import {
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
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

/**
 * Cobra una factura en efectivo, total o parcialmente. `cajaId` es la
 * caja que recibe la plata — el concepto del movimiento lo arma el
 * servicio con el número de la factura, no se pide acá.
 */
export class CobrarEfectivoDto {
  @IsUUID()
  cajaId!: string;

  @IsISO8601({ strict: true })
  fecha!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}
