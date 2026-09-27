import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { hoyEnColombia } from '../../../common/fecha';
import type { Tokens } from '../../../common/ia/modelos';
import {
  armarTablero,
  type FilaLectura,
  type FilaRespuesta,
  type Tablero,
} from '../reglas/consumo';
import {
  armarDetalle,
  ETIQUETA_CATEGORIA,
  POR_PAGINA,
  type Categoria,
  type Detalle,
} from '../reglas/detalle';

/** Lo más que se trae de un período. Más que eso ya pide agregar en la base. */
const TOPE_FILAS = 100_000;
/** El rango más largo que se deja pedir. */
const DIAS_MAXIMOS = 400;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** El día en hora de Colombia, como texto: es lo que agrupa el tablero. */
const DIA = (columna: string) =>
  `to_char((${columna} AT TIME ZONE 'America/Bogota')::date, 'YYYY-MM-DD')`;

/**
 * Las consultas del tablero. **Nunca seleccionan texto** —ni `texto`, ni
 * `motivo`, ni `extraido`—: solo cifras y de qué empresa. Una prueba lo revisa
 * leyendo este SQL.
 */
export const SQL_RESPUESTAS = `
  SELECT t.id, t.empresa_id, e.razon_social AS empresa,
         ${DIA('t.creado_en')} AS dia, t.creado_en AS fecha,
         t.estado, t.modelo, t.uso, t.duracion_ms, t.vueltas,
         (SELECT count(*)::int FROM conversacion_consulta c WHERE c.turno_id = t.id) AS consultas
    FROM conversacion_turno t
    JOIN empresa e ON e.id = t.empresa_id
   WHERE t.autor = 'ASISTENTE' AND t.uso IS NOT NULL
     AND (t.creado_en AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date
     AND ($3::uuid IS NULL OR t.empresa_id = $3::uuid)
     AND ($4::uuid IS NULL OR e.tenant_id = $4::uuid)
   ORDER BY t.creado_en
   LIMIT ${TOPE_FILAS}`;

/**
 * Las lecturas y, con ellas, las propuestas del clasificador de retenciones
 * (fuente 5, `retencion_clasificacion_ia`): también son una llamada al modelo
 * sobre un documento. Van con el tipo `CONCEPTO_RETENCION`.
 */
export const SQL_LECTURAS = `
  SELECT d.empresa_id, e.razon_social AS empresa,
         ${DIA('coalesce(d.leido_en, d.creado_en)')} AS dia,
         d.tipo, d.estado, d.modelo, d.uso, d.duracion_ms
    FROM documento_leido d
    JOIN empresa e ON e.id = d.empresa_id
   WHERE d.estado IN ('LEIDO', 'FALLO')
     AND (coalesce(d.leido_en, d.creado_en) AT TIME ZONE 'America/Bogota')::date
         BETWEEN $1::date AND $2::date
     AND ($3::uuid IS NULL OR d.empresa_id = $3::uuid)
     AND ($4::uuid IS NULL OR e.tenant_id = $4::uuid)
  UNION ALL
  SELECT c.empresa_id, e.razon_social AS empresa,
         ${DIA('c.creado_en')} AS dia,
         'CONCEPTO_RETENCION' AS tipo,
         CASE WHEN c.estado = 'FALLO' THEN 'FALLO' ELSE 'LEIDO' END AS estado,
         c.modelo, c.uso, c.duracion_ms
    FROM retencion_clasificacion_ia c
    JOIN empresa e ON e.id = c.empresa_id
   WHERE (c.creado_en AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date
     AND ($3::uuid IS NULL OR c.empresa_id = $3::uuid)
     AND ($4::uuid IS NULL OR e.tenant_id = $4::uuid)
   LIMIT ${TOPE_FILAS}`;

/**
 * Para el detalle: cada respuesta con los **nombres** de las herramientas que
 * usó, en orden, y cuántas propuestas dejó. De `conversacion_consulta` se lee
 * solo `herramienta`; de `asistente_propuesta`, solo contar. Lo que se pidió
 * (`entrada`) y lo que se propuso no se tocan.
 */
export const SQL_DETALLE_RESPUESTAS = `
  SELECT t.id, t.empresa_id, e.razon_social AS empresa,
         ${DIA('t.creado_en')} AS dia, t.creado_en AS fecha,
         t.estado, t.modelo, t.uso, t.duracion_ms, t.vueltas,
         coalesce((SELECT array_agg(c.herramienta ORDER BY c.orden)
                     FROM conversacion_consulta c WHERE c.turno_id = t.id),
                  '{}') AS herramientas,
         (SELECT count(*)::int FROM asistente_propuesta p WHERE p.turno_id = t.id) AS propuestas
    FROM conversacion_turno t
    JOIN empresa e ON e.id = t.empresa_id
   WHERE t.autor = 'ASISTENTE' AND t.uso IS NOT NULL
     AND (t.creado_en AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date
     AND ($3::uuid IS NULL OR t.empresa_id = $3::uuid)
     AND ($4::uuid IS NULL OR e.tenant_id = $4::uuid)
   LIMIT ${TOPE_FILAS}`;

/** Las lecturas con su id y su hora, para listarlas una por una. */
export const SQL_DETALLE_LECTURAS = `
  SELECT d.id, d.empresa_id, e.razon_social AS empresa,
         ${DIA('coalesce(d.leido_en, d.creado_en)')} AS dia,
         coalesce(d.leido_en, d.creado_en) AS fecha,
         d.tipo, d.estado, d.modelo, d.uso, d.duracion_ms
    FROM documento_leido d
    JOIN empresa e ON e.id = d.empresa_id
   WHERE d.estado IN ('LEIDO', 'FALLO')
     AND (coalesce(d.leido_en, d.creado_en) AT TIME ZONE 'America/Bogota')::date
         BETWEEN $1::date AND $2::date
     AND ($3::uuid IS NULL OR d.empresa_id = $3::uuid)
     AND ($4::uuid IS NULL OR e.tenant_id = $4::uuid)
  UNION ALL
  SELECT c.id, c.empresa_id, e.razon_social AS empresa,
         ${DIA('c.creado_en')} AS dia,
         c.creado_en AS fecha,
         'CONCEPTO_RETENCION' AS tipo,
         CASE WHEN c.estado = 'FALLO' THEN 'FALLO' ELSE 'LEIDO' END AS estado,
         c.modelo, c.uso, c.duracion_ms
    FROM retencion_clasificacion_ia c
    JOIN empresa e ON e.id = c.empresa_id
   WHERE (c.creado_en AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date
     AND ($3::uuid IS NULL OR c.empresa_id = $3::uuid)
     AND ($4::uuid IS NULL OR e.tenant_id = $4::uuid)
   LIMIT ${TOPE_FILAS}`;

/**
 * Las empresas que usaron la IA alguna vez, con su cuenta: para los filtros y
 * para sumar el gasto por cuenta.
 */
export const SQL_EMPRESAS = `
  SELECT e.id, e.razon_social AS nombre, e.tenant_id AS "cuentaId", c.nombre AS cuenta
    FROM empresa e
    JOIN tenant c ON c.id = e.tenant_id
   WHERE EXISTS (SELECT 1 FROM conversacion_turno t WHERE t.empresa_id = e.id AND t.uso IS NOT NULL)
      OR EXISTS (SELECT 1 FROM documento_leido d WHERE d.empresa_id = e.id)
      OR EXISTS (SELECT 1 FROM retencion_clasificacion_ia c WHERE c.empresa_id = e.id)
   ORDER BY e.razon_social`;

export interface EmpresaConConsumo {
  id: string;
  nombre: string;
  cuentaId: string;
  cuenta: string;
}

/** Los filtros del tablero. `cuentaId` lo usa solo la consola de plataforma. */
export interface FiltroConsumo {
  desde?: string;
  hasta?: string;
  empresaId?: string;
  cuentaId?: string;
}

export interface RespuestaTablero extends Tablero {
  empresas: EmpresaConConsumo[];
  empresaId: string | null;
  cuentaId: string | null;
  /** Si el período llegó al tope de filas: las cifras están cortas. */
  truncado: boolean;
}

/**
 * El consumo de la IA de **todas las empresas**, para el tablero privado
 * (`docs/planes/consumo-ia.md`).
 *
 * Lee por `DATA_SOURCE_PROVISION`, el rol `gestion_provision` con BYPASSRLS
 * que ya usa `plataforma`: la conexión de la aplicación está aislada por
 * empresa y no puede sumar entre ellas. **Solo lee, y solo cifras.**
 */
@Injectable()
export class ConsumoIaService {
  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
  ) {}

  async tablero(e: FiltroConsumo): Promise<RespuestaTablero> {
    const { desde, hasta } = rango(e.desde, e.hasta);
    const empresaId = uuidDe(e.empresaId);
    const cuentaId = uuidDe(e.cuentaId);
    const db = this.conexion();
    const filtros = [desde, hasta, empresaId, cuentaId];

    const [respuestas, lecturas, empresas] = await Promise.all([
      db.query<Record<string, unknown>[]>(SQL_RESPUESTAS, filtros),
      db.query<Record<string, unknown>[]>(SQL_LECTURAS, filtros),
      db.query<EmpresaConConsumo[]>(SQL_EMPRESAS),
    ]);

    return {
      ...armarTablero(
        respuestas.map(aRespuesta),
        lecturas.map(aLectura),
        desde,
        hasta,
      ),
      empresas,
      empresaId,
      cuentaId,
      truncado:
        respuestas.length >= TOPE_FILAS || lecturas.length >= TOPE_FILAS,
    };
  }

  /**
   * Cada llamada al modelo del período, con en qué se gastó: el submódulo
   * «Detalle» del tablero. `?categoria=AYUDA|CONSULTA|PROPUESTA|LECTURA`,
   * `?orden=FECHA|COSTO` y `?pagina=`.
   */
  async detalle(
    e: FiltroConsumo & {
      categoria?: string;
      orden?: string;
      pagina?: string;
    },
  ): Promise<Detalle & { truncado: boolean }> {
    const { desde, hasta } = rango(e.desde, e.hasta);
    const filtros = [desde, hasta, uuidDe(e.empresaId), uuidDe(e.cuentaId)];
    const categoria = e.categoria ?? null;
    if (categoria !== null && !(categoria in ETIQUETA_CATEGORIA)) {
      throw new BadRequestException(
        'La categoría es AYUDA, CONSULTA, PROPUESTA o LECTURA.',
      );
    }
    const pagina = Number(e.pagina ?? 1);
    if (!Number.isInteger(pagina) || pagina < 1) {
      throw new BadRequestException('La página es un número desde 1.');
    }
    const db = this.conexion();

    const [respuestas, lecturas] = await Promise.all([
      db.query<Record<string, unknown>[]>(SQL_DETALLE_RESPUESTAS, filtros),
      db.query<Record<string, unknown>[]>(SQL_DETALLE_LECTURAS, filtros),
    ]);

    return {
      ...armarDetalle(
        respuestas.map((f) => {
          const herramientas = Array.isArray(f.herramientas)
            ? f.herramientas.map(texto)
            : [];
          return {
            ...aRespuesta({ ...f, consultas: herramientas.length }),
            herramientas,
            propuestas: Number(f.propuestas ?? 0),
          };
        }),
        lecturas.map((f) => ({
          ...aLectura(f),
          id: texto(f.id),
          fecha: texto(f.fecha),
        })),
        desde,
        hasta,
        {
          categoria: categoria as Categoria | null,
          orden: e.orden === 'COSTO' ? 'COSTO' : 'FECHA',
          pagina,
          porPagina: POR_PAGINA,
        },
      ),
      truncado:
        respuestas.length >= TOPE_FILAS || lecturas.length >= TOPE_FILAS,
    };
  }

  private conexion(): DataSource {
    if (this.provision === null) {
      throw new ServiceUnavailableException(
        'El tablero de consumo necesita la conexión de aprovisionamiento (DB_PROVISION_USERNAME).',
      );
    }
    return this.provision;
  }
}

/** El rango pedido, o los últimos 30 días en hora de Colombia. */
export function rango(
  desde: string | undefined,
  hasta: string | undefined,
): { desde: string; hasta: string } {
  const h = hasta ?? hoyEnColombia();
  const d =
    desde ??
    new Date(Date.parse(`${h}T00:00:00Z`) - 29 * 86_400_000)
      .toISOString()
      .slice(0, 10);
  if (
    !ISO.test(d) ||
    !ISO.test(h) ||
    Number.isNaN(Date.parse(d)) ||
    Number.isNaN(Date.parse(h))
  ) {
    throw new BadRequestException('Las fechas van como aaaa-mm-dd.');
  }
  if (d > h)
    throw new BadRequestException('«Desde» tiene que ser antes que «hasta».');
  if ((Date.parse(h) - Date.parse(d)) / 86_400_000 > DIAS_MAXIMOS) {
    throw new BadRequestException(
      `El rango es de ${DIAS_MAXIMOS} días como mucho.`,
    );
  }
  return { desde: d, hasta: h };
}

/** El id del filtro, o null si no viene o no es un uuid. */
const uuidDe = (id: string | undefined): string | null =>
  id !== undefined && /^[0-9a-f-]{36}$/i.test(id) ? id : null;

/** Los tokens de un `uso` guardado, con ceros donde falte una clave. */
function tokensDe(uso: unknown): Tokens {
  const u = (uso ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  return {
    entrada: n(u.entrada),
    salida: n(u.salida),
    cacheLeido: n(u.cacheLeido),
    cacheEscrito: n(u.cacheEscrito),
  };
}

const numeroONulo = (v: unknown) =>
  v === null || v === undefined ? null : Number(v);

/** Un texto de la base: las columnas que se leen acá son texto, uuid o fecha. */
const texto = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : v instanceof Date
      ? v.toISOString()
      : typeof v === 'number'
        ? String(v)
        : '';

const textoONulo = (v: unknown): string | null =>
  v === null || v === undefined ? null : texto(v);

function aRespuesta(f: Record<string, unknown>): FilaRespuesta {
  return {
    id: texto(f.id),
    empresaId: texto(f.empresa_id),
    empresa: texto(f.empresa),
    dia: texto(f.dia),
    fecha: texto(f.fecha),
    estado: texto(f.estado),
    modelo: textoONulo(f.modelo),
    uso: tokensDe(f.uso),
    duracionMs: numeroONulo(f.duracion_ms),
    vueltas: numeroONulo(f.vueltas),
    consultas: Number(f.consultas ?? 0),
  };
}

function aLectura(f: Record<string, unknown>): FilaLectura {
  return {
    empresaId: texto(f.empresa_id),
    empresa: texto(f.empresa),
    dia: texto(f.dia),
    tipo: texto(f.tipo),
    estado: texto(f.estado),
    modelo: textoONulo(f.modelo),
    uso: f.uso === null ? null : tokensDe(f.uso),
    duracionMs: numeroONulo(f.duracion_ms),
  };
}
