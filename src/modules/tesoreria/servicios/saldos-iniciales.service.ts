import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import type { CargarSaldosInicialesDto } from '../dto/saldos-iniciales.dto';
import { BancoMovimientoService } from './banco-movimiento.service';
import { CajaMovimientoService } from './caja-movimiento.service';
import {
  CONTRAPARTIDA,
  glosaDeApertura,
  lineasDeApertura,
  problemaDeSaldos,
  type OrigenSaldos,
  type SaldoACargar,
} from './saldos-iniciales.reglas';

export interface EstadoSaldosIniciales {
  /** Hay alguna caja o cuenta activa que nunca se movió: se puede arrancar. */
  pendiente: boolean;
  cajas: Array<{
    id: string;
    nombre: string;
    tipo: 'PRINCIPAL' | 'MENOR';
    sinMovimientos: boolean;
  }>;
  cuentas: Array<{
    id: string;
    nombre: string;
    tipoCuenta: string;
    sinMovimientos: boolean;
  }>;
  /** Qué cuenta recibe el crédito según el origen; `null` si la empresa no la tiene. */
  contrapartidas: Record<
    OrigenSaldos,
    { codigo: string; nombre: string } | null
  >;
}

/**
 * El arranque de caja y bancos: la plata con la que una empresa empieza en el
 * sistema, en un solo guardado y con su asiento de apertura (CA). Solo para
 * cajas y cuentas que nunca se movieron (SI2): el saldo inicial es el primer
 * renglón del libro.
 */
@Injectable()
export class SaldosInicialesService {
  constructor(
    private readonly tx: TxService,
    private readonly contabilidad: ContabilidadApi,
    private readonly cajas: CajaMovimientoService,
    private readonly bancos: BancoMovimientoService,
  ) {}

  async estado(ctx: CtxEmpresa): Promise<EstadoSaldosIniciales> {
    return this.tx.enContexto(ctx, async (t) => {
      const cajas = filas<{
        id: string;
        nombre: string;
        tipo: 'PRINCIPAL' | 'MENOR';
        sin_movimientos: boolean;
      }>(
        await t.query(
          `SELECT c.id, c.nombre, c.tipo,
                  NOT EXISTS (SELECT 1 FROM caja_movimiento m WHERE m.caja_id = c.id) AS sin_movimientos
             FROM caja c
            WHERE c.activa
            ORDER BY c.tipo, c.nombre`,
        ),
      );
      const cuentas = filas<{
        id: string;
        banco: string;
        numero_cuenta: string;
        tipo_cuenta: string;
        sin_movimientos: boolean;
      }>(
        await t.query(
          `SELECT b.id, b.banco, b.numero_cuenta, b.tipo_cuenta,
                  NOT EXISTS (SELECT 1 FROM banco_movimiento m WHERE m.cuenta_bancaria_id = b.id) AS sin_movimientos
             FROM cuenta_bancaria b
            WHERE b.activa
            ORDER BY b.banco, b.numero_cuenta`,
        ),
      );
      const socios = await this.contrapartida('SOCIOS', t);
      const antes = await this.contrapartida('ANTES', t);
      return {
        pendiente:
          cajas.some((c) => c.sin_movimientos) ||
          cuentas.some((c) => c.sin_movimientos),
        cajas: cajas.map((c) => ({
          id: c.id,
          nombre: c.nombre,
          tipo: c.tipo,
          sinMovimientos: c.sin_movimientos,
        })),
        cuentas: cuentas.map((c) => ({
          id: c.id,
          nombre: `${c.banco} ${c.numero_cuenta}`,
          tipoCuenta: c.tipo_cuenta,
          sinMovimientos: c.sin_movimientos,
        })),
        contrapartidas: {
          SOCIOS: socios && { codigo: socios.codigo, nombre: socios.nombre },
          ANTES: antes && { codigo: antes.codigo, nombre: antes.nombre },
        },
      };
    });
  }

  /**
   * Todo o nada: si una caja o una cuenta ya tiene movimientos, o el período
   * está cerrado, no queda escrito nada.
   */
  async cargar(
    ctx: CtxEmpresa,
    dto: CargarSaldosInicialesDto,
  ): Promise<{ asientoId: string; numero: string; total: number }> {
    const pedidos = [
      ...dto.cajas.map((c) => ({
        medio: 'CAJA' as const,
        id: c.cajaId,
        valor: c.valor,
      })),
      ...dto.cuentas.map((c) => ({
        medio: 'BANCO' as const,
        id: c.cuentaBancariaId,
        valor: c.valor,
      })),
    ];
    const problema = problemaDeSaldos(pedidos);
    if (problema !== null) throw new BadRequestException(problema);

    return this.tx.enContexto(ctx, async (t) => {
      const saldos: SaldoACargar[] = [];
      for (const p of pedidos) {
        const c =
          p.medio === 'CAJA'
            ? await this.cajas.cuentaDe(ctx, p.id, t)
            : await this.bancos.cuentaDe(ctx, p.id, t);
        saldos.push({ ...p, cuentaId: c.cuentaId, nombre: c.nombre });
      }

      const contrapartida = await this.contrapartida(dto.origen, t);
      if (contrapartida === null) {
        throw new BadRequestException(
          dto.origen === 'SOCIOS'
            ? 'El plan de cuentas no tiene la cuenta del capital (310505, 311505 o 313005). Agréguela en Configurar empresa → Plan de cuentas.'
            : 'El plan de cuentas no tiene la 370505 (utilidades acumuladas). Agréguela en Configurar empresa → Plan de cuentas.',
        );
      }

      const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
        ctx,
        'CA',
        t,
      );
      if (comprobante === null) {
        throw new BadRequestException(
          'La empresa no tiene el comprobante de apertura (CA) sembrado.',
        );
      }

      const ids = saldos.map(() => randomUUID());
      const primero = saldos[0];
      const asiento = await this.contabilidad.asentar(
        ctx,
        {
          comprobanteTipoId: comprobante.id,
          fecha: dto.fecha,
          glosa: glosaDeApertura(dto.origen),
          lineas: lineasDeApertura(saldos, contrapartida.id),
        },
        {
          origenTipo:
            primero.medio === 'CAJA' ? 'MOVIMIENTO_CAJA' : 'MOVIMIENTO_BANCO',
          origenId: ids[0],
        },
        t,
      );

      const concepto = `Saldo inicial · ${asiento.numero}`;
      for (const [i, s] of saldos.entries()) {
        const carga = { fecha: dto.fecha, valor: s.valor, concepto };
        const apertura = { id: ids[i], asientoId: asiento.id };
        if (s.medio === 'CAJA') {
          await this.cajas.registrarSaldoInicial(ctx, s.id, carga, apertura, t);
        } else {
          await this.bancos.registrarSaldoInicial(
            ctx,
            s.id,
            carga,
            apertura,
            t,
          );
        }
      }

      const total = saldos.reduce((a, s) => a + s.valor, 0);
      return { asientoId: asiento.id, numero: asiento.numero, total };
    });
  }

  /** La primera cuenta candidata que tenga la empresa (`CONTRAPARTIDA`). */
  private async contrapartida(
    origen: OrigenSaldos,
    t: Tx,
  ): Promise<{ id: string; codigo: string; nombre: string } | null> {
    const codigos = CONTRAPARTIDA[origen];
    return (
      fila<{ id: string; codigo: string; nombre: string }>(
        await t.query(
          `SELECT id, codigo, nombre FROM empresa_cuenta
            WHERE activa AND codigo = ANY($1::text[])
            ORDER BY array_position($1::text[], codigo)
            LIMIT 1`,
          [codigos],
        ),
      ) ?? null
    );
  }
}
