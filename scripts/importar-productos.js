// Importa el maestro de productos exportado del sistema anterior (Excel).
//
// El archivo es la "Existencia de Inventarios" del sistema viejo: una columna
// con código y nombre pegados, agrupada en secciones. Solo dos secciones son
// productos de verdad; el resto son cuentas contables y servicios que el
// sistema hoy no modela (todo producto lleva kardex). No trae precio, IVA ni
// existencias: eso se completa después, producto por producto o con un ajuste
// de inventario inicial.
//
// Uso:
//   CLAVE_USUARIO='...' node scripts/importar-productos.js \
//     --archivo "../docs/PRODUCTOS 14092026.xlsx" \
//     --email director@empresa.co \
//     --empresa 901234567 \               NIT (sin DV) o id de la empresa destino
//     [--iva 19] \                         tarifa para todos: 0, 5 o 19
//     [--cuenta-inventario 143501] \       cuentas del plan de la empresa; las de
//     [--cuenta-costo 613501] \            costo e ingreso se crean como
//     [--cuenta-ingreso 413501] \          auxiliares si no existen
//     [--simular] \                        solo limpia y escribe el reporte
//     [--reporte importacion-productos.csv]
//
// Reglas:
//   - Entran las secciones PRODUCTOS e INVENTARIOS DE PRODUCTOS TERMINADOS y
//     las filas sin grupo del principio del archivo. CONTABILIZACIONES
//     AUTOMATICAS son cuentas PUC; SERVICIOS y PROPIEDAD HORIZONTAL no son
//     inventario. Van al reporte como omitidos.
//   - Dentro de lo que entra, se omite lo que no es un bien: código de cuenta
//     PUC (6 dígitos), código de servicio (S50…, SER, SOF) o nombre que empieza
//     como un servicio ("MANTENIMIENTO…", "INSTALACION…", "RECARGA…").
//   - La descripción es "CODIGO NOMBRE". El código admite letras, dígitos y
//     guion, hasta 30; lo demás se omite. El nombre se recorta a 200.
//   - Código repetido: se conserva el primero.
//   - Precio 0 y unidad UND para todos: el archivo no dice otra cosa.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { leerXlsx } = require('./lib/xlsx');
const { pedir, entrar } = require('./lib/api');

const SIN_GRUPO = 'SIN GRUPO';
const SECCIONES_PRODUCTO = ['PRODUCTOS', 'INVENTARIOS DE PRODUCTOS TERMINADOS', SIN_GRUPO];
const PATRON_CODIGO = /^[A-Za-z0-9-]{1,30}$/;
/** Los códigos con que el sistema viejo marcaba servicios y cuentas. */
const CODIGO_SERVICIO = /^(SER|SOF|PRUEBA|servi|APRENDIZ|DOTA|RENO)/i;
/** El grupo "S" del sistema viejo: servicios en su mayoría, pero con repuestos y equipos mezclados. */
const CODIGO_GRUPO_S = /^S\d/;
const CODIGO_CUENTA = /^\d{6}$/;
/**
 * Un servicio se nombra por lo que se hace; un bien, por lo que es. "KIT DE
 * MANTENIMIENTO" es un bien y "MANTENIMIENTO DE IMPRESORA" no, así que la
 * regla mira solo cómo empieza el nombre.
 */
const NOMBRE_SERVICIO =
  /^(MANTENIMIENTO|MTTO|SERVICIOS?\b|INSTALACI[OÓ]N|RECARGA|REPARACI[OÓ]N|REVISI[OÓ]N|CONFIGURACI[OÓ]N|RESPALDO|ASESOR[IÍ]A|ARRENDAMIENTO|HONORARIOS|CONTRATOS?\b|DOTACI[OÓ]N|IMPREVISTOS|UTILIDAD|RENOVACI[OÓ]N|DESAPONAMIENTO|CAMBIO DE|FORMATEO|DIAGN[OÓ]STICO|SOPORTE T[EÉ]CNICO|CORREO ELECTR[OÓ]NICO|CAPACITACI[OÓ]N|VISITA|TRANSPORTE|FLETE|DISE[NÑ]O|ALQUILER|ADECUACI[OÓ]N|OBRAS?\b|MANO DE OBRA|ACTUALIZACI[OÓ]N|LIMPIEZA DE|GARANT[IÍ]A|HOSTING|DOMINIO|SUSCRIPCI[OÓ]N|COBRO|AMPLIACI[OÓ]N|CORREOS?\b|ALMACENAMIENTO \d|RECUPERACI[OÓ]N|ORGANIZAI?CI[OÓ]N|ACTIVACI[OÓ]N|CREACI[OÓ]N|MATERIALES)/i;

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

/**
 * Las filas con "Grupo Uno" abren una sección ("PRODUCTOS") o la cierran
 * ("Total PRODUCTOS"). La que abre trae además el primer ítem de la sección,
 * no es solo un rótulo. Las filas anteriores a la primera sección —hay más de
 * mil— no tienen grupo y se tratan aparte.
 */
function cargarListado(ruta) {
  const filas = leerXlsx(ruta);
  const regs = [];
  let seccion = SIN_GRUPO;
  for (let i = 4; i < filas.length; i += 1) {
    const f = filas[i];
    const grupo = typeof f[0] === 'string' ? f[0].trim() : '';
    const descripcion = typeof f[2] === 'string' ? f[2].replace(/\s+/g, ' ').trim() : '';
    if (grupo) seccion = grupo.startsWith('Total ') ? null : grupo.toUpperCase();
    if (!descripcion || seccion === null) continue;
    regs.push({ fila: i + 1, seccion, descripcion });
  }
  return regs;
}

function csv(filas) {
  const escapar = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const columnas = ['fila', 'accion', 'motivo', 'seccion', 'descripcion', 'codigo', 'nombre'];
  return [columnas.join(';'), ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(';'))].join('\n');
}

/** La cuenta por código; si no está en el plan, se crea como auxiliar. */
async function asegurarCuenta(cuentas, codigo, nombre, token, simular) {
  const existente = cuentas.find((c) => c.codigo === codigo);
  if (existente) {
    if (!(existente.es_auxiliar ?? existente.esAuxiliar)) {
      throw new Error(`La cuenta ${codigo} existe pero no es auxiliar: el libro no acepta asientos en ella.`);
    }
    return existente.id;
  }
  if (simular) {
    console.log(`  (se crearía la cuenta auxiliar ${codigo} ${nombre})`);
    return null;
  }
  const res = await pedir('POST', '/plan-cuentas', { token, cuerpo: { codigo, nombre, esAuxiliar: true } });
  if (res.estado !== 201) throw new Error(`No se pudo crear la cuenta ${codigo}: ${JSON.stringify(res.datos)}`);
  console.log(`  Cuenta auxiliar creada: ${codigo} ${nombre}`);
  return res.datos.id;
}

(async () => {
  const a = argumentos();
  const faltan = ['archivo', 'email', 'empresa'].filter((k) => !a[k]);
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
  const iva = Number(a.iva ?? 19);
  if (![0, 5, 19].includes(iva)) {
    console.error('--iva tiene que ser 0, 5 o 19.');
    process.exit(1);
  }
  const rutaReporte = path.resolve(a.reporte || 'importacion-productos.csv');

  // --- 1. Leer y limpiar ---------------------------------------------------
  const regs = cargarListado(a.archivo);
  const reporte = [];
  const productos = new Map();
  let omitidos = 0;
  const omitir = (r, motivo, extra = {}) => {
    reporte.push({ fila: r.fila, accion: 'OMITIDO', motivo, seccion: r.seccion, descripcion: r.descripcion, ...extra });
    omitidos += 1;
  };

  for (const r of regs) {
    if (!SECCIONES_PRODUCTO.includes(r.seccion)) {
      omitir(r, `sección ${r.seccion}: no es inventario`);
      continue;
    }
    const m = r.descripcion.match(/^(\S+)\s+(.+)$/);
    if (!m) {
      omitir(r, 'sin código o sin nombre');
      continue;
    }
    const [, codigo, nombreCrudo] = m;
    if (!PATRON_CODIGO.test(codigo)) {
      omitir(r, 'código inválido (solo letras, dígitos y guion, hasta 30)', { codigo });
      continue;
    }
    if (CODIGO_CUENTA.test(codigo)) {
      omitir(r, 'es una cuenta PUC, no un producto', { codigo });
      continue;
    }
    if (CODIGO_SERVICIO.test(codigo) || NOMBRE_SERVICIO.test(nombreCrudo)) {
      omitir(r, 'parece un servicio: el sistema no los maneja como inventario', { codigo });
      continue;
    }
    const notas = [];
    if (CODIGO_GRUPO_S.test(codigo)) notas.push('código del grupo de servicios con nombre de producto: confirmar');
    let nombre = nombreCrudo.toUpperCase();
    if (nombre.length > 200) {
      nombre = nombre.slice(0, 200).trim();
      notas.push('nombre recortado a 200 caracteres');
    }
    if (nombre.length < 2) {
      omitir(r, 'nombre demasiado corto', { codigo });
      continue;
    }
    const clave = codigo.toUpperCase();
    if (productos.has(clave)) {
      omitir(r, `código repetido: ya está en la fila ${productos.get(clave).origen.fila}`, { codigo });
      continue;
    }
    productos.set(clave, {
      origen: r,
      notas,
      producto: { codigo, nombre, unidadMedida: 'UND', ivaTarifa: iva, precioVenta: 0 },
    });
  }
  console.log(`Leídas ${regs.length} filas: ${productos.size} productos, ${omitidos} omitidas.`);

  // --- 2. Entrar y resolver cuentas ---------------------------------------
  const sesion = await entrar(a.email, process.env.CLAVE_USUARIO, a.empresa);
  console.log(`Empresa destino: ${sesion.empresa.razonSocial} (NIT ${sesion.empresa.nit}-${sesion.empresa.dv})${simular ? ' — SIMULACIÓN' : ''}`);

  const plan = await pedir('GET', '/plan-cuentas', { token: sesion.token });
  if (plan.estado !== 200) throw new Error(`No se pudo leer el plan de cuentas: ${JSON.stringify(plan.datos)}`);
  const cuentas = Array.isArray(plan.datos) ? plan.datos : plan.datos.datos;

  const codInventario = a['cuenta-inventario'] || '143501';
  const inventario = cuentas.find((c) => c.codigo === codInventario);
  if (!inventario) throw new Error(`La empresa no tiene la cuenta de inventario ${codInventario} en su plan.`);
  const cuentaCostoId = await asegurarCuenta(cuentas, a['cuenta-costo'] || '613501', 'Costo de ventas de mercancías', sesion.token, simular);
  const cuentaIngresoId = await asegurarCuenta(cuentas, a['cuenta-ingreso'] || '413501', 'Venta de mercancías', sesion.token, simular);

  // --- 3. Cargar -----------------------------------------------------------
  let creados = 0;
  let existentes = 0;
  let fallidos = 0;
  const lista = [...productos.values()];
  for (let i = 0; i < lista.length; i += 1) {
    const { producto, origen, notas } = lista[i];
    const base = { fila: origen.fila, seccion: origen.seccion, descripcion: origen.descripcion, codigo: producto.codigo, nombre: producto.nombre };
    const cuerpo = { ...producto, cuentaInventarioId: inventario.id };
    if (cuentaCostoId) cuerpo.cuentaCostoVentaId = cuentaCostoId;
    if (cuentaIngresoId) cuerpo.cuentaIngresoId = cuentaIngresoId;

    if (simular) {
      if (notas.length > 0) reporte.push({ ...base, accion: 'REVISAR', motivo: notas.join(' · ') });
      creados += 1;
      continue;
    }
    const res = await pedir('POST', '/productos', { token: sesion.token, cuerpo });
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
