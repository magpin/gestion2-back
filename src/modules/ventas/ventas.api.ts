import { Injectable } from '@nestjs/common';

/**
 * La única clase que `ventas` expondría a otros módulos — hoy vacía, a
 * propósito.
 *
 * Ningún módulo existente necesita nada de `ventas` todavía: `nucleo`,
 * `contabilidad` e `inventario` no dependen de él (la dependencia va al
 * revés — `ventas` es quien los consume). El candidato obvio es DIAN (#6
 * de `docs/decisiones/secuencia-modulos.md`), que va a necesitar leer una
 * factura para transmitir su XML — pero adivinar esa forma antes de
 * diseñar DIAN es exactamente el riesgo que el resto de este proyecto evitó
 * a propósito (mismo criterio que dejó `InventarioApi.incrementarPorCompra`
 * sin escribir hasta que Compras exista). El archivo existe igual, vacío,
 * para que `VentasModule` tenga dónde registrar el primer método el día
 * que haga falta uno.
 */
@Injectable()
export class VentasApi {}
