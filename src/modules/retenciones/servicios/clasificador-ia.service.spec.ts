import type { CtxEmpresa } from '../../../common/ctx';
import type { ClasificadorPuerto } from '../proveedores/clasificador.puerto';
import { ClasificadorIaService } from './clasificador-ia.service';
import type { DocumentoRenta, PropuestaRenta } from './motor-renta.service';

const ctx = { empresaId: 'e', tenantId: 'c', usuarioId: 'u' } as CtxEmpresa;
const doc: DocumentoRenta = {
  terceroId: 't',
  fecha: '2026-09-26',
  renglones: [
    {
      orden: 1,
      subtotal: 900_000,
      productoId: null,
      texto: 'Diseño del plan de emergencias',
      cuentaCodigo: null,
    },
    {
      orden: 2,
      subtotal: 100_000,
      productoId: null,
      texto: 'Diseño del plan de emergencias',
      cuentaCodigo: null,
    },
  ],
};

const propuesta = (pideIa: boolean) =>
  ({
    renglones: [1, 2].map((orden) => ({ orden, pideIa })),
    conceptos: [
      { codigo: 'HONORARIOS', nombre: 'Honorarios' },
      { codigo: 'SERVICIOS_GENERALES', nombre: 'Servicios generales' },
    ],
  }) as unknown as PropuestaRenta;

function armar(o: {
  pideIa?: boolean;
  disponible?: boolean;
  pausada?: boolean;
  respuesta?: unknown;
}) {
  const insertados: unknown[][] = [];
  const t = {
    query: jest.fn((sql: string, p: unknown[]) => {
      if (sql.includes('FROM tercero x')) {
        return Promise.resolve([
          { nombre: 'Omaira', tipo_persona: 'NATURAL', ciiu: null },
        ]);
      }
      insertados.push(p);
      return Promise.resolve([]);
    }),
  };
  const tx = {
    enContexto: jest.fn((_c: unknown, fn: (x: typeof t) => unknown) => fn(t)),
  };
  const motor = {
    proponer: jest.fn(() => Promise.resolve(propuesta(o.pideIa ?? true))),
  };
  const clasificar = jest.fn(() =>
    Promise.resolve(
      o.respuesta === null
        ? null
        : {
            respuesta: o.respuesta ?? {
              conceptoCodigo: 'HONORARIOS',
              razon: 'Servicio.',
              alternativas: [],
            },
            modelo: 'claude-haiku-4-5',
            uso: { entrada: 900, salida: 60, cacheLeido: 0, cacheEscrito: 0 },
            duracionMs: 800,
          },
    ),
  );
  const ia: ClasificadorPuerto = {
    disponible: o.disponible ?? true,
    clasificar,
  };
  const pausa = { pausada: jest.fn(() => Promise.resolve(o.pausada ?? false)) };
  const s = new ClasificadorIaService(
    tx as never,
    motor as never,
    ia,
    pausa as never,
  );
  return { s, clasificar, insertados };
}

describe('ClasificadorIaService — la fuente 5', () => {
  it('pregunta una vez por renglón repetido y guarda la propuesta', async () => {
    const { s, clasificar, insertados } = armar({});
    await expect(s.completar(ctx, doc)).resolves.toBe(1);
    expect(clasificar).toHaveBeenCalledTimes(1);
    expect(insertados).toHaveLength(1);
    expect(insertados[0][3]).toBe('PROPUESTA');
    expect(insertados[0][4]).toBe('HONORARIOS');
  });

  it('pausa de IA activa → no llama al modelo', async () => {
    const { s, clasificar } = armar({ pausada: true });
    await expect(s.completar(ctx, doc)).resolves.toBe(0);
    expect(clasificar).not.toHaveBeenCalled();
  });

  it('sin clave de la API → no llama al modelo', async () => {
    const { s, clasificar } = armar({ disponible: false });
    await expect(s.completar(ctx, doc)).resolves.toBe(0);
    expect(clasificar).not.toHaveBeenCalled();
  });

  it('si ya lo resolvió otra fuente, no llama', async () => {
    const { s, clasificar } = armar({ pideIa: false });
    await s.completar(ctx, doc);
    expect(clasificar).not.toHaveBeenCalled();
  });

  it('un concepto fuera de la lista se guarda descartado, sin concepto', async () => {
    const { s, insertados } = armar({
      respuesta: { conceptoCodigo: 'PUBLICIDAD', razon: 'x', alternativas: [] },
    });
    await expect(s.completar(ctx, doc)).resolves.toBe(0);
    expect(insertados[0][3]).toBe('FUERA_DE_LISTA');
    expect(insertados[0][4]).toBeNull();
  });

  it('si el modelo no contesta queda como FALLO, para reintentar', async () => {
    const { s, insertados } = armar({ respuesta: null });
    await s.completar(ctx, doc);
    expect(insertados[0][3]).toBe('FALLO');
  });
});
