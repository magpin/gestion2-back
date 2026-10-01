import type { FotoParametros, TarifaLey } from '../servicios/parametros.reglas';
import {
  calcularVenta,
  compararConCliente,
  faltaCuentaAutorretencion,
  type ClienteComprador,
  type ContextoVenta,
  type EmpresaVendedora,
} from './venta.reglas';

const t = (x: Partial<TarifaLey>): TarifaLey => ({
  id: 't',
  conceptoId: 'C',
  tipoPersona: null,
  declarante: true,
  baseUvt: 10,
  tarifa: 0.025,
  vigenciaDesde: '2026-07-01',
  vigenciaHasta: null,
  norma: 'Decreto 572/2025',
  ...x,
});

const foto: FotoParametros = {
  fecha: '2026-09-25',
  uvt: 52374,
  tarifas: [
    t({}),
    t({ id: 'iva', conceptoId: 'IVA', declarante: null, tarifa: 0.15 }),
  ],
};

const ctx = (x: Partial<ContextoVenta> = {}): ContextoVenta => ({
  foto,
  conceptoCompras: 'C',
  conceptoReteIva: 'IVA',
  tarifaEspecial: (ciiu) =>
    ciiu === '4711' ? { tarifa: 0.008, norma: 'Art. 1.2.6.8 DUR' } : null,
  ...x,
});

const EMPRESA: EmpresaVendedora = {
  autorretenedorEspecial: false,
  ciiuPrincipal: '4711',
  regimenSimple: false,
  agenteRenta: true,
  autorretenedorRenta: false,
  responsableIva: true,
  tipoPersona: 'JURIDICA',
};

const CLIENTE: ClienteComprador = {
  regimenSimple: false,
  agenteRenta: false,
  agenteIva: false,
};
const venta = { fecha: '2026-09-25', subtotal: 1_000_000, iva: 190_000 };

describe('Ventas — autorretenciones (especificación §14)', () => {
  it('T22 — venta a un cliente del SIMPLE siendo agente → autorretención de lo que él no retiene', () => {
    const r = calcularVenta(
      venta,
      EMPRESA,
      { ...CLIENTE, regimenSimple: true },
      ctx(),
    );
    expect(r.autorretenciones).toMatchObject([
      { tipo: 'VENTA_A_SIMPLE', valor: 25_000 },
    ]);
  });

  it('venta al SIMPLE sin ser agente de renta → nada', () => {
    const r = calcularVenta(
      venta,
      { ...EMPRESA, agenteRenta: false },
      { ...CLIENTE, regimenSimple: true },
      ctx(),
    );
    expect(r.autorretenciones).toEqual([]);
  });

  it('venta al SIMPLE bajo la base mínima → nada', () => {
    const r = calcularVenta(
      { ...venta, subtotal: 300_000 },
      EMPRESA,
      { ...CLIENTE, regimenSimple: true },
      ctx(),
    );
    expect(r.autorretenciones).toEqual([]);
  });

  it('autorretenedor especial → su tarifa por CIIU sobre todo el ingreso', () => {
    const r = calcularVenta(
      venta,
      { ...EMPRESA, autorretenedorEspecial: true },
      CLIENTE,
      ctx(),
    );
    expect(r.autorretenciones).toMatchObject([
      { tipo: 'ESPECIAL', valor: 8_000 },
    ]);
  });

  it('autorretenedor especial sin tarifa cargada para su CIIU → avisa, nunca cero en silencio', () => {
    const r = calcularVenta(
      venta,
      { ...EMPRESA, autorretenedorEspecial: true, ciiuPrincipal: '9999' },
      CLIENTE,
      ctx(),
    );
    expect(r.autorretenciones).toEqual([]);
    expect(r.avisos[0]).toMatch(/CIIU 9999/);
  });

  it('bug 6: una persona natural no practica autorretención especial (art. 1.2.6.6 DUR): no la calcula y avisa', () => {
    const r = calcularVenta(
      venta,
      { ...EMPRESA, autorretenedorEspecial: true, tipoPersona: 'NATURAL' },
      CLIENTE,
      ctx(),
    );
    expect(r.autorretenciones).toEqual([]);
    expect(r.avisos[0]).toMatch(/persona natural/);
    expect(r.avisos[0]).toMatch(/1\.2\.6\.6/);
  });
});

describe('Ventas — lo que el cliente debería retener', () => {
  it('cliente agente de renta e IVA → renta 2,5 % y ReteIVA 15 %', () => {
    const r = calcularVenta(
      venta,
      EMPRESA,
      { ...CLIENTE, agenteRenta: true, agenteIva: true },
      ctx(),
    );
    expect(r.esperadas).toEqual({ renta: 25_000, iva: 28_500 });
  });

  it('si la empresa es autorretenedora, el cliente no le retiene renta', () => {
    const r = calcularVenta(
      venta,
      { ...EMPRESA, autorretenedorRenta: true },
      { ...CLIENTE, agenteRenta: true },
      ctx(),
    );
    expect(r.esperadas.renta).toBe(0);
  });

  it('avisa si lo registrado no cuadra; si cuadra, no dice nada', () => {
    expect(
      compararConCliente({ renta: 25_000, iva: 0 }, { renta: 25_000, iva: 0 }),
    ).toBeNull();
    expect(
      compararConCliente({ renta: 25_000, iva: 0 }, { renta: 0, iva: 0 }),
    ).toMatch(/corresponden \$25\.000/);
  });
});

describe('faltaCuentaAutorretencion (bug #13)', () => {
  it('dice cuál falta: solo la 236575', () => {
    const texto = faltaCuentaAutorretencion(
      { cuenta_id: null, cuenta_activo_id: 'a' },
      'RENTA',
    );
    expect(texto).toContain('le falta la cuenta 236575');
    expect(texto).not.toContain('135515');
    expect(texto).not.toContain(' o la ');
  });

  it('dice cuál falta: solo la 135515', () => {
    const texto = faltaCuentaAutorretencion(
      { cuenta_id: 'p', cuenta_activo_id: null },
      'RENTA',
    );
    expect(texto).toContain('le falta la cuenta 135515');
    expect(texto).not.toContain('236575');
  });

  it('sin enlace faltan las dos', () => {
    expect(faltaCuentaAutorretencion(null, 'RENTA')).toContain(
      'le faltan las cuentas 236575 (autorretenciones) y 135515',
    );
  });

  it('ICA nombra sus propias cuentas', () => {
    expect(
      faltaCuentaAutorretencion(
        { cuenta_id: 'p', cuenta_activo_id: null },
        'ICA',
      ),
    ).toContain('135518');
  });

  it('con las dos no falta nada', () => {
    expect(
      faltaCuentaAutorretencion(
        { cuenta_id: 'p', cuenta_activo_id: 'a' },
        'RENTA',
      ),
    ).toBeNull();
  });
});
