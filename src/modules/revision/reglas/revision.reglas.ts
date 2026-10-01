/**
 * Los errores que se **afirman**: comparaciones exactas, sin criterio de por
 * medio. Fase 7 de `docs/planes/maria-facturas-y-errores.md`.
 *
 * Cada comprobación compara dos cosas que el sistema lleva por separado y que
 * tienen que dar lo mismo —un asiento y sus líneas, el kardex y la cuenta del
 * inventario, la caja y su cuenta—, o busca la misma cosa cargada dos veces.
 * **O cuadra o no cuadra.** Lo que pide opinión —«esto parece mal
 * clasificado»— es la fase 9 y no entra acá.
 *
 * Y nada se corrige solo. Encontrar es de María; corregir es de una persona.
 *
 * Sin red y sin base de datos: el servicio trae las filas, esto decide.
 */

/** Dos centavos de gracia: los costos promedio van con seis decimales. */
export const TOLERANCIA = 0.01;

export type TipoHallazgo =
  // ── Fase 7: se afirman ──
  | 'ASIENTO_DESCUADRADO'
  | 'PERIODO_CONGELADO_DISTINTO'
  | 'INVENTARIO_VS_CONTABILIDAD'
  | 'CAJA_VS_CONTABILIDAD'
  | 'BANCO_VS_CONTABILIDAD'
  | 'KARDEX_DE_ANULADO'
  | 'DOCUMENTO_Y_ASIENTO_DISTINTOS'
  | 'COMPRA_DUPLICADA'
  | 'COBRO_DUPLICADO'
  | 'PAGO_DUPLICADO'
  | 'TERCERO_DUPLICADO'
  | 'IVA_ANTES_DEL_REGIMEN'
  // ── Fase 9: piden criterio ──
  | 'COMPRA_SIN_RETENCION'
  | 'COMPRA_RETENCION_DISTINTA'
  | 'PERIODO_SIN_CERRAR'
  | 'LECTURA_SIN_REGISTRAR'
  | 'PRODUCTO_SIN_DATOS_DE_VENTA'
  | 'TERCERO_SIN_MARCAR'
  | 'GASTO_EN_CUENTA_DISTINTA'
  | 'GASTO_A_INVENTARIO'
  | 'COMPRA_PARECIDA';

export type GrupoHallazgo =
  'DESCUADRE' | 'DUPLICADO' | 'FECHAS' | 'FALTANTE' | 'CLASIFICACION';

/**
 * Qué tan seguro es lo que se dice. Los tres niveles del plan, menos el
 * tercero —«no sé»—, que no se dice: si no se sabe, no es un hallazgo.
 *
 * - `AFIRMADO`: una comparación exacta. **«Esto no cuadra.»** Fase 7.
 * - `VISTA`: el hecho está claro —julio sigue abierto, el producto no tiene
 *   precio—; lo que pide criterio es si es un error. **«Lo vi, y me parece
 *   que…»**
 * - `DEDUCIDA`: una inferencia —una compra que se parece mucho a otra, un
 *   gasto que fue a una cuenta distinta de la de siempre—. **«Me parece, pero
 *   lo deduzco.»**
 *
 * Ninguno se corrige solo. Encontrar es de María; corregir es de una persona.
 */
export type Certeza = 'AFIRMADO' | 'VISTA' | 'DEDUCIDA';

export const GRUPO: Record<TipoHallazgo, GrupoHallazgo> = {
  ASIENTO_DESCUADRADO: 'DESCUADRE',
  PERIODO_CONGELADO_DISTINTO: 'DESCUADRE',
  INVENTARIO_VS_CONTABILIDAD: 'DESCUADRE',
  CAJA_VS_CONTABILIDAD: 'DESCUADRE',
  BANCO_VS_CONTABILIDAD: 'DESCUADRE',
  KARDEX_DE_ANULADO: 'DESCUADRE',
  DOCUMENTO_Y_ASIENTO_DISTINTOS: 'DESCUADRE',
  COMPRA_DUPLICADA: 'DUPLICADO',
  COBRO_DUPLICADO: 'DUPLICADO',
  PAGO_DUPLICADO: 'DUPLICADO',
  TERCERO_DUPLICADO: 'DUPLICADO',
  IVA_ANTES_DEL_REGIMEN: 'FECHAS',
  COMPRA_SIN_RETENCION: 'FALTANTE',
  COMPRA_RETENCION_DISTINTA: 'DESCUADRE',
  PERIODO_SIN_CERRAR: 'FALTANTE',
  LECTURA_SIN_REGISTRAR: 'FALTANTE',
  PRODUCTO_SIN_DATOS_DE_VENTA: 'CLASIFICACION',
  TERCERO_SIN_MARCAR: 'CLASIFICACION',
  GASTO_EN_CUENTA_DISTINTA: 'CLASIFICACION',
  GASTO_A_INVENTARIO: 'CLASIFICACION',
  COMPRA_PARECIDA: 'DUPLICADO',
};

/** A qué apunta un hallazgo, para poder ir a verlo. */
export interface Referencia {
  tipo:
    | 'ASIENTO'
    | 'PERIODO'
    | 'CUENTA'
    | 'CAJA'
    | 'BANCO'
    | 'COMPRA'
    | 'VENTA'
    | 'TERCERO'
    | 'MOVIMIENTO'
    | 'PRODUCTO'
    | 'LECTURA';
  id: string;
  etiqueta: string;
}

/**
 * Lo que se encontró. `titulo` dice qué, y `detalle` con qué números, en
 * palabras que se entienden sin abrir nada. Si es criterio y no certeza,
 * `certeza` lo dice y el texto también: **«me parece», nunca «está mal»**.
 */
export interface Hallazgo {
  tipo: TipoHallazgo;
  grupo: GrupoHallazgo;
  certeza: Certeza;
  titulo: string;
  detalle: string;
  /** Cuando es una diferencia: lo que dice cada lado. */
  cifras?: { uno: number; otro: number; diferencia: number };
  referencias: Referencia[];
}

/** Arma un hallazgo; el grupo sale del tipo y la certeza, si no se dice, es afirmada. */
export const hallazgo = (
  h: Omit<Hallazgo, 'grupo' | 'certeza'> & { certeza?: Certeza },
): Hallazgo => ({
  ...h,
  grupo: GRUPO[h.tipo],
  certeza: h.certeza ?? 'AFIRMADO',
});

/** $ 1.234.567 — como en el resto de la aplicación. */
export function pesos(n: number): string {
  const redondo = Math.round(n * 100) / 100;
  const [entero, decimales] = Math.abs(redondo).toFixed(2).split('.');
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${redondo < 0 ? '-' : ''}$ ${miles}${decimales === '00' ? '' : `,${decimales}`}`;
}

const distinto = (a: number, b: number) => Math.abs(a - b) > TOLERANCIA;

// ── 1. Asientos ──────────────────────────────────────────────────────────────

export interface FilaAsiento {
  id: string;
  numero: string;
  fecha: string;
  totalDebito: number;
  totalCredito: number;
  sumaDebito: number;
  sumaCredito: number;
}

/**
 * Un asiento cuyas sumas no coinciden. **La base no debería dejarlo existir**
 * —tiene un CHECK y un disparador diferido que lo impiden—, así que esto es la
 * red de abajo: si alguna vez aparece uno, el problema es serio y hay que
 * saberlo.
 */
export function asientosDescuadrados(filas: FilaAsiento[]): Hallazgo[] {
  return filas
    .filter(
      (a) =>
        distinto(a.sumaDebito, a.sumaCredito) ||
        distinto(a.totalDebito, a.sumaDebito) ||
        distinto(a.totalCredito, a.sumaCredito),
    )
    .map((a) =>
      hallazgo({
        tipo: 'ASIENTO_DESCUADRADO',
        titulo: `El asiento ${a.numero} no cuadra`,
        detalle: `Sus líneas suman ${pesos(a.sumaDebito)} al débito y ${pesos(a.sumaCredito)} al crédito; la cabecera dice ${pesos(a.totalDebito)} y ${pesos(a.totalCredito)}.`,
        cifras: {
          uno: a.sumaDebito,
          otro: a.sumaCredito,
          diferencia: a.sumaDebito - a.sumaCredito,
        },
        referencias: [{ tipo: 'ASIENTO', id: a.id, etiqueta: a.numero }],
      }),
    );
}

// ── 2. Períodos cerrados ─────────────────────────────────────────────────────

export interface FilaPeriodoCuenta {
  periodoId: string;
  anio: number;
  mes: number;
  cuentaId: string;
  cuentaCodigo: string;
  cuentaNombre: string;
  /** Lo que quedó congelado al cerrar. */
  congeladoDebitos: number;
  congeladoCreditos: number;
  /** Lo que suman hoy los asientos del período. */
  debitos: number;
  creditos: number;
}

/**
 * Un período cerrado cuyo saldo congelado ya no coincide con sus asientos. Con
 * el período cerrado nada debería moverse, así que si difieren, los libros de
 * ese mes dicen una cosa y los reportes otra.
 */
export function periodosDistintos(filas: FilaPeriodoCuenta[]): Hallazgo[] {
  return filas
    .filter(
      (f) =>
        distinto(f.congeladoDebitos, f.debitos) ||
        distinto(f.congeladoCreditos, f.creditos),
    )
    .map((f) => {
      const periodo = `${String(f.mes).padStart(2, '0')}/${f.anio}`;
      const congelado = f.congeladoDebitos - f.congeladoCreditos;
      const hoy = f.debitos - f.creditos;
      return hallazgo({
        tipo: 'PERIODO_CONGELADO_DISTINTO',
        titulo: `El cierre de ${periodo} no coincide con sus asientos en la ${f.cuentaCodigo}`,
        detalle: `Al cerrar quedaron ${pesos(f.congeladoDebitos)} al débito y ${pesos(f.congeladoCreditos)} al crédito en ${f.cuentaCodigo} ${f.cuentaNombre}; hoy los asientos del período suman ${pesos(f.debitos)} y ${pesos(f.creditos)}.`,
        cifras: { uno: congelado, otro: hoy, diferencia: congelado - hoy },
        referencias: [
          { tipo: 'PERIODO', id: f.periodoId, etiqueta: periodo },
          { tipo: 'CUENTA', id: f.cuentaId, etiqueta: f.cuentaCodigo },
        ],
      });
    });
}

// ── 3. Lo que se lleva por dos lados ─────────────────────────────────────────

export interface FilaDosLados {
  /** La cuenta contable que tiene que dar lo mismo que el auxiliar. */
  cuentaId: string;
  cuentaCodigo: string;
  cuentaNombre: string;
  /** Lo que dice el auxiliar: el kardex, la caja, el banco. */
  auxiliar: number;
  /** Débitos menos créditos de la cuenta, en asientos registrados. */
  contable: number;
  /**
   * Cuánto del auxiliar entró sin asiento: saldos iniciales. No lo corrige
   * nada acá —sigue siendo una diferencia—, pero dice de dónde sale.
   */
  sinAsiento: number;
  /**
   * Solo en el inventario: lo que quedó en el kardex de documentos anulados
   * —entradas menos salidas con un asiento anulado—. Debería ser cero.
   */
  porAnulaciones?: number;
  /** Qué caja, qué banco, o cuántos productos. */
  nombres: Array<{ id: string; nombre: string }>;
}

const DOS_LADOS = {
  INVENTARIO_VS_CONTABILIDAD: {
    auxiliar: 'el kardex',
    referencia: null,
    sinAsiento: 'saldos iniciales de inventario',
  },
  CAJA_VS_CONTABILIDAD: {
    auxiliar: 'el libro de caja',
    referencia: 'CAJA',
    sinAsiento: 'saldos iniciales de caja',
  },
  BANCO_VS_CONTABILIDAD: {
    auxiliar: 'el libro de bancos',
    referencia: 'BANCO',
    sinAsiento: 'saldos iniciales del banco',
  },
} as const;

/**
 * El kardex contra la cuenta del inventario, la caja contra la suya, el banco
 * contra la suya. Son dos registros de la misma plata, y tienen que dar igual.
 *
 * La diferencia más común tiene nombre: **un saldo inicial que entró al
 * auxiliar sin su asiento de apertura**. Se dice cuánto es, porque es lo
 * primero que alguien va a revisar, pero no se descuenta: mientras el asiento
 * no esté, los libros no cuadran.
 */
export function dosLados(
  tipo: keyof typeof DOS_LADOS,
  filas: FilaDosLados[],
): Hallazgo[] {
  const t = DOS_LADOS[tipo];
  return filas
    .filter((f) => distinto(f.auxiliar, f.contable))
    .map((f) => {
      const diferencia = f.auxiliar - f.contable;
      const quien =
        tipo === 'INVENTARIO_VS_CONTABILIDAD'
          ? `${f.nombres.length === 1 ? 'un producto' : `${f.nombres.length} productos`}`
          : f.nombres.map((n) => n.nombre).join(', ');
      // Lo que no se explica es lo que más importa: es plata que se movió por
      // un lado y no por el otro. Se descuenta lo que ya tiene nombre —el
      // saldo inicial sin asiento, y lo que dejaron las anulaciones— y se dice
      // cuánto queda.
      const porAnulaciones = f.porAnulaciones ?? 0;
      const resto = diferencia - f.sinAsiento - porAnulaciones;
      const partes = [
        ...(f.sinAsiento > TOLERANCIA
          ? [
              `${pesos(f.sinAsiento)} son ${t.sinAsiento} que entraron sin asiento de apertura`,
            ]
          : []),
        ...(distinto(porAnulaciones, 0)
          ? [
              `${pesos(porAnulaciones)} salen de documentos anulados que no dejaron el kardex en cero, que se detallan aparte`,
            ]
          : []),
      ];
      const explicacion =
        partes.length === 0
          ? ''
          : ` De eso, ${partes.join('; y ')}.${
              // Un peso de gracia: el kardex promedia con seis decimales y los
              // centavos se van sumando por producto.
              Math.abs(resto) > 1
                ? ` Los otros ${pesos(resto)} no se explican por ahí.`
                : ' Con eso se explica toda la diferencia.'
            }`;
      return hallazgo({
        tipo,
        titulo: `${f.cuentaCodigo} ${f.cuentaNombre} no coincide con ${t.auxiliar}`,
        detalle: `${capital(t.auxiliar)} (${quien}) suma ${pesos(f.auxiliar)}; la cuenta ${f.cuentaCodigo} dice ${pesos(f.contable)}. Diferencia: ${pesos(diferencia)}.${explicacion}`,
        cifras: { uno: f.auxiliar, otro: f.contable, diferencia },
        referencias: [
          { tipo: 'CUENTA', id: f.cuentaId, etiqueta: f.cuentaCodigo },
          ...(t.referencia === null
            ? []
            : f.nombres.map((n) => ({
                tipo: t.referencia,
                id: n.id,
                etiqueta: n.nombre,
              }))),
        ],
      });
    });
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── 4. Terceros ──────────────────────────────────────────────────────────────

export interface FilaTercero {
  id: string;
  tipoDocumento: string;
  numeroDocumento: string;
  dv: string | null;
  nombre: string;
}

/** El dígito de verificación de un NIT, con los pesos de la DIAN. */
export function dvNit(numero: string): string {
  const pesosDian = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const digitos = numero.replace(/\D/g, '').split('').reverse();
  const suma = digitos.reduce(
    (s, d, i) => s + Number(d) * (pesosDian[i] ?? 0),
    0,
  );
  const resto = suma % 11;
  return String(resto > 1 ? 11 - resto : resto);
}

/**
 * Qué terceros son **el mismo documento**, cargado más de una vez.
 *
 * La base ya impide el mismo tipo y número dos veces. Lo que se cuela es lo
 * que se escribe distinto y es igual: el mismo número como NIT y como cédula,
 * con puntos o sin ellos, o **con el dígito de verificación pegado**
 * —900378652-1 guardado como «9003786521»—. Eso último se afirma solo si el
 * dígito sobrante es, de verdad, el de verificación del otro.
 *
 * Devuelve grupos de dos o más: cada grupo es una persona.
 */
export function mismosTerceros(filas: FilaTercero[]): FilaTercero[][] {
  const digitos = (t: FilaTercero) => t.numeroDocumento.replace(/\D/g, '');
  const padre = new Map(filas.map((t) => [t.id, t.id]));
  const raiz = (id: string): string => {
    let r = id;
    while (padre.get(r) !== r) r = padre.get(r)!;
    return r;
  };
  const unir = (a: string, b: string) => padre.set(raiz(a), raiz(b));

  // Mismo número, escrito como sea.
  const porNumero = new Map<string, FilaTercero>();
  for (const t of filas) {
    const d = digitos(t);
    if (d.length < 5) continue;
    const previo = porNumero.get(d);
    if (previo === undefined) porNumero.set(d, t);
    else unir(t.id, previo.id);
  }

  // Con el dígito de verificación pegado.
  for (const t of filas) {
    const d = digitos(t);
    if (d.length < 6) continue;
    const base = porNumero.get(d.slice(0, -1));
    if (base === undefined || base.id === t.id) continue;
    const dv = base.dv ?? dvNit(digitos(base));
    if (d.slice(-1) === dv) unir(t.id, base.id);
  }

  const grupos = new Map<string, FilaTercero[]>();
  for (const t of filas) {
    const r = raiz(t.id);
    grupos.set(r, [...(grupos.get(r) ?? []), t]);
  }
  return [...grupos.values()].filter((g) => g.length > 1);
}

export function tercerosDuplicados(grupos: FilaTercero[][]): Hallazgo[] {
  return grupos.map((g) =>
    hallazgo({
      tipo: 'TERCERO_DUPLICADO',
      titulo: `«${g[0].nombre}» está cargado ${g.length === 2 ? 'dos' : g.length} veces`,
      detalle: `Es el mismo documento escrito de ${g.length === 2 ? 'dos' : g.length} formas: ${g
        .map(
          (t) =>
            `${t.tipoDocumento} ${t.numeroDocumento}${t.dv === null ? '' : `-${t.dv}`} («${t.nombre}»)`,
        )
        .join(
          ', ',
        )}. Lo que se le registra queda repartido entre ${g.length === 2 ? 'los dos' : 'todos'}.`,
      referencias: g.map((t) => ({
        tipo: 'TERCERO' as const,
        id: t.id,
        etiqueta: `${t.tipoDocumento} ${t.numeroDocumento}`,
      })),
    }),
  );
}

// ── 5. Facturas de compra ────────────────────────────────────────────────────

export interface FilaCompra {
  id: string;
  terceroId: string;
  proveedor: string;
  numero: string;
  fecha: string;
  total: number;
}

/**
 * El número como lo escribiría cualquiera: sin guiones, espacios ni puntos, y
 * sin ceros a la izquierda. «FE-0123», «fe 123» y «FE123» son la misma
 * factura.
 */
export function numeroComparable(numero: string): string {
  return numero
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/(^|[A-Z])0+(?=\d)/g, '$1');
}

/**
 * La misma factura del mismo proveedor, dos veces. La base ya impide el número
 * idéntico; esto encuentra **el mismo número escrito distinto**, y **la misma
 * factura cargada a dos terceros que son el mismo** —por eso recibe los grupos
 * de terceros repetidos—.
 */
export function comprasDuplicadas(
  compras: FilaCompra[],
  mismos: FilaTercero[][],
): Hallazgo[] {
  const persona = new Map<string, string>();
  for (const g of mismos) for (const t of g) persona.set(t.id, g[0].id);

  const grupos = new Map<string, FilaCompra[]>();
  for (const c of compras) {
    const llave = `${persona.get(c.terceroId) ?? c.terceroId}|${numeroComparable(c.numero)}`;
    grupos.set(llave, [...(grupos.get(llave) ?? []), c]);
  }

  return [...grupos.values()]
    .filter((g) => g.length > 1)
    .map((g) =>
      hallazgo({
        tipo: 'COMPRA_DUPLICADA',
        titulo: `La factura ${g[0].numero} de ${g[0].proveedor} está registrada ${g.length === 2 ? 'dos' : g.length} veces`,
        detalle: `${g
          .map(
            (c) => `«${c.numero}» del ${fecha(c.fecha)} por ${pesos(c.total)}`,
          )
          .join(
            '; ',
          )}. Es el mismo número del mismo proveedor escrito distinto: el costo y la cuenta por pagar quedan ${g.length === 2 ? 'dobles' : 'multiplicados'}.`,
        referencias: g.map((c) => ({
          tipo: 'COMPRA' as const,
          id: c.id,
          etiqueta: c.numero,
        })),
      }),
    );
}

// ── 6. Cobros y pagos ────────────────────────────────────────────────────────

export interface FilaMovimientoRepetido {
  /** FACTURA_VENTA es un cobro; COMPRA es un pago. */
  origenTipo: 'FACTURA_VENTA' | 'COMPRA';
  origenId: string;
  documento: string;
  tercero: string;
  fecha: string;
  valor: number;
  /** Los movimientos idénticos: dónde quedó cada uno. */
  movimientos: Array<{ id: string; medio: string }>;
}

/**
 * El mismo cobro, o el mismo pago, registrado más de una vez: misma factura,
 * mismo día, mismo valor, misma dirección, y ninguno reversado. **Lo que se
 * afirma es eso, que son idénticos**; si fueron dos abonos iguales el mismo
 * día, lo sabe quien los registró.
 */
export function movimientosRepetidos(
  filas: FilaMovimientoRepetido[],
): Hallazgo[] {
  return filas
    .filter((f) => f.movimientos.length > 1)
    .map((f) => {
      const cobro = f.origenTipo === 'FACTURA_VENTA';
      const n =
        f.movimientos.length === 2 ? 'dos' : String(f.movimientos.length);
      return hallazgo({
        tipo: cobro ? 'COBRO_DUPLICADO' : 'PAGO_DUPLICADO',
        titulo: `${cobro ? 'El cobro' : 'El pago'} de la factura ${f.documento} está ${n} veces`,
        detalle: `${capital(n)} ${cobro ? 'cobros' : 'pagos'} idénticos de ${pesos(f.valor)} el ${fecha(f.fecha)} ${cobro ? 'de' : 'a'} ${f.tercero}: ${f.movimientos
          .map((m) => m.medio)
          .join(
            ' y ',
          )}. Si uno sobra, el saldo de la factura y el de ${f.movimientos.length === 2 && f.movimientos[0].medio === f.movimientos[1].medio ? f.movimientos[0].medio : 'la caja o el banco'} están mal.`,
        cifras: {
          uno: f.valor * f.movimientos.length,
          otro: f.valor,
          diferencia: f.valor * (f.movimientos.length - 1),
        },
        referencias: [
          {
            tipo: cobro ? 'VENTA' : 'COMPRA',
            id: f.origenId,
            etiqueta: f.documento,
          },
          ...f.movimientos.map((m) => ({
            tipo: 'MOVIMIENTO' as const,
            id: m.id,
            etiqueta: m.medio,
          })),
        ],
      });
    });
}

// ── 7. Fechas que no pueden ser ciertas a la vez ─────────────────────────────

export interface FilaIvaAntesDelRegimen {
  compraId: string;
  numero: string;
  proveedor: string;
  fecha: string;
  /** El IVA de la compra que se fue al costo por no ser descontable. */
  ivaAlCosto: number;
  /** Desde cuándo la empresa figura como responsable de IVA. */
  regimenDesde: string;
}

/**
 * Una compra con IVA que se llevó al costo porque, **a la fecha del documento,
 * la empresa no era responsable de IVA** — y sí lo es desde después.
 *
 * El sistema hizo lo que los datos decían. Lo que se afirma es que dos cosas
 * no pueden ser ciertas a la vez: o la fecha desde la que la empresa es
 * responsable está mal cargada, o ese IVA de verdad no era descontable. Cuál
 * de las dos, lo decide una persona. El caso real: Jaltech, 28 de julio,
 * responsable desde el 20 de septiembre, 681.206 de IVA en el inventario.
 */
export function ivaAntesDelRegimen(
  filas: FilaIvaAntesDelRegimen[],
): Hallazgo[] {
  // Todas las compras antes de la misma fecha son **una sola causa**: si la
  // fecha está mal, se arregla una vez. Se dicen juntas, con el total.
  const porFecha = new Map<string, FilaIvaAntesDelRegimen[]>();
  for (const f of filas.filter((f) => f.ivaAlCosto > TOLERANCIA)) {
    porFecha.set(f.regimenDesde, [...(porFecha.get(f.regimenDesde) ?? []), f]);
  }

  return [...porFecha.entries()].map(([desde, compras]) => {
    const ordenadas = [...compras].sort((a, b) =>
      a.fecha.localeCompare(b.fecha),
    );
    const total = ordenadas.reduce((s, c) => s + c.ivaAlCosto, 0);
    const una = ordenadas.length === 1;
    return hallazgo({
      tipo: 'IVA_ANTES_DEL_REGIMEN',
      titulo: una
        ? `El IVA de la factura ${ordenadas[0].numero} de ${ordenadas[0].proveedor} se fue al costo`
        : `El IVA de ${ordenadas.length} compras se fue al costo: ${pesos(total)}`,
      detalle: `La empresa figura como responsable de IVA desde el ${fecha(desde)}, y antes de esa fecha no tiene ningún régimen de IVA cargado. ${
        una
          ? `La factura es del ${fecha(ordenadas[0].fecha)}, así que sus ${pesos(total)} de IVA no se descontaron: quedaron en el costo.`
          : `Estas compras son anteriores, así que su IVA no se descontó y quedó en el costo: ${ordenadas
              .map(
                (c) =>
                  `${c.numero} de ${c.proveedor} (${fecha(c.fecha)}, ${pesos(c.ivaAlCosto)})`,
              )
              .join('; ')}.`
      } O la fecha del régimen está mal cargada, o ese IVA de verdad no era descontable; las dos cosas no pueden ser ciertas a la vez.`,
      cifras: { uno: total, otro: 0, diferencia: total },
      referencias: ordenadas.map((c) => ({
        tipo: 'COMPRA' as const,
        id: c.compraId,
        etiqueta: c.numero,
      })),
    });
  });
}

// ── 8. Lo que quedó de un documento anulado ──────────────────────────────────

export interface FilaKardexDeAnulado {
  asientoId: string;
  /** «la factura de venta SETT13», «la compra 101264». */
  documento: string;
  /** Lo que entró al kardex con ese asiento, y lo que salió. */
  entradas: number;
  salidas: number;
}

/**
 * Un documento anulado cuyo kardex no quedó en cero.
 *
 * Al anular, el asiento sale de los libros; lo que ese documento movió en el
 * kardex tiene que volver, **por el mismo valor**. Si no vuelve, el kardex y
 * la cuenta del inventario se separan justo por esa diferencia, y es la
 * diferencia que la comparación de inventario no sabe explicar.
 */
export function kardexDeAnulados(filas: FilaKardexDeAnulado[]): Hallazgo[] {
  return filas
    .filter((f) => distinto(f.entradas, f.salidas))
    .map((f) => {
      const neto = f.entradas - f.salidas;
      return hallazgo({
        tipo: 'KARDEX_DE_ANULADO',
        titulo:
          f.entradas <= TOLERANCIA
            ? `Anular ${f.documento} no devolvió la mercancía al kardex`
            : `Anular ${f.documento} dejó el kardex descuadrado`,
        detalle:
          f.entradas <= TOLERANCIA
            ? `El documento y su asiento están anulados, pero la mercancía que sacó del kardex —${pesos(f.salidas)}— no volvió. El kardex quedó ${pesos(f.salidas)} por debajo de la cuenta del inventario.`
            : `Con ese asiento entraron al kardex ${pesos(f.entradas)} y, al anularlo, salieron ${pesos(f.salidas)}. Tenía que salir lo mismo que entró: el kardex quedó ${pesos(Math.abs(neto))} por ${neto < 0 ? 'debajo' : 'encima'} de la cuenta del inventario.`,
        cifras: { uno: f.entradas, otro: f.salidas, diferencia: neto },
        referencias: [
          { tipo: 'ASIENTO', id: f.asientoId, etiqueta: f.documento },
        ],
      });
    });
}

// ── 9. Documento y asiento que dicen cosas distintas ────────────────────────

export interface FilaDocumentoYAsiento {
  tipo: 'VENTA' | 'COMPRA';
  id: string;
  numero: string;
  estadoDocumento: string;
  estadoAsiento: string;
}

/**
 * Un documento vigente con su asiento anulado, o al revés. Las dos cosas se
 * anulan juntas, en una transacción; si quedaron distintas, los libros dicen
 * una cosa y la pantalla del documento otra.
 */
export function documentosYAsientos(
  filas: FilaDocumentoYAsiento[],
): Hallazgo[] {
  return filas.map((f) => {
    const nombre = f.tipo === 'VENTA' ? 'La factura de venta' : 'La compra';
    const vigente = f.estadoDocumento !== 'ANULADA';
    return hallazgo({
      tipo: 'DOCUMENTO_Y_ASIENTO_DISTINTOS',
      titulo: vigente
        ? `${nombre} ${f.numero} está vigente y su asiento, anulado`
        : `${nombre} ${f.numero} está anulada y su asiento, vigente`,
      detalle: vigente
        ? 'El documento se ve vigente pero no está en los libros: ni su ingreso o gasto, ni su IVA, ni lo que se debe cuentan en la contabilidad.'
        : 'El documento se ve anulado pero sigue en los libros: lo que registró sigue contando en la contabilidad.',
      referencias: [{ tipo: f.tipo, id: f.id, etiqueta: f.numero }],
    });
  });
}

/**
 * El orden en que se muestran: primero lo que no debería poder pasar, después
 * lo que se afirma, y al final lo que es criterio —de lo que se vio a lo que
 * se deduce—.
 */
const ORDEN: TipoHallazgo[] = [
  'ASIENTO_DESCUADRADO',
  'DOCUMENTO_Y_ASIENTO_DISTINTOS',
  'PERIODO_CONGELADO_DISTINTO',
  'CAJA_VS_CONTABILIDAD',
  'BANCO_VS_CONTABILIDAD',
  'INVENTARIO_VS_CONTABILIDAD',
  'KARDEX_DE_ANULADO',
  'COMPRA_DUPLICADA',
  'COBRO_DUPLICADO',
  'PAGO_DUPLICADO',
  'TERCERO_DUPLICADO',
  'IVA_ANTES_DEL_REGIMEN',
  'COMPRA_SIN_RETENCION',
  'COMPRA_RETENCION_DISTINTA',
  'PERIODO_SIN_CERRAR',
  'LECTURA_SIN_REGISTRAR',
  'TERCERO_SIN_MARCAR',
  'PRODUCTO_SIN_DATOS_DE_VENTA',
  'GASTO_A_INVENTARIO',
  'GASTO_EN_CUENTA_DISTINTA',
  'COMPRA_PARECIDA',
];

export function ordenar(hallazgos: Hallazgo[]): Hallazgo[] {
  return [...hallazgos].sort(
    (a, b) => ORDEN.indexOf(a.tipo) - ORDEN.indexOf(b.tipo),
  );
}

/** 2026-07-28 → 28/07/2026, como se escribe una fecha en Colombia. */
export function fecha(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return d === undefined ? iso : `${d}/${m}/${a}`;
}
