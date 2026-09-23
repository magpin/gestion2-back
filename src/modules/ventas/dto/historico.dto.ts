import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * Las facturas históricas, como las manda el script de importación.
 *
 * El DTO solo exige la **forma** —textos y números—. Lo que es de fondo —que
 * el número se entienda, que la fecha no sea futura, que la tarifa sea una de
 * las colombianas— lo dice `historico.reglas.ts` **factura por factura, en
 * palabras**: un 400 genérico por la fila 312 de un Excel no le sirve a nadie.
 */
export class LineaHistoricaDto {
  @IsString()
  @MaxLength(40)
  codigoProducto!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  cantidad!: number;

  /** Antes de IVA: el que se cobró entonces. */
  @IsNumber({ maxDecimalPlaces: 2 })
  precioUnitario!: number;

  @IsNumber()
  ivaTarifa!: number;
}

export class FacturaHistoricaDto {
  /** Como se imprimió: «FE-0123», «SETT13», «456». */
  @IsString()
  @MaxLength(40)
  numero!: string;

  /** aaaa-mm-dd. */
  @IsString()
  @MaxLength(10)
  fecha!: string;

  /** El NIT o la cédula del cliente, con o sin dígito de verificación. */
  @IsString()
  @MaxLength(20)
  clienteNit!: string;

  @ValidateNested({ each: true })
  @Type(() => LineaHistoricaDto)
  @ArrayMinSize(1)
  lineas!: LineaHistoricaDto[];

  /** Lo que ya se había cobrado. Lo que falte queda en la cartera. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  pagado?: number;
}

/**
 * Hasta 500 por envío: el script parte el archivo. Todas o ninguna —si una
 * tiene un problema, no se carga ninguna del envío—, para que un archivo no
 * quede cargado a medias.
 */
export class CargarHistoricasDto {
  @ValidateNested({ each: true })
  @Type(() => FacturaHistoricaDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  facturas!: FacturaHistoricaDto[];
}
