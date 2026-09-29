import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { hoyEnColombia } from '../../../common/fecha';
import { NotaDebitoService } from './nota-debito.service';
import type { VentaDocumentoDetalle } from './venta-documento.service';

/** Ver la nota de `factura.service.spec.ts`: la fecha de emisión es hoy. */
const HOY = hoyEnColombia();

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['VENTAS'],
};

const numeroFiscal = {
  numero: 'ND-1',
  consecutivo: 1,
  prefijo: 'ND',
  resolucionId: 'res-nd',
  numeroResolucion: '18764000003',
};

const facturaVigente: VentaDocumentoDetalle = {
  id: 'fv-1',
  tipo: 'FACTURA',
  tercero_id: 'ter-1',
  tercero_nombre: 'Tercero uno',
  tercero_identificacion: 'NIT 900123456-7',
  fecha: '2026-09-01',
  vence: null,
  estado: 'EMITIDA',
  prefijo: 'SETP',
  consecutivo: 991,
  resolucion_id: 'res-1',
  documento_origen_id: null,
  subtotal: '579800',
  total_iva: '110162',
  total: '689962',
  monto_pagado: '0',
  ajuste_notas: '0',
  saldo_efectivo: '689962',
  total_retenido: '0',
  pendiente: '689962',
  saldo_a_favor: '0',
  asiento_id: 'asiento-original',
  historica: false,
  lineas: [],
};

/** El producto del flete que se va a cobrar: con su cuenta de ingreso. */
const productoFlete = {
  id: 'p-flete',
  codigo: 'FLETE',
  nombre: 'Flete',
  iva_tarifa: '19',
  cuenta_ingreso_id: 'cta-ingreso-flete',
  cuenta_costo_venta_id: null,
  cuenta_inventario_id: 'cta-inv',
  activo: true,
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
  },
) {
  return {
    cuenta: jest.fn((_ctx: unknown, codigo: string) =>
      Promise.resolve(cuentas[codigo] ?? null),
    ),
    esResponsableDeIva: jest.fn(() => Promise.resolve(true)),
    tomarConsecutivo: jest.fn(() => Promise.resolve(numeroFiscal)),
  } as unknown as ConstructorParameters<typeof NotaDebitoService>[1];
}

function inventarioFalso(
  producto: Record<string, unknown> | null = productoFlete,
) {
  return {
    producto: jest.fn(() => Promise.resolve(producto)),
  } as unknown as ConstructorParameters<typeof NotaDebitoService>[2];
}

function contabilidadFalso(periodoAbierto = true) {
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-nd-1', numero: 'CI-000003' }),
  );
  const fake = {
    periodoAbiertoEn: jest.fn(() => Promise.resolve(periodoAbierto)),
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve({ id: 'comp-ci' })),
    asentar,
  } as unknown as ConstructorParameters<typeof NotaDebitoService>[3];
  return { fake, asentar };
}

function ventasFalso(factura: VentaDocumentoDetalle) {
  return {
    porId: jest.fn(() => Promise.resolve(factura)),
  } as unknown as ConstructorParameters<typeof NotaDebitoService>[4];
}

function txFalso() {
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      // El candado sobre la factura, contra una anulación simultánea.
      if (sql.includes('FOR SHARE')) {
        return [{ '?column?': 1 }];
      }
      if (sql.includes('INSERT INTO venta_documento\n')) {
        const [id, , terceroId, fecha, prefijo, consecutivo, resolucionId] =
          params as unknown[];
        return [
          {
            id,
            tipo: 'NOTA_DEBITO',
            tercero_id: terceroId,
            fecha,
            estado: 'EMITIDA',
            prefijo,
            consecutivo,
            resolucion_id: resolucionId,
            documento_origen_id: 'fv-1',
            subtotal: '100000',
            total_iva: '19000',
            total: '119000',
            asiento_id: 'asiento-nd-1',
          },
        ];
      }
      if (sql.includes('INSERT INTO venta_documento_linea')) {
        const [, ventaDocumentoId, orden, productoId] = params as unknown[];
        return [
          {
            id: `linea-nd-${String(orden)}`,
            venta_documento_id: ventaDocumentoId,
            orden,
            producto_id: productoId,
            cantidad: '1',
            precio_unitario: '100000',
            iva_tarifa: '19',
            subtotal: '100000',
            iva_valor: '19000',
            total: '119000',
            costo_unitario: null,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx };
}

describe('NotaDebitoService.crear', () => {
  it('arma el asiento espejo de la nota crédito: débito cartera, crédito ingreso e IVA', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new NotaDebitoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      ventasFalso(facturaVigente),
    );

    const nota = await servicio.crear(ctx, {
      documentoOrigenId: 'fv-1',
      fecha: HOY,
      motivo: 'Flete que no se cobró en la factura',
      lineas: [{ productoId: 'p-flete', cantidad: 1, precioUnitario: 100000 }],
    });

    expect(nota.tipo).toBe('NOTA_DEBITO');
    expect(nota.documento_origen_id).toBe('fv-1');
    // La línea no corrige ninguna de la factura: cobra algo nuevo.
    const insercionLinea = (tx.query as jest.Mock).mock.calls.find(
      ([sql]: [string]) => sql.includes('INSERT INTO venta_documento_linea'),
    ) as [string, unknown[]];
    // Diez de la línea y tres de la de concepto (vacíos en una de producto).
    expect(insercionLinea[1]).toHaveLength(13);

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      {
        cuentaId: 'cta-cartera',
        terceroId: 'ter-1',
        debito: 119000,
        credito: 0,
      },
      { cuentaId: 'cta-ingreso-flete', debito: 0, credito: 100000 },
      { cuentaId: 'cta-iva', baseGravable: 100000, debito: 0, credito: 19000 },
    ]);
    const totalDebito = dtoAsiento.lineas.reduce((s, l) => s + l.debito, 0);
    const totalCredito = dtoAsiento.lineas.reduce((s, l) => s + l.credito, 0);
    expect(totalDebito).toBe(totalCredito);
  });

  it('rechaza un producto sin cuenta de ingreso: el cobro no sabría contra qué acreditarse', async () => {
    const { tx } = txFalso();
    const servicio = new NotaDebitoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso({ ...productoFlete, cuenta_ingreso_id: null }),
      contabilidadFalso().fake,
      ventasFalso(facturaVigente),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: HOY,
        motivo: 'Flete sin cuenta',
        lineas: [
          { productoId: 'p-flete', cantidad: 1, precioUnitario: 100000 },
        ],
      }),
    ).rejects.toThrow(/no tiene cuenta de ingreso/);
  });

  it('rechaza sobre una factura anulada', async () => {
    const { tx } = txFalso();
    const servicio = new NotaDebitoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso({ ...facturaVigente, estado: 'ANULADA' }),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: HOY,
        motivo: 'Sobre una anulada',
        lineas: [
          { productoId: 'p-flete', cantidad: 1, precioUnitario: 100000 },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza una fecha que no es hoy', async () => {
    const { tx } = txFalso();
    const servicio = new NotaDebitoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso(facturaVigente),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: '2026-01-05',
        motivo: 'Atrasada',
        lineas: [
          { productoId: 'p-flete', cantidad: 1, precioUnitario: 100000 },
        ],
      }),
    ).rejects.toThrow(/fecha de hoy/);
  });

  it('rechaza el mismo producto en dos líneas', async () => {
    const { tx } = txFalso();
    const servicio = new NotaDebitoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso(facturaVigente),
    );

    await expect(
      servicio.crear(ctx, {
        documentoOrigenId: 'fv-1',
        fecha: HOY,
        motivo: 'Dos veces el flete',
        lineas: [
          { productoId: 'p-flete', cantidad: 1, precioUnitario: 100000 },
          { productoId: 'p-flete', cantidad: 1, precioUnitario: 50000 },
        ],
      }),
    ).rejects.toThrow(/No repitas el mismo producto/);
  });
});
