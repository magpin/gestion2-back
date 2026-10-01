import {
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';

import type { CtxEmpresa, RolCodigo } from '../../../common/ctx';
import type { InventarioApi } from '../../inventario/inventario.api';
import { DefinicionInvalida, validar } from '../../reportes/reglas/armador';
import { ATAJOS } from '../../reportes/reglas/rango';
import type {
  ArmadorService,
  Resultado,
} from '../../reportes/servicios/armador.service';
import type { TesoreriaApi } from '../../tesoreria/tesoreria.api';
import type { RevisionApi } from '../../revision/revision.api';
import { ConsultasService } from './consultas.service';
import type { PropuestasService } from './propuestas.service';

const ctx = (roles: RolCodigo[]): CtxEmpresa => ({
  tenantId: 't-1',
  usuarioId: 'u-1',
  empresaId: 'e-1',
  roles,
});

const RESULTADO: Resultado = {
  columnas: [
    { clave: 'cliente', etiqueta: 'Cliente', tipo: 'TEXTO', suma: false },
    { clave: 'saldo', etiqueta: 'Saldo', tipo: 'DINERO', suma: true },
  ],
  filas: [['ALMACENES CORONA S.A.S', '27316050.00']],
  totalFilas: 3,
  truncado: false,
  limite: 5000,
  total: { nivel: 0, grupo: [], filas: 3, sumas: { 1: '27316050.00' } },
  subtotales: [],
  rango: {
    desde: '2000-01-01',
    hasta: '2026-09-21',
    etiqueta: 'fechas fijas',
    relativo: false,
  },
};

/**
 * El armador de verdad para validar, y de mentira para correr: sin base. La
 * validación se envuelve como en `ArmadorService.definicion`: una definición
 * mal armada es un 400 con el mensaje de la regla.
 */
function preparar() {
  const correr = jest.fn(() => Promise.resolve(RESULTADO));
  const valores = jest.fn(() =>
    Promise.resolve(['ALMACENES CORONA S.A.S', 'FERRETERÍA EL TORNILLO']),
  );
  const saldos = jest.fn(() =>
    Promise.resolve([
      {
        medio: 'BANCO' as const,
        nombre: 'Bancolombia corriente 123',
        saldo: '5000000.00',
        ultimoMovimiento: '2026-09-21',
      },
    ]),
  );
  const existencias = jest.fn(() => Promise.resolve([]));
  const revisar = jest.fn(() =>
    Promise.resolve([
      {
        tipo: 'TERCERO_DUPLICADO' as const,
        grupo: 'DUPLICADO' as const,
        titulo: '«X» está cargado dos veces',
        detalle: 'Es el mismo documento.',
        referencias: [
          { tipo: 'TERCERO' as const, id: 't-secreto', etiqueta: 'CC 1' },
        ],
      },
    ]),
  );
  const preparar = jest.fn(() =>
    Promise.resolve({
      texto: '{"propuesta":"lista para confirmar"}',
      nueva: { accion: 'COBRO', documentoId: 'f-1' },
    }),
  );
  const armador = {
    definicion: (e: unknown) => {
      try {
        return validar(e, ATAJOS);
      } catch (error) {
        if (error instanceof DefinicionInvalida)
          throw new BadRequestException(error.message);
        throw error;
      }
    },
    correr,
    valores,
  } as unknown as ArmadorService;
  const estadoVacio = {
    renglones: [
      {
        clave: 'ingresos_op',
        etiqueta: 'Ingresos operacionales',
        valor: 1000,
        tipo: 'grupo',
      },
      { clave: 'costo', etiqueta: 'Costo de ventas', valor: 0, tipo: 'grupo' },
      {
        clave: 'bruta',
        etiqueta: 'Utilidad bruta',
        valor: 1000,
        tipo: 'subtotal',
      },
    ],
    ingresosOperacionales: 1000,
    utilidadBruta: 1000,
    utilidadOperacional: 1000,
    utilidadAntesDeImpuestos: 1000,
    utilidadNeta: 1000,
  };
  const centrosParaConsulta = jest.fn(() =>
    Promise.resolve({
      maneja: true,
      centros: [
        {
          id: 'c-secreto',
          codigo: 'NORTE',
          nombre: 'Sede Norte',
          activo: true,
          padreId: null,
          sedeNombre: 'Norte',
          tipo: 'PRODUCTIVO',
          esPorDefecto: true,
          agrupa: false,
        },
      ],
      repartos: [
        {
          nombre: 'Arriendo',
          base: null,
          activo: true,
          partes: [{ centroNombre: 'NORTE · Sede Norte', porcentaje: 100 }],
        },
      ],
    }),
  );
  const nucleo = { centrosParaConsulta } as never;
  const resultados = jest.fn(() =>
    Promise.resolve({
      periodo: { mes: '2026-10', estado: 'ABIERTO' },
      actual: estadoVacio,
    }),
  );
  const resultadosPorCentro = jest.fn(() =>
    Promise.resolve({
      periodo: { mes: '2026-10', estado: 'ABIERTO' },
      agrupar: 'CENTRO',
      columnas: [
        {
          clave: 'c-secreto',
          nombre: 'NORTE · Sede Norte',
          estado: estadoVacio,
        },
      ],
      total: estadoVacio,
    }),
  );
  const estados = { resultados, resultadosPorCentro } as never;
  const servicio = new ConsultasService(
    armador,
    { saldos } as unknown as TesoreriaApi,
    { existencias } as unknown as InventarioApi,
    { preparar } as unknown as PropuestasService,
    { revisar } as unknown as RevisionApi,
    { retencionesParaAsistente: jest.fn(() => Promise.resolve([])) } as never,
    nucleo,
    estados,
  );
  return {
    servicio,
    correr,
    valores,
    saldos,
    existencias,
    preparar,
    revisar,
    resultados,
    resultadosPorCentro,
  };
}

describe('ConsultasService — con los permisos de quien pregunta', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('corre la cartera con el ctx de quien pregunta y guarda cuántas filas trajo', async () => {
    const { servicio, correr } = preparar();
    const quien = ctx(['VENTAS']);
    const { herramientas, hechas } = servicio.paraTurno(quien);
    const texto = await herramientas.ejecutar('consultar_cartera', {
      columnas: ['cliente', 'saldo'],
      filtros: [{ columna: 'cliente', valores: ['ALMACENES CORONA S.A.S'] }],
    });
    expect(correr).toHaveBeenCalledWith(
      quien,
      expect.objectContaining({ origen: 'CARTERA' }),
      expect.objectContaining({ desde: '2000-01-01' }),
    );
    expect(JSON.parse(texto)).toMatchObject({
      total: { Saldo: '27316050.00' },
    });
    expect(hechas).toEqual([
      expect.objectContaining({
        herramienta: 'consultar_cartera',
        filas: 3,
        error: null,
      }),
    ]);
  });

  it('una consulta que no se le ofreció al rol se rechaza aunque el modelo la pida', async () => {
    const { servicio, correr } = preparar();
    const { herramientas, hechas } = servicio.paraTurno(ctx(['VENTAS']));
    const texto = await herramientas.ejecutar('consultar_compras', {
      columnas: ['proveedor'],
    });
    expect(texto).toMatch(/no está entre las que permite el rol/);
    expect(correr).not.toHaveBeenCalled();
    expect(hechas[0].herramienta).toBe('consultar_compras');
    expect(hechas[0].error).toMatch(/rol/);
  });

  it('INVENTARIO no ve saldos de bancos', async () => {
    const { servicio, saldos } = preparar();
    const { herramientas } = servicio.paraTurno(ctx(['INVENTARIO']));
    expect(await herramientas.ejecutar('consultar_saldos', {})).toMatch(/rol/);
    expect(saldos).not.toHaveBeenCalled();
  });

  it('CAJA ve los saldos', async () => {
    const { servicio, saldos } = preparar();
    const { herramientas } = servicio.paraTurno(ctx(['CAJA']));
    const texto = await herramientas.ejecutar('consultar_saldos', {});
    expect(saldos).toHaveBeenCalled();
    expect(texto).toMatch(/Bancolombia/);
  });

  it('una columna inventada vuelve como texto para que el modelo corrija, sin tocar la base', async () => {
    const { servicio, correr } = preparar();
    const { herramientas, hechas } = servicio.paraTurno(ctx(['CONTADOR']));
    const texto = await herramientas.ejecutar('consultar_cartera', {
      columnas: ['sueldo'],
    });
    expect(texto).toMatch(/^No se pudo: .*no es una columna/);
    expect(correr).not.toHaveBeenCalled();
    expect(hechas[0].error).toMatch(/no es una columna/);
  });

  it('si el armador rechaza por rol, el motivo llega al modelo', async () => {
    const { servicio, correr } = preparar();
    correr.mockRejectedValueOnce(
      new ForbiddenException('Tu rol no incluye la cartera.'),
    );
    const { herramientas } = servicio.paraTurno(ctx(['CONTADOR']));
    expect(
      await herramientas.ejecutar('consultar_cartera', { columnas: ['saldo'] }),
    ).toBe('No se pudo: Tu rol no incluye la cartera.');
  });

  it('una falla de la base no tumba el turno: se dice que falló, sin el error crudo', async () => {
    const { servicio, correr } = preparar();
    correr.mockRejectedValueOnce(new Error('connection terminated'));
    const { herramientas } = servicio.paraTurno(ctx(['CONTADOR']));
    const texto = await herramientas.ejecutar('consultar_cartera', {
      columnas: ['saldo'],
    });
    expect(texto).toBe(
      'No se pudo: La consulta falló. Intente de nuevo en un momento.',
    );
    expect(texto).not.toMatch(/connection/);
  });

  it('buscar_valores devuelve los nombres exactos que coinciden, sin tildes', async () => {
    const { servicio, valores } = preparar();
    const { herramientas } = servicio.paraTurno(ctx(['VENTAS']));
    const texto = await herramientas.ejecutar('buscar_valores', {
      columna: 'CARTERA.cliente',
      contiene: 'ferreteria',
    });
    expect(valores).toHaveBeenCalledWith(
      expect.anything(),
      'CARTERA',
      'cliente',
    );
    expect(JSON.parse(texto)).toEqual(['FERRETERÍA EL TORNILLO']);
  });
});

describe('ConsultasService — la revisión de los libros', () => {
  it('la corre quien ve los asientos, y al modelo no le llegan los ids', async () => {
    const { servicio, revisar } = preparar();
    const quien = ctx(['CONTADOR']);
    const { herramientas, hechas } = servicio.paraTurno(quien);

    const texto = await herramientas.ejecutar('revisar_errores', {});

    expect(revisar).toHaveBeenCalledWith(quien);
    expect(texto).toContain('está cargado dos veces');
    expect(texto).not.toContain('t-secreto');
    expect(hechas[0]).toMatchObject({
      herramienta: 'revisar_errores',
      filas: 1,
    });
  });

  it('quien no ve los asientos no la tiene', async () => {
    const { servicio, revisar } = preparar();
    const { herramientas } = servicio.paraTurno(ctx(['VENTAS']));

    expect(herramientas.definiciones.map((d) => d.name)).not.toContain(
      'revisar_errores',
    );
    expect(await herramientas.ejecutar('revisar_errores', {})).toMatch(
      /^No se pudo/,
    );
    expect(revisar).not.toHaveBeenCalled();
  });
});

describe('ConsultasService — centros de costo', () => {
  it('la lista la ve cualquiera, sin ids', async () => {
    const { servicio } = preparar();
    const { herramientas } = servicio.paraTurno(ctx(['VENTAS']));

    const texto = await herramientas.ejecutar('consultar_centros_costo', {});

    expect(texto).toContain('"encendidos":true');
    expect(texto).toContain('NORTE');
    expect(texto).toContain('Arriendo');
    expect(texto).not.toContain('c-secreto');
  });

  it('los resultados por centro: solo quien ve los estados', async () => {
    const { servicio, resultadosPorCentro } = preparar();
    const ventas = servicio.paraTurno(ctx(['VENTAS'])).herramientas;
    expect(ventas.definiciones.map((d) => d.name)).not.toContain(
      'consultar_resultados_por_centro',
    );

    const contador = servicio.paraTurno(ctx(['CONTADOR'])).herramientas;
    const texto = await contador.ejecutar('consultar_resultados_por_centro', {
      mes: '2026-10',
      agrupar: 'TIPO',
    });
    expect(resultadosPorCentro).toHaveBeenCalledWith(
      expect.anything(),
      '2026-10',
      'TIPO',
    );
    expect(texto).toContain('NORTE · Sede Norte');
    expect(texto).not.toContain('c-secreto');
  });

  it('un centro por su código o su nombre, sin importar mayúsculas', async () => {
    const { servicio, resultados } = preparar();
    const { herramientas } = servicio.paraTurno(ctx(['DIRECTOR']));

    await herramientas.ejecutar('consultar_resultados_por_centro', {
      mes: '2026-10',
      centro: 'sede norte',
    });
    expect(resultados).toHaveBeenCalledWith(
      expect.anything(),
      '2026-10',
      undefined,
      undefined,
      'c-secreto',
    );

    const otro = await herramientas.ejecutar(
      'consultar_resultados_por_centro',
      {
        centro: 'SUR',
      },
    );
    expect(otro).toContain('No hay un centro de costo «SUR»');
  });
});
