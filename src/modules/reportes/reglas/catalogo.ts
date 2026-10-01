import type { RolCodigo } from '../../../common/ctx';

/**
 * Qué se puede reportar, y con qué columnas. Sin red y sin base de datos.
 *
 * Este archivo es el equivalente de `documento.reglas.ts` para los reportes: el
 * **único** lugar donde vive «qué se permite». Hace tres trabajos a la vez, y
 * los tres importan:
 *
 * 1. **La pantalla lo lee** para dibujar el selector de columnas y los filtros.
 *    Sin esto, el armador no tiene qué ofrecer.
 * 2. **La consulta se arma con esto y solo con esto.** El cliente manda claves
 *    —`cliente`, `total`—, nunca SQL. El `sql` de cada columna está escrito acá
 *    y en ningún otro lado. Una clave que no esté en el catálogo no llega a la
 *    consulta, y ese es el motivo por el que «elegir columnas» no es inyección
 *    de SQL con otro nombre.
 * 3. **Agregar un origen es una decisión deliberada**, de unas líneas, en la
 *    que alguien elige a conciencia qué expone y a quién.
 *
 * **Seis orígenes y no se cruzan.** Cruzar dos es el constructor de consultas
 * que `planes/reportes-armables.md` descartó en su primera decisión.
 */

/**
 * De qué es cada columna. Decide tres cosas que nadie debería tener que elegir
 * a mano: si se alinea a la derecha, si suma y cómo se escribe.
 *
 * El plan hablaba de tres tipos —texto, fecha y plata— y son cuatro. `CANTIDAD`
 * apareció al mirar inventario: las unidades suman igual que la plata pero no
 * llevan signo de pesos ni dos decimales fijos, y meterlas en `DINERO` habría
 * puesto «$ 12,00 unidades» en la única columna que un almacenista mira.
 */
export type TipoColumna = 'TEXTO' | 'FECHA' | 'DINERO' | 'CANTIDAD';

/** Las columnas que suman. Es una consecuencia del tipo, no una marca aparte. */
export const SUMA: Record<TipoColumna, boolean> = {
  TEXTO: false,
  FECHA: false,
  DINERO: true,
  CANTIDAD: true,
};

/**
 * Las cuatro formas de filtrar, y no hay una quinta.
 *
 * El rango de fechas no está acá porque no se elige: todo reporte lo tiene, y
 * cuál es su columna lo dice `Origen.fecha`.
 *
 * No hay «y/o» ni paréntesis: **todos los filtros se cumplen a la vez**. Un
 * constructor booleano se ve poderoso y casi nadie lo arma bien; decir en la
 * pantalla «se muestran las filas que cumplen todo esto» es más honesto.
 */
export type FormaFiltro = 'LISTA' | 'RANGO' | 'SI_NO';

/**
 * De dónde salen los valores de una `LISTA` que no es un conjunto cerrado.
 * Los resuelve el endpoint del catálogo contra la base, con el contexto de la
 * empresa puesto: son datos de la empresa, no constantes del producto.
 */
export type ClaveCatalogo =
  | 'TERCEROS_CLIENTE'
  | 'TERCEROS_PROVEEDOR'
  | 'CUENTAS_PUC'
  | 'CATEGORIAS_PRODUCTO'
  | 'SEDES'
  | 'CAJAS'
  | 'CUENTAS_BANCARIAS'
  | 'CENTROS_COSTO';

export interface Columna {
  /** Lo que el cliente manda. Nunca manda SQL. */
  clave: string;
  /** Lo que la persona lee. Nuestro, no de la base. */
  etiqueta: string;
  tipo: TipoColumna;
  /**
   * La expresión SQL. **Escrita acá y en ningún otro lado.** Se interpola en la
   * consulta tal cual, así que lo que entre acá es código: no puede salir de
   * una petición, de una fila ni de una variable de entorno.
   */
  sql: string;
  /** Con qué forma se filtra. Sin esto, la columna se muestra pero no filtra. */
  filtro?: FormaFiltro;
  /** Los valores de una `LISTA` cerrada, cuando son un conjunto del producto. */
  valores?: readonly string[];
  /** Los valores de una `LISTA` que sale de la base. Excluyente con `valores`. */
  catalogo?: ClaveCatalogo;
  /** Si sirve para agrupar. Agrupar por un monto no significa nada. */
  agrupable?: boolean;
  /** Si viene marcada la primera vez. Es el reporte del que se parte. */
  inicial?: boolean;
  /**
   * Una cifra que **no se suma** aunque sea plata o cantidad: un saldo de
   * kardex, un costo unitario, unos días. Sumar el saldo de cada movimiento
   * da un número que no es nada, y un subtotal que no es nada es peor que
   * ninguno.
   */
  noSuma?: boolean;
}

/** Si la columna lleva subtotal y total. Lo decide el tipo, salvo que diga `noSuma`. */
export const sumaColumna = (c: Columna): boolean =>
  SUMA[c.tipo] && c.noSuma !== true;

export interface Origen {
  clave: ClaveOrigen;
  etiqueta: string;
  /** La pregunta que contesta, en las palabras de quien la haría. */
  pregunta: string;
  /**
   * Quién puede correrlo. **Se mira al correr, no al guardar**: un reporte
   * guardado es de la empresa, pero las filas que devuelve son las que puede
   * ver quien aprieta el botón. Un `VENTAS` que abre el reporte de compras del
   * contador no ve compras.
   */
  roles: readonly RolCodigo[];
  /**
   * El `FROM` con sus uniones, fijo. No se arma, no se elige y no depende de
   * las columnas pedidas: una unión de más cuesta poco y una unión armada
   * dinámicamente cuesta un agujero.
   */
  desde: string;
  /** La columna del rango de fechas obligatorio. */
  fecha: string;
  /**
   * Una condición fija que el origen siempre cumple, escrita acá como el
   * `FROM`. No se elige ni se quita: es lo que hace que «cartera» sea cartera
   * y no «ventas con otro nombre».
   */
  donde?: string;
  columnas: readonly Columna[];
}

export type ClaveOrigen =
  | 'VENTAS'
  | 'COMPRAS'
  | 'CARTERA'
  | 'INVENTARIO'
  | 'TESORERIA'
  | 'CONTABILIDAD';

/** El nombre de un tercero, que en Colombia puede ser de persona o de empresa. */
const NOMBRE_TERCERO = `COALESCE(NULLIF(BTRIM(t.razon_social), ''),
  BTRIM(CONCAT_WS(' ', t.primer_nombre, t.segundo_nombre, t.primer_apellido, t.segundo_apellido)))`;

/** El identificador que un contador reconoce: el NIT o la cédula, con su DV. */
const DOCUMENTO_TERCERO = `CONCAT(t.numero_documento, CASE WHEN t.dv IS NOT NULL THEN CONCAT('-', t.dv) ELSE '' END)`;

const ESTADOS_VENTA = ['EMITIDA', 'ANULADA'] as const;
const TIPOS_VENTA = [
  'COTIZACION',
  'FACTURA',
  'NOTA_CREDITO',
  'NOTA_DEBITO',
] as const;
const TIPOS_COMPRA = ['FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO'] as const;
const ESTADOS_COMPRA = ['EMITIDA', 'ANULADA'] as const;

/** Los del `CHECK` de `producto_movimiento`, que es la lista que manda. */
const TIPOS_MOVIMIENTO_INVENTARIO = [
  'ENTRADA_INICIAL',
  'ENTRADA_AJUSTE',
  'ENTRADA_COMPRA',
  'SALIDA_AJUSTE',
  'SALIDA_VENTA',
] as const;

/**
 * La **unión** de los tipos de caja y los de banco, porque el origen une las
 * dos tablas. Filtrar por `CHEQUE` no devuelve ninguna fila de caja, y está
 * bien: la caja no gira cheques. Lo que no puede pasar es que la pantalla
 * ofrezca un tipo que ninguna de las dos tablas conoce.
 */
const TIPOS_MOVIMIENTO_TESORERIA = [
  'SALDO_INICIAL',
  'INGRESO',
  'EGRESO',
  'CONSIGNACION',
  'RETIRO',
  'TRANSFERENCIA_ENTRANTE',
  'TRANSFERENCIA_SALIENTE',
  'NOTA_DEBITO',
  'NOTA_CREDITO',
  'CHEQUE',
] as const;

export const ORIGENES: Readonly<Record<ClaveOrigen, Origen>> = {
  // ── Ventas ────────────────────────────────────────────────────────────────
  VENTAS: {
    clave: 'VENTAS',
    etiqueta: 'Ventas',
    pregunta: 'Qué vendí, a quién y con qué impuestos',
    roles: ['DIRECTOR', 'CONTADOR', 'VENTAS', 'CONSULTA'],
    desde: `venta_documento v
              JOIN tercero t ON t.id = v.tercero_id`,
    fecha: 'v.fecha',
    columnas: [
      {
        clave: 'fecha',
        etiqueta: 'Fecha',
        tipo: 'FECHA',
        sql: 'v.fecha',
        inicial: true,
        agrupable: true,
      },
      {
        clave: 'numero',
        etiqueta: 'Número',
        tipo: 'TEXTO',
        sql: `CONCAT_WS('-', v.prefijo, v.consecutivo::text)`,
        inicial: true,
      },
      {
        clave: 'tipo',
        etiqueta: 'Tipo',
        tipo: 'TEXTO',
        sql: 'v.tipo',
        filtro: 'LISTA',
        valores: TIPOS_VENTA,
        agrupable: true,
      },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        tipo: 'TEXTO',
        sql: 'v.estado',
        filtro: 'LISTA',
        valores: ESTADOS_VENTA,
        agrupable: true,
      },
      {
        clave: 'cliente',
        etiqueta: 'Cliente',
        tipo: 'TEXTO',
        sql: NOMBRE_TERCERO,
        filtro: 'LISTA',
        catalogo: 'TERCEROS_CLIENTE',
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'clienteDocumento',
        etiqueta: 'NIT o cédula',
        tipo: 'TEXTO',
        sql: DOCUMENTO_TERCERO,
      },
      {
        clave: 'subtotal',
        etiqueta: 'Subtotal',
        tipo: 'DINERO',
        sql: 'v.subtotal',
        filtro: 'RANGO',
      },
      { clave: 'iva', etiqueta: 'IVA', tipo: 'DINERO', sql: 'v.total_iva' },
      {
        clave: 'total',
        etiqueta: 'Total',
        tipo: 'DINERO',
        sql: 'v.total',
        filtro: 'RANGO',
        inicial: true,
      },
      {
        clave: 'pagado',
        etiqueta: 'Pagado',
        tipo: 'DINERO',
        sql: 'v.monto_pagado',
      },
      {
        clave: 'saldo',
        etiqueta: 'Saldo',
        tipo: 'DINERO',
        sql: 'v.total - v.monto_pagado',
      },
    ],
  },

  // ── Compras ───────────────────────────────────────────────────────────────
  COMPRAS: {
    clave: 'COMPRAS',
    etiqueta: 'Compras',
    pregunta: 'Qué compré, a quién y con qué retenciones',
    roles: ['DIRECTOR', 'CONTADOR', 'COMPRAS', 'CONSULTA'],
    desde: `compra_documento c
              JOIN tercero t ON t.id = c.tercero_id`,
    fecha: 'c.fecha',
    columnas: [
      {
        clave: 'fecha',
        etiqueta: 'Fecha',
        tipo: 'FECHA',
        sql: 'c.fecha',
        inicial: true,
        agrupable: true,
      },
      {
        clave: 'numero',
        etiqueta: 'Factura del proveedor',
        tipo: 'TEXTO',
        sql: 'c.numero_factura_proveedor',
        inicial: true,
      },
      {
        clave: 'tipo',
        etiqueta: 'Tipo',
        tipo: 'TEXTO',
        sql: 'c.tipo',
        filtro: 'LISTA',
        valores: TIPOS_COMPRA,
        agrupable: true,
      },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        tipo: 'TEXTO',
        sql: 'c.estado',
        filtro: 'LISTA',
        valores: ESTADOS_COMPRA,
        agrupable: true,
      },
      {
        clave: 'proveedor',
        etiqueta: 'Proveedor',
        tipo: 'TEXTO',
        sql: NOMBRE_TERCERO,
        filtro: 'LISTA',
        catalogo: 'TERCEROS_PROVEEDOR',
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'proveedorDocumento',
        etiqueta: 'NIT o cédula',
        tipo: 'TEXTO',
        sql: DOCUMENTO_TERCERO,
      },
      {
        clave: 'subtotal',
        etiqueta: 'Subtotal',
        tipo: 'DINERO',
        sql: 'c.subtotal',
        filtro: 'RANGO',
      },
      { clave: 'iva', etiqueta: 'IVA', tipo: 'DINERO', sql: 'c.total_iva' },
      {
        clave: 'retenciones',
        etiqueta: 'Retenciones',
        tipo: 'DINERO',
        sql: 'c.total_retenciones',
      },
      {
        clave: 'total',
        etiqueta: 'Total',
        tipo: 'DINERO',
        sql: 'c.total',
        filtro: 'RANGO',
        inicial: true,
      },
      {
        clave: 'neto',
        etiqueta: 'Neto a pagar',
        tipo: 'DINERO',
        sql: 'c.neto_a_pagar',
        inicial: true,
      },
      {
        clave: 'saldo',
        etiqueta: 'Saldo',
        tipo: 'DINERO',
        sql: 'c.neto_a_pagar - c.monto_pagado',
      },
    ],
  },

  // ── Cartera ───────────────────────────────────────────────────────────────
  // Es ventas con saldo, y aun así es un origen aparte: la pregunta «quién me
  // debe» no se contesta con el mismo reporte que «qué vendí». Quien arma una
  // cartera no quiere ver las pagadas, y si el origen fuera el mismo tendría
  // que acordarse de filtrarlas cada vez.
  CARTERA: {
    clave: 'CARTERA',
    etiqueta: 'Cartera',
    pregunta: 'Quién me debe, cuánto y desde cuándo',
    roles: ['DIRECTOR', 'CONTADOR', 'VENTAS', 'CAJA', 'CONSULTA'],
    desde: `venta_documento v
              JOIN tercero t ON t.id = v.tercero_id`,
    fecha: 'v.fecha',
    // Lo que se debe: facturas emitidas con saldo. Una cotización no es una
    // deuda y una anulada tampoco, y quien arma una cartera no debería tener
    // que acordarse de sacarlas cada vez.
    donde: `v.tipo <> 'COTIZACION' AND v.estado <> 'ANULADA' AND v.total - v.monto_pagado > 0`,
    columnas: [
      {
        clave: 'cliente',
        etiqueta: 'Cliente',
        tipo: 'TEXTO',
        sql: NOMBRE_TERCERO,
        filtro: 'LISTA',
        catalogo: 'TERCEROS_CLIENTE',
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'clienteDocumento',
        etiqueta: 'NIT o cédula',
        tipo: 'TEXTO',
        sql: DOCUMENTO_TERCERO,
      },
      {
        clave: 'fecha',
        etiqueta: 'Fecha',
        tipo: 'FECHA',
        sql: 'v.fecha',
        inicial: true,
      },
      {
        clave: 'numero',
        etiqueta: 'Número',
        tipo: 'TEXTO',
        sql: `CONCAT_WS('-', v.prefijo, v.consecutivo::text)`,
        inicial: true,
      },
      { clave: 'total', etiqueta: 'Total', tipo: 'DINERO', sql: 'v.total' },
      {
        clave: 'pagado',
        etiqueta: 'Pagado',
        tipo: 'DINERO',
        sql: 'v.monto_pagado',
      },
      {
        clave: 'saldo',
        etiqueta: 'Saldo',
        tipo: 'DINERO',
        sql: 'v.total - v.monto_pagado',
        filtro: 'RANGO',
        inicial: true,
      },
      // La edad de la deuda es lo que convierte una lista de saldos en cartera.
      // Se calcula contra hoy, no contra el fin del rango: quien la mira quiere
      // saber cuánto lleva esperando, no cuánto llevaba en una fecha pasada.
      {
        clave: 'dias',
        etiqueta: 'Días',
        tipo: 'CANTIDAD',
        sql: '(CURRENT_DATE - v.fecha)',
        filtro: 'RANGO',
        inicial: true,
        noSuma: true,
      },
      {
        clave: 'vencida',
        etiqueta: 'Vencida a 30 días',
        tipo: 'TEXTO',
        sql: `CASE WHEN (CURRENT_DATE - v.fecha) > 30 THEN 'Sí' ELSE 'No' END`,
        filtro: 'SI_NO',
        agrupable: true,
      },
    ],
  },

  // ── Inventario ────────────────────────────────────────────────────────────
  INVENTARIO: {
    clave: 'INVENTARIO',
    etiqueta: 'Inventario',
    pregunta: 'Qué entró y salió, y qué queda',
    roles: ['DIRECTOR', 'CONTADOR', 'INVENTARIO', 'CONSULTA'],
    desde: `producto_movimiento m
              JOIN producto p ON p.id = m.producto_id
              LEFT JOIN producto_categoria cat ON cat.id = p.categoria_id`,
    fecha: 'm.fecha',
    columnas: [
      {
        clave: 'fecha',
        etiqueta: 'Fecha',
        tipo: 'FECHA',
        sql: 'm.fecha',
        inicial: true,
        agrupable: true,
      },
      {
        clave: 'codigo',
        etiqueta: 'Código',
        tipo: 'TEXTO',
        sql: 'p.codigo',
        inicial: true,
      },
      {
        clave: 'producto',
        etiqueta: 'Producto',
        tipo: 'TEXTO',
        sql: 'p.nombre',
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'categoria',
        etiqueta: 'Categoría',
        tipo: 'TEXTO',
        sql: 'cat.nombre',
        filtro: 'LISTA',
        catalogo: 'CATEGORIAS_PRODUCTO',
        agrupable: true,
      },
      {
        clave: 'tipo',
        etiqueta: 'Movimiento',
        tipo: 'TEXTO',
        sql: 'm.tipo',
        filtro: 'LISTA',
        valores: TIPOS_MOVIMIENTO_INVENTARIO,
        agrupable: true,
      },
      { clave: 'motivo', etiqueta: 'Motivo', tipo: 'TEXTO', sql: 'm.motivo' },
      {
        clave: 'cantidad',
        etiqueta: 'Cantidad',
        tipo: 'CANTIDAD',
        sql: 'm.cantidad',
        filtro: 'RANGO',
        inicial: true,
      },
      {
        clave: 'costoUnitario',
        etiqueta: 'Costo unitario',
        tipo: 'DINERO',
        sql: 'm.costo_unitario',
        noSuma: true,
      },
      {
        clave: 'valor',
        etiqueta: 'Valor',
        tipo: 'DINERO',
        sql: 'm.valor_total',
        filtro: 'RANGO',
        inicial: true,
      },
      // Los saldos son el kardex: el estado *después* de ese movimiento. No
      // suman entre filas —sumar saldos no significa nada— y por eso van como
      // CANTIDAD y DINERO igual, pero nunca se eligen para agrupar.
      {
        clave: 'saldoCantidad',
        etiqueta: 'Saldo en unidades',
        tipo: 'CANTIDAD',
        sql: 'm.saldo_cantidad',
        noSuma: true,
      },
      {
        clave: 'saldoValor',
        etiqueta: 'Saldo en valor',
        tipo: 'DINERO',
        sql: 'm.saldo_valor',
        noSuma: true,
      },
    ],
  },

  // ── Tesorería ─────────────────────────────────────────────────────────────
  // Caja y bancos en un solo origen, unidos por UNION ALL. Son la misma
  // pregunta —«qué entró y salió de plata»— y separarlos obligaría a armar el
  // mismo reporte dos veces para después sumarlo a mano.
  TESORERIA: {
    clave: 'TESORERIA',
    etiqueta: 'Tesorería',
    pregunta: 'Qué dinero entró y salió, por dónde',
    roles: ['DIRECTOR', 'CONTADOR', 'CAJA', 'CONSULTA'],
    desde: `(
              SELECT cm.empresa_id, cm.fecha, cm.tipo, cm.valor, cm.concepto,
                     cm.tercero_id, 'Caja' AS ambito, cj.nombre AS cuenta
                FROM caja_movimiento cm
                JOIN caja cj ON cj.id = cm.caja_id
              UNION ALL
              -- Una cuenta bancaria no tiene nombre: tiene banco y número. Lo
              -- que un contador dice en voz alta es «la de Bancolombia, la que
              -- termina en 4471», así que eso es lo que va en la columna.
              SELECT bm.empresa_id, bm.fecha, bm.tipo, bm.valor, bm.concepto,
                     bm.tercero_id, 'Banco' AS ambito,
                     CONCAT(cb.banco, ' ···', RIGHT(cb.numero_cuenta, 4)) AS cuenta
                FROM banco_movimiento bm
                JOIN cuenta_bancaria cb ON cb.id = bm.cuenta_bancaria_id
            ) mv
            LEFT JOIN tercero t ON t.id = mv.tercero_id`,
    fecha: 'mv.fecha',
    columnas: [
      {
        clave: 'fecha',
        etiqueta: 'Fecha',
        tipo: 'FECHA',
        sql: 'mv.fecha',
        inicial: true,
        agrupable: true,
      },
      {
        clave: 'ambito',
        etiqueta: 'Caja o banco',
        tipo: 'TEXTO',
        sql: 'mv.ambito',
        filtro: 'LISTA',
        valores: ['Caja', 'Banco'],
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'cuenta',
        etiqueta: 'Cuenta',
        tipo: 'TEXTO',
        sql: 'mv.cuenta',
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'tipo',
        etiqueta: 'Movimiento',
        tipo: 'TEXTO',
        sql: 'mv.tipo',
        filtro: 'LISTA',
        valores: TIPOS_MOVIMIENTO_TESORERIA,
        agrupable: true,
      },
      {
        clave: 'concepto',
        etiqueta: 'Concepto',
        tipo: 'TEXTO',
        sql: 'mv.concepto',
        inicial: true,
      },
      {
        clave: 'tercero',
        etiqueta: 'Tercero',
        tipo: 'TEXTO',
        sql: NOMBRE_TERCERO,
        agrupable: true,
      },
      {
        clave: 'valor',
        etiqueta: 'Valor',
        tipo: 'DINERO',
        sql: 'mv.valor',
        filtro: 'RANGO',
        inicial: true,
      },
    ],
  },

  // ── Contabilidad ──────────────────────────────────────────────────────────
  CONTABILIDAD: {
    clave: 'CONTABILIDAD',
    etiqueta: 'Contabilidad',
    pregunta: 'El auxiliar de cualquier cuenta, tercero o centro de costo',
    roles: ['DIRECTOR', 'CONTADOR', 'CONSULTA'],
    // `al.cuenta_id` apunta a `empresa_cuenta`, **no a `cuenta_puc`**:
    // `cuenta_puc` es el catálogo oficial, sin `id` y sin empresa; el plan de
    // cuentas de cada empresa vive en `empresa_cuenta`, que es lo que un asiento
    // referencia. La unión va por la pareja `(cuenta_id, empresa_id)`, que es
    // como está declarada la llave foránea.
    desde: `asiento_linea al
              JOIN asiento a ON a.id = al.asiento_id
              JOIN empresa_cuenta ec
                ON ec.id = al.cuenta_id AND ec.empresa_id = al.empresa_id
              LEFT JOIN tercero t ON t.id = al.tercero_id
              LEFT JOIN empresa_centro_costo cc ON cc.id = al.centro_costo_id`,
    fecha: 'a.fecha',
    columnas: [
      {
        clave: 'fecha',
        etiqueta: 'Fecha',
        tipo: 'FECHA',
        sql: 'a.fecha',
        inicial: true,
        agrupable: true,
      },
      {
        clave: 'asiento',
        etiqueta: 'Asiento',
        tipo: 'TEXTO',
        sql: 'a.numero',
        inicial: true,
      },
      {
        clave: 'estado',
        etiqueta: 'Estado',
        tipo: 'TEXTO',
        sql: 'a.estado',
        filtro: 'LISTA',
        valores: ['REGISTRADO', 'ANULADO'],
        agrupable: true,
      },
      {
        clave: 'cuenta',
        etiqueta: 'Cuenta',
        tipo: 'TEXTO',
        sql: 'ec.codigo',
        filtro: 'LISTA',
        catalogo: 'CUENTAS_PUC',
        agrupable: true,
        inicial: true,
      },
      {
        clave: 'cuentaNombre',
        etiqueta: 'Nombre de la cuenta',
        tipo: 'TEXTO',
        sql: 'ec.nombre',
        agrupable: true,
      },
      {
        clave: 'tercero',
        etiqueta: 'Tercero',
        tipo: 'TEXTO',
        sql: NOMBRE_TERCERO,
        agrupable: true,
      },
      {
        clave: 'centroCosto',
        etiqueta: 'Centro de costo',
        tipo: 'TEXTO',
        // Con el código: dos centros pueden llamarse igual en sedes distintas.
        sql: `cc.codigo || ' · ' || cc.nombre`,
        filtro: 'LISTA',
        catalogo: 'CENTROS_COSTO',
        agrupable: true,
      },
      {
        clave: 'centroAgrupador',
        etiqueta: 'Centro agrupador',
        tipo: 'TEXTO',
        sql: `(SELECT p.codigo || ' · ' || p.nombre FROM empresa_centro_costo p
                WHERE p.id = cc.padre_id)`,
        filtro: 'LISTA',
        catalogo: 'CENTROS_COSTO',
        agrupable: true,
      },
      {
        clave: 'tipoCentro',
        etiqueta: 'Tipo de centro',
        tipo: 'TEXTO',
        sql: `CASE cc.tipo WHEN 'PRODUCTIVO' THEN 'Productivo'
                         WHEN 'APOYO' THEN 'De apoyo'
                         WHEN 'ADMINISTRATIVO' THEN 'Administrativo' END`,
        filtro: 'LISTA',
        valores: ['Productivo', 'De apoyo', 'Administrativo'],
        agrupable: true,
      },
      {
        clave: 'sedeCentro',
        etiqueta: 'Sede del centro',
        tipo: 'TEXTO',
        sql: '(SELECT s.nombre FROM empresa_sede s WHERE s.id = cc.sede_id)',
        filtro: 'LISTA',
        catalogo: 'SEDES',
        agrupable: true,
      },
      { clave: 'glosa', etiqueta: 'Glosa', tipo: 'TEXTO', sql: 'a.glosa' },
      {
        clave: 'detalle',
        etiqueta: 'Detalle',
        tipo: 'TEXTO',
        sql: 'al.detalle',
        inicial: true,
      },
      {
        clave: 'debito',
        etiqueta: 'Débito',
        tipo: 'DINERO',
        sql: 'al.debito',
        filtro: 'RANGO',
        inicial: true,
      },
      {
        clave: 'credito',
        etiqueta: 'Crédito',
        tipo: 'DINERO',
        sql: 'al.credito',
        filtro: 'RANGO',
        inicial: true,
      },
      {
        clave: 'baseGravable',
        etiqueta: 'Base gravable',
        tipo: 'DINERO',
        sql: 'al.base_gravable',
      },
    ],
  },
};

/** Los orígenes que un rol puede correr. Lo que no puede ver, no se le ofrece. */
export function origenesPara(roles: readonly RolCodigo[]): Origen[] {
  return Object.values(ORIGENES).filter((o) =>
    o.roles.some((r) => roles.includes(r)),
  );
}

/**
 * La columna de un origen, o `undefined` si no existe.
 *
 * **Todo lo que llega del cliente pasa por acá.** Una clave que no esté en el
 * catálogo no tiene `sql`, y sin `sql` no hay nada que interpolar: es la única
 * puerta, y por eso no se puede reemplazar por un `find` suelto en el servicio.
 */
export function columnaDe(
  origen: ClaveOrigen,
  clave: string,
): Columna | undefined {
  return ORIGENES[origen].columnas.find((c) => c.clave === clave);
}
