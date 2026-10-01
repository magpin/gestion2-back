import {
  armarTablero,
  diaEnPalabras,
  type CompraPendiente,
  type EntradaTablero,
} from './tablero.reglas';

const HOY = '2026-09-28'; // lunes

const compra = (c: Partial<CompraPendiente>): CompraPendiente => ({
  id: 'c1',
  numero: 'FV-1',
  venceEfectivo: '2026-10-01',
  tramo: 'ESTA_SEMANA',
  pendiente: 100,
  descuentoSugerido: 0,
  descuentoPct: null,
  descuentoHasta: null,
  ...c,
});

const base = (e: Partial<EntradaTablero> = {}): EntradaTablero => ({
  hoy: HOY,
  lugares: [
    { id: 'b', medio: 'BANCO', nombre: 'Bancolombia', saldo: 1000 },
    { id: 'k', medio: 'CAJA', nombre: 'Caja principal', saldo: 200 },
  ],
  cartera: { total: 0, facturas: 0, clientes: [] },
  porPagar: { total: 0, compras: 0, tramos: { VENCIDO: 0 }, proveedores: [] },
  porCobrar: [],
  programados: [],
  resultado: null,
  ...e,
});

describe('tablero del dinero', () => {
  it('el dinero de hoy es la suma de cajas y bancos', () => {
    const t = armarTablero(base());
    expect(t.plataHoy.total).toBe(1200);
    expect(t.alertas).toEqual([]);
    expect(t.resultadoMes).toBeNull();
  });

  it('la semana son siete días desde hoy, sin lo vencido ni lo que viene después', () => {
    const t = armarTablero(
      base({
        porCobrar: [
          { vence: '2026-09-27', pendiente: 999 }, // vencida: no entra
          { vence: HOY, pendiente: 50 },
          { vence: '2026-10-04', pendiente: 70 },
          { vence: '2026-10-05', pendiente: 999 }, // la otra semana
        ],
        porPagar: {
          total: 100,
          compras: 1,
          tramos: { VENCIDO: 0 },
          proveedores: [
            { terceroId: 'p', nombre: 'Proveedor', compras: [compra({})] },
          ],
        },
        programados: [
          {
            fecha: '2026-10-01',
            valor: 30,
            descripcion: 'Arriendo',
            compraId: null,
          },
          // Apunta a una compra: ya está en lo por pagar.
          {
            fecha: '2026-10-01',
            valor: 100,
            descripcion: 'FV-1',
            compraId: 'c1',
          },
        ],
      }),
    );
    expect(t.semana.map((d) => d.dia)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(t.semana[0].entra).toBe(50);
    expect(t.semana[6].entra).toBe(70);
    expect(t.semana[3].sale).toBe(130);
  });

  it('le deben: lo vencido y los clientes más atrasados, con alerta que abre a María', () => {
    const t = armarTablero(
      base({
        cartera: {
          total: 500,
          facturas: 3,
          clientes: [
            {
              terceroId: 'a',
              nombre: 'Ferretería',
              facturas: 1,
              vencido: 300,
              total: 300,
              maxDiasVencidos: 65,
            },
            {
              terceroId: 'b',
              nombre: 'Juan',
              facturas: 2,
              vencido: 0,
              total: 200,
              maxDiasVencidos: -5,
            },
          ],
        },
      }),
    );
    expect(t.teDeben.vencido).toBe(300);
    expect(t.teDeben.masVencidos.map((c) => c.nombre)).toEqual(['Ferretería']);
    expect(t.alertas).toEqual([
      {
        clave: 'cartera:a',
        partes: ['Ferretería lleva 65 días sin pagar ', 300, '.'],
        accion: {
          tipo: 'MARIA',
          pregunta: '¿Qué facturas me debe Ferretería y desde cuándo?',
        },
      },
    ]);
  });

  it('avisa si el dinero no alcanza, del descuento que se vence y de lo que no está programado', () => {
    const t = armarTablero(
      base({
        porPagar: {
          total: 2100,
          compras: 2,
          tramos: { VENCIDO: 0 },
          proveedores: [
            {
              terceroId: 'p',
              nombre: 'Mayorista',
              compras: [
                compra({
                  id: 'd',
                  numero: 'FV-9',
                  venceEfectivo: '2026-10-10',
                  pendiente: 1000,
                  descuentoSugerido: 20,
                  descuentoPct: 2,
                  descuentoHasta: '2026-09-30',
                }),
              ],
            },
            {
              terceroId: 'q',
              nombre: 'Arrendamientos',
              compras: [
                compra({
                  id: 'e',
                  numero: 'A-10',
                  venceEfectivo: '2026-10-01',
                  pendiente: 1500,
                }),
              ],
            },
          ],
        },
      }),
    );
    expect(t.alertas.map((a) => a.clave)).toEqual([
      'faltante',
      'descuento:d',
      'vence:e',
    ]);
    expect(t.alertas[0].partes).toEqual([
      'Con lo que vence, el jueves 1 oct el dinero no alcanza: faltarían ',
      300,
      '.',
    ]);
    expect(t.alertas[1].partes[0]).toBe(
      'Si le paga a Mayorista hasta el miércoles 30 sep, se ahorra ',
    );
    expect(t.alertas[2].partes[0]).toBe(
      'El jueves 1 oct vence la factura A-10 de Arrendamientos, ',
    );
    // Lo que vence primero, primero.
    expect(t.debes.proximos.map((p) => p.numero)).toEqual(['A-10', 'FV-9']);
  });

  it('el resultado del mes y su variación', () => {
    const t = armarTablero(
      base({
        resultado: {
          mes: '2026-09',
          ingresos: 1000,
          utilidad: 150,
          utilidadAnterior: 100,
          mesAnterior: '2026-08',
        },
      }),
    );
    expect(t.resultadoMes).toEqual({
      mes: '2026-09',
      ingresos: 1000,
      costosYGastos: 850,
      utilidad: 150,
      mesAnterior: '2026-08',
      variacion: 50,
    });
  });

  it('los días en palabras', () => {
    expect(diaEnPalabras(HOY, HOY)).toBe('hoy');
    expect(diaEnPalabras('2026-09-29', HOY)).toBe('mañana');
    expect(diaEnPalabras('2026-10-01', HOY)).toBe('el jueves 1 oct');
  });
});
