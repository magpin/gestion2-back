import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { VentasApi } from '../../ventas/ventas.api';
import { CargaVentasHistoricasService } from './carga-ventas-historicas.service';
import type { VentaHistoricaCruzada } from './cruce.service';
import type { Documento, DocumentoService } from './documento.service';

const ctx = {
  tenantId: 't',
  usuarioId: 'u',
  empresaId: 'e',
  roles: ['CONTADOR'],
} as CtxEmpresa;

function cruzada(
  numero: string,
  cambios: Partial<VentaHistoricaCruzada> = {},
): VentaHistoricaCruzada {
  return {
    factura: {
      numero,
      fecha: '2026-09-24',
      cliente: { nombre: 'FONDECAR', nit: '900048114' },
      formaPago: 'CREDITO',
      renglones: [
        {
          codigo: null,
          descripcion: 'TONER LASER GENERICO HP 83A',
          cantidad: 1,
          valorUnitario: 54621.85,
          ivaTarifa: 19,
        },
      ],
      impreso: { subtotal: 54621.85, iva: 10378.15, total: 65000 },
    },
    comprobaciones: [],
    cliente: { id: 'c-1', nombre: 'FONDECAR' },
    renglones: [
      {
        orden: 1,
        leido: {
          codigo: null,
          descripcion: 'TONER LASER GENERICO HP 83A',
          cantidad: 1,
          valorUnitario: 54621.85,
          ivaTarifa: 19,
        },
        resuelto: { id: 'p-1', codigo: 'TON83A', nombre: 'Tóner HP 83A' },
        motivo: 'Por el nombre.',
      },
    ],
    preguntas: [],
    completa: true,
    ...cambios,
  };
}

function armar(
  facturas: VentaHistoricaCruzada[],
  documento: Partial<Documento> = {},
) {
  const documentos = {
    porId: jest.fn().mockResolvedValue({
      id: 'doc-1',
      tipo: 'VENTA_HISTORICA',
      estado: 'LEIDO',
      extraido: { facturas, preguntas: [] },
      confirmacion: null,
      ...documento,
    }),
    guardarConfirmacion: jest.fn().mockResolvedValue(undefined),
  };
  const ventas = {
    cargarHistoricas: jest
      .fn()
      .mockResolvedValue({ simulada: false, registradas: 1, problemas: [] }),
    facturasExistentes: jest.fn().mockResolvedValue(new Map()),
  };
  const servicio = new CargaVentasHistoricasService(
    documentos as unknown as DocumentoService,
    ventas as unknown as VentasApi,
  );
  return { servicio, documentos, ventas };
}

describe('CargaVentasHistoricasService.cargar', () => {
  it('carga lo impreso —precio e IVA de entonces— con el código del producto del catálogo', async () => {
    const { servicio, ventas } = armar([cruzada('FEV 13896')]);
    await servicio.cargar(ctx, 'doc-1', [
      { numero: 'FEV 13896', pagada: true },
    ]);
    expect(ventas.cargarHistoricas).toHaveBeenCalledWith(ctx, [
      {
        numero: 'FEV 13896',
        fecha: '2026-09-24',
        clienteNit: '900048114',
        lineas: [
          {
            codigoProducto: 'TON83A',
            cantidad: 1,
            precioUnitario: 54621.85,
            ivaTarifa: 19,
          },
        ],
        pagada: true,
      },
    ]);
  });

  it('deja dicho qué se cargó, sumado a lo que ya se había cargado de la misma lectura', async () => {
    const { servicio, documentos } = armar(
      [cruzada('FEV 13896'), cruzada('FEV 13897')],
      { confirmacion: { aplicados: ['FEV 13896'], sinAplicar: [] } },
    );
    await servicio.cargar(ctx, 'doc-1', [
      { numero: 'FEV 13897', pagada: false },
    ]);
    expect(documentos.guardarConfirmacion).toHaveBeenCalledWith(ctx, 'doc-1', {
      aplicados: ['FEV 13896', 'FEV 13897'],
      sinAplicar: [],
    });
  });

  it('si la carga la rechaza, contesta por qué y no marca nada como cargado', async () => {
    const { servicio, ventas, documentos } = armar([cruzada('FEV 13896')]);
    const problemas = [
      {
        numero: 'FEV 13896',
        problemas: ['Ya hay una factura FEV-13896 en el sistema.'],
      },
    ];
    ventas.cargarHistoricas.mockResolvedValue({
      simulada: false,
      registradas: 0,
      problemas,
    });
    const r = await servicio.cargar(ctx, 'doc-1', [
      { numero: 'FEV 13896', pagada: false },
    ]);
    expect(r.problemas).toEqual(problemas);
    expect(documentos.guardarConfirmacion).not.toHaveBeenCalled();
  });

  it('no carga una factura con preguntas ni una que no cuadra', async () => {
    const { servicio, ventas } = armar([
      cruzada('FEV 13895', { completa: false }),
    ]);
    await expect(
      servicio.cargar(ctx, 'doc-1', [{ numero: 'FEV 13895', pagada: false }]),
    ).rejects.toThrow(BadRequestException);
    expect(ventas.cargarHistoricas).not.toHaveBeenCalled();
  });

  it('no carga un número que no está en la lectura', async () => {
    const { servicio } = armar([cruzada('FEV 13896')]);
    await expect(
      servicio.cargar(ctx, 'doc-1', [{ numero: 'FEV 99999', pagada: false }]),
    ).rejects.toThrow('no está en esta lectura');
  });

  it('no carga de una lectura descartada', async () => {
    const { servicio } = armar([cruzada('FEV 13896')], {
      estado: 'DESCARTADO',
    });
    await expect(
      servicio.cargar(ctx, 'doc-1', [{ numero: 'FEV 13896', pagada: false }]),
    ).rejects.toThrow('descartada');
  });
});

describe('CargaVentasHistoricasService.listar', () => {
  it('dice cuáles ya están en el sistema, por el número tal como se leyó', async () => {
    const { servicio, ventas } = armar([]);
    const lectura = {
      id: 'doc-1',
      tipo: 'VENTA_HISTORICA',
      extraido: { facturas: [cruzada('FEV 13896'), cruzada('FEV 13897')] },
    } as unknown as Documento;
    (servicio as unknown as { documentos: DocumentoService }).documentos = {
      listarVentasHistoricas: jest.fn().mockResolvedValue([lectura]),
    } as unknown as DocumentoService;
    ventas.facturasExistentes.mockResolvedValue(
      new Map([['FEV 13896', { id: 'v-1', numero: 'FEV-13896' }]]),
    );

    const [l] = await servicio.listar(ctx);
    expect(ventas.facturasExistentes).toHaveBeenCalledWith(ctx, [
      'FEV 13896',
      'FEV 13897',
    ]);
    expect(l.enSistema).toEqual({
      'FEV 13896': { id: 'v-1', numero: 'FEV-13896' },
    });
  });
});
