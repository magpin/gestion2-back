import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  CuentasAutomaticas,
  resolverCuentaConcepto,
  type ConceptoConfigurado,
} from '../../../common/contabilidad/cuentas-automaticas';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  CONCEPTOS_ARQUEO,
  ORDEN_CONCEPTOS,
  type ConceptoArqueo,
} from './caja.reglas';

export interface CajaConfiguracion {
  conceptos: ConceptoConfigurado<ConceptoArqueo>[];
  /** Los tres conceptos tienen cuenta: cualquier arqueo puede cerrar. */
  completa: boolean;
}

/** Lo que `preparar` dejó hecho, para contárselo a quien lo pidió. */
export interface ResultadoPreparar {
  cuentasCreadas: string[];
  cajasCreadas: string[];
}

/**
 * Las cuentas automáticas de caja —contra qué se ajusta cada diferencia de
 * arqueo— y lo que tesorería necesita para operar sin que nadie configure
 * nada: la caja de cada sede y la caja menor.
 *
 * La regla de las cuentas es la de `CuentasAutomaticas`: el sistema propone
 * la del decreto, la crea si falta, y solo pregunta cuando hay varios
 * auxiliares entre los que elegir.
 */
@Injectable()
export class CajaConfiguracionService {
  private readonly cuentas: CuentasAutomaticas<ConceptoArqueo>;

  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    contabilidad: ContabilidadApi,
  ) {
    this.cuentas = new CuentasAutomaticas(
      'caja_configuracion',
      CONCEPTOS_ARQUEO,
      ORDEN_CONCEPTOS,
      nucleo,
      contabilidad,
    );
  }

  async obtener(ctx: CtxEmpresa, tx?: Tx): Promise<CajaConfiguracion> {
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
    concepto: ConceptoArqueo,
    cuentaId: string,
  ): Promise<CajaConfiguracion> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.cuentas.fijar(ctx, concepto, cuentaId, t);
      return this.obtener(ctx, t);
    });
  }

  /** La cuenta que usa hoy un concepto, para quien asienta el ajuste. */
  async cuentaDe(
    ctx: CtxEmpresa,
    concepto: ConceptoArqueo,
    t: Tx,
  ): Promise<string | null> {
    return this.cuentas.cuentaDe(ctx, concepto, t);
  }

  /**
   * Deja tesorería lista para operar. Se puede correr las veces que sea: lo
   * que ya existe no se toca.
   *
   * 1. Crea las cuentas de arqueo que falten (429553, 136530, 531595) y
   *    asigna cada concepto si no hay nada que elegir.
   * 2. Crea la caja principal de cada sede que no tenga una, con su cuenta
   *    «Caja - {sede}» del plan.
   * 3. Si la empresa maneja caja menor, crea la caja menor con la 110510.
   *
   * Lo llama el asistente al crear el plan de cuentas y la pantalla de
   * tesorería al abrirse, así también llega a las empresas que ya tenían plan.
   */
  async preparar(ctx: CtxEmpresa): Promise<ResultadoPreparar> {
    return this.tx.enContexto(ctx, async (t) => {
      const resultado: ResultadoPreparar = {
        cuentasCreadas: await this.cuentas.preparar(ctx, t),
        cajasCreadas: [],
      };

      // ── Una caja principal por sede ──────────────────────────────────────
      const sedes = await this.nucleo.sedes(ctx, t);
      const cajasSede = await this.nucleo.cuentaConAuxiliares(ctx, '110505', t);
      const conCaja = new Set(
        filas<{ sede_id: string }>(
          await t.query(
            `SELECT sede_id FROM caja WHERE tipo = 'PRINCIPAL' AND activa`,
          ),
        ).map((c) => c.sede_id),
      );

      for (const sede of sedes) {
        if (conCaja.has(sede.id)) continue;
        // El plan crea «Caja - {sede}» debajo de 110505. Con una sola sede y
        // sin auxiliares, la 110505 misma es su caja.
        const cuenta =
          cajasSede.auxiliares.find(
            (c) => c.nombre.trim() === `Caja - ${sede.nombre}`.trim(),
          ) ??
          (sedes.length === 1 &&
          cajasSede.auxiliares.length === 0 &&
          cajasSede.cuenta?.esAuxiliar
            ? cajasSede.cuenta
            : undefined);
        if (cuenta === undefined) continue;

        await this.crearCaja(ctx, t, {
          nombre: `Caja ${sede.nombre}`,
          tipo: 'PRINCIPAL',
          sedeId: sede.id,
          cuentaId: cuenta.id,
        });
        resultado.cajasCreadas.push(`Caja ${sede.nombre}`);
      }

      // ── Caja menor ───────────────────────────────────────────────────────
      const manejaCajaMenor = await this.nucleo.tieneHechoOperativo(
        ctx,
        'MANEJA_CAJA_MENOR',
        t,
      );
      // Cualquier caja menor, activa o no: si alguien la desactivó, no se
      // vuelve a crear por la espalda.
      const yaTiene = fila<{ id: string }>(
        await t.query(`SELECT id FROM caja WHERE tipo = 'MENOR' LIMIT 1`),
      );
      if (manejaCajaMenor && yaTiene === undefined) {
        let familia = await this.nucleo.cuentaConAuxiliares(ctx, '110510', t);
        if (familia.cuenta === null && familia.auxiliares.length === 0) {
          const creada = await this.nucleo.asegurarCuenta(
            ctx,
            { codigo: '110510', nombre: 'Caja menor' },
            t,
          );
          if (creada !== null) {
            resultado.cuentasCreadas.push(`${creada.codigo} ${creada.nombre}`);
          }
          familia = await this.nucleo.cuentaConAuxiliares(ctx, '110510', t);
        }
        const { cuentaId } = resolverCuentaConcepto(familia);
        if (cuentaId !== null) {
          await this.crearCaja(ctx, t, {
            nombre: 'Caja menor',
            tipo: 'MENOR',
            sedeId: null,
            cuentaId,
          });
          resultado.cajasCreadas.push('Caja menor');
        }
      }

      return resultado;
    });
  }

  private async crearCaja(
    ctx: CtxEmpresa,
    t: Tx,
    c: {
      nombre: string;
      tipo: 'PRINCIPAL' | 'MENOR';
      sedeId: string | null;
      cuentaId: string;
    },
  ): Promise<void> {
    await t.query(
      `INSERT INTO caja (empresa_id, nombre, tipo, sede_id, cuenta_id, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ctx.empresaId, c.nombre, c.tipo, c.sedeId, c.cuentaId, ctx.usuarioId],
    );
  }
}

/**
 * La cuenta que usa hoy un concepto, para quien asienta el ajuste dentro de
 * su propia transacción. La columna sale de `CONCEPTOS_ARQUEO`, nunca de
 * quien llama.
 */
export async function cuentaDeConcepto(
  t: Tx,
  ctx: CtxEmpresa,
  concepto: ConceptoArqueo,
): Promise<string | null> {
  const f = fila<{ cuenta_id: string | null }>(
    await t.query(
      `SELECT ${CONCEPTOS_ARQUEO[concepto].columna} AS cuenta_id FROM caja_configuracion WHERE empresa_id = $1`,
      [ctx.empresaId],
    ),
  );
  return f?.cuenta_id ?? null;
}
