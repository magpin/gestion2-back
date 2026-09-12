import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { CobrarDto } from '../dto/venta.dto';
import { VentaDocumentoService } from './venta-documento.service';

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
  activo: true,
};

/** `TxService` falso: entrega directo el `tx` ya armado por el test. */
function txServiceFalso(tx: Tx): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService;
}

/** `NucleoApi` falsa: solo `buscarTercero`/`esResponsableDeIva`, que es lo que usa este servicio. */
function nucleoFalso(
  opciones: {
    tercero?: Record<string, unknown> | null;
    responsableIva?: boolean;
  } = {},
) {
  const { tercero = clienteActivo, responsableIva = true } = opciones;
  return {
    buscarTercero: jest.fn(() => Promise.resolve(tercero)),
    esResponsableDeIva: jest.fn(() => Promise.resolve(responsableIva)),
  } as unknown as ConstructorParameters<typeof VentaDocumentoService>[1];
}

/** `InventarioApi` falsa: un solo producto por defecto, y su precio vigente. */
function inventarioFalso(
  opciones: {
    producto?: Record<string, unknown> | null;
    precio?: number | null;
  } = {},
) {
  const { producto = productoActivo, precio = 289900 } = opciones;
  return {
    producto: jest.fn(() => Promise.resolve(producto)),
    precioVigente: jest.fn(() => Promise.resolve(precio)),
  } as unknown as ConstructorParameters<typeof VentaDocumentoService>[2];
}

/** Transacción falsa: responde según qué tabla toca la consulta. */
function txFalso() {
  const lineasInsertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO venta_cotizacion_consecutivo')) {
        return [];
      }
      if (sql.includes('UPDATE venta_cotizacion_consecutivo')) {
        return [{ consecutivo_actual: 7 }];
      }
      if (sql.includes('INSERT INTO venta_documento\n')) {
        const [
          ,
          terceroId,
          fecha,
          prefijo,
          consecutivo,
          subtotal,
          totalIva,
          total,
        ] = params as unknown[];
        // `numeric`/`int` llegan del driver real como texto o número según
        // el tipo de columna — acá se imitan como texto para `numeric`
        // (subtotal/total_iva/total) y como número para `consecutivo` (es
        // `int`), igual que ya distingue `kardex.service.spec.ts`.
        return [
          {
            id: 'doc-1',
            tipo: 'COTIZACION',
            tercero_id: terceroId,
            fecha,
            estado: 'EMITIDA',
            prefijo,
            consecutivo,
            resolucion_id: null,
            documento_origen_id: null,
            subtotal: String(subtotal),
            total_iva: String(totalIva),
            total: String(total),
            asiento_id: null,
          },
        ];
      }
      if (sql.includes('INSERT INTO venta_documento_linea')) {
        lineasInsertadas.push(params ?? []);
        const [
          ,
          venta_documento_id,
          orden,
          producto_id,
          cantidad,
          precio_unitario,
          iva_tarifa,
          subtotal,
          iva_valor,
          total,
        ] = params as unknown[];
        return [
          {
            id: `linea-${String(orden)}`,
            venta_documento_id,
            orden,
            producto_id,
            cantidad: String(cantidad),
            precio_unitario: String(precio_unitario),
            iva_tarifa: String(iva_tarifa),
            subtotal: String(subtotal),
            iva_valor: String(iva_valor),
            total: String(total),
            costo_unitario: null,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, lineasInsertadas };
}

describe('VentaDocumentoService.crearCotizacion', () => {
  it('crea la cotización con el precio vigente del catálogo y numera con su propio contador', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.
    );

    const documento = await servicio.crearCotizacion(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 2 }],
    });

    expect(documento.prefijo).toBe('COT');
    expect(documento.consecutivo).toBe(7);
    expect(documento.subtotal).toBe('579800');
    expect(documento.total_iva).toBe('110162');
    expect(documento.total).toBe('689962');
    expect(documento.lineas).toHaveLength(1);
    expect(documento.lineas[0].producto_id).toBe('p-1');
  });

  it('si la empresa no es responsable de IVA, ninguna línea liquida IVA aunque el producto tenga tarifa', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso({ responsableIva: false }),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.
    );

    const documento = await servicio.crearCotizacion(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 1 }],
    });

    expect(documento.total_iva).toBe('0');
    expect(documento.lineas[0].iva_tarifa).toBe('0');
  });

  it('rechaza si el tercero no existe', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso({ tercero: null }),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.
    );

    await expect(
      servicio.crearCotizacion(ctx, {
        terceroId: 'inexistente',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rechaza si el tercero no está marcado como cliente', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso({
        tercero: { ...clienteActivo, esCliente: false, esProveedor: true },
      }),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.
    );

    await expect(
      servicio.crearCotizacion(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza si el producto no existe o está inactivo', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso({ producto: null }),
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crearCotizacion(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'inexistente', cantidad: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza si el producto no tiene precio de venta configurado', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso({ precio: null }),
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.
    );

    await expect(
      servicio.crearCotizacion(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/precio de venta configurado/);
  });
});

describe('VentaDocumentoService.porId', () => {
  const documentoFila = {
    id: 'doc-1',
    tipo: 'COTIZACION',
    tercero_id: 'ter-1',
    fecha: '2026-09-07',
    estado: 'EMITIDA',
    prefijo: 'COT',
    consecutivo: 7,
    resolucion_id: null,
    documento_origen_id: null,
    subtotal: '579800',
    total_iva: '110162',
    total: '689962',
    asiento_id: null,
  };
  const lineaFila = {
    id: 'linea-1',
    venta_documento_id: 'doc-1',
    orden: 1,
    producto_id: 'p-1',
    cantidad: '2',
    precio_unitario: '289900',
    iva_tarifa: '19',
    subtotal: '579800',
    iva_valor: '110162',
    total: '689962',
    costo_unitario: null,
  };

  it('devuelve la cotización con sus líneas', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM venta_documento\n')) return [documentoFila];
        if (sql.includes('FROM venta_documento_linea')) return [lineaFila];
        throw new Error(`Query inesperada: ${sql}`);
      }),
    } as unknown as Tx;
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.
    );

    const detalle = await servicio.porId(ctx, 'COTIZACION', 'doc-1');
    expect(detalle.consecutivo).toBe(7);
    expect(detalle.lineas).toHaveLength(1);
  });

  it('lanza NotFoundException si no existe', async () => {
    const tx = { query: jest.fn(() => []) } as unknown as Tx;
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.
    );

    await expect(
      servicio.porId(ctx, 'COTIZACION', 'inexistente'),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('VentaDocumentoService.anular', () => {
  function contabilidadFalso() {
    const anular = jest.fn(() => Promise.resolve());
    const fake = {
      anular,
    } as unknown as ConstructorParameters<typeof VentaDocumentoService>[3];
    return { fake, anular };
  }

  function txAnularFalso(
    documento:
      { tipo: string; estado: string; asiento_id: string | null } | undefined,
  ) {
    const actualizaciones: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT tipo, estado, asiento_id')) {
          return documento === undefined ? [] : [documento];
        }
        if (sql.includes('UPDATE venta_documento')) {
          actualizaciones.push(params ?? []);
          return [];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizaciones };
  }

  it('anula el asiento y marca el documento, en la misma transacción', async () => {
    const { tx, actualizaciones } = txAnularFalso({
      tipo: 'FACTURA',
      estado: 'EMITIDA',
      asiento_id: 'asiento-1',
    });
    const { fake: contabilidad, anular: anularAsiento } = contabilidadFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      {} as never, // TesoreriaApi: no la usa anular.
    );

    await servicio.anular(ctx, 'fv-1', 'Error de digitación');

    expect(anularAsiento).toHaveBeenCalledWith(
      ctx,
      'asiento-1',
      'Error de digitación',
      tx,
    );
    expect(actualizaciones).toHaveLength(1);
  });

  it('rechaza anular una cotización', async () => {
    const { tx } = txAnularFalso({
      tipo: 'COTIZACION',
      estado: 'EMITIDA',
      asiento_id: null,
    });
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa anular.
    );

    await expect(servicio.anular(ctx, 'cot-1', 'motivo')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rechaza anular un documento que ya está anulado', async () => {
    const { tx } = txAnularFalso({
      tipo: 'FACTURA',
      estado: 'ANULADA',
      asiento_id: 'asiento-1',
    });
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa anular.
    );

    await expect(servicio.anular(ctx, 'fv-1', 'motivo')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lanza NotFoundException si el documento no existe', async () => {
    const { tx } = txAnularFalso(undefined);
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      {} as never, // TesoreriaApi: no la usa anular.
    );

    await expect(servicio.anular(ctx, 'inexistente', 'motivo')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VentaDocumentoService.cobrar', () => {
  const DTO: CobrarDto = {
    medio: 'CAJA',
    cajaId: 'c-1',
    fecha: '2026-09-12',
    valor: 50000,
  };

  function nucleoCarteraFalso(
    cuenta: { id: string } | null = { id: 'cta-cartera' },
  ) {
    return {
      cuenta: jest.fn(() => Promise.resolve(cuenta)),
    } as unknown as ConstructorParameters<typeof VentaDocumentoService>[1];
  }

  function tesoreriaFalso() {
    const registrarCobro = jest.fn(() =>
      Promise.resolve({ movimientoId: 'mov-1', asientoId: 'asiento-1' }),
    );
    const fake = {
      registrarCobro,
    } as unknown as ConstructorParameters<typeof VentaDocumentoService>[4];
    return { fake, registrarCobro };
  }

  function txCobrarFalso(
    documento:
      | {
          tipo: string;
          tercero_id: string;
          estado: string;
          prefijo: string | null;
          consecutivo: number;
          total: string;
          monto_pagado: string;
        }
      | undefined,
  ) {
    const actualizaciones: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return documento === undefined ? [] : [documento];
        }
        if (sql.includes('UPDATE venta_documento')) {
          actualizaciones.push(params ?? []);
          const [, montoPagado] = params as unknown[];
          return [
            {
              id: 'fv-1',
              tipo: 'FACTURA',
              tercero_id: documento?.tercero_id,
              fecha: '2026-09-01',
              estado: 'EMITIDA',
              prefijo: documento?.prefijo,
              consecutivo: documento?.consecutivo,
              resolucion_id: null,
              documento_origen_id: null,
              subtotal: '0',
              total_iva: '0',
              total: documento?.total,
              monto_pagado: String(montoPagado),
              asiento_id: null,
            },
          ];
        }
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;
    return { tx, actualizaciones };
  }

  const FACTURA_BASE = {
    tipo: 'FACTURA',
    tercero_id: 'ter-1',
    estado: 'EMITIDA',
    prefijo: 'SETP',
    consecutivo: 5,
    total: '119000',
    monto_pagado: '0',
  };

  it('cobra parcialmente y deja monto_pagado corrido, con el concepto y la cuenta correctos', async () => {
    const { tx, actualizaciones } = txCobrarFalso(FACTURA_BASE);
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
    );

    const actualizado = await servicio.cobrar(ctx, 'fv-1', DTO);

    expect(actualizado.monto_pagado).toBe('50000');
    expect(actualizaciones).toHaveLength(1);
    expect(registrarCobro).toHaveBeenCalledWith(
      ctx,
      {
        medio: 'CAJA',
        cajaId: 'c-1',
        fecha: DTO.fecha,
        valor: 50000,
        concepto: 'Cobro de la factura SETP-000005',
        cuentaClientesId: 'cta-cartera',
        terceroId: 'ter-1',
        facturaVentaId: 'fv-1',
      },
      tx,
    );
  });

  it('cobra por banco cuando medio es BANCO, con cuentaBancariaId en vez de cajaId', async () => {
    const { tx, actualizaciones } = txCobrarFalso(FACTURA_BASE);
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
    );

    await servicio.cobrar(ctx, 'fv-1', {
      medio: 'BANCO',
      cuentaBancariaId: 'cb-1',
      fecha: '2026-09-12',
      valor: 50000,
    });

    expect(actualizaciones).toHaveLength(1);
    expect(registrarCobro).toHaveBeenCalledWith(
      ctx,
      {
        medio: 'BANCO',
        cuentaBancariaId: 'cb-1',
        fecha: '2026-09-12',
        valor: 50000,
        concepto: 'Cobro de la factura SETP-000005',
        cuentaClientesId: 'cta-cartera',
        terceroId: 'ter-1',
        facturaVentaId: 'fv-1',
      },
      tx,
    );
  });

  it('rechaza cobrar algo que no es una factura', async () => {
    const { tx } = txCobrarFalso({ ...FACTURA_BASE, tipo: 'COTIZACION' });
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreriaFalso().fake,
    );

    await expect(servicio.cobrar(ctx, 'cot-1', DTO)).rejects.toThrow(
      /Solo se puede cobrar una factura/,
    );
  });

  it('rechaza cobrar una factura anulada', async () => {
    const { tx } = txCobrarFalso({ ...FACTURA_BASE, estado: 'ANULADA' });
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreriaFalso().fake,
    );

    await expect(servicio.cobrar(ctx, 'fv-1', DTO)).rejects.toThrow(
      /no está vigente/,
    );
  });

  it('rechaza cobrar más de lo que falta, sin llamar a TesoreriaApi ni actualizar nada', async () => {
    const { tx, actualizaciones } = txCobrarFalso({
      ...FACTURA_BASE,
      monto_pagado: '100000',
    });
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
    );

    await expect(
      servicio.cobrar(ctx, 'fv-1', { ...DTO, valor: 30000 }),
    ).rejects.toThrow(BadRequestException);
    expect(registrarCobro).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza sin llamar a TesoreriaApi si no existe la cuenta de cartera', async () => {
    const { tx } = txCobrarFalso(FACTURA_BASE);
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(null),
      inventarioFalso(),
      {} as never,
      tesoreria,
    );

    await expect(servicio.cobrar(ctx, 'fv-1', DTO)).rejects.toThrow(
      /cuenta de cartera/,
    );
    expect(registrarCobro).not.toHaveBeenCalled();
  });

  it('lanza NotFoundException si la factura no existe', async () => {
    const { tx } = txCobrarFalso(undefined);
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreriaFalso().fake,
    );

    await expect(servicio.cobrar(ctx, 'inexistente', DTO)).rejects.toThrow(
      NotFoundException,
    );
  });
});
