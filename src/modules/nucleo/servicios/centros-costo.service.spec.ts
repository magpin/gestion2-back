import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import { CentrosCostoService } from './centros-costo.service';

const ctx: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles: ['DIRECTOR'],
};

type Responder = (sql: string, params: unknown[]) => unknown[] | undefined;

/**
 * Un `Tx` que contesta con la primera regla que reconozca la consulta. Lo que
 * nadie reconoce falla: así una consulta nueva no pasa en silencio.
 */
function txFalso(responder: Responder) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    query: jest.fn((sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      const r = responder(sql, params);
      if (r === undefined) {
        throw new Error(`Consulta inesperada en el test: ${sql}`);
      }
      return Promise.resolve(r);
    }),
  } as unknown as Tx;
  return { tx, consultas };
}

const servicio = (tx: Tx) =>
  new CentrosCostoService({
    enContexto: (_: unknown, fn: (t: Tx) => Promise<unknown>) => fn(tx),
  } as unknown as TxService);

const centro = (extra: Record<string, unknown> = {}) => ({
  id: 'c-1',
  codigo: 'ADM',
  nombre: 'Administración',
  activo: true,
  padre_id: null,
  sede_id: null,
  sede_nombre: null,
  tipo: 'ADMINISTRATIVO',
  es_por_defecto: false,
  agrupa: false,
  ...extra,
});

describe('CentrosCostoService.fijarManejo', () => {
  it('no enciende sin centro por defecto', async () => {
    const { tx, consultas } = txFalso((sql) =>
      sql.includes('es_por_defecto AND activo') ? [] : undefined,
    );
    await expect(servicio(tx).fijarManejo(ctx, true)).rejects.toThrow(
      /elija cuál es el de por defecto/,
    );
    expect(consultas.some((c) => c.sql.includes('UPDATE'))).toBe(false);
  });

  it('al encender marca las cuentas 4 a 7 y prende el interruptor', async () => {
    const { tx, consultas } = txFalso((sql) => {
      if (sql.includes('es_por_defecto AND activo')) return [{ id: 'c-1' }];
      if (sql.includes('UPDATE')) return [];
      return undefined;
    });
    await servicio(tx).fijarManejo(ctx, true);
    const cuentas = consultas.find((c) => c.sql.includes('empresa_cuenta'))!;
    expect(cuentas.params).toEqual([true, ['4', '5', '6', '7']]);
    const config = consultas.find((c) =>
      c.sql.includes('empresa_configuracion_contable'),
    )!;
    expect(config.params).toEqual([true, 'e-1']);
  });

  it('al apagar desmarca sin pedir centro por defecto', async () => {
    const { tx, consultas } = txFalso((sql) =>
      sql.includes('UPDATE') ? [] : undefined,
    );
    await servicio(tx).fijarManejo(ctx, false);
    expect(consultas).toHaveLength(2);
    expect(consultas[0].params).toEqual([false, ['4', '5', '6', '7']]);
  });
});

describe('CentrosCostoService.desactivar', () => {
  it('no desactiva el de por defecto', async () => {
    const { tx } = txFalso((sql) =>
      sql.includes('WHERE c.id = $1')
        ? [centro({ es_por_defecto: true })]
        : undefined,
    );
    await expect(servicio(tx).desactivar(ctx, 'c-1')).rejects.toThrow(
      /elija otro como por defecto/,
    );
  });

  it('no desactiva un agrupador con hijos activos, y los nombra', async () => {
    const { tx } = txFalso((sql) => {
      if (sql.includes('WHERE c.id = $1')) return [centro({ agrupa: true })];
      if (sql.includes('padre_id = $1 AND activo'))
        return [{ codigo: 'N-V' }, { codigo: 'N-B' }];
      return undefined;
    });
    await expect(servicio(tx).desactivar(ctx, 'c-1')).rejects.toThrow(
      'Este centro agrupa centros activos (N-V, N-B): desactívelos primero.',
    );
  });

  it('desactiva y le quita el centro a quien lo tenía como suyo', async () => {
    const { tx, consultas } = txFalso((sql) => {
      if (sql.includes('WHERE c.id = $1')) return [centro()];
      if (sql.includes('padre_id = $1 AND activo')) return [];
      if (sql.startsWith('UPDATE') || sql.startsWith('DELETE')) return [];
      return undefined;
    });
    await servicio(tx).desactivar(ctx, 'c-1');
    expect(
      consultas.some((c) =>
        c.sql.startsWith('DELETE FROM usuario_empresa_centro'),
      ),
    ).toBe(true);
  });

  it('un centro que no existe: 404', async () => {
    const { tx } = txFalso((sql) =>
      sql.includes('WHERE c.id = $1') ? [] : undefined,
    );
    await expect(servicio(tx).desactivar(ctx, 'c-9')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('CentrosCostoService.editar', () => {
  it('no deja quitar la marca de por defecto sin elegir otro', async () => {
    const { tx } = txFalso((sql) =>
      sql.includes('WHERE c.id = $1')
        ? [centro({ es_por_defecto: true })]
        : undefined,
    );
    await expect(
      servicio(tx).editar(ctx, 'c-1', { esPorDefecto: false }),
    ).rejects.toThrow(/siempre tiene que haber uno/);
  });

  it('marcar uno como por defecto le quita la marca al anterior', async () => {
    const { tx, consultas } = txFalso((sql) => {
      if (sql.includes('WHERE c.id = $1')) return [centro()];
      if (sql.startsWith('UPDATE') || sql.trimStart().startsWith('UPDATE'))
        return [];
      return undefined;
    });
    await servicio(tx).editar(ctx, 'c-1', { esPorDefecto: true });
    const updates = consultas.filter((c) =>
      c.sql.trimStart().startsWith('UPDATE'),
    );
    expect(updates[0].sql).toContain('SET es_por_defecto = false');
  });

  it('padreId en null lo quita; ausente, no lo toca', async () => {
    const { tx, consultas } = txFalso((sql) => {
      if (sql.includes('WHERE c.id = $1')) return [centro()];
      if (sql.trimStart().startsWith('UPDATE')) return [];
      return undefined;
    });
    await servicio(tx).editar(ctx, 'c-1', { padreId: null });
    await servicio(tx).editar(ctx, 'c-1', { nombre: 'Gerencia' });
    const [quita, noToca] = consultas
      .filter((c) => c.sql.trimStart().startsWith('UPDATE'))
      .map((c) => c.params);
    expect(quita.slice(2, 4)).toEqual([true, null]);
    expect(noToca.slice(2, 4)).toEqual([false, null]);
  });
});

describe('CentrosCostoService.propuesto', () => {
  const sinManejo: Responder = (sql) =>
    sql.includes('maneja_centro_de_costo') ? [{ maneja: false }] : undefined;

  it('si la empresa no maneja centros, null aunque se elija uno', async () => {
    const { tx } = txFalso(sinManejo);
    await expect(
      servicio(tx).propuesto(ctx, { elegido: 'c-1' }),
    ).resolves.toBeNull();
  });

  it('el elegido se valida: desactivado no', async () => {
    const { tx } = txFalso((sql) => {
      if (sql.includes('maneja_centro_de_costo')) return [{ maneja: true }];
      if (sql.includes('WHERE c.id = $1')) return [centro({ activo: false })];
      return undefined;
    });
    await expect(
      servicio(tx).propuesto(ctx, { elegido: 'c-1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('el elegido se valida: agrupador no', async () => {
    const { tx } = txFalso((sql) => {
      if (sql.includes('maneja_centro_de_costo')) return [{ maneja: true }];
      if (sql.includes('WHERE c.id = $1')) return [centro({ agrupa: true })];
      return undefined;
    });
    await expect(
      servicio(tx).propuesto(ctx, { elegido: 'c-1' }),
    ).rejects.toThrow(/agrupa otros/);
  });

  it('sin elegido: usuario, luego sede, luego por defecto', async () => {
    const respuesta =
      (r: Record<string, string | null>): Responder =>
      (sql) => {
        if (sql.includes('maneja_centro_de_costo')) return [{ maneja: true }];
        if (sql.includes('AS por_defecto')) return [r];
        return undefined;
      };
    const conTodo = { usuario: 'u', sede: 's', por_defecto: 'd' };
    await expect(
      servicio(txFalso(respuesta(conTodo)).tx).propuesto(ctx, {}),
    ).resolves.toBe('u');
    await expect(
      servicio(txFalso(respuesta({ ...conTodo, usuario: null })).tx).propuesto(
        ctx,
        { sedeId: 'sede-1' },
      ),
    ).resolves.toBe('s');
    await expect(
      servicio(
        txFalso(respuesta({ usuario: null, sede: null, por_defecto: 'd' })).tx,
      ).propuesto(ctx, {}),
    ).resolves.toBe('d');
  });
});

describe('CentrosCostoService.crearDesdeSedes', () => {
  it('un centro por sede sin el suyo; la principal es la de por defecto si no hay otra', async () => {
    const { tx, consultas } = txFalso((sql) => {
      if (sql.includes('FROM empresa_sede s'))
        return [
          {
            id: 's-1',
            codigo: 'PPAL',
            nombre: 'Principal',
            es_principal: true,
          },
          { id: 's-2', codigo: 'ADM', nombre: 'Norte', es_principal: false },
        ];
      if (sql.includes('es_por_defecto AND activo')) return [];
      if (sql.startsWith('SELECT codigo FROM')) return [{ codigo: 'ADM' }];
      if (sql.includes('INSERT INTO')) return [];
      if (sql.includes('ORDER BY c.codigo')) return [];
      return undefined;
    });
    await servicio(tx).crearDesdeSedes(ctx);
    const inserts = consultas
      .filter((c) => c.sql.includes('INSERT INTO'))
      .map((c) => c.params);
    // El código de la sede ya lo usa otro centro: se le agrega -2.
    expect(inserts).toEqual([
      ['e-1', 'PPAL', 'Principal', 's-1', true],
      ['e-1', 'ADM-2', 'Norte', 's-2', false],
    ]);
  });
});

describe('CentrosCostoService.fijarDeUsuario', () => {
  it('rechaza un usuario que no trabaja en la empresa', async () => {
    const { tx } = txFalso((sql) =>
      sql.includes('usuario_empresa_rol') ? [] : undefined,
    );
    await expect(
      servicio(tx).fijarDeUsuario(ctx, 'u-9', 'c-1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('null le quita el centro', async () => {
    const { tx, consultas } = txFalso((sql) => {
      if (sql.includes('usuario_empresa_rol')) return [{ ok: true }];
      if (sql.startsWith('DELETE')) return [];
      return undefined;
    });
    await servicio(tx).fijarDeUsuario(ctx, 'u-2', null);
    expect(consultas.at(-1)!.sql).toContain(
      'DELETE FROM usuario_empresa_centro',
    );
  });
});
