import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';

import type { CtxEmpresa } from '../../../common/ctx';
import { fila, filas } from '../../../common/db/filas';
import { TxService, type Tx } from '../../../common/db/tx.service';
import {
  CONVERSADOR,
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

/** Un turno, como lo ve la pantalla. El uso de tokens queda en la base: es del expediente, no de la conversación. */
export interface TurnoResumen {
  id: string;
  orden: number;
  autor: 'PERSONA' | 'ASISTENTE';
  texto: string;
  estado: 'COMPLETO' | 'CORTADO' | 'RECHAZADO' | 'FALLO';
  motivo: string | null;
  creado_en: string;
}

export interface ConversacionVigente {
  /** `null` si la persona todavía no conversó, o si archivó la anterior. */
  id: string | null;
  turnos: TurnoResumen[];
  /** El hilo ya pesa el tope: la pantalla ofrece empezar otra en vez de dejar escribir. */
  superaTope: boolean;
}

/** Lo que devuelve preparar un turno: con esto se llama al modelo, fuera de la transacción. */
export interface TurnoPreparado {
  conversacionId: string;
  pregunta: TurnoResumen;
  hilo: ReturnType<typeof hiloParaModelo>;
}

const CAMPOS = `id, orden, autor, texto, estado, motivo, creado_en`;

interface FilaTurno extends TurnoResumen {
  uso: UsoConversacion | null;
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
   * recibe cada pedazo en vivo; `corte` es la persona cerrando la pestaña.
   * Siempre libera la conversación, aunque falle el guardado.
   */
  async responder(
    ctx: CtxEmpresa,
    preparado: TurnoPreparado,
    opciones: {
      alEscribir?: (trozo: string) => void;
      corte?: AbortSignal;
    } = {},
  ): Promise<TurnoResumen> {
    try {
      const resultado = await this.conversador.responder({
        hilo: preparado.hilo,
        alEscribir: opciones.alEscribir,
        corte: opciones.corte,
      });
      return await this.tx.enContexto(ctx, async (t) => {
        const turnos = await this.turnos(preparado.conversacionId, t);
        const guardado = await this.insertarTurno(
          ctx,
          preparado.conversacionId,
          siguienteOrden(turnos),
          turnoDeRespuesta(resultado),
          t,
        );
        return sinUso(guardado);
      });
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
        `SELECT ${CAMPOS}, uso FROM conversacion_turno
          WHERE conversacion_id = $1 ORDER BY orden`,
        [conversacionId],
      ),
    );
  }

  private async insertarTurno(
    ctx: CtxEmpresa,
    conversacionId: string,
    orden: number,
    turno: TurnoGuardado & {
      modelo?: string | null;
      uso?: UsoConversacion | null;
      motivo?: string | null;
    },
    t: Tx,
  ): Promise<FilaTurno> {
    const guardado = fila<FilaTurno>(
      await t.query(
        `INSERT INTO conversacion_turno
           (empresa_id, conversacion_id, orden, autor, texto, estado, modelo, uso, motivo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    creado_en: t.creado_en,
  };
}
