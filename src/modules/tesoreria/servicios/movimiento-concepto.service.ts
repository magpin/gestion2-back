import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { BancoMovimientoService } from './banco-movimiento.service';
import { CajaMovimientoService } from './caja-movimiento.service';
import type { Contrapartida } from './contrapartida';
import {
  admiteSinFactura,
  gmfDe,
  problemaDeDireccion,
  valorMovido,
  gmfIncluido,
  type Direccion,
} from './movimiento-concepto.reglas';

export type OrigenMovimiento =
  | 'MANUAL'
  | 'RECIBO_CAJA'
  | 'COMPROBANTE_EGRESO'
  | 'GMF'
  | 'DEVOLUCION_ANTICIPO';

/** Lo que se le retiene a quien se le paga, en un anticipo. Lo calcula el motor. */
export interface RetencionDelMovimiento {
  cuentaId: string;
  valor: number;
  base: number;
}

export interface DatosMovimientoConcepto {
  direccion: Direccion;
  medio: 'CAJA' | 'BANCO';
  cajaId?: string;
  cuentaBancariaId?: string;
  fecha: string;
  conceptoId: string;
  terceroId?: string | null;
  detalle: string;
  /** Lo que va al concepto. Sin retenciones, es también lo que se mueve. */
  valorConcepto: number;
  retenciones?: RetencionDelMovimiento[];
  origen: OrigenMovimiento;
  origenId?: string | null;
  /** La devolución de un anticipo: a cuál descuenta. */
  devuelveA?: string | null;
  /**
   * Varios conceptos en un solo movimiento (PC14). Si vienen, mandan sobre
   * `conceptoId` y `valorConcepto`.
   */
  lineas?: Array<{ conceptoId: string; valor: number }>;
}

export interface MovimientoConcepto {
  id: string;
  direccion: Direccion;
  medio: 'CAJA' | 'BANCO';
  cajaId: string | null;
  cuentaBancariaId: string | null;
  destino: string;
  fecha: string;
  conceptoId: string;
  conceptoCodigo: string;
  conceptoNombre: string;
  terceroId: string | null;
  terceroNombre: string | null;
  valorConcepto: number;
  valorMovido: number;
  detalle: string;
  origen: OrigenMovimiento;
  origenId: string | null;
  asientoId: string | null;
  estado: 'VIGENTE' | 'ANULADO';
  motivoAnulacion: string | null;
  /** Las líneas, cuando son varias (PC14); vacío si es una sola. */
  lineas: Array<{ conceptoId: string; concepto: string; valor: number }>;
}

/** Lo que se registra a mano desde Cobros o Pagos (`POST /movimientos-concepto`). */
export interface DatosManual {
  direccion: Direccion;
  medio: 'CAJA' | 'BANCO';
  cajaId?: string;
  cuentaBancariaId?: string;
  fecha: string;
  terceroId?: string | null;
  detalle: string;
  lineas: Array<{ conceptoId: string; valor: number }>;
  /** Lo que nos retuvo quien nos pagó (PC17): solo en una entrada. */
  retencion?: { tipo: 'RENTA' | 'IVA' | 'ICA'; valor: number } | null;
}

/** Dónde queda la retención que nos practican: anticipo de impuestos. */
const CUENTA_SUFRIDA = {
  RENTA: { codigo: '135515', nombre: 'Retención en la fuente' },
  IVA: { codigo: '135517', nombre: 'Impuesto a las ventas retenido' },
  ICA: {
    codigo: '135518',
    nombre: 'Impuesto de industria y comercio retenido',
  },
} as const;

const CAMPOS = `
  m.id, m.direccion, m.medio, m.caja_id, m.cuenta_bancaria_id, m.fecha, m.concepto_id,
  m.tercero_id, m.valor_concepto, m.valor_movido, m.detalle, m.origen, m.origen_id,
  m.asiento_id, m.estado, m.motivo_anulacion, m.caja_movimiento_id, m.banco_movimiento_id,
  c.codigo AS concepto_codigo, c.nombre AS concepto_nombre,
  (SELECT coalesce(json_agg(json_build_object('conceptoId', l.concepto_id, 'concepto', k.nombre,
                                              'valor', l.valor) ORDER BY l.orden), '[]'::json)
     FROM movimiento_concepto_linea l JOIN concepto_movimiento k ON k.id = l.concepto_id
    WHERE l.movimiento_id = m.id) AS lineas,
  (SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido))
     FROM tercero x WHERE x.id = m.tercero_id) AS tercero_nombre,
  COALESCE((SELECT k.nombre FROM caja k WHERE k.id = m.caja_id),
           (SELECT b.banco || ' ' || b.numero_cuenta FROM cuenta_bancaria b
             WHERE b.id = m.cuenta_bancaria_id)) AS destino`;

/**
 * Plata que entra o sale por un concepto: un ingreso o un egreso sin factura,
 * el 4×1000, la comisión del datáfono, un anticipo.
 *
 * Por dentro es un movimiento de caja o banco de los de siempre, con su
 * asiento: la línea del concepto lleva `concepto_id`, así el flujo de caja
 * sabe de qué actividad fue. Anular no borra: registra el movimiento
 * contrario en el mismo libro.
 */
@Injectable()
export class MovimientoConceptoService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly cajas: CajaMovimientoService,
    private readonly bancos: BancoMovimientoService,
  ) {}

  async registrar(
    ctx: CtxEmpresa,
    datos: DatosMovimientoConcepto,
    tx?: Tx,
  ): Promise<MovimientoConcepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        // Una línea o varias (PC14): cada concepto se valida igual.
        const pedidas =
          datos.lineas !== undefined && datos.lineas.length > 0
            ? datos.lineas
            : [{ conceptoId: datos.conceptoId, valor: datos.valorConcepto }];
        const lineas: Array<{
          concepto: Awaited<ReturnType<NucleoApi['concepto']>>;
          cuentaId: string;
          valor: number;
        }> = [];
        for (const l of pedidas) {
          const concepto = await this.nucleo.concepto(ctx, l.conceptoId, t);
          if (!concepto.activo) {
            throw new BadRequestException(
              `El concepto «${concepto.nombre}» está inactivo.`,
            );
          }
          if (concepto.cuenta === null) {
            throw new BadRequestException(
              `El concepto «${concepto.nombre}» no tiene cuenta: elíjala en Contabilidad → Conceptos.`,
            );
          }
          const direccion = problemaDeDireccion(concepto.tipo, datos.direccion);
          if (direccion !== null) throw new BadRequestException(direccion);
          if (datos.origen === 'MANUAL') {
            if (concepto.automatico) {
              throw new BadRequestException(
                `«${concepto.nombre}» lo usa el sistema por su cuenta: no se registra a mano.`,
              );
            }
            if (
              datos.direccion === 'SALIDA' &&
              !admiteSinFactura(concepto.tipo, concepto.cuenta.codigo)
            ) {
              throw new BadRequestException(
                `«${concepto.nombre}» se paga con factura o documento soporte, y lleva retención: regístrelo en Compras.`,
              );
            }
          }
          lineas.push({
            concepto,
            cuentaId: concepto.cuenta.id,
            valor: l.valor,
          });
        }
        const concepto = lineas[0].concepto;
        const valorConcepto =
          Math.round(lineas.reduce((s2, l) => s2 + l.valor, 0) * 100) / 100;

        const retenciones = datos.retenciones ?? [];
        const movido = valorMovido(valorConcepto, retenciones);
        if (!movido.ok) throw new BadRequestException(movido.motivo);

        const salida = datos.direccion === 'SALIDA';
        const tercero = datos.terceroId ?? undefined;
        const contrapartidas: Contrapartida[] = [
          ...lineas.map((l) => ({
            cuentaId: l.cuentaId,
            debito: salida ? l.valor : 0,
            credito: salida ? 0 : l.valor,
            terceroId: tercero,
            conceptoId: l.concepto.id,
          })),
          // En una salida, la retención que se practica queda por pagar
          // (crédito); en una entrada, la que nos practicaron es un anticipo
          // de impuestos (débito). En los dos casos se mueve el neto.
          ...retenciones.map((r) => ({
            cuentaId: r.cuentaId,
            debito: salida ? 0 : r.valor,
            credito: salida ? r.valor : 0,
            terceroId: tercero,
            baseGravable: r.base,
          })),
        ];

        let movimiento: { id: string; asiento_id: string | null };
        if (datos.medio === 'CAJA') {
          if (datos.cajaId === undefined)
            throw new BadRequestException('Elija la caja.');
          movimiento = await this.cajas.registrarConContrapartidas(
            ctx,
            datos.cajaId,
            {
              tipo: salida ? 'EGRESO' : 'INGRESO',
              fecha: datos.fecha,
              valor: movido.valor,
              concepto: datos.detalle,
              terceroId: datos.terceroId ?? null,
              contrapartidas,
            },
            t,
          );
        } else {
          if (datos.cuentaBancariaId === undefined) {
            throw new BadRequestException('Elija la cuenta bancaria.');
          }
          movimiento = await this.bancos.registrarConContrapartidas(
            ctx,
            datos.cuentaBancariaId,
            {
              // Lo que el banco cobra solo —el 4×1000— es una nota débito, como
              // lo muestra el extracto; lo demás, una transferencia.
              tipo:
                datos.origen === 'GMF'
                  ? 'NOTA_DEBITO'
                  : salida
                    ? 'TRANSFERENCIA_SALIENTE'
                    : 'TRANSFERENCIA_ENTRANTE',
              fecha: datos.fecha,
              valor: movido.valor,
              concepto: datos.detalle,
              terceroId: datos.terceroId ?? null,
              contrapartidas,
            },
            t,
          );
        }

        const creado = fila<{ id: string }>(
          await t.query(
            `INSERT INTO movimiento_concepto
               (empresa_id, direccion, medio, caja_id, cuenta_bancaria_id, caja_movimiento_id,
                banco_movimiento_id, asiento_id, concepto_id, tercero_id, fecha, valor_concepto,
                valor_movido, detalle, origen, origen_id, creado_por, devuelve_a)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
             RETURNING id`,
            [
              ctx.empresaId,
              datos.direccion,
              datos.medio,
              datos.medio === 'CAJA' ? datos.cajaId : null,
              datos.medio === 'BANCO' ? datos.cuentaBancariaId : null,
              datos.medio === 'CAJA' ? movimiento.id : null,
              datos.medio === 'BANCO' ? movimiento.id : null,
              movimiento.asiento_id,
              concepto.id,
              datos.terceroId ?? null,
              datos.fecha,
              valorConcepto,
              movido.valor,
              datos.detalle.trim(),
              datos.origen,
              datos.origenId ?? null,
              ctx.usuarioId,
              datos.devuelveA ?? null,
            ],
          ),
        );
        if (creado === undefined)
          throw new BadRequestException('No se pudo registrar el movimiento.');
        if (lineas.length > 1) {
          for (const [i, l] of lineas.entries()) {
            await t.query(
              `INSERT INTO movimiento_concepto_linea (movimiento_id, empresa_id, orden, concepto_id, valor)
               VALUES ($1, $2, $3, $4, $5)`,
              [creado.id, ctx.empresaId, i + 1, l.concepto.id, l.valor],
            );
          }
        }
        return this.obtener(ctx, creado.id, t);
      },
      tx,
    );
  }

  /**
   * Lo que se registra a mano desde Cobros o Pagos: una línea o varias
   * (PC14), con la retención que nos practicaron si es una entrada (PC17), y
   * el 4×1000 si sale de un banco (E27).
   */
  async registrarManual(
    ctx: CtxEmpresa,
    datos: DatosManual,
    tx?: Tx,
  ): Promise<MovimientoConcepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const retenciones: RetencionDelMovimiento[] = [];
        if (datos.retencion != null) {
          if (datos.direccion === 'SALIDA') {
            throw new BadRequestException(
              'La retención que le practican va en una entrada. En un pago, la practica usted: eso va por Compras.',
            );
          }
          if (!datos.terceroId) {
            throw new BadRequestException(
              'Indique quién le retuvo: la retención va a su nombre para el certificado.',
            );
          }
          const c = CUENTA_SUFRIDA[datos.retencion.tipo];
          await this.nucleo.asegurarCuenta(ctx, c, t);
          const cuenta = await this.nucleo.cuenta(ctx, c.codigo, t);
          if (cuenta === null) {
            throw new BadRequestException(`Falta la cuenta ${c.codigo}.`);
          }
          retenciones.push({
            cuentaId: cuenta.id,
            valor: datos.retencion.valor,
            base: datos.lineas.reduce((s2, l) => s2 + l.valor, 0),
          });
        }
        const movimiento = await this.registrar(
          ctx,
          {
            direccion: datos.direccion,
            medio: datos.medio,
            cajaId: datos.cajaId,
            cuentaBancariaId: datos.cuentaBancariaId,
            fecha: datos.fecha,
            conceptoId: datos.lineas[0].conceptoId,
            terceroId: datos.terceroId ?? null,
            detalle: datos.detalle,
            valorConcepto: datos.lineas[0].valor,
            lineas: datos.lineas,
            retenciones,
            origen: 'MANUAL',
          },
          t,
        );
        if (
          datos.direccion === 'SALIDA' &&
          datos.medio === 'BANCO' &&
          datos.cuentaBancariaId !== undefined
        ) {
          await this.cobrarGmf(
            ctx,
            {
              cuentaBancariaId: datos.cuentaBancariaId,
              base: movimiento.valorMovido,
              fecha: datos.fecha,
              detalle: `4×1000 · ${datos.detalle.trim()}`,
              origenId: movimiento.id,
            },
            t,
          );
        }
        return movimiento;
      },
      tx,
    );
  }

  /**
   * El 4×1000 de una salida de banco, si la cuenta no está exenta. Devuelve
   * `null` cuando no hay nada que cobrar.
   */
  async cobrarGmf(
    ctx: CtxEmpresa,
    datos: {
      cuentaBancariaId: string;
      base: number;
      fecha: string;
      detalle: string;
      origenId?: string | null;
    },
    t: Tx,
  ): Promise<MovimientoConcepto | null> {
    const cuenta = fila<{ exenta_gmf: boolean }>(
      await t.query('SELECT exenta_gmf FROM cuenta_bancaria WHERE id = $1', [
        datos.cuentaBancariaId,
      ]),
    );
    if (cuenta === undefined)
      throw new NotFoundException('Cuenta bancaria no encontrada.');
    const valor = gmfDe(datos.base, cuenta.exenta_gmf);
    if (valor === 0) return null;
    const concepto = await this.nucleo.conceptoPorCodigo(ctx, 'GTO-GMF', t);
    return this.registrar(
      ctx,
      {
        direccion: 'SALIDA',
        medio: 'BANCO',
        cuentaBancariaId: datos.cuentaBancariaId,
        fecha: datos.fecha,
        conceptoId: concepto.id,
        detalle: datos.detalle,
        valorConcepto: valor,
        origen: 'GMF',
        origenId: datos.origenId ?? null,
      },
      t,
    );
  }

  /** El 4×1000 que va dentro de `total` cuando lo asume quien recibe (`gmfIncluido`). */
  async gmfIncluidoEn(
    cuentaBancariaId: string,
    total: number,
    t: Tx,
  ): Promise<number> {
    const cuenta = fila<{ exenta_gmf: boolean }>(
      await t.query('SELECT exenta_gmf FROM cuenta_bancaria WHERE id = $1', [
        cuentaBancariaId,
      ]),
    );
    if (cuenta === undefined)
      throw new NotFoundException('Cuenta bancaria no encontrada.');
    return gmfIncluido(total, cuenta.exenta_gmf);
  }

  /** Lo cuánto calcularía el 4×1000 de una salida, sin registrar nada. */
  async gmfPrevisto(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    base: number,
  ): Promise<number> {
    return this.tx.enContexto(ctx, async (t) => {
      const cuenta = fila<{ exenta_gmf: boolean }>(
        await t.query('SELECT exenta_gmf FROM cuenta_bancaria WHERE id = $1', [
          cuentaBancariaId,
        ]),
      );
      return cuenta === undefined ? 0 : gmfDe(base, cuenta.exenta_gmf);
    });
  }

  /**
   * Anula el movimiento con su contrario en el mismo libro. Lo que el
   * movimiento significaba afuera —la retención de un anticipo— lo deshace
   * quien lo originó, en la misma transacción.
   */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<MovimientoConcepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const m = fila<{
          estado: string;
          medio: 'CAJA' | 'BANCO';
          caja_id: string | null;
          cuenta_bancaria_id: string | null;
          caja_movimiento_id: string | null;
          banco_movimiento_id: string | null;
        }>(
          await t.query(
            `SELECT estado, medio, caja_id, cuenta_bancaria_id, caja_movimiento_id, banco_movimiento_id
               FROM movimiento_concepto WHERE id = $1 FOR UPDATE`,
            [id],
          ),
        );
        if (m === undefined)
          throw new NotFoundException('Ese movimiento no existe.');
        if (m.estado === 'ANULADO')
          throw new BadRequestException('Este movimiento ya está anulado.');

        const fecha = hoyEnColombia();
        const contrario =
          m.medio === 'CAJA'
            ? await this.cajas.reversar(
                ctx,
                m.caja_id!,
                m.caja_movimiento_id!,
                { fecha, motivo },
                t,
              )
            : await this.bancos.registrarContrario(
                ctx,
                m.cuenta_bancaria_id!,
                m.banco_movimiento_id!,
                { fecha, motivo },
                t,
              );

        await t.query(
          `UPDATE movimiento_concepto
              SET estado = 'ANULADO', motivo_anulacion = $2, anulado_en = now(), anulado_por = $3,
                  anulacion_movimiento_id = $4
            WHERE id = $1`,
          [id, motivo.trim(), ctx.usuarioId, contrario.id],
        );
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  /**
   * Anular desde la pantalla: solo lo registrado a mano. Lo que salió de un
   * recibo o de un comprobante se anula con su documento, que sabe qué más
   * deshacer (el cruce, la retención).
   */
  async anularManual(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
  ): Promise<MovimientoConcepto> {
    return this.tx.enContexto(ctx, async (t) => {
      const actual = await this.obtener(ctx, id, t);
      if (actual.origen !== 'MANUAL') {
        throw new BadRequestException(
          actual.origen === 'RECIBO_CAJA'
            ? 'Salió de un recibo de caja: se anula anulando el recibo.'
            : actual.origen === 'DEVOLUCION_ANTICIPO'
              ? 'Es la devolución de un anticipo: se anula desde Anticipos.'
              : 'Salió de un comprobante de egreso: se anula anulando el comprobante.',
        );
      }
      return this.anular(ctx, id, motivo, t);
    });
  }

  async obtener(
    ctx: CtxEmpresa,
    id: string,
    tx?: Tx,
  ): Promise<MovimientoConcepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS} FROM movimiento_concepto m
               JOIN concepto_movimiento c ON c.id = m.concepto_id
              WHERE m.id = $1`,
            [id],
          ),
        );
        if (f === undefined)
          throw new NotFoundException('Ese movimiento no existe.');
        return aMovimiento(f);
      },
      tx,
    );
  }

  async listar(
    ctx: CtxEmpresa,
    filtro: {
      direccion?: Direccion;
      terceroId?: string;
      conceptoCodigo?: string;
      origen?: OrigenMovimiento;
      soloVigentes?: boolean;
    } = {},
    tx?: Tx,
  ): Promise<MovimientoConcepto[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const condiciones: string[] = [];
        const params: unknown[] = [];
        const poner = (sql: string, valor: unknown) => {
          params.push(valor);
          condiciones.push(sql.replace('?', `$${params.length}`));
        };
        if (filtro.direccion !== undefined)
          poner('m.direccion = ?', filtro.direccion);
        if (filtro.terceroId !== undefined)
          poner('m.tercero_id = ?', filtro.terceroId);
        if (filtro.conceptoCodigo !== undefined)
          poner('c.codigo = ?', filtro.conceptoCodigo);
        if (filtro.origen !== undefined) poner('m.origen = ?', filtro.origen);
        if (filtro.soloVigentes === true)
          condiciones.push(`m.estado = 'VIGENTE'`);
        const donde =
          condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
        const f = filas<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS} FROM movimiento_concepto m
               JOIN concepto_movimiento c ON c.id = m.concepto_id
              ${donde}
              ORDER BY m.fecha DESC, m.creado_en DESC
              LIMIT 300`,
            params,
          ),
        );
        return f.map(aMovimiento);
      },
      tx,
    );
  }
}

function aMovimiento(f: Record<string, unknown>): MovimientoConcepto {
  return {
    id: f.id as string,
    direccion: f.direccion as Direccion,
    medio: f.medio as 'CAJA' | 'BANCO',
    cajaId: f.caja_id as string | null,
    cuentaBancariaId: f.cuenta_bancaria_id as string | null,
    destino: (f.destino as string | null) ?? '',
    fecha: f.fecha as string,
    conceptoId: f.concepto_id as string,
    conceptoCodigo: f.concepto_codigo as string,
    conceptoNombre: f.concepto_nombre as string,
    terceroId: f.tercero_id as string | null,
    terceroNombre: f.tercero_nombre as string | null,
    valorConcepto: Number(f.valor_concepto),
    valorMovido: Number(f.valor_movido),
    detalle: f.detalle as string,
    origen: f.origen as OrigenMovimiento,
    origenId: f.origen_id as string | null,
    asientoId: f.asiento_id as string | null,
    estado: f.estado as 'VIGENTE' | 'ANULADO',
    motivoAnulacion: f.motivo_anulacion as string | null,
    lineas: (
      (f.lineas ?? []) as Array<{
        conceptoId: string;
        concepto: string;
        valor: string | number;
      }>
    ).map((l) => ({
      conceptoId: l.conceptoId,
      concepto: l.concepto,
      valor: Number(l.valor),
    })),
  };
}
