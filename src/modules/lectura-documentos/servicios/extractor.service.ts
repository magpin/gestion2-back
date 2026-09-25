import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import type { CtxEmpresa, RolCodigo } from '../../../common/ctx';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import { nombreDocumento } from '../reglas/documento.reglas';
import {
  EXTRACTOR_PUERTO,
  type ArchivoParaLeer,
  type ExtractorPuerto,
  type TipoDocumento,
} from '../proveedores/extractor.puerto';

/** Lo que contesta `POST documentos/analizar`. */
export interface ResultadoAnalisis {
  /** La lectura que arrancó, si era uno de los tres documentos; si no, `null`. */
  documento: Documento | null;
  clase: string;
  resumen: string;
}
import type { Documento } from './documento.service';
import { DocumentoService, exigirClaveDeLaEmpresa } from './documento.service';
import {
  CruceService,
  type FacturaCruzada,
  type PedidoCruzado,
  type VentasHistoricasCruzadas,
} from './cruce.service';
import { ProgresoService } from './progreso.service';

/**
 * Orquesta una lectura: baja el archivo, se lo pasa al puerto, y mueve la fila.
 *
 * No sabe nada de modelos ni de tokens —eso es del proveedor— ni de qué significa
 * un dato —eso es de las reglas—. Lo que sabe es el ciclo de vida:
 * `EN_COLA → LEYENDO → LEIDO | FALLO`, y que cada cambio se avisa.
 *
 * **La lectura no se espera en la petición.** El `POST` contesta apenas la fila
 * queda encolada: leer un RUT tarda, y la pantalla ya tiene por dónde mirar el
 * progreso. Que el navegador se vaya no cancela nada; para eso está «Detener».
 */
@Injectable()
export class ExtractorService {
  private readonly log = new Logger(ExtractorService.name);

  constructor(
    private readonly documentos: DocumentoService,
    private readonly almacenamiento: AlmacenamientoApi,
    private readonly progreso: ProgresoService,
    private readonly cruce: CruceService,
    @Inject(EXTRACTOR_PUERTO) private readonly extractor: ExtractorPuerto,
    // Opcional: las pruebas arman el servicio sin él. En la app siempre está.
    @Optional() private readonly pausa?: PausaIaService,
  ) {}

  /** `false` cuando falta la clave: el modo IA entonces no se ofrece. */
  get disponible(): boolean {
    return this.extractor.disponible && this.almacenamiento.disponible;
  }

  async encolar(
    ctx: CtxEmpresa,
    datos: { tipo: TipoDocumento; clave: string },
  ): Promise<Documento> {
    exigirRolPara(ctx, datos.tipo);
    await this.pausa?.exigirActiva(ctx.tenantId, 'LECTURA');
    const documento = await this.documentos.registrar(ctx, {
      tipo: datos.tipo,
      clave: datos.clave,
    });

    this.progreso.emitir(ctx.empresaId, {
      etapa: 'EN_COLA',
      documento: documento.tipo,
      documentoId: documento.id,
      mensaje: `${mayuscula(nombreDocumento(documento.tipo))} entró a la cola.`,
      datos: [],
    });

    void this.leer(ctx, documento);
    return documento;
  }

  /**
   * Un archivo que se subió sin decir qué es: el asistente lo mira y dice qué
   * es. Se espera en la petición —son pocos segundos—.
   *
   * Si es uno de los tres documentos de configuración, la lectura arranca como
   * siempre y el archivo queda. Si no, **no es un error**: se contesta qué es y
   * el archivo se borra del bucket, porque nada lo referencia.
   */
  async analizar(ctx: CtxEmpresa, clave: string): Promise<ResultadoAnalisis> {
    exigirClaveDeLaEmpresa(ctx, clave);
    await this.pausa?.exigirActiva(ctx.tenantId, 'LECTURA');
    const archivo = await this.almacenamiento.descargar(clave);
    const analisis = await this.reconocer(ctx, archivo);
    // Se dice qué es igual, aunque quien lo subió no pueda mandarlo a leer:
    // el análisis ya se pagó, y «esto es un RUT, pero no es lo tuyo» es mejor
    // respuesta que un 403 seco sobre un archivo que ya está arriba.
    if (analisis.tipo !== null && puedeMandarALeer(ctx, analisis.tipo)) {
      const documento = await this.encolar(ctx, { tipo: analisis.tipo, clave });
      return { documento, clase: analisis.clase, resumen: analisis.resumen };
    }
    await this.almacenamiento.borrar(clave);
    return {
      documento: null,
      clase: analisis.clase,
      resumen: analisis.resumen,
    };
  }

  /**
   * Qué es un archivo ya bajado, sabiendo de qué empresa es quien lo sube: es lo
   * que separa una factura de compra de una venta propia.
   */
  async reconocer(ctx: CtxEmpresa, archivo: ArchivoParaLeer) {
    const empresa = await this.documentos.empresaDe(ctx);
    return this.extractor.analizar(archivo, empresa ?? undefined);
  }

  /** Si quien pregunta puede mandar a leer este tipo. Sin excepción: el lote lo dice. */
  puedeLeer(ctx: CtxEmpresa, tipo: TipoDocumento): boolean {
    return puedeMandarALeer(ctx, tipo);
  }

  /**
   * Lee una lectura ya registrada y **la espera**. La usa el lote, que lee de a
   * uno y cuenta él cuántos van. Nunca tira: la fila termina en LEIDO o FALLO
   * igual que por `encolar`.
   */
  async leerYEsperar(ctx: CtxEmpresa, documento: Documento): Promise<void> {
    exigirRolPara(ctx, documento.tipo);
    await this.leer(ctx, documento);
  }

  /**
   * Corta una lectura en curso.
   *
   * Si nadie la está leyendo —el proceso que la leía murió con un reinicio del
   * servidor—, la fila quedó en `EN_COLA` o `LEYENDO` para siempre y no hay
   * corte en memoria que apretar. Entonces se cierra acá: sin esto, «Detener»
   * no hacía nada y la burbuja seguía girando.
   */
  async detener(ctx: CtxEmpresa, documento: Documento): Promise<boolean> {
    if (this.progreso.detener(documento.id)) return true;
    const motivo =
      'La lectura se interrumpió antes de terminar. Subí el archivo de nuevo.';
    await this.documentos.marcarFallo(ctx, documento.id, {
      clase: 'DETENIDO',
      motivo,
    });
    this.progreso.emitir(ctx.empresaId, {
      etapa: 'ERROR',
      documento: documento.tipo,
      documentoId: documento.id,
      mensaje: motivo,
      datos: [],
    });
    this.log.warn(`Lectura huérfana ${documento.id} cerrada al detenerla.`);
    return true;
  }

  /**
   * El trabajo de verdad, fuera de la petición. Nada de acá puede tirar una
   * excepción hacia arriba: no hay nadie esperándola, y la fila tiene que quedar
   * en un estado terminal igual.
   */
  private async leer(ctx: CtxEmpresa, documento: Documento): Promise<void> {
    const corte = this.progreso.registrarCorte(documento.id);

    try {
      await this.documentos.marcarLeyendo(ctx, documento.id);
      this.progreso.emitir(ctx.empresaId, {
        etapa: 'LEYENDO',
        documento: documento.tipo,
        documentoId: documento.id,
        mensaje: `Leyendo ${nombreDocumento(documento.tipo)}…`,
        datos: [],
      });

      const archivo = await this.almacenamiento.descargar(
        documento.claveAlmacenamiento,
      );
      // La huella de lo que se leyó, para que el historial del asiento pueda
      // mostrar que el archivo de hoy es el mismo de entonces.
      await this.documentos.guardarHuella(ctx, documento.id, archivo.contenido);

      // Una factura se lee por otro camino: devuelve cabecera con renglones y
      // no campos sueltos, y el código comprueba sus totales. Es la única
      // bifurcación del ciclo de vida, y termina igual que la otra —LEIDO con
      // lo extraído, o FALLO con su motivo—.
      if (documento.tipo === 'FACTURA_COMPRA') {
        await this.leerFactura(ctx, documento, archivo, corte.signal);
        return;
      }
      // El pedido de un cliente es la misma forma —cabecera con renglones—,
      // y termina igual: LEIDO con el borrador de la factura, o FALLO.
      if (documento.tipo === 'PEDIDO_VENTA') {
        await this.leerPedido(ctx, documento, archivo, corte.signal);
        return;
      }
      // Las ventas del sistema anterior: una lista de facturas por archivo.
      if (documento.tipo === 'VENTA_HISTORICA') {
        await this.leerVentasHistoricas(ctx, documento, archivo, corte.signal);
        return;
      }

      const resultado = await this.extractor.leer({
        tipo: documento.tipo,
        archivo,
        corte: corte.signal,
        alAvanzar: (avance) => {
          this.progreso.emitir(ctx.empresaId, {
            etapa: avance.etapa,
            documento: avance.documento,
            documentoId: documento.id,
            mensaje: avance.mensaje,
            datos: avance.datos,
          });
        },
      });

      if (!resultado.leido) {
        await this.documentos.marcarFallo(ctx, documento.id, resultado);
        this.progreso.emitir(ctx.empresaId, {
          etapa: 'ERROR',
          documento: documento.tipo,
          documentoId: documento.id,
          mensaje: resultado.motivo,
          datos: [],
        });
        this.log.warn(
          `Lectura ${documento.id} (${documento.tipo}) terminó en ${resultado.clase}.`,
        );
        return;
      }

      await this.documentos.guardarLeido(
        ctx,
        documento.id,
        resultado.datos,
        resultado.medicion,
      );
      this.progreso.emitir(ctx.empresaId, {
        etapa: 'LISTO',
        documento: documento.tipo,
        documentoId: documento.id,
        mensaje: `Terminé de leer ${nombreDocumento(documento.tipo)}.`,
        datos: resultado.datos,
      });
    } catch (error: unknown) {
      // Acá caen las fallas que no son del modelo: el bucket, la base, un bug.
      // La fila no puede quedarse en LEYENDO para siempre.
      this.log.error(
        `La lectura ${documento.id} se cayó`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.marcarFalloSeguro(ctx, documento);
    } finally {
      this.progreso.soltarCorte(documento.id);
    }
  }

  /**
   * La rama de la factura. Termina en los mismos dos estados que la otra, y con
   * una diferencia deliberada: **una factura que no cuadra igual se guarda como
   * LEIDA**, con sus comprobaciones al lado.
   *
   * Marcarla FALLO sería decir que no se pudo leer, y sí se pudo: lo que pasa
   * es que las cuentas no dan. Quien mira la pantalla necesita ver los
   * renglones justamente para encontrar cuál está mal —y esa es la diferencia
   * entre «no pude» y «mirá esto»—. Lo que no cuadra no se propone; se muestra.
   */
  private async leerFactura(
    ctx: CtxEmpresa,
    documento: Documento,
    archivo: ArchivoParaLeer,
    corte: AbortSignal,
  ): Promise<void> {
    const resultado = await this.extractor.leerFactura({ archivo, corte });

    if (!resultado.leido) {
      await this.documentos.marcarFallo(ctx, documento.id, resultado);
      this.progreso.emitir(ctx.empresaId, {
        etapa: 'ERROR',
        documento: documento.tipo,
        documentoId: documento.id,
        mensaje: resultado.motivo,
        datos: [],
      });
      this.log.warn(
        `Lectura ${documento.id} (factura) terminó en ${resultado.clase}.`,
      );
      return;
    }

    // El cruce va acá, pegado a la lectura, y no cuando alguien abra la
    // pantalla: es lo que convierte «dice TECLADO INALAMBRICO» en «es el
    // producto P001», y sin eso lo guardado no sirve para proponer nada.
    //
    // Si el cruce se cae —la base, un bug—, la lectura **no se pierde**: se
    // guarda igual con una pregunta que lo dice. Leer es lo que costó dinero.
    let cruzada;
    try {
      cruzada = await this.cruce.cruzar(
        ctx,
        resultado.factura,
        resultado.comprobaciones,
      );
    } catch (error: unknown) {
      this.log.error(
        `No pude cruzar la factura ${documento.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      cruzada = null;
    }

    await this.documentos.guardarLeido(
      ctx,
      documento.id,
      cruzada ?? {
        factura: resultado.factura,
        comprobaciones: resultado.comprobaciones,
        proveedor: null,
        renglones: [],
        lineas: [],
        juntadas: 0,
        preguntas: [
          {
            sobre: 'cruce',
            texto:
              'Leí la factura pero no pude buscar el proveedor ni los productos. Probá de nuevo.',
          },
        ],
        completa: false,
      },
      resultado.medicion,
    );

    this.progreso.emitir(ctx.empresaId, {
      etapa: 'LISTO',
      documento: documento.tipo,
      documentoId: documento.id,
      mensaje: mensajeDeFactura(resultado.factura.renglones.length, cruzada),
      // Los renglones no viajan por el canal de progreso: ese canal transporta
      // `DatoExtraido`, que es la forma plana. La factura se busca con el `id`.
      datos: [],
    });
  }

  /**
   * La rama del pedido. Como la de la factura: si el cruce se cae, la lectura
   * se guarda igual —leer es lo que costó dinero— con una pregunta que lo dice.
   */
  private async leerPedido(
    ctx: CtxEmpresa,
    documento: Documento,
    archivo: ArchivoParaLeer,
    corte: AbortSignal,
  ): Promise<void> {
    const resultado = await this.extractor.leerPedido({ archivo, corte });

    if (!resultado.leido) {
      await this.documentos.marcarFallo(ctx, documento.id, resultado);
      this.progreso.emitir(ctx.empresaId, {
        etapa: 'ERROR',
        documento: documento.tipo,
        documentoId: documento.id,
        mensaje: resultado.motivo,
        datos: [],
      });
      this.log.warn(
        `Lectura ${documento.id} (pedido) terminó en ${resultado.clase}.`,
      );
      return;
    }

    let cruzado: PedidoCruzado | null;
    try {
      cruzado = await this.cruce.cruzarPedido(
        ctx,
        resultado.pedido,
        resultado.comprobaciones,
      );
    } catch (error: unknown) {
      this.log.error(
        `No pude cruzar el pedido ${documento.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      cruzado = null;
    }

    await this.documentos.guardarLeido(
      ctx,
      documento.id,
      cruzado ?? {
        pedido: resultado.pedido,
        comprobaciones: resultado.comprobaciones,
        cliente: null,
        renglones: [],
        lineas: [],
        juntadas: 0,
        preguntas: [
          {
            sobre: 'cruce',
            texto:
              'Leí el pedido pero no pude buscar el cliente ni los productos. Probá de nuevo.',
          },
        ],
        completa: false,
      },
      resultado.medicion,
    );

    this.progreso.emitir(ctx.empresaId, {
      etapa: 'LISTO',
      documento: documento.tipo,
      documentoId: documento.id,
      mensaje:
        cruzado === null
          ? 'Leí el pedido, pero no pude buscar el cliente ni los productos.'
          : cruzado.preguntas.length === 0
            ? `Leí el pedido: ${cruzado.renglones.length} renglones, listo para armar la factura.`
            : `Leí el pedido: ${cruzado.renglones.length} renglones, y me ${cruzado.preguntas.length === 1 ? 'queda 1 pregunta' : `quedan ${cruzado.preguntas.length} preguntas`}.`,
      datos: [],
    });
  }

  /**
   * La rama de las ventas del sistema anterior. Como las otras: si el cruce se
   * cae, lo leído se guarda igual con una pregunta que lo dice.
   */
  private async leerVentasHistoricas(
    ctx: CtxEmpresa,
    documento: Documento,
    archivo: ArchivoParaLeer,
    corte: AbortSignal,
  ): Promise<void> {
    const resultado = await this.extractor.leerVentasHistoricas({
      archivo,
      corte,
    });

    if (!resultado.leido) {
      await this.documentos.marcarFallo(ctx, documento.id, resultado);
      this.progreso.emitir(ctx.empresaId, {
        etapa: 'ERROR',
        documento: documento.tipo,
        documentoId: documento.id,
        mensaje: resultado.motivo,
        datos: [],
      });
      this.log.warn(
        `Lectura ${documento.id} (ventas anteriores) terminó en ${resultado.clase}.`,
      );
      return;
    }

    let cruzadas: VentasHistoricasCruzadas | null;
    try {
      cruzadas = await this.cruce.cruzarVentasHistoricas(
        ctx,
        resultado.facturas,
      );
    } catch (error: unknown) {
      this.log.error(
        `No pude cruzar las ventas anteriores ${documento.id}`,
        error instanceof Error ? error.stack : String(error),
      );
      cruzadas = null;
    }

    await this.documentos.guardarLeido(
      ctx,
      documento.id,
      cruzadas ?? {
        facturas: resultado.facturas.map((f) => ({
          ...f,
          cliente: null,
          renglones: [],
          preguntas: [],
          completa: false,
        })),
        preguntas: [
          {
            sobre: 'cruce',
            texto:
              'Leí las facturas pero no pude buscar los clientes ni los productos. Probá de nuevo.',
          },
        ],
      },
      resultado.medicion,
    );

    const total = resultado.facturas.length;
    const completas = cruzadas?.facturas.filter((f) => f.completa).length ?? 0;
    this.progreso.emitir(ctx.empresaId, {
      etapa: 'LISTO',
      documento: documento.tipo,
      documentoId: documento.id,
      mensaje:
        cruzadas === null
          ? `Leí ${total === 1 ? '1 factura' : `${total} facturas`}, pero no pude buscar los clientes ni los productos.`
          : `Leí ${total === 1 ? '1 factura' : `${total} facturas`} de venta: ${completas === total ? 'todas listas para cargar' : `${completas} listas para cargar`}.`,
      datos: [],
    });
  }

  private async marcarFalloSeguro(
    ctx: CtxEmpresa,
    documento: Documento,
  ): Promise<void> {
    try {
      await this.documentos.marcarFallo(ctx, documento.id, {
        clase: 'FALLA',
        motivo: 'No pude leer el documento. Probá de nuevo.',
      });
      this.progreso.emitir(ctx.empresaId, {
        etapa: 'ERROR',
        documento: documento.tipo,
        documentoId: documento.id,
        mensaje: 'No pude leer el documento. Probá de nuevo.',
        datos: [],
      });
    } catch (error: unknown) {
      // Si tampoco se puede escribir el fallo, la base no está: no hay nada más
      // que hacer desde acá, y la fila queda en LEYENDO hasta que alguien mire.
      this.log.error(
        `Tampoco pude marcar el fallo de ${documento.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

/**
 * Quién puede mandar a leer qué.
 *
 * El guard del controlador es uno solo por ruta, y acá hacen falta dos listas
 * distintas: **configurar una empresa y registrar una compra no las hace la
 * misma gente.** Quien está en COMPRAS tiene que poder subir la factura que le
 * llegó, y no tiene por qué poder subir el RUT de la empresa —ni gastar en
 * leerlo—.
 *
 * Va acá y no en el decorador porque depende del cuerpo de la petición, que el
 * guard no mira.
 */
function puedeMandarALeer(ctx: CtxEmpresa, tipo: TipoDocumento): boolean {
  const permitidos: RolCodigo[] =
    tipo === 'FACTURA_COMPRA'
      ? ['ADMIN_TENANT', 'DIRECTOR', 'CONTADOR', 'COMPRAS']
      : tipo === 'PEDIDO_VENTA'
        ? // Los de `POST /facturas`: leer un pedido es el primer paso de facturar.
          ['DIRECTOR', 'VENTAS']
        : tipo === 'VENTA_HISTORICA'
          ? // Los de `POST /facturas-historicas`: es armar la cartera de arranque.
            ['DIRECTOR', 'CONTADOR']
          : ['ADMIN_TENANT', 'DIRECTOR', 'CONTADOR'];
  return ctx.roles.some((rol) => permitidos.includes(rol));
}

function exigirRolPara(ctx: CtxEmpresa, tipo: TipoDocumento): void {
  if (puedeMandarALeer(ctx, tipo)) return;
  throw new ForbiddenException(
    tipo === 'FACTURA_COMPRA'
      ? 'No tenés permiso para registrar compras.'
      : tipo === 'PEDIDO_VENTA'
        ? 'No tenés permiso para facturar.'
        : tipo === 'VENTA_HISTORICA'
          ? 'No tenés permiso para cargar ventas anteriores.'
          : 'No tenés permiso para configurar la empresa.',
  );
}

/**
 * Lo que dice la burbuja cuando termina de leer una factura.
 *
 * Cuatro estados, y para quien mira son cuatro cosas distintas: no se pudo
 * cruzar, las cuentas no dan, faltan datos, o está lista para proponer. Un
 * «listo» para las cuatro haría que la persona abra la pantalla a ver qué pasó.
 *
 * El orden importa: si las cuentas no dan, eso es lo primero que hay que decir,
 * aunque además falten datos.
 */
function mensajeDeFactura(
  renglones: number,
  cruzada: FacturaCruzada | null,
): string {
  if (cruzada === null) {
    return `Leí la factura (${renglones} renglones), pero no pude buscar el proveedor ni los productos.`;
  }

  const sinCuadrar = cruzada.comprobaciones.filter((c) => !c.cuadra);
  if (sinCuadrar.length > 0) {
    return `Leí la factura, pero las cuentas no dan: ${sinCuadrar.map((c) => c.que.toLowerCase()).join('; ')}.`;
  }
  if (cruzada.preguntas.length > 0) {
    return `Leí la factura: ${renglones} renglones, y me quedan ${cruzada.preguntas.length === 1 ? '1 pregunta' : `${cruzada.preguntas.length} preguntas`}.`;
  }
  return `Leí la factura: ${renglones} renglones, y las cuentas dan.`;
}

function mayuscula(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
