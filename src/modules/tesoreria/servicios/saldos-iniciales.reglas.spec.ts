import {
  CONTRAPARTIDA,
  glosaDeApertura,
  lineasDeApertura,
  problemaDeSaldos,
} from './saldos-iniciales.reglas';

describe('saldos-iniciales.reglas', () => {
  it('arma un débito por caja o banco y un solo crédito por el total', () => {
    const lineas = lineasDeApertura(
      [
        {
          medio: 'CAJA',
          id: 'k1',
          cuentaId: '110505',
          nombre: 'Caja principal',
          valor: 1_605_700,
        },
        {
          medio: 'BANCO',
          id: 'b1',
          cuentaId: '111005',
          nombre: 'Bancolombia',
          valor: 46_660_000.5,
        },
      ],
      '310505',
    );
    expect(lineas).toEqual([
      { cuentaId: '110505', debito: 1_605_700, credito: 0 },
      { cuentaId: '111005', debito: 46_660_000.5, credito: 0 },
      { cuentaId: '310505', debito: 0, credito: 48_265_700.5 },
    ]);
    const debitos = lineas.reduce((s, l) => s + l.debito, 0);
    const creditos = lineas.reduce((s, l) => s + l.credito, 0);
    expect(debitos).toBe(creditos);
  });

  it('rechaza sin valores, en cero o repetidos', () => {
    expect(problemaDeSaldos([])).toMatch(/al menos un valor/);
    expect(problemaDeSaldos([{ medio: 'CAJA', id: 'k1', valor: 0 }])).toMatch(
      /mayores que cero/,
    );
    expect(
      problemaDeSaldos([
        { medio: 'BANCO', id: 'b1', valor: 10 },
        { medio: 'BANCO', id: 'b1', valor: 20 },
      ]),
    ).toMatch(/repetida/);
    expect(
      problemaDeSaldos([
        { medio: 'CAJA', id: 'x', valor: 10 },
        { medio: 'BANCO', id: 'x', valor: 20 },
      ]),
    ).toBeNull();
  });

  it('la contrapartida sale del capital o de las utilidades acumuladas', () => {
    expect(CONTRAPARTIDA.SOCIOS).toEqual(['310505', '311505', '313005']);
    expect(CONTRAPARTIDA.ANTES).toEqual(['370505']);
    expect(glosaDeApertura('SOCIOS')).toMatch(/socios/);
    expect(glosaDeApertura('ANTES')).toMatch(/antes/);
  });
});
