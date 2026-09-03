import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa, TipoRegimen } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  CONDICION_OPUESTA,
  codigosQueSostienen,
  condicionDe,
} from './responsabilidades-rut';
import {
  exigirTipoDocumento,
  nombreCiiuOficial,
} from './validaciones-catalogo';
import type {
  AbrirActividadDto,
  AbrirResponsabilidadRutDto,
  AbrirMatriculaDto,
  AbrirRegimenDto,
  AbrirRepresentanteDto,
  EditarConfiguracionContableDto,
  GuardarHechosOperativosDto,
} from '../dto/empresa-legal.dto';

/**
 * Las condiciones legales de la empresa que cambian en el tiempo.
 *
 * Ninguna de estas filas se edita. Cuando la condición cambia, se cierra la
 * vigente con `fecha_fin` y se abre otra. La DIAN puede exigir demostrar cuál
 * era la condición vigente en una fecha pasada, y una fila sobrescrita ya no
 * puede responder esa pregunta.
 *
 * El cierre automático de la anterior usa `fecha_inicio - 1 dia`: dos condiciones
 * del mismo tipo no pueden estar vigentes el mismo día.
 */
@Injectable()
export class EmpresaLegalService {
  constructor(private readonly tx: TxService) {}

  // ---------------------------------------------------------------------------
  // Actividad económica (CIIU) — define la tarifa de ICA
  // ---------------------------------------------------------------------------

  async abrirActividad(
    ctx: CtxEmpresa,
    dto: AbrirActividadDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      if (dto.esPrincipal === true) {
        await this.cerrarAnterior(
          t,
          `UPDATE empresa_actividad_economica SET fecha_fin = $2::date - 1
            WHERE empresa_id = $1 AND es_principal AND fecha_fin IS NULL`,
          [ctx.empresaId, dto.fechaInicio],
        );
      }
      // El nombre oficial se copia del catalogo y se congela acá. Si el usuario
      // mandó descripción propia, esa gana: hay RUT que traen un texto distinto
      // del catálogo y el documento manda sobre el catálogo.
      const descripcion =
        dto.descripcion ?? (await nombreCiiuOficial(t, dto.codigoCiiu));

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_actividad_economica
           (empresa_id, codigo_ciiu, descripcion, es_principal, tarifa_ica_por_mil, municipio_codigo, fecha_inicio)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          ctx.empresaId,
          dto.codigoCiiu,
          descripcion,
          dto.esPrincipal ?? false,
          dto.tarifaIcaPorMil ?? null,
          dto.municipioCodigo ?? null,
          dto.fechaInicio,
        ],
      );
      return fila;
    });
  }

  async listarActividades(
    ctx: CtxEmpresa,
    soloVigentes: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT a.*, m.nombre AS municipio_nombre
           FROM empresa_actividad_economica a
           LEFT JOIN municipio m ON m.codigo = a.municipio_codigo
          WHERE ($1 = false OR a.fecha_fin IS NULL)
          ORDER BY a.es_principal DESC, a.fecha_inicio DESC`,
        [soloVigentes],
      ),
    );
  }

  async cerrarActividad(
    ctx: CtxEmpresa,
    id: string,
    fechaFin: string,
  ): Promise<void> {
    await this.cerrarFila(ctx, 'empresa_actividad_economica', id, fechaFin);
  }

  // ---------------------------------------------------------------------------
  // Responsabilidades del RUT (casilla 53)
  // ---------------------------------------------------------------------------
  // `empresa_regimen_tributario` guarda la condición en el vocabulario del
  // software ('RESPONSABLE_IVA'); esto guarda el RUT literal, con los códigos que
  // imprime la DIAN. Las dos hacen falta: una la lee el motor de impuestos, la
  // otra responde un requerimiento que pregunta qué decía el RUT en una fecha.

  async abrirResponsabilidadRut(
    ctx: CtxEmpresa,
    dto: AbrirResponsabilidadRutDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.cerrarAnterior(
        t,
        `UPDATE empresa_responsabilidad_rut SET fecha_fin = $3::date - 1
          WHERE empresa_id = $1 AND codigo = $2 AND fecha_fin IS NULL`,
        [ctx.empresaId, dto.codigo, dto.fechaInicio],
      );

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_responsabilidad_rut (empresa_id, codigo, fecha_inicio)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [ctx.empresaId, dto.codigo, dto.fechaInicio],
      );

      await this.derivarCondicion(t, ctx, dto.codigo, dto.fechaInicio);
      return fila;
    });
  }

  /**
   * Abre la condición tributaria que se desprende del código del RUT.
   *
   * La casilla 53 es lo único que se captura; la condición se deduce. Pedir las
   * dos a mano era pedir dos veces el mismo dato, y dejaba abierta la puerta a
   * que se contradijeran — una empresa marcada responsable de IVA en una tabla y
   * no responsable en la otra no tiene forma de facturarse bien.
   *
   * Si la condición ya está vigente no se toca: dos códigos del RUT pueden
   * sostener la misma —el 9 y el 23 son los dos agente de retención de IVA— y
   * reabrirla rompería el índice de "una sola vigente".
   */
  private async derivarCondicion(
    t: Tx,
    ctx: CtxEmpresa,
    codigo: number,
    fechaInicio: string,
  ): Promise<void> {
    // Un RUT viejo trae el 11 donde hoy la DIAN escribe el 48. El catálogo sabe
    // cuál lo reemplazó, así que la condición se deriva del vigente: si no, una
    // empresa migrada con el código suprimido se quedaría sin cuentas de IVA.
    const [reemplazo] = await t.query<Array<{ codigo: number }>>(
      `SELECT COALESCE(codigo_reemplazo, codigo) AS codigo
         FROM responsabilidad_tributaria WHERE codigo = $1`,
      [codigo],
    );

    const condicion = condicionDe(reemplazo?.codigo ?? codigo);
    if (condicion === null) return;

    const [vigente] = await t.query<Array<{ id: string }>>(
      `SELECT id FROM empresa_regimen_tributario
        WHERE empresa_id = $1 AND tipo_regimen = $2 AND fecha_fin IS NULL`,
      [ctx.empresaId, condicion],
    );
    if (vigente !== undefined) return;

    // Abrir "responsable de IVA" cierra "no responsable", y al revés. Dejar las
    // dos abiertas obligaría al motor a elegir cuál vale, y una empresa marcada
    // de las dos formas no tiene manera de facturarse bien.
    const opuesta = CONDICION_OPUESTA[condicion];
    if (opuesta !== undefined) {
      await t.query(
        `UPDATE empresa_regimen_tributario SET fecha_fin = $3::date - 1
          WHERE empresa_id = $1 AND tipo_regimen = $2 AND fecha_fin IS NULL`,
        [ctx.empresaId, opuesta, fechaInicio],
      );
    }

    // El codigo de facturacion electronica sale del catalogo y no de una lista
    // escrita a mano: de las 48 responsabilidades solo seis viajan en el XML, y
    // cual es cual lo dice `responsabilidad_fiscal_fe`.
    await t.query(
      `INSERT INTO empresa_regimen_tributario
         (empresa_id, tipo_regimen, codigo_responsabilidad_dian, fecha_inicio)
       VALUES ($1, $2, (SELECT codigo FROM responsabilidad_fiscal_fe WHERE codigo_rut = $3), $4)`,
      [ctx.empresaId, condicion, codigo, fechaInicio],
    );
  }

  async listarResponsabilidadesRut(
    ctx: CtxEmpresa,
    soloVigentes: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        // El reemplazo viaja con nombre y todo: un codigo suprimido en pantalla se
        // lee como una responsabilidad cualquiera, y el motor en cambio lo trata
        // como el vigente que lo sustituyo. Sin decirlo, el plan de cuentas
        // propone IVA a quien juraria no haberlo declarado.
        `SELECT r.*, rt.descripcion, rt.vigente AS codigo_vigente, fe.codigo AS codigo_dian_fe,
                rt.codigo_reemplazo, re.descripcion AS descripcion_reemplazo
           FROM empresa_responsabilidad_rut r
           JOIN responsabilidad_tributaria rt ON rt.codigo = r.codigo
           LEFT JOIN responsabilidad_tributaria re ON re.codigo = rt.codigo_reemplazo
           LEFT JOIN responsabilidad_fiscal_fe fe ON fe.codigo_rut = r.codigo
          WHERE ($1 = false OR r.fecha_fin IS NULL)
          ORDER BY r.fecha_inicio DESC, r.codigo`,
        [soloVigentes],
      ),
    );
  }

  /**
   * Cierra la responsabilidad y, con ella, la condicion que sostenia — pero solo
   * si ningun otro codigo vigente la sigue sosteniendo. Quitar el 9 cuando el 23
   * sigue abierto no deja de hacer a la empresa agente de retencion de IVA.
   */
  async cerrarResponsabilidadRut(
    ctx: CtxEmpresa,
    id: string,
    fechaFin: string,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<{ codigo: number }>>(
        `UPDATE empresa_responsabilidad_rut SET fecha_fin = $2
          WHERE id = $1 AND fecha_fin IS NULL
         RETURNING codigo`,
        [id, fechaFin],
      );
      if (fila === undefined) {
        throw new NotFoundException(
          'La responsabilidad no existe o ya estaba cerrada',
        );
      }

      const [reemplazo] = await t.query<Array<{ codigo: number }>>(
        `SELECT COALESCE(codigo_reemplazo, codigo) AS codigo
           FROM responsabilidad_tributaria WHERE codigo = $1`,
        [fila.codigo],
      );

      const condicion = condicionDe(reemplazo?.codigo ?? fila.codigo);
      if (condicion === null) return;

      // Los suprimidos cuentan como el vigente que los reemplazó: si queda
      // abierto el 11, la empresa sigue siendo responsable de IVA.
      const sostienen = codigosQueSostienen(condicion);
      const [otro] = await t.query<Array<{ codigo: number }>>(
        `SELECT r.codigo FROM empresa_responsabilidad_rut r
           JOIN responsabilidad_tributaria c ON c.codigo = r.codigo
          WHERE r.empresa_id = $1 AND r.fecha_fin IS NULL
            AND COALESCE(c.codigo_reemplazo, c.codigo) = ANY($2)`,
        [ctx.empresaId, sostienen],
      );
      if (otro !== undefined) return;

      await t.query(
        `UPDATE empresa_regimen_tributario SET fecha_fin = $3
          WHERE empresa_id = $1 AND tipo_regimen = $2 AND fecha_fin IS NULL`,
        [ctx.empresaId, condicion, fechaFin],
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Régimen tributario
  // ---------------------------------------------------------------------------

  async abrirRegimen(
    ctx: CtxEmpresa,
    dto: AbrirRegimenDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      // El indice unico parcial rechaza dos vigentes del mismo tipo. Cerrar la
      // anterior acá evita que el cliente tenga que hacer dos llamadas para algo
      // que es un solo hecho: la condicion cambio tal dia.
      await this.cerrarAnterior(
        t,
        `UPDATE empresa_regimen_tributario SET fecha_fin = $3::date - 1
          WHERE empresa_id = $1 AND tipo_regimen = $2 AND fecha_fin IS NULL`,
        [ctx.empresaId, dto.tipoRegimen, dto.fechaInicio],
      );

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_regimen_tributario
           (empresa_id, tipo_regimen, codigo_responsabilidad_dian, acto_administrativo, fecha_inicio)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          ctx.empresaId,
          dto.tipoRegimen,
          dto.codigoResponsabilidadDian ?? null,
          dto.actoAdministrativo ?? null,
          dto.fechaInicio,
        ],
      );
      return fila;
    });
  }

  async listarRegimenes(
    ctx: CtxEmpresa,
    soloVigentes: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT * FROM empresa_regimen_tributario
          WHERE ($1 = false OR fecha_fin IS NULL)
          ORDER BY fecha_inicio DESC, tipo_regimen`,
        [soloVigentes],
      ),
    );
  }

  async cerrarRegimen(
    ctx: CtxEmpresa,
    id: string,
    fechaFin: string,
  ): Promise<void> {
    await this.cerrarFila(ctx, 'empresa_regimen_tributario', id, fechaFin);
  }

  /**
   * Las condiciones vigentes a una fecha. Es lo que consulta el resto del sistema:
   * si una venta lleva IVA o no depende de esto, y una factura de hace tres meses
   * tiene que responderse con la condición de hace tres meses.
   */
  async regimenVigente(
    ctx: CtxEmpresa,
    fecha: string,
    tx?: Tx,
  ): Promise<TipoRegimen[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const filas = await t.query<Array<{ tipo_regimen: TipoRegimen }>>(
          `SELECT tipo_regimen FROM empresa_regimen_tributario
            WHERE empresa_id = $1
              AND fecha_inicio <= $2::date
              AND (fecha_fin IS NULL OR fecha_fin >= $2::date)
            ORDER BY tipo_regimen`,
          [ctx.empresaId, fecha],
        );
        return filas.map((f) => f.tipo_regimen);
      },
      tx,
    );
  }

  // ---------------------------------------------------------------------------
  // Representante legal
  // ---------------------------------------------------------------------------

  async abrirRepresentante(
    ctx: CtxEmpresa,
    dto: AbrirRepresentanteDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.cerrarAnterior(
        t,
        `UPDATE empresa_representante SET fecha_fin = $3::date - 1
          WHERE empresa_id = $1 AND tipo_representante = $2 AND fecha_fin IS NULL`,
        [ctx.empresaId, dto.tipoRepresentante ?? 'PRINCIPAL', dto.fechaInicio],
      );
      await exigirTipoDocumento(t, dto.tipoDocumento);

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_representante
           (empresa_id, tipo_representante, nombre_completo, tipo_documento, numero_documento, cargo, fecha_inicio)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          ctx.empresaId,
          dto.tipoRepresentante ?? 'PRINCIPAL',
          dto.nombreCompleto,
          dto.tipoDocumento,
          dto.numeroDocumento,
          dto.cargo ?? null,
          dto.fechaInicio,
        ],
      );
      return fila;
    });
  }

  async listarRepresentantes(
    ctx: CtxEmpresa,
    soloVigentes: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT * FROM empresa_representante
          WHERE ($1 = false OR fecha_fin IS NULL)
          ORDER BY fecha_inicio DESC`,
        [soloVigentes],
      ),
    );
  }

  async cerrarRepresentante(
    ctx: CtxEmpresa,
    id: string,
    fechaFin: string,
  ): Promise<void> {
    await this.cerrarFila(ctx, 'empresa_representante', id, fechaFin);
  }

  // ---------------------------------------------------------------------------
  // Matrícula mercantil
  // ---------------------------------------------------------------------------

  async abrirMatricula(
    ctx: CtxEmpresa,
    dto: AbrirMatriculaDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.cerrarAnterior(
        t,
        `UPDATE empresa_matricula_mercantil SET fecha_fin = $2::date - 1
          WHERE empresa_id = $1 AND fecha_fin IS NULL`,
        [ctx.empresaId, dto.fechaInicio],
      );
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_matricula_mercantil
           (empresa_id, numero_matricula, camara_comercio, fecha_matricula, fecha_ultima_renovacion, fecha_inicio)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          ctx.empresaId,
          dto.numeroMatricula,
          dto.camaraComercio,
          dto.fechaMatricula,
          dto.fechaUltimaRenovacion ?? null,
          dto.fechaInicio,
        ],
      );
      return fila;
    });
  }

  async listarMatriculas(
    ctx: CtxEmpresa,
    soloVigentes: boolean,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT * FROM empresa_matricula_mercantil
          WHERE ($1 = false OR fecha_fin IS NULL)
          ORDER BY fecha_inicio DESC`,
        [soloVigentes],
      ),
    );
  }

  async cerrarMatricula(
    ctx: CtxEmpresa,
    id: string,
    fechaFin: string,
  ): Promise<void> {
    await this.cerrarFila(ctx, 'empresa_matricula_mercantil', id, fechaFin);
  }

  // ---------------------------------------------------------------------------
  // Hechos de la operación — lo que ningún documento declara
  // ---------------------------------------------------------------------------
  // Ningún papel dice si la empresa tiene empleados. El RUT no lo trae, la
  // Cámara de Comercio tampoco, y sin saberlo el plan de cuentas no puede
  // decidir entre proponer las cinco cuentas de prestaciones o ninguna.
  //
  // Sin vigencia y con borrado: no es un hecho fiscal. A la DIAN nunca le va a
  // interesar si la empresa tenía empleados en marzo —eso lo responde la nómina,
  // que sí es histórica—. Acá solo se guarda qué cuentas ofrecerle hoy.

  async hechosOperativos(ctx: CtxEmpresa, tx?: Tx): Promise<string[]> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const filas = await t.query<Array<{ hecho: string }>>(
          'SELECT hecho FROM empresa_hecho_operativo ORDER BY hecho',
        );
        return filas.map((f) => f.hecho);
      },
      tx,
    );
  }

  /**
   * Reemplaza la lista entera.
   *
   * Borra y reinserta en vez de calcular diferencias: son cuatro valores como
   * máximo, y el `DELETE` está permitido a propósito —desmarcar "tiene
   * empleados" no deja huérfano a nadie—.
   *
   * Las cuentas que el hecho ya justificó NO se tocan. Una cuenta con
   * movimiento no se quita, y el plan es de la empresa, no de esta respuesta.
   */
  async guardarHechosOperativos(
    ctx: CtxEmpresa,
    dto: GuardarHechosOperativosDto,
  ): Promise<string[]> {
    return this.tx.enContexto(ctx, async (t) => {
      await t.query(
        'DELETE FROM empresa_hecho_operativo WHERE empresa_id = $1',
        [ctx.empresaId],
      );

      // Sin duplicados: la clave primaria los rechazaría, pero devolver un 500
      // por algo que la pantalla puede mandar dos veces no ayuda a nadie.
      for (const hecho of [...new Set(dto.hechos)]) {
        await t.query(
          'INSERT INTO empresa_hecho_operativo (empresa_id, hecho) VALUES ($1, $2)',
          [ctx.empresaId, hecho],
        );
      }

      return [...new Set(dto.hechos)].sort();
    });
  }

  // ---------------------------------------------------------------------------
  // Configuración contable — 1:1, sí se edita
  // ---------------------------------------------------------------------------

  async configuracionContable(
    ctx: CtxEmpresa,
    tx?: Tx,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const [fila] = await t.query<Array<Record<string, unknown>>>(
          'SELECT * FROM empresa_configuracion_contable WHERE empresa_id = $1',
          [ctx.empresaId],
        );
        if (fila === undefined) {
          throw new NotFoundException(
            'La empresa no tiene configuracion contable',
          );
        }
        return fila;
      },
      tx,
    );
  }

  /**
   * El grupo NIIF y la moneda funcional se pueden corregir mientras la empresa no
   * tenga movimiento. Una vez existan asientos, cambiarlos altera cómo se midió
   * lo ya registrado — eso lo bloqueará el módulo de contabilidad cuando exista,
   * que es quien sabe si hay asientos.
   */
  async editarConfiguracionContable(
    ctx: CtxEmpresa,
    dto: EditarConfiguracionContableDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `UPDATE empresa_configuracion_contable
            SET grupo_niif                   = COALESCE($2, grupo_niif),
                moneda_funcional             = COALESCE($3, moneda_funcional),
                mes_cierre_fiscal            = COALESCE($4, mes_cierre_fiscal),
                metodo_valoracion_inventario = COALESCE($5, metodo_valoracion_inventario),
                decimales_valor              = COALESCE($6, decimales_valor),
                decimales_cantidad           = COALESCE($7, decimales_cantidad),
                maneja_centro_de_costo       = COALESCE($8, maneja_centro_de_costo)
          WHERE empresa_id = $1
          RETURNING *`,
        [
          ctx.empresaId,
          dto.grupoNiif ?? null,
          dto.monedaFuncional ?? null,
          dto.mesCierreFiscal ?? null,
          dto.metodoValoracionInventario ?? null,
          dto.decimalesValor ?? null,
          dto.decimalesCantidad ?? null,
          dto.manejaCentroDeCosto ?? null,
        ],
      );
      if (fila === undefined) {
        throw new NotFoundException(
          'La empresa no tiene configuracion contable',
        );
      }
      return fila;
    });
  }

  // ---------------------------------------------------------------------------

  private async cerrarAnterior(
    t: Tx,
    sql: string,
    params: unknown[],
  ): Promise<void> {
    await t.query(sql, params);
  }

  /**
   * Cierra una fila histórica. Solo toca `fecha_fin` y solo si estaba abierta:
   * reescribir una vigencia ya cerrada es reescribir la historia.
   */
  private async cerrarFila(
    ctx: CtxEmpresa,
    tabla: string,
    id: string,
    fechaFin: string,
  ): Promise<void> {
    const tablasPermitidas = [
      'empresa_actividad_economica',
      'empresa_regimen_tributario',
      'empresa_representante',
      'empresa_matricula_mercantil',
      'empresa_responsabilidad_rut',
    ];
    if (!tablasPermitidas.includes(tabla)) {
      throw new BadRequestException('Tabla no valida');
    }

    await this.tx.enContexto(ctx, async (t) => {
      const cerradas = filas<{ id: string }>(
        await t.query(
          `UPDATE ${tabla} SET fecha_fin = $2 WHERE id = $1 AND fecha_fin IS NULL RETURNING id`,
          [id, fechaFin],
        ),
      );
      if (cerradas.length === 0) {
        throw new NotFoundException(
          'No existe, o esa vigencia ya estaba cerrada',
        );
      }
    });
  }
}
