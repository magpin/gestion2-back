// Prueba del 7f (`docs/planes/asistente-facturas-compra.md`) con documentos
// reales: el modelo lee una compra —PDF o Excel del sistema anterior—, se
// cruza con el sistema y se registra de verdad, con su asiento, su kardex y
// su cuenta por pagar.
//
// Compara **Sonnet 5 y Haiku 4.5** leyendo los mismos archivos: qué tan bien
// leen (líneas, totales, NIT, número, fecha) y cuánto cuestan y tardan.
//
// Lo que NO es: la integración en el chat (F6). Es la misma cadena —leer,
// cruzar, registrar— corrida desde un script, para medir antes de construir.
//
// Uso:
//   npx ts-node scripts/probar-facturas-compra.ts --password "la-del-seed"
//                 [--registrar]   registra de verdad las compras que cuadran
//
// Gasta tokens de verdad: cinco archivos por dos modelos.

import 'dotenv/config';

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

import { costoUsd } from '../src/common/ia/modelos';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { leerXlsx } = require('./lib/xlsx') as {
  leerXlsx: (ruta: string) => (string | number | null | undefined)[][];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pedir, entrar } = require('./lib/api') as {
  pedir: (
    metodo: string,
    ruta: string,
    o?: { token?: string; cuerpo?: unknown },
  ) => Promise<{ estado: number; datos: any }>;
  entrar: (email: string, password: string, empresa: string) => Promise<{ token: string }>;
};

const DOCS = join(__dirname, '..', '..', 'docs', 'sistema-anterior');
const MODELOS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001'];

const argumento = (nombre: string): string | undefined => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** Lo que dicen los documentos, leído a mano del PDF: contra esto se califica. */
interface Esperado {
  nit: string | null;
  numero: string | null;
  fecha: string;
  lineas: number;
  subtotal: number;
  iva: number;
  total: number;
}

const ARCHIVOS: { archivo: string; tipo: 'PDF' | 'XLSX'; clave: string; esperado: Esperado }[] = [
  {
    archivo: 'FACTURA DE COMPRA DE JALTECH.pdf',
    tipo: 'PDF',
    clave: 'JALTECH',
    esperado: { nit: '900378652', numero: '215183', fecha: '2026-07-28', lineas: 60, subtotal: 3585293, iva: 681206, total: 4266499 },
  },
  {
    archivo: 'FACTURA DE COMPRA JALTECH.xlsx',
    tipo: 'XLSX',
    clave: 'JALTECH',
    esperado: { nit: null, numero: '215183', fecha: '2026-07-28', lineas: 60, subtotal: 3585293, iva: 681206, total: 4266499 },
  },
  {
    archivo: 'FACTURA DE COMPRA LUIS FERNANDO VARGAS.pdf',
    tipo: 'PDF',
    clave: 'LUIS',
    esperado: { nit: '91076199', numero: '101264', fecha: '2026-07-27', lineas: 9, subtotal: 1131573, iva: 214999, total: 1346572 },
  },
  {
    archivo: 'COMPRA DE LUIS FERNANDO.xlsx',
    tipo: 'XLSX',
    clave: 'LUIS',
    esperado: { nit: null, numero: '101264', fecha: '2026-07-27', lineas: 9, subtotal: 1131573, iva: 214999, total: 1346572 },
  },
  {
    archivo: 'ARRIENDO.pdf',
    tipo: 'PDF',
    clave: 'ARRIENDO',
    esperado: { nit: null, numero: null, fecha: '2026-08-31', lineas: 1, subtotal: 1500000, iva: 0, total: 1500000 },
  },
  {
    archivo: 'ARRIENDOOO.xlsx',
    tipo: 'XLSX',
    clave: 'ARRIENDO',
    esperado: { nit: null, numero: null, fecha: '2026-08-31', lineas: 1, subtotal: 1500000, iva: 0, total: 1500000 },
  },
];

/** La herramienta que obliga al modelo a devolver la compra estructurada. */
const HERRAMIENTA = {
  name: 'registrar_compra_leida',
  description: 'Devuelve la compra leída del documento, tal como está escrita. No inventes lo que no está.',
  input_schema: {
    type: 'object' as const,
    properties: {
      proveedor: {
        type: 'object',
        properties: {
          nombre: { type: 'string' },
          nit: { type: ['string', 'null'], description: 'Sin dígito de verificación ni puntos. null si no aparece.' },
        },
        required: ['nombre', 'nit'],
      },
      numeroFacturaProveedor: {
        type: ['string', 'null'],
        description: 'El número de la factura del PROVEEDOR (en estos documentos, «Documento Externo» o «Doc_Externo»), sin prefijo. null si no hay. No es el consecutivo interno de la compra.',
      },
      prefijoProveedor: { type: ['string', 'null'] },
      fecha: { type: 'string', description: 'aaaa-mm-dd' },
      lineas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            codigo: { type: ['string', 'null'], description: 'El código del producto o de la cuenta contable, si viene aparte de la descripción.' },
            descripcion: { type: 'string' },
            tipo: { type: 'string', enum: ['PRODUCTO', 'GASTO'], description: 'GASTO si es un servicio, arriendo u otro gasto con cuenta contable, no mercancía.' },
            cuentaContable: { type: ['string', 'null'], description: 'Solo en GASTO: el código de la cuenta del PUC si aparece.' },
            centroCosto: { type: ['string', 'null'] },
            cantidad: { type: 'number' },
            valorUnitario: { type: 'number', description: 'Antes de IVA.' },
            ivaPorcentaje: { type: 'number', description: '19, 5 o 0.' },
            total: { type: 'number', description: 'El total de la línea antes de IVA.' },
          },
          required: ['descripcion', 'tipo', 'cantidad', 'valorUnitario', 'ivaPorcentaje', 'total'],
        },
      },
      subtotal: { type: 'number' },
      iva: { type: 'number' },
      retencion: { type: 'number' },
      total: { type: 'number' },
    },
    required: ['proveedor', 'numeroFacturaProveedor', 'fecha', 'lineas', 'subtotal', 'iva', 'total'],
  },
};

const INSTRUCCION = `Leé este documento de compra de una empresa colombiana y devolvé la compra con la herramienta registrar_compra_leida.
Copiá cada línea tal cual: no las agrupes ni las resumas, aunque haya muchas. Montos en pesos, sin separadores.`;

interface Leida {
  proveedor: { nombre: string; nit: string | null };
  numeroFacturaProveedor: string | null;
  prefijoProveedor?: string | null;
  fecha: string;
  lineas: {
    codigo?: string | null;
    descripcion: string;
    tipo: 'PRODUCTO' | 'GASTO';
    cuentaContable?: string | null;
    centroCosto?: string | null;
    cantidad: number;
    valorUnitario: number;
    ivaPorcentaje: number;
    total: number;
  }[];
  subtotal: number;
  iva: number;
  retencion?: number;
  total: number;
}

/** Un serial de fecha de Excel a aaaa-mm-dd. Lo hace el código, no el modelo. */
const fechaExcel = (n: number) => new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);

/** El Excel, como tabla de texto: la API no recibe .xlsx. Las fechas ya convertidas. */
function xlsxComoTexto(ruta: string): string {
  const filas = leerXlsx(ruta);
  const [cabecera, ...resto] = filas;
  const fechas = new Set(['Fecha', 'Vence', 'Fecha_Emision']);
  const celda = (v: unknown, col: string) =>
    v === null || v === undefined ? '' : fechas.has(col) && Number(v) > 20000 ? fechaExcel(Number(v)) : String(v as string);
  return [
    cabecera.join('\t'),
    ...resto.map((f) => cabecera.map((c, i) => celda(f[i], String(c))).join('\t')),
  ].join('\n');
}

async function leer(cliente: Anthropic, modelo: string, a: (typeof ARCHIVOS)[number]) {
  const ruta = join(DOCS, a.archivo);
  const contenido: Anthropic.MessageParam['content'] =
    a.tipo === 'PDF'
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: readFileSync(ruta).toString('base64') } },
          { type: 'text', text: INSTRUCCION },
        ]
      : [{ type: 'text', text: `${INSTRUCCION}\n\nExportación del sistema, una fila por línea:\n\n${xlsxComoTexto(ruta)}` }];
  const inicio = Date.now();
  const m = await cliente.messages.create({
    model: modelo,
    max_tokens: 16000,
    tools: [HERRAMIENTA],
    tool_choice: { type: 'tool', name: HERRAMIENTA.name },
    messages: [{ role: 'user', content: contenido }],
  });
  const bloque = m.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  const leida = (bloque?.input ?? null) as Leida | null;
  if (leida) {
    // La tasa del Excel viene como 0,19.
    for (const x of leida.lineas) if (x.ivaPorcentaje > 0 && x.ivaPorcentaje < 1) x.ivaPorcentaje *= 100;
    // El Excel no trae totales impresos: sumar lo hace el código, no el modelo.
    if (a.tipo === 'XLSX') {
      leida.subtotal = leida.lineas.reduce((s, x) => s + x.total, 0);
      leida.iva = Math.round(leida.lineas.reduce((s, x) => s + (x.total * x.ivaPorcentaje) / 100, 0));
      leida.total = leida.subtotal + leida.iva;
    }
  }
  const uso = {
    entrada: m.usage.input_tokens,
    salida: m.usage.output_tokens,
    cacheLeido: m.usage.cache_read_input_tokens ?? 0,
    cacheEscrito: m.usage.cache_creation_input_tokens ?? 0,
  };
  return {
    leida,
    stop: m.stop_reason,
    uso,
    costo: costoUsd(uso, modelo),
    ms: Date.now() - inicio,
  };
}

/** Las verificaciones de una lectura contra lo que dice el documento. */
function calificar(l: Leida | null, e: Esperado) {
  if (l === null) return [{ que: 'devolvió la compra', ok: false, detalle: 'nada' }];
  const suma = Math.round(l.lineas.reduce((s, x) => s + x.total, 0));
  const soloDigitos = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
  return [
    { que: `líneas (${e.lineas})`, ok: l.lineas.length === e.lineas, detalle: String(l.lineas.length) },
    { que: 'las líneas suman el subtotal', ok: Math.abs(suma - e.subtotal) <= 1, detalle: String(suma) },
    { que: 'subtotal', ok: Math.round(l.subtotal) === e.subtotal, detalle: String(l.subtotal) },
    { que: 'IVA', ok: Math.abs(Math.round(l.iva) - e.iva) <= 1, detalle: String(l.iva) },
    { que: 'total', ok: Math.round(l.total) === e.total, detalle: String(l.total) },
    { que: 'número del proveedor', ok: soloDigitos(l.numeroFacturaProveedor) === soloDigitos(e.numero), detalle: String(l.numeroFacturaProveedor) },
    ...(e.nit === null ? [] : [{ que: 'NIT', ok: soloDigitos(l.proveedor.nit).startsWith(e.nit), detalle: String(l.proveedor.nit) }]),
    { que: 'fecha', ok: l.fecha === e.fecha, detalle: l.fecha },
  ];
}

(async () => {
  const password = argumento('password');
  if (!password) {
    console.error('Falta --password: la de los usuarios que sembró sembrar.js.');
    process.exit(2);
  }
  const registrar = process.argv.includes('--registrar');
  const cliente = new Anthropic();

  // ── 1 y 2: leer y calificar, con cada modelo ──
  const lecturas: { archivo: string; clave: string; modelo: string; leida: Leida | null; aprobada: boolean }[] = [];
  const resumen: string[] = [];
  for (const a of ARCHIVOS) {
    console.log(`\n══ ${a.archivo}`);
    for (const modelo of MODELOS) {
      const r = await leer(cliente, modelo, a);
      const notas = calificar(r.leida, a.esperado);
      const bien = notas.filter((n) => n.ok).length;
      const aprobada = bien === notas.length;
      console.log(`  ${modelo}: ${bien}/${notas.length} · ${(r.ms / 1000).toFixed(1)} s · entrada ${r.uso.entrada}, salida ${r.uso.salida} · US$ ${r.costo.toFixed(4)} · ${r.stop}`);
      for (const n of notas.filter((x) => !x.ok)) console.log(`      FALLA ${n.que}: leyó ${n.detalle}`);
      const tipos = r.leida ? [...new Set(r.leida.lineas.map((x) => x.tipo))].join('/') : '-';
      if (a.clave === 'ARRIENDO' && r.leida) {
        const x = r.leida.lineas[0];
        console.log(`      arriendo: ${x?.tipo} · cuenta ${x?.cuentaContable ?? x?.codigo ?? '-'} · centro ${x?.centroCosto ?? '-'}`);
      }
      resumen.push(`| ${a.archivo.slice(0, 34)} | ${modelo.includes('sonnet') ? 'Sonnet' : 'Haiku'} | ${bien}/${notas.length} | ${tipos} | ${(r.ms / 1000).toFixed(1)} s | ${r.costo.toFixed(4)} |`);
      lecturas.push({ archivo: a.archivo, clave: a.clave, modelo, leida: r.leida, aprobada });
    }
  }
  console.log('\n| Archivo | Modelo | Verificaciones | Tipo de líneas | Tiempo | US$ |');
  console.log('|---|---|---|---|---|---|');
  resumen.forEach((l) => console.log(l));

  // ── 3: cruzar con el sistema, sin IA ──
  const login = await pedir('POST', '/auth/login', { cuerpo: { email: 'compras@demo.co', password } });
  const { token } = await entrar('compras@demo.co', password, login.datos.empresas[0].id);
  const buscarProducto = async (l: Leida['lineas'][number]) => {
    // El Excel trae el código pegado al nombre: «P27ORI0018 TINTA …».
    const codigo = l.codigo ?? l.descripcion.split(' ')[0];
    const porCodigo = await pedir('GET', `/productos?q=${encodeURIComponent(codigo)}`, { token });
    const exacto = (porCodigo.datos.datos ?? []).find((p: any) => p.codigo === codigo);
    if (exacto) return { producto: exacto, como: 'código' };
    const porNombre = await pedir('GET', `/productos?q=${encodeURIComponent(l.descripcion.slice(0, 40))}`, { token });
    const lista = porNombre.datos.datos ?? [];
    const igual = lista.find((p: any) => p.nombre.trim().toUpperCase() === l.descripcion.trim().toUpperCase());
    if (igual) return { producto: igual, como: 'nombre exacto' };
    return lista.length === 1 ? { producto: lista[0], como: 'única coincidencia' } : { producto: null, como: `${lista.length} parecidos` };
  };

  for (const clave of ['JALTECH', 'LUIS', 'ARRIENDO']) {
    // La lectura que aprobó todo, prefiriendo el PDF: es lo que manda el
    // proveedor y trae el NIT. Con --modelo haiku se registra con la de Haiku.
    const preferido = argumento('modelo') ?? 'sonnet';
    const elegida =
      lecturas.find((x) => x.clave === clave && x.aprobada && x.modelo.includes(preferido) && x.archivo.endsWith('.pdf')) ??
      lecturas.find((x) => x.clave === clave && x.aprobada);
    console.log(`\n══ Cruce y registro: ${clave}`);
    if (!elegida?.leida) {
      console.log('  Ninguna lectura aprobó todas las verificaciones: no se registra.');
      continue;
    }
    const l = elegida.leida;
    console.log(`  Lectura usada: ${elegida.archivo} con ${elegida.modelo}`);
    const nit = l.proveedor.nit?.replace(/\D/g, '');
    const t = await pedir('GET', `/terceros?q=${encodeURIComponent(nit || l.proveedor.nombre)}`, { token });
    const tercero = (t.datos.datos ?? [])[0];
    console.log(`  Proveedor: ${tercero ? `${tercero.razon_social ?? tercero.nombre} (por ${nit ? 'NIT' : 'nombre'})` : 'NO ENCONTRADO — se preguntaría'}`);

    const gastos = l.lineas.filter((x) => x.tipo === 'GASTO');
    if (gastos.length > 0) {
      console.log(`  ${gastos.length} línea(s) de GASTO (${gastos.map((g) => `${g.cuentaContable ?? g.codigo ?? '?'} ${g.descripcion}`).join('; ')}).`);
      console.log('  Hoy una compra solo acepta productos: esto necesita las líneas de gasto (F1). No se registra.');
      continue;
    }

    const lineas: { productoId: string; cantidad: number; costoUnitario: number; valor: number }[] = [];
    const sinCruce: string[] = [];
    const como = new Map<string, number>();
    const repetidos: string[] = [];
    for (const x of l.lineas) {
      const r = await buscarProducto(x);
      como.set(r.como, (como.get(r.como) ?? 0) + 1);
      if (!r.producto) sinCruce.push(`${x.descripcion} (${r.como})`);
      else {
        // La compra no acepta el mismo producto dos veces: se suma en una línea,
        // al costo promedio. Al inventario entra el mismo valor.
        const previa = lineas.find((p) => p.productoId === r.producto.id);
        if (previa) {
          repetidos.push(x.descripcion);
          previa.cantidad += x.cantidad;
          previa.valor += x.total;
          previa.costoUnitario = Math.round((previa.valor / previa.cantidad) * 1e6) / 1e6;
        } else lineas.push({ productoId: r.producto.id, cantidad: x.cantidad, costoUnitario: x.valorUnitario, valor: x.total });
      }
    }
    console.log(`  Productos: ${[...como.entries()].map(([k, v]) => `${v} por ${k}`).join(', ')}`);
    if (sinCruce.length > 0) console.log(`  Sin producto (se preguntarían): ${sinCruce.slice(0, 6).join(' | ')}`);
    if (repetidos.length > 0) console.log(`  ${repetidos.length} producto(s) en dos líneas a precios distintos: sumados en una al costo promedio (${repetidos.map((d) => d.slice(0, 30)).join(' | ')})`);
    // Sin simulación de compras todavía, lo mínimo: si el documento cobra IVA
    // y el proveedor figura como no responsable, la compra saldría sin IVA.
    if (tercero && l.iva > 0 && tercero.responsableIva === false) {
      console.log('  La factura cobra IVA y el proveedor figura como NO responsable: se preguntaría. No se registra.');
      continue;
    }
    if (!tercero || sinCruce.length > 0) {
      console.log('  Quedan preguntas para la persona: no se registra solo.');
      continue;
    }

    const cuerpo = {
      terceroId: tercero.id,
      fecha: l.fecha,
      numeroFacturaProveedor: `${l.prefijoProveedor ? `${l.prefijoProveedor}-` : ''}${l.numeroFacturaProveedor}`,
      lineas: lineas.map(({ valor: _v, ...resto }) => resto),
      formaPago: 'CREDITO',
    };
    if (!registrar) {
      console.log(`  Listo para registrar (${lineas.length} líneas). Corré con --registrar para hacerlo.`);
      continue;
    }
    const antes = await pedir('GET', `/productos/${lineas[0].productoId}`, { token });
    const c = await pedir('POST', '/compras', { token, cuerpo });
    if (c.estado !== 201 && c.estado !== 200) {
      console.log(`  El registro rechazó la compra (${c.estado}): ${JSON.stringify(c.datos.message ?? c.datos)}`);
      continue;
    }
    const despues = await pedir('GET', `/productos/${lineas[0].productoId}`, { token });
    console.log(`  REGISTRADA: ${c.datos.numero_factura_proveedor} · subtotal ${c.datos.subtotal} · IVA ${c.datos.total_iva} · total ${c.datos.total} · pendiente ${c.datos.pendiente}`);
    console.log(`  Stock de «${antes.datos.nombre}»: ${antes.datos.saldo_cantidad} → ${despues.datos.saldo_cantidad}`);
    console.log(`  Coincide con el documento: subtotal ${Number(c.datos.subtotal) === l.subtotal ? 'sí' : `NO (${l.subtotal})`}, IVA ${Math.abs(Number(c.datos.total_iva) - l.iva) <= 1 ? 'sí' : `NO (${l.iva})`}, total ${Math.abs(Number(c.datos.total) - l.total) <= 1 ? 'sí' : `NO (${l.total})`}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
