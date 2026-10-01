import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  ResponderIcaDto,
  ResponderImpuestoDto,
} from '../dto/impuestos.dto';
import { EmpresaLegalService } from './empresa-legal.service';
import {
  PREGUNTAS,
  agenteIva,
  preguntaDe,
  respuestaDe,
  resumir,
  type ClavePregunta,
  type ResumenImpuestos,
} from './impuestos.reglas';

const hoy = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const ayer = (fecha: string): string => {
  const d = new Date(`${fecha}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Una fecha de la base, venga como `Date` o como texto. */
const aFecha = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

export interface RespuestaPregunta {
  clave: ClavePregunta;
  pregunta: string;
  ayuda: string;
  respuesta: boolean | null;
  /** De dónde salió: el código del RUT vigente que la sostiene y desde cuándo. */
  fuente: { codigo: number; desde: string } | null;
}

export interface MunicipioIca {
  codigo: string;
  nombre: string;
  esPrincipal: boolean;
  respuesta: {
    esAgenteRetenedor: boolean;
    esAutorretenedor: boolean;
    /** Por mil, provisional hasta que esté la ley de ICA del municipio (R-D11). */
    tarifaProvisionalPorMil: number | null;
    fuente: 'MANUAL' | 'IA' | 'MIGRACION';
    desde: string;
  } | null;
}

export interface EstadoImpuestos {
  preguntas: RespuestaPregunta[];
  agenteIva: { es: boolean; porque: string | null };
  municipios: MunicipioIca[];
  resumen: ResumenImpuestos;
  confirmadoEn: string | null;
}

/**
 * El paso «Impuestos» de la configuración (plan motor de retenciones, Fase 0,
 * §0.7). Cada respuesta termina donde siempre: la casilla 53 del RUT
 * (`EmpresaLegalService`) y la condición que se deriva de ella. Lo único
 * propio es el ICA por municipio y la confirmación del resumen.
 */
@Injectable()
export class ImpuestosEmpresaService {
  constructor(
    private readonly tx: TxService,
    private readonly legal: EmpresaLegalService,
  ) {}

  async estado(ctx: CtxEmpresa): Promise<EstadoImpuestos> {
    return this.tx.enContexto(ctx, async (t) => {
      const vigentes = (
        await t.query<Array<{ tipo_regimen: string }>>(
          `SELECT tipo_regimen FROM empresa_regimen_tributario
            WHERE empresa_id = $1 AND fecha_fin IS NULL`,
          [ctx.empresaId],
        )
      ).map((r) => r.tipo_regimen);

      const codigos = await t.query<Array<{ codigo: number; desde: string }>>(
        `SELECT COALESCE(c.codigo_reemplazo, c.codigo) AS codigo,
                min(r.fecha_inicio)::text AS desde
           FROM empresa_responsabilidad_rut r
           JOIN responsabilidad_tributaria c ON c.codigo = r.codigo
          WHERE r.empresa_id = $1 AND r.fecha_fin IS NULL
          GROUP BY 1`,
        [ctx.empresaId],
      );

      const [empresa] = await t.query<
        Array<{ confirmado: string | null; dijo_no: string[] | null }>
      >(
        `SELECT impuestos_confirmado_en::text AS confirmado,
                impuestos_dijo_no AS dijo_no
           FROM empresa WHERE id = $1`,
        [ctx.empresaId],
      );
      const confirmadoEn = empresa?.confirmado ?? null;
      const dijoNo = empresa?.dijo_no ?? [];

      const preguntas = PREGUNTAS.map((p): RespuestaPregunta => {
        const respuesta = respuestaDe(
          p,
          vigentes,
          confirmadoEn !== null,
          dijoNo,
        );
        const codigo =
          respuesta === true
            ? p.codigoSi
            : respuesta === false
              ? p.codigoNo
              : undefined;
        const fila = codigos.find((c) => c.codigo === codigo);
        return {
          clave: p.clave,
          pregunta: p.pregunta,
          ayuda: p.ayuda,
          respuesta,
          fuente:
            fila === undefined
              ? null
              : { codigo: fila.codigo, desde: fila.desde },
        };
      });

      const municipios = await this.municipios(t, ctx);
      const agenteIcaEn = municipios
        .filter((m) => m.respuesta?.esAgenteRetenedor === true)
        .map((m) => m.nombre);

      return {
        preguntas,
        agenteIva: agenteIva(vigentes),
        municipios,
        resumen: resumir(vigentes, agenteIcaEn),
        confirmadoEn,
      };
    });
  }

  /**
   * «Sí» abre el código del RUT; «no» lo cierra (y en el IVA abre el 49). La
   * condición la deriva `EmpresaLegalService`, igual que al cargar el RUT.
   *
   * Cambiar de opinión el mismo día es corregir, no un hecho nuevo: lo que se
   * había abierto hoy se corrige en el sitio en vez de cerrarse antes de haber
   * empezado (que la base, con razón, rechaza).
   */
  async responder(
    ctx: CtxEmpresa,
    dto: ResponderImpuestoDto,
  ): Promise<EstadoImpuestos> {
    const p = preguntaDe(dto.clave);
    const fecha = hoy();
    const actual = (await this.estado(ctx)).preguntas.find(
      (x) => x.clave === p.clave,
    );
    if (actual?.respuesta === dto.valor) return this.estado(ctx);

    if (p.codigoNo !== undefined) {
      await this.cambiarIva(ctx, dto.valor, fecha);
    } else if (dto.valor) {
      await this.legal.abrirResponsabilidadRut(ctx, {
        codigo: p.codigoSi,
        fechaInicio: fecha,
      });
    } else {
      await this.cerrarCodigo(ctx, p.codigoSi, fecha);
    }
    if (p.codigoNo === undefined) {
      await this.anotarNo(ctx, p.clave, !dto.valor);
    }
    return this.estado(ctx);
  }

  /**
   * El «No» a una pregunta sin código de «no» no deja rastro en la casilla 53:
   * se anota aparte para que se vea contestado (0101). Un «Sí» lo quita.
   */
  private async anotarNo(
    ctx: CtxEmpresa,
    clave: ClavePregunta,
    dijoNo: boolean,
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE empresa
            SET impuestos_dijo_no = array_remove(impuestos_dijo_no, $2::text)
                                    || CASE WHEN $3 THEN ARRAY[$2::text] ELSE '{}'::text[] END
          WHERE id = $1`,
        [ctx.empresaId, clave, dijoNo],
      ),
    );
  }

  /** Responsable de IVA (48) o no (49): siempre queda uno, nunca los dos. */
  private async cambiarIva(
    ctx: CtxEmpresa,
    cobra: boolean,
    fecha: string,
  ): Promise<void> {
    const [nuevo, viejo] = cobra ? [48, 49] : [49, 48];
    const [condNueva, condVieja] = cobra
      ? ['RESPONSABLE_IVA', 'NO_RESPONSABLE_IVA']
      : ['NO_RESPONSABLE_IVA', 'RESPONSABLE_IVA'];

    const corregido = await this.tx.enContexto(ctx, async (t) => {
      // Un UPDATE devuelve [filas, cantidad]: `filas` saca las filas.
      const deHoy = filas<{ id: string }>(
        await t.query(
          `UPDATE empresa_responsabilidad_rut SET codigo = $3
            WHERE empresa_id = $1 AND codigo = $2 AND fecha_fin IS NULL AND fecha_inicio = $4::date
           RETURNING id`,
          [ctx.empresaId, viejo, nuevo, fecha],
        ),
      );
      if (deHoy.length === 0) {
        // Venía de antes: deja de regir ayer, y el nuevo rige desde hoy.
        await t.query(
          `UPDATE empresa_responsabilidad_rut SET fecha_fin = $3::date - 1
            WHERE empresa_id = $1 AND codigo = $2 AND fecha_fin IS NULL`,
          [ctx.empresaId, viejo, fecha],
        );
        return false;
      }
      await t.query(
        `UPDATE empresa_regimen_tributario
            SET tipo_regimen = $3,
                codigo_responsabilidad_dian = (SELECT codigo FROM responsabilidad_fiscal_fe WHERE codigo_rut = $4)
          WHERE empresa_id = $1 AND tipo_regimen = $2 AND fecha_fin IS NULL AND fecha_inicio = $5::date`,
        [ctx.empresaId, condVieja, condNueva, nuevo, fecha],
      );
      return true;
    });

    // Abrir el nuevo deriva su condición y cierra la opuesta ayer.
    if (!corregido) {
      await this.legal.abrirResponsabilidadRut(ctx, {
        codigo: nuevo,
        fechaInicio: fecha,
      });
    }
  }

  /**
   * «No» a un código sin opuesto: deja de regir ayer. Si se había abierto hoy,
   * queda cerrado hoy (una vigencia de un día): la base no guarda vigencias
   * vacías y lo abierto no se borra.
   */
  private async cerrarCodigo(
    ctx: CtxEmpresa,
    codigo: number,
    fecha: string,
  ): Promise<void> {
    const vigentes = await this.legal.listarResponsabilidadesRut(ctx, true);
    for (const f of vigentes) {
      const efectivo =
        (f.codigo_reemplazo as number | null) ?? Number(f.codigo);
      if (efectivo !== codigo) continue;
      const inicio = aFecha(f.fecha_inicio);
      await this.legal.cerrarResponsabilidadRut(
        ctx,
        String(f.id),
        inicio >= fecha ? fecha : ayer(fecha),
      );
    }
  }

  /**
   * El ICA de un municipio con sede. Cambiar la respuesta abre una versión
   * nueva desde hoy; si ya se cambió hoy, se corrige la de hoy.
   *
   * La condición `AGENTE_RETENEDOR_ICA` (la que mira el plan de cuentas para
   * crear la 2368) queda vigente mientras sea agente en al menos un municipio.
   */
  async responderIca(
    ctx: CtxEmpresa,
    municipio: string,
    dto: ResponderIcaDto,
    fuente: 'MANUAL' | 'IA' = 'MANUAL',
  ): Promise<EstadoImpuestos> {
    const fecha = hoy();
    await this.tx.enContexto(ctx, async (t) => {
      const conSede = await t.query<Array<{ ok: number }>>(
        `SELECT 1 AS ok FROM empresa_sede
          WHERE empresa_id = $1 AND municipio_codigo = $2 AND activo LIMIT 1`,
        [ctx.empresaId, municipio],
      );
      if (conSede.length === 0) {
        throw new BadRequestException(
          'Ese municipio no tiene sede activa. El ICA se contesta por cada municipio donde hay sede.',
        );
      }

      const [vigente] = await t.query<
        Array<{ id: string; fecha_inicio: string; tarifa: string | null }>
      >(
        `SELECT id, fecha_inicio::text, tarifa_provisional_por_mil AS tarifa
           FROM empresa_ica_municipio
          WHERE empresa_id = $1 AND municipio_codigo = $2 AND fecha_fin IS NULL
          FOR UPDATE`,
        [ctx.empresaId, municipio],
      );
      const tarifa =
        dto.tarifaProvisionalPorMil !== undefined
          ? dto.tarifaProvisionalPorMil
          : vigente?.tarifa === undefined || vigente.tarifa === null
            ? null
            : Number(vigente.tarifa);

      if (vigente !== undefined && vigente.fecha_inicio === fecha) {
        await t.query(
          `UPDATE empresa_ica_municipio
              SET es_agente_retenedor = $2, es_autorretenedor = $3,
                  tarifa_provisional_por_mil = $4, fuente = $5
            WHERE id = $1`,
          [
            vigente.id,
            dto.esAgenteRetenedor,
            dto.esAutorretenedor,
            tarifa,
            fuente,
          ],
        );
      } else {
        if (vigente !== undefined) {
          await t.query(
            `UPDATE empresa_ica_municipio SET fecha_fin = $2::date - 1 WHERE id = $1`,
            [vigente.id, fecha],
          );
        }
        await t.query(
          `INSERT INTO empresa_ica_municipio
             (empresa_id, municipio_codigo, es_agente_retenedor, es_autorretenedor,
              tarifa_provisional_por_mil, fuente, fecha_inicio, creado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            ctx.empresaId,
            municipio,
            dto.esAgenteRetenedor,
            dto.esAutorretenedor,
            tarifa,
            fuente,
            fecha,
            ctx.usuarioId,
          ],
        );
      }
    });

    await this.sincronizarAgenteIca(ctx, fecha);
    return this.estado(ctx);
  }

  /** «Todo correcto»: el resumen se miró y se aceptó. */
  async confirmar(ctx: CtxEmpresa): Promise<EstadoImpuestos> {
    const estado = await this.estado(ctx);
    const iva = estado.preguntas.find((p) => p.clave === 'IVA');
    if (iva?.respuesta === null) {
      throw new BadRequestException('Falta contestar si la empresa cobra IVA.');
    }
    const sinIca = estado.municipios.filter((m) => m.respuesta === null);
    if (sinIca.length > 0) {
      throw new BadRequestException(
        `Falta contarme el ICA de ${sinIca.map((m) => m.nombre).join(', ')}.`,
      );
    }
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        'UPDATE empresa SET impuestos_confirmado_en = now() WHERE id = $1',
        [ctx.empresaId],
      ),
    );
    return this.estado(ctx);
  }

  // ---------------------------------------------------------------------------

  private async municipios(t: Tx, ctx: CtxEmpresa): Promise<MunicipioIca[]> {
    const sedes = await t.query<
      Array<{
        codigo: string;
        nombre: string;
        es_principal: boolean;
        es_agente_retenedor: boolean | null;
        es_autorretenedor: boolean | null;
        tarifa: string | null;
        fuente: 'MANUAL' | 'IA' | 'MIGRACION' | null;
        desde: string | null;
      }>
    >(
      `SELECT m.codigo, m.nombre, bool_or(s.es_principal) AS es_principal,
              i.es_agente_retenedor, i.es_autorretenedor,
              i.tarifa_provisional_por_mil AS tarifa, i.fuente,
              i.fecha_inicio::text AS desde
         FROM empresa_sede s
         JOIN municipio m ON m.codigo = s.municipio_codigo
         LEFT JOIN empresa_ica_municipio i
                ON i.empresa_id = s.empresa_id
               AND i.municipio_codigo = s.municipio_codigo
               AND i.fecha_fin IS NULL
        WHERE s.empresa_id = $1 AND s.activo
        GROUP BY m.codigo, m.nombre, i.id
        ORDER BY bool_or(s.es_principal) DESC, m.nombre`,
      [ctx.empresaId],
    );
    return sedes.map((f) => ({
      codigo: f.codigo,
      nombre: f.nombre,
      esPrincipal: f.es_principal,
      respuesta:
        f.es_agente_retenedor === null || f.fuente === null || f.desde === null
          ? null
          : {
              esAgenteRetenedor: f.es_agente_retenedor,
              esAutorretenedor: f.es_autorretenedor ?? false,
              tarifaProvisionalPorMil:
                f.tarifa === null ? null : Number(f.tarifa),
              fuente: f.fuente,
              desde: f.desde,
            },
    }));
  }

  private async sincronizarAgenteIca(
    ctx: CtxEmpresa,
    fecha: string,
  ): Promise<void> {
    const { agente, regimen } = await this.tx.enContexto(ctx, async (t) => {
      const [a] = await t.query<Array<{ algun: boolean }>>(
        `SELECT coalesce(bool_or(es_agente_retenedor), false) AS algun
           FROM empresa_ica_municipio
          WHERE empresa_id = $1 AND fecha_fin IS NULL`,
        [ctx.empresaId],
      );
      const [r] = await t.query<Array<{ id: string }>>(
        `SELECT id FROM empresa_regimen_tributario
          WHERE empresa_id = $1 AND tipo_regimen = 'AGENTE_RETENEDOR_ICA' AND fecha_fin IS NULL`,
        [ctx.empresaId],
      );
      return { agente: a?.algun ?? false, regimen: r?.id ?? null };
    });

    if (agente && regimen === null) {
      await this.legal.abrirRegimen(ctx, {
        tipoRegimen: 'AGENTE_RETENEDOR_ICA',
        fechaInicio: fecha,
      });
    } else if (!agente && regimen !== null) {
      await this.legal.cerrarRegimen(ctx, regimen, fecha);
    }
  }
}
