import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { NotaCreditoService } from './nota-credito.service';
import type { VentaDocumentoDetalle } from './venta-documento.service';
import { hoyEnColombia } from '../../../common/fecha';

/** Ver la nota de `factura.service.spec.ts`: la fecha de emisión es hoy. */
const HOY = hoyEnColombia();

/** `HOY` corrido en días, para las fechas que el servicio tiene que rechazar. */
function otroDia(dias: number): string {
  const d = new Date(`${HOY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['DIRECTOR'],
};

const numeroFiscal = {
  numero: 'NC-1',
  consecutivo: 1,
  prefijo: 'NC',
  resolucionId: 'res-nc',
  numeroResolucion: '18764000002',
};

const facturaVigente: VentaDocumentoDetalle = {
  id: 'fv-1',
  tipo: 'FACTURA',
  tercero_id: 'ter-1',
  tercero_nombre: 'Tercero uno',
  tercero_identificacion: 'NIT 900123456-7',
  fecha: '2026-09-01',
  estado: 'EMITIDA',
  prefijo: 'SETP',
  consecutivo: 991,
  resolucion_id: 'res-1',
  documento_origen_id: null,
  subtotal: '579800',
  total_iva: '110162',
  total: '689962',
  monto_pagado: '0',
  asiento_id: 'asiento-original',
  lineas: [
    {
      id: 'linea-1',
      venta_documento_id: 'fv-1',
      orden: 1,
      producto_id: 'p-1',
      producto_codigo: 'P-1',
      producto_nombre: 'Producto uno',
      cantidad: '2',
      precio_unitario: '289900',
      iva_tarifa: '19',
      subtotal: '579800',
      iva_valor: '110162',
      total: '689962',
      costo_unitario: '200000',
    },
  ],
};

function txServiceFalso(tx: Tx): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
}

function nucleoFalso(
  cuentas: Record<string, { id: string } | null> = {
    '130505': { id: 'cta-cartera' },
    '240805': { id: 'cta-iva' },
    '417505': { id: 'cta-devoluciones' },
  },
) {
  const cuenta = jest.fn((_ctx: unknown, codigo: string) =>
    Promise.resolve(cuentas[codigo] ?? null),
  );
  const fake = {
    cuenta,
    tomarConsecutivo: jest.fn(() => Promise.resolve(numeroFiscal)),
  } as unknown as ConstructorParameters<typeof NotaCreditoService>[1];
  return { fake, cuenta };
}

function contabilidadFalso(periodoAbierto = true) {
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-nc-1', numero: 'CI-000002' }),
  );
  const fake = {
    periodoAbiertoEn: jest.fn(() => Promise.resolve(periodoAbierto)),
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve({ id: 'comp-ci' })),
    asentar,
  } as unknown as ConstructorParameters<typeof NotaCreditoService>[2];
  return { fake, asentar };
}

function ventasFalso(factura: VentaDocumentoDetalle) {
  return {
    porId: jest.fn(() => Promise.resolve(factura)),
  } as unknown as ConstructorParameters<typeof NotaCreditoService>[3];
}

/** Transacción falsa: solo los dos `INSERT` de `venta_documento[_linea]`. */
function txFalso() {
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO venta_documento\n')) {
        const [id, , terceroId, fecha, prefijo, consecutivo, resolucionId] =
          params as unknown[];
        return [
          {
            id,
            tipo: 'NOTA_CREDITO',
            tercero_id: terceroId,
            fecha,
            estado: 'EMITIDA',
            prefijo,
            consecutivo,
            resolucion_id: resolucionId,
            documento_origen_id: 'fv-1',
            subtotal: '579800',
            total_iva: '110162',
            total: '689962',
            asiento_id: 'asiento-nc-1',
          },
        ];
      }
      if (sql.includes('INSERT INTO venta_documento_linea')) {
        const [, ventaDocumentoId, orden, productoId] = params as unknown[];
        return [
          {
            id: `linea-nc-${String(orden)}`,
            venta_documento_id: ventaDocumentoId,
            orden,
            producto_id: productoId,
            cantidad: '2',
            precio_unitario: '289900',
            iva_tarifa: '19',
            subtotal: '579800',
            iva_valor: '110162',
            total: '689962',
            costo_unitario: null,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx };
}

describe('NotaCreditoService.crear', () => {
  it('arma el asiento espejo (devoluciones + IVA + cartera), sin tocar costo/inventario', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new NotaCreditoService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      contabilidad,
      ventasFalso(facturaVigente),
    );

    const nota = await servicio.crear(ctx, {
      documentoOrigenId: 'fv-1',
      fecha: HOY,
      motivo: 'Devolución por producto defectuoso',
    });

    expect(nota.tipo).toBe('NOTA_CREDITO');
    expect(nota.documento_origen_id).toBe('fv-1');
    expect(nota.total).toBe('689962');
    expect(nota.lineas[0].costo_unitario).toBeNull();

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-devoluciones', debito: 579800, credito: 0 },
      { cuentaId: 'cta-iva', baseGravable: 579800, debito: 110162, credito: 0 },
      {
        cuentaId: 'cta-cartera',
        terceroId: 'ter-1',
        debito: 0,
        credito: 689962,
      },
    ]);
    // Ninguna línea de costo ni de inventario — solo tres, y cuadra.
    expect(dtoAsiento.lineas).toHaveLength(3);
    const totalDebito = dtoAsiento.lineas.reduce((s, l) => s + l.debito, 0);
    const totalCredito = dtoAsiento.lineas.reduce((s, l) => s + l.credito, 0);
    expect(totalDebito).toBe(totalCredito);
  });

  it('rechaza si la factura origen no está vigente (ya anulada)', async () => {
    const { tx } = txFalso();
    const servicio = new NotaCreditoService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      contabilidadFalso().fake,
      ventasFalso({ ...facturaVigente, estado: 'ANULADA' }),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: HOY,
        motivo: 'Cualquier motivo',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    ['ayer', -1],
    ['mañana', 1],
  ])('rechaza una nota crédito fechada %s', async (_cuando, dias) => {
    const { tx } = txFalso();
    const servicio = new NotaCreditoService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      contabilidadFalso().fake,
      ventasFalso(facturaVigente),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: otroDia(dias),
        motivo: 'Cualquier motivo',
      }),
    ).rejects.toThrow(/fecha de hoy/);
  });

  it('rechaza si el período está cerrado', async () => {
    const { tx } = txFalso();
    const servicio = new NotaCreditoService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      contabilidadFalso(false).fake,
      ventasFalso(facturaVigente),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: HOY,
        motivo: 'Cualquier motivo',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('sin IVA en la factura origen: no busca la cuenta de IVA ni agrega su línea', async () => {
    const { tx } = txFalso();
    const { fake: nucleo, cuenta } = nucleoFalso();
    const servicio = new NotaCreditoService(
      txServiceFalso(tx),
      nucleo,
      contabilidadFalso().fake,
      ventasFalso({ ...facturaVigente, total_iva: '0' }),
    );

    await servicio.crear(ctx, {
      documentoOrigenId: 'fv-1',
      fecha: HOY,
      motivo: 'Sin IVA',
    });

    expect(cuenta.mock.calls.some(([, codigo]) => codigo === '240805')).toBe(
      false,
    );
  });
});
