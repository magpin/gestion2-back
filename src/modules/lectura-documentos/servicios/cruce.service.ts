import { Injectable, Logger } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import {
  codigoDelRenglon,
  consolidar,
  elegirCuenta,
  elegirProducto,
  elegirCliente,
  elegirProveedor,
  type Cruce,
  type FormaDeCruce,
  type LineaCruzada,
} from '../reglas/cruce.reglas';
import type {
  Comprobacion,
  FacturaCompraLeida,
  RenglonLeido,
} from '../reglas/factura-compra.reglas';
import { cuadra } from '../reglas/factura-compra.reglas';
import { llaveDelRenglon, porQueNoSirve } from '../reglas/memoria.reglas';
import {
  avisoDePrecio,
  type PedidoLeido,
  type RenglonPedido,
} from '../reglas/pedido-venta.reglas';
import type {
  RenglonVentaHistorica,
  VentaHistoricaLeida,
} from '../reglas/venta-historica.reglas';
import { MemoriaService, type Recordado } from './memoria.service';

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
  /**
   * Por qué camino se encontró. `APRENDIDO` es lo que la pantalla muestra
   * distinto: lo contestó una persona en otra factura, y se puede cambiar.
   * Ausente en las lecturas guardadas antes de que existiera.
   */
  forma?: FormaDeCruce;
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

/** Un renglón del pedido después de cruzarlo. */
export interface RenglonPedidoCruzado {
  orden: number;
  leido: RenglonPedido;
  /** Solo productos: una factura de venta no tiene líneas de gasto. */
  resuelto: { id: string; codigo: string; nombre: string } | null;
  motivo: string;
  forma?: FormaDeCruce;
  /** El precio de lista vigente, que es al que se factura. */
  precioLista: number | null;
  /** Si el pedido dice otro precio. Se factura igual al de la lista. */
  avisoPrecio: string | null;
}

/**
 * El borrador de la factura de venta. **No es una factura**: una factura de
 * venta nace emitida, con su consecutivo. Esto es lo que se lleva al
 * formulario de siempre para que una persona la revise y la emita.
 */
export interface PedidoCruzado {
  pedido: PedidoLeido;
  comprobaciones: Comprobacion[];
  cliente: { id: string; nombre: string } | null;
  renglones: RenglonPedidoCruzado[];
  /** Producto y cantidad, ya consolidados: la venta no acepta un producto dos veces. */
  lineas: Array<{ productoId: string; cantidad: number }>;
  juntadas: number;
  preguntas: Pregunta[];
  completa: boolean;
}

/** Un renglón de una venta del sistema anterior, después de cruzarlo. */
export interface RenglonHistoricoCruzado {
  orden: number;
  leido: RenglonVentaHistorica;
  resuelto: { id: string; codigo: string; nombre: string } | null;
  motivo: string;
  forma?: FormaDeCruce;
}

/**
 * Una factura del sistema anterior, lista para proponer cargarla como
 * histórica (fase 11). Si ya está en el sistema **no se dice acá**: eso se mira
 * al mostrarla, porque entre leerla y cargarla pudo entrar por otro camino.
 */
export interface VentaHistoricaCruzada {
  factura: VentaHistoricaLeida;
  comprobaciones: Comprobacion[];
  cliente: { id: string; nombre: string } | null;
  renglones: RenglonHistoricoCruzado[];
  preguntas: Pregunta[];
  /** Sin preguntas y con las cuentas dando: se puede cargar. */
  completa: boolean;
}

/** Lo que se guarda de un archivo con ventas del sistema anterior. */
export interface VentasHistoricasCruzadas {
  facturas: VentaHistoricaCruzada[];
  /** Lo que impidió cruzar el archivo entero. Vacío si se cruzó. */
  preguntas: Pregunta[];
}

@Injectable()
export class CruceService {
  private readonly log = new Logger(CruceService.name);

  constructor(
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly memoria: MemoriaService,
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

    // Lo que una persona ya contestó para este proveedor. Solo con el
    // proveedor encontrado por NIT: recordar lo de otro sería peor que
    // preguntar.
    const recordados =
      cruceProveedor.encontrado === null
        ? new Map<string, Recordado>()
        : await this.memoria.recordados(
            ctx,
            cruceProveedor.encontrado.id,
            factura.renglones.flatMap((r) => {
              const texto = llaveDelRenglon(r);
              return texto === null ? [] : [{ clase: r.clase, texto }];
            }),
          );

    for (const [indice, leido] of factura.renglones.entries()) {
      const orden = indice + 1;
      const texto = llaveDelRenglon(leido);
      const recordado =
        texto === null ? undefined : recordados.get(`${leido.clase}|${texto}`);

      // Lo recordado va antes que el catálogo: es lo que una persona dijo que
      // es este texto de este proveedor. Si ya no sirve, se cruza como
      // siempre y se dice por qué no se usó.
      const deMemoria =
        recordado === undefined
          ? null
          : await this.usarRecordado(ctx, recordado);
      let cruce: Cruce<RenglonCruzado['resuelto'] & object>;
      if (deMemoria !== null && deMemoria.encontrado !== null) {
        cruce = deMemoria;
      } else {
        cruce =
          leido.clase === 'GASTO'
            ? await this.cruzarGasto(ctx, leido)
            : await this.cruzarProducto(ctx, leido);
        if (deMemoria !== null && cruce.encontrado === null) {
          cruce = { ...cruce, motivo: `${deMemoria.motivo} ${cruce.motivo}` };
        }
      }

      renglones.push({
        orden,
        leido,
        resuelto: cruce.encontrado,
        motivo: cruce.motivo,
        ...(cruce.forma !== undefined && { forma: cruce.forma }),
      });

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
   * El pedido de un cliente, para armar la factura de venta.
   *
   * La misma búsqueda que en una compra —el tercero por NIT, cada renglón por
   * código y después por nombre—, con dos diferencias: el tercero tiene que
   * ser **cliente**, y cada producto encontrado trae **su precio de lista**,
   * que es al que se factura. Un producto sin precio de lista no se puede
   * facturar —la venta lo rechaza—, así que eso también es una pregunta.
   *
   * Sin memoria: en una venta el renglón no llega hasta la factura con su
   * orden —la persona puede cambiar, quitar o agregar líneas en el formulario—,
   * así que no hay con qué saber qué contestó para cuál.
   */
  async cruzarPedido(
    ctx: CtxEmpresa,
    pedido: PedidoLeido,
    comprobaciones: Comprobacion[],
  ): Promise<PedidoCruzado> {
    const preguntas: Pregunta[] = [];

    const candidatos =
      pedido.cliente.nit === null
        ? []
        : await this.nucleo.terceroPorDocumento(ctx, pedido.cliente.nit);
    const cruceCliente = elegirCliente(
      pedido.cliente,
      candidatos.map((t) => ({
        id: t.id,
        numeroDocumento: t.numeroDocumento,
        nombre: t.nombre,
        esCliente: t.esCliente,
      })),
    );
    if (cruceCliente.encontrado === null) {
      preguntas.push({ sobre: 'cliente', texto: cruceCliente.motivo });
    }

    const renglones: RenglonPedidoCruzado[] = [];
    const porProducto = new Map<string, number>();

    for (const [indice, leido] of pedido.renglones.entries()) {
      const orden = indice + 1;
      const cruce = await this.cruzarProducto(ctx, leido);
      const producto = cruce.encontrado;
      const precioLista =
        producto === null
          ? null
          : await this.inventario.precioVigente(ctx, producto.id);

      renglones.push({
        orden,
        leido,
        resuelto:
          producto === null
            ? null
            : {
                id: producto.id,
                codigo: producto.codigo,
                nombre: producto.nombre,
              },
        motivo: cruce.motivo,
        ...(cruce.forma !== undefined && { forma: cruce.forma }),
        precioLista,
        avisoPrecio: avisoDePrecio(leido.valorUnitario, precioLista),
      });

      if (producto === null) {
        preguntas.push({
          sobre: `renglon-${orden}`,
          texto: `Renglón ${orden} («${leido.descripcion}»): ${cruce.motivo}`,
        });
        continue;
      }
      if (precioLista === null || precioLista <= 0) {
        preguntas.push({
          sobre: `renglon-${orden}`,
          texto: `Renglón ${orden}: ${producto.codigo} ${producto.nombre} no tiene precio de venta. Hay que ponérselo antes de facturar.`,
        });
        continue;
      }
      porProducto.set(
        producto.id,
        (porProducto.get(producto.id) ?? 0) + leido.cantidad,
      );
    }

    const lineas = [...porProducto.entries()].map(([productoId, cantidad]) => ({
      productoId,
      cantidad,
    }));
    const facturables = renglones.filter(
      (r) => r.resuelto !== null && r.precioLista !== null && r.precioLista > 0,
    ).length;
    const completa = preguntas.length === 0 && cuadra(comprobaciones);

    this.log.log(
      `Pedido cruzado: ${renglones.length} renglones, ${preguntas.length} preguntas, ${completa ? 'completo' : 'incompleto'}.`,
    );

    return {
      pedido,
      comprobaciones,
      cliente:
        cruceCliente.encontrado === null
          ? null
          : {
              id: cruceCliente.encontrado.id,
              nombre: cruceCliente.encontrado.nombre,
            },
      renglones,
      lineas,
      // Cuántos renglones facturables se juntaron con otro del mismo producto.
      juntadas: facturables - lineas.length,
      preguntas,
      completa,
    };
  }

  /**
   * Cada factura del sistema anterior contra el sistema: el cliente por NIT y
   * cada renglón por código o nombre. **El precio no se busca**: se carga el
   * que se cobró, que es el impreso.
   */
  async cruzarVentasHistoricas(
    ctx: CtxEmpresa,
    facturas: Array<{
      factura: VentaHistoricaLeida;
      comprobaciones: Comprobacion[];
    }>,
  ): Promise<VentasHistoricasCruzadas> {
    const cruzadas: VentaHistoricaCruzada[] = [];
    for (const { factura, comprobaciones } of facturas) {
      const preguntas: Pregunta[] = [];

      const candidatos =
        factura.cliente.nit === null
          ? []
          : await this.nucleo.terceroPorDocumento(ctx, factura.cliente.nit);
      const cruceCliente = elegirCliente(factura.cliente, candidatos, {
        documento: 'La factura',
        antesDe: 'cargarla',
      });
      if (cruceCliente.encontrado === null) {
        preguntas.push({ sobre: 'cliente', texto: cruceCliente.motivo });
      }

      // El punto de los miles leído como decimal deja «$ 30.000» en 30, y las
      // sumas igual dan —todo quedó dividido por mil—. Pasó en la primera
      // lectura del escaneo de prueba. Una venta de menos de mil pesos es tan
      // rara que se pregunta antes de cargarla.
      if (factura.impreso.total > 0 && factura.impreso.total < MINIMO_CREIBLE) {
        preguntas.push({
          sobre: 'montos',
          texto: `Leí un total de $ ${factura.impreso.total}. Si la factura dice más —por ejemplo $ ${factura.impreso.total}.000—, se leyó mal: súbala de nuevo.`,
        });
      }

      const renglones: RenglonHistoricoCruzado[] = [];
      for (const [indice, leido] of factura.renglones.entries()) {
        const orden = indice + 1;
        const cruce = await this.cruzarProducto(ctx, leido);
        const producto = cruce.encontrado;
        renglones.push({
          orden,
          leido,
          resuelto:
            producto === null
              ? null
              : {
                  id: producto.id,
                  codigo: producto.codigo,
                  nombre: producto.nombre,
                },
          motivo: cruce.motivo,
          ...(cruce.forma !== undefined && { forma: cruce.forma }),
        });
        if (producto === null) {
          preguntas.push({
            sobre: `renglon-${orden}`,
            texto: `Renglón ${orden} («${leido.descripcion}»): ${cruce.motivo}`,
          });
        }
        if (![0, 5, 19].includes(leido.ivaTarifa)) {
          preguntas.push({
            sobre: `iva-${orden}`,
            texto: `Renglón ${orden}: leí un IVA de ${leido.ivaTarifa} %, y solo puede ser 0, 5 o 19.`,
          });
        }
      }

      cruzadas.push({
        factura,
        comprobaciones,
        cliente:
          cruceCliente.encontrado === null
            ? null
            : {
                id: cruceCliente.encontrado.id,
                nombre: cruceCliente.encontrado.nombre,
              },
        renglones,
        preguntas,
        completa: preguntas.length === 0 && cuadra(comprobaciones),
      });
    }

    this.log.log(
      `Ventas anteriores cruzadas: ${cruzadas.length} facturas, ${cruzadas.filter((c) => c.completa).length} completas.`,
    );
    return { facturas: cruzadas, preguntas: [] };
  }

  /**
   * Lo recordado, si todavía sirve. Si el producto se inactivó o la cuenta
   * dejó de recibir movimientos, no se usa: se vuelve a preguntar, sin error.
   */
  private async usarRecordado(
    ctx: CtxEmpresa,
    recordado: Recordado,
  ): Promise<Cruce<RenglonCruzado['resuelto'] & object>> {
    const deDonde = `Lo recuerdo: en la factura ${recordado.numeroFactura} de este proveedor se registró así.`;

    if (recordado.productoId !== null) {
      const producto = await this.inventario.producto(
        ctx,
        recordado.productoId,
      );
      const falla = porQueNoSirve({
        clase: 'PRODUCTO',
        existe: producto !== null,
        activo: producto?.activo ?? false,
      });
      if (producto === null || falla !== null) {
        return {
          encontrado: null,
          motivo: `Lo había recordado, pero ${falla}.`,
        };
      }
      return {
        encontrado: {
          clase: 'PRODUCTO',
          id: producto.id,
          codigo: producto.codigo,
          nombre: producto.nombre,
        },
        forma: 'APRENDIDO',
        motivo: deDonde,
      };
    }

    const cuenta =
      recordado.cuentaId === null
        ? null
        : await this.nucleo.cuentaPorId(ctx, recordado.cuentaId);
    const falla = porQueNoSirve({
      clase: 'GASTO',
      existe: cuenta !== null,
      activa: cuenta?.activa ?? false,
      esAuxiliar: cuenta?.es_auxiliar ?? false,
      codigo: cuenta?.codigo ?? '',
    });
    if (cuenta === null || falla !== null) {
      return { encontrado: null, motivo: `Lo había recordado, pero ${falla}.` };
    }
    return {
      encontrado: {
        clase: 'GASTO',
        id: cuenta.id,
        codigo: cuenta.codigo,
        nombre: cuenta.nombre,
      },
      forma: 'APRENDIDO',
      motivo: deDonde,
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
    renglon: Pick<RenglonLeido, 'codigo' | 'descripcion'>,
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

/** Por debajo de esto, el total de una venta anterior se pregunta: ver arriba. */
const MINIMO_CREIBLE = 1000;

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
