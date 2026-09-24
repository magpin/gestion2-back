import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../ctx';
import { fila } from '../db/filas';
import type { Tx } from '../db/tx.service';
import type {
  ContabilidadApi,
  UsoDeCuenta,
} from '../../modules/contabilidad/contabilidad.api';
import type { NucleoApi } from '../../modules/nucleo/nucleo.api';

/**
 * Cuentas automáticas: la cuenta contable que un módulo usa por su cuenta,
 * sin que nadie la elija al operar —el sobrante de un arqueo, la merma de
 * inventario, el costo de venta de un producto—.
 *
 * La regla es la misma en todos los módulos:
 *
 * - El sistema propone una cuenta del decreto y, si la empresa no la tiene,
 *   la crea.
 * - Si la empresa abrió auxiliares de esa cuenta, esos son las opciones: con
 *   uno solo queda ese; con varios, el contador elige una vez.
 *
 * Cada módulo declara sus conceptos y la tabla donde guarda la elección
 * (una fila por empresa, una columna por concepto). Esto hace el resto.
 */

export interface DefinicionConcepto {
  /** Dónde se buscan la cuenta y sus auxiliares: `1435` encuentra `143501`. */
  familia: string;
  /** Qué cuenta se crea si la familia está vacía. */
  codigoCrear: string;
  nombreCuenta: string;
  etiqueta: string;
  /** Qué hace el sistema con esta cuenta, dicho para quien no es contador. */
  explicacion: string;
  exigeTercero?: boolean;
  /** Columna de la tabla de configuración del módulo. */
  columna: string;
}

export interface CuentaElegible {
  id: string;
  codigo: string;
  nombre: string;
  esAuxiliar: boolean;
}

export interface CuentaDelConcepto {
  id: string;
  codigo: string;
  nombre: string;
}

export interface ConceptoConfigurado<C extends string = string> {
  concepto: C;
  etiqueta: string;
  explicacion: string;
  /** La cuenta del decreto que el sistema propone. */
  codigoPorDefecto: string;
  /** La que se usa hoy. `null` si hay que elegir entre varios auxiliares. */
  cuenta: CuentaDelConcepto | null;
  /** Entre cuáles se elige. Más de una es lo que obliga a preguntar. */
  opciones: CuentaDelConcepto[];
  /** Cuánto la ha usado el sistema: movimientos y fecha del último. */
  uso: UsoDeCuenta;
}

/**
 * Entre qué cuentas se elige un concepto, y cuál queda si no hay nada que
 * elegir.
 *
 * - Si la familia abrió auxiliares, esos son las opciones: la madre ya no
 *   recibe asientos. Con uno solo, no hay pregunta.
 * - Sin auxiliares, la cuenta misma, si recibe asientos.
 * - Sin cuenta ni auxiliares, nada: hay que crearla.
 */
export function resolverCuentaConcepto(familia: {
  cuenta: CuentaElegible | null;
  auxiliares: CuentaElegible[];
}): { opciones: CuentaElegible[]; cuentaId: string | null } {
  const opciones =
    familia.auxiliares.length > 0
      ? familia.auxiliares
      : familia.cuenta !== null && familia.cuenta.esAuxiliar
        ? [familia.cuenta]
        : [];
  return {
    opciones,
    cuentaId: opciones.length === 1 ? opciones[0].id : null,
  };
}

/**
 * La maquinaria de un módulo. `tabla` y las columnas salen de código, nunca
 * de quien llama a un endpoint: por eso se pueden interpolar en el SQL.
 */
export class CuentasAutomaticas<C extends string> {
  constructor(
    private readonly tabla: string,
    private readonly conceptos: Record<C, DefinicionConcepto>,
    private readonly orden: C[],
    private readonly nucleo: NucleoApi,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /** Lo guardado: una columna por concepto, `null` si nadie la ha fijado. */
  async leer(ctx: CtxEmpresa, t: Tx): Promise<Record<C, string | null>> {
    const columnas = this.orden.map((c) => this.conceptos[c].columna);
    const f = fila<Record<string, string | null>>(
      await t.query(
        `SELECT ${columnas.join(', ')} FROM ${this.tabla} WHERE empresa_id = $1`,
        [ctx.empresaId],
      ),
    );
    return Object.fromEntries(
      this.orden.map((c) => [c, f?.[this.conceptos[c].columna] ?? null]),
    ) as Record<C, string | null>;
  }

  /** La cuenta que usa hoy un concepto, para quien asienta. */
  async cuentaDe(ctx: CtxEmpresa, concepto: C, t: Tx): Promise<string | null> {
    return (await this.leer(ctx, t))[concepto];
  }

  async obtener(ctx: CtxEmpresa, t: Tx): Promise<ConceptoConfigurado<C>[]> {
    const guardada = await this.leer(ctx, t);
    const conceptos: ConceptoConfigurado<C>[] = [];

    for (const concepto of this.orden) {
      const def = this.conceptos[concepto];
      const { opciones } = resolverCuentaConcepto(
        await this.nucleo.cuentaConAuxiliares(ctx, def.familia, t),
      );
      const id = guardada[concepto];
      // La elegida puede no estar entre las opciones: alguien la fijó antes de
      // que existieran los conceptos.
      const cuenta =
        id === null
          ? null
          : (opciones.find((o) => o.id === id) ??
            (await this.nucleo.cuentaPorId(ctx, id, t)));

      conceptos.push({
        concepto,
        etiqueta: def.etiqueta,
        explicacion: def.explicacion,
        codigoPorDefecto: def.codigoCrear,
        cuenta:
          cuenta === null
            ? null
            : { id: cuenta.id, codigo: cuenta.codigo, nombre: cuenta.nombre },
        opciones: opciones.map(soloDatos),
        uso: { movimientos: 0, ultimaFecha: null },
      });
    }

    const uso = await this.contabilidad.usoDeCuentas(
      conceptos.flatMap((c) => (c.cuenta === null ? [] : [c.cuenta.id])),
      t,
    );
    for (const c of conceptos) {
      if (c.cuenta !== null) {
        c.uso = uso.get(c.cuenta.id) ?? c.uso;
      }
    }
    return conceptos;
  }

  /** La cuenta de un concepto, elegida entre sus opciones y solo entre ellas. */
  async fijar(
    ctx: CtxEmpresa,
    concepto: C,
    cuentaId: string,
    t: Tx,
  ): Promise<void> {
    const def = this.conceptos[concepto];
    const { opciones } = resolverCuentaConcepto(
      await this.nucleo.cuentaConAuxiliares(ctx, def.familia, t),
    );
    if (!opciones.some((o) => o.id === cuentaId)) {
      throw new BadRequestException(
        `Para «${def.etiqueta}» se elige la cuenta ${def.familia} o uno de sus auxiliares.`,
      );
    }
    await this.guardar(ctx, concepto, cuentaId, t);
  }

  /**
   * Crea las cuentas que falten y asigna cada concepto sin cuenta si no hay
   * nada que elegir. Idempotente. Devuelve las cuentas creadas.
   */
  async preparar(ctx: CtxEmpresa, t: Tx): Promise<string[]> {
    const creadas: string[] = [];
    const guardada = await this.leer(ctx, t);

    for (const concepto of this.orden) {
      const def = this.conceptos[concepto];
      let familia = await this.nucleo.cuentaConAuxiliares(ctx, def.familia, t);

      // Sin nada que reciba asientos —ni auxiliares, ni una cuenta madre que
      // los reciba (4135 del plan, que agrupa)—, se crea la del decreto.
      if (resolverCuentaConcepto(familia).opciones.length === 0) {
        const creada = await this.nucleo.asegurarCuenta(
          ctx,
          {
            codigo: def.codigoCrear,
            nombre: def.nombreCuenta,
            exigeTercero: def.exigeTercero ?? false,
          },
          t,
        );
        if (creada !== null) {
          creadas.push(`${creada.codigo} ${creada.nombre}`);
          familia = await this.nucleo.cuentaConAuxiliares(ctx, def.familia, t);
        }
      }

      if (guardada[concepto] === null) {
        const { cuentaId } = resolverCuentaConcepto(familia);
        if (cuentaId !== null) {
          await this.guardar(ctx, concepto, cuentaId, t);
        }
      }
    }
    return creadas;
  }

  private async guardar(
    ctx: CtxEmpresa,
    concepto: C,
    cuentaId: string,
    t: Tx,
  ): Promise<void> {
    const columna = this.conceptos[concepto].columna;
    await t.query(
      `INSERT INTO ${this.tabla} (empresa_id, ${columna})
       VALUES ($1, $2)
       ON CONFLICT (empresa_id) DO UPDATE SET ${columna} = EXCLUDED.${columna}`,
      [ctx.empresaId, cuentaId],
    );
  }
}

function soloDatos(c: CuentaElegible): CuentaDelConcepto {
  return { id: c.id, codigo: c.codigo, nombre: c.nombre };
}
