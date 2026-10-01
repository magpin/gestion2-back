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
  clase_documento: 'FACTURA_ELECTRONICA',
  transmision: null,
  cufe: null,
  documento_origen_id: null,
  tercero_id: 'prov-1',
  tercero_nombre: 'Proveedor uno',
  tercero_identificacion: 'NIT 800100200-1',
  fecha: '2026-09-10',
  vence: null,
  descuento_pp_pct: null,
  descuento_pp_hasta: null,
  numero_factura_proveedor: 'FP-500',
  estado: 'EMITIDA',
  subtotal: '1000000',
  total_iva: '190000',
  total: '1190000',
  total_retenciones: '29750',
  neto_a_pagar: '1160250',
  monto_pagado: '0',
  ajuste_notas: '0',
  neto_efectivo: '1160250',
  pendiente: '1160250',
  saldo_a_favor: '0',
  asiento_id: 'asiento-compra',
  lineas: [
    {
      id: 'lc-1',
      compra_documento_id: 'c-1',
      orden: 1,
      producto_id: 'p-1',
      producto_codigo: 'P-1',
      producto_nombre: 'Producto uno',
      // La cuenta que se debitó al comprar: la nota crédito la toma de acá,
      // sin volver a preguntarle al producto.
      cuenta_id: 'cuenta-inventario',
      cuenta_codigo: '143505',
      cuenta_nombre: 'Mercancías',
      detalle: null,
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
    // Las notas resuelven el producto y la cuenta de gasto con los mismos
    // ayudantes que la compra: una sola regla para los dos caminos.
    productoDeLinea: jest.fn((_ctx: unknown, id: string) =>
      Promise.resolve(
        id === 'p-1'
          ? { ...productoFlete, id: 'p-1', codigo: 'P-1' }
          : productoFlete,
      ),
    ),
    cuentaDeGasto: jest.fn((_ctx: unknown, id: string) => Promise.resolve(id)),
  } as unknown as ConstructorParameters<typeof CompraNotaService>[4];
}

/**
 * El motor de retenciones de mentira: sin retenciones propias del motor (las
 * de la compra de prueba son de antes de él) salvo que se pasen previstas.
 */
function retencionesFalso(
  previstas = new Map<string, { base: number; valor: number }>(),
) {
  return {
    reversarRenta: jest.fn(() => Promise.resolve(new Map())),
    reversaRentaPrevista: jest.fn(() => Promise.resolve(previstas)),
  } as never;
}

function txFalso(
  yaDevuelto: Array<{ linea_origen_id: string; cantidad: string }> = [],
) {
  const insertadas: Array<[string, unknown[]]> = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('sum(l.cantidad)')) return yaDevuelto;
      // El candado sobre la compra, contra una anulación simultánea.
      if (sql.includes('FOR SHARE')) return [{ '?column?': 1 }];
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
      retencionesFalso(),
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
      { cuentaId: 'cuenta-inventario', debito: 0, credito: 200000 },
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

  it('bug 4: con la retención del motor, el asiento reversa lo que reversa el motor (con el ajuste y al peso)', async () => {
    // La compra retuvo 29.750 y un recálculo le ajustó +5.000: lo vivo son
    // 34.750. Se devuelve 1 de 10 (10 %). Antes el asiento reversaba el 10 %
    // de lo registrado al comprar, en centavos (2.975,00), y el motor 3.475:
    // la 2365 y el 350 no cuadraban.
    const compra: CompraDocumentoDetalle = {
      ...compraVigente,
      retenciones: [
        {
          ...compraVigente.retenciones[0],
          concepto: 'COMPRAS_GENERALES',
          retencion_calculada_id: 'rc-1',
        },
      ],
    };
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const retenciones = retencionesFalso(
      new Map([['rc-1', { base: 100000, valor: 3475 }]]),
    );
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      comprasFalso(compra),
      retenciones,
    );

    await servicio.crearNotaCredito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NCP-8',
      motivo: 'Una unidad llegó rota',
      lineas: [{ lineaOrigenId: 'lc-1', cantidad: 1 }],
    });

    expect(
      (retenciones as { reversaRentaPrevista: jest.Mock }).reversaRentaPrevista,
    ).toHaveBeenCalledWith({ compraId: 'c-1', proporcion: 0.1 }, tx);
    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      {
        cuentaId: 'cta-proveedores',
        terceroId: 'prov-1',
        debito: 115525,
        credito: 0,
      },
      {
        cuentaId: 'cta-retefuente',
        terceroId: 'prov-1',
        baseGravable: 100000,
        debito: 3475,
        credito: 0,
      },
      { cuentaId: 'cuenta-inventario', debito: 0, credito: 100000 },
      {
        cuentaId: 'cta-iva-descontable',
        baseGravable: 100000,
        debito: 0,
        credito: 19000,
      },
    ]);
  });

  it('bug 4: si al motor ya no le queda nada de esa retención, el asiento tampoco la reversa', async () => {
    const compra: CompraDocumentoDetalle = {
      ...compraVigente,
      retenciones: [
        { ...compraVigente.retenciones[0], retencion_calculada_id: 'rc-1' },
      ],
    };
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      comprasFalso(compra),
      retencionesFalso(),
    );

    await servicio.crearNotaCredito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NCP-9',
      motivo: 'Una unidad llegó rota',
      lineas: [{ lineaOrigenId: 'lc-1', cantidad: 1 }],
    });

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string }> },
    ];
    expect(dtoAsiento.lineas.map((l) => l.cuentaId)).not.toContain(
      'cta-retefuente',
    );
  });

  it('la línea de la nota queda enlazada a la línea de la compra', async () => {
    const { tx, insertadas } = txFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      comprasFalso(),
      retencionesFalso(),
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
    // La cuenta y el detalle vienen de la línea original, no del producto.
    expect(linea[1][4]).toBe('cuenta-inventario');
    expect(linea[1][13]).toBe('lc-1');
  });

  it('rechaza devolver más de lo que queda pendiente', async () => {
    const { tx } = txFalso([{ linea_origen_id: 'lc-1', cantidad: '9' }]);
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      comprasFalso(),
      retencionesFalso(),
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
      retencionesFalso(),
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
      retencionesFalso(),
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
  /** El motor de renta: lo que retenga (Fase 8, §8.7). */
  const motorRenta = (
    retenciones: Array<{ valor: number; base: number; cuentaId: string }> = [],
  ) => {
    const confirmarRenta = jest.fn(() =>
      Promise.resolve({
        decision: retenciones.length > 0 ? 'CALCULADA' : 'NO_SUJETO',
        motivo: '',
        retenciones: retenciones.map((r, i) => ({
          impuesto: 'RENTA',
          municipio: null,
          asumida: false,
          conceptoCodigo: 'SERVICIOS_GENERALES',
          conceptoNacionalId: 'n-servicios',
          nombre: 'Servicios generales',
          renglones: [1],
          base: r.base,
          tarifa: 4,
          valor: r.valor,
          cuentaId: r.cuentaId,
          texto: '',
          explicacion: {},
          retencionCalculadaId: `rc-${i}`,
        })),
      }),
    );
    return {
      fake: {
        confirmarRenta,
        reversarRenta: jest.fn(() => Promise.resolve(new Map())),
      } as never,
      confirmarRenta,
    };
  };

  it('va en el mismo sentido que la compra: débito lo que entra, crédito lo que se debe', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(productoFlete),
      contabilidad,
      comprasFalso(),
      motorRenta().fake,
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

  it('lo que cobra de más lleva retención, como la compra', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const motor = motorRenta([
      { base: 80000, valor: 3200, cuentaId: 'cta-rete-servicios' },
    ]);
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(productoFlete),
      contabilidad,
      comprasFalso(),
      motor.fake,
    );

    await servicio.crearNotaDebito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NDP-4',
      motivo: 'Flete que el proveedor cobró aparte',
      lineas: [{ productoId: 'p-flete', cantidad: 1, costoUnitario: 80000 }],
    });

    expect(motor.confirmarRenta).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ terceroId: 'prov-1', fecha: '2026-09-12' }),
      { conceptos: undefined },
      { tipo: 'NOTA_DEBITO_COMPRA', id: expect.any(String) as unknown },
      tx,
    );
    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
    ];
    expect(dtoAsiento.lineas).toContainEqual({
      cuentaId: 'cta-rete-servicios',
      terceroId: 'prov-1',
      baseGravable: 80000,
      debito: 0,
      credito: 3200,
    });
    // Al proveedor se le debe el total menos lo retenido.
    expect(dtoAsiento.lineas).toContainEqual({
      cuentaId: 'cta-proveedores',
      terceroId: 'prov-1',
      debito: 0,
      credito: 92000,
    });
  });

  it('«sin retención» con motivo no pasa por el motor', async () => {
    const { tx } = txFalso();
    const motor = motorRenta();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(productoFlete),
      contabilidadFalso().fake,
      comprasFalso(),
      motor.fake,
    );

    await servicio.crearNotaDebito(ctx, {
      documentoOrigenId: 'c-1',
      fecha: '2026-09-12',
      numeroNotaProveedor: 'NDP-5',
      motivo: 'Flete que el proveedor cobró aparte',
      lineas: [{ productoId: 'p-flete', cantidad: 1, costoUnitario: 80000 }],
      sinRetencionMotivo: 'El proveedor es autorretenedor',
    });

    expect(motor.confirmarRenta).not.toHaveBeenCalled();
  });

  it('rechaza el mismo producto en dos líneas', async () => {
    const { tx } = txFalso();
    const servicio = new CompraNotaService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(productoFlete),
      contabilidadFalso().fake,
      comprasFalso(),
      motorRenta().fake,
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
    ).rejects.toThrow(/No repita el mismo producto/);
  });
});
