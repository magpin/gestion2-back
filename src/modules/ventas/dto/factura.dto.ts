import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class LineaFacturaDto {
  @IsUUID()
  productoId!: string;

  /** Sin `precioUnitario`: se toma el precio de lista vigente — ver `CrearCotizacionDto`. */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

export class CrearFacturaDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaFacturaDto)
  @ArrayMinSize(1, { message: 'Una factura necesita al menos una línea' })
  lineas!: LineaFacturaDto[];

  /**
   * "Sé que no hay existencia y la emito igual".
   *
   * No es un permiso: es una confirmación. La empresa tiene que haber
   * habilitado el descubierto (`inventario_configuracion.permite_existencia_negativa`)
   * y el producto tiene que tener un costo promedio conocido; si falta
   * cualquiera de las dos, la factura se rechaza aunque esto venga en `true`.
   * Lo que salga sin estar queda anotado en `venta_faltante`.
   */
  @IsOptional()
  @IsBoolean()
  confirmaSinExistencia?: boolean;

  /**
   * "Sé que esta venta pierde plata y la emito igual". Como
   * `confirmaSinExistencia`, no alcanza sola: solo un DIRECTOR puede
   * autorizarla, y queda registrado en la línea quién lo hizo.
   */
  @IsOptional()
  @IsBoolean()
  confirmaPrecioBajoCosto?: boolean;
}
