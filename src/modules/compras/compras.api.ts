import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { filas } from '../../common/db/filas';
import { TxService, type Tx } from '../../common/db/tx.service';
import {
  ContabilidadApi,
  type VistaAsiento,
} from '../contabilidad/contabilidad.api';
import type { CrearCompraDto, PagarDto } from './dto/compra.dto';
import {
  CompraService,
  type CompraDocumentoDetalle,
  type OrigenDeLaCompra,
  type CompraDocumentoResumen,
} from './servicios/compra.service';
import { ComprobanteEgresoService } from './servicios/comprobante-egreso.service';
import { PagoProgramadoService } from './servicios/pago-programado.service';

/** Una compra, tal como la ve quien la va a pagar. */
export interface CompraParaPagar {
  id: string;
  numero: string;
  proveedor: string;
  pendiente: string;
}

/**
 * La única clase que `compras` expone a otros módulos.
 *
 * Estuvo vacía hasta el paso 7 de `docs/planes/asistente-conversacion.md`
 * (`asistente-acciones.md`): el asistente propone pagos y una persona los
 * confirma. Es el espejo de `VentasApi`, y por la misma razón todo pasa por
 * `pagarEnTx`, el código de la pantalla.
 *
 * **No mira roles**: eso lo hace quien llama, con las listas del controlador
 * (`@Roles('CAJA', 'DIRECTOR')` en `compras/:id/pagar`).
 */
@Injectable()
export class ComprasApi {
  constructor(
    private readonly compras: CompraService,
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
    private readonly comprobantes: ComprobanteEgresoService,
    private readonly programados: PagoProgramadoService,
  ) {}

  /** Lo que falta pagar, con su vencimiento. Lo lee el flujo de caja proyectado. */
  async pendientesPorPagar(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<Array<{ vence: string; pendiente: number }>> {
    const porPagar = await this.comprobantes.porPagar(ctx, tx);
    return porPagar.proveedores.flatMap((p) =>
      p.compras.map((c) => ({
        vence: c.venceEfectivo,
        pendiente: c.pendiente,
      })),
    );
  }

  /** Lo que falta pagar por proveedor, lo que vence primero arriba. Lo lee el tablero de Inicio. */
  porPagar(ctx: CtxEmpresa, tx?: Tx) {
    return this.comprobantes.porPagar(ctx, tx);
  }

  /** Los pagos programados que siguen pendientes, con su fecha. */
  async programadosPendientes(ctx: CtxEmpresa): Promise<
    Array<{
      fecha: string;
      valor: number;
      descripcion: string;
      compraId: string | null;
    }>
  > {
    return (await this.programados.listar(ctx, true)).map((p) => ({
      fecha: p.fecha,
      valor: p.valor,
      descripcion: p.descripcion,
      compraId: p.compraId,
    }));
  }

  /**
   * Las compras vigentes con ese número de factura del proveedor. El número
   * lo pone cada proveedor, así que **dos pueden repetirlo**: por eso vuelve
   * una lista, y con \`proveedor\` (parte del nombre, sin tildes) se acota.
   */
  async comprasPorNumero(
    ctx: CtxEmpresa,
    numero: string,
    proveedor?: string,
  ): Promise<CompraParaPagar[]> {
    const ids = await this.tx.enContexto(ctx, async (t) =>
      filas<{ id: string }>(
        await t.query(
          `SELECT c.id
             FROM compra_documento c
             JOIN tercero t ON t.id = c.tercero_id
            WHERE c.tipo = 'FACTURA' AND c.estado = 'EMITIDA'
              AND upper(btrim(c.numero_factura_proveedor)) = upper(btrim($1))
              AND ($2::text IS NULL OR fn_normalizar(
                    COALESCE(NULLIF(BTRIM(t.razon_social), ''),
                      CONCAT_WS(' ', t.primer_nombre, t.primer_apellido)))
                  LIKE '%' || fn_normalizar($2) || '%')
            LIMIT 5`,
          [numero, proveedor?.trim() ? proveedor : null],
        ),
      ),
    );
    const compras: CompraParaPagar[] = [];
    for (const { id } of ids) {
      const d = await this.compras.porId(ctx, id);
      compras.push({
        id: d.id,
        numero: d.numero_factura_proveedor,
        proveedor: d.tercero_nombre,
        pendiente: d.pendiente,
      });
    }
    return compras;
  }

  /** El pago **en seco**: el de verdad, deshecho. Ver `VentasApi.simularCobro`. */
  async simularPago(
    ctx: CtxEmpresa,
    compraId: string,
    dto: PagarDto,
  ): Promise<{ documento: CompraDocumentoResumen; asientos: VistaAsiento[] }> {
    return this.tx.simular(ctx, async (t) => {
      const documento = await this.compras.pagarEnTx(ctx, compraId, dto, t);
      const asientos = await this.contabilidad.asientosDeLaTransaccion(t);
      return { documento, asientos };
    });
  }

  /**
   * Registra una compra. **La misma puerta que el endpoint manual**: las
   * mismas validaciones, el mismo asiento, el mismo kardex.
   *
   * Existe para que `lectura-documentos` pueda registrar lo que una persona
   * confirmó de una factura leída, sin abrirse un camino propio a la base. Es
   * el mismo criterio con el que ese módulo aplica un RUT por `NucleoApi`: si
   * hubiera dos caminos, habría dos verdades sobre qué es una compra válida.
   *
   * Con `tx`, se engancha a la transacción de quien llama: lo que ese módulo
   * escriba junto con la compra —lo que María aprendió de la factura— entra o
   * no entra con ella.
   */
  /** La retención de renta que llevaría una compra, sin registrarla. */
  simularRenta(
    ctx: CtxEmpresa,
    dto: Pick<
      CrearCompraDto,
      | 'terceroId'
      | 'fecha'
      | 'lineas'
      | 'conceptosRenta'
      | 'zomacEnFactura'
      | 'pagadaConTarjeta'
      | 'municipioCodigo'
    >,
  ) {
    return this.compras.simularRenta(ctx, dto);
  }

  async registrar(
    ctx: CtxEmpresa,
    dto: CrearCompraDto,
    origen?: OrigenDeLaCompra,
    tx?: Tx,
  ): Promise<CompraDocumentoDetalle> {
    return this.compras.crear(ctx, dto, origen, tx);
  }

  /** El pago de verdad, en la transacción de quien llama. */
  pagarEnTx(
    ctx: CtxEmpresa,
    compraId: string,
    dto: PagarDto,
    t: Tx,
  ): Promise<CompraDocumentoResumen> {
    return this.compras.pagarEnTx(ctx, compraId, dto, t);
  }
}
