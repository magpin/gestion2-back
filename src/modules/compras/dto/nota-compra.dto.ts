import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** Una línea de la compra que la nota crédito corrige, y por cuánto. */
export class LineaNotaCreditoCompraDto {
  @IsUUID()
  lineaOrigenId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

export class CrearNotaCreditoCompraDto {
  /** La compra EMITIDA que se corrige. Sin compra no hay nota. */
  @IsUUID()
  documentoOrigenId!: string;

  @EsFechaCalendario()
  fecha!: string;

  /**
   * El número que el proveedor le puso a SU nota crédito. No es el de la
   * factura: son dos documentos distintos y cada uno trae el suyo.
   */
  @IsString()
  @Length(1, 60)
  numeroNotaProveedor!: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;

  /**
   * Qué se devuelve. Sin esto, la compra completa —menos lo que notas
   * anteriores ya devolvieron—, mismo criterio que la nota crédito de venta.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LineaNotaCreditoCompraDto)
  @ArrayMinSize(1, {
    message: 'Si mandás líneas, tiene que haber al menos una',
  })
  lineas?: LineaNotaCreditoCompraDto[];
}

/** Lo que el proveedor cobra de más: un concepto nuevo, con su costo. */
export class LineaNotaDebitoCompraDto {
  @IsUUID()
  productoId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  costoUnitario!: number;
}

export class CrearNotaDebitoCompraDto {
  @IsUUID()
  documentoOrigenId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @IsString()
  @Length(1, 60)
  numeroNotaProveedor!: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;

  /**
   * Lo que se cobra de más. No copia las líneas de la compra, igual que la
   * nota débito de venta: lo que el proveedor agrega suele ser un concepto
   * nuevo —un flete, un interés— y no más de lo mismo.
   */
  @ValidateNested({ each: true })
  @Type(() => LineaNotaDebitoCompraDto)
  @ArrayMinSize(1, { message: 'Una nota débito necesita al menos una línea' })
  lineas!: LineaNotaDebitoCompraDto[];
}
