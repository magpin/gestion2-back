import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { filas } from '../../common/db/filas';
import type { Tx } from '../../common/db/tx.service';
import type { CrearAsientoDto } from './dto/asiento.dto';
import { AsientoService, type Origen } from './servicios/asiento.service';
import { ComprobanteService } from './servicios/comprobante.service';
import { PeriodoService } from './servicios/periodo.service';

/**
 * La unica clase que `contabilidad` expone a otros modulos.
 *
 * Todo lo demas —servicios, controladores, DTOs— es interno. Ventas no va a
 * importar `AsientoService`: va a llamar `asentar()`. Esa regla es lo que
 * permite cambiar como se guarda un asiento sin que se entere nadie mas.
 *
 * Los metodos que escriben EXIGEN `Tx`. No es opcional como en `NucleoApi`: la
 * factura y su asiento entran juntos o no entra ninguno. Una factura sin asiento
 * es un papel; un asiento sin factura descuadra el libro.
 */
/** Un asiento como lo lee quien confirma: número, glosa y sus líneas. */
export interface VistaAsiento {
  numero: string;
  glosa: string;
  lineas: {
    cuenta: string;
    nombre: string;
    tercero: string | null;
    debito: string;
    credito: string;
  }[];
}

@Injectable()
export class ContabilidadApi {
  constructor(
    private readonly asientos: AsientoService,
    private readonly periodos: PeriodoService,
    private readonly comprobantes: ComprobanteService,
  ) {}

  /**
   * Los asientos creados **en la transacción en curso**, con sus líneas.
   *
   * Es la vista previa de la verificación en seco (`TxService.simular`): se
   * corre el cobro de verdad, se leen los asientos que dejó y se deshace.
   * Una fila nueva lleva en `xmin` el id de la transacción que la creó, y eso
   * la distingue de cualquier otra sin depender de la hora.
   */
  async asientosDeLaTransaccion(t: Tx): Promise<VistaAsiento[]> {
    const lineas = filas<{
      asiento_id: string;
      numero: string;
      glosa: string;
      cuenta: string;
      nombre: string;
      tercero: string | null;
      debito: string;
      credito: string;
    }>(
      await t.query(
        `SELECT a.id AS asiento_id, a.numero, a.glosa,
                ec.codigo AS cuenta, ec.nombre,
                COALESCE(NULLIF(BTRIM(tr.razon_social), ''),
                  NULLIF(BTRIM(CONCAT_WS(' ', tr.primer_nombre, tr.primer_apellido)), '')) AS tercero,
                al.debito, al.credito
           FROM asiento a
           JOIN asiento_linea al ON al.asiento_id = a.id
           JOIN empresa_cuenta ec
             ON ec.id = al.cuenta_id AND ec.empresa_id = al.empresa_id
           LEFT JOIN tercero tr ON tr.id = al.tercero_id
          WHERE a.xmin::text::bigint = txid_current() % 4294967296
          ORDER BY a.numero, al.orden`,
      ),
    );
    const asientos = new Map<string, VistaAsiento>();
    for (const l of lineas) {
      const a = asientos.get(l.asiento_id) ?? {
        numero: l.numero,
        glosa: l.glosa,
        lineas: [],
      };
      a.lineas.push({
        cuenta: l.cuenta,
        nombre: l.nombre,
        tercero: l.tercero,
        debito: l.debito,
        credito: l.credito,
      });
      asientos.set(l.asiento_id, a);
    }
    return [...asientos.values()];
  }

  /**
   * El asiento de un documento.
   *
   * Quien es dueno de la cabecera —la venta, la compra— abre la transaccion y la
   * pasa. Las lineas ya vienen armadas por el modulo que conoce el negocio: aca
   * solo se verifica la partida doble, que es lo unico que es igual para todos.
   */
  async asentar(
    ctx: CtxEmpresa,
    dto: CrearAsientoDto,
    origen: Origen,
    tx: Tx,
  ): Promise<{ id: string; numero: string }> {
    return this.asientos.crear(ctx, dto, origen, tx);
  }

  /**
   * Si se puede escribir con esta fecha.
   *
   * Ventas pregunta ANTES de armar la factura: descubrir que el periodo esta
   * cerrado despues de numerar el documento obliga a devolver el consecutivo, y
   * ahi ya se gasto.
   */
  async periodoAbiertoEn(
    ctx: CtxEmpresa,
    fecha: Date,
    tx?: Tx,
  ): Promise<boolean> {
    const periodo = await this.periodos.porFecha(ctx, fecha, tx);
    return periodo !== null && periodo.estado === 'ABIERTO';
  }

  /**
   * El año y el mes del periodo que contiene una fecha, o `null` si no hay.
   *
   * Lo pide `reportes` para resolver «el periodo contable en curso». Usa la
   * misma definicion que `GET periodos/actual` —el periodo que contiene la
   * fecha— y no otra: si el reporte llamara «en curso» a un periodo distinto
   * del que la pantalla de contabilidad muestra como actual, las dos hojas del
   * mismo contador dirian cosas diferentes.
   */
  async periodoEn(
    ctx: CtxEmpresa,
    fecha: Date,
  ): Promise<{
    anio: number;
    mes: number;
    estado: 'ABIERTO' | 'CERRADO';
  } | null> {
    const periodo = await this.periodos.porFecha(ctx, fecha);
    return periodo === null
      ? null
      : { anio: periodo.anio, mes: periodo.mes, estado: periodo.estado };
  }

  /**
   * El ultimo periodo que se cerro, o `null` si nunca se cerro ninguno.
   *
   * Lo pide `reportes` para «el cierre del periodo anterior»: la cartera a la
   * fecha en que el contador dio por bueno un mes. No es lo mismo que «el
   * cierre del mes pasado» —si agosto sigue abierto, el ultimo cerrado es
   * julio—, y la diferencia es justamente la que importa en una foto de saldos.
   */
  async ultimoPeriodoCerrado(
    ctx: CtxEmpresa,
  ): Promise<{ anio: number; mes: number } | null> {
    // `listar` los devuelve del mas nuevo al mas viejo, asi que el primero
    // cerrado es el ultimo que se cerro.
    const periodos = await this.periodos.listar(ctx);
    const cerrado = periodos.find((p) => p.estado === 'CERRADO');
    return cerrado === undefined
      ? null
      : { anio: cerrado.anio, mes: cerrado.mes };
  }

  /** El asiento que genero un documento, para mostrarlo al lado. */
  async asientoDe(
    ctx: CtxEmpresa,
    origenTipo: string,
    origenId: string,
    tx?: Tx,
  ): Promise<{ id: string; numero: string } | null> {
    return this.asientos.porOrigen(ctx, origenTipo, origenId, tx);
  }

  /**
   * Anula un asiento. No borra nada.
   *
   * `tx` es opcional para que el endpoint HTTP de `contabilidad`
   * (`POST /asientos/:id/anular`) lo siga llamando sin uno, pero quien
   * anula un documento propio —una factura de `ventas`— tiene que pasar la
   * transacción que ya tiene abierta: la anulación del asiento y la del
   * documento se confirman juntas o ninguna de las dos.
   */
  async anular(
    ctx: CtxEmpresa,
    asientoId: string,
    motivo: string,
    tx?: Tx,
  ): Promise<void> {
    await this.asientos.anular(ctx, asientoId, motivo, tx);
  }

  /**
   * Un asiento que da vuelta a otro: mismas cuentas, mismos terceros, débitos
   * y créditos intercambiados.
   *
   * No es anular. Anular deja el asiento viejo marcado y su período tiene que
   * estar abierto; invertir registra un hecho nuevo con la fecha de hoy, que es
   * lo que necesita un libro —la caja— cuyo saldo corrido ya contó el original.
   * Devuelve `null` si el original no existe o ya está anulado.
   */
  async lineasInvertidasDe(
    ctx: CtxEmpresa,
    asientoId: string,
    tx: Tx,
  ): Promise<CrearAsientoDto['lineas'] | null> {
    const lineas = await this.asientos.lineasParaInvertir(ctx, asientoId, tx);
    if (lineas === null) return null;
    return lineas.map((l) => ({
      cuentaId: l.cuentaId,
      terceroId: l.terceroId ?? undefined,
      centroCostoId: l.centroCostoId ?? undefined,
      baseGravable: l.baseGravable ?? undefined,
      debito: l.credito,
      credito: l.debito,
    }));
  }

  /**
   * Un tipo de comprobante por código (ej. `'CD'`), para módulos que asientan
   * automático y necesitan uno ya existente. `null` si la empresa no lo
   * sembró o está desactivado.
   */
  async tipoComprobantePorCodigo(
    ctx: CtxEmpresa,
    codigo: string,
    tx?: Tx,
  ): Promise<{ id: string } | null> {
    return this.comprobantes.porCodigo(ctx, codigo, tx);
  }

  /**
   * Siembra los cinco tipos de comprobante de una empresa nueva.
   *
   * Lo llama `nucleo` al crear la empresa, dentro de su misma transaccion: una
   * empresa sin donde asentar no puede registrar nada, y dejarlo para despues
   * significa que alguien tiene que acordarse.
   */
  async sembrarComprobantes(empresaId: string, tx: Tx): Promise<void> {
    await this.comprobantes.sembrar(empresaId, tx);
  }
}
