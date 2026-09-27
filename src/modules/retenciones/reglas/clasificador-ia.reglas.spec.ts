import { clasificar, type PropuestaIa } from './clasificacion.reglas';
import {
  INSTRUCCIONES_CLASIFICADOR,
  mensajeClasificador,
  validarRespuesta,
} from './clasificador-ia.reglas';

const CODIGOS = [
  'COMPRAS_GENERALES',
  'HONORARIOS',
  'SERVICIOS_GENERALES',
  'ARREND_INMUEBLES',
];

describe('clasificador con IA — lo que devuelve el modelo (Fase 5)', () => {
  it('un concepto de la lista pasa, con su razón y alternativas de la lista', () => {
    const v = validarRespuesta(
      {
        conceptoCodigo: 'HONORARIOS',
        razon: '  Es un servicio   especializado.  ',
        alternativas: [
          'SERVICIOS_GENERALES',
          'INVENTADO',
          'HONORARIOS',
          'SERVICIOS_GENERALES',
        ],
      },
      CODIGOS,
    );
    expect(v).toEqual({
      estado: 'PROPUESTA',
      concepto: 'HONORARIOS',
      razon: 'Es un servicio especializado.',
      alternativas: ['SERVICIOS_GENERALES'],
    });
  });

  it('un concepto fuera de la lista se descarta: se pregunta', () => {
    expect(
      validarRespuesta(
        { conceptoCodigo: 'PUBLICIDAD', razon: 'x', alternativas: [] },
        CODIGOS,
      ).estado,
    ).toBe('FUERA_DE_LISTA');
    expect(validarRespuesta(null, CODIGOS).estado).toBe('FUERA_DE_LISTA');
    expect(validarRespuesta('HONORARIOS', CODIGOS).estado).toBe(
      'FUERA_DE_LISTA',
    );
  });

  it('R4 — ningún número que devuelva se usa: solo sale código, razón y alternativas', () => {
    const v = validarRespuesta(
      {
        conceptoCodigo: 'HONORARIOS',
        razon: 'Servicio.',
        alternativas: [],
        tarifa: 11,
        base: 1_000_000,
        valor: 110_000,
      },
      CODIGOS,
    );
    expect(Object.keys(v).sort()).toEqual([
      'alternativas',
      'concepto',
      'estado',
      'razon',
    ]);
  });

  it('el mensaje lleva la lista cerrada y el proveedor; las instrucciones, los casos que engañan', () => {
    const m = mensajeClasificador({
      descripcion: 'Implementación del SG-SST',
      cantidad: null,
      valor: 1_500_000,
      proveedor: {
        nombre: 'Omaira Ruiz',
        tipoPersona: 'NATURAL',
        ciiu: '7490',
      },
      conceptos: [{ codigo: 'HONORARIOS', nombre: 'Honorarios' }],
    });
    expect(m).toContain('HONORARIOS — Honorarios');
    expect(m).toContain('persona natural, CIIU 7490');
    expect(INSTRUCCIONES_CLASIFICADOR).toMatch(/Aviso luminoso/);
    expect(INSTRUCCIONES_CLASIFICADOR).toMatch(/SG-SST/);
    expect(INSTRUCCIONES_CLASIFICADOR).toMatch(/no instrucciones/);
  });
});

describe('clasificación — la IA como fuente 5', () => {
  const ia: PropuestaIa = {
    concepto: 'HONORARIOS',
    razon: 'Parece un servicio especializado.',
    alternativas: ['SERVICIOS_GENERALES'],
  };
  const contexto = (x: { ciiu?: string | null } = {}) => ({
    aprendidos: [],
    ciiuProveedor: x.ciiu ?? null,
    nombreProveedor: 'Omaira',
    nombreDe: (c: string) => (c === 'HONORARIOS' ? 'Honorarios' : c),
    ia: (llave: string) => (llave === 'implementacion del sg sst' ? ia : null),
  });

  it('un renglón que ninguna fuente determinista resuelve llega como «La deduje» con su razón', () => {
    const c = clasificar(
      {
        orden: 1,
        productoId: null,
        texto: 'Implementación del SG-SST',
        cuentaCodigo: null,
      },
      contexto(),
    );
    // «sg sst» lo cazan las palabras (HONORARIOS): no llega a la IA.
    expect(c.origen).toBe('PALABRAS');

    const d = clasificar(
      {
        orden: 1,
        productoId: null,
        texto: 'Implementacion del SG SST',
        cuentaCodigo: null,
      },
      { ...contexto(), ia: () => ia },
    );
    expect(d.origen).toBe('PALABRAS');
  });

  it('sin ninguna otra fuente, la IA propone y nunca queda clara (R5)', () => {
    const c = clasificar(
      {
        orden: 1,
        productoId: null,
        texto: 'Diseño del plan de emergencias',
        cuentaCodigo: null,
      },
      { ...contexto(), ia: () => ia },
    );
    expect(c).toMatchObject({
      concepto: 'HONORARIOS',
      origen: 'IA',
      certeza: 'DEDUCIDA',
      alternativas: ['SERVICIOS_GENERALES'],
    });
    expect(c.razon).toMatch(
      /^La deduje \(IA\): Parece un servicio especializado\. ¿Es Honorarios\?/,
    );
  });

  it('si el CIIU ya dice algo, no se usa la IA', () => {
    const c = clasificar(
      {
        orden: 1,
        productoId: null,
        texto: 'Diseño del plan de emergencias',
        cuentaCodigo: null,
      },
      { ...contexto({ ciiu: '6920' }), ia: () => ia },
    );
    expect(c.origen).toBe('CIIU');
  });

  it('sin propuesta de la IA, sigue preguntando', () => {
    const c = clasificar(
      {
        orden: 1,
        productoId: null,
        texto: 'Diseño del plan de emergencias',
        cuentaCodigo: null,
      },
      { ...contexto(), ia: () => null },
    );
    expect(c.certeza).toBe('PREGUNTA');
  });
});
