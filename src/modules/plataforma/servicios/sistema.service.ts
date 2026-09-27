import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { PasswordService } from '../../../common/cripto/password.service';
import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { fila } from '../../../common/db/filas';
import { TxService } from '../../../common/db/tx.service';
import type { CtxPlataforma } from '../../../common/ctx';
import type { AnuncioDto, PausarIaDto } from '../dto/cobros.dto';
import { contrasenaParaDictar } from '../reglas/contrasena';
import { iso, registrar } from './bitacora';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const VERSION = (require('../../../../package.json') as { version: string })
  .version;
const ARRANCO = new Date().toISOString();

/**
 * Sistema, anuncios y administradores: lo técnico de la consola.
 *
 * Del asistente solo cuenta respuestas y lecturas por estado; nunca lee el
 * texto ni el motivo de una falla (que puede repetir lo que escribió alguien).
 */
@Injectable()
export class SistemaService {
  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
    @InjectDataSource() private readonly app: DataSource,
    private readonly tx: TxService,
    private readonly passwords: PasswordService,
  ) {}

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------

  async estado() {
    const ds = this.conexion();

    const base = await this.app
      .query<Array<{ usuario: string; super: boolean; bypass: boolean }>>(
        `SELECT current_user AS usuario, r.rolsuper AS super, r.rolbypassrls AS bypass
           FROM pg_roles r WHERE r.rolname = current_user`,
      )
      .then(([f]) => ({
        conectada: true,
        aislamientoActivo: !f.super && !f.bypass,
      }))
      .catch(() => ({ conectada: false, aislamientoActivo: false }));

    const [ia] = await ds.query<Array<Record<string, unknown>>>(
      `SELECT
         (SELECT count(*)::int FROM conversacion_turno
           WHERE autor = 'ASISTENTE' AND creado_en > now() - interval '24 hours')            AS respuestas,
         (SELECT count(*)::int FROM conversacion_turno
           WHERE autor = 'ASISTENTE' AND estado = 'FALLO'
             AND creado_en > now() - interval '24 hours')                                     AS respuestas_fallidas,
         (SELECT count(*)::int FROM conversacion_turno
           WHERE autor = 'ASISTENTE' AND estado = 'CORTADO'
             AND creado_en > now() - interval '24 hours')                                     AS respuestas_cortadas,
         (SELECT count(*)::int FROM documento_leido
           WHERE coalesce(leido_en, creado_en) > now() - interval '24 hours')               AS lecturas,
         (SELECT count(*)::int FROM documento_leido
           WHERE estado = 'FALLO' AND coalesce(leido_en, creado_en) > now() - interval '24 hours') AS lecturas_fallidas,
         (SELECT max(creado_en) FROM conversacion_turno
           WHERE autor = 'ASISTENTE' AND estado IN ('COMPLETO','CORTADO'))                    AS ultima_ok,
         (SELECT max(creado_en) FROM conversacion_turno
           WHERE autor = 'ASISTENTE' AND estado = 'FALLO')                                    AS ultima_falla`,
    );

    const fallidas =
      (ia.respuestas_fallidas as number) + (ia.lecturas_fallidas as number);
    const total = (ia.respuestas as number) + (ia.lecturas as number);
    const ultimaOk = iso(ia.ultima_ok);
    const ultimaFalla = iso(ia.ultima_falla);
    // Sin tráfico no se sabe; con la última llamada fallida y nada bueno
    // después, está caído; con más de una de cada cinco fallando, lento.
    const proveedor =
      total === 0
        ? 'SIN_DATOS'
        : ultimaFalla !== null && (ultimaOk === null || ultimaFalla > ultimaOk)
          ? 'CAIDO'
          : fallidas / total > 0.2
            ? 'INESTABLE'
            : 'FUNCIONANDO';

    return {
      api: { estado: 'FUNCIONANDO', version: VERSION, desde: ARRANCO },
      base,
      proveedorIa: {
        estado: proveedor,
        ultimaRespuestaOk: ultimaOk,
        ultimaFalla,
      },
      ultimas24h: {
        respuestas: ia.respuestas as number,
        respuestasFallidas: ia.respuestas_fallidas as number,
        respuestasCortadas: ia.respuestas_cortadas as number,
        lecturas: ia.lecturas as number,
        lecturasFallidas: ia.lecturas_fallidas as number,
      },
      pausas: await this.pausas(),
    };
  }

  // -------------------------------------------------------------------------
  // Pausas de la IA
  // -------------------------------------------------------------------------

  async pausas() {
    const filas = await this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT p.id, p.tenant_id, t.nombre AS cuenta, p.usos, p.motivo, p.desde,
              a.nombre_completo AS admin
         FROM ia_pausa p
         JOIN plataforma_admin a ON a.id = p.admin_id
         LEFT JOIN tenant t ON t.id = p.tenant_id
        WHERE p.levantada_en IS NULL
        ORDER BY p.desde DESC`,
    );
    return filas.map((f) => ({
      id: f.id as string,
      cuentaId: (f.tenant_id as string | null) ?? null,
      cuenta: (f.cuenta as string | null) ?? null,
      usos: f.usos as string[],
      motivo: f.motivo as string,
      desde: iso(f.desde) as string,
      admin: f.admin as string,
    }));
  }

  async pausar(admin: CtxPlataforma, dto: PausarIaDto) {
    return this.conexion().transaction(async (t) => {
      const [yaHay] = await t.query<unknown[]>(
        `SELECT 1 FROM ia_pausa WHERE levantada_en IS NULL
           AND tenant_id IS NOT DISTINCT FROM $1::uuid`,
        [dto.cuentaId ?? null],
      );
      if (yaHay !== undefined) {
        throw new ConflictException(
          'Ya hay una pausa vigente ahí. Reanúdela antes de poner otra.',
        );
      }
      const [p] = await t.query<Array<{ id: string }>>(
        `INSERT INTO ia_pausa (tenant_id, usos, motivo, admin_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [dto.cuentaId ?? null, dto.usos, dto.motivo.trim(), admin.adminId],
      );
      await registrar(t, admin, 'PAUSAR_IA', dto.cuentaId ?? null, {
        usos: dto.usos,
        motivo: dto.motivo.trim(),
        alcance: dto.cuentaId ? 'CUENTA' : 'PLATAFORMA',
      });
      return { id: p.id };
    });
  }

  async reanudar(admin: CtxPlataforma, id: string) {
    return this.conexion().transaction(async (t) => {
      const [p] = await t.query<
        Array<{ tenant_id: string | null; usos: string[] }>
      >(
        `UPDATE ia_pausa SET levantada_en = now(), levantada_por = $2
          WHERE id = $1 AND levantada_en IS NULL
          RETURNING tenant_id, usos`,
        [id, admin.adminId],
      );
      if (p === undefined)
        throw new NotFoundException('Esa pausa ya no está vigente.');
      await registrar(t, admin, 'REANUDAR_IA', p.tenant_id, {
        usos: p.usos,
        alcance: p.tenant_id ? 'CUENTA' : 'PLATAFORMA',
      });
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // Anuncios
  // -------------------------------------------------------------------------

  async anuncios() {
    const filas = await this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT n.id, n.titulo, n.cuerpo, n.tono, n.cuentas, n.desde, n.hasta,
              n.retirado_en, a.nombre_completo AS admin,
              (SELECT array_agg(t.nombre ORDER BY t.nombre) FROM tenant t
                WHERE t.id = ANY(n.cuentas)) AS nombres
         FROM anuncio n JOIN plataforma_admin a ON a.id = n.admin_id
        ORDER BY n.desde DESC
        LIMIT 50`,
    );
    const ahora = new Date().toISOString();
    return filas.map((f) => {
      const desde = iso(f.desde) as string;
      const hasta = iso(f.hasta) as string;
      const retirado = iso(f.retirado_en);
      return {
        id: f.id as string,
        titulo: f.titulo as string,
        cuerpo: f.cuerpo as string,
        tono: f.tono as string,
        cuentas: (f.cuentas as string[] | null) ?? null,
        nombresCuentas: (f.nombres as string[] | null) ?? [],
        desde,
        hasta,
        retiradoEn: retirado,
        admin: f.admin as string,
        estado:
          retirado !== null
            ? 'RETIRADO'
            : hasta < ahora
              ? 'TERMINADO'
              : desde > ahora
                ? 'PROGRAMADO'
                : 'VIGENTE',
      };
    });
  }

  async publicar(admin: CtxPlataforma, dto: AnuncioDto) {
    if (Date.parse(dto.hasta) <= Date.parse(dto.desde)) {
      throw new BadRequestException(
        '«Hasta» tiene que ser después de «desde».',
      );
    }
    const cuentas = dto.cuentas && dto.cuentas.length > 0 ? dto.cuentas : null;
    return this.conexion().transaction(async (t) => {
      const [n] = await t.query<Array<{ id: string }>>(
        `INSERT INTO anuncio (titulo, cuerpo, tono, cuentas, desde, hasta, admin_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          dto.titulo.trim(),
          dto.cuerpo.trim(),
          dto.tono,
          cuentas,
          dto.desde,
          dto.hasta,
          admin.adminId,
        ],
      );
      await registrar(t, admin, 'PUBLICAR_ANUNCIO', null, {
        titulo: dto.titulo.trim(),
        para: cuentas === null ? 'TODAS' : cuentas.length,
        desde: dto.desde,
        hasta: dto.hasta,
      });
      return { id: n.id };
    });
  }

  async retirar(admin: CtxPlataforma, id: string) {
    return this.conexion().transaction(async (t) => {
      const n = fila<{ titulo: string }>(
        await t.query(
          `UPDATE anuncio SET retirado_en = now() WHERE id = $1 AND retirado_en IS NULL
           RETURNING titulo`,
          [id],
        ),
      );
      if (n === undefined)
        throw new NotFoundException('Ese anuncio ya no está publicado.');
      await registrar(t, admin, 'RETIRAR_ANUNCIO', null, { titulo: n.titulo });
      return { ok: true };
    });
  }

  /**
   * Lo que ve un cliente: los anuncios vigentes para todas las cuentas o para
   * la suya. Va por la conexión de la aplicación, que tiene SELECT sobre
   * `anuncio` y nada más de la plataforma.
   */
  async vigentesPara(tenantId: string) {
    const filas = await this.tx.sinContexto((t) =>
      t.query<Array<Record<string, unknown>>>(
        `SELECT id, titulo, cuerpo, tono, hasta FROM anuncio
          WHERE retirado_en IS NULL AND now() BETWEEN desde AND hasta
            AND (cuentas IS NULL OR $1::uuid = ANY(cuentas))
          ORDER BY desde DESC LIMIT 3`,
        [tenantId],
      ),
    );
    return filas.map((f) => ({
      id: f.id as string,
      titulo: f.titulo as string,
      cuerpo: f.cuerpo as string,
      tono: f.tono as string,
      hasta: iso(f.hasta) as string,
    }));
  }

  // -------------------------------------------------------------------------
  // Administradores
  // -------------------------------------------------------------------------

  async administradores() {
    const filas = await this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT a.id, a.email, a.nombre_completo, a.activo, a.ultimo_acceso_en, a.creado_en,
              (SELECT count(*)::int FROM login_fallido f
                WHERE f.admin_id = a.id AND f.ocurrido_en > now() - interval '24 hours') AS fallidos_24h,
              (SELECT count(*)::int FROM login_fallido f
                WHERE f.admin_id = a.id AND f.ocurrido_en > now() - interval '7 days')   AS fallidos_7d,
              (SELECT max(f.ocurrido_en) FROM login_fallido f WHERE f.admin_id = a.id)  AS ultimo_fallido
         FROM plataforma_admin a
        ORDER BY a.activo DESC, a.nombre_completo`,
    );
    return filas.map((f) => ({
      id: f.id as string,
      email: f.email as string,
      nombreCompleto: f.nombre_completo as string,
      activo: f.activo as boolean,
      ultimoAcceso: iso(f.ultimo_acceso_en),
      creadoEn: iso(f.creado_en) as string,
      fallidos24h: f.fallidos_24h as number,
      fallidos7d: f.fallidos_7d as number,
      ultimoFallido: iso(f.ultimo_fallido),
    }));
  }

  /**
   * Nadie se desactiva a sí mismo, y el último administrador activo no se
   * desactiva: la consola quedaría sin nadie que la maneje.
   */
  async cambiarAdmin(admin: CtxPlataforma, id: string, activo: boolean) {
    if (!activo && id === admin.adminId) {
      throw new BadRequestException('No puede desactivarse a sí mismo.');
    }
    return this.conexion().transaction(async (t) => {
      const [otro] = await t.query<Array<{ email: string; activo: boolean }>>(
        'SELECT email, activo FROM plataforma_admin WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (otro === undefined)
        throw new NotFoundException('Administrador no encontrado');
      if (otro.activo === activo) {
        throw new BadRequestException(
          activo ? 'Ya está activo.' : 'Ya está desactivado.',
        );
      }
      if (!activo) {
        const [{ n }] = await t.query<Array<{ n: number }>>(
          'SELECT count(*)::int AS n FROM plataforma_admin WHERE activo AND id <> $1',
          [id],
        );
        if (n === 0) {
          throw new ConflictException('Es el único administrador activo.');
        }
      }
      await t.query('UPDATE plataforma_admin SET activo = $2 WHERE id = $1', [
        id,
        activo,
      ]);
      await registrar(
        t,
        admin,
        activo ? 'REACTIVAR_ADMIN' : 'DESACTIVAR_ADMIN',
        null,
        {
          email: otro.email,
        },
      );
      return { ok: true };
    });
  }

  /** Una contraseña nueva para otro administrador, una sola vez. */
  async restablecerAdmin(admin: CtxPlataforma, id: string) {
    const password = contrasenaParaDictar();
    const hash = await this.passwords.hashear(password);
    return this.conexion().transaction(async (t) => {
      const [otro] = await t.query<
        Array<{ email: string; nombre_completo: string }>
      >(
        `UPDATE plataforma_admin SET hash_password = $2 WHERE id = $1
         RETURNING email, nombre_completo`,
        [id, hash],
      );
      if (otro === undefined)
        throw new NotFoundException('Administrador no encontrado');
      await registrar(t, admin, 'RESTABLECER_ADMIN', null, {
        email: otro.email,
      });
      return {
        email: otro.email,
        nombreCompleto: otro.nombre_completo,
        password,
      };
    });
  }

  private conexion(): DataSource {
    if (this.provision === null) {
      throw new ServiceUnavailableException(
        'Falta configurar DB_PROVISION_USERNAME y DB_PROVISION_PASSWORD.',
      );
    }
    return this.provision;
  }
}
