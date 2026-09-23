import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { ComprasApi } from '../../compras/compras.api';
import { PagarDto } from '../../compras/dto/compra.dto';
import {
  ContabilidadApi,
  type VistaAsiento,
} from '../../contabilidad/contabilidad.api';
import { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import { CobrarDto } from '../../ventas/dto/venta.dto';
import { VentasApi } from '../../ventas/ventas.api';
import {
  cuerpoDesde,
  puedeHacer,
  type AccionPropuesta,
  type CuerpoDePago,
} from '../reglas/propuestas';

/** Lo que se muestra de una propuesta: sale de la verificación en seco. */
export interface VistaPrevia {
  documento: {
    numero: string;
    tercero: string;
    pendienteAntes: string;
    pendienteDespues: string;
  };
  medios: { medio: 'CAJA' | 'BANCO'; nombre: string; valor: number }[];
  asientos: VistaAsiento[];
}

/** Una propuesta recién verificada, esperando que se guarde la respuesta. */
export interface PropuestaNueva {
  accion: AccionPropuesta;
  documentoId: string;
  cuerpo: CuerpoDePago;
  vistaPrevia: VistaPrevia;
}

export type EstadoPropuesta =
  'PENDIENTE' | 'CONFIRMADA' | 'DESCARTADA' | 'VENCIDA';

/** Una propuesta como la ve la pantalla. */
export interface PropuestaResumen {
  id: string;
  accion: AccionPropuesta;
  cuerpo: CuerpoDePago;
  vistaPrevia: VistaPrevia;
  /** Una pendiente con `vence_en` ya pasado se muestra VENCIDA, aunque no se haya marcado. */
  estado: EstadoPropuesta;
  venceEn: string;
  error: string | null;
  /** Lo que se registró de verdad, si se corrigió antes de confirmar. */
  cuerpoConfirmado: CuerpoDePago | null;
}

interface FilaPropuesta {
  id: string;
  accion: AccionPropuesta;
  documento_id: string;
  cuerpo: CuerpoDePago;
  vista_previa: VistaPrevia;
  estado: EstadoPropuesta;
  vence_en: string;
  vencida: boolean;
  error: string | null;
  cuerpo_confirmado: CuerpoDePago | null;
}

/** Los campos de una propuesta, para leerla (`vencida` sale de la base, con su reloj). */
export const CAMPOS_PROPUESTA = `id, accion, documento_id, cuerpo, vista_previa, estado,
  vence_en, (estado = 'PENDIENTE' AND vence_en < now()) AS vencida, error, cuerpo_confirmado`;

class NoSePudo extends Error {}

/** Una propuesta pendiente a la que se le pasaron las 24 horas. */
class PropuestaVencida extends ConflictException {
  constructor() {
    super(
      'Esa propuesta venció: pasaron más de 24 horas. Pedile al asistente que la arme de nuevo.',
    );
  }
}

/**
 * Lo que el asistente propone hacer y lo que la persona decide (paso 7,
 * `docs/planes/asistente-acciones.md`).
 *
 * **No hay una puerta nueva para escribir.**
 * - Proponer corre el cobro o el pago de verdad **en seco**
 *   (`VentasApi.simularCobro`): las reglas son las del endpoint, no una copia.
 * - Confirmar mira los mismos roles que el endpoint y llama al mismo código
 *   (`cobrarEnTx`), en la misma transacción que marca la propuesta: o quedan
 *   las dos cosas o ninguna.
 * - Una propuesta se confirma una sola vez. La base lo garantiza
 *   (`fn_asistente_propuesta_una_vez`, migración 0052).
 *
 * Cada persona ve y confirma solo las suyas: todo filtra por `usuario_id`.
 */
@Injectable()
export class PropuestasService {
  private readonly log = new Logger(PropuestasService.name);

  constructor(
    private readonly tx: TxService,
    private readonly ventas: VentasApi,
    private readonly compras: ComprasApi,
    private readonly tesoreria: TesoreriaApi,
    private readonly contabilidad: ContabilidadApi,
  ) {}

  /**
   * Arma y verifica en seco lo que pidió el modelo. Devuelve el texto que lee
   * el modelo y, si pasó, la propuesta para guardar con la respuesta.
   */
  async preparar(
    ctx: CtxEmpresa,
    accion: AccionPropuesta,
    entrada: unknown,
  ): Promise<{ texto: string; nueva?: PropuestaNueva }> {
    try {
      if (!puedeHacer(ctx.roles, accion)) {
        throw new NoSePudo(
          'El rol de quien pregunta no puede hacer esto, así que no se propone.',
        );
      }
      const cuerpo = cuerpoDesde(entrada, hoyEnColombia());
      await this.validarCuerpo(accion, cuerpo);
      const e = (entrada ?? {}) as Record<string, unknown>;
      const texto = (v: unknown) => (typeof v === 'string' ? v : '');
      const nueva =
        accion === 'COBRO'
          ? await this.prepararCobro(ctx, texto(e.factura), cuerpo)
          : await this.prepararPago(
              ctx,
              texto(e.compra),
              typeof e.proveedor === 'string' ? e.proveedor : undefined,
              cuerpo,
            );
      return {
        texto: JSON.stringify({
          propuesta: 'lista para confirmar',
          ...nueva.vistaPrevia.documento,
          medios: nueva.vistaPrevia.medios,
          aviso:
            'Quedó como propuesta, con un botón Confirmar para la persona. No está registrada: no digas que se hizo.',
        }),
        nueva,
      };
    } catch (e) {
      return { texto: `No se pudo proponer: ${this.explicar(e)}` };
    }
  }

  /** Las propuestas de la respuesta, en la transacción que la guarda. */
  async guardar(
    ctx: CtxEmpresa,
    turnoId: string,
    nuevas: readonly PropuestaNueva[],
    t: Tx,
  ): Promise<PropuestaResumen[]> {
    const guardadas: PropuestaResumen[] = [];
    for (const n of nuevas) {
      const f = fila<FilaPropuesta>(
        await t.query(
          `INSERT INTO asistente_propuesta
             (empresa_id, usuario_id, turno_id, accion, documento_id, cuerpo, vista_previa, error)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${CAMPOS_PROPUESTA}`,
          [
            ctx.empresaId,
            ctx.usuarioId,
            turnoId,
            n.accion,
            n.documentoId,
            JSON.stringify(n.cuerpo),
            JSON.stringify(n.vistaPrevia),
            null,
          ],
        ),
      );
      if (f !== undefined) guardadas.push(resumenDe(f));
    }
    return guardadas;
  }

  /**
   * Confirmar: el cobro o el pago de verdad, con los roles del endpoint, y la
   * propuesta marcada en la misma transacción. `correccion` es lo que la
   * persona cambió en la tarjeta —la fecha, un valor—; sin ella se registra lo
   * propuesto.
   */
  async confirmar(
    ctx: CtxEmpresa,
    id: string,
    correccion?: CuerpoDePago,
  ): Promise<PropuestaResumen> {
    try {
      return await this.tx.enContexto(ctx, async (t) => {
        const p = await this.bloquear(ctx, id, t);
        if (!puedeHacer(ctx.roles, p.accion)) {
          throw new ForbiddenException(
            'Tu rol no puede registrar esto. Pídeselo a quien tenga caja.',
          );
        }
        const cuerpo = correccion ?? p.cuerpo;
        await this.validarCuerpo(p.accion, cuerpo);
        const resultado =
          p.accion === 'COBRO'
            ? await this.ventas.cobrarEnTx(ctx, p.documento_id, cuerpo, t)
            : await this.compras.pagarEnTx(ctx, p.documento_id, cuerpo, t);
        // Los asientos que acaba de dejar el cobro quedan atados a esta
        // propuesta, dentro de la misma transacción: después ya no habría
        // forma de distinguirlos de un cobro digitado a mano.
        await this.contabilidad.marcarPropuesta(t, id);
        const f = fila<FilaPropuesta>(
          await t.query(
            `UPDATE asistente_propuesta
                SET estado = 'CONFIRMADA', resuelta_en = now(), resuelta_por = $2,
                    cuerpo_confirmado = $3, resultado = $4, error = NULL
              WHERE id = $1
              RETURNING ${CAMPOS_PROPUESTA}`,
            [
              id,
              ctx.usuarioId,
              JSON.stringify(cuerpo),
              JSON.stringify(resultado),
            ],
          ),
        );
        return resumenDe(f!);
      });
    } catch (e) {
      if (e instanceof PropuestaVencida) await this.marcarVencida(ctx, id);
      // Si el registro lo rechazó —alguien cobró mientras tanto, la caja se
      // cerró—, la propuesta sigue pendiente y guarda por qué, para que la
      // tarjeta lo diga. Lo que no es de la propuesta se deja pasar tal cual.
      if (e instanceof BadRequestException) {
        await this.anotarError(ctx, id, e.message);
      }
      throw e;
    }
  }

  private async leer(
    ctx: CtxEmpresa,
    id: string,
  ): Promise<PropuestaResumen | null> {
    const f = await this.tx.enContexto(ctx, async (t) =>
      fila<FilaPropuesta>(
        await t.query(
          `SELECT ${CAMPOS_PROPUESTA} FROM asistente_propuesta
            WHERE id = $1 AND usuario_id = $2`,
          [id, ctx.usuarioId],
        ),
      ),
    );
    return f === undefined ? null : resumenDe(f);
  }

  async descartar(ctx: CtxEmpresa, id: string): Promise<PropuestaResumen> {
    try {
      return await this.tx.enContexto(ctx, async (t) => {
        await this.bloquear(ctx, id, t);
        const f = fila<FilaPropuesta>(
          await t.query(
            `UPDATE asistente_propuesta
                SET estado = 'DESCARTADA', resuelta_en = now(), resuelta_por = $2
              WHERE id = $1
              RETURNING ${CAMPOS_PROPUESTA}`,
            [id, ctx.usuarioId],
          ),
        );
        return resumenDe(f!);
      });
    } catch (e) {
      if (e instanceof PropuestaVencida) await this.marcarVencida(ctx, id);
      throw e;
    }
  }

  /**
   * La propuesta, bloqueada, si es de quien pregunta y sigue pendiente. Una
   * vencida se rechaza con `PropuestaVencida`, y quien llama la marca VENCIDA
   * en otra transacción: en esta se perdería, porque el rechazo la deshace.
   */
  private async bloquear(
    ctx: CtxEmpresa,
    id: string,
    t: Tx,
  ): Promise<FilaPropuesta> {
    const p = fila<FilaPropuesta>(
      await t.query(
        `SELECT ${CAMPOS_PROPUESTA} FROM asistente_propuesta
          WHERE id = $1 AND usuario_id = $2
          FOR UPDATE`,
        [id, ctx.usuarioId],
      ),
    );
    if (p === undefined)
      throw new NotFoundException('No encontré esa propuesta.');
    if (p.estado !== 'PENDIENTE') {
      throw new ConflictException(
        `Esa propuesta ya está ${p.estado === 'CONFIRMADA' ? 'confirmada' : p.estado === 'DESCARTADA' ? 'descartada' : 'vencida'}.`,
      );
    }
    if (p.vencida) throw new PropuestaVencida();
    return p;
  }

  private async marcarVencida(ctx: CtxEmpresa, id: string) {
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE asistente_propuesta
            SET estado = 'VENCIDA', resuelta_en = now()
          WHERE id = $1 AND usuario_id = $2 AND estado = 'PENDIENTE'
            AND vence_en < now()`,
        [id, ctx.usuarioId],
      ),
    );
  }

  private async anotarError(ctx: CtxEmpresa, id: string, error: string) {
    try {
      await this.tx.enContexto(ctx, (t) =>
        t.query(
          `UPDATE asistente_propuesta SET error = $3
            WHERE id = $1 AND usuario_id = $2 AND estado = 'PENDIENTE'`,
          [id, ctx.usuarioId, error.slice(0, 1000)],
        ),
      );
    } catch (e) {
      this.log.warn(
        `No pude anotar el error de la propuesta ${id}: ${String(e)}`,
      );
    }
  }

  private async prepararCobro(
    ctx: CtxEmpresa,
    numero: string,
    cuerpo: CuerpoDePago,
  ): Promise<PropuestaNueva> {
    const factura = await this.ventas.facturaPorNumero(ctx, numero);
    if (factura === null) {
      throw new NoSePudo(
        `No hay una factura emitida con el número «${numero}».`,
      );
    }
    const seco = await this.ventas.simularCobro(ctx, factura.id, cuerpo);
    return {
      accion: 'COBRO',
      documentoId: factura.id,
      cuerpo,
      vistaPrevia: {
        documento: {
          numero: factura.numero,
          tercero: factura.cliente,
          pendienteAntes: factura.pendiente,
          pendienteDespues: seco.documento.pendiente,
        },
        medios: await this.medios(ctx, cuerpo),
        asientos: seco.asientos,
      },
    };
  }

  private async prepararPago(
    ctx: CtxEmpresa,
    numero: string,
    proveedor: string | undefined,
    cuerpo: CuerpoDePago,
  ): Promise<PropuestaNueva> {
    const compras = await this.compras.comprasPorNumero(ctx, numero, proveedor);
    if (compras.length === 0) {
      throw new NoSePudo(
        `No hay una compra emitida con el número «${numero}».`,
      );
    }
    if (compras.length > 1) {
      throw new NoSePudo(
        `Hay ${compras.length} compras con el número «${numero}» (${compras.map((c) => c.proveedor).join(', ')}). Decí de qué proveedor.`,
      );
    }
    const [compra] = compras;
    const seco = await this.compras.simularPago(ctx, compra.id, cuerpo);
    return {
      accion: 'PAGO',
      documentoId: compra.id,
      cuerpo,
      vistaPrevia: {
        documento: {
          numero: compra.numero,
          tercero: compra.proveedor,
          pendienteAntes: compra.pendiente,
          pendienteDespues: seco.documento.pendiente,
        },
        medios: await this.medios(ctx, cuerpo),
        asientos: seco.asientos,
      },
    };
  }

  /** Los medios con su nombre, para que la tarjeta diga «Caja principal» y no un id. */
  private async medios(ctx: CtxEmpresa, cuerpo: CuerpoDePago) {
    const saldos = await this.tesoreria.saldos(ctx);
    return cuerpo.pagos.map((p) => {
      const id = p.medio === 'CAJA' ? p.cajaId : p.cuentaBancariaId;
      return {
        medio: p.medio,
        nombre: saldos.find((s) => s.id === id)?.nombre ?? 'Medio desconocido',
        valor: p.valor,
      };
    });
  }

  /** El cuerpo, contra la misma clase que valida el endpoint. */
  private async validarCuerpo(accion: AccionPropuesta, cuerpo: CuerpoDePago) {
    const instancia =
      accion === 'COBRO'
        ? plainToInstance(CobrarDto, cuerpo)
        : plainToInstance(PagarDto, cuerpo);
    const errores = await validate(instancia, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errores.length > 0) {
      const primero = (e: (typeof errores)[number]): string | undefined =>
        Object.values(e.constraints ?? {})[0] ??
        e.children?.map(primero).find((m) => m !== undefined);
      throw new BadRequestException(
        errores.map(primero).find((m) => m !== undefined) ??
          'El cuerpo no es válido.',
      );
    }
  }

  private explicar(e: unknown): string {
    if (e instanceof NoSePudo) return e.message;
    if (e instanceof HttpException) return e.message;
    this.log.error(
      'Falló una propuesta',
      e instanceof Error ? e.stack : String(e),
    );
    return 'La verificación falló. Probá de nuevo en un rato.';
  }
}

export function resumenDe(f: FilaPropuesta): PropuestaResumen {
  return {
    id: f.id,
    accion: f.accion,
    cuerpo: f.cuerpo,
    vistaPrevia: f.vista_previa,
    estado: f.vencida ? 'VENCIDA' : f.estado,
    venceEn: f.vence_en,
    error: f.error,
    cuerpoConfirmado: f.cuerpo_confirmado,
  };
}

/** Lo que suma un cobro o un pago: el monto que mira el límite de la regla. */
function total(cuerpo: CuerpoDePago): number {
  return cuerpo.pagos.reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

/** Para el texto al modelo. */
