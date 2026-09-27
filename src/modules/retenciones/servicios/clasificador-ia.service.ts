import { Inject, Injectable, Optional } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { llaveDe } from '../reglas/clasificacion.reglas';
import { validarRespuesta } from '../reglas/clasificador-ia.reglas';
import {
  CLASIFICADOR_PUERTO,
  type ClasificadorPuerto,
} from '../proveedores/clasificador.puerto';
import { MotorRentaService, type DocumentoRenta } from './motor-renta.service';

/** Lo más que se le pregunta a la IA de una vez: una factura larga no dispara cien llamadas. */
const TOPE_RENGLONES = 8;

/**
 * La fuente 5 (plan motor de retenciones, Fase 5): le pregunta a la IA por
 * los renglones que ninguna fuente determinista resolvió, y guarda lo que
 * dijo en `retencion_clasificacion_ia`.
 *
 * **Se llama fuera de la transacción del documento**: la red no deja una
 * transacción abierta. Y solo al simular: al registrar, el motor lee lo que
 * ya quedó guardado, así lo que se ve es lo que se registra.
 *
 * Respeta la pausa de IA de la lectura de documentos: con la pausa puesta no
 * se gasta un token y el renglón queda en «Te pregunto».
 */
@Injectable()
export class ClasificadorIaService {
  constructor(
    private readonly tx: TxService,
    private readonly motor: MotorRentaService,
    @Inject(CLASIFICADOR_PUERTO)
    private readonly ia: ClasificadorPuerto,
    @Optional() private readonly pausa?: PausaIaService,
  ) {}

  /** Cuántos renglones quedaron con propuesta nueva. */
  async completar(ctx: CtxEmpresa, doc: DocumentoRenta): Promise<number> {
    if (!this.ia.disponible) return 0;
    const propuesta = await this.motor.proponer(ctx, doc);
    const pendientes = propuesta.renglones
      .filter((r) => r.pideIa)
      .slice(0, TOPE_RENGLONES);
    if (pendientes.length === 0) return 0;
    if ((await this.pausa?.pausada(ctx.tenantId, 'LECTURA')) ?? false) {
      return 0;
    }

    const proveedor = await this.tx.enContexto(ctx, async (t) => {
      const [p] = filas<{
        nombre: string;
        tipo_persona: 'NATURAL' | 'JURIDICA' | null;
        ciiu: string | null;
      }>(
        await t.query(
          `SELECT COALESCE(x.razon_social, concat_ws(' ', x.primer_nombre, x.primer_apellido)) AS nombre,
                  x.tipo_persona,
                  (SELECT p.ciiu_principal FROM tercero_perfil_tributario p
                    WHERE p.tercero_id = x.id AND p.vigencia_desde <= $2::date
                      AND (p.vigencia_hasta IS NULL OR p.vigencia_hasta >= $2::date)
                    ORDER BY p.vigencia_desde DESC LIMIT 1) AS ciiu
             FROM tercero x WHERE x.id = $1`,
          [doc.terceroId, doc.fecha],
        ),
      );
      return p;
    });
    if (proveedor === undefined) return 0;

    // Un renglón repetido en la factura se pregunta una vez.
    const porLlave = new Map<string, (typeof doc.renglones)[number]>();
    for (const p of pendientes) {
      const r = doc.renglones.find((x) => x.orden === p.orden);
      const llave = r === undefined ? null : llaveDe(r.texto);
      if (r !== undefined && llave !== null && !porLlave.has(llave)) {
        porLlave.set(llave, r);
      }
    }
    const codigos = propuesta.conceptos.map((c) => c.codigo);
    const respuestas = await Promise.all(
      [...porLlave].map(async ([llave, r]) => {
        const dicho = await this.ia.clasificar({
          descripcion: r.texto ?? '',
          cantidad: null,
          valor: r.subtotal,
          proveedor: {
            nombre: proveedor.nombre,
            tipoPersona: proveedor.tipo_persona,
            ciiu: proveedor.ciiu,
          },
          conceptos: propuesta.conceptos,
        });
        return { llave, dicho };
      }),
    );

    let nuevas = 0;
    await this.tx.enContexto(ctx, async (t) => {
      for (const { llave, dicho } of respuestas) {
        const v =
          dicho === null ? null : validarRespuesta(dicho.respuesta, codigos);
        const estado = v === null ? 'FALLO' : v.estado;
        if (v?.estado === 'PROPUESTA') nuevas++;
        await t.query(
          `INSERT INTO retencion_clasificacion_ia
             (empresa_id, tercero_id, llave_renglon, estado, concepto_nacional_id,
              razon, alternativas, modelo, uso, duracion_ms, creado_por)
           VALUES ($1, $2, $3, $4,
                   (SELECT id FROM retencion_concepto_nacional WHERE codigo = $5),
                   $6, $7, $8, $9, $10, $11)
           ON CONFLICT (empresa_id, tercero_id, llave_renglon) DO UPDATE
             SET estado = EXCLUDED.estado,
                 concepto_nacional_id = EXCLUDED.concepto_nacional_id,
                 razon = EXCLUDED.razon, alternativas = EXCLUDED.alternativas,
                 modelo = EXCLUDED.modelo, uso = EXCLUDED.uso,
                 duracion_ms = EXCLUDED.duracion_ms, creado_en = now(),
                 creado_por = EXCLUDED.creado_por
             WHERE retencion_clasificacion_ia.estado = 'FALLO'`,
          [
            ctx.empresaId,
            doc.terceroId,
            llave,
            estado,
            v?.concepto ?? null,
            v?.razon ?? null,
            v?.alternativas ?? [],
            dicho?.modelo ?? null,
            dicho === null ? null : JSON.stringify(dicho.uso),
            dicho?.duracionMs ?? null,
            ctx.usuarioId,
          ],
        );
      }
    });
    return nuevas;
  }
}
