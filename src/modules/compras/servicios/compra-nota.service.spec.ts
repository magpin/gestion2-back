import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { CompraNotaService } from './compra-nota.service';
import type { CompraDocumentoDetalle } from './compra.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['COMPRAS'],
};

/**
 * Una compra de 10 unidades a 100.000, IVA 19% descontable, con retención de
 * renta del 2,5% sobre el total: subtotal 1.000.000, IVA 190.000, total
 * 1.190.000, retenido 29.750, neto 1.160.250.
 */
const compraVigente: CompraDocumentoDetalle = {
  id: 'c-1',
  tipo: 'FACTURA',
  documento_origen_id: null,
  tercero_id: 'prov-1',
  tercero_nombre: 'Proveedor uno',
  tercero_identificacion: 'NIT 800100200-1',
  fecha: '2026-09-10',
  numero_factura_proveedor: 'FP-500',
  estado: 'EMITIDA',
  subtotal: '1000000',
  total_iva: '190000',
  total: '1190000',
  total_retenciones: '29750',
  neto_a_pagar: '1160250',
  monto_pagado: '0',
  asiento_id: 'asiento-compra',
  lineas: [
    {
      id: 'lc-1',
      compra_documento_id: 'c-1',
      orden: 1,
      producto_id: 'p-1',
      producto_codigo: 'P-1',
      producto_nombre: 'Producto uno',
      cantidad: '10',
      costo_unitario: '100000',
      iva_tarifa: '19',
      subtotal: '1000000',
      iva_valor: '190000',
      total: '1190000',
      iva_descontable: true,
    },
  ],
  retenciones: [
    {
      id: 'ret-1',
      compra_documento_id: 'c-1',
      concepto: 'RENTA',
      cuenta_id: 'cta-retefuente',
      base: '1000000',
      valor: '29750',
    },
  ],
};

const productoFlete = {
  id: 'p-flete',
  codigo: 'FLETE',
  nombre: 'Flete',
  iva_tarifa: '19',
  cuenta_inventario_id: 'cta-inventario',
  cuenta_costo_venta_id: null,
  cuenta_ingreso_id: null,
  activo: true,
};

function txServiceFalso(tx: Tx): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
}

function nucleoFalso() {
  return {
    cuenta: jest.fn((_ctx: unknown, codigo: string) =>
      Promise.resolve(
        codigo === '220505'
          ? { id: 'cta-proveedores' }
          : codigo === '240810'
            ? { id: 'cta-iva-descontable' }
            : null,
      ),
    ),
  } as unknown as ConstructorParameters<typeof CompraNotaService>[1];
}

function inventarioFalso(producto: Record<string, unknown> | null = null) {
  return {
    producto: jest.fn((_ctx: unknown, id: string) =>
      Promise.resolve(
        producto ??
          (id === 'p-1'
            ? { ...productoFlete, id: 'p-1', codigo: 'P-1' }
            : productoFlete),
      ),
    ),
  } as unknown as ConstructorParameters<typeof CompraNotaService>[2];
}

function contabilidadFalso(periodoAbierto = true) {
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-nota', numero: 'CE-000010' }),
  );
  const fake = {
    periodoAbiertoEn: jest.fn(() => Promise.resolve(periodoAbierto)),
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve({ id: 'comp-ce' })),
    asentar,
  } as unknown as ConstructorParameters<typeof CompraNotaService>[3];
  return { fake, asentar };
}

function comprasFalso(compra: CompraDocumentoDetalle = compraVigente) {
  return {
    porId: jest.fn((_ctx: unknown, id: string) =>
      Promise.resolve(id === 'c-1' ? compra : { ...compra, id }),
    ),
  } as unknown as ConstructorParameters<typeof CompraNotaService>[4];
}

function txFalso(
  yaDevuelto: Array<{ linea_origen_id: string; cantidad: string }> = [],
) {
  const insertadas: Array<[string, unknown[]]> = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('sum(l.cantidad)')) return yaDevuelto;
      if (sql.startsWith('INSERT')) {
        insertadas.push([sql, params ?? []]);
        if (sql.includes('INSERT INTO compra_documento\n')) {
          const [id, , tipo] = params as unknown[];
          return [{ id, tipo, documento_origen_id: 'c-1' }];
        }
        if (sql.includes('INSERT INTO compra_documento_linea')) {
          const [, , orden] = params as unknown[];
          return [{ id: `ln-${String(orden)}`, orden }];
        }
        return [];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, insertadas };
}

describe('CompraNotaService.crearNotaCredito', () => {
  it('arma el asiento de la compra al revés, con la retención proporcional', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      comprasFalso(),
    );

    // Se devuelven 2 de las 10: subtotal 200.000, IVA 38.000, total 238.000.
    // La retención baja en la misma proporción: 29.750 * (238000/1190000) =
    // 5.950, y el neto queda 232.050.
    await servicio.crearNotaCredito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NCP-7',
      motivo: 'Dos unidades llegaron rotas',
      lineas: [{ lineaOrigenId: 'lc-1', cantidad: 2 }],
    });

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      {
        cuentaId: 'cta-proveedores',
        terceroId: 'prov-1',
        debito: 232050,
        credito: 0,
      },
      {
        cuentaId: 'cta-retefuente',
        terceroId: 'prov-1',
        baseGravable: 200000,
        debito: 5950,
        credito: 0,
      },
      { cuentaId: 'cta-inventario', debito: 0, credito: 200000 },
      {
        cuentaId: 'cta-iva-descontable',
        baseGravable: 200000,
        debito: 0,
        credito: 38000,
      },
    ]);
    const totalDebito = dtoAsiento.lineas.reduce((s, l) => s + l.debito, 0);
    const totalCredito = dtoAsiento.lineas.reduce((s, l) => s + l.credito, 0);
    expect(totalDebito).toBe(totalCredito);
  });

  it('la línea de la nota queda enlazada a la línea de la compra', async () => {
    const { tx, insertadas } = txFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      comprasFalso(),
    );

    await servicio.crearNotaCredito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NCP-7',
      motivo: 'Dos unidades llegaron rotas',
      lineas: [{ lineaOrigenId: 'lc-1', cantidad: 2 }],
    });

    const linea = insertadas.find(([sql]) =>
      sql.includes('INSERT INTO compra_documento_linea'),
    )!;
    expect(linea[1][3]).toBe('p-1');
    expect(linea[1][11]).toBe('lc-1');
  });

  it('rechaza devolver más de lo que queda pendiente', async () => {
    const { tx } = txFalso([{ linea_origen_id: 'lc-1', cantidad: '9' }]);
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      comprasFalso(),
    );

    await expect(
      servicio.crearNotaCredito(ctx, {
        documentoOrigenId: 'c-1',
        fecha: '2026-09-12',
        numeroNotaProveedor: 'NCP-8',
        motivo: 'Intento de más',
        lineas: [{ lineaOrigenId: 'lc-1', cantidad: 2 }],
      }),
    ).rejects.toThrow(/quedan 1 por devolver de las 10 compradas/);
  });

  it('rechaza una nota sobre otra nota', async () => {
    const { tx } = txFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      comprasFalso({ ...compraVigente, tipo: 'NOTA_CREDITO' }),
    );

    await expect(
      servicio.crearNotaCredito(ctx, {
        documentoOrigenId: 'c-1',
        fecha: '2026-09-12',
        numeroNotaProveedor: 'NCP-9',
        motivo: 'Sobre una nota',
      }),
    ).rejects.toThrow(/no sobre otra nota/);
  });

  it('rechaza si el período de esa fecha está cerrado', async () => {
    const { tx } = txFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso(false).fake,
      comprasFalso(),
    );

    await expect(
      servicio.crearNotaCredito(ctx, {
        documentoOrigenId: 'c-1',
        fecha: '2026-09-12',
        numeroNotaProveedor: 'NCP-10',
        motivo: 'Período cerrado',
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('CompraNotaService.crearNotaDebito', () => {
  it('va en el mismo sentido que la compra: débito lo que entra, crédito lo que se debe', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(productoFlete),
      contabilidad,
      comprasFalso(),
    );

    await servicio.crearNotaDebito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NDP-3',
      motivo: 'Flete que el proveedor cobró aparte',
      lineas: [{ productoId: 'p-flete', cantidad: 1, costoUnitario: 80000 }],
    });

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-inventario', debito: 80000, credito: 0 },
      {
        cuentaId: 'cta-iva-descontable',
        baseGravable: 80000,
        debito: 15200,
        credito: 0,
      },
      {
        cuentaId: 'cta-proveedores',
        terceroId: 'prov-1',
        debito: 0,
        credito: 95200,
      },
    ]);
    const totalDebito = dtoAsiento.lineas.reduce((s, l) => s + l.debito, 0);
    const totalCredito = dtoAsiento.lineas.reduce((s, l) => s + l.credito, 0);
    expect(totalDebito).toBe(totalCredito);
  });

  it('rechaza el mismo producto en dos líneas', async () => {
    const { tx } = txFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(productoFlete),
      contabilidadFalso().fake,
      comprasFalso(),
    );

    await expect(
      servicio.crearNotaDebito(ctx, {
        documentoOrigenId: 'c-1',
        fecha: '2026-09-12',
        numeroNotaProveedor: 'NDP-4',
        motivo: 'Dos fletes',
        lineas: [
          { productoId: 'p-flete', cantidad: 1, costoUnitario: 80000 },
          { productoId: 'p-flete', cantidad: 1, costoUnitario: 20000 },
        ],
      }),
    ).rejects.toThrow(/No repitas el mismo producto/);
  });
});
