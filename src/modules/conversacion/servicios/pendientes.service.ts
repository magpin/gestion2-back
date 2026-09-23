import { Injectable } from '@nestjs/common';

import type { CtxEmpresa, RolCodigo } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';

/**
 * Lo que espera una decisión de quien mira: el número de la barra lateral y la
 * píldora «2 pendientes» del encabezado del chat (lámina `Aplicada` de
 * `maria-identidad/`).
 *
 * **Solo lo que esa persona puede resolver.** Una factura leída le pesa a quien
 * registra compras; un pedido, a quien factura. Contarle a alguien de consulta
 * lo que no puede hacer sería un número que no se baja nunca.
 *
 * Lee directo de las tablas de `lectura-documentos`, como `revision`: es un
 * conteo, no escribe nada.
 */

export interface Pendientes {
  total: number;
  /** Cobros o pagos que María propuso a esta persona y nadie confirmó. */
  propuestas: number;
  /** Facturas de compra leídas y sin registrar. */
  facturas: number;
  /** Pedidos de clientes leídos y sin facturar. */
  pedidos: number;
}

export interface ResumenSemana {
  /** Documentos que María leyó desde el lunes, de cualquier tipo. */
  leidos: number;
  /** Asientos vigentes de esta semana que salieron de ella y una persona aprobó. */
  aprobados: number;
  /** Lo mismo que `Pendientes.total`: lo que espera a quien mira. */
  esperan: number;
}

/** Los mismos roles de `POST /facturas-leidas/:id/registrar`. */
const ROLES_FACTURAS: readonly RolCodigo[] = [
  'ADMIN_TENANT',
  'DIRECTOR',
  'CONTADOR',
  'COMPRAS',
];
/** Los mismos de `POST /pedidos-leidos/:id/facturar`. */
const ROLES_PEDIDOS: readonly RolCodigo[] = ['DIRECTOR', 'VENTAS'];

const puede = (ctx: CtxEmpresa, roles: readonly RolCodigo[]) =>
  ctx.roles.some((r) => roles.includes(r));

@Injectable()
export class PendientesService {
  constructor(private readonly tx: TxService) {}

  async contar(ctx: CtxEmpresa): Promise<Pendientes> {
    return this.tx.enContexto(ctx, async (t) => {
      const propuestas = await this.propuestas(ctx, t);
      const facturas = puede(ctx, ROLES_FACTURAS)
        ? await this.lecturas(t, 'FACTURA_COMPRA')
        : 0;
      const pedidos = puede(ctx, ROLES_PEDIDOS)
        ? await this.lecturas(t, 'PEDIDO_VENTA')
        : 0;
      return {
        total: propuestas + facturas + pedidos,
        propuestas,
        facturas,
        pedidos,
      };
    });
  }

  /**
   * «María esta semana», la tarjeta del tablero: lo que leyó, lo que de eso
   * terminó en el libro, y lo que todavía espera a quien mira.
   *
   * La semana empieza el lunes en hora de Colombia, que es la semana de la
   * empresa y no la del servidor. «Aprobados» son asientos vigentes que salieron
   * de ella —de una propuesta suya o de un documento que leyó— y que por lo
   * tanto alguien aprobó: María no asienta sola.
   */
  async semana(ctx: CtxEmpresa): Promise<ResumenSemana> {
    const esperan = (await this.contar(ctx)).total;
    return this.tx.enContexto(ctx, async (t) => {
      const r = fila<{ leidos: string; aprobados: string }>(
        await t.query(`
          WITH desde AS (
            SELECT date_trunc('week', now() AT TIME ZONE 'America/Bogota')
                     AT TIME ZONE 'America/Bogota' AS lunes
          )
          SELECT
            (SELECT count(*) FROM documento_leido d, desde
              WHERE d.estado IN ('LEIDO', 'DESCARTADO') AND d.leido_en >= desde.lunes) AS leidos,
            (SELECT count(*) FROM asiento a, desde
              WHERE a.estado = 'REGISTRADO' AND a.creado_en >= desde.lunes
                AND (a.propuesta_id IS NOT NULL
                     OR EXISTS (SELECT 1 FROM compra_documento c
                                 WHERE c.asiento_id = a.id AND c.documento_leido_id IS NOT NULL)
                     OR EXISTS (SELECT 1 FROM venta_documento v
                                 WHERE v.asiento_id = a.id AND v.documento_leido_id IS NOT NULL))
            ) AS aprobados`),
      );
      return {
        leidos: Number(r?.leidos ?? 0),
        aprobados: Number(r?.aprobados ?? 0),
        esperan,
      };
    });
  }

  /** Las suyas: una propuesta la confirma quien la pidió. */
  private async propuestas(ctx: CtxEmpresa, t: Tx): Promise<number> {
    const r = fila<{ n: string }>(
      await t.query(
        `SELECT count(*) AS n FROM asistente_propuesta
          WHERE estado = 'PENDIENTE' AND usuario_id = $1`,
        [ctx.usuarioId],
      ),
    );
    return Number(r?.n ?? 0);
  }

  /**
   * Las lecturas sin registrar, **una vez por documento**: la misma cuenta de
   * cobro subida cuatro veces es un pendiente, no cuatro. Y si una de las
   * lecturas de ese documento ya se registró, las otras sobran y no cuentan
   * —de eso avisa la revisión—.
   *
   * El documento se reconoce igual que en la revisión: tercero, número, fecha
   * y total.
   */
  private async lecturas(
    t: Tx,
    tipo: 'FACTURA_COMPRA' | 'PEDIDO_VENTA',
  ): Promise<number> {
    const raiz = tipo === 'FACTURA_COMPRA' ? 'factura' : 'pedido';
    const tercero = tipo === 'FACTURA_COMPRA' ? 'proveedor' : 'cliente';
    const total =
      tipo === 'FACTURA_COMPRA'
        ? `d.extraido #>> '{factura,impreso,total}'`
        : `d.extraido #>> '{pedido,subtotalImpreso}'`;
    const r = fila<{ n: string }>(
      await t.query(`
        WITH lectura AS (
          SELECT concat_ws('|',
                   coalesce(d.extraido #>> '{${raiz},${tercero},nit}',
                            d.extraido #>> '{${raiz},${tercero},nombre}'),
                   d.extraido #>> '{${raiz},numero}',
                   d.extraido #>> '{${raiz},fecha}',
                   ${total}) AS documento,
                 (c.id IS NOT NULL OR v.id IS NOT NULL) AS registrada
            FROM documento_leido d
            LEFT JOIN compra_documento c ON c.documento_leido_id = d.id AND c.estado <> 'ANULADA'
            LEFT JOIN venta_documento v  ON v.documento_leido_id = d.id AND v.estado <> 'ANULADA'
           WHERE d.tipo = '${tipo}' AND d.estado = 'LEIDO' AND d.extraido IS NOT NULL
        )
        SELECT count(*) AS n FROM (
          SELECT documento FROM lectura
           GROUP BY documento
          HAVING NOT bool_or(registrada)
        ) x`),
    );
    return Number(r?.n ?? 0);
  }
}
