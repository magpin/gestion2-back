import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  decidir,
  GUARDAS_FIJAS,
  HISTORIA_MINIMA,
  hayHistoria,
  pesos,
  ROLES_EDITAR,
  type Aciertos,
  type Decision,
  type ModoRegla,
  type ReglaVigente,
} from '../reglas/autonomia';
import type { AccionPropuesta } from '../reglas/propuestas';

const ACCIONES: readonly AccionPropuesta[] = ['COBRO', 'PAGO'];

/** Una regla como la ve la pantalla «Hasta dónde llega». */
export interface ReglaEnPantalla {
  accion: AccionPropuesta;
  modo: ModoRegla;
  limite: number | null;
  activadaPor: string | null;
  desde: string | null;
  aciertos: Aciertos;
  /** Si ya se puede pasar a «confirmar si pasa todo». */
  hayHistoria: boolean;
}

export interface EstadoAutonomia {
  pausada: boolean;
  reglas: ReglaEnPantalla[];
  guardas: readonly string[];
  historiaMinima: number;
  puedeEditar: boolean;
}

/** Lo que el asistente hizo solo, y lo que dejó apartado, en un día. */
export interface ResumenDelDia {
  fecha: string;
  registradas: {
    accion: AccionPropuesta;
    numero: string;
    tercero: string;
    valor: number;
    hora: string;
  }[];
  apartadas: {
    accion: AccionPropuesta;
    numero: string;
    tercero: string;
    motivo: string;
  }[];
}

/**
 * Hasta dónde llega el asistente (paso 8, `docs/planes/asistente-autonomia.md`).
 *
 * - **Las reglas se agregan, no se editan** (migración 0053): la vigente de
 *   cada acción es la última, y queda con quién y cuándo.
 * - **Todo arranca en «solo proponer».** Pasar una acción a «confirmar si
 *   pasa todo» exige historia: `HISTORIA_MINIMA` propuestas de esa acción que
 *   confirmó una persona.
 * - **La regla actúa con los roles de quien la activó, mirados al actuar**: si
 *   perdió el rol o lo desactivaron, su regla deja de actuar y la propuesta
 *   espera.
 * - Solo DIRECTOR cambia las reglas; cualquiera de la empresa las ve.
 */
@Injectable()
export class AutonomiaService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
  ) {}

  async estado(ctx: CtxEmpresa): Promise<EstadoAutonomia> {
    const { pausada, reglas } = await this.vigentes(ctx);
    const aciertos = await this.aciertos(ctx);
    const nombres = new Map<string, string>();
    for (const r of reglas.values()) {
      if (!nombres.has(r.activadaPor)) {
        const { nombre } = await this.nucleo.rolesVigentesDe(
          ctx,
          r.activadaPor,
          ctx.empresaId,
        );
        nombres.set(r.activadaPor, nombre);
      }
    }
    return {
      pausada,
      reglas: ACCIONES.map((accion) => {
        const r = reglas.get(accion);
        const a = aciertos[accion];
        return {
          accion,
          modo: r?.modo ?? 'SOLO_PROPONER',
          limite: r?.limite ?? null,
          activadaPor: r ? (nombres.get(r.activadaPor) ?? null) : null,
          desde: r?.desde ?? null,
          aciertos: a,
          hayHistoria: hayHistoria(a),
        };
      }),
      guardas: GUARDAS_FIJAS,
      historiaMinima: HISTORIA_MINIMA,
      puedeEditar: ctx.roles.some((r) => ROLES_EDITAR.includes(r)),
    };
  }

  /** Cambia la regla de una acción: una fila nueva, que pasa a ser la vigente. */
  async cambiarRegla(
    ctx: CtxEmpresa,
    accion: AccionPropuesta,
    modo: ModoRegla,
    limite: number | null,
  ): Promise<EstadoAutonomia> {
    this.exigirEditar(ctx);
    if (modo === 'CONFIRMAR_SI_PASA') {
      if (limite === null || !(limite > 0)) {
        throw new BadRequestException(
          'Para que confirme sola, la regla necesita un límite mayor que cero.',
        );
      }
      const a = (await this.aciertos(ctx))[accion];
      if (!hayHistoria(a)) {
        throw new BadRequestException(
          `Todavía no se puede soltar: hay ${a.confirmadas} ${accion === 'COBRO' ? 'cobros' : 'pagos'} propuestos confirmados por una persona, y hacen falta ${HISTORIA_MINIMA}.`,
        );
      }
    }
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `INSERT INTO asistente_regla (empresa_id, accion, modo, limite, activada_por)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          ctx.empresaId,
          accion,
          modo,
          modo === 'CONFIRMAR_SI_PASA' ? limite : null,
          ctx.usuarioId,
        ],
      ),
    );
    return this.estado(ctx);
  }

  /** «Pausar la autonomía»: todo vuelve a solo proponer, sin perder las reglas. */
  async pausar(ctx: CtxEmpresa, pausada: boolean): Promise<EstadoAutonomia> {
    this.exigirEditar(ctx);
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `INSERT INTO asistente_regla (empresa_id, accion, modo, activada_por)
         VALUES ($1, 'GENERAL', $2, $3)`,
        [ctx.empresaId, pausada ? 'PAUSADA' : 'ACTIVA', ctx.usuarioId],
      ),
    );
    return this.estado(ctx);
  }

  /**
   * Si una propuesta recién verificada se confirma sola. Se mira al proponer
   * —para que el asistente diga lo que va a pasar— y otra vez al confirmar,
   * porque los roles de quien activó la regla se miran al actuar.
   */
  async decidir(
    ctx: CtxEmpresa,
    accion: AccionPropuesta,
    documentoId: string,
    total: number,
  ): Promise<Decision> {
    const { pausada, reglas } = await this.vigentes(ctx);
    const regla = reglas.get(accion) ?? null;
    if (pausada || regla === null || regla.modo !== 'CONFIRMAR_SI_PASA') {
      return { confirmar: false, motivo: null };
    }
    const { roles } = await this.nucleo.rolesVigentesDe(
      ctx,
      regla.activadaPor,
      ctx.empresaId,
    );
    const duplicado = await this.tx.enContexto(ctx, async (t) =>
      fila<{ hay: boolean }>(
        await t.query(
          `SELECT EXISTS (
             SELECT 1 FROM asistente_propuesta
              WHERE documento_id = $1 AND estado = 'CONFIRMADA'
                AND (resuelta_en AT TIME ZONE 'America/Bogota')::date
                    = (now() AT TIME ZONE 'America/Bogota')::date
                AND (SELECT coalesce(sum((p->>'valor')::numeric), 0)
                       FROM jsonb_array_elements(cuerpo_confirmado->'pagos') p) = $2
           ) AS hay`,
          [documentoId, total],
        ),
      ),
    );
    return decidir({
      accion,
      total,
      pausada,
      regla,
      rolesDelActivador: roles,
      duplicadoPosible: duplicado?.hay === true,
    });
  }

  /** Lo que hizo solo y lo que apartó en un día (hoy, si no se dice). */
  async resumen(ctx: CtxEmpresa, fecha?: string): Promise<ResumenDelDia> {
    return this.tx.enContexto(ctx, async (t) => {
      const dia = fila<{ dia: string }>(
        // El día de Colombia, no el del servidor de la base.
        await t.query(
          `SELECT coalesce($1::date, (now() AT TIME ZONE 'America/Bogota')::date)::text AS dia`,
          [fecha ?? null],
        ),
      )!.dia;
      const lista = filas<{
        accion: AccionPropuesta;
        numero: string;
        tercero: string;
        valor: string;
        hora: string;
        automatica: boolean;
        motivo: string | null;
      }>(
        await t.query(
          `SELECT accion,
                  vista_previa->'documento'->>'numero' AS numero,
                  vista_previa->'documento'->>'tercero' AS tercero,
                  (SELECT coalesce(sum((p->>'valor')::numeric), 0)
                     FROM jsonb_array_elements(coalesce(cuerpo_confirmado, cuerpo)->'pagos') p)::text AS valor,
                  to_char(coalesce(resuelta_en, creada_en) AT TIME ZONE 'America/Bogota', 'HH24:MI') AS hora,
                  confirmada_por_regla IS NOT NULL AS automatica,
                  error AS motivo
             FROM asistente_propuesta
            WHERE (creada_en AT TIME ZONE 'America/Bogota')::date = $1::date
              AND (confirmada_por_regla IS NOT NULL
                   OR (estado = 'PENDIENTE' AND error LIKE 'No se registró sola:%'))
            ORDER BY creada_en`,
          [dia],
        ),
      );
      return {
        fecha: dia,
        registradas: lista
          .filter((l) => l.automatica)
          .map((l) => ({
            accion: l.accion,
            numero: l.numero,
            tercero: l.tercero,
            valor: Number(l.valor),
            hora: l.hora,
          })),
        apartadas: lista
          .filter((l) => !l.automatica)
          .map((l) => ({
            accion: l.accion,
            numero: l.numero,
            tercero: l.tercero,
            motivo: l.motivo ?? '',
          })),
      };
    });
  }

  /**
   * Lo que el asistente tiene que saber de la autonomía en este turno, para
   * las instrucciones del sistema. `null` si nada se registra solo: entonces
   * vale la regla de siempre, todo espera el botón.
   */
  async contexto(ctx: CtxEmpresa): Promise<string | null> {
    const { pausada, reglas } = await this.vigentes(ctx);
    if (pausada) return null;
    const activas = [...reglas.values()].filter(
      (r) => r.modo === 'CONFIRMAR_SI_PASA',
    );
    if (activas.length === 0) return null;
    return `Autonomía (la escribe el sistema en cada turno): ${activas
      .map((r) => AutonomiaService.descripcion(r))
      .join(
        '; ',
      )} se registran solos si pasan la verificación; lo demás espera el botón Confirmar. La verificación de cada propuesta te dice si esa se registra sola o por qué no.`;
  }

  /** Una frase para el asistente: qué regla aplica y hasta cuánto. */
  static descripcion(regla: ReglaVigente): string {
    return `${regla.accion === 'COBRO' ? 'cobros' : 'pagos'} hasta ${pesos(regla.limite ?? 0)}`;
  }

  private exigirEditar(ctx: CtxEmpresa) {
    if (!ctx.roles.some((r) => ROLES_EDITAR.includes(r))) {
      throw new ForbiddenException(
        'Solo la dirección decide hasta dónde llega el asistente.',
      );
    }
  }

  /** Las reglas vigentes —la última fila de cada acción— y la pausa general. */
  private async vigentes(ctx: CtxEmpresa): Promise<{
    pausada: boolean;
    reglas: Map<AccionPropuesta, ReglaVigente & { desde: string }>;
  }> {
    const ultimas = await this.tx.enContexto(ctx, async (t) =>
      filas<{
        id: string;
        accion: AccionPropuesta | 'GENERAL';
        modo: string;
        limite: string | null;
        activada_por: string;
        creada_en: string;
      }>(
        await t.query(
          `SELECT DISTINCT ON (accion) id, accion, modo, limite, activada_por, creada_en
             FROM asistente_regla
            ORDER BY accion, creada_en DESC, id`,
        ),
      ),
    );
    const reglas = new Map<AccionPropuesta, ReglaVigente & { desde: string }>();
    let pausada = false;
    for (const r of ultimas) {
      if (r.accion === 'GENERAL') {
        pausada = r.modo === 'PAUSADA';
        continue;
      }
      reglas.set(r.accion, {
        id: r.id,
        accion: r.accion,
        modo: r.modo as ModoRegla,
        limite: r.limite === null ? null : Number(r.limite),
        activadaPor: r.activada_por,
        desde: r.creada_en,
      });
    }
    return { pausada, reglas };
  }

  /** Los aciertos de cada acción, de las propuestas de la empresa. */
  private async aciertos(
    ctx: CtxEmpresa,
  ): Promise<Record<AccionPropuesta, Aciertos>> {
    const conteo = await this.tx.enContexto(ctx, async (t) =>
      filas<{
        accion: AccionPropuesta;
        confirmadas: number;
        sin_corregir: number;
        automaticas: number;
      }>(
        await t.query(
          `SELECT accion,
                  count(*) FILTER (WHERE confirmada_por_regla IS NULL)::int AS confirmadas,
                  count(*) FILTER (WHERE confirmada_por_regla IS NULL
                                     AND cuerpo_confirmado = cuerpo)::int AS sin_corregir,
                  count(*) FILTER (WHERE confirmada_por_regla IS NOT NULL)::int AS automaticas
             FROM asistente_propuesta
            WHERE estado = 'CONFIRMADA'
            GROUP BY accion`,
        ),
      ),
    );
    const vacio: Aciertos = { confirmadas: 0, sinCorregir: 0, automaticas: 0 };
    const r: Record<AccionPropuesta, Aciertos> = { COBRO: vacio, PAGO: vacio };
    for (const c of conteo) {
      r[c.accion] = {
        confirmadas: c.confirmadas,
        sinCorregir: c.sin_corregir,
        automaticas: c.automaticas,
      };
    }
    return r;
  }
}
