import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import {
  motivoNoSeLee,
  numeroComparable,
  resumenDelLote,
  situacionDelLote,
  type ArchivoDelLote,
  type FilaArchivo,
  type ResumenLote,
} from '../reglas/lote.reglas';
import { DocumentoService, exigirClaveDeLaEmpresa } from './documento.service';
import { ExtractorService } from './extractor.service';
import { ProgresoService } from './progreso.service';

/** Cuántos archivos se aceptan de una vez. Más que esto es una migración, no un lote. */
export const TOPE_LOTE = 25;

export interface Lote extends ResumenLote {
  id: string;
  creadoEn: string;
  terminadoEn: string | null;
  detenido: boolean;
  archivos: ArchivoDelLote[];
}

interface FilaLote {
  id: string;
  creado_en: Date;
  terminado_en: Date | null;
  detenido: boolean;
}

/**
 * Varios documentos soltados juntos en el chat (tanda 3, migración 0067).
 *
 * **De a uno y en orden.** Soltar veinte facturas no lanza veinte lecturas a la
 * vez: cada una es una llamada al modelo con el archivo entero, y en paralelo
 * se pisarían en el límite de la cuenta y la pantalla no podría decir «3 de
 * 20». Primero se mira qué es cada archivo; si es algo que María lee, se lee
 * ahí mismo, y recién después pasa al siguiente.
 *
 * El trabajo corre fuera de la petición, como una lectura suelta. El avance
 * sale por el mismo canal de progreso, con `lote` en el evento.
 *
 * **Nada de esto registra.** El lote termina en listas para aprobar y
 * apartadas; aprobar sigue siendo, una por una, de una persona.
 */
@Injectable()
export class LoteService {
  private readonly log = new Logger(LoteService.name);
  /** Los lotes que este proceso está leyendo ahora. */
  private readonly enMarcha = new Set<string>();

  constructor(
    private readonly tx: TxService,
    private readonly documentos: DocumentoService,
    private readonly extractor: ExtractorService,
    private readonly almacenamiento: AlmacenamientoApi,
    private readonly progreso: ProgresoService,
    @Optional() private readonly pausa?: PausaIaService,
  ) {}

  async crear(
    ctx: CtxEmpresa,
    archivos: Array<{ clave: string; nombre: string }>,
  ): Promise<Lote> {
    if (archivos.length === 0) {
      throw new BadRequestException('El lote no trae archivos.');
    }
    if (archivos.length > TOPE_LOTE) {
      throw new BadRequestException(
        `Son ${archivos.length} archivos: de a ${TOPE_LOTE} como mucho.`,
      );
    }
    for (const a of archivos) exigirClaveDeLaEmpresa(ctx, a.clave);
    await this.pausa?.exigirActiva(ctx.tenantId, 'LECTURA');

    const loteId = await this.tx.enContexto(ctx, async (t) => {
      const lote = fila<{ id: string }>(
        await t.query(
          `INSERT INTO lote_lectura (empresa_id, creado_por) VALUES ($1, $2) RETURNING id`,
          [ctx.empresaId, ctx.usuarioId],
        ),
      )!;
      for (const [orden, a] of archivos.entries()) {
        await t.query(
          `INSERT INTO lote_archivo
             (empresa_id, lote_id, orden, nombre, clave_almacenamiento)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            ctx.empresaId,
            lote.id,
            orden,
            a.nombre.trim().slice(0, 255) || 'archivo',
            a.clave,
          ],
        );
      }
      return lote.id;
    });

    void this.procesar(ctx, loteId);
    return this.ver(ctx, loteId);
  }

  /**
   * Los lotes de quien pregunta, los más nuevos primero.
   *
   * Un lote sin terminar que este proceso no está leyendo es de antes de un
   * reinicio: se cierra acá, con lo que quedaba en cola como detenido. Supone
   * un solo proceso de la API, que es como se despliega hoy.
   */
  async listar(ctx: CtxEmpresa, tope = 10): Promise<Lote[]> {
    const lotes = await this.tx.enContexto(ctx, async (t) =>
      filas<{ id: string; terminado_en: Date | null }>(
        await t.query(
          `SELECT id, terminado_en FROM lote_lectura
            WHERE creado_por = $1
            ORDER BY creado_en DESC
            LIMIT $2`,
          [ctx.usuarioId, tope],
        ),
      ),
    );
    for (const l of lotes) {
      if (l.terminado_en === null && !this.enMarcha.has(l.id)) {
        await this.cerrar(ctx, l.id);
      }
    }
    return Promise.all(lotes.map((l) => this.ver(ctx, l.id)));
  }

  async ver(ctx: CtxEmpresa, loteId: string): Promise<Lote> {
    return this.tx.enContexto(ctx, async (t) => {
      const lote = fila<FilaLote>(
        await t.query(
          'SELECT id, creado_en, terminado_en, detenido FROM lote_lectura WHERE id = $1',
          [loteId],
        ),
      );
      if (lote === undefined)
        throw new NotFoundException('Ese lote no existe.');
      const archivos = situacionDelLote(await this.filas(t, loteId));
      return {
        id: lote.id,
        creadoEn: new Date(lote.creado_en).toISOString(),
        terminadoEn:
          lote.terminado_en === null
            ? null
            : new Date(lote.terminado_en).toISOString(),
        detenido: lote.detenido,
        archivos,
        ...resumenDelLote(archivos),
      };
    });
  }

  /**
   * Para el lote: lo que se está leyendo se corta y lo que quedaba en cola no
   * se mira. Si el proceso que lo leía ya no existe —se reinició el servidor—,
   * se cierra acá, que si no quedaría «leyendo» para siempre.
   */
  async detener(ctx: CtxEmpresa, loteId: string): Promise<Lote> {
    await this.tx.enContexto(ctx, async (t) => {
      const lote = fila<{ id: string }>(
        await t.query(
          'SELECT id FROM lote_lectura WHERE id = $1 AND creado_por = $2',
          [loteId, ctx.usuarioId],
        ),
      );
      if (lote === undefined)
        throw new NotFoundException('Ese lote no existe.');
      await t.query('UPDATE lote_lectura SET detenido = true WHERE id = $1', [
        loteId,
      ]);
    });

    const leyendo = await this.tx.enContexto(ctx, async (t) =>
      filas<{ documento_leido_id: string }>(
        await t.query(
          `SELECT a.documento_leido_id FROM lote_archivo a
             JOIN documento_leido d ON d.id = a.documento_leido_id
            WHERE a.lote_id = $1 AND d.estado IN ('EN_COLA', 'LEYENDO')`,
          [loteId],
        ),
      ),
    );
    for (const l of leyendo) this.progreso.detener(l.documento_leido_id);

    if (!this.enMarcha.has(loteId)) await this.cerrar(ctx, loteId);
    return this.ver(ctx, loteId);
  }

  // ─── El trabajo ────────────────────────────────────────────────────────────

  private async procesar(ctx: CtxEmpresa, loteId: string): Promise<void> {
    this.enMarcha.add(loteId);
    try {
      for (;;) {
        const siguiente = await this.tx.enContexto(ctx, async (t) => {
          const lote = fila<{ detenido: boolean }>(
            await t.query('SELECT detenido FROM lote_lectura WHERE id = $1', [
              loteId,
            ]),
          );
          if (lote?.detenido !== false) return null;
          return (
            fila<{ id: string; nombre: string; clave_almacenamiento: string }>(
              await t.query(
                `SELECT id, nombre, clave_almacenamiento FROM lote_archivo
                  WHERE lote_id = $1 AND estado = 'EN_COLA'
                  ORDER BY orden LIMIT 1`,
                [loteId],
              ),
            ) ?? null
          );
        });
        if (siguiente === null) break;
        await this.unArchivo(ctx, loteId, siguiente);
      }
    } catch (error: unknown) {
      this.log.error(
        `El lote ${loteId} se cayó`,
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.enMarcha.delete(loteId);
      await this.cerrar(ctx, loteId).catch(() => undefined);
    }
  }

  /**
   * Mira un archivo y, si es algo que María lee, lo lee. Nada de acá tira: un
   * archivo que falla no puede frenar a los que vienen detrás.
   */
  private async unArchivo(
    ctx: CtxEmpresa,
    loteId: string,
    archivo: { id: string; nombre: string; clave_almacenamiento: string },
  ): Promise<void> {
    const marcar = (sql: string, params: unknown[]) =>
      this.tx.enContexto(ctx, (t) => t.query(sql, params));

    try {
      await marcar(`UPDATE lote_archivo SET estado = 'MIRANDO' WHERE id = $1`, [
        archivo.id,
      ]);
      await this.avisar(ctx, loteId);

      const bajado = await this.almacenamiento.descargar(
        archivo.clave_almacenamiento,
      );
      const analisis = await this.extractor.reconocer(ctx, bajado);
      const permitido =
        analisis.tipo !== null && this.extractor.puedeLeer(ctx, analisis.tipo);
      const noSeLee = motivoNoSeLee(analisis, permitido);

      if (noSeLee !== null || analisis.tipo === null) {
        await marcar(
          `UPDATE lote_archivo SET estado = 'NO_SE_LEE', clase = $2, resumen = $3, motivo = $4
            WHERE id = $1`,
          [archivo.id, analisis.clase, analisis.resumen, noSeLee],
        );
        // Nada lo va a referenciar: se borra, como en `analizar`.
        await this.almacenamiento.borrar(archivo.clave_almacenamiento);
        return;
      }

      const documento = await this.documentos.registrar(ctx, {
        tipo: analisis.tipo,
        clave: archivo.clave_almacenamiento,
      });
      await marcar(
        `UPDATE lote_archivo
            SET estado = 'DERIVADO', clase = $2, resumen = $3, documento_leido_id = $4
          WHERE id = $1`,
        [archivo.id, analisis.clase, analisis.resumen, documento.id],
      );
      await this.avisar(ctx, loteId);
      await this.extractor.leerYEsperar(ctx, documento);
    } catch (error: unknown) {
      this.log.error(
        `Lote ${loteId}: el archivo ${archivo.id} se cayó`,
        error instanceof Error ? error.stack : String(error),
      );
      // Si ya tenía su lectura, esa quedó en FALLO; si no, se dice acá.
      await marcar(
        `UPDATE lote_archivo SET estado = 'NO_SE_LEE',
                motivo = 'No pude abrir este archivo. Intente subirlo de nuevo.'
          WHERE id = $1 AND estado <> 'DERIVADO'`,
        [archivo.id],
      ).catch(() => undefined);
    } finally {
      await this.avisar(ctx, loteId).catch(() => undefined);
    }
  }

  private async cerrar(ctx: CtxEmpresa, loteId: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await t.query(
        `UPDATE lote_archivo SET estado = 'DETENIDO'
          WHERE lote_id = $1 AND estado IN ('EN_COLA', 'MIRANDO')`,
        [loteId],
      );
      await t.query(
        `UPDATE lote_lectura SET terminado_en = coalesce(terminado_en, now()) WHERE id = $1`,
        [loteId],
      );
    });
    await this.avisar(ctx, loteId);
  }

  /** El avance, por el mismo canal que las lecturas sueltas. */
  private async avisar(ctx: CtxEmpresa, loteId: string): Promise<void> {
    const lote = await this.ver(ctx, loteId);
    this.progreso.emitirLote(ctx.empresaId, {
      loteId,
      total: lote.total,
      hechos: lote.hechos,
      actual: lote.actual,
      terminado: lote.terminadoEn !== null,
    });
  }

  /**
   * Cada archivo con su lectura, si la tiene; en qué compra o factura terminó;
   * y, para una factura de compra, si ya hay una compra vigente del mismo
   * proveedor con el mismo número.
   */
  private async filas(t: Tx, loteId: string): Promise<FilaArchivo[]> {
    const crudas = filas<{
      id: string;
      orden: number;
      nombre: string;
      estado: FilaArchivo['estado'];
      clase: string | null;
      motivo: string | null;
      d_id: string | null;
      d_tipo: string | null;
      d_estado: NonNullable<FilaArchivo['documento']>['estado'] | null;
      d_extraido: unknown;
      d_error: string | null;
      d_motivo_descarte: string | null;
      d_cargadas: number | null;
      registrado_id: string | null;
      registrado_numero: string | null;
    }>(
      await t.query(
        `SELECT a.id, a.orden, a.nombre, a.estado, a.clase, a.motivo,
                d.id AS d_id, d.tipo AS d_tipo, d.estado AS d_estado,
                d.extraido AS d_extraido, d.error AS d_error,
                d.motivo_descarte AS d_motivo_descarte,
                CASE WHEN d.tipo = 'VENTA_HISTORICA' THEN
                  jsonb_array_length(coalesce(d.confirmacion -> 'aplicados', '[]'::jsonb))
                END AS d_cargadas,
                coalesce(c.id, v.id) AS registrado_id,
                coalesce(c.numero_factura_proveedor,
                         concat_ws('', v.prefijo, v.consecutivo::text)) AS registrado_numero
           FROM lote_archivo a
           LEFT JOIN documento_leido d ON d.id = a.documento_leido_id
           LEFT JOIN compra_documento c
             ON c.documento_leido_id = d.id AND c.estado <> 'ANULADA'
           LEFT JOIN venta_documento v
             ON v.documento_leido_id = d.id AND v.estado <> 'ANULADA'
          WHERE a.lote_id = $1
          ORDER BY a.orden`,
        [loteId],
      ),
    );

    const resultado: FilaArchivo[] = [];
    for (const f of crudas) {
      let duplicadoDe: FilaArchivo['duplicadoDe'] = null;
      if (
        f.d_tipo === 'FACTURA_COMPRA' &&
        f.d_estado === 'LEIDO' &&
        f.registrado_id === null
      ) {
        duplicadoDe = await this.compraIgual(t, f.d_extraido);
      }
      resultado.push({
        id: f.id,
        orden: f.orden,
        nombre: f.nombre,
        estado: f.estado,
        clase: f.clase,
        motivo: f.motivo,
        documento:
          f.d_id === null
            ? null
            : {
                id: f.d_id,
                tipo: f.d_tipo!,
                estado: f.d_estado!,
                extraido: f.d_extraido,
                error: f.d_error,
                motivoDescarte: f.d_motivo_descarte,
                ...(f.d_cargadas !== null && {
                  cargadas: Number(f.d_cargadas),
                }),
              },
        registrado:
          f.registrado_id === null
            ? null
            : { id: f.registrado_id, numero: f.registrado_numero ?? '' },
        duplicadoDe,
      });
    }
    return resultado;
  }

  /**
   * Una compra vigente del mismo proveedor que parece la misma: por el número,
   * o —si el papel no trae número, como una cuenta de cobro— por la fecha y el
   * total juntos. Es «posible»: lo decide una persona.
   */
  private async compraIgual(
    t: Tx,
    extraido: unknown,
  ): Promise<FilaArchivo['duplicadoDe']> {
    const e = (extraido ?? {}) as {
      proveedor?: { id: string } | null;
      factura?: {
        numero?: string | null;
        prefijo?: string | null;
        fecha?: string;
        impreso?: { total?: number };
      };
    };
    const proveedor = e.proveedor?.id;
    if (proveedor == null) return null;
    const numero = e.factura?.numero ?? null;
    const buscados = new Set(
      numero === null
        ? []
        : [
            numeroComparable(numero),
            numeroComparable(`${e.factura?.prefijo ?? ''}${numero}`),
          ],
    );
    const fecha = e.factura?.fecha;
    const total = e.factura?.impreso?.total;
    const mismoDiaYMonto = (c: { fecha: Date | string; total: string }) =>
      fecha !== undefined &&
      typeof total === 'number' &&
      total > 0 &&
      aDia(c.fecha) === fecha &&
      Math.abs(Number(c.total) - total) < 1;
    const candidatas = filas<{
      id: string;
      numero_factura_proveedor: string;
      fecha: Date | string;
      total: string;
    }>(
      await t.query(
        `SELECT id, numero_factura_proveedor, fecha, total FROM compra_documento
          WHERE tercero_id = $1 AND estado <> 'ANULADA'`,
        [proveedor],
      ),
    );
    const igual =
      candidatas.find((c) =>
        buscados.has(numeroComparable(c.numero_factura_proveedor)),
      ) ?? (numero === null ? candidatas.find(mismoDiaYMonto) : undefined);
    return igual === undefined
      ? null
      : {
          id: igual.id,
          numero: igual.numero_factura_proveedor,
          fecha: aDia(igual.fecha),
          total: Number(igual.total),
        };
  }
}

/** `aaaa-mm-dd` de una columna `date`, venga como texto o como `Date`. */
function aDia(valor: Date | string): string {
  return typeof valor === 'string'
    ? valor.slice(0, 10)
    : valor.toISOString().slice(0, 10);
}
