import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type { CobrarDto } from '../dto/venta.dto';
import { VentaDocumentoService } from './venta-documento.service';

/** RetencionesApi: la autorretención de la venta, que acá no hay. */
function retencionesVentaFalsas() {
  return {
    anularAutorretencion: jest.fn(() => Promise.resolve()),
    reversarAutorretencionPorNota: jest.fn(() => Promise.resolve([])),
  } as never;
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
function txFalso(
  cotizacion: { tipo: string; estado: string } | null = {
    tipo: 'COTIZACION',
    estado: 'EMITIDA',
  },
) {
  const lineasInsertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO venta_cotizacion_consecutivo')) {
        return [];
      }
      if (sql.includes('SELECT tipo, estado FROM venta_documento')) {
        return cotizacion === null ? [] : [cotizacion];
      }
      if (sql.includes("SET estado = 'ANULADA', motivo_anulacion")) {
        return [];
      }
      if (sql.includes('DELETE FROM venta_documento_linea')) {
        return [];
      }
      if (sql.includes('UPDATE venta_cotizacion_consecutivo')) {
        return [{ consecutivo_actual: 7 }];
      }
      if (sql.includes('SET tercero_id = $2')) {
        const [, tercero_id, fecha, subtotal, totalIva, total] =
          params as unknown[];
        return [
          {
            id: 'cot-1',
            tipo: 'COTIZACION',
            tercero_id,
            fecha,
            estado: 'EMITIDA',
            prefijo: 'COT',
            consecutivo: 7,
            resolucion_id: null,
            documento_origen_id: null,
            subtotal: String(subtotal),
            total_iva: String(totalIva),
            total: String(total),
            asiento_id: null,
          },
        ];
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

// Los ayudantes del cobro viven acá y no dentro de su `describe` porque
// `devolverCobro` usa los mismos: la misma factura bloqueada, la misma
// `TesoreriaApi` falsa y el mismo `UPDATE` de `monto_pagado`.
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
  const registrarDevolucionCobro = jest.fn(() =>
    Promise.resolve({ movimientoId: 'mov-2', asientoId: 'asiento-2' }),
  );
  const fake = {
    registrarCobro,
    registrarDevolucionCobro,
    // Una cuenta que paga 4×1000: de 100.400 que se devuelven, 400 son el impuesto.
    gmfIncluidoEn: jest.fn((_ctx: unknown, _cuenta: string, total: number) =>
      Promise.resolve(total - Math.round((total * 1000) / 1004)),
    ),
    cuentaDelMedio: jest.fn((_ctx: unknown, m: { medio: string }) =>
      Promise.resolve(
        m.medio === 'CAJA'
          ? { cuentaId: 'cta-caja', nombre: 'Caja general' }
          : { cuentaId: 'cta-banco', nombre: 'Bancolombia ···1234' },
      ),
    ),
  } as unknown as ConstructorParameters<typeof VentaDocumentoService>[4];
  return { fake, registrarCobro, registrarDevolucionCobro };
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
        ajuste_notas: string;
      }
    | undefined,
) {
  const actualizaciones: unknown[][] = [];
  // `por_cobrar` lo calcula la consulta, no el servicio: acá se replica esa
  // cuenta para que el caso se siga escribiendo en los términos en que se
  // piensa —"esta factura tiene una nota crédito de 19.000"—. Sin retenciones
  // en estos casos: son el otro lado y tienen sus propios tests.
  const porCobrar =
    documento === undefined
      ? undefined
      : String(Number(documento.total) + Number(documento.ajuste_notas));
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return documento === undefined
          ? []
          : [{ ...documento, por_cobrar: porCobrar }];
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
      // Lo descontado por pronto pago en recibos: en estos casos, nada.
      if (sql.includes('recibo_caja_aplicacion')) {
        return [{ total: '0' }];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, actualizaciones };
}

describe('VentaDocumentoService.crearCotizacion', () => {
  it('crea la cotización con el precio vigente del catálogo y numera con su propio contador', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.,
      retencionesVentaFalsas(),
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
      {} as never, // TesoreriaApi: no la usan estos métodos.,
      retencionesVentaFalsas(),
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
      {} as never, // TesoreriaApi: no la usan estos métodos.,
      retencionesVentaFalsas(),
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
      {} as never, // TesoreriaApi: no la usan estos métodos.,
      retencionesVentaFalsas(),
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
      {} as never, // TesoreriaApi: no la usa este método.,
      retencionesVentaFalsas(),
    );

    await expect(
      servicio.crearCotizacion(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'inexistente', cantidad: 1 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza si el producto no tiene precio de lista y la línea tampoco lo trae', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso({ precio: null }),
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.,
      retencionesVentaFalsas(),
    );

    await expect(
      servicio.crearCotizacion(ctx, {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/digite el precio en la línea/);
  });

  it('usa el precio digitado en la línea cuando el producto no tiene precio de lista', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso({ precio: null }),
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.,
      retencionesVentaFalsas(),
    );

    const documento = await servicio.crearCotizacion(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 2, precioUnitario: 100000 }],
    });

    expect(documento.lineas[0].precio_unitario).toBe('100000');
    expect(documento.subtotal).toBe('200000');
    expect(documento.total_iva).toBe('38000');
  });

  it('el precio digitado manda sobre el de lista: es el que se le ofrece al cliente', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.,
      retencionesVentaFalsas(),
    );

    const documento = await servicio.crearCotizacion(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 1, precioUnitario: 250000 }],
    });

    expect(documento.lineas[0].precio_unitario).toBe('250000');
  });

  it('no mira la existencia: cotiza 9.999 unidades de un producto sin nada en bodega', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      // El doble de InventarioApi solo sabe de `producto` y `precioVigente`:
      // si la cotización consultara el saldo o el kardex, reventaría acá.
      inventarioFalso(),
      {} as never,
      {} as never, // TesoreriaApi: no la usa este método.,
      retencionesVentaFalsas(),
    );

    const documento = await servicio.crearCotizacion(ctx, {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 9999 }],
    });

    expect(documento.lineas).toHaveLength(1);
    expect(documento.lineas[0].cantidad).toBe('9999');
  });
});

describe('VentaDocumentoService.editarCotizacion', () => {
  function servicioCon(tx: Tx) {
    return new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never,
      {} as never,
      retencionesVentaFalsas(),
    );
  }

  it('reemplaza las líneas y recalcula los totales, sin tocar el consecutivo', async () => {
    const { tx, lineasInsertadas } = txFalso();
    const servicio = servicioCon(tx);

    const documento = await servicio.editarCotizacion(ctx, 'cot-1', {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 3 }],
    });

    // 3 * 289900 = 869700, IVA 19% = 165243.
    expect(documento.subtotal).toBe('869700');
    expect(documento.total_iva).toBe('165243');
    expect(documento.consecutivo).toBe(7);
    expect(lineasInsertadas).toHaveLength(1);

    const consultas = (tx.query as jest.Mock).mock.calls.map(
      ([sql]: [string]) => sql,
    );
    // Las viejas se borran antes de insertar las nuevas: una línea no se edita.
    expect(
      consultas.some((s) => s.includes('DELETE FROM venta_documento_linea')),
    ).toBe(true);
    expect(consultas.some((s) => s.includes('FOR UPDATE'))).toBe(true);
  });

  it('corregir conserva el precio digitado', async () => {
    const { tx } = txFalso();
    const servicio = servicioCon(tx);

    const documento = await servicio.editarCotizacion(ctx, 'cot-1', {
      terceroId: 'ter-1',
      fecha: '2026-09-07',
      lineas: [{ productoId: 'p-1', cantidad: 2, precioUnitario: 250000 }],
    });

    expect(documento.lineas[0].precio_unitario).toBe('250000');
    expect(documento.subtotal).toBe('500000');
  });

  it('rechaza corregir una cotización ya convertida en factura', async () => {
    const { tx } = txFalso({ tipo: 'COTIZACION', estado: 'CONVERTIDA' });
    const servicio = servicioCon(tx);

    await expect(
      servicio.editarCotizacion(ctx, 'cot-1', {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/ya se convirtió en factura/);
  });

  it('rechaza corregir algo que no es una cotización', async () => {
    const { tx } = txFalso({ tipo: 'FACTURA', estado: 'EMITIDA' });
    const servicio = servicioCon(tx);

    await expect(
      servicio.editarCotizacion(ctx, 'fv-1', {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(/no es una cotización/);
  });

  it('lanza NotFoundException si no existe', async () => {
    const { tx } = txFalso(null);
    const servicio = servicioCon(tx);

    await expect(
      servicio.editarCotizacion(ctx, 'no-existe', {
        terceroId: 'ter-1',
        fecha: '2026-09-07',
        lineas: [{ productoId: 'p-1', cantidad: 1 }],
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('VentaDocumentoService.descartarCotizacion', () => {
  it('la marca ANULADA con su motivo, sin borrar nada', async () => {
    const { tx } = txFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never,
      {} as never,
      retencionesVentaFalsas(),
    );

    await servicio.descartarCotizacion(ctx, 'cot-1', 'El cliente no la tomó');

    const anulacion = (tx.query as jest.Mock).mock.calls.find(
      ([sql]: [string]) => sql.includes("SET estado = 'ANULADA'"),
    ) as [string, unknown[]];
    expect(anulacion[1]).toEqual([
      'cot-1',
      'El cliente no la tomó',
      ctx.usuarioId,
    ]);
  });

  it('rechaza descartar una que ya está descartada', async () => {
    const { tx } = txFalso({ tipo: 'COTIZACION', estado: 'ANULADA' });
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never,
      {} as never,
      retencionesVentaFalsas(),
    );

    await expect(
      servicio.descartarCotizacion(ctx, 'cot-1', 'Otra vez'),
    ).rejects.toThrow(/ya está descartada/);
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
        // La de las notas primero: sale de la misma tabla, y lo que la
        // distingue es a quién le apunta.
        if (sql.includes('documento_origen_id = $1')) return [];
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
      {} as never, // TesoreriaApi: no la usan estos métodos.,
      retencionesVentaFalsas(),
    );

    const detalle = await servicio.porId(ctx, 'COTIZACION', 'doc-1');
    expect(detalle.consecutivo).toBe(7);
    expect(detalle.lineas).toHaveLength(1);
  });

  it('la nota trae su factura, y la factura sus notas', async () => {
    // Las dos direcciones del enlace: quien mira una nota crédito tiene que
    // ver "factura SETP-991", no un UUID, y quien mira la factura tiene que
    // ver qué se le colgó encima.
    const facturaFila = {
      ...documentoFila,
      id: 'fv-1',
      tipo: 'FACTURA',
      prefijo: 'SETP',
      consecutivo: 991,
      documento_origen_id: null,
    };
    const notaFila = {
      ...documentoFila,
      id: 'nc-1',
      tipo: 'NOTA_CREDITO',
      prefijo: 'NC',
      consecutivo: 3,
      documento_origen_id: 'fv-1',
      total: '119000',
    };
    const consulta = (pedido: 'FACTURA' | 'NOTA_CREDITO') =>
      jest.fn((sql: string) => {
        // El orden importa: las tres salen de `venta_documento` y solo el
        // `WHERE` las distingue. La del documento pedido lleva `tipo`, la de
        // las notas apunta al origen, y la que queda es la del origen mismo.
        if (sql.includes('AND tipo = $2')) {
          return [pedido === 'FACTURA' ? facturaFila : notaFila];
        }
        if (sql.includes('documento_origen_id = $1')) {
          return pedido === 'FACTURA' ? [notaFila] : [];
        }
        if (sql.includes('FROM venta_documento_linea')) return [];
        if (sql.includes('WHERE id = $1')) return [facturaFila];
        throw new Error(`Query inesperada: ${sql}`);
      });
    const servicioCon = (pedido: 'FACTURA' | 'NOTA_CREDITO') =>
      new VentaDocumentoService(
        txServiceFalso({ query: consulta(pedido) } as unknown as Tx),
        nucleoFalso(),
        inventarioFalso(),
        {} as never,
        {} as never,
        retencionesVentaFalsas(),
      );

    const nota = await servicioCon('NOTA_CREDITO').porId(
      ctx,
      'NOTA_CREDITO',
      'nc-1',
    );
    expect(nota.documento_origen?.consecutivo).toBe(991);
    expect(nota.notas).toEqual([]);

    const factura = await servicioCon('FACTURA').porId(ctx, 'FACTURA', 'fv-1');
    expect(factura.documento_origen).toBeNull();
    expect(factura.notas).toHaveLength(1);
    expect(factura.notas?.[0].tipo).toBe('NOTA_CREDITO');
  });

  it('lanza NotFoundException si no existe', async () => {
    const tx = { query: jest.fn(() => []) } as unknown as Tx;
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      {} as never, // ContabilidadApi: crearCotizacion/listar/porId no lo usan.
      {} as never, // TesoreriaApi: no la usan estos métodos.,
      retencionesVentaFalsas(),
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

  /** `hay`: la factura es de contado y su asiento lleva la plata. */
  function tesoreriaAnularFalso(hay = false) {
    return {
      hayPlataEnAsiento: jest.fn(() => Promise.resolve(hay)),
    } as unknown as ConstructorParameters<typeof VentaDocumentoService>[4];
  }

  function txAnularFalso(
    documento:
      { tipo: string; estado: string; asiento_id: string | null } | undefined,
    /** Las notas vivas que corrigen al documento. */
    notasVivas: Array<{ tipo: string; numero: string }> = [],
  ) {
    const actualizaciones: unknown[][] = [];
    const tx = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT tipo, estado, asiento_id')) {
          return documento === undefined ? [] : [documento];
        }
        if (sql.includes('WHERE documento_origen_id = $1')) {
          return notasVivas;
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
    const revertir = jest.fn(() => Promise.resolve({ movimientos: 2 }));
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      {
        ...inventarioFalso(),
        revertirPorAnulacion: revertir,
      } as unknown as ConstructorParameters<typeof VentaDocumentoService>[2],
      contabilidad,
      tesoreriaAnularFalso(),
      retencionesVentaFalsas(),
    );

    await servicio.anular(ctx, 'fv-1', 'Error de digitación');

    expect(anularAsiento).toHaveBeenCalledWith(
      ctx,
      'asiento-1',
      'Error de digitación',
      tx,
    );
    // La mercancía vuelve al kardex con el mismo asiento, en la misma
    // transacción. Antes no volvía: la SETT-13 dejó 7 unidades descontadas.
    expect(revertir).toHaveBeenCalledWith(
      ctx,
      'asiento-1',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringContaining('Error de digitación'),
      tx,
    );
    expect(actualizaciones).toHaveLength(1);
    // La factura se bloquea antes de mirar sus notas: una nota que se emita
    // mientras tanto espera, y la anulación no se cruza con ella.
    const consultas = (tx.query as jest.Mock).mock.calls.map(
      ([sql]: [string]) => sql,
    );
    expect(consultas[0]).toContain('FOR UPDATE');
  });

  it('rechaza anular una factura de contado aunque el cobro ya se haya devuelto', async () => {
    // `monto_pagado` en 0 tras la devolución, pero la plata entró en el
    // asiento de la factura: anularlo la sacaría de caja por segunda vez.
    const { tx, actualizaciones } = txAnularFalso({
      tipo: 'FACTURA',
      estado: 'EMITIDA',
      asiento_id: 'asiento-1',
    });
    const { fake: contabilidad, anular: anularAsiento } = contabilidadFalso();
    const tesoreria = tesoreriaAnularFalso(true);
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      tesoreria,
      retencionesVentaFalsas(),
    );

    await expect(servicio.anular(ctx, 'fv-1', 'motivo')).rejects.toThrow(
      /se cobró de contado/,
    );
    expect(
      (tesoreria as unknown as { hayPlataEnAsiento: jest.Mock })
        .hayPlataEnAsiento,
    ).toHaveBeenCalledWith('asiento-1', tx);
    expect(anularAsiento).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('rechaza anular una factura con una nota viva, y la nombra', async () => {
    const { tx, actualizaciones } = txAnularFalso(
      { tipo: 'FACTURA', estado: 'EMITIDA', asiento_id: 'asiento-1' },
      [{ tipo: 'NOTA_CREDITO', numero: 'NC-5' }],
    );
    const { fake: contabilidad, anular: anularAsiento } = contabilidadFalso();
    const anularAutorretencion = jest.fn(() => Promise.resolve());
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidad,
      tesoreriaAnularFalso(),
      { anularAutorretencion } as never,
    );

    const intento = servicio.anular(ctx, 'fv-1', 'Error de digitación');
    await expect(intento).rejects.toThrow(ConflictException);
    await expect(intento).rejects.toThrow(
      'Esta factura tiene la nota crédito NC-5 viva: anúlela primero.',
    );
    // Nada se tocó: ni el asiento, ni la autorretención, ni el documento.
    expect(anularAsiento).not.toHaveBeenCalled();
    expect(anularAutorretencion).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('nombra todas las notas vivas, crédito y débito', async () => {
    const { tx } = txAnularFalso(
      { tipo: 'FACTURA', estado: 'EMITIDA', asiento_id: 'asiento-1' },
      [
        { tipo: 'NOTA_CREDITO', numero: 'NC-5' },
        { tipo: 'NOTA_DEBITO', numero: 'ND-2' },
      ],
    );
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      inventarioFalso(),
      contabilidadFalso().fake,
      tesoreriaAnularFalso(),
      retencionesVentaFalsas(),
    );

    await expect(servicio.anular(ctx, 'fv-1', 'motivo')).rejects.toThrow(
      'Esta factura tiene vivas la nota crédito NC-5 y la nota débito ND-2: anúlelas primero.',
    );
  });

  it('solo cuenta las notas vivas: la consulta descarta las anuladas', async () => {
    const { tx } = txAnularFalso({
      tipo: 'FACTURA',
      estado: 'EMITIDA',
      asiento_id: 'asiento-1',
    });
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoFalso(),
      {
        ...inventarioFalso(),
        revertirPorAnulacion: jest.fn(() =>
          Promise.resolve({ movimientos: 0 }),
        ),
      } as unknown as ConstructorParameters<typeof VentaDocumentoService>[2],
      contabilidadFalso().fake,
      tesoreriaAnularFalso(),
      retencionesVentaFalsas(),
    );

    await servicio.anular(ctx, 'fv-1', 'motivo');

    const notas = (tx.query as jest.Mock).mock.calls.find(([sql]: [string]) =>
      sql.includes('WHERE documento_origen_id = $1'),
    ) as [string, unknown[]];
    expect(notas[0]).toContain(`estado <> 'ANULADA'`);
    expect(notas[1]).toEqual(['fv-1']);
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
      tesoreriaAnularFalso(),
      retencionesVentaFalsas(),
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
      tesoreriaAnularFalso(),
      retencionesVentaFalsas(),
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
      tesoreriaAnularFalso(),
      retencionesVentaFalsas(),
    );

    await expect(servicio.anular(ctx, 'inexistente', 'motivo')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VentaDocumentoService.cobrar', () => {
  const DTO: CobrarDto = {
    fecha: '2026-09-12',
    pagos: [{ medio: 'CAJA', cajaId: 'c-1', valor: 50000 }],
  };

  /** El mismo cobro por caja, por otro valor. */
  const porValor = (valor: number): CobrarDto => ({
    ...DTO,
    pagos: [{ ...DTO.pagos[0], valor }],
  });

  const FACTURA_BASE = {
    tipo: 'FACTURA',
    tercero_id: 'ter-1',
    estado: 'EMITIDA',
    prefijo: 'SETP',
    consecutivo: 5,
    total: '119000',
    monto_pagado: '0',
    /** Sin notas encima: el saldo efectivo es el total. */
    ajuste_notas: '0',
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
      retencionesVentaFalsas(),
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
      retencionesVentaFalsas(),
    );

    await servicio.cobrar(ctx, 'fv-1', {
      fecha: '2026-09-12',
      pagos: [{ medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 50000 }],
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
      retencionesVentaFalsas(),
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
      retencionesVentaFalsas(),
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
      retencionesVentaFalsas(),
    );

    await expect(servicio.cobrar(ctx, 'fv-1', porValor(30000))).rejects.toThrow(
      BadRequestException,
    );
    expect(registrarCobro).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('cobra contra el saldo efectivo: una nota crédito encima baja el tope', async () => {
    // Factura de 119.000 con una nota crédito de 19.000: debe 100.000.
    const { tx } = txCobrarFalso({
      ...FACTURA_BASE,
      ajuste_notas: '-19000',
    });
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    await expect(
      servicio.cobrar(ctx, 'fv-1', porValor(110000)),
    ).rejects.toThrow(/Solo faltan 100000 por cobrar/);
    expect(registrarCobro).not.toHaveBeenCalled();

    // Y hasta el saldo efectivo, sí cobra.
    const { tx: tx2 } = txCobrarFalso({
      ...FACTURA_BASE,
      ajuste_notas: '-19000',
    });
    const { fake: tesoreria2, registrarCobro: registrar2 } = tesoreriaFalso();
    const servicio2 = new VentaDocumentoService(
      txServiceFalso(tx2),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria2,
      retencionesVentaFalsas(),
    );
    await servicio2.cobrar(ctx, 'fv-1', porValor(100000));
    expect(registrar2).toHaveBeenCalledTimes(1);
  });

  it('reparte un cobro entre caja y banco: dos movimientos, un solo monto_pagado', async () => {
    const { tx, actualizaciones } = txCobrarFalso(FACTURA_BASE);
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    const actualizado = await servicio.cobrar(ctx, 'fv-1', {
      fecha: '2026-09-12',
      pagos: [
        { medio: 'CAJA', cajaId: 'c-1', valor: 19000 },
        { medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 100000 },
      ],
    });

    // Dos movimientos, uno por renglón, y el concepto dice a dónde fue cada
    // parte para que el libro no muestre dos líneas indistinguibles.
    expect(registrarCobro).toHaveBeenCalledTimes(2);
    expect(registrarCobro).toHaveBeenNthCalledWith(
      1,
      ctx,
      expect.objectContaining({
        medio: 'CAJA',
        cajaId: 'c-1',
        valor: 19000,
        concepto: 'Cobro de la factura SETP-000005 · en Caja general',
      }),
      expect.anything(),
    );
    expect(registrarCobro).toHaveBeenNthCalledWith(
      2,
      ctx,
      expect.objectContaining({
        medio: 'BANCO',
        cuentaBancariaId: 'cb-1',
        valor: 100000,
        concepto: 'Cobro de la factura SETP-000005 · en Bancolombia ···1234',
      }),
      expect.anything(),
    );

    // Y un solo UPDATE por la suma: es un cobro, no dos.
    expect(actualizaciones).toHaveLength(1);
    expect(actualizado.monto_pagado).toBe('119000');
  });

  it('rechaza el reparto cuya SUMA se pasa, aunque cada renglón quepa', async () => {
    const { tx, actualizaciones } = txCobrarFalso(FACTURA_BASE);
    const { fake: tesoreria, registrarCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    // 70.000 + 70.000 sobre una factura de 119.000: por separado cada uno
    // cabe, juntos no. Validar renglón por renglón dejaría pasar esto.
    await expect(
      servicio.cobrar(ctx, 'fv-1', {
        fecha: '2026-09-12',
        pagos: [
          { medio: 'CAJA', cajaId: 'c-1', valor: 70000 },
          { medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 70000 },
        ],
      }),
    ).rejects.toThrow(/Solo faltan 119000 por cobrar/);
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
      retencionesVentaFalsas(),
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
      retencionesVentaFalsas(),
    );

    await expect(servicio.cobrar(ctx, 'inexistente', DTO)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('VentaDocumentoService.devolverCobro', () => {
  const FACTURA_COBRADA = {
    tipo: 'FACTURA',
    tercero_id: 'ter-1',
    estado: 'EMITIDA',
    prefijo: 'SETP',
    consecutivo: 5,
    total: '119000',
    monto_pagado: '119000',
    ajuste_notas: '0',
  };

  it('devuelve una parte: un egreso y el monto_pagado baja', async () => {
    const { tx, actualizaciones } = txCobrarFalso(FACTURA_COBRADA);
    const { fake: tesoreria, registrarDevolucionCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    const actualizado = await servicio.devolverCobro(ctx, 'fv-1', {
      fecha: '2026-09-16',
      pagos: [{ medio: 'CAJA', cajaId: 'c-1', valor: 19000 }],
    });

    expect(registrarDevolucionCobro).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        medio: 'CAJA',
        cajaId: 'c-1',
        valor: 19000,
        concepto: 'Devolución de cobro de la factura SETP-000005',
        cuentaClientesId: 'cta-cartera',
        facturaVentaId: 'fv-1',
      }),
      expect.anything(),
    );
    expect(actualizaciones).toHaveLength(1);
    expect(actualizado.monto_pagado).toBe('100000');
  });

  it('rechaza devolver más de lo cobrado, sin tocar nada', async () => {
    const { tx, actualizaciones } = txCobrarFalso({
      ...FACTURA_COBRADA,
      monto_pagado: '50000',
    });
    const { fake: tesoreria, registrarDevolucionCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    await expect(
      servicio.devolverCobro(ctx, 'fv-1', {
        fecha: '2026-09-16',
        pagos: [{ medio: 'CAJA', cajaId: 'c-1', valor: 60000 }],
      }),
    ).rejects.toThrow(/solo se cobraron 50000/);
    expect(registrarDevolucionCobro).not.toHaveBeenCalled();
    expect(actualizaciones).toHaveLength(0);
  });

  it('reparte la devolución entre caja y banco', async () => {
    const { tx, actualizaciones } = txCobrarFalso(FACTURA_COBRADA);
    const { fake: tesoreria, registrarDevolucionCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    const actualizado = await servicio.devolverCobro(ctx, 'fv-1', {
      fecha: '2026-09-16',
      pagos: [
        { medio: 'CAJA', cajaId: 'c-1', valor: 19000 },
        { medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 100000 },
      ],
    });

    // Caja, banco y el 4×1000 del banco, que sale de lo que se devuelve.
    expect(registrarDevolucionCobro).toHaveBeenCalledTimes(3);
    expect(actualizaciones).toHaveLength(1);
    expect(actualizado.monto_pagado).toBe('0');
  });

  it('por banco, el 4×1000 lo asume el cliente: le llega el resto y la factura baja por el total', async () => {
    const { tx } = txCobrarFalso(FACTURA_COBRADA);
    const { fake: tesoreria, registrarDevolucionCobro } = tesoreriaFalso();
    const servicio = new VentaDocumentoService(
      txServiceFalso(tx),
      nucleoCarteraFalso(),
      inventarioFalso(),
      {} as never,
      tesoreria,
      retencionesVentaFalsas(),
    );

    await servicio.devolverCobro(ctx, 'fv-1', {
      fecha: '2026-09-16',
      pagos: [{ medio: 'BANCO', cuentaBancariaId: 'cb-1', valor: 100400 }],
    });

    expect(registrarDevolucionCobro).toHaveBeenCalledTimes(2);
    expect(registrarDevolucionCobro).toHaveBeenNthCalledWith(
      1,
      ctx,
      expect.objectContaining({ valor: 100000 }),
      expect.anything(),
    );
    expect(registrarDevolucionCobro).toHaveBeenNthCalledWith(
      2,
      ctx,
      expect.objectContaining({
        valor: 400,
        concepto: expect.stringMatching(
          /4×1000, lo asume el cliente$/,
        ) as unknown,
      }),
      expect.anything(),
    );
  });
});
