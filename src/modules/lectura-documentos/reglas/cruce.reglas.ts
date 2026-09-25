/**
 * Cómo se decide que algo leído en una factura **es** algo que ya está en el
 * sistema. Sin red y sin base de datos.
 *
 * Acá vive la parte que se puede equivocar y que hay que poder discutir: no
 * *buscar* —eso lo hacen los servicios— sino **elegir** entre lo que la
 * búsqueda devolvió, y sobre todo decidir cuándo no elegir.
 *
 * La regla de fondo, que es la misma de todo el módulo: **cuando hay más de
 * una lectura posible, no se elige ninguna**. Un producto equivocado en una
 * compra entra al kardex y sale en el costo de todo lo que se venda después;
 * preguntar cuesta una pregunta.
 */

/** Cómo se encontró algo, para poder decirlo. */
export type FormaDeCruce =
  | 'CODIGO'
  | 'NOMBRE_EXACTO'
  | 'UNICA_COINCIDENCIA'
  | 'NIT'
  /** Lo contestó una persona en una factura anterior del mismo proveedor. */
  | 'APRENDIDO';

/**
 * Lo que se dice de un renglón o de la cabecera después de buscarlo.
 *
 * `null` en `id` no es un error: es una pregunta. Por eso el motivo viaja
 * siempre, también cuando se encontró, y está escrito para que lo lea una
 * persona.
 */
export interface Cruce<T> {
  encontrado: T | null;
  /** Cómo se encontró, o por qué no. */
  motivo: string;
  forma?: FormaDeCruce;
}

/** Lo mínimo que se necesita de un candidato para poder elegirlo. */
export interface Candidato {
  id: string;
  codigo: string;
  nombre: string;
}

export const encontrado = <T>(
  valor: T,
  forma: FormaDeCruce,
  motivo: string,
): Cruce<T> => ({ encontrado: valor, forma, motivo });

export const sinEncontrar = <T>(motivo: string): Cruce<T> => ({
  encontrado: null,
  motivo,
});

/**
 * Para comparar nombres: sin tildes, sin dobles espacios y en mayúsculas.
 *
 * El sistema anterior exporta «TINTA HP 664 NEGRA » y el PDF imprime «Tinta HP
 * 664 Negra»; son el mismo producto y dos cadenas distintas. Esto **no**
 * normaliza puntuación ni abreviaturas: hacer eso empieza a acercar cosas que
 * no son iguales, y el que sigue después de la coincidencia exacta es
 * «preguntá», no «aproximá».
 */
export function comparable(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * El código que trae un renglón, que no siempre viene en su propia columna.
 *
 * La exportación del sistema anterior lo pega al nombre —«P27ORI0018 TINTA
 * …»—, así que cuando no hay columna se prueba con la primera palabra. Se
 * exige que parezca un código —letras y dígitos, con al menos un dígito— para
 * no salir a buscar «TINTA» como si lo fuera.
 */
export function codigoDelRenglon(renglon: {
  codigo: string | null;
  descripcion: string;
}): string | null {
  if (renglon.codigo !== null && renglon.codigo.trim() !== '') {
    return renglon.codigo.trim();
  }
  const primera = renglon.descripcion.trim().split(' ')[0] ?? '';
  return /^(?=.*\d)[A-Za-z0-9-]{3,}$/.test(primera) ? primera : null;
}

/**
 * Elige el producto de un renglón entre lo que devolvió la búsqueda.
 *
 * Tres formas, en orden de qué tan seguro es cada una:
 *
 * 1. **Por código exacto.** Es identidad, no parecido.
 * 2. **Por nombre exacto**, comparado sin tildes ni mayúsculas. Si hay dos
 *    productos con el mismo nombre, ninguna: el catálogo tiene un problema que
 *    no se resuelve adivinando cuál de los dos.
 * 3. **Porque la búsqueda devolvió uno solo.** La más floja de las tres, y se
 *    conserva porque en un catálogo chico es casi siempre correcta — pero se
 *    dice cómo se encontró, para que se pueda dudar de ella.
 *
 * Cualquier otra cosa —cero coincidencias, o varias parecidas— es una pregunta.
 */
export function elegirProducto<T extends Candidato>(
  renglon: { codigo: string | null; descripcion: string },
  candidatos: T[],
): Cruce<T> {
  const codigo = codigoDelRenglon(renglon);
  if (codigo !== null) {
    const porCodigo = candidatos.filter((c) => c.codigo === codigo);
    if (porCodigo.length === 1) {
      return encontrado(porCodigo[0], 'CODIGO', `Por el código ${codigo}.`);
    }
  }

  const buscado = comparable(renglon.descripcion);
  const porNombre = candidatos.filter((c) => comparable(c.nombre) === buscado);
  if (porNombre.length === 1) {
    return encontrado(porNombre[0], 'NOMBRE_EXACTO', 'Por el nombre exacto.');
  }
  if (porNombre.length > 1) {
    return sinEncontrar(
      `Hay ${porNombre.length} productos con ese mismo nombre. ¿Cuál es?`,
    );
  }

  if (candidatos.length === 1) {
    return encontrado(
      candidatos[0],
      'UNICA_COINCIDENCIA',
      `Es el único que se parece: ${candidatos[0].codigo} ${candidatos[0].nombre}.`,
    );
  }

  return sinEncontrar(
    candidatos.length === 0
      ? 'No encontré este producto en el catálogo.'
      : `Hay ${candidatos.length} productos parecidos. ¿Cuál es?`,
  );
}

/**
 * El NIT se compara por prefijo y no por igualdad.
 *
 * El documento puede imprimirlo con el dígito de verificación pegado
 * —900378652-1, o 9003786521— y el sistema lo guarda aparte. Recortarle el
 * último dígito a ciegas rompería un NIT que ya venía sin él, así que se
 * compara por el principio: el guardado tiene que ser prefijo del leído, o al
 * revés, y la diferencia como mucho un dígito.
 */
export function mismoNit(guardado: string, leido: string): boolean {
  const a = guardado.replace(/\D/g, '');
  const b = leido.replace(/\D/g, '');
  if (a === '' || b === '') return false;
  if (a === b) return true;
  return (
    Math.abs(a.length - b.length) === 1 && (a.startsWith(b) || b.startsWith(a))
  );
}

/** Elige el proveedor. Por NIT es identidad; por nombre **no se elige nunca**. */
export function elegirProveedor<
  T extends {
    id: string;
    numeroDocumento: string;
    nombre: string;
    esProveedor: boolean;
  },
>(leido: { nombre: string; nit: string | null }, candidatos: T[]): Cruce<T> {
  if (leido.nit === null) {
    // Dos empresas pueden llamarse casi igual y una compra le queda a la
    // cuenta por pagar de la equivocada. Sin NIT se pregunta, y punto.
    return sinEncontrar(
      `El documento no trae el NIT de «${leido.nombre}». ¿Quién es el proveedor?`,
    );
  }

  const porNit = candidatos.filter((c) =>
    mismoNit(c.numeroDocumento, leido.nit!),
  );
  if (porNit.length !== 1) {
    return sinEncontrar(
      porNit.length === 0
        ? `No tengo ningún tercero con el NIT ${leido.nit}. ¿Lo creo como proveedor?`
        : `Hay ${porNit.length} terceros con el NIT ${leido.nit}.`,
    );
  }

  const [proveedor] = porNit;
  // Existe pero no está marcado como proveedor: es un dato que falta, no una
  // búsqueda fallida, y se dice distinto porque se arregla distinto.
  if (!proveedor.esProveedor) {
    return sinEncontrar(
      `«${proveedor.nombre}» está en el sistema pero no figura como proveedor. ¿Lo marco?`,
    );
  }

  return encontrado(proveedor, 'NIT', `Por el NIT ${leido.nit}.`);
}

/**
 * Elige el cliente de un pedido. La misma regla que el proveedor —por NIT es
 * identidad, por nombre no se elige nunca—, mirando que esté marcado como
 * cliente: facturarle a un tercero que no lo está, la venta lo rechaza.
 */
export function elegirCliente<
  T extends {
    id: string;
    numeroDocumento: string;
    nombre: string;
    esCliente: boolean;
  },
>(
  leido: { nombre: string; nit: string | null },
  candidatos: T[],
  // Una factura del sistema anterior no se factura: se carga (fase 11).
  textos: { documento: string; antesDe: string } = {
    documento: 'El pedido',
    antesDe: 'facturar',
  },
): Cruce<T> {
  if (leido.nit === null) {
    return sinEncontrar(
      `${textos.documento} no trae el NIT de «${leido.nombre}». ¿Quién es el cliente?`,
    );
  }

  const porNit = candidatos.filter((c) =>
    mismoNit(c.numeroDocumento, leido.nit!),
  );
  if (porNit.length !== 1) {
    return sinEncontrar(
      porNit.length === 0
        ? `No tengo ningún tercero con el NIT ${leido.nit}. Hay que crearlo como cliente antes de ${textos.antesDe}.`
        : `Hay ${porNit.length} terceros con el NIT ${leido.nit}. ¿Cuál es?`,
    );
  }

  const [cliente] = porNit;
  if (!cliente.esCliente) {
    return sinEncontrar(
      `«${cliente.nombre}» está en el sistema pero no figura como cliente. Hay que marcarlo antes de ${textos.antesDe}.`,
    );
  }

  return encontrado(cliente, 'NIT', `Por el NIT ${leido.nit}.`);
}

/**
 * Las clases del PUC contra las que una compra se debita. Las mismas de
 * `compra.service.ts`: gastos y costos (5, 6, 7) y los activos que se compran
 * (14 a 17). La clase 1 entera dejaría mandar un arriendo a un banco.
 */
const CLASES_DE_GASTO = ['5', '6', '7', '14', '15', '16', '17'];

export function esCuentaDeGasto(codigo: string): boolean {
  return CLASES_DE_GASTO.some((clase) => codigo.startsWith(clase));
}

/**
 * Elige la cuenta de un renglón de gasto.
 *
 * **Solo por código exacto, y casi nunca va a haber uno.** Una cuenta de cobro
 * de arriendo no imprime el código del PUC, y buscar por la descripción
 * devolvería «Arrendamientos» y «Arrendamientos recibidos» —un gasto y un
 * ingreso— sin manera de saber cuál. Elegir la cuenta es de quien contabiliza.
 *
 * Esto se comprobó contra un documento real el 23 de septiembre: el arriendo se
 * leyó bien y se frenó justo acá.
 */
export function elegirCuenta<T extends Candidato & { esAuxiliar: boolean }>(
  renglon: { cuentaPuc: string | null; descripcion: string },
  candidatos: T[],
): Cruce<T> {
  const codigo = renglon.cuentaPuc?.replace(/\D/g, '') ?? '';
  if (codigo === '') {
    return sinEncontrar(
      `El documento no dice contra qué cuenta va «${renglon.descripcion}». ¿Cuál uso?`,
    );
  }

  const cuenta = candidatos.find((c) => c.codigo === codigo);
  if (cuenta === undefined) {
    return sinEncontrar(`La cuenta ${codigo} no está en el plan de cuentas.`);
  }
  if (!cuenta.esAuxiliar) {
    return sinEncontrar(
      `La cuenta ${codigo} no recibe movimientos: es de agrupación.`,
    );
  }
  if (!esCuentaDeGasto(codigo)) {
    return sinEncontrar(
      `La cuenta ${codigo} no es de gasto ni de un activo que se compre.`,
    );
  }

  return encontrado(cuenta, 'CODIGO', `Por el código ${codigo}.`);
}

/** Una línea ya cruzada, lista para armar la compra. */
export interface LineaCruzada {
  productoId?: string;
  cuentaId?: string;
  detalle?: string;
  ivaTarifa?: number;
  cantidad: number;
  costoUnitario: number;
  /** Solo para promediar los repetidos. No viaja a `POST /compras`. */
  valor: number;
}

/**
 * Junta en una sola línea el mismo producto que aparece dos veces.
 *
 * **La compra no acepta el mismo producto dos veces** y la factura de Jaltech
 * lo traía cuatro. Se suman las cantidades y el costo queda al **promedio
 * ponderado**, que es lo que de verdad costó: tomar el primero o el último
 * cambiaría el costo del inventario según el orden de los renglones.
 *
 * Los gastos no se juntan: dos renglones de «mantenimiento» contra la misma
 * cuenta pueden ser dos servicios distintos, y el detalle de cada uno es
 * justamente lo que los diferencia en el libro.
 */
export function consolidar(lineas: LineaCruzada[]): {
  lineas: LineaCruzada[];
  juntadas: number;
} {
  const salida: LineaCruzada[] = [];
  let juntadas = 0;

  for (const linea of lineas) {
    const previa =
      linea.productoId === undefined
        ? undefined
        : salida.find((s) => s.productoId === linea.productoId);

    if (previa === undefined) {
      salida.push({ ...linea });
      continue;
    }

    juntadas += 1;
    previa.cantidad += linea.cantidad;
    previa.valor += linea.valor;
    // Seis decimales: los que acepta `costo_unitario`. Redondear a dos haría
    // que la línea deje de sumar su propio valor.
    previa.costoUnitario =
      Math.round((previa.valor / previa.cantidad) * 1e6) / 1e6;
  }

  return { lineas: salida, juntadas };
}
