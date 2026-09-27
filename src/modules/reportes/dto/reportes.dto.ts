import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsUUID } from 'class-validator';

import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';
import {
  ATAJOS,
  ATAJOS_CORTE,
  type Atajo,
  type AtajoCorte,
} from '../reglas/rango';

/**
 * Adónde va la hoja.
 *
 * `HTML` es la hoja para mirar en la pantalla, dentro de un `iframe`; `PDF` es
 * el archivo para bajar. **Son la misma hoja**: misma plantilla, mismo CSS,
 * mismo tamaño de carta. Lo único que cambia es cómo se referencian las
 * fuentes y las gráficas, que es lo que hace que la vista previa diga la verdad
 * sobre lo que se va a imprimir.
 *
 * `XLSX` no es la hoja: son los mismos datos, una fila por factura, para
 * filtrar y pivotear.
 */
export const FORMATOS = ['HTML', 'PDF', 'XLSX'] as const;
export type Formato = (typeof FORMATOS)[number];

/**
 * Un rango: o un atajo, o dos fechas. **No los dos.**
 *
 * La validación de que venga uno de los dos —y no ninguno ni ambos— vive en el
 * controlador y no acá, porque `class-validator` no sabe decir «este campo es
 * obligatorio si aquel no está» sin volverse ilegible. Mejor un `if` con un
 * mensaje que diga qué falta.
 */
export class RangoReporteDto {
  @IsOptional()
  @IsIn(ATAJOS)
  atajo?: Atajo;

  @IsOptional()
  @EsFechaCalendario()
  desde?: string;

  @IsOptional()
  @EsFechaCalendario()
  hasta?: string;

  @IsOptional()
  @IsIn(FORMATOS)
  formato?: Formato;

  /**
   * Una miniatura, no una corrida.
   *
   * Las tarjetas de la lista muestran la hoja real a un quinto de su tamaño. Si
   * eso contara como sacar el reporte, **abrir la lista dejaría dos corridas en
   * el rastro** y «la última vez que se corrió» diría «hace un segundo» cada vez
   * que alguien entra a mirar. La miniatura sale igual; solo no deja huella.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  previa?: boolean;
}

/**
 * Una fecha de corte: o un atajo, o una fecha. Sin ninguno de los dos, hoy:
 * es lo que alguien espera de «la cartera».
 */
export class CorteReporteDto {
  @IsOptional()
  @IsIn(ATAJOS_CORTE)
  atajo?: AtajoCorte;

  @IsOptional()
  @EsFechaCalendario()
  corte?: string;

  @IsOptional()
  @IsIn(FORMATOS)
  formato?: Formato;

  /**
   * Una miniatura, no una corrida.
   *
   * Las tarjetas de la lista muestran la hoja real a un quinto de su tamaño. Si
   * eso contara como sacar el reporte, **abrir la lista dejaría dos corridas en
   * el rastro** y «la última vez que se corrió» diría «hace un segundo» cada vez
   * que alguien entra a mirar. La miniatura sale igual; solo no deja huella.
   */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  previa?: boolean;
}

/**
 * Certificados de retención: el rango y, si se pide, un solo tercero —el
 * proveedor que lo pidió— (plan motor de retenciones, Fase 8, §8.5).
 */
export class CertificadosReporteDto extends RangoReporteDto {
  @IsOptional()
  @IsUUID()
  terceroId?: string;
}
