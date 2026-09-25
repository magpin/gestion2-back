import { createHash } from 'node:crypto';

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
  MedicionLectura,
  TipoDocumento,
} from '../proveedores/extractor.puerto';

/**
 * La fila de `documento_leido`: registrar, mover de estado, leer lo extraído.
 *
 * Nada de esto interpreta un documento. El estado de la lectura es un hecho de
 * la base —para que sobreviva a un F5 y al reinicio del servidor— y esta clase
 * es lo único que lo escribe.
 */

export type EstadoDocumento =
  'EN_COLA' | 'LEYENDO' | 'LEIDO' | 'FALLO' | 'DESCARTADO';

export interface Documento {
  id: string;
  tipo: TipoDocumento;
  estado: EstadoDocumento;
  claveAlmacenamiento: string;
  /**
   * Los campos sueltos de un documento de configuración. **Vacío en una
   * factura**, que no tiene campos sueltos: lo suyo está en `extraido`.
   */
  datos: DatoExtraido[];
  /**
   * Lo guardado tal cual, sin interpretar. En los tres de configuración es el
   * mismo arreglo que `datos`; en una factura es el objeto con la cabecera, los
   * renglones y el cruce (migración 0061).
   *
   * Existe porque `datos` filtra por `Array.isArray`, y sin esto una factura
   * leída salía de acá vacía: la forma que la base admite son dos, y quien
   * sabe cuál es cada una es quien conoce el tipo.
   */
  extraido: unknown;
  /**
   * En qué compra terminó esta lectura, si una persona la confirmó. `null`
   * mientras nadie la registró, que es el estado normal de una recién leída.
   *
   * Solo lo trae `listarFacturas`: `porId` mira una sola fila y no vale hacerle
   * el JOIN a las tres de configuración, que nunca terminan en una compra.
   */
  compra: { id: string; numero: string; estado: string } | null;
  /** Lo mismo para un pedido: en qué factura de venta terminó. */
  venta: { id: string; numero: string; estado: string } | null;
  error: string | null;
  creadoEn: string;
  leidoEn: string | null;
  /** Por qué una persona la dejó sin registrar (0067). Solo en DESCARTADO. */
  motivoDescarte: string | null;
  /** Cuándo una persona confirmó lo leído (0068). `null`: todavía no. */
  confirmadoEn: string | null;
  /** Lo que pasó al confirmar: lo aplicado y lo que quedó sin aplicar. */
  confirmacion: {
    aplicados: string[];
    sinAplicar: Array<{ campo: string; etiqueta: string; motivo: string }>;
    /** Lo que la persona cambió de lo leído, campo por valor. */
    correcciones?: Record<string, string>;
  } | null;
}

interface FilaDocumento {
  id: string;
  tipo: TipoDocumento;
  estado: EstadoDocumento;
  clave_almacenamiento: string;
  extraido: unknown;
  compra_id?: string | null;
  compra_numero?: string | null;
  compra_estado?: string | null;
  venta_id?: string | null;
  venta_numero?: string | null;
  venta_estado?: string | null;
  error: string | null;
  creado_en: Date | string;
  leido_en: Date | string | null;
  motivo_descarte?: string | null;
  confirmado_en?: Date | string | null;
  confirmacion?: unknown;
}

/** El prefijo del bucket donde viven los documentos de una empresa. */
/**
 * La llave vuelve por el navegador: tiene que ser del prefijo de **esta**
 * empresa. Se mira antes de tocar el archivo —también antes de bajarlo para
 * reconocerlo—, no solo antes de guardar la fila.
 */
export function exigirClaveDeLaEmpresa(ctx: CtxEmpresa, clave: string): void {
  if (!clave.startsWith(`${prefijoDe(ctx.empresaId)}/`)) {
    throw new BadRequestException(
      'Esa llave no es de un documento de esta empresa.',
    );
  }
}

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
    exigirClaveDeLaEmpresa(ctx, datos.clave);

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
  /**
   * El último intento de cada documento de configuración: es lo que la tarjeta
   * necesita para dibujarse después de un F5.
   *
   * **Las facturas quedan afuera**, y no es un filtro de conveniencia: hay un
   * RUT y hay muchas facturas. `DISTINCT ON (tipo)` es la consulta correcta
   * para lo primero y devolvería una sola factura para lo segundo, que es el
   * mismo supuesto que la migración 0061 sacó del índice único.
   */
  async listar(ctx: CtxEmpresa): Promise<Documento[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontradas = filas<FilaDocumento>(
        await t.query(
          `SELECT DISTINCT ON (tipo) *
             FROM documento_leido
            WHERE empresa_id = $1
              AND tipo NOT IN ('FACTURA_COMPRA', 'PEDIDO_VENTA', 'VENTA_HISTORICA')
            ORDER BY tipo, creado_en DESC`,
          [ctx.empresaId],
        ),
      );
      return encontradas.map(aDocumento);
    });
  }

  /**
   * Las últimas facturas leídas, las más nuevas primero. Todas, no una por
   * tipo: son muchas y cada una es su propio caso.
   *
   * Trae **en qué compra terminó cada una**, si terminó en alguna. Sin eso la
   * lista miente: tres lecturas de la misma cuenta de cobro se ven idénticas
   * —«me faltan 2 datos»— cuando una de ellas ya es una compra registrada, y
   * la pantalla sigue ofreciendo registrarla.
   */
  async listarFacturas(ctx: CtxEmpresa, tope = 50): Promise<Documento[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontradas = filas<FilaDocumento>(
        await t.query(
          `SELECT d.*,
                  c.id                       AS compra_id,
                  c.numero_factura_proveedor AS compra_numero,
                  c.estado                   AS compra_estado
             FROM documento_leido d
             LEFT JOIN compra_documento c ON c.documento_leido_id = d.id
            WHERE d.empresa_id = $1 AND d.tipo = 'FACTURA_COMPRA'
            ORDER BY d.creado_en DESC
            LIMIT $2`,
          [ctx.empresaId, tope],
        ),
      );
      return encontradas.map(aDocumento);
    });
  }

  /**
   * Los últimos pedidos de clientes leídos, con la factura en que terminó cada
   * uno. Una anulada no cuenta: el pedido vuelve a quedar por facturar, que es
   * lo mismo que dice el índice único de la 0064.
   */
  async listarPedidos(ctx: CtxEmpresa, tope = 50): Promise<Documento[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontrados = filas<FilaDocumento>(
        await t.query(
          `SELECT d.*,
                  v.id     AS venta_id,
                  concat_ws('-', nullif(v.prefijo, ''), v.consecutivo::text) AS venta_numero,
                  v.estado AS venta_estado
             FROM documento_leido d
             LEFT JOIN venta_documento v
               ON v.documento_leido_id = d.id AND v.estado <> 'ANULADA'
            WHERE d.empresa_id = $1 AND d.tipo = 'PEDIDO_VENTA'
            ORDER BY d.creado_en DESC
            LIMIT $2`,
          [ctx.empresaId, tope],
        ),
      );
      return encontrados.map(aDocumento);
    });
  }

  /**
   * Los últimos archivos con ventas del sistema anterior (fase 11). Cuáles de
   * sus facturas ya están en el sistema no se dice acá: lo agrega quien las
   * muestra, mirando los números.
   */
  async listarVentasHistoricas(
    ctx: CtxEmpresa,
    tope = 50,
  ): Promise<Documento[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const encontrados = filas<FilaDocumento>(
        await t.query(
          `SELECT * FROM documento_leido
            WHERE empresa_id = $1 AND tipo = 'VENTA_HISTORICA'
            ORDER BY creado_en DESC
            LIMIT $2`,
          [ctx.empresaId, tope],
        ),
      );
      return encontrados.map(aDocumento);
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

  /** Cómo se llama y qué NIT tiene la empresa de quien pregunta. */
  async empresaDe(
    ctx: CtxEmpresa,
  ): Promise<{ razonSocial: string; nit: string } | null> {
    return this.tx.enContexto(ctx, async (t) => {
      const e = fila<{ razon_social: string; nit: string }>(
        await t.query('SELECT razon_social, nit FROM empresa WHERE id = $1', [
          ctx.empresaId,
        ]),
      );
      return e === undefined
        ? null
        : { razonSocial: e.razon_social, nit: e.nit };
    });
  }

  /**
   * Deja una lectura sin registrar, con quién, cuándo y por qué (0067): «es la
   * misma, descartala» sobre un posible duplicado.
   *
   * Solo una leída y sin registrar: una que ya es compra o factura se corrige
   * anulando ese documento, no escondiendo de dónde salió.
   */
  async descartar(
    ctx: CtxEmpresa,
    id: string,
    tipo: 'FACTURA_COMPRA' | 'PEDIDO_VENTA' | 'VENTA_HISTORICA',
    motivo: string,
  ): Promise<Documento> {
    return this.tx.enContexto(ctx, async (t) => {
      const actual = fila<FilaDocumento & { registrada: boolean }>(
        await t.query(
          `SELECT d.*,
                  EXISTS (SELECT 1 FROM compra_documento c
                           WHERE c.documento_leido_id = d.id AND c.estado <> 'ANULADA')
               OR EXISTS (SELECT 1 FROM venta_documento v
                           WHERE v.documento_leido_id = d.id AND v.estado <> 'ANULADA')
                  -- Ventas anteriores: si ya se cargó alguna de sus facturas.
               OR jsonb_array_length(coalesce(d.confirmacion -> 'aplicados', '[]'::jsonb)) > 0
                  AS registrada
             FROM documento_leido d
            WHERE d.id = $1 AND d.tipo = $2
            FOR UPDATE`,
          [id, tipo],
        ),
      );
      if (actual === undefined) {
        throw new NotFoundException('Ese documento no existe.');
      }
      if (actual.registrada) {
        throw new BadRequestException(
          'Ya está registrado: para dejarlo sin efecto, anulá el documento que se registró.',
        );
      }
      if (actual.estado !== 'LEIDO') {
        throw new BadRequestException(
          actual.estado === 'DESCARTADO'
            ? 'Ya estaba descartado.'
            : 'Solo se descarta lo que ya se leyó.',
        );
      }
      const hecho = fila<FilaDocumento>(
        await t.query(
          `UPDATE documento_leido
              SET estado = 'DESCARTADO', descartado_en = now(),
                  descartado_por = $2, motivo_descarte = $3
            WHERE id = $1
            RETURNING *`,
          [id, ctx.usuarioId, motivo.trim()],
        ),
      );
      return aDocumento(hecho!);
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

  /**
   * `extraido` es un arreglo de `DatoExtraido` en los tres documentos de
   * configuración, y un objeto en una factura (migración 0061). La base no mira
   * adentro: lo que garantiza es que sea una de esas dos formas, y quién valida
   * el contenido son las reglas del módulo.
   */
  async guardarLeido(
    ctx: CtxEmpresa,
    id: string,
    datos: DatoExtraido[] | object,
    medicion?: MedicionLectura,
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido
            SET estado = 'LEIDO', extraido = $2::jsonb, leido_en = now(), error = NULL,
                uso = $3::jsonb, modelo = $4, duracion_ms = $5
          WHERE id = $1`,
        [id, JSON.stringify(datos), ...columnasDe(medicion)],
      ),
    );
  }

  /**
   * El sha256 del archivo (0066). Se guarda al leer, que es cuando el archivo
   * ya está bajado; los documentos anteriores la calculan la primera vez que
   * alguien abre el historial de su asiento. Si ya la tenía no se pisa: la
   * huella es de lo que se leyó, no de lo que haya hoy en el bucket.
   */
  /** Lo que pasó al confirmar la lectura (0068): para no volver a pedirlo. */
  async guardarConfirmacion(
    ctx: CtxEmpresa,
    id: string,
    resultado: {
      aplicados: string[];
      sinAplicar: Array<{ campo: string; etiqueta: string; motivo: string }>;
      correcciones?: Record<string, string>;
    },
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido SET confirmado_en = now(), confirmacion = $2::jsonb
          WHERE id = $1`,
        [id, JSON.stringify(resultado)],
      ),
    );
  }

  async guardarHuella(
    ctx: CtxEmpresa,
    id: string,
    contenido: Buffer,
  ): Promise<string> {
    const huella = createHash('sha256').update(contenido).digest('hex');
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido SET huella_sha256 = $2
          WHERE id = $1 AND huella_sha256 IS NULL`,
        [id, huella],
      ),
    );
    return huella;
  }

  /**
   * El intento terminó mal. La clase queda en el registro del servidor; en la
   * fila queda el motivo, que es lo que la persona va a leer.
   */
  async marcarFallo(
    ctx: CtxEmpresa,
    id: string,
    falla: { clase: ClaseDeFalla; motivo: string; medicion?: MedicionLectura },
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE documento_leido
            SET estado = 'FALLO', error = $2, leido_en = now(),
                uso = $3::jsonb, modelo = $4, duracion_ms = $5
          WHERE id = $1`,
        [id, falla.motivo, ...columnasDe(falla.medicion)],
      ),
    );
  }
}

/** La medición como columnas (0054). Sin medición, las tres en NULL. */
function columnasDe(
  m: MedicionLectura | undefined,
): [string | null, string | null, number | null] {
  return m === undefined
    ? [null, null, null]
    : [JSON.stringify(m.uso), m.modelo, Math.round(m.duracionMs)];
}

function aDocumento(f: FilaDocumento): Documento {
  return {
    id: f.id,
    tipo: f.tipo,
    estado: f.estado,
    claveAlmacenamiento: f.clave_almacenamiento,
    datos: Array.isArray(f.extraido) ? (f.extraido as DatoExtraido[]) : [],
    extraido: f.extraido ?? null,
    compra:
      f.compra_id == null
        ? null
        : {
            id: f.compra_id,
            numero: f.compra_numero ?? '',
            estado: f.compra_estado ?? '',
          },
    venta:
      f.venta_id == null
        ? null
        : {
            id: f.venta_id,
            numero: f.venta_numero ?? '',
            estado: f.venta_estado ?? '',
          },
    error: f.error,
    creadoEn: comoTexto(f.creado_en),
    leidoEn: f.leido_en === null ? null : comoTexto(f.leido_en),
    motivoDescarte: f.motivo_descarte ?? null,
    confirmadoEn: f.confirmado_en == null ? null : comoTexto(f.confirmado_en),
    confirmacion: (f.confirmacion as Documento['confirmacion']) ?? null,
  };
}

function comoTexto(valor: Date | string): string {
  return valor instanceof Date ? valor.toISOString() : valor;
}
