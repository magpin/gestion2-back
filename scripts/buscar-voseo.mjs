#!/usr/bin/env node
/**
 * Busca voseo y regionalismos en el código (docs/referencia/guia-de-lenguaje.md).
 *
 * El sistema le habla al usuario de usted («Elija el cliente»), sin «acá» ni
 * «plata» en texto formal. Esto avisa cuando entra texto con voseo
 * («Elegí», «tenés», «revisalo»).
 *
 *   node scripts/buscar-voseo.mjs [carpeta…]   (por defecto: src)
 *
 * Sale con 1 si encuentra algo. Los comentarios no cuentan. Una línea que de
 * verdad lo necesita (María contando lo que hizo: «leí», «elegí») se marca
 * con `voseo-ok` en un comentario de la misma línea.
 */
import fs from "node:fs";
import path from "node:path";

// Imperativos de vos con tilde en la última sílaba: «Elegí», «Revisá», «Poné».
const IMPERATIVOS = new Set(
  `elegí escribí revisá probá subí decí contá registrá leé poné recargá agregá volvé creá
   arrastrá sumá empezá digitá cargá anulá usá dejá soltá quitá conocé esperá tocá corregí
   hacé preguntá cambiá confirmá marcá contestá consultá ampliá mirá armá devolvé copiá llená
   buscá pasá llevá juntá agrupá ignorá aplicá pausá entrá pagá clasificá configurá aprobá
   rastreá dedicá atendé tené programá recalculá completá aclará respondé seguí cruzá
   transcribí extraé cerrá pedí rechazá abrí guardá activá desactivá elegila elegilo
   imprimí descargá editá borrá eliminá escaneá importá exportá sacá ponele fijate`
    .split(/\s+/)
    .filter(Boolean),
);

// Imperativos de vos con pronombre, sin tilde: «revisalo», «pedile».
const ENCLITICOS = new Set(
  `pedile revisalo avisale completalo cerralo elegila corregila registralo emitila confirmalo
   copialo dejalo actualizalo preguntale guardalo buscalo contale escribila subile ponela
   cambialo aparealo armalo preguntalo explicale hablalo causalo subila abrila hacelo fijale
   mandame preguntame contame contámelo pedíselo pedírselo decile decime mostrame avisame
   probalo revisala cargalo sacalo`
    .split(/\s+/)
    .filter(Boolean),
);

// Segunda persona del presente de vos: «tenés», «podés», «elegís». Las que
// terminan igual y no son voseo van en EXCEPCIONES.
const PRESENTE = /(?<!\p{L})\p{L}+(?:ás|és|ís)(?!\p{L})/gu;
const EXCEPCIONES = new Set(
  `más además detrás atrás demás jamás quizás después través revés interés inglés francés
   país cortés estrés portugués holandés japonés montañés marqués compás tomás nicolás`
    .split(/\s+/)
    .filter(Boolean),
);

const SUELTAS = /(?<!\p{L})(vos|sos|acá|plata)(?!\p{L})/giu;
const PALABRA = /(?<!\p{L})\p{L}+(?!\p{L})/gu;

const raices = process.argv.slice(2);
const hallazgos = [];

function recorrer(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p);
    else if (/\.(tsx?|mjs|js)$/.test(e.name) && !/buscar-voseo/.test(e.name)) leer(p);
  }
}

function leer(archivo) {
  fs.readFileSync(archivo, "utf8")
    .split(/\r?\n/)
    .forEach((linea, i) => {
      const t = linea.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*") || linea.includes("voseo-ok")) return;
      // Sin el comentario del final de la línea: solo lo que ve el usuario.
      const codigo = linea.replace(/\s\/\/.*$/, "");
      const malas = new Set();
      for (const m of codigo.matchAll(PALABRA)) {
        const w = m[0].toLowerCase();
        if (IMPERATIVOS.has(w) || ENCLITICOS.has(w)) malas.add(m[0]);
      }
      for (const m of codigo.matchAll(PRESENTE)) {
        if (!EXCEPCIONES.has(m[0].toLowerCase())) malas.add(m[0]);
      }
      for (const m of codigo.matchAll(SUELTAS)) {
        // «plata» como nombre de código (`plata(`, `if (plata <= 0)`, `tablero.plata`) no lo ve nadie.
        const antes = codigo.slice(0, m.index);
        const despues = codigo.slice(m.index + m[0].length);
        if (/[.\w]$/.test(antes) || /^\s*[-(<>=!;,)[.?:+*/]/.test(despues)) continue;
        malas.add(m[0]);
      }
      if (malas.size > 0) hallazgos.push(`${archivo}:${i + 1}: ${[...malas].join(", ")}`);
    });
}

for (const r of raices.length > 0 ? raices : ["src"]) recorrer(r);
if (hallazgos.length > 0) {
  console.log(hallazgos.join("\n"));
  console.log(`\n${hallazgos.length} líneas con voseo o regionalismos. Ver docs/referencia/guia-de-lenguaje.md.`);
  process.exit(1);
}
console.log("Sin voseo.");
