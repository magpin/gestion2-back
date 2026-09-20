import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { hoyEnColombia } from '../../../common/fecha';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type { Accion, SinAplicar } from '../reglas/confirmacion.reglas';
import { planear } from '../reglas/confirmacion.reglas';
import { DocumentoService } from './documento.service';

/**
 * Aplica lo que una persona confirmó, llamando a los mismos servicios que usan
 * los endpoints manuales.
 *
 * Este servicio es la razón por la que el módulo no escribe en la base de
 * configuración. Todo pasa por `NucleoApi`: las validaciones, los catálogos y las
 * reglas de vigencia son las de siempre, y un dato leído de un PDF entra por la
 * misma puerta que uno escrito a mano.
 *
 * **Cada acción va en su propia transacción**, no todas en una. El plan pedía una
 * sola, y para eso habría que pasarle un `Tx` a cinco servicios de `nucleo` que
 * hoy abren la suya. No se hizo porque cada acción es configuración válida por sí
 * misma —una sede, una actividad, una responsabilidad— y lo que se gana no paga
 * el cambio: si una falla, las anteriores quedaron aplicadas, se informa cuál
 * falló y la pantalla vuelve a preguntarle a `estado-configuracion` qué falta.
 * Lo que sí sería inaceptable es aplicar media acción, y eso no pasa: el DTO se
 * arma completo antes de llamar, o no se llama.
 */

export interface ResultadoConfirmacion {
  /** Los campos que quedaron guardados. */
  aplicados: string[];
  /** Lo que no se aplicó, con su motivo. Va a la lista de preguntas. */
  sinAplicar: SinAplicar[];
}

@Injectable()
export class ConfirmacionService {
  private readonly log = new Logger(ConfirmacionService.name);

  constructor(
    private readonly documentos: DocumentoService,
    private readonly nucleo: NucleoApi,
  ) {}

  /**
   * Los valores **no vienen de la petición**: salen de lo que quedó guardado
   * cuando se leyó el documento. De la petición vienen los campos aprobados.
   */
  async confirmar(
    ctx: CtxEmpresa,
    documentoId: string,
    seleccion?: string[],
  ): Promise<ResultadoConfirmacion> {
    const documento = await this.documentos.porId(ctx, documentoId);
    const { acciones, sinAplicar } = planear(documento.datos, {
      hoy: hoyEnColombia(),
      seleccion,
    });

    const aplicados: string[] = [];
    for (const accion of acciones) {
      try {
        await this.aplicar(ctx, accion);
        aplicados.push(...accion.campos);
      } catch (error: unknown) {
        // La validación de `nucleo` es la que manda: un municipio que no está en
        // el catálogo DANE o un CIIU que no existe se rechazan acá, y eso no es
        // un error del sistema, es un dato que hay que revisar a mano.
        const motivo = mensajeDe(error);
        this.log.warn(
          `No se pudo aplicar ${accion.tipo} de ${documentoId}: ${motivo}`,
        );
        for (const campo of accion.campos) {
          sinAplicar.push({ campo, etiqueta: campo, motivo });
        }
      }
    }

    this.log.log(
      `Confirmado ${documento.tipo} (${documentoId}): ${aplicados.length} campos aplicados, ${sinAplicar.length} sin aplicar.`,
    );

    return { aplicados, sinAplicar };
  }

  private async aplicar(ctx: CtxEmpresa, accion: Accion): Promise<void> {
    switch (accion.tipo) {
      case 'EDITAR_EMPRESA':
        await this.nucleo.editarEmpresa(ctx, accion.dto);
        return;

      case 'SEDE_PRINCIPAL':
        await this.nucleo.fijarSedePrincipal(ctx, accion.dto);
        return;

      case 'ACTIVIDAD':
        await this.nucleo.abrirActividad(ctx, accion.dto);
        return;

      case 'RESPONSABILIDADES_RUT':
        // Una fila por código: así las cierra y las abre el endpoint manual, y
        // así cada una lleva su propia vigencia.
        for (const codigo of accion.dto.codigos) {
          await this.nucleo.abrirResponsabilidadRut(ctx, {
            codigo,
            fechaInicio: accion.dto.fechaInicio,
          });
        }
        return;

      case 'REGIMEN':
        await this.nucleo.abrirRegimen(ctx, accion.dto);
        return;

      case 'REPRESENTANTE':
        await this.nucleo.abrirRepresentante(ctx, accion.dto);
        return;

      case 'MATRICULA':
        await this.nucleo.abrirMatricula(ctx, accion.dto);
        return;

      case 'RESOLUCION':
        await this.nucleo.crearResolucion(ctx, accion.dto);
        return;
    }
  }
}

/**
 * El mensaje de `nucleo` tal cual: ya está escrito para que lo lea quien
 * configura —«El tipo de documento "X" no existe. Validos: …»—.
 */
function mensajeDe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'No se pudo guardar.';
}
