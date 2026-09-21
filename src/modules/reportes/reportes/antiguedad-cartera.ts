import { millones, pesos, type FacturaLeida } from './ventas-por-cliente';

/**
 * «Antigüedad de saldos de cartera» — de filas a hoja.
 *
 * Puro, como el de ventas: entran las facturas con saldo y sale el modelo que
 * la plantilla dibuja. El **corte** entra como parámetro y no se lee del reloj,
 * porque toda la hoja se mide contra él: un informe de cartera al 30 de
 * septiembre tiene que decir lo mismo hoy que en diciembre.
 *
 * Reusa `pesos`, `millones` y el tipo de factura de `ventas-por-cliente`: son
 * las mismas cifras de la misma empresa, y dos formatos distintos en dos hojas
 * de la misma carpeta se notan.
 */

/**
 * Los cinco tramos, en días **vencidos**.
 *
 * Están definidos por su borde superior; el último no tiene. Los colores son la
 * escala del reglamento de oscuro a claro, con el naranja **solo en el último**:
 * lo que lleva más de noventa días es lo único que exige atención, y en una
 * fotocopia en gris los otros cuatro se siguen distinguiendo por luminosidad.
 */
export const TRAMOS = [
  { clave: 'SIN_VENCER', etiqueta: 'Sin vencer', hasta: 0, color: '#171717' },
  { clave: 'D1_30', etiqueta: '1 – 30 días', hasta: 30, color: '#4d4d4d' },
  { clave: 'D31_60', etiqueta: '31 – 60', hasta: 60, color: '#8a8a8a' },
  { clave: 'D61_90', etiqueta: '61 – 90', hasta: 90, color: '#b8b8b8' },
  { clave: 'D90_MAS', etiqueta: 'Más de 90', hasta: null, color: '#f25623' },
] as const;

export type ClaveTramo = (typeof TRAMOS)[number]['clave'];

export interface TramoVista {
  clave: ClaveTramo;
  etiqueta: string;
  color: string;
  centavos: number;
  monto: string;
  parte: string;
  /** Lo que pesa dentro de la franja. Va como `flex`, no como ancho. */
  peso: number;
}

export interface ClienteVista {
  cliente: string;
  clienteDocumento: string;
  centavos: number;
  saldo: string;
  /** El largo de la barra contra la del que más debe. */
  ancho: number;
  /** Los pedazos de su barra, en porcentaje de la barra. */
  pedazos: { color: string; parte: number }[];
  /** «36 % vencido» o «al día». */
  estado: string;
  vencido: boolean;
}

export interface AntiguedadCartera {
  resumen: {
    total: string;
    clientes: number;
    alDia: string;
    alDiaPorciento: number;
    vencida: string;
    vencidaPorciento: number;
    masDe90: string;
    masDe90Detalle: string;
  };
  tramos: TramoVista[];
  clientes: ClienteVista[];
  /** Cuántos días de plazo se asumieron. La hoja lo declara. */
  plazo: number;
}

const dias = (desde: string, hasta: string): number =>
  Math.round(
    (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) /
      86_400_000,
  );

function aCentavos(valor: string | number): number {
  const texto =
    typeof valor === 'number' ? valor.toFixed(2) : String(valor).trim();
  const [enteros, decimales = ''] = texto.split('.');
  return Number(enteros) * 100 + Number((decimales + '00').slice(0, 2));
}

const porciento = (parte: number, total: number): number =>
  total === 0 ? 0 : Math.round((parte / total) * 100);

/**
 * En qué tramo cae una factura.
 *
 * Los días **vencidos** son los transcurridos desde la emisión menos el plazo
 * asumido. El sistema no guarda el plazo pactado con cada cliente —no hay
 * columna—, así que se usa uno solo para todos y la hoja lo dice. Es la misma
 * convención que usa «Ventas del mes por cliente», y tiene que serlo: dos
 * hojas de la misma carpeta que llamen «vencida» a cosas distintas es peor que
 * no tener ninguna.
 */
export function tramoDe(diasVencidos: number): ClaveTramo {
  for (const tramo of TRAMOS) {
    if (tramo.hasta !== null && diasVencidos <= tramo.hasta) return tramo.clave;
  }
  return 'D90_MAS';
}

export function armar(
  facturas: FacturaLeida[],
  corte: string,
  plazo: number,
): AntiguedadCartera {
  const porCliente = new Map<
    string,
    { documento: string; tramos: Map<ClaveTramo, number> }
  >();
  const totales = new Map<ClaveTramo, number>(TRAMOS.map((t) => [t.clave, 0]));
  let total = 0;

  for (const factura of facturas) {
    // Una anulada no debe nada, y una pagada tampoco: la cartera es lo que
    // queda por cobrar, no lo que se facturó.
    if (factura.estado === 'ANULADA') continue;
    const saldo = Math.max(
      0,
      aCentavos(factura.total) - aCentavos(factura.pagado),
    );
    if (saldo === 0) continue;

    const tramo = tramoDe(dias(factura.fecha, corte) - plazo);
    total += saldo;
    totales.set(tramo, (totales.get(tramo) ?? 0) + saldo);

    const suyo = porCliente.get(factura.cliente) ?? {
      documento: factura.clienteDocumento,
      tramos: new Map<ClaveTramo, number>(),
    };
    suyo.tramos.set(tramo, (suyo.tramos.get(tramo) ?? 0) + saldo);
    porCliente.set(factura.cliente, suyo);
  }

  const tramos: TramoVista[] = TRAMOS.map((tramo) => {
    const centavos = totales.get(tramo.clave) ?? 0;
    return {
      clave: tramo.clave,
      etiqueta: tramo.etiqueta,
      color: tramo.color,
      centavos,
      monto: millones(centavos),
      parte: `${porciento(centavos, total)} %`,
      // Como `flex` y no como ancho: así los cinco llenan la franja exactamente
      // y no sobra ni falta un píxel por redondeo, que en una franja de cinco
      // tramos se nota.
      peso: centavos,
    };
  });

  const clientes: ClienteVista[] = [...porCliente.entries()]
    .map(([cliente, datos]) => {
      const centavos = [...datos.tramos.values()].reduce((a, b) => a + b, 0);
      const vencido = centavos - (datos.tramos.get('SIN_VENCER') ?? 0);
      return {
        cliente,
        clienteDocumento: datos.documento,
        centavos,
        saldo: pesos(centavos),
        ancho: 0,
        pedazos: TRAMOS.filter((t) => (datos.tramos.get(t.clave) ?? 0) > 0).map(
          (t) => ({
            color: t.color,
            parte: ((datos.tramos.get(t.clave) ?? 0) / centavos) * 100,
          }),
        ),
        estado:
          vencido === 0
            ? 'al día'
            : `${porciento(vencido, centavos)} % vencido`,
        vencido: vencido > 0,
      };
    })
    .sort((a, b) => b.centavos - a.centavos);

  const mayor = clientes[0]?.centavos ?? 0;
  for (const cliente of clientes) {
    cliente.ancho = mayor === 0 ? 0 : (cliente.centavos / mayor) * 100;
  }

  const sinVencer = totales.get('SIN_VENCER') ?? 0;
  const masDe90 = totales.get('D90_MAS') ?? 0;
  const conMasDe90 = clientes.filter(
    (c) => (porCliente.get(c.cliente)?.tramos.get('D90_MAS') ?? 0) > 0,
  );

  return {
    resumen: {
      total: pesos(total),
      clientes: clientes.length,
      alDia: millones(sinVencer),
      alDiaPorciento: porciento(sinVencer, total),
      vencida: millones(total - sinVencer),
      vencidaPorciento: porciento(total - sinVencer, total),
      masDe90: millones(masDe90),
      masDe90Detalle: detalleDe(conMasDe90),
    },
    tramos,
    clientes,
    plazo,
  };
}

/** «1 cliente», «3 clientes», o que no hay. */
function detalleDe(clientes: ClienteVista[]): string {
  if (clientes.length === 0) return 'ninguno';
  if (clientes.length === 1) return `1 cliente · ${clientes[0].cliente}`;
  return `${clientes.length} clientes`;
}
