import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  CrearCentroCostoDto,
  EditarCentroCostoDto,
  GuardarRepartoDto,
} from '../dto/plan-cuentas.dto';
import { repartoCompleto, resolverCentro } from './centros-costo.reglas';

export type TipoCentro = 'PRODUCTIVO' | 'APOYO' | 'ADMINISTRATIVO';

export interface CentroCosto {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  padreId: string | null;
  sedeId: string | null;
  sedeNombre: string | null;
  tipo: TipoCentro;
  esPorDefecto: boolean;
  /** Agrupa otros: no recibe movimientos. */
  agrupa: boolean;
}

interface FilaCentro {
  id: string;
  codigo: string;
  nombre: string;
  activo: boolean;
  padre_id: string | null;
  sede_id: string | null;
  sede_nombre: string | null;
  tipo: TipoCentro;
  es_por_defecto: boolean;
  agrupa: boolean;
}

const SELECT_CENTRO = `
  SELECT c.id, c.codigo, c.nombre, c.activo, c.padre_id, c.sede_id,
         s.nombre AS sede_nombre, c.tipo, c.es_por_defecto,
         EXISTS (SELECT 1 FROM empresa_centro_costo h WHERE h.padre_id = c.id) AS agrupa
    FROM empresa_centro_costo c
    LEFT JOIN empresa_sede s ON s.id = c.sede_id`;

function aCentro(f: FilaCentro): CentroCosto {
  return {
    id: f.id,
    codigo: f.codigo,
    nombre: f.nombre,
    activo: f.activo,
    padreId: f.padre_id,
    sedeId: f.sede_id,
    sedeNombre: f.sede_nombre,
    tipo: f.tipo,
    esPorDefecto: f.es_por_defecto,
    agrupa: f.agrupa,
  };
}

/** Un reparto de un gasto común entre centros (fase 8, D6). */
export interface Reparto {
  id: string;
  nombre: string;
  base: string | null;
  activo: boolean;
  partes: Array<{
    centroCostoId: string;
    centroNombre: string;
    porcentaje: number;
  }>;
}

/** Las clases del PUC que llevan centro cuando la empresa lo maneja (D2). */
const CLASES_DE_RESULTADO = ['4', '5', '6', '7'];

/**
 * Los centros de costo de una empresa: dónde se vendió o se gastó (sede,
 * área, proyecto). Ver `docs/planes/plan-centros-de-costo.md`.
 *
 * La base sostiene la forma (dos niveles, un solo por defecto, de la misma
 * empresa: `0123`); acá van las reglas que dependen de más de una fila.
 */
@Injectable()
export class CentrosCostoService {
  constructor(private readonly tx: TxService) {}

  async listar(ctx: CtxEmpresa, soloActivos = false): Promise<CentroCosto[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<FilaCentro>(
        await t.query(
          `${SELECT_CENTRO}
           ${soloActivos ? 'WHERE c.activo' : ''}
           ORDER BY c.codigo`,
        ),
      ).map(aCentro),
    );
  }

  async crear(ctx: CtxEmpresa, dto: CrearCentroCostoDto): Promise<CentroCosto> {
    return this.tx.enContexto(ctx, async (t) => {
      if (dto.padreId) await this.exigirAgrupable(dto.padreId, t);
      if (dto.esPorDefecto) await this.quitarPorDefecto(t);
      const nuevo = fila<{ id: string }>(
        await t.query(
          `INSERT INTO empresa_centro_costo
             (empresa_id, codigo, nombre, padre_id, sede_id, tipo, es_por_defecto)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            ctx.empresaId,
            dto.codigo.trim(),
            dto.nombre.trim(),
            dto.padreId ?? null,
            dto.sedeId ?? null,
            dto.tipo ?? 'PRODUCTIVO',
            dto.esPorDefecto ?? false,
          ],
        ),
      );
      return this.porId(nuevo!.id, t);
    });
  }

  /**
   * `padreId` y `sedeId` en `null` los quitan; ausentes, no cambian. Marcar
   * uno como por defecto le quita la marca al que la tenía.
   */
  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarCentroCostoDto,
  ): Promise<CentroCosto> {
    return this.tx.enContexto(ctx, async (t) => {
      const actual = await this.porId(id, t);
      if (dto.padreId) await this.exigirAgrupable(dto.padreId, t);
      if (dto.esPorDefecto === true && !actual.esPorDefecto) {
        if (!actual.activo) {
          throw new BadRequestException(
            'Un centro desactivado no puede ser el de por defecto.',
          );
        }
        await this.quitarPorDefecto(t);
      }
      if (dto.esPorDefecto === false && actual.esPorDefecto) {
        throw new BadRequestException(
          'Elija otro centro como el de por defecto: siempre tiene que haber uno.',
        );
      }
      await t.query(
        `UPDATE empresa_centro_costo
            SET nombre         = COALESCE($2, nombre),
                padre_id       = CASE WHEN $3 THEN $4::uuid ELSE padre_id END,
                sede_id        = CASE WHEN $5 THEN $6::uuid ELSE sede_id END,
                tipo           = COALESCE($7, tipo),
                es_por_defecto = COALESCE($8, es_por_defecto)
          WHERE id = $1`,
        [
          id,
          dto.nombre?.trim() ?? null,
          dto.padreId !== undefined,
          dto.padreId ?? null,
          dto.sedeId !== undefined,
          dto.sedeId ?? null,
          dto.tipo ?? null,
          dto.esPorDefecto ?? null,
        ],
      );
      return this.porId(id, t);
    });
  }

  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const centro = await this.porId(id, t);
      if (centro.esPorDefecto) {
        throw new BadRequestException(
          'Este es el centro de por defecto: elija otro como por defecto antes de desactivarlo.',
        );
      }
      const hijos = filas<{ codigo: string }>(
        await t.query(
          `SELECT codigo FROM empresa_centro_costo
            WHERE padre_id = $1 AND activo ORDER BY codigo`,
          [id],
        ),
      );
      if (hijos.length > 0) {
        throw new BadRequestException(
          `Este centro agrupa centros activos (${hijos.map((h) => h.codigo).join(', ')}): desactívelos primero.`,
        );
      }
      await t.query(
        'UPDATE empresa_centro_costo SET activo = false WHERE id = $1',
        [id],
      );
      // Quien lo tenía como suyo vuelve a la cadena (sede, por defecto).
      await t.query(
        'DELETE FROM usuario_empresa_centro WHERE centro_costo_id = $1',
        [id],
      );
    });
  }

  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await this.porId(id, t);
      await t.query(
        'UPDATE empresa_centro_costo SET activo = true WHERE id = $1',
        [id],
      );
    });
  }

  /**
   * Un centro por cada sede activa que todavía no tenga el suyo, con el
   * código y el nombre de la sede. Si la empresa no tiene centro por defecto,
   * lo es el de la sede principal.
   */
  async crearDesdeSedes(ctx: CtxEmpresa): Promise<CentroCosto[]> {
    return this.tx.enContexto(ctx, async (t) => {
      const sedes = filas<{
        id: string;
        codigo: string;
        nombre: string;
        es_principal: boolean;
      }>(
        await t.query(
          `SELECT s.id, s.codigo, s.nombre, s.es_principal
             FROM empresa_sede s
            WHERE s.activo
              AND NOT EXISTS (SELECT 1 FROM empresa_centro_costo c WHERE c.sede_id = s.id)
            ORDER BY s.es_principal DESC, s.codigo`,
        ),
      );
      const hayPorDefecto = fila<{ id: string }>(
        await t.query(
          'SELECT id FROM empresa_centro_costo WHERE es_por_defecto AND activo',
        ),
      );
      const usados = new Set(
        filas<{ codigo: string }>(
          await t.query('SELECT codigo FROM empresa_centro_costo'),
        ).map((c) => c.codigo),
      );
      for (const s of sedes) {
        let codigo = s.codigo.slice(0, 20);
        for (let n = 2; usados.has(codigo); n++) {
          codigo = `${s.codigo.slice(0, 16)}-${n}`;
        }
        usados.add(codigo);
        await t.query(
          `INSERT INTO empresa_centro_costo
             (empresa_id, codigo, nombre, sede_id, tipo, es_por_defecto)
           VALUES ($1, $2, $3, $4, 'PRODUCTIVO', $5)`,
          [
            ctx.empresaId,
            codigo,
            s.nombre,
            s.id,
            hayPorDefecto === undefined && s.es_principal,
          ],
        );
      }
      return filas<FilaCentro>(
        await t.query(`${SELECT_CENTRO} ORDER BY c.codigo`),
      ).map(aCentro);
    });
  }

  // ---------------------------------------------------------------------------
  // Repartos por porcentajes (fase 8)
  // ---------------------------------------------------------------------------

  async listarRepartos(ctx: CtxEmpresa): Promise<Reparto[]> {
    return this.tx.enContexto(ctx, async (t) => this.repartosEn(t));
  }

  async crearReparto(
    ctx: CtxEmpresa,
    dto: GuardarRepartoDto,
  ): Promise<Reparto> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirPartes(dto, t);
      const nuevo = fila<{ id: string }>(
        await t.query(
          `INSERT INTO centro_costo_reparto (empresa_id, nombre, base)
           VALUES ($1, $2, $3) RETURNING id`,
          [ctx.empresaId, dto.nombre.trim(), dto.base?.trim() || null],
        ),
      );
      await this.guardarPartes(ctx, nuevo!.id, dto, t);
      return (await this.repartosEn(t, nuevo!.id))[0];
    });
  }

  /** Cambia el nombre, la base y las partes. Lo ya registrado no cambia. */
  async editarReparto(
    ctx: CtxEmpresa,
    id: string,
    dto: GuardarRepartoDto,
  ): Promise<Reparto> {
    return this.tx.enContexto(ctx, async (t) => {
      const existe = fila<{ id: string }>(
        await t.query('SELECT id FROM centro_costo_reparto WHERE id = $1', [
          id,
        ]),
      );
      if (existe === undefined) {
        throw new NotFoundException('El reparto no existe.');
      }
      await this.exigirPartes(dto, t);
      await t.query(
        'UPDATE centro_costo_reparto SET nombre = $2, base = $3 WHERE id = $1',
        [id, dto.nombre.trim(), dto.base?.trim() || null],
      );
      await t.query(
        'DELETE FROM centro_costo_reparto_linea WHERE reparto_id = $1',
        [id],
      );
      await this.guardarPartes(ctx, id, dto, t);
      return (await this.repartosEn(t, id))[0];
    });
  }

  async fijarRepartoActivo(
    ctx: CtxEmpresa,
    id: string,
    activo: boolean,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const existe = fila<{ id: string }>(
        await t.query('SELECT id FROM centro_costo_reparto WHERE id = $1', [
          id,
        ]),
      );
      if (existe === undefined) {
        throw new NotFoundException('El reparto no existe.');
      }
      await t.query(
        'UPDATE centro_costo_reparto SET activo = $2 WHERE id = $1',
        [id, activo],
      );
    });
  }

  private async repartosEn(t: Tx, id?: string): Promise<Reparto[]> {
    const filasReparto = filas<{
      id: string;
      nombre: string;
      base: string | null;
      activo: boolean;
      partes: Array<{
        centroCostoId: string;
        centroNombre: string;
        porcentaje: string;
      }>;
    }>(
      await t.query(
        `SELECT r.id, r.nombre, r.base, r.activo,
                coalesce((SELECT json_agg(json_build_object(
                            'centroCostoId', l.centro_costo_id,
                            'centroNombre', c.codigo || ' · ' || c.nombre,
                            'porcentaje', l.porcentaje) ORDER BY l.orden)
                            FROM centro_costo_reparto_linea l
                            JOIN empresa_centro_costo c ON c.id = l.centro_costo_id
                           WHERE l.reparto_id = r.id), '[]'::json) AS partes
           FROM centro_costo_reparto r
          ${id === undefined ? '' : 'WHERE r.id = $1'}
          ORDER BY r.activo DESC, r.nombre`,
        id === undefined ? [] : [id],
      ),
    );
    return filasReparto.map((r) => ({
      ...r,
      partes: r.partes.map((p) => ({ ...p, porcentaje: Number(p.porcentaje) })),
    }));
  }

  /** Suman 100, sin centros repetidos, y cada uno recibe movimientos. */
  private async exigirPartes(dto: GuardarRepartoDto, t: Tx): Promise<void> {
    const ids = dto.partes.map((p) => p.centroCostoId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException(
        'Un centro aparece dos veces en el reparto: sume sus porcentajes en uno.',
      );
    }
    if (!repartoCompleto(dto.partes)) {
      const suma = dto.partes.reduce((s, p) => s + p.porcentaje, 0);
      throw new BadRequestException(
        `Los porcentajes suman ${Math.round(suma * 10000) / 10000} %: tienen que sumar 100 %.`,
      );
    }
    for (const id of ids) await this.exigirUsable(id, t);
  }

  private async guardarPartes(
    ctx: CtxEmpresa,
    repartoId: string,
    dto: GuardarRepartoDto,
    t: Tx,
  ): Promise<void> {
    for (const [i, p] of dto.partes.entries()) {
      await t.query(
        `INSERT INTO centro_costo_reparto_linea
           (reparto_id, empresa_id, orden, centro_costo_id, porcentaje)
         VALUES ($1, $2, $3, $4, $5)`,
        [repartoId, ctx.empresaId, i + 1, p.centroCostoId, p.porcentaje],
      );
    }
  }

  /** Si la empresa maneja centros de costo. */
  async maneja(ctx: CtxEmpresa, tx?: Tx): Promise<boolean> {
    return this.tx.enContexto(ctx, async (t) => this.manejaEn(t), tx);
  }

  /**
   * Encender o apagar el manejo (D2). Encender exige un centro por defecto y
   * marca «exige centro» en todas las cuentas de ingresos, costos y gastos
   * (clases 4 a 7); apagar las desmarca. Lo ya registrado no cambia.
   */
  async fijarManejo(ctx: CtxEmpresa, activo: boolean): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      if (activo) {
        const porDefecto = fila<{ id: string }>(
          await t.query(
            'SELECT id FROM empresa_centro_costo WHERE es_por_defecto AND activo',
          ),
        );
        if (porDefecto === undefined) {
          throw new BadRequestException(
            'Antes de encender los centros de costo, elija cuál es el de por defecto: a él va lo que no diga otro centro.',
          );
        }
      }
      await t.query(
        `UPDATE empresa_cuenta SET exige_centro_costo = $1
          WHERE left(codigo, 1) = ANY($2::text[])`,
        [activo, CLASES_DE_RESULTADO],
      );
      await t.query(
        `UPDATE empresa_configuracion_contable
            SET maneja_centro_de_costo = $1
          WHERE empresa_id = $2`,
        [activo, ctx.empresaId],
      );
    });
  }

  /** El centro que un usuario tiene como suyo en esta empresa, si tiene. */
  async deUsuario(ctx: CtxEmpresa, usuarioId: string): Promise<string | null> {
    return this.tx.enContexto(ctx, async (t) => {
      const r = fila<{ centro_costo_id: string }>(
        await t.query(
          'SELECT centro_costo_id FROM usuario_empresa_centro WHERE usuario_id = $1',
          [usuarioId],
        ),
      );
      return r?.centro_costo_id ?? null;
    });
  }

  /** `null` le quita el centro: vuelve a la cadena (sede, por defecto). */
  async fijarDeUsuario(
    ctx: CtxEmpresa,
    usuarioId: string,
    centroCostoId: string | null,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const tieneRol = fila<{ ok: boolean }>(
        await t.query(
          `SELECT true AS ok FROM usuario_empresa_rol
            WHERE usuario_id = $1 AND empresa_id = $2 AND revocado_en IS NULL
            LIMIT 1`,
          [usuarioId, ctx.empresaId],
        ),
      );
      if (tieneRol === undefined) {
        throw new NotFoundException('Ese usuario no trabaja en esta empresa.');
      }
      if (centroCostoId === null) {
        await t.query(
          'DELETE FROM usuario_empresa_centro WHERE usuario_id = $1',
          [usuarioId],
        );
        return;
      }
      await this.exigirUsable(centroCostoId, t);
      await t.query(
        `INSERT INTO usuario_empresa_centro (usuario_id, empresa_id, centro_costo_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, empresa_id)
         DO UPDATE SET centro_costo_id = EXCLUDED.centro_costo_id, actualizado_en = now()`,
        [usuarioId, ctx.empresaId, centroCostoId],
      );
    });
  }

  /**
   * El centro que propone el sistema para un documento nuevo (D3): el que
   * eligió la persona, el suyo, el de la sede de la caja y el de por defecto,
   * en ese orden. `null` si la empresa no maneja centros: ahí ningún
   * documento lleva centro.
   *
   * El elegido se valida (activo, de esta empresa, sin hijos); los demás ya
   * lo son por construcción.
   */
  async propuesto(
    ctx: CtxEmpresa,
    datos: {
      elegido?: string | null;
      sedeId?: string | null;
      /** La caja por donde entra o sale la plata: su sede propone el centro. */
      cajaId?: string | null;
    },
    tx?: Tx,
  ): Promise<string | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        if (!(await this.manejaEn(t))) return null;
        if (datos.elegido) {
          await this.exigirUsable(datos.elegido, t);
          return datos.elegido;
        }
        const r = fila<{
          usuario: string | null;
          sede: string | null;
          por_defecto: string | null;
        }>(
          await t.query(
            `SELECT
               (SELECT u.centro_costo_id FROM usuario_empresa_centro u
                  JOIN empresa_centro_costo c ON c.id = u.centro_costo_id AND c.activo
                 WHERE u.usuario_id = $1) AS usuario,
               (SELECT c.id FROM empresa_centro_costo c
                 WHERE c.sede_id = COALESCE($2::uuid, (SELECT sede_id FROM caja WHERE id = $3::uuid))
                   AND c.activo
                   AND NOT EXISTS (SELECT 1 FROM empresa_centro_costo h WHERE h.padre_id = c.id)
                 ORDER BY c.codigo LIMIT 1) AS sede,
               (SELECT c.id FROM empresa_centro_costo c
                 WHERE c.es_por_defecto AND c.activo) AS por_defecto`,
            [ctx.usuarioId, datos.sedeId ?? null, datos.cajaId ?? null],
          ),
        );
        return resolverCentro({
          usuario: r?.usuario,
          sedeCaja: r?.sede,
          porDefecto: r?.por_defecto,
        });
      },
      tx,
    );
  }

  /**
   * Un centro que se puede elegir para un movimiento nuevo: existe en esta
   * empresa (RLS esconde los ajenos), está activo y no agrupa otros.
   */
  async exigirUsable(id: string, t: Tx): Promise<void> {
    const c = await this.porId(id, t);
    if (!c.activo) {
      throw new BadRequestException(
        `El centro de costo ${c.codigo} (${c.nombre}) está desactivado.`,
      );
    }
    if (c.agrupa) {
      throw new BadRequestException(
        `El centro de costo ${c.codigo} (${c.nombre}) agrupa otros y no recibe movimientos. Use uno de los que agrupa.`,
      );
    }
  }

  private async manejaEn(t: Tx): Promise<boolean> {
    const r = fila<{ maneja: boolean }>(
      await t.query(
        `SELECT maneja_centro_de_costo AS maneja
           FROM empresa_configuracion_contable
          WHERE empresa_id = app_empresa_id()`,
      ),
    );
    return r?.maneja === true;
  }

  private async porId(id: string, t: Tx): Promise<CentroCosto> {
    const f = fila<FilaCentro>(
      await t.query(`${SELECT_CENTRO} WHERE c.id = $1`, [id]),
    );
    if (f === undefined) {
      throw new NotFoundException('El centro de costo no existe.');
    }
    return aCentro(f);
  }

  /** Un padre: activo y de primer nivel. Lo demás lo cuida el trigger. */
  private async exigirAgrupable(padreId: string, t: Tx): Promise<void> {
    const p = await this.porId(padreId, t);
    if (!p.activo) {
      throw new BadRequestException(
        `El centro ${p.codigo} (${p.nombre}) está desactivado y no puede agrupar otros.`,
      );
    }
  }

  private async quitarPorDefecto(t: Tx): Promise<void> {
    await t.query(
      'UPDATE empresa_centro_costo SET es_por_defecto = false WHERE es_por_defecto',
    );
  }
}
