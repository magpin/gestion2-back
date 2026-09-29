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
  type Direccion,
} from './movimiento-concepto.reglas';

export type OrigenMovimiento =
  'MANUAL' | 'RECIBO_CAJA' | 'COMPROBANTE_EGRESO' | 'GMF';

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
}

const CAMPOS = `
  m.id, m.direccion, m.medio, m.caja_id, m.cuenta_bancaria_id, m.fecha, m.concepto_id,
  m.tercero_id, m.valor_concepto, m.valor_movido, m.detalle, m.origen, m.origen_id,
  m.asiento_id, m.estado, m.motivo_anulacion, m.caja_movimiento_id, m.banco_movimiento_id,
  c.codigo AS concepto_codigo, c.nombre AS concepto_nombre,
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
        const concepto = await this.nucleo.concepto(ctx, datos.conceptoId, t);
        if (!concepto.activo) {
          throw new BadRequestException(
            `El concepto «${concepto.nombre}» está inactivo.`,
          );
        }
        if (concepto.cuenta === null) {
          throw new BadRequestException(
            `El concepto «${concepto.nombre}» no tiene cuenta: elegila en Contabilidad → Conceptos.`,
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
              `«${concepto.nombre}» se paga con factura o documento soporte, y lleva retención: registralo en Compras.`,
            );
          }
        }

        const retenciones = datos.retenciones ?? [];
        const movido = valorMovido(datos.valorConcepto, retenciones);
        if (!movido.ok) throw new BadRequestException(movido.motivo);

        const salida = datos.direccion === 'SALIDA';
        const tercero = datos.terceroId ?? undefined;
        const contrapartidas: Contrapartida[] = [
          {
            cuentaId: concepto.cuenta.id,
            debito: salida ? datos.valorConcepto : 0,
            credito: salida ? 0 : datos.valorConcepto,
            terceroId: tercero,
            conceptoId: concepto.id,
          },
          ...retenciones.map((r) => ({
            cuentaId: r.cuentaId,
            debito: 0,
            credito: r.valor,
            terceroId: tercero,
            baseGravable: r.base,
          })),
        ];

        let movimiento: { id: string; asiento_id: string | null };
        if (datos.medio === 'CAJA') {
          if (datos.cajaId === undefined)
            throw new BadRequestException('Elegí la caja.');
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
            throw new BadRequestException('Elegí la cuenta bancaria.');
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
                valor_movido, detalle, origen, origen_id, creado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
              datos.valorConcepto,
              movido.valor,
              datos.detalle.trim(),
              datos.origen,
              datos.origenId ?? null,
              ctx.usuarioId,
            ],
          ),
        );
        if (creado === undefined)
          throw new BadRequestException('No se pudo registrar el movimiento.');
        return this.obtener(ctx, creado.id, t);
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
  };
}
