import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';

import { DATA_SOURCE_PROVISION } from '../../../common/db/db.module';
import { hoyEnColombia } from '../../../common/fecha';
import type { CtxPlataforma } from '../../../common/ctx';
import type {
  CambiarSuscripcionDto,
  RegistrarPagoDto,
} from '../dto/cobros.dto';
import {
  decidirMora,
  DIAS_PARA_MORA,
  estadoDeCuenta,
  periodosACobrar,
  proximoCorte,
  type Cargo,
  type EstadoDeCuenta,
  type Pago,
} from '../reglas/cobros';
import { iso, registrar } from './bitacora';

/** Cada cuánto se revisan los cobros y la mora, además de al arrancar. */
const CADA = 60 * 60 * 1000;
/** Un número fijo para que dos instancias no revisen a la vez. */
const CANDADO = 55_056;

const fecha = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/** Lo que el Inicio y el detalle necesitan de los cobros de una cuenta. */
export interface ResumenCobro {
  tenantId: string;
  precio: number | null;
  precioPactado: number | null;
  diaCorte: number;
  cobroDesde: string;
  proximoCobro: string;
  estado: EstadoDeCuenta;
  ultimoPago: { fecha: string; monto: number } | null;
}

/**
 * Lo que el cliente paga: los cargos de cada período, los pagos que se
 * registran a mano y la mora automática.
 *
 * **La revisión es idempotente.** Genera los cargos que falten —uno por cuenta
 * y período, con un `UNIQUE` que impide duplicarlos— y aplica la mora. Corre al
 * arrancar, cada hora y antes de mostrar el Inicio; correrla de más no cambia
 * nada. No hay un programador de tareas en el sistema, y para esto no hace
 * falta.
 *
 * Solo toca `tenant.estado`, sus propias tablas y la bitácora. Nada contable.
 */
@Injectable()
export class CobrosService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger(CobrosService.name);
  private reloj: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DATA_SOURCE_PROVISION)
    private readonly provision: DataSource | null,
  ) {}

  onApplicationBootstrap(): void {
    if (this.provision === null || process.env.NODE_ENV === 'test') return;
    const correr = () =>
      this.revisar().catch((e: unknown) =>
        this.log.error(`La revisión de cobros falló: ${String(e)}`),
      );
    setTimeout(() => void correr(), 5_000).unref();
    this.reloj = setInterval(() => void correr(), CADA);
    this.reloj.unref();
  }

  onApplicationShutdown(): void {
    if (this.reloj) clearInterval(this.reloj);
  }

  /**
   * Genera los cargos que falten y aplica la mora a todas las cuentas. Si otra
   * instancia está revisando, no hace nada.
   */
  async revisar(hoy = hoyEnColombia()): Promise<{
    cargos: number;
    aMorosa: number;
    aActiva: number;
  }> {
    const ds = this.provision;
    if (ds === null) return { cargos: 0, aMorosa: 0, aActiva: 0 };

    return ds.transaction(async (t) => {
      const [{ libre }] = await t.query<Array<{ libre: boolean }>>(
        'SELECT pg_try_advisory_xact_lock($1) AS libre',
        [CANDADO],
      );
      if (!libre) return { cargos: 0, aMorosa: 0, aActiva: 0 };

      const cuentas = await t.query<Array<Record<string, unknown>>>(
        `SELECT t.id, t.plan, t.estado, t.dia_corte, t.cobro_desde::text AS cobro_desde,
                coalesce(t.precio_pactado, p.precio_mensual) AS precio
           FROM tenant t
           LEFT JOIN plan_catalogo p ON p.clave = t.plan
          WHERE t.estado IN ('ACTIVO', 'MOROSO')`,
      );

      let cargos = 0;
      let aMorosa = 0;
      let aActiva = 0;
      for (const c of cuentas) {
        const id = c.id as string;
        if (c.precio !== null) {
          for (const p of periodosACobrar(
            fecha(c.cobro_desde),
            Number(c.dia_corte),
            hoy,
          )) {
            const creados = await t.query<unknown[]>(
              `INSERT INTO suscripcion_cargo (tenant_id, periodo, plan, monto, vence_en)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (tenant_id, periodo) DO NOTHING
               RETURNING id`,
              [id, p.periodo, c.plan, Number(c.precio), p.venceEn],
            );
            cargos += creados.length;
          }
        }
        const cambio = await this.aplicarMora(t, id, c.estado as string, hoy);
        if (cambio === 'MOROSO') aMorosa += 1;
        if (cambio === 'ACTIVO') aActiva += 1;
      }
      if (cargos + aMorosa + aActiva > 0) {
        this.log.log(
          `Cobros: ${cargos} cargos nuevos, ${aMorosa} a morosa, ${aActiva} a activa.`,
        );
      }
      return { cargos, aMorosa, aActiva };
    });
  }

  /** La mora de una cuenta, con la regla de `decidirMora`. */
  private async aplicarMora(
    t: EntityManager,
    tenantId: string,
    estado: string,
    hoy: string,
  ): Promise<'MOROSO' | 'ACTIVO' | null> {
    const e = estadoDeCuenta(...(await this.movimientos(t, tenantId)), hoy);
    const [ultimo] = await t.query<
      Array<{ admin_id: string | null; despues: string | null }>
    >(
      `SELECT admin_id, detalle->>'despues' AS despues FROM plataforma_bitacora
        WHERE tenant_id = $1 AND accion = 'CAMBIAR_ESTADO'
        ORDER BY ocurrido_en DESC LIMIT 1`,
      [tenantId],
    );
    const porSistema =
      ultimo !== undefined &&
      ultimo.admin_id === null &&
      ultimo.despues === 'MOROSO';

    const nuevo = decidirMora(estado, e.diasMora, porSistema);
    if (nuevo === null) return null;

    await t.query('UPDATE tenant SET estado = $2 WHERE id = $1', [
      tenantId,
      nuevo,
    ]);
    await registrar(t, null, 'CAMBIAR_ESTADO', tenantId, {
      antes: estado,
      despues: nuevo,
      origen: 'SISTEMA',
      motivo:
        nuevo === 'MOROSO'
          ? `${e.diasMora} días sin pagar (el límite es ${DIAS_PARA_MORA})`
          : 'Se puso al día',
      ...(nuevo === 'MOROSO' ? { vencido: e.vencido } : {}),
    });
    return nuevo;
  }

  private async movimientos(
    t: EntityManager | DataSource,
    tenantId: string,
  ): Promise<[Cargo[], Pago[]]> {
    const [cargos, pagos] = await Promise.all([
      t.query<Array<Record<string, unknown>>>(
        'SELECT id, periodo, plan, monto, vence_en::text AS vence_en FROM suscripcion_cargo WHERE tenant_id = $1',
        [tenantId],
      ),
      t.query<Array<Record<string, unknown>>>(
        'SELECT id, fecha::text AS fecha, monto FROM suscripcion_pago WHERE tenant_id = $1',
        [tenantId],
      ),
    ]);
    return [
      cargos.map((c) => ({
        id: c.id as string,
        periodo: String(c.periodo),
        plan: c.plan as string,
        monto: Number(c.monto),
        venceEn: fecha(c.vence_en),
      })),
      pagos.map((p) => ({
        id: p.id as string,
        fecha: fecha(p.fecha),
        monto: Number(p.monto),
      })),
    ];
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /** Los cobros de todas las cuentas: para el Inicio y la lista. */
  async resumenes(hoy = hoyEnColombia()): Promise<Map<string, ResumenCobro>> {
    const ds = this.conexion();
    const [cuentas, cargos, pagos] = await Promise.all([
      ds.query<Array<Record<string, unknown>>>(
        `SELECT t.id, t.precio_pactado, t.dia_corte, t.cobro_desde::text AS cobro_desde,
                coalesce(t.precio_pactado, p.precio_mensual) AS precio
           FROM tenant t LEFT JOIN plan_catalogo p ON p.clave = t.plan`,
      ),
      ds.query<Array<Record<string, unknown>>>(
        'SELECT id, tenant_id, periodo, plan, monto, vence_en::text AS vence_en FROM suscripcion_cargo',
      ),
      ds.query<Array<Record<string, unknown>>>(
        'SELECT id, tenant_id, fecha::text AS fecha, monto FROM suscripcion_pago ORDER BY fecha, creado_en',
      ),
    ]);

    const agrupar = <T>(
      filas: Array<Record<string, unknown>>,
      a: (f: Record<string, unknown>) => T,
    ) => {
      const m = new Map<string, T[]>();
      for (const f of filas) {
        const k = f.tenant_id as string;
        m.set(k, [...(m.get(k) ?? []), a(f)]);
      }
      return m;
    };
    const cargosDe = agrupar<Cargo>(cargos, (c) => ({
      id: c.id as string,
      periodo: String(c.periodo),
      plan: c.plan as string,
      monto: Number(c.monto),
      venceEn: fecha(c.vence_en),
    }));
    const pagosDe = agrupar<Pago>(pagos, (p) => ({
      id: p.id as string,
      fecha: fecha(p.fecha),
      monto: Number(p.monto),
    }));

    return new Map(
      cuentas.map((c) => {
        const id = c.id as string;
        const suyos = pagosDe.get(id) ?? [];
        // Vienen por fecha y hora de registro: el último es el más reciente.
        const ultimo = suyos.at(-1);
        return [
          id,
          {
            tenantId: id,
            precio: c.precio === null ? null : Number(c.precio),
            precioPactado:
              c.precio_pactado === null ? null : Number(c.precio_pactado),
            diaCorte: Number(c.dia_corte),
            cobroDesde: fecha(c.cobro_desde),
            proximoCobro: proximoCorte(
              Number(c.dia_corte),
              hoy,
              fecha(c.cobro_desde),
            ),
            estado: estadoDeCuenta(cargosDe.get(id) ?? [], suyos, hoy),
            ultimoPago: ultimo
              ? { fecha: ultimo.fecha, monto: ultimo.monto }
              : null,
          },
        ];
      }),
    );
  }

  /** La pestaña Suscripción: el resumen, los cargos y los pagos. */
  async suscripcion(tenantId: string, hoy = hoyEnColombia()) {
    const ds = this.conexion();
    const resumen = (await this.resumenes(hoy)).get(tenantId);
    if (resumen === undefined)
      throw new NotFoundException('Cuenta no encontrada');
    const pagos = await ds.query<Array<Record<string, unknown>>>(
      `SELECT p.id, p.fecha::text AS fecha, p.monto, p.medio, p.referencia, p.creado_en,
              a.nombre_completo AS admin
         FROM suscripcion_pago p JOIN plataforma_admin a ON a.id = p.admin_id
        WHERE p.tenant_id = $1
        ORDER BY p.fecha DESC, p.creado_en DESC`,
      [tenantId],
    );
    return {
      ...resumen,
      pagos: pagos.map((p) => ({
        id: p.id as string,
        fecha: fecha(p.fecha),
        monto: Number(p.monto),
        medio: p.medio as string,
        referencia: (p.referencia as string | null) ?? null,
        registradoEn: iso(p.creado_en) as string,
        admin: p.admin as string,
      })),
    };
  }

  /** Lo que se cargó en cada período, por plan: el ingreso facturado. */
  async facturadoPorMes(): Promise<
    { periodo: string; plan: string; monto: number }[]
  > {
    const filas = await this.conexion().query<Array<Record<string, unknown>>>(
      `SELECT periodo, plan, sum(monto) AS monto FROM suscripcion_cargo
        GROUP BY periodo, plan ORDER BY periodo`,
    );
    return filas.map((f) => ({
      periodo: String(f.periodo),
      plan: f.plan as string,
      monto: Number(f.monto),
    }));
  }

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  /**
   * Un pago registrado a mano. No se edita ni se borra: si quedó mal, se
   * compensa con otro. Si la cuenta estaba morosa por el sistema y se pone al
   * día, vuelve a activa en la misma transacción.
   */
  async registrarPago(
    admin: CtxPlataforma,
    tenantId: string,
    dto: RegistrarPagoDto,
  ) {
    const hoy = hoyEnColombia();
    if (dto.fecha > hoy) {
      throw new BadRequestException('La fecha del pago no puede ser futura.');
    }
    return this.conexion().transaction(async (t) => {
      const [cuenta] = await t.query<Array<{ estado: string }>>(
        'SELECT estado FROM tenant WHERE id = $1 FOR UPDATE',
        [tenantId],
      );
      if (cuenta === undefined)
        throw new NotFoundException('Cuenta no encontrada');

      const [pago] = await t.query<Array<{ id: string }>>(
        `INSERT INTO suscripcion_pago (tenant_id, fecha, monto, medio, referencia, admin_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          tenantId,
          dto.fecha,
          dto.monto,
          dto.medio,
          dto.referencia?.trim() || null,
          admin.adminId,
        ],
      );
      await registrar(t, admin, 'REGISTRAR_PAGO', tenantId, {
        monto: dto.monto,
        fecha: dto.fecha,
        medio: dto.medio,
        ...(dto.referencia ? { referencia: dto.referencia.trim() } : {}),
      });
      const cambio = await this.aplicarMora(t, tenantId, cuenta.estado, hoy);
      return { pagoId: pago.id, reactivada: cambio === 'ACTIVO' };
    });
  }

  /** El precio pactado (null: el del plan) y el día de corte. */
  async cambiarSuscripcion(
    admin: CtxPlataforma,
    tenantId: string,
    dto: CambiarSuscripcionDto,
  ) {
    return this.conexion().transaction(async (t) => {
      const [antes] = await t.query<Array<Record<string, unknown>>>(
        'SELECT precio_pactado, dia_corte FROM tenant WHERE id = $1 FOR UPDATE',
        [tenantId],
      );
      if (antes === undefined)
        throw new NotFoundException('Cuenta no encontrada');
      const despues = {
        precioPactado:
          dto.precioPactado === undefined
            ? antes.precio_pactado === null
              ? null
              : Number(antes.precio_pactado)
            : dto.precioPactado,
        diaCorte: dto.diaCorte ?? Number(antes.dia_corte),
      };
      await t.query(
        'UPDATE tenant SET precio_pactado = $2, dia_corte = $3 WHERE id = $1',
        [tenantId, despues.precioPactado, despues.diaCorte],
      );
      await registrar(t, admin, 'CAMBIAR_SUSCRIPCION', tenantId, {
        antes: {
          precioPactado:
            antes.precio_pactado === null ? null : Number(antes.precio_pactado),
          diaCorte: Number(antes.dia_corte),
        },
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
