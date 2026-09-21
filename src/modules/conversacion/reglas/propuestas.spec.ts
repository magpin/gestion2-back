import { readFileSync } from 'fs';
import { join } from 'path';

import {
  accionDeHerramienta,
  cuerpoDesde,
  herramientasDeAccion,
  puedeHacer,
  ROLES_ACCION,
} from './propuestas';

const nombres = (roles: Parameters<typeof herramientasDeAccion>[0]) =>
  herramientasDeAccion(roles).map((h) => h.name);

describe('herramientasDeAccion — solo lo que el rol puede confirmar', () => {
  it('CAJA y DIRECTOR proponen cobros y pagos', () => {
    expect(nombres(['CAJA'])).toEqual(['proponer_cobro', 'proponer_pago']);
    expect(nombres(['DIRECTOR'])).toEqual(['proponer_cobro', 'proponer_pago']);
  });

  it('VENTAS, CONTADOR, COMPRAS y CONSULTA no proponen nada: no pueden cobrar ni pagar', () => {
    for (const rol of ['VENTAS', 'CONTADOR', 'COMPRAS', 'CONSULTA'] as const) {
      expect(nombres([rol])).toEqual([]);
    }
  });

  it('puedeHacer mira los roles de la acción', () => {
    expect(puedeHacer(['VENTAS', 'CAJA'], 'COBRO')).toBe(true);
    expect(puedeHacer(['VENTAS'], 'COBRO')).toBe(false);
  });
});

describe('los roles son los de los endpoints que hacen la acción', () => {
  // Si alguien cambia quién cobra o quién paga en la pantalla, el asistente
  // tiene que cambiar igual. Esto lo recuerda leyendo los controladores.
  const controlador = (ruta: string) =>
    readFileSync(join(__dirname, '../../', ruta), 'utf8');
  const antesDe = (texto: string, ruta: string) => {
    const i = texto.indexOf(ruta);
    return texto.slice(Math.max(0, i - 80), i);
  };
  const lista = (roles: readonly string[]) =>
    `@Roles(${roles.map((r) => `'${r}'`).join(', ')})`;

  it('cobrar: facturas/:id/cobrar', () => {
    const texto = controlador('ventas/controladores/facturas.controller.ts');
    expect(antesDe(texto, "@Post(':id/cobrar')")).toContain(
      lista(ROLES_ACCION.COBRO),
    );
  });

  it('pagar: compras/:id/pagar', () => {
    const texto = controlador('compras/controladores/compras.controller.ts');
    expect(antesDe(texto, "@Post(':id/pagar')")).toContain(
      lista(ROLES_ACCION.PAGO),
    );
  });
});

describe('accionDeHerramienta', () => {
  it('traduce el nombre; lo demás no es una acción', () => {
    expect(accionDeHerramienta('proponer_cobro')).toBe('COBRO');
    expect(accionDeHerramienta('proponer_pago')).toBe('PAGO');
    expect(accionDeHerramienta('consultar_cartera')).toBeUndefined();
  });
});

describe('cuerpoDesde — lo que pidió el modelo, como el cuerpo del endpoint', () => {
  it('traduce el id al campo de su medio, y sin fecha es hoy', () => {
    expect(
      cuerpoDesde(
        {
          factura: 'SETT-5',
          pagos: [
            { medio: 'CAJA', id: 'caja-1', valor: 1000 },
            { medio: 'BANCO', id: 'banco-1', valor: 500.5 },
          ],
        },
        '2026-09-21',
      ),
    ).toEqual({
      fecha: '2026-09-21',
      pagos: [
        { medio: 'CAJA', cajaId: 'caja-1', valor: 1000 },
        { medio: 'BANCO', cuentaBancariaId: 'banco-1', valor: 500.5 },
      ],
    });
  });

  it('una entrada rota queda sin pagos, y el DTO la rechaza después', () => {
    expect(cuerpoDesde('hola', '2026-09-21')).toEqual({
      fecha: '2026-09-21',
      pagos: [],
    });
  });
});
