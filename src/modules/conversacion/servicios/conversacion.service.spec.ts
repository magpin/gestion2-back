import { ConflictException, HttpException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { Tx, TxService } from '../../../common/db/tx.service';
import type {
  ConversadorPuerto,
  ResultadoRespuesta,
} from '../proveedores/conversador.puerto';
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
  let fallaAlGuardarAsistente = false;

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (
      /FROM conversacion\b|UPDATE conversacion\b|INSERT INTO conversacion\b/.test(
        sql,
      )
    ) {
      consultasConversacion.push({ sql, params });
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
    if (sql.includes('FROM conversacion_turno')) {
      return turnos
        .filter((t) => t.conversacion_id === params[0])
        .sort((a, b) => a.orden - b.orden);
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
    romperGuardado: () => {
      fallaAlGuardarAsistente = true;
    },
  };
}

/** Un conversador de mentira que contesta lo que se le diga y escribe en trozos. */
function conversadorFalso(resultado: ResultadoRespuesta, disponible = true) {
  const responder = jest.fn(
    async (e: {
      hilo: unknown[];
      alEscribir?: (t: string) => void;
    }): Promise<ResultadoRespuesta> => {
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

function servicio(resultado: ResultadoRespuesta = COMPLETO, disponible = true) {
  const base = baseFalsa();
  const { conversador, responder } = conversadorFalso(resultado, disponible);
  return {
    base,
    responder,
    servicio: new ConversacionService(base.tx, conversador),
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
        motivo: 'No puedo ayudarte.',
      },
      { estado: 'RECHAZADO', texto: '', motivo: 'No puedo ayudarte.' },
    ],
    [
      'una falla',
      { estado: 'FALLO', clase: 'NO_DISPONIBLE', motivo: 'Probá en un rato.' },
      { estado: 'FALLO', texto: '', modelo: null, motivo: 'Probá en un rato.' },
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
      /Escribí una pregunta/,
    );
  });

  it('sin clave, 503 y nada guardado', async () => {
    const { servicio: s, base } = servicio(COMPLETO, false);
    await expect(s.preparar(ana, 'hola')).rejects.toMatchObject({
      status: 503,
    });
    expect(base.turnos).toHaveLength(0);
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
      /Empezá una nueva/,
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
