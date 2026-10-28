import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { ComprobanteService, TIPOS_INICIALES } from './comprobante.service';

const ctx: CtxEmpresa = {
  tenantId: 't',
  usuarioId: 'u',
  empresaId: 'e',
  roles: ['DIRECTOR'],
};

/** Una tabla en memoria: `existentes` dice qué códigos hay y si están activos. */
function armar(existentes: Record<string, boolean>) {
  const tabla = new Map(Object.entries(existentes));
  const query = jest.fn((sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT')) {
      const codigo = params[0] as string;
      return Promise.resolve(
        tabla.get(codigo) === true ? [{ id: `id-${codigo}` }] : [],
      );
    }
    const codigo = params[1] as string;
    if (!tabla.has(codigo)) tabla.set(codigo, true);
    return Promise.resolve([]);
  });
  const t = { query } as unknown as Tx;
  const tx = {
    enContexto: (_c: CtxEmpresa, fn: (t: Tx) => unknown) => fn(t),
  } as unknown as TxService;
  return { servicio: new ComprobanteService(tx), query };
}

const inserciones = (query: jest.Mock) =>
  query.mock.calls.filter(([sql]) => !(sql as string).startsWith('SELECT'))
    .length;

describe('ComprobanteService.porCodigo', () => {
  it('lo encuentra sin sembrar nada', async () => {
    const { servicio, query } = armar({ CA: true });
    await expect(servicio.porCodigo(ctx, 'CA')).resolves.toEqual({
      id: 'id-CA',
    });
    expect(inserciones(query)).toBe(0);
  });

  it('si falta un tipo inicial, siembra los que faltan y lo devuelve', async () => {
    const { servicio, query } = armar({});
    await expect(servicio.porCodigo(ctx, 'CA')).resolves.toEqual({
      id: 'id-CA',
    });
    expect(inserciones(query)).toBe(TIPOS_INICIALES.length);
  });

  it('el desactivado sigue desactivado', async () => {
    const { servicio } = armar({ CA: false });
    await expect(servicio.porCodigo(ctx, 'CA')).resolves.toBeNull();
  });

  it('un código que no es inicial no siembra nada', async () => {
    const { servicio, query } = armar({});
    await expect(servicio.porCodigo(ctx, 'FV')).resolves.toBeNull();
    expect(inserciones(query)).toBe(0);
  });
});
