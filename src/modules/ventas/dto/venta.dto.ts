import {
  IsIn,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

/**
 * Compartido entre `cotizaciones`, `facturas` y `notas-credito`: los tres
 * listan lo mismo (documentos de `venta_documento`), filtrados por su
 * propio `tipo` desde el controlador — no acá.
 */
export class ListarVentasDto extends PaginacionDto {
  @IsOptional()
  @IsUUID()
  terceroId?: string;
}

/** Anular una factura o nota crédito. Una cotización no se anula por acá. */
export class AnularVentaDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export const MEDIOS_PAGO = ['CAJA', 'BANCO'] as const;
export type MedioPago = (typeof MEDIOS_PAGO)[number];

/**
 * Cobra una factura, total o parcialmente, por caja o por banco —
 * `cajaId`/`cuentaBancariaId` son mutuamente excluyentes, discriminados
 * por `medio` (mismo criterio que `Medio` en `tesoreria.api.ts`). El
 * concepto del movimiento lo arma el servicio con el número de la
 * factura, no se pide acá.
 */
export class CobrarDto {
  @IsIn(MEDIOS_PAGO)
  medio!: MedioPago;

  @ValidateIf((o: CobrarDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: CobrarDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  @IsISO8601({ strict: true })
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}
