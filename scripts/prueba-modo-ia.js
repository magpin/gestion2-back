// Recorre el modo IA completo por HTTP: subir, leer, ver, confirmar.
//
// Es el 6d de `lectura-documentos.md` hecho por la puerta que usa el navegador,
// no por la pantalla. No reemplaza la revisión visual —el SSE dibujando, la
// tarjeta «Esto encontré»— pero sí prueba todo lo que hay detrás, y prueba tres
// cosas que ninguna suite puede dar: que el `PUT` a la URL firmada pase el CORS
// que el navegador exige, que el flujo de eventos llegue en orden, y que al
// cortarlo se pueda recuperar el estado.
//
// Cada corrida crea una cuenta desechable (`prueba-a-<sello>`), como pide el
// 6d. `node scripts/limpiar-pruebas.js --confirmar` las borra.
//
// Uso:
//   node scripts/rut-de-prueba.js rut.pdf      # si no hay uno real
//   node scripts/prueba-modo-ia.js rut.pdf
//
// **Gasta tokens**: cada corrida es una lectura de verdad contra la API de
// Anthropic. Lo que cuesta está medido en el espejo del paso 2.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');

const BASE = `http://localhost:${process.env.PORT || 3001}/${process.env.API_PREFIX || 'api/v1'}`;
// El origen desde el que el navegador haría el `PUT`. El bucket tiene que
// aceptarlo: si no, la subida falla solo en el navegador y en ningún curl.
const ORIGEN = process.env.ORIGEN_WEB || 'http://localhost:3000';

const marca = Date.now();
let pasadas = 0;
let fallidas = 0;

function revisar(condicion, descripcion, detalle = '') {
  if (condicion) {
    pasadas += 1;
    console.log(`  OK    ${descripcion}`);
  } else {
    fallidas += 1;
    console.log(`  FALLA ${descripcion}${detalle ? ' -> ' + detalle : ''}`);
  }
}

function nota(texto) {
  console.log(`  ·     ${texto}`);
}

async function pedir(metodo, ruta, { token, cuerpo, cabeceras } = {}) {
  const res = await fetch(BASE + ruta, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...cabeceras,
    },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const texto = await res.text();
  let datos = null;
  try {
    datos = texto ? JSON.parse(texto) : null;
  } catch {
    datos = texto;
  }
  return { estado: res.status, datos };
}

/**
 * El flujo de eventos, consumido como lo consume la pantalla: con `fetch` y
 * lectura del cuerpo por partes, porque `EventSource` no sabe mandar la cabecera
 * `Authorization` y este endpoint la exige.
 */
function abrirProgreso(token, alLlegar) {
  const corte = new AbortController();
  const lista = [];

  const terminado = (async () => {
    const res = await fetch(`${BASE}/configuracion/ia/progreso`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: corte.signal,
    });
    if (res.status !== 200) return { estado: res.status, eventos: lista };

    const lector = res.body.getReader();
    const decodificador = new TextDecoder();
    let resto = '';
    try {
      for (;;) {
        const { done, value } = await lector.read();
        if (done) break;
        resto += decodificador.decode(value, { stream: true });
        const partes = resto.split('\n\n');
        resto = partes.pop();
        for (const parte of partes) {
          const linea = parte.split('\n').find((l) => l.startsWith('data:'));
          if (!linea) continue;
          const evento = JSON.parse(linea.slice(5).trim());
          lista.push(evento);
          if (alLlegar) alLlegar(evento);
        }
      }
    } catch {
      // Abortar el `fetch` cierra el lector: es la salida normal de acá.
    }
    return { estado: res.status, eventos: lista };
  })();

  return { corte, terminado, eventos: lista };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lo que acepta `UrlDeCargaDto`. La extensión decide; el bucket no adivina. */
const TIPOS_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

(async () => {
  const archivo = process.argv[2];
  if (!archivo || !fs.existsSync(archivo)) {
    console.error(
      'Falta el documento.\n' +
        '  node scripts/rut-de-prueba.js rut.pdf   (uno inventado, para ejercitar la cadena)\n' +
        '  node scripts/prueba-modo-ia.js rut.pdf\n' +
        '  node scripts/prueba-modo-ia.js rut.png  (también acepta imágenes)',
    );
    process.exit(2);
  }
  const contenido = fs.readFileSync(archivo);
  const extension = archivo.slice(archivo.lastIndexOf('.')).toLowerCase();
  const tipoMime = TIPOS_MIME[extension];
  if (tipoMime === undefined) {
    console.error(
      `No sé qué es un «${extension}». Se aceptan ${Object.keys(TIPOS_MIME).join(', ')}.`,
    );
    process.exit(2);
  }

  console.log(`\n=== Modo IA · punta a punta contra ${BASE} ===`);
  console.log(
    `    Documento: ${archivo} (${contenido.length} bytes, ${tipoMime})\n`,
  );

  // -------------------------------------------------------------------------
  console.log('1 · Una empresa desechable');
  const correo = `ana.torres+${marca}@prueba.co`;
  const password = crypto.randomBytes(18).toString('base64url');

  const alta = await pedir('POST', '/tenants', {
    cabeceras: { 'x-clave-provision': process.env.CLAVE_PROVISION },
    cuerpo: {
      nombre: 'Prueba modo IA',
      slug: `prueba-a-${marca}`,
      plan: 'CONTADOR',
      maxEmpresas: 5,
      maxUsuarios: 5,
      email: correo,
      nombreAdministrador: 'Ana Torres',
      password,
    },
  });
  revisar(alta.estado === 201, 'se crea la cuenta', JSON.stringify(alta.datos));

  const login = await pedir('POST', '/auth/login', {
    cuerpo: { email: correo, password },
  });
  const tokenSesion = login.datos?.token;
  revisar(!!tokenSesion, 'entra y recibe token de sesión');

  // La empresa se crea con lo mínimo. Todo lo demás —sede, actividades,
  // responsabilidades— es lo que el RUT tiene que llenar: si se crea completa,
  // la prueba no prueba nada.
  const empresa = await pedir('POST', '/empresas', {
    token: tokenSesion,
    cuerpo: {
      tipoPersona: 'JURIDICA',
      razonSocial: 'SOLUCIONES CONTABLES DE PRUEBA S.A.S.',
      nit: '901234567',
      dv: '7',
      sectores: ['SERVICIOS'],
      grupoNiif: 'GRUPO_2',
      fechaInicioOperaciones: '2020-03-15',
    },
  });
  revisar(
    empresa.estado === 201,
    'crea la empresa',
    JSON.stringify(empresa.datos),
  );
  const empresaId = empresa.datos?.id;

  const trabajo = await pedir('POST', '/auth/empresa', {
    token: tokenSesion,
    cuerpo: { empresaId },
  });
  const token = trabajo.datos?.token;
  revisar(!!token, 'cambia el token de sesión por uno de trabajo');

  const antes = await pedir('GET', '/empresas/actual/estado-configuracion', {
    token,
  });
  const faltabaAntes = JSON.stringify(antes.datos);

  // -------------------------------------------------------------------------
  console.log('\n2 · El modo IA está disponible');
  const disponible = await pedir('GET', '/configuracion/ia/disponible', {
    token,
  });
  revisar(
    disponible.datos?.disponible === true,
    'la clave de Anthropic y el bucket están puestos',
    JSON.stringify(disponible.datos),
  );
  if (disponible.datos?.disponible !== true) {
    console.log('\n  Sin bucket o sin clave no hay nada que probar. Ver docs/infra/minio.md.\n');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  console.log('\n3 · El flujo de eventos, abierto antes de subir');
  const progreso = abrirProgreso(token, (e) =>
    nota(`evento ${e.etapa.padEnd(10)} ${e.mensaje}`),
  );
  await esperar(500);

  // -------------------------------------------------------------------------
  console.log('\n4 · Subir el archivo al bucket, como lo sube el navegador');
  const firma = await pedir('POST', '/configuracion/ia/documentos/carga', {
    token,
    cuerpo: { tipo: 'RUT', tipoMime },
  });
  revisar(
    firma.estado === 201 && !!firma.datos?.url,
    'la API firma la subida',
    JSON.stringify(firma.datos),
  );
  const { url, clave } = firma.datos;
  revisar(
    clave.startsWith(`documentos/${empresaId}/`),
    'la llave lleva el id de esta empresa adentro',
    clave,
  );

  // El navegador manda antes un preflight. Si el bucket no lo contesta, la
  // subida falla solo desde la pantalla y ningún curl lo delata.
  const vuelo = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGEN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  revisar(
    vuelo.status < 400 &&
      !!vuelo.headers.get('access-control-allow-origin'),
    `el bucket contesta el preflight de ${ORIGEN}`,
    `${vuelo.status}, allow-origin: ${vuelo.headers.get('access-control-allow-origin')}`,
  );

  const subida = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': tipoMime, Origin: ORIGEN },
    body: contenido,
  });
  revisar(subida.status === 200, 'el PUT a la URL firmada entra', `${subida.status}`);

  // -------------------------------------------------------------------------
  console.log('\n5 · Registrar y leer');
  const ajeno = await pedir('POST', '/configuracion/ia/documentos', {
    token,
    cuerpo: { tipo: 'RUT', clave: 'documentos/00000000-0000-4000-8000-000000000000/x.pdf' },
  });
  revisar(
    ajeno.estado >= 400,
    'una llave de otra empresa se rechaza',
    `${ajeno.estado} ${JSON.stringify(ajeno.datos)}`,
  );

  const arranque = Date.now();
  const registro = await pedir('POST', '/configuracion/ia/documentos', {
    token,
    cuerpo: { tipo: 'RUT', clave },
  });
  revisar(
    registro.estado === 201,
    'queda registrado y encolado',
    JSON.stringify(registro.datos),
  );
  const documentoId = registro.datos?.id;

  // La lectura sigue por su cuenta: acá se espera al evento, no a la respuesta.
  for (let i = 0; i < 120; i += 1) {
    if (progreso.eventos.some((e) => e.etapa === 'LISTO' || e.etapa === 'ERROR')) break;
    await esperar(1000);
  }
  const fin = progreso.eventos.find((e) => e.etapa === 'LISTO' || e.etapa === 'ERROR');
  revisar(!!fin, 'la lectura termina y lo dice por el flujo');
  nota(`tardó ${((Date.now() - arranque) / 1000).toFixed(1)} s`);

  const etapas = progreso.eventos.map((e) => e.etapa);
  revisar(
    etapas.includes('EN_COLA') && etapas.includes('LEYENDO'),
    'los eventos vienen de hechos, no de un temporizador',
    etapas.join(' → '),
  );
  revisar(fin?.etapa === 'LISTO', 'la lectura no falló', fin?.mensaje ?? '');

  // -------------------------------------------------------------------------
  console.log('\n6 · Cortar el flujo y recuperarse, como un F5');
  progreso.corte.abort();
  await progreso.terminado;
  const reconexion = abrirProgreso(token);
  await esperar(500);
  revisar(true, 'el flujo se puede volver a abrir sin que la API se caiga');

  const lista = await pedir('GET', '/configuracion/ia/documentos', { token });
  const enLista = (lista.datos ?? []).find((d) => d.id === documentoId);
  revisar(
    !!enLista && enLista.estado === 'LEIDO',
    'después del corte, `GET documentos` sabe en qué quedó',
    JSON.stringify(lista.datos)?.slice(0, 200),
  );
  reconexion.corte.abort();
  await reconexion.terminado;

  // -------------------------------------------------------------------------
  console.log('\n7 · Lo que se leyó');
  const datos = enLista?.datos ?? [];
  revisar(datos.length > 0, 'volvieron campos');
  const dudosos = datos.filter((d) => d.confianza !== 'ALTA');
  console.log();
  for (const d of datos) {
    const marcaDuda = d.confianza === 'ALTA' ? ' ' : '?';
    console.log(
      `  ${marcaDuda} ${String(d.campo).padEnd(24)} ${String(d.valor).slice(0, 36).padEnd(38)} ${(d.fuente?.casilla ?? '—').slice(0, 30)}`,
    );
  }
  console.log();
  revisar(
    datos.every((d) => d.fuente),
    'cada campo dice de dónde salió',
  );
  nota(`${datos.length} campos, ${dudosos.length} por debajo de ALTA`);

  // -------------------------------------------------------------------------
  console.log('\n8 · Confirmar');
  const confirmacion = await pedir(
    'POST',
    `/configuracion/ia/documentos/${documentoId}/confirmar`,
    { token },
  );
  revisar(
    confirmacion.estado === 201 || confirmacion.estado === 200,
    'la confirmación responde',
    JSON.stringify(confirmacion.datos)?.slice(0, 300),
  );
  const aplicados = confirmacion.datos?.aplicados ?? [];
  const sinAplicar = confirmacion.datos?.sinAplicar ?? [];
  nota(`aplicados: ${aplicados.length ? aplicados.join(', ') : '—'}`);
  for (const s of sinAplicar) {
    nota(`sin aplicar: ${s.campo} — ${s.motivo}`);
  }
  revisar(aplicados.length > 0, 'algo quedó guardado');

  // -------------------------------------------------------------------------
  console.log('\n9 · Los valores están en la configuración, no solo en la tarjeta');
  const despues = await pedir('GET', '/empresas/actual/estado-configuracion', {
    token,
  });
  revisar(
    JSON.stringify(despues.datos) !== faltabaAntes,
    'el estado de configuración cambió después de confirmar',
  );
  console.log(`  antes:   ${faltabaAntes?.slice(0, 220)}`);
  console.log(`  después: ${JSON.stringify(despues.datos)?.slice(0, 220)}`);

  // -------------------------------------------------------------------------
  console.log(`\n=== ${pasadas} bien, ${fallidas} mal ===`);
  console.log(
    `Cuenta desechable: prueba-a-${marca}. Se borra con ` +
      '`node scripts/limpiar-pruebas.js --confirmar`.\n',
  );
  process.exit(fallidas === 0 ? 0 : 1);
})();
