import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { AlmacenamientoApi } from '../../almacenamiento/almacenamiento.api';
import { nombreDocumento } from '../reglas/documento.reglas';
import {
  EXTRACTOR_PUERTO,
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
