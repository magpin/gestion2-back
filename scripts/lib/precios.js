// El precio sin IVA que, al facturar, vuelve a dar el precio con IVA.
//
// El sistema anterior exporta la lista con el IVA incluido —la tinta de
// $30.000 se facturaba 25.210 + 4.790—, y este sistema guarda el precio SIN
// IVA y se lo suma al facturar (`calcularLinea` en ventas/venta.reglas.ts: el
// IVA en centavos, redondeado). Cargar el precio tal cual lo sube un 19 %.
//
// La base se busca en centavos: con pesos enteros, 226 de 1.560 precios de
// la lista de Computintas quedaban a un peso; con centavos, 187 quedan a un
// centavo porque no existe base que dé el total exacto, y ahí se elige la más
// cercana.

/** Lo mismo que `calcularLinea`, en centavos: base más IVA redondeado. */
function totalConIva(baseCentavos, iva) {
  return baseCentavos + Math.round((baseCentavos * iva) / 100);
}

/**
 * @param {number} precioConIva el de la lista, en pesos
 * @param {number} iva 0, 5 o 19
 * @returns {{ base: number, total: number }} la base en pesos (dos decimales)
 *   y el total que dará al facturar
 */
function baseSinIva(precioConIva, iva) {
  const objetivo = Math.round(precioConIva * 100);
  if (iva === 0) return { base: objetivo / 100, total: objetivo / 100 };
  const aprox = Math.round(objetivo / (1 + iva / 100));
  let mejor = aprox;
  for (const c of [aprox, aprox - 1, aprox + 1, aprox - 2, aprox + 2]) {
    const dif = Math.abs(totalConIva(c, iva) - objetivo);
    if (dif < Math.abs(totalConIva(mejor, iva) - objetivo)) mejor = c;
    if (dif === 0) {
      mejor = c;
      break;
    }
  }
  return { base: mejor / 100, total: totalConIva(mejor, iva) / 100 };
}

module.exports = { baseSinIva, totalConIva };
