import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { CobrarDto } from '../../ventas/dto/venta.dto';

/**
 * Lo que la persona escribe. 8.000 caracteres alcanzan para una pregunta con
 * un correo pegado; más que eso es un documento, y para eso está la lectura.
 * La base tiene su propio tope, más alto (40.000): este es el de la pantalla.
 */
export class TurnoDto {
  @IsString()
  @Length(1, 8000, {
    message: 'La pregunta tiene que tener entre 1 y 8.000 caracteres.',
  })
  texto!: string;
}

/**
 * Confirmar una propuesta del asistente. Sin `correccion` se registra lo
 * propuesto; con ella, lo que la persona cambió en la tarjeta. Tiene la forma
 * de `CobrarDto` —fecha y medios—, que es también la de `PagarDto`.
 */
export class ConfirmarPropuestaDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CobrarDto)
  correccion?: CobrarDto;
}
