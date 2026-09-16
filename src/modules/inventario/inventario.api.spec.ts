import type { CtxEmpresa } from '../../common/ctx';
import { TxService, type Tx } from '../../common/db/tx.service';
import { InventarioApi } from './inventario.api';
import { KardexService } from './servicios/kardex.service';
import { PrecioService } from './servicios/precio.service';
import { ProductoService } from './servicios/producto.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['DIRECTOR'],
};

/**
 * `TxService` falso: igual que su versión real cuando ya viene un `tx`
 * (`kardex.service.spec.ts` no existe todavía, así que este es el primer
 * lugar del módulo que necesita este doble — mismo criterio que
 * `resolucion.service.spec.ts` para `tomarConsecutivo`, adaptado porque acá
 * el `tx` sí es opcional).
 */
function txServiceFalso(): TxService {
  return {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown, tx?: Tx) =>
      fn(tx as Tx),
  } as unknown as TxService;
}

/** Transacción falsa: responde según qué tabla consulta la query. */
function txFalso(
  producto: Record<string, unknown> | undefined,
  movimiento: Record<string, unknown> | undefined,
  precio?: Record<string, unknown>,
) {
  return {
    query: jest.fn((sql: string) => {
      if (sql.includes('FROM producto WHERE')) {
        return producto === undefined ? [] : [producto];
      }
      if (sql.includes('FROM producto_movimiento')) {
        return movimiento === undefined ? [] : [movimiento];
      }
      if (sql.includes('FROM producto_precio')) {
        return precio === undefined ? [] : [precio];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
}

const productoFila = {
  id: 'p-1',
  codigo: 'MART-01',
  nombre: 'Martillo',
  unidad_medida: 'UND',
  iva_tarifa: '19.00',
  cuenta_inventario_id: 'c-1',
  activo: true,
};

const movimientoFila = {
  saldo_cantidad: '10.000000',
  saldo_costo_promedio: '5000.00',
};

describe('InventarioApi', () => {
  const productos = new ProductoService(
    txServiceFalso(),
    // AlmacenamientoApi: `ultimoSaldo` no firma ninguna URL.
    { disponible: false } as never,
  );
  const kardex = new KardexService(
    txServiceFalso(),
    {} as never, // NucleoApi: ultimoSaldo no lo toca
    {} as never, // ContabilidadApi: ultimoSaldo no lo toca
    {} as never, // ConfiguracionService: ultimoSaldo no lo toca
  );
  const precios = new PrecioService(txServiceFalso());
  const api = new InventarioApi(productos, kardex, precios);

  it('producto() devuelve los datos cuando existe', async () => {
    const tx = txFalso(productoFila, undefined);
    const resultado = await api.producto(ctx, 'p-1', tx);
    expect(resultado?.codigo).toBe('MART-01');
  });

  it('producto() devuelve null cuando no existe', async () => {
    const tx = txFalso(undefined, undefined);
    const resultado = await api.producto(ctx, 'inexistente', tx);
    expect(resultado).toBeNull();
  });

  it('saldoActual() devuelve el ultimo saldo cuando el producto tiene movimientos', async () => {
    const tx = txFalso(undefined, movimientoFila);
    const saldo = await api.saldoActual(ctx, 'p-1', tx);
    expect(saldo).toEqual({ cantidad: 10, costoPromedio: 5000 });
  });

  it('saldoActual() devuelve null cuando el producto no tiene movimientos', async () => {
    const tx = txFalso(undefined, undefined);
    const saldo = await api.saldoActual(ctx, 'p-1', tx);
    expect(saldo).toBeNull();
  });

  it('precioVigente() devuelve el precio de lista vigente', async () => {
    const tx = txFalso(undefined, undefined, { precio_venta: '89900.00' });
    const precio = await api.precioVigente(ctx, 'p-1', tx);
    expect(precio).toBe(89900);
  });

  it('precioVigente() devuelve null cuando el producto no tiene precio', async () => {
    const tx = txFalso(undefined, undefined, undefined);
    const precio = await api.precioVigente(ctx, 'p-1', tx);
    expect(precio).toBeNull();
  });
});
