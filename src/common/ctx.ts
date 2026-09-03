/**
 * El vocabulario que comparten todos los módulos. No es un módulo: es el contrato.
 */

export type RolCodigo =
  | 'ADMIN_TENANT'
  | 'DIRECTOR'
  | 'CONTADOR'
  | 'VENTAS'
  | 'COMPRAS'
  | 'INVENTARIO'
  | 'CAJA'
  | 'CONSULTA';

export const ROLES: readonly RolCodigo[] = [
  'ADMIN_TENANT',
  'DIRECTOR',
  'CONTADOR',
  'VENTAS',
  'COMPRAS',
  'INVENTARIO',
  'CAJA',
  'CONSULTA',
];

/**
 * Quién pide, de qué cuenta, sobre qué contabilidad y con qué permisos.
 * Sale del token, nunca de la base ni de un parámetro de la URL: si el
 * `empresaId` viniera de la ruta, cualquiera podría escribir el de otro.
 *
 * `empresaId` es opcional porque existe un estado intermedio real: recién
 * autenticado, el usuario todavía no eligió con cuál de sus empresas va a
 * trabajar.
 */
export interface Ctx {
  tenantId: string;
  usuarioId: string;
  empresaId?: string;
  roles: RolCodigo[];
}

/** Ctx con empresa ya elegida. Lo exige todo lo que toca datos contables. */
export interface CtxEmpresa extends Ctx {
  empresaId: string;
}

export function tieneEmpresa(ctx: Ctx): ctx is CtxEmpresa {
  return ctx.empresaId !== undefined;
}

/**
 * El contexto de una sesión de plataforma.
 *
 * No tiene `tenantId` ni `empresaId`, y no es un descuido: un administrador del
 * producto no puede entrar a una contabilidad. Sin esos campos no hay forma de
 * armarle un `Ctx` de negocio, así que la imposibilidad es estructural y no una
 * regla que alguien deba recordar.
 *
 * Vive acá y no dentro de `plataforma` porque desde que el login es uno solo hay
 * dos módulos que lo nombran: `nucleo` lo emite y `plataforma` lo verifica. Y
 * `plataforma` no exporta nada a propósito.
 */
export interface CtxPlataforma {
  adminId: string;
  email: string;
}

/**
 * Marca que distingue un token de plataforma de uno de cliente.
 *
 * Los dos se firman con el mismo secreto, así que este campo es lo único que los
 * separa: sin él, un token de cliente serviría para administrar el producto
 * entero.
 */
export const AMBITO_PLATAFORMA = 'plataforma';

/**
 * Qué clase de sesión abrió un login. Viaja en la respuesta de `/auth/login`
 * porque es un único endpoint para los dos: sin esto el frontend no sabría si
 * llevar a elegir empresa o a la consola de administración.
 */
export type AmbitoSesion = 'CLIENTE' | 'PLATAFORMA';

/** Los tipos de documento con numeración autorizada por la DIAN. */
export type TipoDocumentoFiscal =
  | 'FACTURA_VENTA'
  | 'FACTURA_CONTINGENCIA'
  | 'NOTA_CREDITO'
  | 'NOTA_DEBITO'
  | 'DOCUMENTO_SOPORTE'
  | 'NOTA_AJUSTE_DOC_SOPORTE'
  | 'NOMINA_ELECTRONICA'
  | 'POS';

/** Condiciones tributarias que una empresa puede cursar, cada una con su vigencia. */
export type TipoRegimen =
  | 'RESPONSABLE_IVA'
  | 'NO_RESPONSABLE_IVA'
  | 'RESPONSABLE_INC'
  | 'AGENTE_RETENEDOR_RENTA'
  | 'AGENTE_RETENEDOR_IVA'
  | 'AGENTE_RETENEDOR_ICA'
  | 'AUTORRETENEDOR_RENTA'
  | 'GRAN_CONTRIBUYENTE'
  | 'REGIMEN_SIMPLE'
  | 'REGIMEN_ORDINARIO'
  | 'ENTIDAD_SIN_ANIMO_DE_LUCRO'
  | 'EXENTO_RENTA';
