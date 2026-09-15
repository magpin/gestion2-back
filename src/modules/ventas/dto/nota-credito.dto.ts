import { IsString, IsUUID, Length } from 'class-validator';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

export class CrearNotaCreditoDto {
  /** La factura EMITIDA que se corrige. Sus líneas se copian, no se vuelven a pedir. */
  @IsUUID()
  documentoOrigenId!: string;

  @EsFechaCalendario()
  fecha!: string;

  @IsString()
  @Length(3, 300)
  motivo!: string;
}
