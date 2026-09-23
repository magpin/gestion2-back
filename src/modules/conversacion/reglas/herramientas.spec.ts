import { readFileSync } from 'fs';
import { join } from 'path';

import { ATAJOS } from '../../reportes/reglas/rango';
import { validar } from '../../reportes/reglas/armador';
import {
  coincidencias,
  definicionDesde,
  DESDE_SIEMPRE,
  etiquetaDeConsulta,
  herramientasPara,
  ROLES_EXISTENCIAS,
  ROLES_REVISION,
  ROLES_SALDOS,
  origenDeHerramienta,
  resultadoParaModelo,
} from './herramientas';

const nombres = (roles: Parameters<typeof herramientasPara>[0]) =>
  herramientasPara(roles).map((h) => h.name);

describe('herramientasPara — el modelo ve lo que el rol puede ver', () => {
  it('VENTAS: ventas y cartera, saldos y existencias; nada de compras ni contabilidad', () => {
    expect(nombres(['VENTAS'])).toEqual([
      'consultar_ventas',
      'consultar_cartera',
      'buscar_valores',
      'consultar_saldos',
      'consultar_existencias',
    ]);
  });

  it('INVENTARIO: inventario y existencias; ni saldos ni ventas', () => {
    expect(nombres(['INVENTARIO'])).toEqual([
      'consultar_inventario',
      'buscar_valores',
      'consultar_existencias',
    ]);
  });

  it('CAJA: cartera, tesorería y saldos; no existencias', () => {
    expect(nombres(['CAJA'])).toEqual([
      'consultar_cartera',
      'consultar_tesoreria',
      'buscar_valores',
      'consultar_saldos',
    ]);
  });

  it('CONTADOR: los seis orígenes, buscar, saldos, existencias y la revisión', () => {
    expect(nombres(['CONTADOR'])).toHaveLength(10);
  });

  it('un rol sin orígenes no recibe ninguna herramienta, ni la de buscar', () => {
    expect(nombres(['ADMIN_TENANT'])).toEqual([]);
  });

  it('buscar_valores solo ofrece columnas de los orígenes del rol', () => {
    const buscar = herramientasPara(['COMPRAS']).find(
      (h) => h.name === 'buscar_valores',
    )!;
    const columna = (
      buscar.input_schema.properties as Record<string, { enum: string[] }>
    ).columna;
    expect(columna.enum).toEqual(['COMPRAS.proveedor']);
  });

  it('las columnas de cada herramienta son las del catálogo, sin SQL', () => {
    const cartera = herramientasPara(['VENTAS']).find(
      (h) => h.name === 'consultar_cartera',
    )!;
    expect(JSON.stringify(cartera)).not.toMatch(/SELECT|COALESCE|\bv\.saldo/);
    expect(cartera.description).toMatch(/Quién me debe/);
  });
});

describe('origenDeHerramienta', () => {
  it('traduce el nombre al origen, y rechaza lo que no es de consultar', () => {
    expect(origenDeHerramienta('consultar_cartera')).toBe('CARTERA');
    expect(origenDeHerramienta('consultar_nomina')).toBeUndefined();
    expect(origenDeHerramienta('buscar_valores')).toBeUndefined();
  });
});

describe('definicionDesde — lo que pidió el modelo, listo para el validador de siempre', () => {
  it('completa la forma del filtro desde el catálogo y las fechas desde siempre', () => {
    const def = definicionDesde(
      'CARTERA',
      {
        columnas: ['cliente', 'saldo'],
        filtros: [
          { columna: 'cliente', valores: ['PAPELERIA CENTRAL SAS'] },
          { columna: 'vencida', valor: true },
        ],
      },
      '2026-09-21',
    );
    expect(def.fechas).toEqual({ desde: DESDE_SIEMPRE, hasta: '2026-09-21' });
    const valida = validar(def, ATAJOS);
    expect(valida.filtros).toEqual([
      {
        columna: 'cliente',
        forma: 'LISTA',
        valores: ['PAPELERIA CENTRAL SAS'],
      },
      { columna: 'vencida', forma: 'SI_NO', valor: true },
    ]);
  });

  it('una columna inventada no pasa el validador', () => {
    const def = definicionDesde(
      'CARTERA',
      { columnas: ['sueldo'] },
      '2026-09-21',
    );
    expect(() => validar(def, ATAJOS)).toThrow(/no es una columna/);
  });

  it('una entrada que no es objeto no rompe: queda sin columnas y el validador la rechaza', () => {
    expect(() =>
      validar(definicionDesde('VENTAS', 'hola', '2026-09-21'), ATAJOS),
    ).toThrow(/al menos una columna/);
  });
});

describe('resultadoParaModelo', () => {
  it('manda etiquetas, hasta 50 filas, y avisa que el total es de todas', () => {
    const texto = resultadoParaModelo({
      columnas: [
        { clave: 'cliente', etiqueta: 'Cliente', tipo: 'TEXTO', suma: false },
        { clave: 'saldo', etiqueta: 'Saldo', tipo: 'DINERO', suma: true },
      ],
      filas: Array.from({ length: 60 }, (_, i) => [`c${i}`, '1000.00']),
      totalFilas: 60,
      truncado: false,
      limite: 5000,
      total: { nivel: 0, grupo: [], filas: 60, sumas: { 1: '60000.00' } },
      subtotales: [],
      rango: {
        desde: '2000-01-01',
        hasta: '2026-09-21',
        etiqueta: 'fechas fijas',
        relativo: false,
      },
    });
    const r = JSON.parse(texto) as {
      filas: unknown[];
      total: unknown;
      aviso: string;
    };
    expect(r.filas).toHaveLength(50);
    expect(r.total).toEqual({ Saldo: '60000.00' });
    expect(r.aviso).toMatch(/50 de 60/);
  });
});

describe('coincidencias', () => {
  it('busca sin tildes ni mayúsculas', () => {
    expect(
      coincidencias(
        ['PAPELERÍA CENTRAL S.A.S.', 'Ferretería El Tornillo'],
        'papeleria',
      ),
    ).toEqual(['PAPELERÍA CENTRAL S.A.S.']);
  });
});

describe('saldos y existencias — los roles son los de sus pantallas', () => {
  // Si alguien cambia quién ve bancos o productos en la pantalla, el asistente
  // tiene que cambiar igual. Esto lo recuerda leyendo los controladores.
  const controlador = (ruta: string) =>
    readFileSync(join(__dirname, '../../', ruta), 'utf8');
  const lista = (roles: readonly string[]) =>
    `@Roles(${roles.map((r) => `'${r}'`).join(', ')})`;

  it.each([
    ['tesoreria/controladores/cuentas-bancarias.controller.ts', ROLES_SALDOS],
    ['tesoreria/controladores/cajas.controller.ts', ROLES_SALDOS],
    ['inventario/controladores/productos.controller.ts', ROLES_EXISTENCIAS],
    ['revision/controladores/revision.controller.ts', ROLES_REVISION],
  ])('%s', (ruta, roles) => {
    expect(controlador(ruta)).toContain(lista(roles));
  });
});

describe('etiquetaDeConsulta', () => {
  it('con palabras de la aplicación', () => {
    expect(etiquetaDeConsulta('consultar_cartera')).toBe('Cartera');
    expect(etiquetaDeConsulta('consultar_saldos')).toBe(
      'Saldos de caja y bancos',
    );
    expect(etiquetaDeConsulta('consultar_existencias')).toBe('Existencias');
    expect(etiquetaDeConsulta('otra')).toBe('Consulta');
  });
});
