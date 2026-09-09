import { Injectable } from '@nestjs/common';

/**
 * La única clase que `compras` expondría a otros módulos — hoy vacía, a
 * propósito.
 *
 * Ningún módulo existente necesita nada de `compras` todavía: `nucleo`,
 * `contabilidad` e `inventario` no dependen de él (la dependencia va al
 * revés — `compras` es quien los consume). El candidato obvio es DIAN (#6
 * de `docs/decisiones/secuencia-modulos.md`), si algún día necesita cruzar
 * información de compras — pero adivinar esa forma antes de diseñar DIAN
 * es el mismo riesgo que ya evitó `VentasApi` (ver su propio comentario).
 * El archivo existe igual, vacío, para que `ComprasModule` tenga dónde
 * registrar el primer método el día que haga falta uno.
 */
@Injectable()
export class ComprasApi {}
