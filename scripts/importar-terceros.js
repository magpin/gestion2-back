// Importa el maestro de terceros exportado del sistema anterior (Excel).
//
// Lee el listado completo y los dos parciales (proveedores y clientes), limpia
// cada fila según las reglas de abajo, escribe un reporte de excepciones y crea
// los terceros por la API —`POST /terceros`— para que pasen por las mismas
// validaciones que una alta manual.
//
// Uso:
//   CLAVE_USUARIO='...' node scripts/importar-terceros.js \
//     --terceros   "../docs/TERCEROS COMPUTINTA 14092026.xlsx" \
//     --proveedores "../docs/PROVEEDOR COMPUTINTA 14092026.xlsx" \
//     --clientes   "../docs/CLIENTE COMPUTINTA 14092026.xlsx" \
//     --email director@empresa.co \
//     --empresa 901234567 \            NIT (sin DV) o id de la empresa destino
//     [--simular] \                    solo limpia y escribe el reporte; no crea nada
//     [--reporte importacion-terceros.csv]
//
// El usuario tiene que tener rol DIRECTOR o CONTADOR en la empresa. La
// contraseña va por entorno y no por argumento: los argumentos quedan en el
// historial de la terminal.
//
// Reglas de limpieza (decididas el 14 sep 2026, ver docs/planes):
//   - Cliente/proveedor: lo que digan los parciales. Quien está en el completo y
//     en ninguno de los dos (bancos, EPS, Hacienda) entra como proveedor.
//   - Jurídica: NIT de 9 dígitos que empieza por 8 o 9, o nombre con forma de
//     sociedad. Todo lo demás es persona natural, incluso con NIT.
//   - Jurídica → responsable de IVA, O-48. Natural → no responsable, R-99-PN.
//   - Natural: el nombre se parte por heurística (primera palabra nombre, última
//     apellido) y la fila queda marcada para revisión. El texto original nunca
//     se pierde: va en nombre comercial.
//   - NIT con DV que no cuadra: se corrige al calculado. CC con DV que cuadra:
//     era un NIT. CC con DV que no cuadra: se omite.
//   - NIT de 10+ dígitos que empieza por 8/9 (un dígito de más): se omite.
//   - Duplicados: se conserva la fila con más datos.
//   - Ciudad: se busca en el catálogo DANE sin tildes. Riosucio es el del Chocó.
//     Ambiguas o sin correspondencia: sin municipio, al reporte.
//   - Teléfono: solo 7 o 10 dígitos. Se quita el "34" sobrante de los celulares.
//   - Correo pegado en la dirección: se separa.
//   - Se omiten los nombres de una sola palabra ("NN", "HERNANDEZ .") y los
//     documentos de relleno (123, 222222222222).
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { leerXlsx } = require('./lib/xlsx');
const { pedir, entrar } = require('./lib/api');

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------
function argumentos() {
  const args = process.argv.slice(2);
  const valores = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const clave = args[i].slice(2);
    const siguiente = args[i + 1];
    valores[clave] = siguiente && !siguiente.startsWith('--') ? siguiente : true;
    if (valores[clave] !== true) i += 1;
  }
  return valores;
}

// ---------------------------------------------------------------------------
// Limpieza
// ---------------------------------------------------------------------------
const COLUMNAS = ['clasificacion1', 'clasificacion2', 'nombre', 'identificacion', 'direccion', 'telefono', 'ciudad'];

function limpiarTexto(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** Las tres primeras filas son título, subtítulo y encabezado. */
function cargarListado(ruta) {
  return leerXlsx(ruta)
    .slice(3)
    .map((f, i) => {
      const r = { fila: i + 4 };
      COLUMNAS.forEach((c, j) => {
        r[c] = c === 'direccion' ? (typeof f[j] === 'string' ? f[j].trim() : '') : limpiarTexto(f[j]);
        if (c === 'nombre') r[c] = r[c].toUpperCase();
      });
      return r;
    })
    .filter((r) => r.nombre || r.identificacion);
}

function dvNit(numero) {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let suma = 0;
  const digitos = numero.split('').reverse();
  for (let i = 0; i < digitos.length; i += 1) suma += Number(digitos[i]) * pesos[i];
  const resto = suma % 11;
  return String(resto < 2 ? resto : 11 - resto);
}

function normalizar(s) {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const FORMA_SOCIEDAD =
  /\b(S\.?A\.?S\.?|LTDA\.?|S\.? ?A\.?|E\.?U\.?|S\.? EN C\.?|S\.?C\.?A\.?|& ?CIA|Y CIA|ASOCIACI[OÓ]N|FUNDACI[OÓ]N|COOPERATIVA|CORPORACI[OÓ]N|CONSORCIO|UNI[OÓ]N TEMPORAL|IGLESIA|PARROQUIA|MUNICIPIO|ALCALD[IÍ]A|GOBERNACI[OÓ]N|HOSPITAL|E\.?S\.?E\.?|EPS|IPS|BANCO|UNIVERSIDAD|INSTITUCI[OÓ]N|INSTITUTO|COLEGIO|JUNTA|EMPRESA|COMPA[NÑ][IÍ]A|SOCIEDAD|CAJA DE COMPENSACI[OÓ]N|SECRETAR[IÍ]A|DIRECCI[OÓ]N|CENTRO EDUCATIVO|HOGAR INFANTIL|CLUB|SINDICATO)\b/i;

/** Palabras con las que empieza el nombre de un negocio, no el de una persona. */
const FORMA_NEGOCIO =
  /\b(ALMAC[EÉ]N|TALLER|FERRETER[IÍ]A|HOTEL|TIENDA|DROGUER[IÍ]A|RESTAURANTE|VARIEDADES|COMPRAVENTA|PAPELER[IÍ]A|SUMINISTROS|DISTRIBUIDORA|COMERCIALIZADORA|[OÓ]PTICA|PANADER[IÍ]A|SUPERMERCADO|MISCEL[AÁ]NEA|AVISOS|PUBLICIDAD|ASESOR[IÍ]AS|SERVICIOS|INVERSIONES|AGRO\w*|INMOBILIARIA|CONSULTORIO|CL[IÍ]NICA|LABORATORIO|ESTACI[OÓ]N|PARQUEADERO|CAFETER[IÍ]A|HELADER[IÍ]A|PELUQUER[IÍ]A|SALA DE BELLEZA|LAVADERO|MOTOS|REPUESTOS|EL[EÉ]CTRICOS|TECNOLOG[IÍ]A|SISTEMAS|COMPUTADORES|CELULARES|IMPRESIONES|LITOGRAF[IÍ]A|FOTOCOPIAS|REFRIGERACI[OÓ]N|CONSTRUCCIONES|MUEBLES|CALZADO|BOUTIQUE|VIVERO|FINCA|GRANJA)\b/i;

/**
 * Lo que va después de "Y/O", " - " o "/" es el negocio, no la persona.
 *
 * Para una sociedad el guion también aparece dentro del nombre ("ETNICO -
 * TERRITORIALES"), así que ahí solo cuenta como alias si lo que sigue es
 * corto: una sigla o un nombre de fantasía.
 */
function separarAlias(nombre, esJuridica) {
  const partes = nombre.split(/\s+Y\/O\s+|\s+-\s+|\s*\/\s*/i).map((p) => p.trim()).filter(Boolean);
  if (partes.length < 2) return { principal: nombre, alias: null };
  if (esJuridica) {
    const cola = partes.slice(1).join(' / ');
    return cola.split(' ').length <= 4 ? { principal: partes[0], alias: cola } : { principal: nombre, alias: null };
  }
  // Un nombre de persona no empieza por artículo ni lleva números.
  const pareceNegocio = (p) => FORMA_SOCIEDAD.test(p) || FORMA_NEGOCIO.test(p) || /^(EL|LA|LOS|LAS|MI|SU)\b|[0-9#]/i.test(p);
  const personas = partes.filter((p) => !pareceNegocio(p));
  const principal = personas.length === 1 ? personas[0] : partes[0];
  return { principal, alias: partes.filter((p) => p !== principal).join(' / ') };
}

/**
 * Con qué se cruza una fila entre los tres archivos: el número sin el DV. Los
 * parciales traen exactamente el mismo texto que el completo, así que basta
 * con que la clave sea la misma función a los dos lados.
 */
function claveIdentificacion(texto) {
  const m = texto.trim().match(/^(NIT|CC)\s+(\d+)(?:\s+\d)?$/);
  return m ? m[2] : normalizar(texto);
}

function interpretarDocumento(texto, nombre, notas) {
  const t = texto.trim();
  let m;
  if ((m = t.match(/^NIT\s+(\d+)\s+(\d)$/))) {
    const [, numero, dv] = m;
    if (/^(\d)\1+$/.test(numero) || numero.length < 6) return { omitir: `documento de relleno (${t})` };
    if (numero.length >= 10 && /^[89]/.test(numero)) return { omitir: `NIT de ${numero.length} dígitos: tiene un dígito de más` };
    const dvReal = dvNit(numero);
    if (dvReal !== dv) notas.push(`DV corregido de ${dv} a ${dvReal}`);
    return { tipoDocumento: 'NIT', numero, dv: dvReal };
  }
  if ((m = t.match(/^CC\s+(\d+)\s+(\d)$/))) {
    const [, numero, dv] = m;
    if (dvNit(numero) !== dv) return { omitir: `CC con DV que no cuadra (${t})` };
    notas.push('CC con DV: se toma como NIT');
    return { tipoDocumento: 'NIT', numero, dv };
  }
  if ((m = t.match(/^CC\s+(\d+)$/))) {
    const numero = m[1];
    if (/^[89]\d{8}$/.test(numero) && FORMA_SOCIEDAD.test(nombre)) {
      notas.push('CC de 9 dígitos con nombre de sociedad: se toma como NIT');
      return { tipoDocumento: 'NIT', numero, dv: dvNit(numero) };
    }
    return { tipoDocumento: 'CC', numero };
  }
  if ((m = t.match(/^(CE|TI|PA|PEP|PPT|RC|NUIP)\s+(\S+)$/))) return { tipoDocumento: m[1], numero: m[2] };
  if ((m = t.match(/^Permiso especial de permanencia\s+(\S+)$/i))) return { tipoDocumento: 'PEP', numero: m[1] };
  if ((m = t.match(/^C[ée]dula de extranjer[ií]a\s+(\S+)$/i))) return { tipoDocumento: 'CE', numero: m[1] };
  if ((m = t.match(/^Documento de Identificaci[oó]n extranjero.*?\s+(\d+)(?:\s+(\d))?$/i))) {
    notas.push(`documento extranjero (${t}): revisar tipo`);
    return { tipoDocumento: 'DOC_EXTRANJERO', numero: m[1] };
  }
  return { omitir: `identificación no reconocida (${t})` };
}

/** Primera palabra es el nombre, la última el apellido; lo del medio se reparte. */
function partirNombre(texto) {
  const p = texto.split(' ').filter((x) => x && x !== '.');
  if (p.length < 2) return null;
  if (p.length === 2) return { primerNombre: p[0], primerApellido: p[1] };
  if (p.length === 3) return { primerNombre: p[0], primerApellido: p[1], segundoApellido: p[2] };
  return {
    primerNombre: p[0],
    segundoNombre: p[1],
    primerApellido: p.slice(2, -1).join(' '),
    segundoApellido: p[p.length - 1],
  };
}

function limpiarTelefono(texto) {
  const partes = texto.split(/[-/,;]/).map((p) => p.replace(/\D/g, ''));
  const validos = [];
  for (let d of partes) {
    if (d.length === 12 && d.startsWith('34') && d[2] === '3') d = d.slice(2);
    if ((d.length === 10 && d[0] === '3') || d.length === 7) {
      if (!/^(\d)\1+$/.test(d)) validos.push(d);
    }
  }
  return validos.length > 0 ? validos.join(' / ') : null;
}

function separarCorreo(direccion) {
  const lineas = direccion.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const correo = lineas.find((l) => /^\S+@\S+\.\S+$/.test(l)) || null;
  const resto = lineas.filter((l) => l !== correo).join(' ').replace(/\s+/g, ' ').trim();
  return { direccion: resto || null, email: correo ? correo.toLowerCase() : null };
}

function puntaje(r) {
  return [r.direccion, r.telefono !== '0' && r.telefono, r.ciudad].filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Municipios: se consultan por nombre al catálogo DANE de la API.
// ---------------------------------------------------------------------------
/**
 * Nombres que el catálogo DANE escribe distinto o que en el archivo son
 * ambiguos y tienen una lectura obvia. Riosucio es el del Chocó porque es donde
 * opera la empresa; Armenia y Rionegro son la capital y el de Antioquia por la
 * misma razón.
 */
const ALIAS_MUNICIPIO = {
  cali: '76001',
  cartagena: '13001',
  chibolo: '47170', // Chivolo, Magdalena
  'santafe de antioquia': '05042',
  riosucio: '27615',
  armenia: '63001',
  rionegro: '05615',
};

async function resolverMunicipios(nombres, pedir, token) {
  const mapa = {};
  for (const nombre of nombres) {
    const clave = normalizar(nombre).replace(/ d c$/, '');
    if (ALIAS_MUNICIPIO[clave]) {
      mapa[nombre] = { codigo: ALIAS_MUNICIPIO[clave] };
      continue;
    }
    const { datos } = await pedir('GET', `/municipios?q=${encodeURIComponent(nombre.replace(/\s*d\.?c\.?$/i, ''))}`, { token });
    const exactos = (datos || []).filter((m) => {
      const n = normalizar(m.nombre);
      return n === clave || n.replace(/ d c$/, '') === clave || n === `nuevo ${clave}`;
    });
    if (exactos.length === 1) mapa[nombre] = { codigo: exactos[0].codigo };
    else if (exactos.length > 1) mapa[nombre] = { ambigua: exactos.map((m) => `${m.nombre} (${m.departamento_nombre})`).join(' | ') };
    else mapa[nombre] = { ambigua: null };
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------
function csv(filas) {
  const escapar = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const columnas = ['fila', 'accion', 'motivo', 'identificacion', 'nombre', 'ciudad', 'cargado_como'];
  return [columnas.join(';'), ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(';'))].join('\n');
}

// ---------------------------------------------------------------------------
(async () => {
  const a = argumentos();
  const faltan = ['terceros', 'proveedores', 'clientes', 'email', 'empresa'].filter((k) => !a[k]);
  if (faltan.length > 0) {
    console.error(`Faltan argumentos: ${faltan.map((f) => '--' + f).join(', ')}`);
    console.error('Ver el encabezado de este archivo para el uso completo.');
    process.exit(1);
  }
  if (!process.env.CLAVE_USUARIO) {
    console.error('Falta CLAVE_USUARIO en el entorno (la contraseña del usuario que importa).');
    process.exit(1);
  }
  const simular = a.simular === true;
  const rutaReporte = path.resolve(a.reporte || 'importacion-terceros.csv');

  // --- 1. Leer -------------------------------------------------------------
  const completo = cargarListado(a.terceros);
  const claveDe = (r) => claveIdentificacion(r.identificacion);
  const proveedores = new Set(cargarListado(a.proveedores).map(claveDe));
  const clientes = new Set(cargarListado(a.clientes).map(claveDe));
  console.log(`Leídos: ${completo.length} terceros, ${proveedores.size} proveedores, ${clientes.size} clientes.`);

  // --- 2. Limpiar ----------------------------------------------------------
  const reporte = [];
  const porDocumento = new Map();
  let omitidos = 0;

  for (const r of completo) {
    const notas = [];
    const doc = interpretarDocumento(r.identificacion, r.nombre, notas);
    if (doc.omitir) {
      reporte.push({ fila: r.fila, accion: 'OMITIDO', motivo: doc.omitir, identificacion: r.identificacion, nombre: r.nombre, ciudad: r.ciudad });
      omitidos += 1;
      continue;
    }

    const esJuridica =
      (doc.tipoDocumento === 'NIT' && /^[89]\d{8}$/.test(doc.numero)) ||
      (doc.tipoDocumento !== 'NIT' && /Persona Jur[ií]dica/i.test(r.identificacion)) ||
      FORMA_SOCIEDAD.test(r.nombre);

    const { direccion, email } = separarCorreo(r.direccion);
    const tercero = {
      tipoPersona: esJuridica ? 'JURIDICA' : 'NATURAL',
      tipoDocumento: doc.tipoDocumento,
      numeroDocumento: doc.numero,
      dv: doc.dv,
      email: email || undefined,
      telefono: limpiarTelefono(r.telefono) || undefined,
      direccion: direccion || undefined,
      responsableIva: esJuridica,
      responsabilidadesDian: [esJuridica ? 'O-48' : 'R-99-PN'],
    };

    if (esJuridica) {
      const { principal, alias } = separarAlias(r.nombre, true);
      tercero.razonSocial = principal.length >= 2 ? principal : r.nombre;
      if (alias) tercero.nombreComercial = alias;
      if (doc.tipoDocumento === 'CC') notas.push('sociedad con cédula: revisar documento');
    } else {
      const { principal, alias } = separarAlias(r.nombre, false);
      const partes = partirNombre(principal);
      if (!partes) {
        reporte.push({ fila: r.fila, accion: 'OMITIDO', motivo: 'nombre de una sola palabra', identificacion: r.identificacion, nombre: r.nombre, ciudad: r.ciudad });
        omitidos += 1;
        continue;
      }
      Object.assign(tercero, partes);
      tercero.nombreComercial = alias || r.nombre;
      notas.push('nombre partido por heurística');
    }

    const clave = `${doc.tipoDocumento}:${doc.numero}`;
    // Duplicado: se conserva la fila con más datos, pero lo que solo traía la
    // otra —el correo, típicamente— no se pierde.
    const previo = porDocumento.get(clave);
    const actual = { tercero, origen: r, notas };
    if (previo) {
      const [gana, pierde] = puntaje(previo.origen) >= puntaje(r) ? [previo, actual] : [actual, previo];
      if (!gana.tercero.email && pierde.tercero.email) gana.tercero.email = pierde.tercero.email;
      reporte.push({ fila: pierde.origen.fila, accion: 'OMITIDO', motivo: `duplicado de la fila ${gana.origen.fila}`, identificacion: pierde.origen.identificacion, nombre: pierde.origen.nombre, ciudad: pierde.origen.ciudad });
      omitidos += 1;
      porDocumento.set(clave, gana);
      continue;
    }
    porDocumento.set(clave, actual);
  }

  // Cliente / proveedor, con el mismo criterio de clave que los parciales.
  for (const { tercero, origen, notas } of porDocumento.values()) {
    const clave = claveDe(origen);
    tercero.esProveedor = proveedores.has(clave);
    tercero.esCliente = clientes.has(clave);
    if (!tercero.esProveedor && !tercero.esCliente) {
      tercero.esProveedor = true;
      notas.push('no estaba en ningún parcial: entra como proveedor');
    }
  }

  // --- 3. Entrar y resolver municipios --------------------------------------
  const sesion = await entrar(a.email, process.env.CLAVE_USUARIO, a.empresa);
  console.log(`Empresa destino: ${sesion.empresa.razonSocial} (NIT ${sesion.empresa.nit}-${sesion.empresa.dv})${simular ? ' — SIMULACIÓN' : ''}`);

  const ciudades = [...new Set([...porDocumento.values()].map((x) => x.origen.ciudad).filter(Boolean))];
  const municipios = await resolverMunicipios(ciudades, pedir, sesion.token);
  for (const { tercero, origen, notas } of porDocumento.values()) {
    if (!origen.ciudad) continue;
    const m = municipios[origen.ciudad];
    if (m.codigo) tercero.municipioCodigo = m.codigo;
    else notas.push(m.ambigua ? `ciudad ambigua: ${m.ambigua}` : `ciudad sin correspondencia DANE: ${origen.ciudad}`);
  }

  // --- 4. Cargar -----------------------------------------------------------
  let creados = 0;
  let existentes = 0;
  let fallidos = 0;
  const lista = [...porDocumento.values()];
  for (let i = 0; i < lista.length; i += 1) {
    const { tercero, origen, notas } = lista[i];
    const cargadoComo = tercero.tipoPersona === 'JURIDICA'
      ? `${tercero.tipoPersona} · ${tercero.razonSocial}`
      : `${tercero.tipoPersona} · ${tercero.primerNombre} ${tercero.segundoNombre || ''} | ${tercero.primerApellido} ${tercero.segundoApellido || ''}`.replace(/\s+/g, ' ');
    const base = { fila: origen.fila, identificacion: origen.identificacion, nombre: origen.nombre, ciudad: origen.ciudad, cargado_como: cargadoComo };

    if (simular) {
      if (notas.length > 0) reporte.push({ ...base, accion: 'REVISAR', motivo: notas.join(' · ') });
      creados += 1;
      continue;
    }

    const res = await pedir('POST', '/terceros', { token: sesion.token, cuerpo: tercero });
    if (res.estado === 201) {
      creados += 1;
      if (notas.length > 0) reporte.push({ ...base, accion: 'REVISAR', motivo: notas.join(' · ') });
    } else if (res.estado === 409) {
      existentes += 1;
      reporte.push({ ...base, accion: 'YA_EXISTÍA', motivo: notas.join(' · ') });
    } else {
      fallidos += 1;
      const mensaje = res.datos && res.datos.message ? [].concat(res.datos.message).join('; ') : JSON.stringify(res.datos);
      reporte.push({ ...base, accion: 'FALLÓ', motivo: `${res.estado}: ${mensaje}` });
    }
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${lista.length}…`);
  }

  reporte.sort((x, y) => x.fila - y.fila);
  fs.writeFileSync(rutaReporte, '﻿' + csv(reporte), 'utf8');

  console.log('');
  console.log(`  ${simular ? 'Se cargarían' : 'Creados'}   ${creados}`);
  if (!simular) console.log(`  Ya existían  ${existentes}`);
  if (!simular) console.log(`  Fallidos     ${fallidos}`);
  console.log(`  Omitidos     ${omitidos}`);
  console.log(`  Para revisar ${reporte.filter((r) => r.accion === 'REVISAR').length}`);
  console.log(`\n  Reporte: ${rutaReporte}\n`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
