import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
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
  FORMAS_PAGO,
  MedioPagoAlFacturarDto,
  type FormaPago,
} from './venta.dto';

/**
 * Una línea de la factura: un producto del catálogo, o un concepto de ingreso
 * —un servicio (41) u otro ingreso (42)—. Una de las dos (Fase 8, pantalla 13).
 */
export class LineaFacturaDto {
  @ValidateIf((l: LineaFacturaDto) => l.conceptoId === undefined)
  @IsUUID()
  productoId?: string;

  /** Concepto de INGRESO: la línea no mueve kardex y entra a la cuenta del concepto. */
  @ValidateIf((l: LineaFacturaDto) => l.productoId === undefined)
  @IsUUID()
  conceptoId?: string;

  /** Solo en la de concepto: qué se cobró («Transporte de la mercancía a Turbo»). */
  @ValidateIf((l: LineaFacturaDto) => l.conceptoId !== undefined)
  @IsString()
  @Length(2, 200)
  detalle?: string;

  /** Solo en la de concepto: un servicio no tiene precio de lista, lo pone quien factura. */
  @ValidateIf((l: LineaFacturaDto) => l.conceptoId !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  precioUnitario?: number;

  /** Solo en la de concepto: 0, 5 o 19. En la de producto la dice el producto. */
  @ValidateIf((l: LineaFacturaDto) => l.conceptoId !== undefined)
  @IsIn([0, 5, 19])
  ivaTarifa?: number;

  /** En la de producto, sin `precioUnitario`: se toma el precio de lista vigente — ver `CrearCotizacionDto`. */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

/**
 * Una retención que el cliente nos practica sobre esta factura.
 *
 * **No baja el valor de la factura**: baja lo que nos van a pagar. Lo retenido
 * es un anticipo de nuestro impuesto, o sea un activo nuestro (grupo `1355`),
 * no un menor ingreso — si se registrara como menor ingreso, el estado de
 * resultados diría que vendimos menos de lo que vendimos.
 *
 * El valor lo calcula el sistema con la tarifa y la base mínima del catálogo:
 * acá solo va qué concepto y sobre qué base.
 */
export class RetencionVentaDto {
  @IsUUID()
  conceptoId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  base!: number;
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

  /**
   * Lo que el cliente nos retiene sobre esta factura, si es agente retenedor.
   * El valor lo calcula el sistema contra el catálogo del año.
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => RetencionVentaDto)
  retenciones?: RetencionVentaDto[];

  /**
   * `CONTADO` cobra la factura entera en la misma transacción que la emite,
   * con los renglones de `pagos` —uno solo, o repartido entre caja y banco; el
   * que venga sin valor se lleva lo que falte—.
   * `CREDITO` la deja pendiente y no lleva `pagos`. Ver `validarFormaPago`.
   */
  @IsIn(FORMAS_PAGO)
  formaPago!: FormaPago;

  /**
   * Cuándo vence, si es a crédito. Sin ella la cartera cuenta 30 días desde
   * la emisión, como los reportes. En una de contado no aplica: se cobra ya.
   */
  @IsOptional()
  @EsFechaCalendario()
  vence?: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MedioPagoAlFacturarDto)
  pagos?: MedioPagoAlFacturarDto[];
}
