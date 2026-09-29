import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/**
 * Una línea del asiento.
 *
 * `orden` no viaja: lo pone el servidor con la posición en el arreglo. Aceptarlo
 * del cliente permitiría dos renglones 3, y el índice único lo rechazaría con un
 * error de base en vez de uno que explique.
 */
export class LineaAsientoDto {
  @IsUUID()
  cuentaId!: string;

  /** Obligatorio si la cuenta lo exige. Lo verifica `fn_exigencias_cuenta`. */
  @IsOptional()
  @IsUUID()
  terceroId?: string;

  @IsOptional()
  @IsUUID()
  centroCostoId?: string;

  /**
   * El concepto de ingreso o egreso del que salió la línea. Es lo que deja
   * armar el flujo de caja por actividad sin volver a clasificar nada.
   */
  @IsOptional()
  @IsUUID()
  conceptoId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  baseGravable?: number;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  detalle?: string;

  // Los dos por defecto en cero: una línea manda uno de los dos, y omitir el
  // otro es lo natural. El valor nunca es negativo — el sentido lo da la
  // columna, no el signo.
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  debito: number = 0;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  credito: number = 0;
}

export class CrearAsientoDto {
  @IsUUID()
  comprobanteTipoId!: string;

  /** La fecha del hecho, no la de digitación. Decide en qué período cae. */
  @EsFechaCalendario()
  fecha!: string;

  /**
   * Por qué existe este asiento, en palabras. Es lo primero que lee quien
   * audita, y sin ella hay que reconstruir el motivo desde las líneas.
   */
  @IsString()
  @Length(3, 500)
  glosa!: string;

  @IsArray()
  @ArrayMinSize(2, {
    message:
      'Un asiento lleva al menos dos lineas: algo se debita contra algo que se acredita',
  })
  @ValidateNested({ each: true })
  @Type(() => LineaAsientoDto)
  lineas!: LineaAsientoDto[];
}

export class AnularAsientoDto {
  /**
   * Se agrega a la glosa y queda en el libro. Exigirlo no es burocracia: un
   * asiento anulado sin motivo obliga a preguntarle a quien lo anuló, y para
   * cuando alguien audita, esa persona ya no se acuerda.
   */
  @IsString()
  @Length(3, 200)
  motivo!: string;
}

/** Los booleanos llegan como texto en la query string. */
const aBooleano = ({ value }: { value: unknown }): boolean | undefined =>
  value === undefined ? undefined : value === 'true' || value === true;

export class FiltroAsientosDto extends PaginacionDto {
  @IsOptional()
  @EsFechaCalendario()
  desde?: string;

  @IsOptional()
  @EsFechaCalendario()
  hasta?: string;

  @IsOptional()
  @IsUUID()
  comprobanteTipoId?: string;

  // `q` lo hereda de PaginacionDto. Acá busca por número de comprobante o por
  // texto de la glosa.
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean()
  incluirAnulados?: boolean;
}
