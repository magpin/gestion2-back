import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { hoyEnColombia } from '../../common/fecha';
import { ComprasApi } from '../compras/compras.api';
import { TesoreriaApi } from '../tesoreria/tesoreria.api';
import { VentasApi } from '../ventas/ventas.api';
import { EstadosFinancierosService } from './estados-financieros.service';
import { mesDe } from './estados.reglas';
import { armarTablero, type Tablero } from './tablero.reglas';

/** Quien ve los estados financieros ve también el resultado del mes en Inicio. */
const VEN_RESULTADO = ['DIRECTOR', 'CONTADOR', 'CONSULTA'] as const;

/**
 * Inicio → tablero de la plata. Una sola llamada que junta lo que ya existe:
 * los saldos de tesorería, la cartera de ventas, lo por pagar y lo programado
 * de compras, y el estado de resultados del mes. No calcula nada propio más
 * allá de juntar: eso está en `tablero.reglas.ts`.
 */
@Injectable()
export class TableroService {
  constructor(
    private readonly tesoreria: TesoreriaApi,
    private readonly ventas: VentasApi,
    private readonly compras: ComprasApi,
    private readonly estados: EstadosFinancierosService,
  ) {}

  async plata(ctx: CtxEmpresa): Promise<Tablero> {
    // voseo-ok: nombre de código
    const hoy = hoyEnColombia();
    const mes = hoy.slice(0, 7);
    const anterior = mesDe(mes).anterior;
    const veResultado = VEN_RESULTADO.some((r) => ctx.roles.includes(r));

    const [saldos, cartera, porPagar, porCobrar, programados, resultados] =
      await Promise.all([
        this.tesoreria.saldos(ctx),
        this.ventas.cartera(ctx),
        this.compras.porPagar(ctx),
        this.ventas.pendientesPorCobrar(ctx),
        this.compras.programadosPendientes(ctx),
        veResultado
          ? this.estados.resultados(ctx, mes, anterior)
          : Promise.resolve(null),
      ]);

    const ingresos = (clave: string) =>
      resultados?.actual.renglones.find((r) => r.clave === clave)?.valor ?? 0;

    return armarTablero({
      hoy,
      lugares: saldos.map((s) => ({
        id: s.id,
        medio: s.medio,
        nombre: s.nombre,
        saldo: Number(s.saldo),
      })),
      cartera,
      porPagar,
      porCobrar,
      programados,
      resultado:
        resultados === null
          ? null
          : {
              mes,
              ingresos: ingresos('ingresos_op') + ingresos('ing_no_op'),
              utilidad: resultados.actual.utilidadAntesDeImpuestos,
              utilidadAnterior:
                resultados.comparado?.estado.utilidadAntesDeImpuestos ?? null,
              mesAnterior: resultados.comparado?.periodo.mes ?? null,
            },
    });
  }
}
