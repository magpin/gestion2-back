import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Min,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';

/** Enum cerrado: el catálogo oficial DIAN/UBL de unidades es trabajo del módulo DIAN (#6). */
export const UNIDADES_MEDIDA = [
  'UND',
  'KG',
  'LB',
  'LT',
  'GAL',
  'MT',
  'M2',
  'M3',
  'CAJA',
  'PAR',
  'DOC',
] as const;

/** Las únicas tres tarifas reales de IVA para bienes en Colombia. */
const TARIFAS_IVA = [0, 5, 19] as const;

export class CrearProductoDto {
  @Matches(/^[A-Za-z0-9-]{1,30}$/, { message: 'Codigo invalido' })
  codigo!: string;

  @IsString()
  @Length(2, 200)
  nombre!: string;

  @IsOptional()
  @IsIn(UNIDADES_MEDIDA)
  unidadMedida?: (typeof UNIDADES_MEDIDA)[number];

  @IsNumber()
  @IsIn(TARIFAS_IVA)
  ivaTarifa!: number;

  /**
   * La cuenta del plan de la empresa (1435/1405/143005 según el giro). No se
   * edita después de creado el producto: cambiarla dejaría el kardex viejo
   * apuntando a una cuenta que el producto ya no dice usar. Si el id no
   * existe o pertenece a otra empresa, la FK compuesta de `producto` lo
   * rechaza y el filtro de errores lo traduce.
   */
  @IsUUID()
  cuentaInventarioId!: string;

  /**
   * La cuenta de costo (6135/6145 según el giro) contra la que se debita
   * cuando ESTE producto se vende. Opcional a propósito: `ventas` (módulo
   * #4) todavía no existe cuando `inventario` se construyó, así que no
   * hay forma de exigirla al dar de alta un producto hoy. A diferencia de
   * `cuentaInventarioId`, esta SÍ se puede editar después — no ancla
   * ningún movimiento de kardex ya escrito, `VentasService` la lee al
   * momento de vender, no antes.
   */
  @IsOptional()
  @IsUUID()
  cuentaCostoVentaId?: string;

  /**
   * La cuenta de ingreso (413504/415505 según el giro) que se acredita
   * cuando ESTE producto se vende — la pareja de `cuentaCostoVentaId`,
   * mismo criterio: opcional acá, editable después.
   */
  @IsOptional()
  @IsUUID()
  cuentaIngresoId?: string;

  /** El precio con el que arranca. Cambiarlo después es `POST /productos/:id/precio`. */
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  precioVenta!: number;
}

/**
 * `codigo` y `cuentaInventarioId` no se editan acá — ver el porqué en
 * `CrearProductoDto`. `precioVenta` tampoco: eso vive en `producto_precio`,
 * historial aparte. `unidadMedida`, `cuentaCostoVentaId` y
 * `cuentaIngresoId` sí se pueden editar: ninguna ancla un movimiento de
 * kardex ya escrito.
 */
export class EditarProductoDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  nombre?: string;

  @IsOptional()
  @IsIn(UNIDADES_MEDIDA)
  unidadMedida?: (typeof UNIDADES_MEDIDA)[number];

  @IsOptional()
  @IsNumber()
  @IsIn(TARIFAS_IVA)
  ivaTarifa?: number;

  @IsOptional()
  @IsUUID()
  cuentaCostoVentaId?: string;

  @IsOptional()
  @IsUUID()
  cuentaIngresoId?: string;
}

export class ListarProductosDto extends PaginacionDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  incluirInactivos?: 'true' | 'false';

  @IsOptional()
  @IsIn(['true', 'false'])
  soloInactivos?: 'true' | 'false';
}
