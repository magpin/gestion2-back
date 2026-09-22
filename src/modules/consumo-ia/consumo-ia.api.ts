import { Injectable } from '@nestjs/common';

import {
  ConsumoIaService,
  type FiltroConsumo,
  type RespuestaTablero,
} from './servicios/consumo-ia.service';

/** Lo que gastó una empresa en el período, con su cuenta. */
export interface GastoDeEmpresa {
  empresaId: string;
  empresa: string;
  cuentaId: string;
  cuenta: string;
  costoUsd: number;
  respuestas: number;
  documentos: number;
}

/**
 * La superficie pública de `consumo-ia`: la consola de plataforma lee el
 * consumo con su propio login, sin la clave del tablero aparte.
 *
 * Son las mismas consultas y la misma cuenta que el tablero. **Solo cifras.**
 */
@Injectable()
export class ConsumoIaApi {
  constructor(private readonly consumo: ConsumoIaService) {}

  tablero(filtro: FiltroConsumo): Promise<RespuestaTablero> {
    return this.consumo.tablero(filtro);
  }

  detalle(
    filtro: FiltroConsumo & {
      categoria?: string;
      orden?: string;
      pagina?: string;
    },
  ) {
    return this.consumo.detalle(filtro);
  }

  /** El gasto de cada empresa en el período, de mayor a menor. */
  async gastoPorEmpresa(
    desde: string,
    hasta: string,
    cuentaId?: string,
  ): Promise<GastoDeEmpresa[]> {
    const t = await this.consumo.tablero({ desde, hasta, cuentaId });
    const cuentaDe = new Map(t.empresas.map((e) => [e.id, e]));
    return t.porEmpresa.map((e) => {
      const c = cuentaDe.get(e.empresaId);
      return {
        empresaId: e.empresaId,
        empresa: e.empresa,
        cuentaId: c?.cuentaId ?? '',
        cuenta: c?.cuenta ?? '',
        costoUsd: e.costoUsd,
        respuestas: e.respuestas,
        documentos: e.documentos,
      };
    });
  }
}
