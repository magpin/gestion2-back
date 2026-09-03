import {
  CONDICION_OPUESTA,
  CONDICION_POR_RESPONSABILIDAD_RUT,
} from './responsabilidades-rut';
import { INGRESO_POR_SECCION } from './secciones-ciiu';

/**
 * Qué cuentas necesita ESTA empresa, deducido de sus documentos.
 *
 * No hay plantillas ni "plan típico de comercio". Cada cuenta propuesta nombra el
 * hecho que la justifica —una responsabilidad del RUT, la forma jurídica de la
 * Cámara de Comercio, la tarifa del acuerdo municipal de ICA— y si el hecho no
 * está declarado la cuenta no se propone: se devuelve como faltante, diciendo qué
 * dato falta y dónde cargarlo. Un plan de cuentas sembrado a ciegas obliga después
 * a borrar la mitad, y en contabilidad borrar cuentas con movimiento no es opción.
 *
 * La única excepción es el bloque BASE: son las cuentas que toda contabilidad usa
 * sin importar qué diga ningún papel —efectivo, cartera, proveedores, el arriendo,
 * la papelería—. Ahí el `porque` lo dice así, y no finge derivar de un documento.
 *
 * Los bloques SUMAN y nunca restan. Que el sector marcado agregue el inventario no
 * quita las cuentas que respalda el RUT, igual que dice el comentario de
 * `empresa_sector`. Si dos bloques piden la misma cuenta, se propone una sola vez
 * con el motivo del primero que la pidió.
 *
 * Está separado del acceso a datos igual que `estado-configuracion.reglas`: es la
 * parte que hay que poder probar sin levantar una base.
 */

/**
 * De dónde sale cada cuenta. La UI agrupa por esto: trece cuentas en fila sin
 * separar no dejan ver que seis vienen del RUT y tres de haber dicho que hay
 * empleados.
 */
export type Bloque = 'BASE' | 'PATRIMONIO' | 'IMPUESTOS' | 'GIRO' | 'OPERACION';

export interface CuentaSugerida {
  codigo: string;
  nombre: string;
  /** Ancestro en el Decreto 2650 contra el que se ancla. */
  codigoPuc: string;
  /** false = agrupa y no recibe asientos. */
  esAuxiliar: boolean;
  exigeTercero: boolean;
  exigeCentroCosto: boolean;
  exigeBaseGravable: boolean;
  /** El hecho declarado que hace falta esta cuenta. Va a la UI tal cual. */
  porque: string;
  bloque: Bloque;
  /**
   * true = el decreto deja libre la numeración de este nivel y el código es una
   * propuesta, no una norma. El usuario puede cambiarlo dentro del rango.
   */
  sugerido: boolean;
  /** El rango que el decreto deja libre, cuando `sugerido`. */
  rango?: string;
  /**
   * true = hay que elegir la subcuenta según la actividad, y el sistema no puede
   * hacerlo por vos. Se propone la cuenta de agrupación y ahí termina.
   */
  requiereEleccion?: boolean;
}

/** Un dato sin declarar que impide proponer algo. Nombra qué y dónde cargarlo. */
export interface HechoFaltante {
  hecho: string;
  etiqueta: string;
  /** Qué queda sin proponer por esto. */
  impide: string;
  /** El paso del asistente donde se carga. */
  paso: string;
}

export interface Sugerencia {
  cuentas: CuentaSugerida[];
  faltantes: HechoFaltante[];
}

export interface HechosPlan {
  /** Decide la forma del patrimonio. Una natural no emite acciones. */
  tipoPersona: 'JURIDICA' | 'NATURAL';
  /** Casilla 63 del RUT. '12' es S.A.S. null = jurídica que aún no la cargó. */
  formaAsociativa: string | null;
  /** COMERCIO / SERVICIOS / MANUFACTURA. Suman entre sí. */
  sectores: string[];
  /** Condiciones en el vocabulario del software. */
  regimenesVigentes: string[];
  /**
   * Casilla 53 del RUT, vigentes y ya resueltas contra `codigo_reemplazo`: el 11
   * de un RUT viejo llega acá convertido en 48.
   */
  responsabilidadesRut: number[];
  /** Lo que ningún documento declara: empleados, activos, crédito, caja menor. */
  hechosOperativos: string[];
  actividadPrincipal: {
    codigoCiiu: string;
    seccionCiiu: string | null;
    divisionCiiu: string | null;
    tarifaIcaPorMil: number | null;
  } | null;
  manejaCentroCosto: boolean;
  sedes: Array<{ codigo: string; nombre: string }>;
  /** Lo que la empresa ya tiene. Nada que ya exista se vuelve a proponer. */
  codigosExistentes: string[];
}

type Entrada = Omit<
  CuentaSugerida,
  | 'esAuxiliar'
  | 'exigeTercero'
  | 'exigeCentroCosto'
  | 'exigeBaseGravable'
  | 'sugerido'
> &
  Partial<CuentaSugerida>;

const cuenta = (c: Entrada): CuentaSugerida => ({
  esAuxiliar: true,
  exigeTercero: false,
  exigeCentroCosto: false,
  exigeBaseGravable: false,
  sugerido: false,
  ...c,
});

/**
 * Una cuenta de seis dígitos dentro de un tramo que el decreto deja libre.
 *
 * El código es propuesta, no norma: el decreto llega hasta la cuenta de cuatro y
 * de ahí para abajo numera quien lleva la contabilidad. Por eso se ancla al padre
 * de cuatro y se marca `sugerido` con el rango completo, para que la UI pueda
 * decir "podés cambiarlo por cualquiera entre 220501 y 220598".
 */
const libre = (
  madre: string,
  sufijo: string,
  c: Omit<Entrada, 'codigo' | 'codigoPuc'>,
): CuentaSugerida =>
  cuenta({
    ...c,
    codigo: `${madre}${sufijo}`,
    codigoPuc: madre,
    sugerido: true,
    rango: `${madre}01 a ${madre}98`,
  });

/** Las clases 4 a 7 son de resultado; son las únicas que se costean. */
const esDeResultado = (codigo: string): boolean =>
  ['4', '5', '6', '7'].includes(codigo[0] ?? '');

// ---------------------------------------------------------------------------
// Bloque BASE — lo que toda contabilidad usa, sin depender de ningún documento
// ---------------------------------------------------------------------------

/**
 * No se derivan de nada porque no hay nada de donde derivarlas: ningún documento
 * dice que la empresa compra papelería, pero toda empresa compra papelería y
 * ninguna contabilidad puede registrar el pago sin la cuenta.
 *
 * La lista es corta a propósito. Es el arranque cómodo, no el plan completo: lo
 * que falte se agrega del catálogo, que está a un clic.
 */
function bloqueBase(h: HechosPlan): CuentaSugerida[] {
  const lista: CuentaSugerida[] = [
    cuenta({
      codigo: '110505',
      nombre: 'Caja general',
      codigoPuc: '110505',
      bloque: 'BASE',
      porque: 'Toda contabilidad registra efectivo.',
    }),
    cuenta({
      codigo: '111005',
      nombre: 'Bancos moneda nacional',
      codigoPuc: '111005',
      bloque: 'BASE',
      porque: 'Toda contabilidad registra movimientos bancarios.',
    }),
    cuenta({
      codigo: '130505',
      nombre: 'Clientes nacionales',
      codigoPuc: '130505',
      exigeTercero: true,
      bloque: 'BASE',
      porque: 'Toda venta a crédito necesita cartera con tercero identificado.',
    }),
    // La retención que a la empresa le practican es un anticipo suyo, y existe
    // aunque no sea agente retenedor: se la practican por vender.
    cuenta({
      codigo: '135515',
      nombre: 'Retención en la fuente que nos practican',
      codigoPuc: '135515',
      bloque: 'BASE',
      porque:
        'Toda empresa que factura recibe retenciones, que son anticipo de su renta.',
    }),
    cuenta({
      codigo: '138095',
      nombre: 'Otras cuentas por cobrar',
      codigoPuc: '138095',
      exigeTercero: true,
      bloque: 'BASE',
      porque: 'El cajón de lo que se cobra y no es cartera de ventas.',
    }),
    libre('2205', '05', {
      nombre: 'Proveedores nacionales',
      exigeTercero: true,
      bloque: 'BASE',
      porque:
        'Toda compra a crédito necesita cuentas por pagar con tercero identificado.',
    }),
    cuenta({
      codigo: '233550',
      nombre: 'Servicios públicos por pagar',
      codigoPuc: '233550',
      exigeTercero: true,
      bloque: 'BASE',
      porque: 'El recibo llega antes de pagarse, y ese lapso es un pasivo.',
    }),
    cuenta({
      codigo: '233540',
      nombre: 'Arrendamientos por pagar',
      codigoPuc: '233540',
      exigeTercero: true,
      bloque: 'BASE',
      porque:
        'El arriendo se causa el mes que se ocupa el local, se pague cuando se pague.',
    }),
    cuenta({
      codigo: '233595',
      nombre: 'Otros costos y gastos por pagar',
      codigoPuc: '233595',
      exigeTercero: true,
      bloque: 'BASE',
      porque: 'El cajón de lo causado y no pagado que no cabe en las otras.',
    }),
    cuenta({
      codigo: '511005',
      nombre: 'Honorarios',
      codigoPuc: '511005',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque:
        'Toda empresa obligada a llevar contabilidad le paga a quien se la lleva.',
    }),
    cuenta({
      codigo: '512005',
      nombre: 'Arrendamientos - construcciones y edificaciones',
      codigoPuc: '512005',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque:
        'El local donde opera la empresa: propio o arrendado, alguno de los dos es.',
    }),
    cuenta({
      codigo: '513525',
      nombre: 'Acueducto y alcantarillado',
      codigoPuc: '513525',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque: 'Servicio público del local.',
    }),
    cuenta({
      codigo: '513530',
      nombre: 'Energía eléctrica',
      codigoPuc: '513530',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque: 'Servicio público del local.',
    }),
    cuenta({
      codigo: '513535',
      nombre: 'Teléfono',
      codigoPuc: '513535',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque: 'Servicio público del local: teléfono e internet.',
    }),
    cuenta({
      codigo: '514010',
      nombre: 'Gastos legales - registro mercantil',
      codigoPuc: '514010',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque:
        'La matrícula mercantil se renueva todos los años y eso es un gasto.',
    }),
    cuenta({
      codigo: '519525',
      nombre: 'Elementos de aseo y cafetería',
      codigoPuc: '519525',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque: 'Gasto menor que aparece todos los meses en cualquier negocio.',
    }),
    cuenta({
      codigo: '519530',
      nombre: 'Útiles, papelería y fotocopias',
      codigoPuc: '519530',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque: 'Gasto menor que aparece todos los meses en cualquier negocio.',
    }),
    cuenta({
      codigo: '530505',
      nombre: 'Gastos bancarios',
      codigoPuc: '530505',
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'BASE',
      porque:
        'La cuota de manejo y las comisiones del banco donde está la plata.',
    }),
  ];

  // Una caja por sede: el arqueo se hace por punto de venta, y un solo saldo
  // junto no se puede cuadrar contra la caja física de cada local.
  //
  // El consecutivo es posicional y de dos dígitos, no el código de la sede: ese
  // lo escribe el usuario y puede ser '001' o 'PPAL', lo que daría auxiliares de
  // largo distinto colgando de la misma cuenta. Un plan de cuentas se lee en
  // columna y los códigos desparejos lo vuelven ilegible.
  h.sedes.forEach((sede, i) => {
    lista.push(
      cuenta({
        codigo: `110505${String(i + 1).padStart(2, '0')}`,
        nombre: `Caja - ${sede.nombre}`,
        codigoPuc: '110505',
        bloque: 'BASE',
        porque: `Tenés registrada la sede "${sede.nombre}", y el arqueo se hace por sede.`,
        sugerido: true,
      }),
    );
  });

  return lista;
}

// ---------------------------------------------------------------------------
// Bloque PATRIMONIO — sale de la forma jurídica
// ---------------------------------------------------------------------------

/**
 * Sin patrimonio no hay balance que cuadre, así que este bloque nunca sale vacío.
 * Lo que cambia es la forma: una persona natural no emite acciones ni constituye
 * reserva legal, y exigirle esas cuentas sería inventarle una obligación que la
 * ley no le pone.
 *
 * Las formas asociativas son la casilla 63 del RUT. 12 es la S.A.S., que es lo
 * que constituye casi todo el mundo hoy; 04 y 05 son las anónimas.
 */
const FORMAS_POR_ACCIONES = new Set(['04', '05', '12']);

function bloquePatrimonio(h: HechosPlan): CuentaSugerida[] {
  const lista: CuentaSugerida[] = [];

  if (h.tipoPersona === 'NATURAL') {
    // El decreto le da cuenta propia y no la subdivide: el comerciante no tiene
    // capital suscrito ni socios a quienes cobrarles la suscripción.
    lista.push(
      libre('3130', '05', {
        nombre: 'Capital de personas naturales',
        bloque: 'PATRIMONIO',
        porque:
          'Sos persona natural: tu capital va en una sola cuenta, sin acciones ni reservas.',
      }),
    );
  } else if (
    h.formaAsociativa !== null &&
    FORMAS_POR_ACCIONES.has(h.formaAsociativa)
  ) {
    lista.push(
      cuenta({
        codigo: '310505',
        nombre: 'Capital autorizado',
        codigoPuc: '310505',
        bloque: 'PATRIMONIO',
        porque:
          'Sociedad por acciones: el capital autorizado es el que dice la escritura.',
      }),
      cuenta({
        codigo: '310510',
        nombre: 'Capital por suscribir (DB)',
        codigoPuc: '310510',
        bloque: 'PATRIMONIO',
        porque: 'Contrapartida del autorizado: lo que todavía nadie suscribió.',
      }),
      cuenta({
        codigo: '320505',
        nombre: 'Prima en colocación de acciones',
        codigoPuc: '320505',
        bloque: 'PATRIMONIO',
        porque:
          'Sociedad por acciones: lo pagado por encima del valor nominal va acá.',
      }),
      cuenta({
        codigo: '330505',
        nombre: 'Reserva legal',
        codigoPuc: '330505',
        bloque: 'PATRIMONIO',
        porque:
          'La sociedad comercial aparta el 10% de la utilidad hasta llegar al 50% del capital.',
      }),
    );
  } else {
    // Jurídica sin forma cargada, o de las que no emiten acciones (limitada,
    // colectiva, en comandita simple). El aporte social es la cuota de cada socio.
    lista.push(
      cuenta({
        codigo: '311505',
        nombre: 'Aportes sociales - cuotas o partes de interés social',
        codigoPuc: '311505',
        exigeTercero: true,
        bloque: 'PATRIMONIO',
        porque:
          'Sociedad de personas: el capital son las cuotas de cada socio.',
      }),
      cuenta({
        codigo: '330505',
        nombre: 'Reserva legal',
        codigoPuc: '330505',
        bloque: 'PATRIMONIO',
        porque:
          'La sociedad comercial aparta el 10% de la utilidad hasta llegar al 50% del capital.',
      }),
    );
  }

  // El resultado es de toda empresa, con cualquier forma jurídica: sin estas
  // cuatro el cierre del ejercicio no tiene contra qué cancelar las clases 4 a 6.
  lista.push(
    cuenta({
      codigo: '360505',
      nombre: 'Utilidad del ejercicio',
      codigoPuc: '360505',
      bloque: 'PATRIMONIO',
      porque:
        'El cierre del ejercicio necesita dónde dejar el resultado del período.',
    }),
    cuenta({
      codigo: '361005',
      nombre: 'Pérdida del ejercicio',
      codigoPuc: '361005',
      bloque: 'PATRIMONIO',
      porque:
        'El resultado del período puede ser negativo, y el decreto le da cuenta aparte.',
    }),
    libre('3705', '05', {
      nombre: 'Utilidades acumuladas de ejercicios anteriores',
      bloque: 'PATRIMONIO',
      porque: 'Lo que no se distribuyó al cierre pasa acá y se arrastra.',
    }),
    libre('3710', '05', {
      nombre: 'Pérdidas acumuladas de ejercicios anteriores',
      bloque: 'PATRIMONIO',
      porque: 'Las pérdidas de años anteriores se arrastran hasta compensarse.',
    }),
  );

  return lista;
}

// ---------------------------------------------------------------------------
// Bloque IMPUESTOS — sale del RUT, y solo del RUT
// ---------------------------------------------------------------------------

/**
 * Acá está el caso que motiva todo el proceso: la empresa no responsable de IVA
 * NO recibe las cuentas de IVA. No es que se borren después — es que nunca se
 * proponen. La ausencia es el resultado correcto.
 *
 * Sin ninguna condición declarada no se propone ni una cuenta de impuestos:
 * proponer IVA a quien no lo cobra es sembrar una cuenta que nunca se usa, y no
 * proponérselo a quien sí lo cobra es peor.
 */
function bloqueImpuestos(
  h: HechosPlan,
  condiciones: Set<string>,
): {
  cuentas: CuentaSugerida[];
  faltantes: HechoFaltante[];
} {
  const cuentas: CuentaSugerida[] = [];
  const faltantes: HechoFaltante[] = [];
  const tiene = (c: string) => condiciones.has(c);
  const centro = h.manejaCentroCosto;

  if (condiciones.size === 0) {
    faltantes.push({
      hecho: 'REGIMEN_TRIBUTARIO',
      etiqueta: 'Condición tributaria',
      impide:
        'No se puede proponer ninguna cuenta de impuestos: IVA, retención en la fuente, reteIVA ni ICA. Cargá la casilla 53 del RUT o la condición tributaria.',
      paso: 'SITUACION_LEGAL',
    });
    return { cuentas, faltantes };
  }

  // Responsable y no responsable a la vez no es un caso a resolver por defecto:
  // es un dato roto. Elegir una de las dos por nuestra cuenta sembraría cuentas
  // de IVA en una empresa que no lo cobra, o se las negaría a una que sí.
  // `condiciones` es un conjunto de texto porque une dos fuentes; el mapa está
  // tipado contra el enum. La lectura se hace por índice de texto acá y no se
  // afloja el tipo del mapa, que es el que vale.
  const opuestaDe = (c: string): string | undefined =>
    (CONDICION_OPUESTA as Record<string, string | undefined>)[c];

  const contradice = [...condiciones].find((c) => {
    const otra = opuestaDe(c);
    return otra !== undefined && condiciones.has(otra);
  });

  if (contradice !== undefined) {
    const legible = (c: string) => c.replace(/_/g, ' ').toLowerCase();
    faltantes.push({
      hecho: 'CONDICION_CONTRADICTORIA',
      etiqueta: 'Condiciones tributarias que se contradicen',
      impide: `La empresa figura a la vez como ${legible(contradice)} y como ${legible(opuestaDe(contradice)!)}. Mientras no se cierre una de las dos, no se propone ninguna cuenta de impuestos.`,
      paso: 'SITUACION_LEGAL',
    });
    return { cuentas, faltantes };
  }

  if (tiene('RESPONSABLE_IVA')) {
    cuentas.push(
      libre('2408', '05', {
        nombre: 'IVA generado',
        exigeBaseGravable: true,
        bloque: 'IMPUESTOS',
        porque:
          'Sos responsable de IVA: las ventas gravadas generan IVA por pagar.',
      }),
      libre('2408', '10', {
        nombre: 'IVA descontable',
        exigeBaseGravable: true,
        bloque: 'IMPUESTOS',
        porque: 'Sos responsable de IVA: el IVA de las compras se descuenta.',
      }),
    );
  }

  // El impuesto al consumo es de 2012 y el decreto es de 1993: no tiene cuenta
  // propia. Va en 'otros impuestos por pagar', que el decreto deja en rango libre
  // justamente para los que iban a venir después.
  if (tiene('RESPONSABLE_INC')) {
    cuentas.push(
      libre('2495', '05', {
        nombre: 'Impuesto nacional al consumo por pagar',
        exigeBaseGravable: true,
        bloque: 'IMPUESTOS',
        porque:
          'Sos responsable de impuesto al consumo: se cobra en la venta y se declara aparte del IVA.',
      }),
    );
  }

  // Las seis subcuentas de retefuente son los conceptos que practica cualquier
  // agente retenedor. Se proponen juntas porque retener por compras y no por
  // servicios no es una decisión: es olvidarse de una.
  if (
    tiene('AGENTE_RETENEDOR_RENTA') ||
    tiene('AUTORRETENEDOR_RENTA') ||
    tiene('GRAN_CONTRIBUYENTE')
  ) {
    const porque = tiene('GRAN_CONTRIBUYENTE')
      ? 'Sos gran contribuyente: retenés en la fuente sobre los pagos que hacés.'
      : 'Sos agente de retención de renta: lo retenido se le debe a la DIAN.';

    const conceptos: Array<[string, string]> = [
      ['15', 'Retención en la fuente - honorarios'],
      ['20', 'Retención en la fuente - comisiones'],
      ['25', 'Retención en la fuente - servicios'],
      ['30', 'Retención en la fuente - arrendamientos'],
      ['40', 'Retención en la fuente - compras'],
      ['70', 'Retención en la fuente - otros conceptos'],
    ];

    for (const [sufijo, nombre] of conceptos) {
      cuentas.push(
        cuenta({
          codigo: `2365${sufijo}`,
          nombre,
          codigoPuc: `2365${sufijo}`,
          exigeTercero: true,
          exigeBaseGravable: true,
          bloque: 'IMPUESTOS',
          porque,
        }),
      );
    }
  }

  if (tiene('AUTORRETENEDOR_RENTA')) {
    cuentas.push(
      cuenta({
        codigo: '236575',
        nombre: 'Autorretenciones',
        codigoPuc: '236575',
        exigeBaseGravable: true,
        bloque: 'IMPUESTOS',
        porque:
          'Sos autorretenedor: te retenés a vos mismo sobre tus propios ingresos.',
      }),
    );
  }

  if (tiene('AGENTE_RETENEDOR_IVA')) {
    cuentas.push(
      libre('2367', '05', {
        nombre: 'IVA retenido',
        exigeTercero: true,
        exigeBaseGravable: true,
        bloque: 'IMPUESTOS',
        porque: 'Sos agente de retención de IVA.',
      }),
    );
  }

  if (tiene('AGENTE_RETENEDOR_ICA')) {
    cuentas.push(
      libre('2368', '05', {
        nombre: 'ICA retenido',
        exigeTercero: true,
        exigeBaseGravable: true,
        bloque: 'IMPUESTOS',
        porque: 'Sos agente de retención de ICA.',
      }),
    );
  }

  // El régimen simple sustituye la renta, el ICA y varios más en una sola
  // declaración: provisionarle renta sería provisionar un impuesto que no paga.
  if (!tiene('REGIMEN_SIMPLE')) {
    cuentas.push(
      cuenta({
        codigo: '240405',
        nombre: 'Impuesto de renta por pagar',
        codigoPuc: '240405',
        bloque: 'IMPUESTOS',
        porque:
          'Estás en régimen ordinario: la renta del ejercicio se provisiona.',
      }),
    );
  }

  // El ICA es municipal y se liquida sobre la tarifa de la actividad. Si la
  // tarifa no está cargada, no hay con qué liquidarlo — ni el gasto ni el pasivo.
  if (
    h.actividadPrincipal !== null &&
    h.actividadPrincipal.tarifaIcaPorMil !== null
  ) {
    const tarifa = h.actividadPrincipal.tarifaIcaPorMil;
    cuentas.push(
      cuenta({
        codigo: '511505',
        nombre: 'Impuesto de industria y comercio',
        codigoPuc: '511505',
        exigeCentroCosto: centro,
        bloque: 'IMPUESTOS',
        porque: `Tenés tarifa de ICA cargada (${tarifa} por mil).`,
      }),
      cuenta({
        codigo: '241205',
        nombre: 'Industria y comercio por pagar - vigencia fiscal corriente',
        codigoPuc: '241205',
        bloque: 'IMPUESTOS',
        porque:
          'Contrapartida del gasto de ICA: lo liquidado se le debe al municipio.',
      }),
    );
  }

  return { cuentas, faltantes };
}

// ---------------------------------------------------------------------------
// Bloque GIRO — sale del sector, que confirma el objeto social
// ---------------------------------------------------------------------------

/**
 * Los sectores SUMAN. El taller que vende repuestos y cobra mano de obra marca
 * los dos y recibe las cuentas de los dos: inventario para lo que revende y
 * herramienta para lo que repara.
 *
 * El ingreso y el costo no salen de acá sino de la CIIU, que es más precisa: el
 * sector dice "comercio", la CIIU dice cuál de las veinte cuentas del grupo 41.
 */
function bloqueGiro(h: HechosPlan): CuentaSugerida[] {
  const lista: CuentaSugerida[] = [];
  const centro = h.manejaCentroCosto;

  if (h.sectores.includes('COMERCIO')) {
    lista.push(
      libre('1435', '01', {
        nombre: 'Mercancías no fabricadas por la empresa',
        bloque: 'GIRO',
        porque:
          'Marcaste COMERCIO: lo que se revende se inventaría antes de venderse.',
      }),
    );
  }

  if (h.sectores.includes('MANUFACTURA')) {
    lista.push(
      libre('1405', '01', {
        nombre: 'Materias primas',
        bloque: 'GIRO',
        porque:
          'Marcaste MANUFACTURA: lo que se transforma entra como materia prima.',
      }),
      libre('1410', '01', {
        nombre: 'Productos en proceso',
        bloque: 'GIRO',
        porque:
          'Marcaste MANUFACTURA: lo que está a medio fabricar tiene costo acumulado.',
      }),
      cuenta({
        codigo: '143005',
        nombre: 'Productos manufacturados',
        codigoPuc: '143005',
        bloque: 'GIRO',
        porque:
          'Marcaste MANUFACTURA: lo terminado y no vendido se inventaría.',
      }),
    );
  }

  if (h.sectores.includes('SERVICIOS')) {
    lista.push(
      cuenta({
        codigo: '152410',
        nombre: 'Maquinaria y equipo - herramienta',
        codigoPuc: '152410',
        bloque: 'GIRO',
        porque:
          'Marcaste SERVICIOS: la herramienta con la que se presta el servicio es un activo.',
      }),
      cuenta({
        codigo: '159245',
        nombre: 'Depreciación acumulada - maquinaria y equipo',
        codigoPuc: '159245',
        bloque: 'GIRO',
        porque: 'Contrapartida de la herramienta: se deprecia con el uso.',
      }),
      cuenta({
        codigo: '516010',
        nombre: 'Depreciación - maquinaria y equipo',
        codigoPuc: '516010',
        exigeCentroCosto: centro,
        bloque: 'GIRO',
        porque: 'El gasto del período por la herramienta que se desgasta.',
      }),
    );
  }

  return lista;
}

// ---------------------------------------------------------------------------
// Bloque OPERACIÓN — lo que ningún documento declara
// ---------------------------------------------------------------------------

/**
 * Ningún papel dice si la empresa tiene empleados. Estas cuatro respuestas son
 * la única fuente posible, y por eso viven en `empresa_hecho_operativo` y no se
 * deducen de nada.
 *
 * No responder no es un error ni un faltante: una empresa de un solo dueño sin
 * empleados, sin crédito y sin activos es perfectamente normal, y su plan
 * correcto es el que no tiene ninguna de estas cuentas.
 */
function bloqueOperacion(h: HechosPlan): CuentaSugerida[] {
  const lista: CuentaSugerida[] = [];
  const tiene = (x: string) => h.hechosOperativos.includes(x);
  const centro = h.manejaCentroCosto;

  if (tiene('MANEJA_CAJA_MENOR')) {
    lista.push(
      cuenta({
        codigo: '110510',
        nombre: 'Caja menor',
        codigoPuc: '110510',
        bloque: 'OPERACION',
        porque: 'Declaraste que manejás fondo fijo de caja menor.',
      }),
    );
  }

  if (tiene('TIENE_EMPLEADOS')) {
    lista.push(
      // Pasivo laboral. Las prestaciones se causan mes a mes aunque se paguen
      // una vez al año: sin estas cuentas el balance de junio miente.
      libre('2505', '05', {
        nombre: 'Salarios por pagar',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: la nómina causada y no pagada es un pasivo.',
      }),
      cuenta({
        codigo: '251010',
        nombre: 'Cesantías consolidadas - Ley 50 de 1990',
        codigoPuc: '251010',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: las cesantías se consolidan cada año.',
      }),
      libre('2515', '05', {
        nombre: 'Intereses sobre cesantías',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: los intereses a las cesantías se pagan en enero.',
      }),
      libre('2520', '05', {
        nombre: 'Prima de servicios',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: la prima se causa mes a mes y se paga semestral.',
      }),
      cuenta({
        codigo: '252501',
        nombre: 'Vacaciones consolidadas por empleado',
        codigoPuc: '252501',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: las vacaciones se provisionan por empleado.',
      }),
      cuenta({
        codigo: '236505',
        nombre: 'Retención en la fuente - salarios y pagos laborales',
        codigoPuc: '236505',
        exigeTercero: true,
        exigeBaseGravable: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: al salario por encima del tope se le retiene.',
      }),
      cuenta({
        codigo: '237005',
        nombre: 'Retenciones y aportes de nómina',
        codigoPuc: '237005',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: lo descontado al trabajador se le gira a la EPS y al fondo.',
      }),

      // Gasto laboral. Todas de administración: dividir entre administración y
      // ventas es una decisión de la empresa, no del sistema.
      cuenta({
        codigo: '510506',
        nombre: 'Gastos de personal - sueldos',
        codigoPuc: '510506',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: el sueldo es gasto del período.',
      }),
      cuenta({
        codigo: '510527',
        nombre: 'Gastos de personal - auxilio de transporte',
        codigoPuc: '510527',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: el auxilio va aparte del sueldo.',
      }),
      cuenta({
        codigo: '510530',
        nombre: 'Gastos de personal - cesantías',
        codigoPuc: '510530',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque: 'Contrapartida de la consolidación de cesantías.',
      }),
      cuenta({
        codigo: '510533',
        nombre: 'Gastos de personal - intereses sobre cesantías',
        codigoPuc: '510533',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque: 'Contrapartida de los intereses a las cesantías.',
      }),
      cuenta({
        codigo: '510536',
        nombre: 'Gastos de personal - prima de servicios',
        codigoPuc: '510536',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque: 'Contrapartida de la prima de servicios.',
      }),
      cuenta({
        codigo: '510539',
        nombre: 'Gastos de personal - vacaciones',
        codigoPuc: '510539',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque: 'Contrapartida de las vacaciones consolidadas.',
      }),
      cuenta({
        codigo: '510569',
        nombre: 'Gastos de personal - aportes de salud y pensión',
        codigoPuc: '510569',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés empleados: la seguridad social a cargo del empleador.',
      }),
      cuenta({
        codigo: '510572',
        nombre: 'Gastos de personal - aportes a cajas, ICBF y SENA',
        codigoPuc: '510572',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque: 'Declaraste que tenés empleados: los parafiscales.',
      }),
    );
  }

  if (tiene('TIENE_ACTIVOS_FIJOS')) {
    lista.push(
      cuenta({
        codigo: '151605',
        nombre: 'Equipo de oficina - muebles y enseres',
        codigoPuc: '151605',
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés activos fijos: mostradores, estantería, escritorios.',
      }),
      cuenta({
        codigo: '152805',
        nombre: 'Equipo de computación',
        codigoPuc: '152805',
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés activos fijos: computadores, impresoras, terminal POS.',
      }),
      cuenta({
        codigo: '159235',
        nombre: 'Depreciación acumulada - equipo de oficina',
        codigoPuc: '159235',
        bloque: 'OPERACION',
        porque: 'Contrapartida del equipo de oficina: se deprecia con el uso.',
      }),
      cuenta({
        codigo: '159240',
        nombre: 'Depreciación acumulada - equipo de computación',
        codigoPuc: '159240',
        bloque: 'OPERACION',
        porque: 'Contrapartida del equipo de cómputo: se deprecia con el uso.',
      }),
      cuenta({
        codigo: '516015',
        nombre: 'Depreciación - equipo de oficina',
        codigoPuc: '516015',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque:
          'El gasto del período por el equipo de oficina que se desgasta.',
      }),
      cuenta({
        codigo: '516020',
        nombre: 'Depreciación - equipo de computación',
        codigoPuc: '516020',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque:
          'El gasto del período por el equipo de cómputo que se desgasta.',
      }),
    );
  }

  if (tiene('TIENE_CREDITO_BANCARIO')) {
    lista.push(
      cuenta({
        codigo: '210510',
        nombre: 'Bancos nacionales - pagarés',
        codigoPuc: '210510',
        exigeTercero: true,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés crédito bancario: el capital que se debe.',
      }),
      cuenta({
        codigo: '530520',
        nombre: 'Intereses',
        codigoPuc: '530520',
        exigeCentroCosto: centro,
        bloque: 'OPERACION',
        porque:
          'Declaraste que tenés crédito bancario: los intereses son gasto del período.',
      }),
    );
  }

  return lista;
}

// ---------------------------------------------------------------------------
// Ingresos y costo — se derivan de la CIIU declarada en el RUT
// ---------------------------------------------------------------------------

/**
 * Las cuentas del grupo 41 del decreto SON las secciones de la CIIU, así que la
 * actividad principal decide cuál. Lo que el sistema no puede decidir es la
 * subcuenta: dentro de "comercio al por mayor y al por menor" hay veinte, y cuál
 * corresponde depende de qué se vende exactamente.
 */
function bloqueIngresos(h: HechosPlan): {
  cuentas: CuentaSugerida[];
  faltantes: HechoFaltante[];
} {
  const cuentas: CuentaSugerida[] = [];
  const faltantes: HechoFaltante[] = [];

  if (h.actividadPrincipal === null) {
    faltantes.push({
      hecho: 'ACTIVIDAD_PRINCIPAL',
      etiqueta: 'Actividad económica principal (CIIU)',
      impide:
        'No se puede proponer la cuenta de ingresos ni la de costo de ventas: dependen de la actividad.',
      paso: 'SITUACION_LEGAL',
    });
    return { cuentas, faltantes };
  }

  if (h.actividadPrincipal.tarifaIcaPorMil === null) {
    faltantes.push({
      hecho: 'TARIFA_ICA',
      etiqueta: 'Tarifa de ICA',
      impide:
        'No se propone el gasto de industria y comercio ni su cuenta por pagar: no hay tarifa con qué liquidarlos.',
      paso: 'SITUACION_LEGAL',
    });
  }

  const { codigoCiiu, seccionCiiu, divisionCiiu } = h.actividadPrincipal;
  // La sección A junta agricultura y pesca; el decreto las separa en 4105 y 4110.
  const cuentaIngreso =
    divisionCiiu === '03'
      ? '4110'
      : seccionCiiu !== null
        ? INGRESO_POR_SECCION[seccionCiiu]
        : undefined;

  if (cuentaIngreso === undefined) {
    faltantes.push({
      hecho: 'SECCION_CIIU',
      etiqueta: 'Sección de la actividad económica',
      impide: `La actividad ${codigoCiiu} no tiene sección CIIU, así que no hay de dónde deducir la cuenta de ingresos.`,
      paso: 'SITUACION_LEGAL',
    });
    return { cuentas, faltantes };
  }

  const cuentaCosto = `61${cuentaIngreso.slice(2)}`;
  cuentas.push(
    cuenta({
      codigo: cuentaIngreso,
      nombre: 'Ingresos operacionales',
      codigoPuc: cuentaIngreso,
      esAuxiliar: false,
      requiereEleccion: true,
      bloque: 'GIRO',
      porque: `Tu actividad ${codigoCiiu} cae en esta cuenta del decreto. Elegí la subcuenta que corresponde a lo que vendés.`,
    }),
    cuenta({
      codigo: cuentaCosto,
      nombre: 'Costo de ventas',
      codigoPuc: cuentaCosto,
      esAuxiliar: false,
      requiereEleccion: true,
      exigeCentroCosto: h.manejaCentroCosto,
      bloque: 'GIRO',
      porque: `Contrapartida de ${cuentaIngreso}. Elegí la subcuenta que corresponde a lo que vendés.`,
    }),
    libre('4175', '05', {
      nombre: 'Devoluciones en ventas',
      bloque: 'GIRO',
      porque:
        'Toda venta admite devolución, y el decreto la registra restando del ingreso.',
    }),
  );

  return { cuentas, faltantes };
}

// ---------------------------------------------------------------------------

/**
 * Las condiciones tributarias vigentes, leyendo las dos fuentes.
 *
 * El RUT es el documento y de él se deriva la condición al cargarlo, así que en
 * la práctica las dos dicen lo mismo. Se leen igual las dos porque una empresa
 * migrada puede tener la condición cargada sin el RUT detrás, y no proponerle
 * las cuentas de IVA por eso sería castigarla por el orden en que se cargó.
 */
export function condicionesTributarias(h: HechosPlan): Set<string> {
  const condiciones = new Set(h.regimenesVigentes);
  for (const codigo of h.responsabilidadesRut) {
    const condicion = CONDICION_POR_RESPONSABILIDAD_RUT[codigo];
    if (condicion !== undefined) condiciones.add(condicion);
  }
  return condiciones;
}

export function sugerirPlan(h: HechosPlan): Sugerencia {
  const condiciones = condicionesTributarias(h);
  const impuestos = bloqueImpuestos(h, condiciones);
  const ingresos = bloqueIngresos(h);

  const propuestas = [
    ...bloqueBase(h),
    ...bloquePatrimonio(h),
    ...impuestos.cuentas,
    ...bloqueGiro(h),
    ...ingresos.cuentas,
    ...bloqueOperacion(h),
  ];

  // Dos bloques pueden justificar la misma cuenta —la depreciación de la
  // herramienta también es activo fijo—. Se propone una sola vez y con el motivo
  // del primero que la pidió, que es el más específico por el orden de arriba.
  const vistos = new Set(h.codigosExistentes);
  const cuentas: CuentaSugerida[] = [];
  for (const c of propuestas) {
    if (vistos.has(c.codigo)) continue;
    vistos.add(c.codigo);
    // El centro de costo solo se exige donde tiene sentido pedirlo. Un pasivo con
    // centro de costo obligatorio bloquea el asiento sin informar nada.
    cuentas.push(
      c.exigeCentroCosto && !esDeResultado(c.codigo)
        ? { ...c, exigeCentroCosto: false }
        : c,
    );
  }

  return {
    cuentas,
    faltantes: [...impuestos.faltantes, ...ingresos.faltantes],
  };
}
