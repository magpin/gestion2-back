import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import type { Tx } from '../../common/db/tx.service';
import {
  calcularRetencion,
  tarifaAplicable,
} from './servicios/retencion.reglas';
import { RetencionService } from './servicios/retencion.service';

export interface RetencionCalculada {
  conceptoId: string;
  tipo: 'RENTA' | 'IVA' | 'ICA';
  concepto: string;
  cuentaId: string;
  base: number;
  tarifa: number;
  valor: number;
}

/**
 * Lo único que `retenciones` expone a otros módulos: calcular cuánto se retiene
 * de una base, con la tarifa y la base mínima que rigen **a la fecha del
 * documento**.
 *
 * Compras la usa para lo que le retiene al proveedor; Ventas, para lo que el
 * cliente nos retiene a nosotros. Es el mismo cálculo de los dos lados: lo que
 * cambia es contra qué cuenta va —un pasivo cuando retenemos, un activo cuando
 * nos retienen— y eso lo decide quien llama, no esto.
 */
@Injectable()
export class RetencionesApi {
  constructor(private readonly retenciones: RetencionService) {}

  /**
   * Cuánto se retiene por este concepto sobre esta base.
   *
   * Devuelve `null` cuando **no corresponde retener** —la base no llega al
   * mínimo—, que no es un error: es la respuesta correcta y muy común en
   * compras chicas.
   */
  async calcular(
    ctx: CtxEmpresa,
    datos: {
      conceptoId: string;
      base: number;
      fecha: string;
      /** Del tercero. Decide la tarifa en los conceptos que tienen dos. */
      declaranteRenta: boolean;
    },
    tx?: Tx,
  ): Promise<RetencionCalculada | null> {
    const concepto = await this.retenciones.porId(ctx, datos.conceptoId, tx);
    if (concepto === null || !concepto.activo) {
      throw new BadRequestException(
        'Ese concepto de retención no existe o está archivado.',
      );
    }

    const anioDocumento = Number(datos.fecha.slice(0, 4));
    if (concepto.anio !== anioDocumento) {
      throw new BadRequestException(
        `El concepto ${concepto.codigo} es del ${concepto.anio} y el documento es del ${anioDocumento}. Cargá la tarifa del año del documento.`,
      );
    }

    const uvt = await this.retenciones.uvtDe(ctx, datos.fecha, tx);
    if (uvt === null) {
      throw new BadRequestException(
        `No está cargada la UVT del ${anioDocumento}. Sin ella no se puede saber si la base llega al mínimo.`,
      );
    }

    const tarifa = tarifaAplicable(concepto, datos.declaranteRenta);
    const resultado = calcularRetencion({
      base: datos.base,
      tarifa,
      baseMinimaUvt: Number(concepto.base_minima_uvt),
      uvt,
    });

    if (!resultado.retiene) return null;

    return {
      conceptoId: concepto.id,
      tipo: concepto.tipo,
      concepto: concepto.codigo,
      cuentaId: concepto.cuenta_id,
      base: datos.base,
      tarifa: resultado.tarifa,
      valor: resultado.valor,
    };
  }
}
