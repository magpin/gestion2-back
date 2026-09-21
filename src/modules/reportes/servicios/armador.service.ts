import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { Libro, TipoColumna as TipoLibro } from '../reportes/libros';
import {
  consultaFilas,
  consultaTotales,
  DefinicionInvalida,
  LIMITE_EXCEL,
  LIMITE_FILAS,
  LIMITE_MUESTRA,
  TIEMPO_MAXIMO,
  validar,
  type Definicion,
} from '../reglas/armador';
import {
  columnaDe,
  ORIGENES,
  origenesPara,
  sumaColumna,
  type ClaveOrigen,
  type Columna,
} from '../reglas/catalogo';
import { ATAJOS, type Rango } from '../reglas/rango';
import { ExcelService } from './excel.service';
import { MembreteService } from './membrete.service';

/** Una fila de totales: el total general (`nivel` 0) o el de un grupo. */
export interface Subtotal {
  nivel: number;
  /** Los valores de las columnas de agrupación que definen el grupo. */
  grupo: (string | null)[];
  filas: number;
  /** Por índice de columna, solo las que suman. En texto, para no perder centavos. */
  sumas: Record<number, string | null>;
}

export interface Resultado {
  columnas: {
    clave: string;
    etiqueta: string;
    tipo: Columna['tipo'];
    suma: boolean;
  }[];
  /** Una fila por registro, en el orden de `columnas`. Cifras y fechas en texto. */
  filas: (string | null)[][];
  /** Cuántas filas hay en total, aunque se muestren menos. */
  totalFilas: number;
  /** Si se cortó en el límite: hay más filas de las que se muestran. */
  truncado: boolean;
  limite: number;
  total: Subtotal | null;
  subtotales: Subtotal[];
  rango: Rango;
}

export interface Guardado {
  id: string;
  nombre: string;
  origen: ClaveOrigen;
  definicion: unknown;
  creadoPor: string;
  creadoEn: string;
  actualizadoEn: string;
}

/**
 * Corre definiciones del armador y guarda las que alguien quiere volver a ver.
 *
 * **Los permisos son los de quien corre**, cada vez: un reporte guardado de
 * compras que abre alguien sin compras no devuelve nada, aunque lo haya
 * guardado el contador. Y la definición se vuelve a validar contra el catálogo
 * en cada corrida, no solo al guardarla: una columna que el catálogo dejó de
 * exponer rebota aunque esté en una definición vieja.
 */
@Injectable()
export class ArmadorService {
  constructor(
    private readonly tx: TxService,
    private readonly membretes: MembreteService,
    private readonly excel: ExcelService,
  ) {}

  /** Lo que la pantalla necesita del catálogo: todo menos el SQL. */
  origenes(ctx: CtxEmpresa) {
    return origenesPara(ctx.roles).map((o) => ({
      clave: o.clave,
      etiqueta: o.etiqueta,
      pregunta: o.pregunta,
      columnas: o.columnas.map((c) => ({
        clave: c.clave,
        etiqueta: c.etiqueta,
        tipo: c.tipo,
        filtro: c.filtro ?? null,
        valores: c.valores ?? null,
        conCatalogo: c.catalogo !== undefined,
        agrupable: c.agrupable === true,
        inicial: c.inicial === true,
        suma: sumaColumna(c),
      })),
    }));
  }

  /** Valida lo que llegó; un error de forma es un 400 con el mensaje de la regla. */
  definicion(entrada: unknown): Definicion {
    try {
      return validar(entrada, ATAJOS);
    } catch (e) {
      if (e instanceof DefinicionInvalida)
        throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** Que el rol pueda correr el origen. Se dice cuál, para saber a quién pedírselo. */
  exigirOrigen(ctx: CtxEmpresa, origen: ClaveOrigen): void {
    if (!ORIGENES[origen].roles.some((r) => ctx.roles.includes(r))) {
      throw new ForbiddenException(
        `Este reporte es de ${ORIGENES[origen].etiqueta.toLowerCase()} y tu rol no la incluye. Pídele acceso a quien administra la empresa.`,
      );
    }
  }

  /**
   * Los valores que tiene una columna de lista **en los datos de la empresa**.
   *
   * Salen de la misma expresión que la columna, así que lo que se elige acá es
   * exactamente lo que el filtro va a comparar: un cliente escrito de otra
   * manera en el catálogo de terceros no puede quedar sin coincidir.
   */
  async valores(
    ctx: CtxEmpresa,
    origen: ClaveOrigen,
    clave: string,
  ): Promise<string[]> {
    this.exigirOrigen(ctx, origen);
    const c = columnaDe(origen, clave);
    if (!c || c.filtro !== 'LISTA')
      throw new BadRequestException('Esa columna no se filtra por lista.');
    if (c.valores) return [...c.valores];
    const o = ORIGENES[origen];
    return this.tx.enContexto(ctx, async (t) => {
      await this.tope(t);
      const crudas = filas<{ v: string }>(
        await t.query(
          `SELECT DISTINCT (${c.sql})::text AS v FROM ${o.desde}
            WHERE (${c.sql}) IS NOT NULL ${o.donde ? `AND (${o.donde})` : ''}
            ORDER BY 1 LIMIT 1000`,
        ),
      );
      return crudas.map((r) => r.v);
    });
  }

  /**
   * Corre una definición ya validada.
   *
   * `limite` es `LIMITE_MUESTRA` para la vista previa del armador y
   * `LIMITE_FILAS` para el resultado. Las filas y los totales van en la misma
   * transacción: si alguien factura entre una consulta y otra, el total no
   * puede contar una factura que la tabla no muestra.
   */
  async correr(
    ctx: CtxEmpresa,
    def: Definicion,
    rango: Rango,
    limite: number = LIMITE_FILAS,
  ): Promise<Resultado> {
    this.exigirOrigen(ctx, def.origen);
    const cols = def.columnas.map((k) => columnaDe(def.origen, k)!);

    return this.conTope(() =>
      this.tx.enContexto(ctx, async (t) => {
        await this.tope(t);
        const q = consultaFilas(def, rango, limite);
        const crudas = filas<Record<string, string | null>>(
          await t.query(q.sql, q.parametros),
        );
        const truncado = crudas.length > limite;
        const visibles = truncado ? crudas.slice(0, limite) : crudas;

        const qt = consultaTotales(def, rango);
        const totales = filas<Record<string, string | number | null>>(
          await t.query(qt.sql, qt.parametros),
        );
        const aSubtotal = (
          r: Record<string, string | number | null>,
        ): Subtotal => ({
          nivel: def.agrupar.length === 0 ? 0 : Number(r.nivel),
          grupo: def.agrupar.map(
            (_, i) => (r[`g${i}`] as string | null) ?? null,
          ),
          filas: Number(r.filas),
          sumas: Object.fromEntries(
            cols.flatMap((c, i) =>
              sumaColumna(c)
                ? [[i, (r[`s${i}`] as string | null) ?? null]]
                : [],
            ),
          ),
        });
        const todos = totales.map(aSubtotal);
        const total = todos.find((s) => s.nivel === 0) ?? null;

        return {
          columnas: cols.map((c) => ({
            clave: c.clave,
            etiqueta: c.etiqueta,
            tipo: c.tipo,
            suma: sumaColumna(c),
          })),
          filas: visibles.map((r) => cols.map((_, i) => r[`c${i}`] ?? null)),
          totalFilas: total?.filas ?? visibles.length,
          truncado,
          limite,
          total,
          subtotales: todos.filter((s) => s.nivel > 0),
          rango,
        };
      }),
    );
  }

  /** La muestra de la vista previa: las primeras filas, sin contarla como corrida. */
  muestra(ctx: CtxEmpresa, def: Definicion, rango: Rango): Promise<Resultado> {
    return this.correr(ctx, def, rango, LIMITE_MUESTRA);
  }

  /** El Excel del armador: las filas, planas, con autofiltro y totales. */
  async xlsx(
    ctx: CtxEmpresa,
    def: Definicion,
    rango: Rango,
    nombre: string,
  ): Promise<Buffer> {
    const [r, empresa] = await Promise.all([
      this.correr(ctx, def, rango, LIMITE_EXCEL),
      this.membretes.de(ctx),
    ]);
    const tipo: Record<Columna['tipo'], TipoLibro> = {
      TEXTO: 'TEXTO',
      FECHA: 'FECHA',
      DINERO: 'DINERO',
      CANTIDAD: 'ENTERO',
    };
    const libro: Libro = {
      titulo: nombre,
      parametros: [
        `${ORIGENES[def.origen].etiqueta} · del ${rango.desde} al ${rango.hasta} · ${rango.etiqueta}`,
      ],
      resumen: [{ rotulo: 'Filas', valor: r.totalFilas, tipo: 'ENTERO' }],
      notas: r.truncado
        ? [
            `Son ${r.totalFilas} filas y el archivo trae las primeras ${LIMITE_EXCEL}. Acota las fechas o agrega un filtro.`,
          ]
        : [],
      tablas: [
        {
          nombre: 'Datos',
          columnas: r.columnas.map((c) => ({
            titulo: c.etiqueta,
            tipo: tipo[c.tipo],
            ancho: c.tipo === 'TEXTO' ? 28 : 14,
            suma: c.suma,
          })),
          filas: r.filas.map((f) =>
            f.map((v, i) => {
              const t = r.columnas[i].tipo;
              return v !== null && (t === 'DINERO' || t === 'CANTIDAD')
                ? Number(v)
                : v;
            }),
          ),
          conTotales: r.columnas.some((c) => c.suma),
        },
      ],
    };
    return this.excel.escribir(libro, empresa);
  }

  /* ── Guardados ──────────────────────────────────────────────────────── */

  /** Los guardados de la empresa, todos: el permiso se mira al correr. */
  async guardados(ctx: CtxEmpresa): Promise<Guardado[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Guardado>(
        await t.query(
          `SELECT g.id, g.nombre, g.origen, g.definicion,
                  u.nombre_completo AS "creadoPor",
                  g.creado_en AS "creadoEn", g.actualizado_en AS "actualizadoEn"
             FROM reporte_guardado g
             JOIN usuario u ON u.id = g.creado_por
            WHERE g.archivado_en IS NULL
            ORDER BY lower(g.nombre)`,
        ),
      ),
    );
  }

  async guardado(ctx: CtxEmpresa, id: string): Promise<Guardado> {
    const todos = await this.guardados(ctx);
    const uno = todos.find((g) => g.id === id);
    if (!uno)
      throw new NotFoundException(
        'Ese reporte guardado no existe o ya se borró.',
      );
    return uno;
  }

  async guardar(
    ctx: CtxEmpresa,
    nombre: string,
    def: Definicion,
  ): Promise<{ id: string }> {
    this.exigirOrigen(ctx, def.origen);
    return this.conNombreUnico(() =>
      this.tx.enContexto(ctx, async (t) => {
        const r = filas<{ id: string }>(
          await t.query(
            `INSERT INTO reporte_guardado (empresa_id, nombre, origen, definicion, creado_por)
             VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
            [
              ctx.empresaId,
              nombre.trim(),
              def.origen,
              JSON.stringify(def),
              ctx.usuarioId,
            ],
          ),
        );
        return { id: r[0].id };
      }),
    );
  }

  /** Cambia el nombre, la definición o las dos. El origen no cambia: es otro reporte. */
  async actualizar(
    ctx: CtxEmpresa,
    id: string,
    cambios: { nombre?: string; definicion?: Definicion },
  ): Promise<void> {
    const actual = await this.guardado(ctx, id);
    this.exigirOrigen(ctx, actual.origen);
    if (cambios.definicion && cambios.definicion.origen !== actual.origen) {
      throw new BadRequestException(
        'Un reporte guardado no cambia de origen. Guárdalo como uno nuevo.',
      );
    }
    await this.conNombreUnico(() =>
      this.tx.enContexto(ctx, (t) =>
        t.query(
          `UPDATE reporte_guardado
              SET nombre = COALESCE($2, nombre),
                  definicion = COALESCE($3::jsonb, definicion),
                  actualizado_en = now()
            WHERE id = $1 AND archivado_en IS NULL`,
          [
            id,
            cambios.nombre?.trim() ?? null,
            cambios.definicion ? JSON.stringify(cambios.definicion) : null,
          ],
        ),
      ),
    );
  }

  /** «Borrar» es archivar: acá no se borra nada. */
  async archivar(ctx: CtxEmpresa, id: string): Promise<void> {
    const actual = await this.guardado(ctx, id);
    this.exigirOrigen(ctx, actual.origen);
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE reporte_guardado
            SET archivado_en = now(), archivado_por = $2
          WHERE id = $1 AND archivado_en IS NULL`,
        [id, ctx.usuarioId],
      ),
    );
  }

  /**
   * El techo de una corrida. `SET LOCAL` vive lo que la transacción: no se le
   * escapa a la siguiente petición que use la misma conexión del pool.
   */
  private async tope(t: Tx): Promise<void> {
    await t.query(`SET LOCAL statement_timeout = '${TIEMPO_MAXIMO}'`);
  }

  /** Una corrida que pasó el techo se corta, y se dice qué hacer. */
  private async conTope<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const pg = e as { code?: string; driverError?: { code?: string } };
      if ((pg.code ?? pg.driverError?.code) === '57014') {
        throw new BadRequestException(
          `La consulta tardó más de ${TIEMPO_MAXIMO.replace('s', ' segundos')} y se cortó. Acota las fechas o agrega un filtro.`,
        );
      }
      throw e;
    }
  }

  private async conNombreUnico<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const pg = e as { code?: string; driverError?: { code?: string } };
      if ((pg.code ?? pg.driverError?.code) === '23505') {
        throw new ConflictException(
          'Ya hay un reporte guardado con ese nombre. Elige otro.',
        );
      }
      throw e;
    }
  }
}
