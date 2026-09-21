// Punta a punta de la conversación con el asistente (paso 4d de
// `docs/planes/asistente-conversacion.md`), contra la API corriendo y el
// modelo de verdad. **Gasta plata**: trece llamadas, unos US$ 0,10
// (medido el 21 sep 2026: 0,091).
//
// Recorre lo que ninguna prueba con simulacros ve:
// - diez turnos seguidos, con la respuesta llegando en pedazos;
// - el historial guardado en orden, y que otra persona no lo ve;
// - dos preguntas a la vez: una pasa, la otra rebota con 409;
// - cerrar la conexión a mitad: el turno queda CORTADO con lo que alcanzó, y
//   la conversación sigue;
// - el costo de cada turno, leído de la base, contra lo medido en la 4b.
//
// El rechazo no se puede provocar a pedido contra el modelo real: lo cubren
// las pruebas del adaptador y del servicio, y los CHECK de la 0050.
//
// Usa los usuarios que siembra `sembrar.js`. La contraseña va por argumento.
//
// Uso:
//   node scripts/prueba-conversacion.js --password "la-del-seed"
require('dotenv').config();
const { Client } = require('pg');
const { BASE, pedir, entrar } = require('./lib/api');

const argumento = (nombre) => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

let pasadas = 0;
let fallidas = 0;
const revisar = (cond, que, detalle = '') => {
  if (cond) {
    pasadas += 1;
    console.log(`  OK    ${que}`);
  } else {
    fallidas += 1;
    console.log(`  FALLA ${que}${detalle ? ' -> ' + detalle : ''}`);
  }
};

const PREGUNTAS = [
  '¿Cómo registro una compra a un proveedor?',
  '¿Y cómo le pago esa compra?',
  '¿Dónde veo lo que me deben los clientes?',
  '¿Cómo anulo una factura de venta que hice mal?',
  '¿Qué es la retención en la fuente, en dos líneas?',
  '¿Dónde concilio el banco?',
  '¿Puedo cargar el extracto del banco en Excel?',
  '¿Cómo creo un producto nuevo?',
  '¿Quién puede cerrar un período?',
  'Gracias. ¿Me resumís en una línea lo que hablamos?',
];

/**
 * Manda una pregunta y lee los eventos a medida que llegan. `cortarAlPrimerTrozo`
 * cierra la conexión apenas llega el primer pedazo, como quien cierra la pestaña.
 */
async function preguntar(token, texto, { cortarAlPrimerTrozo = false } = {}) {
  const corte = new AbortController();
  const inicio = Date.now();
  const res = await fetch(`${BASE}/conversacion/turnos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ texto }),
    signal: corte.signal,
  });
  if (res.status !== 200) {
    return { estado: res.status, cuerpo: await res.text(), eventos: [] };
  }
  const eventos = [];
  let primerTrozoMs = null;
  const lector = res.body.getReader();
  const decodificador = new TextDecoder();
  let pendiente = '';
  try {
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      pendiente += decodificador.decode(value, { stream: true });
      let fin;
      while ((fin = pendiente.indexOf('\n\n')) >= 0) {
        const bloque = pendiente.slice(0, fin);
        pendiente = pendiente.slice(fin + 2);
        if (!bloque.startsWith('data: ')) continue;
        const evento = JSON.parse(bloque.slice(6));
        eventos.push(evento);
        if (evento.tipo === 'TROZO' && primerTrozoMs === null) {
          primerTrozoMs = Date.now() - inicio;
          if (cortarAlPrimerTrozo) {
            corte.abort();
            return { estado: 200, eventos, primerTrozoMs, totalMs: Date.now() - inicio };
          }
        }
      }
    }
  } catch (error) {
    if (!cortarAlPrimerTrozo) throw error;
  }
  return { estado: 200, eventos, primerTrozoMs, totalMs: Date.now() - inicio };
}

const fin = (r) => r.eventos.find((e) => e.tipo === 'FIN');
const texto = (r) =>
  r.eventos
    .filter((e) => e.tipo === 'TROZO')
    .map((e) => e.texto)
    .join('');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const password = argumento('password');
  if (!password) {
    console.error('Falta --password: la de los usuarios que sembró sembrar.js.');
    process.exit(2);
  }

  // La primera empresa de quien vende; el contador entra a la misma.
  const login = await pedir('POST', '/auth/login', { cuerpo: { email: 'ventas@demo.co', password } });
  if (!login.datos?.empresas?.length) throw new Error(`Login falló (${login.estado}): ${JSON.stringify(login.datos)}`);
  const ventas = await entrar('ventas@demo.co', password, login.datos.empresas[0].id);
  const contador = await entrar('contador@demo.co', password, ventas.empresa.id);

  console.log('\nAntes de empezar');
  const disponible = await pedir('GET', '/conversacion/disponible', { token: ventas.token });
  revisar(disponible.datos?.disponible === true, 'el asistente está disponible (hay clave)');
  revisar((await pedir('POST', '/conversacion/nueva', { token: ventas.token })).estado === 204, 'empezar de nuevo: 204');
  const vacia = await pedir('GET', '/conversacion', { token: ventas.token });
  revisar(vacia.datos?.id === null && vacia.datos?.turnos.length === 0, 'la vigente arranca vacía');
  revisar((await pedir('POST', '/conversacion/turnos', { token: ventas.token, cuerpo: { texto: '' } })).estado === 400, 'pregunta vacía: 400');
  revisar(
    (await pedir('POST', '/conversacion/turnos', { token: ventas.token, cuerpo: { texto: 'x'.repeat(8001) } })).estado === 400,
    'pregunta de 8.001 caracteres: 400',
  );

  console.log('\nDiez turnos');
  const tiempos = [];
  for (const [i, pregunta] of PREGUNTAS.entries()) {
    const r = await preguntar(ventas.token, pregunta);
    const f = fin(r);
    const trozos = r.eventos.filter((e) => e.tipo === 'TROZO').length;
    tiempos.push(r);
    revisar(
      r.estado === 200 && r.eventos[0]?.tipo === 'PREGUNTA' && f?.turno.estado === 'COMPLETO' && trozos > 1 && texto(r) === f.turno.texto,
      `turno ${i + 1}: PREGUNTA, ${trozos} pedazos, FIN COMPLETO · primer pedazo ${r.primerTrozoMs} ms, total ${r.totalMs} ms`,
      JSON.stringify({ estado: r.estado, fin: f, cuerpo: r.cuerpo }),
    );
  }
  console.log(`\n  Pregunta 1: ${PREGUNTAS[0]}\n  Respuesta: ${fin(tiempos[0])?.turno.texto}`);
  console.log(`\n  Pregunta 10: ${PREGUNTAS[9]}\n  Respuesta: ${fin(tiempos[9])?.turno.texto}\n`);

  console.log('El historial');
  const hilo = await pedir('GET', '/conversacion', { token: ventas.token });
  const turnos = hilo.datos?.turnos ?? [];
  revisar(turnos.length === 20, `20 turnos guardados (${turnos.length})`);
  revisar(
    turnos.every((t, i) => t.orden === i + 1 && t.autor === (i % 2 === 0 ? 'PERSONA' : 'ASISTENTE')),
    'en orden 1..20, alternando persona y asistente',
  );
  revisar(turnos.every((t) => !('uso' in t)), 'el uso de tokens no viaja a la pantalla');
  revisar(hilo.datos?.superaTope === false, 'lejos del tope');
  const ajena = await pedir('GET', '/conversacion', { token: contador.token });
  revisar(
    ajena.estado === 200 && ajena.datos.id !== hilo.datos.id && !ajena.datos.turnos.some((t) => turnos.some((u) => u.id === t.id)),
    'otra persona de la misma empresa no ve esta conversación',
  );

  console.log('\nDos preguntas a la vez');
  const [a, b] = await Promise.all([
    preguntar(ventas.token, '¿Dónde veo el inventario?'),
    esperar(150).then(() => preguntar(ventas.token, '¿Y el kardex?')),
  ]);
  const estados = [a.estado, b.estado].sort();
  revisar(estados[0] === 200 && estados[1] === 409, `una pasa y la otra rebota (${a.estado}, ${b.estado})`);

  console.log('\nCerrar a mitad');
  const cortada = await preguntar(ventas.token, 'Explicame paso a paso cómo hago un cierre de mes completo.', { cortarAlPrimerTrozo: true });
  revisar(cortada.estado === 200 && cortada.primerTrozoMs !== null, `llegó el primer pedazo (${cortada.primerTrozoMs} ms) y se cortó`);
  let ultimo;
  for (let i = 0; i < 20; i += 1) {
    await esperar(500);
    const h = await pedir('GET', '/conversacion', { token: ventas.token });
    ultimo = h.datos.turnos.at(-1);
    if (ultimo.autor === 'ASISTENTE') break;
  }
  revisar(ultimo?.estado === 'CORTADO', `el turno quedó CORTADO (${ultimo?.estado})`);
  revisar(
    typeof ultimo?.texto === 'string' && ultimo.texto.startsWith(texto(cortada)),
    `con lo que alcanzó a escribirse (${ultimo?.texto.length ?? 0} caracteres)`,
  );
  const despues = await preguntar(ventas.token, 'Perdón, se me cerró. ¿Por dónde arranco el cierre?');
  revisar(fin(despues)?.turno.estado === 'COMPLETO', 'la conversación sigue después del corte');

  console.log('\nEl costo, leído de la base');
  const db = new Client({
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    const { rows: emp } = await db.query('SELECT tenant_id FROM empresa WHERE id = $1', [ventas.empresa.id]);
    await db.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.empresa_id', $2, true)`, [emp[0].tenant_id, ventas.empresa.id]);
    const { rows } = await db.query(
      `SELECT t.orden, t.estado, t.modelo, t.uso FROM conversacion_turno t
         JOIN conversacion c ON c.id = t.conversacion_id
        WHERE c.id = $1 AND t.autor = 'ASISTENTE' ORDER BY t.orden`,
      [hilo.datos.id],
    );
    await db.query('COMMIT');
    const precio = (u) => (u.entrada * 5 + u.salida * 25 + u.cacheEscrito * 6.25 + u.cacheLeido * 0.5) / 1e6;
    let total = 0;
    console.log('  Turno | Estado    | Entrada total | Del caché | Salida | US$');
    for (const r of rows) {
      if (!r.uso) {
        console.log(`  ${String(r.orden).padStart(5)} | ${r.estado.padEnd(9)} | sin uso (cortado antes del final)`);
        continue;
      }
      const u = r.uso;
      const costo = precio(u);
      total += costo;
      console.log(
        `  ${String(r.orden).padStart(5)} | ${r.estado.padEnd(9)} | ${String(u.entrada + u.cacheEscrito + u.cacheLeido).padStart(13)} | ${String(u.cacheLeido).padStart(9)} | ${String(u.salida).padStart(6)} | ${costo.toFixed(4)}`,
      );
    }
    console.log(`  Total: US$ ${total.toFixed(3)}`);
    const conUso = rows.filter((r) => r.uso);
    revisar(conUso.every((r) => r.modelo === 'claude-opus-5'), 'todas con el modelo guardado');
    revisar(conUso.slice(1).every((r) => r.uso.cacheLeido > 2000), 'desde el segundo turno, casi todo sale del caché');
    revisar(conUso.every((r) => precio(r.uso) < 0.04), 'ningún turno pasa de US$ 0,04 (en la 4b: 0,008 a 0,033)');
  } finally {
    await db.end();
  }

  console.log(`\n${pasadas} bien, ${fallidas} mal.`);
  process.exit(fallidas === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
