import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { hoyEnColombia } from '../../../common/fecha';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import type { AtajoCorte, Atajo } from '../reglas/rango';
import {
  aMano,
  corteAMano,
  resolver,
  resolverCorte,
  ultimoDiaDe,
  type Corte,
  type Rango,
} from '../reglas/rango';

/**
 * Los atajos de fecha resueltos contra hoy y contra los períodos contables.
 *
 * Los usan los dos reportes fijos y el armador: «el período contable en curso»
 * tiene que ser el mismo en una hoja impresa y en un reporte armado.
 */
@Injectable()
export class FechasReporteService {
  constructor(private readonly contabilidad: ContabilidadApi) {}

  /**
   * El rango pedido: un atajo, o dos fechas. **No los dos, y no ninguno.**
   *
   * Está acá y no en el DTO porque «obligatorio si el otro falta» en
   * `class-validator` se vuelve ilegible, y un `if` con un mensaje que diga qué
   * falta se entiende solo.
   */
  async rango(
    ctx: CtxEmpresa,
    q: { atajo?: Atajo; desde?: string; hasta?: string },
  ): Promise<Rango> {
    const conFechas = q.desde !== undefined || q.hasta !== undefined;

    if (q.atajo !== undefined && conFechas) {
      throw new BadRequestException(
        'Elegí un atajo o dos fechas, no las dos cosas.',
      );
    }

    if (conFechas) {
      if (q.desde === undefined || q.hasta === undefined) {
        throw new BadRequestException('Faltan las dos fechas: desde y hasta.');
      }
      if (q.desde > q.hasta) {
        throw new BadRequestException(
          'La fecha inicial es posterior a la final.',
        );
      }
      return aMano(q.desde, q.hasta);
    }

    const atajo = q.atajo ?? 'ESTE_MES';
    const hoy = hoyEnColombia();
    if (atajo !== 'PERIODO') return resolver(atajo, hoy);

    // «El periodo contable en curso» es el que contiene hoy, con la misma
    // definición que usa la pantalla de contabilidad. Si no hay ninguno —la
    // empresa todavía no abrió periodos—, este mes: es lo más parecido que
    // tiene sentido, y la hoja dice «este mes» y no «periodo», así que no
    // engaña.
    const periodo = await this.contabilidad.periodoEn(ctx, new Date());
    if (periodo === null) return resolver('ESTE_MES', hoy);

    const mes = String(periodo.mes).padStart(2, '0');
    return {
      desde: `${periodo.anio}-${mes}-01`,
      hasta: `${periodo.anio}-${mes}-${String(ultimoDiaDe(periodo.anio, periodo.mes)).padStart(2, '0')}`,
      etiqueta: `el periodo contable ${mes}/${periodo.anio}`,
      relativo: true,
    };
  }
  /**
   * La fecha de corte pedida: un atajo, o una fecha. No los dos.
   *
   * «El cierre del periodo anterior» es el último día del último periodo que
   * se **cerró**, no el del mes pasado: si agosto sigue abierto, es julio. Si
   * nunca se cerró ninguno, cae al cierre del mes pasado y la hoja lo dice así,
   * sin fingir que hubo un cierre.
   */
  async corte(
    ctx: CtxEmpresa,
    q: { atajo?: AtajoCorte; corte?: string },
  ): Promise<Corte> {
    if (q.atajo !== undefined && q.corte !== undefined) {
      throw new BadRequestException(
        'Elegí un atajo o una fecha, no las dos cosas.',
      );
    }
    if (q.corte !== undefined) return corteAMano(q.corte);

    const hoy = hoyEnColombia();
    const atajo = q.atajo ?? 'HOY';
    if (atajo !== 'CIERRE_PERIODO_ANTERIOR') return resolverCorte(atajo, hoy);

    const cerrado = await this.contabilidad.ultimoPeriodoCerrado(ctx);
    if (cerrado === null) return resolverCorte('CIERRE_MES_PASADO', hoy);
    const mes = String(cerrado.mes).padStart(2, '0');
    return {
      corte: `${cerrado.anio}-${mes}-${String(ultimoDiaDe(cerrado.anio, cerrado.mes)).padStart(2, '0')}`,
      etiqueta: `el cierre del periodo ${mes}/${cerrado.anio}`,
      relativo: true,
    };
  }
}
