// Punta a punta del paso 6 de `docs/planes/asistente-conversacion.md`: el
// asistente contesta con datos de la empresa, por la API corriendo y con el
// modelo de verdad, **con los permisos de cada rol**.
//
// Para cada rol hace una pregunta y comprueba tres cosas:
//   - qué consultó, por los eventos `CONSULTA` del flujo en vivo;
//   - que la cifra que contesta sea la que ese mismo rol ve en la pantalla
//     (la cifra de referencia sale de la API, no del modelo);
//   - que lo que el rol no ve no se consulte, y se diga.
//
// Usa la Empresa Demo con los datos cargados el 21 sep 2026 (ver la 6a en el
// plan) y los usuarios de `sembrar.js`. **Gasta plata**: cinco preguntas, del
// orden de US$ 0,25.
//
// Uso:
//   node scripts/prueba-conversacion-datos.js --password "la-del-seed"
require('dotenv').config();
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

/** «27316050.00» → «27.316.050», como lo escribe el asistente. */
const pesos = (valor) =>
  Math.round(Math.abs(Number(valor))).toLocaleString('es-CO').replace(/,/g, '.');

async function preguntar(token, texto) {
  const inicio = Date.now();
  const res = await fetch(`${BASE}/conversacion/turnos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ texto }),
  });
  const cuerpo = await res.text();
  const eventos = cuerpo
    .split('\n\n')
    .filter((b) => b.startsWith('data: '))
    .map((b) => JSON.parse(b.slice(6)));
  const fin = eventos.find((e) => e.tipo === 'FIN');
  return {
    estado: res.status,
    consultas: eventos.filter((e) => e.tipo === 'CONSULTA').map((e) => e.etiqueta),
    texto: fin?.turno.texto ?? '',
    fuentes: fin?.turno.fuentes ?? [],
    estadoTurno: fin?.turno.estado,
    segundos: (Date.now() - inicio) / 1000,
  };
}

/** La cifra de referencia: el armador, como lo corre la pantalla de Reportes. */
async function armador(token, origen, columna, valor, suma) {
  const r = await pedir('POST', '/reportes/armador/correr', {
    token,
    cuerpo: {
      definicion: {
        origen,
        columnas: [columna, suma],
        fechas: { desde: '2000-01-01', hasta: '2026-12-31' },
        filtros: [{ columna, forma: 'LISTA', valores: [valor] }],
        agrupar: [],
      },
    },
  });
  return r.datos?.total?.sumas?.[1] ?? null;
}

(async () => {
  const password = argumento('password');
  if (!password) {
    console.error('Falta --password: la de los usuarios que sembró sembrar.js.');
    process.exit(2);
  }
  const login = await pedir('POST', '/auth/login', {
    cuerpo: { email: 'contador@demo.co', password },
  });
  const empresaId = login.datos.empresas[0].id;
  const como = async (rol) => {
    const { token } = await entrar(`${rol}@demo.co`, password, empresaId);
    // Cada rol en una conversación nueva, para que el hilo no ayude.
    await pedir('POST', '/conversacion/nueva', { token });
    return token;
  };

  console.log('\nVENTAS — lo que le debe un cliente');
  {
    const token = await como('ventas');
    const esperado = await armador(token, 'CARTERA', 'cliente', 'ALMACENES CORONA S.A.S', 'saldo');
    const r = await preguntar(token, '¿Cuánto me debe almacenes corona?');
    revisar(r.consultas.includes('Cartera'), `consultó la cartera (${r.consultas.join(', ')})`);
    revisar(esperado !== null && r.texto.includes(pesos(esperado)), `contesta $ ${pesos(esperado)}, lo que ventas ve en Reportes`, r.texto);
    revisar(r.fuentes.includes('Cartera'), `la respuesta guarda su fuente (${r.fuentes.join(', ')})`);
    console.log(`        ${r.segundos.toFixed(1)} s`);
  }

  console.log('\nCONTADOR — lo que se le debe a un proveedor');
  {
    const token = await como('contador');
    const esperado = await armador(token, 'COMPRAS', 'proveedor', 'MPS MAYORISTAS DE COLOMBIA', 'saldo');
    const r = await preguntar(token, '¿Cuánto le debemos a mps mayoristas?');
    revisar(r.consultas.includes('Compras'), `consultó las compras (${r.consultas.join(', ')})`);
    revisar(esperado !== null && r.texto.includes(pesos(esperado)), `contesta $ ${pesos(esperado)}`, r.texto);
    console.log(`        ${r.segundos.toFixed(1)} s`);
  }

  console.log('\nCAJA — la plata en caja y bancos');
  {
    const token = await como('caja');
    const cajas = (await pedir('GET', '/cajas', { token })).datos;
    const r = await preguntar(token, '¿Cuánta plata hay en la caja?');
    revisar(r.consultas.includes('Saldos de caja y bancos'), `consultó los saldos (${r.consultas.join(', ')})`);
    const caja = cajas.find((c) => Number(c.saldo) !== 0) ?? cajas[0];
    revisar(caja !== undefined && r.texto.includes(pesos(caja.saldo)), `contesta $ ${pesos(caja?.saldo ?? 0)}, lo que caja ve en Tesorería`, r.texto);
    console.log(`        ${r.segundos.toFixed(1)} s`);
  }

  console.log('\nINVENTARIO — pregunta por algo que su rol no ve');
  {
    const token = await como('inventario');
    const r = await preguntar(token, '¿Cuánto me debe almacenes corona?');
    revisar(!r.consultas.includes('Cartera'), `no consultó la cartera (${r.consultas.join(', ') || 'ninguna'})`);
    revisar(!/27\.316\.050/.test(r.texto), 'no da la cifra');
    revisar(/rol/i.test(r.texto), 'dice que su rol no lo incluye', r.texto);
    revisar(!/\*\*Reportes\*\*|«Reportes»|en Reportes/.test(r.texto), 'no la manda a una pantalla que su rol no abre', r.texto);
    console.log(`        «${r.texto.replace(/\n+/g, ' ')}»`);
  }

  console.log('\nINVENTARIO — lo que sí ve');
  {
    const token = await como('inventario');
    const r = await preguntar(token, '¿Cuántos portátiles dell latitude 3450 quedan?');
    revisar(r.consultas.includes('Existencias'), `consultó las existencias (${r.consultas.join(', ')})`);
    revisar(/\b3 unidades\b|\btres\b/i.test(r.texto), 'contesta 3 unidades', r.texto);
    console.log(`        ${r.segundos.toFixed(1)} s`);
  }

  console.log(`\n${pasadas} bien, ${fallidas} mal.`);
  process.exit(fallidas === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
