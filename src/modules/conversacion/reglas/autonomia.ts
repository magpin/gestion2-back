import type { RolCodigo } from '../../../common/ctx';
import { ROLES_ACCION, type AccionPropuesta } from './propuestas';

/**
 * La autonomía del asistente (paso 8, `docs/planes/asistente-autonomia.md`).
 * Puro: sin red y sin base.
 *
 * Una regla dice que, para una acción y bajo un monto, una propuesta que pasó
 * todas las verificaciones se confirma sola. **La propuesta es la misma del
 * paso 7**: se verificó en seco con el código del endpoint, y se confirma por
 * el mismo camino. La regla solo decide si hace falta el botón.
 */

export type ModoRegla = 'SOLO_PROPONER' | 'CONFIRMAR_SI_PASA';

/** Una regla vigente de una acción. */
export interface ReglaVigente {
  id: string;
  accion: AccionPropuesta;
  modo: ModoRegla;
  limite: number | null;
  activadaPor: string;
}

/**
 * Cuántas propuestas de una acción tiene que haber confirmado una persona
 * antes de poder soltarla. Soltar lo que nadie ejercitó es soltarlo a ciegas.
 * **Se calibra con el uso del 7**: 20 es el punto de partida del plan.
 */
export const HISTORIA_MINIMA = 20;

/** Quién puede cambiar las reglas: el plan propuso DIRECTOR, y así quedó. */
export const ROLES_EDITAR: readonly RolCodigo[] = ['DIRECTOR'];

/**
 * Las guardas que ninguna regla apaga. Cuatro son del prototipo y las cumple
 * la verificación en seco del paso 7 —un cobro en un período cerrado o que no
 * cuadra no llega a ser propuesta; el asistente no crea terceros ni borra—.
 * Las otras tres las mira `decidir`.
 */
export const GUARDAS_FIJAS = [
  'Nunca registra en un período cerrado.',
  'Nunca crea un tercero.',
  'Nunca registra algo que no cuadra.',
  'Nunca borra: corregir es devolver o anular, y las dos cosas quedan.',
  'Nunca por encima del límite: uno de un peso más espera a una persona.',
  'Nunca un posible duplicado: el mismo monto al mismo documento el mismo día.',
  'Nunca si quien activó la regla ya no puede registrar eso.',
] as const;

/** Lo que decide la autonomía para una propuesta. */
export type Decision =
  | { confirmar: true; regla: ReglaVigente }
  /** `motivo`: por qué no se confirmó sola, para decirlo. Sin regla que aplique, no hay motivo. */
  | { confirmar: false; motivo: string | null };

export const pesos = (n: number): string =>
  `$ ${Math.round(n).toLocaleString('es-CO').replace(/,/g, '.')}`;

/**
 * Si una propuesta se confirma sola. En orden: la pausa general, la regla de
 * su acción, el límite, quien activó la regla, el posible duplicado.
 */
export function decidir(e: {
  accion: AccionPropuesta;
  total: number;
  pausada: boolean;
  regla: ReglaVigente | null;
  rolesDelActivador: readonly RolCodigo[];
  duplicadoPosible: boolean;
}): Decision {
  const { regla } = e;
  if (e.pausada || regla === null || regla.modo !== 'CONFIRMAR_SI_PASA') {
    return { confirmar: false, motivo: null };
  }
  if (regla.limite === null || e.total > regla.limite) {
    return {
      confirmar: false,
      motivo: `No se registró sola: supera el límite de ${pesos(regla.limite ?? 0)} de la regla. Espera tu confirmación.`,
    };
  }
  if (!e.rolesDelActivador.some((r) => ROLES_ACCION[e.accion].includes(r))) {
    return {
      confirmar: false,
      motivo:
        'No se registró sola: quien activó la regla ya no puede registrar esto. Espera tu confirmación.',
    };
  }
  if (e.duplicadoPosible) {
    return {
      confirmar: false,
      motivo:
        'No se registró sola: hoy ya se registró el mismo monto a este documento. Espera tu confirmación, por si es un duplicado.',
    };
  }
  return { confirmar: true, regla };
}

/** Los aciertos de una acción, para decidir si soltarla. */
export interface Aciertos {
  /** Confirmadas por una persona. Las que confirmó una regla no son evidencia. */
  confirmadas: number;
  /** De esas, las que se confirmaron sin corregir nada. */
  sinCorregir: number;
  /** Las que confirmó una regla. */
  automaticas: number;
}

/** Si ya hay historia para soltar la acción. */
export const hayHistoria = (a: Aciertos): boolean =>
  a.confirmadas >= HISTORIA_MINIMA;
