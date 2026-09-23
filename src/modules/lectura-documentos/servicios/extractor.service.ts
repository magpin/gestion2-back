import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
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
    const analisis = await this.extractor.analizar(archivo);
    if (analisis.tipo !== null) {
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

      // Una factura se lee por otro camino: devuelve cabecera con renglones y
      // no campos sueltos, y el código comprueba sus totales. Es la única
      // bifurcación del ciclo de vida, y termina igual que la otra —LEIDO con
      // lo extraído, o FALLO con su motivo—.
      if (documento.tipo === 'FACTURA_COMPRA') {
        await this.leerFactura(ctx, documento, archivo, corte.signal);
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

    const sinCuadrar = resultado.comprobaciones.filter((c) => !c.cuadra);
    await this.documentos.guardarLeido(
      ctx,
      documento.id,
      { factura: resultado.factura, comprobaciones: resultado.comprobaciones },
      resultado.medicion,
    );

    this.progreso.emitir(ctx.empresaId, {
      etapa: 'LISTO',
      documento: documento.tipo,
      documentoId: documento.id,
      mensaje:
        sinCuadrar.length === 0
          ? `Leí la factura: ${resultado.factura.renglones.length} renglones, y las cuentas dan.`
          : `Leí la factura, pero ${sinCuadrar.length === 1 ? 'algo no da' : 'hay cosas que no dan'}: ${sinCuadrar.map((c) => c.que.toLowerCase()).join('; ')}.`,
      // Los renglones no viajan por el canal de progreso: ese canal transporta
      // `DatoExtraido`, que es la forma plana. La factura se busca con el `id`.
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

function mayuscula(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
