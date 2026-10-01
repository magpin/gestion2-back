import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  ActualizarReglaExtractoDto,
  CrearReglaExtractoDto,
} from '../dto/extracto.dto';

export interface ReglaExtractoResumen {
  id: string;
  cuenta_bancaria_id: string | null;
  nombre: string;
  palabras: string[];
  tipo_linea: 'DEBITO' | 'CREDITO';
  contra_cuenta_id: string;
  concepto: string;
  activa: boolean;
  centro_costo_id: string | null;
}

const CAMPOS = `id, cuenta_bancaria_id, nombre, palabras, tipo_linea,
                contra_cuenta_id, concepto, activa, centro_costo_id`;

/**
 * Las reglas del extracto: "las líneas que dicen GMF son 4×1000 y van contra
 * tal cuenta". Reconocen y proponen; registrar lo confirma una persona
 * (`ExtractoService.registrar`). No se borran: se desactivan.
 */
@Injectable()
export class ExtractoReglaService {
  constructor(private readonly tx: TxService) {}

  async listar(ctx: CtxEmpresa): Promise<ReglaExtractoResumen[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<ReglaExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS} FROM extracto_regla
            ORDER BY activa DESC, cuenta_bancaria_id NULLS LAST, creado_en`,
        ),
      ),
    );
  }

  async crear(
    ctx: CtxEmpresa,
    dto: CrearReglaExtractoDto,
  ): Promise<ReglaExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      if (dto.cuentaBancariaId !== undefined) {
        const cuenta = fila<{ id: string }>(
          await t.query(`SELECT id FROM cuenta_bancaria WHERE id = $1`, [
            dto.cuentaBancariaId,
          ]),
        );
        if (cuenta === undefined) {
          throw new NotFoundException('Cuenta bancaria no encontrada');
        }
      }
      await this.exigirContraCuenta(dto.contraCuentaId, t);

      const creada = fila<ReglaExtractoResumen>(
        await t.query(
          `INSERT INTO extracto_regla
             (empresa_id, cuenta_bancaria_id, nombre, palabras, tipo_linea,
              contra_cuenta_id, concepto, creado_por, centro_costo_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING ${CAMPOS}`,
          [
            ctx.empresaId,
            dto.cuentaBancariaId ?? null,
            dto.nombre.trim(),
            limpiarPalabras(dto.palabras),
            dto.tipoLinea,
            dto.contraCuentaId,
            dto.concepto.trim(),
            ctx.usuarioId,
            dto.centroCostoId ?? null,
          ],
        ),
      );
      if (creada === undefined) {
        throw new BadRequestException('No se pudo crear la regla.');
      }
      return creada;
    });
  }

  async actualizar(
    ctx: CtxEmpresa,
    id: string,
    dto: ActualizarReglaExtractoDto,
  ): Promise<ReglaExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      if (dto.contraCuentaId !== undefined) {
        await this.exigirContraCuenta(dto.contraCuentaId, t);
      }

      const actualizada = fila<ReglaExtractoResumen>(
        await t.query(
          `UPDATE extracto_regla
              SET nombre           = coalesce($2, nombre),
                  palabras         = coalesce($3, palabras),
                  contra_cuenta_id = coalesce($4, contra_cuenta_id),
                  concepto         = coalesce($5, concepto),
                  activa           = coalesce($6, activa),
                  centro_costo_id  = CASE WHEN $7 THEN $8::uuid ELSE centro_costo_id END
            WHERE id = $1
          RETURNING ${CAMPOS}`,
          [
            id,
            dto.nombre?.trim() ?? null,
            dto.palabras === undefined ? null : limpiarPalabras(dto.palabras),
            dto.contraCuentaId ?? null,
            dto.concepto?.trim() ?? null,
            dto.activa ?? null,
            dto.centroCostoId !== undefined,
            dto.centroCostoId ?? null,
          ],
        ),
      );
      if (actualizada === undefined) {
        throw new NotFoundException('Regla no encontrada');
      }
      return actualizada;
    });
  }

  /**
   * La contra cuenta recibe asientos: tiene que existir, estar activa y ser
   * auxiliar. Y no puede exigir tercero ni base gravable: una regla registra
   * sus líneas sin ninguno de los dos, y el trigger del asiento
   * (`0022_asiento.sql`) la rechazaría el día que se use, no hoy. El centro
   * de costo sí: lo lleva la regla, y si no, va al de por defecto.
   */
  private async exigirContraCuenta(cuentaId: string, t: Tx): Promise<void> {
    const cuenta = fila<{
      activa: boolean;
      es_auxiliar: boolean;
      exige_tercero: boolean;
      exige_base_gravable: boolean;
    }>(
      await t.query(
        `SELECT activa, es_auxiliar, exige_tercero, exige_base_gravable
           FROM empresa_cuenta WHERE id = $1`,
        [cuentaId],
      ),
    );
    if (cuenta === undefined) {
      throw new NotFoundException('Cuenta contable no encontrada');
    }
    if (!cuenta.activa || !cuenta.es_auxiliar) {
      throw new BadRequestException(
        'La cuenta de la regla tiene que estar activa y ser auxiliar: ahí se registra el gasto o el ingreso.',
      );
    }
    const exige = cuenta.exige_tercero
      ? 'tercero'
      : cuenta.exige_base_gravable
        ? 'base gravable'
        : null;
    if (exige !== null) {
      throw new BadRequestException(
        `La cuenta de la regla exige ${exige}, y una regla registra sus líneas sin él. Elija otra auxiliar.`,
      );
    }
  }
}

function limpiarPalabras(palabras: readonly string[]): string[] {
  return [...new Set(palabras.map((p) => p.trim()).filter((p) => p !== ''))];
}
