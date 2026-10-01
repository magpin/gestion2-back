import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import {
  CuentasAutomaticas,
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
  /** Las cajas de más, sin movimientos, que se desactivaron: se maneja una sola. */
  cajasDesactivadas: string[];
  /** Lo que no se pudo dejar listo, en palabras. */
  avisos: string[];
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
   * 2. Si la empresa no tiene caja, crea la caja principal en su sede
   *    principal, con su cuenta «Caja - {sede}». Una sola caja por empresa.
   *
   * Lo llama el asistente al crear el plan de cuentas y la pantalla de
   * tesorería al abrirse, así también llega a las empresas que ya tenían plan.
   */
  async preparar(ctx: CtxEmpresa): Promise<ResultadoPreparar> {
    return this.tx.enContexto(ctx, async (t) => {
      const resultado: ResultadoPreparar = {
        cuentasCreadas: await this.cuentas.preparar(ctx, t),
        cajasCreadas: [],
        cajasDesactivadas: [],
        avisos: [],
      };

      // ── Una sola caja: la principal ──────────────────────────────────────
      // Decisión del dueño (30-09): una empresa maneja una sola caja, la
      // principal, en su sede principal. Ni una por sede ni caja menor.
      // Las empresas que ya tenían más de una se dejan con una: la principal
      // de la sede principal (o la que más se usó); las otras sin movimientos
      // se desactivan. Una con movimientos no se toca: se avisa, porque tiene
      // plata que hay que llevar a la principal antes.
      const activas = filas<{
        id: string;
        nombre: string;
        movimientos: number;
      }>(
        await t.query(
          `SELECT c.id, c.nombre,
                  (SELECT count(*)::int FROM caja_movimiento m WHERE m.caja_id = c.id) AS movimientos
             FROM caja c
             LEFT JOIN empresa_sede s ON s.id = c.sede_id
            WHERE c.activa
            ORDER BY (c.tipo = 'PRINCIPAL') DESC, s.es_principal DESC NULLS LAST,
                     movimientos DESC, c.creado_en`,
        ),
      );
      if (activas.length > 0) {
        for (const otra of activas.slice(1)) {
          if (otra.movimientos > 0) {
            resultado.avisos.push(
              `La caja «${otra.nombre}» tiene movimientos: lleve su saldo a «${activas[0].nombre}» y desactívela; se maneja una sola caja.`,
            );
            continue;
          }
          await t.query('UPDATE caja SET activa = false WHERE id = $1', [
            otra.id,
          ]);
          resultado.cajasDesactivadas.push(otra.nombre);
        }
        return resultado;
      }

      const [sede] = await this.nucleo.sedes(ctx, t);
      if (sede === undefined) {
        resultado.avisos.push(
          'La caja principal no se creó: la empresa no tiene sede.',
        );
        return resultado;
      }
      const familia = await this.nucleo.cuentaConAuxiliares(ctx, '110505', t);
      let cuenta: { id: string } | undefined =
        familia.auxiliares.find(
          (c) => c.nombre.trim() === `Caja - ${sede.nombre}`.trim(),
        ) ??
        familia.auxiliares[0] ??
        (familia.cuenta?.esAuxiliar ? familia.cuenta : undefined);
      if (cuenta === undefined) {
        try {
          await t.query('SAVEPOINT caja_principal');
          const creada = await this.nucleo.crearAuxiliar(
            ctx,
            { madre: '110505', nombre: `Caja - ${sede.nombre}` },
            { sistema: true },
            t,
          );
          await t.query('RELEASE SAVEPOINT caja_principal');
          resultado.cuentasCreadas.push(`${creada.codigo} ${creada.nombre}`);
          cuenta = creada;
        } catch (e) {
          await t.query('ROLLBACK TO SAVEPOINT caja_principal');
          resultado.avisos.push(
            `La caja principal no se creó: ${e instanceof Error ? e.message : 'no se pudo crear su cuenta'}`,
          );
          return resultado;
        }
      }

      await this.crearCaja(ctx, t, {
        nombre: 'Caja principal',
        tipo: 'PRINCIPAL',
        sedeId: sede.id,
        cuentaId: cuenta.id,
      });
      resultado.cajasCreadas.push('Caja principal');

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
