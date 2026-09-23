import { BadRequestException } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import type { TxService } from '../../../common/db/tx.service';
import type { ComprasApi } from '../../compras/compras.api';
import {
  comprobar,
  type FacturaCompraLeida,
} from '../reglas/factura-compra.reglas';
import { ConfirmacionFacturaService } from './confirmacion-factura.service';
import type { FacturaCruzada } from './cruce.service';
import type { DocumentoService } from './documento.service';
import type { MemoriaService } from './memoria.service';

const ctx = { empresaId: 'e1', usuarioId: 'u1' } as unknown as CtxEmpresa;

const factura: FacturaCompraLeida = {
  proveedor: { nombre: 'JALTECH', nit: '900378652' },
  numero: '215183',
  prefijo: null,
  fecha: '2026-07-28',
  renglones: [
    {
      codigo: 'P001',
      descripcion: 'TECLADO INALAMBRICO',
      clase: 'PRODUCTO',
      cuentaPuc: null,
      cantidad: 2,
      valorUnitario: 50_000,
      ivaTarifa: 19,
      total: 100_000,
    },
  ],
  impreso: { subtotal: 100_000, iva: 19_000, retencion: 0, total: 119_000 },
};

const cruzada = (cambios: Partial<FacturaCruzada> = {}): FacturaCruzada => ({
  factura,
  comprobaciones: comprobar(factura),
  proveedor: { id: 'prov-1', nombre: 'JALTECH' },
  renglones: [
    {
      orden: 1,
      leido: factura.renglones[0],
      resuelto: {
        clase: 'PRODUCTO',
        id: 'prod-1',
        codigo: 'P001',
        nombre: 'TECLADO',
      },
      motivo: 'Por el código P001.',
    },
  ],
  lineas: [],
  juntadas: 0,
  preguntas: [],
  completa: true,
  ...cambios,
});

const armar = (extraido: unknown, tipo = 'FACTURA_COMPRA') => {
  const registrar = jest.fn().mockResolvedValue({ id: 'compra-1' });
  const aprender = jest.fn().mockResolvedValue(undefined);
  const documentos = {
    porId: jest
      .fn()
      .mockResolvedValue({ id: 'doc-1', tipo, extraido, datos: [] }),
  } as unknown as DocumentoService;
  const compras = { registrar } as unknown as ComprasApi;
  const memoria = { aprender } as unknown as MemoriaService;
  // La transacción de mentira: corre la función con un `tx` reconocible, para
  // poder comprobar que la compra y lo aprendido van en la misma.
  const tx = {
    enContexto: jest.fn((_ctx: unknown, fn: (t: unknown) => unknown) => fn(TX)),
  } as unknown as TxService;
  return {
    servicio: new ConfirmacionFacturaService(documentos, compras, memoria, tx),
    registrar,
    aprender,
  };
};

const TX = { soy: 'la transacción' };

describe('ConfirmacionFacturaService — registrar lo confirmado', () => {
  it('registra por la misma puerta que el endpoint manual', async () => {
    const { servicio, registrar } = armar(cruzada());

    await servicio.confirmar(ctx, 'doc-1');

    expect(registrar).toHaveBeenCalledWith(
      ctx,
      {
        terceroId: 'prov-1',
        fecha: '2026-07-28',
        numeroFacturaProveedor: '215183',
        lineas: [{ productoId: 'prod-1', cantidad: 2, costoUnitario: 50_000 }],
        formaPago: 'CREDITO',
      },
      // De qué documento salió, en un argumento aparte del DTO: si viajara en
      // el cuerpo de la petición, cualquiera podría registrar una compra a
      // mano y decir que la leyó María.
      { documentoLeidoId: 'doc-1' },
      TX,
    );
  });

  it('el prefijo va pegado al número, como lo imprime el proveedor', async () => {
    const { servicio, registrar } = armar(
      cruzada({ factura: { ...factura, prefijo: 'FE' } }),
    );

    await servicio.confirmar(ctx, 'doc-1');

    expect(registrar.mock.calls[0][1].numeroFacturaProveedor).toBe('FE-215183');
  });

  it('contado solo si lo piden: los medios de pago no salen de la factura', async () => {
    const { servicio, registrar } = armar(cruzada());

    await servicio.confirmar(ctx, 'doc-1', { formaPago: 'CONTADO' });

    expect(registrar.mock.calls[0][1].formaPago).toBe('CONTADO');
  });
});

describe('ConfirmacionFacturaService — lo que responde la persona', () => {
  it('el número que faltaba', async () => {
    const sinNumero = cruzada({
      factura: { ...factura, numero: null },
      preguntas: [{ sobre: 'numero', texto: '¿Con qué número?' }],
      completa: false,
    });
    const { servicio, registrar } = armar(sinNumero);

    await servicio.confirmar(ctx, 'doc-1', { numero: 'CC-0912' });

    expect(registrar.mock.calls[0][1].numeroFacturaProveedor).toBe('CC-0912');
  });

  it('el proveedor que no se encontró', async () => {
    const { servicio, registrar } = armar(cruzada({ proveedor: null }));

    await servicio.confirmar(ctx, 'doc-1', {
      terceroId: '11111111-1111-1111-1111-111111111111',
    });

    expect(registrar.mock.calls[0][1].terceroId).toBe(
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('la cuenta de un renglón de gasto que quedó sin resolver', async () => {
    const gasto = cruzada({
      renglones: [
        {
          orden: 1,
          leido: { ...factura.renglones[0], clase: 'GASTO', ivaTarifa: 0 },
          resuelto: null,
          motivo: '¿Cuál uso?',
        },
      ],
    });
    const { servicio, registrar } = armar(gasto);

    await servicio.confirmar(ctx, 'doc-1', {
      renglones: [{ orden: 1, cuentaId: 'cta-1' }],
    });

    expect(registrar.mock.calls[0][1].lineas[0]).toMatchObject({
      cuentaId: 'cta-1',
      detalle: 'TECLADO INALAMBRICO',
      ivaTarifa: 0,
    });
  });
});

describe('ConfirmacionFacturaService — lo que no se registra', () => {
  // No es un dato que falte: es que lo leído se contradice con lo impreso.
  // Registrar igual sería meter a la contabilidad algo que nadie verificó.
  it('una factura cuyas cuentas no dan, ni con respuestas', async () => {
    const mal = cruzada({
      comprobaciones: comprobar({
        ...factura,
        impreso: {
          subtotal: 999_999,
          iva: 19_000,
          retencion: 0,
          total: 119_000,
        },
      }),
    });
    const { servicio, registrar } = armar(mal);

    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toThrow(
      /las cuentas de la factura no dan/i,
    );
    expect(registrar).not.toHaveBeenCalled();
  });

  it('dice cuánto sumó y cuánto dice el papel, no solo que no da', async () => {
    const mal = cruzada({
      comprobaciones: comprobar({
        ...factura,
        impreso: {
          subtotal: 999_999,
          iva: 19_000,
          retencion: 0,
          total: 119_000,
        },
      }),
    });
    const { servicio } = armar(mal);

    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toThrow(/999999/);
  });

  it('un renglón sin resolver y sin respuesta', async () => {
    const { servicio, registrar } = armar(
      cruzada({
        renglones: [
          {
            orden: 1,
            leido: factura.renglones[0],
            resuelto: null,
            motivo: 'No lo encontré.',
          },
        ],
      }),
    );

    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toThrow(
      /renglón 1.*TECLADO INALAMBRICO/i,
    );
    expect(registrar).not.toHaveBeenCalled();
  });

  it('un renglón que sería producto y gasto a la vez', async () => {
    const { servicio } = armar(cruzada());

    await expect(
      servicio.confirmar(ctx, 'doc-1', {
        renglones: [{ orden: 1, productoId: 'p', cuentaId: 'c' }],
      }),
    ).rejects.toThrow(/producto y un gasto a la vez/);
  });

  it('sin proveedor y sin respuesta', async () => {
    const { servicio } = armar(cruzada({ proveedor: null }));
    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toThrow(
      /quién es el proveedor/i,
    );
  });

  it('sin número y sin respuesta', async () => {
    const { servicio } = armar(
      cruzada({ factura: { ...factura, numero: null } }),
    );
    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toThrow(/número/i);
  });

  it('un documento que no es una factura', async () => {
    const { servicio } = armar([], 'RUT');
    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('una lectura que no llegó a guardar nada', async () => {
    const { servicio } = armar(null);
    await expect(servicio.confirmar(ctx, 'doc-1')).rejects.toThrow(
      /no tiene una factura/i,
    );
  });
});

describe('ConfirmacionFacturaService — el mismo producto dos veces', () => {
  // La compra lo rechaza, y la factura de Jaltech lo traía cuatro veces.
  it('se juntan al costo promedio antes de registrar', async () => {
    const renglon = (cantidad: number, valorUnitario: number) => ({
      codigo: 'P001',
      descripcion: 'TECLADO',
      clase: 'PRODUCTO' as const,
      cuentaPuc: null,
      cantidad,
      valorUnitario,
      ivaTarifa: 19,
      total: cantidad * valorUnitario,
    });
    const resuelto = {
      clase: 'PRODUCTO' as const,
      id: 'prod-1',
      codigo: 'P001',
      nombre: 'TECLADO',
    };
    const dos = cruzada({
      renglones: [
        { orden: 1, leido: renglon(2, 10_000), resuelto, motivo: '' },
        { orden: 2, leido: renglon(3, 15_000), resuelto, motivo: '' },
      ],
    });
    const { servicio, registrar } = armar(dos);

    await servicio.confirmar(ctx, 'doc-1');

    expect(registrar.mock.calls[0][1].lineas).toEqual([
      { productoId: 'prod-1', cantidad: 5, costoUnitario: 13_000 },
    ]);
  });
});

describe('ConfirmacionFacturaService — lo que aprende al registrar', () => {
  const gasto = (cambios: Partial<FacturaCruzada['renglones'][number]> = {}) =>
    cruzada({
      renglones: [
        {
          orden: 1,
          leido: {
            ...factura.renglones[0],
            clase: 'GASTO',
            descripcion: 'ARRENDAMIENTO LOCAL COMERCIAL OCTUBRE 2026',
            ivaTarifa: 0,
          },
          resuelto: null,
          motivo: '¿Cuál uso?',
          ...cambios,
        },
      ],
    });

  it('guarda lo que la persona contestó, en la transacción de la compra', async () => {
    const { servicio, registrar, aprender } = armar(gasto());

    await servicio.confirmar(ctx, 'doc-1', {
      renglones: [{ orden: 1, cuentaId: 'cta-512005' }],
    });

    expect(registrar.mock.calls[0][3]).toBe(TX);
    expect(aprender).toHaveBeenCalledWith(
      ctx,
      'prov-1',
      'compra-1',
      [
        {
          tipo: 'RESPUESTA',
          clase: 'GASTO',
          texto: 'ARRENDAMIENTO LOCAL COMERCIAL',
          ejemplo: 'ARRENDAMIENTO LOCAL COMERCIAL OCTUBRE 2026',
          cuentaId: 'cta-512005',
        },
      ],
      TX,
    );
  });

  // Lo que el cruce resolvió solo no se aprende: grabaría un «era el único que
  // se parecía» equivocado para siempre.
  it('no aprende lo que el cruce encontró solo', async () => {
    const { servicio, aprender } = armar(cruzada());

    await servicio.confirmar(ctx, 'doc-1');

    expect(aprender.mock.calls[0][3]).toEqual([]);
  });

  it('lo recordado que nadie cambió suma un uso', async () => {
    const { servicio, aprender } = armar(
      gasto({
        resuelto: {
          clase: 'GASTO',
          id: 'cta-512005',
          codigo: '512005',
          nombre: 'Arrendamientos',
        },
        forma: 'APRENDIDO',
      }),
    );

    await servicio.confirmar(ctx, 'doc-1');

    expect(aprender.mock.calls[0][3]).toEqual([
      { tipo: 'USO', clase: 'GASTO', texto: 'ARRENDAMIENTO LOCAL COMERCIAL' },
    ]);
  });

  it('si la compra falla, no se aprende nada', async () => {
    const { servicio, registrar, aprender } = armar(gasto());
    registrar.mockRejectedValueOnce(
      new BadRequestException('Período cerrado.'),
    );

    await expect(
      servicio.confirmar(ctx, 'doc-1', {
        renglones: [{ orden: 1, cuentaId: 'cta-512005' }],
      }),
    ).rejects.toThrow(/período cerrado/i);
    expect(aprender).not.toHaveBeenCalled();
  });
});
