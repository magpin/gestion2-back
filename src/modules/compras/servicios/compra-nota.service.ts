import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { esFechaFutura } from '../../../common/fecha';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type { LineaAsientoDto } from '../../contabilidad/dto/asiento.dto';
import { ContabilidadApi } from '../../contabilidad/contabilidad.api';
import { InventarioApi } from '../../inventario/inventario.api';
import { NucleoApi } from '../../nucleo/nucleo.api';
import { RetencionesApi } from '../../retenciones/retenciones.api';
import type {
  CrearNotaCreditoCompraDto,
  CrearNotaDebitoCompraDto,
} from '../dto/nota-compra.dto';
import { calcularLineasCompra, netoAPagar } from './compra.reglas';
import {
  CAMPOS_DOCUMENTO,
  CompraService,
  type CompraDocumentoDetalle,
  type CompraDocumentoLineaResumen,
  type CompraDocumentoResumen,
} from './compra.service';

const CAMPOS_LINEA = `id, compra_documento_id, orden, producto_id, cuenta_id, detalle, concepto_id, cantidad,
                       costo_unitario, iva_tarifa, subtotal, iva_valor, total, iva_descontable, iva_base,
                       (SELECT x.codigo FROM producto x WHERE x.id = producto_id) AS producto_codigo,
                       (SELECT x.nombre FROM producto x WHERE x.id = producto_id) AS producto_nombre,
                       (SELECT x.codigo FROM empresa_cuenta x WHERE x.id = cuenta_id) AS cuenta_codigo,
                       (SELECT x.nombre FROM empresa_cuenta x WHERE x.id = cuenta_id) AS cuenta_nombre`;

const CODIGO_CUENTA_PROVEEDORES = '220505';
const CODIGO_CUENTA_IVA_DESCONTABLE = '240810';
const CODIGO_COMPROBANTE_COMPRA = 'CE';

/**
 * Las dos notas de compra, con su naturaleza invertida.
 *
 * * **Nota crédito**: el proveedor nos acredita —una devolución, un descuento
 *   posterior, un menor valor— y baja lo que se le debe. Es el asiento de la
 *   compra al revés: débito a proveedores, crédito a inventario y al IVA
 *   descontable, y las retenciones se reversan en la proporción devuelta
 *   (lo retenido se le debe a la DIAN, y si la compra baja, baja también).
 * * **Nota débito**: el proveedor nos cobra más —un flete, un interés, un
 *   mayor valor— y sube lo que se le debe. Mismo sentido que la compra.
 *
 * **Ninguna de las dos mueve el kardex**, igual que las notas de venta (ver
 * "Qué NO entra" en `docs/planes/ventas-ajustes.md`). Ojo con lo que eso
 * implica en compras, que es más fuerte que en ventas: si la mercancía vuelve
 * físicamente al proveedor, el libro deja de contarla y el kardex sigue con
 * ella hasta que alguien registre la salida de ajuste. Está anotado como el
 * punto a revisar del plan: `CompraService.anular` ya resuelve el caso
 * equivalente moviendo el kardex en el mismo acto, y estas dos notas deberían
 * terminar haciendo lo mismo.
 */
@Injectable()
export class CompraNotaService {
  constructor(
    private readonly tx: TxService,
    private readonly nucleo: NucleoApi,
    private readonly inventario: InventarioApi,
    private readonly contabilidad: ContabilidadApi,
    private readonly compras: CompraService,
    private readonly retenciones: RetencionesApi,
  ) {}

  // ---------------------------------------------------------------------------
  // Nota crédito: el proveedor nos acredita
  // ---------------------------------------------------------------------------
  async crearNotaCredito(
    ctx: CtxEmpresa,
    dto: CrearNotaCreditoCompraDto,
    tx?: Tx,
  ): Promise<CompraDocumentoDetalle> {
    return this.tx.enContexto(
      ctx,
      async (t) => {
        const compra = await this.exigirCompraVigente(ctx, dto, t);

        // Qué se devuelve, y a qué costo: el de la compra, no uno nuevo.
        const yaDevuelto = await this.devueltoPorLinea(
          compra.lineas.map((l) => l.id),
          t,
        );
        const pedido =
          dto.lineas ??
          compra.lineas
            .map((l) => ({
              lineaOrigenId: l.id,
              cantidad: Number(l.cantidad) - (yaDevuelto.get(l.id) ?? 0),
            }))
            .filter((l) => l.cantidad > 0);

        const porId = new Map(compra.lineas.map((l) => [l.id, l]));
        const origenes: CompraDocumentoLineaResumen[] = [];
        const entradas = [];
        for (const p of pedido) {
          const original = porId.get(p.lineaOrigenId);
          if (original === undefined) {
            throw new BadRequestException(
              'Una de las líneas que querés devolver no es de esta compra.',
            );
          }
          const pendiente =
            Number(original.cantidad) - (yaDevuelto.get(p.lineaOrigenId) ?? 0);
          if (p.cantidad > pendiente) {
            throw new BadRequestException(
              `De esa línea quedan ${pendiente} por devolver de las ${Number(original.cantidad)} compradas; no se pueden devolver ${p.cantidad}.`,
            );
          }
          origenes.push(original);
          entradas.push({
            cantidad: p.cantidad,
            costoUnitario: Number(original.costo_unitario),
            ivaTarifa: Number(original.iva_tarifa),
            ivaDescontable: original.iva_descontable,
            // Con IVA sobre el AIU (0102), la devolución lleva la parte del AIU
            // que le toca: el IVA que se reversa es el que se cobró.
            aiu:
              original.iva_base === null || original.iva_base === undefined
                ? undefined
                : (Number(original.iva_base) * p.cantidad) /
                  Number(original.cantidad),
          });
        }
        if (entradas.length === 0) {
          throw new BadRequestException(
            'Esta compra ya se devolvió completa: no queda nada por acreditar.',
          );
        }

        const { lineas, totales } = calcularLineasCompra(entradas);

        // Las retenciones bajan en la misma proporción que el total: lo que se
        // le retuvo al proveedor por una compra que se devolvió en parte ya no
        // se le debe a la DIAN en esa parte.
        const proporcion = totales.total / Number(compra.total);
        // Lo que calculó el motor se reversa con la cifra del motor: la
        // proporción de lo vivo de la compra —con los ajustes por cambio de
        // norma— y al peso. Si el asiento iba en centavos sobre lo registrado
        // al comprar, la 2365 y el 350 no cuadraban (bug 4). Lo registrado sin
        // motor (antes de él) sigue en la proporción de lo registrado.
        const previstas = await this.retenciones.reversaRentaPrevista(
          { compraId: compra.id, proporcion },
          t,
        );
        const retenciones = compra.retenciones.map((r) => {
          const municipio = r.municipio_codigo ?? null;
          const delMotor =
            r.retencion_calculada_id != null
              ? (previstas.get(r.retencion_calculada_id) ?? {
                  base: 0,
                  valor: 0,
                })
              : previstas.get(`${r.concepto}|${municipio ?? ''}`);
          return {
            concepto: r.concepto,
            cuentaId: r.cuenta_id,
            tipo: r.tipo ?? null,
            conceptoNacionalId: r.concepto_nacional_id ?? null,
            tarifa:
              r.tarifa === null || r.tarifa === undefined
                ? null
                : Number(r.tarifa),
            asumida: r.asumida === true,
            municipio,
            base: delMotor?.base ?? redondear2(Number(r.base) * proporcion),
            valor: delMotor?.valor ?? redondear2(Number(r.valor) * proporcion),
          };
        });
        // El IVA asumido no bajó lo que se le debía al proveedor: su reversa
        // tampoco lo toca.
        const retenido = redondear2(
          retenciones
            .filter((r) => !r.asumida)
            .reduce((s, r) => s + r.valor, 0),
        );
        const neto = netoAPagar(totales.total, retenido);

        const { cuentaProveedores, cuentaIvaId, totalIvaDescontable } =
          await this.cuentas(ctx, lineas, totales.subtotal, t);

        // Contra la misma cuenta que se debitó al comprar, y la línea original
        // la guarda desde la 0060. Antes se le preguntaba al producto, y con
        // una línea de gasto —que no tiene producto— se caía.
        const cuentaDebitoDe = origenes.map((l) => l.cuenta_id);

        // El asiento de la compra, al revés.
        const lineasAsiento: LineaAsientoDto[] = [
          {
            cuentaId: cuentaProveedores.id,
            terceroId: compra.tercero_id,
            debito: neto,
            credito: 0,
          },
        ];
        for (const r of retenciones) {
          if (r.valor <= 0) continue;
          lineasAsiento.push({
            cuentaId: r.cuentaId,
            terceroId: compra.tercero_id,
            baseGravable: r.base,
            debito: r.valor,
            credito: 0,
          });
          // La contrapartida del IVA asumido, al revés que en la compra.
          if (r.asumida) {
            const vigentes = await this.nucleo.regimenVigente(
              ctx,
              dto.fecha,
              t,
            );
            const descontable = vigentes.includes('RESPONSABLE_IVA')
              ? await this.nucleo.cuenta(ctx, '240810', t)
              : null;
            lineasAsiento.push({
              cuentaId: descontable?.id ?? cuentaDebitoDe[0],
              debito: 0,
              credito: r.valor,
            });
          }
        }
        lineas.forEach((l, i) => {
          lineasAsiento.push({
            cuentaId: cuentaDebitoDe[i],
            debito: 0,
            credito: l.valorKardex,
            // El mismo concepto que la compra: la vista de Gastos resta la nota.
            ...(origenes[i].concepto_id
              ? { conceptoId: origenes[i].concepto_id }
              : {}),
          });
        });
        if (cuentaIvaId !== null) {
          lineasAsiento.push({
            cuentaId: cuentaIvaId,
            baseGravable: totales.subtotal,
            debito: 0,
            credito: totalIvaDescontable,
          });
        }

        return this.guardar(
          ctx,
          'NOTA_CREDITO',
          dto,
          compra,
          { lineas, totales, retenido, neto, retenciones, proporcion },
          origenes.map((l) => ({
            productoId: l.producto_id,
            cuentaId: l.cuenta_id,
            detalle: l.detalle,
            conceptoId: l.concepto_id ?? null,
          })),
          origenes.map((l) => l.id),
          lineasAsiento,
          t,
        );
      },
      tx,
    );
  }

  // ---------------------------------------------------------------------------
  // Nota débito: el proveedor nos cobra más
  // ---------------------------------------------------------------------------
  async crearNotaDebito(
    ctx: CtxEmpresa,
    dto: CrearNotaDebitoCompraDto,
  ): Promise<CompraDocumentoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const compra = await this.exigirCompraVigente(ctx, dto, t);

      // Las de gasto quedan fuera de esta cuenta: dos fletes en la misma nota
      // son corrientes, y cada uno tiene su detalle.
      const productoIds = dto.lineas.flatMap((l) =>
        l.productoId === undefined ? [] : [l.productoId],
      );
      if (new Set(productoIds).size !== productoIds.length) {
        throw new BadRequestException(
          'No repitas el mismo producto en dos líneas — sumá la cantidad en una sola.',
        );
      }

      // Las dos preguntas de siempre (decisión 4 del plan de compras): el IVA
      // de la línea lo pone el proveedor, y que sea descontable lo decide
      // nuestra condición. Se heredan de la compra que se está corrigiendo.
      const ivaDescontable = compra.lineas.some((l) => l.iva_descontable);
      const entradas = [];
      /** Contra qué cuenta va cada línea: la del producto o la del gasto. */
      const cuentaDebitoDe: string[] = [];
      const conceptoDe: Array<string | null> = [];
      /** Lo que el motor de renta necesita para clasificar cada renglón. */
      const pistas: Array<{
        texto: string | null;
        cuentaCodigo: string | null;
      }> = [];
      for (const l of dto.lineas) {
        const producto =
          l.productoId === undefined
            ? null
            : await this.compras.productoDeLinea(ctx, l.productoId, t);
        const gasto =
          producto === null ? await this.compras.gastoDeLinea(ctx, l, t) : null;

        cuentaDebitoDe.push(gasto?.id ?? producto!.cuenta_inventario_id);
        conceptoDe.push(gasto?.conceptoId ?? null);
        pistas.push({
          texto: producto?.nombre ?? l.detalle ?? null,
          cuentaCodigo: gasto?.codigo ?? null,
        });

        entradas.push({
          cantidad: l.cantidad,
          costoUnitario: l.costoUnitario,
          ivaTarifa:
            producto === null
              ? (l.ivaTarifa ?? 0)
              : Number(producto.iva_tarifa),
          ivaDescontable,
          // El IVA de aseo, vigilancia y temporales va sobre el AIU (bug #16).
          aiu: dto.aiuRenglones?.find((x) => x.orden === entradas.length + 1)
            ?.aiu,
        });
      }

      const { lineas, totales } = calcularLineasCompra(entradas);

      // Lo que el proveedor cobra de más también lleva retención: el mismo
      // motor que la compra, con la ley a la fecha de la nota (Fase 8, §8.7).
      // «Sin retención» se acepta solo con el porqué.
      const documentoId = randomUUID();
      const renta =
        dto.sinRetencionMotivo !== undefined
          ? null
          : await this.retenciones.confirmarRenta(
              ctx,
              {
                terceroId: compra.tercero_id,
                fecha: dto.fecha,
                aportesSeguridadSocial: dto.aportesSeguridadSocial,
                renglones: lineas.map((l, i) => ({
                  orden: i + 1,
                  subtotal: l.subtotal,
                  iva: l.ivaValor,
                  productoId: dto.lineas[i].productoId ?? null,
                  texto: pistas[i].texto,
                  cuentaCodigo: pistas[i].cuentaCodigo,
                  aiu: dto.aiuRenglones?.find((x) => x.orden === i + 1)?.aiu,
                })),
              },
              { conceptos: dto.conceptosRenta, convenios: dto.conveniosRenta },
              { tipo: 'NOTA_DEBITO_COMPRA', id: documentoId },
              t,
            );
      const retenciones = (renta?.retenciones ?? []).map((r) => ({
        concepto: r.conceptoCodigo,
        cuentaId: r.cuentaId,
        tipo: r.impuesto,
        conceptoNacionalId: r.conceptoNacionalId,
        tarifa: r.tarifa / 100,
        asumida: r.asumida,
        municipio: r.municipio,
        base: r.base,
        valor: r.valor,
        renglones: r.renglones,
        retencionCalculadaId: r.retencionCalculadaId,
      }));
      // El IVA asumido (servicios del exterior) no se le descuenta al proveedor.
      const retenido = redondear2(
        retenciones.filter((r) => !r.asumida).reduce((s, r) => s + r.valor, 0),
      );
      if (retenido > totales.total) {
        throw new BadRequestException(
          'Lo retenido no puede superar el total de la nota.',
        );
      }
      const neto = netoAPagar(totales.total, retenido);

      const { cuentaProveedores, cuentaIvaId, totalIvaDescontable } =
        await this.cuentas(ctx, lineas, totales.subtotal, t);

      // Mismo sentido que la compra: débito lo que entra, crédito lo que se
      // debe.
      const lineasAsiento: LineaAsientoDto[] = [];
      lineas.forEach((l, i) => {
        lineasAsiento.push({
          cuentaId: cuentaDebitoDe[i],
          debito: l.valorKardex,
          credito: 0,
          ...(conceptoDe[i] !== null && { conceptoId: conceptoDe[i] }),
        });
      });
      if (cuentaIvaId !== null) {
        lineasAsiento.push({
          cuentaId: cuentaIvaId,
          baseGravable: totales.subtotal,
          debito: totalIvaDescontable,
          credito: 0,
        });
      }
      // Cada retención al pasivo; el IVA asumido, como en la compra: descontable
      // si la empresa descuenta IVA, si no, mayor valor de lo que se cobró.
      for (const r of retenciones) {
        lineasAsiento.push({
          cuentaId: r.cuentaId,
          terceroId: compra.tercero_id,
          baseGravable: r.base,
          debito: 0,
          credito: r.valor,
        });
        if (r.asumida) {
          const cuenta = ivaDescontable
            ? (cuentaIvaId ??
              (await this.nucleo.cuenta(ctx, CODIGO_CUENTA_IVA_DESCONTABLE, t))
                ?.id)
            : cuentaDebitoDe[(r.renglones?.[0] ?? 1) - 1];
          if (cuenta === undefined) {
            throw new BadRequestException(
              `No existe o está inactiva la cuenta de IVA descontable (${CODIGO_CUENTA_IVA_DESCONTABLE}). Actívala en el plan de cuentas.`,
            );
          }
          lineasAsiento.push({
            cuentaId: cuenta,
            ...(ivaDescontable ? { baseGravable: r.base } : {}),
            debito: r.valor,
            credito: 0,
          });
        }
      }
      lineasAsiento.push({
        cuentaId: cuentaProveedores.id,
        terceroId: compra.tercero_id,
        debito: 0,
        credito: neto,
      });

      return this.guardar(
        ctx,
        'NOTA_DEBITO',
        dto,
        compra,
        { lineas, totales, retenido, neto, retenciones, documentoId },
        dto.lineas.map((l, i) => ({
          productoId: l.productoId ?? null,
          cuentaId: cuentaDebitoDe[i],
          detalle: l.detalle ?? null,
          conceptoId: conceptoDe[i],
        })),
        dto.lineas.map(() => null),
        lineasAsiento,
        t,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Lo compartido
  // ---------------------------------------------------------------------------

  /** La compra que la nota corrige, vigente y con su fecha razonable. */
  private async exigirCompraVigente(
    ctx: CtxEmpresa,
    dto: { documentoOrigenId: string; fecha: string },
    t: Tx,
  ): Promise<CompraDocumentoDetalle> {
    // Como la compra: acepta fecha pasada —la nota del proveedor llega con la
    // fecha que él le puso— y rechaza futuro.
    if (esFechaFutura(dto.fecha)) {
      throw new BadRequestException(
        'La fecha de la nota no puede ser posterior a hoy.',
      );
    }
    const periodoAbierto = await this.contabilidad.periodoAbiertoEn(
      ctx,
      new Date(dto.fecha),
      t,
    );
    if (!periodoAbierto) {
      throw new BadRequestException(
        'El período de esta fecha está cerrado. No se puede registrar la nota.',
      );
    }

    // El candado contra una anulación simultánea: `CompraService.anular` toma
    // la compra `FOR UPDATE` y rechaza si tiene notas vivas. Sin esto, la
    // compra podía anularse mientras esta nota se registraba y la nota quedaba
    // corrigiendo una compra anulada. Se toma antes de leerla, para leerla ya
    // con la anulación confirmada si la hubo.
    await t.query(`SELECT 1 FROM compra_documento WHERE id = $1 FOR SHARE`, [
      dto.documentoOrigenId,
    ]);
    const compra = await this.compras.porId(ctx, dto.documentoOrigenId, t);
    if (compra.tipo !== 'FACTURA') {
      throw new BadRequestException(
        'Una nota se registra sobre una factura de compra, no sobre otra nota.',
      );
    }
    if (compra.estado !== 'EMITIDA') {
      throw new BadRequestException(
        'Esta compra está anulada: no se le puede registrar una nota.',
      );
    }
    return compra;
  }

  /** Cuánto se devolvió ya de cada línea, por notas crédito no anuladas. */
  private async devueltoPorLinea(
    lineaIds: string[],
    t: Tx,
  ): Promise<Map<string, number>> {
    if (lineaIds.length === 0) return new Map();
    const devueltas = filas<{ linea_origen_id: string; cantidad: string }>(
      await t.query(
        `SELECT l.linea_origen_id, sum(l.cantidad)::text AS cantidad
           FROM compra_documento_linea l
           JOIN compra_documento d ON d.id = l.compra_documento_id
          WHERE l.linea_origen_id = ANY($1)
            AND d.tipo = 'NOTA_CREDITO'
            AND d.estado <> 'ANULADA'
          GROUP BY l.linea_origen_id`,
        [lineaIds],
      ),
    );
    return new Map(
      devueltas.map((d) => [d.linea_origen_id, Number(d.cantidad)]),
    );
  }

  private async cuentas(
    ctx: CtxEmpresa,
    lineas: Array<{ ivaDescontable: boolean; ivaValor: number }>,
    subtotal: number,
    t: Tx,
  ): Promise<{
    cuentaProveedores: { id: string };
    cuentaIvaId: string | null;
    totalIvaDescontable: number;
  }> {
    const cuentaProveedores = await this.nucleo.cuenta(
      ctx,
      CODIGO_CUENTA_PROVEEDORES,
      t,
    );
    if (cuentaProveedores === null) {
      throw new BadRequestException(
        `No existe o está inactiva la cuenta de proveedores (${CODIGO_CUENTA_PROVEEDORES}). Actívala en el plan de cuentas.`,
      );
    }

    const totalIvaDescontable = lineas
      .filter((l) => l.ivaDescontable)
      .reduce((s, l) => s + l.ivaValor, 0);
    let cuentaIvaId: string | null = null;
    if (totalIvaDescontable > 0) {
      const cuentaIva = await this.nucleo.cuenta(
        ctx,
        CODIGO_CUENTA_IVA_DESCONTABLE,
        t,
      );
      if (cuentaIva === null) {
        throw new BadRequestException(
          `No existe o está inactiva la cuenta de IVA descontable (${CODIGO_CUENTA_IVA_DESCONTABLE}). Actívala en el plan de cuentas.`,
        );
      }
      cuentaIvaId = cuentaIva.id;
    }
    void subtotal;
    return { cuentaProveedores, cuentaIvaId, totalIvaDescontable };
  }

  /** El asiento, la cabecera, las líneas y las retenciones de la nota. */
  private async guardar(
    ctx: CtxEmpresa,
    tipo: 'NOTA_CREDITO' | 'NOTA_DEBITO',
    dto: {
      documentoOrigenId: string;
      fecha: string;
      numeroNotaProveedor: string;
      motivo: string;
    },
    compra: CompraDocumentoDetalle,
    calculo: {
      lineas: Array<{
        cantidad: number;
        costoUnitario: number;
        ivaTarifa: number;
        subtotal: number;
        /** La base del IVA cuando es el AIU (0102); `null`: el subtotal. */
        ivaBase: number | null;
        ivaValor: number;
        total: number;
        ivaDescontable: boolean;
      }>;
      totales: { subtotal: number; totalIva: number; total: number };
      retenido: number;
      neto: number;
      retenciones: Array<{
        concepto: string;
        cuentaId: string;
        tipo?: string | null;
        conceptoNacionalId?: string | null;
        tarifa?: number | null;
        asumida?: boolean;
        municipio?: string | null;
        base: number;
        valor: number;
        /** La fila del motor, cuando la retención la calculó él (nota débito). */
        retencionCalculadaId?: string | null;
      }>;
      /** En la nota crédito: qué parte de la compra se devuelve. */
      proporcion?: number;
      /** El id, cuando el motor ya guardó retenciones contra él (nota débito). */
      documentoId?: string;
    },
    renglones: Array<{
      productoId: string | null;
      cuentaId: string;
      detalle: string | null;
      conceptoId?: string | null;
    }>,
    lineaOrigenIds: Array<string | null>,
    lineasAsiento: LineaAsientoDto[],
    t: Tx,
  ): Promise<CompraDocumentoDetalle> {
    const comprobante = await this.contabilidad.tipoComprobantePorCodigo(
      ctx,
      CODIGO_COMPROBANTE_COMPRA,
      t,
    );
    if (comprobante === null) {
      throw new BadRequestException(
        'La empresa no tiene el comprobante de egreso sembrado.',
      );
    }

    const documentoId = calculo.documentoId ?? randomUUID();
    const etiqueta = tipo === 'NOTA_CREDITO' ? 'Nota crédito' : 'Nota débito';
    const asiento = await this.contabilidad.asentar(
      ctx,
      {
        comprobanteTipoId: comprobante.id,
        fecha: dto.fecha,
        glosa: `${etiqueta} de compra ${dto.numeroNotaProveedor} — factura ${compra.numero_factura_proveedor}: ${dto.motivo}`,
        lineas: lineasAsiento,
      },
      { origenTipo: 'COMPRA', origenId: documentoId },
      t,
    );

    const documento = fila<CompraDocumentoResumen>(
      await t.query(
        `INSERT INTO compra_documento
           (id, empresa_id, tipo, tercero_id, fecha, numero_factura_proveedor,
            documento_origen_id, subtotal, total_iva, total, total_retenciones,
            neto_a_pagar, asiento_id, creado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING ${CAMPOS_DOCUMENTO}`,
        [
          documentoId,
          ctx.empresaId,
          tipo,
          compra.tercero_id,
          dto.fecha,
          dto.numeroNotaProveedor,
          dto.documentoOrigenId,
          calculo.totales.subtotal,
          calculo.totales.totalIva,
          calculo.totales.total,
          calculo.retenido,
          calculo.neto,
          asiento.id,
          ctx.usuarioId,
        ],
      ),
    );
    if (documento === undefined) {
      throw new BadRequestException(`No se pudo registrar la ${etiqueta}.`);
    }

    const lineasInsertadas: CompraDocumentoLineaResumen[] = [];
    for (let i = 0; i < calculo.lineas.length; i++) {
      const l = calculo.lineas[i];
      const insertada = fila<CompraDocumentoLineaResumen>(
        await t.query(
          `INSERT INTO compra_documento_linea
             (empresa_id, compra_documento_id, orden, producto_id, cuenta_id, detalle,
              cantidad, costo_unitario, iva_tarifa, subtotal, iva_valor, total,
              iva_descontable, linea_origen_id, iva_base, concepto_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING ${CAMPOS_LINEA}`,
          [
            ctx.empresaId,
            documento.id,
            i + 1,
            renglones[i].productoId,
            renglones[i].cuentaId,
            renglones[i].detalle,
            l.cantidad,
            l.costoUnitario,
            l.ivaTarifa,
            l.subtotal,
            l.ivaValor,
            l.total,
            l.ivaDescontable,
            lineaOrigenIds[i],
            l.ivaBase,
            renglones[i].conceptoId ?? null,
          ],
        ),
      );
      if (insertada === undefined) {
        throw new BadRequestException(
          `No se pudo registrar una línea de la ${etiqueta}.`,
        );
      }
      lineasInsertadas.push(insertada);
    }

    // La renta que calculó el motor se reversa también en su registro:
    // una fila nueva por concepto, ligada a la original (caso borde 4).
    const reversadas =
      calculo.proporcion === undefined
        ? new Map<string, string>()
        : await this.retenciones.reversarRenta(
            ctx,
            {
              compraId: compra.id,
              notaId: documento.id,
              proporcion: calculo.proporcion,
              fecha: dto.fecha,
            },
            t,
          );

    for (const r of calculo.retenciones) {
      if (r.valor <= 0) continue;
      await t.query(
        `INSERT INTO compra_retencion
           (empresa_id, compra_documento_id, concepto, cuenta_id, base, valor,
            tipo, concepto_nacional_id, tarifa, retencion_calculada_id, asumida,
            municipio_codigo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          ctx.empresaId,
          documento.id,
          r.concepto,
          r.cuentaId,
          r.base,
          r.valor,
          r.tipo ?? null,
          r.conceptoNacionalId ?? null,
          r.tarifa ?? null,
          reversadas.get(`${r.concepto}|${r.municipio ?? ''}`) ??
            r.retencionCalculadaId ??
            null,
          r.asumida === true,
          r.municipio ?? null,
        ],
      );
    }

    return this.compras.porId(ctx, documento.id, t);
  }
}

/** Los pesos de las notas se redondean igual que en el resto del sistema. */
function redondear2(valor: number): number {
  return Math.round(valor * 100) / 100;
}
