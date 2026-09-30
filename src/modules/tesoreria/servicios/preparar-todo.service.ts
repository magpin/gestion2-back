import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { CajaConfiguracionService } from './caja-configuracion.service';

/** Lo que dejó hecho cada paso, y lo que no se pudo. */
export interface ResultadoPrepararTodo {
  pasos: Array<{ paso: string; hecho: string[]; error?: string }>;
}

/**
 * Deja una empresa lista para operar sin crear nada a mano (plan de ventas,
 * Fase 6): cobrar por banco, facturar con su propio ingreso, registrar un
 * gasto por concepto y cargar el saldo inicial. En orden:
 *
 * 1. corrige la depreciación que la sugerencia vieja puso en códigos de flota;
 * 2. tesorería: las cuentas de arqueo, la caja de cada sede y la caja menor;
 * 3. inventario: las cuentas de un producto nuevo, según la actividad;
 * 4. los conceptos de movimiento con su cuenta;
 * 5. el patrimonio (el capital y la 370505).
 *
 * Cada paso es idempotente y va en su propia transacción: si uno falla, los
 * demás siguen, y el resultado dice cuál y por qué. Lo usa el asistente al
 * terminar; para una empresa que ya existía, se corre una vez.
 *
 * Vive en tesorería porque es el módulo que puede ver a núcleo y a
 * inventario; núcleo no puede llamar a tesorería.
 */
@Injectable()
export class PrepararTodoService {
  constructor(
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly caja: CajaConfiguracionService,
  ) {}

  async preparar(ctx: CtxEmpresa): Promise<ResultadoPrepararTodo> {
    const pasos: ResultadoPrepararTodo['pasos'] = [];
    const paso = async (nombre: string, fn: () => Promise<string[]>) => {
      try {
        pasos.push({ paso: nombre, hecho: await fn() });
      } catch (e) {
        pasos.push({
          paso: nombre,
          hecho: [],
          error: e instanceof Error ? e.message : 'No se pudo.',
        });
      }
    };

    await paso('Depreciación', () => this.nucleo.corregirDepreciacion(ctx));
    await paso('Tesorería', async () => {
      const r = await this.caja.preparar(ctx);
      return [
        ...r.cuentasCreadas,
        ...r.cajasCreadas,
        ...r.cajasDesactivadas.map((c) => `Caja desactivada: ${c}`),
        ...r.avisos,
      ];
    });
    await paso(
      'Inventario',
      async () => (await this.inventario.prepararCuentas(ctx)).cuentasCreadas,
    );
    await paso('Conceptos', async () => {
      const r = await this.nucleo.prepararConceptos(ctx);
      return [
        ...r.cuentasCreadas,
        ...(r.creados > 0 ? [`${r.creados} conceptos creados`] : []),
        ...r.sinCuenta.map((c) => `Sin cuenta: ${c}`),
      ];
    });
    await paso('Patrimonio', () => this.nucleo.prepararPatrimonio(ctx));

    return { pasos };
  }
}
