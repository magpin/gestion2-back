import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { PaginacionDto } from '../../../common/dto/paginacion.dto';
import { EsFechaCalendario } from '../../../common/dto/fecha.decorator';

/**
 * Compartido entre `cotizaciones`, `facturas` y `notas-credito`: los tres
 * listan lo mismo (documentos de `venta_documento`), filtrados por su
 * propio `tipo` desde el controlador — no acá.
 */
export class ListarVentasDto extends PaginacionDto {
  @IsOptional()
  @IsUUID()
  terceroId?: string;
}

/**
 * La lista de faltantes. `soloPendientes` deja fuera los que ya se
 * resolvieron —la compra entró y el kardex volvió a positivo—, que es lo que
 * quiere ver quien va a comprar.
 */
export class ListarFaltantesDto extends PaginacionDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  soloPendientes?: 'true' | 'false';
}

/** Anular una factura o nota crédito. Una cotización no se anula por acá. */
export class AnularVentaDto {
  @IsString()
  @Length(3, 300)
  motivo!: string;
}

export const MEDIOS_PAGO = ['CAJA', 'BANCO'] as const;
export type MedioPago = (typeof MEDIOS_PAGO)[number];

/**
 * Un renglón del cobro: de dónde entra la plata y cuánta.
 * `cajaId`/`cuentaBancariaId` son mutuamente excluyentes, discriminados por
 * `medio` (mismo criterio que `Medio` en `tesoreria.api.ts`).
 */
export class MedioPagoDto {
  @IsIn(MEDIOS_PAGO)
  medio!: MedioPago;

  @ValidateIf((o: MedioPagoDto) => o.medio === 'CAJA')
  @IsUUID()
  cajaId?: string;

  @ValidateIf((o: MedioPagoDto) => o.medio === 'BANCO')
  @IsUUID()
  cuentaBancariaId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  valor!: number;
}

/**
 * Cobra una factura, total o parcialmente, **repartida entre uno o varios
 * medios**: el cliente que paga la mitad en efectivo y la mitad por
 * transferencia es un solo cobro, no dos.
 *
 * Hasta el paso 12 esto era un solo medio y un solo valor, y ese caso
 * obligaba a cobrar dos veces —dos actos, dos asientos, dos fechas posibles—
 * para algo que pasó una sola vez. Ahora la fecha es una, la validación
 * contra el saldo es una, y cada renglón produce su movimiento.
 *
 * El concepto de cada movimiento lo arma el servicio con el número de la
 * factura, no se pide acá.
 */
export class CobrarDto {
  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => MedioPagoDto)
  @ArrayMinSize(1, { message: 'Un cobro necesita al menos un medio de pago' })
  pagos!: MedioPagoDto[];
}

/**
 * Devuelve parte —o todo— de lo que ya se cobró de una factura. Misma forma
 * que `CobrarDto` porque es el mismo acto al revés: una fecha y un renglón
 * por caja o cuenta de donde sale la plata.
 *
 * Se declara aparte y no se reusa `CobrarDto` porque son dos cosas distintas
 * —cobrar baja lo que el cliente debe, devolver le entrega plata—, y el día
 * que una pida un campo que la otra no, compartir la clase obligaría a
 * partirla con las dos rutas ya en uso.
 */
export class DevolverCobroDto {
  @EsFechaCalendario()
  fecha!: string;

  @ValidateNested({ each: true })
  @Type(() => MedioPagoDto)
  @ArrayMinSize(1, {
    message: 'Una devolución necesita al menos un medio de salida',
  })
  pagos!: MedioPagoDto[];
}
