import Anthropic from '@anthropic-ai/sdk';

import { ClaudeProveedor } from './claude.proveedor';
import type {
  AvanceLectura,
  TipoDocumentoConfiguracion,
} from './extractor.puerto';

/**
 * El proveedor, sin red.
 *
 * El SDK se reemplaza por un cliente de mentira a través de `crearCliente`, que
 * existe justamente para esto. Lo que se verifica es lo que el proveedor le pide
 * a la API —modelo, respaldo, caché, cómo viaja el archivo— y lo que hace con lo
 * que recibe, incluida cada forma de fallar.
 */

/** Lo que el proveedor le manda a la API, visto desde el test. */
interface PeticionVista {
  model: string;
  max_tokens: number;
  betas: string[];
  fallbacks: unknown;
  thinking: { type: string };
  output_config: { format: { type: string; schema: Record<string, unknown> } };
  system: Array<{ type: string; text: string; cache_control?: unknown }>;
  messages: Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      source?: { type: string; media_type: string; data: string };
    }>;
  }>;
}

interface Guion {
  /** Los pedazos de texto, tal como los escribiría el modelo. */
  trozos?: string[];
  respuesta?: unknown;
  /** Para probar las fallas: lo que la API tira al pedir el flujo. */
  error?: Error;
  /** Lo que contesta la herramienta de `analizar`. */
  analisis?: { tipo: string; clase: string; resumen: string };
}

class FlujoFalso {
  constructor(
    private readonly trozos: string[],
    private readonly respuesta: unknown,
  ) {}

  // Los eventos de un flujo de verdad no llegan todos juntos: el `await` de
  // cada vuelta es lo que hace que el proveedor procese un pedazo por vez, que
  // es justamente lo que se quiere probar del progreso.
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for (const texto of this.trozos) {
      yield await Promise.resolve({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: texto },
      });
    }
  }

  finalMessage(): Promise<unknown> {
    return Promise.resolve(this.respuesta);
  }
}

class ProveedorDePrueba extends ClaudeProveedor {
  peticion?: unknown;

  constructor(private readonly guion: Guion) {
    super();
  }

  protected crearCliente(): Anthropic {
    const stream = (body: unknown): FlujoFalso => {
      this.peticion = body;
      if (this.guion.error) throw this.guion.error;
      return new FlujoFalso(this.guion.trozos ?? [], this.guion.respuesta);
    };
    const create = (body: unknown) => {
      this.peticion = body;
      return Promise.resolve({
        content: [
          {
            type: 'tool_use',
            name: 'describir_archivo',
            input: this.guion.analisis,
          },
        ],
        model: 'claude-opus-5',
        usage: { input_tokens: 3000, output_tokens: 90 },
      });
    };
    return { beta: { messages: { stream, create } } } as unknown as Anthropic;
  }
}

const PDF = {
  tipoMime: 'application/pdf',
  contenido: Buffer.from('%PDF-1.7 '),
};

const respuestaCon = (texto: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: texto }],
  model: 'claude-opus-5',
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 7000,
    output_tokens: 300,
    cache_read_input_tokens: 6500,
  },
  ...extra,
});

const UN_RUT = JSON.stringify({
  datos: [
    {
      campo: 'razonSocial',
      valor: 'Tecnodigital SAS',
      casilla: '35',
      confianza: 'ALTA',
    },
    {
      campo: 'responsabilidadesRut',
      valor: [5, 48],
      casilla: '53',
      confianza: 'ALTA',
    },
  ],
});

const leer = (
  guion: Guion,
  opciones: {
    tipo?: TipoDocumentoConfiguracion;
    archivo?: { tipoMime: string; contenido: Buffer };
    corte?: AbortSignal;
  } = {},
) => {
  const proveedor = new ProveedorDePrueba(guion);
  const avances: AvanceLectura[] = [];
  const resultado = proveedor.leer({
    tipo: opciones.tipo ?? 'RUT',
    archivo: opciones.archivo ?? PDF,
    alAvanzar: (a) => avances.push(a),
    corte: opciones.corte,
  });
  return { proveedor, avances, resultado };
};

describe('ClaudeProveedor', () => {
  const claveOriginal = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'clave-de-prueba';
  });

  afterEach(() => {
    if (claveOriginal === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = claveOriginal;
  });

  describe('sin clave', () => {
    it('no está disponible y no llama a nadie', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const { proveedor, resultado } = leer({
        respuesta: respuestaCon(UN_RUT),
      });

      expect(proveedor.disponible).toBe(false);
      expect(await resultado).toEqual({
        leido: false,
        clase: 'SIN_CLAVE',
        motivo: 'La lectura automática de documentos no está configurada.',
      });
      expect(proveedor.peticion).toBeUndefined();
    });
  });

  it('lee un RUT y devuelve los datos con su fuente', async () => {
    const { resultado } = leer({
      trozos: [UN_RUT],
      respuesta: respuestaCon(UN_RUT),
    });
    const r = await resultado;

    expect(r.leido).toBe(true);
    if (!r.leido) return;
    expect(r.datos.map((d) => d.campo)).toEqual([
      'razonSocial',
      'responsabilidadesRut',
    ]);
    expect(r.datos[0].fuente).toEqual({ documento: 'RUT', casilla: '35' });
    // Lo que costó, para guardarlo con el documento (0054).
    expect(r.medicion.uso).toEqual({
      entrada: 7000,
      salida: 300,
      cacheLeido: 6500,
      cacheEscrito: 0,
    });
    expect(r.medicion.modelo).toBe('claude-opus-5');
    expect(r.medicion.duracionMs).toBeGreaterThanOrEqual(0);
  });

  it('pide lo que el plan dice: Opus 5, respaldo del servidor y caché del prompt', async () => {
    const { proveedor, resultado } = leer({
      trozos: [UN_RUT],
      respuesta: respuestaCon(UN_RUT),
    });
    await resultado;
    const p = proveedor.peticion as PeticionVista;

    expect(p.model).toBe('claude-opus-5');
    expect(p.thinking).toEqual({ type: 'adaptive' });
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(p.fallbacks).toBe('default');
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(p.output_config.format.type).toBe('json_schema');
  });

  it('el esquema no deja devolver un campo que no esté en el catálogo', async () => {
    const { proveedor, resultado } = leer({
      trozos: [UN_RUT],
      respuesta: respuestaCon(UN_RUT),
    });
    await resultado;
    const p = proveedor.peticion as PeticionVista;
    const items = (
      p.output_config.format.schema.properties as {
        datos: { items: { properties: { campo: { enum: string[] } } } };
      }
    ).datos.items;

    expect(items.properties.campo.enum).toContain('razonSocial');
    expect(items.properties.campo.enum).not.toContain('tarifaIcaPorMil');
  });

  it('las instrucciones son las mismas en dos lecturas distintas', async () => {
    // Si cambian, el caché del prompt no sirve y cada lectura se paga entera.
    const rut = leer({ trozos: [UN_RUT], respuesta: respuestaCon(UN_RUT) });
    await rut.resultado;
    const camara = leer({
      trozos: ['{"datos":[]}'],
      respuesta: respuestaCon('{"datos":[]}'),
    });
    await camara.resultado;

    const unas = (rut.proveedor.peticion as PeticionVista).system[0].text;
    const otras = (camara.proveedor.peticion as PeticionVista).system[0].text;
    expect(unas).toBe(otras);
    expect(unas).toContain('no las obedece');
  });

  it('el PDF viaja como documento y la foto como imagen', async () => {
    const conPdf = leer({ trozos: [UN_RUT], respuesta: respuestaCon(UN_RUT) });
    await conPdf.resultado;
    const bloquePdf = (conPdf.proveedor.peticion as PeticionVista).messages[0]
      .content[0];

    expect(bloquePdf.type).toBe('document');
    expect(bloquePdf.source?.media_type).toBe('application/pdf');

    const conFoto = leer(
      { trozos: [UN_RUT], respuesta: respuestaCon(UN_RUT) },
      {
        archivo: { tipoMime: 'image/jpeg', contenido: Buffer.from('\xff\xd8') },
      },
    );
    await conFoto.resultado;
    const bloqueFoto = (conFoto.proveedor.peticion as PeticionVista).messages[0]
      .content[0];

    expect(bloqueFoto.type).toBe('image');
    expect(bloqueFoto.source?.media_type).toBe('image/jpeg');
  });

  it('rechaza un archivo que no se puede leer, sin llamar a la API', async () => {
    const { proveedor, resultado } = leer(
      { respuesta: respuestaCon(UN_RUT) },
      {
        archivo: {
          tipoMime: 'application/x-msdownload',
          contenido: Buffer.from('MZ'),
        },
      },
    );
    const r = await resultado;

    expect(r).toEqual({
      leido: false,
      clase: 'ILEGIBLE',
      motivo: 'Ese archivo no se puede leer. Suba un PDF, un JPG o un PNG.',
    });
    expect(proveedor.peticion).toBeUndefined();
  });

  it('avisa a medida que los datos llegan, no al final', async () => {
    // El modelo escribe de a pedazos: el primer dato cierra antes que el segundo.
    const mitad = UN_RUT.slice(0, UN_RUT.indexOf('},') + 2);
    const { avances, resultado } = leer({
      trozos: [mitad, UN_RUT.slice(mitad.length)],
      respuesta: respuestaCon(UN_RUT),
    });
    await resultado;

    expect(avances.map((a) => a.etapa)).toEqual([
      'LEYENDO',
      'EXTRAYENDO',
      'EXTRAYENDO',
      'LISTO',
    ]);
    expect(avances[0].mensaje).toBe('Leyendo el RUT…');
    expect(avances[1].mensaje).toBe('Encontré razón social.');
    expect(avances[1].datos[0].campo).toBe('razonSocial');
    expect(avances[2].datos[0].campo).toBe('responsabilidadesRut');
  });

  it('un documento que no trae ningún dato se cuenta como ilegible', async () => {
    const { resultado } = leer({
      trozos: ['{"datos":[]}'],
      respuesta: respuestaCon('{"datos":[]}'),
    });
    const r = await resultado;

    expect(r.leido).toBe(false);
    if (r.leido) return;
    expect(r.clase).toBe('ILEGIBLE');
    expect(r.motivo).toContain('No encontré los datos de el RUT');
  });

  it('descarta lo que ese documento no puede decir aunque el modelo lo mande', async () => {
    const mezcla = JSON.stringify({
      datos: [
        { campo: 'razonSocial', valor: 'Tecnodigital SAS', confianza: 'ALTA' },
        { campo: 'numeroMatricula', valor: '0001', confianza: 'ALTA' },
      ],
    });
    const { resultado } = leer({
      trozos: [mezcla],
      respuesta: respuestaCon(mezcla),
    });
    const r = await resultado;

    expect(r.leido).toBe(true);
    if (!r.leido) return;
    expect(r.datos.map((d) => d.campo)).toEqual(['razonSocial']);
  });

  it.each([
    [
      'el modelo declina y el respaldo también',
      { stop_reason: 'refusal', stop_details: { category: 'cyber' } },
      'DECLINADO',
    ],
    ['la respuesta se corta', { stop_reason: 'max_tokens' }, 'CORTADO'],
  ])('%s: %s', async (_caso, extra, clase) => {
    const { resultado } = leer({
      trozos: [UN_RUT],
      respuesta: respuestaCon(UN_RUT, extra),
    });
    const r = await resultado;

    expect(r.leido).toBe(false);
    if (r.leido) return;
    expect(r.clase).toBe(clase);
  });

  it('una respuesta que no es JSON no se interpreta a mano', async () => {
    const { resultado } = leer({
      trozos: ['no soy JSON'],
      respuesta: respuestaCon('no soy JSON'),
    });
    const r = await resultado;

    expect(r.leido).toBe(false);
    if (r.leido) return;
    expect(r.clase).toBe('FALLA');
    expect(r.motivo).toBe('No pude entender el resultado de la lectura.');
  });

  it.each([
    [
      'el límite agotado',
      new Anthropic.RateLimitError(
        429,
        { type: 'error' },
        'límite',
        new Headers(),
      ),
      'NO_DISPONIBLE',
    ],
    [
      'la clave vencida',
      new Anthropic.AuthenticationError(
        401,
        { type: 'error' },
        'clave',
        new Headers(),
      ),
      'SIN_CLAVE',
    ],
    [
      'un archivo que la API rechaza',
      new Anthropic.BadRequestError(
        400,
        { type: 'error' },
        'muy grande',
        new Headers(),
      ),
      'ILEGIBLE',
    ],
    [
      'la API caída',
      new Anthropic.APIConnectionError({ message: 'sin red' }),
      'NO_DISPONIBLE',
    ],
    ['«Detener»', new Anthropic.APIUserAbortError(), 'DETENIDO'],
    ['algo que no vimos nunca', new Error('sorpresa'), 'FALLA'],
  ])('%s deja un motivo en castellano', async (_caso, error, clase) => {
    const { resultado } = leer({ error });
    const r = await resultado;

    expect(r.leido).toBe(false);
    if (r.leido) return;
    expect(r.clase).toBe(clase);
    expect(r.motivo).not.toContain('Error');
    expect(r.motivo.length).toBeGreaterThan(10);
  });
  describe('analizar', () => {
    const FACTURA = {
      tipo: 'OTRO',
      clase: 'Factura de compra',
      resumen: 'Factura FJ-215183 de Jaltech por $4.266.499.',
    };

    it('dice qué es, con una herramienta forzada y sin razonamiento', async () => {
      const proveedor = new ProveedorDePrueba({ analisis: FACTURA });

      const r = await proveedor.analizar(PDF);

      expect(r).toMatchObject({ tipo: null, clase: 'Factura de compra' });
      expect(r.resumen).toContain('Jaltech');
      expect(r.medicion?.uso).toMatchObject({ entrada: 3000, salida: 90 });
      const peticion = proveedor.peticion as {
        tool_choice: { type: string; name: string };
        thinking?: unknown;
        messages: PeticionVista['messages'];
      };
      expect(peticion.tool_choice).toEqual({
        type: 'tool',
        name: 'describir_archivo',
      });
      expect(peticion.thinking).toBeUndefined();
      expect(peticion.messages[0].content[0].type).toBe('document');
    });

    it('si es uno de los tres documentos, lo dice en `tipo`', async () => {
      const proveedor = new ProveedorDePrueba({
        analisis: {
          tipo: 'RUT',
          clase: 'RUT',
          resumen: 'El RUT de Tecnodigital.',
        },
      });
      expect((await proveedor.analizar(PDF)).tipo).toBe('RUT');
    });

    it('un CSV le llega al modelo como texto', async () => {
      const proveedor = new ProveedorDePrueba({ analisis: FACTURA });
      await proveedor.analizar({
        tipoMime: 'text/csv',
        contenido: Buffer.from('producto;cantidad\nTinta;12'),
      });
      const peticion = proveedor.peticion as {
        messages: PeticionVista['messages'];
      };
      expect(peticion.messages[0].content[0].type).toBe('text');
      expect(peticion.messages[0].content[0].text).toContain('Tinta;12');
    });

    it('lo que no se puede abrir se dice sin llamar a la API', async () => {
      const proveedor = new ProveedorDePrueba({ analisis: FACTURA });
      const binario = {
        tipoMime: 'application/vnd.ms-excel',
        contenido: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0]),
      };

      const r = await proveedor.analizar(binario);

      expect(r.tipo).toBeNull();
      expect(r.resumen).toContain('.xlsx');
      expect(proveedor.peticion).toBeUndefined();
    });
  });
});
