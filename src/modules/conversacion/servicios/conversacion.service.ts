import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { PausaIaService } from '../../../common/ia/pausa-ia.service';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  CONVERSADOR,
  type ClaseDeFalla,
  type ConversadorPuerto,
  type ResultadoRespuesta,
  type UsoConversacion,
} from '../proveedores/conversador.puerto';
import { MODELO } from '../proveedores/claude.conversador';
import {
  hiloParaModelo,
  superaTope,
  VentanaDeTurnos,
  type TurnoGuardado,
} from '../reglas/conversacion.reglas';
import { BUSCAR, etiquetaDeConsulta } from '../reglas/herramientas';
import { ConsultasService, type ConsultaHecha } from './consultas.service';
import {
  CAMPOS_PROPUESTA,
  resumenDe,
  type PropuestaResumen,
} from './propuestas.service';

/** Un turno, como lo ve la pantalla. El uso de tokens queda en la base: es del expediente, no de la conversación. */
export interface TurnoResumen {
  id: string;
  orden: number;
  autor: 'PERSONA' | 'ASISTENTE';
  texto: string;
  estado: 'COMPLETO' | 'CORTADO' | 'RECHAZADO' | 'FALLO';
  motivo: string | null;
  /** De qué tipo fue la falla, cuando la hubo. Decide qué cara muestra la pantalla. */
  clase: ClaseDeFalla | null;
  creado_en: string;
  /**
   * De dónde salieron las cifras de una respuesta: «Cartera», «Saldos de caja
   * y bancos». Las consultas que salieron bien, sin repetir y sin las
   * búsquedas de nombres. Vacío en las preguntas y en lo que se contestó sin
   * consultar.
   */
  fuentes: string[];
  /**
   * Lo que el asistente propuso hacer en esta respuesta (paso 7): cobros o
   * pagos esperando Confirmar. Vacío en las preguntas.
   */
  propuestas: PropuestaResumen[];
}

export interface ConversacionVigente {
  /** `null` si la persona todavía no conversó, o si archivó la anterior. */
  id: string | null;
  turnos: TurnoResumen[];
  /** El hilo ya pesa el tope: la pantalla ofrece empezar otra en vez de dejar escribir. */
  superaTope: boolean;
}

/** Una conversación en la lista de la izquierda. */
export interface ConversacionEnLista {
  id: string;
  /** La primera pregunta, recortada: es lo que la persona reconoce. */
  titulo: string;
  preguntas: number;
  creada_en: string;
  /** `null` en la vigente: es la única en la que se puede seguir escribiendo. */
  archivada_en: string | null;
  /** El último turno, o la creación si no hay turnos. Ordena la lista. */
  ultima_en: string;
}

/** Una conversación cualquiera de quien pregunta, vigente o archivada. */
export interface ConversacionCompleta {
  id: string;
  vigente: boolean;
  turnos: TurnoResumen[];
  superaTope: boolean;
}

/** Lo que devuelve preparar un turno: con esto se llama al modelo, fuera de la transacción. */
export interface TurnoPreparado {
  conversacionId: string;
  pregunta: TurnoResumen;
  hilo: ReturnType<typeof hiloParaModelo>;
}

const CAMPOS = `id, orden, autor, texto, estado, motivo, clase, creado_en`;

interface FilaTurno extends Omit<TurnoResumen, 'fuentes' | 'propuestas'> {
  uso: UsoConversacion | null;
  /** Las herramientas que salieron bien, en orden. Solo en la lectura. */
  herramientas?: string[] | null;
  /** Las propuestas del turno, como filas. Solo en la lectura. */
  propuestas?: Parameters<typeof resumenDe>[0][] | null;
}

/**
 * La conversación de una persona con el asistente.
 *
 * **Cada persona ve solo lo suyo, y lo filtra este servicio.** La base aísla por
 * empresa (RLS), pero la sesión no sabe el usuario (migración 0050). Por eso
 * ninguna ruta recibe el id de una conversación: todo sale de «la vigente de
 * quien pregunta», y toda consulta lleva `usuario_id = ctx.usuarioId`.
 *
 * **Un turno son dos momentos**, y la transacción no cubre la llamada al
 * modelo, que tarda segundos:
 * 1. `preparar`: el límite, el tope, que no haya otra respuesta en curso, y la
 *    pregunta guardada. Si algo falla, falla acá, antes de abrir el flujo.
 * 2. `responder`: la llamada al modelo y la respuesta guardada, con el estado
 *    que haya tenido —incluso si la persona cerró la pestaña a mitad—.
 */
@Injectable()
export class ConversacionService {
  private readonly ventana = new VentanaDeTurnos(20, 60_000);
  /** Las conversaciones con una respuesta en curso: una a la vez por conversación. */
  private readonly enCurso = new Set<string>();

  constructor(
    private readonly tx: TxService,
    @Inject(CONVERSADOR) private readonly conversador: ConversadorPuerto,
    private readonly consultas: ConsultasService,
    // Opcional: las pruebas arman el servicio sin él. En la app siempre está.
    @Optional() private readonly pausa?: PausaIaService,
  ) {}

  get disponible(): boolean {
    return this.conversador.disponible;
  }

  async vigente(ctx: CtxEmpresa): Promise<ConversacionVigente> {
    return this.tx.enContexto(ctx, async (t) => {
      const id = await this.idVigente(ctx, t);
      if (id === null) return { id: null, turnos: [], superaTope: false };
      const turnos = await this.turnos(id, t);
      return {
        id,
        turnos: turnos.map(sinUso),
        superaTope: superaTope(ultimoUso(turnos)),
      };
    });
  }

  /**
   * Las conversaciones de quien pregunta, la más reciente primero. Las que no
   * llegaron a tener una pregunta no se listan: no hay nada que mostrar.
   */
  async lista(ctx: CtxEmpresa): Promise<ConversacionEnLista[]> {
    return this.tx.enContexto(ctx, async (t) =>
      filas<ConversacionEnLista>(
        await t.query(
          `SELECT c.id, c.creada_en, c.archivada_en, r.titulo, r.preguntas,
                  COALESCE(r.ultima_en, c.creada_en) AS ultima_en
             FROM conversacion c
             CROSS JOIN LATERAL (
               SELECT left((array_agg(t.texto ORDER BY t.orden)
                              FILTER (WHERE t.autor = 'PERSONA'))[1], 80) AS titulo,
                      (count(*) FILTER (WHERE t.autor = 'PERSONA'))::int AS preguntas,
                      max(t.creado_en) AS ultima_en
                 FROM conversacion_turno t
                WHERE t.conversacion_id = c.id
             ) r
            WHERE c.usuario_id = $1 AND r.preguntas > 0
            ORDER BY ultima_en DESC
            LIMIT 100`,
          [ctx.usuarioId],
        ),
      ),
    );
  }

  /**
   * Una conversación de quien pregunta, por su id. Una ajena —de otra persona
   * de la misma empresa— contesta lo mismo que una que no existe: 404.
   */
  async una(ctx: CtxEmpresa, id: string): Promise<ConversacionCompleta> {
    return this.tx.enContexto(ctx, async (t) => {
      const c = fila<{ id: string; archivada_en: string | null }>(
        await t.query(
          `SELECT id, archivada_en FROM conversacion WHERE id = $1 AND usuario_id = $2`,
          [id, ctx.usuarioId],
        ),
      );
      if (c === undefined) {
        throw new NotFoundException('No encontré esa conversación.');
      }
      const turnos = await this.turnos(c.id, t);
      return {
        id: c.id,
        vigente: c.archivada_en === null,
        turnos: turnos.map(sinUso),
        superaTope: superaTope(ultimoUso(turnos)),
      };
    });
  }

  /** «Empezar de nuevo»: la vigente se archiva, no se borra. Sin vigente, no hace nada. */
  async archivar(ctx: CtxEmpresa): Promise<void> {
    const id = await this.tx.enContexto(ctx, (t) => this.idVigente(ctx, t));
    if (id !== null && this.enCurso.has(id)) {
      throw new ConflictException(
        'Esperá a que termine la respuesta para empezar otra conversación.',
      );
    }
    await this.tx.enContexto(ctx, (t) =>
      t.query(
        `UPDATE conversacion SET archivada_en = now()
          WHERE usuario_id = $1 AND archivada_en IS NULL`,
        [ctx.usuarioId],
      ),
    );
  }

  async preparar(ctx: CtxEmpresa, texto: string): Promise<TurnoPreparado> {
    const pregunta = texto.trim();
    if (pregunta === '') {
      throw new BadRequestException('Escribí una pregunta.');
    }
    if (!this.conversador.disponible) {
      throw new HttpException(
        'El asistente no está disponible en este momento.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // La pausa de la consola va antes de todo lo que gasta: con el
    // asistente en pausa no se guarda ni la pregunta.
    await this.pausa?.exigirActiva(ctx.tenantId, 'CHAT');
    if (
      !this.ventana.permitir(`${ctx.empresaId}:${ctx.usuarioId}`, Date.now())
    ) {
      throw new HttpException(
        'Estás preguntando muy seguido. Esperá un minuto y seguí.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Se marca «en curso» con la fila bloqueada, no después de soltarla: si no,
    // dos preguntas simultáneas pasaban las dos el control. Si algo falla antes
    // de terminar, la marca se quita.
    let marcada: string | undefined;
    try {
      return await this.tx.enContexto(ctx, async (t) => {
        const conversacionId = await this.vigenteBloqueada(ctx, t);
        if (this.enCurso.has(conversacionId)) {
          throw new ConflictException(
            'Todavía estoy contestando lo anterior. Esperá a que termine.',
          );
        }
        this.enCurso.add(conversacionId);
        marcada = conversacionId;

        const turnos = await this.turnos(conversacionId, t);
        if (superaTope(ultimoUso(turnos))) {
          throw new ConflictException(
            'Esta conversación ya es muy larga para seguirla. Empezá una nueva: lo conversado queda guardado.',
          );
        }

        const guardada = await this.insertarTurno(
          ctx,
          conversacionId,
          siguienteOrden(turnos),
          { autor: 'PERSONA', texto: pregunta, estado: 'COMPLETO' },
          t,
        );
        const hilo = hiloParaModelo([...turnos, guardada]);
        return { conversacionId, pregunta: sinUso(guardada), hilo };
      });
    } catch (error) {
      if (marcada !== undefined) this.enCurso.delete(marcada);
      throw error;
    }
  }

  /**
   * Llama al modelo y guarda la respuesta, pase lo que pase. `alEscribir`
   * recibe cada pedazo en vivo; `corte` es la persona cerrando la pestaña;
   * `alConsultar` avisa cada consulta que el modelo hace a los datos.
   * Siempre libera la conversación, aunque falle el guardado.
   *
   * Las consultas corren con los permisos de quien pregunta
   * (`ConsultasService`) y se guardan con la respuesta, en la misma
   * transacción: una respuesta sin sus fuentes no se guarda.
   */
  async responder(
    ctx: CtxEmpresa,
    preparado: TurnoPreparado,
    opciones: {
      alEscribir?: (trozo: string) => void;
      corte?: AbortSignal;
      alConsultar?: (etiqueta: string) => void;
    } = {},
  ): Promise<TurnoResumen> {
    try {
      const { herramientas, hechas, propuestas } =
        this.consultas.paraTurno(ctx);
      // Cuánto tardó la respuesta entera, consultas incluidas (0054).
      const empezo = Date.now();
      const resultado = await this.conversador.responder({
        hilo: preparado.hilo,
        alEscribir: opciones.alEscribir,
        corte: opciones.corte,
        herramientas,
        alConsultar: (nombre) =>
          opciones.alConsultar?.(etiquetaDeConsulta(nombre)),
      });
      const turno = await this.tx.enContexto(ctx, async (t) => {
        const turnos = await this.turnos(preparado.conversacionId, t);
        const guardado = await this.insertarTurno(
          ctx,
          preparado.conversacionId,
          siguienteOrden(turnos),
          {
            ...turnoDeRespuesta(resultado),
            duracionMs: Date.now() - empezo,
            vueltas:
              resultado.estado === 'FALLO' ? null : (resultado.vueltas ?? null),
          },
          t,
        );
        await this.insertarConsultas(ctx, guardado.id, hechas, t);
        const guardadas = await this.consultas.guardarPropuestas(
          ctx,
          guardado.id,
          propuestas,
          t,
        );
        return {
          ...sinUso({
            ...guardado,
            herramientas: hechas
              .filter((c) => c.error === null)
              .map((c) => c.herramienta),
          }),
          propuestas: guardadas,
        };
      });
      return turno;
    } finally {
      this.enCurso.delete(preparado.conversacionId);
    }
  }

  private async idVigente(ctx: CtxEmpresa, t: Tx): Promise<string | null> {
    const c = fila<{ id: string }>(
      await t.query(
        `SELECT id FROM conversacion WHERE usuario_id = $1 AND archivada_en IS NULL`,
        [ctx.usuarioId],
      ),
    );
    return c?.id ?? null;
  }

  /**
   * La vigente de quien pregunta, creada si no hay, y bloqueada hasta el fin de
   * la transacción: dos preguntas simultáneas no pueden calcular el mismo
   * `orden`. `ON CONFLICT` cubre la carrera de dos primeras preguntas.
   */
  private async vigenteBloqueada(ctx: CtxEmpresa, t: Tx): Promise<string> {
    await t.query(
      `INSERT INTO conversacion (empresa_id, usuario_id) VALUES ($1, $2)
       ON CONFLICT (empresa_id, usuario_id) WHERE archivada_en IS NULL DO NOTHING`,
      [ctx.empresaId, ctx.usuarioId],
    );
    const c = fila<{ id: string }>(
      await t.query(
        `SELECT id FROM conversacion
          WHERE usuario_id = $1 AND archivada_en IS NULL
          FOR UPDATE`,
        [ctx.usuarioId],
      ),
    );
    if (c === undefined) {
      throw new ConflictException(
        'No pude abrir la conversación. Probá de nuevo.',
      );
    }
    return c.id;
  }

  private async turnos(conversacionId: string, t: Tx): Promise<FilaTurno[]> {
    return filas<FilaTurno>(
      await t.query(
        `SELECT ${CAMPOS}, uso,
                (SELECT array_agg(c.herramienta ORDER BY c.orden)
                   FROM conversacion_consulta c
                  WHERE c.turno_id = conversacion_turno.id AND c.error IS NULL)
                  AS herramientas,
                (SELECT json_agg(row_to_json(p) ORDER BY p.creada_en)
                   FROM (SELECT ${CAMPOS_PROPUESTA}, creada_en
                           FROM asistente_propuesta
                          WHERE turno_id = conversacion_turno.id) p)
                  AS propuestas
           FROM conversacion_turno
          WHERE conversacion_id = $1 ORDER BY orden`,
        [conversacionId],
      ),
    );
  }

  /** Lo que consultó la respuesta, en el orden en que lo consultó (migración 0051). */
  private async insertarConsultas(
    ctx: CtxEmpresa,
    turnoId: string,
    hechas: readonly ConsultaHecha[],
    t: Tx,
  ): Promise<void> {
    for (const [i, c] of hechas.entries()) {
      await t.query(
        `INSERT INTO conversacion_consulta
           (empresa_id, turno_id, orden, herramienta, entrada, filas, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ctx.empresaId,
          turnoId,
          i + 1,
          c.herramienta,
          JSON.stringify(c.entrada ?? {}),
          c.filas,
          c.error === null ? null : c.error.slice(0, 1000),
        ],
      );
    }
  }

  private async insertarTurno(
    ctx: CtxEmpresa,
    conversacionId: string,
    orden: number,
    turno: TurnoGuardado & {
      modelo?: string | null;
      uso?: UsoConversacion | null;
      motivo?: string | null;
      clase?: ClaseDeFalla | null;
      detalle?: string | null;
      /** Solo en la respuesta del asistente: lo que mide el tablero de consumo. */
      duracionMs?: number;
      vueltas?: number | null;
    },
    t: Tx,
  ): Promise<FilaTurno> {
    const guardado = fila<FilaTurno>(
      await t.query(
        `INSERT INTO conversacion_turno
           (empresa_id, conversacion_id, orden, autor, texto, estado, modelo, uso, motivo,
            duracion_ms, vueltas, clase, detalle)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING ${CAMPOS}, uso`,
        [
          ctx.empresaId,
          conversacionId,
          orden,
          turno.autor,
          turno.texto,
          turno.estado,
          turno.modelo ?? null,
          turno.uso === undefined || turno.uso === null
            ? null
            : JSON.stringify(turno.uso),
          turno.motivo ?? null,
          turno.duracionMs === undefined ? null : Math.round(turno.duracionMs),
          turno.vueltas ?? null,
          turno.clase ?? null,
          // Acotado: es para diagnosticar, no un registro de todo lo que dijo
          // el proveedor.
          turno.detalle?.slice(0, 500) ?? null,
        ],
      ),
    );
    if (guardado === undefined) {
      throw new ConflictException('No pude guardar el turno.');
    }
    return guardado;
  }
}

/** Lo que se guarda de cada forma de terminar. Respeta los CHECK de la 0050. */
function turnoDeRespuesta(r: ResultadoRespuesta): TurnoGuardado & {
  modelo: string | null;
  uso: UsoConversacion | null;
  motivo: string | null;
  clase?: ClaseDeFalla | null;
  detalle?: string | null;
} {
  switch (r.estado) {
    case 'COMPLETO':
      return {
        autor: 'ASISTENTE',
        estado: 'COMPLETO',
        texto: r.texto,
        modelo: r.modelo,
        uso: r.uso,
        motivo: null,
      };
    case 'CORTADO':
      return {
        autor: 'ASISTENTE',
        estado: 'CORTADO',
        texto: r.texto,
        modelo: r.modelo || MODELO,
        uso: r.uso,
        motivo: r.motivo,
      };
    case 'RECHAZADO':
      return {
        autor: 'ASISTENTE',
        estado: 'RECHAZADO',
        texto: '',
        modelo: r.modelo,
        uso: r.uso,
        motivo: r.motivo,
      };
    case 'FALLO':
      return {
        autor: 'ASISTENTE',
        estado: 'FALLO',
        texto: '',
        modelo: null,
        uso: null,
        motivo: r.motivo,
        clase: r.clase,
        detalle: r.detalle ?? null,
      };
  }
}

function siguienteOrden(turnos: readonly { orden: number }[]): number {
  return turnos.reduce((max, t) => Math.max(max, t.orden), 0) + 1;
}

/** El uso de la última respuesta que lo tenga: es lo que el hilo pesa de verdad. */
function ultimoUso(turnos: readonly FilaTurno[]): UsoConversacion | null {
  for (let i = turnos.length - 1; i >= 0; i -= 1) {
    if (turnos[i].autor === 'ASISTENTE' && turnos[i].uso !== null)
      return turnos[i].uso;
  }
  return null;
}

function sinUso(t: FilaTurno): TurnoResumen {
  return {
    id: t.id,
    orden: t.orden,
    autor: t.autor,
    texto: t.texto,
    estado: t.estado,
    motivo: t.motivo,
    clase: t.clase,
    creado_en: t.creado_en,
    fuentes: fuentesDe(t.herramientas ?? []),
    propuestas: (t.propuestas ?? []).map(resumenDe),
  };
}

/** Las etiquetas de lo consultado, sin repetir y sin las búsquedas de nombres. */
function fuentesDe(herramientas: readonly string[]): string[] {
  return [
    ...new Set(
      herramientas.filter((h) => h !== BUSCAR).map(etiquetaDeConsulta),
    ),
  ];
}
