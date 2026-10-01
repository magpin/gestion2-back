import type { RolCodigo } from '../../../common/ctx';
import type { Herramienta } from './herramientas';

/**
 * Las propuestas del asistente (paso 7, `docs/planes/asistente-acciones.md`).
 * Puro: sin red y sin base.
 *
 * El asistente **propone** un cobro o un pago y una persona lo confirma. Las
 * herramientas de acá no registran nada: arman el cuerpo, que se verifica en
 * seco y queda como propuesta.
 */

export type AccionPropuesta = 'COBRO' | 'PAGO';

/**
 * Quién puede confirmar cada acción: **los roles del endpoint que la hace**,
 * copiados de los controladores (`facturas/:id/cobrar` y `compras/:id/pagar`,
 * los dos `@Roles('CAJA', 'DIRECTOR')`). Una prueba lee los controladores y
 * avisa si cambian. El asistente solo recibe la herramienta si el rol la puede
 * confirmar: no tiene sentido proponer lo que quien pregunta no puede hacer.
 */
export const ROLES_ACCION: Readonly<
  Record<AccionPropuesta, readonly RolCodigo[]>
> = {
  COBRO: ['CAJA', 'DIRECTOR'],
  PAGO: ['CAJA', 'DIRECTOR'],
};

/** Las propuestas por turno. «Cobrá estas tres» son tres; veinte no se revisan. */
export const PROPUESTAS_POR_TURNO = 5;

export const PROPONER_COBRO = 'proponer_cobro';
export const PROPONER_PAGO = 'proponer_pago';

export const puedeHacer = (
  roles: readonly RolCodigo[],
  accion: AccionPropuesta,
): boolean => roles.some((r) => ROLES_ACCION[accion].includes(r));

/** La acción de una herramienta de proponer, o `undefined` si no es una. */
export function accionDeHerramienta(
  nombre: string,
): AccionPropuesta | undefined {
  if (nombre === PROPONER_COBRO) return 'COBRO';
  if (nombre === PROPONER_PAGO) return 'PAGO';
  return undefined;
}

const PAGOS = {
  type: 'array',
  minItems: 1,
  description:
    'De dónde entra o sale el dinero. Un renglón por caja o cuenta; varios si se reparte.',
  items: {
    type: 'object',
    properties: {
      medio: { type: 'string', enum: ['CAJA', 'BANCO'] },
      id: {
        type: 'string',
        description:
          'El id de la caja o de la cuenta bancaria, tal como sale en consultar_saldos.',
      },
      valor: { type: 'number', description: 'En pesos, hasta dos decimales.' },
    },
    required: ['medio', 'id', 'valor'],
  },
};

const FECHA = {
  type: 'string',
  description: 'aaaa-mm-dd. Opcional: sin fecha es hoy.',
};

const NO_REGISTRA = `No registra nada: se verifica en seco y queda como propuesta, con un botón Confirmar para la persona. Si la verificación falla, le dice por qué.`;

/** Las herramientas de proponer que el rol puede confirmar. */
export function herramientasDeAccion(
  roles: readonly RolCodigo[],
): Herramienta[] {
  const lista: Herramienta[] = [];
  if (puedeHacer(roles, 'COBRO')) {
    lista.push({
      name: PROPONER_COBRO,
      description: `Arma el cobro de una factura de venta para que la persona lo confirme. ${NO_REGISTRA} Necesita el número de la factura como sale en la cartera («SETT-5») y el id de la caja o la cuenta de consultar_saldos. Hasta ${PROPUESTAS_POR_TURNO} por turno.`,
      input_schema: {
        type: 'object',
        properties: {
          factura: {
            type: 'string',
            description: 'El número, como sale en la cartera.',
          },
          fecha: FECHA,
          pagos: PAGOS,
        },
        required: ['factura', 'pagos'],
      },
    });
  }
  if (puedeHacer(roles, 'PAGO')) {
    lista.push({
      name: PROPONER_PAGO,
      description: `Arma el pago de una compra a un proveedor para que la persona lo confirme. ${NO_REGISTRA} Necesita el número de la factura del proveedor, como sale en las compras, y el id de la caja o la cuenta de consultar_saldos. Hasta ${PROPUESTAS_POR_TURNO} por turno.`,
      input_schema: {
        type: 'object',
        properties: {
          compra: {
            type: 'string',
            description: 'El número de la factura del proveedor.',
          },
          proveedor: {
            type: 'string',
            description:
              'Parte del nombre del proveedor. Hace falta si dos proveedores usan el mismo número.',
          },
          fecha: FECHA,
          pagos: PAGOS,
        },
        required: ['compra', 'pagos'],
      },
    });
  }
  return lista;
}

/** Un renglón de pago como lo esperan `CobrarDto` y `PagarDto`. */
export interface MedioDelCuerpo {
  medio: 'CAJA' | 'BANCO';
  cajaId?: string;
  cuentaBancariaId?: string;
  valor: number;
}

/** El cuerpo de un cobro o un pago: el mismo de los endpoints. */
export interface CuerpoDePago {
  fecha: string;
  pagos: MedioDelCuerpo[];
}

const esObjeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Lo que pidió el modelo, como el cuerpo que manda la pantalla. **No
 * valida**: eso lo hacen las clases de los DTO de siempre. Solo traduce el
 * `id` de cada renglón al campo que corresponde a su medio, y pone hoy si no
 * hay fecha.
 */
export function cuerpoDesde(entrada: unknown, hoy: string): CuerpoDePago {
  const e = esObjeto(entrada) ? entrada : {};
  const pagos = Array.isArray(e.pagos) ? e.pagos.filter(esObjeto) : [];
  return {
    fecha: typeof e.fecha === 'string' ? e.fecha : hoy,
    pagos: pagos.map((p) => {
      const id = typeof p.id === 'string' ? p.id : '';
      const medio = p.medio === 'BANCO' ? 'BANCO' : 'CAJA';
      return {
        medio,
        ...(medio === 'CAJA' ? { cajaId: id } : { cuentaBancariaId: id }),
        valor: typeof p.valor === 'number' ? p.valor : Number(p.valor),
      };
    }),
  };
}

/** Lo que dice la pantalla de una acción. */
export const NOMBRE_ACCION: Record<AccionPropuesta, string> = {
  COBRO: 'Cobro',
  PAGO: 'Pago',
};
