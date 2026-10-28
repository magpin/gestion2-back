import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  CrearComprobanteDto,
  EditarComprobanteDto,
} from '../dto/comprobante.dto';
import { armarNumero } from './asiento.reglas';

export interface ComprobanteTipo {
  id: string;
  codigo: string;
  nombre: string;
  naturaleza: string;
  prefijo: string;
  consecutivo: number;
  activo: boolean;
}

/**
 * Los tipos que la empresa arranca teniendo.
 *
 * Se siembran al crear la empresa porque un plan de cuentas sin dónde asentar no
 * sirve de nada, y porque estos cinco son los que usa cualquier contabilidad:
 * no hay decisión que tomar sobre ellos.
 */
export const TIPOS_INICIALES: ReadonlyArray<{
  codigo: string;
  nombre: string;
  naturaleza: string;
  prefijo: string;
}> = [
  {
    codigo: 'CD',
    nombre: 'Comprobante de diario',
    naturaleza: 'DIARIO',
    prefijo: 'CD',
  },
  {
    codigo: 'CI',
    nombre: 'Comprobante de ingreso',
    naturaleza: 'INGRESO',
    prefijo: 'CI',
  },
  {
    codigo: 'CE',
    nombre: 'Comprobante de egreso',
    naturaleza: 'EGRESO',
    prefijo: 'CE',
  },
  {
    codigo: 'CA',
    nombre: 'Comprobante de apertura',
    naturaleza: 'APERTURA',
    prefijo: 'CA',
  },
  {
    codigo: 'CC',
    nombre: 'Comprobante de cierre',
    naturaleza: 'CIERRE',
    prefijo: 'CC',
  },
];

/** Las que produce el sistema. Digitarlas a mano descuadra el arrastre de saldos. */
const NATURALEZAS_DEL_SISTEMA = ['APERTURA', 'CIERRE'];

/**
 * Las series de numeración de los asientos.
 *
 * Los asientos no van en una sola serie corrida: cada tipo lleva la suya —
 * `CD-000145`, `CI-000032`— que es como se pide un comprobante y como lo espera
 * quien revisa.
 */
@Injectable()
export class ComprobanteService {
  constructor(private readonly tx: TxService) {}

  async listar(
    ctx: CtxEmpresa,
    incluirInactivos = false,
  ): Promise<ComprobanteTipo[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<ComprobanteTipo>(
        await t.query(
          `SELECT id, codigo, nombre, naturaleza, prefijo, consecutivo, activo
             FROM empresa_comprobante_tipo
            ${incluirInactivos ? '' : 'WHERE activo'}
            ORDER BY codigo`,
        ),
      ),
    );
  }

  async crear(
    ctx: CtxEmpresa,
    dto: CrearComprobanteDto,
  ): Promise<ComprobanteTipo> {
    return this.tx.enContexto(ctx, async (t) => {
      const creado = fila<ComprobanteTipo>(
        await t.query(
          `INSERT INTO empresa_comprobante_tipo
             (empresa_id, codigo, nombre, naturaleza, prefijo)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, codigo, nombre, naturaleza, prefijo, consecutivo, activo`,
          [
            ctx.empresaId,
            dto.codigo.toUpperCase(),
            dto.nombre,
            dto.naturaleza,
            dto.prefijo.toUpperCase(),
          ],
        ),
      );

      if (creado === undefined) {
        throw new BadRequestException(
          'No se pudo crear el tipo de comprobante.',
        );
      }
      return creado;
    });
  }

  /**
   * Solo el nombre.
   *
   * El prefijo y la naturaleza no se editan: cambiar el prefijo dejaría los
   * asientos ya numerados con uno que la tabla ya no reconoce, y cambiar la
   * naturaleza convertiría comprobantes de diario en asientos de apertura sin
   * que nada en el libro lo refleje.
   */
  async editar(
    ctx: CtxEmpresa,
    id: string,
    dto: EditarComprobanteDto,
  ): Promise<ComprobanteTipo> {
    return this.tx.enContexto(ctx, async (t) => {
      const editado = fila<ComprobanteTipo>(
        await t.query(
          `UPDATE empresa_comprobante_tipo
              SET nombre = COALESCE($2, nombre)
            WHERE id = $1
          RETURNING id, codigo, nombre, naturaleza, prefijo, consecutivo, activo`,
          [id, dto.nombre ?? null],
        ),
      );

      if (editado === undefined) {
        throw new NotFoundException('Tipo de comprobante no encontrado');
      }
      return editado;
    });
  }

  async desactivar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        'UPDATE empresa_comprobante_tipo SET activo = false WHERE id = $1',
        [id],
      ),
    );
  }

  async activar(ctx: CtxEmpresa, id: string): Promise<void> {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        'UPDATE empresa_comprobante_tipo SET activo = true WHERE id = $1',
        [id],
      ),
    );
  }

  /**
   * Un tipo por su código (`'CD'`, `'CI'`...), para módulos que asientan
   * automático y necesitan uno ya sembrado. `null` si no existe — no lanza,
   * porque quien llama (`ContabilidadApi.tipoComprobantePorCodigo`) es quien
   * decide si la ausencia es un error o una condición a informar.
   *
   * Si falta uno de los tipos iniciales —una empresa vaciada, o de antes de
   * que se sembraran—, se siembran los que faltan y se vuelve a buscar. El que
   * existe desactivado no se toca: lo apagó alguien y sigue dando `null`.
   */
  async porCodigo(
    ctx: CtxEmpresa,
    codigo: string,
    tx?: Tx,
  ): Promise<{ id: string } | null> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const buscar = async () =>
          fila<{ id: string }>(
            await t.query(
              'SELECT id FROM empresa_comprobante_tipo WHERE codigo = $1 AND activo',
              [codigo],
            ),
          ) ?? null;
        const encontrado = await buscar();
        if (
          encontrado !== null ||
          !TIPOS_INICIALES.some((tipo) => tipo.codigo === codigo)
        ) {
          return encontrado;
        }
        await this.sembrar(ctx.empresaId, t);
        return buscar();
      },
      tx,
    );
  }

  /**
   * Toma el siguiente número y lo consume. **Exige transacción.**
   *
   * `UPDATE ... RETURNING` toma el bloqueo de la fila, así que dos asientos
   * simultáneos no sacan el mismo número: el segundo espera al COMMIT del
   * primero.
   *
   * Y exige `tx` porque de eso depende que el número vuelva: si la transacción
   * del asiento se revierte, el `UPDATE` se revierte con ella. Una `SEQUENCE` no
   * lo haría, y dejaría un hueco en una numeración que es fiscal.
   */
  async siguienteNumero(tipoId: string, tx: Tx): Promise<string> {
    const tomado = fila<{ prefijo: string; consecutivo: number }>(
      await tx.query(
        `UPDATE empresa_comprobante_tipo
            SET consecutivo = consecutivo + 1
          WHERE id = $1 AND activo
        RETURNING prefijo, consecutivo`,
        [tipoId],
      ),
    );

    if (tomado === undefined) {
      throw new BadRequestException(
        'El tipo de comprobante no existe o esta desactivado.',
      );
    }

    // El consecutivo vuelve como texto: `numeric` y `bigint` llegan en cadena
    // desde el driver, y `padStart` sobre un número mal tipado produciría
    // 'CD-undefined'.
    return armarNumero(tomado.prefijo, Number(tomado.consecutivo));
  }

  /**
   * El tipo, verificado y listo para numerar.
   *
   * Rechaza los que produce el sistema: un asiento de apertura digitado a mano
   * descuadra el arrastre de saldos, porque el cierre del ejercicio los vuelve a
   * calcular y no sabe de este.
   */
  async exigirDigitable(tipoId: string, tx: Tx): Promise<ComprobanteTipo> {
    const tipo = fila<ComprobanteTipo>(
      await tx.query(
        `SELECT id, codigo, nombre, naturaleza, prefijo, consecutivo, activo
           FROM empresa_comprobante_tipo WHERE id = $1`,
        [tipoId],
      ),
    );

    if (tipo === undefined) {
      throw new NotFoundException('Tipo de comprobante no encontrado');
    }
    if (!tipo.activo) {
      throw new BadRequestException(
        `El comprobante ${tipo.codigo} esta desactivado y no acepta asientos nuevos.`,
      );
    }
    if (NATURALEZAS_DEL_SISTEMA.includes(tipo.naturaleza)) {
      throw new BadRequestException(
        `Los comprobantes de ${tipo.naturaleza.toLowerCase()} los produce el sistema al abrir y cerrar el ejercicio: digitarlos a mano descuadra el arrastre de saldos.`,
      );
    }
    return tipo;
  }

  /**
   * Siembra los cinco tipos de una empresa nueva.
   *
   * Idempotente: repetirla no duplica. Se llama al crear la empresa y también
   * puede correr sobre una empresa vieja que se quedó sin ellos.
   */
  async sembrar(empresaId: string, tx: Tx): Promise<void> {
    for (const t of TIPOS_INICIALES) {
      await tx.query(
        `INSERT INTO empresa_comprobante_tipo
           (empresa_id, codigo, nombre, naturaleza, prefijo)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (empresa_id, codigo) DO NOTHING`,
        [empresaId, t.codigo, t.nombre, t.naturaleza, t.prefijo],
      );
    }
  }
}
