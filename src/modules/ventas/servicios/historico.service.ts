import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { filas } from '../../../common/db/filas';
import { hoyEnColombia } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import type { FacturaHistoricaDto } from '../dto/historico.dto';
import {
  choqueConResolucion,
  numeroComoTexto,
  partirNumero,
  problemasDeFactura,
  repetidosEnElArchivo,
  type NumeroFactura,
  type ResolucionVigente,
} from './historico.reglas';
import { calcularLineas } from './venta.reglas';

/** Lo que contesta una carga: cuántas entraron, o por qué ninguna. */
export interface ResultadoCarga {
  /** `true` si se corrió sin escribir nada. */
  simulada: boolean;
  registradas: number;
  /** Por factura, en palabras. Si hay alguno, no se registró ninguna. */
  problemas: Array<{ numero: string; problemas: string[] }>;
}

/** Una factura con todo resuelto, lista para insertar. */
interface FacturaResuelta {
  entrada: FacturaHistoricaDto;
  numero: NumeroFactura;
  terceroId: string;
  productoIds: string[];
}

/**
 * Carga facturas de venta históricas: las que se emitieron antes de usar el
 * sistema (fase 10, migración 0065).
 *
 * **Con su número y su fecha originales, sin tocar la resolución, sin asiento
 * y sin kardex.** Lo que vendieron ya está en los saldos iniciales; acá quedan
 * para consultarlas y para cobrar lo que falte.
 *
 * **Todas o ninguna.** Se resuelve y se valida el envío entero antes de
 * escribir, y si una factura tiene un problema no entra ninguna: un archivo a
 * medio cargar es peor que uno sin cargar, porque no se sabe desde dónde
 * seguir. Con `simular` se corre todo —también los INSERT— y se deshace, para
 * ver qué pasaría.
 */
@Injectable()
export class HistoricoService {
  private readonly log = new Logger(HistoricoService.name);

  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
  ) {}

  async cargar(
    ctx: CtxEmpresa,
    facturas: FacturaHistoricaDto[],
    simular: boolean,
  ): Promise<ResultadoCarga> {
    const hoy = hoyEnColombia();
    const problemas = new Map<string, string[]>();
    const anotar = (numero: string, problema: string) =>
      problemas.set(numero, [...(problemas.get(numero) ?? []), problema]);

    // ── 1. Lo que se ve sin la base ────────────────────────────────────────
    for (const f of facturas) {
      for (const p of problemasDeFactura(f, hoy)) anotar(f.numero, p);
    }
    for (const repetido of repetidosEnElArchivo(facturas)) {
      anotar(repetido, 'Está más de una vez en el archivo.');
    }

    // ── 2. Clientes, productos, números ya usados y la resolución ──────────
    const clientes = new Map<string, string | string[]>();
    const productos = new Map<string, string | null>();
    const resueltas: FacturaResuelta[] = [];
    const { existentes, resoluciones } = await this.tx.enContexto(
      ctx,
      async (t) => ({
        existentes: await this.numerosUsados(t),
        resoluciones: await this.resolucionesVigentes(t),
      }),
    );

    for (const f of facturas) {
      const numero = partirNumero(f.numero);
      if (numero === null) continue;

      if (existentes.has(numeroComoTexto(numero))) {
        anotar(
          f.numero,
          `Ya hay una factura ${numeroComoTexto(numero)} en el sistema.`,
        );
      }
      const choque = choqueConResolucion(numero, resoluciones);
      if (choque !== null) anotar(f.numero, choque);

      const cliente = await this.cliente(ctx, f.clienteNit, clientes);
      if (typeof cliente !== 'string') {
        for (const p of cliente) anotar(f.numero, p);
      }

      const productoIds: string[] = [];
      for (const l of f.lineas) {
        const id = await this.producto(ctx, l.codigoProducto, productos);
        if (id === null) {
          anotar(
            f.numero,
            `El producto «${l.codigoProducto}» no está en el catálogo, o está inactivo.`,
          );
        } else {
          productoIds.push(id);
        }
      }

      if (
        typeof cliente === 'string' &&
        productoIds.length === f.lineas.length
      ) {
        resueltas.push({ entrada: f, numero, terceroId: cliente, productoIds });
      }
    }

    if (problemas.size > 0) {
      return {
        simulada: simular,
        registradas: 0,
        problemas: [...problemas.entries()].map(([numero, p]) => ({
          numero,
          problemas: p,
        })),
      };
    }

    // ── 3. Registrar, todas en una transacción ─────────────────────────────
    const escribir = async (t: Tx) => {
      for (const r of resueltas) await this.insertar(ctx, r, t);
    };
    if (simular) {
      await this.tx.simular(ctx, escribir);
    } else {
      await this.tx.enContexto(ctx, escribir);
    }

    this.log.log(
      `${simular ? 'Simuladas' : 'Registradas'} ${resueltas.length} facturas históricas.`,
    );
    return { simulada: simular, registradas: resueltas.length, problemas: [] };
  }

  /**
   * El cliente por su documento. Por identidad y no por parecido —el mismo
   * criterio que el cruce de las facturas leídas—: los mismos dígitos, o los
   * mismos con el de verificación pegado. Tiene que estar marcado como cliente.
   */
  private async cliente(
    ctx: CtxEmpresa,
    documento: string,
    cache: Map<string, string | string[]>,
  ): Promise<string | string[]> {
    const digitos = documento.replace(/\D/g, '');
    const guardado = cache.get(digitos);
    if (guardado !== undefined) return guardado;

    const candidatos = (
      await this.nucleo.terceroPorDocumento(ctx, digitos)
    ).filter((t) => mismoDocumento(t.numeroDocumento, digitos));
    const resultado: string | string[] =
      candidatos.length === 0
        ? [`No hay ningún tercero con el documento ${documento}.`]
        : candidatos.length > 1
          ? [`Hay ${candidatos.length} terceros con el documento ${documento}.`]
          : !candidatos[0].esCliente
            ? [`«${candidatos[0].nombre}» no está marcado como cliente.`]
            : candidatos[0].id;
    cache.set(digitos, resultado);
    return resultado;
  }

  /** El producto por su código exacto. */
  private async producto(
    ctx: CtxEmpresa,
    codigo: string,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    const llave = codigo.trim().toUpperCase();
    if (cache.has(llave)) return cache.get(llave) ?? null;
    const encontrados = (
      await this.inventario.buscarProductos(ctx, llave)
    ).filter((p) => p.codigo.toUpperCase() === llave);
    const id = encontrados.length === 1 ? encontrados[0].id : null;
    cache.set(llave, id);
    return id;
  }

  /**
   * Los números de factura que ya tiene la empresa, como texto comparable.
   * Una histórica anulada no cuenta: anularla es la forma de cargarla de nuevo.
   */
  private async numerosUsados(t: Tx): Promise<Set<string>> {
    const r = filas<{ prefijo: string | null; consecutivo: number }>(
      await t.query(`
        SELECT prefijo, consecutivo FROM venta_documento
         WHERE tipo = 'FACTURA' AND NOT (historica AND estado = 'ANULADA')`),
    );
    return new Set(
      r.map((f) =>
        numeroComoTexto({
          prefijo:
            f.prefijo === null || f.prefijo === ''
              ? null
              : f.prefijo.toUpperCase(),
          consecutivo: Number(f.consecutivo),
        }),
      ),
    );
  }

  /**
   * Las resoluciones de facturación activas. Se leen directo de la tabla de
   * `nucleo` —como hace `reportes`— porque es una consulta de solo lectura que
   * solo usa esto.
   */
  private async resolucionesVigentes(t: Tx): Promise<ResolucionVigente[]> {
    const r = filas<{
      prefijo: string | null;
      rango_desde: string;
      rango_hasta: string;
      consecutivo_actual: string;
    }>(
      await t.query(`
        SELECT prefijo, rango_desde, rango_hasta, consecutivo_actual
          FROM empresa_resolucion_dian
         WHERE activa AND tipo_documento = 'FACTURA_VENTA'`),
    );
    return r.map((f) => ({
      prefijo:
        f.prefijo === null || f.prefijo === '' ? null : f.prefijo.toUpperCase(),
      rangoDesde: Number(f.rango_desde),
      rangoHasta: Number(f.rango_hasta),
      consecutivoActual: Number(f.consecutivo_actual),
    }));
  }

  /** La factura y sus líneas. Sin resolución, sin asiento y sin kardex. */
  private async insertar(
    ctx: CtxEmpresa,
    r: FacturaResuelta,
    t: Tx,
  ): Promise<void> {
    const { lineas, totales } = calcularLineas(r.entrada.lineas);
    const id = randomUUID();
    await t.query(
      `INSERT INTO venta_documento
         (id, empresa_id, tipo, tercero_id, fecha, estado, prefijo, consecutivo,
          resolucion_id, asiento_id, subtotal, total_iva, total, monto_pagado,
          historica, creado_por)
       VALUES ($1, $2, 'FACTURA', $3, $4, 'EMITIDA', $5, $6,
               NULL, NULL, $7, $8, $9, $10, true, $11)`,
      [
        id,
        ctx.empresaId,
        r.terceroId,
        r.entrada.fecha,
        r.numero.prefijo,
        r.numero.consecutivo,
        totales.subtotal,
        totales.totalIva,
        totales.total,
        Math.min(r.entrada.pagado ?? 0, totales.total),
        ctx.usuarioId,
      ],
    );
    for (let i = 0; i < lineas.length; i++) {
      const l = lineas[i];
      await t.query(
        `INSERT INTO venta_documento_linea
           (empresa_id, venta_documento_id, orden, producto_id, cantidad,
            precio_unitario, iva_tarifa, subtotal, iva_valor, total, costo_unitario)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)`,
        [
          ctx.empresaId,
          id,
          i + 1,
          r.productoIds[i],
          l.cantidad,
          l.precioUnitario,
          l.ivaTarifa,
          l.subtotal,
          l.ivaValor,
          l.total,
        ],
      );
    }
  }
}

/** Los mismos dígitos, o los mismos con el de verificación pegado de un lado. */
function mismoDocumento(guardado: string, leido: string): boolean {
  const a = guardado.replace(/\D/g, '');
  const b = leido.replace(/\D/g, '');
  if (a === '' || b === '') return false;
  if (a === b) return true;
  return (
    Math.abs(a.length - b.length) === 1 && (a.startsWith(b) || b.startsWith(a))
  );
}
