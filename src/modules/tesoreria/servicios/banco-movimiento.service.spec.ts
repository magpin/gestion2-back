import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { BancoMovimientoService } from './banco-movimiento.service';
import type {
  CargaInicialBancoDto,
  RegistrarMovimientoBancoDto,
} from '../dto/banco-movimiento.dto';
import { ListarMovimientosBancoDto } from '../dto/banco-movimiento.dto';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CAJA'],
};

const DTO_INICIAL: CargaInicialBancoDto = {
  fecha: '2026-09-12',
  valor: 500_000,
  concepto: 'Saldo con el que abre la cuenta',
};

const DTO_MOVIMIENTO: RegistrarMovimientoBancoDto = {
  tipo: 'CONSIGNACION',
  fecha: '2026-09-12',
  valor: 100_000,
  concepto: 'Consignación de un cliente',
  contraCuentaId: 'cta-contra',
};

/**
 * Transacción falsa: responde según qué tabla consulta la query. `saldo`
 * `undefined` simula una cuenta sin movimientos todavía.
 */
function txFalso(saldo: { saldo_valor: string } | undefined) {
  const insertadas: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM cuenta_bancaria WHERE')) {
        return [{ id: 'cb-1', cuenta_id: 'cta-1' }];
      }
      if (sql.startsWith('SELECT saldo_valor')) {
        return saldo === undefined ? [] : [saldo];
      }
      if (sql.startsWith('INSERT INTO banco_movimiento')) {
        insertadas.push(params ?? []);
        const [
          id,
          ,
          cuenta_bancaria_id,
          fecha,
          tipo,
          valor,
          concepto,
          origen_tipo,
          origen_id,
          tercero_id,
          saldo_valor,
          asiento_id,
        ] = params as unknown[];
        return [
          {
            id,
            cuenta_bancaria_id,
            fecha,
            tipo,
            valor: String(valor),
            concepto,
            origen_tipo,
            origen_id,
            tercero_id,
            saldo_valor: String(saldo_valor),
            asiento_id,
            conciliado: false,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, insertadas };
}

function contabilidadFalso(
  opciones: { comprobante?: { id: string } | null } = {},
) {
  const { comprobante = { id: 'comp-1' } } = opciones;
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-1', numero: 'CI-000001' }),
  );
  const fake = {
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve(comprobante)),
    asentar,
  } as unknown as ConstructorParameters<typeof BancoMovimientoService>[1];
  return { fake, asentar };
}

function servicioCon(
  tx: Tx,
  contabilidad: ConstructorParameters<
    typeof BancoMovimientoService
  >[1] = {} as never,
) {
  return new BancoMovimientoService(
    {
      enContexto: (_ctx: unknown, fn: (t: Tx) => unknown, tExterna?: Tx) =>
        tExterna ? fn(tExterna) : fn(tx),
    } as never,
    contabilidad,
  );
}

describe('BancoMovimientoService.registrarSaldoInicial', () => {
  it('inserta el saldo inicial sin asiento, con el saldo corrido igual al valor', async () => {
    const { tx, insertadas } = txFalso(undefined);

    const movimiento = await servicioCon(tx).registrarSaldoInicial(
      ctx,
      'cb-1',
      DTO_INICIAL,
    );

    expect(movimiento.tipo).toBe('SALDO_INICIAL');
    expect(movimiento.asiento_id).toBeNull();
    expect(movimiento.saldo_valor).toBe('500000');
    expect(insertadas).toHaveLength(1);
  });

  it('rechaza sin insertar si la cuenta ya tiene movimientos', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '200000' });

    await expect(
      servicioCon(tx).registrarSaldoInicial(ctx, 'cb-1', DTO_INICIAL),
    ).rejects.toThrow(BadRequestException);
    expect(insertadas).toHaveLength(0);
  });

  it('rechaza si la cuenta no existe o está inactiva', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM cuenta_bancaria WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(
      servicioCon(tx).registrarSaldoInicial(ctx, 'inexistente', DTO_INICIAL),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('BancoMovimientoService.registrarMovimiento', () => {
  it('una CONSIGNACION suma al saldo y asienta contra CI', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '400000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    const movimiento = await servicioCon(tx, contabilidad).registrarMovimiento(
      ctx,
      'cb-1',
      DTO_MOVIMIENTO,
    );

    expect(movimiento.saldo_valor).toBe('500000');
    expect(insertadas).toHaveLength(1);

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-1', debito: 100_000, credito: 0 },
      { cuentaId: 'cta-contra', debito: 0, credito: 100_000 },
    ]);
  });

  it('un RETIRO resta del saldo y asienta contra CE, y puede dejarlo en negativo sin rechazar', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '50000' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    const movimiento = await servicioCon(tx, contabilidad).registrarMovimiento(
      ctx,
      'cb-1',
      { ...DTO_MOVIMIENTO, tipo: 'RETIRO', valor: 80_000 },
    );

    expect(movimiento.saldo_valor).toBe('-30000');
    expect(insertadas).toHaveLength(1);

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-1', debito: 0, credito: 80_000 },
      { cuentaId: 'cta-contra', debito: 80_000, credito: 0 },
    ]);
  });

  it('un CHEQUE también resta (misma dirección que RETIRO)', async () => {
    const { tx } = txFalso({ saldo_valor: '100000' });
    const { fake: contabilidad } = contabilidadFalso();

    const movimiento = await servicioCon(tx, contabilidad).registrarMovimiento(
      ctx,
      'cb-1',
      { ...DTO_MOVIMIENTO, tipo: 'CHEQUE', valor: 30_000 },
    );

    expect(movimiento.saldo_valor).toBe('70000');
  });

  it('rechaza sin asentar ni insertar si la empresa no sembró el comprobante', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '400000' });
    const { fake: contabilidad, asentar } = contabilidadFalso({
      comprobante: null,
    });

    await expect(
      servicioCon(tx, contabilidad).registrarMovimiento(
        ctx,
        'cb-1',
        DTO_MOVIMIENTO,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(asentar).not.toHaveBeenCalled();
    expect(insertadas).toHaveLength(0);
  });
});

describe('BancoMovimientoService.registrarMovimientoDocumento', () => {
  it('un cobro por transferencia deja origen_tipo/origen_id/tercero_id con el documento', async () => {
    const { tx, insertadas } = txFalso({ saldo_valor: '400000' });
    const { fake: contabilidad } = contabilidadFalso();

    const movimiento = await servicioCon(
      tx,
      contabilidad,
    ).registrarMovimientoDocumento(ctx, 'cb-1', {
      tipo: 'TRANSFERENCIA_ENTRANTE',
      fecha: '2026-09-12',
      valor: 50_000,
      concepto: 'Cobro de factura FV-001',
      contraCuentaId: 'cta-clientes',
      documentoTipo: 'FACTURA_VENTA',
      documentoId: 'factura-1',
      terceroId: 'ter-1',
    });

    expect(movimiento.origen_tipo).toBe('FACTURA_VENTA');
    expect(movimiento.origen_id).toBe('factura-1');
    expect(movimiento.tercero_id).toBe('ter-1');
    expect(insertadas).toHaveLength(1);
  });

  it('acepta una transacción externa y no abre una propia', async () => {
    const { tx } = txFalso({ saldo_valor: '400000' });
    const { fake: contabilidad } = contabilidadFalso();
    const servicio = servicioCon(
      {
        query: jest.fn(() => {
          throw new Error('no debería usar el tx por defecto');
        }),
      } as unknown as Tx,
      contabilidad,
    );

    const movimiento = await servicio.registrarMovimientoDocumento(
      ctx,
      'cb-1',
      {
        tipo: 'TRANSFERENCIA_SALIENTE',
        fecha: '2026-09-12',
        valor: 30_000,
        concepto: 'Pago de compra CO-001',
        contraCuentaId: 'cta-proveedores',
        documentoTipo: 'COMPRA',
        documentoId: 'compra-1',
        terceroId: 'ter-2',
      },
      tx,
    );

    expect(movimiento.origen_tipo).toBe('COMPRA');
  });
});

describe('BancoMovimientoService.resumen', () => {
  it('entradas y salidas cuentan todos los tipos del libro, notas y cheques incluidos', async () => {
    const query = jest.fn(() =>
      Promise.resolve([
        { entradas: '0', salidas: '0', saldo_inicial: '0', saldo: '0' },
      ]),
    );
    const servicio = new BancoMovimientoService(
      {
        enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) =>
          fn({ query } as unknown as Tx),
      } as never,
      {} as never,
    );

    await servicio.resumen(ctx, 'cb-1');

    const [, params] = query.mock.calls[0] as unknown as [
      string,
      [string, string[], string[]],
    ];
    expect([...params[1]].sort()).toEqual(
      ['CONSIGNACION', 'NOTA_CREDITO', 'TRANSFERENCIA_ENTRANTE'].sort(),
    );
    expect([...params[2]].sort()).toEqual(
      ['CHEQUE', 'NOTA_DEBITO', 'RETIRO', 'TRANSFERENCIA_SALIENTE'].sort(),
    );
  });
});

describe('BancoMovimientoService.listar', () => {
  function listarCon(filtro: Partial<ListarMovimientosBancoDto>) {
    const query = jest.fn((sql: string) =>
      Promise.resolve(sql.includes('count(*)') ? [{ total: '0' }] : []),
    );
    const servicio = new BancoMovimientoService(
      {
        enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) =>
          fn({ query } as unknown as Tx),
      } as never,
      {} as never,
    );
    const dto = Object.assign(new ListarMovimientosBancoDto(), filtro);
    return { query, listado: servicio.listar(ctx, 'cb-1', dto) };
  }

  it('sinConciliar filtra el conteo y la página igual: lo cruzado y el saldo inicial no cuentan', async () => {
    const { query, listado } = listarCon({ sinConciliar: 'true' });
    await listado;

    const consultas = query.mock.calls.map(([sql]) => sql);
    expect(consultas).toHaveLength(2);
    for (const sql of consultas) {
      expect(sql).toContain('NOT conciliado');
      expect(sql).toContain(`tipo <> 'SALDO_INICIAL'`);
    }
  });

  it('sin el filtro trae el libro entero, como antes', async () => {
    const { query, listado } = listarCon({});
    await listado;

    for (const [sql] of query.mock.calls) {
      expect(sql).not.toContain('NOT conciliado');
    }
  });
});
