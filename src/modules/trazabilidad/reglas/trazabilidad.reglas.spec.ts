import {
  iniciales,
  pasosDelAsiento,
  type FuentesDelAsiento,
} from './trazabilidad.reglas';

const asiento: FuentesDelAsiento['asiento'] = {
  numero: 'CC-000031',
  creadoEn: '2026-09-10T15:00:05Z',
  creadoPor: { nombre: 'Camila Torres' },
  estado: 'REGISTRADO',
  anuladoEn: null,
  anuladoPor: null,
  motivo: null,
  periodo: { anio: 2026, mes: 9 },
};

const leida = {
  factura: { renglones: [{}, {}, {}] },
  comprobaciones: [
    { que: 'Los renglones suman el subtotal', cuadra: true },
    { que: 'El IVA da', cuadra: true },
    { que: 'El total da', cuadra: false },
  ],
  proveedor: { id: 'p', nombre: 'Jaltech' },
  renglones: [
    { resuelto: { id: 'a' }, forma: 'CODIGO' },
    { resuelto: { id: 'b' }, forma: 'APRENDIDO' },
    { resuelto: null },
  ],
};

describe('iniciales', () => {
  it('toma el primer nombre y el último apellido', () => {
    expect(iniciales('Camila Andrea Torres')).toBe('CT');
    expect(iniciales('  ana  ')).toBe('AN');
  });
});

describe('pasosDelAsiento', () => {
  it('un asiento digitado a mano: lo registró alguien y se contabilizó', () => {
    const pasos = pasosDelAsiento({ asiento });
    expect(pasos.map((p) => p.clave)).toEqual(['REGISTRADO', 'CONTABILIZADO']);
    expect(pasos[0]).toMatchObject({
      deMaria: false,
      persona: { nombre: 'Camila Torres', iniciales: 'CT' },
      titulo: 'Camila Torres lo registró',
    });
    expect(pasos[1].detalle).toBe(
      'Período septiembre de 2026 · asiento CC-000031',
    );
  });

  it('una factura leída: recibido, leído, verificado, propuesto, aprobado, contabilizado', () => {
    const pasos = pasosDelAsiento({
      asiento,
      documento: {
        tipo: 'FACTURA_COMPRA',
        clave: 'empresa/x/factura.pdf',
        creadoEn: '2026-09-10T14:00:00Z',
        subidoPor: { nombre: 'Luis Gómez' },
        leidoEn: '2026-09-10T14:00:30Z',
        extraido: leida,
      },
      registro: {
        tipo: 'COMPRA',
        nombre: 'la compra FE-88',
        creadoEn: '2026-09-10T15:00:00Z',
        creadoPor: { nombre: 'Camila Torres' },
      },
    });
    expect(pasos.map((p) => p.clave)).toEqual([
      'RECIBIDO',
      'LEIDO',
      'VERIFICADO',
      'PROPUESTO',
      'APROBADO',
      'CONTABILIZADO',
    ]);
    expect(pasos.map((p) => p.deMaria)).toEqual([
      false,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(pasos[0].detalle).toBe(
      'La factura de compra en PDF · subido por Luis Gómez',
    );
    expect(pasos[1].detalle).toBe(
      '3 renglones leídos, con la cabecera y los totales.',
    );
    expect(pasos[2].aviso).toBe(true);
    expect(pasos[1].aviso).toBeUndefined();
    expect(pasos[2].detalle).toBe(
      '2 de 3 comprobaciones superadas: los renglones suman el subtotal; el IVA da; el total da.',
    );
    expect(pasos[3].detalle).toBe(
      'El proveedor, por su NIT; 1 renglón encontrado en el catálogo; 1 recordado de facturas anteriores; 1 renglón lo contestó una persona.',
    );
    expect(pasos[4]).toMatchObject({
      titulo: 'Camila Torres lo aprobó',
      detalle: 'Registró la compra FE-88.',
    });
  });

  it('nunca dice que María asentó sola: el paso de aprobar es siempre de una persona', () => {
    const pasos = pasosDelAsiento({
      asiento,
      propuesta: {
        accion: 'COBRO',
        creadaEn: '2026-09-10T14:59:00Z',
        resueltaEn: '2026-09-10T15:00:00Z',
        resueltaPor: { nombre: 'Camila Torres' },
      },
    });
    expect(pasos.map((p) => p.clave)).toEqual([
      'PROPUESTO',
      'APROBADO',
      'CONTABILIZADO',
    ]);
    expect(pasos[0].titulo).toBe('María propuso el cobro');
    expect(pasos[1]).toMatchObject({
      deMaria: false,
      detalle: 'Confirmó lo que María propuso.',
    });
  });

  it('un documento sin leer no inventa pasos de María', () => {
    const pasos = pasosDelAsiento({
      asiento,
      documento: {
        tipo: 'FACTURA_COMPRA',
        clave: 'empresa/x/factura.jpg',
        creadoEn: '2026-09-10T14:00:00Z',
        subidoPor: { nombre: 'Luis Gómez' },
        leidoEn: null,
        extraido: null,
      },
    });
    expect(pasos.some((p) => p.deMaria)).toBe(false);
    expect(pasos[0].detalle).toContain('en foto');
  });

  it('el anulado va al final, con quién y por qué', () => {
    const pasos = pasosDelAsiento({
      asiento: {
        ...asiento,
        estado: 'ANULADO',
        anuladoEn: '2026-09-12T10:00:00Z',
        anuladoPor: { nombre: 'Mario Ruiz' },
        motivo: 'Factura repetida',
      },
    });
    expect(pasos.at(-1)).toMatchObject({
      clave: 'ANULADO',
      titulo: 'Anulado por Mario Ruiz',
      detalle: 'Factura repetida',
      persona: { iniciales: 'MR' },
    });
  });
});
