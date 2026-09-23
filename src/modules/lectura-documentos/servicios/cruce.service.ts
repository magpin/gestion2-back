import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  codigoDelRenglon,
  consolidar,
  elegirCuenta,
  elegirProducto,
  elegirProveedor,
  type Cruce,
  type LineaCruzada,
} from '../reglas/cruce.reglas';
import type {
  Comprobacion,
  FacturaCompraLeida,
  RenglonLeido,
} from '../reglas/factura-compra.reglas';
import { cuadra } from '../reglas/factura-compra.reglas';

/**
 * Cruza una factura leída con lo que ya está en el sistema: quién es el
 * proveedor, qué producto es cada renglón, contra qué cuenta va cada gasto.
 *
 * **No registra nada.** Devuelve lo que se pudo resolver y lo que hay que
 * preguntar, y de ahí sale la propuesta que una persona confirma. Esto es lo
 * que antes vivía en `scripts/probar-facturas-compra.ts`, que sirvió para
 * medir y no para producción.
 *
 * Las decisiones —cuándo una coincidencia cuenta y cuándo no— están en
 * `reglas/cruce.reglas.ts`, sin base de datos y con sus pruebas. Acá solo se
 * busca y se arma.
 */

/** Un renglón después de cruzarlo. */
export interface RenglonCruzado {
  /** El orden en que venía en el documento: es cómo se lo nombra. */
  orden: number;
  leido: RenglonLeido;
  /** Qué resultó: un producto, una cuenta, o una pregunta. */
  resuelto:
    | { clase: 'PRODUCTO'; id: string; codigo: string; nombre: string }
    | { clase: 'GASTO'; id: string; codigo: string; nombre: string }
    | null;
  /** Cómo se resolvió, o por qué no. Escrito para leerse. */
  motivo: string;
}

/** Lo que falta para poder registrar. Cada una es una pregunta concreta. */
export interface Pregunta {
  /** `proveedor`, `numero`, o `renglon-3`: con qué se identifica en la pantalla. */
  sobre: string;
  texto: string;
}

export interface FacturaCruzada {
  factura: FacturaCompraLeida;
  comprobaciones: Comprobacion[];
  proveedor: { id: string; nombre: string } | null;
  renglones: RenglonCruzado[];
  /** Listas para `POST /compras`, ya consolidadas. Vacío si falta algo. */
  lineas: LineaCruzada[];
  /** Cuántos renglones del mismo producto se juntaron en uno. */
  juntadas: number;
  preguntas: Pregunta[];
  /**
   * Si no queda nada por preguntar **y** las cuentas dan. Lo que sigue es
   * proponer; confirmar es de una persona, siempre.
   */
  completa: boolean;
}

@Injectable()
export class CruceService {
  private readonly log = new Logger(CruceService.name);

  constructor(
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
  ) {}

  async cruzar(
    ctx: CtxEmpresa,
    factura: FacturaCompraLeida,
    comprobaciones: Comprobacion[],
  ): Promise<FacturaCruzada> {
    const preguntas: Pregunta[] = [];

    // ── El proveedor ────────────────────────────────────────────────────────
    const candidatos =
      factura.proveedor.nit === null
        ? []
        : await this.nucleo.terceroPorDocumento(ctx, factura.proveedor.nit);

    const cruceProveedor = elegirProveedor(
      factura.proveedor,
      candidatos.map((t) => ({
        id: t.id,
        numeroDocumento: t.numeroDocumento,
        nombre: t.nombre,
        esProveedor: t.esProveedor,
      })),
    );
    if (cruceProveedor.encontrado === null) {
      preguntas.push({ sobre: 'proveedor', texto: cruceProveedor.motivo });
    }

    // ── El número ───────────────────────────────────────────────────────────
    // Lo pone el proveedor y es la identidad del documento: sin él la compra no
    // se puede registrar ni volver a encontrar. Una cuenta de cobro no lo trae,
    // y eso no es un error de lectura.
    if (factura.numero === null) {
      preguntas.push({
        sobre: 'numero',
        texto:
          'El documento no trae número de factura. ¿Con qué número lo registro?',
      });
    }

    // ── Los renglones ───────────────────────────────────────────────────────
    const renglones: RenglonCruzado[] = [];
    const lineas: LineaCruzada[] = [];

    for (const [indice, leido] of factura.renglones.entries()) {
      const orden = indice + 1;
      const cruce =
        leido.clase === 'GASTO'
          ? await this.cruzarGasto(ctx, leido)
          : await this.cruzarProducto(ctx, leido);

      renglones.push({ orden, leido, resuelto: cruce.encontrado, motivo: cruce.motivo });

      if (cruce.encontrado === null) {
        preguntas.push({
          sobre: `renglon-${orden}`,
          texto: `Renglón ${orden} («${leido.descripcion}»): ${cruce.motivo}`,
        });
        continue;
      }

      lineas.push(
        cruce.encontrado.clase === 'GASTO'
          ? {
              cuentaId: cruce.encontrado.id,
              detalle: leido.descripcion,
              ivaTarifa: leido.ivaTarifa,
              cantidad: leido.cantidad,
              costoUnitario: leido.valorUnitario,
              valor: leido.total,
            }
          : {
              productoId: cruce.encontrado.id,
              cantidad: leido.cantidad,
              costoUnitario: leido.valorUnitario,
              valor: leido.total,
            },
      );
    }

    const consolidadas = consolidar(lineas);
    const completa = preguntas.length === 0 && cuadra(comprobaciones);

    this.log.log(
      `Factura cruzada: ${renglones.length} renglones, ${preguntas.length} preguntas, ${completa ? 'completa' : 'incompleta'}.`,
    );

    return {
      factura,
      comprobaciones,
      proveedor:
        cruceProveedor.encontrado === null
          ? null
          : {
              id: cruceProveedor.encontrado.id,
              nombre: cruceProveedor.encontrado.nombre,
            },
      renglones,
      // Si falta algo, las líneas no sirven para nada: mandar media factura a
      // `POST /compras` la registraría incompleta, que es peor que no
      // registrarla.
      lineas: completa ? consolidadas.lineas : [],
      juntadas: consolidadas.juntadas,
      preguntas,
      completa,
    };
  }

  /**
   * Un renglón de mercancía. Dos búsquedas y no una: primero por código, que
   * es identidad, y solo si eso no da, por descripción.
   *
   * Buscar siempre las dos costaría el doble de consultas en una factura de
   * sesenta renglones, y la de Jaltech cruzó 58 de 60 por la primera.
   */
  private async cruzarProducto(
    ctx: CtxEmpresa,
    renglon: RenglonLeido,
  ): Promise<Cruce<RenglonCruzado['resuelto'] & object>> {
    const codigo = codigoDelRenglon(renglon);

    if (codigo !== null) {
      const porCodigo = await this.inventario.buscarProductos(ctx, codigo);
      const cruce = elegirProducto(renglon, porCodigo);
      if (cruce.encontrado !== null) return comoProducto(cruce);
    }

    // La descripción entera traería cero resultados por una coma de más: se
    // busca con el principio, que es donde está lo que identifica al producto.
    const porNombre = await this.inventario.buscarProductos(
      ctx,
      renglon.descripcion.slice(0, LARGO_DE_BUSQUEDA),
    );
    return comoProducto(elegirProducto(renglon, porNombre));
  }

  /**
   * Un renglón de gasto. Una sola búsqueda, por el código del PUC, y **casi
   * nunca hay uno**: una cuenta de cobro no lo imprime. Entonces se pregunta,
   * que es lo correcto —elegir la cuenta es de quien contabiliza—.
   */
  private async cruzarGasto(
    ctx: CtxEmpresa,
    renglon: RenglonLeido,
  ): Promise<Cruce<RenglonCruzado['resuelto'] & object>> {
    const codigo = renglon.cuentaPuc?.replace(/\D/g, '') ?? '';
    const cuenta = codigo === '' ? null : await this.nucleo.cuenta(ctx, codigo);
    const cruce = elegirCuenta(
      renglon,
      cuenta === null
        ? []
        : [
            {
              id: cuenta.id,
              codigo: cuenta.codigo,
              nombre: cuenta.nombre,
              esAuxiliar: cuenta.esAuxiliar,
            },
          ],
    );
    return {
      encontrado:
        cruce.encontrado === null
          ? null
          : {
              clase: 'GASTO',
              id: cruce.encontrado.id,
              codigo: cruce.encontrado.codigo,
              nombre: cruce.encontrado.nombre,
            },
      motivo: cruce.motivo,
      forma: cruce.forma,
    };
  }
}

/**
 * Con cuánto de la descripción se busca. Cuarenta entra en el nombre de un
 * producto del catálogo y deja afuera la cola —presentaciones, códigos de
 * barras, unidades— que es donde las dos fuentes se escriben distinto.
 */
const LARGO_DE_BUSQUEDA = 40;

function comoProducto<T extends { id: string; codigo: string; nombre: string }>(
  cruce: Cruce<T>,
): Cruce<RenglonCruzado['resuelto'] & object> {
  return {
    encontrado:
      cruce.encontrado === null
        ? null
        : {
            clase: 'PRODUCTO',
            id: cruce.encontrado.id,
            codigo: cruce.encontrado.codigo,
            nombre: cruce.encontrado.nombre,
          },
    motivo: cruce.motivo,
    forma: cruce.forma,
  };
}
