import {
  clasificar,
  llaveDe,
  type Aprendido,
  type RenglonAClasificar,
} from './clasificacion.reglas';

const NOMBRES: Record<string, string> = {
  COMPRAS_GENERALES: 'Compras generales',
  ARREND_INMUEBLES: 'Arrendamiento de bienes inmuebles',
  TRANSPORTE_CARGA: 'Transporte de carga',
  HONORARIOS: 'Honorarios',
  SERVICIOS_GENERALES: 'Servicios generales',
};

const renglon = (x: Partial<RenglonAClasificar>): RenglonAClasificar => ({
  orden: 1,
  productoId: null,
  texto: null,
  cuentaCodigo: null,
  ...x,
});

const contexto = (
  x: { aprendidos?: Aprendido[]; ciiu?: string | null } = {},
) => ({
  aprendidos: x.aprendidos ?? [],
  ciiuProveedor: x.ciiu ?? null,
  nombreProveedor: 'Omaira',
  nombreDe: (c: string) => NOMBRES[c] ?? c,
});

describe('clasificación del concepto de renta — sin IA', () => {
  it('lo que una persona ya confirmó para este proveedor gana: «La vi clara»', () => {
    const c = clasificar(
      renglon({ texto: 'Arriendo local sept.' }),
      contexto({
        ciiu: '4923',
        aprendidos: [
          {
            productoId: null,
            llaveRenglon: 'arriendo local sept',
            deEsteProveedor: true,
            conceptoCodigo: 'ARREND_INMUEBLES',
          },
        ],
      }),
    );
    expect(c).toMatchObject({
      concepto: 'ARREND_INMUEBLES',
      origen: 'CONFIRMADO',
      certeza: 'CLARA',
    });
    expect(c.razon).toMatch(/A Omaira/);
  });

  it('un producto del catálogo es compras generales, claro', () => {
    expect(clasificar(renglon({ productoId: 'p1' }), contexto())).toMatchObject(
      {
        concepto: 'COMPRAS_GENERALES',
        origen: 'PRODUCTO',
        certeza: 'CLARA',
      },
    );
  });

  it('el CIIU del proveedor deduce, y hay que aceptarlo', () => {
    expect(
      clasificar(
        renglon({ texto: 'Despacho a Cali' }),
        contexto({ ciiu: '4923' }),
      ),
    ).toMatchObject({
      concepto: 'TRANSPORTE_CARGA',
      origen: 'CIIU',
      certeza: 'DEDUCIDA',
    });
  });

  it('las palabras deducen: «canon de arrendamiento» → arrendamiento', () => {
    expect(
      clasificar(
        renglon({ texto: 'Canon de arrendamiento oficina' }),
        contexto(),
      ),
    ).toMatchObject({
      concepto: 'ARREND_INMUEBLES',
      certeza: 'DEDUCIDA',
    });
  });

  it('los casos engañosos: productos de aseo son compras, no servicio de aseo', () => {
    expect(
      clasificar(renglon({ texto: 'Productos de aseo' }), contexto()).concepto,
    ).toBe('COMPRAS_GENERALES');
    expect(
      clasificar(renglon({ texto: 'Café trillado 25 kg' }), contexto())
        .concepto,
    ).toBe('COMPRAS_GENERALES');
    expect(
      clasificar(renglon({ texto: 'Letrero luminoso fachada' }), contexto())
        .concepto,
    ).toBe('COMPRAS_GENERALES');
  });

  it('la cuenta de gasto también deduce: 5120 es arrendamiento', () => {
    expect(
      clasificar(
        renglon({ texto: 'Pago mes', cuentaCodigo: '512010' }),
        contexto(),
      ).concepto,
    ).toBe('ARREND_INMUEBLES');
  });

  it('si el CIIU y el renglón no coinciden, pregunta con las dos opciones', () => {
    const c = clasificar(
      renglon({ texto: 'Asesoría tributaria' }),
      contexto({ ciiu: '4923' }),
    );
    expect(c.certeza).toBe('PREGUNTA');
    expect(c.concepto).toBeNull();
    expect(c.opciones).toEqual(['TRANSPORTE_CARGA', 'HONORARIOS']);
  });

  it('PC23: la retención que sugiere el concepto deduce, y pesa más que las palabras', () => {
    const c = clasificar(
      renglon({
        texto: 'Canon de arrendamiento',
        sugerida: {
          concepto: 'SERVICIOS_GENERALES',
          nombreConcepto: 'Mantenimiento',
        },
      }),
      contexto(),
    );
    expect(c.concepto).toBe('SERVICIOS_GENERALES');
    expect(c.origen).toBe('CONCEPTO');
    // Es una sugerencia: se acepta o se cambia antes de registrar.
    expect(c.certeza).toBe('DEDUCIDA');
    expect(c.razon).toContain('«Mantenimiento»');
  });

  it('PC23: si el CIIU dice otra cosa que el concepto, pregunta con las dos', () => {
    const c = clasificar(
      renglon({
        sugerida: { concepto: 'HONORARIOS', nombreConcepto: 'Asesoría' },
      }),
      contexto({ ciiu: '4923' }),
    );
    expect(c.certeza).toBe('PREGUNTA');
    expect(c.opciones).toEqual(['TRANSPORTE_CARGA', 'HONORARIOS']);
  });

  it('sin ninguna pista, pregunta', () => {
    expect(clasificar(renglon({ texto: 'Varios' }), contexto()).certeza).toBe(
      'PREGUNTA',
    );
  });

  it('la llave del renglón ignora tildes, números y signos', () => {
    expect(llaveDe('Arriendo Local #3 — Sept.')).toBe('arriendo local sept');
  });
});
