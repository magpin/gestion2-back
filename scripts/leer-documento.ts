// Manda un documento del disco directo al `ClaudeProveedor`. Sin MinIO, sin
// endpoints y sin base de datos.
//
// Existe porque las 73 pruebas de `lectura-documentos` corren **con el proveedor
// simulado, sin red**. Eso es deliberado —es lo que hace que el módulo se pueda
// probar sin gastar tokens— pero significa que lo verificado es el catálogo de
// campos, el descarte y la traducción de errores. Lo que ningún simulacro puede
// haber probado es **la petición misma**: un simulacro devuelve lo que se le
// pida aunque el cuerpo que se armó sea inválido.
//
// Lo que este script separa, y que hoy nadie separa:
//
//   - que el `json_schema` de `ESQUEMA` lo acepte la API;
//   - que `betas: server-side-fallback-2026-07-01` con `fallbacks: 'default'`
//     sean parámetros válidos;
//   - que `output_config.format` y `thinking: adaptive` convivan;
//   - que el `cache_control` de las instrucciones realmente pegue caché.
//
// Si alguna está mal, en la aplicación vuelve como `BadRequestError` → clase
// `ILEGIBLE` → «No pude leer ese archivo. Puede estar dañado o ser muy grande.»
// Un mensaje que **culpa al documento cuando el problema es la llamada**. Acá el
// rechazo se imprime crudo, con el cuerpo que devolvió la API.
//
// Uso:
//
//   npx ts-node scripts/leer-documento.ts <archivo> [tipo] [--dos-veces]
//
//   tipo: RUT (por defecto), CAMARA_COMERCIO, RESOLUCION_DIAN
//   --dos-veces:  lee dos veces el mismo archivo para medir el caché del prompt.
//   --sin-enviar: arma la petición, la imprime y la corta antes de salir. No
//                 gasta un token. Es lo que se usa para revisar la forma de la
//                 llamada después de tocar `claude.proveedor.ts`.
//
// Sin `--sin-enviar` gasta tokens de verdad. Una lectura, una factura.

import 'reflect-metadata';
import 'dotenv/config';

import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { ClaudeProveedor } from '../src/modules/lectura-documentos/proveedores/claude.proveedor';
import type {
  ResultadoLectura,
  TipoDocumentoConfiguracion,
} from '../src/modules/lectura-documentos/proveedores/extractor.puerto';

/**
 * Tarifas de `claude-opus-5` por millón de tokens, para poder decir en pesos lo
 * que cuesta leer un documento. Son del catálogo público: si cambian, esta
 * cuenta queda vieja y el número de tokens de arriba sigue siendo cierto.
 */
const USD_POR_MILLON = { entrada: 5, salida: 25, cache: 0.5 };

const EXTENSIONES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

const TIPOS: Record<string, TipoDocumentoConfiguracion> = {
  RUT: 'RUT',
  CAMARA: 'CAMARA_COMERCIO',
  CAMARA_COMERCIO: 'CAMARA_COMERCIO',
  RESOLUCION: 'RESOLUCION_DIAN',
  RESOLUCION_DIAN: 'RESOLUCION_DIAN',
};

/** Lo que vio pasar el espía. Se imprime aunque la lectura salga bien. */
let rechazoDeLaApi = false;

/** `--sin-enviar`: se arma la petición, se imprime y se corta ahí. */
let sinEnviar = false;

/** El corte de `--sin-enviar`, para reconocerlo cuando vuelva traducido. */
const CORTE_LOCAL = 'La petición no se envió: esto fue una inspección.';

/**
 * El mismo proveedor que usa la aplicación —la petición que se prueba es la que
 * corre en producción, no una copia— con un `fetch` que cuenta lo que sale y lo
 * que vuelve.
 */
class ProveedorObservado extends ClaudeProveedor {
  protected crearCliente(): Anthropic {
    // Sin reintentos cuando no se envía: si no, el SDK vuelve a intentar el
    // corte dos veces y la misma petición se imprime tres veces.
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
  contarLaPeticion(init);

  if (sinEnviar) throw new Error(CORTE_LOCAL);

  const respuesta = await fetch(url, init);

  if (!respuesta.ok) {
    rechazoDeLaApi = true;
    const copia = respuesta.clone();
    console.log('');
    console.log(`  ── La API respondió ${respuesta.status} ──`);
    console.log(recortar(await copia.text(), 2000));
    console.log('');
  }

  return respuesta;
}

/**
 * Un resumen del cuerpo, **nunca el cuerpo**: adentro viaja el documento en
 * base64 y son megabytes. Lo que interesa son los parámetros que nadie ha
 * probado, y el tamaño de lo que se manda.
 *
 * Las cabeceras se imprimen aparte porque **`betas` no viaja en el cuerpo**: el
 * SDK lo convierte en `anthropic-beta`. Buscarlo en el JSON da `undefined` y
 * parece que no se mandó.
 */
function contarLaPeticion(init?: RequestInit): void {
  const crudo = typeof init?.body === 'string' ? init.body : undefined;
  if (crudo === undefined) return;

  let cuerpo: Record<string, unknown>;
  try {
    cuerpo = JSON.parse(crudo) as Record<string, unknown>;
  } catch {
    return;
  }

  console.log('  Lo que sale:');
  console.log(`    anthropic-beta   ${cabecera(init, 'anthropic-beta')}`);
  console.log(`    model            ${JSON.stringify(cuerpo.model)}`);
  console.log(`    max_tokens       ${JSON.stringify(cuerpo.max_tokens)}`);
  console.log(`    fallbacks        ${JSON.stringify(cuerpo.fallbacks)}`);
  console.log(`    thinking         ${JSON.stringify(cuerpo.thinking)}`);
  console.log(`    output_config    ${resumirEsquema(cuerpo.output_config)}`);
  console.log(`    system           ${resumirSistema(cuerpo.system)}`);
  console.log(`    contenido        ${resumirContenido(cuerpo.messages)}`);
  console.log(
    `    cuerpo entero    ${(crudo.length / 1_048_576).toFixed(2)} MB`,
  );
  console.log('');
}

/** Las cabeceras llegan como `Headers`, como lista de pares o como objeto. */
function cabecera(init: RequestInit | undefined, nombre: string): string {
  const cabeceras = init?.headers;
  if (cabeceras === undefined) return 'sin cabeceras';

  if (cabeceras instanceof Headers) return cabeceras.get(nombre) ?? 'no está';

  const pares = Array.isArray(cabeceras)
    ? cabeceras
    : Object.entries(cabeceras);
  const par = pares.find(
    ([clave]) => clave.toLowerCase() === nombre.toLowerCase(),
  );
  return par?.[1] ?? 'no está';
}

function resumirEsquema(valor: unknown): string {
  const config = valor as
    { format?: { type?: string; schema?: unknown } } | undefined;
  const formato = config?.format;
  if (formato === undefined) return 'sin formato';
  const campos = (
    formato.schema as
      | { properties?: { datos?: { items?: { properties?: object } } } }
      | undefined
  )?.properties?.datos?.items?.properties;
  const llaves = campos ? Object.keys(campos).join(', ') : 'sin propiedades';
  return `${formato.type} · cada dato lleva { ${llaves} }`;
}

function resumirSistema(valor: unknown): string {
  const bloques = valor as
    { text?: string; cache_control?: unknown }[] | undefined;
  if (!Array.isArray(bloques)) return 'texto suelto, sin cache_control';
  return bloques
    .map((b) => {
      const caracteres = (b.text ?? '').length;
      const cache = b.cache_control ? 'con cache_control' : 'sin cache_control';
      return `${caracteres} caracteres, ${cache}`;
    })
    .join(' | ');
}

function resumirContenido(valor: unknown): string {
  const mensajes = valor as { content?: unknown }[] | undefined;
  const bloques = mensajes?.[0]?.content;
  if (!Array.isArray(bloques)) return 'un texto';
  return bloques
    .map((b: { type?: string; source?: { data?: string } }) => {
      const datos = b.source?.data;
      if (typeof datos === 'string') {
        return `${b.type} (${(datos.length / 1_048_576).toFixed(2)} MB en base64)`;
      }
      return String(b.type);
    })
    .join(' + ');
}

async function main(): Promise<number> {
  const argumentos = process.argv.slice(2);
  const dosVeces = argumentos.includes('--dos-veces');
  sinEnviar = argumentos.includes('--sin-enviar');
  const [ruta, tipoPedido = 'RUT'] = argumentos.filter(
    (a) => !a.startsWith('--'),
  );

  if (ruta === undefined) {
    console.log(
      'Uso: npx ts-node scripts/leer-documento.ts <archivo> [RUT|CAMARA_COMERCIO|RESOLUCION_DIAN] [--dos-veces]',
    );
    return 2;
  }

  const tipo = TIPOS[tipoPedido.toUpperCase()];
  if (tipo === undefined) {
    console.log(`No conozco el tipo "${tipoPedido}".`);
    console.log('Son: RUT, CAMARA_COMERCIO, RESOLUCION_DIAN.');
    return 2;
  }

  const tipoMime = EXTENSIONES.get(extname(ruta).toLowerCase());
  if (tipoMime === undefined) {
    console.log(
      `No sé qué es "${extname(ruta)}". Subí un PDF, un JPG o un PNG.`,
    );
    return 2;
  }

  let contenido: Buffer;
  try {
    contenido = readFileSync(ruta);
  } catch (error) {
    console.log(`No pude abrir ${ruta}: ${(error as Error).message}`);
    return 2;
  }

  const megas = statSync(ruta).size / 1_048_576;

  const clave = process.env.ANTHROPIC_API_KEY ?? '';
  console.log('');
  console.log(`  Archivo   ${ruta} · ${megas.toFixed(2)} MB · ${tipoMime}`);
  console.log(`  Tipo      ${tipo}`);
  console.log(
    `  Clave     ${clave === '' ? 'SIN PONER' : `puesta, termina en …${clave.slice(-4)}`}`,
  );
  console.log('');

  if (clave === '') {
    console.log(
      'Sin `ANTHROPIC_API_KEY` en el ambiente no hay nada que probar.',
    );
    return 2;
  }

  // El base64 infla un tercio, y el límite de la API es 32 MB de petición.
  if (megas * 1.37 > 30) {
    console.log(
      'Ese archivo pasa el límite de la petición. Va a volver como ILEGIBLE, y esta vez sí sería culpa del documento.',
    );
    return 2;
  }

  const proveedor = new ProveedorObservado();
  const vueltas = dosVeces ? 2 : 1;
  let ultimo: ResultadoLectura | undefined;

  for (let vuelta = 1; vuelta <= vueltas; vuelta += 1) {
    if (vueltas > 1) {
      console.log(`  ══ Lectura ${vuelta} de ${vueltas} ══`);
      console.log('');
    }

    const empezo = Date.now();
    ultimo = await proveedor.leer({
      tipo,
      archivo: { tipoMime, contenido },
      alAvanzar: (avance) => {
        console.log(`  · ${avance.etapa.padEnd(10)} ${avance.mensaje}`);
      },
    });

    console.log('');
    contar(ultimo, Date.now() - empezo, vuelta);
    console.log('');
  }

  if (sinEnviar) return 0;
  return ultimo?.leido === true ? 0 : 1;
}

function contar(
  resultado: ResultadoLectura,
  milisegundos: number,
  vuelta: number,
): void {
  if (!resultado.leido) {
    if (sinEnviar) {
      console.log(`  ${CORTE_LOCAL}`);
      console.log('  Arriba está lo que habría salido. No se gastó un token.');
      return;
    }

    console.log(`  NO SE LEYÓ · ${resultado.clase}`);
    console.log(`  Lo que vería la persona: «${resultado.motivo}»`);
    console.log('');

    if (rechazoDeLaApi) {
      console.log(
        '  El cuerpo de la petición es el problema, no el documento. Lo que la',
      );
      console.log(
        '  pantalla diría es mentira: mirá el rechazo de arriba y arreglá',
      );
      console.log('  `claude.proveedor.ts` antes de tocar el 6d.');
    } else {
      console.log(
        '  La API aceptó la petición: la falla es de la lectura, no de la llamada.',
      );
    }
    return;
  }

  console.log(
    `  ${resultado.datos.length} datos en ${(milisegundos / 1000).toFixed(1)} s`,
  );
  console.log('');

  for (const dato of resultado.datos) {
    const casilla = dato.fuente.casilla ?? '—';
    console.log(
      `  ${dato.confianza.padEnd(7)} ${dato.campo.padEnd(26)} ${formatear(dato.valor)}`,
    );
    console.log(
      `  ${''.padEnd(7)} ${`casilla ${casilla}`.padEnd(26)} → paso ${dato.paso} · «${dato.etiqueta}»`,
    );
  }

  const { entrada, salida, cacheLeido } = resultado.medicion.uso;
  const dolares =
    ((entrada - cacheLeido) * USD_POR_MILLON.entrada +
      cacheLeido * USD_POR_MILLON.cache +
      salida * USD_POR_MILLON.salida) /
    1_000_000;

  console.log('');
  console.log(
    `  Tokens: ${entrada} de entrada (${cacheLeido} del caché), ${salida} de salida · ~US$ ${dolares.toFixed(4)}`,
  );

  if (vuelta > 1) {
    console.log(
      cacheLeido > 0
        ? '  El `cache_control` de las instrucciones pega: la segunda lectura no las repagó.'
        : '  El caché NO pegó. Las instrucciones se pagan enteras en cada lectura.',
    );
  }
}

function formatear(valor: unknown): string {
  if (Array.isArray(valor)) return valor.join(', ');
  if (typeof valor === 'string') return valor;
  return JSON.stringify(valor);
}

function recortar(texto: string, tope: number): string {
  return texto.length > tope ? `${texto.slice(0, tope)}…` : texto;
}

main()
  .then((codigo) => process.exit(codigo))
  .catch((error: unknown) => {
    // Lo que llegue acá se escapó del proveedor, que traduce todo lo suyo. Va
    // entero: en un script de diagnóstico esconder la pila no ayuda a nadie.
    console.error(error);
    process.exit(1);
  });
