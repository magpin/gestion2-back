import { GraficoService, TINTA } from './grafico.service';

/**
 * Lo que se vigila acá son los **defectos de QuickChart**, que es donde se
 * pierde una tarde: la sintaxis es la de Chart.js v2 y las opciones mal puestas
 * no fallan, se ignoran, y el gráfico sale con leyenda o con números encima.
 *
 * Que el PNG llegue de verdad lo comprueba
 * `scripts/verificar-reportes-sidecars.js`, que necesita el contenedor.
 */
describe('GraficoService', () => {
  const servicio = new GraficoService();

  /** La configuración que de verdad sale hacia QuickChart. */
  const enviada = async (config: Record<string, unknown>) => {
    let url = '';
    globalThis.fetch = jest.fn((u: string) => {
      url = u;
      return Promise.resolve({
        ok: true,
        arrayBuffer: () =>
          Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      });
    }) as unknown as typeof fetch;

    await servicio.aPng(config, 150, 150);
    const c = new URL(url).searchParams.get('c');
    return JSON.parse(c ?? '{}') as {
      options?: {
        legend?: { display?: boolean };
        plugins?: Record<string, unknown>;
      };
    };
  };

  it('apaga la leyenda, que el diseño resuelve con rótulos al lado', async () => {
    const config = await enviada({ type: 'doughnut', data: {} });
    expect(config.options?.legend?.display).toBe(false);
  });

  it('apaga los datalabels, que vienen encendidos y escriben el valor encima', async () => {
    const config = await enviada({ type: 'doughnut', data: {} });
    expect(config.options?.plugins?.datalabels).toEqual({ display: false });
  });

  it('usa `legend` y no `plugins.legend`: la sintaxis es de Chart.js v2', async () => {
    // Con la de v3 QuickChart 1.8.1 ignora la opción y dibuja la leyenda igual,
    // sin un solo error. Es la trampa que costó la primera dona.
    const config = await enviada({ type: 'doughnut', data: {} });
    expect(config.options).toHaveProperty('legend');
    expect(config.options?.plugins).not.toHaveProperty('legend');
  });

  it('no pisa lo que el gráfico sí quiso decir', async () => {
    const config = await enviada({
      type: 'bar',
      data: {},
      options: {
        legend: { display: true },
        scales: { yAxes: [{ display: false }] },
      },
    });
    expect(config.options?.legend?.display).toBe(true);
    expect(config.options).toHaveProperty('scales');
  });

  it('devuelve null si QuickChart no contesta, porque un reporte sin gráfico sigue siendo un reporte', async () => {
    globalThis.fetch = jest.fn(() => Promise.reject(new Error('sin red')));

    await expect(
      servicio.aPng({ type: 'pie', data: {} }, 100, 100),
    ).resolves.toBeNull();
  });

  it('devuelve null si lo que llega no es un PNG, aunque venga con 200', async () => {
    globalThis.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(Buffer.from('<html>error</html>')),
      }),
    ) as unknown as typeof fetch;

    await expect(
      servicio.aPng({ type: 'pie', data: {} }, 100, 100),
    ).resolves.toBeNull();
  });

  describe('la tinta', () => {
    it('reserva el naranja para una sola cosa', () => {
      // Si el acento entra en los tramos, deja de señalar. Es la regla de
      // dosis del reglamento de color, escrita como prueba.
      expect(TINTA.tramos).not.toContain(TINTA.atencion);
      expect(TINTA.resuelto).not.toBe(TINTA.atencion);
    });

    it('distingue los tramos por luminosidad, para que se lean fotocopiados', () => {
      const luz = (hex: string) => parseInt(hex.slice(1, 3), 16);
      const luces = [TINTA.resuelto, ...TINTA.tramos].map(luz);
      expect(luces).toEqual([...luces].sort((a, b) => a - b));
      expect(new Set(luces).size).toBe(luces.length);
    });
  });
});
