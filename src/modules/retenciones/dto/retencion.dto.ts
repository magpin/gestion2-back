import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

export const TIPOS_RETENCION = ['RENTA', 'IVA', 'ICA'] as const;
export type TipoRetencion = (typeof TIPOS_RETENCION)[number];

/** El valor de la UVT de un año. Lo carga un contador; el sistema no lo inventa. */
export class CargarUvtDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  valor!: number;
}

export class CrearConceptoDto {
  @IsInt()
  @Min(2000)
  @Max(2100)
  anio!: number;

  @IsIn(TIPOS_RETENCION)
  tipo!: TipoRetencion;

  /** Corto y estable: `COMPRAS`, `SERVICIOS`, `HONORARIOS`. */
  @IsString()
  @Length(2, 30)
  codigo!: string;

  @IsString()
  @Length(2, 80)
  nombre!: string;

  /** En porcentaje. Una tarifa de ICA en por mil se carga dividida: 7‰ es 0.7. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  tarifa!: number;

  /** Solo en RENTA: la tarifa cuando el beneficiario no declara. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  tarifaNoDeclarante?: number;

  /** En UVT, no en pesos: el valor en pesos cambia cada año y la base no. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseMinimaUvt?: number;

  /** La cuenta `2365xx` contra la que se acredita lo retenido. */
  @IsUUID()
  cuentaId!: string;
}

export class EditarConceptoDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  nombre?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  tarifa?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  tarifaNoDeclarante?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseMinimaUvt?: number;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
