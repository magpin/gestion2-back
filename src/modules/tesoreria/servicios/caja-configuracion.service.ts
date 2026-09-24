import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  CONCEPTOS_ARQUEO,
  ORDEN_CONCEPTOS,
  resolverCuentaConcepto,
  type ConceptoArqueo,
  type CuentaElegible,
} from './caja.reglas';

/** La columna de `caja_configuracion` de cada concepto. */
const COLUMNA: Record<ConceptoArqueo, string> = {
  SOBRANTE: 'cuenta_sobrante_id',
  FALTANTE_COBRABLE: 'cuenta_faltante_cobrable_id',
  FALTANTE_ASUMIDO: 'cuenta_faltante_asumido_id',
};

type Fila = Record<(typeof COLUMNA)[ConceptoArqueo], string | null>;

export interface CuentaDelConcepto {
  id: string;
  codigo: string;
  nombre: string;
}

export interface ConceptoConfigurado {
  concepto: ConceptoArqueo;
  etiqueta: string;
  /** La cuenta del decreto que el sistema propone para este concepto. */
  codigoPorDefecto: string;
  /** La que se usa hoy. `null` si hay que elegir entre varios auxiliares. */
  cuenta: CuentaDelConcepto | null;
  /**
   * Entre cuáles se elige: los auxiliares de la cuenta por defecto, o la
   * cuenta misma si no tiene. Más de una opción es lo que obliga a preguntar.
   */
  opciones: CuentaDelConcepto[];
}

export interface CajaConfiguracion {
  conceptos: ConceptoConfigurado[];
  /** Los tres conceptos tienen cuenta: cualquier arqueo puede cerrar. */
  completa: boolean;
}

/** Lo que `preparar` dejó hecho, para contárselo a quien lo pidió. */
export interface ResultadoPreparar {
  cuentasCreadas: string[];
  cajasCreadas: string[];
}

/**
 * Contra qué cuenta se ajusta cada diferencia de arqueo, y lo que tesorería
 * necesita para operar sin que nadie tenga que configurar nada a mitad de un
 * cierre.
 *
 * La regla es la del plan de cuentas: el sistema propone la cuenta del
 * decreto y solo pregunta cuando hay algo que decidir —la empresa abrió
 * auxiliares de esa cuenta y hay que elegir cuál—.
 */
@Injectable()
export class CajaConfiguracionService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
  ) {}

  async obtener(ctx: CtxEmpresa, tx?: Tx): Promise<CajaConfiguracion> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const guardada = await this.leer(ctx, t);
        const conceptos: ConceptoConfigurado[] = [];

        for (const concepto of ORDEN_CONCEPTOS) {
          const def = CONCEPTOS_ARQUEO[concepto];
          const { opciones } = resolverCuentaConcepto(
            await this.nucleo.cuentaConAuxiliares(ctx, def.codigo, t),
          );
          const id = guardada[COLUMNA[concepto]];
          // La elegida puede no estar entre las opciones: alguien la fijó antes
          // de que existieran los conceptos (la vieja «cuenta de diferencia»).
          const cuenta =
            id === null
              ? null
              : (opciones.find((o) => o.id === id) ??
                (await this.nucleo.cuentaPorId(ctx, id, t)));

          conceptos.push({
            concepto,
            etiqueta: def.etiqueta,
            codigoPorDefecto: def.codigo,
            cuenta:
              cuenta === null
                ? null
                : {
                    id: cuenta.id,
                    codigo: cuenta.codigo,
                    nombre: cuenta.nombre,
                  },
            opciones: opciones.map(soloDatos),
          });
        }

        return {
          conceptos,
          completa: conceptos.every((c) => c.cuenta !== null),
        };
      },
      tx,
    );
  }

  /**
   * La cuenta de un concepto, elegida entre sus opciones. Solo entre ellas: el
   * concepto es la cuenta del decreto o uno de sus auxiliares, no cualquier
   * cuenta del plan.
   */
  async fijar(
    ctx: CtxEmpresa,
    concepto: ConceptoArqueo,
    cuentaId: string,
  ): Promise<CajaConfiguracion> {
    return this.tx.enContexto(ctx, async (t) => {
      const def = CONCEPTOS_ARQUEO[concepto];
      const { opciones } = resolverCuentaConcepto(
        await this.nucleo.cuentaConAuxiliares(ctx, def.codigo, t),
      );
      if (!opciones.some((o) => o.id === cuentaId)) {
        throw new BadRequestException(
          `Para «${def.etiqueta}» se elige la cuenta ${def.codigo} o uno de sus auxiliares.`,
        );
      }
      await this.guardar(ctx, concepto, cuentaId, t);
      return this.obtener(ctx, t);
    });
  }

  /**
   * Deja tesorería lista para operar. Se puede correr las veces que sea: lo
   * que ya existe no se toca.
   *
   * 1. Crea las cuentas de arqueo que la empresa no tenga (429553, 136530,
   *    531595) y asigna cada concepto si no hay nada que elegir.
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
        cuentasCreadas: [],
        cajasCreadas: [],
      };

      // ── 1. Cuentas de arqueo ─────────────────────────────────────────────
      const guardada = await this.leer(ctx, t);
      for (const concepto of ORDEN_CONCEPTOS) {
        const def = CONCEPTOS_ARQUEO[concepto];
        let familia = await this.nucleo.cuentaConAuxiliares(ctx, def.codigo, t);

        if (familia.cuenta === null && familia.auxiliares.length === 0) {
          const creada = await this.nucleo.asegurarCuenta(
            ctx,
            {
              codigo: def.codigo,
              nombre: def.nombreCuenta,
              exigeTercero: def.exigeTercero,
            },
            t,
          );
          if (creada !== null) {
            resultado.cuentasCreadas.push(`${creada.codigo} ${creada.nombre}`);
            familia = await this.nucleo.cuentaConAuxiliares(ctx, def.codigo, t);
          }
        }

        if (guardada[COLUMNA[concepto]] === null) {
          const { cuentaId } = resolverCuentaConcepto(familia);
          if (cuentaId !== null) {
            await this.guardar(ctx, concepto, cuentaId, t);
          }
        }
      }

      // ── 2. Una caja principal por sede ───────────────────────────────────
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

      // ── 3. Caja menor ────────────────────────────────────────────────────
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

  // ---------------------------------------------------------------------------

  private async leer(ctx: CtxEmpresa, t: Tx): Promise<Fila> {
    return (
      fila<Fila>(
        await t.query(
          `SELECT cuenta_sobrante_id, cuenta_faltante_cobrable_id, cuenta_faltante_asumido_id
             FROM caja_configuracion WHERE empresa_id = $1`,
          [ctx.empresaId],
        ),
      ) ?? {
        cuenta_sobrante_id: null,
        cuenta_faltante_cobrable_id: null,
        cuenta_faltante_asumido_id: null,
      }
    );
  }

  /**
   * `UPSERT` de una sola columna. La columna sale de `COLUMNA`, nunca de
   * quien llama: por eso se puede interpolar.
   */
  private async guardar(
    ctx: CtxEmpresa,
    concepto: ConceptoArqueo,
    cuentaId: string,
    t: Tx,
  ): Promise<void> {
    const columna = COLUMNA[concepto];
    await t.query(
      `INSERT INTO caja_configuracion (empresa_id, ${columna})
       VALUES ($1, $2)
       ON CONFLICT (empresa_id) DO UPDATE SET ${columna} = EXCLUDED.${columna}`,
      [ctx.empresaId, cuentaId],
    );
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

function soloDatos(c: CuentaElegible): CuentaDelConcepto {
  return { id: c.id, codigo: c.codigo, nombre: c.nombre };
}

/** La cuenta que usa hoy un concepto, para quien asienta el ajuste. */
export async function cuentaDeConcepto(
  t: Tx,
  ctx: CtxEmpresa,
  concepto: ConceptoArqueo,
): Promise<string | null> {
  const f = fila<Record<string, string | null>>(
    await t.query(
      `SELECT ${COLUMNA[concepto]} AS cuenta_id FROM caja_configuracion WHERE empresa_id = $1`,
      [ctx.empresaId],
    ),
  );
  return f?.cuenta_id ?? null;
}
