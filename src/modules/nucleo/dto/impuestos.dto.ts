import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import type { ClavePregunta } from '../servicios/impuestos.reglas';

const CLAVES: ClavePregunta[] = [
  'IVA',
  'SIMPLE',
  'GRAN_CONTRIBUYENTE',
  'AGENTE_RETENCION',
  'AUTORRETENEDOR',
];

/** Una respuesta del bloque «Tu empresa ante la DIAN». */
export class ResponderImpuestoDto {
  @IsIn(CLAVES)
  clave!: ClavePregunta;

  @IsBoolean()
  valor!: boolean;
}

/** El ICA de un municipio con sede. */
export class ResponderIcaDto {
  @IsBoolean()
  esAgenteRetenedor!: boolean;

  @IsBoolean()
  esAutorretenedor!: boolean;

  /**
   * Por mil. Provisional mientras la ley de ICA del municipio no esté cargada
   * (R-D11). Sin el dato se conserva la que había.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(30)
  tarifaProvisionalPorMil?: number;
}
