// Prueba de punta a punta de la fase 6: se sube una factura en PDF por la API,
// María la lee, la cruza con el sistema, y una persona la registra.
//
// Es la cadena completa y de verdad: el bucket, el modelo, la comprobación de
// totales, el cruce contra productos y cuentas, y `POST /compras` con su
// asiento y su kardex. Nada simulado.
//
// Uso:
//   npx ts-node scripts/probar-lectura-factura.ts --password "la-del-seed"
//                 [--archivo "ARRIENDO.pdf"]   cuál de docs/sistema-anterior
//                 [--registrar]                registra la compra de verdad
//                 [--cuenta 512005]            la cuenta del gasto, si la pide
//                 [--numero ARR-1023]          el número, si el documento no lo trae
//
// Gasta tokens de verdad: una lectura por corrida.

import 'dotenv/config';

import { readFileSync } from 'fs';
import { join } from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pedir, entrar } = require('./lib/api') as {
  pedir: (
    metodo: string,
    ruta: string,
    o?: { token?: string; cuerpo?: unknown },
  ) => Promise<{ estado: number; datos: any }>;
  entrar: (
    email: string,
    password: string,
    empresa: string,
  ) => Promise<{ token: string }>;
};

const DOCS = join(__dirname, '..', '..', 'docs', 'sistema-anterior');

const argumento = (nombre: string): string | undefined => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pesos = (n: unknown) => Number(n).toLocaleString('es-CO');

(async () => {
  const password = argumento('password');
  if (password === undefined) {
    console.error('Falta --password: la de los usuarios que sembró sembrar.js.');
    process.exit(2);
  }
  const archivo = argumento('archivo') ?? 'ARRIENDO.pdf';
  const registrar = process.argv.includes('--registrar');

  // Entra como COMPRAS a propósito: es quien recibe las facturas, y el permiso
  // para mandarlas a leer se agregó justamente para este caso.
  const login = await pedir('POST', '/auth/login', {
    cuerpo: { email: 'compras@demo.co', password },
  });
  if (login.estado !== 200 && login.estado !== 201) {
    console.error(`No pude entrar (${login.estado}).`);
    process.exit(1);
  }
  const { token } = await entrar(
    'compras@demo.co',
    password,
    login.datos.empresas[0].id,
  );

  const disponible = await pedir('GET', '/configuracion/ia/disponible', { token });
  console.log(`Lectura automática: ${JSON.stringify(disponible.datos)}`);
  if (disponible.datos?.disponible !== true) {
    console.error('La lectura automática no está disponible. No sigo.');
    process.exit(1);
  }

  // ── 1. Subir el archivo al bucket, con URL firmada ──
  console.log(`\n══ 1. Subiendo ${archivo}`);
  const carga = await pedir('POST', '/configuracion/ia/documentos/carga', {
    token,
    cuerpo: { tipo: 'FACTURA_COMPRA', tipoMime: 'application/pdf' },
  });
  if (carga.estado !== 200 && carga.estado !== 201) {
    console.error(`No pude firmar la subida (${carga.estado}): ${JSON.stringify(carga.datos)}`);
    process.exit(1);
  }
  const { url, clave } = carga.datos as { url: string; clave: string };

  const contenido = readFileSync(join(DOCS, archivo));
  const subida = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: new Uint8Array(contenido),
  });
  if (!subida.ok) {
    console.error(`El bucket rechazó la subida (${subida.status}).`);
    process.exit(1);
  }
  console.log(`  Subido: ${clave} (${(contenido.length / 1024).toFixed(0)} KB)`);

  // ── 2. Encolar la lectura ──
  console.log('\n══ 2. Leyendo');
  const registro = await pedir('POST', '/configuracion/ia/documentos', {
    token,
    cuerpo: { tipo: 'FACTURA_COMPRA', clave },
  });
  if (registro.estado !== 200 && registro.estado !== 201) {
    console.error(`No pude encolar (${registro.estado}): ${JSON.stringify(registro.datos)}`);
    process.exit(1);
  }
  const documentoId = registro.datos.id as string;

  // Se consulta el estado en vez de escuchar el SSE: es un script, y lo que se
  // prueba es el resultado, no el canal de progreso.
  let documento: any = null;
  for (let intento = 0; intento < 60; intento++) {
    await esperar(2000);
    const lista = await pedir('GET', '/facturas-leidas', { token });
    documento = (lista.datos as any[]).find((d) => d.id === documentoId);
    process.stdout.write(`  ${documento?.estado ?? '—'}…\r`);
    if (documento?.estado === 'LEIDO' || documento?.estado === 'FALLO') break;
  }
  console.log(`  Estado: ${documento?.estado}                    `);

  if (documento?.estado !== 'LEIDO') {
    console.error(`  No se pudo leer: ${documento?.error ?? 'sin motivo'}`);
    process.exit(1);
  }

  // ── 3. Lo que leyó y lo que cruzó ──
  const cruzada = documento.extraido as {
    factura: any;
    comprobaciones: { que: string; cuadra: boolean; calculado: number; impreso: number }[];
    proveedor: { id: string; nombre: string } | null;
    renglones: { orden: number; leido: any; resuelto: any; motivo: string }[];
    preguntas: { sobre: string; texto: string }[];
    juntadas: number;
    completa: boolean;
  };

  console.log('\n══ 3. Lo que leyó');
  const f = cruzada.factura;
  console.log(`  Proveedor en el papel: ${f.proveedor.nombre} (NIT ${f.proveedor.nit ?? '—'})`);
  console.log(`  Número: ${f.numero ?? '—'} · Fecha: ${f.fecha}`);
  console.log(`  Impreso: subtotal ${pesos(f.impreso.subtotal)}, IVA ${pesos(f.impreso.iva)}, total ${pesos(f.impreso.total)}`);

  console.log('\n  Comprobaciones (las suma el código):');
  for (const c of cruzada.comprobaciones) {
    console.log(`    ${c.cuadra ? 'OK  ' : 'NO  '} ${c.que}: calculé ${pesos(c.calculado)}, dice ${pesos(c.impreso)}`);
  }

  console.log('\n══ 4. Lo que cruzó');
  console.log(`  Proveedor: ${cruzada.proveedor ? cruzada.proveedor.nombre : 'NO ENCONTRADO'}`);
  for (const r of cruzada.renglones.slice(0, 8)) {
    const resuelto = r.resuelto
      ? `${r.resuelto.clase} ${r.resuelto.codigo} ${r.resuelto.nombre}`
      : 'SIN RESOLVER';
    console.log(`    ${String(r.orden).padStart(2)}. ${r.leido.descripcion.slice(0, 38).padEnd(38)} → ${resuelto}`);
    if (!r.resuelto) console.log(`        ${r.motivo}`);
  }
  if (cruzada.renglones.length > 8) {
    console.log(`    … y ${cruzada.renglones.length - 8} renglones más.`);
  }
  if (cruzada.juntadas > 0) {
    console.log(`  ${cruzada.juntadas} renglón(es) del mismo producto se juntaron al costo promedio.`);
  }

  console.log(`\n══ 5. ${cruzada.completa ? 'Lista para registrar' : 'Lo que falta'}`);
  for (const p of cruzada.preguntas) console.log(`  · [${p.sobre}] ${p.texto}`);

  // ── 6. Responder lo que falta y registrar ──
  const respuestas: Record<string, unknown> = {};
  const numero = argumento('numero');
  if (numero !== undefined) respuestas.numero = numero;

  const cuenta = argumento('cuenta');
  if (cuenta !== undefined) {
    const cuentas = await pedir('GET', `/plan-cuentas?q=${cuenta}&soloAuxiliares=true`, { token });
    const exacta = (cuentas.datos as any[]).find((c) => c.codigo === cuenta);
    if (exacta === undefined) {
      console.error(`\n  La cuenta ${cuenta} no está en el plan de cuentas.`);
      process.exit(1);
    }
    respuestas.renglones = cruzada.renglones
      .filter((r) => r.resuelto === null && r.leido.clase === 'GASTO')
      .map((r) => ({ orden: r.orden, cuentaId: exacta.id }));
    console.log(`\n  Respondiendo: los gastos van a ${exacta.codigo} ${exacta.nombre}.`);
  }

  if (!registrar) {
    console.log('\n  Corré con --registrar para registrar la compra.');
    return;
  }

  console.log('\n══ 6. Registrando');
  const compra = await pedir(
    'POST',
    `/facturas-leidas/${documentoId}/registrar`,
    { token, cuerpo: respuestas },
  );
  if (compra.estado !== 200 && compra.estado !== 201) {
    console.log(`  No se registró (${compra.estado}): ${JSON.stringify(compra.datos.message ?? compra.datos)}`);
    return;
  }
  const c = compra.datos;
  console.log(`  REGISTRADA: ${c.numero_factura_proveedor} · subtotal ${pesos(c.subtotal)} · IVA ${pesos(c.total_iva)} · total ${pesos(c.total)} · pendiente ${pesos(c.pendiente)}`);
  console.log(`  Asiento: ${c.asiento_id}`);
  console.log(
    `  Coincide con el papel: subtotal ${Math.abs(Number(c.subtotal) - f.impreso.subtotal) <= 1 ? 'sí' : 'NO'}, total ${Math.abs(Number(c.total) - f.impreso.total) <= 1 ? 'sí' : 'NO'}`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
