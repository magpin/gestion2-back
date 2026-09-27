/**
 * Cuánto se retiene. Sin base de datos.
 *
 * La retención en la fuente no es un impuesto: es el recaudo anticipado de uno.
 * El agente retenedor responde ante la DIAN por el valor **aunque no lo haya
 * practicado** (art. 370 del Estatuto Tributario), y por eso el cálculo no
 * puede depender de que alguien lo recuerde.
 *
 * Dos reglas y nada más:
 *
 *   1. Si la base no llega al mínimo, **no se retiene**. El mínimo se escribe
 *      en UVT y se convierte a pesos con la UVT del año del documento, no con
 *      la de hoy: una factura de 2025 se explica con la UVT de 2025.
 *   2. Si llega, se retiene `base × tarifa`, redondeado a pesos.
 *
 * Al peso y no a centavos: la DIAN recibe las declaraciones en pesos enteros y
 * arrastrar centavos acá solo crea diferencias de redondeo contra el
 * certificado que el proveedor va a presentar.
 */

export type ResultadoRetencion =
  | { retiene: false; motivo: string }
  | { retiene: true; tarifa: number; valor: number };

export function calcularRetencion(entrada: {
  base: number;
  tarifa: number;
  /** El mínimo, en UVT. `0` si el concepto no tiene. */
  baseMinimaUvt: number;
  /** El valor de la UVT del año del documento. */
  uvt: number;
}): ResultadoRetencion {
  const { base, tarifa, baseMinimaUvt, uvt } = entrada;

  if (base <= 0) {
    return { retiene: false, motivo: 'La base tiene que ser mayor a cero.' };
  }

  const minimoEnPesos = baseMinimaUvt * uvt;
  if (baseMinimaUvt > 0 && base < minimoEnPesos) {
    return {
      retiene: false,
      motivo: `La base (${base}) no llega al mínimo de ${baseMinimaUvt} UVT (${Math.round(minimoEnPesos)}).`,
    };
  }

  return { retiene: true, tarifa, valor: Math.round((base * tarifa) / 100) };
}
