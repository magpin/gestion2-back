import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../common/ctx';
import { fila, filas } from '../../common/db/filas';

/** La fila que tiene que estar: si no está, es un error del sistema, no del usuario. */
function exigida<T>(resultado: unknown): T {
  const f = fila<T>(resultado);
  if (f === undefined)
    throw new Error(
      'Inconsistencia: la consulta no devolvió la fila esperada.',
    );
  return f;
}
import { TxService, type Tx } from '../../common/db/tx.service';
import { hoyEnColombia } from '../../common/fecha';
import { AlmacenamientoApi } from '../almacenamiento/almacenamiento.api';
import { NucleoApi } from '../nucleo/nucleo.api';
import type {
  Formulario350,
  ReteIcaMunicipio,
} from '../reportes/reportes/retenciones';
import { RetencionesReporteService } from '../reportes/servicios/retenciones-reporte.service';
import { TesoreriaApi } from '../tesoreria/tesoreria.api';
import {
  armarPago,
  CUENTAS_DE,
  FORMULARIO,
  NOMBRE_OBLIGACION,
  nombrePeriodo,
  periodoDe,
  periodosDelAnio,
  rangoDe,
  situacion,
  ultimoDigito,
  type ArmadoPago,
  type Obligacion,
  type Periodicidad,
  type PeriodicidadIva,
  type SaldoCausado,
  type Situacion,
} from './impuestos.reglas';
import {
  armarIcaPropio,
  type FuenteTarifa,
  type IcaPropio,
} from './ica.reglas';
import { armarIva, periodoAnterior, type IvaDelPeriodo } from './iva.reglas';
import {
  armarCuota,
  cuotasDe,
  estimarRenta,
  type RentaEstimada,
} from './renta.reglas';

/** El NIT de la DIAN: con él se busca su tercero para el pago. */
const NIT_DIAN = '800197268';
/** Responsabilidades del RUT (casilla 53) que abren cada obligación. */
const RUT_RETENCION = 7;
const RUT_IVA = 48;
const RUT_RENTA = 5;
const RUT_GRAN_CONTRIBUYENTE = 13;
const RUT_SIMPLE = 47;

/** Cuentas del pago que la empresa puede no tener todavía. Pendiente de ratificar Yeris. */
const CUENTA_INTERESES = { codigo: '530520', nombre: 'Intereses' };
const CUENTA_AJUSTE_INGRESO = { codigo: '429581', nombre: 'Ajuste al peso' };
const CUENTA_AJUSTE_GASTO = {
  codigo: '530595',
  nombre: 'Otros gastos financieros',
};

export interface Declaracion {
  id: string;
  obligacion: Obligacion;
  periodo: string;
  municipioCodigo: string | null;
  estado: 'PRESENTADA' | 'PAGADA';
  numeroFormulario: string;
  presentadaEl: string;
  valorAPagar: number;
  vence: string | null;
  archivoNombre: string | null;
  tieneArchivo: boolean;
  recibo490: string | null;
  pagadaEl: string | null;
  intereses: number;
  gmf: number;
  asientoId: string | null;
  /** Renta: el impuesto neto del 110 (para el anticipo por promedio del año siguiente). */
  impuestoNeto: number | null;
  /** Renta: el anticipo que se liquidó para el año siguiente. */
  anticipoSiguiente: number | null;
  /** En cuántas cuotas se paga: 1, salvo la renta. */
  cuotas: number;
  /** Lo pagado en cuotas (renta). */
  pagado: number;
  cuotasPagadas: number;
}

export interface FilaCalendario {
  obligacion: Obligacion;
  periodo: string;
  municipio: { codigo: string; nombre: string } | null;
  /** «Retención en la fuente · septiembre». */
  etiqueta: string;
  formulario: string | null;
  /** `null`: el calendario de ley no tiene la fecha (PC3). */
  vence: string | null;
  situacion: Situacion;
  /** Lo declarado si ya se presentó; si no, lo causado en el libro hasta hoy. `null` si no se puede separar. */
  valor: number | null;
  declaracion: Declaracion | null;
}

export interface ConfiguracionImpuestos {
  nit: string;
  digito: number;
  periodicidadIva: PeriodicidadIva | null;
  declaraRetencion: boolean;
  responsableIva: boolean;
  reteica: Array<{
    codigo: string;
    nombre: string;
    periodicidad: Periodicidad;
  }>;
  /** Los municipios donde la empresa tiene sede: en cada uno declara ICA. */
  ica: Array<{
    codigo: string;
    nombre: string;
    /** El de la sede principal: la venta no dice de qué sede sale, así que ahí van los ingresos. */
    principal: boolean;
    /** Desde qué año declara ahí; `null` si no se sabe (vino de la migración). */
    desdeAnio: number | null;
  }>;
  /** Renta del régimen ordinario (RUT 05) de una sociedad: la que va en el 110. */
  declaraRenta: boolean;
  /** RUT 47: declara el SIMPLE (260), no el 110. */
  regimenSimple: boolean;
  tipoPersona: 'JURIDICA' | 'NATURAL';
  /** RUT 13: paga la renta en tres cuotas. */
  granContribuyente: boolean;
  zomacTamano: ZomacTamano | null;
  /** El año de la matrícula mercantil: con él se sabe cuántos años lleva declarando. */
  desdeAnioRenta: number | null;
}

export type ZomacTamano = 'MICRO' | 'PEQUENA' | 'MEDIANA' | 'GRANDE';

export interface Calendario {
  hoy: string;
  anio: number;
  configuracion: ConfiguracionImpuestos;
  filas: FilaCalendario[];
  /** Lo presentado sin pagar más lo que ya se debe presentar. */
  porPagar: number;
  /** La que vence primero entre las que falta pagar. */
  proxima: FilaCalendario | null;
}

/** Desde cuántos días antes del vencimiento avisa Inicio. */
const DIAS_AVISO = 10;
/** Cuántos días se ve en Inicio una declaración recién pagada. */
const DIAS_PAGADA = 3;

function restarDias(fecha: string, dias: number): string {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) - dias * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Qué tanto del período ya pasó: «día 29 de 61». */
function avanceDe(
  desde: string,
  hasta: string,
  hoy: string,
): { dia: number; dias: number; cierra: string } {
  const ms = (f: string) => Date.parse(`${f}T00:00:00Z`);
  const dias = Math.round((ms(hasta) - ms(desde)) / 86_400_000) + 1;
  const dia = Math.max(
    0,
    Math.min(dias, Math.round((ms(hoy) - ms(desde)) / 86_400_000) + 1),
  );
  return { dia, dias, cierra: hasta };
}

export interface AvisoImpuestos {
  tipo: 'POR_PRESENTAR' | 'POR_PAGAR' | 'VENCE_HOY' | 'VENCIDA' | 'PAGADA';
  fila: FilaCalendario;
}

export interface IvaPantalla {
  configuracion: ConfiguracionImpuestos;
  /** `null` mientras la empresa no diga cada cuánto declara IVA. */
  periodo: string | null;
  fila: FilaCalendario | null;
  iva: IvaDelPeriodo | null;
  anterior: FilaCalendario | null;
  /** Qué tanto del período ya pasó. */
  avance: { dia: number; dias: number; cierra: string } | null;
}

export interface IcaDeMunicipio {
  municipio: { codigo: string; nombre: string };
  principal: boolean;
  /** La ley de ICA del municipio está cargada. */
  tieneLey: boolean;
  /** `null` fuera de la sede principal: los ingresos no se separan por sede. */
  estimado: IcaPropio | null;
  /** Si la empresa ya dijo si tiene avisos y tableros; sin respuesta, se incluyen. */
  avisosRespondido: boolean;
  /** El año en curso, que se sigue causando. */
  fila: FilaCalendario;
  /** El año anterior, el que toca declarar; `null` si la sede no existía o el libro no sabe nada de él. */
  anterior: FilaCalendario | null;
}

export interface ReteIcaDelPeriodo {
  municipio: { codigo: string; nombre: string };
  periodicidad: Periodicidad;
  periodo: string;
  fila: FilaCalendario;
  anterior: FilaCalendario;
  /** Lo retenido por proveedor; `null` si en el período no hubo ReteICA. */
  detalle: ReteIcaMunicipio | null;
  /** Lo retenido en los documentos contra lo causado en la 2368. */
  cuadre: {
    libro: number;
    documentos: number;
    diferencia: number;
    cuadra: boolean;
  };
  avance: { dia: number; dias: number; cierra: string } | null;
}

export interface IcaPantalla {
  hoy: string;
  configuracion: ConfiguracionImpuestos;
  /** `null` si la empresa no es agente de ReteICA en ningún municipio. */
  reteica: ReteIcaDelPeriodo | null;
  ica: IcaDeMunicipio[];
}

export interface PagoCuota {
  cuota: number;
  valor: number;
  intereses: number;
  recibo490: string;
  pagadaEl: string;
}

export interface RentaPantalla {
  hoy: string;
  configuracion: ConfiguracionImpuestos;
  /** `null` si la empresa no declara el 110 (persona natural, SIMPLE o sin RUT 05). */
  estimado: RentaEstimada | null;
  /** El año en curso. */
  fila: FilaCalendario | null;
  /** El año anterior, el que se declara este año. */
  anterior: FilaCalendario | null;
  /** Las cuotas pagadas del año anterior. */
  pagos: PagoCuota[];
}

export interface RetencionDelMes {
  mes: string;
  fila: FilaCalendario;
  formulario: Formulario350;
}

export interface DatosPresentacion {
  obligacion: Obligacion;
  periodo: string;
  municipioCodigo?: string | null;
  numeroFormulario: string;
  presentadaEl: string;
  valorAPagar: number;
  vence?: string | null;
  archivoClave?: string | null;
  archivoNombre?: string | null;
  /** Renta: el impuesto neto del 110. */
  impuestoNeto?: number | null;
  /** Renta: el anticipo que se liquidó para el año siguiente. */
  anticipoSiguiente?: number | null;
}

export interface DatosPago {
  medio: 'CAJA' | 'BANCO';
  cajaId?: string | null;
  cuentaBancariaId?: string | null;
  fecha: string;
  recibo490: string;
  intereses: number;
}

export interface PagoPrevio {
  declaracion: Declaracion;
  causado: SaldoCausado[];
  armado: ArmadoPago;
  /** Renta: la cuota que se va a pagar. `null` en las que se pagan de una vez. */
  cuota: { numero: number; de: number; valor: number } | null;
}

const CAMPOS = `id, obligacion, periodo, municipio_codigo, estado, numero_formulario,
  presentada_el::text, valor_a_pagar, vence::text, archivo_clave, archivo_nombre,
  recibo_490, pagada_el::text, intereses, gmf, asiento_id, impuesto_neto,
  anticipo_siguiente, cuotas,
  (SELECT coalesce(sum(p.valor), 0) FROM declaracion_pago p WHERE p.declaracion_id = declaracion.id) AS pagado,
  (SELECT count(*) FROM declaracion_pago p WHERE p.declaracion_id = declaracion.id) AS cuotas_pagadas`;

function aDeclaracion(f: Record<string, unknown>): Declaracion {
  return {
    id: f.id as string,
    obligacion: f.obligacion as Obligacion,
    periodo: f.periodo as string,
    municipioCodigo: (f.municipio_codigo as string | null)?.trim() ?? null,
    estado: f.estado as 'PRESENTADA' | 'PAGADA',
    numeroFormulario: f.numero_formulario as string,
    presentadaEl: f.presentada_el as string,
    valorAPagar: Number(f.valor_a_pagar),
    vence: f.vence as string | null,
    archivoNombre: f.archivo_nombre as string | null,
    tieneArchivo: f.archivo_clave !== null,
    recibo490: f.recibo_490 as string | null,
    pagadaEl: f.pagada_el as string | null,
    intereses: Number(f.intereses),
    gmf: Number(f.gmf),
    asientoId: f.asiento_id as string | null,
    impuestoNeto: f.impuesto_neto === null ? null : Number(f.impuesto_neto),
    anticipoSiguiente:
      f.anticipo_siguiente === null ? null : Number(f.anticipo_siguiente),
    cuotas: Number(f.cuotas ?? 1),
    pagado: Number(f.pagado ?? 0),
    cuotasPagadas: Number(f.cuotas_pagadas ?? 0),
  };
}

/**
 * El valor que muestra la fila de una declaración: lo que falta pagar (la
 * renta se paga por cuotas), o lo que se pagó si ya está pagada.
 */
const valorDeFila = (d: Declaracion) =>
  d.estado === 'PAGADA'
    ? d.valorAPagar
    : Math.round((d.valorAPagar - d.pagado) * 100) / 100;

/**
 * Contabilidad → Impuestos: el calendario, el 350 del mes, la presentación y
 * el pago de cada declaración.
 *
 * Lo causado sale del libro —las cuentas del pasivo de cada obligación en el
 * período—, sin contar los asientos de los pagos de declaraciones: pagar en
 * septiembre la retención de agosto no le resta a la de septiembre.
 */
@Injectable()
export class ImpuestosService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly tesoreria: TesoreriaApi,
    private readonly almacenamiento: AlmacenamientoApi,
    private readonly retenciones: RetencionesReporteService,
  ) {}

  // ─── Configuración ────────────────────────────────────────────────────────

  async configuracion(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<ConfiguracionImpuestos> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const empresa = exigida<{
          nit: string;
          tipo_persona: 'JURIDICA' | 'NATURAL';
          desde: number | null;
        }>(
          await t.query(
            `SELECT e.nit, e.tipo_persona,
                    (SELECT extract(year FROM min(m.fecha_matricula))::int
                       FROM empresa_matricula_mercantil m) AS desde
               FROM empresa e WHERE e.id = $1`,
            [ctx.empresaId],
          ),
        );
        const [config] = filas<{
          periodicidad_iva: PeriodicidadIva | null;
          zomac_tamano: ZomacTamano | null;
        }>(
          await t.query(
            'SELECT periodicidad_iva, zomac_tamano FROM empresa_impuesto_config',
          ),
        );
        const rut = new Set(
          filas<{ codigo: number }>(
            await t.query(
              `SELECT codigo FROM empresa_responsabilidad_rut
                WHERE empresa_id = $1 AND fecha_fin IS NULL`,
              [ctx.empresaId],
            ),
          ).map((r) => Number(r.codigo)),
        );
        const anio = Number(hoyEnColombia().slice(0, 4));
        const reteica = filas<{
          codigo: string;
          nombre: string;
          periodicidad: Periodicidad | null;
        }>(
          await t.query(
            `SELECT m.codigo, m.nombre, p.periodicidad
               FROM empresa_ica_municipio e
               JOIN municipio m ON m.codigo = e.municipio_codigo
               LEFT JOIN ica_parametro p ON p.municipio_codigo = e.municipio_codigo AND p.anio = $1
              WHERE e.es_agente_retenedor AND e.fecha_fin IS NULL
              ORDER BY m.nombre`,
            [anio],
          ),
        );
        const ica = filas<{
          codigo: string;
          nombre: string;
          principal: boolean;
          desde_anio: number | null;
        }>(
          await t.query(
            // Desde cuándo: la primera respuesta para ese municipio. La que
            // puso la migración 0077 no sabe cuándo empezó la sede.
            `SELECT m.codigo, m.nombre,
                    EXISTS (SELECT 1 FROM empresa_sede s
                             WHERE s.municipio_codigo = e.municipio_codigo
                               AND s.es_principal AND s.activo) AS principal,
                    (SELECT CASE WHEN bool_or(h.fuente = 'MIGRACION') THEN NULL
                                 ELSE extract(year FROM min(h.fecha_inicio))::int END
                       FROM empresa_ica_municipio h
                      WHERE h.municipio_codigo = e.municipio_codigo) AS desde_anio
               FROM empresa_ica_municipio e
               JOIN municipio m ON m.codigo = e.municipio_codigo
              WHERE e.fecha_fin IS NULL
              ORDER BY 3 DESC, m.nombre`,
          ),
        );
        return {
          nit: empresa.nit,
          digito: ultimoDigito(empresa.nit),
          periodicidadIva: config?.periodicidad_iva ?? null,
          declaraRetencion: rut.has(RUT_RETENCION),
          responsableIva: rut.has(RUT_IVA),
          declaraRenta:
            rut.has(RUT_RENTA) &&
            !rut.has(RUT_SIMPLE) &&
            empresa.tipo_persona === 'JURIDICA',
          regimenSimple: rut.has(RUT_SIMPLE),
          tipoPersona: empresa.tipo_persona,
          granContribuyente: rut.has(RUT_GRAN_CONTRIBUYENTE),
          zomacTamano: config?.zomac_tamano ?? null,
          desdeAnioRenta: empresa.desde,
          // Sin la ley del municipio cargada, bimestral: lo más común (E10).
          reteica: reteica.map((r) => ({
            codigo: r.codigo.trim(),
            nombre: r.nombre,
            periodicidad: r.periodicidad ?? 'BIMESTRAL',
          })),
          ica: ica.map((m) => ({
            codigo: m.codigo.trim(),
            nombre: m.nombre,
            principal: m.principal,
            desdeAnio: m.desde_anio,
          })),
        };
      },
      tx,
    );
  }

  async guardarConfiguracion(
    ctx: CtxEmpresa,
    datos: { periodicidadIva: PeriodicidadIva | null },
    tx?: Tx,
  ): Promise<ConfiguracionImpuestos> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        await t.query(
          `INSERT INTO empresa_impuesto_config (empresa_id, periodicidad_iva, actualizado_por)
         VALUES ($1, $2, $3)
         ON CONFLICT (empresa_id) DO UPDATE
           SET periodicidad_iva = EXCLUDED.periodicidad_iva,
               actualizado_en = now(),
               actualizado_por = EXCLUDED.actualizado_por`,
          [ctx.empresaId, datos.periodicidadIva, ctx.usuarioId],
        );
        return this.configuracion(ctx, t);
      },
      tx,
    );
  }

  // ─── Calendario ───────────────────────────────────────────────────────────

  async calendario(
    ctx: CtxEmpresa,
    anio: number,
    tx?: Tx,
  ): Promise<Calendario> {
    const hoy = hoyEnColombia();
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const config = await this.configuracion(ctx, t);
        const declaraciones = filas<Record<string, unknown>>(
          await t.query(`SELECT ${CAMPOS} FROM declaracion`),
        ).map(aDeclaracion);
        const buscar = (o: Obligacion, p: string, m: string | null) =>
          declaraciones.find(
            (d) =>
              d.obligacion === o && d.periodo === p && d.municipioCodigo === m,
          ) ?? null;

        // Qué períodos se miran: los del año que ya empezaron, y los del año
        // anterior que quedaron sin pagar (diciembre se paga en enero).
        const periodos = (
          periodicidad: Periodicidad,
          o: Obligacion,
          m: string | null,
        ) => {
          const actuales = periodosDelAnio(periodicidad, anio).filter(
            (p) => rangoDe(p).desde <= hoy,
          );
          const pendientesAntes = periodosDelAnio(
            periodicidad,
            anio - 1,
          ).filter(
            (p) =>
              buscar(o, p, m)?.estado !== 'PAGADA' &&
              rangoDe(p).hasta >= `${anio - 1}-10-01`,
          );
          return [...pendientesAntes, ...actuales];
        };

        const pedidos: Array<{
          o: Obligacion;
          p: string;
          m: { codigo: string; nombre: string } | null;
        }> = [];
        if (config.declaraRetencion) {
          for (const p of periodos('MENSUAL', 'RETENCION', null))
            pedidos.push({ o: 'RETENCION', p, m: null });
        }
        if (config.responsableIva && config.periodicidadIva !== null) {
          for (const p of periodos(config.periodicidadIva, 'IVA', null))
            pedidos.push({ o: 'IVA', p, m: null });
        }
        for (const m of config.reteica) {
          for (const p of periodos(m.periodicidad, 'RETEICA', m.codigo)) {
            pedidos.push({
              o: 'RETEICA',
              p,
              m: { codigo: m.codigo, nombre: m.nombre },
            });
          }
        }
        // El ICA propio: uno por municipio con sede, cada año.
        for (const m of config.ica) {
          for (const p of periodos('ANUAL', 'ICA', m.codigo)) {
            if (m.desdeAnio !== null && Number(p) < m.desdeAnio) continue;
            pedidos.push({
              o: 'ICA',
              p,
              m: { codigo: m.codigo, nombre: m.nombre },
            });
          }
        }
        // La renta: una al año, desde el año de la matrícula.
        if (config.declaraRenta) {
          for (const p of periodos('ANUAL', 'RENTA', null)) {
            if (
              config.desdeAnioRenta !== null &&
              Number(p) < config.desdeAnioRenta
            )
              continue;
            pedidos.push({ o: 'RENTA', p, m: null });
          }
        }
        // Las que se registraron por fuera de lo que se espera (un período
        // viejo) también se ven.
        for (const d of declaraciones) {
          const ya = pedidos.some(
            (x) =>
              x.o === d.obligacion &&
              x.p === d.periodo &&
              (x.m?.codigo ?? null) === d.municipioCodigo,
          );
          if (!ya && rangoDe(d.periodo).hasta.slice(0, 4) >= String(anio - 1)) {
            pedidos.push({
              o: d.obligacion,
              p: d.periodo,
              m:
                d.municipioCodigo === null
                  ? null
                  : { codigo: d.municipioCodigo, nombre: d.municipioCodigo },
            });
          }
        }

        const nombres = await this.nombresMunicipio(t);
        const resultado: FilaCalendario[] = [];
        for (const x of pedidos) {
          if (x.m !== null) {
            x.m = {
              codigo: x.m.codigo,
              nombre: nombres.get(x.m.codigo) ?? x.m.nombre,
            };
          }
          const declaracion = buscar(x.o, x.p, x.m?.codigo ?? null);
          const vence =
            x.o === 'RENTA'
              ? await this.venceRenta(t, x.p, config.digito, declaracion)
              : (declaracion?.vence ??
                (await this.vence(
                  t,
                  x.o,
                  x.p,
                  config.digito,
                  x.m?.codigo ?? null,
                )));
          let exacto: number | null = null;
          if (declaracion === null && x.o === 'RENTA') {
            // Como el ICA: el estimado desde el libro, no lo causado.
            const renta = await this.rentaEstimada(t, config, Number(x.p));
            if (!renta.conDatos && rangoDe(x.p).hasta < hoy) continue;
            exacto = renta.estimado.saldo;
          } else if (declaracion === null && x.o === 'ICA') {
            // El ICA no sale de lo causado en la 2412 (casi nadie lo provisiona
            // mes a mes): es el estimado desde los ingresos.
            const ica = await this.icaPropio(
              t,
              config,
              Number(x.p),
              x.m?.codigo ?? '',
            );
            // Un año sin ingresos en el libro es de antes de usar el sistema:
            // no se sabe nada de él, y no se muestra como pendiente.
            if (ica.ingresos === 0 && rangoDe(x.p).hasta < hoy) continue;
            exacto = ica.estimado?.saldo ?? null;
          } else if (declaracion === null) {
            const causado = await this.causado(
              t,
              x.o,
              x.p,
              x.m?.codigo ?? null,
              x.o === 'RETEICA' && config.reteica.length > 1,
            );
            exacto =
              Math.round(causado.reduce((s, c) => s + c.valor, 0) * 100) / 100;
            // Un período cerrado en el que no se causó nada no se presenta
            // (arts. 601 y 606 par. ET): no se muestra como pendiente.
            if (exacto === 0 && rangoDe(x.p).hasta < hoy) continue;
          }
          resultado.push({
            obligacion: x.o,
            periodo: x.p,
            municipio: x.m,
            etiqueta: `${NOMBRE_OBLIGACION[x.o]} · ${nombrePeriodo(x.p)}`,
            formulario: FORMULARIO[x.o],
            vence,
            situacion: situacion({ periodo: x.p, hoy, vence, declaracion }),
            valor: declaracion === null ? exacto : valorDeFila(declaracion),
            declaracion,
          });
        }
        // Lo que vence primero, primero; lo pagado al final.
        resultado.sort((a, b) => {
          const pa = a.situacion.estado === 'PAGADA' ? 1 : 0;
          const pb = b.situacion.estado === 'PAGADA' ? 1 : 0;
          if (pa !== pb) return pa - pb;
          return (a.vence ?? rangoDe(a.periodo).hasta).localeCompare(
            b.vence ?? rangoDe(b.periodo).hasta,
          );
        });
        const pendientes = resultado.filter(
          (f) =>
            (f.situacion.estado === 'PRESENTADA' ||
              f.situacion.estado === 'POR_PRESENTAR') &&
            (f.valor ?? 0) > 0,
        );
        return {
          hoy,
          anio,
          configuracion: config,
          filas: resultado,
          porPagar:
            Math.round(
              pendientes.reduce((s, f) => s + (f.valor ?? 0), 0) * 100,
            ) / 100,
          proxima: pendientes[0] ?? null,
        };
      },
      tx,
    );
  }

  /** La retención del mes: el 350 armado del libro y en qué va su declaración. */
  async retencion(ctx: CtxEmpresa, mes: string): Promise<RetencionDelMes> {
    const periodo = mes;
    const [formulario, calendario] = await Promise.all([
      this.retenciones.formulario350(ctx, mes),
      this.tx.enContexto(ctx, async (t) => {
        const config = await this.configuracion(ctx, t);
        const [d] = filas<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS} FROM declaracion WHERE obligacion = 'RETENCION' AND periodo = $1`,
            [periodo],
          ),
        );
        const declaracion = d === undefined ? null : aDeclaracion(d);
        const vence =
          declaracion?.vence ??
          (await this.vence(t, 'RETENCION', periodo, config.digito, null));
        return { declaracion, vence };
      }),
    ]);
    const hoy = hoyEnColombia();
    return {
      mes,
      formulario,
      fila: {
        obligacion: 'RETENCION',
        periodo,
        municipio: null,
        etiqueta: `${NOMBRE_OBLIGACION.RETENCION} · ${nombrePeriodo(periodo)}`,
        formulario: '350',
        vence: calendario.vence,
        situacion: situacion({
          periodo,
          hoy,
          vence: calendario.vence,
          declaracion: calendario.declaracion,
        }),
        valor:
          calendario.declaracion?.valorAPagar ??
          formulario.totales.centavos.total / 100,
        declaracion: calendario.declaracion,
      },
    };
  }

  /**
   * El IVA de un período (lienzo «IVA 300»): de las facturas de venta y de
   * compra, con el cuadre contra la 2408. Sin período, el que va corriendo.
   * `null` en `iva` si la empresa no dijo todavía cada cuánto declara.
   */
  async iva(ctx: CtxEmpresa, periodo?: string, tx?: Tx): Promise<IvaPantalla> {
    const hoy = hoyEnColombia();
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const config = await this.configuracion(ctx, t);
        if (config.periodicidadIva === null) {
          return {
            configuracion: config,
            periodo: null,
            fila: null,
            iva: null,
            anterior: null,
            avance: null,
          };
        }
        const p = periodo ?? periodoDe(config.periodicidadIva, hoy);
        const { desde, hasta } = rangoDe(p);

        const ventas = filas<{
          mes: string;
          tarifa: string;
          base: string;
          iva: string;
        }>(
          await t.query(
            `SELECT to_char(v.fecha, 'YYYY-MM') AS mes, l.iva_tarifa AS tarifa,
                    sum(CASE WHEN v.tipo = 'NOTA_CREDITO' THEN -l.subtotal ELSE l.subtotal END) AS base,
                    sum(CASE WHEN v.tipo = 'NOTA_CREDITO' THEN -l.iva_valor ELSE l.iva_valor END) AS iva
               FROM venta_documento_linea l
               JOIN venta_documento v ON v.id = l.venta_documento_id
              WHERE v.tipo IN ('FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO')
                AND v.estado <> 'ANULADA'
                AND v.fecha BETWEEN $1 AND $2
              GROUP BY 1, 2`,
            [desde, hasta],
          ),
        );
        const compras = filas<{
          mes: string;
          tarifa: string;
          descontable: boolean;
          base: string;
          iva: string;
        }>(
          await t.query(
            `SELECT to_char(c.fecha, 'YYYY-MM') AS mes, l.iva_tarifa AS tarifa, l.iva_descontable AS descontable,
                    sum(CASE WHEN c.tipo = 'NOTA_CREDITO' THEN -coalesce(l.iva_base, l.subtotal)
                             ELSE coalesce(l.iva_base, l.subtotal) END) AS base,
                    sum(CASE WHEN c.tipo = 'NOTA_CREDITO' THEN -l.iva_valor ELSE l.iva_valor END) AS iva
               FROM compra_documento_linea l
               JOIN compra_documento c ON c.id = l.compra_documento_id
              WHERE c.estado <> 'ANULADA'
                AND c.fecha BETWEEN $1 AND $2
                AND l.iva_tarifa > 0
              GROUP BY 1, 2, 3`,
            [desde, hasta],
          ),
        );
        const [rete] = filas<{ valor: string | null }>(
          await t.query(
            `SELECT sum(CASE WHEN v.tipo = 'NOTA_CREDITO' THEN -r.valor ELSE r.valor END) AS valor
               FROM venta_retencion r
               JOIN venta_documento v ON v.id = r.venta_documento_id
              WHERE r.tipo = 'IVA' AND v.estado <> 'ANULADA' AND v.fecha BETWEEN $1 AND $2`,
            [desde, hasta],
          ),
        );
        const libro = (await this.causado(t, 'IVA', p))
          .filter((c) => c.codigo.startsWith('2408'))
          .reduce((s, c) => s + c.valor, 0);

        const iva = armarIva({
          periodo: p,
          ventas: ventas.map((v) => ({
            mes: v.mes,
            tarifa: Number(v.tarifa),
            base: Number(v.base),
            iva: Number(v.iva),
          })),
          compras: compras.map((c) => ({
            mes: c.mes,
            tarifa: Number(c.tarifa),
            descontable: c.descontable,
            base: Number(c.base),
            iva: Number(c.iva),
          })),
          reteIvaSufrida: Number(rete?.valor ?? 0),
          libro2408: libro,
        });

        const fila = await this.filaDe(
          t,
          config.digito,
          'IVA',
          p,
          hoy,
          iva.saldo,
        );
        const anterior = await this.filaDe(
          t,
          config.digito,
          'IVA',
          periodoAnterior(p),
          hoy,
          null,
        );
        return {
          configuracion: config,
          periodo: p,
          fila,
          iva,
          anterior,
          avance: avanceDe(desde, hasta, hoy),
        };
      },
      tx,
    );
  }

  /**
   * ICA y ReteICA (lienzo «ICA y ReteICA»). El ReteICA de un municipio y un
   * período (sin ellos, el primer municipio y el período que va corriendo), y
   * el ICA propio de cada municipio con sede: el año en curso y el anterior.
   */
  async ica(
    ctx: CtxEmpresa,
    municipio?: string,
    periodo?: string,
    tx?: Tx,
  ): Promise<IcaPantalla> {
    const hoy = hoyEnColombia();
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const config = await this.configuracion(ctx, t);
        const m =
          config.reteica.find((r) => r.codigo === municipio) ??
          config.reteica[0] ??
          null;
        // El período se lleva a la periodicidad del municipio: «2026-B5» en uno
        // mensual es septiembre.
        const p =
          m === null
            ? null
            : periodoDe(
                m.periodicidad,
                periodo === undefined ? hoy : rangoDe(periodo).desde,
              );
        const reporte =
          p === null
            ? null
            : await this.retenciones.reteIca(
                ctx,
                { ...rangoDe(p), etiqueta: nombrePeriodo(p) },
                t,
              );
        let reteica: ReteIcaDelPeriodo | null = null;
        if (m !== null && p !== null && reporte !== null) {
          const repartir = config.reteica.length > 1;
          const suma = (c: SaldoCausado[]) =>
            Math.round(c.reduce((s, x) => s + x.valor, 0) * 100) / 100;
          const libro = suma(
            await this.causado(t, 'RETEICA', p, m.codigo, repartir),
          );
          const anteriorP = periodoDe(
            m.periodicidad,
            restarDias(rangoDe(p).desde, 1),
          );
          const libroAnterior = suma(
            await this.causado(t, 'RETEICA', anteriorP, m.codigo, repartir),
          );
          const detalle =
            reporte.municipios.find((x) => x.codigo.trim() === m.codigo) ??
            null;
          const documentos = (detalle?.centavos ?? 0) / 100;
          const municipioFila = { codigo: m.codigo, nombre: m.nombre };
          const { desde, hasta } = rangoDe(p);
          reteica = {
            municipio: municipioFila,
            periodicidad: m.periodicidad,
            periodo: p,
            fila: await this.filaDe(
              t,
              config.digito,
              'RETEICA',
              p,
              hoy,
              libro,
              municipioFila,
            ),
            anterior: await this.filaDe(
              t,
              config.digito,
              'RETEICA',
              anteriorP,
              hoy,
              libroAnterior,
              municipioFila,
            ),
            detalle,
            cuadre: {
              libro,
              documentos,
              diferencia: Math.round((libro - documentos) * 100) / 100,
              // El libro va al peso; lo retenido, al centavo.
              cuadra: Math.abs(libro - documentos) < 1,
            },
            avance: avanceDe(desde, hasta, hoy),
          };
        }

        const anio = Number(hoy.slice(0, 4));
        const ica: IcaDeMunicipio[] = [];
        for (const x of config.ica) {
          const municipioFila = { codigo: x.codigo, nombre: x.nombre };
          const este = await this.icaPropio(t, config, anio, x.codigo);
          const antes = await this.icaPropio(t, config, anio - 1, x.codigo);
          const anterior = await this.filaDe(
            t,
            config.digito,
            'ICA',
            String(anio - 1),
            hoy,
            antes.estimado?.saldo ?? null,
            municipioFila,
          );
          ica.push({
            municipio: municipioFila,
            principal: x.principal,
            tieneLey: este.tieneLey,
            estimado: este.estimado,
            avisosRespondido: este.avisosRespondido,
            fila: await this.filaDe(
              t,
              config.digito,
              'ICA',
              String(anio),
              hoy,
              este.estimado?.saldo ?? null,
              municipioFila,
            ),
            // Como en el calendario: no se muestra el año en que la sede no
            // existía, ni uno del que el libro no sabe nada.
            anterior:
              anterior.declaracion === null &&
              ((x.desdeAnio !== null && anio - 1 < x.desdeAnio) ||
                antes.ingresos === 0)
                ? null
                : anterior,
          });
        }
        return { hoy, configuracion: config, reteica, ica };
      },
      tx,
    );
  }

  /** Si la empresa tiene avisos y tableros en el municipio: suma el 15 % al ICA. */
  async guardarAvisos(
    ctx: CtxEmpresa,
    municipioCodigo: string,
    avisosTableros: boolean,
    tx?: Tx,
  ): Promise<void> {
    await this.tx.enContexto(
      ctx,
      async (t) => {
        const [sede] = filas<{ ok: number }>(
          await t.query(
            `SELECT 1 AS ok FROM empresa_ica_municipio
            WHERE municipio_codigo = $1 AND fecha_fin IS NULL`,
            [municipioCodigo],
          ),
        );
        if (sede === undefined) {
          throw new BadRequestException(
            'La empresa no tiene sede en ese municipio: no declara ICA allá.',
          );
        }
        await t.query(
          `INSERT INTO empresa_ica_propio (empresa_id, municipio_codigo, avisos_tableros, actualizado_por)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (empresa_id, municipio_codigo) DO UPDATE
           SET avisos_tableros = EXCLUDED.avisos_tableros,
               actualizado_en = now(),
               actualizado_por = EXCLUDED.actualizado_por`,
          [ctx.empresaId, municipioCodigo, avisosTableros, ctx.usuarioId],
        );
      },
      tx,
    );
  }

  /**
   * El ICA propio de un año en un municipio, desde el libro. Los ingresos
   * (clase 4, sin el asiento de cierre) son de la empresa entera: la venta no
   * dice de qué sede sale, así que el estimado va solo en la sede principal.
   */
  private async icaPropio(
    t: Tx,
    config: ConfiguracionImpuestos,
    anio: number,
    municipio: string,
  ): Promise<{
    ingresos: number;
    tieneLey: boolean;
    estimado: IcaPropio | null;
    avisosRespondido: boolean;
  }> {
    const [libro] = filas<{
      ingresos: string | null;
      excluidos: string | null;
      anticipos: string | null;
    }>(
      await t.query(
        `SELECT sum(CASE WHEN c.codigo LIKE '4%' THEN l.credito - l.debito END) AS ingresos,
                sum(CASE WHEN c.codigo LIKE '4245%' THEN l.credito - l.debito END) AS excluidos,
                sum(CASE WHEN c.codigo LIKE '135518%' THEN l.debito - l.credito END) AS anticipos
           FROM asiento_linea l
           JOIN asiento a ON a.id = l.asiento_id
           JOIN empresa_cuenta c ON c.id = l.cuenta_id
           JOIN empresa_comprobante_tipo ct ON ct.id = a.comprobante_tipo_id
          WHERE a.estado = 'REGISTRADO'
            AND a.fecha BETWEEN $1 AND $2
            AND ct.naturaleza <> 'CIERRE'
            AND (c.codigo LIKE '4%' OR c.codigo LIKE '135518%')
            AND NOT EXISTS (SELECT 1 FROM declaracion d WHERE d.asiento_id = a.id)`,
        [`${anio}-01-01`, `${anio}-12-31`],
      ),
    );
    const ingresos = Number(libro?.ingresos ?? 0);
    const [ley] = filas<{ ok: number }>(
      await t.query(
        'SELECT 1 AS ok FROM ica_parametro WHERE municipio_codigo = $1 LIMIT 1',
        [municipio],
      ),
    );
    const [avisos] = filas<{ avisos_tableros: boolean }>(
      await t.query(
        'SELECT avisos_tableros FROM empresa_ica_propio WHERE municipio_codigo = $1',
        [municipio],
      ),
    );
    const principal =
      config.ica.find((x) => x.codigo === municipio)?.principal ?? false;
    if (!principal) {
      return {
        ingresos,
        tieneLey: ley !== undefined,
        estimado: null,
        avisosRespondido: avisos !== undefined,
      };
    }
    // La tarifa: la de la actividad de la empresa en la ley del municipio (la
    // del año más cercano cargado); si no, la que escribió la empresa.
    const [tarifa] = filas<{ tarifa: string; fuente: FuenteTarifa }>(
      await t.query(
        `SELECT tarifa::text, fuente FROM (
           SELECT t.tarifa_por_mil AS tarifa, 'LEY' AS fuente, 0 AS orden, abs(t.anio - $2) AS cerca
             FROM ica_tarifa t
             JOIN empresa_actividad_economica a
               ON a.es_principal AND a.fecha_fin IS NULL AND t.ciiu = a.codigo_ciiu
            WHERE t.municipio_codigo = $1
           UNION ALL
           SELECT e.tarifa_provisional_por_mil, 'PROVISIONAL', 1, 0
             FROM empresa_ica_municipio e
            WHERE e.municipio_codigo = $1 AND e.fecha_fin IS NULL
              AND e.tarifa_provisional_por_mil IS NOT NULL
           UNION ALL
           SELECT a.tarifa_ica_por_mil, 'PROVISIONAL', 2, 0
             FROM empresa_actividad_economica a
            WHERE a.es_principal AND a.fecha_fin IS NULL AND a.tarifa_ica_por_mil IS NOT NULL
         ) x
         ORDER BY orden, cerca, tarifa DESC
         LIMIT 1`,
        [municipio, anio],
      ),
    );
    return {
      ingresos,
      tieneLey: ley !== undefined,
      avisosRespondido: avisos !== undefined,
      estimado: armarIcaPropio({
        anio,
        ingresos,
        excluidos: Number(libro?.excluidos ?? 0),
        tarifaPorMil: tarifa === undefined ? null : Number(tarifa.tarifa),
        fuenteTarifa: tarifa?.fuente ?? null,
        avisosTableros: avisos?.avisos_tableros ?? true,
        anticipos: Number(libro?.anticipos ?? 0),
      }),
    };
  }

  private async nombresMunicipio(t: Tx): Promise<Map<string, string>> {
    const usados = filas<{ codigo: string; nombre: string }>(
      await t.query(
        `SELECT m.codigo, m.nombre FROM municipio m
          WHERE m.codigo IN (SELECT municipio_codigo FROM declaracion
                             UNION SELECT municipio_codigo FROM empresa_ica_municipio)`,
      ),
    );
    return new Map(usados.map((u) => [u.codigo.trim(), u.nombre]));
  }

  /**
   * Renta (lienzo «Renta 110»): el estimado del año en curso, desde el libro,
   * y la declaración del año anterior con sus cuotas. No es la declaración
   * (Y8): lo dice la pantalla.
   */
  async renta(ctx: CtxEmpresa, tx?: Tx): Promise<RentaPantalla> {
    const hoy = hoyEnColombia();
    const anio = Number(hoy.slice(0, 4));
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const config = await this.configuracion(ctx, t);
        if (!config.declaraRenta) {
          return {
            hoy,
            configuracion: config,
            estimado: null,
            fila: null,
            anterior: null,
            pagos: [],
          };
        }
        const este = await this.rentaEstimada(t, config, anio);
        const fila = await this.filaRenta(t, config, String(anio), hoy, este);
        const antes = await this.rentaEstimada(t, config, anio - 1);
        const anterior = await this.filaRenta(
          t,
          config,
          String(anio - 1),
          hoy,
          antes,
        );
        const pagos =
          anterior.declaracion === null
            ? []
            : filas<{
                cuota: number;
                valor: string;
                intereses: string;
                recibo_490: string;
                pagada_el: string;
              }>(
                await t.query(
                  `SELECT cuota, valor, intereses, recibo_490, pagada_el::text
                     FROM declaracion_pago WHERE declaracion_id = $1 ORDER BY cuota`,
                  [anterior.declaracion.id],
                ),
              ).map((p) => ({
                cuota: Number(p.cuota),
                valor: Number(p.valor),
                intereses: Number(p.intereses),
                recibo490: p.recibo_490,
                pagadaEl: p.pagada_el,
              }));
        // El año anterior no se muestra si la empresa no existía o el libro
        // no sabe nada de él, salvo que ya se haya registrado.
        const mostrarAnterior =
          anterior.declaracion !== null ||
          (antes.conDatos &&
            (config.desdeAnioRenta === null ||
              anio - 1 >= config.desdeAnioRenta));
        return {
          hoy,
          configuracion: config,
          estimado: este.estimado,
          fila,
          anterior: mostrarAnterior ? anterior : null,
          pagos,
        };
      },
      tx,
    );
  }

  /** Si la empresa es ZOMAC y de qué tamaño: cambia la tarifa de renta. */
  async guardarZomac(
    ctx: CtxEmpresa,
    zomacTamano: ZomacTamano | null,
    tx?: Tx,
  ): Promise<ConfiguracionImpuestos> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        await t.query(
          `INSERT INTO empresa_impuesto_config (empresa_id, zomac_tamano, actualizado_por)
           VALUES ($1, $2, $3)
           ON CONFLICT (empresa_id) DO UPDATE
             SET zomac_tamano = EXCLUDED.zomac_tamano,
                 actualizado_en = now(),
                 actualizado_por = EXCLUDED.actualizado_por`,
          [ctx.empresaId, zomacTamano, ctx.usuarioId],
        );
        return this.configuracion(ctx, t);
      },
      tx,
    );
  }

  private async filaRenta(
    t: Tx,
    config: ConfiguracionImpuestos,
    periodo: string,
    hoy: string,
    renta: { estimado: RentaEstimada },
  ): Promise<FilaCalendario> {
    const [d] = filas<Record<string, unknown>>(
      await t.query(
        `SELECT ${CAMPOS} FROM declaracion WHERE obligacion = 'RENTA' AND periodo = $1`,
        [periodo],
      ),
    );
    const declaracion = d === undefined ? null : aDeclaracion(d);
    const vence = await this.venceRenta(t, periodo, config.digito, declaracion);
    return {
      obligacion: 'RENTA',
      periodo,
      municipio: null,
      etiqueta: `${NOMBRE_OBLIGACION.RENTA} · ${nombrePeriodo(periodo)}`,
      formulario: FORMULARIO.RENTA,
      vence,
      situacion: situacion({ periodo, hoy, vence, declaracion }),
      valor:
        declaracion === null ? renta.estimado.saldo : valorDeFila(declaracion),
      declaracion,
    };
  }

  /**
   * El estimado de la renta de un año desde el libro (sin el asiento de
   * cierre). `conDatos`: si el libro tiene movimientos de resultados ese año.
   */
  private async rentaEstimada(
    t: Tx,
    config: ConfiguracionImpuestos,
    anio: number,
  ): Promise<{ conDatos: boolean; estimado: RentaEstimada }> {
    const desde = `${anio}-01-01`;
    const hasta = `${anio}-12-31`;
    const [libro] = filas<{
      lineas: string;
      utilidad: string | null;
      gmf: string | null;
      multas: string | null;
      retenciones: string | null;
    }>(
      await t.query(
        `SELECT count(*) FILTER (WHERE c.codigo ~ '^[4-7]') AS lineas,
                -- La utilidad antes del impuesto de renta (54).
                sum(CASE WHEN c.codigo ~ '^[4-7]' AND c.codigo NOT LIKE '54%'
                         THEN l.credito - l.debito END) AS utilidad,
                sum(CASE WHEN cm.codigo = 'GTO-GMF' THEN l.debito - l.credito END) AS gmf,
                sum(CASE WHEN c.codigo LIKE '539520%' THEN l.debito - l.credito END) AS multas,
                -- Lo retenido, sin el cruce contra la 2404 que hace el contador.
                sum(CASE WHEN c.codigo LIKE '135515%'
                          AND NOT EXISTS (SELECT 1 FROM asiento_linea x
                                            JOIN empresa_cuenta xc ON xc.id = x.cuenta_id
                                           WHERE x.asiento_id = a.id AND xc.codigo LIKE '2404%')
                         THEN l.debito - l.credito END) AS retenciones
           FROM asiento_linea l
           JOIN asiento a ON a.id = l.asiento_id
           JOIN empresa_cuenta c ON c.id = l.cuenta_id
           JOIN empresa_comprobante_tipo ct ON ct.id = a.comprobante_tipo_id
           LEFT JOIN concepto_movimiento cm ON cm.id = l.concepto_id
          WHERE a.estado = 'REGISTRADO'
            AND a.fecha BETWEEN $1 AND $2
            AND ct.naturaleza <> 'CIERRE'
            AND (c.codigo ~ '^[4-7]' OR c.codigo LIKE '135515%')`,
        [desde, hasta],
      ),
    );
    // Los intereses de mora de impuestos no se restan (art. 105 ET).
    const [mora] = filas<{ valor: string | null }>(
      await t.query(
        `SELECT (SELECT coalesce(sum(intereses), 0) FROM declaracion
                  WHERE cuotas = 1 AND pagada_el BETWEEN $1 AND $2)
              + (SELECT coalesce(sum(intereses), 0) FROM declaracion_pago
                  WHERE pagada_el BETWEEN $1 AND $2) AS valor`,
        [desde, hasta],
      ),
    );
    const [zomac] =
      config.zomacTamano === null
        ? []
        : filas<{ factor: string }>(
            await t.query(
              `SELECT factor FROM retencion_zomac_factor
                WHERE tamano = $1 AND $2 BETWEEN anio_desde AND anio_hasta`,
              [config.zomacTamano, anio],
            ),
          );
    const [previa] = filas<{
      anticipo_siguiente: string | null;
      impuesto_neto: string | null;
    }>(
      await t.query(
        `SELECT anticipo_siguiente, impuesto_neto FROM declaracion
          WHERE obligacion = 'RENTA' AND periodo = $1`,
        [String(anio - 1)],
      ),
    );
    return {
      conDatos: Number(libro?.lineas ?? 0) > 0,
      estimado: estimarRenta({
        anio,
        utilidad: Number(libro?.utilidad ?? 0),
        gmf: Number(libro?.gmf ?? 0),
        multas: Number(libro?.multas ?? 0) + Number(mora?.valor ?? 0),
        factorZomac: zomac === undefined ? 1 : Number(zomac.factor),
        retenciones: Number(libro?.retenciones ?? 0),
        anticipoAnterior:
          previa?.anticipo_siguiente == null
            ? null
            : Number(previa.anticipo_siguiente),
        impuestoNetoAnterior:
          previa?.impuesto_neto == null ? null : Number(previa.impuesto_neto),
        anioDeclaracion:
          config.desdeAnioRenta === null
            ? null
            : Math.max(1, anio - config.desdeAnioRenta + 1),
        cuotas: config.granContribuyente ? 3 : 2,
      }),
    };
  }

  /**
   * La fila del calendario de una obligación: su declaración, si la hay, y su
   * vencimiento. Con `municipio`, la de ese municipio (ICA y ReteICA).
   */
  private async filaDe(
    t: Tx,
    digito: number,
    obligacion: Obligacion,
    periodo: string,
    hoy: string,
    causado: number | null,
    municipio: { codigo: string; nombre: string } | null = null,
  ): Promise<FilaCalendario> {
    const [d] = filas<Record<string, unknown>>(
      await t.query(
        `SELECT ${CAMPOS} FROM declaracion
          WHERE obligacion = $1 AND periodo = $2
            AND coalesce(municipio_codigo, '') = coalesce($3, '')`,
        [obligacion, periodo, municipio?.codigo ?? null],
      ),
    );
    const declaracion = d === undefined ? null : aDeclaracion(d);
    const vence =
      declaracion?.vence ??
      (await this.vence(
        t,
        obligacion,
        periodo,
        digito,
        municipio?.codigo ?? null,
      ));
    return {
      obligacion,
      periodo,
      municipio,
      etiqueta: `${NOMBRE_OBLIGACION[obligacion]} · ${nombrePeriodo(periodo)}`,
      formulario: FORMULARIO[obligacion],
      vence,
      situacion: situacion({ periodo, hoy, vence, declaracion }),
      valor: declaracion?.valorAPagar ?? causado,
      declaracion,
    };
  }

  /**
   * El aviso de Inicio (lienzo «La DIAN en Inicio»): la declaración más
   * urgente, o la que se acaba de pagar. `null` si no hay nada que decir.
   */
  async aviso(ctx: CtxEmpresa, tx?: Tx): Promise<AvisoImpuestos | null> {
    const hoy = hoyEnColombia();
    const cal = await this.calendario(ctx, Number(hoy.slice(0, 4)), tx);
    const urgente = cal.filas.find(
      (f) =>
        (f.situacion.estado === 'POR_PRESENTAR' ||
          f.situacion.estado === 'PRESENTADA') &&
        (f.valor ?? 0) > 0 &&
        (f.situacion.dias === null || f.situacion.dias <= DIAS_AVISO),
    );
    if (urgente !== undefined) {
      const dias = urgente.situacion.dias;
      return {
        tipo:
          dias !== null && dias < 0
            ? 'VENCIDA'
            : dias === 0
              ? 'VENCE_HOY'
              : urgente.situacion.estado === 'PRESENTADA'
                ? 'POR_PAGAR'
                : 'POR_PRESENTAR',
        fila: urgente,
      };
    }
    // La recién pagada se muestra unos días, y se va sola.
    const pagada = cal.filas
      .filter(
        (f) =>
          f.declaracion?.pagadaEl != null &&
          f.declaracion.pagadaEl >= restarDias(hoy, DIAS_PAGADA),
      )
      .sort((a, b) =>
        (b.declaracion!.pagadaEl ?? '').localeCompare(
          a.declaracion!.pagadaEl ?? '',
        ),
      )[0];
    return pagada === undefined ? null : { tipo: 'PAGADA', fila: pagada };
  }

  /** Lo presentado que falta pagar: lo lee Pagos → Por pagar y el tablero de Inicio. */
  async porPagar(ctx: CtxEmpresa, tx?: Tx): Promise<FilaCalendario[]> {
    const hoy = hoyEnColombia();
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const declaraciones = filas<Record<string, unknown>>(
          await t.query(
            `SELECT ${CAMPOS} FROM declaracion WHERE estado = 'PRESENTADA' ORDER BY vence NULLS LAST`,
          ),
        ).map(aDeclaracion);
        const nombres = await this.nombresMunicipio(t);
        const digito = (await this.configuracion(ctx, t)).digito;
        const resultado: FilaCalendario[] = [];
        for (const d of declaraciones) {
          const vence =
            d.obligacion === 'RENTA'
              ? await this.venceRenta(t, d.periodo, digito, d)
              : d.vence;
          resultado.push({
            obligacion: d.obligacion,
            periodo: d.periodo,
            municipio:
              d.municipioCodigo === null
                ? null
                : {
                    codigo: d.municipioCodigo,
                    nombre: nombres.get(d.municipioCodigo) ?? d.municipioCodigo,
                  },
            etiqueta: `${NOMBRE_OBLIGACION[d.obligacion]} · ${nombrePeriodo(d.periodo)}`,
            formulario: FORMULARIO[d.obligacion],
            vence,
            situacion: situacion({
              periodo: d.periodo,
              hoy,
              vence,
              declaracion: d,
            }),
            valor: valorDeFila(d),
            declaracion: d,
          });
        }
        return resultado;
      },
      tx,
    );
  }

  // ─── Presentación ─────────────────────────────────────────────────────────

  async presentar(
    ctx: CtxEmpresa,
    datos: DatosPresentacion,
    tx?: Tx,
  ): Promise<Declaracion> {
    rangoDe(datos.periodo);
    const municipio = datos.municipioCodigo ?? null;
    if (
      (datos.obligacion === 'RETEICA' || datos.obligacion === 'ICA') !==
      (municipio !== null)
    ) {
      throw new BadRequestException(
        municipio === null
          ? 'Esta declaración es del municipio: elegí cuál.'
          : 'Esta declaración es de la DIAN: no lleva municipio.',
      );
    }
    if (datos.presentadaEl > hoyEnColombia()) {
      throw new BadRequestException(
        'La fecha de presentación no puede ser futura.',
      );
    }
    // Un período se declara cuando termina: antes, MUISCA no lo deja.
    if (datos.presentadaEl <= rangoDe(datos.periodo).hasta) {
      throw new BadRequestException(
        `El período ${nombrePeriodo(datos.periodo)} termina el ${rangoDe(datos.periodo).hasta}: se presenta después de esa fecha.`,
      );
    }
    const renta = datos.obligacion === 'RENTA';
    if (
      !renta &&
      (datos.impuestoNeto != null || datos.anticipoSiguiente != null)
    ) {
      throw new BadRequestException(
        'El impuesto neto y el anticipo son renglones de la renta.',
      );
    }
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const config = await this.configuracion(ctx, t);
        const vence =
          datos.vence ??
          (await this.vence(
            t,
            datos.obligacion,
            datos.periodo,
            config.digito,
            municipio,
            renta ? 1 : null,
          ));
        // La renta de una sociedad va en dos cuotas; la del gran
        // contribuyente, en tres.
        const cuotas = renta ? (config.granContribuyente ? 3 : 2) : 1;
        try {
          const creada = exigida<Record<string, unknown>>(
            await t.query(
              `INSERT INTO declaracion
               (empresa_id, obligacion, periodo, municipio_codigo, estado, numero_formulario,
                presentada_el, valor_a_pagar, vence, archivo_clave, archivo_nombre, creado_por,
                impuesto_neto, anticipo_siguiente, cuotas)
             VALUES ($1,$2,$3,$4,'PRESENTADA',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING ${CAMPOS}`,
              [
                ctx.empresaId,
                datos.obligacion,
                datos.periodo,
                municipio,
                datos.numeroFormulario.trim(),
                datos.presentadaEl,
                datos.valorAPagar,
                vence,
                datos.archivoClave ?? null,
                datos.archivoNombre ?? null,
                ctx.usuarioId,
                renta ? (datos.impuestoNeto ?? null) : null,
                renta ? (datos.anticipoSiguiente ?? null) : null,
                cuotas,
              ],
            ),
          );
          return aDeclaracion(creada);
        } catch (e) {
          if ((e as { code?: string }).code === '23505') {
            throw new ConflictException(
              'Esa declaración ya está registrada: corregila en vez de registrarla otra vez.',
            );
          }
          throw e;
        }
      },
      tx,
    );
  }

  /** Corrige la presentación mientras no esté pagada. */
  async corregir(
    ctx: CtxEmpresa,
    id: string,
    datos: Omit<
      DatosPresentacion,
      'obligacion' | 'periodo' | 'municipioCodigo'
    >,
    tx?: Tx,
  ): Promise<Declaracion> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const actual = await this.una(t, id);
        if (actual.estado === 'PAGADA') {
          throw new ConflictException(
            'La declaración ya está pagada: no se corrige.',
          );
        }
        // Con una cuota pagada, el valor ya no se mueve: las cuotas salieron de él.
        if (actual.pagado > 0 && datos.valorAPagar !== actual.valorAPagar) {
          throw new ConflictException(
            'Ya hay cuotas pagadas: el valor a pagar no se corrige. Si la corregiste en MUISCA, hablalo con el contador.',
          );
        }
        const renta = actual.obligacion === 'RENTA';
        const f = exigida<Record<string, unknown>>(
          await t.query(
            `UPDATE declaracion
              SET numero_formulario = $2, presentada_el = $3, valor_a_pagar = $4,
                  vence = coalesce($5, vence),
                  archivo_clave = coalesce($6, archivo_clave),
                  archivo_nombre = coalesce($7, archivo_nombre),
                  impuesto_neto = CASE WHEN $8 THEN $9::numeric ELSE impuesto_neto END,
                  anticipo_siguiente = CASE WHEN $8 THEN $10::numeric ELSE anticipo_siguiente END
            WHERE id = $1
            RETURNING ${CAMPOS}`,
            [
              id,
              datos.numeroFormulario.trim(),
              datos.presentadaEl,
              datos.valorAPagar,
              datos.vence ?? null,
              datos.archivoClave ?? null,
              datos.archivoNombre ?? null,
              renta,
              renta ? (datos.impuestoNeto ?? null) : null,
              renta ? (datos.anticipoSiguiente ?? null) : null,
            ],
          ),
        );
        return aDeclaracion(f);
      },
      tx,
    );
  }

  /** Dónde subir el PDF del formulario. La llave la decide el servidor. */
  firmarArchivo(ctx: CtxEmpresa, tipoMime: string) {
    if (!this.almacenamiento.disponible) {
      throw new BadRequestException(
        'Subir archivos no está disponible en este ambiente.',
      );
    }
    return this.almacenamiento.firmarSubida(
      `declaraciones/${ctx.empresaId}`,
      tipoMime,
    );
  }

  /** Un enlace de lectura al PDF del formulario. */
  async archivo(
    ctx: CtxEmpresa,
    id: string,
  ): Promise<{ url: string; nombre: string | null }> {
    const [f] = await this.tx.enContexto(ctx, async (t) =>
      filas<{ archivo_clave: string | null; archivo_nombre: string | null }>(
        await t.query(
          'SELECT archivo_clave, archivo_nombre FROM declaracion WHERE id = $1',
          [id],
        ),
      ),
    );
    if (f === undefined)
      throw new NotFoundException('La declaración no existe.');
    if (f.archivo_clave === null)
      throw new NotFoundException('Esta declaración no tiene PDF.');
    return {
      url: await this.almacenamiento.firmarLectura(f.archivo_clave),
      nombre: f.archivo_nombre,
    };
  }

  // ─── Pago ─────────────────────────────────────────────────────────────────

  async pagoPrevio(
    ctx: CtxEmpresa,
    id: string,
    intereses: number,
    tx?: Tx,
  ): Promise<PagoPrevio> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const declaracion = await this.una(t, id);
        return {
          declaracion,
          ...(await this.armar(ctx, t, declaracion, intereses, false)),
        };
      },
      tx,
    );
  }

  async pagar(
    ctx: CtxEmpresa,
    id: string,
    datos: DatosPago,
    tx?: Tx,
  ): Promise<Declaracion> {
    if (datos.fecha > hoyEnColombia()) {
      throw new BadRequestException('La fecha del pago no puede ser futura.');
    }
    if (datos.recibo490.trim() === '') {
      throw new BadRequestException('Escribí el número del recibo 490.');
    }
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const declaracion = await this.una(t, id, true);
        if (declaracion.estado === 'PAGADA') {
          throw new ConflictException('Esta declaración ya está pagada.');
        }
        const { armado, cuota } = await this.armar(
          ctx,
          t,
          declaracion,
          datos.intereses,
          true,
        );
        if (!armado.ok) throw new BadRequestException(armado.motivo);

        const tercero =
          declaracion.municipioCodigo === null
            ? await this.terceroDian(t)
            : null;
        const etiqueta = `${NOMBRE_OBLIGACION[declaracion.obligacion]} ${nombrePeriodo(declaracion.periodo)}${cuota === null ? '' : ` · cuota ${cuota.numero} de ${cuota.de}`} · ${FORMULARIO[declaracion.obligacion] ?? 'formulario'} ${declaracion.numeroFormulario}`;
        const pago = await this.tesoreria.registrarSalidaConPartidas(
          ctx,
          {
            medio: datos.medio,
            cajaId: datos.cajaId,
            cuentaBancariaId: datos.cuentaBancariaId,
            fecha: datos.fecha,
            valor: armado.total,
            concepto: `Pago ${etiqueta} · recibo ${datos.recibo490.trim()}`,
            terceroId: tercero,
            contrapartidas: armado.partidas.map((p) => ({
              cuentaId: p.cuentaId,
              debito: p.debito,
              credito: p.credito,
              // Cada retención se salda con su tercero; lo que no va por
              // tercero (intereses, ajuste), con la DIAN si está registrada.
              terceroId: p.terceroId ?? tercero ?? undefined,
              baseGravable: p.exigeBase ? 0 : undefined,
            })),
          },
          t,
        );
        const gmf =
          datos.medio === 'BANCO' && datos.cuentaBancariaId
            ? await this.tesoreria.cobrarGmf(
                ctx,
                {
                  cuentaBancariaId: datos.cuentaBancariaId,
                  base: armado.total,
                  fecha: datos.fecha,
                  detalle: `4×1000 del pago ${etiqueta}`,
                  origenId: declaracion.id,
                },
                t,
              )
            : null;
        if (cuota !== null) {
          await t.query(
            `INSERT INTO declaracion_pago
               (empresa_id, declaracion_id, cuota, valor, intereses, recibo_490, pagada_el, medio,
                caja_id, cuenta_bancaria_id, asiento_id, movimiento_id, gmf_movimiento_id, gmf, creado_por)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              ctx.empresaId,
              id,
              cuota.numero,
              cuota.valor,
              datos.intereses,
              datos.recibo490.trim(),
              datos.fecha,
              datos.medio,
              datos.medio === 'CAJA' ? datos.cajaId : null,
              datos.medio === 'BANCO' ? datos.cuentaBancariaId : null,
              pago.asientoId,
              pago.movimientoId,
              gmf?.id ?? null,
              gmf?.valorMovido ?? 0,
              ctx.usuarioId,
            ],
          );
          // Hasta la última cuota, la declaración sigue presentada.
          if (cuota.numero < cuota.de) return this.una(t, id);
        }
        const f = exigida<Record<string, unknown>>(
          await t.query(
            `UPDATE declaracion
              SET estado = 'PAGADA', recibo_490 = $2, pagada_el = $3, medio = $4, caja_id = $5,
                  cuenta_bancaria_id = $6, asiento_id = $8, movimiento_id = $9,
                  gmf_movimiento_id = $10, pagado_por = $12,
                  -- Con cuotas, la declaración suma los intereses y el 4×1000 de todas.
                  intereses = coalesce((SELECT sum(p.intereses) FROM declaracion_pago p WHERE p.declaracion_id = $1), $7),
                  gmf = coalesce((SELECT sum(p.gmf) FROM declaracion_pago p WHERE p.declaracion_id = $1), $11)
            WHERE id = $1
            RETURNING ${CAMPOS}`,
            [
              id,
              datos.recibo490.trim(),
              datos.fecha,
              datos.medio,
              datos.medio === 'CAJA' ? datos.cajaId : null,
              datos.medio === 'BANCO' ? datos.cuentaBancariaId : null,
              datos.intereses,
              pago.asientoId,
              pago.movimientoId,
              gmf?.id ?? null,
              gmf?.valorMovido ?? 0,
              ctx.usuarioId,
            ],
          ),
        );
        return aDeclaracion(f);
      },
      tx,
    );
  }

  // ─── Internos ─────────────────────────────────────────────────────────────

  private async una(t: Tx, id: string, bloquear = false): Promise<Declaracion> {
    const [f] = filas<Record<string, unknown>>(
      await t.query(
        `SELECT ${CAMPOS} FROM declaracion WHERE id = $1${bloquear ? ' FOR UPDATE' : ''}`,
        [id],
      ),
    );
    if (f === undefined)
      throw new NotFoundException('La declaración no existe.');
    return aDeclaracion(f);
  }

  /** El vencimiento de ley: por dígito para la DIAN, por municipio para el ICA. */
  private async vence(
    t: Tx,
    obligacion: Obligacion,
    periodo: string,
    digito: number,
    municipio: string | null,
    cuota: number | null = null,
  ): Promise<string | null> {
    const [f] = filas<{ vence: string }>(
      await t.query(
        `SELECT vence::text FROM calendario_tributario
          WHERE obligacion = $1 AND periodo = $2
            AND coalesce(cuota, 0) = coalesce($5::smallint, 0)
            AND (digito IS NULL OR digito = $3)
            AND coalesce(municipio_codigo, '') = coalesce($4, '')
          ORDER BY digito NULLS LAST
          LIMIT 1`,
        [obligacion, periodo, digito, municipio, cuota],
      ),
    );
    return f?.vence ?? null;
  }

  /**
   * El vencimiento de la renta es el de la cuota que sigue. La primera va con
   * la declaración: sin fila en el calendario, vale la que se escribió al
   * presentarla.
   */
  private async venceRenta(
    t: Tx,
    periodo: string,
    digito: number,
    declaracion: Declaracion | null,
  ): Promise<string | null> {
    if (declaracion?.estado === 'PAGADA') return declaracion.vence;
    const cuota = (declaracion?.cuotasPagadas ?? 0) + 1;
    return (
      (await this.vence(t, 'RENTA', periodo, digito, null, cuota)) ??
      (cuota === 1 ? (declaracion?.vence ?? null) : null)
    );
  }

  /**
   * Lo causado por cuenta en el período: créditos menos débitos de las
   * cuentas del pasivo de la obligación, sin los asientos de pagos de
   * declaraciones.
   *
   * Con `repartir` (ReteICA en varios municipios), la 2368 no dice de qué
   * municipio es: cada línea cuenta por la parte que el documento de origen
   * retuvo en `municipio`. Un asiento a mano, sin documento, no se reparte.
   */
  private async causado(
    t: Tx,
    obligacion: Obligacion,
    periodo: string,
    municipio: string | null = null,
    repartir = false,
  ): Promise<SaldoCausado[]> {
    const { desde, hasta } = rangoDe(periodo);
    if (repartir && municipio !== null) {
      return filas<{
        id: string;
        codigo: string;
        nombre: string;
        tercero_id: string | null;
        exige_base_gravable: boolean;
        valor: string;
      }>(
        await t.query(
          `SELECT c.id, c.codigo, c.nombre, l.tercero_id, c.exige_base_gravable,
                  round(sum((l.credito - l.debito) * coalesce(r.parte, 0)), 2) AS valor
             FROM asiento_linea l
             JOIN asiento a ON a.id = l.asiento_id
             JOIN empresa_cuenta c ON c.id = l.cuenta_id
             LEFT JOIN LATERAL (
               SELECT sum(rc.valor) FILTER (WHERE rc.municipio_codigo = $4)
                        / nullif(sum(rc.valor), 0) AS parte
                 FROM retencion_calculada rc
                WHERE rc.documento_id = a.origen_id
                  AND rc.impuesto = 'ICA'
                  AND rc.estado IN ('CONFIRMADA', 'ANULADA')) r ON true
            WHERE a.estado = 'REGISTRADO'
              AND a.fecha BETWEEN $1 AND $2
              AND c.codigo LIKE ANY ($3)
              AND NOT EXISTS (SELECT 1 FROM declaracion d WHERE d.asiento_id = a.id)
            GROUP BY c.id, c.codigo, c.nombre, l.tercero_id, c.exige_base_gravable
           HAVING round(sum((l.credito - l.debito) * coalesce(r.parte, 0)), 2) <> 0
            ORDER BY c.codigo, l.tercero_id`,
          [desde, hasta, CUENTAS_DE[obligacion].map((p) => `${p}%`), municipio],
        ),
      ).map((f) => ({
        cuentaId: f.id,
        codigo: f.codigo,
        nombre: f.nombre,
        terceroId: f.tercero_id,
        exigeBase: f.exige_base_gravable,
        valor: Number(f.valor),
      }));
    }
    return filas<{
      id: string;
      codigo: string;
      nombre: string;
      tercero_id: string | null;
      exige_base_gravable: boolean;
      valor: string;
    }>(
      await t.query(
        `SELECT c.id, c.codigo, c.nombre, l.tercero_id, c.exige_base_gravable,
                sum(l.credito - l.debito) AS valor
           FROM asiento_linea l
           JOIN asiento a ON a.id = l.asiento_id
           JOIN empresa_cuenta c ON c.id = l.cuenta_id
          WHERE a.estado = 'REGISTRADO'
            AND a.fecha BETWEEN $1 AND $2
            AND c.codigo LIKE ANY ($3)
            AND NOT EXISTS (SELECT 1 FROM declaracion d WHERE d.asiento_id = a.id)
          GROUP BY c.id, c.codigo, c.nombre, l.tercero_id, c.exige_base_gravable
         HAVING sum(l.credito - l.debito) <> 0
          ORDER BY c.codigo, l.tercero_id`,
        [desde, hasta, CUENTAS_DE[obligacion].map((p) => `${p}%`)],
      ),
    ).map((f) => ({
      cuentaId: f.id,
      codigo: f.codigo,
      nombre: f.nombre,
      terceroId: f.tercero_id,
      exigeBase: f.exige_base_gravable,
      valor: Number(f.valor),
    }));
  }

  /**
   * Las partidas del pago. Al pagar (`crear`), las cuentas de intereses y
   * ajuste que falten se crean del decreto; en la vista previa no se crea
   * nada.
   */
  private async armar(
    ctx: CtxEmpresa,
    t: Tx,
    declaracion: Declaracion,
    intereses: number,
    crear: boolean,
  ): Promise<{
    causado: SaldoCausado[];
    armado: ArmadoPago;
    cuota: PagoPrevio['cuota'];
  }> {
    if (declaracion.obligacion === 'RENTA') {
      return this.armarRenta(ctx, t, declaracion, intereses, crear);
    }
    const config = await this.configuracion(ctx, t);
    if (declaracion.obligacion === 'ICA' && config.ica.length > 1) {
      // La 2412 no dice de qué municipio es cada peso.
      return {
        causado: [],
        armado: {
          ok: false,
          motivo:
            'La empresa tiene sedes en varios municipios y el libro no separa el ICA de cada uno. Registrá este pago con un comprobante de egreso en Pagos.',
        },
        cuota: null,
      };
    }
    const causado = await this.causado(
      t,
      declaracion.obligacion,
      declaracion.periodo,
      declaracion.municipioCodigo,
      declaracion.obligacion === 'RETEICA' && config.reteica.length > 1,
    );
    const cuenta = async (c: { codigo: string; nombre: string }) => {
      if (crear) await this.nucleo.asegurarCuenta(ctx, c, t);
      const encontrada = await this.nucleo.cuenta(ctx, c.codigo, t);
      return {
        cuentaId: encontrada?.id ?? `nueva:${c.codigo}`,
        codigo: c.codigo,
        nombre: encontrada?.nombre ?? c.nombre,
      };
    };
    const armado = armarPago({
      causado,
      valorAPagar: declaracion.valorAPagar,
      intereses,
      cuentaIntereses: intereses > 0 ? await cuenta(CUENTA_INTERESES) : null,
      ajusteIngreso: await cuenta(CUENTA_AJUSTE_INGRESO),
      ajusteGasto: await cuenta(CUENTA_AJUSTE_GASTO),
    });
    if (
      !armado.ok &&
      declaracion.obligacion === 'ICA' &&
      !causado.some((c) => c.codigo.startsWith('2412') && c.valor > 0)
    ) {
      return {
        causado,
        armado: {
          ok: false,
          motivo: `El ICA de ${declaracion.periodo} no está causado en el libro (2412). Causalo primero con un comprobante de diario (gasto 511505 contra 2412) y después registrá el pago.`,
        },
        cuota: null,
      };
    }
    return { causado, armado, cuota: null };
  }

  /**
   * La cuota de renta que sigue: su valor sale del saldo a pagar del 110 en
   * cuotas parejas, y se paga contra lo que tenga la 2404 (acumulado, no del
   * período: la renta se causa al cierre y se paga al año siguiente).
   */
  private async armarRenta(
    ctx: CtxEmpresa,
    t: Tx,
    declaracion: Declaracion,
    intereses: number,
    crear: boolean,
  ): Promise<{
    causado: SaldoCausado[];
    armado: ArmadoPago;
    cuota: PagoPrevio['cuota'];
  }> {
    const numero = declaracion.cuotasPagadas + 1;
    const plan = cuotasDe(declaracion.valorAPagar, declaracion.cuotas);
    const cuota = plan[numero - 1];
    if (cuota === undefined) {
      return {
        causado: [],
        armado: {
          ok: false,
          motivo:
            declaracion.valorAPagar <= 0
              ? 'La declaración no tiene saldo a pagar.'
              : 'Ya se pagaron todas las cuotas.',
        },
        cuota: null,
      };
    }
    const saldos = filas<{
      id: string;
      codigo: string;
      nombre: string;
      saldo: string;
    }>(
      await t.query(
        `SELECT c.id, c.codigo, c.nombre, sum(l.credito - l.debito) AS saldo
           FROM asiento_linea l
           JOIN asiento a ON a.id = l.asiento_id
           JOIN empresa_cuenta c ON c.id = l.cuenta_id
          WHERE a.estado = 'REGISTRADO' AND c.codigo LIKE '2404%'
          GROUP BY c.id, c.codigo, c.nombre`,
      ),
    );
    let cuentaIntereses: {
      cuentaId: string;
      codigo: string;
      nombre: string;
    } | null = null;
    if (intereses > 0) {
      if (crear) await this.nucleo.asegurarCuenta(ctx, CUENTA_INTERESES, t);
      const c = await this.nucleo.cuenta(ctx, CUENTA_INTERESES.codigo, t);
      cuentaIntereses = {
        cuentaId: c?.id ?? `nueva:${CUENTA_INTERESES.codigo}`,
        codigo: CUENTA_INTERESES.codigo,
        nombre: c?.nombre ?? CUENTA_INTERESES.nombre,
      };
    }
    const r = armarCuota({
      valor: cuota.valor,
      intereses,
      saldos2404: saldos.map((s) => ({
        cuentaId: s.id,
        codigo: s.codigo,
        nombre: s.nombre,
        saldo: Number(s.saldo),
      })),
      cuentaIntereses,
    });
    const info = { numero, de: declaracion.cuotas, valor: cuota.valor };
    if (!r.ok) return { causado: [], armado: r, cuota: info };
    return {
      causado: [],
      armado: {
        ok: true,
        partidas: r.partidas.map((p) => ({
          ...p,
          terceroId: null,
          exigeBase: false,
          credito: 0,
        })),
        redondeo: 0,
        total: r.total,
      },
      cuota: info,
    };
  }

  private async terceroDian(t: Tx): Promise<string | null> {
    const [f] = filas<{ id: string }>(
      await t.query(
        `SELECT id FROM tercero WHERE regexp_replace(numero_documento, '\\D', '', 'g') = $1 LIMIT 1`,
        [NIT_DIAN],
      ),
    );
    return f?.id ?? null;
  }
}
