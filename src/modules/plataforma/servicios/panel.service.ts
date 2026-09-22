import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { hoyEnColombia } from '../../../common/fecha';
import type { CtxPlataforma } from '../../../common/ctx';
import { ConsumoIaApi } from '../../consumo-ia/consumo-ia.api';
import type { PrecioPlanDto } from '../dto/cobros.dto';
import type { EditarPlanDto } from '../dto/cuentas.dto';
import {
  cercaDelCupo,
  cupoCerca,
  diasDesde,
  sinActividad,
} from '../reglas/cuentas';
import {
  DIAS_CUENTA_NUEVA,
  DIAS_MORA_AVISO,
  diaAnterior,
  fraccionDelMes,
  gastoPorMes,
  iaDisparada,
  inicioDeMes,
  mesAnterior,
  mesesMedidos,
  restarDias,
  tresMesesAnteriores,
} from '../reglas/inicio';
import { iso, registrar } from './bitacora';
import { CobrosService } from './cobros.service';
import { aPlan, CuentasService, normalizar } from './cuentas.service';

const POR_PAGINA_BITACORA = 50;

/**
 * Lo que la consola muestra de toda la plataforma: el Inicio, la búsqueda,
 * la bitácora global y el catálogo de planes.
 *
 * Las mismas reglas que `CuentasService`: conexión de aprovisionamiento,
 * nada contable, de la IA solo cifras.
 */
@Injectable()
export class PanelService {
  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
    private readonly cuentas: CuentasService,
    private readonly consumo: ConsumoIaApi,
    private readonly cobros: CobrosService,
  ) {}

  // -------------------------------------------------------------------------
  // Inicio
  // -------------------------------------------------------------------------

  async inicio() {
    const ds = this.conexion();
    const ahora = new Date();
    const hoy = hoyEnColombia();
    const mes = { desde: inicioDeMes(hoy), hasta: hoy };
    const pasado = mesAnterior(hoy);
    const previos = tresMesesAnteriores(hoy);

    // Los cargos del día y la mora, antes de contar: es idempotente.
    await this.cobros.revisar(hoy);

    const [
      cuentas,
      planes,
      gastoMes,
      gastoPasado,
      gastoPrevio,
      tableroHoy,
      doceMeses,
      altasYBajas,
      actividad,
      primeraMedicion,
      cobros,
      facturado,
    ] = await Promise.all([
      this.cuentas.todas(),
      ds.query<Array<Record<string, unknown>>>(
        'SELECT clave, nombre, max_empresas, max_usuarios, precio_mensual, tope_ia_usd, al_llegar_tope FROM plan_catalogo ORDER BY orden',
      ),
      this.consumo.gastoPorEmpresa(mes.desde, mes.hasta),
      this.consumo.gastoPorEmpresa(pasado.desde, pasado.hasta),
      this.consumo.gastoPorEmpresa(previos[0].desde, previos[2].hasta),
      this.consumo.tablero({ desde: hoy, hasta: hoy }),
      this.consumo.tablero({ desde: restarDias(hoy, 364), hasta: hoy }),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT
           (SELECT count(*)::int FROM tenant
             WHERE (creado_en AT TIME ZONE 'America/Bogota')::date >= $1::date)          AS nuevas,
           (SELECT count(*)::int FROM tenant
             WHERE (creado_en AT TIME ZONE 'America/Bogota')::date BETWEEN $2::date AND $3::date) AS nuevas_pasado,
           (SELECT count(DISTINCT tenant_id)::int FROM plataforma_bitacora
             WHERE accion = 'CAMBIAR_ESTADO' AND detalle->>'despues' = 'CANCELADO'
               AND (ocurrido_en AT TIME ZONE 'America/Bogota')::date >= $1::date)         AS bajas,
           (SELECT count(DISTINCT tenant_id)::int FROM plataforma_bitacora
             WHERE accion = 'CAMBIAR_ESTADO' AND detalle->>'despues' = 'CANCELADO'
               AND (ocurrido_en AT TIME ZONE 'America/Bogota')::date BETWEEN $2::date AND $3::date) AS bajas_pasado`,
        [mes.desde, pasado.desde, pasado.hasta],
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT
           (SELECT count(*)::int FROM usuario_acceso_dia WHERE dia = $1::date)            AS hoy,
           (SELECT count(*)::int FROM usuario_acceso_dia WHERE dia = $2::date)            AS ayer,
           (SELECT count(DISTINCT usuario_id)::int FROM usuario_acceso_dia
             WHERE dia > $3::date)                                                          AS semana,
           (SELECT min(dia) FROM usuario_acceso_dia)                                        AS desde,
           (SELECT count(*)::int FROM usuario u JOIN tenant t ON t.id = u.tenant_id
             WHERE u.activo AND t.estado <> 'CANCELADO')                                    AS usuarios_activos,
           (SELECT count(*)::int FROM empresa e JOIN tenant t ON t.id = e.tenant_id
             WHERE e.activo AND t.estado <> 'CANCELADO')                                    AS empresas,
           (SELECT count(DISTINCT uer.empresa_id)::int
              FROM usuario_acceso_dia a
              JOIN usuario_empresa_rol uer ON uer.usuario_id = a.usuario_id AND uer.revocado_en IS NULL
             WHERE a.dia > $3::date)                                                        AS empresas_activas`,
        [hoy, diaAnterior(hoy), restarDias(hoy, 7)],
      ),
      ds.query<Array<{ dia: string | null }>>(
        `SELECT to_char(least(
                  (SELECT min(creado_en) FROM conversacion_turno WHERE duracion_ms IS NOT NULL),
                  (SELECT min(coalesce(leido_en, creado_en)) FROM documento_leido WHERE uso IS NOT NULL)
                ) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS dia`,
      ),
      this.cobros.resumenes(hoy),
      this.cobros.facturadoPorMes(),
    ]);

    const [ab] = altasYBajas;
    const [act] = actividad;
    const medicion = primeraMedicion[0]?.dia ?? null;
    const sumar = (g: { costoUsd: number }[]) =>
      g.reduce((s, x) => s + x.costoUsd, 0);

    // --- Pendientes ---------------------------------------------------------
    // Días sin pagar, de los cobros; si la marcó una persona sin deuda
    // registrada, desde que la marcó.
    const morosas = cuentas
      .filter((c) => c.estado === 'MOROSO')
      .map((c) => {
        const e = cobros.get(c.id)?.estado;
        return {
          id: c.id,
          nombre: c.nombre,
          dias:
            e && e.diasMora > 0 ? e.diasMora : diasDesde(c.estadoDesde, ahora),
          vencido: e?.vencido ?? 0,
        };
      })
      .filter((c) => c.dias >= DIAS_MORA_AVISO || c.vencido > 0)
      .sort((a, b) => b.dias - a.dias);

    // Las que ya se atrasaron pero todavía no llegan a la mora automática.
    const pagosVencidos = cuentas
      .filter((c) => c.estado === 'ACTIVO')
      .map((c) => ({ c, e: cobros.get(c.id)?.estado }))
      .filter(({ e }) => e !== undefined && e.diasMora > 0)
      .map(({ c, e }) => ({
        id: c.id,
        nombre: c.nombre,
        dias: e!.diasMora,
        vencido: e!.vencido,
      }))
      .sort((a, b) => b.dias - a.dias);

    const cercaCupo = cuentas.filter(cercaDelCupo).map((c) => ({
      id: c.id,
      nombre: c.nombre,
      recurso: cupoCerca(c.usuarios, c.maxUsuarios)
        ? ('USUARIOS' as const)
        : ('EMPRESAS' as const),
      usados: cupoCerca(c.usuarios, c.maxUsuarios) ? c.usuarios : c.empresas,
      max: cupoCerca(c.usuarios, c.maxUsuarios) ? c.maxUsuarios : c.maxEmpresas,
    }));

    const previo = new Map<string, number>();
    for (const g of gastoPrevio) previo.set(g.empresaId, g.costoUsd);
    const disparada = iaDisparada(
      gastoMes,
      previo,
      mesesMedidos(previos, medicion),
      fraccionDelMes(hoy),
    );

    const fallidas = tableroHoy.lectura
      .filter((l) => l.fallidas > 0)
      .map((l) => ({ tipo: l.tipo, cantidad: l.fallidas }));

    const nuevas = cuentas.filter((c) => {
      const dias = diasDesde(c.creadoEn, ahora);
      return (
        c.estado !== 'CANCELADO' &&
        dias >= DIAS_CUENTA_NUEVA.desde &&
        dias <= DIAS_CUENTA_NUEVA.hasta
      );
    });
    const sinConfigurar = (
      await Promise.all(nuevas.map((c) => this.avanceDeCuenta(c.id)))
    )
      .map((empresas, i) => ({
        cuentaId: nuevas[i].id,
        cuenta: nuevas[i].nombre,
        dias: diasDesde(nuevas[i].creadoEn, ahora),
        sinEmpresa: empresas.length === 0,
        empresas: empresas.filter((e) => !e.completa),
      }))
      .filter((c) => c.sinEmpresa || c.empresas.length > 0);

    const sinEntrar = cuentas
      .filter((c) => sinActividad(c, ahora))
      .map((c) => ({
        id: c.id,
        nombre: c.nombre,
        dias: diasDesde(c.ultimoAcceso ?? c.creadoEn, ahora),
        nuncaEntro: c.ultimoAcceso === null,
      }))
      .sort((a, b) => b.dias - a.dias);

    // --- Cifras -------------------------------------------------------------
    const porEstado = { ACTIVO: 0, MOROSO: 0, SUSPENDIDO: 0, CANCELADO: 0 };
    for (const c of cuentas) porEstado[c.estado] += 1;

    const planDe = new Map(cuentas.map((c) => [c.id, c.plan]));
    // Lo que se cobra al mes, de las cuentas que pagan: activas y morosas.
    const pagan = cuentas.filter(
      (c) => c.estado === 'ACTIVO' || c.estado === 'MOROSO',
    );
    const conPrecio = pagan.filter(
      (c) => (cobros.get(c.id)?.precio ?? null) !== null,
    );
    const ingresoMensual =
      conPrecio.length === 0
        ? null
        : conPrecio.reduce((s, c) => s + (cobros.get(c.id)?.precio ?? 0), 0);
    const periodo = hoy.slice(0, 7);
    const periodoPasado = pasado.desde.slice(0, 7);
    const facturadoMes = (per: string, plan?: string) =>
      facturado
        .filter(
          (f) => f.periodo === per && (plan === undefined || f.plan === plan),
        )
        .reduce((s, f) => s + f.monto, 0);
    const porMes = new Map<string, number>();
    for (const f of facturado)
      porMes.set(f.periodo, (porMes.get(f.periodo) ?? 0) + f.monto);
    const catalogo = planes.map(aPlan);
    const nombrePlan = new Map(catalogo.map((p) => [p.clave, p.nombre]));

    return {
      revisadoEn: ahora.toISOString(),
      hoy,
      medicionDesde: medicion,
      accesosDesde: act.desde === null ? null : iso(act.desde)?.slice(0, 10),
      pendientes: {
        morosas,
        pagosVencidos,
        cercaCupo,
        iaDisparada: disparada,
        lecturasFallidas: fallidas,
        sinConfigurar,
        sinEntrar,
      },
      cifras: {
        activas: porEstado.ACTIVO,
        nuevas: ab.nuevas as number,
        nuevasMesPasado: ab.nuevas_pasado as number,
        seFueron: ab.bajas as number,
        seFueronMesPasado: ab.bajas_pasado as number,
        iaMesUsd: sumar(gastoMes),
        iaMesPasadoUsd: sumar(gastoPasado),
        // El margen se calcula en la pantalla: resta la IA en pesos, con la
        // tasa que escribe quien la mira.
        ingresoMensual,
        facturadoMes: facturadoMes(periodo),
        facturadoMesPasado: facturadoMes(periodoPasado),
        porCobrar: [...cobros.values()].reduce(
          (s, e) => s + Math.max(0, e.estado.vencido),
          0,
        ),
      },
      iaPorMes: gastoPorMes(doceMeses.porDia)
        .slice(-12)
        .map((m) => ({ ...m, facturado: porMes.get(m.mes) ?? 0 })),
      porEstado,
      porPlan: catalogo.map((p) => ({
        clave: p.clave,
        nombre: p.nombre,
        cuentas: cuentas.filter(
          (c) => c.plan === p.clave && c.estado !== 'CANCELADO',
        ).length,
        precioMensual: p.precioMensual,
        facturadoMes: facturadoMes(periodo, p.clave),
      })),
      topIa: gastoMes.slice(0, 5).map((g) => ({
        ...g,
        plan: planDe.get(g.cuentaId) ?? null,
        planNombre: nombrePlan.get(planDe.get(g.cuentaId) ?? '') ?? null,
        pagaMensual: cobros.get(g.cuentaId)?.precio ?? null,
      })),
      actividad: {
        hoy: act.hoy as number,
        ayer: act.ayer as number,
        semana: act.semana as number,
        usuariosActivos: act.usuarios_activos as number,
        empresasActivas: act.empresas_activas as number,
        empresas: act.empresas as number,
      },
    };
  }

  private async avanceDeCuenta(cuentaId: string) {
    const empresas = await this.conexion().query<
      Array<{ id: string; razon_social: string }>
    >(
      'SELECT id, razon_social FROM empresa WHERE tenant_id = $1 AND activo ORDER BY razon_social',
      [cuentaId],
    );
    return Promise.all(
      empresas.map(async (e) => ({
        id: e.id,
        razonSocial: e.razon_social,
        ...(await this.cuentas.avance(e.id)),
      })),
    );
  }

  // -------------------------------------------------------------------------
  // Búsqueda
  // -------------------------------------------------------------------------

  /**
   * Cuentas por nombre, empresas por razón social o NIT —con o sin puntos— y
   * usuarios por correo. Cinco de cada una.
   */
  async buscar(q: string) {
    const texto = normalizar(q ?? '');
    if (texto.length < 2) return { cuentas: [], empresas: [], usuarios: [] };
    const digitos = texto.replace(/\D/g, '');
    const patron = `%${texto}%`;
    const ds = this.conexion();

    const [cuentas, empresas, usuarios] = await Promise.all([
      ds.query<Array<Record<string, unknown>>>(
        `SELECT id, nombre, plan, estado FROM tenant
          WHERE fn_normalizar(nombre) LIKE fn_normalizar($1) OR slug ILIKE $1
          ORDER BY nombre LIMIT 5`,
        [patron],
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT e.id, e.razon_social, e.nit, e.dv, e.tenant_id, t.nombre AS cuenta
           FROM empresa e JOIN tenant t ON t.id = e.tenant_id
          WHERE fn_normalizar(e.razon_social) LIKE fn_normalizar($1)
             OR ($2::text <> '' AND length($2::text) >= 3 AND e.nit LIKE $2::text || '%')
          ORDER BY e.razon_social LIMIT 5`,
        [patron, digitos],
      ),
      ds.query<Array<Record<string, unknown>>>(
        `SELECT u.id, u.email, u.nombre_completo, u.tenant_id, t.nombre AS cuenta,
                COALESCE((SELECT array_agg(DISTINCT uer.rol_codigo) FROM usuario_empresa_rol uer
                           WHERE uer.usuario_id = u.id AND uer.revocado_en IS NULL),
                         ARRAY[]::text[]) AS roles
           FROM usuario u JOIN tenant t ON t.id = u.tenant_id
          WHERE u.email ILIKE $1 OR fn_normalizar(u.nombre_completo) LIKE fn_normalizar($1)
          ORDER BY u.email LIMIT 5`,
        [patron],
      ),
    ]);

    return {
      cuentas: cuentas.map((c) => ({
        id: c.id as string,
        nombre: c.nombre as string,
        plan: c.plan as string,
        estado: c.estado as string,
      })),
      empresas: empresas.map((e) => ({
        id: e.id as string,
        razonSocial: e.razon_social as string,
        nit: e.nit as string,
        dv: e.dv as string,
        cuentaId: e.tenant_id as string,
        cuenta: e.cuenta as string,
      })),
      usuarios: usuarios.map((u) => ({
        id: u.id as string,
        email: u.email as string,
        nombreCompleto: u.nombre_completo as string,
        cuentaId: u.tenant_id as string,
        cuenta: u.cuenta as string,
        roles: u.roles as string[],
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Bitácora
  // -------------------------------------------------------------------------

  async bitacora(f: {
    cuenta?: string;
    admin?: string;
    accion?: string;
    desde?: string;
    hasta?: string;
    pagina?: string;
  }) {
    const uuid = (v?: string) =>
      v !== undefined && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
    const fecha = (v?: string) =>
      v !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    const accion =
      f.accion !== undefined && /^[A-Z_]{3,40}$/.test(f.accion)
        ? f.accion
        : null;
    const pagina = Math.max(1, Number(f.pagina) || 1);
    const params = [
      uuid(f.cuenta),
      uuid(f.admin),
      accion,
      fecha(f.desde),
      fecha(f.hasta),
    ];
    const donde = `
      WHERE ($1::uuid IS NULL OR b.tenant_id = $1::uuid)
        AND ($2::uuid IS NULL OR b.admin_id = $2::uuid)
        AND ($3::text IS NULL OR b.accion = $3::text)
        AND ($4::date IS NULL OR (b.ocurrido_en AT TIME ZONE 'America/Bogota')::date >= $4::date)
        AND ($5::date IS NULL OR (b.ocurrido_en AT TIME ZONE 'America/Bogota')::date <= $5::date)`;
    const ds = this.conexion();

    const [filas, [total], admins] = await Promise.all([
      ds.query<Array<Record<string, unknown>>>(
        `SELECT b.id, b.accion, b.detalle, b.ocurrido_en, b.tenant_id,
                coalesce(a.nombre_completo, 'El sistema') AS admin, t.nombre AS cuenta
           FROM plataforma_bitacora b
           LEFT JOIN plataforma_admin a ON a.id = b.admin_id
           LEFT JOIN tenant t ON t.id = b.tenant_id
           ${donde}
          ORDER BY b.ocurrido_en DESC
          LIMIT ${POR_PAGINA_BITACORA} OFFSET ${(pagina - 1) * POR_PAGINA_BITACORA}`,
        params,
      ),
      ds.query<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM plataforma_bitacora b ${donde}`,
        params,
      ),
      ds.query<Array<{ id: string; nombre: string }>>(
        'SELECT id, nombre_completo AS nombre FROM plataforma_admin ORDER BY nombre_completo',
      ),
    ]);

    return {
      filas: filas.map((b) => ({
        id: b.id as string,
        accion: b.accion as string,
        detalle: b.detalle as Record<string, unknown>,
        ocurridoEn: iso(b.ocurrido_en) as string,
        admin: b.admin as string,
        cuentaId: (b.tenant_id as string | null) ?? null,
        cuenta: (b.cuenta as string | null) ?? null,
      })),
      total: total.n,
      pagina,
      porPagina: POR_PAGINA_BITACORA,
      admins,
    };
  }

  // -------------------------------------------------------------------------
  // Planes
  // -------------------------------------------------------------------------

  async planes() {
    const filas = await this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT p.*,
              (SELECT count(*)::int FROM tenant t
                WHERE t.plan = p.clave AND t.estado <> 'CANCELADO') AS cuentas
         FROM plan_catalogo p ORDER BY p.orden`,
    );
    return filas.map((f) => ({ ...aPlan(f), cuentas: f.cuentas as number }));
  }

  /**
   * Los cupos con los que nace una cuenta de este plan. **No toca a las
   * cuentas que ya lo tienen**: sus cupos son suyos, y a varias se les pactó
   * algo distinto.
   */
  async editarPlan(admin: CtxPlataforma, clave: string, dto: EditarPlanDto) {
    if (dto.maxEmpresas === undefined && dto.maxUsuarios === undefined) {
      throw new BadRequestException('No hay nada que cambiar.');
    }
    return this.conexion().transaction(async (t) => {
      const [antes] = await t.query<Array<Record<string, unknown>>>(
        'SELECT * FROM plan_catalogo WHERE clave = $1 FOR UPDATE',
        [clave],
      );
      if (antes === undefined)
        throw new NotFoundException('El plan no existe.');
      const a = aPlan(antes);
      const despues = {
        maxEmpresas: dto.maxEmpresas ?? a.maxEmpresas,
        maxUsuarios: dto.maxUsuarios ?? a.maxUsuarios,
      };
      await t.query(
        'UPDATE plan_catalogo SET max_empresas = $2, max_usuarios = $3 WHERE clave = $1',
        [clave, despues.maxEmpresas, despues.maxUsuarios],
      );
      await registrar(t, admin, 'EDITAR_PLAN', null, {
        plan: clave,
        antes: { maxEmpresas: a.maxEmpresas, maxUsuarios: a.maxUsuarios },
        despues,
      });
      return { ok: true };
    });
  }

  /**
   * El precio y el tope de IA de un plan. El precio nuevo se cobra desde el
   * próximo cargo de cada cuenta: los cargos ya generados no cambian. El tope
   * es **de ejemplo** hasta que se construya el freno.
   */
  async editarPrecio(admin: CtxPlataforma, clave: string, dto: PrecioPlanDto) {
    if (dto.precioMensual === undefined && dto.topeIaUsd === undefined) {
      throw new BadRequestException('No hay nada que cambiar.');
    }
    return this.conexion().transaction(async (t) => {
      const [antes] = await t.query<Array<Record<string, unknown>>>(
        'SELECT * FROM plan_catalogo WHERE clave = $1 FOR UPDATE',
        [clave],
      );
      if (antes === undefined)
        throw new NotFoundException('El plan no existe.');
      const a = aPlan(antes);
      const despues = {
        precioMensual: dto.precioMensual ?? a.precioMensual,
        topeIaUsd: dto.topeIaUsd ?? a.topeIaUsd,
      };
      await t.query(
        'UPDATE plan_catalogo SET precio_mensual = $2, tope_ia_usd = $3 WHERE clave = $1',
        [clave, despues.precioMensual, despues.topeIaUsd],
      );
      await registrar(t, admin, 'EDITAR_PLAN', null, {
        plan: clave,
        antes: { precioMensual: a.precioMensual, topeIaUsd: a.topeIaUsd },
        despues,
      });
      return { ok: true };
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
