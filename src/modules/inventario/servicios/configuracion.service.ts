import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  CuentasAutomaticas,
  type ConceptoConfigurado,
} from '../../../common/contabilidad/cuentas-automaticas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  CONCEPTOS_INVENTARIO,
  conceptosInventarioPara,
  ORDEN_CONCEPTOS_INVENTARIO,
  type ConceptoInventario,
} from './cuentas-inventario.reglas';

export interface InventarioConfiguracion {
  conceptos: ConceptoConfigurado<ConceptoInventario>[];
  /** Todos los conceptos tienen cuenta: productos y ajustes funcionan sin preguntar. */
  completa: boolean;
}

/**
 * Las cuentas automáticas de inventario: las que toma un producto nuevo
 * (inventario, ingreso, costo de venta) y contra las que se asienta un ajuste
 * de existencias (sobrante, faltante asumido, faltante cobrable).
 *
 * Nadie las elige al operar: el sistema propone la del decreto, la crea si
 * falta, y solo pregunta —en el Plan de cuentas— cuando hay varios auxiliares.
 *
 * «Vender sin existencia» ya no vive acá: es el hecho operativo
 * `VENDE_SIN_EXISTENCIA`, que se contesta en el asistente.
 */
@Injectable()
export class ConfiguracionService {
  private readonly cuentas: CuentasAutomaticas<ConceptoInventario>;

  constructor(
    private readonly tx: TxService,
    nucleo: NucleoApi,
    contabilidad: ContabilidadApi,
  ) {
    this.cuentas = new CuentasAutomaticas(
      'inventario_configuracion',
      CONCEPTOS_INVENTARIO,
      ORDEN_CONCEPTOS_INVENTARIO,
      nucleo,
      contabilidad,
      // El ingreso y el costo de un producto nuevo, según la actividad de la
      // empresa: una de servicios no vende en 4135.
      async (ctx, t) =>
        conceptosInventarioPara(await nucleo.familiaDeIngreso(ctx, t)),
    );
  }

  async obtener(ctx: CtxEmpresa, tx?: Tx): Promise<InventarioConfiguracion> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const conceptos = await this.cuentas.obtener(ctx, t);
        return {
          conceptos,
          completa: conceptos.every((c) => c.cuenta !== null),
        };
      },
      tx,
    );
  }

  /** La cuenta de un concepto, elegida entre sus opciones y solo entre ellas. */
  async fijar(
    ctx: CtxEmpresa,
    concepto: ConceptoInventario,
    cuentaId: string,
  ): Promise<InventarioConfiguracion> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.cuentas.fijar(ctx, concepto, cuentaId, t);
      return this.obtener(ctx, t);
    });
  }

  /**
   * Crea las cuentas que falten y asigna cada concepto si no hay nada que
   * elegir. Idempotente. Lo llaman el asistente al crear el plan, la pantalla
   * de inventario al abrirse, y crear un producto o un ajuste si encuentran
   * un concepto sin cuenta.
   */
  async preparar(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<{ cuentasCreadas: string[] }> {
    return this.tx.enContexto(
      ctx,
      async (t) => ({ cuentasCreadas: await this.cuentas.preparar(ctx, t) }),
      tx,
    );
  }

  /**
   * La cuenta que usa hoy un concepto. Si no la tiene, prepara primero: quien
   * opera nunca tiene que ir a configurar nada. Sigue siendo `null` solo si
   * hay varios auxiliares y nadie ha elegido.
   */
  async cuentaDe(
    ctx: CtxEmpresa,
    concepto: ConceptoInventario,
    t: Tx,
  ): Promise<string | null> {
    const cuenta = await this.cuentas.cuentaDe(ctx, concepto, t);
    if (cuenta !== null) return cuenta;
    await this.cuentas.preparar(ctx, t);
    return this.cuentas.cuentaDe(ctx, concepto, t);
  }
}
