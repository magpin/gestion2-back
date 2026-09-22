import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/** Un pago que llegó por fuera del sistema: transferencia, PSE, efectivo. */
export class RegistrarPagoDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString()
  fecha!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  monto!: number;

  @IsIn(['TRANSFERENCIA', 'PSE', 'TARJETA', 'EFECTIVO', 'CONSIGNACION', 'OTRO'])
  medio!: string;

  @IsOptional()
  @IsString()
  @Length(0, 120)
  referencia?: string;
}

/** `precioPactado: null` vuelve al precio del plan. */
export class CambiarSuscripcionDto {
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  precioPactado?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  diaCorte?: number;
}

/** El precio y el tope de un plan. Los cupos van en `EditarPlanDto`. */
export class PrecioPlanDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  precioMensual?: number;

  /** De ejemplo: todavía no frena nada. */
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  topeIaUsd?: number;
}

export class PausarIaDto {
  /** Sin cuenta: para toda la plataforma. */
  @IsOptional()
  @IsUUID()
  cuentaId?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['CHAT', 'LECTURA'], { each: true })
  usos!: string[];

  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export class AnuncioDto {
  @IsString()
  @Length(3, 120)
  titulo!: string;

  @IsString()
  @Length(3, 600)
  cuerpo!: string;

  @IsIn(['INFORMATIVO', 'MANTENIMIENTO'])
  tono!: string;

  /** Sin cuentas: para todas. */
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  cuentas?: string[];

  @IsISO8601()
  desde!: string;

  @IsISO8601()
  hasta!: string;
}
