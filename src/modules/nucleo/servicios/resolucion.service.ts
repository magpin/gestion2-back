import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { CifradoService } from '../../../common/cripto/cifrado.service';
import type { CtxEmpresa, TipoDocumentoFiscal } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  CrearResolucionDto,
  GuardarCredencialDto,
} from '../dto/resolucion.dto';

export interface NumeroFiscal {
  /** El número completo tal como va en el documento: prefijo + consecutivo. */
  numero: string;
  consecutivo: number;
  prefijo: string | null;
  resolucionId: string;
  numeroResolucion: string;
}

@Injectable()
export class ResolucionService {
  constructor(
    private readonly tx: TxService,
    private readonly cifrado: CifradoService,
  ) {}

  async crear(
    ctx: CtxEmpresa,
    dto: CrearResolucionDto,
  ): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      // Solo puede haber una activa por tipo y ambiente: el indice unico parcial
      // lo rechaza. Desactivar la anterior acá convierte "reemplazar la
      // resolucion" en una sola operacion, que es como ocurre en la realidad
      // cuando la DIAN autoriza un rango nuevo.
      if (dto.reemplazarActiva === true) {
        await t.query(
          `UPDATE empresa_resolucion_dian SET activa = false
            WHERE empresa_id = $1 AND tipo_documento = $2 AND ambiente = $3 AND activa`,
          [ctx.empresaId, dto.tipoDocumento, dto.ambiente],
        );
      }

      const [fila] = await t.query<Array<Record<string, unknown>>>(
        `INSERT INTO empresa_resolucion_dian
           (empresa_id, tipo_documento, numero_resolucion, prefijo, rango_desde, rango_hasta,
            consecutivo_actual, fecha_resolucion, fecha_vigencia_desde, fecha_vigencia_hasta,
            ambiente, clave_tecnica_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          ctx.empresaId,
          dto.tipoDocumento,
          dto.numeroResolucion,
          dto.prefijo ?? null,
          dto.rangoDesde,
          dto.rangoHasta,
          // Arranca en desde - 1: todavia no se emitio ninguno.
          dto.rangoDesde - 1,
          dto.fechaResolucion,
          dto.fechaVigenciaDesde,
          dto.fechaVigenciaHasta,
          dto.ambiente,
          this.cifrado.cifrarOpcional(dto.claveTecnica),
        ],
      );
      return this.sinSecretos(fila);
    });
  }

  async listar(ctx: CtxEmpresa): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, async (t) => {
      const filas = await t.query<Array<Record<string, unknown>>>(
        `SELECT * FROM empresa_resolucion_dian
          ORDER BY activa DESC, tipo_documento, fecha_vigencia_hasta DESC`,
      );
      return filas.map((f) => this.sinSecretos(f));
    });
  }

  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        'UPDATE empresa_resolucion_dian SET activa = false WHERE id = $1',
        [id],
      ),
    );
  }

  /**
   * Cuántos números quedan y cuándo vence. Es lo que alimenta el aviso de
   * "resolución por agotarse": pedirle una nueva a la DIAN toma días, y quedarse
   * sin numeración es quedarse sin poder facturar.
   */
  async disponibilidad(
    ctx: CtxEmpresa,
  ): Promise<Array<Record<string, unknown>>> {
    return this.tx.enContexto(ctx, (t) =>
      t.query(
        `SELECT tipo_documento, ambiente, prefijo, numero_resolucion,
                rango_desde, rango_hasta, consecutivo_actual,
                rango_hasta - consecutivo_actual         AS numeros_restantes,
                fecha_vigencia_hasta,
                fecha_vigencia_hasta - CURRENT_DATE      AS dias_restantes,
                (fecha_vigencia_hasta < CURRENT_DATE)    AS vencida,
                (consecutivo_actual >= rango_hasta)      AS agotada
           FROM empresa_resolucion_dian
          WHERE activa
          ORDER BY tipo_documento`,
      ),
    );
  }

  /**
   * Entrega el siguiente número fiscal.
   *
   * Este método es la razón por la que la numeración no tiene huecos ni repetidos.
   * Tres cosas lo sostienen:
   *
   * 1. `FOR UPDATE` bloquea la fila de la resolución. Dos facturas simultáneas se
   *    serializan; la segunda espera a que la primera confirme.
   * 2. El avance ocurre **dentro de la transacción del documento**. Si el
   *    documento falla, el consecutivo vuelve atrás con él — un número quemado
   *    sin documento es un hueco que hay que justificar ante la DIAN.
   * 3. `ck_resolucion_consecutivo` en la base impide pasarse del rango aunque
   *    este código tuviera un error.
   *
   * Por eso exige `tx`: quien emite el documento ya abrió su transacción, y
   * tomar el número en otra rompería las tres garantías.
   */
  async tomarConsecutivo(
    ctx: CtxEmpresa,
    tipo: TipoDocumentoFiscal,
    tx: Tx,
    fecha: string = new Date().toISOString().slice(0, 10),
  ): Promise<NumeroFiscal> {
    const [resolucion] = await tx.query<
      Array<{
        id: string;
        prefijo: string | null;
        rango_hasta: string;
        consecutivo_actual: string;
        numero_resolucion: string;
        fecha_vigencia_desde: string;
        fecha_vigencia_hasta: string;
      }>
    >(
      `SELECT id, prefijo, rango_hasta, consecutivo_actual, numero_resolucion,
              fecha_vigencia_desde, fecha_vigencia_hasta
         FROM empresa_resolucion_dian
        WHERE empresa_id = $1 AND tipo_documento = $2 AND activa
        FOR UPDATE`,
      [ctx.empresaId, tipo],
    );

    if (resolucion === undefined) {
      throw new BadRequestException(
        `No hay resolucion activa para ${tipo}. Registrar la autorizacion de la DIAN antes de emitir.`,
      );
    }

    if (
      fecha < resolucion.fecha_vigencia_desde ||
      fecha > resolucion.fecha_vigencia_hasta
    ) {
      throw new ConflictException(
        `La resolucion ${resolucion.numero_resolucion} no esta vigente el ${fecha}. ` +
          `Vigencia: ${resolucion.fecha_vigencia_desde} a ${resolucion.fecha_vigencia_hasta}.`,
      );
    }

    if (
      Number(resolucion.consecutivo_actual) >= Number(resolucion.rango_hasta)
    ) {
      throw new ConflictException(
        `La resolucion ${resolucion.numero_resolucion} agoto su rango (hasta ${resolucion.rango_hasta}). ` +
          'Solicitar una nueva a la DIAN.',
      );
    }

    // `fila()` y no destructurar: en un UPDATE ... RETURNING, TypeORM devuelve
    // [filas, cantidad], y leer el campo directo daria `NaN` como numero fiscal.
    const avanzada = fila<{ consecutivo_actual: string }>(
      await tx.query(
        `UPDATE empresa_resolucion_dian
            SET consecutivo_actual = consecutivo_actual + 1
          WHERE id = $1
          RETURNING consecutivo_actual`,
        [resolucion.id],
      ),
    );

    if (avanzada === undefined) {
      throw new ConflictException(
        'No se pudo avanzar el consecutivo de la resolucion',
      );
    }

    const consecutivo = Number(avanzada.consecutivo_actual);
    return {
      numero: `${resolucion.prefijo ?? ''}${consecutivo}`,
      consecutivo,
      prefijo: resolucion.prefijo,
      resolucionId: resolucion.id,
      numeroResolucion: resolucion.numero_resolucion,
    };
  }

  // ---------------------------------------------------------------------------
  // Credenciales DIAN
  // ---------------------------------------------------------------------------

  /** Guarda las credenciales cifradas. 1:1 con la empresa, así que es un upsert. */
  async guardarCredenciales(
    ctx: CtxEmpresa,
    dto: GuardarCredencialDto,
  ): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `INSERT INTO empresa_credencial_dian
           (empresa_id, software_id_enc, software_pin_enc, certificado_clave_enc,
            certificado_vence_en, proveedor_tecnologico, test_set_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (empresa_id) DO UPDATE SET
           software_id_enc       = COALESCE(EXCLUDED.software_id_enc, empresa_credencial_dian.software_id_enc),
           software_pin_enc      = COALESCE(EXCLUDED.software_pin_enc, empresa_credencial_dian.software_pin_enc),
           certificado_clave_enc = COALESCE(EXCLUDED.certificado_clave_enc, empresa_credencial_dian.certificado_clave_enc),
           certificado_vence_en  = COALESCE(EXCLUDED.certificado_vence_en, empresa_credencial_dian.certificado_vence_en),
           proveedor_tecnologico = COALESCE(EXCLUDED.proveedor_tecnologico, empresa_credencial_dian.proveedor_tecnologico),
           test_set_id           = COALESCE(EXCLUDED.test_set_id, empresa_credencial_dian.test_set_id)`,
        [
          ctx.empresaId,
          this.cifrado.cifrarOpcional(dto.softwareId),
          this.cifrado.cifrarOpcional(dto.softwarePin),
          this.cifrado.cifrarOpcional(dto.certificadoClave),
          dto.certificadoVenceEn ?? null,
          dto.proveedorTecnologico ?? null,
          dto.testSetId ?? null,
        ],
      ),
    );
  }

  /**
   * Estado de las credenciales, nunca su contenido.
   *
   * Devuelve si cada secreto está cargado y cuándo vence el certificado. El valor
   * descifrado solo lo usará el módulo `dian` al firmar; no sale por la API ni
   * para el director.
   */
  async estadoCredenciales(ctx: CtxEmpresa): Promise<Record<string, unknown>> {
    return this.tx.enContexto(ctx, async (t) => {
      const [fila] = await t.query<
        Array<{
          software_id_enc: string | null;
          software_pin_enc: string | null;
          certificado_p12_enc: Buffer | null;
          certificado_vence_en: string | null;
          proveedor_tecnologico: string | null;
          test_set_id: string | null;
          habilitado_en: Date | null;
        }>
      >('SELECT * FROM empresa_credencial_dian WHERE empresa_id = $1', [
        ctx.empresaId,
      ]);

      if (fila === undefined) {
        return { configurado: false };
      }

      return {
        configurado: true,
        tieneSoftwareId: fila.software_id_enc !== null,
        tieneSoftwarePin: fila.software_pin_enc !== null,
        tieneCertificado: fila.certificado_p12_enc !== null,
        certificadoVenceEn: fila.certificado_vence_en,
        proveedorTecnologico: fila.proveedor_tecnologico,
        testSetId: fila.test_set_id,
        habilitadoEn: fila.habilitado_en,
      };
    });
  }

  /** Nunca devolver una columna `_enc` por la API. */
  private sinSecretos(fila: Record<string, unknown>): Record<string, unknown> {
    const copia = { ...fila };
    delete copia.clave_tecnica_enc;
    return { ...copia, tieneClaveTecnica: fila.clave_tecnica_enc !== null };
  }
}
