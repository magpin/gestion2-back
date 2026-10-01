import {
  completarCentros,
  expandirRepartos,
  repartirValor,
  resolverCentro,
} from './centros-costo.reglas';

describe('resolverCentro', () => {
  const todos = {
    renglon: 'r',
    cabecera: 'c',
    usuario: 'u',
    sedeCaja: 's',
    porDefecto: 'd',
  };

  it('gana el renglón sobre todo lo demás', () => {
    expect(resolverCentro(todos)).toBe('r');
  });

  it('sigue el orden: cabecera, usuario, sede de la caja, por defecto', () => {
    expect(resolverCentro({ ...todos, renglon: null })).toBe('c');
    expect(resolverCentro({ ...todos, renglon: null, cabecera: null })).toBe(
      'u',
    );
    expect(
      resolverCentro({ sedeCaja: 's', porDefecto: 'd', usuario: undefined }),
    ).toBe('s');
    expect(resolverCentro({ porDefecto: 'd' })).toBe('d');
  });

  it('salta los vacíos aunque estén antes', () => {
    expect(resolverCentro({ renglon: '', cabecera: null, usuario: 'u' })).toBe(
      'u',
    );
  });

  it('sin nada, null', () => {
    expect(resolverCentro({})).toBeNull();
  });
});

describe('completarCentros', () => {
  const exigen = new Set(['gasto', 'ingreso']);

  it('pone el de por defecto solo en las cuentas que lo exigen y no lo traen', () => {
    const lineas = [
      { cuentaId: 'gasto', debito: 100 },
      { cuentaId: 'ingreso', centroCostoId: 'norte', credito: 60 },
      { cuentaId: 'caja', credito: 40 },
    ];
    expect(completarCentros(lineas, exigen, 'adm')).toEqual([
      { cuentaId: 'gasto', debito: 100, centroCostoId: 'adm' },
      { cuentaId: 'ingreso', centroCostoId: 'norte', credito: 60 },
      { cuentaId: 'caja', credito: 40 },
    ]);
  });

  it('sin centro por defecto deja las líneas como vienen', () => {
    const lineas = [{ cuentaId: 'gasto' }];
    expect(completarCentros(lineas, exigen, null)).toBe(lineas);
  });
});

describe('repartirValor', () => {
  it('el arriendo 60 / 40', () => {
    expect(
      repartirValor(2_000_000, [
        { centroCostoId: 'n', porcentaje: 60 },
        { centroCostoId: 's', porcentaje: 40 },
      ]),
    ).toEqual([
      { centroCostoId: 'n', valor: 1_200_000 },
      { centroCostoId: 's', valor: 800_000 },
    ]);
  });

  it('en tercios, el último absorbe el redondeo y suman exacto', () => {
    const partes = repartirValor(100, [
      { centroCostoId: 'a', porcentaje: 33.3333 },
      { centroCostoId: 'b', porcentaje: 33.3333 },
      { centroCostoId: 'c', porcentaje: 33.3334 },
    ]);
    expect(partes.map((p) => p.valor)).toEqual([33.33, 33.33, 33.34]);
    expect(partes.reduce((s, p) => s + Math.round(p.valor * 100), 0)).toBe(
      10000,
    );
  });

  it('rechaza porcentajes que no suman 100', () => {
    expect(() =>
      repartirValor(100, [{ centroCostoId: 'a', porcentaje: 90 }]),
    ).toThrow(/100 %/);
  });
});

describe('expandirRepartos', () => {
  const repartos = new Map([
    [
      'r-1',
      [
        { centroCostoId: 'n', porcentaje: 60 },
        { centroCostoId: 's', porcentaje: 40 },
      ],
    ],
  ]);

  it('parte la línea con reparto y deja las demás', () => {
    const lineas = [
      {
        cuentaId: 'arriendo',
        debito: 1000,
        credito: 0,
        repartoId: 'r-1',
        conceptoId: 'k',
      },
      { cuentaId: 'proveedores', debito: 0, credito: 1000 },
    ];
    expect(expandirRepartos(lineas, repartos)).toEqual([
      {
        cuentaId: 'arriendo',
        debito: 600,
        credito: 0,
        repartoId: undefined,
        conceptoId: 'k',
        centroCostoId: 'n',
      },
      {
        cuentaId: 'arriendo',
        debito: 400,
        credito: 0,
        repartoId: undefined,
        conceptoId: 'k',
        centroCostoId: 's',
      },
      { cuentaId: 'proveedores', debito: 0, credito: 1000 },
    ]);
  });

  it('una línea crédito se reparte en crédito (la nota que devuelve)', () => {
    const [a, b] = expandirRepartos(
      [{ cuentaId: 'arriendo', debito: 0, credito: 500, repartoId: 'r-1' }],
      repartos,
    );
    expect([a.credito, b.credito]).toEqual([300, 200]);
  });

  it('un reparto que no está, error', () => {
    expect(() =>
      expandirRepartos(
        [{ cuentaId: 'x', debito: 1, repartoId: 'r-9' }],
        repartos,
      ),
    ).toThrow(/no existe/);
  });
});
