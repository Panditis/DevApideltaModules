'use strict';
// Helper de comparación de CONFIGURACIÓN entre worktrees (dev vs producción).
// Lo usa validar_paridad_entornos.js para explicar por qué un PLU sale distinto:
// casi siempre la causa no es el código sino data/listas_distribucion.json o
// data/distribucion_config.json divergentes entre las dos carpetas.
const fs = require('fs');
const crypto = require('crypto');

// Listas de PLUs (arrays planos) de listas_distribucion.json. 'restringidos' se
// trata aparte porque es un objeto {sucursal: [plu,...]}.
const CLAVES_LISTA = ['noEnvasa', 'siempreAlmacen', 'siemprePesable', 'siemprePesableSinGranel', 'ocultarPesable'];

// Lee un JSON y devuelve además su sha256, para el bloque resumen "¿son idénticos?".
function leerArchivo(ruta) {
  try {
    const txt = fs.readFileSync(ruta, 'utf8');
    return { ruta, existe: true, sha256: crypto.createHash('sha256').update(txt).digest('hex'), json: JSON.parse(txt), error: null };
  } catch (err) {
    return { ruta, existe: false, sha256: null, json: null, error: err.message };
  }
}

const aSet = arr => new Set((Array.isArray(arr) ? arr : []).map(String));
const soloEn = (a, b) => [...a].filter(x => !b.has(x));

// Diferencias de pertenencia de PLUs en listas_distribucion.json. Devuelve, por
// clave, qué PLUs están solo en dev y qué PLUs están solo en producción.
function diffListas(dev, prod) {
  const porClave = {}, restringidos = {}, clavesDivergentes = [];
  for (const clave of CLAVES_LISTA) {
    const d = aSet((dev || {})[clave]), p = aSet((prod || {})[clave]);
    const soloDev = soloEn(d, p), soloProd = soloEn(p, d);
    porClave[clave] = { soloDev, soloProd, setDev: d, setProd: p };
    if (soloDev.length || soloProd.length) clavesDivergentes.push(`${clave} (solo dev: ${soloDev.length}, solo prod: ${soloProd.length})`);
  }
  const sucursales = new Set([...Object.keys((dev || {}).restringidos || {}), ...Object.keys((prod || {}).restringidos || {})]);
  for (const suc of sucursales) {
    const d = aSet(((dev || {}).restringidos || {})[suc]), p = aSet(((prod || {}).restringidos || {})[suc]);
    const soloDev = soloEn(d, p), soloProd = soloEn(p, d);
    restringidos[suc] = { soloDev, soloProd };
    if (soloDev.length || soloProd.length) clavesDivergentes.push(`restringidos.${suc} (solo dev: ${soloDev.length}, solo prod: ${soloProd.length})`);
  }
  return { porClave, restringidos, clavesDivergentes };
}

// Diff recursivo de distribucion_config.json: devuelve las rutas de clave que
// difieren, con el valor de cada entorno serializado para poder imprimirlo.
function diffProfundo(dev, prod, prefijo = '') {
  const esObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (esObj(dev) && esObj(prod)) {
    const rutas = [];
    for (const k of new Set([...Object.keys(dev), ...Object.keys(prod)]))
      rutas.push(...diffProfundo(dev[k], prod[k], prefijo ? `${prefijo}.${k}` : k));
    return rutas;
  }
  const sDev = JSON.stringify(dev === undefined ? null : dev);
  const sProd = JSON.stringify(prod === undefined ? null : prod);
  if (sDev === sProd) return [];
  return [{ ruta: prefijo || '(raíz)', dev: sDev, prod: sProd }];
}

// Etiquetas de causa raíz para un PLU concreto. Primero busca pertenencia a
// listas (causa dura y específica); si no hay ninguna, cae a las divergencias
// globales de distribucion_config.json; si tampoco, marca código/cache.
function causasPorPlu(plu, difListas, difConfig) {
  const p = String(plu), causas = [];
  const lado = (soloDev, soloProd) => soloDev.includes(p) ? 'dev lo incluye, prod no'
    : soloProd.includes(p) ? 'prod lo incluye, dev no' : null;
  for (const clave of CLAVES_LISTA) {
    const d = difListas.porClave[clave];
    const cual = d && lado(d.soloDev, d.soloProd);
    if (cual) causas.push(`${clave} difiere (${cual})`);
  }
  for (const [suc, d] of Object.entries(difListas.restringidos)) {
    const cual = lado(d.soloDev, d.soloProd);
    if (cual) causas.push(`restringidos.${suc} difiere (${cual})`);
  }
  if (causas.length) return causas;
  if (difConfig.length) return difConfig.slice(0, 3).map(d => `config difiere en ${d.ruta} (dev=${d.dev} prod=${d.prod})`);
  return ['sin diferencia de config detectada → probable diferencia de CODIGO o de cache (data/a8020*.json)'];
}

module.exports = { CLAVES_LISTA, leerArchivo, diffListas, diffProfundo, causasPorPlu };
