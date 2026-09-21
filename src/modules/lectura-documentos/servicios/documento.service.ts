import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import type {
  ClaseDeFalla,
  DatoExtraido,
  TipoDocumento,
} from '../proveedores/extractor.puerto';

/**
 * La fila de `documento_leido`: registrar, mover de estado, leer lo extraído.
 *
 * Nada de esto interpreta un documento. El estado de la lectura es un hecho de
 * la base —para que sobreviva a un F5 y al reinicio del servidor— y esta clase
 * es lo único que lo escribe.
 */

export type EstadoDocumento = 'EN_COLA' | 'LEYENDO' | 'LEIDO' | 'FALLO';

export interface Documento {
  id: string;
  tipo: TipoDocumento;
  estado: EstadoDocumento;
  claveAlmacenamiento: string;
  datos: DatoExtraido[];
  error: string | null;
  creadoEn: string;
  leidoEn: string | null;
}

interface FilaDocumento {
  id: string;
  tipo: TipoDocumento;
  estado: EstadoDocumento;
  clave_almacenamiento: string;
  extraido: unknown;
  error: string | null;
  creado_en: Date | string;
  leido_en: Date | string | null;
}

/** El prefijo del bucket donde viven los documentos de una empresa. */
export function prefijoDe(empresaId: string): string {
  return `documentos/${empresaId}`;
}

@Injectable()
export class DocumentoService {
  constructor(private readonly tx: TxService) {}

  /**
   * Encola un archivo que el navegador ya subió al bucket.
   *
   * La llave vuelve por el navegador, así que se vuelve a mirar acá: tiene que
   * ser del prefijo de esta empresa. Sin esto, pedir la lectura del RUT de otra
   * empresa sería cuestión de escribir otra llave.
   */
  async registrar(
    ctx: CtxEmpresa,
    datos: { tipo: TipoDocumento; clave: string },
  ): Promise<Documento> {
    const prefijo = `${prefijoDe(ctx.empresaId)}/`;
    if (!datos.clave.startsWith(prefijo)) {
      throw new BadRequestException(
        'Esa llave no es de un documento de esta empresa.',
      );
    }

    return this.tx.enContexto(ctx, async (t) => {
      const creada = fila<FilaDocumento>(
        await t.query(
          `INSERT INTO documento_leido
             (empresa_id, tipo, clave_almacenamiento, creado_por)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [ctx.empresaId, datos.tipo, datos.clave, ctx.usuarioId],
        ),
      );
      return aDocumento(creada!);
    });
  }

  /** El último intento de cada tipo: lo que muestra la tarjeta de documentos. */
  async listar(ctx: CtxEmpresa): Promise<Documento[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontradas = filas<FilaDocumento>(
        await t.query(
          `SELECT DISTINCT ON (tipo) *
             FROM documento_leido
            WHERE empresa_id = $1
            ORDER BY tipo, creado_en DESC`,
          [ctx.empresaId],
        ),
      );
      return encontradas.map(aDocumento);
    });
  }

  async porId(ctx: CtxEmpresa, id: string): Promise<Documento> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontrada = fila<FilaDocumento>(
        await t.query('SELECT * FROM documento_leido WHERE id = $1', [id]),
      );
      if (encontrada === undefined) {
        throw new NotFoundException('Ese documento no existe.');
      }
      return aDocumento(encontrada);
    });
  }

  async marcarLeyendo(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido SET estado = 'LEYENDO'
          WHERE id = $1 AND estado = 'EN_COLA'`,
        [id],
      ),
    );
  }

  async guardarLeido(
    ctx: CtxEmpresa,
    id: string,
    datos: DatoExtraido[],
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido
            SET estado = 'LEIDO', extraido = $2::jsonb, leido_en = now(), error = NULL
          WHERE id = $1`,
        [id, JSON.stringify(datos)],
      ),
    );
  }

  /**
   * El intento terminó mal. La clase queda en el registro del servidor; en la
   * fila queda el motivo, que es lo que la persona va a leer.
   */
  async marcarFallo(
    ctx: CtxEmpresa,
    id: string,
    falla: { clase: ClaseDeFalla; motivo: string },
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido
            SET estado = 'FALLO', error = $2, leido_en = now()
          WHERE id = $1`,
        [id, falla.motivo],
      ),
    );
  }
}

function aDocumento(f: FilaDocumento): Documento {
  return {
    id: f.id,
    tipo: f.tipo,
    estado: f.estado,
    claveAlmacenamiento: f.clave_almacenamiento,
    datos: Array.isArray(f.extraido) ? (f.extraido as DatoExtraido[]) : [],
    error: f.error,
    creadoEn: comoTexto(f.creado_en),
    leidoEn: f.leido_en === null ? null : comoTexto(f.leido_en),
  };
}

function comoTexto(valor: Date | string): string {
  return valor instanceof Date ? valor.toISOString() : valor;
}
