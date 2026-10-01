import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { hoyEnColombia } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  NuevaResidenciaDto,
  NuevoIcaTerceroDto,
  NuevoPerfilDto,
} from '../dto/retencion.dto';
import {
  aplicarCambios,
  cambiosDesdeFactura,
  huellaDe,
  type CambioPerfil,
  type CondicionLeida,
  type PerfilParaComparar,
} from '../reglas/propuesta-perfil.reglas';

export interface VersionPerfil {
  id: string;
  tipo_persona: 'NATURAL' | 'JURIDICA';
  regimen_renta: string;
  declarante_renta: boolean;
  es_responsable_iva: boolean;
  es_gran_contribuyente: boolean;
  es_autorretenedor_renta: boolean;
  es_agente_ret_iva: boolean;
  es_zomac: boolean;
  zomac_tamano: string | null;
  ciiu_principal: string | null;
  contrato_dos_o_mas_trabajadores: boolean;
  vigencia_desde: string;
  vigencia_hasta: string | null;
  fuente: string;
  aprobado_por_nombre: string | null;
  aprobado_en: string | null;
}

const CAMPOS = `p.id, p.tipo_persona, p.regimen_renta, p.declarante_renta, p.es_responsable_iva,
  p.es_gran_contribuyente, p.es_autorretenedor_renta, p.es_agente_ret_iva, p.es_zomac,
  p.zomac_tamano, p.ciiu_principal, p.contrato_dos_o_mas_trabajadores, p.vigencia_desde::text, p.vigencia_hasta::text, p.fuente,
  (SELECT u.nombre_completo FROM usuario u WHERE u.id = p.aprobado_por) AS aprobado_por_nombre,
  p.aprobado_en::text`;

// El día de la empresa, no el del servidor: en un servidor en UTC, a las 7 de
// la noche de Bogotá ya es mañana, y así se colaba una versión con fecha
// futura (bug #7 de la revisión del 27-09).
const hoy = hoyEnColombia;

/** Una versión del perfil, como la lee la aprobación de una propuesta. */
interface VersionParaHistoria {
  id: string;
  desde: string;
  hasta: string | null;
  regimen_renta: PerfilParaComparar['regimenRenta'];
  es_responsable_iva: boolean;
  es_gran_contribuyente: boolean;
  es_autorretenedor_renta: boolean;
  ciiu_principal: string | null;
}

const comparable = (v: VersionParaHistoria): PerfilParaComparar => ({
  regimenRenta: v.regimen_renta,
  esResponsableIva: v.es_responsable_iva,
  esGranContribuyente: v.es_gran_contribuyente,
  esAutorretenedorRenta: v.es_autorretenedor_renta,
  ciiuPrincipal: v.ciiu_principal,
});

/**
 * Los datos tributarios de un tercero, con historia (plan motor de
 * retenciones, Fase 1, §1.4). Un proveedor que pasa al SIMPLE en julio no
 * cambia las facturas de marzo: cada cambio es una versión con su fecha.
 *
 * Nada se edita hacia atrás. Una versión nueva cierra la anterior el día antes
 * de empezar; corregir la de hoy la corrige en el sitio. Las columnas de
 * `tercero` se actualizan con lo vigente hoy para que el resto del sistema lo
 * lea igual, sin que el trigger de la 0075 abra otra versión encima (0081).
 */
@Injectable()
export class PerfilTerceroService {
  constructor(private readonly tx: TxService) {}

  async historia(ctx: CtxEmpresa, terceroId: string): Promise<VersionPerfil[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<VersionPerfil>(
        await t.query(
          `SELECT ${CAMPOS} FROM tercero_perfil_tributario p
            WHERE p.tercero_id = $1 ORDER BY p.vigencia_desde DESC`,
          [terceroId],
        ),
      ),
    );
  }

  async nuevaVersion(
    ctx: CtxEmpresa,
    terceroId: string,
    dto: NuevoPerfilDto,
    /**
     * De dónde salió (`FACTURA`: una propuesta aprobada, §8.8) y la
     * transacción de quien la llama. Con `tx` no devuelve la historia.
     */
    opciones: { fuente?: 'MANUAL' | 'FACTURA'; tx?: Tx } = {},
  ): Promise<VersionPerfil[]> {
    const fuente = opciones.fuente ?? 'MANUAL';
    if (dto.esZomac && dto.zomacTamano === undefined) {
      throw new BadRequestException(
        'Si es ZOMAC, indique de qué tamaño: sin eso no hay factor.',
      );
    }
    if (dto.vigenciaDesde > hoy()) {
      throw new BadRequestException(
        'La versión no puede empezar en el futuro.',
      );
    }

    await this.tx.enContexto(
      ctx,
      async (t) => {
        const [tercero] = filas<{ tipo_persona: 'NATURAL' | 'JURIDICA' }>(
          await t.query(
            'SELECT tipo_persona FROM tercero WHERE id = $1 FOR UPDATE',
            [terceroId],
          ),
        );
        if (tercero === undefined)
          throw new NotFoundException('Tercero no encontrado.');

        const [vigente] = filas<{
          id: string;
          desde: string;
          automatica: boolean;
        }>(
          await t.query(
            `SELECT id, vigencia_desde::text AS desde,
                  aprobado_por IS NULL
                    AND NOT EXISTS (SELECT 1 FROM tercero_perfil_tributario o
                                     WHERE o.tercero_id = $1 AND o.vigencia_hasta IS NOT NULL)
                    AS automatica
             FROM tercero_perfil_tributario
            WHERE tercero_id = $1 AND vigencia_hasta IS NULL FOR UPDATE`,
            [terceroId],
          ),
        );
        // La primera versión la crea el sistema al dar de alta el tercero, con
        // la fecha de ese día: no es un hecho de nadie. Si una persona dice
        // desde cuándo rige de verdad —su RUT, su resolución—, la reemplaza.
        const reemplazaLaAutomatica =
          vigente !== undefined &&
          vigente.automatica &&
          dto.vigenciaDesde < vigente.desde;
        if (
          vigente !== undefined &&
          dto.vigenciaDesde < vigente.desde &&
          !reemplazaLaAutomatica
        ) {
          throw new ConflictException(
            `La versión vigente empieza el ${vigente.desde}. Una versión nueva no puede empezar antes: la historia no se reescribe.`,
          );
        }

        const valores = [
          tercero.tipo_persona,
          dto.regimenRenta,
          dto.declaranteRenta,
          dto.esResponsableIva,
          dto.esGranContribuyente,
          dto.esAutorretenedorRenta,
          dto.esAgenteRetIva ?? false,
          dto.esZomac ?? false,
          dto.esZomac ? (dto.zomacTamano ?? null) : null,
          dto.ciiuPrincipal ?? null,
          dto.contratoDosOMasTrabajadores ?? false,
        ];

        if (
          vigente !== undefined &&
          (vigente.desde === dto.vigenciaDesde || reemplazaLaAutomatica)
        ) {
          // El mismo día es corregir, no un cambio; y la automática se reemplaza.
          await t.query(
            `UPDATE tercero_perfil_tributario
              SET vigencia_desde = $14::date,
                  tipo_persona = $2, regimen_renta = $3, declarante_renta = $4,
                  es_responsable_iva = $5, es_gran_contribuyente = $6,
                  es_autorretenedor_renta = $7, es_agente_ret_iva = $8, es_zomac = $9,
                  zomac_tamano = $10, ciiu_principal = $11,
                  contrato_dos_o_mas_trabajadores = $12, fuente = $15,
                  aprobado_por = $13, aprobado_en = now()
            WHERE id = $1`,
            [vigente.id, ...valores, ctx.usuarioId, dto.vigenciaDesde, fuente],
          );
        } else {
          if (vigente !== undefined) {
            await t.query(
              `UPDATE tercero_perfil_tributario SET vigencia_hasta = $2::date - 1 WHERE id = $1`,
              [vigente.id, dto.vigenciaDesde],
            );
          }
          await t.query(
            `INSERT INTO tercero_perfil_tributario
             (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
              es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
              es_agente_ret_iva, es_zomac, zomac_tamano, ciiu_principal,
              contrato_dos_o_mas_trabajadores,
              vigencia_desde, fuente, propuesto_por, aprobado_por, aprobado_en,
              es_agente_ret_renta, es_entidad_publica, es_autorretenedor_especial,
              agente_iva_numeral, ciiu_secundarios)
           -- Lo que esta pantalla no pide se hereda de la versión anterior.
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$16,$15,$15,now(),
                  COALESCE(a.es_agente_ret_renta, false),
                  COALESCE(a.es_entidad_publica, false),
                  COALESCE(a.es_autorretenedor_especial, false),
                  a.agente_iva_numeral, a.ciiu_secundarios
             FROM (SELECT 1) uno
             LEFT JOIN tercero_perfil_tributario a ON a.id = $17`,
            [
              ctx.empresaId,
              terceroId,
              ...valores,
              dto.vigenciaDesde,
              ctx.usuarioId,
              fuente,
              vigente?.id ?? null,
            ],
          );
        }
      },
      opciones.tx,
    );

    return opciones.tx === undefined ? this.historia(ctx, terceroId) : [];
  }

  // --- ICA por municipio (Fase 3) -----------------------------------------

  /** El ICA del proveedor en cada municipio, con su historia. */
  async icaDeTercero(ctx: CtxEmpresa, terceroId: string) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT p.id, p.municipio_codigo, m.nombre AS municipio, p.ica_regimen,
                  p.es_agente_ret_ica, p.es_autorretenedor_ica, p.codigo_actividad_local,
                  p.resolucion, p.vigencia_desde::text, p.vigencia_hasta::text
             FROM tercero_perfil_ica p JOIN municipio m ON m.codigo = p.municipio_codigo
            WHERE p.tercero_id = $1
            ORDER BY m.nombre, p.vigencia_desde DESC`,
          [terceroId],
        ),
      ),
    );
  }

  /**
   * Una versión nueva del ICA del proveedor en un municipio. Como el perfil:
   * cierra la anterior el día antes, corrige la de hoy en el sitio, y nunca
   * reescribe hacia atrás.
   */
  async nuevoIcaTercero(
    ctx: CtxEmpresa,
    terceroId: string,
    dto: NuevoIcaTerceroDto,
  ) {
    if (dto.vigenciaDesde > hoy()) {
      throw new BadRequestException(
        'La versión no puede empezar en el futuro.',
      );
    }
    await this.tx.enContexto(ctx, async (t) => {
      const [vigente] = filas<{ id: string; desde: string }>(
        await t.query(
          `SELECT id, vigencia_desde::text AS desde FROM tercero_perfil_ica
            WHERE tercero_id = $1 AND municipio_codigo = $2 AND vigencia_hasta IS NULL
            FOR UPDATE`,
          [terceroId, dto.municipioCodigo],
        ),
      );
      if (vigente !== undefined && dto.vigenciaDesde < vigente.desde) {
        throw new ConflictException(
          `La versión vigente empieza el ${vigente.desde}. Una nueva no puede empezar antes.`,
        );
      }
      const valores = [
        dto.icaRegimen,
        dto.esAgenteRetIca ?? false,
        dto.esAutorretenedorIca,
        dto.codigoActividadLocal ?? null,
        dto.resolucion?.trim() || null,
      ];
      if (vigente !== undefined && vigente.desde === dto.vigenciaDesde) {
        await t.query(
          `UPDATE tercero_perfil_ica
              SET ica_regimen = $2, es_agente_ret_ica = $3, es_autorretenedor_ica = $4,
                  codigo_actividad_local = $5, resolucion = $6
            WHERE id = $1`,
          [vigente.id, ...valores],
        );
        return;
      }
      if (vigente !== undefined) {
        await t.query(
          'UPDATE tercero_perfil_ica SET vigencia_hasta = $2::date - 1 WHERE id = $1',
          [vigente.id, dto.vigenciaDesde],
        );
      }
      await t.query(
        `INSERT INTO tercero_perfil_ica
           (empresa_id, tercero_id, municipio_codigo, ica_regimen, es_agente_ret_ica,
            es_autorretenedor_ica, codigo_actividad_local, resolucion, vigencia_desde, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          ctx.empresaId,
          terceroId,
          dto.municipioCodigo,
          ...valores,
          dto.vigenciaDesde,
          ctx.usuarioId,
        ],
      );
    });
    return this.icaDeTercero(ctx, terceroId);
  }

  /**
   * El ICA de la empresa por municipio: dónde tiene sede, si es agente allí y
   * lo que dice la ley del municipio para el año (base, tarifa, si acumula).
   */
  async icaDeEmpresa(ctx: CtxEmpresa, anio: number) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT m.codigo, m.nombre,
                  bool_or(s.es_principal) AS es_principal,
                  i.es_agente_retenedor, i.es_autorretenedor,
                  p.base_minima_uvt_compras, p.base_minima_uvt_servicios,
                  p.tarifa_general_por_mil, p.usa_tarifa_por_actividad,
                  p.acumula_en_periodo, p.periodicidad, p.acuerdo,
                  (SELECT count(*)::int FROM ica_tarifa x
                    WHERE x.municipio_codigo = m.codigo AND x.anio = $2) AS tarifas_por_actividad
             FROM empresa_sede s
             JOIN municipio m ON m.codigo = s.municipio_codigo
             LEFT JOIN empresa_ica_municipio i
                    ON i.empresa_id = s.empresa_id AND i.municipio_codigo = m.codigo
                   AND i.fecha_fin IS NULL
             LEFT JOIN ica_parametro p ON p.municipio_codigo = m.codigo AND p.anio = $2
            WHERE s.empresa_id = $1 AND s.activo
            GROUP BY m.codigo, m.nombre, i.id, p.id
            ORDER BY bool_or(s.es_principal) DESC, m.nombre`,
          [ctx.empresaId, anio],
        ),
      ),
    );
  }

  // --- Lo que aprendí ------------------------------------------------------

  async aprendido(ctx: CtxEmpresa) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT m.id, m.llave_renglon, m.origen, m.veces, m.actualizado_en::text,
                  n.codigo AS concepto, n.nombre AS concepto_nombre,
                  coalesce(nullif(te.razon_social, ''), concat_ws(' ', te.primer_nombre, te.primer_apellido)) AS proveedor,
                  (SELECT p.nombre FROM producto p WHERE p.id = m.producto_id) AS producto,
                  (SELECT u.nombre_completo FROM usuario u WHERE u.id = m.confirmado_por) AS confirmado_por
             FROM retencion_mapeo_concepto m
             JOIN retencion_concepto_nacional n ON n.id = m.concepto_nacional_id
             LEFT JOIN tercero te ON te.id = m.tercero_id
            WHERE m.activo
            ORDER BY m.actualizado_en DESC
            LIMIT 500`,
        ),
      ),
    );
  }

  /** Quitar lo aprendido: la próxima vez se vuelve a deducir o a preguntar. */
  async quitarAprendido(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const quitadas = filas<{ id: string }>(
        await t.query(
          `UPDATE retencion_mapeo_concepto SET activo = false, actualizado_en = now()
            WHERE id = $1 AND activo RETURNING id`,
          [id],
        ),
      );
      if (quitadas.length === 0)
        throw new NotFoundException('Eso ya no está aprendido.');
    });
  }

  // --- Residencia fiscal del exterior (Fase 8, §8.15) ----------------------

  /**
   * Si el tercero es del exterior, sus certificados de residencia fiscal y los
   * países con convenio que el sistema conoce.
   */
  async residencia(ctx: CtxEmpresa, terceroId: string) {
    return this.tx.enContexto(ctx, async (t) => {
      const [tercero] = filas<{ tipo_documento: string }>(
        await t.query('SELECT tipo_documento FROM tercero WHERE id = $1', [
          terceroId,
        ]),
      );
      if (tercero === undefined)
        throw new NotFoundException('Tercero no encontrado.');
      const residencias = filas<Record<string, unknown>>(
        await t.query(
          `SELECT r.id, r.pais_codigo AS "paisCodigo",
                  (SELECT c.pais_nombre FROM cdi_tarifa c WHERE c.pais_codigo = r.pais_codigo LIMIT 1) AS "paisNombre",
                  r.certificado_desde::text AS "certificadoDesde",
                  r.certificado_hasta::text AS "certificadoHasta", r.observacion
             FROM tercero_residencia_fiscal r
            WHERE r.tercero_id = $1
            ORDER BY r.certificado_hasta DESC`,
          [terceroId],
        ),
      );
      const paises = filas<{ codigo: string; nombre: string }>(
        await t.query(
          `SELECT DISTINCT pais_codigo AS codigo, pais_nombre AS nombre
             FROM cdi_tarifa ORDER BY pais_nombre`,
        ),
      );
      return {
        exterior: ['NIT_EXTRANJERO', 'DOC_EXTRANJERO'].includes(
          tercero.tipo_documento,
        ),
        residencias,
        paises,
      };
    });
  }

  async nuevaResidencia(
    ctx: CtxEmpresa,
    terceroId: string,
    dto: NuevaResidenciaDto,
  ) {
    if (dto.certificadoHasta < dto.certificadoDesde) {
      throw new BadRequestException('El certificado termina antes de empezar.');
    }
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `INSERT INTO tercero_residencia_fiscal
           (empresa_id, tercero_id, pais_codigo, certificado_desde, certificado_hasta,
            observacion, creado_por)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ctx.empresaId,
          terceroId,
          dto.paisCodigo,
          dto.certificadoDesde,
          dto.certificadoHasta,
          dto.observacion?.trim() || null,
          ctx.usuarioId,
        ],
      ),
    );
    return this.residencia(ctx, terceroId);
  }

  // --- Propuestas desde la factura (Fase 8, §8.8) --------------------------

  /** El perfil vigente, como lo compara la regla y lo recibe nuevaVersion. */
  private async vigenteParaProponer(t: Tx, terceroId: string) {
    const [v] = filas<{
      regimen_renta: PerfilParaComparar['regimenRenta'];
      declarante_renta: boolean;
      es_responsable_iva: boolean;
      es_gran_contribuyente: boolean;
      es_autorretenedor_renta: boolean;
      es_agente_ret_iva: boolean;
      es_zomac: boolean;
      zomac_tamano: NuevoPerfilDto['zomacTamano'] | null;
      ciiu_principal: string | null;
      contrato_dos_o_mas_trabajadores: boolean;
      desde: string;
      /** La que puso el sistema al crear el tercero: no es un hecho de nadie. */
      automatica: boolean;
    }>(
      await t.query(
        `SELECT regimen_renta, declarante_renta, es_responsable_iva, es_gran_contribuyente,
                es_autorretenedor_renta, es_agente_ret_iva, es_zomac, zomac_tamano,
                ciiu_principal, contrato_dos_o_mas_trabajadores, vigencia_desde::text AS desde,
                aprobado_por IS NULL
                  AND NOT EXISTS (SELECT 1 FROM tercero_perfil_tributario o
                                   WHERE o.tercero_id = $1 AND o.vigencia_hasta IS NOT NULL)
                  AS automatica
           FROM tercero_perfil_tributario
          WHERE tercero_id = $1 AND vigencia_hasta IS NULL`,
        [terceroId],
      ),
    );
    return v;
  }

  /**
   * Lo que la factura dice del proveedor y no coincide con su perfil queda
   * como propuesta. No cambia nada; lo mismo no se propone dos veces —ni
   * pendiente ni ya rechazado—. Devuelve cuántas quedaron (0 o 1).
   */
  async proponerDesdeFactura(
    ctx: CtxEmpresa,
    datos: {
      terceroId: string;
      documentoLeidoId: string | null;
      /** El número de la factura, para que la persona sepa de dónde salió. */
      referencia: string | null;
      fecha: string;
      leido: CondicionLeida;
    },
    tx?: Tx,
  ): Promise<number> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const v = await this.vigenteParaProponer(t, datos.terceroId);
        if (v === undefined) return 0;
        const cambios = cambiosDesdeFactura(
          {
            regimenRenta: v.regimen_renta,
            esResponsableIva: v.es_responsable_iva,
            esGranContribuyente: v.es_gran_contribuyente,
            esAutorretenedorRenta: v.es_autorretenedor_renta,
            ciiuPrincipal: v.ciiu_principal,
          },
          datos.leido,
        );
        if (cambios.length === 0) return 0;
        const creadas = filas<{ id: string }>(
          await t.query(
            `INSERT INTO tercero_perfil_propuesta
             (empresa_id, tercero_id, documento_leido_id, referencia, desde, cambios, huella)
           VALUES ($1, $2, $3, $7, $4, $5, $6)
           ON CONFLICT (empresa_id, tercero_id, huella)
             WHERE estado IN ('PENDIENTE', 'RECHAZADA')
           DO NOTHING
           RETURNING id`,
            [
              ctx.empresaId,
              datos.terceroId,
              datos.documentoLeidoId,
              datos.fecha,
              JSON.stringify(cambios),
              huellaDe(cambios),
              datos.referencia,
            ],
          ),
        );
        return creadas.length;
      },
      tx,
    );
  }

  /** Las propuestas pendientes; de un tercero, o de todos. */
  async propuestas(ctx: CtxEmpresa, terceroId?: string) {
    return this.tx.enContexto(ctx, async (t) =>
      filas<Record<string, unknown>>(
        await t.query(
          `SELECT p.id, p.tercero_id AS "terceroId", p.desde::text AS desde,
                  p.cambios, p.creado_en AS "creadoEn",
                  COALESCE(nullif(btrim(te.razon_social), ''),
                           btrim(concat_ws(' ', te.primer_nombre, te.primer_apellido))) AS tercero,
                  p.referencia
             FROM tercero_perfil_propuesta p
             JOIN tercero te ON te.id = p.tercero_id
            WHERE p.estado = 'PENDIENTE'
              AND ($1::uuid IS NULL OR p.tercero_id = $1)
            ORDER BY p.creado_en`,
          [terceroId ?? null],
        ),
      ),
    );
  }

  /**
   * Una persona aprueba (R-D8): se abre la versión nueva del perfil desde la
   * fecha de la factura, por el mismo camino que un cambio a mano.
   *
   * Si la versión vigente empieza el mismo día de la factura o después, la
   * factura habla de antes: su versión entra en la historia, en su fecha, y
   * la vigente queda como está (bug #5 de la revisión del 27-09: antes se
   * corregía la vigente en el sitio y se perdía lo que decía). La única
   * excepción es la versión automática del alta, que no es un hecho de nadie
   * y se reemplaza, como en `nuevaVersion`.
   */
  async aprobarPropuesta(ctx: CtxEmpresa, id: string, tx?: Tx): Promise<void> {
    await this.tx.enContexto(
      ctx,
      async (t) => {
        const p = await this.propuestaPendiente(t, id);
        const v = await this.vigenteParaProponer(t, p.tercero_id);
        if (v === undefined) {
          throw new NotFoundException('El tercero no tiene perfil tributario.');
        }
        if (p.desde <= v.desde && !v.automatica) {
          await this.versionEnLaHistoria(
            t,
            ctx,
            p.tercero_id,
            p.desde,
            p.cambios,
          );
          await this.marcarAprobada(t, ctx, id);
          return;
        }
        const nuevo = aplicarCambios(
          {
            regimenRenta: v.regimen_renta,
            esResponsableIva: v.es_responsable_iva,
            esGranContribuyente: v.es_gran_contribuyente,
            esAutorretenedorRenta: v.es_autorretenedor_renta,
            ciiuPrincipal: v.ciiu_principal,
          },
          p.cambios,
        );
        await this.nuevaVersion(
          ctx,
          p.tercero_id,
          {
            ...nuevo,
            ciiuPrincipal: nuevo.ciiuPrincipal ?? undefined,
            declaranteRenta: v.declarante_renta,
            esAgenteRetIva: v.es_agente_ret_iva,
            esZomac: v.es_zomac,
            zomacTamano: v.zomac_tamano ?? undefined,
            contratoDosOMasTrabajadores: v.contrato_dos_o_mas_trabajadores,
            // Después de la vigente, o reemplazando la automática del alta.
            vigenciaDesde: p.desde,
          },
          { fuente: 'FACTURA', tx: t },
        );
        await this.marcarAprobada(t, ctx, id);
      },
      tx,
    );
  }

  private async marcarAprobada(t: Tx, ctx: CtxEmpresa, id: string) {
    await t.query(
      `UPDATE tercero_perfil_propuesta
          SET estado = 'APROBADA', resuelta_por = $2, resuelta_en = now()
        WHERE id = $1`,
      [id, ctx.usuarioId],
    );
  }

  /**
   * La versión de una factura anterior a la vigente entra en la historia, en
   * su fecha: parte la versión que regía ese día y dura hasta que empieza la
   * siguiente. Ninguna versión cambia lo que dice; la que regía ese día solo
   * se cierra el día antes, como cuando se abre cualquier versión.
   *
   * Si ya hay una versión que empieza ese mismo día, no se pisa: una persona
   * dijo qué regía desde entonces, y cambiarla es cosa de Datos tributarios.
   */
  private async versionEnLaHistoria(
    t: Tx,
    ctx: CtxEmpresa,
    terceroId: string,
    fecha: string,
    cambios: CambioPerfil[],
  ): Promise<void> {
    const versiones = filas<VersionParaHistoria>(
      await t.query(
        `SELECT id, vigencia_desde::text AS desde, vigencia_hasta::text AS hasta,
                regimen_renta, es_responsable_iva, es_gran_contribuyente,
                es_autorretenedor_renta, ciiu_principal
           FROM tercero_perfil_tributario
          WHERE tercero_id = $1
          ORDER BY vigencia_desde
          FOR UPDATE`,
        [terceroId],
      ),
    );
    if (versiones.some((x) => x.desde === fecha)) {
      throw new ConflictException(
        `Ya hay una versión del perfil que empieza el ${fecha}. La propuesta no la reemplaza: si hay que cambiarla, hágalo en Datos tributarios, o rechace la propuesta.`,
      );
    }
    const anterior = [...versiones].reverse().find((x) => x.desde < fecha);
    const siguiente = versiones.find((x) => x.desde > fecha);
    const base = anterior ?? siguiente;
    if (base === undefined || siguiente === undefined) {
      // Sin una versión posterior no se llega acá: la vigente empieza después.
      throw new NotFoundException('El tercero no tiene perfil tributario.');
    }

    const antes = comparable(base);
    const nuevo = aplicarCambios(antes, cambios);
    const campos = Object.keys(antes) as Array<keyof PerfilParaComparar>;
    // Si ese día ya regía lo que dice la factura, no hay nada que insertar.
    if (campos.every((k) => antes[k] === nuevo[k])) {
      return;
    }

    if (
      anterior !== undefined &&
      (anterior.hasta === null || anterior.hasta >= fecha)
    ) {
      await t.query(
        `UPDATE tercero_perfil_tributario SET vigencia_hasta = $2::date - 1 WHERE id = $1`,
        [anterior.id, fecha],
      );
    }
    await t.query(
      `INSERT INTO tercero_perfil_tributario
         (empresa_id, tercero_id, tipo_persona, regimen_renta, declarante_renta,
          es_responsable_iva, es_gran_contribuyente, es_autorretenedor_renta,
          es_entidad_publica, es_agente_ret_renta, es_autorretenedor_especial,
          es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
          ciiu_principal, ciiu_secundarios, contrato_dos_o_mas_trabajadores,
          vigencia_desde, vigencia_hasta, fuente, propuesto_por, aprobado_por, aprobado_en)
       SELECT empresa_id, tercero_id, tipo_persona, $2, declarante_renta,
              $3, $4, $5,
              es_entidad_publica, es_agente_ret_renta, es_autorretenedor_especial,
              es_agente_ret_iva, agente_iva_numeral, es_zomac, zomac_tamano,
              $6, ciiu_secundarios, contrato_dos_o_mas_trabajadores,
              $7::date, $8::date - 1, 'FACTURA', $9, $9, now()
         FROM tercero_perfil_tributario WHERE id = $1`,
      [
        base.id,
        nuevo.regimenRenta,
        nuevo.esResponsableIva,
        nuevo.esGranContribuyente,
        nuevo.esAutorretenedorRenta,
        nuevo.ciiuPrincipal,
        fecha,
        siguiente.desde,
        ctx.usuarioId,
      ],
    );
  }

  async rechazarPropuesta(
    ctx: CtxEmpresa,
    id: string,
    motivo: string,
    tx?: Tx,
  ): Promise<void> {
    const limpio = motivo.trim();
    if (limpio.length === 0) {
      throw new BadRequestException('Indique por qué no se cambia.');
    }
    await this.tx.enContexto(
      ctx,
      async (t) => {
        await this.propuestaPendiente(t, id);
        await t.query(
          `UPDATE tercero_perfil_propuesta
            SET estado = 'RECHAZADA', motivo = $2, resuelta_por = $3, resuelta_en = now()
          WHERE id = $1`,
          [id, limpio, ctx.usuarioId],
        );
      },
      tx,
    );
  }

  private async propuestaPendiente(t: Tx, id: string) {
    const [p] = filas<{
      tercero_id: string;
      desde: string;
      cambios: CambioPerfil[];
      estado: string;
    }>(
      await t.query(
        `SELECT tercero_id, desde::text AS desde, cambios, estado
           FROM tercero_perfil_propuesta WHERE id = $1 FOR UPDATE`,
        [id],
      ),
    );
    if (p === undefined)
      throw new NotFoundException('Propuesta no encontrada.');
    if (p.estado !== 'PENDIENTE') {
      throw new ConflictException('Esta propuesta ya se resolvió.');
    }
    return p;
  }
}
