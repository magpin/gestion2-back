/**
 * Qué pasó con cada archivo de un lote, en palabras que sirvan para decidir.
 *
 * Tanda 3 del diseño de María (`docs/planes/maria.md` §11), sobre los
 * prototipos `Main.dc.html` y `Procesando.dc.html`. El prototipo separa
 * «asentadas solas» de «apartadas»; **acá no hay asentadas solas** —María no
 * registra nada sin una persona desde el 22 de septiembre de 2026—, así que la
 * separación es entre **listas para aprobar** y **apartadas**, y apartada
 * quiere decir «antes de aprobarla hay algo que decidir».
 *
 * Los motivos para apartar no los configura nadie: son lo que el código ya
 * comprobó al leer —las cuentas no dan, falta el proveedor, quedaron
 * preguntas— más el posible duplicado, que se busca contra las compras
 * registradas y contra el mismo lote.
 *
 * Sin base de datos: el servicio trae las filas, esto decide.
 */

export type EstadoArchivo =
  'EN_COLA' | 'MIRANDO' | 'DERIVADO' | 'NO_SE_LEE' | 'DETENIDO';

/** Lo que el servicio trae de cada archivo. */
export interface FilaArchivo {
  id: string;
  orden: number;
  nombre: string;
  estado: EstadoArchivo;
  clase: string | null;
  motivo: string | null;
  documento: {
    id: string;
    tipo: string;
    estado: 'EN_COLA' | 'LEYENDO' | 'LEIDO' | 'FALLO' | 'DESCARTADO';
    extraido: unknown;
    error: string | null;
    motivoDescarte: string | null;
    /** Ventas anteriores: cuántas de sus facturas ya se cargaron (fase 11). */
    cargadas?: number;
  } | null;
  /** La compra o la factura en que terminó, si alguien ya la registró. */
  registrado: { id: string; numero: string } | null;
  /** Una compra vigente del mismo proveedor con el mismo número. */
  duplicadoDe: {
    id: string;
    numero: string;
    fecha: string;
    total: number;
  } | null;
}

export type Situacion =
  | 'EN_COLA'
  | 'MIRANDO'
  | 'LEYENDO'
  | 'LISTA'
  | 'APARTADA'
  | 'REGISTRADA'
  | 'DESCARTADA'
  | 'CONFIGURACION'
  | 'NO_SE_LEE'
  | 'FALLO'
  | 'DETENIDO';

export type ClaveMotivo =
  'DUPLICADO' | 'REPETIDO_EN_LOTE' | 'SIN_TERCERO' | 'NO_CUADRA' | 'PREGUNTAS';

export interface ArchivoDelLote {
  id: string;
  orden: number;
  nombre: string;
  situacion: Situacion;
  tipo: string | null;
  /** «Papelería Central · FC-0231», o el nombre del archivo si no se leyó. */
  titulo: string;
  /** «Factura de compra», «Pedido de cliente», o lo que dijo al mirarlo. */
  descripcion: string;
  valor: number | null;
  /** Por qué quedó apartada, del más serio al más leve. Vacío si no lo está. */
  motivos: Array<{ clave: ClaveMotivo; texto: string }>;
  /** Una línea: por qué no se lee, el error, o por qué se descartó. */
  nota: string | null;
  documentoId: string | null;
  registrado: { id: string; numero: string } | null;
  duplicadoDe: FilaArchivo['duplicadoDe'];
}

export interface ResumenLote {
  total: number;
  /** Los que ya pasaron por María, bien o mal. */
  hechos: number;
  listas: number;
  apartadas: number;
  /** El que se está mirando o leyendo ahora, si hay uno. */
  actual: string | null;
}

const DESCRIPCION: Record<string, string> = {
  FACTURA_COMPRA: 'Factura de compra',
  PEDIDO_VENTA: 'Pedido de cliente',
  VENTA_HISTORICA: 'Ventas del sistema anterior',
  RUT: 'RUT',
  CAMARA_COMERCIO: 'Certificado de Cámara de Comercio',
  RESOLUCION_DIAN: 'Resolución de facturación',
};

/** «FE-0231», «fe 231» y «FE0231» son el mismo número de factura. */
export function numeroComparable(numero: string): string {
  return numero
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^([A-Z]*)0+(?=\d)/, '$1');
}

interface Leido {
  tercero: { id: string; nombre: string } | null;
  terceroLeido: { nombre: string; nit: string | null } | null;
  numero: string | null;
  prefijo: string | null;
  valor: number | null;
  comprobaciones: Array<{ que: string; cuadra: boolean }>;
  preguntas: number;
}

function leer(tipo: string, extraido: unknown): Leido {
  const e = (extraido ?? {}) as Record<string, unknown>;
  const esPedido = tipo === 'PEDIDO_VENTA';
  const raiz = (e[esPedido ? 'pedido' : 'factura'] ?? {}) as Record<
    string,
    unknown
  >;
  const leido = (raiz[esPedido ? 'cliente' : 'proveedor'] ??
    null) as Leido['terceroLeido'];
  const impreso = (raiz.impreso ?? {}) as { total?: number };
  const valor = esPedido
    ? typeof raiz.subtotalImpreso === 'number' && raiz.subtotalImpreso > 0
      ? raiz.subtotalImpreso
      : null
    : typeof impreso.total === 'number' && impreso.total > 0
      ? impreso.total
      : null;
  return {
    tercero: (e[esPedido ? 'cliente' : 'proveedor'] ??
      null) as Leido['tercero'],
    terceroLeido: leido,
    numero: typeof raiz.numero === 'string' ? raiz.numero : null,
    prefijo: typeof raiz.prefijo === 'string' ? raiz.prefijo : null,
    valor,
    comprobaciones: Array.isArray(e.comprobaciones)
      ? (e.comprobaciones as Leido['comprobaciones'])
      : [],
    preguntas: Array.isArray(e.preguntas) ? e.preguntas.length : 0,
  };
}

/** La llave con que se reconoce el mismo documento dentro del lote. */
function llave(tipo: string, l: Leido): string | null {
  if (l.numero === null) return null;
  const quien = l.tercero?.id ?? l.terceroLeido?.nit ?? l.terceroLeido?.nombre;
  if (quien == null) return null;
  return `${tipo}|${quien}|${numeroComparable(`${l.prefijo ?? ''}${l.numero}`)}`;
}

const plural = (n: number, uno: string, varios: string) =>
  `${n} ${n === 1 ? uno : varios}`;

/**
 * Cada archivo con su situación. Los archivos van en el orden en que se
 * soltaron; el primero de dos iguales dentro del lote es el que queda, y el
 * segundo se aparta como repetido.
 */
export function situacionDelLote(filas: FilaArchivo[]): ArchivoDelLote[] {
  const vistas = new Map<string, string>();
  return [...filas]
    .sort((a, b) => a.orden - b.orden)
    .map((f) => {
      const base = {
        id: f.id,
        orden: f.orden,
        nombre: f.nombre,
        tipo: f.documento?.tipo ?? null,
        titulo: f.nombre,
        descripcion:
          f.documento === null
            ? (f.clase ?? 'Documento')
            : (DESCRIPCION[f.documento.tipo] ?? f.clase ?? 'Documento'),
        valor: null as number | null,
        motivos: [] as ArchivoDelLote['motivos'],
        nota: null as string | null,
        documentoId: f.documento?.id ?? null,
        registrado: f.registrado,
        duplicadoDe: null as FilaArchivo['duplicadoDe'],
      };

      if (f.estado !== 'DERIVADO' || f.documento === null) {
        const situacion: Situacion =
          f.estado === 'DERIVADO' ? 'FALLO' : f.estado;
        return {
          ...base,
          situacion,
          nota:
            f.estado === 'NO_SE_LEE'
              ? f.motivo
              : f.estado === 'DETENIDO'
                ? 'No llegué a mirarlo: se detuvo el lote.'
                : null,
        };
      }

      const d = f.documento;
      if (d.estado === 'EN_COLA' || d.estado === 'LEYENDO') {
        return { ...base, situacion: 'LEYENDO' as const };
      }
      if (d.estado === 'FALLO') {
        return { ...base, situacion: 'FALLO' as const, nota: d.error };
      }
      if (d.tipo === 'VENTA_HISTORICA') {
        return { ...base, ...ventasAnteriores(d) };
      }
      if (d.tipo !== 'FACTURA_COMPRA' && d.tipo !== 'PEDIDO_VENTA') {
        return {
          ...base,
          situacion: 'CONFIGURACION' as const,
          nota: 'Sus datos van a la configuración de la empresa: confirmalos en su tarjeta.',
        };
      }

      const l = leer(d.tipo, d.extraido);
      const nombre = l.tercero?.nombre ?? l.terceroLeido?.nombre ?? f.nombre;
      const numero =
        l.numero === null
          ? null
          : [l.prefijo, l.numero].filter(Boolean).join('-');
      const conDatos = {
        ...base,
        titulo: numero === null ? nombre : `${nombre} · ${numero}`,
        valor: l.valor,
      };

      if (f.registrado !== null) {
        return { ...conDatos, situacion: 'REGISTRADA' as const };
      }
      if (d.estado === 'DESCARTADO') {
        return {
          ...conDatos,
          situacion: 'DESCARTADA' as const,
          nota: d.motivoDescarte,
        };
      }

      const motivos: ArchivoDelLote['motivos'] = [];
      const clave = llave(d.tipo, l);
      const repetidoDe = clave === null ? undefined : vistas.get(clave);
      if (clave !== null && repetidoDe === undefined)
        vistas.set(clave, f.nombre);

      if (f.duplicadoDe !== null) {
        motivos.push({
          clave: 'DUPLICADO',
          texto: `Posible duplicado: ya está registrada como ${f.duplicadoDe.numero}`,
        });
      } else if (repetidoDe !== undefined) {
        motivos.push({
          clave: 'REPETIDO_EN_LOTE',
          texto: `Es la misma que ${repetidoDe}, en este mismo lote`,
        });
      }
      if (l.tercero === null) {
        motivos.push({
          clave: 'SIN_TERCERO',
          texto:
            d.tipo === 'PEDIDO_VENTA'
              ? 'Cliente que no tengo registrado'
              : 'Proveedor que no tengo registrado',
        });
      }
      const noDan = l.comprobaciones.filter((c) => !c.cuadra);
      if (noDan.length > 0) {
        motivos.push({
          clave: 'NO_CUADRA',
          texto: `Las cuentas no dan: ${noDan[0].que.charAt(0).toLowerCase()}${noDan[0].que.slice(1)}`,
        });
      }
      if (l.preguntas > 0) {
        motivos.push({
          clave: 'PREGUNTAS',
          texto: `Me ${l.preguntas === 1 ? 'falta' : 'faltan'} ${plural(l.preguntas, 'dato', 'datos')}`,
        });
      }

      return {
        ...conDatos,
        situacion:
          motivos.length === 0 ? ('LISTA' as const) : ('APARTADA' as const),
        motivos,
        duplicadoDe: f.duplicadoDe,
      };
    });
}

export function resumenDelLote(archivos: ArchivoDelLote[]): ResumenLote {
  const enCurso = archivos.find(
    (a) => a.situacion === 'MIRANDO' || a.situacion === 'LEYENDO',
  );
  return {
    total: archivos.length,
    hechos: archivos.filter(
      (a) => !['EN_COLA', 'MIRANDO', 'LEYENDO'].includes(a.situacion),
    ).length,
    listas: archivos.filter((a) => a.situacion === 'LISTA').length,
    apartadas: archivos.filter((a) => a.situacion === 'APARTADA').length,
    actual: enCurso?.nombre ?? null,
  };
}

/**
 * Un archivo con ventas del sistema anterior: varias facturas en uno. Se da por
 * hecho cuando se cargó alguna; si no, se aparta si alguna tiene preguntas o no
 * cuadra. Si ya estaban en el sistema no se sabe acá: lo dice la pantalla de
 * Ventas, que lo mira al mostrarlas.
 */
function ventasAnteriores(
  d: NonNullable<FilaArchivo['documento']>,
): Pick<
  ArchivoDelLote,
  'situacion' | 'titulo' | 'valor' | 'motivos' | 'nota' | 'registrado'
> {
  const e = (d.extraido ?? {}) as {
    facturas?: Array<{
      factura: {
        numero: string;
        cliente: { nombre: string };
        impreso: { total: number };
      };
      comprobaciones: Array<{ cuadra: boolean }>;
      preguntas: unknown[];
    }>;
    preguntas?: unknown[];
  };
  const facturas = e.facturas ?? [];
  const n = facturas.length;
  const titulo =
    n === 1
      ? `${facturas[0].factura.cliente.nombre} · ${facturas[0].factura.numero}`
      : plural(n, 'factura de venta', 'facturas de venta');
  const total = facturas.reduce(
    (s, f) => s + (f.factura.impreso.total || 0),
    0,
  );
  const conDatos = {
    titulo,
    valor: total > 0 ? total : null,
    motivos: [] as ArchivoDelLote['motivos'],
    nota: null as string | null,
    registrado: null as ArchivoDelLote['registrado'],
  };

  const cargadas = d.cargadas ?? 0;
  if (cargadas > 0) {
    return {
      ...conDatos,
      situacion: 'REGISTRADA',
      registrado: { id: d.id, numero: `${cargadas} de ${n}` },
    };
  }
  if (d.estado === 'DESCARTADO') {
    return { ...conDatos, situacion: 'DESCARTADA', nota: d.motivoDescarte };
  }

  const motivos: ArchivoDelLote['motivos'] = [];
  const noCuadran = facturas.filter((f) =>
    f.comprobaciones.some((c) => !c.cuadra),
  ).length;
  if (noCuadran > 0) {
    motivos.push({
      clave: 'NO_CUADRA',
      texto: `Las cuentas no dan en ${plural(noCuadran, 'factura', 'facturas')}`,
    });
  }
  const conPreguntas = facturas.filter((f) => f.preguntas.length > 0).length;
  if (conPreguntas > 0 || (e.preguntas ?? []).length > 0) {
    motivos.push({
      clave: 'PREGUNTAS',
      texto:
        conPreguntas > 0
          ? `Me faltan datos en ${plural(conPreguntas, 'factura', 'facturas')}`
          : 'No pude buscar los clientes ni los productos',
    });
  }
  return {
    ...conDatos,
    situacion: motivos.length === 0 ? 'LISTA' : 'APARTADA',
    motivos,
  };
}

/** Lo que dice el lote de un archivo que no es algo que María lea. */
export function motivoNoSeLee(
  analisis: { tipo: string | null; clase: string },
  permitido: boolean,
): string | null {
  if (analisis.tipo === null) {
    return `${analisis.clase}: no es algo que yo lea. Lo que sí leo: facturas de proveedores, pedidos de clientes, el RUT, la Cámara de Comercio y la resolución de la DIAN.`;
  }
  if (!permitido) {
    return analisis.tipo === 'FACTURA_COMPRA'
      ? 'Es una factura de compra, y registrar compras no le corresponde: entréguela a quien las registra.'
      : analisis.tipo === 'PEDIDO_VENTA'
        ? 'Es un pedido de cliente, y facturar no le corresponde: entrégueselo a quien factura.'
        : analisis.tipo === 'VENTA_HISTORICA'
          ? 'Son ventas del sistema anterior, y cargarlas no le corresponde: entrégueselas al contador.'
          : 'Es un documento de la configuración de la empresa, y configurarla no le corresponde.';
  }
  return null;
}
