import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { FacturaService } from './factura.service';
import type { VentaDocumentoDetalle } from './venta-documento.service';
import { hoyEnColombia } from '../../../common/fecha';

/**
 * Un documento de venta se emite con la fecha de hoy y ninguna otra, así que
 * las entradas de los tests la calculan en vez de escribirla: una fecha fija
 * acá dejaría de pasar mañana.
 */
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
  roles: ['VENTAS'],
};

const clienteActivo = {
  id: 'ter-1',
  activo: true,
  esCliente: true,
  esProveedor: false,
};

const productoActivo = {
  id: 'p-1',
  codigo: 'FER-001',
  nombre: 'Taladro',
  iva_tarifa: '19.00',
  cuenta_inventario_id: 'cta-inv',
  cuenta_costo_venta_id: 'cta-costo',
  cuenta_ingreso_id: 'cta-ingreso',
  activo: true,
};

const numeroFiscal = {
  numero: 'SETP991',
  consecutivo: 991,
  prefijo: 'SETP',
  resolucionId: 'res-1',
  numeroResolucion: '18764000001',
};

function txServiceFalso(tx: Tx): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
}

function nucleoFalso(
  opciones: {
    tercero?: Record<string, unknown> | null;
    responsableIva?: boolean;
    cuentas?: Record<string, { id: string } | null>;
  } = {},
) {
  const {
    tercero = clienteActivo,
    responsableIva = true,
    cuentas = { '130505': { id: 'cta-cartera' }, '240805': { id: 'cta-iva' } },
  } = opciones;
  // Referencias sueltas, sin pasar por el cast: leerlas a través del objeto
  // casteado dispara `unbound-method` porque el tipo declarado (`NucleoApi`)
  // es una clase real, aunque en tiempo de ejecución sea un `jest.fn()`.
  const cuenta = jest.fn((_ctx: unknown, codigo: string) =>
    Promise.resolve(cuentas[codigo] ?? null),
  );
  const tomarConsecutivo = jest.fn(() => Promise.resolve(numeroFiscal));
  const fake = {
    buscarTercero: jest.fn(() => Promise.resolve(tercero)),
    esResponsableDeIva: jest.fn(() => Promise.resolve(responsableIva)),
    cuenta,
    tomarConsecutivo,
  } as unknown as ConstructorParameters<typeof FacturaService>[1];
  return { fake, cuenta, tomarConsecutivo };
}

function inventarioFalso(
  opciones: {
    producto?: Record<string, unknown> | null;
    precio?: number | null;
    costeo?: { costoUnitario: number; valorTotal: number; faltante: number };
  } = {},
) {
  const {
    producto = productoActivo,
    precio = 289900,
    costeo = { costoUnitario: 200000, valorTotal: 200000, faltante: 0 },
  } = opciones;
  return {
    producto: jest.fn(() => Promise.resolve(producto)),
    precioVigente: jest.fn(() => Promise.resolve(precio)),
    costearSalida: jest.fn(() => Promise.resolve(costeo)),
    descontarPorVenta: jest.fn(() =>
      Promise.resolve({ movimientoId: 'mov-1' }),
    ),
  } as unknown as ConstructorParameters<typeof FacturaService>[2];
}

function contabilidadFalso(
  opciones: {
    periodoAbierto?: boolean;
    comprobante?: { id: string } | null;
  } = {},
) {
  const { periodoAbierto = true, comprobante = { id: 'comp-ci' } } = opciones;
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-1', numero: 'CI-000001' }),
  );
  const fake = {
    periodoAbiertoEn: jest.fn(() => Promise.resolve(periodoAbierto)),
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve(comprobante)),
    asentar,
  } as unknown as ConstructorParameters<typeof FacturaService>[3];
  return { fake, asentar };
}

const cotizacionEmitida: VentaDocumentoDetalle = {
  id: 'cot-1',
  tipo: 'COTIZACION',
  tercero_id: 'ter-1',
  tercero_nombre: 'Tercero uno',
  tercero_identificacion: 'NIT 900123456-7',
  fecha: '2026-09-01',
  estado: 'EMITIDA',
  prefijo: 'COT',
  consecutivo: 5,
  resolucion_id: null,
  documento_origen_id: null,
  subtotal: '289900',
  total_iva: '55081',
  total: '344981',
  monto_pagado: '0',
  ajuste_notas: '0',
  saldo_efectivo: '344981',
  total_retenido: '0',
  pendiente: '344981',
  saldo_a_favor: '0',
  asiento_id: null,
  lineas: [
    {
      id: 'cot-linea-1',
      venta_documento_id: 'cot-1',
      orden: 1,
      producto_id: 'p-1',
      producto_codigo: 'P-1',
      producto_nombre: 'Producto uno',
      cantidad: '1',
      precio_unitario: '289900',
      iva_tarifa: '19.00',
      subtotal: '289900',
      iva_valor: '55081',
      total: '344981',
      costo_unitario: null,
    },
  ],
};

function ventasFalso(cotizacion: VentaDocumentoDetalle = cotizacionEmitida) {
  return {
    porId: jest.fn(() => Promise.resolve(cotizacion)),
  } as unknown as ConstructorParameters<typeof FacturaService>[4];
}

/**
 * Transacción falsa: los dos `INSERT` de `venta_documento[_linea]`, más el
 * candado y la marca de `convertirCotizacion` cuando `estadoCotizacion` no
 * es `undefined` (`null` simula que la cotización no existe).
 */
function txFalso(opciones: { estadoCotizacion?: string | null } = {}) {
  const { estadoCotizacion } = opciones;
  const faltantesInsertados: unknown[][] = [];
  const lineasInsertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes("WHERE id = $1 AND tipo = 'COTIZACION'")) {
        return estadoCotizacion === null || estadoCotizacion === undefined
          ? []
          : [{ estado: estadoCotizacion }];
      }
      if (sql.includes("SET estado = 'CONVERTIDA'")) {
        return [];
      }
      if (sql.includes('INSERT INTO venta_faltante')) {
        faltantesInsertados.push(params ?? []);
        return [];
      }
      if (sql.includes('INSERT INTO venta_documento\n')) {
        const [
          id,
          ,
          terceroId,
          fecha,
          prefijo,
          consecutivo,
          resolucionId,
          documentoOrigenId,
          subtotal,
          totalIva,
          total,
          asientoId,
        ] = params as unknown[];
        return [
          {
            id,
            tipo: 'FACTURA',
            tercero_id: terceroId,
            fecha,
            estado: 'EMITIDA',
            prefijo,
            consecutivo,
            resolucion_id: resolucionId,
            documento_origen_id: documentoOrigenId,
            subtotal: String(subtotal),
            total_iva: String(totalIva),
            total: String(total),
            asiento_id: asientoId,
          },
        ];
      }
      if (sql.includes('INSERT INTO venta_documento_linea')) {
        lineasInsertadas.push(params ?? []);
        const [
          ,
          ventaDocumentoId,
          orden,
          productoId,
          cantidad,
          precioUnitario,
          ivaTarifa,
          subtotal,
          ivaValor,
          total,
          costoUnitario,
        ] = params as unknown[];
        return [
          {
            id: `linea-${String(orden)}`,
            venta_documento_id: ventaDocumentoId,
            orden,
            producto_id: productoId,
            cantidad: String(cantidad),
            precio_unitario: String(precioUnitario),
            iva_tarifa: String(ivaTarifa),
            subtotal: String(subtotal),
            iva_valor: String(ivaValor),
            total: String(total),
            costo_unitario: String(costoUnitario),
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, faltantesInsertados, lineasInsertadas };
}

describe('FacturaService.crear', () => {
  it('arma el asiento completo (cartera, ingreso, IVA, costo, inventario) y descuenta el kardex', async () => {
    const { tx } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidad,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    const factura = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: HOY,
      lineas: [{ productoId: 'p-1', cantidad: 2 }],
    });

    // subtotal = 2 * 289900 = 579800; iva 19% = 110162; total = 689962.
    expect(factura.subtotal).toBe('579800');
    expect(factura.total_iva).toBe('110162');
    expect(factura.total).toBe('689962');
    expect(factura.consecutivo).toBe(991);
    expect(factura.resolucion_id).toBe('res-1');
    expect(factura.asiento_id).toBe('asiento-1');
    expect(factura.lineas[0].costo_unitario).toBe('200000');

    expect(asentar).toHaveBeenCalledTimes(1);
    const [, dtoAsiento, origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<{ cuentaId: string; debito: number; credito: number }> },
      { origenTipo: string; origenId: string },
    ];
    expect(origen.origenTipo).toBe('VENTA');
    expect(dtoAsiento.lineas).toEqual([
      {
        cuentaId: 'cta-cartera',
        terceroId: 'ter-1',
        debito: 689962,
        credito: 0,
      },
      { cuentaId: 'cta-ingreso', debito: 0, credito: 579800 },
      { cuentaId: 'cta-iva', baseGravable: 579800, debito: 0, credito: 110162 },
      { cuentaId: 'cta-costo', debito: 200000, credito: 0 },
      { cuentaId: 'cta-inv', debito: 0, credito: 200000 },
    ]);

    // Cuadra: débitos = créditos.
    const totalDebito = dtoAsiento.lineas.reduce((s, l) => s + l.debito, 0);
    const totalCredito = dtoAsiento.lineas.reduce((s, l) => s + l.credito, 0);
    expect(totalDebito).toBe(totalCredito);
  });

  it('sin IVA (empresa no responsable): no busca la cuenta de IVA ni agrega su línea', async () => {
    const { tx } = txFalso();
    const { fake: nucleo, cuenta } = nucleoFalso({ responsableIva: false });
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleo,
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    const factura = await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: HOY,
      lineas: [{ productoId: 'p-1', cantidad: 1 }],
    });

    expect(factura.total_iva).toBe('0');
    expect(cuenta.mock.calls.some(([, codigo]) => codigo === '240805')).toBe(
      false,
    );
  });

  it('rechaza si el período está cerrado, antes de gastar el consecutivo', async () => {
    const { tx } = txFalso();
    const { fake: nucleo, tomarConsecutivo } = nucleoFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleo,
      inventarioFalso(),
      contabilidadFalso({ periodoAbierto: false }).fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tomarConsecutivo).not.toHaveBeenCalled();
  });

  it.each([
    ['ayer', -1],
    ['mañana', 1],
  ])(
    'rechaza una factura fechada %s, antes de gastar el consecutivo',
    async (_cuando, dias) => {
      const { tx } = txFalso();
      const { fake: nucleo, tomarConsecutivo } = nucleoFalso();
      const servicio = new FacturaService(
        txServiceFalso(tx),
        nucleo,
        inventarioFalso(),
        contabilidadFalso().fake,
        {} as never,
        // RetencionesApi: ninguno de estos casos trae retenciones.
        {} as never,
      );

      await expect(
        servicio.crear(ctx, {
          terceroId: 'ter-1',
          fecha: otroDia(dias),
          lineas: [{ productoId: 'p-1', cantidad: 1 }],
        }),
      ).rejects.toThrow(/fecha de hoy/);
      expect(tomarConsecutivo).not.toHaveBeenCalled();
    },
  );

  it('anota en venta_faltante lo que salió sin existencia, con su costo de referencia', async () => {
    const { tx, faltantesInsertados } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      // El kardex ya decidió: dejó salir 2 unidades y 1,5 no estaban.
      inventarioFalso({
        costeo: { costoUnitario: 200000, valorTotal: 400000, faltante: 1.5 },
      }),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: HOY,
      lineas: [{ productoId: 'p-1', cantidad: 2 }],
      confirmaSinExistencia: true,
    });

    expect(faltantesInsertados).toHaveLength(1);
    const [, , productoId, cantidadFaltante, costoReferencia] =
      faltantesInsertados[0];
    expect(productoId).toBe('p-1');
    expect(cantidadFaltante).toBe(1.5);
    expect(costoReferencia).toBe(200000);
  });

  it('rechaza vender por debajo del costo, y lo dice con los dos números', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      // Precio de lista 100.000 contra un costo promedio de 200.000.
      inventarioFalso({
        precio: 100000,
        costeo: { costoUnitario: 200000, valorTotal: 400000, faltante: 0 },
      }),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 2 }],
      }),
    ).rejects.toThrow(/por debajo de su costo.*200000.*100000/s);
  });

  it('confirmar no alcanza si quien factura no es DIRECTOR', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso({
        precio: 100000,
        costeo: { costoUnitario: 200000, valorTotal: 400000, faltante: 0 },
      }),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 2 }],
        confirmaPrecioBajoCosto: true,
      }),
    ).rejects.toThrow(/autorizar un DIRECTOR/);
  });

  it('un DIRECTOR la emite, y la línea queda con quién la autorizó', async () => {
    const { tx, lineasInsertadas } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso({
        precio: 100000,
        costeo: { costoUnitario: 200000, valorTotal: 400000, faltante: 0 },
      }),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await servicio.crear(
      { ...ctx, roles: ['DIRECTOR'] },
      {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 2 }],
        confirmaPrecioBajoCosto: true,
      },
    );

    // El último parámetro del INSERT de la línea es quién autorizó.
    const linea = lineasInsertadas[0];
    expect(linea[linea.length - 1]).toBe('u-1');
  });

  it('no anota nada cuando había existencia', async () => {
    const { tx, faltantesInsertados } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await servicio.crear(ctx, {
      terceroId: 'ter-1',
      fecha: HOY,
      lineas: [{ productoId: 'p-1', cantidad: 2 }],
      confirmaSinExistencia: true,
    });

    expect(faltantesInsertados).toHaveLength(0);
  });

  it('rechaza si el mismo producto aparece en dos líneas', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [
          { productoId: 'p-1', cantidad: 1 },
          { productoId: 'p-1', cantidad: 2 },
        ],
      }),
    ).rejects.toThrow(/No repitas el mismo producto/);
  });

  it('rechaza si el tercero no existe', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso({ tercero: null }).fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'inexistente',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza si el producto no tiene cuenta de costo de venta configurada', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso({
        producto: { ...productoActivo, cuenta_costo_venta_id: null },
      }),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/cuenta de costo de venta/);
  });

  it('rechaza si el producto no tiene cuenta de ingreso configurada', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso({
        producto: { ...productoActivo, cuenta_ingreso_id: null },
      }),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/cuenta de ingreso/);
  });

  it('rechaza si no existe la cuenta de cartera (130505)', async () => {
    const { tx } = txFalso();
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso({ cuentas: {} }).fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never,
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.crear(ctx, {
        terceroId: 'ter-1',
        fecha: HOY,
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/cuenta de cartera/);
  });
});

describe('FacturaService.convertirCotizacion', () => {
  it('convierte la cotización: enlaza documento_origen_id y la marca CONVERTIDA', async () => {
    const { tx } = txFalso({ estadoCotizacion: 'EMITIDA' });
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso(),
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    const factura = await servicio.convertirCotizacion(ctx, 'cot-1', HOY);

    expect(factura.documento_origen_id).toBe('cot-1');
    expect(
      (tx.query as jest.Mock).mock.calls.some(
        ([sql, params]: [string, unknown[]]) =>
          sql.includes("SET estado = 'CONVERTIDA'") && params[0] === 'cot-1',
      ),
    ).toBe(true);
  });

  it('rechaza si la cotización no existe', async () => {
    const { tx } = txFalso({ estadoCotizacion: null });
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso(),
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.convertirCotizacion(ctx, 'inexistente', HOY),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza si la cotización ya se convirtió', async () => {
    const { tx } = txFalso({ estadoCotizacion: 'CONVERTIDA' });
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso(),
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.convertirCotizacion(ctx, 'cot-1', HOY),
    ).rejects.toThrow(/ya se convirtió/);
  });

  it('rechaza una cotización que no está EMITIDA (p. ej. BORRADOR)', async () => {
    const { tx } = txFalso({ estadoCotizacion: 'BORRADOR' });
    const servicio = new FacturaService(
      txServiceFalso(tx),
      nucleoFalso().fake,
      inventarioFalso(),
      contabilidadFalso().fake,
      ventasFalso(),
      // RetencionesApi: ninguno de estos casos trae retenciones.
      {} as never,
    );

    await expect(
      servicio.convertirCotizacion(ctx, 'cot-1', HOY),
    ).rejects.toThrow(/no está vigente/);
  });
});
