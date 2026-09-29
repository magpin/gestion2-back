import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { fila, filas } from '../../common/db/filas';
import { TxService, type Tx } from '../../common/db/tx.service';
import {
  ContabilidadApi,
  type VistaAsiento,
} from '../contabilidad/contabilidad.api';
import type { CrearFacturaDto } from './dto/factura.dto';
import type { CobrarDto } from './dto/venta.dto';
import {
  HistoricoService,
  type ResultadoCarga,
} from './servicios/historico.service';
import {
  numeroComoTexto,
  partirNumero,
  type FacturaHistoricaEntrada,
} from './servicios/historico.reglas';
import { calcularLineas } from './servicios/venta.reglas';
import { ReciboCajaService } from './servicios/recibo-caja.service';
import {
  FacturaService,
  type OrigenDeLaFactura,
} from './servicios/factura.service';
import {
  VentaDocumentoService,
  type VentaDocumentoDetalle,
  type VentaDocumentoResumen,
} from './servicios/venta-documento.service';

/** Una factura, tal como la ve quien la va a cobrar. */
export interface FacturaParaCobrar {
  id: string;
  numero: string;
  cliente: string;
  pendiente: string;
}

/**
 * La única clase que `ventas` expone a otros módulos.
 *
 * Estuvo vacía hasta el paso 7 de `docs/planes/asistente-conversacion.md`
 * (`asistente-acciones.md`): el asistente propone cobros y una persona los
 * confirma. Todo lo de acá **pasa por el mismo código que la pantalla**
 * —`cobrarEnTx`—, así que un cobro propuesto se valida, se asienta y falla
 * exactamente igual que uno digitado.
 *
 * **No mira roles**: eso lo hace quien llama, con las listas del controlador
 * (`@Roles('CAJA', 'DIRECTOR')` en `facturas/:id/cobrar`).
 */
@Injectable()
export class VentasApi {
  constructor(
    private readonly ventas: VentaDocumentoService,
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
    private readonly facturas: FacturaService,
    private readonly historico: HistoricoService,
    private readonly recibos: ReciboCajaService,
  ) {}

  /** Lo que falta cobrar, con su vencimiento. Lo lee el flujo de caja proyectado. */
  pendientesPorCobrar(ctx: CtxEmpresa, tx?: Tx) {
    return this.recibos.pendientesConVence(ctx, tx);
  }

  /** La cartera por cliente, lo más vencido primero. La lee el tablero de Inicio. */
  cartera(ctx: CtxEmpresa, tx?: Tx) {
    return this.recibos.porCobrar(ctx, tx);
  }

  /**
   * Cuáles de estos números de factura ya están en el sistema —emitidas acá o
   * cargadas como históricas—, comparados como los compara la carga: «FEV
   * 13892» y «FEV-013892» son la misma. Una histórica anulada no cuenta:
   * anularla es la forma de volver a cargarla. La llave es el número tal como
   * llegó.
   */
  async facturasExistentes(
    ctx: CtxEmpresa,
    numeros: string[],
  ): Promise<Map<string, { id: string; numero: string }>> {
    const buscados = new Map<string, string[]>();
    for (const n of numeros) {
      const partido = partirNumero(n);
      if (partido === null) continue;
      const llave = numeroComoTexto(partido);
      buscados.set(llave, [...(buscados.get(llave) ?? []), n]);
    }
    const encontrados = new Map<string, { id: string; numero: string }>();
    if (buscados.size === 0) return encontrados;

    const existentes = await this.tx.enContexto(ctx, async (t) =>
      filas<{ id: string; prefijo: string | null; consecutivo: number }>(
        await t.query(`
          SELECT id, prefijo, consecutivo FROM venta_documento
           WHERE tipo = 'FACTURA' AND NOT (historica AND estado = 'ANULADA')`),
      ),
    );
    for (const e of existentes) {
      const llave = numeroComoTexto({
        prefijo:
          e.prefijo === null || e.prefijo === ''
            ? null
            : e.prefijo.toUpperCase(),
        consecutivo: Number(e.consecutivo),
      });
      for (const original of buscados.get(llave) ?? []) {
        encontrados.set(original, { id: e.id, numero: llave });
      }
    }
    return encontrados;
  }

  /**
   * Carga facturas históricas por **la misma puerta que el Excel** (fase 10):
   * número y fecha originales, sin resolución, sin asiento y sin kardex, y
   * todas o ninguna. «Pagada» es lo pagado igual al total que da la factura
   * calculada, no el impreso: la carga no acepta pagar de más ni un centavo.
   *
   * No mira roles: los mira quien llama, con los de `POST /facturas-historicas`.
   */
  cargarHistoricas(
    ctx: CtxEmpresa,
    facturas: Array<
      Omit<FacturaHistoricaEntrada, 'pagado'> & { pagada: boolean }
    >,
  ): Promise<ResultadoCarga> {
    return this.historico.cargar(
      ctx,
      facturas.map(({ pagada, ...f }) => ({
        ...f,
        pagado: pagada ? calcularLineas(f.lineas).totales.total : 0,
      })),
      false,
    );
  }

  /**
   * Emite una factura. **La misma puerta que `POST /facturas`**: el mismo
   * precio de lista, la misma resolución, el mismo asiento y el mismo kardex.
   *
   * Existe para que `lectura-documentos` emita la factura que una persona armó
   * a partir de un pedido leído, dejando dicho de qué pedido salió —y un
   * pedido se factura una vez: lo impide un índice único de la 0064—.
   */
  crearFactura(
    ctx: CtxEmpresa,
    dto: CrearFacturaDto,
    origen: OrigenDeLaFactura,
  ): Promise<VentaDocumentoDetalle> {
    return this.facturas.crear(ctx, dto, origen);
  }

  /**
   * Una factura vigente por su número, como sale en la cartera y en la
   * pantalla: `SETT-5` (el consecutivo sin ceros adelante, o con ellos).
   * `null` si no hay una factura emitida con ese número.
   */
  async facturaPorNumero(
    ctx: CtxEmpresa,
    numero: string,
  ): Promise<FacturaParaCobrar | null> {
    const partido = /^\s*(.*?)-?0*(\d+)\s*$/.exec(numero);
    if (partido === null) return null;
    const [, prefijo, consecutivo] = partido;
    const encontrada = await this.tx.enContexto(ctx, async (t) =>
      fila<{ id: string }>(
        await t.query(
          `SELECT id FROM venta_documento
            WHERE tipo = 'FACTURA' AND estado = 'EMITIDA'
              AND upper(coalesce(prefijo, '')) = upper($1)
              AND consecutivo = $2`,
          [prefijo.replace(/-$/, ''), Number(consecutivo)],
        ),
      ),
    );
    if (encontrada === undefined) return null;
    const d = await this.ventas.porId(ctx, 'FACTURA', encontrada.id);
    return {
      id: d.id,
      numero: [d.prefijo, d.consecutivo].filter((p) => p !== null).join('-'),
      cliente: d.tercero_nombre,
      pendiente: d.pendiente,
    };
  }

  /**
   * El cobro **en seco**: se corre el de verdad y se deshace
   * (`TxService.simular`). Si no pasaría, tira el mismo error que tiraría el
   * cobro. Si pasa, devuelve cómo quedaría la factura y los asientos que se
   * harían.
   */
  async simularCobro(
    ctx: CtxEmpresa,
    facturaId: string,
    dto: CobrarDto,
  ): Promise<{ documento: VentaDocumentoResumen; asientos: VistaAsiento[] }> {
    return this.tx.simular(ctx, async (t) => {
      const documento = await this.ventas.cobrarEnTx(ctx, facturaId, dto, t);
      const asientos = await this.contabilidad.asientosDeLaTransaccion(t);
      return { documento, asientos };
    });
  }

  /**
   * El cobro de verdad, en la transacción de quien llama: la propuesta del
   * asistente se marca confirmada en la misma, y o quedan las dos cosas o
   * ninguna.
   */
  cobrarEnTx(
    ctx: CtxEmpresa,
    facturaId: string,
    dto: CobrarDto,
    t: Tx,
  ): Promise<VentaDocumentoResumen> {
    return this.ventas.cobrarEnTx(ctx, facturaId, dto, t);
  }
}
