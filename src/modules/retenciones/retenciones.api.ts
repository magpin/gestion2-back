import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import type { Tx } from '../../common/db/tx.service';
import { elegirTarifa } from './servicios/parametros.reglas';
import {
  MotorRentaService,
  type DocumentoRenta,
  type PropuestaRenta,
  type RentaConfirmada,
  type RespuestasRenta,
} from './servicios/motor-renta.service';
import {
  MotorVentaService,
  type VentaConfirmada,
} from './servicios/motor-venta.service';
import { ClasificadorIaService } from './servicios/clasificador-ia.service';
import { ParametrosService } from './servicios/parametros.service';
import { calcularRetencion } from './servicios/retencion.reglas';
import {
  RecalculoService,
  type ResumenEmpresa,
} from './servicios/recalculo.service';
import type { CondicionLeida } from './reglas/propuesta-perfil.reglas';
import { PerfilTerceroService } from './servicios/perfil-tercero.service';
import { RetencionService } from './servicios/retencion.service';
import { AnticipoRetencionService } from './servicios/anticipo-retencion.service';

export interface RetencionCalculada {
  conceptoId: string;
  tipo: 'RENTA' | 'IVA' | 'ICA';
  concepto: string;
  cuentaId: string;
  base: number;
  tarifa: number;
  valor: number;
  /** De qué norma sale la tarifa, cuando vino de la ley. */
  norma?: string;
}

/**
 * Lo único que `retenciones` expone a otros módulos: calcular cuánto se retiene
 * de una base, con la tarifa y la base mínima que rigen **a la fecha del
 * documento**.
 *
 * Compras la usa para lo que le retiene al proveedor; Ventas, para lo que el
 * cliente nos retiene a nosotros. Es el mismo cálculo de los dos lados: lo que
 * cambia es contra qué cuenta va —un pasivo cuando retenemos, un activo cuando
 * nos retienen— y eso lo decide quien llama, no esto.
 *
 * **Desde 0074/0075 la tarifa sale de la ley** (`retencion_tarifa`), a la fecha
 * del documento, cuando el concepto de la empresa está enlazado a uno de la
 * ley. Las filas cargadas a mano sin equivalente siguen con su tarifa y su año
 * hasta que el contador las enlace (plan motor de retenciones, Fase 0).
 */
@Injectable()
export class RetencionesApi {
  constructor(
    private readonly retenciones: RetencionService,
    private readonly parametros: ParametrosService,
    private readonly motorRenta: MotorRentaService,
    private readonly motorVenta: MotorVentaService,
    private readonly clasificadorIa: ClasificadorIaService,
    private readonly recalculo: RecalculoService,
    private readonly perfiles: PerfilTerceroService,
    private readonly anticipos: AnticipoRetencionService,
  ) {}

  /**
   * La retención de un anticipo a proveedor, sin guardar nada: el concepto
   * con su certeza y lo que se retendría (D11b). Ver `AnticipoRetencionService`.
   */
  proponerAnticipo(
    ctx: CtxEmpresa,
    datos: Parameters<AnticipoRetencionService['proponer']>[1],
    tx?: Tx,
  ) {
    return this.anticipos.proponer(ctx, datos, tx);
  }

  /** Retiene el anticipo y lo guarda para la 350. Devuelve lo retenido por cuenta. */
  confirmarAnticipo(
    ctx: CtxEmpresa,
    datos: Parameters<AnticipoRetencionService['confirmar']>[1],
    tx: Tx,
  ) {
    return this.anticipos.confirmar(ctx, datos, tx);
  }

  /** Reversa una proporción de la retención del anticipo (el cruce o la anulación). */
  reversarAnticipo(
    ctx: CtxEmpresa,
    datos: Parameters<AnticipoRetencionService['reversar']>[1],
    tx: Tx,
  ) {
    return this.anticipos.reversar(ctx, datos, tx);
  }

  /** Vuelve a poner lo que un cruce reversó, al anular el cruce. */
  restablecerAnticipo(
    ctx: CtxEmpresa,
    datos: Parameters<AnticipoRetencionService['restablecer']>[1],
    tx: Tx,
  ) {
    return this.anticipos.restablecer(ctx, datos, tx);
  }

  /** Lo que retuvo el anticipo y sigue vivo. */
  retencionVivaDeAnticipo(anticipoId: string, tx: Tx) {
    return this.anticipos.vivo(tx, anticipoId);
  }

  /**
   * La fuente 5 (Fase 5): le pregunta a la IA por los renglones que ninguna
   * fuente resolvió y guarda lo que dijo. **Fuera de toda transacción**: quien
   * llama vuelve a proponer después. Devuelve cuántos quedaron con propuesta.
   */
  completarConIa(ctx: CtxEmpresa, doc: DocumentoRenta): Promise<number> {
    return this.clasificadorIa.completar(ctx, doc);
  }

  /**
   * El lado de la venta (Fase 4): la autorretención especial y la de venta a
   * un cliente del SIMPLE, guardadas con su explicación, y el aviso si lo que
   * el cliente dice que retuvo no cuadra con la norma.
   */
  confirmarVenta(
    ctx: CtxEmpresa,
    venta: {
      documentoId: string;
      terceroId: string;
      fecha: string;
      subtotal: number;
      iva: number;
      registradas: { renta: number; iva: number };
    },
    tx: Tx,
  ): Promise<VentaConfirmada> {
    return this.motorVenta.confirmar(ctx, venta, tx);
  }

  /**
   * La retención en la fuente de renta de una compra, **sin guardar nada**: el
   * concepto de cada renglón con su certeza, lo que se retiene y lo que falta
   * contestar (plan motor de retenciones, Fase 1). La usan las pantallas.
   */
  proponerRenta(
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    respuestas?: RespuestasRenta,
    tx?: Tx,
  ): Promise<PropuestaRenta> {
    return this.motorRenta.proponer(ctx, doc, respuestas, tx);
  }

  /**
   * La puerta única al registrar: exige lo deducido aceptado, guarda cada
   * retención con su explicación (`retencion_calculada`), aprende lo
   * contestado y devuelve lo que va al asiento.
   */
  /**
   * La reversa proporcional de la renta de una compra, por una nota crédito.
   * Devuelve, por código de concepto, la fila nueva de `retencion_calculada`.
   */
  reversarRenta(
    ctx: CtxEmpresa,
    datos: {
      compraId: string;
      notaId: string;
      proporcion: number;
      fecha: string;
    },
    tx: Tx,
  ): Promise<Map<string, string>> {
    return this.motorRenta.reversar(ctx, datos, tx);
  }

  /**
   * Lo que la nota crédito va a reversar de cada retención de la compra, sin
   * escribir nada: la nota lo usa en su asiento para que la 2365 diga lo mismo
   * que el motor (bug 4). Por id de la retención original y, de respaldo, por
   * `concepto|municipio`.
   */
  async reversaRentaPrevista(
    datos: { compraId: string; proporcion: number },
    tx: Tx,
  ): Promise<Map<string, { base: number; valor: number }>> {
    const previstas = new Map<string, { base: number; valor: number }>();
    for (const p of await this.motorRenta.reversaPrevista(tx, datos)) {
      const cifra = { base: p.base, valor: p.valor };
      previstas.set(p.retencionId, cifra);
      if (!previstas.has(p.clave)) previstas.set(p.clave, cifra);
    }
    return previstas;
  }

  /**
   * La nota crédito de venta baja la autorretención en proporción (plan,
   * §6.0). Devuelve las líneas que van en el asiento de la nota.
   */
  reversarAutorretencionPorNota(
    ctx: CtxEmpresa,
    datos: {
      ventaId: string;
      notaId: string;
      proporcion: number;
      fecha: string;
    },
    tx: Tx,
  ): Promise<VentaConfirmada['lineasAsiento']> {
    return this.motorVenta.reversarPorNota(ctx, datos, tx);
  }

  /** Anular una factura o una nota crédito deja su autorretención en cero. */
  anularAutorretencion(
    ctx: CtxEmpresa,
    datos: { documentoId: string; fecha: string; motivo: string },
    tx: Tx,
  ): Promise<void> {
    return this.motorVenta.anular(ctx, datos, tx);
  }

  /**
   * Recalcula las compras de una empresa en un rango con la norma que rige
   * hoy y deja sus diferencias (plan, §6.3). Lo llama la consola, empresa por
   * empresa, con el contexto de cada una.
   */
  recalcularEmpresa(
    ctx: CtxEmpresa,
    datos: { recalculoId: string; desde: string; hasta: string },
  ): Promise<ResumenEmpresa> {
    return this.recalculo.recalcularEmpresa(ctx, datos);
  }

  /**
   * Lo que la factura leída dice del proveedor y no coincide con su perfil
   * queda como propuesta para que una persona la apruebe (Fase 8, §8.8).
   */
  proponerPerfilDesdeFactura(
    ctx: CtxEmpresa,
    datos: {
      terceroId: string;
      documentoLeidoId: string | null;
      referencia: string | null;
      fecha: string;
      leido: CondicionLeida;
    },
  ): Promise<number> {
    return this.perfiles.proponerDesdeFactura(ctx, datos);
  }

  /** Los ajustes por cambio de norma vivos de una compra (Fase 8, §8.3). */
  ajustesDeCompra(ctx: CtxEmpresa, compraId: string, tx?: Tx) {
    return this.recalculo.ajustesDeCompra(ctx, compraId, tx);
  }

  /** Anular una compra deja su retención en cero (plan, §6.0). */
  anularRetencionesCompra(
    ctx: CtxEmpresa,
    datos: { compraId: string; fecha: string; motivo: string },
    tx: Tx,
  ): Promise<void> {
    return this.motorRenta.anularCompra(ctx, datos, tx);
  }

  /** Las retenciones calculadas con su explicación, para el asistente. */
  retencionesParaAsistente(
    ctx: CtxEmpresa,
    filtros: {
      proveedor?: string;
      numero?: string;
      desde?: string;
      hasta?: string;
    },
  ) {
    return this.motorRenta.consultar(ctx, filtros);
  }

  confirmarRenta(
    ctx: CtxEmpresa,
    doc: DocumentoRenta,
    respuestas: RespuestasRenta,
    documento: { tipo: 'COMPRA' | 'NOTA_DEBITO_COMPRA'; id: string },
    tx: Tx,
  ): Promise<RentaConfirmada> {
    return this.motorRenta.confirmar(ctx, doc, respuestas, documento, tx);
  }

  /**
   * Cuánto se retiene por este concepto sobre esta base.
   *
   * Devuelve `null` cuando **no corresponde retener** —la base no llega al
   * mínimo—, que no es un error: es la respuesta correcta y muy común en
   * compras chicas.
   */
  async calcular(
    ctx: CtxEmpresa,
    datos: {
      conceptoId: string;
      base: number;
      fecha: string;
      /** Del tercero. Decide la tarifa en los conceptos que tienen dos. */
      declaranteRenta: boolean;
      /**
       * Del beneficiario. La ley distingue persona natural y jurídica en
       * algunos conceptos (honorarios, comisiones). Sin el dato se toma
       * jurídica, que es la tarifa más alta en esos conceptos: retener de más
       * se devuelve; de menos, lo paga el agente.
       */
      tipoPersona?: 'NATURAL' | 'JURIDICA';
      /**
       * El IVA del documento, calculado por el servidor. En la retención de IVA
       * la tarifa se aplica sobre el IVA, no sobre `base`: `base` (el subtotal)
       * solo decide si se llega al mínimo. Viene del servidor y no del
       * navegador: el agente retenedor responde por lo que debió retener.
       */
      ivaDocumento?: number;
      /**
       * `RETENEMOS` (compras): va al pasivo con la DIAN. `NOS_RETIENEN`
       * (ventas): va al anticipo de la empresa. Decide la cuenta, no el valor.
       */
      lado?: 'RETENEMOS' | 'NOS_RETIENEN';
    },
    tx?: Tx,
  ): Promise<RetencionCalculada | null> {
    const concepto = await this.retenciones.porId(ctx, datos.conceptoId, tx);
    if (concepto === null || !concepto.activo) {
      throw new BadRequestException(
        'Ese concepto de retención no existe o está archivado.',
      );
    }

    // Las filas cargadas a mano antes de 0076 tienen una sola cuenta, la que
    // el contador eligió para el lado en que las usaba.
    const cuentaId =
      datos.lado === 'NOS_RETIENEN'
        ? (concepto.cuenta_activo_id ?? concepto.cuenta_id)
        : concepto.cuenta_id;
    if (cuentaId === null) {
      throw new BadRequestException(
        datos.lado === 'NOS_RETIENEN'
          ? `No tiene la cuenta donde va la retención «${concepto.nombre}» que le practican. Créela en el Plan de cuentas y se enlaza sola.`
          : `No tiene la cuenta donde va la retención «${concepto.nombre}». Se crea sola cuando en Impuestos indica que es agente de ese impuesto.`,
      );
    }

    // La tarifa y la base mínima son de la ley a la fecha del documento. Una
    // fila vieja sin concepto de la ley no tiene tarifa (0099).
    const foto =
      concepto.concepto_nacional_id === null
        ? null
        : await this.parametros.fotoEn(ctx, datos.fecha, tx);
    const deLey =
      foto === null || concepto.concepto_nacional_id === null
        ? null
        : elegirTarifa(foto, concepto.concepto_nacional_id, {
            tipoPersona: datos.tipoPersona ?? 'JURIDICA',
            declarante: datos.declaranteRenta,
          });
    if (foto === null || deLey === null) {
      throw new BadRequestException(
        `No tengo la tarifa de ley de «${concepto.nombre}» para el ${datos.fecha}. Solicite al administrador del sistema que la cargue.`,
      );
    }
    const norma = deLey.norma;
    if (foto.uvt === null) {
      throw new BadRequestException(
        `No está cargada la UVT del ${datos.fecha.slice(0, 4)}. Sin ella no se puede saber si la base llega al mínimo.`,
      );
    }

    const resultado = calcularRetencion({
      base: datos.base,
      // La ley guarda fracciones (0,025); el cálculo trabaja en porcentaje.
      tarifa: deLey.tarifa * 100,
      baseMinimaUvt: deLey.baseUvt,
      uvt: foto.uvt,
    });

    if (!resultado.retiene) return null;

    // ReteIVA: pasado el mínimo sobre el subtotal, la tarifa va sobre el IVA.
    if (concepto.tipo === 'IVA') {
      const iva = datos.ivaDocumento ?? 0;
      if (iva <= 0) return null;
      return {
        conceptoId: concepto.id,
        tipo: concepto.tipo,
        concepto: concepto.codigo,
        cuentaId,
        base: iva,
        tarifa: resultado.tarifa,
        valor: Math.round((iva * resultado.tarifa) / 100),
        norma,
      };
    }

    return {
      conceptoId: concepto.id,
      tipo: concepto.tipo,
      concepto: concepto.codigo,
      cuentaId,
      base: datos.base,
      tarifa: resultado.tarifa,
      valor: resultado.valor,
      norma,
    };
  }

  /**
   * Olvida la ley en memoria. Lo llama la consola de plataforma al cargar una
   * vigencia nueva de tarifa o de UVT, para que el próximo documento la vea.
   */
  olvidarParametros(): void {
    this.parametros.olvidar();
  }
}
