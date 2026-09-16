import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { PagarDto } from '../dto/compra.dto';
import { CompraService } from './compra.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['COMPRAS'],
};

const proveedorActivo = {
  id: 'ter-1',
  activo: true,
  esCliente: false,
  esProveedor: true,
  responsableIva: true,
};

const productoActivo = {
  id: 'p-1',
  codigo: 'FER-001',
  nombre: 'Taladro',
  iva_tarifa: '19.00',
  cuenta_inventario_id: 'cta-inv',
  activo: true,
};

function txServiceFalso(tx: Tx): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
}

function nucleoFalso(
  opciones: {
    proveedor?: Record<string, unknown> | null;
    regimen?: string[];
    cuentas?: Record<string, { id: string } | null>;
  } = {},
) {
  const {
    proveedor = proveedorActivo,
    regimen = ['RESPONSABLE_IVA'],
    cuentas = {
      '220505': { id: 'cta-proveedores' },
      '240810': { id: 'cta-iva-descontable' },
      '236540': { id: 'cta-rete-compras' },
    },
  } = opciones;
  const cuenta = jest.fn((_ctx: unknown, codigo: string) =>
    Promise.resolve(cuentas[codigo] ?? null),
  );
  const fake = {
    buscarTercero: jest.fn(() => Promise.resolve(proveedor)),
    regimenVigente: jest.fn(() => Promise.resolve(regimen)),
    cuenta,
  } as unknown as ConstructorParameters<typeof CompraService>[1];
  return { fake, cuenta };
}

function inventarioFalso(
  opciones: {
    producto?: Record<string, unknown> | null;
  } = {},
) {
  const { producto = productoActivo } = opciones;
  // `incrementarPorCompra` queda suelto, sin pasar por el cast: leerlo a
  // través del objeto casteado dispara `unbound-method` (mismo motivo que
  // ya documentó `factura.service.spec.ts` para `cuenta`/`tomarConsecutivo`).
  const incrementarPorCompra = jest.fn(() =>
    Promise.resolve({ movimientoId: 'mov-1' }),
  );
  const fake = {
    producto: jest.fn(() => Promise.resolve(producto)),
    incrementarPorCompra,
  } as unknown as ConstructorParameters<typeof CompraService>[2];
  return { fake, incrementarPorCompra };
}

function contabilidadFalso(
  opciones: {
    periodoAbierto?: boolean;
    comprobante?: { id: string } | null;
  } = {},
) {
  const { periodoAbierto = true, comprobante = { id: 'comp-ce' } } = opciones;
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-1', numero: 'CE-000001' }),
  );
  const fake = {
    periodoAbiertoEn: jest.fn(() => Promise.resolve(periodoAbierto)),
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve(comprobante)),
    asentar,
  } as unknown as ConstructorParameters<typeof CompraService>[3];
  return { fake, asentar };
}

/** Transacción falsa: los tres `INSERT` de compra_documento[_linea|_retencion]. */
function txFalso() {
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO compra_documento\n')) {
        const [
          id,
          ,
          terceroId,
          fecha,
          numeroFactura,
          subtotal,
          totalIva,
          total,
          totalRetenciones,
          neto,
          asientoId,
        ] = params as unknown[];
        return [
          {
            id,
            tercero_id: terceroId,
            fecha,
            numero_factura_proveedor: numeroFactura,
            estado: 'EMITIDA',
            subtotal: String(subtotal),
            total_iva: String(totalIva),
            total: String(total),
            total_retenciones: String(totalRetenciones),
            neto_a_pagar: String(neto),
            asiento_id: asientoId,
          },
        ];
      }
      if (sql.includes('INSERT INTO compra_documento_linea')) {
        const [
          ,
          compraDocumentoId,
          orden,
          productoId,
          cantidad,
          costoUnitario,
          ivaTarifa,
          subtotal,
          ivaValor,
          total,
          ivaDescontable,
        ] = params as unknown[];
        return [
          {
            id: `linea-${String(orden)}`,
            compra_documento_id: compraDocumentoId,
            orden,
            producto_id: productoId,
            cantidad: String(cantidad),
            costo_unitario: String(costoUnitario),
            iva_tarifa: String(ivaTarifa),
            subtotal: String(subtotal),
            iva_valor: String(ivaValor),
            total: String(total),
            iva_descontable: ivaDescontable,
          },
        ];
      }
      if (sql.includes('INSERT INTO compra_retencion')) {
        const [, compraDocumentoId, concepto, cuentaId, base, valor] =
          params as unknown[];
        return [
          {
            id: `ret-${String(concepto)}`,
            compra_documento_id: compraDocumentoId,
            concepto,
            cuenta_id: cuentaId,
            base: String(base),
            valor: String(valor),
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx };
}

const lineaBase = { productoId: 'p-1', cantidad: 2, costoUnitario: 50000 };

describe('CompraService.crear', () => {
  it('con IVA descontable (empresa responsable): débito inventario por el subtotal, débito IVA aparte', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso().fake,
      contabilidad,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    const compra = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-08',
      numeroFacturaProveedor: 'FP-001',
      lineas: [lineaBase],
    });

    // subtotal = 2*50000=100000; iva 19% = 19000; total = 119000; sin retención.
    expect(compra.subtotal).toBe('100000');
    expect(compra.total_iva).toBe('19000');
    expect(compra.total).toBe('119000');
    expect(compra.total_retenciones).toBe('0');
    expect(compra.neto_a_pagar).toBe('119000');
    expect(compra.lineas[0].costo_unitario).toBe('50000');

    expect(asentar).toHaveBeenCalledTimes(1);
    const [, dtoAsiento, origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
      { origenTipo: string; origenId: string },
    ];
    expect(origen.origenTipo).toBe('COMPRA');
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-inv', debito: 100000, credito: 0 },
      {
        cuentaId: 'cta-iva-descontable',
        baseGravable: 100000,
        debito: 19000,
        credito: 0,
      },
      {
        cuentaId: 'cta-proveedores',
        terceroId: 'ter-1',
        debito: 0,
        credito: 119000,
      },
    ]);

    const totalDebito = dtoAsiento.lineas.reduce(
      (s, l) => s + (l.debito as number),
      0,
    );
    const totalCredito = dtoAsiento.lineas.reduce(
      (s, l) => s + (l.credito as number),
      0,
    );
    expect(totalDebito).toBe(totalCredito);
  });

  it('con IVA NO descontable (empresa no responsable): el IVA se suma al débito de inventario', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ regimen: [] }).fake,
      inventarioFalso().fake,
      contabilidad,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    const compra = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-08',
      numeroFacturaProveedor: 'FP-002',
      lineas: [lineaBase],
    });

    expect(compra.neto_a_pagar).toBe('119000');

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    // Sin línea de IVA descontable — todo el IVA quedó en inventario.
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-inv', debito: 119000, credito: 0 },
      {
        cuentaId: 'cta-proveedores',
        terceroId: 'ter-1',
        debito: 0,
        credito: 119000,
      },
    ]);
  });

  it('sinIva baja la tarifa a cero aunque el proveedor sea responsable', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      // Proveedor responsable y empresa responsable: por configuración, esta
      // línea liquidaría 19%.
      nucleoFalso().fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never,
    );

    const compra = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-08',
      numeroFacturaProveedor: 'FP-900',
      lineas: [
        { productoId: 'p-1', cantidad: 1, costoUnitario: 100000, sinIva: true },
      ],
    });

    // Manda lo que dice la factura del proveedor, no lo que dicen las dos
    // condiciones.
    expect(compra.total_iva).toBe('0');
  });

  it('sin IVA (proveedor no responsable, tarifa forzada a 0)', async () => {
    const { tx } = txFalso();
    const { fake: nucleo } = nucleoFalso({
      proveedor: { ...proveedorActivo, responsableIva: false },
    });
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleo,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    const compra = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-08',
      numeroFacturaProveedor: 'FP-003',
      lineas: [lineaBase],
    });

    expect(compra.total_iva).toBe('0');
    expect(compra.total).toBe('100000');
  });

  it('con retención: crédito a la cuenta del concepto y el neto a pagar descuenta lo retenido', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ regimen: ['RESPONSABLE_IVA', 'AGENTE_RETENEDOR_RENTA'] })
        .fake,
      inventarioFalso().fake,
      contabilidad,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    const compra = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-08',
      numeroFacturaProveedor: 'FP-004',
      lineas: [lineaBase],
      retenciones: [{ concepto: 'COMPRAS', base: 100000, valor: 2500 }],
    });

    expect(compra.total_retenciones).toBe('2500');
    expect(compra.neto_a_pagar).toBe('116500');
    expect(compra.retenciones).toHaveLength(1);
    expect(compra.retenciones[0].cuenta_id).toBe('cta-rete-compras');

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-inv', debito: 100000, credito: 0 },
      {
        cuentaId: 'cta-iva-descontable',
        baseGravable: 100000,
        debito: 19000,
        credito: 0,
      },
      {
        cuentaId: 'cta-rete-compras',
        terceroId: 'ter-1',
        baseGravable: 100000,
        debito: 0,
        credito: 2500,
      },
      {
        cuentaId: 'cta-proveedores',
        terceroId: 'ter-1',
        debito: 0,
        credito: 116500,
      },
    ]);
    const totalDebito = dtoAsiento.lineas.reduce(
      (s, l) => s + (l.debito as number),
      0,
    );
    const totalCredito = dtoAsiento.lineas.reduce(
      (s, l) => s + (l.credito as number),
      0,
    );
    expect(totalDebito).toBe(totalCredito);
  });

  it('rechaza una retención si la empresa no es agente de retención', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ regimen: ['RESPONSABLE_IVA'] }).fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-005',
        lineas: [lineaBase],
        retenciones: [{ concepto: 'COMPRAS', base: 100000, valor: 2500 }],
      }),
    ).rejects.toThrow(/no es agente de retención/);
  });

  it('rechaza si lo retenido supera el total de la factura', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ regimen: ['AGENTE_RETENEDOR_RENTA'] }).fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-006',
        lineas: [lineaBase],
        retenciones: [{ concepto: 'COMPRAS', base: 200000, valor: 200000 }],
      }),
    ).rejects.toThrow(/no puede superar el total/);
  });

  it('rechaza si no existe la cuenta del concepto retenido', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({
        regimen: ['AGENTE_RETENEDOR_RENTA'],
        cuentas: {
          '220505': { id: 'cta-proveedores' },
          '240810': { id: 'cta-iva-descontable' },
        },
      }).fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-007',
        lineas: [lineaBase],
        retenciones: [{ concepto: 'COMPRAS', base: 100000, valor: 2500 }],
      }),
    ).rejects.toThrow(/cuenta de retención por compras/);
  });

  it('rechaza dos retenciones con el mismo concepto', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ regimen: ['AGENTE_RETENEDOR_RENTA'] }).fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-008',
        lineas: [lineaBase],
        retenciones: [
          { concepto: 'COMPRAS', base: 50000, valor: 1000 },
          { concepto: 'COMPRAS', base: 50000, valor: 1000 },
        ],
      }),
    ).rejects.toThrow(/No repitas el mismo concepto/);
  });

  it('rechaza si el mismo producto aparece en dos líneas', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-009',
        lineas: [lineaBase, lineaBase],
      }),
    ).rejects.toThrow(/No repitas el mismo producto/);
  });

  it('rechaza si el período está cerrado', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso().fake,
      contabilidadFalso({ periodoAbierto: false }).fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-01-05',
        numeroFacturaProveedor: 'FP-010',
        lineas: [lineaBase],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza si el tercero no existe', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ proveedor: null }).fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'inexistente',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-011',
        lineas: [lineaBase],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza si el tercero no está marcado como proveedor', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ proveedor: { ...proveedorActivo, esProveedor: false } })
        .fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-012',
        lineas: [lineaBase],
      }),
    ).rejects.toThrow(/no está marcado como proveedor/);
  });

  it('rechaza si el producto no existe o está inactivo', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso({ producto: null }).fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-013',
        lineas: [lineaBase],
      }),
    ).rejects.toThrow(/no existe o está inactivo/);
  });

  it('rechaza si no existe la cuenta de proveedores (220505)', async () => {
    const { tx } = txFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: {} }).fake,
      inventarioFalso().fake,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-08',
        numeroFacturaProveedor: 'FP-014',
        lineas: [lineaBase],
      }),
    ).rejects.toThrow(/cuenta de proveedores/);
  });

  it('incrementa el kardex después de asentar, con el costo ya resuelto', async () => {
    const { tx } = txFalso();
    const { fake: inventario, incrementarPorCompra } = inventarioFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ regimen: [] }).fake, // no responsable: IVA se suma al costo
      inventario,
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-08',
      numeroFacturaProveedor: 'FP-015',
      lineas: [lineaBase],
    });

    expect(incrementarPorCompra).toHaveBeenCalledWith(
      ctx,
      'p-1',
      2,
      59500, // (100000+19000)/2 — el IVA no descontable prorrateado.
      '2026-09-08',
      expect.stringContaining('FP-015'),
      'asiento-1',
      tx,
    );
  });
});

describe('CompraService.listar', () => {
  it('pagina y filtra por proveedor', async () => {
    const documentoFila = {
      id: 'c-1',
      tercero_id: 'ter-1',
      fecha: '2026-09-08',
      numero_factura_proveedor: 'FP-001',
      estado: 'EMITIDA',
      subtotal: '100000',
      total_iva: '19000',
      total: '119000',
      total_retenciones: '0',
      neto_a_pagar: '119000',
      asiento_id: 'asiento-1',
    };
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('count(*)')) return [{ total: '1' }];
        if (sql.includes('FROM compra_documento')) return [documentoFila];
        throw new Error(`Query inesperada: ${sql}`);
      }),
    } as unknown as Tx;
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      {} as never,
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    const pagina = await servicio.listar(ctx, {
      terceroId: 'ter-1',
      pagina: 1,
      tamano: 50,
      salto: 0,
    });

    expect(pagina.total).toBe(1);
    expect(pagina.datos[0].numero_factura_proveedor).toBe('FP-001');
  });
});

describe('CompraService.porId', () => {
  const documentoFila = {
    id: 'c-1',
    tipo: 'FACTURA',
    documento_origen_id: null,
    tercero_id: 'ter-1',
    fecha: '2026-09-08',
    numero_factura_proveedor: 'FP-001',
    estado: 'EMITIDA',
    subtotal: '100000',
    total_iva: '19000',
    total: '119000',
    total_retenciones: '2500',
    neto_a_pagar: '116500',
    asiento_id: 'asiento-1',
  };
  const lineaFila = {
    id: 'linea-1',
    compra_documento_id: 'c-1',
    orden: 1,
    producto_id: 'p-1',
    cantidad: '2',
    costo_unitario: '50000',
    iva_tarifa: '19',
    subtotal: '100000',
    iva_valor: '19000',
    total: '119000',
    iva_descontable: true,
  };
  const retencionFila = {
    id: 'ret-1',
    compra_documento_id: 'c-1',
    concepto: 'COMPRAS',
    cuenta_id: 'cta-rete-compras',
    base: '100000',
    valor: '2500',
  };

  it('devuelve la compra con sus líneas y retenciones', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        // La de las notas primero: también sale de `compra_documento`, y es
        // la que distingue "esta compra" de "las notas que le apuntan".
        if (sql.includes('documento_origen_id = $1')) return [];
        if (sql.includes('FROM compra_documento WHERE')) return [documentoFila];
        if (sql.includes('FROM compra_documento_linea')) return [lineaFila];
        if (sql.includes('FROM compra_retencion')) return [retencionFila];
        throw new Error(`Query inesperada: ${sql}`);
      }),
    } as unknown as Tx;
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      {} as never,
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    const detalle = await servicio.porId(ctx, 'c-1');
    expect(detalle.neto_a_pagar).toBe('116500');
    expect(detalle.lineas).toHaveLength(1);
    expect(detalle.retenciones).toHaveLength(1);
  });

  it('la nota del proveedor trae su factura, y la factura sus notas', async () => {
    const notaFila = {
      ...documentoFila,
      id: 'cn-1',
      tipo: 'NOTA_CREDITO',
      documento_origen_id: 'c-1',
      numero_factura_proveedor: 'NCP-7',
      neto_a_pagar: '20000',
    };
    // Las dos consultas a `compra_documento` son idénticas en texto —el
    // documento pedido y su origen—: lo que las separa es el id que llevan.
    const consulta = (pedidoId: string) =>
      jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('documento_origen_id = $1')) {
          return pedidoId === 'c-1' ? [notaFila] : [];
        }
        if (sql.includes('FROM compra_documento WHERE')) {
          const [buscado] = params as unknown[];
          return [buscado === 'cn-1' ? notaFila : documentoFila];
        }
        if (sql.includes('FROM compra_documento_linea')) return [];
        if (sql.includes('FROM compra_retencion')) return [];
        throw new Error(`Query inesperada: ${sql}`);
      });
    const servicioCon = (pedidoId: string) =>
      new CompraService(
        txServiceFalso({ query: consulta(pedidoId) } as unknown as Tx),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );

    const nota = await servicioCon('cn-1').porId(ctx, 'cn-1');
    expect(nota.documento_origen?.numero_factura_proveedor).toBe('FP-001');
    expect(nota.notas).toEqual([]);

    const compra = await servicioCon('c-1').porId(ctx, 'c-1');
    expect(compra.documento_origen).toBeNull();
    expect(compra.notas).toHaveLength(1);
    expect(compra.notas?.[0].tipo).toBe('NOTA_CREDITO');
  });

  it('lanza NotFoundException si no existe', async () => {
    const tx = { query: jest.fn(() => []) } as unknown as Tx;
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      {} as never,
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(servicio.porId(ctx, 'inexistente')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CompraService.anular', () => {
  function contabilidadAnularFalso() {
    const anular = jest.fn(() => Promise.resolve());
    const fake = {
      anular,
    } as unknown as ConstructorParameters<typeof CompraService>[3];
    return { fake, anular };
  }

  const LINEA = {
    producto_id: 'p-1',
    producto_codigo: 'TEC-1',
    cantidad: '5.000000',
  };

  function txAnularFalso(
    documento:
      | {
          estado: string;
          asiento_id: string;
          monto_pagado?: string;
          numero_factura_proveedor?: string;
        }
      | undefined,
  ) {
    const actualizaciones: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT estado, asiento_id')) {
          return documento === undefined
            ? []
            : [
                {
                  monto_pagado: '0',
                  numero_factura_proveedor: 'FV-1',
                  ...documento,
                },
              ];
        }
        if (sql.includes('FROM compra_documento_linea')) {
          return [LINEA];
        }
        if (sql.includes('UPDATE compra_documento')) {
          actualizaciones.push(params ?? []);
          return [];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizaciones };
  }

  /** El kardex con `disponible` unidades del producto de la línea. */
  function inventarioAnularFalso(disponible: number) {
    const revertir = jest.fn(() => Promise.resolve({ movimientoId: 'm-1' }));
    const fake = {
      saldoActual: jest.fn(() =>
        Promise.resolve({ cantidad: disponible, costoPromedio: 1000 }),
      ),
      revertirPorAnulacionCompra: revertir,
    } as unknown as ConstructorParameters<typeof CompraService>[2];
    return { fake, revertir };
  }

  it('anula el asiento, devuelve el kardex y marca la compra, en la misma transacción', async () => {
    const { tx, actualizaciones } = txAnularFalso({
      estado: 'EMITIDA',
      asiento_id: 'asiento-1',
    });
    const { fake: contabilidad, anular: anularAsiento } =
      contabilidadAnularFalso();
    const { fake: inventario, revertir } = inventarioAnularFalso(5);
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      inventario,
      contabilidad,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await servicio.anular(ctx, 'c-1', 'Factura duplicada por error');

    expect(anularAsiento).toHaveBeenCalledWith(
      ctx,
      'asiento-1',
      'Factura duplicada por error',
      tx,
    );
    expect(revertir).toHaveBeenCalledWith(
      ctx,
      'p-1',
      5,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringContaining('FV-1'),
      'asiento-1',
      tx,
    );
    expect(actualizaciones).toHaveLength(1);
  });

  it('rechaza anular si parte de la mercancía ya salió del kardex', async () => {
    const { tx, actualizaciones } = txAnularFalso({
      estado: 'EMITIDA',
      asiento_id: 'asiento-1',
    });
    const { fake: contabilidad, anular: anularAsiento } =
      contabilidadAnularFalso();
    const { fake: inventario, revertir } = inventarioAnularFalso(3);
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      inventario,
      contabilidad,
      {} as never,
    );

    await expect(servicio.anular(ctx, 'c-1', 'Motivo')).rejects.toThrow(
      /solo quedan 3/,
    );
    expect(anularAsiento).not.toHaveBeenCalled();
    expect(revertir).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza anular una compra con pagos registrados', async () => {
    const { tx } = txAnularFalso({
      estado: 'EMITIDA',
      asiento_id: 'asiento-1',
      monto_pagado: '40000',
    });
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      inventarioAnularFalso(5).fake,
      contabilidadAnularFalso().fake,
      {} as never,
    );

    await expect(servicio.anular(ctx, 'c-1', 'Motivo')).rejects.toThrow(
      /pagos registrados/,
    );
  });

  it('rechaza anular una compra ya anulada', async () => {
    const { tx } = txAnularFalso({
      estado: 'ANULADA',
      asiento_id: 'asiento-1',
    });
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      {} as never,
      contabilidadAnularFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.anular(ctx, 'c-1', 'Motivo cualquiera'),
    ).rejects.toThrow(/ya está anulada/);
  });

  it('lanza NotFoundException si la compra no existe', async () => {
    const { tx } = txAnularFalso(undefined);
    const servicio = new CompraService(
      txServiceFalso(tx),
      {} as never,
      {} as never,
      contabilidadAnularFalso().fake,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.anular(ctx, 'inexistente', 'Motivo cualquiera'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CompraService.pagar', () => {
  const DTO: PagarDto = {
    fecha: '2026-09-12',
    pagos: [{ medio: 'CAJA', cajaId: 'c-1', valor: 40000 }],
  };

  /** El mismo pago por caja, por otro valor. */
  const porValor = (valor: number): PagarDto => ({
    ...DTO,
    pagos: [{ ...DTO.pagos[0], valor }],
  });

  function tesoreriaFalso() {
    const registrarPago = jest.fn(() =>
      Promise.resolve({ movimientoId: 'mov-1', asientoId: 'asiento-1' }),
    );
    const fake = {
      registrarPago,
    } as unknown as ConstructorParameters<typeof CompraService>[4];
    return { fake, registrarPago };
  }

  function txPagarFalso(
    documento:
      | {
          tercero_id: string;
          estado: string;
          numero_factura_proveedor: string;
          neto_a_pagar: string;
          monto_pagado: string;
          ajuste_notas: string;
        }
      | undefined,
  ) {
    const actualizaciones: unknown[][] = [];
    // Igual que en ventas: el `neto_efectivo` sale de la consulta, y acá se
    // replica para poder escribir el caso como "esta compra tiene una nota
    // crédito del proveedor por 19.000".
    const netoEfectivo =
      documento === undefined
        ? undefined
        : String(
            Number(documento.neto_a_pagar) + Number(documento.ajuste_notas),
          );
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return documento === undefined
            ? []
            : [{ ...documento, neto_efectivo: netoEfectivo }];
        }
        if (sql.includes('UPDATE compra_documento')) {
          actualizaciones.push(params ?? []);
          const [, montoPagado] = params as unknown[];
          return [
            {
              id: 'compra-1',
              tercero_id: documento?.tercero_id,
              fecha: '2026-09-01',
              numero_factura_proveedor: documento?.numero_factura_proveedor,
              estado: 'EMITIDA',
              subtotal: '0',
              total_iva: '0',
              total: documento?.neto_a_pagar,
              total_retenciones: '0',
              neto_a_pagar: documento?.neto_a_pagar,
              monto_pagado: String(montoPagado),
              asiento_id: 'asiento-original',
            },
          ];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizaciones };
  }

  const COMPRA_BASE = {
    tercero_id: 'ter-1',
    estado: 'EMITIDA',
    numero_factura_proveedor: 'FP-001',
    neto_a_pagar: '94000',
    monto_pagado: '0',
    ajuste_notas: '0',
  };

  it('paga parcialmente y deja monto_pagado corrido, con el concepto y la cuenta correctos', async () => {
    const { tx, actualizaciones } = txPagarFalso(COMPRA_BASE);
    const { fake: tesoreria, registrarPago } = tesoreriaFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria,
    );

    const actualizado = await servicio.pagar(ctx, 'compra-1', DTO);

    expect(actualizado.monto_pagado).toBe('40000');
    expect(actualizaciones).toHaveLength(1);
    expect(registrarPago).toHaveBeenCalledWith(
      ctx,
      {
        medio: 'CAJA',
        cajaId: 'c-1',
        fecha: DTO.fecha,
        valor: 40000,
        concepto: 'Pago de la compra FP-001',
        cuentaProveedoresId: 'cta-proveedores',
        terceroId: 'ter-1',
        compraId: 'compra-1',
      },
      tx,
    );
  });

  it('paga por banco cuando medio es BANCO, con cuentaBancariaId en vez de cajaId', async () => {
    const { tx, actualizaciones } = txPagarFalso(COMPRA_BASE);
    const { fake: tesoreria, registrarPago } = tesoreriaFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria,
    );

    await servicio.pagar(ctx, 'compra-1', {
      fecha: '2026-09-12',
      pagos: [{ medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 40000 }],
    });

    expect(actualizaciones).toHaveLength(1);
    expect(registrarPago).toHaveBeenCalledWith(
      ctx,
      {
        medio: 'BANCO',
        cuentaBancariaId: 'cb-1',
        fecha: '2026-09-12',
        valor: 40000,
        concepto: 'Pago de la compra FP-001',
        cuentaProveedoresId: 'cta-proveedores',
        terceroId: 'ter-1',
        compraId: 'compra-1',
      },
      tx,
    );
  });

  it('rechaza pagar una compra anulada', async () => {
    const { tx } = txPagarFalso({ ...COMPRA_BASE, estado: 'ANULADA' });
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreriaFalso().fake,
    );

    await expect(servicio.pagar(ctx, 'compra-1', DTO)).rejects.toThrow(
      /no está vigente/,
    );
  });

  it('rechaza pagar más de lo que falta, sin llamar a TesoreriaApi ni actualizar nada', async () => {
    const { tx, actualizaciones } = txPagarFalso({
      ...COMPRA_BASE,
      monto_pagado: '80000',
    });
    const { fake: tesoreria, registrarPago } = tesoreriaFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria,
    );

    await expect(
      servicio.pagar(ctx, 'compra-1', porValor(20000)),
    ).rejects.toThrow(BadRequestException);
    expect(registrarPago).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('paga contra el neto efectivo: una nota crédito del proveedor baja el tope', async () => {
    // Neto de 94.000 con una nota crédito de 14.000: se le deben 80.000.
    const conNota = { ...COMPRA_BASE, ajuste_notas: '-14000' };
    const { tx } = txPagarFalso(conNota);
    const { fake: tesoreria, registrarPago } = tesoreriaFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria,
    );

    await expect(
      servicio.pagar(ctx, 'compra-1', porValor(94000)),
    ).rejects.toThrow(/Solo faltan 80000 por pagar/);
    expect(registrarPago).not.toHaveBeenCalled();

    // Y hasta el neto efectivo, sí paga.
    const { tx: tx2 } = txPagarFalso(conNota);
    const { fake: tesoreria2, registrarPago: registrar2 } = tesoreriaFalso();
    const servicio2 = new CompraService(
      txServiceFalso(tx2),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria2,
    );
    await servicio2.pagar(ctx, 'compra-1', porValor(80000));
    expect(registrar2).toHaveBeenCalledTimes(1);
  });

  it('reparte un pago entre caja y banco: dos movimientos, un solo monto_pagado', async () => {
    const { tx, actualizaciones } = txPagarFalso(COMPRA_BASE);
    const { fake: tesoreria, registrarPago } = tesoreriaFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria,
    );

    const actualizado = await servicio.pagar(ctx, 'compra-1', {
      fecha: '2026-09-12',
      pagos: [
        { medio: 'CAJA', cajaId: 'c-1', valor: 14000 },
        { medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 80000 },
      ],
    });

    expect(registrarPago).toHaveBeenCalledTimes(2);
    expect(registrarPago).toHaveBeenNthCalledWith(
      1,
      ctx,
      expect.objectContaining({
        medio: 'CAJA',
        valor: 14000,
        concepto: 'Pago de la compra FP-001 (1 de 2)',
      }),
      expect.anything(),
    );
    expect(registrarPago).toHaveBeenNthCalledWith(
      2,
      ctx,
      expect.objectContaining({
        medio: 'BANCO',
        valor: 80000,
        concepto: 'Pago de la compra FP-001 (2 de 2)',
      }),
      expect.anything(),
    );
    expect(actualizaciones).toHaveLength(1);
    expect(actualizado.monto_pagado).toBe('94000');
  });

  it('rechaza sin llamar a TesoreriaApi si no existe la cuenta de proveedores', async () => {
    const { tx } = txPagarFalso(COMPRA_BASE);
    const { fake: tesoreria, registrarPago } = tesoreriaFalso();
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: {} }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreria,
    );

    await expect(servicio.pagar(ctx, 'compra-1', DTO)).rejects.toThrow(
      /cuenta de proveedores/,
    );
    expect(registrarPago).not.toHaveBeenCalled();
  });

  it('lanza NotFoundException si la compra no existe', async () => {
    const { tx } = txPagarFalso(undefined);
    const servicio = new CompraService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: { '220505': { id: 'cta-proveedores' } } }).fake,
      inventarioFalso().fake,
      {} as never,
      tesoreriaFalso().fake,
    );

    await expect(servicio.pagar(ctx, 'inexistente', DTO)).rejects.toThrow(
      NotFoundException,
    );
  });
});
