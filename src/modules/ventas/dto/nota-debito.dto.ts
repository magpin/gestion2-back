import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/** Un producto, o un concepto de ingreso con su detalle (Fase 8). Uno de los dos. */
export class LineaNotaDebitoDto {
  @ValidateIf((l: LineaNotaDebitoDto) => l.conceptoId === undefined)
  @IsUUID()
  productoId?: string;

  @ValidateIf((l: LineaNotaDebitoDto) => l.productoId === undefined)
  @IsUUID()
  conceptoId?: string;

  @ValidateIf((l: LineaNotaDebitoDto) => l.conceptoId !== undefined)
  @IsString()
  @Length(2, 200)
  detalle?: string;

  /** Solo en la de concepto: 0, 5 o 19. */
  @ValidateIf((l: LineaNotaDebitoDto) => l.conceptoId !== undefined)
  @IsIn([0, 5, 19])
  ivaTarifa?: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;

  /**
   * El precio de esta línea, digitado.
   *
   * A diferencia de la nota crédito —que devuelve al precio de la factura—,
   * acá no hay un precio anterior que copiar: lo que se cobra de más es un
   * valor nuevo (un flete, un interés, el mayor valor que se facturó de
   * menos), y quien emite la nota es quien lo sabe.
   */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  precioUnitario!: number;
}

export class CrearNotaDebitoDto {
  /** La factura EMITIDA que se corrige. Sin factura no hay nota. */
  @IsUUID()
  documentoOrigenId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;

  /**
   * Qué se cobra de más. No se copian las líneas de la factura: una nota
   * débito no suele ser "más de lo mismo" sino un concepto nuevo, y por eso
   * cada línea trae su producto, su cantidad y su precio.
   */
  @ValidateNested({ each: true })
  @Type(() => LineaNotaDebitoDto)
  @ArrayMinSize(1, { message: 'Una nota débito necesita al menos una línea' })
  lineas!: LineaNotaDebitoDto[];
}
