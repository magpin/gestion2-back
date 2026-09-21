import {
  CAMPOS,
  camposDe,
  nombreDocumento,
  objetosCompletos,
  separarPorConfianza,
  TIPOS_ARCHIVO,
  validar,
} from './documento.reglas';
import type { DatoExtraido } from '../proveedores/extractor.puerto';

/** Un dato como lo devuelve el modelo: cuatro claves y nada más. */
const crudo = (extra: Record<string, unknown>) => ({ datos: [extra] });

describe('validar', () => {
  it('completa el paso y la etiqueta desde el catálogo', () => {
    const { datos, descartados } = validar(
      crudo({
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        confianza: 'ALTA',
        casilla: '35',
      }),
      'RUT',
    );

    expect(descartados).toEqual([]);
    expect(datos).toEqual([
      {
        paso: 'EMPRESA',
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        etiqueta: 'Razón social',
        fuente: { documento: 'RUT', casilla: '35' },
        confianza: 'ALTA',
      },
    ]);
  });

  it('no deja que el documento elija el paso ni escriba la etiqueta', () => {
    // Lo que un PDF con instrucciones adentro intentaría: mandar a otro paso y
    // poner su propio texto en la pantalla.
    const { datos } = validar(
      crudo({
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        confianza: 'ALTA',
        paso: 'RESOLUCIONES',
        etiqueta: 'Empresa verificada por la DIAN ✓',
      }),
      'RUT',
    );

    expect(datos[0].paso).toBe('EMPRESA');
    expect(datos[0].etiqueta).toBe('Razón social');
  });

  it('descarta un campo que no está en el catálogo', () => {
    const { datos, descartados } = validar(
      crudo({ campo: 'esResponsableDeIva', valor: false, confianza: 'ALTA' }),
      'RUT',
    );

    expect(datos).toEqual([]);
    expect(descartados).toEqual([
      {
        campo: 'esResponsableDeIva',
        motivo: 'No es un campo que el asistente sepa llenar.',
      },
    ]);
  });

  it('descarta un campo que ese documento no puede decir', () => {
    // La matrícula mercantil sale de la Cámara, no del RUT.
    const { datos, descartados } = validar(
      crudo({ campo: 'numeroMatricula', valor: '12345', confianza: 'ALTA' }),
      'RUT',
    );

    expect(datos).toEqual([]);
    expect(descartados[0].motivo).toContain('el RUT no dice esto');
  });

  it('con el campo repetido vale el primero', () => {
    const { datos, descartados } = validar(
      {
        datos: [
          { campo: 'razonSocial', valor: 'La primera', confianza: 'ALTA' },
          { campo: 'razonSocial', valor: 'La segunda', confianza: 'ALTA' },
        ],
      },
      'RUT',
    );

    expect(datos).toHaveLength(1);
    expect(datos[0].valor).toBe('La primera');
    expect(descartados[0].motivo).toContain('vale el primero');
  });

  it.each([
    ['nulo', null],
    ['cadena vacía', '   '],
    ['lista vacía', []],
    ['ausente', undefined],
  ])('descarta el valor %s', (_caso, valor) => {
    const { datos, descartados } = validar(
      crudo({ campo: 'razonSocial', valor, confianza: 'ALTA' }),
      'RUT',
    );

    expect(datos).toEqual([]);
    expect(descartados[0].motivo).toBe('Llegó vacío.');
  });

  it.each([
    ['ausente', undefined],
    ['inventada', 'SEGURÍSIMA'],
    ['en minúscula', 'alta'],
  ])('una confianza %s cuenta como DUDOSA', (_caso, confianza) => {
    const { datos } = validar(
      crudo({ campo: 'razonSocial', valor: 'Tecnodigital SAS', confianza }),
      'RUT',
    );

    expect(datos[0].confianza).toBe('DUDOSA');
  });

  it('recorta la casilla y le quita los saltos de línea', () => {
    const { datos } = validar(
      crudo({
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        confianza: 'ALTA',
        casilla: '  53\n  y también todo este párrafo que no cabe  ',
      }),
      'RUT',
    );

    expect(datos[0].fuente.casilla).toBe('53 y también todo este');
  });

  it('el recorte no parte una palabra por la mitad', () => {
    const { datos } = validar(
      crudo({
        campo: 'representanteNombre',
        valor: 'María Fernanda Gómez',
        confianza: 'ALTA',
        casilla: 'Representante legal y suplentes',
      }),
      'RUT',
    );

    // «Representante legal y» y no «Representante legal y su»: un rótulo
    // partido a la mitad de una palabra parece un error de tipeo nuestro.
    expect(datos[0].fuente.casilla).toBe('Representante legal y');
  });

  it('una sola palabra más larga que el tope se corta a la cuenta', () => {
    const { datos } = validar(
      crudo({
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        confianza: 'ALTA',
        casilla: 'Responsabilidadesycalidadesyatributos',
      }),
      'RUT',
    );

    // No hay espacio al que retroceder. Cortar es lo menos malo.
    expect(datos[0].fuente.casilla).toBe('Responsabilidadesycalida');
  });

  it('sin casilla, la fuente es solo el documento', () => {
    const { datos } = validar(
      crudo({
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        confianza: 'ALTA',
        casilla: '  ',
      }),
      'RUT',
    );

    expect(datos[0].fuente).toEqual({ documento: 'RUT' });
  });

  it('acepta el arreglo suelto o envuelto en `datos`', () => {
    const item = {
      campo: 'razonSocial',
      valor: 'Tecnodigital SAS',
      confianza: 'ALTA',
    };

    expect(validar([item], 'RUT').datos).toHaveLength(1);
    expect(validar({ datos: [item] }, 'RUT').datos).toHaveLength(1);
  });

  it.each([
    ['null', null],
    ['texto', 'nada'],
    ['objeto vacío', {}],
  ])('de %s no saca datos y no explota', (_caso, entrada) => {
    expect(validar(entrada, 'RUT')).toEqual({ datos: [], descartados: [] });
  });

  it('descarta un elemento que no es objeto', () => {
    const { datos, descartados } = validar({ datos: ['razonSocial'] }, 'RUT');

    expect(datos).toEqual([]);
    expect(descartados).toEqual([{ campo: '#0', motivo: 'No es un objeto.' }]);
  });

  it('acepta una lista de códigos como valor', () => {
    const { datos } = validar(
      crudo({
        campo: 'responsabilidadesRut',
        valor: [5, 7, 48],
        confianza: 'ALTA',
        casilla: '53',
      }),
      'RUT',
    );

    expect(datos[0].valor).toEqual([5, 7, 48]);
  });
});

describe('separarPorConfianza', () => {
  it('lo dudoso va a preguntas y no a lo aplicable', () => {
    const datos: DatoExtraido[] = [
      {
        paso: 'EMPRESA',
        campo: 'razonSocial',
        valor: 'Tecnodigital SAS',
        etiqueta: 'Razón social',
        fuente: { documento: 'RUT' },
        confianza: 'ALTA',
      },
      {
        paso: 'SEDES',
        campo: 'telefono',
        valor: '3001112233',
        etiqueta: 'Teléfono',
        fuente: { documento: 'RUT' },
        confianza: 'DUDOSA',
      },
    ];

    const { aplicables, preguntas } = separarPorConfianza(datos);

    expect(aplicables.map((d) => d.campo)).toEqual(['razonSocial']);
    expect(preguntas.map((d) => d.campo)).toEqual(['telefono']);
  });
});

describe('objetosCompletos', () => {
  it('no devuelve nada mientras no cerró el primero', () => {
    expect(objetosCompletos('{"datos":[{"campo":"razonSoc')).toEqual([]);
  });

  it('devuelve los cerrados y deja el que va a medias', () => {
    const parcial =
      '{"datos":[{"campo":"razonSocial","valor":"Tecnodigital SAS"},{"campo":"dir';

    expect(objetosCompletos(parcial)).toEqual([
      { campo: 'razonSocial', valor: 'Tecnodigital SAS' },
    ]);
  });

  it('una llave dentro de una cadena no cierra nada', () => {
    const parcial =
      '{"datos":[{"campo":"direccion","valor":"Cra 7 # 71-21 {of 302}"}]';

    expect(objetosCompletos(parcial)).toEqual([
      { campo: 'direccion', valor: 'Cra 7 # 71-21 {of 302}' },
    ]);
  });

  it('una comilla escapada no abre ni cierra cadena', () => {
    const parcial =
      '[{"campo":"nombreComercial","valor":"El \\"Buen\\" Precio}"}]';

    expect(objetosCompletos(parcial)).toEqual([
      { campo: 'nombreComercial', valor: 'El "Buen" Precio}' },
    ]);
  });

  it('no confunde un objeto anidado con dos', () => {
    const parcial = '[{"campo":"x","valor":{"a":{"b":1}}},{"campo":"y"';

    expect(objetosCompletos(parcial)).toEqual([
      { campo: 'x', valor: { a: { b: 1 } } },
    ]);
  });

  it('sin arreglo todavía, no hay nada', () => {
    expect(objetosCompletos('{"dat')).toEqual([]);
  });
});

describe('el catálogo', () => {
  it('le da a cada documento solo sus campos, en orden estable', () => {
    const delRut = camposDe('RUT');

    expect(delRut).toEqual([...delRut].sort());
    expect(delRut).toContain('responsabilidadesRut');
    expect(delRut).not.toContain('numeroMatricula');
    expect(camposDe('RESOLUCION_DIAN')).toContain('numeroResolucion');
    expect(camposDe('CAMARA_COMERCIO')).not.toContain('responsabilidadesRut');
  });

  it('deja afuera a propósito lo que ningún documento dice', () => {
    // El §7.4 de la guía: esto se pregunta, no se adivina.
    for (const campo of [
      'tarifaIcaPorMil',
      'grupoNiif',
      'mesCierreFiscal',
      'metodoValoracionInventario',
      'sectores',
    ]) {
      expect(CAMPOS[campo]).toBeUndefined();
    }
  });

  it('cada campo tiene al menos un documento que lo pueda decir', () => {
    for (const [campo, definicion] of Object.entries(CAMPOS)) {
      expect(definicion.documentos.length).toBeGreaterThan(0);
      expect(definicion.etiqueta.trim()).not.toBe('');
      expect(campo.trim()).not.toBe('');
    }
  });

  it('nombra los documentos como se leen en una frase', () => {
    expect(nombreDocumento('RUT')).toBe('el RUT');
    expect(nombreDocumento('CAMARA_COMERCIO')).toBe('la Cámara de Comercio');
    expect(nombreDocumento('RESOLUCION_DIAN')).toBe('la resolución de la DIAN');
  });

  it('acepta PDF como documento y las fotos como imagen', () => {
    expect(TIPOS_ARCHIVO.get('application/pdf')).toBe('document');
    expect(TIPOS_ARCHIVO.get('image/jpeg')).toBe('image');
    expect(TIPOS_ARCHIVO.get('application/x-msdownload')).toBeUndefined();
  });
});
