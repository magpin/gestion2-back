import {
  madrePermitida,
  proximoCodigoAuxiliar,
  sugerirPlan,
  type HechosPlan,
} from './plan-cuentas.reglas';

/** Una empresa que declaró lo mínimo: sin régimen, sin actividad y sin sector. */
const minima: HechosPlan = {
  tipoPersona: 'JURIDICA',
  formaAsociativa: null,
  sectores: [],
  regimenesVigentes: [],
  responsabilidadesRut: [],
  hechosOperativos: [],
  actividadPrincipal: null,
  manejaCentroCosto: false,
  sedes: [],
  codigosExistentes: [],
};

const con = (cambios: Partial<HechosPlan>): HechosPlan => ({
  ...minima,
  ...cambios,
});
const codigos = (h: HechosPlan) => sugerirPlan(h).cuentas.map((c) => c.codigo);

describe('sugerirPlan · nada se propone sin el hecho que lo justifica', () => {
  it('sin regimen ni casilla 53 no propone ninguna cuenta de impuestos, y lo dice', () => {
    const s = sugerirPlan(minima);
    expect(s.cuentas.some((c) => c.codigo.startsWith('2408'))).toBe(false);
    expect(s.cuentas.some((c) => c.codigo.startsWith('2365'))).toBe(false);

    const falta = s.faltantes.find((f) => f.hecho === 'REGIMEN_TRIBUTARIO');
    expect(falta).toBeDefined();
    expect(falta!.paso).toBe('IMPUESTOS');
  });

  it('sin actividad no propone ingresos ni costo, y lo dice', () => {
    const s = sugerirPlan(minima);
    expect(s.cuentas.some((c) => c.codigo.startsWith('41'))).toBe(false);
    expect(s.faltantes.some((f) => f.hecho === 'ACTIVIDAD_PRINCIPAL')).toBe(
      true,
    );
  });

  it('sin sector no propone inventario ni herramienta', () => {
    const c = codigos(minima);
    expect(c.some((x) => x.startsWith('1435'))).toBe(false);
    expect(c).not.toContain('152410');
  });

  it('sin hechos operativos declarados no propone nada laboral ni de activos', () => {
    const c = codigos(minima);
    expect(c.some((x) => x.startsWith('25'))).toBe(false);
    expect(c).not.toContain('510506');
    expect(c).not.toContain('110510');
  });

  it('el efectivo se propone siempre: no depende de ningun hecho declarado', () => {
    expect(codigos(minima)).toEqual(
      expect.arrayContaining(['110505', '111005']),
    );
  });

  it('cada cuenta propuesta dice por que, y de que bloque viene', () => {
    for (const c of sugerirPlan(minima).cuentas) {
      expect(c.porque.length).toBeGreaterThan(10);
      expect([
        'BASE',
        'PATRIMONIO',
        'IMPUESTOS',
        'GIRO',
        'OPERACION',
      ]).toContain(c.bloque);
    }
  });

  it('ninguna cuenta se propone dos veces aunque dos bloques la justifiquen', () => {
    const c = codigos(
      con({
        sectores: ['SERVICIOS'],
        hechosOperativos: ['TIENE_ACTIVOS_FIJOS'],
        regimenesVigentes: ['RESPONSABLE_IVA', 'AGENTE_RETENEDOR_RENTA'],
      }),
    );
    expect(new Set(c).size).toBe(c.length);
  });
});

describe('sugerirPlan · impuestos derivados del regimen', () => {
  it('responsable de IVA recibe IVA generado y descontable', () => {
    const c = codigos(con({ regimenesVigentes: ['RESPONSABLE_IVA'] }));
    expect(c).toEqual(expect.arrayContaining(['240805', '240810']));
  });

  it('no responsable de IVA no las recibe', () => {
    const c = codigos(con({ regimenesVigentes: ['NO_RESPONSABLE_IVA'] }));
    expect(c).not.toContain('240805');
  });

  it('agente de retencion de IVA recibe la cuenta de IVA retenido', () => {
    const c = codigos(con({ regimenesVigentes: ['AGENTE_RETENEDOR_IVA'] }));
    expect(c).toContain('236705');
  });

  it('agente de retencion de renta recibe las subcuentas de todos los conceptos de retefuente', () => {
    const c = codigos(con({ regimenesVigentes: ['AGENTE_RETENEDOR_RENTA'] }));
    expect(c).toEqual(
      expect.arrayContaining([
        '236515',
        '236520',
        '236525',
        '236530',
        '236535',
        '236540',
        '236545',
        '236550',
        '236570',
      ]),
    );
  });

  it('el autorretenedor suma su propia subcuenta', () => {
    expect(
      codigos(con({ regimenesVigentes: ['AUTORRETENEDOR_RENTA'] })),
    ).toContain('236575');
    // El agente también: le puede tocar autorretenerse al venderle al SIMPLE.
    expect(
      codigos(con({ regimenesVigentes: ['AGENTE_RETENEDOR_RENTA'] })),
    ).toContain('236575');
    expect(
      codigos(con({ regimenesVigentes: ['RESPONSABLE_IVA'] })),
    ).not.toContain('236575');
  });

  it('el regimen simple no provisiona impuesto de renta', () => {
    expect(
      codigos(con({ regimenesVigentes: ['REGIMEN_SIMPLE'] })),
    ).not.toContain('240405');
    expect(
      codigos(con({ regimenesVigentes: ['REGIMEN_ORDINARIO'] })),
    ).toContain('240405');
  });
});

describe('sugerirPlan · la casilla 53 del RUT es una fuente por si sola', () => {
  it('el codigo 48 basta para proponer el IVA, sin regimen cargado', () => {
    const c = codigos(con({ responsabilidadesRut: [48] }));
    expect(c).toEqual(expect.arrayContaining(['240805', '240810']));
  });

  it('el 49 y el 53 no proponen IVA: son las dos formas de decir que no lo cobra', () => {
    expect(codigos(con({ responsabilidadesRut: [49] }))).not.toContain(
      '240805',
    );
    expect(codigos(con({ responsabilidadesRut: [53] }))).not.toContain(
      '240805',
    );
  });

  it('el 7 propone retefuente y el 15 autorretencion', () => {
    expect(codigos(con({ responsabilidadesRut: [7] }))).toContain('236540');
    expect(codigos(con({ responsabilidadesRut: [15] }))).toContain('236575');
  });

  it('el 47 (SIMPLE) no provisiona renta', () => {
    expect(codigos(con({ responsabilidadesRut: [47] }))).not.toContain(
      '240405',
    );
  });

  it('las dos fuentes suman: el RUT no anula lo cargado a mano ni al reves', () => {
    const c = codigos(
      con({
        responsabilidadesRut: [48],
        regimenesVigentes: ['AGENTE_RETENEDOR_ICA'],
      }),
    );
    expect(c).toEqual(expect.arrayContaining(['240805', '236805']));
  });

  it('un codigo que no cambia el plan no alcanza para dar por declarada la condicion', () => {
    // 42 es "obligado a llevar contabilidad": no agrega ni quita una sola cuenta,
    // y sobre todo no dice si la empresa cobra IVA. Un RUT que solo trae eso
    // sigue estando incompleto para armar el plan, y hay que decirlo.
    const s = sugerirPlan(con({ responsabilidadesRut: [42] }));
    expect(s.faltantes.some((f) => f.hecho === 'REGIMEN_TRIBUTARIO')).toBe(
      true,
    );
    expect(s.cuentas.some((c) => c.codigo.startsWith('2408'))).toBe(false);
  });
});

describe('sugerirPlan · condiciones que se contradicen', () => {
  it('responsable y no responsable de IVA a la vez no propone impuestos, y lo dice', () => {
    // Pasa con un RUT viejo: el 11 (ventas regimen comun) llega aca ya resuelto
    // como 48 —la consulta lo normaliza contra codigo_reemplazo— y si ademas
    // quedo abierto NO_RESPONSABLE_IVA, las dos verdades chocan. Elegir una por
    // nuestra cuenta sembraria IVA en quien no lo cobra.
    const s = sugerirPlan(
      con({
        regimenesVigentes: ['NO_RESPONSABLE_IVA'],
        responsabilidadesRut: [48],
      }),
    );
    expect(s.cuentas.some((c) => c.codigo.startsWith('2408'))).toBe(false);

    const falta = s.faltantes.find(
      (f) => f.hecho === 'CONDICION_CONTRADICTORIA',
    );
    expect(falta).toBeDefined();
    expect(falta!.paso).toBe('IMPUESTOS');
  });

  it('el regimen simple y el ordinario tampoco pueden coexistir', () => {
    const s = sugerirPlan(
      con({ regimenesVigentes: ['REGIMEN_SIMPLE', 'REGIMEN_ORDINARIO'] }),
    );
    expect(
      s.faltantes.some((f) => f.hecho === 'CONDICION_CONTRADICTORIA'),
    ).toBe(true);
    expect(s.cuentas.some((c) => c.codigo === '240405')).toBe(false);
  });

  it('sin contradiccion las cuentas de impuestos se proponen normal', () => {
    const s = sugerirPlan(con({ regimenesVigentes: ['RESPONSABLE_IVA'] }));
    expect(
      s.faltantes.some((f) => f.hecho === 'CONDICION_CONTRADICTORIA'),
    ).toBe(false);
    expect(s.cuentas.some((c) => c.codigo === '240805')).toBe(true);
  });
});

describe('sugerirPlan · patrimonio segun la forma juridica', () => {
  it('la persona natural lleva una sola cuenta de capital, sin reserva ni prima', () => {
    const c = codigos(con({ tipoPersona: 'NATURAL' }));
    expect(c).toContain('313005');
    expect(c).not.toContain('330505');
    expect(c).not.toContain('320505');
  });

  it('la S.A.S. lleva capital autorizado, prima y reserva legal', () => {
    const c = codigos(con({ tipoPersona: 'JURIDICA', formaAsociativa: '12' }));
    expect(c).toEqual(
      expect.arrayContaining(['310505', '310510', '320505', '330505']),
    );
  });

  it('la sociedad de personas lleva aportes sociales, no acciones', () => {
    const c = codigos(con({ tipoPersona: 'JURIDICA', formaAsociativa: '10' }));
    expect(c).toContain('311505');
    expect(c).not.toContain('320505');
  });

  it('el resultado del ejercicio va en toda empresa, con cualquier forma', () => {
    for (const h of [
      con({ tipoPersona: 'NATURAL' }),
      con({ formaAsociativa: '12' }),
      con({ formaAsociativa: '10' }),
    ]) {
      expect(codigos(h)).toEqual(
        expect.arrayContaining(['360505', '361005', '370505', '371005']),
      );
    }
  });
});

describe('sugerirPlan · giro derivado del sector', () => {
  it('comercio recibe inventario de mercancias', () => {
    expect(codigos(con({ sectores: ['COMERCIO'] }))).toContain('143501');
  });

  it('manufactura recibe los tres inventarios de produccion', () => {
    const c = codigos(con({ sectores: ['MANUFACTURA'] }));
    expect(c).toEqual(expect.arrayContaining(['140501', '141001', '143005']));
  });

  it('servicios recibe herramienta y su depreciacion', () => {
    const c = codigos(con({ sectores: ['SERVICIOS'] }));
    expect(c).toEqual(expect.arrayContaining(['152410', '159210', '516010']));
  });

  it('el taller mixto recibe la union de los dos, nunca la interseccion', () => {
    const c = codigos(con({ sectores: ['COMERCIO', 'SERVICIOS'] }));
    expect(c).toEqual(expect.arrayContaining(['143501', '152410']));
  });
});

describe('sugerirPlan · hechos que ningun documento declara', () => {
  it('sin empleados no hay pasivo laboral; con empleados aparece completo', () => {
    const sin = codigos(minima);
    expect(sin).not.toContain('250505');

    const con_ = codigos(con({ hechosOperativos: ['TIENE_EMPLEADOS'] }));
    expect(con_).toEqual(
      expect.arrayContaining([
        '250505',
        '251010',
        '251505',
        '252005',
        '252501',
        '237005',
      ]),
    );
    expect(con_).toEqual(
      expect.arrayContaining(['510506', '510530', '510569', '510572']),
    );
  });

  it('la retencion sobre salarios llega con los empleados, no con el regimen', () => {
    expect(
      codigos(con({ regimenesVigentes: ['AGENTE_RETENEDOR_RENTA'] })),
    ).not.toContain('236505');
    expect(codigos(con({ hechosOperativos: ['TIENE_EMPLEADOS'] }))).toContain(
      '236505',
    );
  });

  it('los activos fijos traen el activo, su depreciacion acumulada y el gasto', () => {
    const c = codigos(con({ hechosOperativos: ['TIENE_ACTIVOS_FIJOS'] }));
    expect(c).toEqual(
      expect.arrayContaining([
        '151605',
        '152805',
        '159215',
        '159220',
        '516015',
        '516020',
      ]),
    );
  });

  it('el credito bancario trae el pasivo y los intereses', () => {
    const c = codigos(con({ hechosOperativos: ['TIENE_CREDITO_BANCARIO'] }));
    expect(c).toEqual(expect.arrayContaining(['210510', '530520']));
  });

  it('la caja menor es una sola cuenta', () => {
    expect(codigos(con({ hechosOperativos: ['MANEJA_CAJA_MENOR'] }))).toContain(
      '110510',
    );
  });
});

describe('sugerirPlan · ingresos derivados de la CIIU', () => {
  const actividad = (
    seccion: string,
    division = '46',
    tarifa: number | null = 4.14,
  ) => ({
    codigoCiiu: '4741',
    seccionCiiu: seccion,
    divisionCiiu: division,
    tarifaIcaPorMil: tarifa,
  });

  it('comercio (seccion G) cae en 4135 y su costo en 6135', () => {
    const c = codigos(con({ actividadPrincipal: actividad('G') }));
    expect(c).toEqual(expect.arrayContaining(['4135', '6135']));
  });

  it('ensenanza (seccion P) cae en 4160, no en comercio', () => {
    const c = codigos(con({ actividadPrincipal: actividad('P') }));
    expect(c).toContain('4160');
    expect(c).not.toContain('4135');
  });

  it('pesca se separa de agricultura aunque compartan seccion', () => {
    expect(
      codigos(con({ actividadPrincipal: actividad('A', '03') })),
    ).toContain('4110');
    expect(
      codigos(con({ actividadPrincipal: actividad('A', '01') })),
    ).toContain('4105');
  });

  it('la cuenta de ingresos exige elegir subcuenta: el sistema no la adivina', () => {
    const s = sugerirPlan(con({ actividadPrincipal: actividad('G') }));
    const ingreso = s.cuentas.find((c) => c.codigo === '4135')!;
    expect(ingreso.requiereEleccion).toBe(true);
    expect(ingreso.esAuxiliar).toBe(false);
  });
});

describe('sugerirPlan · ICA, que es municipal y no sale del RUT', () => {
  const conTarifa = (tarifa: number | null) =>
    con({
      regimenesVigentes: ['REGIMEN_ORDINARIO'],
      actividadPrincipal: {
        codigoCiiu: '4741',
        seccionCiiu: 'G',
        divisionCiiu: '47',
        tarifaIcaPorMil: tarifa,
      },
    });

  it('con tarifa propone el gasto y la cuenta por pagar', () => {
    expect(codigos(conTarifa(4.14))).toEqual(
      expect.arrayContaining(['511505', '241205']),
    );
  });

  it('sin tarifa no propone ninguna de las dos, y lo dice', () => {
    const s = sugerirPlan(conTarifa(null));
    expect(s.cuentas.some((c) => c.codigo === '511505')).toBe(false);
    expect(s.cuentas.some((c) => c.codigo === '241205')).toBe(false);
    expect(s.faltantes.some((f) => f.hecho === 'TARIFA_ICA')).toBe(true);
  });
});

describe('sugerirPlan · centros de costo', () => {
  const gastos = (manejaCentroCosto: boolean) =>
    sugerirPlan(
      con({ manejaCentroCosto, hechosOperativos: ['TIENE_EMPLEADOS'] }),
    ).cuentas;

  it('solo se exige centro de costo si la empresa los maneja', () => {
    expect(gastos(false).every((c) => !c.exigeCentroCosto)).toBe(true);
    expect(gastos(true).some((c) => c.exigeCentroCosto)).toBe(true);
  });

  it('nunca se exige en cuentas de balance: un pasivo con centro de costo bloquea el asiento', () => {
    for (const c of gastos(true)) {
      if (c.exigeCentroCosto)
        expect(['4', '5', '6', '7']).toContain(c.codigo[0]);
    }
  });
});

describe('sugerirPlan · sedes y cuentas ya existentes', () => {
  it('propone una caja por sede', () => {
    const c = codigos(
      con({
        sedes: [
          { codigo: '1', nombre: 'Almacén' },
          { codigo: '2', nombre: 'Taller' },
        ],
      }),
    );
    expect(c).toEqual(expect.arrayContaining(['11050501', '11050502']));
  });

  it('no vuelve a proponer lo que la empresa ya tiene', () => {
    expect(codigos(con({ codigosExistentes: ['110505'] }))).not.toContain(
      '110505',
    );
  });

  it('marca como sugerido lo que el decreto deja en rango libre', () => {
    const s = sugerirPlan(con({ regimenesVigentes: ['RESPONSABLE_IVA'] }));
    const iva = s.cuentas.find((c) => c.codigo === '240805')!;
    expect(iva.sugerido).toBe(true);
    expect(iva.rango).toBe('240801 a 240898');
    // Las de codigo fijo no se marcan: ahi el decreto sí manda.
    expect(s.cuentas.find((c) => c.codigo === '110505')!.sugerido).toBe(false);
  });

  it('lo sugerido cuelga de la cuenta de cuatro digitos, no de si misma', () => {
    const s = sugerirPlan(con({ regimenesVigentes: ['RESPONSABLE_IVA'] }));
    expect(s.cuentas.find((c) => c.codigo === '240805')!.codigoPuc).toBe(
      '2408',
    );
  });
});

describe('proximoCodigoAuxiliar', () => {
  it('la primera hija es 01', () => {
    expect(proximoCodigoAuxiliar('110505', [])).toEqual({
      ok: true,
      codigo: '11050501',
    });
  });

  it('cuenta las inactivas: no reusa el número de una desactivada', () => {
    // 11050502 está desactivada, pero sigue en la lista.
    expect(proximoCodigoAuxiliar('110505', ['11050501', '11050502'])).toEqual({
      ok: true,
      codigo: '11050503',
    });
  });

  it('se apoya en el mayor, no en la cantidad', () => {
    expect(proximoCodigoAuxiliar('110505', ['11050507'])).toEqual({
      ok: true,
      codigo: '11050508',
    });
  });

  it('con el rango lleno, error', () => {
    const r = proximoCodigoAuxiliar('110505', ['11050599']);
    expect(r.ok).toBe(false);
  });

  it('no cuenta la madre ni otras ramas', () => {
    expect(proximoCodigoAuxiliar('110505', ['110505', '11051001'])).toEqual({
      ok: true,
      codigo: '11050501',
    });
  });
});

describe('madrePermitida', () => {
  it('director y contador, cualquier madre', () => {
    expect(madrePermitida(['DIRECTOR'], '5105')).toBe(true);
    expect(madrePermitida(['CONTADOR'], '2408')).toBe(true);
  });

  it('caja solo bajo 1105 y 1110', () => {
    expect(madrePermitida(['CAJA'], '110505')).toBe(true);
    expect(madrePermitida(['CAJA'], '111005')).toBe(true);
    expect(madrePermitida(['CAJA'], '5105')).toBe(false);
  });

  it('inventario bajo 1435, 41 y 61', () => {
    expect(madrePermitida(['INVENTARIO'], '143505')).toBe(true);
    expect(madrePermitida(['INVENTARIO'], '4135')).toBe(true);
    expect(madrePermitida(['INVENTARIO'], '6135')).toBe(true);
    expect(madrePermitida(['INVENTARIO'], '1105')).toBe(false);
  });

  it('compras bajo 5, 6 y 1', () => {
    expect(madrePermitida(['COMPRAS'], '5135')).toBe(true);
    expect(madrePermitida(['COMPRAS'], '2205')).toBe(false);
  });
});

describe('sugerirPlan · la depreciación con el código que dice el decreto', () => {
  it('equipo de oficina a 159215 y de cómputo a 159220, no a flota', () => {
    const c = codigos(con({ hechosOperativos: ['TIENE_ACTIVOS_FIJOS'] }));
    expect(c).toEqual(expect.arrayContaining(['159215', '159220']));
    expect(c).not.toContain('159235');
    expect(c).not.toContain('159240');
  });

  it('la herramienta de servicios a 159210 (maquinaria), no a flota aérea', () => {
    const c = codigos(con({ sectores: ['SERVICIOS'] }));
    expect(c).toContain('159210');
    expect(c).not.toContain('159245');
  });

  it('con empleados, la provisión de prima (261020) que usa la plantilla', () => {
    expect(codigos(con({ hechosOperativos: ['TIENE_EMPLEADOS'] }))).toContain(
      '261020',
    );
    expect(codigos(minima)).not.toContain('261020');
  });
});

describe('sugerirPlan · la caja de una sede agregada después', () => {
  it('no choca con el código de otra sede: toma el siguiente libre', () => {
    const c = codigos(
      con({
        sedes: [
          { codigo: '1', nombre: 'Almacén' },
          { codigo: '2', nombre: 'Taller' },
        ],
        codigosExistentes: ['110505', '11050501'],
        cajasExistentes: [{ codigo: '11050501', nombre: 'Caja - Almacén' }],
      }),
    );
    expect(c).toContain('11050502');
    expect(c).not.toContain('11050501');
  });

  it('la sede que ya tiene su caja no se vuelve a proponer', () => {
    const s = sugerirPlan(
      con({
        sedes: [{ codigo: '1', nombre: 'Almacén' }],
        codigosExistentes: ['11050507'],
        cajasExistentes: [{ codigo: '11050507', nombre: 'Caja - Almacén' }],
      }),
    );
    expect(s.cuentas.filter((c) => c.nombre.startsWith('Caja -'))).toHaveLength(
      0,
    );
  });
});

describe('sugerirPlan · ingreso y costo con una subcuenta que recibe asientos', () => {
  const actividad = (seccion: string, division = '00') =>
    con({
      actividadPrincipal: {
        codigoCiiu: '9999',
        seccionCiiu: seccion,
        divisionCiiu: division,
        tarifaIcaPorMil: 10,
      },
    });

  it('un comercio recibe 413595 y 613595', () => {
    expect(codigos(actividad('G'))).toEqual(
      expect.arrayContaining(['4135', '413595', '6135', '613595']),
    );
  });

  it('una empresa de servicios recibe 415595 y 615595, no 413595', () => {
    const c = codigos(actividad('M'));
    expect(c).toEqual(expect.arrayContaining(['415595', '615595']));
    expect(c).not.toContain('413595');
  });

  it('la subcuenta recibe asientos', () => {
    const s = sugerirPlan(actividad('M'));
    expect(s.cuentas.find((c) => c.codigo === '415595')!.esAuxiliar).toBe(true);
  });
});
