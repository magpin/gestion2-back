// Recorre los endpoints de reportes contra la API corriendo.
//
// No comprueba las cuentas —eso lo hacen las pruebas de cada armador contra
// los números del diseño—: comprueba **la puerta**. Que la lista venga
// filtrada por rol, que una URL escrita a mano rebote con 403, que las
// fuentes se sirvan sin token y que la hoja vuelva como HTML o como PDF según
// se pida.
//
// Usa los usuarios que siembra `sembrar.js`. La contraseña va por argumento,
// no escrita acá: una contraseña en el repositorio termina copiada a un
// entorno real.
//
// Uso:
//   node scripts/verificar-reportes-api.js --password "la-del-seed"
require('dotenv').config();

const BASE = `http://localhost:${process.env.PORT || 3001}/${process.env.API_PREFIX || 'api/v1'}`;

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

async function tokenDe(email, password) {
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.json());
  if (!login.token) throw new Error(`No pude entrar como ${email}: ${JSON.stringify(login)}`);
  const empresa = await fetch(`${BASE}/auth/empresa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
    body: JSON.stringify({ empresaId: login.empresas[0].id }),
  }).then((r) => r.json());
  return empresa.token;
}

const pedir = (ruta, token) =>
  fetch(`${BASE}${ruta}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

(async () => {
  const password = argumento('password');
  if (!password) {
    console.error('Falta --password: la de los usuarios que sembró sembrar.js.');
    process.exit(2);
  }

  console.log(`\n=== Reportes contra ${BASE} ===\n`);

  const contador = await tokenDe('contador@demo.co', password);
  const inventario = await tokenDe('inventario@demo.co', password);
  const ventas = await tokenDe('ventas@demo.co', password);

  console.log('1 · Sin token');
  revisar((await pedir('/reportes')).status === 401, 'la lista pide sesión');
  revisar(
    (await pedir('/reportes/ventas-por-cliente')).status === 401,
    'la hoja también, que es la que trae datos',
  );
  const fuente = await pedir('/reportes/fuentes/inter-400.woff2');
  revisar(
    fuente.status === 200 && fuente.headers.get('content-type') === 'font/woff2',
    'las fuentes no: el iframe no manda la cabecera Authorization',
    `${fuente.status} ${fuente.headers.get('content-type')}`,
  );
  revisar(
    (fuente.headers.get('cache-control') ?? '').includes('immutable'),
    'y se cachean un año, que no cambian sin cambiar de versión',
  );
  revisar(
    (await pedir('/reportes/fuentes/..%2F..%2Fpackage.json')).status === 404,
    'y el nombre no sirve para pedir otro archivo del disco',
  );

  console.log('\n2 · La lista, por rol');
  const listaContador = await pedir('/reportes', contador).then((r) => r.json());
  revisar(listaContador.areas?.length === 6, 'vienen las seis áreas', String(listaContador.areas?.length));
  const cuantos = (lista) => lista.areas.reduce((n, a) => n + a.reportes.length, 0);
  revisar(cuantos(listaContador) === 2, 'un contador ve los dos reportes', String(cuantos(listaContador)));
  revisar(
    listaContador.areas.filter((a) => a.reportes.length === 0).length === 4,
    'y cuatro áreas vienen vacías, a propósito',
  );

  const listaInventario = await pedir('/reportes', inventario).then((r) => r.json());
  revisar(
    cuantos(listaInventario) === 0,
    'un usuario de inventario no ve ninguno de los dos',
    String(cuantos(listaInventario)),
  );
  revisar(
    listaInventario.areas.length === 6,
    'pero sí ve las seis áreas: lo que no puede correr no aparece, no se esconde el área',
  );

  console.log('\n3 · La puerta, que no confía en la lista');
  const directo = await pedir('/reportes/ventas-por-cliente', inventario);
  revisar(directo.status === 403, 'una URL escrita a mano rebota con 403', String(directo.status));
  const cuerpo = await directo.json();
  revisar(
    /rol/i.test(cuerpo.message ?? ''),
    'y el mensaje dice que es el rol, no que el reporte no existe',
    cuerpo.message,
  );
  revisar(
    (await pedir('/reportes/antiguedad-cartera', ventas)).status === 200,
    'ventas sí puede ver la cartera',
  );

  console.log('\n4 · La hoja');
  const html = await pedir('/reportes/ventas-por-cliente?atajo=MES_PASADO', contador);
  const texto = await html.text();
  revisar(
    html.status === 200 && (html.headers.get('content-type') ?? '').startsWith('text/html'),
    'vuelve como HTML para el iframe',
  );
  revisar(texto.includes('Ventas del mes por cliente'), 'con su título');
  revisar(
    texto.includes('/api/v1/reportes/fuentes/inter-400.woff2'),
    'y las fuentes apuntan a la ruta pública, no a un archivo suelto',
  );
  revisar(
    html.headers.get('cache-control') === 'no-store',
    'sin caché: es una hoja con datos de la empresa',
  );
  revisar(
    html.headers.get('x-reporte-desde') !== null && html.headers.get('x-reporte-relativo') === 'true',
    'y devuelve en cabeceras el rango que de verdad usó',
    `${html.headers.get('x-reporte-desde')} → ${html.headers.get('x-reporte-hasta')}`,
  );
  // La base local no tiene ventas: esta hoja corrió bien y no encontró nada.
  // La pantalla necesita saberlo sin abrir el HTML a buscar un cero, para
  // mostrar «no hay ventas en este período» en vez de una hoja en blanco.
  revisar(
    ['true', 'false'].includes(html.headers.get('x-reporte-vacio') ?? ''),
    'y dice si corrió sin encontrar nada, que no es un error',
    `x-reporte-vacio: ${html.headers.get('x-reporte-vacio')}`,
  );
  revisar(
    (html.headers.get('access-control-expose-headers') ?? '').includes('X-Reporte-Vacio'),
    'con las cabeceras expuestas, o el navegador no se las deja leer al frontend',
  );

  const pdf = await pedir('/reportes/antiguedad-cartera?formato=PDF', contador);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  revisar(
    pdf.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-',
    'con formato=PDF vuelve un PDF de verdad',
    `${pdf.status} · ${bytes.length} bytes`,
  );
  revisar(
    /attachment; filename="antiguedad-cartera-/.test(pdf.headers.get('content-disposition') ?? ''),
    'como descarga, con un nombre que dice qué es y de cuándo',
    pdf.headers.get('content-disposition'),
  );

  console.log('\n5 · Los rangos');
  const ambos = await pedir('/reportes/ventas-por-cliente?atajo=ESTE_MES&desde=2026-01-01&hasta=2026-01-31', contador);
  revisar(ambos.status === 400, 'un atajo y dos fechas a la vez se rechaza', String(ambos.status));
  const media = await pedir('/reportes/ventas-por-cliente?desde=2026-01-01', contador);
  revisar(media.status === 400, 'una sola fecha se rechaza', String(media.status));
  const alReves = await pedir('/reportes/ventas-por-cliente?desde=2026-02-01&hasta=2026-01-01', contador);
  revisar(alReves.status === 400, 'un rango al revés se rechaza', String(alReves.status));
  const fijas = await pedir('/reportes/ventas-por-cliente?desde=2026-01-01&hasta=2026-01-31', contador);
  revisar(
    fijas.status === 200 && fijas.headers.get('x-reporte-relativo') === 'false',
    'dos fechas a mano quedan como fijas, no relativas',
  );
  const periodo = await pedir('/reportes/ventas-por-cliente?atajo=PERIODO', contador);
  revisar(periodo.status === 200, 'el periodo en curso resuelve aunque no haya periodos abiertos');

  console.log(`\n=== ${pasadas} bien, ${fallidas} mal ===\n`);
  process.exit(fallidas === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
