import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { VentasApi } from '../../ventas/ventas.api';
import type { VentasHistoricasCruzadas } from './cruce.service';
import { DocumentoService, type Documento } from './documento.service';

/** Una lectura de ventas anteriores, con cuáles de sus facturas ya están. */
export interface LecturaVentasHistoricas extends Documento {
  /**
   * Por número leído, la factura del sistema que ya lo tiene. Se mira al
   * mostrarla y no al leerla: entre leer y cargar, pudo entrar por el Excel.
   */
  enSistema: Record<string, { id: string; numero: string }>;
}

/** Lo que una persona eligió cargar de una factura leída. */
export interface EleccionCarga {
  numero: string;
  /** Si ya se había cobrado entera. Si no, queda en la cartera. */
  pagada: boolean;
}

/**
 * Carga como históricas las facturas del sistema anterior que María leyó y una
 * persona eligió (fase 11 de `docs/planes/maria-facturas-y-errores.md`).
 *
 * **No carga nada por su cuenta**: va por `VentasApi.cargarHistoricas`, que es
 * la misma puerta del Excel —número y fecha originales, sin asiento ni kardex,
 * todas o ninguna—. Lo que agrega es armar esa entrada desde lo leído, y negarse
 * a cargar lo que tiene preguntas o no cuadra.
 */
@Injectable()
export class CargaVentasHistoricasService {
  private readonly log = new Logger(CargaVentasHistoricasService.name);

  constructor(
    private readonly documentos: DocumentoService,
    private readonly ventas: VentasApi,
  ) {}

  async listar(ctx: CtxEmpresa): Promise<LecturaVentasHistoricas[]> {
    const lecturas = await this.documentos.listarVentasHistoricas(ctx);
    const existentes = await this.ventas.facturasExistentes(
      ctx,
      lecturas.flatMap((l) => numerosDe(l)),
    );
    return lecturas.map((l) => conEnSistema(l, existentes));
  }

  async ver(ctx: CtxEmpresa, id: string): Promise<LecturaVentasHistoricas> {
    const lectura = await this.documentos.porId(ctx, id);
    const existentes = await this.ventas.facturasExistentes(
      ctx,
      numerosDe(lectura),
    );
    return conEnSistema(lectura, existentes);
  }

  async cargar(
    ctx: CtxEmpresa,
    documentoId: string,
    elegidas: EleccionCarga[],
  ) {
    const documento = await this.documentos.porId(ctx, documentoId);
    if (documento.tipo !== 'VENTA_HISTORICA') {
      throw new BadRequestException(
        'Ese documento no es de ventas del sistema anterior.',
      );
    }
    if (documento.estado !== 'LEIDO') {
      throw new BadRequestException(
        documento.estado === 'DESCARTADO'
          ? 'Esa lectura está descartada.'
          : 'Esa lectura todavía no terminó.',
      );
    }
    const cruzadas = documento.extraido as VentasHistoricasCruzadas | null;
    const leidas = cruzadas?.facturas ?? [];

    const entradas = elegidas.map((e) => {
      const f = leidas.find((l) => l.factura.numero === e.numero);
      if (f === undefined) {
        throw new BadRequestException(
          `La factura ${e.numero} no está en esta lectura.`,
        );
      }
      if (!f.completa || f.factura.cliente.nit === null) {
        throw new BadRequestException(
          `La factura ${e.numero} todavía tiene algo por resolver: no se puede cargar así.`,
        );
      }
      return {
        numero: f.factura.numero,
        fecha: f.factura.fecha,
        clienteNit: f.factura.cliente.nit,
        lineas: f.renglones.map((r) => ({
          codigoProducto: r.resuelto!.codigo,
          cantidad: r.leido.cantidad,
          precioUnitario: r.leido.valorUnitario,
          ivaTarifa: r.leido.ivaTarifa,
        })),
        pagada: e.pagada,
      };
    });

    const resultado = await this.ventas.cargarHistoricas(ctx, entradas);
    if (resultado.problemas.length > 0) return resultado;

    // Qué se cargó de esta lectura, para que el lote del chat la dé por hecha
    // y no se pueda descartar: se descarta lo que no se usó.
    const antes = documento.confirmacion?.aplicados ?? [];
    await this.documentos.guardarConfirmacion(ctx, documentoId, {
      aplicados: [...new Set([...antes, ...entradas.map((e) => e.numero)])],
      sinAplicar: [],
    });
    this.log.log(
      `Ventas anteriores ${documentoId}: ${resultado.registradas} facturas cargadas.`,
    );
    return resultado;
  }
}

function numerosDe(lectura: Documento): string[] {
  const cruzadas = lectura.extraido as VentasHistoricasCruzadas | null;
  return (cruzadas?.facturas ?? []).map((f) => f.factura.numero);
}

function conEnSistema(
  lectura: Documento,
  existentes: Map<string, { id: string; numero: string }>,
): LecturaVentasHistoricas {
  return {
    ...lectura,
    enSistema: Object.fromEntries(
      numerosDe(lectura)
        .filter((n) => existentes.has(n))
        .map((n) => [n, existentes.get(n)!]),
    ),
  };
}
