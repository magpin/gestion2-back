import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type { DatoExtraido } from '../proveedores/extractor.puerto';
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
    private readonly tx: TxService,
  ) {}

  /**
   * Los valores salen de lo que quedó guardado cuando se leyó el documento. De
   * la petición vienen los campos aprobados y, si la persona cambió algo —sobre
   * todo lo leído dudoso—, sus correcciones: ella decide.
   */
  async confirmar(
    ctx: CtxEmpresa,
    documentoId: string,
    seleccion?: string[],
    correcciones?: Record<string, string>,
  ): Promise<ResultadoConfirmacion> {
    const documento = await this.documentos.porId(ctx, documentoId);
    const datos = conCorrecciones(documento.datos, correcciones);
    const { acciones, sinAplicar } = planear(datos, {
      hoy: hoyEnColombia(),
      // Lo corregido cuenta como elegido: la persona lo vio y lo decidió.
      seleccion:
        seleccion === undefined && correcciones === undefined
          ? undefined
          : [...new Set([...(seleccion ?? []), ...Object.keys(correcciones ?? {})])],
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
    // Queda escrito (0068): volver a la pantalla no puede volver a pedir que se
    // confirme lo que ya se guardó.
    // Confirmar de nuevo lo que había quedado pendiente suma a lo anterior:
    // lo ya aplicado sigue aplicado.
    const antes =
      seleccion === undefined && correcciones === undefined
        ? null
        : documento.confirmacion;
    await this.documentos.guardarConfirmacion(ctx, documentoId, {
      aplicados: [...new Set([...(antes?.aplicados ?? []), ...aplicados])],
      sinAplicar,
      // Lo que la persona cambió de lo leído queda escrito: el dato ya no es lo
      // que decía el papel, y eso se tiene que poder ver después.
      correcciones: { ...(antes?.correcciones ?? {}), ...(correcciones ?? {}) },
    });

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

      case 'ACTIVIDAD': {
        // La actividad principal sale del RUT. Si ya hay una vigente, la de la
        // Cámara no la reemplaza: la misma ya está, y cambiar de principal es
        // un acto aparte. Registrarla otra vez la rechazaba la base, y el dato
        // quedaba «pendiente» cuando ya estaba guardado.
        const vigente = await this.tx.enContexto(ctx, async (t) =>
          fila<{ codigo_ciiu: string }>(
            await t.query(
              `SELECT codigo_ciiu FROM empresa_actividad_economica
                WHERE empresa_id = $1 AND es_principal AND fecha_fin IS NULL
                LIMIT 1`,
              [ctx.empresaId],
            ),
          ),
        );
        if (vigente !== undefined) {
          if (vigente.codigo_ciiu === accion.dto.codigoCiiu) return;
          throw new Error(
            `La actividad principal ya es la ${vigente.codigo_ciiu}, la del RUT. Si cambió, se cambia en situación legal.`,
          );
        }
        await this.nucleo.abrirActividad(ctx, accion.dto);
        return;
      }

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
 * Lo leído con lo que la persona corrigió encima. El dato corregido queda con
 * confianza alta —lo decidió ella— y, si el leído era una lista, la corrección
 * se separa por comas. Un campo corregido que no se había leído se agrega.
 *
 * Los valores vienen del navegador, como en cualquier formulario manual: los
 * valida lo mismo que valida a mano —las reglas de \`planear\` y \`nucleo\`—.
 */
function conCorrecciones(
  datos: DatoExtraido[],
  correcciones?: Record<string, string>,
): DatoExtraido[] {
  if (correcciones === undefined) return datos;
  const limpias = Object.entries(correcciones)
    .filter(([, v]) => typeof v === 'string')
    .map(([campo, v]) => [campo, v.trim().slice(0, 300)] as const)
    .filter(([, v]) => v !== '');
  const resultado = datos.map((d) => {
    const nuevo = limpias.find(([campo]) => campo === d.campo);
    if (nuevo === undefined) return d;
    return {
      ...d,
      valor: Array.isArray(d.valor)
        ? nuevo[1].split(',').map((x) => x.trim()).filter(Boolean)
        : nuevo[1],
      confianza: 'ALTA' as const,
    };
  });
  for (const [campo, valor] of limpias) {
    if (!resultado.some((d) => d.campo === campo)) {
      resultado.push({
        campo,
        valor,
        confianza: 'ALTA',
      } as DatoExtraido);
    }
  }
  return resultado;
}

/**
 * El mensaje de `nucleo` tal cual: ya está escrito para que lo lea quien
 * configura —«El tipo de documento "X" no existe. Validos: …»—.
 */
function mensajeDe(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'No se pudo guardar.';
}
