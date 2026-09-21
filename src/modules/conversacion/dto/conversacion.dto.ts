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

/**
 * Cambiar la regla de autonomía de una acción (paso 8). Con
 * `CONFIRMAR_SI_PASA` hace falta el límite, en pesos.
 */
export class CambiarReglaDto {
  @IsIn(['COBRO', 'PAGO'])
  accion!: 'COBRO' | 'PAGO';

  @IsIn(['SOLO_PROPONER', 'CONFIRMAR_SI_PASA'])
  modo!: 'SOLO_PROPONER' | 'CONFIRMAR_SI_PASA';

  @ValidateIf((o: CambiarReglaDto) => o.modo === 'CONFIRMAR_SI_PASA')
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1, { message: 'El límite tiene que ser mayor que cero.' })
  limite?: number;
}

/** «Pausar la autonomía»: todo vuelve a solo proponer, sin perder las reglas. */
export class PausarAutonomiaDto {
  @IsBoolean()
  pausada!: boolean;
}
