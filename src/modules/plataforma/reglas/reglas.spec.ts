import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALFABETO, contrasenaParaDictar } from './contrasena';
import {
  cercaDelCupo,
  cupoCerca,
  excesoFrente,
  listarCuentas,
  sinActividad,
  type Cuenta,
} from './cuentas';
import {
  fraccionDelMes,
  gastoPorMes,
  iaDisparada,
  mesAnterior,
  mesesMedidos,
  tresMesesAnteriores,
} from './inicio';

const AHORA = new Date('2026-09-22T19:00:00Z');

const cuenta = (c: Partial<Cuenta>): Cuenta => ({
  id: c.id ?? 'x',
  nombre: c.nombre ?? 'Cuenta',
  slug: c.slug ?? 'cuenta',
  plan: c.plan ?? 'BASICO',
  estado: c.estado ?? 'ACTIVO',
  maxEmpresas: c.maxEmpresas ?? 1,
  maxUsuarios: c.maxUsuarios ?? 3,
  empresas: c.empresas ?? 1,
  usuarios: c.usuarios ?? 1,
  creadoEn: c.creadoEn ?? '2026-01-01T00:00:00Z',
  ultimoAcceso:
    c.ultimoAcceso === undefined ? '2026-09-22T12:00:00Z' : c.ultimoAcceso,
  estadoDesde: c.estadoDesde ?? '2026-01-01T00:00:00Z',
  iaMesUsd: c.iaMesUsd ?? 0,
});

describe('cupos', () => {
  it('avisa desde el 90 %, pero un cupo de 1 es la forma del plan', () => {
    expect(cupoCerca(23, 25)).toBe(true);
    expect(cupoCerca(22, 25)).toBe(false);
    expect(cupoCerca(1, 1)).toBe(false);
    expect(cupoCerca(3, 3)).toBe(true);
  });

  it('una cuenta cancelada no está cerca de nada', () => {
    expect(cercaDelCupo(cuenta({ usuarios: 3, estado: 'CANCELADO' }))).toBe(
      false,
    );
    expect(cercaDelCupo(cuenta({ usuarios: 3 }))).toBe(true);
  });

  it('el exceso frente a otro plan dice qué y cuánto', () => {
    expect(
      excesoFrente(
        { empresas: 3, usuarios: 23 },
        { maxEmpresas: 3, maxUsuarios: 8 },
      ),
    ).toEqual([{ recurso: 'USUARIOS', usados: 23, permitidos: 8 }]);
    expect(
      excesoFrente(
        { empresas: 1, usuarios: 1 },
        { maxEmpresas: 1, maxUsuarios: 3 },
      ),
    ).toEqual([]);
  });
});

describe('sin actividad', () => {
  it('30 días sin entrar; la que nunca entró cuenta desde su alta', () => {
    expect(
      sinActividad(cuenta({ ultimoAcceso: '2026-08-19T12:00:00Z' }), AHORA),
    ).toBe(true);
    expect(
      sinActividad(cuenta({ ultimoAcceso: '2026-09-01T12:00:00Z' }), AHORA),
    ).toBe(false);
    expect(
      sinActividad(
        cuenta({ ultimoAcceso: null, creadoEn: '2026-09-20T00:00:00Z' }),
        AHORA,
      ),
    ).toBe(false);
    expect(
      sinActividad(
        cuenta({ ultimoAcceso: null, creadoEn: '2026-07-01T00:00:00Z' }),
        AHORA,
      ),
    ).toBe(true);
  });
});

describe('listarCuentas', () => {
  const cuentas = [
    cuenta({ id: 'a', nombre: 'Andina', estado: 'MOROSO', iaMesUsd: 5 }),
    cuenta({ id: 'b', nombre: 'Bolívar', iaMesUsd: 30 }),
    cuenta({ id: 'c', nombre: 'Café', estado: 'SUSPENDIDO', iaMesUsd: 1 }),
  ];

  it('cuenta cada filtro aunque se muestre otro', () => {
    const p = listarCuentas(cuentas, {
      filtro: 'MOROSAS',
      orden: 'nombre',
      dir: 'asc',
      pagina: 1,
      ahora: AHORA,
    });
    expect(p.filas.map((c) => c.id)).toEqual(['a']);
    expect(p.conteos).toMatchObject({
      TODAS: 3,
      ACTIVAS: 1,
      MOROSAS: 1,
      SUSPENDIDAS: 1,
    });
  });

  it('ordena por IA de mayor a menor y la página se queda en su rango', () => {
    const p = listarCuentas(cuentas, {
      filtro: 'TODAS',
      orden: 'ia',
      dir: 'desc',
      pagina: 9,
      ahora: AHORA,
    });
    expect(p.filas.map((c) => c.id)).toEqual(['b', 'a', 'c']);
    expect(p.pagina).toBe(1);
  });
});

describe('meses', () => {
  it('el mes pasado y los tres anteriores, completos', () => {
    expect(mesAnterior('2026-03-15')).toEqual({
      desde: '2026-02-01',
      hasta: '2026-02-28',
    });
    expect(tresMesesAnteriores('2026-01-10').map((m) => m.desde)).toEqual([
      '2025-10-01',
      '2025-11-01',
      '2025-12-01',
    ]);
    expect(fraccionDelMes('2026-09-15')).toBeCloseTo(0.5);
  });

  it('solo cuentan los meses que empiezan después de la primera medición', () => {
    const meses = tresMesesAnteriores('2026-12-05');
    // Septiembre empezó antes de medir; octubre y noviembre, no.
    expect(mesesMedidos(meses, '2026-09-21')).toBe(2);
    expect(mesesMedidos(meses, null)).toBe(0);
  });

  it('suma el gasto por mes', () => {
    expect(
      gastoPorMes([
        { dia: '2026-08-31', chatUsd: 1, lecturaUsd: 0.5 },
        { dia: '2026-09-01', chatUsd: 2, lecturaUsd: 0 },
        { dia: '2026-09-02', chatUsd: 1, lecturaUsd: 1 },
      ]),
    ).toEqual([
      { mes: '2026-08', usd: 1.5 },
      { mes: '2026-09', usd: 4 },
    ]);
  });
});

describe('IA disparada', () => {
  const g = (empresaId: string, costoUsd: number) => ({
    empresaId,
    empresa: empresaId,
    cuentaId: 'c',
    cuenta: 'c',
    costoUsd,
  });

  it('compara contra el promedio proporcional a lo que va del mes', () => {
    // Promedio de US$ 10 al mes; a mitad de mes se esperan 5: 20 es 4 veces.
    const r = iaDisparada(
      [g('a', 20), g('b', 6)],
      new Map([
        ['a', 30],
        ['b', 30],
      ]),
      3,
      0.5,
    );
    expect(r.map((x) => x.empresaId)).toEqual(['a']);
    expect(r[0].veces).toBeCloseTo(4);
  });

  it('sin historia, o con un promedio de centavos, no avisa', () => {
    expect(iaDisparada([g('a', 20)], new Map([['a', 30]]), 0, 0.5)).toEqual([]);
    expect(iaDisparada([g('a', 2)], new Map([['a', 0.3]]), 3, 0.5)).toEqual([]);
  });
});

describe('contraseña para dictar', () => {
  it('tres grupos de cuatro, sin caracteres que se confunden', () => {
    const vistas = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const p = contrasenaParaDictar();
      expect(p).toMatch(/^[^\W_]{4}-[^\W_]{4}-[^\W_]{4}$/);
      for (const ch of p.replace(/-/g, '')) expect(ALFABETO).toContain(ch);
      expect(p).not.toMatch(/[0O1lI]/);
      vistas.add(p);
    }
    expect(vistas.size).toBe(200);
  });
});

describe('la consola no lee contabilidad ni texto de la IA', () => {
  const fuente = (archivo: string) =>
    readFileSync(join(__dirname, '..', 'servicios', archivo), 'utf8');

  /**
   * Las únicas tablas que la consola lee directo. La IA va por `ConsumoIaApi`
   * y el avance de la configuración por `NucleoApi`, que tienen sus propias
   * pruebas. Una tabla nueva acá tiene que ser una decisión, no un descuido.
   */
  const PERMITIDAS = new Set([
    'tenant',
    'empresa',
    'empresa_sector',
    'empresa_sede',
    'empresa_configuracion_contable',
    'usuario',
    'usuario_rol_tenant',
    'usuario_empresa_rol',
    'usuario_acceso_dia',
    'plataforma_admin',
    'plataforma_bitacora',
    'plan_catalogo',
    'suscripcion_cargo',
    'suscripcion_pago',
    'ia_pausa',
    'anuncio',
    'login_fallido',
    // Sistema: con qué rol está conectada la API.
    'pg_roles',
    // Solo fechas y conteos por estado, nunca el texto.
    'conversacion_turno',
    'documento_leido',
  ]);

  const SERVICIOS = [
    'cuentas.service.ts',
    'panel.service.ts',
    'cobros.service.ts',
    'sistema.service.ts',
  ];

  it.each(SERVICIOS)('%s solo lee tablas de la plataforma', (archivo) => {
    const tablas = [
      ...fuente(archivo).matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/g),
    ].map((m) => m[1]);
    expect(tablas.length).toBeGreaterThan(0);
    expect(tablas.filter((t) => !PERMITIDAS.has(t))).toEqual([]);
  });

  it.each(SERVICIOS)(
    '%s de conversaciones y documentos nunca lee el texto',
    (archivo) => {
      // `texto` como columna (`t.texto`), no una variable que se llame así.
      expect(fuente(archivo)).not.toMatch(
        /\.texto\b|\bextraido\b|SELECT[^`]*\berror\b/,
      );
    },
  );

  it('la bitácora nunca guarda una contraseña', () => {
    const sql = SERVICIOS.map(fuente).join('\n');
    for (const m of sql.matchAll(/registrar\(([\s\S]*?)\);/g)) {
      expect(m[1]).not.toMatch(/password|hash/);
    }
  });
});
