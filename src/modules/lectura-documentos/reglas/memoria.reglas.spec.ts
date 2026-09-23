import { llaveDelRenglon, porQueNoSirve, queAprender } from './memoria.reglas';

describe('llaveDelRenglon — con qué texto se recuerda', () => {
  it('un gasto se reconoce aunque cambie el mes', () => {
    const octubre = llaveDelRenglon({
      clase: 'GASTO',
      descripcion: 'Arrendamiento local comercial mes de OCTUBRE 2026',
    });
    const noviembre = llaveDelRenglon({
      clase: 'GASTO',
      descripcion: 'ARRENDAMIENTO LOCAL COMERCIAL MES DE NOVIEMBRE 2026',
    });

    expect(octubre).toBe('ARRENDAMIENTO LOCAL COMERCIAL MES DE');
    expect(noviembre).toBe(octubre);
  });

  it('en un gasto se quitan fechas y periodos, no solo el año', () => {
    expect(
      llaveDelRenglon({
        clase: 'GASTO',
        descripcion: 'Servicio de aseo periodo 01/10/2026 - 31/10/2026',
      }),
    ).toBe('SERVICIO DE ASEO PERIODO');
  });

  // En un producto los números son el producto: juntarlos mandaría uno al
  // kardex del otro.
  it('en un producto el texto queda entero, números incluidos', () => {
    const medio = llaveDelRenglon({
      clase: 'PRODUCTO',
      descripcion: 'TORNILLO 1/2',
    });
    const tres = llaveDelRenglon({
      clase: 'PRODUCTO',
      descripcion: 'TORNILLO 3/8',
    });

    expect(medio).toBe('TORNILLO 1/2');
    expect(medio).not.toBe(tres);
  });

  it('sin tildes ni mayúsculas que separen lo que es igual', () => {
    expect(
      llaveDelRenglon({
        clase: 'PRODUCTO',
        descripcion: '  Tinta  HP 664 Negra ',
      }),
    ).toBe(
      llaveDelRenglon({ clase: 'PRODUCTO', descripcion: 'TINTA HP 664 NEGRA' }),
    );
  });

  it('un gasto que es solo fecha no tiene con qué recordarse', () => {
    expect(
      llaveDelRenglon({ clase: 'GASTO', descripcion: 'OCTUBRE 2026' }),
    ).toBeNull();
  });
});

describe('porQueNoSirve — lo recordado, contra cómo está hoy', () => {
  const cuenta = {
    clase: 'GASTO' as const,
    existe: true,
    activa: true,
    esAuxiliar: true,
    codigo: '512005',
  };

  it('una cuenta de gasto vigente sirve', () => {
    expect(porQueNoSirve(cuenta)).toBeNull();
  });

  it('una cuenta que dejó de recibir movimientos no', () => {
    expect(porQueNoSirve({ ...cuenta, esAuxiliar: false })).toMatch(
      /no recibe movimientos/,
    );
  });

  it('una cuenta inactiva no', () => {
    expect(porQueNoSirve({ ...cuenta, activa: false })).toMatch(/inactiva/);
  });

  // La misma regla que el cruce por código: un arriendo no va a un banco.
  it('una cuenta que no es de gasto no', () => {
    expect(porQueNoSirve({ ...cuenta, codigo: '111005' })).toMatch(
      /no es de gasto/,
    );
  });

  it('un producto inactivo no', () => {
    expect(
      porQueNoSirve({ clase: 'PRODUCTO', existe: true, activo: false }),
    ).toMatch(/inactivo/);
  });

  it('lo que ya no existe no', () => {
    expect(
      porQueNoSirve({ clase: 'PRODUCTO', existe: false, activo: false }),
    ).toMatch(/no existe/);
  });
});

describe('queAprender — de personas, nunca de sí misma', () => {
  const renglon = (
    orden: number,
    descripcion: string,
    forma?: 'CODIGO' | 'UNICA_COINCIDENCIA' | 'APRENDIDO',
  ) => ({
    orden,
    leido: { clase: 'GASTO' as const, descripcion },
    ...(forma !== undefined && { forma }),
  });

  it('guarda lo que contestó una persona', () => {
    expect(
      queAprender(
        [renglon(1, 'ARRIENDO OCTUBRE')],
        [{ orden: 1, cuentaId: 'c1' }],
      ),
    ).toEqual([
      {
        tipo: 'RESPUESTA',
        clase: 'GASTO',
        texto: 'ARRIENDO',
        ejemplo: 'ARRIENDO OCTUBRE',
        cuentaId: 'c1',
      },
    ]);
  });

  // «Era el único que se parecía» aprendido sería un error para siempre.
  it('no guarda lo que el cruce encontró solo', () => {
    expect(
      queAprender(
        [
          renglon(1, 'ASEO', 'CODIGO'),
          renglon(2, 'VIGILANCIA', 'UNICA_COINCIDENCIA'),
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('lo recordado que nadie cambió suma un uso', () => {
    expect(queAprender([renglon(1, 'ARRIENDO', 'APRENDIDO')], [])).toEqual([
      { tipo: 'USO', clase: 'GASTO', texto: 'ARRIENDO' },
    ]);
  });

  it('lo recordado que alguien cambió es una respuesta nueva', () => {
    const [a] = queAprender(
      [renglon(1, 'ARRIENDO', 'APRENDIDO')],
      [{ orden: 1, cuentaId: 'otra' }],
    );
    expect(a).toMatchObject({ tipo: 'RESPUESTA', cuentaId: 'otra' });
  });

  it('dos renglones con el mismo texto: la respuesta le gana al uso', () => {
    const r = queAprender(
      [renglon(1, 'ARRIENDO', 'APRENDIDO'), renglon(2, 'ARRIENDO NOVIEMBRE')],
      [{ orden: 2, cuentaId: 'nueva' }],
    );
    expect(r).toEqual([
      expect.objectContaining({ tipo: 'RESPUESTA', cuentaId: 'nueva' }),
    ]);
  });

  it('una respuesta con producto y cuenta a la vez no se guarda', () => {
    expect(
      queAprender(
        [renglon(1, 'ARRIENDO')],
        [{ orden: 1, productoId: 'p', cuentaId: 'c' }],
      ),
    ).toEqual([]);
  });
});
