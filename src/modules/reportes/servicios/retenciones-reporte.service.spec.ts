import {
  MesIncompleto,
  RetencionesReporteService,
} from './retenciones-reporte.service';

const rango = (desde: string, hasta: string) => ({
  desde,
  hasta,
  etiqueta: 'prueba',
  relativo: false,
});

describe('RetencionesReporteService.exigirMes (formulario 350)', () => {
  it('un mes completo es su mes', () => {
    expect(
      RetencionesReporteService.exigirMes(rango('2026-08-01', '2026-08-31')),
    ).toBe('2026-08');
  });

  it('«este mes» llega hasta hoy y también sirve: es lo que va del mes', () => {
    expect(
      RetencionesReporteService.exigirMes(rango('2026-09-01', '2026-09-26')),
    ).toBe('2026-09');
  });

  it('un rango que cruza meses no se puede declarar', () => {
    expect(() =>
      RetencionesReporteService.exigirMes(rango('2026-08-01', '2026-09-30')),
    ).toThrow(MesIncompleto);
  });

  it('un rango que no empieza el primero, tampoco', () => {
    expect(() =>
      RetencionesReporteService.exigirMes(rango('2026-09-05', '2026-09-30')),
    ).toThrow(MesIncompleto);
  });
});
