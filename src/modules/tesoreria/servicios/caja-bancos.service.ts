import { Injectable, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { TIPOS_ENTRADA_BANCO } from './banco-movimiento.service';

export interface MovimientoDelDia {
  id: string;
  /** «11:42»: cuándo se registró. */
  hora: string;
  concepto: string;
  /** El número del asiento: «CE-000074», «CI-000230». */
  documento: string | null;
  /** Con quién: «Transportes Rápido Urabá». */
  tercero: string | null;
  entra: number;
  sale: number;
}

export interface DiaDeCaja {
  caja: {
    id: string;
    nombre: string;
    tipo: 'PRINCIPAL' | 'MENOR';
    responsable: string | null;
    /** El municipio de su sede: «Apartadó». */
    sede: string | null;
  };
  fecha: string;
  saldo: number;
  /** Lo que había antes del primer movimiento del día. */
  abrioCon: number;
  entro: number;
  salio: number;
  movimientos: MovimientoDelDia[];
  /** El último arqueo cerrado; `null` si nunca se contó. */
  ultimoArqueo: {
    fecha: string;
    diferencia: number;
    resultado: 'CUADRO' | 'SOBRANTE' | 'FALTANTE';
  } | null;
}

export interface MovimientoTesoreria {
  id: string;
  fecha: string;
  hora: string;
  medio: 'CAJA' | 'BANCO';
  cuentaId: string;
  /** «Caja principal», «Bancolombia». */
  cuenta: string;
  concepto: string;
  documento: string | null;
  tercero: string | null;
  entra: number;
  sale: number;
  /** El saldo de esa cuenta después del movimiento, como lo lleva su libro. */
  saldo: number;
  /** El saldo inicial de la cuenta: se lista, pero no suma en «entró». */
  apertura: boolean;
}

export interface MovimientosTesoreria {
  desde: string;
  hasta: string;
  movimientos: MovimientoTesoreria[];
  entro: number;
  salio: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Caja y bancos (Fase 6 de las pantallas complementarias): lo que se ve de la
 * caja en el día y los movimientos de todas las cuentas juntos. Solo lee: cada
 * libro (caja, banco) lleva su saldo corrido, y aquí se muestra ese mismo.
 */
@Injectable()
export class CajaBancosService {
  constructor(private readonly tx: TxService) {}

  /** El día de una caja (lienzo «Caja»): con qué abrió, qué entró y salió, y el último arqueo. */
  async diaDeCaja(
    ctx: CtxEmpresa,
    cajaId: string,
    fecha?: string,
    tx?: Tx,
  ): Promise<DiaDeCaja> {
    const dia = fecha ?? hoyEnColombia();
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const caja = fila<{
          id: string;
          nombre: string;
          tipo: 'PRINCIPAL' | 'MENOR';
          responsable: string | null;
          sede: string | null;
          saldo: string;
        }>(
          await t.query(
            `SELECT c.id, c.nombre, c.tipo,
                    (SELECT COALESCE(NULLIF(BTRIM(x.razon_social), ''), BTRIM(CONCAT_WS(' ', x.primer_nombre, x.primer_apellido)))
                       FROM tercero x WHERE x.id = c.responsable_tercero_id) AS responsable,
                    (SELECT mu.nombre FROM empresa_sede s JOIN municipio mu ON mu.codigo = s.municipio_codigo
                      WHERE s.id = c.sede_id) AS sede,
                    coalesce((SELECT m.saldo_valor FROM caja_movimiento m WHERE m.caja_id = c.id
                               ORDER BY m.secuencia DESC LIMIT 1), 0) AS saldo
               FROM caja c WHERE c.id = $1`,
            [cajaId],
          ),
        );
        if (caja === undefined)
          throw new NotFoundException('Esa caja no existe.');
        const movimientos = filas<{
          id: string;
          hora: string;
          tipo: string;
          concepto: string;
          valor: string;
          documento: string | null;
          tercero: string | null;
        }>(
          await t.query(
            `SELECT m.id, to_char(m.creado_en AT TIME ZONE 'America/Bogota', 'HH24:MI') AS hora,
                    m.tipo, m.concepto, m.valor, a.numero AS documento,
                    (SELECT COALESCE(NULLIF(BTRIM(x.razon_social), ''), BTRIM(CONCAT_WS(' ', x.primer_nombre, x.primer_apellido)))
                         FROM tercero x WHERE x.id = m.tercero_id) AS tercero
               FROM caja_movimiento m
               LEFT JOIN asiento a ON a.id = m.asiento_id
              WHERE m.caja_id = $1 AND m.fecha = $2 AND m.tipo <> 'SALDO_INICIAL'
              ORDER BY m.secuencia DESC`,
            [cajaId, dia],
          ),
        ).map((m) => ({
          id: m.id,
          hora: m.hora,
          concepto: m.concepto,
          documento: m.documento,
          tercero: m.tercero,
          entra: m.tipo === 'INGRESO' ? Number(m.valor) : 0,
          sale: m.tipo === 'EGRESO' ? Number(m.valor) : 0,
        }));
        const entro = r2(movimientos.reduce((s, m) => s + m.entra, 0));
        const salio = r2(movimientos.reduce((s, m) => s + m.sale, 0));
        const saldo = Number(caja.saldo);
        const arqueo = fila<{ fecha: string; diferencia: string }>(
          await t.query(
            `SELECT fecha::text AS fecha, diferencia FROM caja_arqueo
              WHERE caja_id = $1 AND estado = 'CERRADO'
              ORDER BY creado_en DESC LIMIT 1`,
            [cajaId],
          ),
        );
        return {
          caja: {
            id: caja.id,
            nombre: caja.nombre,
            tipo: caja.tipo,
            responsable: caja.responsable,
            sede: caja.sede,
          },
          fecha: dia,
          saldo,
          // Lo de hoy, al revés: así el saldo del día y el del libro son el mismo.
          abrioCon: r2(saldo - entro + salio),
          entro,
          salio,
          movimientos,
          ultimoArqueo:
            arqueo === undefined
              ? null
              : {
                  fecha: arqueo.fecha,
                  diferencia: Number(arqueo.diferencia),
                  resultado:
                    Number(arqueo.diferencia) === 0
                      ? 'CUADRO'
                      : Number(arqueo.diferencia) > 0
                        ? 'SOBRANTE'
                        : 'FALTANTE',
                },
        };
      },
      tx,
    );
  }

  /**
   * Caja y bancos → Movimientos: todas las cuentas juntas, del más reciente al
   * más viejo, cada uno con el saldo de su cuenta después de él.
   */
  async movimientos(
    ctx: CtxEmpresa,
    desde: string,
    hasta: string,
    tx?: Tx,
  ): Promise<MovimientosTesoreria> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const movimientos = filas<Record<string, unknown>>(
          await t.query(
            `SELECT * FROM (
               SELECT m.id, m.fecha::text AS fecha, m.secuencia, m.creado_en, 'CAJA' AS medio,
                      m.caja_id AS cuenta_id, k.nombre AS cuenta, m.concepto, a.numero AS documento,
                      (SELECT COALESCE(NULLIF(BTRIM(x.razon_social), ''), BTRIM(CONCAT_WS(' ', x.primer_nombre, x.primer_apellido)))
                         FROM tercero x WHERE x.id = m.tercero_id) AS tercero,
                      CASE WHEN m.tipo IN ('INGRESO', 'SALDO_INICIAL') THEN m.valor ELSE 0 END AS entra,
                      CASE WHEN m.tipo = 'EGRESO' THEN m.valor ELSE 0 END AS sale,
                      m.saldo_valor AS saldo, m.tipo = 'SALDO_INICIAL' AS apertura
                 FROM caja_movimiento m
                 JOIN caja k ON k.id = m.caja_id
                 LEFT JOIN asiento a ON a.id = m.asiento_id
                WHERE m.fecha BETWEEN $1 AND $2
               UNION ALL
               SELECT m.id, m.fecha::text, m.secuencia, m.creado_en, 'BANCO',
                      m.cuenta_bancaria_id, b.banco, m.concepto, a.numero,
                      (SELECT COALESCE(NULLIF(BTRIM(x.razon_social), ''), BTRIM(CONCAT_WS(' ', x.primer_nombre, x.primer_apellido)))
                         FROM tercero x WHERE x.id = m.tercero_id),
                      CASE WHEN m.tipo = ANY ($3) OR m.tipo = 'SALDO_INICIAL' THEN m.valor ELSE 0 END,
                      CASE WHEN m.tipo <> ALL ($3) AND m.tipo <> 'SALDO_INICIAL' THEN m.valor ELSE 0 END,
                      m.saldo_valor, m.tipo = 'SALDO_INICIAL'
                 FROM banco_movimiento m
                 JOIN cuenta_bancaria b ON b.id = m.cuenta_bancaria_id
                 LEFT JOIN asiento a ON a.id = m.asiento_id
                WHERE m.fecha BETWEEN $1 AND $2
             ) x
             ORDER BY x.fecha DESC, x.creado_en DESC, x.secuencia DESC
             LIMIT 1000`,
            [desde, hasta, TIPOS_ENTRADA_BANCO],
          ),
        ).map((m) => ({
          id: m.id as string,
          fecha: m.fecha as string,
          hora: new Date(m.creado_en as string).toLocaleTimeString('es-CO', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'America/Bogota',
          }),
          medio: m.medio as 'CAJA' | 'BANCO',
          cuentaId: m.cuenta_id as string,
          cuenta: m.cuenta as string,
          concepto: m.concepto as string,
          documento: (m.documento as string | null) ?? null,
          tercero: (m.tercero as string | null) ?? null,
          entra: Number(m.entra),
          sale: Number(m.sale),
          saldo: Number(m.saldo),
          apertura: m.apertura === true,
        }));
        return {
          desde,
          hasta,
          movimientos,
          // El saldo inicial se lista pero no suma: es con lo que se arrancó,
          // no plata que entró ese día.
          entro: r2(
            movimientos.reduce((s, m) => s + (m.apertura ? 0 : m.entra), 0),
          ),
          salio: r2(movimientos.reduce((s, m) => s + m.sale, 0)),
        };
      },
      tx,
    );
  }
}
