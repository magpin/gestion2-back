import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type {
  ConversadorPuerto,
  HerramientasDelTurno,
  ResultadoRespuesta,
} from '../proveedores/conversador.puerto';
import type { ConsultaHecha, ConsultasService } from './consultas.service';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { ConversacionService } from './conversacion.service';

const ana: CtxEmpresa = {
  tenantId: 't-1',
  usuarioId: 'u-ana',
  empresaId: 'e-1',
  roles: ['VENTAS'],
};

interface Conversacion {
  id: string;
  empresa_id: string;
  usuario_id: string;
  archivada_en: string | null;
}
interface Turno {
  id: string;
  conversacion_id: string;
  orden: number;
  autor: string;
  texto: string;
  estado: string;
  modelo: string | null;
  uso: unknown;
  motivo: string | null;
  creado_en: string;
}

/**
 * Una base de mentira que contesta las consultas del servicio sobre dos
 * arreglos. Registra cada consulta a `conversacion` para verificar que todas
 * filtran por el usuario: la base aísla por empresa, el usuario lo filtra el
 * servicio.
 */
function baseFalsa() {
  const conversaciones: Conversacion[] = [];
  const turnos: Turno[] = [];
  const consultasConversacion: Array<{ sql: string; params: unknown[] }> = [];
  const consultas: Array<{
    empresa_id: string;
    turno_id: string;
    orden: number;
    herramienta: string;
    entrada: string;
    filas: number | null;
    error: string | null;
  }> = [];
  let fallaAlGuardarAsistente = false;

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (
      /FROM conversacion\b|UPDATE conversacion\b|INSERT INTO conversacion\b/.test(
        sql,
      )
    ) {
      consultasConversacion.push({ sql, params });
    }
    if (sql.includes('AS titulo')) {
      return conversaciones
        .filter((c) => c.usuario_id === params[0])
        .map((c) => {
          const propios = turnos.filter((t) => t.conversacion_id === c.id);
          const preguntas = propios.filter((t) => t.autor === 'PERSONA');
          return {
            id: c.id,
            creada_en: '2026-09-21T09:00:00Z',
            archivada_en: c.archivada_en,
            titulo: preguntas[0]?.texto.slice(0, 80),
            preguntas: preguntas.length,
            ultima_en: '2026-09-21T10:00:00Z',
          };
        })
        .filter((c) => c.preguntas > 0)
        .reverse();
    }
    if (sql.includes('WHERE id = $1 AND usuario_id = $2')) {
      const c = conversaciones.find(
        (x) => x.id === params[0] && x.usuario_id === params[1],
      );
      return c ? [{ id: c.id, archivada_en: c.archivada_en }] : [];
    }
    if (sql.startsWith('INSERT INTO conversacion (')) {
      const [empresa_id, usuario_id] = params as string[];
      if (
        !conversaciones.some(
          (c) => c.usuario_id === usuario_id && c.archivada_en === null,
        )
      ) {
        conversaciones.push({
          id: `c-${conversaciones.length + 1}`,
          empresa_id,
          usuario_id,
          archivada_en: null,
        });
      }
      return [];
    }
    if (
      sql.includes('FROM conversacion') &&
      sql.includes('archivada_en IS NULL')
    ) {
      const c = conversaciones.find(
        (x) => x.usuario_id === params[0] && x.archivada_en === null,
      );
      return c ? [{ id: c.id }] : [];
    }
    if (sql.startsWith('UPDATE conversacion SET archivada_en')) {
      for (const c of conversaciones) {
        if (c.usuario_id === params[0] && c.archivada_en === null)
          c.archivada_en = 'ahora';
      }
      return [];
    }
    if (sql.includes('INSERT INTO conversacion_consulta')) {
      const [empresa_id, turno_id, orden, herramienta, entrada, filas, error] =
        params as [
          string,
          string,
          number,
          string,
          string,
          number | null,
          string | null,
        ];
      consultas.push({
        empresa_id,
        turno_id,
        orden,
        herramienta,
        entrada,
        filas,
        error,
      });
      return [];
    }
    if (sql.includes('FROM conversacion_turno')) {
      return turnos
        .filter((t) => t.conversacion_id === params[0])
        .sort((a, b) => a.orden - b.orden)
        .map((t) => {
          const suyas = consultas
            .filter((c) => c.turno_id === t.id && c.error === null)
            .sort((a, b) => a.orden - b.orden)
            .map((c) => c.herramienta);
          return { ...t, herramientas: suyas.length === 0 ? null : suyas };
        });
    }
    if (sql.includes('INSERT INTO conversacion_turno')) {
      const [
        ,
        conversacion_id,
        orden,
        autor,
        texto,
        estado,
        modelo,
        uso,
        motivo,
      ] = params as [
        string,
        string,
        number,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ];
      if (autor === 'ASISTENTE' && fallaAlGuardarAsistente)
        throw new Error('la base se cayó');
      const t: Turno = {
        id: `t-${turnos.length + 1}`,
        conversacion_id,
        orden,
        autor,
        texto,
        estado,
        modelo,
        uso: uso === null ? null : JSON.parse(uso),
        motivo,
        creado_en: '2026-09-21T10:00:00Z',
      };
      turnos.push(t);
      return [t];
    }
    throw new Error(`Consulta inesperada: ${sql}`);
  });

  const tx = {
    enContexto: (_ctx: unknown, fn: (t: Tx) => unknown) =>
      fn({ query } as unknown as Tx),
  } as unknown as TxService;

  return {
    tx,
    conversaciones,
    turnos,
    consultasConversacion,
    consultas,
    romperGuardado: () => {
      fallaAlGuardarAsistente = true;
    },
  };
}

/** Un conversador de mentira que contesta lo que se le diga y escribe en trozos. */
function conversadorFalso(
  resultado: ResultadoRespuesta,
  disponible = true,
  consultar: readonly string[] = [],
) {
  const responder = jest.fn(
    async (e: {
      hilo: unknown[];
      alEscribir?: (t: string) => void;
      herramientas?: HerramientasDelTurno;
      alConsultar?: (nombre: string, entrada: unknown) => void;
    }): Promise<ResultadoRespuesta> => {
      for (const nombre of consultar) {
        e.alConsultar?.(nombre, { de: nombre });
        await e.herramientas?.ejecutar(nombre, { de: nombre });
      }
      if (resultado.estado === 'COMPLETO') {
        for (const trozo of resultado.texto.split(' ')) e.alEscribir?.(trozo);
      }
      return Promise.resolve(resultado);
    },
  );
  return {
    conversador: { disponible, responder } as unknown as ConversadorPuerto,
    responder,
  };
}

const COMPLETO: ResultadoRespuesta = {
  estado: 'COMPLETO',
  texto: 'En Compras, con Nueva compra.',
  modelo: 'claude-opus-5',
  uso: { entrada: 2, salida: 40, cacheEscrito: 100, cacheLeido: 2500 },
};

/** Las consultas de mentira: registran lo que se pide, y «falla» sale mal. */
function consultasFalsas() {
  const paraTurno = jest.fn(() => {
    const hechas: ConsultaHecha[] = [];
    const herramientas: HerramientasDelTurno = {
      definiciones: [],
      ejecutar: (nombre, entrada) => {
        const error = nombre === 'falla' ? 'Esa columna no existe.' : null;
        hechas.push({
          herramienta: nombre,
          entrada,
          filas: error ? null : 3,
          error,
        });
        return Promise.resolve(error ?? '{}');
      },
    };
    return { herramientas, hechas, propuestas: [] };
  });
  const guardarPropuestas = jest.fn(() => Promise.resolve([]));
  const contextoDelTurno = jest.fn(() => Promise.resolve(null));
  return {
    consultas: {
      paraTurno,
      guardarPropuestas,
      contextoDelTurno,
    } as unknown as ConsultasService,
    paraTurno,
  };
}

function servicio(
  resultado: ResultadoRespuesta = COMPLETO,
  disponible = true,
  consultar: readonly string[] = [],
) {
  const base = baseFalsa();
  const { conversador, responder } = conversadorFalso(
    resultado,
    disponible,
    consultar,
  );
  const { consultas, paraTurno } = consultasFalsas();
  return {
    base,
    responder,
    paraTurno,
    servicio: new ConversacionService(base.tx, conversador, consultas),
  };
}

describe('ConversacionService — un turno', () => {
  it('la primera pregunta crea la conversación y queda en el orden 1; la respuesta, en el 2', async () => {
    const { servicio: s, base, responder } = servicio();
    const preparado = await s.preparar(ana, '  ¿Cómo registro una compra?  ');
    expect(preparado.pregunta).toMatchObject({
      orden: 1,
      autor: 'PERSONA',
      texto: '¿Cómo registro una compra?',
    });
    expect(preparado.hilo).toEqual([
      { autor: 'PERSONA', texto: '¿Cómo registro una compra?' },
    ]);

    const trozos: string[] = [];
    const respuesta = await s.responder(ana, preparado, {
      alEscribir: (t) => trozos.push(t),
    });
    expect(trozos.join(' ')).toBe('En Compras, con Nueva compra.');
    expect(respuesta).toMatchObject({
      orden: 2,
      autor: 'ASISTENTE',
      estado: 'COMPLETO',
    });
    expect(respuesta).not.toHaveProperty('uso');
    expect(base.turnos[1]).toMatchObject({
      modelo: 'claude-opus-5',
      uso: COMPLETO.uso,
    });
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it('el segundo turno manda todo el hilo al modelo', async () => {
    const { servicio: s, responder } = servicio();
    await s.responder(ana, await s.preparar(ana, 'primera'));
    await s.responder(ana, await s.preparar(ana, 'segunda'));
    const hilo = responder.mock.calls[1][0].hilo;
    expect(hilo).toEqual([
      { autor: 'PERSONA', texto: 'primera' },
      {
        autor: 'ASISTENTE',
        texto: COMPLETO.estado === 'COMPLETO' ? COMPLETO.texto : '',
      },
      { autor: 'PERSONA', texto: 'segunda' },
    ]);
  });

  it('toda consulta a la conversación va filtrada por quien pregunta', async () => {
    const { servicio: s, base } = servicio();
    await s.responder(ana, await s.preparar(ana, 'hola'));
    await s.vigente(ana);
    await s.lista(ana);
    await s.una(ana, base.conversaciones[0].id);
    await s.archivar(ana);
    expect(base.consultasConversacion.length).toBeGreaterThan(0);
    for (const c of base.consultasConversacion) {
      expect(c.sql).toMatch(/usuario_id/);
      expect(c.params).toContain('u-ana');
    }
  });
});

describe('ConversacionService — lo que se guarda de cada forma de terminar', () => {
  it.each<[string, ResultadoRespuesta, Record<string, unknown>]>([
    [
      'un corte',
      {
        estado: 'CORTADO',
        texto: 'Lo que alcan',
        modelo: 'claude-opus-5',
        uso: null,
        motivo: null,
      },
      {
        estado: 'CORTADO',
        texto: 'Lo que alcan',
        modelo: 'claude-opus-5',
        uso: null,
      },
    ],
    [
      'un rechazo',
      {
        estado: 'RECHAZADO',
        modelo: 'claude-opus-5',
        uso: null,
        motivo: 'No puedo ayudarle.',
      },
      { estado: 'RECHAZADO', texto: '', motivo: 'No puedo ayudarle.' },
    ],
    [
      'una falla',
      {
        estado: 'FALLO',
        clase: 'NO_DISPONIBLE',
        motivo: 'Intente en un momento.',
      },
      {
        estado: 'FALLO',
        texto: '',
        modelo: null,
        motivo: 'Intente en un momento.',
      },
    ],
  ])(
    '%s se guarda con los datos que exige la base',
    async (_caso, resultado, esperado) => {
      const { servicio: s, base } = servicio(resultado);
      const respuesta = await s.responder(ana, await s.preparar(ana, 'hola'));
      expect(base.turnos[1]).toMatchObject(esperado);
      expect(respuesta.estado).toBe(esperado.estado);
    },
  );
});

describe('ConversacionService — lo que frena antes de llamar al modelo', () => {
  it('una pregunta vacía', async () => {
    const { servicio: s } = servicio();
    await expect(s.preparar(ana, '   ')).rejects.toThrow(
      /Escriba una pregunta/,
    );
  });

  it('sin clave, 503 y nada guardado', async () => {
    const { servicio: s, base } = servicio(COMPLETO, false);
    await expect(s.preparar(ana, 'hola')).rejects.toMatchObject({
      status: 503,
    });
    expect(base.turnos).toHaveLength(0);
  });

  it('con el asistente en pausa desde la consola, 503 y nada guardado', async () => {
    const base = baseFalsa();
    const { conversador, responder } = conversadorFalso(COMPLETO, true, []);
    const { consultas } = consultasFalsas();
    const pausa = new PausaIaService({
      sinContexto: (fn: (t: unknown) => unknown) =>
        fn({ query: () => Promise.resolve([{ '?column?': 1 }]) }),
    } as unknown as TxService);
    const s = new ConversacionService(base.tx, conversador, consultas, pausa);

    await expect(s.preparar(ana, 'hola')).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/en pausa/) as unknown,
    });
    expect(base.turnos).toHaveLength(0);
    expect(responder).not.toHaveBeenCalled();
  });

  it('la pregunta 21 del minuto es un 429', async () => {
    const { servicio: s } = servicio();
    for (let i = 0; i < 20; i += 1)
      await s.responder(ana, await s.preparar(ana, `p${i}`));
    const intento = s.preparar(ana, 'una más');
    await expect(intento).rejects.toBeInstanceOf(HttpException);
    await expect(intento).rejects.toMatchObject({ status: 429 });
  });

  it('otra pregunta mientras se contesta la anterior es un 409, y después vuelve a andar', async () => {
    const { servicio: s } = servicio();
    const primera = await s.preparar(ana, 'primera');
    await expect(s.preparar(ana, 'segunda')).rejects.toBeInstanceOf(
      ConflictException,
    );
    await s.responder(ana, primera);
    await expect(s.preparar(ana, 'segunda')).resolves.toMatchObject({
      pregunta: { orden: 3 },
    });
  });

  it('el hilo que ya pesa el tope no sigue: se dice y se ofrece empezar otra', async () => {
    const pesado: ResultadoRespuesta = {
      ...COMPLETO,
      uso: { entrada: 2, salida: 10, cacheEscrito: 0, cacheLeido: 60_000 },
    };
    const { servicio: s } = servicio(pesado);
    await s.responder(ana, await s.preparar(ana, 'primera'));
    expect((await s.vigente(ana)).superaTope).toBe(true);
    await expect(s.preparar(ana, 'segunda')).rejects.toThrow(
      /Empiece una nueva/,
    );
  });
});

describe('ConversacionService — la conversación', () => {
  it('sin conversar todavía, la vigente está vacía', async () => {
    const { servicio: s } = servicio();
    expect(await s.vigente(ana)).toEqual({
      id: null,
      turnos: [],
      superaTope: false,
    });
  });

  it('empezar de nuevo archiva la vigente y la próxima pregunta abre otra', async () => {
    const { servicio: s, base } = servicio();
    await s.responder(ana, await s.preparar(ana, 'hola'));
    await s.archivar(ana);
    expect((await s.vigente(ana)).id).toBeNull();
    const nueva = await s.preparar(ana, 'otra vez');
    expect(nueva.conversacionId).not.toBe(base.conversaciones[0].id);
    expect(nueva.pregunta.orden).toBe(1);
  });

  it('no se archiva con una respuesta en curso', async () => {
    const { servicio: s } = servicio();
    await s.preparar(ana, 'hola');
    await expect(s.archivar(ana)).rejects.toBeInstanceOf(ConflictException);
  });

  it('si falla el guardado de la respuesta, la conversación igual queda libre', async () => {
    const { servicio: s, base } = servicio();
    const preparado = await s.preparar(ana, 'hola');
    base.romperGuardado();
    await expect(s.responder(ana, preparado)).rejects.toThrow(/se cayó/);
    await expect(s.preparar(ana, 'de nuevo')).resolves.toBeDefined();
  });
});

describe('ConversacionService — la lista y las archivadas', () => {
  const beto: CtxEmpresa = { ...ana, usuarioId: 'u-beto' };

  it('lista las de quien pregunta, la más reciente primero, con la primera pregunta como título', async () => {
    const { servicio: s } = servicio();
    await s.responder(ana, await s.preparar(ana, 'primera charla'));
    await s.archivar(ana);
    await s.responder(ana, await s.preparar(ana, 'segunda charla'));
    await s.responder(beto, await s.preparar(beto, 'la de beto'));
    const lista = await s.lista(ana);
    expect(lista.map((c) => [c.titulo, c.archivada_en === null])).toEqual([
      ['segunda charla', true],
      ['primera charla', false],
    ]);
  });

  it('una conversación vacía no se lista', async () => {
    const { servicio: s, base } = servicio();
    base.conversaciones.push({
      id: 'c-vacia',
      empresa_id: 'e-1',
      usuario_id: 'u-ana',
      archivada_en: null,
    });
    expect(await s.lista(ana)).toEqual([]);
  });

  it('una archivada se lee entera, y dice que no es la vigente', async () => {
    const { servicio: s, base } = servicio();
    await s.responder(ana, await s.preparar(ana, 'hola'));
    await s.archivar(ana);
    const leida = await s.una(ana, base.conversaciones[0].id);
    expect(leida.vigente).toBe(false);
    expect(leida.turnos.map((t) => t.autor)).toEqual(['PERSONA', 'ASISTENTE']);
    expect(leida.turnos[1]).not.toHaveProperty('uso');
  });

  it('la de otra persona da 404, igual que una que no existe', async () => {
    const { servicio: s, base } = servicio();
    await s.responder(beto, await s.preparar(beto, 'la de beto'));
    await expect(s.una(ana, base.conversaciones[0].id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(s.una(ana, 'c-no-existe')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('ConversacionService — las consultas a los datos (paso 6)', () => {
  it('las herramientas salen de quien pregunta y llegan al modelo', async () => {
    const { servicio: s, paraTurno, responder } = servicio();
    await s.responder(ana, await s.preparar(ana, '¿Cuánto me debe Corona?'));
    expect(paraTurno).toHaveBeenCalledWith(ana);
    const pedido = responder.mock.calls[0][0] as { herramientas?: unknown };
    expect(pedido.herramientas).toBeDefined();
  });

  it('cada consulta se avisa con la etiqueta de la aplicación, no con el nombre de la herramienta', async () => {
    const { servicio: s } = servicio(COMPLETO, true, [
      'buscar_valores',
      'consultar_cartera',
    ]);
    const avisos: string[] = [];
    await s.responder(ana, await s.preparar(ana, '¿Cuánto me debe Corona?'), {
      alConsultar: (e) => avisos.push(e),
    });
    expect(avisos).toEqual(['Búsqueda', 'Cartera']);
  });

  it('se guardan con la respuesta, en orden, con lo que falló; las fuentes son las que salieron bien', async () => {
    const { servicio: s, base } = servicio(COMPLETO, true, [
      'buscar_valores',
      'falla',
      'consultar_cartera',
      'consultar_cartera',
    ]);
    const respuesta = await s.responder(
      ana,
      await s.preparar(ana, '¿Cuánto me debe Corona?'),
    );
    expect(
      base.consultas.map((c) => [c.orden, c.herramienta, c.error !== null]),
    ).toEqual([
      [1, 'buscar_valores', false],
      [2, 'falla', true],
      [3, 'consultar_cartera', false],
      [4, 'consultar_cartera', false],
    ]);
    expect(base.consultas.every((c) => c.turno_id === respuesta.id)).toBe(true);
    // Sin la búsqueda de nombres y sin repetir.
    expect(respuesta.fuentes).toEqual(['Cartera']);
  });

  it('al releer la conversación, cada respuesta trae sus fuentes y las preguntas ninguna', async () => {
    const { servicio: s } = servicio(COMPLETO, true, ['consultar_saldos']);
    await s.responder(ana, await s.preparar(ana, '¿Cuánto hay en el banco?'));
    const { turnos } = await s.vigente(ana);
    expect(turnos.map((t) => [t.autor, t.fuentes])).toEqual([
      ['PERSONA', []],
      ['ASISTENTE', ['Saldos de caja y bancos']],
    ]);
  });

  it('sin consultas, la respuesta no tiene fuentes', async () => {
    const { servicio: s } = servicio();
    const r = await s.responder(ana, await s.preparar(ana, '¿Cómo pago?'));
    expect(r.fuentes).toEqual([]);
  });
});
