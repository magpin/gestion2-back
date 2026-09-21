/**
 * «Ventas del mes por cliente» — de filas a hoja.
 *
 * Todo lo de acá es puro: entran las facturas que devolvió la consulta y sale
 * el modelo que la plantilla dibuja. Sin base, sin red y sin fechas del reloj
 * —el corte entra como parámetro—, que es lo que hace que los números se puedan
 * comprobar contra los del diseño sin levantar nada.
 *
 * **La propiedad que sostiene la hoja**: lo que dice el resumen tiene que ser
 * la suma del detalle. Es lo que permite que alguien la firme, y por eso no se
 * calcula dos veces —una para arriba y otra para abajo— sino una sola, acá.
 */

/** Una factura, como la devuelve la consulta. Los montos vienen en texto. */
export interface FacturaLeida {
  cliente: string;
  clienteDocumento: string;
  numero: string;
  /** `aaaa-mm-dd`. */
  fecha: string;
  estado: 'EMITIDA' | 'ANULADA';
  total: string | number;
  pagado: string | number;
}

export type Situacion = 'PAGADA' | 'PENDIENTE' | 'VENCIDA' | 'ANULADA';

export interface FacturaVista {
  numero: string;
  /**
   * La clase del cuadrito de color. Sale de acá y no de un `if` en la
   * plantilla: el color **es** la situación, y decidirlo en el modelo deja la
   * regla en un solo lugar y con prueba. Una plantilla llena de condicionales
   * es donde se cuela que una anulada se pinte de naranja.
   */
  punto: string;
  /** «04 sep». */
  fecha: string;
  situacion: Situacion;
  etiqueta: string;
  total: string;
  porCobrar: string;
  /** Cuánto de esa factura está cobrado, de 0 a 100. Pinta la barrita. */
  cobradoPorciento: number;
  anulada: boolean;
}

export interface GrupoVista {
  cliente: string;
  clienteDocumento: string;
  /**
   * El total del grupo en centavos. Está acá y no solo formateado porque es lo
   * que se ordena y con lo que se calcula la participación: volver a leer
   * `$ 28.900.000` para sacar un número sería parsear lo que uno mismo acaba
   * de escribir, y basta un cambio de formato para romperlo en silencio.
   */
  centavos: number;
  total: string;
  porCobrar: string;
  cobradoPorciento: number;
  /**
   * Cuánto mide la barra de este cliente, contra la del mayor.
   *
   * **Sin esto la gráfica no dice nada**: si todas las barras llegan al borde,
   * lo único que se ve es el reparto interno de cada una y se pierde lo que la
   * gráfica viene a mostrar, que es quién compra más. El mayor llega al 100 y
   * el resto en proporción, como en el diseño: 28,9 M ocupa 420 px y 19,1 M
   * ocupa 278.
   */
  ancho: number;
  /** Los tres tramos, en porcentaje **de la barra**, no del total general. */
  tramos: { cobrado: number; porCobrar: number; vencido: number };
  /** Cuánto pesa este cliente en el total. */
  participacion: string;
  totalCorto: string;
  facturas: FacturaVista[];
}

export interface VentasPorCliente {
  resumen: {
    totalFacturado: string;
    facturas: number;
    clientes: number;
    cobrado: string;
    cobradoPorciento: number;
    porCobrar: string;
    porCobrarPorciento: number;
    vencido: string;
    /** «1 factura · Almacenes del Sur», o «sin vencidas». */
    vencidoDetalle: string;
    /**
     * Los tres tramos en porcentaje, para la dona. Son los mismos números que
     * las barras por cliente, y salen del mismo cálculo: si la dona dijera 60 %
     * y las barras 58 %, la hoja se contradice a sí misma.
     */
    tramos: { cobrado: number; porCobrarAlDia: number; vencido: number };
  };
  grupos: GrupoVista[];
  /**
   * Una barra por día del rango, o por mes si el rango pasa de dos meses. El
   * pico se señala.
   */
  porDia: { clave: string; rotulo: string; valor: number }[];
  /** `DIA` o `MES`: lo que mide cada barra, y el título de la gráfica. */
  escala: 'DIA' | 'MES';
  pico: { clave: string; texto: string } | null;
  totalGeneral: {
    total: string;
    porCobrar: string;
    cobradoPorciento: number;
    facturas: number;
  };
}

/**
 * Cuántos días sin pagar convierten una factura en vencida.
 *
 * **Es una convención, no un hecho, y hay que decirlo.** Ninguna tabla guarda
 * la fecha de vencimiento de una factura ni el plazo pactado con el cliente:
 * `venta_documento` tiene la fecha de emisión y nada más. Así que «vencida»
 * acá significa «emitida hace más de treinta días y todavía con saldo», que es
 * lo único que los datos permiten afirmar.
 *
 * Por eso la hoja lo escribe en sus parámetros: quien la lea en diciembre tiene
 * que poder saber qué quería decir esa palabra. El día que el sistema guarde un
 * plazo, esto se reemplaza por el plazo y la hoja lo dirá también.
 */
export const DIAS_PARA_VENCER = 30;

/** Los tres colores del reporte, que son los del reglamento y en ese orden. */
export const TRAMOS = ['cobrado', 'porCobrar', 'vencido'] as const;

const MESES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/**
 * A centavos, como entero.
 *
 * Los montos llegan de Postgres como texto —`numeric` no cabe en un `number`
 * sin perder— y sumarlos como decimales arrastra el error clásico: 0,1 + 0,2.
 * En un reporte que alguien firma, que el total general no cuadre con la suma
 * de los grupos por un centavo es inaceptable, y pasa sin que nadie lo note.
 * Todo lo de adentro son enteros; solo se vuelve a pesos al escribirlo.
 */
export function aCentavos(valor: string | number): number {
  const texto = typeof valor === 'number' ? valor.toFixed(2) : valor.trim();
  const [enteros, decimales = ''] = texto.split('.');
  return Number(enteros) * 100 + Number((decimales + '00').slice(0, 2));
}

/** `$ 68.575.000`, como se escribe en Colombia. */
export function pesos(centavos: number): string {
  const enteros = Math.round(centavos / 100);
  return `$ ${enteros.toLocaleString('es-CO')}`;
}

/** `41,1 M` — para las cifras del resumen, donde el número exacto estorba. */
export function millones(centavos: number): string {
  const valor = centavos / 100_000_000;
  return `${valor.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} M`;
}

/** `04 sep`. */
function diaMes(fecha: string): string {
  const [, mes, dia] = fecha.split('-');
  return `${dia} ${MESES[Number(mes) - 1]}`;
}

function porciento(parte: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((parte / total) * 100);
}

/** Solo lo vencido lleva el acento. Lo demás son neutros, por el reglamento. */
const PUNTO: Record<Situacion, string> = {
  PAGADA: 'punto--resuelto',
  PENDIENTE: 'punto--medio',
  VENCIDA: 'punto--atencion',
  ANULADA: 'punto--medio',
};

export function situacionDe(
  factura: FacturaLeida,
  saldo: number,
  diasDesdeEmision: number,
): { situacion: Situacion; etiqueta: string } {
  if (factura.estado === 'ANULADA')
    return { situacion: 'ANULADA', etiqueta: 'Anulada' };
  if (saldo <= 0) return { situacion: 'PAGADA', etiqueta: 'Pagada' };
  if (diasDesdeEmision > DIAS_PARA_VENCER)
    return { situacion: 'VENCIDA', etiqueta: 'Vencida' };
  return { situacion: 'PENDIENTE', etiqueta: 'Pendiente' };
}

export const dias = (desde: string, hasta: string): number =>
  Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) /
      86_400_000,
  );

export function armar(
  facturas: FacturaLeida[],
  rango: { desde: string; hasta: string },
): VentasPorCliente {
  // Las anuladas se muestran tachadas y **no suman**: una factura anulada no es
  // una venta, y dejarla en el total sería reportar plata que no existe. Se
  // muestra igual porque su número se consumió y alguien va a preguntar por él.
  const cuenta = (f: FacturaLeida): boolean => f.estado !== 'ANULADA';

  const porCliente = new Map<string, FacturaLeida[]>();
  for (const factura of facturas) {
    const suyas = porCliente.get(factura.cliente) ?? [];
    suyas.push(factura);
    porCliente.set(factura.cliente, suyas);
  }

  let totalCentavos = 0;
  let saldoCentavos = 0;
  let vencidoCentavos = 0;
  const vencidas: FacturaLeida[] = [];
  let contadas = 0;

  const grupos: GrupoVista[] = [];

  for (const [cliente, suyas] of porCliente) {
    let totalGrupo = 0;
    let saldoGrupo = 0;
    let vencidoGrupo = 0;

    const vistas: FacturaVista[] = suyas
      .slice()
      .sort((a, b) => a.fecha.localeCompare(b.fecha))
      .map((factura) => {
        const total = aCentavos(factura.total);
        const pagado = aCentavos(factura.pagado);
        const saldo = Math.max(0, total - pagado);
        const { situacion, etiqueta } = situacionDe(
          factura,
          saldo,
          dias(factura.fecha, rango.hasta),
        );

        if (cuenta(factura)) {
          totalGrupo += total;
          saldoGrupo += saldo;
          contadas += 1;
          if (situacion === 'VENCIDA') {
            vencidoGrupo += saldo;
            vencidas.push(factura);
          }
        }

        return {
          numero: factura.numero,
          fecha: diaMes(factura.fecha),
          situacion,
          punto: PUNTO[situacion],
          etiqueta,
          total: pesos(total),
          porCobrar: pesos(saldo),
          cobradoPorciento: porciento(total - saldo, total),
          anulada: situacion === 'ANULADA',
        };
      });

    totalCentavos += totalGrupo;
    saldoCentavos += saldoGrupo;
    vencidoCentavos += vencidoGrupo;

    grupos.push({
      cliente,
      clienteDocumento: suyas[0].clienteDocumento,
      centavos: totalGrupo,
      total: pesos(totalGrupo),
      totalCorto: millones(totalGrupo),
      porCobrar: pesos(saldoGrupo),
      cobradoPorciento: porciento(totalGrupo - saldoGrupo, totalGrupo),
      tramos: {
        cobrado: porciento(totalGrupo - saldoGrupo, totalGrupo),
        porCobrar: porciento(saldoGrupo - vencidoGrupo, totalGrupo),
        vencido: porciento(vencidoGrupo, totalGrupo),
      },
      participacion: '',
      ancho: 0,
      facturas: vistas,
    });
  }

  // Del mayor al menor, como dice el diseño: quien mira un reporte de ventas
  // quiere saber primero quién le compra más.
  grupos.sort((a, b) => b.centavos - a.centavos);
  const mayor = grupos[0]?.centavos ?? 0;
  for (const grupo of grupos) {
    grupo.participacion = `${porciento(grupo.centavos, totalCentavos)} %`;
    grupo.ancho = mayor === 0 ? 0 : (grupo.centavos / mayor) * 100;
  }

  const cobradoCentavos = totalCentavos - saldoCentavos;

  return {
    resumen: {
      totalFacturado: pesos(totalCentavos),
      facturas: contadas,
      clientes: grupos.length,
      cobrado: millones(cobradoCentavos),
      cobradoPorciento: porciento(cobradoCentavos, totalCentavos),
      porCobrar: millones(saldoCentavos),
      porCobrarPorciento: porciento(saldoCentavos, totalCentavos),
      vencido: millones(vencidoCentavos),
      vencidoDetalle: detalleVencido(vencidas),
      tramos: {
        cobrado: porciento(cobradoCentavos, totalCentavos),
        porCobrarAlDia: porciento(
          saldoCentavos - vencidoCentavos,
          totalCentavos,
        ),
        vencido: porciento(vencidoCentavos, totalCentavos),
      },
    },
    grupos,
    ...porDiaConPico(facturas.filter(cuenta), rango),
    totalGeneral: {
      total: pesos(totalCentavos),
      porCobrar: pesos(saldoCentavos),
      cobradoPorciento: porciento(cobradoCentavos, totalCentavos),
      facturas: contadas,
    },
  };
}

/**
 * «1 factura · Almacenes del Sur» o «3 facturas · 2 clientes».
 *
 * Cuando es una sola se nombra al cliente: el que lee la hoja quiere llamarlo,
 * no contar. Cuando son varias, el nombre no cabe y el detalle está abajo.
 */
function detalleVencido(vencidas: FacturaLeida[]): string {
  if (vencidas.length === 0) return 'sin facturas vencidas';
  if (vencidas.length === 1) return `1 factura · ${vencidas[0].cliente}`;
  const clientes = new Set(vencidas.map((f) => f.cliente)).size;
  return clientes === 1
    ? `${vencidas.length} facturas · ${vencidas[0].cliente}`
    : `${vencidas.length} facturas · ${clientes} clientes`;
}

const MESES_CORTOS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** Hasta dos meses, una barra por día; más, una por mes. */
const MAXIMO_DIAS_POR_DIA = 62;

/**
 * Una barra por día del rango, **incluidos los días sin ventas**: un lunes
 * vacío entre dos días buenos es información, y una gráfica que salta del 12
 * al 15 miente sobre el ritmo.
 *
 * **Un rango largo va por mes.** «Este año» en septiembre son 264 días: 264
 * barras en 430 px no se leen, y numerarlas «del 1 al 264» no le dice a nadie
 * qué día fue. Cada barra lleva su fecha real —el día del mes, o el mes—, no
 * su posición en el rango.
 */
function porDiaConPico(
  facturas: FacturaLeida[],
  rango: { desde: string; hasta: string },
): Pick<VentasPorCliente, 'porDia' | 'escala' | 'pico'> {
  const cuantos = dias(rango.desde, rango.hasta) + 1;
  if (cuantos <= 0 || cuantos > 366)
    return { porDia: [], escala: 'DIA', pico: null };

  const escala = cuantos > MAXIMO_DIAS_POR_DIA ? 'MES' : 'DIA';
  const claveDe = (fecha: string) =>
    escala === 'MES' ? fecha.slice(0, 7) : fecha;

  // Las claves del rango, en orden y sin huecos.
  const claves: string[] = [];
  for (let i = 0; i < cuantos; i++) {
    const fecha = new Date(
      Date.parse(`${rango.desde}T00:00:00Z`) + i * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const clave = claveDe(fecha);
    if (claves[claves.length - 1] !== clave) claves.push(clave);
  }

  const porDia = claves.map((clave) => {
    const mes = Number(clave.slice(5, 7));
    return {
      clave,
      rotulo:
        escala === 'MES'
          ? MESES_CORTOS[mes - 1]
          : String(Number(clave.slice(8, 10))),
      valor: 0,
    };
  });
  const indice = new Map(claves.map((c, i) => [c, i]));

  for (const factura of facturas) {
    const i = indice.get(claveDe(factura.fecha));
    if (i === undefined) continue;
    porDia[i].valor += aCentavos(factura.total);
  }

  const mayor = porDia.reduce((a, b) => (b.valor > a.valor ? b : a), porDia[0]);
  const cuando = (clave: string) => {
    const mes = MESES_CORTOS[Number(clave.slice(5, 7)) - 1];
    return escala === 'MES'
      ? `en ${mes} ${clave.slice(0, 4)}`
      : `el ${Number(clave.slice(8, 10))} ${mes}`;
  };
  return {
    porDia,
    escala,
    pico:
      mayor.valor === 0
        ? null
        : {
            clave: mayor.clave,
            texto: `mayor ${cuando(mayor.clave)} · ${millones(mayor.valor)}`,
          },
  };
}
