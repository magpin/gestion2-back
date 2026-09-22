import { Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  calcularEstado,
  type EstadoConfiguracion,
  type HechosConfiguracion,
} from './estado-configuracion.reglas';

/**
 * Recoge de la base los hechos que deciden si la empresa está lista para operar.
 *
 * Todo en una transacción y una sola vuelta: es la consulta que el asistente hace
 * en cada paso, así que se paga cara si se hace mal. Interpretar los hechos es de
 * `estado-configuracion.reglas`, no de acá.
 */
@Injectable()
export class EstadoConfiguracionService {
  constructor(private readonly tx: TxService) {}

  async estado(ctx: CtxEmpresa, tx?: Tx): Promise<EstadoConfiguracion> {
    return this.tx.enContexto(
      ctx,
      async (t) => calcularEstado(await this.hechos(t, ctx.empresaId)),
      tx,
    );
  }

  /**
   * El mismo cálculo sobre una conexión que ya puede leer la empresa sin
   * contexto: la de aprovisionamiento, con la que la consola de plataforma ve
   * el avance de muchas empresas. Es la misma regla, no una copia.
   */
  async estadoCon(t: Tx, empresaId: string): Promise<EstadoConfiguracion> {
    return calcularEstado(await this.hechos(t, empresaId));
  }

  private async hechos(t: Tx, empresaId: string): Promise<HechosConfiguracion> {
    const [fila] = await t.query<Array<Record<string, unknown>>>(
      `SELECT
         e.razon_social,
         e.tipo_persona,
         COALESCE((SELECT array_agg(sec.sector ORDER BY sec.sector)
                     FROM empresa_sector sec WHERE sec.empresa_id = e.id),
                  ARRAY[]::text[])                                     AS sectores,
         COALESCE((SELECT array_agg(DISTINCT d.seccion_codigo)
                     FROM empresa_actividad_economica a
                     JOIN ciiu_clase    c ON c.codigo = a.codigo_ciiu
                     JOIN ciiu_grupo    g ON g.codigo = c.grupo_codigo
                     JOIN ciiu_division d ON d.codigo = g.division_codigo
                    WHERE a.empresa_id = e.id AND a.fecha_fin IS NULL),
                  ARRAY[]::text[])                                     AS secciones_actividades,

         cc.grupo_niif,
         cc.moneda_funcional,

         (SELECT count(*)::int FROM empresa_cuenta ec
           WHERE ec.empresa_id = e.id AND ec.activa)                   AS plan_cuentas,
         (SELECT count(*)::int FROM empresa_cuenta ec
           WHERE ec.empresa_id = e.id AND ec.activa AND ec.es_auxiliar) AS plan_auxiliares,

         (SELECT count(*)::int FROM empresa_sede s
           WHERE s.empresa_id = e.id AND s.activo)                     AS sedes_activas,
         (SELECT count(*)::int > 0 FROM empresa_sede s
           WHERE s.empresa_id = e.id AND s.activo AND s.es_principal)  AS sede_principal,
         (SELECT m.nombre FROM empresa_sede s
            JOIN municipio m ON m.codigo = s.municipio_codigo
           WHERE s.empresa_id = e.id AND s.activo AND s.es_principal
           LIMIT 1)                                                    AS municipio_principal,

         COALESCE((SELECT array_agg(rt.tipo_regimen ORDER BY rt.tipo_regimen)
                     FROM empresa_regimen_tributario rt
                    WHERE rt.empresa_id = e.id AND rt.fecha_fin IS NULL),
                  ARRAY[]::text[])                                     AS regimenes_vigentes,

         (SELECT rp.nombre_completo FROM empresa_representante rp
           WHERE rp.empresa_id = e.id AND rp.fecha_fin IS NULL
             AND rp.tipo_representante = 'PRINCIPAL'
           LIMIT 1)                                                    AS representante,

         (SELECT a.codigo_ciiu FROM empresa_actividad_economica a
           WHERE a.empresa_id = e.id AND a.fecha_fin IS NULL AND a.es_principal
           LIMIT 1)                                                    AS ciiu,
         (SELECT a.tarifa_ica_por_mil FROM empresa_actividad_economica a
           WHERE a.empresa_id = e.id AND a.fecha_fin IS NULL AND a.es_principal
           LIMIT 1)                                                    AS tarifa_ica,

         (SELECT count(*)::int > 0 FROM empresa_matricula_mercantil mm
           WHERE mm.empresa_id = e.id AND mm.fecha_fin IS NULL)        AS matricula,

         (SELECT count(*)::int > 0 FROM empresa_credencial_dian cd
           WHERE cd.empresa_id = e.id
             AND cd.software_id_enc IS NOT NULL)                       AS credenciales

       FROM empresa e
       LEFT JOIN empresa_configuracion_contable cc ON cc.empresa_id = e.id
       WHERE e.id = $1`,
      [empresaId],
    );

    // La resolución va aparte: necesita comparar contra la fecha de hoy y su
    // propio rango, y meterla en la consulta de arriba la volvía ilegible.
    const [res] = await t.query<
      Array<{
        numero_resolucion: string;
        vigente: boolean;
        agotada: boolean;
        numeros_restantes: string;
      }>
    >(
      `SELECT numero_resolucion,
              (CURRENT_DATE BETWEEN fecha_vigencia_desde AND fecha_vigencia_hasta) AS vigente,
              (consecutivo_actual >= rango_hasta)                                  AS agotada,
              (rango_hasta - consecutivo_actual)                                   AS numeros_restantes
         FROM empresa_resolucion_dian
        WHERE empresa_id = $1 AND tipo_documento = 'FACTURA_VENTA' AND activa
        LIMIT 1`,
      [empresaId],
    );

    return {
      empresa: {
        razonSocial: fila.razon_social as string,
        tipoPersona: fila.tipo_persona as 'JURIDICA' | 'NATURAL',
        sectores: (fila.sectores as string[] | null) ?? [],
        seccionesActividades:
          (fila.secciones_actividades as string[] | null) ?? [],
      },
      configuracionContable:
        fila.grupo_niif === null || fila.grupo_niif === undefined
          ? null
          : {
              grupoNiif: fila.grupo_niif as string,
              monedaFuncional: fila.moneda_funcional as string,
            },
      sedes: {
        activas: fila.sedes_activas as number,
        tienePrincipal: fila.sede_principal as boolean,
        municipioPrincipal: (fila.municipio_principal as string | null) ?? null,
      },
      regimenesVigentes: (fila.regimenes_vigentes as string[]) ?? [],
      representanteVigente: (fila.representante as string | null) ?? null,
      actividadPrincipal:
        fila.ciiu === null || fila.ciiu === undefined
          ? null
          : {
              codigoCiiu: fila.ciiu as string,
              // numeric llega como texto: convertirlo acá evita que las reglas
              // tengan que saber de qué tipo viene cada columna.
              tarifaIcaPorMil:
                fila.tarifa_ica === null ? null : Number(fila.tarifa_ica),
            },
      matriculaVigente: fila.matricula as boolean,
      resolucionFacturaVenta:
        res === undefined
          ? null
          : {
              numeroResolucion: res.numero_resolucion,
              vigente: res.vigente,
              agotada: res.agotada,
              numerosRestantes: Number(res.numeros_restantes),
            },
      credencialesDianCargadas: fila.credenciales as boolean,
      plan: {
        cuentasActivas: fila.plan_cuentas as number,
        auxiliares: fila.plan_auxiliares as number,
      },
    };
  }
}
