import { HttpException, Injectable, Logger } from '@nestjs/common';

import type { Tx } from '../../../common/db/tx.service';

import type { CtxEmpresa } from '../../../common/ctx';
import { hoyEnColombia } from '../../../common/fecha';
import { InventarioApi } from '../../inventario/inventario.api';
import type { ClaveOrigen } from '../../reportes/reglas/catalogo';
import { aMano } from '../../reportes/reglas/rango';
import { ArmadorService } from '../../reportes/servicios/armador.service';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import { RevisionApi } from '../../revision/revision.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type { HerramientasDelTurno } from '../proveedores/conversador.puerto';
import {
  BUSCAR,
  coincidencias,
  definicionDesde,
  existenciasParaModelo,
  EXISTENCIAS,
  herramientasPara,
  origenDeHerramienta,
  resultadoParaModelo,
  RETENCIONES,
  retencionesParaModelo,
  REVISAR,
  revisionParaModelo,
  ROLES_RETENCIONES,
  ROLES_REVISION,
  ROLES_EXISTENCIAS,
  ROLES_SALDOS,
  SALDOS,
  saldosParaModelo,
} from '../reglas/herramientas';
import {
  accionDeHerramienta,
  herramientasDeAccion,
  PROPUESTAS_POR_TURNO,
} from '../reglas/propuestas';
import {
  PropuestasService,
  type PropuestaNueva,
  type PropuestaResumen,
} from './propuestas.service';

/** Una consulta del turno, para guardarla con la respuesta (migración 0051). */
export interface ConsultaHecha {
  herramienta: string;
  entrada: unknown;
  filas: number | null;
  error: string | null;
}

/** Lo que devuelve una consulta: el texto para el modelo y cuántas filas trajo. */
interface Devuelto {
  texto: string;
  filas: number | null;
}

class NoPermitida extends Error {}

/**
 * Las consultas que el asistente puede hacer en un turno, con los permisos de
 * quien pregunta (paso 6 de `docs/planes/asistente-conversacion.md`).
 *
 * **No hay una puerta nueva.** Cada consulta corre por el servicio que ya
 * atiende la pantalla equivalente:
 * - los reportes por `ArmadorService.correr`, que vuelve a mirar los roles
 *   adentro;
 * - los saldos por `TesoreriaApi`;
 * - las existencias por `InventarioApi`;
 * - la revisión de errores por `RevisionApi`, que es lo que corre
 *   `GET /revision`.
 *
 * Esas dos fachadas no miran roles, como tampoco los servicios detrás de sus
 * controladores. Por eso se miran acá, con las mismas listas.
 *
 * Todo con el `ctx` de quien pregunta: el RLS es el suyo.
 */
@Injectable()
export class ConsultasService {
  private readonly log = new Logger(ConsultasService.name);

  constructor(
    private readonly armador: ArmadorService,
    private readonly tesoreria: TesoreriaApi,
    private readonly inventario: InventarioApi,
    private readonly propuestas: PropuestasService,
    private readonly revision: RevisionApi,
    private readonly retenciones: RetencionesApi,
  ) {}

  /**
   * Las herramientas de quien pregunta, y la lista donde queda cada consulta
   * que el modelo haga en el turno.
   *
   * Un error de la consulta —una columna que no existe, un reporte que su rol
   * no ve— vuelve como texto: el modelo lo lee y corrige o lo explica. Una
   * falla de la base también: el turno no se cae por una consulta.
   */
  paraTurno(ctx: CtxEmpresa): {
    herramientas: HerramientasDelTurno;
    hechas: ConsultaHecha[];
    propuestas: PropuestaNueva[];
  } {
    // Las de consultar y, si el rol puede cobrar o pagar, las de proponer
    // (paso 7). Proponer no registra nada: verifica en seco.
    const definiciones = [
      ...herramientasPara(ctx.roles),
      ...herramientasDeAccion(ctx.roles),
    ];
    const ofrecidas = new Set(definiciones.map((d) => d.name));
    const hechas: ConsultaHecha[] = [];
    const propuestas: PropuestaNueva[] = [];

    const ejecutar = async (nombre: string, entrada: unknown) => {
      // Una propuesta no es una consulta: no va a las fuentes; se guarda
      // aparte, con la respuesta.
      const accion = accionDeHerramienta(nombre);
      if (accion !== undefined) {
        if (!ofrecidas.has(nombre)) {
          return 'No se pudo proponer: el rol de quien pregunta no puede hacer esto.';
        }
        if (propuestas.length >= PROPUESTAS_POR_TURNO) {
          return `No se pudo proponer: ya van ${PROPUESTAS_POR_TURNO} en este turno. Que confirme esas y sigan en el próximo.`;
        }
        const r = await this.propuestas.preparar(ctx, accion, entrada);
        if (r.nueva !== undefined) propuestas.push(r.nueva);
        return r.texto;
      }
      try {
        // El modelo solo ve las ofrecidas; esto es por si pide otra igual.
        if (!ofrecidas.has(nombre)) throw new NoPermitida();
        const r = await this.correr(ctx, nombre, entrada);
        hechas.push({
          herramienta: nombre,
          entrada,
          filas: r.filas,
          error: null,
        });
        return r.texto;
      } catch (e) {
        const error = this.explicar(nombre, e);
        hechas.push({ herramienta: nombre, entrada, filas: null, error });
        return `No se pudo: ${error}`;
      }
    };

    return { herramientas: { definiciones, ejecutar }, hechas, propuestas };
  }

  /** Las propuestas del turno, en la transacción que guarda la respuesta. */
  guardarPropuestas(
    ctx: CtxEmpresa,
    turnoId: string,
    nuevas: readonly PropuestaNueva[],
    t: Tx,
  ): Promise<PropuestaResumen[]> {
    if (nuevas.length === 0) return Promise.resolve([]);
    return this.propuestas.guardar(ctx, turnoId, nuevas, t);
  }

  private async correr(
    ctx: CtxEmpresa,
    nombre: string,
    entrada: unknown,
  ): Promise<Devuelto> {
    const e = (entrada ?? {}) as Record<string, unknown>;

    if (nombre === BUSCAR) {
      const [origen, columna] = (
        typeof e.columna === 'string' ? e.columna : ''
      ).split('.');
      const valores = await this.armador.valores(
        ctx,
        origen as ClaveOrigen,
        columna ?? '',
      );
      const encontrados = coincidencias(
        valores,
        typeof e.contiene === 'string' ? e.contiene : '',
      );
      return { texto: JSON.stringify(encontrados), filas: encontrados.length };
    }

    if (nombre === SALDOS) {
      if (!ctx.roles.some((r) => ROLES_SALDOS.includes(r)))
        throw new NoPermitida();
      const saldos = await this.tesoreria.saldos(ctx);
      return { texto: saldosParaModelo(saldos), filas: saldos.length };
    }

    if (nombre === EXISTENCIAS) {
      if (!ctx.roles.some((r) => ROLES_EXISTENCIAS.includes(r)))
        throw new NoPermitida();
      const busqueda = typeof e.busqueda === 'string' ? e.busqueda : '';
      const existencias = await this.inventario.existencias(ctx, busqueda);
      return {
        texto: existenciasParaModelo(existencias),
        filas: existencias.length,
      };
    }

    if (nombre === RETENCIONES) {
      if (!ctx.roles.some((r) => ROLES_RETENCIONES.includes(r)))
        throw new NoPermitida();
      const texto = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const filas = await this.retenciones.retencionesParaAsistente(ctx, {
        proveedor: texto(e.proveedor),
        numero: texto(e.numero),
        desde: texto(e.desde),
        hasta: texto(e.hasta),
      });
      return { texto: retencionesParaModelo(filas), filas: filas.length };
    }

    if (nombre === REVISAR) {
      if (!ctx.roles.some((r) => ROLES_REVISION.includes(r)))
        throw new NoPermitida();
      const hallazgos = await this.revision.revisar(ctx);
      return {
        texto: revisionParaModelo(hallazgos, ctx.roles),
        filas: hallazgos.length,
      };
    }

    const origen = origenDeHerramienta(nombre);
    if (origen === undefined) throw new NoPermitida();
    const def = this.armador.definicion(
      definicionDesde(origen, entrada, hoyEnColombia()),
    );
    // `definicionDesde` siempre manda fechas escritas; un atajo no llega acá.
    if (!('desde' in def.fechas)) throw new NoPermitida();
    const resultado = await this.armador.correr(
      ctx,
      def,
      aMano(def.fechas.desde, def.fechas.hasta),
    );
    return {
      texto: resultadoParaModelo(resultado),
      filas: resultado.totalFilas,
    };
  }

  private explicar(nombre: string, e: unknown): string {
    if (e instanceof NoPermitida) {
      return 'Esa consulta no está entre las que permite el rol de quien pregunta.';
    }
    if (e instanceof HttpException) return e.message;
    this.log.error(
      `Falló la consulta ${nombre}`,
      e instanceof Error ? e.stack : String(e),
    );
    return 'La consulta falló. Intente de nuevo en un momento.';
  }
}
