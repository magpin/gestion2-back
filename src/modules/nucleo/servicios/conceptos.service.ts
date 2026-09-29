import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { resolverCuentaConcepto } from '../../../common/contabilidad/cuentas-automaticas';
import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  CrearConceptoDto,
  EditarConceptoDto,
  ListarConceptosDto,
} from '../dto/conceptos.dto';
import {
  CONCEPTOS_INICIALES,
  afectaResultado,
  codigoPropio,
  esOperacional,
  problemaDeCuenta,
  type TipoConcepto,
  type TipoFlujo,
} from './conceptos.reglas';
import { PlanCuentasService } from './plan-cuentas.service';

/** Un concepto como lo ve quien lo elige o lo administra. */
export interface Concepto {
  id: string;
  codigo: string;
  nombre: string;
  grupo: string;
  tipo: TipoConcepto;
  tipoFlujo: TipoFlujo;
  /** `null` si falta elegir el auxiliar: así no se puede usar. */
  cuenta: { id: string; codigo: string; nombre: string } | null;
  /** Leído de la cuenta: 41, 51, 52 sí; 42, 53 no. `null` si no va al resultado. */
  operacional: boolean | null;
  afectaResultado: boolean;
  automatico: boolean;
  esSistema: boolean;
  pistas: string[];
  activo: boolean;
  /** Líneas de asiento que lo llevan. */
  usos: number;
}

/** Lo que dejó `preparar`: para avisar qué se hizo y qué falta decidir. */
export interface ResultadoPreparar {
  creados: number;
  cuentasCreadas: string[];
  /** Conceptos que quedaron sin cuenta porque hay varios auxiliares posibles. */
  sinCuenta: string[];
}

const SELECT = `
  SELECT c.id, c.codigo, c.nombre, c.grupo, c.tipo, c.tipo_flujo, c.automatico,
         c.es_sistema, c.pistas, c.activo,
         ec.id AS cuenta_id, ec.codigo AS cuenta_codigo, ec.nombre AS cuenta_nombre,
         (SELECT count(*)::int FROM asiento_linea al WHERE al.concepto_id = c.id) AS usos
    FROM concepto_movimiento c
    LEFT JOIN empresa_cuenta ec ON ec.id = c.cuenta_id`;

/**
 * El catálogo de conceptos de ingreso y egreso de la empresa.
 *
 * Vive en `nucleo`, junto al plan de cuentas del que cuelga: es parte de lo que
 * define a la empresa antes de mover un peso, y lo usan Tesorería, Compras y
 * Ventas a través de `NucleoApi`.
 */
@Injectable()
export class ConceptosService {
  constructor(
    private readonly tx: TxService,
    private readonly plan: PlanCuentasService,
  ) {}

  async listar(
    ctx: CtxEmpresa,
    q: ListarConceptosDto = {},
    tx?: Tx,
  ): Promise<Concepto[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const condiciones: string[] = [];
        const params: unknown[] = [];
        if (q.tipo !== undefined) {
          params.push(q.tipo);
          condiciones.push(`c.tipo = $${params.length}`);
        }
        if (q.incluirInactivos !== 'true') condiciones.push('c.activo');
        const donde =
          condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
        const f = filas<Record<string, unknown>>(
          await t.query(
            `${SELECT} ${donde} ORDER BY c.tipo, c.grupo, c.orden, c.nombre`,
            params,
          ),
        );
        return f.map(aConcepto);
      },
      tx,
    );
  }

  /**
   * Un concepto del sistema por su código —`GTO-GMF`, `NG-ANTICIPO-CLIENTE`—,
   * para los módulos que lo usan por su cuenta. Si la empresa todavía no tiene
   * el catálogo (nadie abrió Conceptos), se siembra en la misma transacción.
   */
  async porCodigo(ctx: CtxEmpresa, codigo: string, tx?: Tx): Promise<Concepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const buscar = async () =>
          fila<Record<string, unknown>>(
            await t.query(`${SELECT} WHERE c.codigo = $1`, [codigo]),
          );
        let f = await buscar();
        if (f === undefined) {
          await this.preparar(ctx, t);
          f = await buscar();
        }
        if (f === undefined) {
          throw new BadRequestException(
            `Falta el concepto ${codigo} en el catálogo de la empresa.`,
          );
        }
        return aConcepto(f);
      },
      tx,
    );
  }

  async obtener(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<Concepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const f = fila<Record<string, unknown>>(
          await t.query(`${SELECT} WHERE c.id = $1`, [id]),
        );
        if (f === undefined)
          throw new NotFoundException('Ese concepto no existe.');
        return aConcepto(f);
      },
      tx,
    );
  }

  /**
   * Siembra el catálogo inicial. Idempotente: lo que ya está no se toca, y a
   * lo que quedó sin cuenta se le vuelve a buscar una.
   *
   * Por concepto, la cuenta sale igual que en las cuentas automáticas: si la
   * empresa abrió auxiliares de esa cuenta, esos son las opciones —con uno solo
   * queda ese; con varios, el contador elige—; si no tiene nada, se crea la
   * del decreto.
   */
  async preparar(ctx: CtxEmpresa, tx?: Tx): Promise<ResultadoPreparar> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const resultado: ResultadoPreparar = {
          creados: 0,
          cuentasCreadas: [],
          sinCuenta: [],
        };
        const existentes = new Map(
          filas<{ id: string; codigo: string; cuenta_id: string | null }>(
            await t.query(
              'SELECT id, codigo, cuenta_id FROM concepto_movimiento',
            ),
          ).map((c) => [c.codigo, c]),
        );

        for (const [orden, inicial] of CONCEPTOS_INICIALES.entries()) {
          const ya = existentes.get(inicial.codigo);
          if (ya !== undefined && ya.cuenta_id !== null) continue;

          const cuentaId = await this.cuentaParaInicial(
            ctx,
            inicial,
            resultado,
            t,
          );
          if (cuentaId === null) resultado.sinCuenta.push(inicial.nombre);

          if (ya !== undefined) {
            if (cuentaId !== null) {
              await t.query(
                'UPDATE concepto_movimiento SET cuenta_id = $2, actualizado_en = now() WHERE id = $1',
                [ya.id, cuentaId],
              );
            }
            continue;
          }

          // Sin ON CONFLICT con destino: si la empresa ya creó uno propio con
          // el mismo nombre, se respeta el suyo y este no entra.
          const insertado = filas(
            await t.query(
              `INSERT INTO concepto_movimiento
                 (empresa_id, codigo, nombre, grupo, tipo, tipo_flujo, cuenta_id,
                  automatico, es_sistema, pistas, orden)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $10)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [
                ctx.empresaId,
                inicial.codigo,
                inicial.nombre,
                inicial.grupo,
                inicial.tipo,
                inicial.tipoFlujo ?? 'OPERACION',
                cuentaId,
                inicial.automatico ?? false,
                inicial.pistas ?? [],
                orden,
              ],
            ),
          );
          resultado.creados += insertado.length;
        }
        return resultado;
      },
      tx,
    );
  }

  private async cuentaParaInicial(
    ctx: CtxEmpresa,
    inicial: (typeof CONCEPTOS_INICIALES)[number],
    resultado: ResultadoPreparar,
    t: Tx,
  ): Promise<string | null> {
    let familia = await this.plan.cuentaConAuxiliares(ctx, inicial.cuenta, t);
    if (resolverCuentaConcepto(familia).opciones.length === 0) {
      const creada = await this.plan.asegurarCuenta(
        ctx,
        {
          codigo: inicial.cuenta,
          nombre: inicial.nombreCuenta,
          exigeTercero: inicial.exigeTercero ?? false,
        },
        t,
      );
      if (creada !== null) {
        resultado.cuentasCreadas.push(`${creada.codigo} ${creada.nombre}`);
        familia = await this.plan.cuentaConAuxiliares(ctx, inicial.cuenta, t);
      }
    }
    return resolverCuentaConcepto(familia).cuentaId;
  }

  async crear(
    ctx: CtxEmpresa,
    dto: CrearConceptoDto,
    tx?: Tx,
  ): Promise<Concepto> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        await this.validarCuenta(ctx, dto.tipo, dto.cuentaId, t);
        const codigos = new Set(
          filas<{ codigo: string }>(
            await t.query(
              "SELECT codigo FROM concepto_movimiento WHERE codigo LIKE 'PROPIO-%'",
            ),
          ).map((c) => c.codigo),
        );
        const nuevo = fila<{ id: string }>(
          await t.query(
            `INSERT INTO concepto_movimiento
             (empresa_id, codigo, nombre, grupo, tipo, tipo_flujo, cuenta_id, pistas)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING
           RETURNING id`,
            [
              ctx.empresaId,
              codigoPropio(dto.nombre, codigos),
              dto.nombre.trim(),
              dto.grupo.trim(),
              dto.tipo,
              dto.tipoFlujo ?? 'OPERACION',
              dto.cuentaId,
              dto.pistas ?? [],
            ],
          ),
        );
        if (nuevo === undefined) {
          throw new BadRequestException(
            `Ya hay un concepto que se llama «${dto.nombre.trim()}».`,
          );
        }
        return this.obtener(ctx, nuevo.id, t);
      },
      tx,
    );
  }

  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarConceptoDto,
  ): Promise<Concepto> {
    return this.tx.enContexto(ctx, async (t) => {
      const actual = await this.obtener(ctx, id, t);
      if (dto.cuentaId !== undefined) {
        await this.validarCuenta(ctx, actual.tipo, dto.cuentaId, t);
      }
      const cambios: string[] = [];
      const params: unknown[] = [id];
      const poner = (columna: string, valor: unknown) => {
        params.push(valor);
        cambios.push(`${columna} = $${params.length}`);
      };
      if (dto.nombre !== undefined) poner('nombre', dto.nombre.trim());
      if (dto.grupo !== undefined) poner('grupo', dto.grupo.trim());
      if (dto.cuentaId !== undefined) poner('cuenta_id', dto.cuentaId);
      if (dto.tipoFlujo !== undefined) poner('tipo_flujo', dto.tipoFlujo);
      if (dto.activo !== undefined) poner('activo', dto.activo);
      if (dto.pistas !== undefined) poner('pistas', dto.pistas);
      if (cambios.length === 0) return actual;

      try {
        await t.query(
          `UPDATE concepto_movimiento SET ${cambios.join(', ')}, actualizado_en = now() WHERE id = $1`,
          params,
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new BadRequestException(
            `Ya hay un concepto que se llama «${dto.nombre?.trim()}».`,
          );
        }
        throw e;
      }
      return this.obtener(ctx, id, t);
    });
  }

  /** La cuenta existe, está activa, recibe asientos y es de la clase del tipo. */
  private async validarCuenta(
    ctx: CtxEmpresa,
    tipo: TipoConcepto,
    cuentaId: string,
    t: Tx,
  ): Promise<void> {
    const cuenta = await this.plan.cuentaPorId(ctx, cuentaId, t);
    if (cuenta === null)
      throw new BadRequestException(
        'Esa cuenta no está en el plan de la empresa.',
      );
    if (!cuenta.activa) {
      throw new BadRequestException(
        `La cuenta ${cuenta.codigo} está inactiva.`,
      );
    }
    const problema = problemaDeCuenta(tipo, {
      codigo: cuenta.codigo,
      esAuxiliar: cuenta.es_auxiliar,
    });
    if (problema !== null) throw new BadRequestException(problema);
  }
}

function aConcepto(f: Record<string, unknown>): Concepto {
  const tipo = f.tipo as TipoConcepto;
  const cuentaCodigo = f.cuenta_codigo as string | null;
  return {
    id: f.id as string,
    codigo: f.codigo as string,
    nombre: f.nombre as string,
    grupo: f.grupo as string,
    tipo,
    tipoFlujo: f.tipo_flujo as TipoFlujo,
    cuenta:
      f.cuenta_id === null
        ? null
        : {
            id: f.cuenta_id as string,
            codigo: cuentaCodigo as string,
            nombre: f.cuenta_nombre as string,
          },
    operacional:
      cuentaCodigo === null || !afectaResultado(tipo)
        ? null
        : esOperacional(cuentaCodigo),
    afectaResultado: afectaResultado(tipo),
    automatico: f.automatico === true,
    esSistema: f.es_sistema === true,
    pistas: (f.pistas as string[] | null) ?? [],
    activo: f.activo === true,
    usos: Number(f.usos ?? 0),
  };
}
