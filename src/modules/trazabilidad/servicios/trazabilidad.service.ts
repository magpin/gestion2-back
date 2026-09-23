import { Injectable, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  LecturaDocumentosApi,
  type DocumentoSoporte,
} from '../../lectura-documentos/lectura-documentos.api';
import {
  pasosDelAsiento,
  type FuentesDelAsiento,
  type Paso,
} from '../reglas/trazabilidad.reglas';

export interface Trazabilidad {
  pasos: Paso[];
  /** El archivo que se leyó. `null` si el asiento no salió de un documento. */
  documento: (DocumentoSoporte & { id: string; nombre: string }) | null;
}

interface FilaAsiento {
  numero: string;
  estado: string;
  creado_en: Date;
  creado_por: string;
  anulado_en: Date | null;
  anulado_por: string | null;
  motivo_anulacion: string | null;
  origen_tipo: string | null;
  origen_id: string | null;
  propuesta_id: string | null;
  anio: number;
  mes: number;
}

interface FilaRegistro {
  nombre: string;
  creado_en: Date;
  creado_por: string;
  documento_leido_id: string | null;
}

interface FilaDocumento {
  id: string;
  tipo: string;
  clave_almacenamiento: string;
  huella_sha256: string | null;
  creado_en: Date;
  creado_por: string;
  leido_en: Date | null;
  extraido: unknown;
}

interface FilaPropuesta {
  accion: 'COBRO' | 'PAGO';
  creada_en: Date;
  resuelta_en: Date | null;
  resuelta_por: string | null;
}

const iso = (d: Date | string) => new Date(d).toISOString();

/**
 * Junta lo que ya se guardaba de un asiento y de lo que lo originó, y se lo
 * pasa a las reglas para armar el historial.
 *
 * **Solo lee**, y lee directo de las tablas de otros módulos —como `reportes`
 * y `revision`—: el historial cruza contabilidad, compras, ventas, lectura de
 * documentos y el chat, y no es de ninguno. Lo único que se escribe, y por la
 * fachada de su dueño, es la huella de un documento leído antes de que se
 * guardara (`LecturaDocumentosApi.soporte`).
 */
@Injectable()
export class TrazabilidadService {
  constructor(
    private readonly tx: TxService,
    private readonly lectura: LecturaDocumentosApi,
  ) {}

  async deAsiento(ctx: CtxEmpresa, asientoId: string): Promise<Trazabilidad> {
    const { fuentes, documento } = await this.tx.enContexto(ctx, (t) =>
      this.fuentes(t, asientoId),
    );
    return {
      pasos: pasosDelAsiento(fuentes),
      documento:
        documento === null
          ? null
          : {
              id: documento.id,
              nombre:
                documento.clave_almacenamiento.split('/').pop() ?? documento.id,
              ...(await this.lectura.soporte(ctx, {
                id: documento.id,
                clave: documento.clave_almacenamiento,
                huella: documento.huella_sha256,
              })),
            },
    };
  }

  private async fuentes(
    t: Tx,
    asientoId: string,
  ): Promise<{ fuentes: FuentesDelAsiento; documento: FilaDocumento | null }> {
    const asiento = fila<FilaAsiento>(
      await t.query(
        `SELECT a.numero, a.estado, a.creado_en, a.creado_por, a.anulado_en,
                a.anulado_por, a.motivo_anulacion, a.origen_tipo, a.origen_id,
                a.propuesta_id, p.anio, p.mes
           FROM asiento a
           JOIN periodo_contable p ON p.id = a.periodo_id
          WHERE a.id = $1`,
        [asientoId],
      ),
    );
    if (asiento === undefined)
      throw new NotFoundException('Asiento no encontrado');

    const registro = await this.registro(t, asiento);
    const documento =
      registro?.documento_leido_id == null
        ? null
        : (fila<FilaDocumento>(
            await t.query(
              `SELECT id, tipo, clave_almacenamiento, huella_sha256, creado_en,
                      creado_por, leido_en, extraido
                 FROM documento_leido WHERE id = $1`,
              [registro.documento_leido_id],
            ),
          ) ?? null);
    const propuesta =
      asiento.propuesta_id === null
        ? undefined
        : fila<FilaPropuesta>(
            await t.query(
              `SELECT accion, creada_en, resuelta_en, resuelta_por
                 FROM asistente_propuesta WHERE id = $1`,
              [asiento.propuesta_id],
            ),
          );

    // Los nombres, de una vez: pocas personas, y casi siempre las mismas.
    const ids = [
      asiento.creado_por,
      asiento.anulado_por,
      registro?.creado_por,
      documento?.creado_por,
      propuesta?.resuelta_por,
    ].filter((id): id is string => typeof id === 'string');
    const nombres = new Map(
      filas<{ id: string; nombre_completo: string }>(
        await t.query(
          'SELECT id, nombre_completo FROM usuario WHERE id = ANY($1::uuid[])',
          [[...new Set(ids)]],
        ),
      ).map((u) => [u.id, u.nombre_completo]),
    );
    const persona = (id: string) => ({ nombre: nombres.get(id) ?? 'Alguien' });

    return {
      documento,
      fuentes: {
        asiento: {
          numero: asiento.numero,
          creadoEn: iso(asiento.creado_en),
          creadoPor: persona(asiento.creado_por),
          estado: asiento.estado,
          anuladoEn:
            asiento.anulado_en === null ? null : iso(asiento.anulado_en),
          anuladoPor:
            asiento.anulado_por === null ? null : persona(asiento.anulado_por),
          motivo: asiento.motivo_anulacion,
          periodo: { anio: asiento.anio, mes: asiento.mes },
        },
        documento:
          documento === null
            ? undefined
            : {
                tipo: documento.tipo,
                clave: documento.clave_almacenamiento,
                creadoEn: iso(documento.creado_en),
                subidoPor: persona(documento.creado_por),
                leidoEn:
                  documento.leido_en === null ? null : iso(documento.leido_en),
                extraido: documento.extraido,
              },
        propuesta:
          propuesta === undefined
            ? undefined
            : {
                accion: propuesta.accion,
                creadaEn: iso(propuesta.creada_en),
                resueltaEn:
                  propuesta.resuelta_en === null
                    ? null
                    : iso(propuesta.resuelta_en),
                resueltaPor:
                  propuesta.resuelta_por === null
                    ? null
                    : persona(propuesta.resuelta_por),
              },
        registro:
          registro === undefined
            ? undefined
            : {
                tipo: asiento.origen_tipo as 'COMPRA' | 'VENTA',
                nombre: registro.nombre,
                creadoEn: iso(registro.creado_en),
                creadoPor: persona(registro.creado_por),
              },
      },
    };
  }

  /** La compra o el documento de venta del que salió el asiento, si salió de uno. */
  private async registro(
    t: Tx,
    asiento: FilaAsiento,
  ): Promise<FilaRegistro | undefined> {
    if (asiento.origen_id === null) return undefined;
    if (asiento.origen_tipo === 'COMPRA') {
      return fila<FilaRegistro>(
        await t.query(
          `SELECT 'la compra ' || numero_factura_proveedor AS nombre,
                  creado_en, creado_por, documento_leido_id
             FROM compra_documento WHERE id = $1`,
          [asiento.origen_id],
        ),
      );
    }
    if (asiento.origen_tipo === 'VENTA') {
      return fila<FilaRegistro>(
        await t.query(
          `SELECT CASE tipo WHEN 'NOTA_CREDITO' THEN 'la nota crédito '
                            WHEN 'NOTA_DEBITO'  THEN 'la nota débito '
                            ELSE 'la factura ' END
                  || coalesce(prefijo, '') || consecutivo AS nombre,
                  creado_en, creado_por, documento_leido_id
             FROM venta_documento WHERE id = $1`,
          [asiento.origen_id],
        ),
      );
    }
    return undefined;
  }
}
