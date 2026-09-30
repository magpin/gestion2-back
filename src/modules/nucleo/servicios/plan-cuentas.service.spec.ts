import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { PlanCuentasService } from './plan-cuentas.service';

interface Cuenta {
  id: string;
  codigo: string;
  nombre: string;
  codigo_padre: string | null;
  activa: boolean;
  es_auxiliar: boolean;
  exige_tercero: boolean;
  exige_centro_costo: boolean;
  exige_base_gravable: boolean;
}

const ctx = (roles: string[]): CtxEmpresa => ({
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: roles as CtxEmpresa['roles'],
});

/**
 * Un plan de cuentas en memoria, con lo que el servicio le pregunta: las
 * cuentas, sus movimientos y quién apunta a cada una (`caja.cuenta_id`).
 */
function planFalso(
  inicial: Array<Partial<Cuenta> & { codigo: string }>,
  opciones: {
    conMovimiento?: string[];
    cajas?: Array<{ id: string; cuenta_id: string }>;
  } = {},
) {
  let n = 0;
  const cuentas: Cuenta[] = inicial.map((c) => ({
    id: `id-${c.codigo}`,
    nombre: `Cuenta ${c.codigo}`,
    codigo_padre: null,
    activa: true,
    es_auxiliar: true,
    exige_tercero: false,
    exige_centro_costo: false,
    exige_base_gravable: false,
    ...c,
  }));
  const cajas = opciones.cajas ?? [];
  const porCodigo = (codigo: string) =>
    cuentas.find((c) => c.codigo === codigo);

  const query = jest.fn((sql: string, p: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (
      s.startsWith('SELECT id, codigo, nombre, activa, es_auxiliar') &&
      s.includes('WHERE codigo = $1')
    ) {
      const c = porCodigo(p[0] as string);
      return Promise.resolve(c ? [c] : []);
    }
    if (
      s.startsWith('SELECT id, codigo, nombre, activa, es_auxiliar') &&
      s.includes("LIKE codigo || '%'")
    ) {
      const codigo = p[0] as string;
      const padre = cuentas
        .filter(
          (c) => codigo.startsWith(c.codigo) && c.codigo.length < codigo.length,
        )
        .sort((a, b) => b.codigo.length - a.codigo.length)[0];
      return Promise.resolve(padre ? [padre] : []);
    }
    if (s.startsWith('SELECT codigo FROM cuenta_puc')) {
      return Promise.resolve([{ codigo: (p[0] as string).slice(0, 6) }]);
    }
    if (s.startsWith('SELECT nombre FROM cuenta_puc'))
      return Promise.resolve([]);
    if (s.startsWith('SELECT codigo FROM empresa_cuenta WHERE codigo_padre')) {
      return Promise.resolve(
        cuentas
          .filter((c) => c.codigo_padre === p[0])
          .map((c) => ({ codigo: c.codigo })),
      );
    }
    if (s.startsWith('SELECT 1 AS uno FROM asiento_linea')) {
      const c = cuentas.find((x) => x.id === p[0]);
      return Promise.resolve(
        c && opciones.conMovimiento?.includes(c.codigo) ? [{ uno: 1 }] : [],
      );
    }
    if (s.includes('FROM pg_constraint')) {
      return Promise.resolve([{ tabla: 'caja', columna: 'cuenta_id' }]);
    }
    if (s.startsWith('SELECT 1 AS uno FROM caja')) {
      return Promise.resolve(
        cajas.some((k) => k.cuenta_id === p[0]) ? [{ uno: 1 }] : [],
      );
    }
    if (s.startsWith('UPDATE empresa_cuenta SET es_auxiliar = false')) {
      cuentas.find((c) => c.id === p[0])!.es_auxiliar = false;
      return Promise.resolve([]);
    }
    if (s.startsWith('UPDATE caja SET')) {
      for (const k of cajas)
        if (k.cuenta_id === p[1]) k.cuenta_id = p[0] as string;
      return Promise.resolve([]);
    }
    if (s.startsWith('INSERT INTO empresa_cuenta')) {
      const nueva: Cuenta = {
        id: `nueva-${++n}`,
        codigo: p[1] as string,
        nombre: p[2] as string,
        codigo_padre: p[5] as string | null,
        activa: true,
        es_auxiliar: p[6] as boolean,
        exige_tercero: p[7] as boolean,
        exige_centro_costo: p[8] as boolean,
        exige_base_gravable: p[9] as boolean,
      };
      if (porCodigo(nueva.codigo))
        return Promise.reject(new Error('uq_empresa_cuenta'));
      cuentas.push(nueva);
      return Promise.resolve([nueva]);
    }
    if (s.startsWith('SELECT ec.id, ec.codigo')) {
      return Promise.resolve([cuentas.find((c) => c.id === p[0])]);
    }
    if (
      s.startsWith('SELECT codigo, codigo_padre FROM empresa_cuenta WHERE id')
    ) {
      const c = cuentas.find((x) => x.id === p[0]);
      return Promise.resolve(c ? [c] : []);
    }
    if (s.startsWith('SELECT activa FROM empresa_cuenta WHERE codigo')) {
      const c = porCodigo(p[0] as string);
      return Promise.resolve(c ? [c] : []);
    }
    if (s.startsWith('UPDATE empresa_cuenta SET activa = true')) {
      cuentas.find((c) => c.id === p[0])!.activa = true;
      return Promise.resolve([]);
    }
    return Promise.reject(new Error(`Query inesperada: ${s}`));
  });
  const tx = { query } as unknown as Tx;
  const servicio = new PlanCuentasService({
    enContexto: (_c: unknown, fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as TxService);
  return { servicio, cuentas, cajas };
}

describe('PlanCuentasService.crearAuxiliar', () => {
  it('crea la hija con el código que sigue, contando las inactivas', async () => {
    const { servicio } = planFalso([
      { codigo: '111005', es_auxiliar: false },
      { codigo: '11100501', codigo_padre: '111005', activa: false },
    ]);
    const c = await servicio.crearAuxiliar(ctx(['CAJA']), {
      madre: '111005',
      nombre: 'Bancolombia ···1234',
    });
    expect(c.codigo).toBe('11100502');
    expect(c.es_auxiliar).toBe(true);
  });

  it('dos creaciones seguidas dan códigos distintos', async () => {
    const { servicio } = planFalso([{ codigo: '111005', es_auxiliar: false }]);
    const a = await servicio.crearAuxiliar(ctx(['DIRECTOR']), {
      madre: '111005',
      nombre: 'Uno',
    });
    const b = await servicio.crearAuxiliar(ctx(['DIRECTOR']), {
      madre: '111005',
      nombre: 'Dos',
    });
    expect([a.codigo, b.codigo]).toEqual(['11100501', '11100502']);
  });

  it('CAJA no puede crear bajo 5105', async () => {
    const { servicio } = planFalso([{ codigo: '510506', es_auxiliar: false }]);
    await expect(
      servicio.crearAuxiliar(ctx(['CAJA']), {
        madre: '510506',
        nombre: 'Sueldos',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('D5: lo que apuntaba a la madre pasa a una hija con su mismo nombre, y la madre agrupa', async () => {
    const { servicio, cuentas, cajas } = planFalso(
      [{ codigo: '110505', nombre: 'Caja general' }],
      { cajas: [{ id: 'caja-1', cuenta_id: 'id-110505' }] },
    );
    const c = await servicio.crearAuxiliar(ctx(['CAJA']), {
      madre: '110505',
      nombre: 'Caja - Sede norte',
    });

    const madre = cuentas.find((x) => x.codigo === '110505')!;
    const traslado = cuentas.find((x) => x.codigo === '11050501')!;
    expect(madre.es_auxiliar).toBe(false);
    expect(traslado.nombre).toBe('Caja general');
    expect(cajas[0].cuenta_id).toBe(traslado.id);
    expect(c.codigo).toBe('11050502');
  });

  it('D5: si la madre tiene movimientos, rechaza con un mensaje claro', async () => {
    const { servicio } = planFalso([{ codigo: '110505' }], {
      conMovimiento: ['110505'],
    });
    await expect(
      servicio.crearAuxiliar(ctx(['DIRECTOR']), {
        madre: '110505',
        nombre: 'Caja - Sede norte',
      }),
    ).rejects.toThrow(/ya tiene movimientos/);
  });

  it('la madre inactiva no admite hijas', async () => {
    const { servicio } = planFalso([
      { codigo: '111005', es_auxiliar: false, activa: false },
    ]);
    await expect(
      servicio.crearAuxiliar(ctx(['DIRECTOR']), {
        madre: '111005',
        nombre: 'X',
      }),
    ).rejects.toThrow(/inactiva/);
  });
});

describe('PlanCuentasService.activar', () => {
  it('con la madre inactiva, 400: primero la madre', async () => {
    const { servicio } = planFalso([
      { codigo: '111005', activa: false, es_auxiliar: false },
      { codigo: '11100501', codigo_padre: '111005', activa: false },
    ]);
    await expect(
      servicio.activar(ctx(['DIRECTOR']), 'id-11100501'),
    ).rejects.toThrow(BadRequestException);
  });

  it('con la madre activa, la activa', async () => {
    const { servicio, cuentas } = planFalso([
      { codigo: '111005', es_auxiliar: false },
      { codigo: '11100501', codigo_padre: '111005', activa: false },
    ]);
    await servicio.activar(ctx(['DIRECTOR']), 'id-11100501');
    expect(cuentas.find((c) => c.codigo === '11100501')!.activa).toBe(true);
  });
});
