import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';
import {
  AiuRenglonDto,
  ConceptoRentaDto,
  ConvenioRentaDto,
} from './compra.dto';

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

/**
 * Lo que el proveedor cobra de más: un concepto nuevo, con su costo.
 *
 * **O un producto, o un gasto**, igual que una línea de compra — y acá se
 * nota más todavía: lo que el proveedor agrega suele ser un flete o un
 * interés, que no son productos de nadie.
 */
export class LineaNotaDebitoCompraDto {
  @ValidateIf(
    (o: LineaNotaDebitoCompraDto) =>
      o.cuentaId === undefined && o.conceptoId === undefined,
  )
  @IsUUID()
  productoId?: string;

  /** Qué es lo que cobra de más: la cuenta la pone el concepto. */
  @ValidateIf(
    (o: LineaNotaDebitoCompraDto) =>
      o.productoId === undefined && o.cuentaId === undefined,
  )
  @IsUUID()
  conceptoId?: string;

  /** La cuenta del gasto. Auxiliar, activa y de una clase donde un gasto va. */
  @ValidateIf(
    (o: LineaNotaDebitoCompraDto) =>
      o.productoId === undefined && o.conceptoId === undefined,
  )
  @IsUUID()
  cuentaId?: string;

  /** Qué cobra de más. Obligatorio cuando no es un producto. */
  @ValidateIf((o: LineaNotaDebitoCompraDto) => o.productoId === undefined)
  @IsString()
  @Length(2, 200)
  detalle?: string;

  /** La tarifa del gasto. En las de producto la pone el producto. */
  @ValidateIf((o: LineaNotaDebitoCompraDto) => o.productoId === undefined)
  @IsOptional()
  @IsIn([0, 5, 19])
  ivaTarifa?: number;

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

  /** Los conceptos de renta contestados por renglón, como en la compra (§8.7). */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConceptoRentaDto)
  conceptosRenta?: ConceptoRentaDto[];

  /** «Sin retención», con el porqué: lo mismo que en la compra. */
  @IsOptional()
  @IsString()
  @Length(5, 300)
  sinRetencionMotivo?: string;

  /** Los aportes del proveedor persona natural (§8.14), como en la compra. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  aportesSeguridadSocial?: number;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AiuRenglonDto)
  aiuRenglones?: AiuRenglonDto[];

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ConvenioRentaDto)
  conveniosRenta?: ConvenioRentaDto[];
}
