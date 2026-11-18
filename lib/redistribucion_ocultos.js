'use strict';
// Ocultos de Redistribución compartidos entre usuarios: { "<IdSucursal>": [{ plu, usuario, fecha }] }.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SUCURSALES_REALES = [2, 3, 4, 5, 7, 9, 10]; // 6/8/11 son ficticias
const PLU_RE = /^[A-Za-z0-9._-]+$/;

function validarSucursal(s) {
  return Number.isInteger(s) && SUCURSALES_REALES.includes(s) ? null : 'sucursal inválida';
}
function validarPlu(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 40 && PLU_RE.test(p) ? null : 'plu inválido';
}

// --- Operaciones puras (devuelven mapa nuevo, no mutan) ---
function conLista(mapa, suc, lista) {
  const { [String(suc)]: _, ...resto } = mapa;
  return lista.length ? { ...resto, [String(suc)]: lista } : resto;
}
function ocultar(mapa, suc, plu, usuario, fecha) {
  const lista = mapa[String(suc)] || [];
  if (lista.some(x => x.plu === plu)) return mapa;
  return conLista(mapa, suc, [...lista, { plu, usuario: usuario || null, fecha }]);
}
function mostrar(mapa, suc, plu) {
  return conLista(mapa, suc, (mapa[String(suc)] || []).filter(x => x.plu !== plu));
}
function restablecer(mapa, suc) {
  return conLista(mapa, suc, []);
}

// Devuelve un mapa nuevo solo con listas válidas; descarta (y loguea) lo que no tenga forma esperada.
function sanear(m, nombre) {
  const limpio = {};
  for (const [suc, lista] of Object.entries(m)) {
    if (!Array.isArray(lista)) { console.error(`[redistribucion_ocultos] ${nombre}: clave ${suc} no es lista, se ignora`); continue; }
    const ok = lista.filter(x => x && typeof x === 'object' && validarPlu(x.plu) === null);
    if (ok.length !== lista.length) console.error(`[redistribucion_ocultos] ${nombre}: ${lista.length - ok.length} elemento(s) inválidos en ${suc}, se ignoran`);
    if (ok.length) limpio[suc] = ok;
  }
  return limpio;
}

// --- Persistencia ---
async function leerArchivo(ruta) {
  let txt;
  try { txt = await fs.readFile(ruta, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  try {
    const m = JSON.parse(txt);
    if (m && typeof m === 'object' && !Array.isArray(m)) return sanear(m, path.basename(ruta));
  } catch { /* cae al log */ }
  // ponytail: corrupto → se loguea y se arranca vacío; el próximo POST lo sobrescribe (copia en .corrupto, una vez).
  console.error(`[redistribucion_ocultos] ${path.basename(ruta)} corrupto, se usa mapa vacío`);
  const previo = await fs.readFile(`${ruta}.corrupto`, 'utf8').catch(() => null);
  if (previo !== txt) await fs.writeFile(`${ruta}.corrupto`, txt, 'utf8').catch(() => {});
  return {};
}

const REINTENTABLES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const espera = ms => new Promise(r => setTimeout(r, ms));
// ponytail: Windows bloquea el rename si otro proceso (antivirus, indexador) tiene el archivo abierto; 3 intentos alcanzan.
async function renombrar(tmp, ruta, intentos = 3) {
  for (let i = 1; ; i++) {
    try { return await fs.rename(tmp, ruta); }
    catch (err) { if (i >= intentos || !REINTENTABLES.has(err.code)) throw err; await espera(30); }
  }
}
async function escribir(ruta, datos) {
  const tmp = `${ruta}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(datos, null, 2), 'utf8');
  try { await renombrar(tmp, ruta); }
  catch (err) { await fs.rm(tmp, { force: true }); throw err; }
}

// ponytail: cola global en proceso; alcanza con un solo server escribiendo el archivo.
let cola = Promise.resolve();
function encolar(tarea) {
  const op = cola.then(tarea);
  cola = op.catch(() => {});
  return op;
}
function leer(ruta) {
  return encolar(() => leerArchivo(ruta));
}
function modificar(ruta, fn) {
  return encolar(async () => {
    const nuevo = fn(await leerArchivo(ruta));
    await escribir(ruta, nuevo);
    return nuevo;
  });
}

module.exports = { SUCURSALES_REALES, validarSucursal, validarPlu, ocultar, mostrar, restablecer, sanear, leer, modificar };
