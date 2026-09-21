import { IsString, Length } from 'class-validator';

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
