import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';
import {
  FORMAS_PAGO,
  MedioPagoAlFacturarDto,
  type FormaPago,
} from './venta.dto';
import { RetencionVentaDto } from './factura.dto';

export class LineaCotizacionDto {
  @IsUUID()
  productoId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  /**
   * El precio sin IVA de esta línea, el que se le ofrece al cliente. Si
   * viene, manda sobre el de lista; si no, se toma el de lista vigente. La
   * factura que salga de la cotización se emite a este precio.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  precioUnitario?: number;
}

export class CrearCotizacionDto {
  @IsUUID()
  terceroId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaCotizacionDto)
  @ArrayMinSize(1, { message: 'Una cotización necesita al menos una línea' })
  lineas!: LineaCotizacionDto[];
}

/**
 * Convertir una cotización en factura: solo pide la fecha de la factura
 * resultante y cómo se paga — el cliente, las líneas y el precio de cada una
 * vienen de la propia cotización, no se vuelven a digitar. Se factura al
 * precio cotizado; el IVA y el costo se calculan al emitir.
 */
export class ConvertirCotizacionDto {
  @EsFechaCalendario()
  fecha!: string;

  /**
   * "Sé que no hay existencia y la emito igual".
   *
   * No es un permiso: es una confirmación. La empresa tiene que haber
   * habilitado el descubierto (el hecho operativo `VENDE_SIN_EXISTENCIA`)
   * y el producto tiene que tener un costo promedio conocido; si falta
   * cualquiera de las dos, la factura se rechaza aunque esto venga en `true`.
   * Lo que salga sin estar queda anotado en `venta_faltante`.
   */
  @IsOptional()
  @IsBoolean()
  confirmaSinExistencia?: boolean;

  /** Ver `CrearFacturaDto.confirmaPrecioBajoCosto`. */
  @IsOptional()
  @IsBoolean()
  confirmaPrecioBajoCosto?: boolean;

  /**
   * `CONTADO` cobra la factura entera en la misma transacción que la emite,
   * con los renglones de `pagos` —uno solo, o repartido entre caja y banco; el
   * que venga sin valor se lleva lo que falte—.
   * `CREDITO` la deja pendiente y no lleva `pagos`. Ver `validarFormaPago`.
   */
  @IsIn(FORMAS_PAGO)
  formaPago!: FormaPago;

  /** Ver `CrearFacturaDto.vence`. */
  @IsOptional()
  @EsFechaCalendario()
  vence?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MedioPagoAlFacturarDto)
  pagos?: MedioPagoAlFacturarDto[];

  /** Lo que el cliente nos retiene: igual que en `CrearFacturaDto.retenciones`. */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RetencionVentaDto)
  retenciones?: RetencionVentaDto[];
}

export class LineaExistenciaDto {
  @IsUUID()
  productoId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

/** Qué productos no alcanzan para una venta (`POST /facturas/existencia`). */
export class ExistenciaDto {
  @ValidateNested({ each: true })
  @Type(() => LineaExistenciaDto)
  @ArrayMinSize(1)
  lineas!: LineaExistenciaDto[];
}
