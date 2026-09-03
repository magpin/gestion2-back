/**
 * `CtxPlataforma` y `AMBITO_PLATAFORMA` se mudaron a `common/ctx`.
 *
 * Desde que el login es uno solo hay dos módulos que los nombran: `nucleo` emite
 * el token de plataforma y `plataforma` lo verifica. Y `plataforma` no exporta
 * nada a propósito, así que el tipo compartido no podía quedarse acá.
 */
export { AMBITO_PLATAFORMA, type CtxPlataforma } from '../../common/ctx';
