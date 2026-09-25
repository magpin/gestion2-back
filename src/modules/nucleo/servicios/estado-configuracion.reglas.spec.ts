import {
  calcularEstado,
  type ClavePaso,
  type HechosConfiguracion,
  type Paso,
} from './estado-configuracion.reglas';

/** Una empresa completamente configurada. Cada prueba le quita una pieza. */
const completa: HechosConfiguracion = {
  empresa: {
    razonSocial: 'ACME Repuestos S.A.S.',
    tipoPersona: 'JURIDICA',
    sectores: ['COMERCIO'],
    seccionesActividades: ['G'],
  },
  configuracionContable: { grupoNiif: 'GRUPO_2', monedaFuncional: 'COP' },
  sedes: { activas: 3, tienePrincipal: true, municipioPrincipal: 'Medellín' },
  regimenesVigentes: ['RESPONSABLE_IVA'],
  representanteVigente: 'Luisa Peña',
  actividadPrincipal: { codigoCiiu: '4530', tarifaIcaPorMil: 4.14 },
  matriculaVigente: true,
  resolucionFacturaVenta: {
    numeroResolucion: '18764000001234',
    vigente: true,
    agotada: false,
    numerosRestantes: 688,
  },
  credencialesDianCargadas: true,
  plan: { cuentasActivas: 42, auxiliares: 31 },
};

const con = (cambios: Partial<HechosConfiguracion>): HechosConfiguracion => ({
  ...completa,
  ...cambios,
});
const paso = (h: HechosConfiguracion, clave: ClavePaso): Paso =>
  calcularEstado(h).pasos.find((p) => p.clave === clave)!;

describe('calcularEstado · panorama', () => {
  it('una empresa completa esta lista para operar', () => {
    const e = calcularEstado(completa);
    expect(e.completa).toBe(true);
    expect(e.porcentaje).toBe(100);
    expect(e.siguiente).toBeNull();
  });

  it('devuelve los cinco pasos en orden', () => {
    expect(calcularEstado(completa).pasos.map((p) => p.clave)).toEqual([
      'EMPRESA',
      'SEDES',
      'SITUACION_LEGAL',
      'PLAN_CUENTAS',
      'RESOLUCIONES',
    ]);
  });

  it('todos los pasos son obligatorios: lo que no bloquea operar no esta aca', () => {
    // Invitar usuarios y cargar clientes son trabajo del dia a dia y viven en su
    // propia pantalla. Un asistente que los lista deja pendientes que nunca se
    // cierran y hacen ver incompleta a una empresa que ya puede facturar.
    const e = calcularEstado(completa);
    expect(e.totalObligatorios).toBe(5);
    expect(e.pasos.every((p) => p.obligatorio)).toBe(true);
  });

  it('el porcentaje cuenta los pasos completados', () => {
    const e = calcularEstado(con({ resolucionFacturaVenta: null }));
    expect(e.completados).toBe(4);
    expect(e.porcentaje).toBe(80);
    expect(e.completa).toBe(false);
  });
});

describe('calcularEstado · bienvenida de Maria (0072)', () => {
  it('sin fecha, la bienvenida no se vio', () => {
    expect(calcularEstado(completa).bienvenidaVista).toBe(false);
    expect(
      calcularEstado(
        con({ empresa: { ...completa.empresa, bienvenidaVistaEn: null } }),
      ).bienvenidaVista,
    ).toBe(false);
  });

  it('con fecha, ya se vio', () => {
    const h = con({
      empresa: {
        ...completa.empresa,
        bienvenidaVistaEn: new Date('2026-09-25T15:00:00Z'),
      },
    });
    expect(calcularEstado(h).bienvenidaVista).toBe(true);
  });
});

describe('calcularEstado · siguiente paso', () => {
  it('prefiere lo empezado a medias sobre lo que nunca se toco', () => {
    // Situacion legal esta a medias y resoluciones ni se empezo. Terminar algo
    // abierto cuesta menos que arrancar de cero.
    const hechos = con({
      actividadPrincipal: null,
      resolucionFacturaVenta: null,
    });
    expect(paso(hechos, 'SITUACION_LEGAL').estado).toBe('FALTA');
    expect(paso(hechos, 'RESOLUCIONES').estado).toBe('PENDIENTE');
    expect(calcularEstado(hechos).siguiente).toBe('SITUACION_LEGAL');
  });

  it('no manda a un paso bloqueado', () => {
    // El plan de cuentas se deriva de la situacion legal: mandar ahi primero
    // obliga a rehacerlo cuando el regimen aparezca.
    const hechos = con({
      regimenesVigentes: [],
      representanteVigente: null,
      actividadPrincipal: null,
      plan: { cuentasActivas: 0, auxiliares: 0 },
    });
    expect(paso(hechos, 'PLAN_CUENTAS').estado).toBe('BLOQUEADO');
    expect(calcularEstado(hechos).siguiente).toBe('SITUACION_LEGAL');
  });

  it('con todo listo no queda siguiente', () => {
    const e = calcularEstado(completa);
    expect(e.completa).toBe(true);
    expect(e.siguiente).toBeNull();
  });
});

describe('paso · Empresa', () => {
  it('sin configuracion contable el paso no esta listo', () => {
    // Sin grupo NIIF el modulo de contabilidad no puede asentar nada.
    const p = paso(con({ configuracionContable: null }), 'EMPRESA');
    expect(p.estado).toBe('FALTA');
    expect(p.faltantes[0].campo).toBe('grupoNiif');
  });

  it('el resumen dice sector, marco y moneda', () => {
    expect(paso(completa, 'EMPRESA').resumen).toBe('COMERCIO · GRUPO 2 · COP');
  });
});

describe('paso · Sedes', () => {
  it('sin sedes esta pendiente', () => {
    const p = paso(
      con({
        sedes: { activas: 0, tienePrincipal: false, municipioPrincipal: null },
      }),
      'SEDES',
    );
    expect(p.estado).toBe('PENDIENTE');
    expect(p.faltantes[0].campo).toBe('sede');
  });

  it('con sedes pero ninguna principal falta marcarla', () => {
    // El municipio de la principal define la tarifa de ICA y viaja en la factura.
    const p = paso(
      con({
        sedes: { activas: 2, tienePrincipal: false, municipioPrincipal: null },
      }),
      'SEDES',
    );
    expect(p.estado).toBe('FALTA');
    expect(p.faltantes[0].campo).toBe('esPrincipal');
  });
});

describe('paso · Situacion legal', () => {
  it('sin condicion tributaria vigente no esta listo', () => {
    const p = paso(con({ regimenesVigentes: [] }), 'SITUACION_LEGAL');
    expect(p.faltantes.map((x) => x.campo)).toContain('tipoRegimen');
  });

  it('a persona juridica le exige representante legal', () => {
    const p = paso(con({ representanteVigente: null }), 'SITUACION_LEGAL');
    expect(p.faltantes.map((x) => x.campo)).toContain('representante');
  });

  it('a persona natural no le exige representante', () => {
    // Se representa a si misma: exigirselo seria inventar un requisito.
    const p = paso(
      con({
        empresa: { ...completa.empresa, tipoPersona: 'NATURAL' },
        representanteVigente: null,
      }),
      'SITUACION_LEGAL',
    );
    expect(p.estado).toBe('LISTO');
  });

  it('con actividad pero sin tarifa de ICA falta la tarifa', () => {
    const p = paso(
      con({
        actividadPrincipal: { codigoCiiu: '4530', tarifaIcaPorMil: null },
      }),
      'SITUACION_LEGAL',
    );
    expect(p.faltantes.map((x) => x.campo)).toEqual(['tarifaIcaPorMil']);
  });

  it('una tarifa de cero es una tarifa, no un dato faltante', () => {
    // Hay actividades exentas de ICA. Cero es una respuesta.
    const p = paso(
      con({ actividadPrincipal: { codigoCiiu: '4530', tarifaIcaPorMil: 0 } }),
      'SITUACION_LEGAL',
    );
    expect(p.estado).toBe('LISTO');
  });

  it('la matricula mercantil avisa pero no bloquea', () => {
    const p = paso(con({ matriculaVigente: false }), 'SITUACION_LEGAL');
    expect(p.estado).toBe('LISTO');
    expect(p.opcionales.map((x) => x.campo)).toContain('matricula');
  });

  it('nada registrado queda PENDIENTE, no FALTA', () => {
    const p = paso(
      con({
        regimenesVigentes: [],
        representanteVigente: null,
        actividadPrincipal: null,
      }),
      'SITUACION_LEGAL',
    );
    expect(p.estado).toBe('PENDIENTE');
    expect(p.faltantes).toHaveLength(3);
  });
});

describe('paso · Resoluciones', () => {
  it('sin resolucion esta pendiente', () => {
    const p = paso(con({ resolucionFacturaVenta: null }), 'RESOLUCIONES');
    expect(p.estado).toBe('PENDIENTE');
    expect(p.faltantes[0].campo).toBe('resolucion');
  });

  it('una resolucion vencida no sirve', () => {
    const p = paso(
      con({
        resolucionFacturaVenta: {
          numeroResolucion: '187',
          vigente: false,
          agotada: false,
          numerosRestantes: 400,
        },
      }),
      'RESOLUCIONES',
    );
    expect(p.estado).toBe('FALTA');
    expect(p.faltantes[0].campo).toBe('fechaVigenciaHasta');
  });

  it('una resolucion agotada tampoco', () => {
    const p = paso(
      con({
        resolucionFacturaVenta: {
          numeroResolucion: '187',
          vigente: true,
          agotada: true,
          numerosRestantes: 0,
        },
      }),
      'RESOLUCIONES',
    );
    expect(p.faltantes[0].campo).toBe('rangoHasta');
  });

  it('las credenciales DIAN avisan pero no bloquean', () => {
    // Registrar la resolucion ya permite numerar; transmitir es del modulo dian.
    const p = paso(con({ credencialesDianCargadas: false }), 'RESOLUCIONES');
    expect(p.estado).toBe('LISTO');
    expect(p.opcionales.map((x) => x.campo)).toContain('credenciales');
  });
});

describe('calcularEstado · plan de cuentas', () => {
  it('sin cuentas la empresa no puede operar', () => {
    const hechos = con({ plan: { cuentasActivas: 0, auxiliares: 0 } });
    expect(calcularEstado(hechos).completa).toBe(false);
    expect(paso(hechos, 'PLAN_CUENTAS').estado).toBe('PENDIENTE');
  });

  it('un plan sin auxiliares no deja asentar, aunque tenga cuentas', () => {
    // Todas de agrupacion: suman a sus hijas pero no reciben movimiento.
    const p = paso(
      con({ plan: { cuentasActivas: 9, auxiliares: 0 } }),
      'PLAN_CUENTAS',
    );
    expect(p.estado).toBe('FALTA');
    expect(p.faltantes.map((x) => x.campo)).toContain('esAuxiliar');
  });

  it('queda bloqueado mientras la situacion legal no este lista', () => {
    // El plan se deriva del regimen y de la actividad: armarlo antes obliga a rehacerlo.
    const p = paso(
      con({
        regimenesVigentes: [],
        plan: { cuentasActivas: 0, auxiliares: 0 },
      }),
      'PLAN_CUENTAS',
    );
    expect(p.estado).toBe('BLOQUEADO');
    expect(p.bloqueadoPor).toBe('SITUACION_LEGAL');
  });

  it('con cuentas y auxiliares queda listo', () => {
    expect(paso(completa, 'PLAN_CUENTAS').estado).toBe('LISTO');
  });
});

describe('calcularEstado · sector sin respaldo en el RUT', () => {
  const legal = (h: HechosConfiguracion) => paso(h, 'SITUACION_LEGAL');

  it('avisa cuando se marca un sector que ninguna actividad respalda', () => {
    // Marca manufactura pero su unica actividad del RUT es comercio. No es un
    // error —el sector solo suma cuentas— pero el RUT quedo corto.
    const p = legal(
      con({
        empresa: { ...completa.empresa, sectores: ['COMERCIO', 'MANUFACTURA'] },
      }),
    );
    const aviso = p.opcionales.find((o) => o.campo === 'sectores');
    expect(aviso).toBeDefined();
    expect(aviso!.etiqueta).toContain('Manufactura');
  });

  it('no avisa cuando la actividad lo respalda', () => {
    const p = legal(
      con({
        empresa: {
          ...completa.empresa,
          sectores: ['COMERCIO', 'MANUFACTURA'],
          seccionesActividades: ['C', 'G'],
        },
      }),
    );
    expect(p.opcionales.some((o) => o.campo === 'sectores')).toBe(false);
  });

  it('sin ninguna actividad registrada lo dice con esas palabras', () => {
    const p = legal(
      con({
        empresa: {
          ...completa.empresa,
          sectores: ['COMERCIO'],
          seccionesActividades: [],
        },
      }),
    );
    expect(p.opcionales.find((o) => o.campo === 'sectores')!.detalle).toContain(
      'Todavía no registraste',
    );
  });

  it('no bloquea: el paso sigue listo', () => {
    // El sector suma cuentas al catalogo y nunca esconde las del RUT, asi que
    // marcar de mas no impide operar.
    const p = legal(
      con({
        empresa: { ...completa.empresa, sectores: ['COMERCIO', 'MANUFACTURA'] },
      }),
    );
    expect(p.estado).toBe('LISTO');
  });

  it('sin sectores marcados no hay nada que avisar', () => {
    const p = legal(con({ empresa: { ...completa.empresa, sectores: [] } }));
    expect(p.opcionales.some((o) => o.campo === 'sectores')).toBe(false);
  });
});
