import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  NotFoundException,
  Injectable,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import type {
  AbrirArqueoDto,
  CerrarArqueoDto,
  ListarArqueosDto,
} from '../dto/caja-arqueo.dto';
import { cuentaDeConcepto } from './caja-configuracion.service';
import { CajaMovimientoService } from './caja-movimiento.service';
import {
  CONCEPTOS_ARQUEO,
  calcularDiferenciaArqueo,
  conceptoDelAjuste,
  resolverConteo,
  verificarPuedeAbrirArqueo,
  type TipoDenominacion,
  type TratamientoFaltante,
} from './caja.reglas';

export interface ArqueoResumen {
  id: string;
  caja_id: string;
  fecha: string;
  saldo_sistema: string;
  saldo_contado: string | null;
  diferencia: string | null;
  estado: string;
  cerrado_en: string | null;
  cerrado_por: string | null;
  nota: string | null;
  asiento_ajuste_id: string | null;
  /** Solo con faltante: lo asumió la empresa o se le cobra al responsable. */
  tratamiento_faltante: TratamientoFaltante | null;
  /** A quién se le cobra el faltante, si `tratamiento_faltante` es RESPONSABLE. */
  responsable_tercero_id: string | null;
  /**
   * El conteo billete por billete, si se cerró así. Vacío en un arqueo
   * abierto o en uno que se cerró con el total a secas.
   */
  denominaciones: Array<{
    tipo: TipoDenominacion;
    denominacion: string;
    cantidad: number;
    subtotal: string;
  }>;
}

// `fecha` sale como texto AAAA-MM-DD y no como `Date` de pg: al cerrar, esa
// fecha vuelve al motor de asientos, que arma el período con `new Date(\`${fecha}T12:00:00\`)`
// y con un `Date` serializado producía un mes NaN.
//
// Las denominaciones van como subconsulta y no como JOIN, por lo mismo que en
// ventas: así las mismas columnas sirven en el `RETURNING` del cierre. Billetes
// primero y de mayor a menor, que es como se cuenta un cajón.
const CAMPOS = `id, caja_id, to_char(fecha, 'YYYY-MM-DD') AS fecha, saldo_sistema, saldo_contado, diferencia,
                estado, cerrado_en, cerrado_por, nota, asiento_ajuste_id,
                tratamiento_faltante, responsable_tercero_id,
                (SELECT coalesce(json_agg(json_build_object(
                          'tipo', d.tipo, 'denominacion', d.denominacion,
                          'cantidad', d.cantidad, 'subtotal', d.subtotal)
                        ORDER BY d.tipo, d.denominacion DESC), '[]'::json)
                   FROM caja_arqueo_denominacion d
                  WHERE d.arqueo_id = caja_arqueo.id) AS denominaciones`;

/** El ajuste de un arqueo es un asiento de diario, no un ingreso/egreso de caja. */
const CODIGO_COMPROBANTE_AJUSTE = 'CD';

/**
 * El cuadre diario de una caja: "lo de hoy es el inicio de mañana".
 * `ux_arqueo_abierto` en la base ya impide dos arqueos `ABIERTO` a la vez
 * para la misma caja; acá se anticipa con `verificarPuedeAbrirArqueo`,
 * mismo motivo que el resto del módulo — un mensaje legible en vez de la
 * violación de índice único.
 */
@Injectable()
export class CajaArqueoService {
  constructor(
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
    private readonly movimientos: CajaMovimientoService,
  ) {}

  /**
   * Abre el arqueo del día: congela `saldo_sistema` con el último saldo
   * corrido del libro (0 si la caja no tiene movimientos todavía).
   */
  async abrir(
    ctx: CtxEmpresa,
    cajaId: string,
    dto: AbrirArqueoDto,
  ): Promise<ArqueoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCajaBloqueada(cajaId, t);

      const resultado = verificarPuedeAbrirArqueo(
        await this.hayArqueoAbierto(cajaId, t),
      );
      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

      const saldoSistema = (await this.saldoActual(cajaId, t)) ?? 0;

      const creado = fila<ArqueoResumen>(
        await t.query(
          `INSERT INTO caja_arqueo
             (id, empresa_id, caja_id, fecha, saldo_sistema, nota, creado_por)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING ${CAMPOS}`,
          [
            randomUUID(),
            ctx.empresaId,
            cajaId,
            dto.fecha,
            saldoSistema,
            dto.nota ?? null,
            ctx.usuarioId,
          ],
        ),
      );
      if (creado === undefined) {
        throw new BadRequestException('No se pudo abrir el arqueo.');
      }
      return creado;
    });
  }

  /**
   * Cierra el arqueo abierto de esta caja. Si `saldoContado` difiere del
   * `saldo_sistema` congelado al abrir, genera el asiento de ajuste contra la
   * cuenta del concepto —sobrante, faltante cobrable o faltante asumido, según
   * lo que diga quien cierra— y el `caja_movimiento` correctivo, todo en la
   * misma transacción del cierre. Sin diferencia, solo cierra: no toca
   * contabilidad para nada.
   */
  async cerrar(
    ctx: CtxEmpresa,
    cajaId: string,
    dto: CerrarArqueoDto,
  ): Promise<ArqueoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = resolverConteo(dto.saldoContado, dto.denominaciones);
      if (!conteo.ok) {
        throw new BadRequestException(conteo.motivo);
      }
      const saldoContado = conteo.saldoContado;

      const caja = await this.exigirCajaBloqueada(cajaId, t);
      const arqueo = await this.exigirArqueoAbierto(cajaId, t);

      const diferencia = calcularDiferenciaArqueo(
        Number(arqueo.saldo_sistema),
        saldoContado,
      );

      let asientoAjusteId: string | null = null;
      let tratamiento: TratamientoFaltante | null = null;
      let responsableId: string | null = null;
      if (diferencia !== 0) {
        const ajuste = conceptoDelAjuste(diferencia, dto.tratamientoFaltante);
        if (!ajuste.ok) {
          throw new BadRequestException(ajuste.motivo);
        }
        if (diferencia < 0) {
          tratamiento = dto.tratamientoFaltante ?? null;
          if (tratamiento === 'RESPONSABLE') {
            // El de la caja viene por defecto; quien cierra lo cambia si ese
            // día contó otra persona.
            responsableId =
              dto.responsableTerceroId ?? caja.responsable_tercero_id;
            if (responsableId === null) {
              throw new BadRequestException(
                'Para cobrar el faltante, elija a quién: esta caja no tiene responsable.',
              );
            }
          }
        }

        const cuentaAjusteId = await cuentaDeConcepto(t, ctx, ajuste.concepto);
        if (cuentaAjusteId === null) {
          throw new BadRequestException(
            `Falta la cuenta de «${CONCEPTOS_ARQUEO[ajuste.concepto].etiqueta}»: elíjala en Plan de cuentas → Cuentas automáticas.`,
          );
        }
        const movimientoId = randomUUID();

        asientoAjusteId = await this.asentarAjuste(
          ctx,
          caja,
          cuentaAjusteId,
          arqueo,
          diferencia,
          movimientoId,
          responsableId,
          t,
        );

        await this.movimientos.registrarAjusteArqueo(
          ctx,
          cajaId,
          {
            id: movimientoId,
            tipo: diferencia < 0 ? 'EGRESO' : 'INGRESO',
            fecha: arqueo.fecha,
            valor: Math.abs(diferencia),
            concepto: `Ajuste de arqueo del ${arqueo.fecha}: ${
              diferencia < 0 ? 'faltante' : 'sobrante'
            } de ${Math.abs(diferencia)}`,
            saldoValor: saldoContado,
            asientoId: asientoAjusteId,
          },
          t,
        );
      }

      // Antes del `UPDATE`: así su `RETURNING` ya las ve y el arqueo cerrado
      // vuelve con su conteo.
      for (const d of conteo.denominaciones) {
        await t.query(
          `INSERT INTO caja_arqueo_denominacion
             (empresa_id, arqueo_id, tipo, denominacion, cantidad)
           VALUES ($1, $2, $3, $4, $5)`,
          [ctx.empresaId, arqueo.id, d.tipo, d.denominacion, d.cantidad],
        );
      }

      const cerrado = fila<ArqueoResumen>(
        await t.query(
          `UPDATE caja_arqueo
              SET estado = 'CERRADO', saldo_contado = $2, diferencia = $3,
                  cerrado_en = now(), cerrado_por = $4,
                  nota = COALESCE($5, nota), asiento_ajuste_id = $6,
                  tratamiento_faltante = $7, responsable_tercero_id = $8
            WHERE id = $1
          RETURNING ${CAMPOS}`,
          [
            arqueo.id,
            saldoContado,
            diferencia,
            ctx.usuarioId,
            dto.nota ?? null,
            asientoAjusteId,
            tratamiento,
            responsableId,
          ],
        ),
      );
      if (cerrado === undefined) {
        throw new BadRequestException('No se pudo cerrar el arqueo.');
      }
      return cerrado;
    });
  }

  /** El historial de arqueos de una caja. Más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    cajaId: string,
    p: ListarArqueosDto,
  ): Promise<Pagina<ArqueoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = fila<{ total: string }>(
        await t.query(
          'SELECT count(*) AS total FROM caja_arqueo WHERE caja_id = $1',
          [cajaId],
        ),
      );

      const datos = filas<ArqueoResumen>(
        await t.query(
          `SELECT ${CAMPOS}
             FROM caja_arqueo
            WHERE caja_id = $1
            ORDER BY creado_en DESC, id DESC
            LIMIT $2 OFFSET $3`,
          [cajaId, p.tamano, p.salto],
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Bloquea la fila de la caja por el resto de la transacción — mismo
   * motivo que `CajaMovimientoService.exigirCajaBloqueada`: serializa
   * `abrir`/`cerrar` contra cualquier movimiento o arqueo concurrente de
   * la misma caja.
   */
  private async exigirCajaBloqueada(
    cajaId: string,
    t: Tx,
  ): Promise<{
    id: string;
    cuenta_id: string;
    responsable_tercero_id: string | null;
    centro_costo_id: string | null;
  }> {
    // El centro de la sede de la caja: ahí va el faltante o el sobrante (D5).
    const caja = fila<{
      id: string;
      cuenta_id: string;
      responsable_tercero_id: string | null;
      centro_costo_id: string | null;
    }>(
      await t.query(
        `SELECT id, cuenta_id, responsable_tercero_id,
                (SELECT c.id FROM empresa_centro_costo c
                  WHERE c.sede_id = caja.sede_id AND c.activo
                    AND NOT EXISTS (SELECT 1 FROM empresa_centro_costo h WHERE h.padre_id = c.id)
                  ORDER BY c.codigo LIMIT 1) AS centro_costo_id
           FROM caja WHERE id = $1 AND activa FOR UPDATE OF caja`,
        [cajaId],
      ),
    );
    if (caja === undefined) {
      throw new NotFoundException('Caja no encontrada o inactiva');
    }
    return caja;
  }

  /** El saldo corrido con el que sigue el libro, o `null` si no tiene movimientos. */
  private async saldoActual(cajaId: string, t: Tx): Promise<number | null> {
    const ultimo = fila<{ saldo_valor: string }>(
      await t.query(
        `SELECT saldo_valor
           FROM caja_movimiento
          WHERE caja_id = $1
          ORDER BY secuencia DESC
          LIMIT 1`,
        [cajaId],
      ),
    );
    return ultimo === undefined ? null : Number(ultimo.saldo_valor);
  }

  private async hayArqueoAbierto(cajaId: string, t: Tx): Promise<boolean> {
    const abierto = fila<{ id: string }>(
      await t.query(
        `SELECT id FROM caja_arqueo WHERE caja_id = $1 AND estado = 'ABIERTO'`,
        [cajaId],
      ),
    );
    return abierto !== undefined;
  }

  private async exigirArqueoAbierto(
    cajaId: string,
    t: Tx,
  ): Promise<ArqueoResumen> {
    const abierto = fila<ArqueoResumen>(
      await t.query(
        `SELECT ${CAMPOS}
           FROM caja_arqueo
          WHERE caja_id = $1 AND estado = 'ABIERTO'`,
        [cajaId],
      ),
    );
    if (abierto === undefined) {
      throw new BadRequestException(
        'Esta caja no tiene un arqueo abierto para cerrar.',
      );
    }
    return abierto;
  }

  /**
   * El asiento de ajuste: débito a `cuentaAjusteId` y crédito a
   * `caja.cuenta_id` si faltó, al revés si sobró — misma tabla que
   * documenta `caja-bancos-backend.md`. Si el faltante se le cobra a
   * alguien, la línea de la cuenta por cobrar lleva ese tercero. `origenId` es el id del
   * `caja_movimiento` correctivo que se inserta a continuación, en la
   * MISMA transacción — se genera antes para poder enlazarlo en los dos
   * lados, mismo patrón que `KardexService.asentarAjuste`.
   */
  private async asentarAjuste(
    ctx: CtxEmpresa,
    caja: { cuenta_id: string; centro_costo_id?: string | null },
    cuentaAjusteId: string,
    arqueo: { id: string; fecha: string },
    diferencia: number,
    movimientoId: string,
    responsableId: string | null,
    t: Tx,
  ): Promise<string> {
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      CODIGO_COMPROBANTE_AJUSTE,
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        'La empresa no tiene el comprobante de diario sembrado.',
      );
    }

    const valor = Math.abs(diferencia);
    const faltante = diferencia < 0;

    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: arqueo.fecha,
        glosa: `Ajuste de arqueo (${faltante ? 'faltante' : 'sobrante'}), arqueo ${arqueo.id}`,
        centroCostoId: caja.centro_costo_id ?? undefined,
        lineas: [
          {
            cuentaId: cuentaAjusteId,
            debito: faltante ? valor : 0,
            credito: faltante ? 0 : valor,
            terceroId: responsableId ?? undefined,
          },
          {
            cuentaId: caja.cuenta_id,
            debito: faltante ? 0 : valor,
            credito: faltante ? valor : 0,
          },
        ],
      },
      { origenTipo: 'MOVIMIENTO_CAJA', origenId: movimientoId },
      t,
    );
    return asiento.id;
  }
}
