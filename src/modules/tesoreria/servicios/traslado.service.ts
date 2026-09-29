import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { BancoMovimientoService } from './banco-movimiento.service';
import { CajaMovimientoService } from './caja-movimiento.service';
import { gmfDe } from './movimiento-concepto.reglas';
import { MovimientoConceptoService } from './movimiento-concepto.service';
import {
  causaGmf,
  nombreDelTraslado,
  numeroTraslado,
  problemaDeTraslado,
  tipoEnBanco,
  type Extremo,
  type Medio,
} from './traslado.reglas';

/** Un extremo como lo manda la pantalla: el medio y cuál. */
export interface ExtremoInput {
  medio: Medio;
  cajaId?: string;
  cuentaBancariaId?: string;
}

export interface Traslado {
  id: string;
  numero: string;
  fecha: string;
  origen: { medio: Medio; id: string; nombre: string };
  destino: { medio: Medio; id: string; nombre: string };
  valor: number;
  detalle: string;
  gmf: number;
  estado: 'VIGENTE' | 'ANULADO';
  motivoAnulacion: string | null;
}

/** Un extremo ya resuelto: su cuenta contable y cómo se llama. */
interface ExtremoResuelto extends Extremo {
  cuentaId: string;
  nombre: string;
  exentaGmf: boolean;
}

const SELECT_TRASLADO = `
  SELECT x.id, x.numero, x.fecha::text AS fecha, x.valor, x.detalle, x.gmf, x.estado,
         x.motivo_anulacion, x.origen_medio, x.destino_medio,
         coalesce(x.origen_caja_id, x.origen_cuenta_bancaria_id) AS origen_id,
         coalesce(x.destino_caja_id, x.destino_cuenta_bancaria_id) AS destino_id,
         coalesce((SELECT k.nombre FROM caja k WHERE k.id = x.origen_caja_id),
                  (SELECT b.banco || ' ' || b.numero_cuenta FROM cuenta_bancaria b
                    WHERE b.id = x.origen_cuenta_bancaria_id)) AS origen_nombre,
         coalesce((SELECT k.nombre FROM caja k WHERE k.id = x.destino_caja_id),
                  (SELECT b.banco || ' ' || b.numero_cuenta FROM cuenta_bancaria b
                    WHERE b.id = x.destino_cuenta_bancaria_id)) AS destino_nombre
    FROM traslado x`;

/**
 * Traslados entre caja y bancos: la plata cambia de lugar, no es ingreso ni
 * gasto. Un documento, UN asiento (débito al destino, crédito al origen) y un
 * movimiento en cada libro que apunta a ese asiento. Si sale de un banco que
 * no es exento, el 4×1000 va aparte como movimiento por concepto.
 */
@Injectable()
export class TrasladoService {
  constructor(
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
    private readonly cajas: CajaMovimientoService,
    private readonly bancos: BancoMovimientoService,
    private readonly porConcepto: MovimientoConceptoService,
  ) {}

  /** Cuánto 4×1000 causaría, sin registrar nada: para mostrarlo antes de guardar. */
  async gmfPrevisto(
    ctx: CtxEmpresa,
    origen: ExtremoInput,
    destino: ExtremoInput,
    valor: number,
    tx?: Tx,
  ): Promise<{ causa: boolean; gmf: number }> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const o = await this.resolver(ctx, origen, t);
        const d = await this.resolver(ctx, destino, t);
        const causa = causaGmf(o, d);
        return { causa, gmf: causa ? gmfDe(valor, o.exentaGmf) : 0 };
      },
      tx,
    );
  }

  async crear(
    ctx: CtxEmpresa,
    datos: {
      fecha: string;
      origen: ExtremoInput;
      destino: ExtremoInput;
      valor: number;
      detalle?: string;
      /** Si el banco no cobró el 4×1000 aunque la regla diga que sí. */
      sinGmf?: boolean;
    },
    tx?: Tx,
  ): Promise<Traslado> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const origen = await this.resolver(ctx, datos.origen, t);
        const destino = await this.resolver(ctx, datos.destino, t);
        const problema = problemaDeTraslado(origen, destino);
        if (problema !== null) throw new BadRequestException(problema);

        const comprobante = await this.comprobante(ctx, 'CE', t);
        const numero = await this.siguienteNumero(ctx.empresaId, t);
        const trasladoId = randomUUID();
        const salidaId = randomUUID();
        const entradaId = randomUUID();
        const detalle =
          datos.detalle?.trim() ||
          nombreDelTraslado(origen.medio, destino.medio);
        const rotulo = `${numeroTraslado(numero)} · ${detalle}`;

        const asiento = await this.contabilidad.asentar(
          ctx,
          {
            comprobanteTipoId: comprobante,
            fecha: datos.fecha,
            glosa: `${rotulo}: de ${origen.nombre} a ${destino.nombre}`,
            lineas: [
              { cuentaId: destino.cuentaId, debito: datos.valor, credito: 0 },
              { cuentaId: origen.cuentaId, debito: 0, credito: datos.valor },
            ],
          },
          { origenTipo: movimientoDe(origen.medio), origenId: salidaId },
          t,
        );

        // Primero la salida: si la caja no tiene el efectivo, no se escribe nada.
        await this.mover(
          ctx,
          origen,
          'SALIDA',
          destino.medio,
          {
            id: salidaId,
            fecha: datos.fecha,
            valor: datos.valor,
            concepto: `${rotulo} → ${destino.nombre}`,
            trasladoId,
            asientoId: asiento.id,
          },
          t,
        );
        await this.mover(
          ctx,
          destino,
          'ENTRADA',
          origen.medio,
          {
            id: entradaId,
            fecha: datos.fecha,
            valor: datos.valor,
            concepto: `${rotulo} ← ${origen.nombre}`,
            trasladoId,
            asientoId: asiento.id,
          },
          t,
        );

        const gmf =
          causaGmf(origen, destino) && !datos.sinGmf
            ? await this.porConcepto.cobrarGmf(
                ctx,
                {
                  cuentaBancariaId: origen.id,
                  base: datos.valor,
                  fecha: datos.fecha,
                  detalle: `4×1000 del ${numeroTraslado(numero)}`,
                  origenId: trasladoId,
                },
                t,
              )
            : null;

        await t.query(
          `INSERT INTO traslado
           (id, empresa_id, numero, fecha, origen_medio, origen_caja_id, origen_cuenta_bancaria_id,
            destino_medio, destino_caja_id, destino_cuenta_bancaria_id, valor, detalle, asiento_id,
            salida_movimiento_id, entrada_movimiento_id, gmf, gmf_movimiento_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            trasladoId,
            ctx.empresaId,
            numero,
            datos.fecha,
            origen.medio,
            origen.medio === 'CAJA' ? origen.id : null,
            origen.medio === 'BANCO' ? origen.id : null,
            destino.medio,
            destino.medio === 'CAJA' ? destino.id : null,
            destino.medio === 'BANCO' ? destino.id : null,
            datos.valor,
            detalle,
            asiento.id,
            salidaId,
            entradaId,
            gmf?.valorMovido ?? 0,
            gmf?.id ?? null,
            ctx.usuarioId,
          ],
        );
        return this.obtener(ctx, trasladoId, t);
      },
      tx,
    );
  }

  /**
   * Anula con un solo asiento invertido y el movimiento contrario en cada
   * libro: la plata sale del destino y vuelve al origen. Si el destino es una
   * caja que ya no tiene ese efectivo, no se puede —como cualquier egreso—.
   * El 4×1000 se anula con su movimiento.
   */
  async anular(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<Traslado> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const x = fila<{
          numero: number;
          estado: string;
          valor: string;
          detalle: string;
          asiento_id: string;
          gmf_movimiento_id: string | null;
          origen_medio: Medio;
          origen_id: string;
          destino_medio: Medio;
          destino_id: string;
        }>(
          await t.query(
            `SELECT numero, estado, valor, detalle, asiento_id, gmf_movimiento_id,
                  origen_medio, coalesce(origen_caja_id, origen_cuenta_bancaria_id) AS origen_id,
                  destino_medio, coalesce(destino_caja_id, destino_cuenta_bancaria_id) AS destino_id
             FROM traslado WHERE id = $1 FOR UPDATE`,
            [id],
          ),
        );
        if (x === undefined)
          throw new NotFoundException('Ese traslado no existe.');
        if (x.estado === 'ANULADO')
          throw new BadRequestException('Este traslado ya está anulado.');

        const lineas = await this.contabilidad.lineasInvertidasDe(
          ctx,
          x.asiento_id,
          t,
        );
        if (lineas === null) {
          throw new BadRequestException(
            'El asiento de este traslado está anulado: no hay nada que deshacer en la contabilidad.',
          );
        }
        const origen = await this.resolver(
          ctx,
          extremoDe(x.origen_medio, x.origen_id),
          t,
          true,
        );
        const destino = await this.resolver(
          ctx,
          extremoDe(x.destino_medio, x.destino_id),
          t,
          true,
        );
        const fecha = hoyEnColombia();
        const rotulo = `Anulación del ${numeroTraslado(x.numero)} · ${x.detalle}`;
        const valor = Number(x.valor);
        const devuelveId = randomUUID();
        const vuelveId = randomUUID();

        const comprobante = await this.comprobante(ctx, 'CI', t);
        const asiento = await this.contabilidad.asentar(
          ctx,
          {
            comprobanteTipoId: comprobante,
            fecha,
            glosa: `${rotulo} — ${motivo.trim()}`,
            lineas,
          },
          { origenTipo: movimientoDe(destino.medio), origenId: devuelveId },
          t,
        );

        await this.mover(
          ctx,
          destino,
          'SALIDA',
          origen.medio,
          {
            id: devuelveId,
            fecha,
            valor,
            concepto: `${rotulo} → ${origen.nombre}`,
            trasladoId: id,
            asientoId: asiento.id,
          },
          t,
        );
        await this.mover(
          ctx,
          origen,
          'ENTRADA',
          destino.medio,
          {
            id: vuelveId,
            fecha,
            valor,
            concepto: `${rotulo} ← ${destino.nombre}`,
            trasladoId: id,
            asientoId: asiento.id,
          },
          t,
        );

        if (x.gmf_movimiento_id !== null) {
          await this.porConcepto.anular(ctx, x.gmf_movimiento_id, motivo, t);
        }

        await t.query(
          `UPDATE traslado
            SET estado = 'ANULADO', motivo_anulacion = $2, anulado_en = now(), anulado_por = $3,
                asiento_anulacion_id = $4
          WHERE id = $1`,
          [id, motivo.trim(), ctx.usuarioId, asiento.id],
        );
        return this.obtener(ctx, id, t);
      },
      tx,
    );
  }

  async obtener(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<Traslado> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(`${SELECT_TRASLADO} WHERE x.id = $1`, [id]),
        );
        if (f === undefined)
          throw new NotFoundException('Ese traslado no existe.');
        return aTraslado(f);
      },
      tx,
    );
  }

  /** Los traslados, el más reciente primero. */
  async listar(ctx: CtxEmpresa): Promise<Traslado[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `${SELECT_TRASLADO} ORDER BY x.fecha DESC, x.numero DESC LIMIT 300`,
        ),
      ).map(aTraslado),
    );
  }

  /** La cuenta contable, el nombre y, en banco, el banco y si es exenta. */
  private async resolver(
    ctx: CtxEmpresa,
    e: ExtremoInput,
    t: Tx,
    /** Al anular, la caja o la cuenta pudo desactivarse después: igual se deshace. */
    inactivaVale = false,
  ): Promise<ExtremoResuelto> {
    if (e.medio === 'CAJA') {
      if (!e.cajaId) throw new BadRequestException('Elegí la caja.');
      if (inactivaVale) {
        const k = fila<{ cuenta_id: string; nombre: string }>(
          await t.query('SELECT cuenta_id, nombre FROM caja WHERE id = $1', [
            e.cajaId,
          ]),
        );
        if (k === undefined) throw new NotFoundException('Caja no encontrada');
        return {
          medio: 'CAJA',
          id: e.cajaId,
          cuentaId: k.cuenta_id,
          nombre: k.nombre,
          exentaGmf: false,
        };
      }
      const k = await this.cajas.cuentaDe(ctx, e.cajaId, t);
      return { medio: 'CAJA', id: e.cajaId, ...k, exentaGmf: false };
    }
    if (!e.cuentaBancariaId)
      throw new BadRequestException('Elegí la cuenta bancaria.');
    if (inactivaVale) {
      const b = fila<{
        cuenta_id: string;
        banco: string;
        numero_cuenta: string;
        exenta_gmf: boolean;
      }>(
        await t.query(
          'SELECT cuenta_id, banco, numero_cuenta, exenta_gmf FROM cuenta_bancaria WHERE id = $1',
          [e.cuentaBancariaId],
        ),
      );
      if (b === undefined)
        throw new NotFoundException('Cuenta bancaria no encontrada');
      return {
        medio: 'BANCO',
        id: e.cuentaBancariaId,
        cuentaId: b.cuenta_id,
        nombre: `${b.banco} ${b.numero_cuenta}`,
        banco: b.banco,
        exentaGmf: b.exenta_gmf,
      };
    }
    const b = await this.bancos.cuentaDe(ctx, e.cuentaBancariaId, t);
    return { medio: 'BANCO', id: e.cuentaBancariaId, ...b };
  }

  /** Un lado en su libro, apuntando al asiento del traslado. */
  private async mover(
    ctx: CtxEmpresa,
    extremo: ExtremoResuelto,
    lado: 'SALIDA' | 'ENTRADA',
    otro: Medio,
    datos: {
      id: string;
      fecha: string;
      valor: number;
      concepto: string;
      trasladoId: string;
      asientoId: string;
    },
    t: Tx,
  ): Promise<void> {
    if (extremo.medio === 'CAJA') {
      await this.cajas.registrarDeTraslado(
        ctx,
        extremo.id,
        { ...datos, tipo: lado === 'SALIDA' ? 'EGRESO' : 'INGRESO' },
        t,
      );
    } else {
      await this.bancos.registrarDeTraslado(
        ctx,
        extremo.id,
        { ...datos, tipo: tipoEnBanco(lado, otro) },
        t,
      );
    }
  }

  private async comprobante(
    ctx: CtxEmpresa,
    codigo: 'CI' | 'CE',
    t: Tx,
  ): Promise<string> {
    const c = await this.contabilidad.tipoComprobantePorCodigo(ctx, codigo, t);
    if (c === null) {
      throw new BadRequestException(
        `La empresa no tiene el comprobante de ${codigo === 'CI' ? 'ingreso' : 'egreso'} sembrado.`,
      );
    }
    return c.id;
  }

  private async siguienteNumero(empresaId: string, t: Tx): Promise<number> {
    await t.query(
      `INSERT INTO traslado_consecutivo (empresa_id) VALUES ($1)
       ON CONFLICT (empresa_id) DO NOTHING`,
      [empresaId],
    );
    const tomado = fila<{ consecutivo_actual: number }>(
      await t.query(
        `UPDATE traslado_consecutivo SET consecutivo_actual = consecutivo_actual + 1
          WHERE empresa_id = $1 RETURNING consecutivo_actual`,
        [empresaId],
      ),
    );
    if (tomado === undefined)
      throw new BadRequestException('No se pudo numerar el traslado.');
    return Number(tomado.consecutivo_actual);
  }
}

function movimientoDe(medio: Medio): 'MOVIMIENTO_CAJA' | 'MOVIMIENTO_BANCO' {
  return medio === 'CAJA' ? 'MOVIMIENTO_CAJA' : 'MOVIMIENTO_BANCO';
}

function extremoDe(medio: Medio, id: string): ExtremoInput {
  return medio === 'CAJA'
    ? { medio, cajaId: id }
    : { medio, cuentaBancariaId: id };
}

function aTraslado(f: Record<string, unknown>): Traslado {
  return {
    id: String(f.id),
    numero: numeroTraslado(Number(f.numero)),
    fecha: String(f.fecha),
    origen: {
      medio: f.origen_medio as Medio,
      id: String(f.origen_id),
      nombre: (f.origen_nombre as string | null) ?? '',
    },
    destino: {
      medio: f.destino_medio as Medio,
      id: String(f.destino_id),
      nombre: (f.destino_nombre as string | null) ?? '',
    },
    valor: Number(f.valor),
    detalle: String(f.detalle),
    gmf: Number(f.gmf),
    estado: f.estado as Traslado['estado'],
    motivoAnulacion: (f.motivo_anulacion as string | null) ?? null,
  };
}
