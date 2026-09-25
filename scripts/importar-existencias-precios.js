// Carga las existencias iniciales y la lista de precios del sistema anterior
// sobre los productos que ya importó `importar-productos.js`, y limpia el
// catálogo: solo productos, no servicios.
//
// Uso:
//   CLAVE_USUARIO='...' node scripts/importar-existencias-precios.js \
//     --existencias "../docs/fuentes/tecnodigital-14sep2026/existencia inventario 25092026.xlsx" \
//     --precios "../docs/fuentes/tecnodigital-14sep2026/lista de precio.xlsx" \
//     --email director@empresa.co \
//     --empresa 901299793 \                 NIT (sin DV) o id de la empresa destino
//     [--api https://qa.contable.computintasdigital.com/api/v1] \   por defecto, la local
//     [--fecha 2026-09-25] \                la de la existencia: fecha de la carga y del precio
//     [--simular] \                         lee todo y escribe el reporte, sin cambiar nada
//     [--reporte importacion-existencias.csv]
//
// Qué hace, por fila de la existencia:
//   - Solo productos. Las secciones CONTABILIZACIONES AUTOMATICAS, PROPIEDAD
//     HORIZONTAL y SERVICIOS no se tocan: van al reporte.
//   - PRECIO: el Precio1 de la lista, si es mayor que cero y distinto del
//     vigente. Rige desde --fecha.
//   - EXISTENCIA: la carga inicial del kardex, con la cantidad y el costo
//     promedio del sistema anterior, tal cual (hasta 6 decimales, lo que guarda
//     la base). Solo si hay cantidad y costo, y solo una vez por producto: si
//     ya tiene movimientos, el servidor la rechaza y se reporta.
//   - NEGATIVOS: no se cargan —un producto no arranca en negativo—; quedan en
//     cero y en el reporte, para ajustarlos con el conteo de bodega.
//   - SIN COSTO: existencia sin costo promedio no se carga: con costo cero el
//     inventario valdría menos de lo que vale. Va al reporte.
//   - GRAMOS: los polvillos que el sistema anterior llevaba en gramos pasan a
//     KG: 720 g a $46 el gramo son 0,72 kg a $46.000 el kilo. Mismo valor.
//   - SERVICIOS en el catálogo: los de SERVICIOS_A_INACTIVAR se inactivan (no
//     se borran). Las licencias se quedan: se compran y se revenden con costo.
//   - FALTANTES: los de PRODUCTOS_A_CREAR se crean con su precio y su IVA.
//   - IVA: no se cambia. Si la lista dice otro distinto del del producto, va
//     al reporte.
//
// Todo pasa por la API: cada cambio con las mismas validaciones que en la
// pantalla. Correrlo dos veces no duplica nada.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { leerXlsx } = require('./lib/xlsx');

/**
 * Servicios que el importador del 14 dejó como productos. Revisados a mano el
 * 25 de septiembre sobre 68 candidatos: los demás («KIT DE MANTENIMIENTO»,
 * «CUCHILLA DE LIMPIEZA», «SOPORTE PARA TELEVISOR») son repuestos.
 */
const SERVICIOS_A_INACTIVAR = new Set([
  '310100011', // ADMINISTRACION
  'P24OOO119', // DESFRAGMENTACIÓN DE DISCO DURO
  'S54OOO13', // ORGANIZACION DE PUNTOS DE RED
  'P240071', // AJUSTE DE PIÑONERIA IMPRESORA
  'PONCHE', // PONCHADA DE CABLE DE RED
  'P35ACC003', // SUMINISTRO Y CAMBIO DEL BALLAST UNIT
  'S58OOO6', // IMPRESORA EPSON L355 MTTO
]);

/**
 * Productos que no están en el catálogo: cuatro que el importador descartó por
 * error —código de seis dígitos leído como cuenta PUC— y las tintas Epson 524,
 * que llegaron después del 14.
 */
const PRODUCTOS_A_CREAR = new Set([
  '111116', // DISCO SOLIDO 240GB SATA
  '110116', // TECLADO GENIUS USB KB-116
  '350071', // ADAPTADOR TL-POE824G
  '27013500',
  '27013600',
  '27013700',
  '27013800', // TINTA ORIGINAL EPSON 524
]);

const SECCIONES_FUERA = ['CONTABILIZACIONES AUTOMATICAS', 'PROPIEDAD HORIZONTAL', 'SERVICIOS'];

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

const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));
/** Lo que guarda la base: seis decimales. */
const seis = (n) => Math.round(n * 1e6) / 1e6;

function leerExistencias(ruta) {
  const filas = leerXlsx(ruta);
  const regs = [];
  let seccion = 'SIN GRUPO';
  for (let i = 4; i < filas.length; i += 1) {
    const f = filas[i];
    const grupo = typeof f[0] === 'string' ? f[0].trim() : '';
    const desc = typeof f[2] === 'string' ? f[2].replace(/\s+/g, ' ').trim() : '';
    if (grupo) seccion = grupo.startsWith('Total ') ? null : grupo.toUpperCase();
    if (!desc || seccion === null) continue;
    const m = desc.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    regs.push({
      fila: i + 1,
      seccion,
      codigo: m[1],
      nombre: m[2],
      um: f[3],
      existencia: num(f[4]),
      promedio: num(f[5]),
    });
  }
  return regs;
}

function leerPrecios(ruta) {
  const filas = leerXlsx(ruta);
  const precios = new Map();
  for (let i = 2; i < filas.length; i += 1) {
    const f = filas[i];
    if (!f[4]) continue;
    precios.set(String(f[4]).trim().toUpperCase(), {
      nombre: String(f[5] ?? '').replace(/\s+/g, ' ').trim(),
      precio: num(f[10]),
      iva: Math.round(num(f[14]) * 100),
    });
  }
  return precios;
}

function csv(filas) {
  const escapar = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const columnas = ['fila', 'codigo', 'nombre', 'accion', 'detalle'];
  return [columnas.join(';'), ...filas.map((f) => columnas.map((c) => escapar(f[c])).join(';'))].join('\n');
}

(async () => {
  const a = argumentos();
  const faltan = ['existencias', 'precios', 'email', 'empresa'].filter((k) => !a[k]);
  if (faltan.length > 0) {
    console.error(`Faltan argumentos: ${faltan.map((f) => '--' + f).join(', ')}`);
    process.exit(1);
  }
  if (!process.env.CLAVE_USUARIO) {
    console.error('Falta CLAVE_USUARIO en el entorno (la contraseña del usuario que importa).');
    process.exit(1);
  }
  if (a.api) process.env.API_BASE = a.api;
  // Se pide después de fijar la base: la librería la lee al cargarse.
  const { pedir, entrar } = require('./lib/api');

  const simular = a.simular === true;
  const fecha = a.fecha || '2026-09-25';
  const rutaReporte = path.resolve(a.reporte || 'importacion-existencias.csv');

  const existencias = leerExistencias(a.existencias);
  const precios = leerPrecios(a.precios);
  console.log(`Leídas ${existencias.length} filas de existencia y ${precios.size} precios.`);

  const sesion = await entrar(a.email, process.env.CLAVE_USUARIO, a.empresa);
  console.log(`Empresa destino: ${sesion.empresa.razonSocial} (NIT ${sesion.empresa.nit})${simular ? ' — SIMULACIÓN' : ''}`);
  const token = sesion.token;

  // --- El catálogo actual, con los inactivos ------------------------------
  const catalogo = new Map();
  for (let pagina = 1; ; pagina += 1) {
    const r = await pedir('GET', `/productos?incluirInactivos=true&tamano=200&pagina=${pagina}`, { token });
    if (r.estado !== 200) throw new Error(`No se pudo leer el catálogo: ${JSON.stringify(r.datos)}`);
    for (const p of r.datos.datos) catalogo.set(p.codigo.toUpperCase(), p);
    if (r.datos.datos.length < 200) break;
  }
  console.log(`Catálogo actual: ${catalogo.size} productos.`);

  const reporte = [];
  const cuenta = {};
  const anotar = (r, accion, detalle = '') => {
    reporte.push({ fila: r.fila, codigo: r.codigo, nombre: r.nombre, accion, detalle });
    cuenta[accion] = (cuenta[accion] || 0) + 1;
  };
  const mensaje = (res) =>
    res.datos && res.datos.message ? [].concat(res.datos.message).join('; ') : JSON.stringify(res.datos);

  for (let i = 0; i < existencias.length; i += 1) {
    const r = existencias[i];
    const clave = r.codigo.toUpperCase();
    const lista = precios.get(clave);
    let producto = catalogo.get(clave);

    if (SECCIONES_FUERA.includes(r.seccion)) {
      if (!producto) {
        anotar(r, 'FUERA', `sección ${r.seccion}`);
        continue;
      }
    }

    // --- Servicios que quedaron como producto -----------------------------
    if (SERVICIOS_A_INACTIVAR.has(clave)) {
      if (!producto) anotar(r, 'FUERA', 'servicio');
      else if (!producto.activo) anotar(r, 'YA_INACTIVO', 'servicio');
      else if (simular) anotar(r, 'INACTIVAR', 'servicio');
      else {
        const res = await pedir('POST', `/productos/${producto.id}/desactivar`, { token });
        anotar(r, res.estado < 300 ? 'INACTIVAR' : 'FALLÓ', res.estado < 300 ? 'servicio' : `inactivar: ${mensaje(res)}`);
      }
      continue;
    }

    // --- Faltantes ---------------------------------------------------------
    if (!producto) {
      if (!PRODUCTOS_A_CREAR.has(clave)) {
        anotar(r, 'FUERA', 'no está en el catálogo');
        continue;
      }
      const cuerpo = {
        codigo: r.codigo,
        nombre: r.nombre.toUpperCase().slice(0, 200),
        unidadMedida: 'UND',
        ivaTarifa: lista && [0, 5, 19].includes(lista.iva) ? lista.iva : 19,
        precioVenta: lista && lista.precio > 0 ? lista.precio : 0,
      };
      if (simular) {
        anotar(r, 'CREAR', `IVA ${cuerpo.ivaTarifa} · precio ${cuerpo.precioVenta}`);
        producto = { id: null, codigo: r.codigo, activo: true, unidad_medida: 'UND', iva_tarifa: String(cuerpo.ivaTarifa), creado: true };
      } else {
        const res = await pedir('POST', '/productos', { token, cuerpo });
        if (res.estado !== 201) {
          anotar(r, 'FALLÓ', `crear: ${mensaje(res)}`);
          continue;
        }
        anotar(r, 'CREAR', `IVA ${cuerpo.ivaTarifa} · precio ${cuerpo.precioVenta}`);
        producto = { ...res.datos, creado: true };
      }
    }

    // --- IVA: se dice, no se cambia ----------------------------------------
    if (lista && !producto.creado && Number(producto.iva_tarifa) !== lista.iva) {
      anotar(r, 'IVA_DISTINTO', `catálogo ${Number(producto.iva_tarifa)} % · lista ${lista.iva} %`);
    }

    // --- Precio ------------------------------------------------------------
    if (!producto.creado && lista && lista.precio > 0) {
      let vigente = null;
      if (producto.id) {
        const h = await pedir('GET', `/productos/${producto.id}/precios`, { token });
        const historial = Array.isArray(h.datos) ? h.datos : (h.datos?.datos ?? []);
        const actual = historial.find((p) => p.fecha_fin === null);
        vigente = actual ? Number(actual.precio_venta) : null;
      }
      if (vigente === lista.precio) {
        anotar(r, 'PRECIO_IGUAL', String(lista.precio));
      } else if (simular) {
        anotar(r, 'PRECIO', `${vigente ?? '—'} → ${lista.precio}`);
      } else {
        const res = await pedir('POST', `/productos/${producto.id}/precio`, {
          token,
          cuerpo: { precioVenta: lista.precio, fechaInicio: fecha, nota: 'Lista de precios del sistema anterior' },
        });
        anotar(r, res.estado < 300 ? 'PRECIO' : 'FALLÓ', res.estado < 300 ? `${vigente ?? '—'} → ${lista.precio}` : `precio: ${mensaje(res)}`);
      }
    } else if (!lista || lista.precio <= 0) {
      anotar(r, 'SIN_PRECIO', 'la lista no le da precio');
    }

    // --- Existencia --------------------------------------------------------
    if (r.existencia === 0) continue;
    if (r.existencia < 0) {
      anotar(r, 'NEGATIVO', `${r.existencia}: queda en cero, ajustarlo con el conteo`);
      continue;
    }
    if (r.promedio <= 0) {
      anotar(r, 'SIN_COSTO', `${r.existencia} sin costo promedio: no se carga`);
      continue;
    }

    let cantidad = r.existencia;
    let costo = seis(r.promedio);
    if (r.um === 'gramo') {
      cantidad = seis(r.existencia / 1000);
      costo = seis(r.promedio * 1000);
      if (producto.unidad_medida !== 'KG') {
        if (simular) anotar(r, 'A_KG', `${r.existencia} g → ${cantidad} kg a ${costo} el kilo`);
        else {
          const res = await pedir('PATCH', `/productos/${producto.id}`, { token, cuerpo: { unidadMedida: 'KG' } });
          if (res.estado >= 300) {
            anotar(r, 'FALLÓ', `pasar a KG: ${mensaje(res)}`);
            continue;
          }
          anotar(r, 'A_KG', `${r.existencia} g → ${cantidad} kg a ${costo} el kilo`);
        }
      }
    } else if (r.um !== 'Unidad') {
      anotar(r, 'FUERA', `unidad «${r.um}» sin conversión`);
      continue;
    }

    if (Number(producto.saldo_cantidad ?? 0) !== 0) {
      anotar(r, 'YA_TENIA', `ya tiene ${producto.saldo_cantidad} en el kardex`);
      continue;
    }
    if (simular) {
      anotar(r, 'EXISTENCIA', `${cantidad} a ${costo}`);
      continue;
    }
    const res = await pedir('POST', `/productos/${producto.id}/movimientos/carga-inicial`, {
      token,
      cuerpo: { fecha, cantidad, costoUnitario: costo, motivo: 'Existencia del sistema anterior al 25/09/2026' },
    });
    if (res.estado < 300) anotar(r, 'EXISTENCIA', `${cantidad} a ${costo}`);
    else if (/ya tiene movimientos/i.test(mensaje(res))) anotar(r, 'YA_TENIA', 'ya tiene movimientos');
    else anotar(r, 'FALLÓ', `existencia: ${mensaje(res)}`);

    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${existencias.length}…`);
  }

  fs.writeFileSync(rutaReporte, '﻿' + csv(reporte), 'utf8');
  console.log('');
  for (const [accion, n] of Object.entries(cuenta).sort()) console.log(`  ${accion.padEnd(14)} ${n}`);
  console.log(`\n  Reporte: ${rutaReporte}\n`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
