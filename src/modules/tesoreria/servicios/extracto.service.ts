import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { armarPagina, type Pagina } from '../../../common/dto/paginacion.dto';
import { TxService, type Tx } from '../../../common/db/tx.service';
import type {
  AgregarLineaExtractoDto,
  CompletarGrupoDto,
  ConciliarDto,
  CrearExtractoDto,
  GrupoConciliacionDto,
  ImportarExtractoDto,
  ListarExtractosDto,
  NotaLineaDto,
  RegistrarDesdeExtractoDto,
} from '../dto/extracto.dto';
import {
  BancoMovimientoService,
  DIRECCION_MOVIMIENTO_BANCO,
} from './banco-movimiento.service';
import {
  calcularSaldoExtracto,
  DIAS_CON_REFERENCIA,
  describirCruce,
  proponerCruces,
  reconocerPorReglas,
  verificarConciliacion,
  verificarGrupo,
  type CriterioPropuesto,
} from './banco.reglas';
import { redondear } from './caja.reglas';

export interface ExtractoResumen {
  id: string;
  cuenta_bancaria_id: string;
  fecha_desde: string;
  fecha_hasta: string;
  saldo_inicial_banco: string;
  saldo_final_banco: string;
  estado: 'ABIERTO' | 'CONCILIADO';
  conciliado_en: string | null;
  conciliado_por: string | null;
  archivo_nombre: string | null;
}

export interface LineaExtractoResumen {
  id: string;
  extracto_id: string;
  fecha: string;
  descripcion: string;
  referencia: string | null;
  valor: string;
  tipo: 'DEBITO' | 'CREDITO';
  origen: 'MANUAL' | 'IMPORTADA';
  fila_archivo: number | null;
  nota: string | null;
  /** El cruce vigente en que está, o `null` si está suelta. */
  grupo_id: string | null;
}

export type CriterioGrupo =
  CriterioPropuesto | 'MANUAL' | 'REGISTRADA' | 'ANTERIOR';

export interface GrupoResumen {
  id: string;
  criterio: CriterioGrupo;
  creado_en: string;
  creado_por: string | null;
  linea_ids: string[];
  movimiento_ids: string[];
}

export interface ExtractoDetalle extends ExtractoResumen {
  lineas: LineaExtractoResumen[];
  grupos: GrupoResumen[];
}

export interface PropuestasExtracto {
  propuestas: Array<{
    lineaId: string;
    movimientoId: string;
    criterio: CriterioPropuesto;
    dias: number;
    referencia: string | null;
    motivo: string;
  }>;
  ambiguas: Array<{ lineaId: string; candidatos: string[] }>;
  /** Líneas sueltas que reconoce una regla: "Registrar las 23 líneas de 4×1000". */
  porRegla: Array<{
    reglaId: string;
    nombre: string;
    contraCuentaId: string;
    concepto: string;
    lineaIds: string[];
    total: string;
  }>;
  lineasSueltas: string[];
  movimientosSueltos: string[];
}

const CAMPOS_EXTRACTO = `id, cuenta_bancaria_id, fecha_desde, fecha_hasta,
                          saldo_inicial_banco, saldo_final_banco, estado,
                          conciliado_en, conciliado_por, archivo_nombre`;

const CAMPOS_LINEA = `id, extracto_id, fecha, descripcion, referencia, valor, tipo,
                      origen, fila_archivo, nota`;

/** Una línea sin cruce vigente. `el` es el alias de `extracto_linea`. */
const LINEA_SUELTA = `NOT EXISTS (SELECT 1 FROM conciliacion_partida p
                                   WHERE p.extracto_linea_id = el.id AND p.vigente)`;

type Direccion = 'ENTRADA' | 'SALIDA';

function direccionDe(tipo: string): Direccion {
  return DIRECCION_MOVIMIENTO_BANCO[
    tipo as keyof typeof DIRECCION_MOVIMIENTO_BANCO
  ];
}

/**
 * La conciliación bancaria: un extracto es un rango de fechas, no un día
 * — no encadena con el anterior, el banco lleva su propio calendario. Ver
 * "Por qué Bancos no tiene arqueo" en `docs/planes/caja-bancos-fase2.md`.
 *
 * El sistema PROPONE cruces y una persona los confirma — nunca concilia solo
 * (paso 16 de `docs/planes/ajustes-16-sep.md`). Un cruce es un grupo: unas
 * líneas del extracto con unos movimientos del libro cuyas sumas con signo
 * son iguales. Una diferencia no se cruza: se registra (cargo o abono del
 * banco, error nuestro) o se anota como error del banco.
 *
 * Todo lo que escribe bloquea la fila del extracto (`FOR UPDATE`) antes de
 * tocarlo: dos conciliaciones simultáneas del mismo extracto no pueden
 * pisarse.
 */
@Injectable()
export class ExtractoService {
  constructor(
    private readonly tx: TxService,
    private readonly movimientos: BancoMovimientoService,
  ) {}

  async crear(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: CrearExtractoDto,
  ): Promise<ExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCuentaActiva(cuentaBancariaId, t);
      return this.insertarExtracto(ctx, cuentaBancariaId, dto, null, t);
    });
  }

  /**
   * El extracto leído de un archivo, de una vez: la cabecera, las líneas y el
   * mapeo de columnas que queda recordado en la cuenta. Rechaza antes de
   * guardar lo que después no se podría cerrar: líneas fuera del rango, y un
   * extracto que no cuadra consigo mismo —casi siempre, el débito y el crédito
   * cruzados en el mapeo—.
   */
  async importar(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: ImportarExtractoDto,
  ): Promise<ExtractoResumen> {
    const fuera = dto.lineas.filter(
      (l) => l.fecha < dto.fechaDesde || l.fecha > dto.fechaHasta,
    );
    if (fuera.length > 0) {
      const filasFuera = fuera
        .slice(0, 5)
        .map((l) => l.fila)
        .join(', ');
      throw new BadRequestException(
        `${fuera.length} línea${fuera.length === 1 ? '' : 's'} con fecha fuera del ` +
          `extracto (${dto.fechaDesde} a ${dto.fechaHasta}): fila${fuera.length === 1 ? '' : 's'} ${filasFuera}` +
          `${fuera.length > 5 ? '…' : ''}.`,
      );
    }

    const calculado = calcularSaldoExtracto(dto.saldoInicialBanco, dto.lineas);
    if (calculado !== redondear(dto.saldoFinalBanco)) {
      throw new BadRequestException(
        `El extracto no cuadra: saldo inicial ${redondear(dto.saldoInicialBanco)} ` +
          `más los créditos y menos los débitos da ${calculado}, y el banco dice ` +
          `${redondear(dto.saldoFinalBanco)}. Revisa qué columna es débito y cuál crédito.`,
      );
    }

    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirCuentaActiva(cuentaBancariaId, t);

      const repetido = fila<{ fecha_desde: string; fecha_hasta: string }>(
        await t.query(
          `SELECT fecha_desde, fecha_hasta FROM extracto_bancario
            WHERE cuenta_bancaria_id = $1 AND archivo_huella = $2`,
          [cuentaBancariaId, dto.archivoHuella],
        ),
      );
      if (repetido !== undefined) {
        throw new BadRequestException(
          `Este archivo ya se subió: es el extracto del ${repetido.fecha_desde} al ${repetido.fecha_hasta}.`,
        );
      }

      const extracto = await this.insertarExtracto(
        ctx,
        cuentaBancariaId,
        dto,
        { nombre: dto.archivoNombre, huella: dto.archivoHuella },
        t,
      );

      await t.query(
        `INSERT INTO extracto_linea
           (empresa_id, extracto_id, origen, fila_archivo, fecha, descripcion,
            referencia, valor, tipo)
         SELECT $1, $2, 'IMPORTADA', x.fila, x.fecha, x.descripcion,
                x.referencia, x.valor, x.tipo
           FROM unnest($3::int[], $4::date[], $5::text[], $6::text[],
                       $7::numeric[], $8::text[])
                AS x(fila, fecha, descripcion, referencia, valor, tipo)`,
        [
          ctx.empresaId,
          extracto.id,
          dto.lineas.map((l) => l.fila),
          dto.lineas.map((l) => l.fecha),
          dto.lineas.map((l) => l.descripcion),
          dto.lineas.map((l) => l.referencia ?? null),
          dto.lineas.map((l) => l.valor),
          dto.lineas.map((l) => l.tipo),
        ],
      );

      await t.query(
        `UPDATE cuenta_bancaria SET formato_extracto = $2 WHERE id = $1`,
        [cuentaBancariaId, JSON.stringify(dto.formato)],
      );

      return extracto;
    });
  }

  async agregarLinea(
    ctx: CtxEmpresa,
    extractoId: string,
    dto: AgregarLineaExtractoDto,
  ): Promise<LineaExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      await this.exigirExtractoAbierto(extractoId, t);

      const creada = fila<Omit<LineaExtractoResumen, 'grupo_id'>>(
        await t.query(
          `INSERT INTO extracto_linea
             (empresa_id, extracto_id, fecha, descripcion, referencia, valor, tipo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING ${CAMPOS_LINEA}`,
          [
            ctx.empresaId,
            extractoId,
            dto.fecha,
            dto.descripcion,
            dto.referencia ?? null,
            dto.valor,
            dto.tipo,
          ],
        ),
      );
      if (creada === undefined) {
        throw new BadRequestException('No se pudo agregar la línea.');
      }
      return { ...creada, grupo_id: null };
    });
  }

  /** El historial de extractos de una cuenta bancaria. Más reciente primero. */
  async listar(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    p: ListarExtractosDto,
  ): Promise<Pagina<ExtractoResumen>> {
    return this.tx.enContexto(ctx, async (t) => {
      const conteo = fila<{ total: string }>(
        await t.query(
          'SELECT count(*) AS total FROM extracto_bancario WHERE cuenta_bancaria_id = $1',
          [cuentaBancariaId],
        ),
      );

      const datos = filas<ExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS_EXTRACTO}
             FROM extracto_bancario
            WHERE cuenta_bancaria_id = $1
            ORDER BY fecha_desde DESC
            LIMIT $2 OFFSET $3`,
          [cuentaBancariaId, p.tamano, p.salto],
        ),
      );

      return armarPagina(datos, Number(conteo?.total ?? 0), p);
    });
  }

  /** El extracto con sus líneas y los cruces vigentes. */
  async porId(ctx: CtxEmpresa, id: string): Promise<ExtractoDetalle> {
    return this.tx.enContexto(ctx, async (t) => {
      const extracto = fila<ExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS_EXTRACTO} FROM extracto_bancario WHERE id = $1`,
          [id],
        ),
      );
      if (extracto === undefined) {
        throw new NotFoundException('Extracto no encontrado');
      }

      const lineas = filas<LineaExtractoResumen>(
        await t.query(
          `SELECT el.id, el.extracto_id, el.fecha, el.descripcion, el.referencia,
                  el.valor, el.tipo, el.origen, el.fila_archivo, el.nota,
                  p.grupo_id
             FROM extracto_linea el
             LEFT JOIN conciliacion_partida p
               ON p.extracto_linea_id = el.id AND p.vigente
            WHERE el.extracto_id = $1
            ORDER BY el.fecha, el.fila_archivo NULLS LAST, el.id`,
          [id],
        ),
      );

      const grupos = filas<GrupoResumen>(
        await t.query(
          `SELECT g.id, g.criterio, g.creado_en, g.creado_por,
                  coalesce(array_agg(p.extracto_linea_id)
                    FILTER (WHERE p.extracto_linea_id IS NOT NULL), '{}') AS linea_ids,
                  coalesce(array_agg(p.banco_movimiento_id)
                    FILTER (WHERE p.banco_movimiento_id IS NOT NULL), '{}') AS movimiento_ids
             FROM conciliacion_grupo g
             JOIN conciliacion_partida p ON p.grupo_id = g.id
            WHERE g.extracto_id = $1 AND g.deshecho_en IS NULL
            GROUP BY g.id
            ORDER BY g.creado_en`,
          [id],
        ),
      );

      return { ...extracto, lineas, grupos };
    });
  }

  /**
   * Lo que el sistema propone, calculado en el momento y sin guardar: si
   * mañana se registra el 4×1000 que faltaba, la propuesta ya lo ve. Ver
   * `banco.reglas.proponerCruces`.
   */
  async propuestas(
    ctx: CtxEmpresa,
    extractoId: string,
  ): Promise<PropuestasExtracto> {
    return this.tx.enContexto(ctx, async (t) => {
      const extracto = fila<ExtractoResumen>(
        await t.query(
          `SELECT ${CAMPOS_EXTRACTO} FROM extracto_bancario WHERE id = $1`,
          [extractoId],
        ),
      );
      if (extracto === undefined) {
        throw new NotFoundException('Extracto no encontrado');
      }

      const lineas = filas<{
        id: string;
        fecha: string;
        valor: string;
        tipo: 'DEBITO' | 'CREDITO';
        descripcion: string;
        referencia: string | null;
      }>(
        await t.query(
          `SELECT el.id, el.fecha::text AS fecha, el.valor, el.tipo,
                  el.descripcion, el.referencia
             FROM extracto_linea el
            -- Una línea anotada como error del banco ya está explicada: no
            -- se propone ni la reconoce una regla. Se le reclama al banco.
            WHERE el.extracto_id = $1 AND ${LINEA_SUELTA} AND el.nota IS NULL
            ORDER BY el.fecha, el.fila_archivo NULLS LAST, el.id`,
          [extractoId],
        ),
      );

      // Sin piso de fecha: un cheque girado hace dos meses puede cobrarse hoy.
      // El techo es el más lejano que todavía podría cruzar por referencia.
      const movimientos = filas<{
        id: string;
        fecha: string;
        valor: string;
        tipo: string;
        referencia: string | null;
        numero_documento: string | null;
        dv: string | null;
        consecutivo: number | null;
        numero_factura_proveedor: string | null;
      }>(
        await t.query(
          `SELECT m.id, m.fecha::text AS fecha, m.valor, m.tipo, m.referencia,
                  te.numero_documento, te.dv::text AS dv,
                  v.consecutivo, c.numero_factura_proveedor
             FROM banco_movimiento m
             LEFT JOIN tercero te ON te.id = m.tercero_id
             LEFT JOIN venta_documento v
               ON m.origen_tipo = 'FACTURA_VENTA' AND v.id = m.origen_id
             LEFT JOIN compra_documento c
               ON m.origen_tipo = 'COMPRA' AND c.id = m.origen_id
            WHERE m.cuenta_bancaria_id = $1
              AND NOT m.conciliado
              AND m.tipo <> 'SALDO_INICIAL'
              AND m.fecha <= $2::date + $3::int
            ORDER BY m.fecha, m.secuencia`,
          [
            extracto.cuenta_bancaria_id,
            extracto.fecha_hasta,
            DIAS_CON_REFERENCIA,
          ],
        ),
      );

      const resultado = proponerCruces(
        lineas.map((l) => ({
          id: l.id,
          fecha: l.fecha,
          valor: Number(l.valor),
          tipo: l.tipo,
          texto: `${l.descripcion} ${l.referencia ?? ''}`,
        })),
        movimientos.map((m) => ({
          id: m.id,
          fecha: m.fecha,
          valor: Number(m.valor),
          direccion: direccionDe(m.tipo),
          referencias: [
            m.referencia,
            m.numero_documento,
            m.numero_documento !== null && m.dv !== null
              ? `${m.numero_documento}${m.dv}`
              : null,
            m.consecutivo !== null ? String(m.consecutivo) : null,
            m.numero_factura_proveedor,
          ].filter((r): r is string => r !== null),
        })),
      );

      const reglas = filas<{
        id: string;
        nombre: string;
        palabras: string[];
        tipo_linea: 'DEBITO' | 'CREDITO';
        contra_cuenta_id: string;
        concepto: string;
      }>(
        await t.query(
          `SELECT id, nombre, palabras, tipo_linea, contra_cuenta_id, concepto
             FROM extracto_regla
            WHERE activa
              AND (cuenta_bancaria_id IS NULL OR cuenta_bancaria_id = $1)
            ORDER BY cuenta_bancaria_id NULLS LAST, creado_en`,
          [extracto.cuenta_bancaria_id],
        ),
      );

      // Las reglas miran solo lo que quedó suelto: si alguien ya registró el
      // 4×1000 a mano, cruzarlo es mejor que registrarlo otra vez.
      const sueltas = new Set(resultado.lineasSueltas);
      const reconocidas = reconocerPorReglas(
        lineas.filter((l) => sueltas.has(l.id)),
        reglas.map((r) => ({
          id: r.id,
          palabras: r.palabras,
          tipoLinea: r.tipo_linea,
        })),
      );
      const valorPorLinea = new Map(lineas.map((l) => [l.id, Number(l.valor)]));

      return {
        propuestas: resultado.propuestas.map((p) => ({
          ...p,
          motivo: describirCruce(p),
        })),
        ambiguas: resultado.ambiguas,
        porRegla: reglas
          .filter((r) => reconocidas.has(r.id))
          .map((r) => {
            const lineaIds = reconocidas.get(r.id) ?? [];
            const total = lineaIds.reduce(
              (s, id) => s + (valorPorLinea.get(id) ?? 0),
              0,
            );
            return {
              reglaId: r.id,
              nombre: r.nombre,
              contraCuentaId: r.contra_cuenta_id,
              concepto: r.concepto,
              lineaIds,
              total: redondear(total).toFixed(2),
            };
          }),
        lineasSueltas: resultado.lineasSueltas,
        movimientosSueltos: resultado.movimientosSueltos,
      };
    });
  }

  /**
   * Confirma uno o varios cruces, todos o ninguno. Cada grupo tiene que
   * cuadrar al centavo: una diferencia no se cruza, se explica
   * (`completar`, `anotarLinea`).
   */
  async conciliar(
    ctx: CtxEmpresa,
    extractoId: string,
    dto: ConciliarDto,
  ): Promise<{ grupos: number }> {
    exigirSinRepetidos(dto.grupos);

    await this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);

      for (const grupo of dto.grupos) {
        const lineas = await this.lineasSueltas(extractoId, grupo.lineaIds, t);
        const movimientos = await this.movimientosSinConciliar(
          extracto.cuenta_bancaria_id,
          grupo.movimientoIds,
          t,
        );

        const { cuadra, diferencia } = verificarGrupo(lineas, movimientos);
        if (!cuadra) {
          throw new BadRequestException(
            `No cuadra: el banco dice ${formatoDiferencia(diferencia)} que el libro. ` +
              'Una diferencia no se cruza: regístrala o anótala como error del banco.',
          );
        }

        await this.crearGrupo(
          ctx,
          extractoId,
          grupo.criterio,
          grupo.lineaIds,
          grupo.movimientoIds,
          t,
        );
      }
    });

    return { grupos: dto.grupos.length };
  }

  /** Deshace un cruce mal hecho. No borra: queda quién y cuándo. */
  async deshacer(
    ctx: CtxEmpresa,
    extractoId: string,
    grupoId: string,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await this.exigirExtractoAbierto(extractoId, t);

      const grupo = fila<{ id: string }>(
        await t.query(
          `UPDATE conciliacion_grupo
              SET deshecho_en = now(), deshecho_por = $3
            WHERE id = $1 AND extracto_id = $2 AND deshecho_en IS NULL
          RETURNING id`,
          [grupoId, extractoId, ctx.usuarioId],
        ),
      );
      if (grupo === undefined) {
        throw new NotFoundException(
          'Ese cruce no existe en este extracto o ya se deshizo',
        );
      }

      const partidas = filas<{ banco_movimiento_id: string | null }>(
        await t.query(
          `UPDATE conciliacion_partida SET vigente = false
            WHERE grupo_id = $1 AND vigente
          RETURNING banco_movimiento_id`,
          [grupoId],
        ),
      );
      const movimientoIds = partidas
        .map((p) => p.banco_movimiento_id)
        .filter((id): id is string => id !== null);

      await t.query(
        `UPDATE banco_movimiento SET conciliado = false WHERE id = ANY($1::uuid[])`,
        [movimientoIds],
      );
    });
  }

  /**
   * Registra en el libro lo que el banco hizo solo: una nota débito o crédito
   * por línea, con la fecha y el valor que dice el banco, cada una cruzada
   * con su línea. Es el ajuste que pide la teoría para los cargos y abonos
   * del banco que la empresa no había registrado, con el extracto de soporte.
   */
  async registrar(
    ctx: CtxEmpresa,
    extractoId: string,
    dto: RegistrarDesdeExtractoDto,
  ): Promise<{ registradas: number }> {
    await this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);
      const lineas = await this.lineasSueltas(extractoId, dto.lineaIds, t);

      for (const linea of lineas) {
        const movimiento = await this.movimientos.registrarNota(
          ctx,
          extracto.cuenta_bancaria_id,
          {
            tipo: linea.tipo === 'DEBITO' ? 'NOTA_DEBITO' : 'NOTA_CREDITO',
            fecha: linea.fecha,
            valor: linea.valor,
            concepto: dto.concepto,
            contraCuentaId: dto.contraCuentaId,
            terceroId: dto.terceroId ?? null,
            referencia: linea.referencia,
          },
          t,
        );
        await this.crearGrupo(
          ctx,
          extractoId,
          'REGISTRADA',
          [linea.id],
          [movimiento.id],
          t,
        );
      }
    });

    return { registradas: dto.lineaIds.length };
  }

  /**
   * Un cruce al que le falta una diferencia: el cheque de 500.000 que el banco
   * cobró por 510.000. Registra la nota por lo que falta —contra el gasto si
   * fue un cargo del banco, contra la cuenta que corresponda si fue un error
   * nuestro— y cruza todo junto. Si el error es del banco, no se usa esto: la
   * línea se anota y se reclama.
   */
  async completar(
    ctx: CtxEmpresa,
    extractoId: string,
    dto: CompletarGrupoDto,
  ): Promise<{ movimientoId: string; diferencia: number }> {
    exigirSinRepetidos([dto]);

    return this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);
      const lineas = await this.lineasSueltas(extractoId, dto.lineaIds, t);
      const movimientos = await this.movimientosSinConciliar(
        extracto.cuenta_bancaria_id,
        dto.movimientoIds,
        t,
      );

      const { cuadra, diferencia } = verificarGrupo(lineas, movimientos);
      if (cuadra) {
        throw new BadRequestException(
          'Este cruce ya cuadra: no hay diferencia que registrar.',
        );
      }

      const fecha = lineas
        .map((l) => l.fecha)
        .sort()
        .at(-1)!;
      const nota = await this.movimientos.registrarNota(
        ctx,
        extracto.cuenta_bancaria_id,
        {
          tipo: diferencia < 0 ? 'NOTA_DEBITO' : 'NOTA_CREDITO',
          fecha,
          valor: Math.abs(diferencia),
          concepto: dto.concepto,
          contraCuentaId: dto.contraCuentaId,
          terceroId: dto.terceroId ?? null,
          referencia: null,
        },
        t,
      );

      await this.crearGrupo(
        ctx,
        extractoId,
        'REGISTRADA',
        dto.lineaIds,
        [...dto.movimientoIds, nota.id],
        t,
      );

      return { movimientoId: nota.id, diferencia };
    });
  }

  /**
   * Un error del banco: la línea queda sin cruzar y con el porqué, y se le
   * reclama. El libro no se toca. Con `nota: null` se quita.
   */
  async anotarLinea(
    ctx: CtxEmpresa,
    extractoId: string,
    lineaId: string,
    dto: NotaLineaDto,
  ): Promise<void> {
    await this.tx.enContexto(ctx, async (t) => {
      await this.exigirExtractoAbierto(extractoId, t);
      await this.lineasSueltas(extractoId, [lineaId], t, {
        aceptarAnotadas: true,
      });
      await t.query(`UPDATE extracto_linea SET nota = $2 WHERE id = $1`, [
        lineaId,
        dto.nota === null ? null : dto.nota.trim(),
      ]);
    });
  }

  /**
   * Cierra el extracto como `CONCILIADO`. Toda línea tiene que estar
   * explicada —cruzada, o anotada como error del banco— y cuadrar las dos
   * cuentas de `verificarConciliacion`: el extracto consigo mismo, y el
   * libro ajustado por lo pendiente y lo que se le reclama al banco contra el
   * saldo final. Rechaza con el detalle si no.
   */
  async cerrar(ctx: CtxEmpresa, extractoId: string): Promise<ExtractoResumen> {
    return this.tx.enContexto(ctx, async (t) => {
      const extracto = await this.exigirExtractoAbierto(extractoId, t);

      const lineas = filas<{
        valor: string;
        tipo: 'DEBITO' | 'CREDITO';
        suelta: boolean;
        nota: string | null;
      }>(
        await t.query(
          `SELECT el.valor, el.tipo, el.nota, ${LINEA_SUELTA} AS suelta
             FROM extracto_linea el
            WHERE el.extracto_id = $1`,
          [extractoId],
        ),
      );

      const sinExplicar = lineas.filter((l) => l.suelta && l.nota === null);
      if (sinExplicar.length > 0) {
        throw new BadRequestException(
          `${sinExplicar.length} línea${sinExplicar.length === 1 ? '' : 's'} del extracto ` +
            'sin cruzar ni explicar. Crúzalas, regístralas en el libro o anótalas ' +
            'como error del banco.',
        );
      }

      const ultimoMovimiento = fila<{ saldo_valor: string }>(
        await t.query(
          `SELECT saldo_valor FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1
            ORDER BY secuencia DESC
            LIMIT 1`,
          [extracto.cuenta_bancaria_id],
        ),
      );
      const saldoLibro = Number(ultimoMovimiento?.saldo_valor ?? 0);

      const pendientesFilas = filas<{ valor: string; tipo: string }>(
        await t.query(
          `SELECT valor, tipo FROM banco_movimiento
            WHERE cuenta_bancaria_id = $1 AND NOT conciliado AND tipo <> 'SALDO_INICIAL'`,
          [extracto.cuenta_bancaria_id],
        ),
      );

      const aNumero = (l: { valor: string; tipo: 'DEBITO' | 'CREDITO' }) => ({
        valor: Number(l.valor),
        tipo: l.tipo,
      });
      const resultado = verificarConciliacion({
        saldoInicialBanco: Number(extracto.saldo_inicial_banco),
        saldoFinalBanco: Number(extracto.saldo_final_banco),
        lineas: lineas.map(aNumero),
        saldoLibro,
        pendientes: pendientesFilas.map((m) => ({
          valor: Number(m.valor),
          direccion: direccionDe(m.tipo),
        })),
        porReclamar: lineas.filter((l) => l.suelta).map(aNumero),
      });

      if (!resultado.ok) {
        throw new BadRequestException(resultado.motivo);
      }

      const cerrado = fila<ExtractoResumen>(
        await t.query(
          `UPDATE extracto_bancario
              SET estado = 'CONCILIADO', conciliado_en = now(), conciliado_por = $2
            WHERE id = $1
          RETURNING ${CAMPOS_EXTRACTO}`,
          [extractoId, ctx.usuarioId],
        ),
      );
      if (cerrado === undefined) {
        throw new BadRequestException('No se pudo cerrar el extracto.');
      }
      return cerrado;
    });
  }

  // ---------------------------------------------------------------------------

  private async exigirCuentaActiva(cuentaBancariaId: string, t: Tx) {
    const cuenta = fila<{ id: string }>(
      await t.query(`SELECT id FROM cuenta_bancaria WHERE id = $1 AND activa`, [
        cuentaBancariaId,
      ]),
    );
    if (cuenta === undefined) {
      throw new NotFoundException('Cuenta bancaria no encontrada o inactiva');
    }
  }

  private async insertarExtracto(
    ctx: CtxEmpresa,
    cuentaBancariaId: string,
    dto: CrearExtractoDto,
    archivo: { nombre: string; huella: string } | null,
    t: Tx,
  ): Promise<ExtractoResumen> {
    const creado = fila<ExtractoResumen>(
      await t.query(
        `INSERT INTO extracto_bancario
           (empresa_id, cuenta_bancaria_id, fecha_desde, fecha_hasta,
            saldo_inicial_banco, saldo_final_banco, archivo_nombre, archivo_huella)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${CAMPOS_EXTRACTO}`,
        [
          ctx.empresaId,
          cuentaBancariaId,
          dto.fechaDesde,
          dto.fechaHasta,
          dto.saldoInicialBanco,
          dto.saldoFinalBanco,
          archivo?.nombre ?? null,
          archivo?.huella ?? null,
        ],
      ),
    );
    if (creado === undefined) {
      throw new BadRequestException('No se pudo crear el extracto.');
    }
    return creado;
  }

  private async exigirExtractoAbierto(
    extractoId: string,
    t: Tx,
  ): Promise<ExtractoResumen> {
    const extracto = fila<ExtractoResumen>(
      await t.query(
        `SELECT ${CAMPOS_EXTRACTO} FROM extracto_bancario WHERE id = $1 FOR UPDATE`,
        [extractoId],
      ),
    );
    if (extracto === undefined) {
      throw new NotFoundException('Extracto no encontrado');
    }
    if (extracto.estado !== 'ABIERTO') {
      throw new BadRequestException('Este extracto ya está conciliado.');
    }
    return extracto;
  }

  /** Las líneas pedidas, exigiendo que sean de este extracto y estén sueltas. */
  /**
   * Las líneas pedidas, si son de este extracto y están sueltas. Una línea
   * anotada como error del banco tampoco se cruza ni se registra: se le
   * reclama al banco, y cruzarla la dejaría cruzada y diciendo «error del
   * banco». Solo `anotarLinea` la acepta, para poder quitarle la nota.
   */
  private async lineasSueltas(
    extractoId: string,
    ids: readonly string[],
    t: Tx,
    { aceptarAnotadas = false }: { aceptarAnotadas?: boolean } = {},
  ) {
    const lineas = filas<{
      id: string;
      fecha: string;
      valor: string;
      tipo: 'DEBITO' | 'CREDITO';
      referencia: string | null;
      nota: string | null;
      suelta: boolean;
    }>(
      await t.query(
        `SELECT el.id, el.fecha::text AS fecha, el.valor, el.tipo, el.referencia,
                el.nota, ${LINEA_SUELTA} AS suelta
           FROM extracto_linea el
          WHERE el.extracto_id = $1 AND el.id = ANY($2::uuid[])
          ORDER BY el.fecha, el.fila_archivo NULLS LAST, el.id`,
        [extractoId, ids],
      ),
    );
    if (lineas.length !== ids.length) {
      throw new NotFoundException('Alguna línea no es de este extracto');
    }
    if (lineas.some((l) => !l.suelta)) {
      throw new BadRequestException(
        'Alguna línea ya está cruzada. Deshaz ese cruce primero.',
      );
    }
    if (!aceptarAnotadas && lineas.some((l) => l.nota !== null)) {
      throw new BadRequestException(
        'Alguna línea está anotada como error del banco. Quítale la nota primero.',
      );
    }
    return lineas.map((l) => ({ ...l, valor: Number(l.valor) }));
  }

  /** Los movimientos pedidos, bloqueados, exigiendo que sean de la cuenta y no estén conciliados. */
  private async movimientosSinConciliar(
    cuentaBancariaId: string,
    ids: readonly string[],
    t: Tx,
  ) {
    const movimientos = filas<{
      id: string;
      valor: string;
      tipo: string;
      conciliado: boolean;
    }>(
      await t.query(
        `SELECT id, valor, tipo, conciliado FROM banco_movimiento
          WHERE cuenta_bancaria_id = $1 AND id = ANY($2::uuid[])
            AND tipo <> 'SALDO_INICIAL'
          FOR UPDATE`,
        [cuentaBancariaId, ids],
      ),
    );
    if (movimientos.length !== ids.length) {
      throw new NotFoundException(
        'Algún movimiento no es de esta cuenta bancaria',
      );
    }
    if (movimientos.some((m) => m.conciliado)) {
      throw new BadRequestException('Algún movimiento ya está conciliado.');
    }
    return movimientos.map((m) => ({
      valor: Number(m.valor),
      direccion: direccionDe(m.tipo),
    }));
  }

  private async crearGrupo(
    ctx: CtxEmpresa,
    extractoId: string,
    criterio: CriterioGrupo,
    lineaIds: readonly string[],
    movimientoIds: readonly string[],
    t: Tx,
  ): Promise<string> {
    const grupo = fila<{ id: string }>(
      await t.query(
        `INSERT INTO conciliacion_grupo (empresa_id, extracto_id, criterio, creado_por)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [ctx.empresaId, extractoId, criterio, ctx.usuarioId],
      ),
    );
    if (grupo === undefined) {
      throw new BadRequestException('No se pudo registrar el cruce.');
    }

    await t.query(
      `INSERT INTO conciliacion_partida (empresa_id, grupo_id, extracto_linea_id, banco_movimiento_id)
       SELECT $1::uuid, $2::uuid, x.linea, NULL FROM unnest($3::uuid[]) AS x(linea)
       UNION ALL
       SELECT $1::uuid, $2::uuid, NULL, x.movimiento FROM unnest($4::uuid[]) AS x(movimiento)`,
      [ctx.empresaId, grupo.id, lineaIds, movimientoIds],
    );
    await t.query(
      `UPDATE banco_movimiento SET conciliado = true WHERE id = ANY($1::uuid[])`,
      [movimientoIds],
    );
    return grupo.id;
  }
}

/** Una misma línea o movimiento en dos cruces del mismo pedido es un error de quien llama. */
function exigirSinRepetidos(
  grupos: ReadonlyArray<
    Pick<GrupoConciliacionDto, 'lineaIds' | 'movimientoIds'>
  >,
): void {
  const lineas = grupos.flatMap((g) => g.lineaIds);
  const movimientos = grupos.flatMap((g) => g.movimientoIds);
  if (
    new Set(lineas).size !== lineas.length ||
    new Set(movimientos).size !== movimientos.length
  ) {
    throw new BadRequestException(
      'Una misma línea o movimiento aparece dos veces en el pedido.',
    );
  }
}

function formatoDiferencia(diferencia: number): string {
  const valor = Math.abs(diferencia).toLocaleString('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return diferencia < 0 ? `$${valor} menos` : `$${valor} más`;
}
