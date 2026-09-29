import { Matches } from 'class-validator';

import { MES } from '../resumen-medio';

/** Un mes, «2026-09»: el de las cabeceras de Cobros y Pagos. */
export class ResumenMesDto {
  @Matches(MES, { message: 'El mes va como 2026-09.' })
  mes!: string;
}
