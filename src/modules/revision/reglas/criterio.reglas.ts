/**
 * Los errores que **piden criterio**. Fase 9 de
 * `docs/planes/maria-facturas-y-errores.md`.
 *
 * La diferencia con `revision.reglas.ts` está en lo que se dice. Allá se
 * compara y se afirma: «esto no cuadra». Acá el hecho puede estar claro —julio
 * sigue abierto— o ser una deducción —esta compra se parece mucho a otra—, pero
 * **si es un error lo decide una persona**. María dice «me parece», y nunca
 * «está mal».
 *
 * Cada hallazgo lleva su nivel de certeza (`VISTA` o `DEDUCIDA`), y el texto
 * lo dice con palabras: la pantalla y el modelo leen lo mismo.
 *
 * Sin red y sin base de datos: el servicio trae las filas, esto decide.
 */

import {
  fecha,
  hallazgo,
  numeroComparable,
  pesos,
  type FilaTercero,
  type Hallazgo,
} from './revision.reglas';

/** Cuántos se nombran en un detalle antes de decir «y N más». */
const NOMBRADOS = 8;

function enumerar(cosas: string[]): string {
  const vistas = cosas.slice(0, NOMBRADOS).join('; ');
  return cosas.length > NOMBRADOS
    ? `${vistas}; y ${cosas.length - NOMBRADOS} más`
    : vistas;
}

const plural = (n: number, uno: string, varios: string) =>
  n === 1 ? uno : varios;

// ── 1. Compras sin retención ─────────────────────────────────────────────────

export interface FilaCompraSinRetencion {
  compraId: string;
  numero: string;
  proveedor: string;
  fecha: string;
  subtotal: number;
}

/**
 * Compras sin retención en la fuente de una empresa que es agente retenedor.
 *
 * **Criterio y no certeza**, porque no a todo proveedor se le retiene: un
 * autorretenedor, un gran contribuyente en ciertos conceptos, uno del régimen
 * simple. Lo que sí se ve es el hecho, y hay dos formas de verlo:
 *
 * - **No hay conceptos de renta configurados** para el año: entonces ninguna
 *   compra pudo llevar retención, y eso se dice una sola vez, con todas.
 * - Los hay, y la compra supera la base mínima más baja: se deduce que
 *   correspondía, y se pregunta por qué no.
 */
export function comprasSinRetencion(
  sinConceptos: {
    anio: number;
    desde: string;
    compras: FilaCompraSinRetencion[];
  }[],
  sobreLaBase: FilaCompraSinRetencion[],
): Hallazgo[] {
  const porFaltaDeConceptos = sinConceptos
    .filter((g) => g.compras.length > 0)
    .map((g) =>
      hallazgo({
        tipo: 'COMPRA_SIN_RETENCION',
        certeza: 'VISTA',
        titulo: `La empresa es agente retenedor de renta y no tiene conceptos de retención para ${g.anio}`,
        detalle: `Figura como agente retenedor desde el ${fecha(g.desde)}, pero no hay ningún concepto de retención en la fuente de renta configurado para ${g.anio}, así que ${plural(g.compras.length, 'la compra desde esa fecha salió', `las ${g.compras.length} compras desde esa fecha salieron`)} sin retención: ${enumerar(g.compras.map((c) => `${c.numero} de ${c.proveedor}`))}. Me parece que falta configurarlos; si a esos proveedores no se les retiene, está bien así.`,
        referencias: g.compras.map((c) => ({
          tipo: 'COMPRA' as const,
          id: c.compraId,
          etiqueta: c.numero,
        })),
      }),
    );

  const porCompra = sobreLaBase.map((c) =>
    hallazgo({
      tipo: 'COMPRA_SIN_RETENCION',
      certeza: 'DEDUCIDA',
      titulo: `La compra ${c.numero} de ${c.proveedor} no tiene retención`,
      detalle: `Es del ${fecha(c.fecha)}, por ${pesos(c.subtotal)} antes de IVA, que supera la base mínima de retención, y la empresa ya era agente retenedor. Me parece que correspondía retener, salvo que el proveedor sea autorretenedor o no se le retenga por otra razón.`,
      referencias: [{ tipo: 'COMPRA', id: c.compraId, etiqueta: c.numero }],
    }),
  );

  return [...porFaltaDeConceptos, ...porCompra];
}

// ── 2. Períodos sin cerrar ───────────────────────────────────────────────────

export interface FilaPeriodoAbierto {
  periodoId: string;
  anio: number;
  mes: number;
  /** Días desde que terminó el mes, contados hasta hoy. */
  diasDesdeElFin: number;
}

/** Cuántos días se le dan a un mes para cerrarse: el cierre del mes siguiente. */
export const DIAS_PARA_CERRAR = 30;

const MESES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/**
 * Un mes que terminó hace más de un mes y sigue abierto. **Deducido**: cuándo
 * se cierra un mes es costumbre de cada contador, y uno abierto no es un error
 * en sí; lo que pasa es que sigue recibiendo asientos con fecha vieja.
 */
export function periodosSinCerrar(filas: FilaPeriodoAbierto[]): Hallazgo[] {
  const viejos = filas
    .filter((f) => f.diasDesdeElFin > DIAS_PARA_CERRAR)
    .sort((a, b) => a.anio - b.anio || a.mes - b.mes);
  if (viejos.length === 0) return [];

  const nombre = (f: FilaPeriodoAbierto) => `${MESES[f.mes - 1]} de ${f.anio}`;
  const primero = viejos[0];
  return [
    hallazgo({
      tipo: 'PERIODO_SIN_CERRAR',
      certeza: 'DEDUCIDA',
      titulo:
        viejos.length === 1
          ? `${capital(nombre(primero))} sigue abierto`
          : `${viejos.length} meses siguen abiertos, desde ${nombre(primero)}`,
      detalle: `${capital(enumerar(viejos.map((f) => `${nombre(f)} terminó hace ${f.diasDesdeElFin} días`)))}. Me parece que ${plural(viejos.length, 'ya debería estar cerrado', 'ya deberían estar cerrados')}: mientras ${plural(viejos.length, 'siga abierto', 'sigan abiertos')}, se ${plural(viejos.length, 'le', 'les')} pueden seguir registrando asientos con fecha vieja y los estados financieros de esos meses pueden cambiar.`,
      referencias: viejos.map((f) => ({
        tipo: 'PERIODO' as const,
        id: f.periodoId,
        etiqueta: `${String(f.mes).padStart(2, '0')}/${f.anio}`,
      })),
    }),
  ];
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── 3. Lecturas sin registrar ────────────────────────────────────────────────

export interface FilaLectura {
  id: string;
  tipo: 'FACTURA_COMPRA' | 'PEDIDO_VENTA';
  /** Del documento: el proveedor o el cliente. */
  tercero: string;
  nit: string | null;
  numero: string | null;
  fechaDocumento: string | null;
  /** El total impreso de la factura, o el subtotal del pedido. */
  total: number;
  /** En qué terminó, si terminó en algo: el número de la compra o la factura. */
  registradaComo: string | null;
  diasDesdeLaLectura: number;
}

/** Cuántos días se le dan a una lectura antes de preguntar por ella. */
export const DIAS_PARA_REGISTRAR = 3;

/**
 * Lo que María leyó y nadie registró. Dos casos, y el primero es el que más
 * aparece en la práctica:
 *
 * - **Una lectura de un documento que ya se registró por otra lectura** —se
 *   subió dos veces la misma factura—: esa sobra. Se reconoce por el mismo
 *   tercero, número, fecha y total.
 * - Una lectura que lleva más de unos días sin registrarse: o falta hacerlo,
 *   o sobra.
 *
 * **Visto**: el hecho es claro, pero si falta o sobra lo sabe quien la subió.
 */
export function lecturasSinRegistrar(filas: FilaLectura[]): Hallazgo[] {
  const llave = (f: FilaLectura) =>
    [
      f.tipo,
      f.nit ?? f.tercero,
      numeroComparable(f.numero ?? ''),
      f.fechaDocumento ?? '',
      Math.round(f.total),
    ].join('|');

  const grupos = new Map<string, FilaLectura[]>();
  for (const f of filas)
    grupos.set(llave(f), [...(grupos.get(llave(f)) ?? []), f]);

  const hallazgos: Hallazgo[] = [];
  for (const grupo of grupos.values()) {
    const registrada = grupo.find((f) => f.registradaComo !== null);
    const pendientes = grupo.filter((f) => f.registradaComo === null);
    if (pendientes.length === 0) continue;
    const muestra = pendientes[0];
    const que = muestra.tipo === 'FACTURA_COMPRA' ? 'la factura' : 'el pedido';
    const de = `${que}${muestra.numero === null ? '' : ` ${muestra.numero}`} de ${muestra.tercero}`;

    if (registrada !== undefined) {
      hallazgos.push(
        hallazgo({
          tipo: 'LECTURA_SIN_REGISTRAR',
          certeza: 'VISTA',
          titulo: `${capital(de)} se leyó ${pendientes.length + 1} veces`,
          detalle: `Una de las lecturas ya ${muestra.tipo === 'FACTURA_COMPRA' ? 'se registró' : 'se facturó'} como ${registrada.registradaComo}; ${plural(pendientes.length, 'la otra quedó', `las otras ${pendientes.length} quedaron`)} sin registrar. Me parece que ${plural(pendientes.length, 'sobra', 'sobran')}: es el mismo documento, con el mismo número, fecha y total.`,
          referencias: pendientes.map((f) => ({
            tipo: 'LECTURA' as const,
            id: f.id,
            etiqueta: de,
          })),
        }),
      );
      continue;
    }

    const viejas = pendientes.filter(
      (f) => f.diasDesdeLaLectura > DIAS_PARA_REGISTRAR,
    );
    if (viejas.length === 0) continue;
    const dias = Math.max(...viejas.map((f) => f.diasDesdeLaLectura));
    hallazgos.push(
      hallazgo({
        tipo: 'LECTURA_SIN_REGISTRAR',
        certeza: 'VISTA',
        titulo: `${capital(de)} está leído hace ${dias} días y sin ${muestra.tipo === 'FACTURA_COMPRA' ? 'registrar' : 'facturar'}`,
        detalle: `${plural(viejas.length, 'Se leyó', `Se leyó ${viejas.length} veces`)} por ${pesos(muestra.total)} y ninguna lectura terminó en ${muestra.tipo === 'FACTURA_COMPRA' ? 'una compra' : 'una factura'}. Me parece que falta ${muestra.tipo === 'FACTURA_COMPRA' ? 'registrarla' : 'facturarlo'}, o que ya se hizo a mano y la lectura sobra.`,
        referencias: viejas.map((f) => ({
          tipo: 'LECTURA' as const,
          id: f.id,
          etiqueta: de,
        })),
      }),
    );
  }
  return hallazgos;
}

// ── 4. Productos que no se pueden vender ─────────────────────────────────────

export interface FilaProductoIncompleto {
  id: string;
  codigo: string;
  nombre: string;
  existencias: number;
  sinPrecio: boolean;
  sinCuentas: boolean;
}

/**
 * Productos activos, **con existencias**, que no se pueden facturar: sin
 * precio de venta, o sin la cuenta de ingreso o de costo que la venta necesita
 * para asentar. Visto. Si es a propósito —algo que no se vende— lo sabe quien
 * lleva el catálogo; lo que se ve es que hoy la factura los rechazaría.
 */
export function productosSinDatosDeVenta(
  filas: FilaProductoIncompleto[],
): Hallazgo[] {
  const conExistencias = filas.filter(
    (f) => f.existencias > 0 && (f.sinPrecio || f.sinCuentas),
  );
  if (conExistencias.length === 0) return [];

  const sinPrecio = conExistencias.filter((f) => f.sinPrecio).length;
  const sinCuentas = conExistencias.filter((f) => f.sinCuentas).length;
  const faltas = [
    ...(sinPrecio > 0 ? [`${sinPrecio} sin precio de venta`] : []),
    ...(sinCuentas > 0
      ? [`${sinCuentas} sin cuenta de ingreso o de costo`]
      : []),
  ].join(' y ');

  return [
    hallazgo({
      tipo: 'PRODUCTO_SIN_DATOS_DE_VENTA',
      certeza: 'VISTA',
      titulo: `${conExistencias.length} ${plural(conExistencias.length, 'producto con existencias no se puede', 'productos con existencias no se pueden')} facturar`,
      detalle: `${capital(faltas)}: ${enumerar(conExistencias.map((f) => `${f.codigo} ${f.nombre} (${f.existencias} en existencia${f.sinPrecio ? ', sin precio' : ''}${f.sinCuentas ? ', sin cuentas' : ''})`))}. Hoy una factura los rechazaría. Me parece que les falta configurarlos, salvo que no sean para vender.`,
      referencias: conExistencias.map((f) => ({
        tipo: 'PRODUCTO' as const,
        id: f.id,
        etiqueta: f.codigo,
      })),
    }),
  ];
}

// ── 5. Terceros sin marcar ───────────────────────────────────────────────────

export interface FilaTerceroSinMarcar {
  id: string;
  nombre: string;
  /** PROVEEDOR si tiene compras y no está marcado; CLIENTE si tiene ventas. */
  falta: 'PROVEEDOR' | 'CLIENTE';
  documentos: number;
}

/**
 * Terceros con compras vigentes que no figuran como proveedores, o con
 * facturas vigentes que no figuran como clientes. Se registraron cuando sí lo
 * estaban, y después alguien los desmarcó. Visto: la próxima compra o factura
 * se va a rechazar.
 */
export function tercerosSinMarcar(filas: FilaTerceroSinMarcar[]): Hallazgo[] {
  return filas.map((f) => {
    const rol = f.falta === 'PROVEEDOR' ? 'proveedor' : 'cliente';
    const docs =
      f.falta === 'PROVEEDOR'
        ? plural(
            f.documentos,
            'una compra vigente',
            `${f.documentos} compras vigentes`,
          )
        : plural(
            f.documentos,
            'una factura vigente',
            `${f.documentos} facturas vigentes`,
          );
    return hallazgo({
      tipo: 'TERCERO_SIN_MARCAR',
      certeza: 'VISTA',
      titulo: `«${f.nombre}» tiene ${docs} y no figura como ${rol}`,
      detalle: `Me parece que alguien lo desmarcó después de registrarle. Mientras no figure como ${rol}, ${f.falta === 'PROVEEDOR' ? 'no se le puede registrar otra compra' : 'no se le puede emitir otra factura'}.`,
      referencias: [{ tipo: 'TERCERO', id: f.id, etiqueta: f.nombre }],
    });
  });
}

// ── 6. Gastos ────────────────────────────────────────────────────────────────

export interface FilaGasto {
  compraId: string;
  numero: string;
  terceroId: string;
  proveedor: string;
  detalle: string;
  cuentaId: string;
  cuenta: string;
  total: number;
  /** Si la cuenta es la del inventario de algún producto. */
  esCuentaDeInventario: boolean;
}

/** Cuántas veces tiene que haberse usado una cuenta para ser «la de siempre». */
export const VECES_PARA_COSTUMBRE = 2;

/**
 * Un gasto de un proveedor que fue a una cuenta distinta de la de siempre:
 * el proveedor tiene dos o más gastos a una cuenta y este es el único a otra.
 * **Deducido**: el mismo proveedor puede cobrar dos cosas distintas.
 */
export function gastosEnCuentaDistinta(filas: FilaGasto[]): Hallazgo[] {
  const porProveedor = new Map<string, FilaGasto[]>();
  for (const f of filas) {
    porProveedor.set(f.terceroId, [
      ...(porProveedor.get(f.terceroId) ?? []),
      f,
    ]);
  }

  const hallazgos: Hallazgo[] = [];
  for (const gastos of porProveedor.values()) {
    const porCuenta = new Map<string, FilaGasto[]>();
    for (const g of gastos) {
      porCuenta.set(g.cuentaId, [...(porCuenta.get(g.cuentaId) ?? []), g]);
    }
    const [habitual] = [...porCuenta.values()].sort(
      (a, b) => b.length - a.length,
    );
    if (habitual === undefined || habitual.length < VECES_PARA_COSTUMBRE)
      continue;

    for (const [cuentaId, usos] of porCuenta) {
      if (cuentaId === habitual[0].cuentaId || usos.length !== 1) continue;
      const g = usos[0];
      hallazgos.push(
        hallazgo({
          tipo: 'GASTO_EN_CUENTA_DISTINTA',
          certeza: 'DEDUCIDA',
          titulo: `Un gasto de ${g.proveedor} fue a una cuenta distinta de la de siempre`,
          detalle: `«${g.detalle}» de la compra ${g.numero}, por ${pesos(g.total)}, quedó en ${g.cuenta}; los otros ${habitual.length} gastos de ${g.proveedor} van a ${habitual[0].cuenta}. Me parece que puede estar en la cuenta equivocada, salvo que sea un gasto de otra naturaleza.`,
          referencias: [{ tipo: 'COMPRA', id: g.compraId, etiqueta: g.numero }],
        }),
      );
    }
  }
  return hallazgos;
}

/**
 * Un renglón de gasto —sin producto— que fue a la cuenta del inventario. Esa
 * plata entra a la cuenta pero no al kardex, y el inventario se descuadra por
 * ahí. **Deducido**: puede ser mercancía que se registró como gasto, o una
 * cuenta de inventario que se usa para otra cosa.
 */
export function gastosAInventario(filas: FilaGasto[]): Hallazgo[] {
  const alInventario = filas.filter((f) => f.esCuentaDeInventario);
  if (alInventario.length === 0) return [];
  const total = alInventario.reduce((s, f) => s + f.total, 0);
  return [
    hallazgo({
      tipo: 'GASTO_A_INVENTARIO',
      certeza: 'DEDUCIDA',
      titulo: `${alInventario.length} ${plural(alInventario.length, 'gasto fue', 'gastos fueron')} a la cuenta del inventario sin pasar por el kardex: ${pesos(total)}`,
      detalle: `${capital(enumerar(alInventario.map((f) => `«${f.detalle}» de la compra ${f.numero} (${f.proveedor}) a ${f.cuenta}, ${pesos(f.total)}`)))}. Me parece que es mercancía registrada como gasto: la cuenta la suma y el kardex no, y así se separan.`,
      cifras: { uno: total, otro: 0, diferencia: total },
      referencias: alInventario.map((f) => ({
        tipo: 'COMPRA' as const,
        id: f.compraId,
        etiqueta: f.numero,
      })),
    }),
  ];
}

// ── 7. Compras que se parecen demasiado ──────────────────────────────────────

export interface FilaCompraParecida {
  id: string;
  terceroId: string;
  proveedor: string;
  numero: string;
  fecha: string;
  total: number;
}

/** Cuántos días de diferencia se toleran para decir «el mismo momento». */
export const DIAS_DE_PARECIDO = 5;

/**
 * Dos compras del mismo proveedor, por el mismo total, con pocos días de
 * diferencia y **números distintos**. La fase 7 las deja pasar a propósito: dos
 * facturas iguales pueden ser dos pedidos iguales. Acá se dicen como lo que
 * son, una sospecha.
 *
 * Recibe los grupos de terceros repetidos, como la fase 7: la misma factura
 * cargada a dos terceros que son la misma persona también se parece.
 */
export function comprasParecidas(
  compras: FilaCompraParecida[],
  mismos: FilaTercero[][],
): Hallazgo[] {
  const persona = new Map<string, string>();
  for (const g of mismos) for (const t of g) persona.set(t.id, g[0].id);
  const quien = (c: FilaCompraParecida) =>
    persona.get(c.terceroId) ?? c.terceroId;
  const dias = (a: string, b: string) =>
    Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

  const hallazgos: Hallazgo[] = [];
  const ordenadas = [...compras].sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (let i = 0; i < ordenadas.length; i++) {
    for (let j = i + 1; j < ordenadas.length; j++) {
      const a = ordenadas[i];
      const b = ordenadas[j];
      if (dias(a.fecha, b.fecha) > DIAS_DE_PARECIDO) break;
      if (quien(a) !== quien(b)) continue;
      if (Math.abs(a.total - b.total) > 1) continue;
      // El mismo número escrito distinto ya lo afirma la fase 7.
      if (numeroComparable(a.numero) === numeroComparable(b.numero)) continue;
      hallazgos.push(
        hallazgo({
          tipo: 'COMPRA_PARECIDA',
          certeza: 'DEDUCIDA',
          titulo: `Dos compras de ${a.proveedor} por ${pesos(a.total)} con ${Math.round(dias(a.fecha, b.fecha))} días de diferencia`,
          detalle: `${a.numero} del ${fecha(a.fecha)} y ${b.numero} del ${fecha(b.fecha)}: mismo proveedor, mismo total, números distintos. Me parece que puede ser la misma factura registrada dos veces con el número mal escrito, salvo que sean dos pedidos iguales.`,
          referencias: [
            { tipo: 'COMPRA', id: a.id, etiqueta: a.numero },
            { tipo: 'COMPRA', id: b.id, etiqueta: b.numero },
          ],
        }),
      );
    }
  }
  return hallazgos;
}
