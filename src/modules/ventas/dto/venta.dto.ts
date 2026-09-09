import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

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
