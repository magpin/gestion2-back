/**
 * Cómo se filtra, se ordena y se lee cada cuenta en la consola.
 *
 * Puro a propósito: las cuentas se traen de una vez —son cientos, no
 * millones— y lo que decide qué es «cerca del cupo» o «sin actividad» se
 * prueba sin base.
 */

export type EstadoCuenta = 'ACTIVO' | 'SUSPENDIDO' | 'MOROSO' | 'CANCELADO';

export interface Cuenta {
  id: string;
  nombre: string;
  slug: string;
  plan: string;
  estado: EstadoCuenta;
  maxEmpresas: number;
  maxUsuarios: number;
  empresas: number;
  usuarios: number;
  creadoEn: string;
  /** El último acceso de cualquiera de sus usuarios. */
  ultimoAcceso: string | null;
  /** Desde cuándo está en su estado: el último cambio, o el alta. */
  estadoDesde: string;
  /** Lo que gastó en IA en lo que va del mes, en US$. */
  iaMesUsd: number;
}

export const FILTROS = [
  'TODAS',
  'ACTIVAS',
  'MOROSAS',
  'SUSPENDIDAS',
  'CERCA_CUPO',
  'SIN_ACTIVIDAD',
] as const;
export type Filtro = (typeof FILTROS)[number];

export const ORDENES = [
  'nombre',
  'plan',
  'estado',
  'empresas',
  'usuarios',
  'ia',
  'acceso',
  'alta',
] as const;
export type Orden = (typeof ORDENES)[number];

export const POR_PAGINA = 25;

/** Desde qué parte del cupo se avisa. */
export const UMBRAL_CUPO = 0.9;
/** Cuántos días sin entrar hacen una cuenta «sin actividad». */
export const DIAS_SIN_ACTIVIDAD = 30;

const DIA_MS = 86_400_000;

/**
 * Un cupo al 90 % o más. Un cupo de 1 no cuenta: una cuenta Básico con su
 * única empresa está en la forma de su plan, no a punto de quedarse corta.
 */
export function cupoCerca(usados: number, max: number): boolean {
  return max > 1 && usados >= Math.ceil(max * UMBRAL_CUPO);
}

export function cercaDelCupo(c: Cuenta): boolean {
  return (
    c.estado !== 'CANCELADO' &&
    (cupoCerca(c.empresas, c.maxEmpresas) ||
      cupoCerca(c.usuarios, c.maxUsuarios))
  );
}

/** Días enteros entre una fecha y ahora. */
export function diasDesde(fecha: string, ahora: Date): number {
  return Math.floor((ahora.getTime() - Date.parse(fecha)) / DIA_MS);
}

/**
 * Nadie entra hace 30 días. Una cuenta que nunca entró cuenta desde su alta:
 * la de ayer todavía no está abandonada.
 */
export function sinActividad(c: Cuenta, ahora: Date): boolean {
  return (
    c.estado !== 'CANCELADO' &&
    diasDesde(c.ultimoAcceso ?? c.creadoEn, ahora) >= DIAS_SIN_ACTIVIDAD
  );
}

export function cumple(c: Cuenta, filtro: Filtro, ahora: Date): boolean {
  switch (filtro) {
    case 'TODAS':
      return true;
    case 'ACTIVAS':
      return c.estado === 'ACTIVO';
    case 'MOROSAS':
      return c.estado === 'MOROSO';
    case 'SUSPENDIDAS':
      return c.estado === 'SUSPENDIDO';
    case 'CERCA_CUPO':
      return cercaDelCupo(c);
    case 'SIN_ACTIVIDAD':
      return sinActividad(c, ahora);
  }
}

const ORDEN_ESTADO: Record<EstadoCuenta, number> = {
  MOROSO: 0,
  SUSPENDIDO: 1,
  ACTIVO: 2,
  CANCELADO: 3,
};
const ORDEN_PLAN: Record<string, number> = {
  BASICO: 0,
  PROFESIONAL: 1,
  CONTADOR: 2,
  EMPRESARIAL: 3,
};

function clave(c: Cuenta, orden: Orden): number | string {
  switch (orden) {
    case 'nombre':
      return c.nombre.toLocaleLowerCase('es');
    case 'plan':
      return ORDEN_PLAN[c.plan] ?? 9;
    case 'estado':
      return ORDEN_ESTADO[c.estado];
    case 'empresas':
      return c.empresas;
    case 'usuarios':
      return c.usuarios;
    case 'ia':
      return c.iaMesUsd;
    case 'acceso':
      return c.ultimoAcceso ? Date.parse(c.ultimoAcceso) : 0;
    case 'alta':
      return Date.parse(c.creadoEn);
  }
}

export interface PaginaCuentas {
  filas: Cuenta[];
  total: number;
  pagina: number;
  porPagina: number;
  conteos: Record<Filtro, number>;
}

export interface Seleccion {
  filtro: Filtro;
  orden: Orden;
  dir: 'asc' | 'desc';
  ahora: Date;
}

/** Las cuentas del filtro, en su orden. Es lo que se exporta a Excel. */
export function seleccionar(cuentas: Cuenta[], o: Seleccion): Cuenta[] {
  const signo = o.dir === 'asc' ? 1 : -1;
  return cuentas
    .filter((c) => cumple(c, o.filtro, o.ahora))
    .sort((a, b) => {
      const x = clave(a, o.orden);
      const y = clave(b, o.orden);
      if (x < y) return -signo;
      if (x > y) return signo;
      return a.nombre.localeCompare(b.nombre, 'es');
    });
}

export function listarCuentas(
  cuentas: Cuenta[],
  o: Seleccion & { pagina: number },
): PaginaCuentas {
  const conteos = Object.fromEntries(
    FILTROS.map((f) => [
      f,
      cuentas.filter((c) => cumple(c, f, o.ahora)).length,
    ]),
  ) as Record<Filtro, number>;

  const filtradas = seleccionar(cuentas, o);

  const paginas = Math.max(1, Math.ceil(filtradas.length / POR_PAGINA));
  const pagina = Math.min(Math.max(1, o.pagina), paginas);
  return {
    filas: filtradas.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA),
    total: filtradas.length,
    pagina,
    porPagina: POR_PAGINA,
    conteos,
  };
}

/**
 * Lo que la cuenta ya usa por encima de los cupos de otro plan. Vacío si
 * cabe. Es lo que el diálogo de cambiar plan muestra antes de confirmar.
 */
export function excesoFrente(
  c: Pick<Cuenta, 'empresas' | 'usuarios'>,
  cupos: { maxEmpresas: number; maxUsuarios: number },
): { recurso: 'EMPRESAS' | 'USUARIOS'; usados: number; permitidos: number }[] {
  const exceso: {
    recurso: 'EMPRESAS' | 'USUARIOS';
    usados: number;
    permitidos: number;
  }[] = [];
  if (c.empresas > cupos.maxEmpresas) {
    exceso.push({
      recurso: 'EMPRESAS',
      usados: c.empresas,
      permitidos: cupos.maxEmpresas,
    });
  }
  if (c.usuarios > cupos.maxUsuarios) {
    exceso.push({
      recurso: 'USUARIOS',
      usados: c.usuarios,
      permitidos: cupos.maxUsuarios,
    });
  }
  return exceso;
}
