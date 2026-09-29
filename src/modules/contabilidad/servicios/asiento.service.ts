import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import {
  armarPagina,
  type Pagina,
  type PaginacionDto,
} from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { CrearAsientoDto, FiltroAsientosDto } from '../dto/asiento.dto';
import {
  lineasConValorNegativo,
  lineasSinUnaPata,
  totalesDe,
  verificarCuadre,
} from './asiento.reglas';
import { ComprobanteService } from './comprobante.service';
import { PeriodoService } from './periodo.service';

export interface AsientoResumen {
  id: string;
  numero: string;
  fecha: string;
  glosa: string;
  total_debito: string;
  estado: string;
  comprobante_codigo: string;
  comprobante_nombre: string;
}

export interface LineaAsiento {
  id: string;
  orden: number;
  cuenta_id: string;
  cuenta_codigo: string;
  cuenta_nombre: string;
  tercero_id: string | null;
  tercero_nombre: string | null;
  centro_costo_id: string | null;
  centro_costo_nombre: string | null;
  base_gravable: string | null;
  detalle: string | null;
  debito: string;
  credito: string;
}

/** El origen de un asiento automático. `null` en los que digita una persona. */
export interface Origen {
  origenTipo:
    | 'VENTA'
    | 'COMPRA'
    | 'NOMINA'
    | 'AJUSTE_INVENTARIO'
    | 'MOVIMIENTO_CAJA'
    | 'MOVIMIENTO_BANCO';
  origenId: string;
}

/**
 * El motor de asientos. Una sola ruta para todos.
 *
 * La factura lo llama con `origen = { origenTipo: 'VENTA', ... }` y las líneas
 * que armó el módulo de ventas; el contador lo llama sin origen y con las líneas
 * que escribió a mano. Es el mismo camino a propósito: si cada módulo armara el
 * suyo, terminarían tres reglas distintas de partida doble.
 *
 * Las validaciones de acá no reemplazan a los triggers de `0022`: los anticipan.
 * El trigger de cuadre dispara al COMMIT y habla del asiento entero; acá todavía
 * se puede decir qué renglón está mal. Si esto y la base discrepan, la base
 * tiene razón.
 */
@Injectable()
export class AsientoService {
  constructor(
    private readonly tx: TxService,
    private readonly periodos: PeriodoService,
    private readonly comprobantes: ComprobanteService,
  ) {}

  async listar(
    ctx: CtxEmpresa,
    p: PaginacionDto,
    filtro: FiltroAsientosDto,
  ): Promise<Pagina<AsientoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const condiciones: string[] = [];
      const params: unknown[] = [];

      if (filtro.desde !== undefined) {
        params.push(filtro.desde);
        condiciones.push(`a.fecha >= $${params.length}`);
      }
      if (filtro.hasta !== undefined) {
        params.push(filtro.hasta);
        condiciones.push(`a.fecha <= $${params.length}`);
      }
      if (filtro.comprobanteTipoId !== undefined) {
        params.push(filtro.comprobanteTipoId);
        condiciones.push(`a.comprobante_tipo_id = $${params.length}`);
      }
      // Los anulados se ocultan salvo que se pidan: siguen en el libro, pero no
      // son lo que alguien busca al abrir la lista.
      if (filtro.incluirAnulados !== true) {
        condiciones.push(`a.estado = 'REGISTRADO'`);
      }
      if (filtro.q !== undefined && filtro.q.trim() !== '') {
        params.push(`%${filtro.q.trim()}%`);
        condiciones.push(
          `(a.numero ILIKE $${params.length}
            OR fn_normalizar(a.glosa) LIKE fn_normalizar($${params.length}))`,
        );
      }

      const where =
        condiciones.length === 0 ? '' : `WHERE ${condiciones.join(' AND ')}`;

      const conteo = fila<{ total: string }>(
        await t.query(
          `SELECT count(*) AS total FROM asiento a ${where}`,
          params,
        ),
      );

      params.push(p.tamano, p.salto);
      const datos = filas<AsientoResumen>(
        await t.query(
          `SELECT a.id, a.numero, a.fecha, a.glosa, a.total_debito, a.estado,
                  c.codigo AS comprobante_codigo, c.nombre AS comprobante_nombre
             FROM asiento a
             JOIN empresa_comprobante_tipo c ON c.id = a.comprobante_tipo_id
             ${where}
            ORDER BY a.fecha DESC, a.numero DESC
            LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params,
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /** La cabecera con sus líneas, con los nombres ya resueltos para mostrarla. */
  async porId(
    ctx: CtxEmpresa,
    id: string,
  ): Promise<Record<string, unknown> & { lineas: LineaAsiento[] }> {
    return this.tx.enContexto(ctx, async (t) => {
      const cabecera = fila<Record<string, unknown>>(
        await t.query(
          `SELECT a.*, c.codigo AS comprobante_codigo, c.nombre AS comprobante_nombre,
                  p.anio AS periodo_anio, p.mes AS periodo_mes, p.estado AS periodo_estado
             FROM asiento a
             JOIN empresa_comprobante_tipo c ON c.id = a.comprobante_tipo_id
             JOIN periodo_contable p ON p.id = a.periodo_id
            WHERE a.id = $1`,
          [id],
        ),
      );

      if (cabecera === undefined) {
        throw new NotFoundException('Asiento no encontrado');
      }

      const lineas = filas<LineaAsiento>(
        await t.query(
          `SELECT l.id, l.orden, l.cuenta_id, l.tercero_id, l.centro_costo_id,
                  l.base_gravable, l.detalle, l.debito, l.credito,
                  cu.codigo AS cuenta_codigo, cu.nombre AS cuenta_nombre,
                  coalesce(te.razon_social,
                           btrim(concat_ws(' ', te.primer_nombre, te.primer_apellido)))
                    AS tercero_nombre,
                  cc.nombre AS centro_costo_nombre
             FROM asiento_linea l
             JOIN empresa_cuenta cu ON cu.id = l.cuenta_id
             LEFT JOIN tercero te ON te.id = l.tercero_id
             LEFT JOIN empresa_centro_costo cc ON cc.id = l.centro_costo_id
            WHERE l.asiento_id = $1
            ORDER BY l.orden`,
          [id],
        ),
      );

      return { ...cabecera, lineas };
    });
  }

  /**
   * Registra un asiento con todas sus líneas.
   *
   * El `tx` opcional es lo que va a usar ventas: la factura abre la transacción,
   * llama acá con ella, y la factura y su asiento entran juntos o no entra
   * ninguno.
   *
   * El orden de los pasos no es casual. Primero lo que se puede rechazar sin
   * tocar la base —el cuadre, las patas—, porque son los errores frecuentes y
   * ahí todavía se puede señalar el renglón. Después el período, que decide si
   * se puede escribir. El número se toma de último: es lo único que consume algo.
   */
  async crear(
    ctx: CtxEmpresa,
    dto: CrearAsientoDto,
    origen: Origen | null = null,
    tx?: Tx,
  ): Promise<{ id: string; numero: string }> {
    this.validarLineas(dto);

    return this.tx.enContexto(
      ctx,
      async (t) => {
        // Los módulos llaman a esto con fechas que a veces vienen de la base, y
        // pg entrega las columnas `date` como `Date`, no como texto. Mejor
        // decirlo acá que dejar que un mes `NaN` reviente en Postgres.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.fecha))) {
          throw new BadRequestException(
            `La fecha del asiento tiene que ser AAAA-MM-DD; llegó "${String(dto.fecha)}".`,
          );
        }
        // El calendario es automático: si el mes del documento ya se cerró, el
        // asiento va al mes abierto, el primer día, y la glosa guarda la fecha
        // original. El documento (factura, compra) conserva la suya.
        const destino = await this.periodos.periodoParaAsentar(
          ctx,
          dto.fecha,
          t,
        );
        const periodo = destino.periodo;
        const glosa = destino.movida
          ? `${dto.glosa} (documento del ${dto.fecha}: su mes ya estaba cerrado)`
          : dto.glosa;

        // Los automáticos no pasan por acá: un asiento de venta puede ser de
        // naturaleza que una persona no podría digitar.
        if (origen === null) {
          await this.comprobantes.exigirDigitable(dto.comprobanteTipoId, t);
        }

        const numero = await this.comprobantes.siguienteNumero(
          dto.comprobanteTipoId,
          t,
        );

        const { totalDebito, totalCredito } = totalesDe(dto.lineas);

        const cabecera = fila<{ id: string }>(
          await t.query(
            `INSERT INTO asiento
               (empresa_id, comprobante_tipo_id, numero, fecha, periodo_id, glosa,
                total_debito, total_credito, origen_tipo, origen_id, creado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id`,
            [
              ctx.empresaId,
              dto.comprobanteTipoId,
              numero,
              destino.fecha,
              periodo.id,
              glosa,
              totalDebito,
              totalCredito,
              origen?.origenTipo ?? null,
              origen?.origenId ?? null,
              ctx.usuarioId,
            ],
          ),
        );

        if (cabecera === undefined) {
          throw new BadRequestException('No se pudo registrar el asiento.');
        }

        // El `orden` lo pone el servidor y no el cliente: es la posición en la
        // que llegaron, y aceptarlo del cliente permitiría dos renglones 3.
        for (const [i, l] of dto.lineas.entries()) {
          await t.query(
            `INSERT INTO asiento_linea
               (asiento_id, empresa_id, orden, cuenta_id, tercero_id,
                centro_costo_id, base_gravable, detalle, debito, credito, concepto_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              cabecera.id,
              ctx.empresaId,
              i + 1,
              l.cuentaId,
              l.terceroId ?? null,
              l.centroCostoId ?? null,
              l.baseGravable ?? null,
              l.detalle ?? null,
              l.debito ?? 0,
              l.credito ?? 0,
              l.conceptoId ?? null,
            ],
          );
        }

        return { id: cabecera.id, numero };
      },
      tx,
    );
  }

  /**
   * Anula un asiento. No borra nada.
   *
   * El motivo va en su propia columna y no en la glosa. La glosa dice por qué
   * EXISTE el asiento y no cambia nunca; por qué se anuló es otro hecho, de otro
   * momento y de otra persona, y sin `anulado_por` y `anulado_en` se pierde lo
   * primero que pregunta un auditor.
   *
   * El asiento sigue en el período donde estaba. Si ese período está cerrado, la
   * anulación se rechaza: los estados financieros ya salieron, y la corrección
   * correcta es un contra-asiento en el período abierto.
   *
   * `tx` es opcional: el endpoint HTTP anula solo, sin nadie más de por
   * medio, y abre la suya. Quien anula un documento propio —una factura de
   * `ventas`, por ejemplo— pasa la transacción que ya tiene abierta: la
   * anulación del asiento y la del documento tienen que confirmarse juntas
   * o ninguna de las dos.
   */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<void> {
    await this.tx.enContexto(
      ctx,
      async (t) => {
        const asiento = fila<{
          estado: string;
          glosa: string;
          numero: string;
          periodo_estado: string;
          anio: number;
          mes: number;
        }>(
          await t.query(
            `SELECT a.estado, a.glosa, a.numero,
                  p.estado AS periodo_estado, p.anio, p.mes
             FROM asiento a
             JOIN periodo_contable p ON p.id = a.periodo_id
            WHERE a.id = $1`,
            [id],
          ),
        );

        if (asiento === undefined) {
          throw new NotFoundException('Asiento no encontrado');
        }
        if (asiento.estado === 'ANULADO') {
          throw new BadRequestException(
            `El asiento ${asiento.numero} ya esta anulado.`,
          );
        }
        if (asiento.periodo_estado === 'CERRADO') {
          throw new BadRequestException(
            `El asiento ${asiento.numero} esta en ${asiento.anio}-${String(asiento.mes).padStart(2, '0')}, que ya se cerro. Corregilo con un contra-asiento en un periodo abierto.`,
          );
        }

        await t.query(
          `UPDATE asiento
              SET estado = 'ANULADO',
                  motivo_anulacion = $2,
                  anulado_en = now(),
                  anulado_por = $3
            WHERE id = $1`,
          [id, motivo, ctx.usuarioId],
        );
      },
      tx,
    );
  }

  /**
   * Las líneas de un asiento, tal como se guardaron y sin nombres resueltos:
   * lo que necesita quien va a armar el asiento contrario. `null` si el
   * asiento no existe o está anulado —no hay nada que invertir—.
   */
  async lineasParaInvertir(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<Array<{
    cuentaId: string;
    terceroId: string | null;
    centroCostoId: string | null;
    conceptoId: string | null;
    baseGravable: number | null;
    debito: number;
    credito: number;
  }> | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const asiento = fila<{ estado: string }>(
          await t.query('SELECT estado FROM asiento WHERE id = $1', [id]),
        );
        if (asiento === undefined || asiento.estado !== 'REGISTRADO') {
          return null;
        }
        const lineas = filas<{
          cuenta_id: string;
          tercero_id: string | null;
          centro_costo_id: string | null;
          concepto_id: string | null;
          base_gravable: string | null;
          debito: string;
          credito: string;
        }>(
          await t.query(
            `SELECT cuenta_id, tercero_id, centro_costo_id, concepto_id, base_gravable,
                    debito, credito
               FROM asiento_linea
              WHERE asiento_id = $1
              ORDER BY orden`,
            [id],
          ),
        );
        return lineas.map((l) => ({
          cuentaId: l.cuenta_id,
          terceroId: l.tercero_id,
          centroCostoId: l.centro_costo_id,
          conceptoId: l.concepto_id,
          baseGravable:
            l.base_gravable === null ? null : Number(l.base_gravable),
          debito: Number(l.debito),
          credito: Number(l.credito),
        }));
      },
      tx,
    );
  }

  /** El asiento que generó un documento. Para mostrarlo al lado de la factura. */
  async porOrigen(
    ctx: CtxEmpresa,
    origenTipo: string,
    origenId: string,
    tx?: Tx,
  ): Promise<{ id: string; numero: string } | null> {
    return this.tx.enContexto(
      ctx,
      async (t) =>
        fila<{ id: string; numero: string }>(
          await t.query(
            `SELECT id, numero FROM asiento
              WHERE origen_tipo = $1 AND origen_id = $2 AND estado = 'REGISTRADO'`,
            [origenTipo, origenId],
          ),
        ) ?? null,
      tx,
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Todo lo que se puede rechazar sin tocar la base.
   *
   * Son los errores frecuentes de digitación, y acá todavía se puede decir qué
   * renglón está mal. El trigger dispara al COMMIT y para entonces solo sabe que
   * el asiento entero no cuadra.
   */
  private validarLineas(dto: CrearAsientoDto): void {
    if (dto.lineas.length < 2) {
      throw new BadRequestException(
        'Un asiento lleva al menos dos lineas: algo se debita contra algo que se acredita.',
      );
    }

    const negativas = lineasConValorNegativo(dto.lineas);
    if (negativas.length > 0) {
      throw new BadRequestException(
        `El valor nunca es negativo; el sentido lo da la columna. Revisa ${renglones(negativas)}.`,
      );
    }

    const sinPata = lineasSinUnaPata(dto.lineas);
    if (sinPata.length > 0) {
      throw new BadRequestException(
        `Cada linea lleva debito o credito, nunca los dos ni ninguno. Revisa ${renglones(sinPata)}.`,
      );
    }

    const cuadre = verificarCuadre(dto.lineas);
    if (!cuadre.cuadra) {
      throw new BadRequestException(
        `El asiento no cuadra: debitos ${cuadre.totalDebito}, creditos ${cuadre.totalCredito}. Faltan ${cuadre.diferencia} en el ${cuadre.falta?.toLowerCase()}.`,
      );
    }
  }
}

/** "la linea 3" / "las lineas 3 y 7". El plural importa: se lee en un error. */
function renglones(numeros: number[]): string {
  if (numeros.length === 1) {
    return `la linea ${numeros[0]}`;
  }
  const ultimo = numeros[numeros.length - 1];
  return `las lineas ${numeros.slice(0, -1).join(', ')} y ${ultimo}`;
}
