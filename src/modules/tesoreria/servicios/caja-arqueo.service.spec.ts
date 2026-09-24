import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx } from '../../../common/db/tx.service';
import { CajaArqueoService } from './caja-arqueo.service';
import type { AbrirArqueoDto, CerrarArqueoDto } from '../dto/caja-arqueo.dto';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['CAJA'],
};

const ABRIR: AbrirArqueoDto = { fecha: '2026-09-12' };

const arqueoAbiertoFila = {
  id: 'arq-1',
  caja_id: 'c-1',
  fecha: '2026-09-12',
  saldo_sistema: '80000',
  saldo_contado: null,
  diferencia: null,
  estado: 'ABIERTO',
  cerrado_en: null,
  cerrado_por: null,
  nota: null,
  asiento_ajuste_id: null,
};

/** Las tres cuentas de arqueo configuradas, como quedan después de `preparar`. */
const CUENTAS = {
  cuenta_sobrante_id: 'cta-sobrante',
  cuenta_faltante_cobrable_id: 'cta-cobrable',
  cuenta_faltante_asumido_id: 'cta-asumido',
};

/**
 * Transacción falsa: responde según qué tabla consulta la query.
 * `arqueoAbierto: null` simula que la caja no tiene arqueo abierto; sin
 * pasar la opción, usa `arqueoAbiertoFila` (hay uno). `cuentas` es
 * `caja_configuracion`: la columna que falte es un concepto sin cuenta.
 * `responsable` es el tercero que responde por la caja.
 */
function txFalso(
  opciones: {
    saldo?: { saldo_valor: string };
    arqueoAbierto?: Record<string, unknown> | null;
    cuentas?: Partial<typeof CUENTAS>;
    responsable?: string | null;
  } = {},
) {
  const { saldo, cuentas = CUENTAS, responsable = null } = opciones;
  const arqueoAbierto =
    opciones.arqueoAbierto === undefined
      ? arqueoAbiertoFila
      : opciones.arqueoAbierto;
  const inserts: unknown[][] = [];
  const updates: unknown[][] = [];
  const denominaciones: unknown[][] = [];
  const tx = {
    query: jest.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM caja WHERE')) {
        return [
          {
            id: 'c-1',
            cuenta_id: 'cta-1',
            responsable_tercero_id: responsable,
          },
        ];
      }
      if (sql.startsWith('SELECT saldo_valor')) {
        return saldo === undefined ? [] : [saldo];
      }
      if (sql.startsWith('SELECT id FROM caja_arqueo')) {
        return arqueoAbierto === null ? [] : [{ id: arqueoAbierto.id }];
      }
      if (
        sql.includes('FROM caja_arqueo') &&
        sql.includes("estado = 'ABIERTO'")
      ) {
        return arqueoAbierto === null ? [] : [arqueoAbierto];
      }
      if (sql.includes('FROM caja_configuracion')) {
        const columna = /SELECT (\w+) AS cuenta_id/.exec(sql)?.[1] ?? '';
        const id = (cuentas as Record<string, string | undefined>)[columna];
        return id === undefined ? [] : [{ cuenta_id: id }];
      }
      if (sql.includes('INSERT INTO caja_arqueo_denominacion')) {
        denominaciones.push(params ?? []);
        return [];
      }
      if (sql.startsWith('INSERT INTO caja_arqueo')) {
        inserts.push(params ?? []);
        const [id, , caja_id, fecha, saldo_sistema, nota] = params as unknown[];
        return [
          {
            id,
            caja_id,
            fecha,
            saldo_sistema: String(saldo_sistema),
            saldo_contado: null,
            diferencia: null,
            estado: 'ABIERTO',
            cerrado_en: null,
            cerrado_por: null,
            nota,
            asiento_ajuste_id: null,
          },
        ];
      }
      if (sql.startsWith('UPDATE caja_arqueo')) {
        updates.push(params ?? []);
        const [
          id,
          saldo_contado,
          diferencia,
          cerrado_por,
          nota,
          asiento_ajuste_id,
        ] = params as unknown[];
        return [
          {
            id,
            caja_id: 'c-1',
            fecha: '2026-09-12',
            saldo_sistema: '80000',
            saldo_contado: String(saldo_contado),
            diferencia: String(diferencia),
            estado: 'CERRADO',
            cerrado_en: '2026-09-12T10:00:00.000Z',
            cerrado_por,
            nota: nota ?? arqueoAbiertoFila.nota,
            asiento_ajuste_id,
          },
        ];
      }
      throw new Error(`Query inesperada en el test: ${sql}`);
    }),
  } as unknown as Tx;
  return { tx, inserts, updates, denominaciones };
}

function contabilidadFalso(
  comprobante: { id: string } | null = { id: 'comp-cd' },
) {
  const asentar = jest.fn(() =>
    Promise.resolve({ id: 'asiento-ajuste-1', numero: 'CD-000001' }),
  );
  const fake = {
    tipoComprobantePorCodigo: jest.fn(() => Promise.resolve(comprobante)),
    asentar,
  } as unknown as ConstructorParameters<typeof CajaArqueoService>[1];
  return { fake, asentar };
}

function movimientosFalso() {
  const registrarAjusteArqueo = jest.fn(() => Promise.resolve({} as never));
  const fake = {
    registrarAjusteArqueo,
  } as unknown as ConstructorParameters<typeof CajaArqueoService>[2];
  return { fake, registrarAjusteArqueo };
}

function servicioCon(
  tx: Tx,
  contabilidad: ConstructorParameters<
    typeof CajaArqueoService
  >[1] = {} as never,
  movimientos: ConstructorParameters<typeof CajaArqueoService>[2] = {} as never,
) {
  return new CajaArqueoService(
    {
      enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) => fn(tx),
    } as never,
    contabilidad,
    movimientos,
  );
}

describe('CajaArqueoService.abrir', () => {
  it('congela saldo_sistema con el último saldo del libro', async () => {
    const { tx, inserts } = txFalso({
      saldo: { saldo_valor: '80000' },
      arqueoAbierto: null,
    });

    const arqueo = await servicioCon(tx).abrir(ctx, 'c-1', ABRIR);

    expect(arqueo.estado).toBe('ABIERTO');
    expect(arqueo.saldo_sistema).toBe('80000');
    expect(inserts).toHaveLength(1);
  });

  it('congela saldo_sistema en 0 si la caja no tiene movimientos', async () => {
    const { tx, inserts } = txFalso({ saldo: undefined, arqueoAbierto: null });

    const arqueo = await servicioCon(tx).abrir(ctx, 'c-1', ABRIR);

    expect(arqueo.saldo_sistema).toBe('0');
    expect(inserts).toHaveLength(1);
  });

  it('rechaza sin insertar si ya hay un arqueo abierto', async () => {
    const { tx, inserts } = txFalso();

    await expect(servicioCon(tx).abrir(ctx, 'c-1', ABRIR)).rejects.toThrow(
      BadRequestException,
    );
    expect(inserts).toHaveLength(0);
  });

  it('rechaza si la caja no existe o está inactiva', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM caja WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(
      servicioCon(tx).abrir(ctx, 'inexistente', ABRIR),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('CajaArqueoService.cerrar', () => {
  const CERRAR_SIN_DIFERENCIA: CerrarArqueoDto = { saldoContado: 80_000 };

  it('sin diferencia: cierra sin asentar ni generar movimiento correctivo', async () => {
    const { tx, updates } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const { fake: movimientos, registrarAjusteArqueo } = movimientosFalso();

    const cerrado = await servicioCon(tx, contabilidad, movimientos).cerrar(
      ctx,
      'c-1',
      CERRAR_SIN_DIFERENCIA,
    );

    expect(cerrado.estado).toBe('CERRADO');
    expect(cerrado.diferencia).toBe('0');
    expect(cerrado.asiento_ajuste_id).toBeNull();
    expect(asentar).not.toHaveBeenCalled();
    expect(registrarAjusteArqueo).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it('contado billete por billete: guarda el conteo y cierra con lo que suma', async () => {
    const { tx, updates, denominaciones } = txFalso();
    const { fake: movimientos, registrarAjusteArqueo } = movimientosFalso();

    await servicioCon(tx, contabilidadFalso().fake, movimientos).cerrar(
      ctx,
      'c-1',
      {
        denominaciones: [
          { tipo: 'BILLETE', denominacion: 50_000, cantidad: 1 },
          { tipo: 'BILLETE', denominacion: 10_000, cantidad: 3 },
          { tipo: 'MONEDA', denominacion: 500, cantidad: 0 },
        ],
      },
    );

    // 50.000 + 30.000 = 80.000: cuadra, sin ajuste.
    expect(registrarAjusteArqueo).not.toHaveBeenCalled();
    expect(denominaciones).toEqual([
      ['e-1', 'arq-1', 'BILLETE', 50_000, 1],
      ['e-1', 'arq-1', 'BILLETE', 10_000, 3],
    ]);
    expect(updates[0][1]).toBe(80_000);
  });

  it('rechaza sin tocar la base si el conteo y el total no coinciden', async () => {
    const { tx, updates, denominaciones } = txFalso();

    await expect(
      servicioCon(tx).cerrar(ctx, 'c-1', {
        saldoContado: 90_000,
        denominaciones: [
          { tipo: 'BILLETE', denominacion: 20_000, cantidad: 4 },
        ],
      }),
    ).rejects.toThrow(/uno de los dos está mal/);
    expect((tx.query as jest.Mock).mock.calls).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(denominaciones).toHaveLength(0);
  });

  it('faltante asumido: débito al gasto, crédito a la caja, movimiento EGRESO', async () => {
    const { tx, updates } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const { fake: movimientos, registrarAjusteArqueo } = movimientosFalso();

    const cerrado = await servicioCon(tx, contabilidad, movimientos).cerrar(
      ctx,
      'c-1',
      { saldoContado: 75_000, tratamientoFaltante: 'EMPRESA' },
    );

    expect(cerrado.diferencia).toBe('-5000');
    expect(cerrado.asiento_ajuste_id).toBe('asiento-ajuste-1');

    const [, dtoAsiento, origen] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
      { origenTipo: string; origenId: string },
    ];
    expect(origen.origenTipo).toBe('MOVIMIENTO_CAJA');
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-asumido', debito: 5000, credito: 0 },
      { cuentaId: 'cta-1', debito: 0, credito: 5000 },
    ]);

    expect(registrarAjusteArqueo).toHaveBeenCalledWith(
      ctx,
      'c-1',
      expect.objectContaining({
        tipo: 'EGRESO',
        valor: 5000,
        saldoValor: 75_000,
        asientoId: 'asiento-ajuste-1',
      }),
      tx,
    );
    // tratamiento y responsable quedan escritos en el arqueo
    expect(updates[0].slice(6)).toEqual(['EMPRESA', null]);
  });

  it('faltante cobrable: a la cuenta por cobrar, con el responsable de la caja como tercero', async () => {
    const { tx, updates } = txFalso({ responsable: 'ter-cajero' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    await servicioCon(tx, contabilidad, movimientosFalso().fake).cerrar(
      ctx,
      'c-1',
      { saldoContado: 75_000, tratamientoFaltante: 'RESPONSABLE' },
    );

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      {
        cuentaId: 'cta-cobrable',
        debito: 5000,
        credito: 0,
        terceroId: 'ter-cajero',
      },
      { cuentaId: 'cta-1', debito: 0, credito: 5000 },
    ]);
    expect(updates[0].slice(6)).toEqual(['RESPONSABLE', 'ter-cajero']);
  });

  it('faltante cobrable: quien cierra puede cobrárselo a otra persona', async () => {
    const { tx, updates } = txFalso({ responsable: 'ter-cajero' });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    await servicioCon(tx, contabilidad, movimientosFalso().fake).cerrar(
      ctx,
      'c-1',
      {
        saldoContado: 75_000,
        tratamientoFaltante: 'RESPONSABLE',
        responsableTerceroId: 'ter-reemplazo',
      },
    );

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    expect(dtoAsiento.lineas[0].terceroId).toBe('ter-reemplazo');
    expect(updates[0][7]).toBe('ter-reemplazo');
  });

  it('rechaza cobrar un faltante si no hay a quién', async () => {
    const { tx, updates } = txFalso({ responsable: null });
    const { fake: contabilidad, asentar } = contabilidadFalso();

    await expect(
      servicioCon(tx, contabilidad, movimientosFalso().fake).cerrar(
        ctx,
        'c-1',
        {
          saldoContado: 75_000,
          tratamientoFaltante: 'RESPONSABLE',
        },
      ),
    ).rejects.toThrow(/elige a quién/);
    expect(asentar).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('rechaza un faltante sin decir quién lo asume', async () => {
    const { tx, updates } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();

    await expect(
      servicioCon(tx, contabilidad, movimientosFalso().fake).cerrar(
        ctx,
        'c-1',
        {
          saldoContado: 75_000,
        },
      ),
    ).rejects.toThrow(/asume la empresa o lo paga el responsable/);
    expect(asentar).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('sobrante: débito a la caja, crédito a sobrantes, movimiento INGRESO', async () => {
    const { tx, updates } = txFalso();
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const { fake: movimientos, registrarAjusteArqueo } = movimientosFalso();

    const cerrado = await servicioCon(tx, contabilidad, movimientos).cerrar(
      ctx,
      'c-1',
      // Con sobrante, el tratamiento no aplica y se ignora.
      { saldoContado: 90_000, tratamientoFaltante: 'RESPONSABLE' },
    );

    expect(cerrado.diferencia).toBe('10000');

    const [, dtoAsiento] = asentar.mock.calls[0] as unknown as [
      unknown,
      { lineas: Array<Record<string, unknown>> },
    ];
    expect(dtoAsiento.lineas).toEqual([
      { cuentaId: 'cta-sobrante', debito: 0, credito: 10_000 },
      { cuentaId: 'cta-1', debito: 10_000, credito: 0 },
    ]);
    expect(registrarAjusteArqueo).toHaveBeenCalledWith(
      ctx,
      'c-1',
      expect.objectContaining({ tipo: 'INGRESO', valor: 10_000 }),
      tx,
    );
    expect(updates[0].slice(6)).toEqual([null, null]);
  });

  it('rechaza sin asentar si el concepto no tiene cuenta configurada', async () => {
    const { tx, updates } = txFalso({
      cuentas: { cuenta_sobrante_id: 'cta-sobrante' },
    });
    const { fake: contabilidad, asentar } = contabilidadFalso();
    const { fake: movimientos, registrarAjusteArqueo } = movimientosFalso();

    await expect(
      servicioCon(tx, contabilidad, movimientos).cerrar(ctx, 'c-1', {
        saldoContado: 75_000,
        tratamientoFaltante: 'EMPRESA',
      }),
    ).rejects.toThrow(/Faltante asumido por la empresa/);
    expect(asentar).not.toHaveBeenCalled();
    expect(registrarAjusteArqueo).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('rechaza si la empresa no tiene el comprobante CD sembrado', async () => {
    const { tx, updates } = txFalso();
    const { fake: contabilidad } = contabilidadFalso(null);
    const { fake: movimientos, registrarAjusteArqueo } = movimientosFalso();

    await expect(
      servicioCon(tx, contabilidad, movimientos).cerrar(ctx, 'c-1', {
        saldoContado: 75_000,
        tratamientoFaltante: 'EMPRESA',
      }),
    ).rejects.toThrow(/comprobante de diario/);
    expect(registrarAjusteArqueo).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('rechaza si esta caja no tiene un arqueo abierto', async () => {
    const { tx } = txFalso({ arqueoAbierto: null });

    await expect(
      servicioCon(tx).cerrar(ctx, 'c-1', CERRAR_SIN_DIFERENCIA),
    ).rejects.toThrow(BadRequestException);
  });

  it('rechaza si la caja no existe o está inactiva', async () => {
    const tx = {
      query: jest.fn((sql: string) => {
        if (sql.includes('FROM caja WHERE')) return [];
        throw new Error(`Query inesperada en el test: ${sql}`);
      }),
    } as unknown as Tx;

    await expect(
      servicioCon(tx).cerrar(ctx, 'inexistente', CERRAR_SIN_DIFERENCIA),
    ).rejects.toThrow(NotFoundException);
  });
});
