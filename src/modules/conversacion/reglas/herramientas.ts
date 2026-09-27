import type { RolCodigo } from '../../../common/ctx';
import type { Existencia } from '../../inventario/inventario.api';
import type { SaldoDeMedio } from '../../tesoreria/tesoreria.api';
import type { Resultado } from '../../reportes/servicios/armador.service';
import type { Hallazgo } from '../../revision/revision.api';
import {
  ORIGENES,
  origenesPara,
  type ClaveOrigen,
  type Origen,
} from '../../reportes/reglas/catalogo';

/**
 * Las herramientas con las que el asistente consulta los datos de la empresa
 * (paso 6 de `docs/planes/asistente-conversacion.md`). Puro: sin red y sin
 * base.
 *
 * **No hay una puerta nueva.** Cada herramienta es un origen del armador de
 * reportes (`reportes/reglas/catalogo.ts`) y corre por `ArmadorService.correr`,
 * igual que la pantalla de Reportes:
 *
 * - **El modelo solo ve los orígenes que el rol de quien pregunta puede
 *   correr** (`origenesPara`). Si igual pidiera otro, el servicio lo rechaza:
 *   `correr` vuelve a mirar los roles.
 * - **El modelo no escribe SQL.** Manda claves de columnas, como la pantalla, y
 *   la definición pasa por `validar` del armador antes de tocar la base.
 */

/** Las filas que ve el modelo por consulta. Para más, que agrupe o pida el total. */
export const FILAS_PARA_MODELO = 50;

/** Las consultas por turno. Si no le alcanza, lo dice en vez de seguir gastando. */
export const CONSULTAS_POR_TURNO = 4;

/** Los valores parecidos que devuelve `buscar_valores`. */
const COINCIDENCIAS = 20;

/** Desde cuándo, si el modelo no dice: la cartera y los saldos son de siempre. */
export const DESDE_SIEMPRE = '2000-01-01';

const PREFIJO = 'consultar_';

/**
 * Las dos consultas que el armador no tiene: la plata de hoy en cada caja y
 * banco, y lo que queda de un producto. Son fotos del día, no movimientos en un
 * rango, y por eso no son orígenes del armador.
 *
 * **Sus roles son los de las pantallas que muestran lo mismo**, copiados de los
 * controladores: `GET /cuentas-bancarias` y `GET /cajas` para los saldos,
 * `GET /productos` para las existencias. Si cambian allá, cambian acá: una
 * prueba lo recuerda.
 */
export const ROLES_SALDOS: readonly RolCodigo[] = [
  'DIRECTOR',
  'CONTADOR',
  'CAJA',
  'CONSULTA',
  'VENTAS',
];
export const ROLES_EXISTENCIAS: readonly RolCodigo[] = [
  'DIRECTOR',
  'CONTADOR',
  'INVENTARIO',
  'VENTAS',
  'COMPRAS',
  'CONSULTA',
];

/**
 * Los de `GET /revision`, que son los de los asientos: lo que se revisa sale
 * de los libros, y quien no los ve no tiene por qué ver sus diferencias.
 */
export const ROLES_REVISION: readonly RolCodigo[] = [
  'DIRECTOR',
  'CONTADOR',
  'CONSULTA',
];

/**
 * Los de `GET /compras`: quien ve las compras ve lo que se les retuvo, y por
 * qué (plan motor de retenciones, Fase 1).
 */
export const ROLES_RETENCIONES: readonly RolCodigo[] = [
  'DIRECTOR',
  'CONTADOR',
  'COMPRAS',
  'CONSULTA',
];

export const SALDOS = 'consultar_saldos';
export const RETENCIONES = 'consultar_retenciones';
export const REVISAR = 'revisar_errores';
export const EXISTENCIAS = 'consultar_existencias';
export const BUSCAR = 'buscar_valores';

const puede = (roles: readonly RolCodigo[], permitidos: readonly RolCodigo[]) =>
  roles.some((r) => permitidos.includes(r));

/** Lo que el SDK espera de una herramienta. Sin importar el SDK acá: es un objeto. */
export interface Herramienta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const enumDe = (claves: readonly string[]) => ({
  type: 'string',
  enum: [...claves],
});

function describirOrigen(o: Origen): string {
  const columnas = o.columnas
    .map((c) => {
      const extras = [
        c.tipo.toLowerCase(),
        c.filtro === 'LISTA'
          ? c.valores
            ? `filtra por lista: ${c.valores.join(', ')}`
            : 'filtra por lista (valores exactos: usá buscar_valores)'
          : c.filtro === 'RANGO'
            ? 'filtra por mínimo/máximo'
            : c.filtro === 'SI_NO'
              ? 'filtra por sí/no'
              : null,
        c.agrupable ? 'agrupa' : null,
      ].filter((e) => e !== null);
      return `- ${c.clave}: ${c.etiqueta} (${extras.join('; ')})`;
    })
    .join('\n');
  return `${o.pregunta}. Consulta el reporte de ${o.etiqueta.toLowerCase()} de la empresa, con los permisos de quien pregunta.

Las fechas filtran por ${o.fecha.split('.').pop()}. Sin fechas, va desde siempre hasta hoy.
Devuelve hasta ${FILAS_PARA_MODELO} filas y el total de todas: para sumar, agrupá o usá el total, no sumes filas a mano.

Columnas:
${columnas}`;
}

/**
 * Las herramientas de quien pregunta: una por origen del armador que su rol
 * puede correr, la de buscar valores si hay alguno, y saldos y existencias si
 * su rol ve esas pantallas. Un rol que no ve nada no recibe nada.
 */
export function herramientasPara(roles: readonly RolCodigo[]): Herramienta[] {
  const extras: Herramienta[] = [
    ...(puede(roles, ROLES_SALDOS)
      ? [
          {
            name: SALDOS,
            description:
              'Cuánta plata hay hoy en cada cuenta bancaria y cada caja activa, con la fecha de su último movimiento. Es el saldo del día, no un rango de fechas.',
            input_schema: { type: 'object', properties: {} },
          },
        ]
      : []),
    ...(puede(roles, ROLES_EXISTENCIAS)
      ? [
          {
            name: EXISTENCIAS,
            description:
              'Cuántas unidades quedan hoy de los productos activos que coinciden con la búsqueda (código, código de barras o parte del nombre, sin tildes), con su costo promedio y su valor. Devuelve hasta 20.',
            input_schema: {
              type: 'object',
              properties: {
                busqueda: {
                  type: 'string',
                  description: 'Código o parte del nombre del producto.',
                },
              },
              required: ['busqueda'],
            },
          },
        ]
      : []),
    ...(puede(roles, ROLES_RETENCIONES)
      ? [
          {
            name: RETENCIONES,
            description:
              'Las retenciones que el sistema calculó en las compras —en la fuente (renta) y de IVA (ReteIVA)—, con su explicación completa: concepto y de dónde salió (confirmado por una persona, producto, CIIU o palabras), base, cuantía mínima en UVT, tarifa, norma que la sostiene, y por qué el proveedor es sujeto (guardas). Sirve para «¿por qué le retuviste esto a X?» y para «¿cuánto retuve este mes?» (sumá los valores por concepto). Una fila en negativo es la reversa de una nota crédito. Devuelve hasta 30, las más recientes.',
            input_schema: {
              type: 'object',
              properties: {
                proveedor: {
                  type: 'string',
                  description: 'Parte del nombre del proveedor.',
                },
                numero: {
                  type: 'string',
                  description: 'Parte del número de la factura del proveedor.',
                },
                desde: { type: 'string', description: 'AAAA-MM-DD.' },
                hasta: { type: 'string', description: 'AAAA-MM-DD.' },
              },
            },
          },
        ]
      : []),
    ...(puede(roles, ROLES_REVISION)
      ? [
          {
            name: REVISAR,
            description:
              'Revisa los libros y devuelve lo que no cuadra, lo que está dos veces, lo que falta y lo que parece mal clasificado: asientos y cierres descuadrados, el kardex, las cajas y los bancos contra su cuenta, documentos anulados que dejaron el kardex mal, facturas, cobros, pagos y terceros repetidos, compras sin retención, meses sin cerrar, lecturas sin registrar, productos que no se pueden facturar y gastos en cuentas raras. Cada hallazgo trae su certeza: AFIRMADO es un hecho comprobado; VISTA y DEDUCIDA piden criterio. No corrige nada.',
            input_schema: { type: 'object', properties: {} },
          },
        ]
      : []),
  ];
  const origenes = origenesPara(roles);
  if (origenes.length === 0) return extras;

  const porOrigen = origenes.map((o): Herramienta => {
    const claves = o.columnas.map((c) => c.clave);
    const filtrables = o.columnas.filter((c) => c.filtro).map((c) => c.clave);
    const agrupables = o.columnas
      .filter((c) => c.agrupable)
      .map((c) => c.clave);
    return {
      name: `${PREFIJO}${o.clave.toLowerCase()}`,
      description: describirOrigen(o),
      input_schema: {
        type: 'object',
        properties: {
          columnas: { type: 'array', items: enumDe(claves), minItems: 1 },
          desde: { type: 'string', description: 'aaaa-mm-dd. Opcional.' },
          hasta: { type: 'string', description: 'aaaa-mm-dd. Opcional: hoy.' },
          filtros: {
            type: 'array',
            description: 'Se cumplen todos a la vez.',
            items: {
              type: 'object',
              properties: {
                columna: enumDe(filtrables),
                valores: { type: 'array', items: { type: 'string' } },
                minimo: { type: 'number' },
                maximo: { type: 'number' },
                valor: { type: 'boolean' },
              },
              required: ['columna'],
            },
          },
          agrupar: { type: 'array', items: enumDe(agrupables), maxItems: 2 },
          orden: {
            type: 'object',
            properties: {
              columna: enumDe(claves),
              direccion: { type: 'string', enum: ['ASC', 'DESC'] },
            },
            required: ['columna'],
          },
        },
        required: ['columnas'],
      },
    };
  });

  const listas = origenes.flatMap((o) =>
    o.columnas
      .filter((c) => c.filtro === 'LISTA' && c.catalogo !== undefined)
      .map((c) => `${o.clave}.${c.clave}`),
  );
  const buscar: Herramienta = {
    name: BUSCAR,
    description: `Los valores exactos de una columna de lista, como están escritos en los datos de la empresa. Usala antes de filtrar por un cliente, un proveedor, una cuenta o una categoría: el filtro compara el texto exacto, y «Papelería Central» puede estar escrito «PAPELERIA CENTRAL S.A.S.». Busca sin tildes ni mayúsculas y devuelve hasta ${COINCIDENCIAS}.`,
    input_schema: {
      type: 'object',
      properties: {
        columna: enumDe(listas),
        contiene: {
          type: 'string',
          description: 'Parte del nombre. Vacío trae los primeros.',
        },
      },
      required: ['columna'],
    },
  };

  return [...porOrigen, buscar, ...extras];
}

/**
 * Lo que la pantalla dice mientras se consulta, y lo que queda debajo de la
 * respuesta como fuente. Con palabras de la aplicación, no con el nombre de la
 * herramienta.
 */
export function etiquetaDeConsulta(nombre: string): string {
  const origen = origenDeHerramienta(nombre);
  if (origen !== undefined) return ORIGENES[origen].etiqueta;
  if (nombre === SALDOS) return 'Saldos de caja y bancos';
  if (nombre === EXISTENCIAS) return 'Existencias';
  if (nombre === REVISAR) return 'Revisión de los libros';
  if (nombre === RETENCIONES) return 'Retenciones';
  if (nombre === BUSCAR) return 'Búsqueda';
  // Las de proponer (paso 7) no son consultas: la burbuja dice que verifica.
  if (nombre === 'proponer_cobro') return 'Verificando el cobro';
  if (nombre === 'proponer_pago') return 'Verificando el pago';
  return 'Consulta';
}

/**
 * Las retenciones como las lee el modelo: la frase de la explicación, la
 * norma, las guardas y la base contra el mínimo. Lo necesario para contestar
 * como la especificación §12.2, sin ids.
 */
export function retencionesParaModelo(
  filas: readonly Record<string, unknown>[],
): string {
  if (filas.length === 0) {
    return JSON.stringify({
      aviso:
        'No hay retenciones calculadas con esos filtros. Las compras anteriores al motor de retenciones no tienen explicación guardada.',
    });
  }
  return JSON.stringify(
    filas.map((f) => {
      const e = (f.explicacion ?? {}) as Record<string, unknown>;
      return {
        fecha: f.fecha,
        documento: f.documento,
        tipoDocumento: f.documento_tipo,
        proveedor: f.proveedor,
        concepto: f.concepto,
        base: Number(f.base),
        tarifa: `${(Number(f.tarifa_efectiva) * 100).toLocaleString('es-CO', { maximumFractionDigits: 3 })} %`,
        valor: Number(f.valor),
        norma: f.norma_aplicada,
        deDondeSalioElConcepto: f.origen_clasificacion,
        explicacion: e.texto ?? null,
        guardas: e.guardas ?? null,
        cuantiaMinima: e.cuantia_minima ?? null,
        acumuladoHonorarios: e.acumulado ?? null,
        zomac: e.zomac ?? null,
      };
    }),
  );
}

/** Los saldos, como los lee el modelo. */
export function saldosParaModelo(saldos: readonly SaldoDeMedio[]): string {
  return JSON.stringify(
    saldos.length === 0
      ? { aviso: 'La empresa no tiene cajas ni cuentas bancarias activas.' }
      : saldos,
  );
}

/**
 * Lo que encontró la revisión, como lo lee el modelo: sin ids —no le sirven
 * para nada y no tiene que repetirlos—, con el título, el detalle y las cifras.
 */
export function revisionParaModelo(
  hallazgos: readonly Hallazgo[],
  roles: readonly RolCodigo[] = [],
): string {
  return JSON.stringify({
    // Quién pregunta, como dato: sin esto el modelo le decía al contador que
    // «lo revise con su contador». Es quien lleva los libros, o su director.
    rolesDeQuienPregunta: roles,
    ...(hallazgos.length === 0
      ? {
          aviso:
            'La revisión no encontró nada: los asientos cuadran, el kardex, las cajas y los bancos coinciden con sus cuentas, y no hay facturas, cobros, pagos ni terceros repetidos.',
        }
      : {
          hallazgos: hallazgos.map((h) => ({
            grupo: h.grupo,
            // Cómo tiene que decirlo: AFIRMADO es un hecho; VISTA y DEDUCIDA
            // son criterio, y se dicen con «me parece».
            certeza: h.certeza,
            titulo: h.titulo,
            detalle: h.detalle,
          })),
        }),
  });
}

/** Las existencias, como las lee el modelo. */
export function existenciasParaModelo(
  existencias: readonly Existencia[],
): string {
  return JSON.stringify(
    existencias.length === 0
      ? { aviso: 'Ningún producto activo coincide con esa búsqueda.' }
      : existencias,
  );
}

/** De qué origen es una herramienta, o `undefined` si no es de consultar. */
export function origenDeHerramienta(nombre: string): ClaveOrigen | undefined {
  if (!nombre.startsWith(PREFIJO)) return undefined;
  const clave = nombre.slice(PREFIJO.length).toUpperCase();
  return clave in ORIGENES ? (clave as ClaveOrigen) : undefined;
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lo que pidió el modelo, como la definición que manda la pantalla del
 * armador. **No valida**: eso lo hace `validar` del armador, el mismo de
 * siempre. Acá solo se completa lo que el modelo no tiene por qué saber: la
 * forma de cada filtro sale del catálogo, y sin fechas va desde siempre.
 */
export function definicionDesde(
  origen: ClaveOrigen,
  entrada: unknown,
  hoy: string,
): Record<string, unknown> {
  const e = esObjeto(entrada) ? entrada : {};
  const forma = (clave: unknown) =>
    ORIGENES[origen].columnas.find((c) => c.clave === clave)?.filtro;
  const filtros = Array.isArray(e.filtros)
    ? e.filtros.filter(esObjeto).map((f) => ({ ...f, forma: forma(f.columna) }))
    : [];
  return {
    origen,
    columnas: Array.isArray(e.columnas) ? e.columnas : [],
    fechas: {
      desde: typeof e.desde === 'string' ? e.desde : DESDE_SIEMPRE,
      hasta: typeof e.hasta === 'string' ? e.hasta : hoy,
    },
    filtros,
    agrupar: Array.isArray(e.agrupar) ? e.agrupar : [],
    orden: esObjeto(e.orden) ? e.orden : null,
  };
}

/**
 * El resultado, como lo lee el modelo: etiquetas en vez de claves, las filas
 * que entran y el total de todas. Cifras en texto, como las devuelve la base:
 * convertirlas a número perdería centavos.
 */
export function resultadoParaModelo(r: Resultado): string {
  const filas = r.filas.slice(0, FILAS_PARA_MODELO);
  const total =
    r.total === null
      ? null
      : Object.fromEntries(
          Object.entries(r.total.sumas).map(([i, v]) => [
            r.columnas[Number(i)].etiqueta,
            v,
          ]),
        );
  return JSON.stringify({
    rango: `${r.rango.desde} a ${r.rango.hasta}`,
    columnas: r.columnas.map((c) => c.etiqueta),
    filas,
    totalFilas: r.totalFilas,
    ...(r.totalFilas > filas.length
      ? {
          aviso: `Se muestran ${filas.length} de ${r.totalFilas} filas; el total es de todas.`,
        }
      : {}),
    total,
    subtotales: r.subtotales.slice(0, FILAS_PARA_MODELO).map((s) => ({
      grupo: s.grupo,
      filas: s.filas,
      sumas: Object.fromEntries(
        Object.entries(s.sumas).map(([i, v]) => [
          r.columnas[Number(i)].etiqueta,
          v,
        ]),
      ),
    })),
  });
}

/** Sin tildes ni mayúsculas, para buscar «papeleria» y encontrar «PAPELERÍA». */
export const normalizar = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Los valores que contienen el texto buscado, hasta el tope. */
export function coincidencias(
  valores: readonly string[],
  contiene: string,
): string[] {
  const buscado = normalizar(contiene);
  return valores
    .filter((v) => buscado === '' || normalizar(v).includes(buscado))
    .slice(0, COINCIDENCIAS);
}
