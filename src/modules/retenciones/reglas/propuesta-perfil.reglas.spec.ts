import {
  aplicarCambios,
  cambiosDesdeFactura,
  huellaDe,
  type PerfilParaComparar,
} from './propuesta-perfil.reglas';

const ordinario: PerfilParaComparar = {
  regimenRenta: 'ORDINARIO',
  esResponsableIva: true,
  esGranContribuyente: false,
  esAutorretenedorRenta: false,
  ciiuPrincipal: '4659',
};

const nada = {
  regimenSimple: null,
  responsableIva: null,
  granContribuyente: null,
  autorretenedorRenta: null,
  ciiu: null,
};

describe('cambiosDesdeFactura (Fase 8, §8.8)', () => {
  it('una factura que no dice nada no propone nada', () => {
    expect(cambiosDesdeFactura(ordinario, nada)).toEqual([]);
  });

  it('lo que coincide con el perfil no se propone', () => {
    expect(
      cambiosDesdeFactura(ordinario, {
        ...nada,
        responsableIva: true,
        ciiu: '4659',
      }),
    ).toEqual([]);
  });

  it('régimen simple, no responsable de IVA y otro CIIU', () => {
    const c = cambiosDesdeFactura(ordinario, {
      ...nada,
      regimenSimple: true,
      responsableIva: false,
      ciiu: '4711',
    });
    expect(c.map((x) => [x.campo, x.propuesto])).toEqual([
      ['regimenRenta', 'SIMPLE'],
      ['esResponsableIva', false],
      ['ciiuPrincipal', '4711'],
    ]);
    expect(c[0].texto).toMatch(/régimen simple/);
  });

  it('no decir «gran contribuyente» no prueba nada; decirlo sí', () => {
    expect(
      cambiosDesdeFactura(
        { ...ordinario, esGranContribuyente: true },
        {
          ...nada,
          granContribuyente: false,
        },
      ),
    ).toEqual([]);
    expect(
      cambiosDesdeFactura(ordinario, { ...nada, granContribuyente: true })[0]
        .campo,
    ).toBe('esGranContribuyente');
  });

  it('un CIIU mal leído no se propone', () => {
    expect(cambiosDesdeFactura(ordinario, { ...nada, ciiu: '46' })).toEqual([]);
  });
});

describe('huellaDe y aplicarCambios', () => {
  it('la misma propuesta en otro orden da la misma huella', () => {
    const a = cambiosDesdeFactura(ordinario, {
      ...nada,
      regimenSimple: true,
      ciiu: '4711',
    });
    expect(huellaDe(a)).toBe(huellaDe([...a].reverse()));
  });

  it('aplica los cambios sobre el perfil vigente', () => {
    const nuevo = aplicarCambios(
      { ...ordinario, esAutorretenedorRenta: true },
      cambiosDesdeFactura(ordinario, { ...nada, regimenSimple: true }),
    );
    expect(nuevo.regimenRenta).toBe('SIMPLE');
    // El simple sustituye la renta: no queda como autorretenedor.
    expect(nuevo.esAutorretenedorRenta).toBe(false);
    expect(nuevo.ciiuPrincipal).toBe('4659');
  });
});
