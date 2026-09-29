import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

import {
  TIPOS_CONCEPTO,
  TIPOS_FLUJO,
  type TipoConcepto,
  type TipoFlujo,
} from '../servicios/conceptos.reglas';

export const IVAS_COMPRA = [
  'DESCONTABLE',
  'NO_DESCONTABLE',
  'SIN_IVA',
] as const;
export type IvaCompra = (typeof IVAS_COMPRA)[number];

export class ListarConceptosDto {
  @IsOptional()
  @IsIn(TIPOS_CONCEPTO)
  tipo?: TipoConcepto;

  @IsOptional()
  @IsIn(['true', 'false'])
  incluirInactivos?: 'true' | 'false';
}

/** Un concepto propio de la empresa. Siempre colgado de un auxiliar suyo. */
export class CrearConceptoDto {
  @IsString()
  @Length(2, 80)
  nombre!: string;

  @IsString()
  @Length(2, 60)
  grupo!: string;

  @IsIn(TIPOS_CONCEPTO)
  tipo!: TipoConcepto;

  @IsUUID()
  cuentaId!: string;

  @IsOptional()
  @IsIn(TIPOS_FLUJO)
  tipoFlujo?: TipoFlujo;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  pistas?: string[];

  /** Si el IVA de lo comprado con este concepto se descuenta (PC23: sugerencia). */
  @IsOptional()
  @IsIn([...IVAS_COMPRA, null])
  ivaCompra?: IvaCompra | null;

  /** El concepto de retención de renta que se propone (código de la ley). */
  @IsOptional()
  @IsString()
  @Length(2, 40)
  retencionSugerida?: string | null;

  /** Si se le practica ReteICA; la tarifa la pone el motor por municipio (E20). */
  @IsOptional()
  @IsBoolean()
  aplicaReteica?: boolean;

  /** Si se puede restar en la renta, con factura o documento soporte. */
  @IsOptional()
  @IsBoolean()
  deducible?: boolean;
}

/**
 * Lo que se cambia de un concepto. El tipo no: un gasto que pasa a ser «no
 * gasto» es otro concepto, y los asientos viejos seguirían diciendo lo otro.
 */
export class EditarConceptoDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  nombre?: string;

  @IsOptional()
  @IsString()
  @Length(2, 60)
  grupo?: string;

  @IsOptional()
  @IsUUID()
  cuentaId?: string;

  @IsOptional()
  @IsIn(TIPOS_FLUJO)
  tipoFlujo?: TipoFlujo;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(2, 40, { each: true })
  pistas?: string[];

  /** Si el IVA de lo comprado con este concepto se descuenta (PC23: sugerencia). */
  @IsOptional()
  @IsIn([...IVAS_COMPRA, null])
  ivaCompra?: IvaCompra | null;

  /** El concepto de retención de renta que se propone (código de la ley). */
  @IsOptional()
  @IsString()
  @Length(2, 40)
  retencionSugerida?: string | null;

  /** Si se le practica ReteICA; la tarifa la pone el motor por municipio (E20). */
  @IsOptional()
  @IsBoolean()
  aplicaReteica?: boolean;

  /** Si se puede restar en la renta, con factura o documento soporte. */
  @IsOptional()
  @IsBoolean()
  deducible?: boolean;
}
