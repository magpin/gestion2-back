// Manda un hilo directo al `ClaudeConversador`, sin rutas ni base de datos, y
// mide cuánto cuesta un turno a medida que la conversación crece.
//
// Existe por lo mismo que `leer-documento.ts`: las pruebas del módulo corren con
// el SDK simulado, y un simulacro devuelve lo que se le pida aunque la petición
// sea inválida. Lo que ningún simulacro prueba:
//
//   - que la API acepte la petición tal como la arma el adaptador (respaldo por
//     rechazo, esfuerzo, `cache_control` de primer nivel y en las instrucciones);
//   - que el caché realmente pegue de un turno al siguiente;
//   - cuánto cuesta un turno en el 1, en el 10 y en el 30.
//
// Para no pagar treinta llamadas hasta llegar al turno 30, los turnos previos
// son un historial armado; cada punto se mide dos veces seguidas —el turno y el
// siguiente— para ver cuánto sale del caché en el segundo.
//
// Uso:
//
//   npx ts-node scripts/conversar.ts               seis llamadas: turnos 1-2, 10-11 y 30-31
//   npx ts-node scripts/conversar.ts --sin-enviar  arma la primera petición, la imprime y
//                                                  la corta. No gasta un token.
//
// Sin `--sin-enviar` gasta tokens de verdad: seis llamadas, del orden de
// centavos de dólar en total.

import 'reflect-metadata';
import 'dotenv/config';

import Anthropic from '@anthropic-ai/sdk';

import { ClaudeConversador } from '../src/modules/conversacion/proveedores/claude.conversador';
import type {
  ResultadoRespuesta,
  TurnoParaModelo,
} from '../src/modules/conversacion/proveedores/conversador.puerto';
import {
  costoUsd,
  entradaTotal,
} from '../src/modules/conversacion/reglas/conversacion.reglas';

const sinEnviar = process.argv.includes('--sin-enviar');
const CORTE_LOCAL = 'La petición no se envió: esto fue una inspección.';

/** Preguntas y respuestas con el largo de una conversación de verdad. */
const PARES: Array<[string, string]> = [
  [
    '¿Cómo registro una factura de venta a crédito?',
    'En Ventas, con «Nueva factura». Elegís el cliente, agregás los productos con su cantidad y precio, y en la forma de pago dejás «Crédito». La factura queda emitida con su saldo pendiente, y cuando el cliente pague la cobrás desde el menú de la fila, con «Cobrar». El asiento contable lo arma el sistema al emitir y otro al cobrar.',
  ],
  [
    '¿Qué pasa si el cliente me devuelve un producto?',
    'Eso es una nota crédito: baja lo que la factura vale. Desde la factura, en el menú de la fila, «Nota crédito», y elegís qué líneas y cuántas unidades vuelven. Si la factura ya estaba cobrada entera, le queda un saldo a favor al cliente, y ese saldo se le devuelve con «Devolver saldo a favor», que saca la plata de la caja o del banco.',
  ],
  [
    '¿Dónde veo cuánta plata hay en el banco?',
    'En Tesorería, en la pestaña Bancos. Cada cuenta muestra su saldo según el libro, y en Libro ves los movimientos uno por uno. Si querés compararlo con lo que dice el banco, eso es el corte diario, o la conciliación cuando subís el extracto del mes.',
  ],
  [
    '¿Qué es el 4×1000 y cómo lo registro?',
    'Es el gravamen a los movimientos financieros: el banco cobra cuatro pesos por cada mil que salen de la cuenta, y lo retiene él mismo. No se calcula en cada pago; se reconoce cuando aparece en el extracto. En Tesorería, en Reglas, creás una regla con las palabras GMF o 4X1000 y la cuenta de gasto que te indique tu contador, y al conciliar el sistema te propone registrar todas esas líneas de una vez.',
  ],
  [
    '¿Puedo anular una factura?',
    'Sí, si todavía no tiene cobros ni notas. Desde el menú de la fila, «Anular», con un motivo. La factura no se borra: queda anulada, con su número, y el sistema reversa el asiento. Si ya tiene cobros, primero hay que resolver esos cobros, o usar una nota crédito según el caso.',
  ],
];

/** El hilo de antes de medir: `pares` preguntas con su respuesta. */
function historial(pares: number): TurnoParaModelo[] {
  const hilo: TurnoParaModelo[] = [];
  for (let i = 0; i < pares; i += 1) {
    const [pregunta, respuesta] = PARES[i % PARES.length];
    hilo.push(
      { autor: 'PERSONA', texto: pregunta },
      { autor: 'ASISTENTE', texto: respuesta },
    );
  }
  return hilo;
}

class ConversadorObservado extends ClaudeConversador {
  protected crearCliente(): Anthropic {
    return new Anthropic({
      fetch: espiar,
      ...(sinEnviar ? { maxRetries: 0 } : {}),
    });
  }
}

async function espiar(
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (sinEnviar) {
    imprimirPeticion(init);
    throw new Error(CORTE_LOCAL);
  }
  const respuesta = await fetch(url, init);
  if (!respuesta.ok) {
    console.log(`\n  ── La API respondió ${respuesta.status} ──`);
    console.log((await respuesta.clone().text()).slice(0, 2000));
  }
  return respuesta;
}

/** Un resumen de la petición. `betas` no viaja en el cuerpo: es la cabecera `anthropic-beta`. */
function imprimirPeticion(init?: RequestInit): void {
  // El SDK manda el cuerpo como texto; cualquier otra cosa no se inspecciona.
  const crudo = typeof init?.body === 'string' ? init.body : '{}';
  const cuerpo = JSON.parse(crudo) as Record<string, unknown>;
  const cabeceras = new Headers(init?.headers);
  const system = cuerpo.system as Array<{
    text: string;
    cache_control?: unknown;
  }>;
  const messages = cuerpo.messages as unknown[];
  console.log('  Lo que sale:');
  console.log(`    anthropic-beta   ${cabeceras.get('anthropic-beta')}`);
  for (const campo of [
    'model',
    'max_tokens',
    'fallbacks',
    'thinking',
    'output_config',
    'cache_control',
  ]) {
    console.log(`    ${campo.padEnd(16)} ${JSON.stringify(cuerpo[campo])}`);
  }
  console.log(
    `    system           ${system.length} bloque, ${system[0].text.length} caracteres, cache_control ${JSON.stringify(system[0].cache_control)}`,
  );
  console.log(`    messages         ${messages.length}`);
}

interface Fila {
  turno: number;
  resultado: ResultadoRespuesta;
  ms: number;
}

async function medir(
  conversador: ClaudeConversador,
  hilo: TurnoParaModelo[],
  turno: number,
): Promise<Fila> {
  const empezo = Date.now();
  const resultado = await conversador.responder({ hilo });
  return { turno, resultado, ms: Date.now() - empezo };
}

function imprimirFila({ turno, resultado, ms }: Fila): void {
  if (resultado.estado === 'FALLO') {
    console.log(
      `  turno ${String(turno).padStart(2)}  FALLO ${resultado.clase}: ${resultado.motivo}`,
    );
    return;
  }
  const uso = resultado.uso;
  if (uso === null) {
    console.log(
      `  turno ${String(turno).padStart(2)}  ${resultado.estado} sin uso`,
    );
    return;
  }
  console.log(
    `  turno ${String(turno).padStart(2)}  ${resultado.estado.padEnd(9)} ${resultado.modelo.padEnd(16)}` +
      ` entrada ${String(uso.entrada).padStart(5)}  caché escrito ${String(uso.cacheEscrito).padStart(6)}` +
      `  caché leído ${String(uso.cacheLeido).padStart(6)}  total ${String(entradaTotal(uso)).padStart(6)}` +
      `  salida ${String(uso.salida).padStart(5)}  ${(ms / 1000).toFixed(1)} s  US$ ${costoUsd(uso).toFixed(4)}`,
  );
}

(async () => {
  const conversador = new ConversadorObservado();

  if (sinEnviar) {
    const r = await conversador.responder({
      hilo: [
        ...historial(0),
        { autor: 'PERSONA', texto: '¿Cómo registro una compra?' },
      ],
    });
    console.log(
      `\n  Cortado antes de salir (${r.estado}). No se gastó ningún token.`,
    );
    return;
  }

  let total = 0;
  for (const previos of [0, 9, 29]) {
    const hilo = [
      ...historial(previos),
      {
        autor: 'PERSONA' as const,
        texto: '¿Cómo registro una compra a un proveedor?',
      },
    ];
    const primera = await medir(conversador, hilo, previos + 1);
    imprimirFila(primera);

    // El turno siguiente, sobre el mismo hilo más la respuesta real: es el que
    // tiene que leer del caché todo lo anterior.
    const respuesta =
      primera.resultado.estado === 'COMPLETO'
        ? primera.resultado.texto
        : '(sin respuesta)';
    const siguiente = await medir(
      conversador,
      [
        ...hilo,
        { autor: 'ASISTENTE', texto: respuesta },
        {
          autor: 'PERSONA',
          texto: '¿Y si la compra tiene retención en la fuente?',
        },
      ],
      previos + 2,
    );
    imprimirFila(siguiente);

    for (const f of [primera, siguiente]) {
      if (f.resultado.estado !== 'FALLO' && f.resultado.uso)
        total += costoUsd(f.resultado.uso);
    }
    if (previos === 0 && primera.resultado.estado === 'COMPLETO') {
      console.log(
        `\n  Primera respuesta, para ver el tono:\n  ${primera.resultado.texto.replace(/\n/g, '\n  ')}\n`,
      );
    }
  }
  console.log(
    `\n  Seis llamadas: US$ ${total.toFixed(4)} en total, con las tarifas de conversacion.reglas.ts.`,
  );
})().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
