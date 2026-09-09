import { IsISO8601, IsString, IsUUID, Length } from 'class-validator';

export class CrearNotaCreditoDto {
  /** La factura EMITIDA que se corrige. Sus líneas se copian, no se vuelven a pedir. */
  @IsUUID()
  documentoOrigenId!: string;

  @IsISO8601({ strict: true })
  fecha!: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;
}
