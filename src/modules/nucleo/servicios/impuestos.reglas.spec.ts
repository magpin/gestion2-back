import {
  agenteIva,
  preguntaDe,
  respuestaDe,
  resumir,
} from './impuestos.reglas';

describe('paso Impuestos — respuestas', () => {
  it('el IVA se contesta con el 48 o el 49; sin ninguno, nadie contestó', () => {
    const iva = preguntaDe('IVA');
    expect(respuestaDe(iva, ['RESPONSABLE_IVA'], false)).toBe(true);
    expect(respuestaDe(iva, ['NO_RESPONSABLE_IVA'], false)).toBe(false);
    expect(respuestaDe(iva, [], true)).toBeNull();
  });

  it('un «no» sin código solo existe si alguien confirmó el paso', () => {
    const gc = preguntaDe('GRAN_CONTRIBUYENTE');
    expect(respuestaDe(gc, ['RESPONSABLE_IVA'], false)).toBeNull();
    expect(respuestaDe(gc, ['RESPONSABLE_IVA'], true)).toBe(false);
    expect(respuestaDe(gc, ['GRAN_CONTRIBUYENTE'], false)).toBe(true);
  });

  it('el «No» que contestó la persona se ve antes de confirmar (bug #18)', () => {
    const simple = preguntaDe('SIMPLE');
    expect(respuestaDe(simple, [], false, ['SIMPLE'])).toBe(false);
    // Solo el de esa pregunta.
    expect(respuestaDe(simple, [], false, ['AUTORRETENEDOR'])).toBeNull();
    // El código abierto (el RUT) manda sobre el «No» anotado.
    expect(respuestaDe(simple, ['REGIMEN_SIMPLE'], false, ['SIMPLE'])).toBe(
      true,
    );
    // El IVA tiene su código de «no» (49): la lista no lo toca.
    expect(respuestaDe(preguntaDe('IVA'), [], false, ['IVA'])).toBeNull();
  });
});

describe('paso Impuestos — lo deducido no se pregunta', () => {
  it('el gran contribuyente es agente de IVA por el numeral 1', () => {
    expect(agenteIva(['GRAN_CONTRIBUYENTE'])).toMatchObject({ es: true });
    expect(agenteIva(['AGENTE_RETENEDOR_RENTA'])).toMatchObject({ es: false });
  });
});

describe('paso Impuestos — «Lo que esto significa para usted»', () => {
  it('agente de renta, responsable de IVA y agente de ICA en Medellín', () => {
    const r = resumir(
      ['AGENTE_RETENEDOR_RENTA', 'RESPONSABLE_IVA'],
      ['Medellín'],
    );
    expect(r.vasARetener).toEqual([
      expect.stringMatching(/^Retención en la fuente/),
      'ReteICA en Medellín.',
    ]);
    expect(r.teVanARetener).toEqual(
      expect.arrayContaining([expect.stringMatching(/^ReteIVA/)]),
    );
  });

  it('el gran contribuyente retiene renta e IVA', () => {
    const r = resumir(['GRAN_CONTRIBUYENTE'], []);
    expect(r.vasARetener).toHaveLength(2);
  });

  it('en el SIMPLE no le retienen renta', () => {
    const r = resumir(['REGIMEN_SIMPLE'], []);
    expect(r.vasARetener).toEqual([]);
    expect(r.teVanARetener[0]).toMatch(/SIMPLE/);
  });

  it('varios municipios se leen como una frase', () => {
    expect(resumir([], ['Medellín', 'Pereira', 'Cali']).vasARetener).toEqual([
      'ReteICA en Medellín, Pereira y Cali.',
    ]);
  });
});
