import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsNumber,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class LineaNotaDebitoDto {
  @IsUUID()
  productoId!: string;

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
