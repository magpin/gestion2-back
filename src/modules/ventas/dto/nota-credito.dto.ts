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

export class LineaNotaDto {
  /** La línea de la factura que esta corrige. */
  @IsUUID()
  lineaOrigenId!: string;

  /**
   * Cuánto de esa línea. No puede pasarse de lo que queda por devolver
   * —descontando las notas anteriores no anuladas—, y el precio y la tarifa
   * de IVA no se piden: son los de la factura, no se renegocian al corregir.
   */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  cantidad!: number;
}

export class CrearNotaCreditoDto {
  /** La factura EMITIDA que se corrige. Sus líneas se copian, no se vuelven a pedir. */
  @IsUUID()
  documentoOrigenId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;

  /**
   * Las líneas a devolver. **Sin esto, se devuelve la factura completa** —el
   * comportamiento de siempre—: es el caso más común y no tiene sentido
   * obligar a enumerar las líneas para decir "todo".
   */
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LineaNotaDto)
  @ArrayMinSize(1, {
    message: 'Si envía líneas, tiene que haber al menos una',
  })
  lineas?: LineaNotaDto[];
}
