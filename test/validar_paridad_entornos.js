'use strict';
// Compara la salida de distribución entre el server DEV (8081) y el de PRODUCCIÓN
// (8080) y CLASIFICA cada diferencia por causa raíz. Nació de dos incidentes reales
// donde un PLU (2891) y el conteo de filas de Pesables (591 vs 585) diferían entre
// entornos: en ambos casos la causa fue configuración divergente entre worktrees
// (data/listas_distribucion.json, data/distribucion_config.json), no código.
// El script no arranca ni reinicia nada: si un entorno no responde, sale con 2.
//
// Uso: node test/validar_paridad_entornos.js [--dev=URL] [--prod=URL]
//                                            [--tab=almacen|pesables|ambos]
//                                            [--max-ejemplos=N] [--json]
// Exit: 0 sin diferencias · 1 con diferencias · 2 entorno caído o config ilegible.
const path = require('path');
const { execFileSync } = require('child_process');
const { leerArchivo, diffListas, diffProfundo, causasPorPlu } = require('./validar_paridad_config');

// El script vive en test/, pero compara la config de la RAÍZ de cada worktree.
const RAIZ_DEV = path.join(__dirname, '..');
const TOL = 1e-6;
const TIMEOUT_MS = 180000;   // los endpoints golpean SQL y tardan; margen amplio
// Claves de min/S por tab: almacén expone minSuc/sSuc, pesables mins/sLev.
const TABS = {
  almacen:  { ruta: '/api/distribucion/almacen',  claveMin: 'minSuc', claveS: 'sSuc' },
  pesables: { ruta: '/api/distribucion/pesables', claveMin: 'mins',   claveS: 'sLev' },
};

function parsearArgs(argv) {
  const opt = { dev: 'http://localhost:8081', prod: 'http://localhost:8080', tab: 'ambos', maxEjemplos: 20, json: false };
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (!m) { console.error(`Argumento no reconocido: ${a}`); process.exit(2); }
    const [, clave, valor] = m;
    if (clave === 'dev') opt.dev = valor.replace(/\/$/, '');
    else if (clave === 'prod') opt.prod = valor.replace(/\/$/, '');
    else if (clave === 'tab') opt.tab = valor;
    else if (clave === 'max-ejemplos') opt.maxEjemplos = Math.max(1, parseInt(valor, 10) || 20);
    else if (clave === 'json') opt.json = true;
    else { console.error(`Flag no reconocida: --${clave}`); process.exit(2); }
  }
  if (!TABS[opt.tab] && opt.tab !== 'ambos') { console.error(`--tab debe ser almacen, pesables o ambos (recibido: ${opt.tab})`); process.exit(2); }
  return opt;
}

// Localiza el worktree de producción con `git worktree list` (es otra carpeta).
function worktreeProduccion() {
  try {
    const salida = execFileSync('git', ['worktree', 'list'], { cwd: RAIZ_DEV, encoding: 'utf8' });
    for (const linea of salida.split('\n')) {
      const m = /^(\S+)\s+\S+\s+\[(.+)\]$/.exec(linea.trim());
      if (m && m[2] === 'produccion') return m[1].replace(/\//g, path.sep);
    }
    return null;
  } catch { return null; }
}

async function bajar(base, ruta) {
  const url = `${base}${ruta}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`no se pudo conectar a ${url} (${err.name === 'TimeoutError' ? `timeout ${TIMEOUT_MS}ms` : err.message})`);
  }
  const texto = await res.text();
  if (!res.ok) {
    let detalle = texto.slice(0, 300);
    try { detalle = JSON.parse(texto).error || detalle; } catch { /* cuerpo no JSON */ }
    throw new Error(`${url} respondió HTTP ${res.status}: ${detalle}`);
  }
  let filas;
  try { filas = JSON.parse(texto); } catch { throw new Error(`${url} devolvió una respuesta no-JSON`); }
  if (!Array.isArray(filas)) throw new Error(`${url} no devolvió un array de filas`);
  return filas;
}

// 'Fact' y similares son strings: sólo aplicar tolerancia si ambos son números.
function difValor(a, b) {
  if (typeof a === 'number' && typeof b === 'number')
    return Math.abs(a - b) > TOL * Math.max(1, Math.abs(a), Math.abs(b));
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

// Compara un sub-objeto por sucursal (enviar / min / S) usando la unión de claves,
// para no perder sucursales que existan en un entorno y no en el otro.
function difSubObjeto(etiqueta, oDev, oProd) {
  const difs = [];
  const dev = oDev && typeof oDev === 'object' ? oDev : {};
  const prod = oProd && typeof oProd === 'object' ? oProd : {};
  for (const k of new Set([...Object.keys(dev), ...Object.keys(prod)]))
    if (difValor(dev[k], prod[k])) difs.push({ campo: `${etiqueta}.${k}`, dev: dev[k] ?? null, prod: prod[k] ?? null });
  return difs;
}

function compararTab(nombreTab, filasDev, filasProd, difLis, difCfg, maxEjemplos) {
  const cfg = TABS[nombreTab];
  const mapaDev = new Map(filasDev.map(f => [String(f.plu), f]));
  const mapaProd = new Map(filasProd.map(f => [String(f.plu), f]));
  const idFila = (mapa, plu) => ({ plu, nombre: (mapa.get(plu) || {}).nombre || '' });

  const soloDev = [...mapaDev.keys()].filter(p => !mapaProd.has(p)).map(p => idFila(mapaDev, p));
  const soloProd = [...mapaProd.keys()].filter(p => !mapaDev.has(p)).map(p => idFila(mapaProd, p));
  for (const f of [...soloDev, ...soloProd]) f.causas = causasPorPlu(f.plu, difLis, difCfg);

  const cantidades = [];
  let totalCampos = 0;
  for (const plu of mapaDev.keys()) {
    if (!mapaProd.has(plu)) continue;
    const d = mapaDev.get(plu), p = mapaProd.get(plu);
    const difs = [
      ...difSubObjeto('enviar', d.enviar, p.enviar),
      ...difSubObjeto('min', d[cfg.claveMin], p[cfg.claveMin]),
      ...difSubObjeto('S', d[cfg.claveS], p[cfg.claveS]),
    ];
    if (!difs.length) continue;
    totalCampos += difs.length;
    cantidades.push({ plu, nombre: d.nombre || '', difs, causas: causasPorPlu(plu, difLis, difCfg) });
  }

  return {
    tab: nombreTab,
    filasDev: filasDev.length,
    filasProd: filasProd.length,
    membresia: { soloDev, soloProd, totalSoloDev: soloDev.length, totalSoloProd: soloProd.length },
    cantidades: {
      totalPlus: cantidades.length,
      totalCampos,
      ejemplos: cantidades.slice(0, maxEjemplos),
      truncado: Math.max(0, cantidades.length - maxEjemplos),
    },
    hayDiferencias: soloDev.length > 0 || soloProd.length > 0 || cantidades.length > 0,
  };
}

function imprimirConfig(res) {
  console.log('\n===== CONFIGURACIÓN (dev vs producción) =====');
  console.log(`  worktree producción: ${res.worktreeProd}`);
  for (const [archivo, info] of Object.entries(res.archivos)) {
    const marca = info.identico ? '✓ idénticos' : '✗ DIFIEREN';
    console.log(`  ${archivo}: ${marca}`);
    console.log(`      dev  sha256=${(info.shaDev || 'ERROR').slice(0, 16)}   prod sha256=${(info.shaProd || 'ERROR').slice(0, 16)}`);
  }
  if (res.clavesListasDivergentes.length) {
    console.log('  Listas divergentes (listas_distribucion.json):');
    for (const c of res.clavesListasDivergentes) console.log(`      - ${c}`);
  } else console.log('  Listas de PLUs: sin divergencias.');
  if (res.clavesConfigDivergentes.length) {
    console.log('  Claves divergentes (distribucion_config.json):');
    for (const d of res.clavesConfigDivergentes) console.log(`      - ${d.ruta}: dev=${d.dev} prod=${d.prod}`);
  } else console.log('  distribucion_config.json: sin claves divergentes.');
}

function imprimirTab(r) {
  console.log(`\n===== TAB ${r.tab.toUpperCase()} =====`);
  console.log(`  Filas: dev=${r.filasDev}  prod=${r.filasProd}  (delta=${r.filasDev - r.filasProd})`);
  const { soloDev, soloProd } = r.membresia;
  console.log(`  MEMBRESÍA — solo en dev: ${soloDev.length}   solo en producción: ${soloProd.length}`);
  for (const [rotulo, lista] of [['solo dev', soloDev], ['solo prod', soloProd]])
    for (const f of lista) console.log(`      [${rotulo}] PLU ${f.plu} ${f.nombre} → causa: ${f.causas.join(' | ')}`);
  const c = r.cantidades;
  console.log(`  CANTIDADES — PLUs con diferencias: ${c.totalPlus}   campos distintos: ${c.totalCampos}`);
  for (const e of c.ejemplos) {
    console.log(`      PLU ${e.plu} ${e.nombre}`);
    for (const d of e.difs) console.log(`          ${d.campo}: dev=${JSON.stringify(d.dev)} prod=${JSON.stringify(d.prod)}`);
    console.log(`          causa: ${e.causas.join(' | ')}`);
  }
  if (c.truncado > 0) console.log(`      … ${c.truncado} PLUs más con diferencias (subí --max-ejemplos para verlos).`);
}

async function main() {
  const opt = parsearArgs(process.argv.slice(2));
  const tabs = opt.tab === 'ambos' ? ['almacen', 'pesables'] : [opt.tab];

  // 1) Configuración de ambos worktrees (si no se puede leer, no tiene sentido seguir).
  const dirProd = worktreeProduccion();
  if (!dirProd) { console.error('ERROR: no se encontró el worktree "produccion" en `git worktree list`.'); process.exit(2); }
  const archivos = {};
  const lecturas = {};
  for (const nombre of ['listas_distribucion.json', 'distribucion_config.json']) {
    const dev = leerArchivo(path.join(RAIZ_DEV, 'data', nombre));
    const prod = leerArchivo(path.join(dirProd, 'data', nombre));
    if (dev.error || prod.error) {
      console.error(`ERROR leyendo ${nombre}: dev=${dev.error || 'ok'} prod=${prod.error || 'ok'}`);
      process.exit(2);
    }
    lecturas[nombre] = { dev, prod };
    archivos[nombre] = { shaDev: dev.sha256, shaProd: prod.sha256, identico: dev.sha256 === prod.sha256 };
  }
  const difLis = diffListas(lecturas['listas_distribucion.json'].dev.json, lecturas['listas_distribucion.json'].prod.json);
  const difCfg = diffProfundo(lecturas['distribucion_config.json'].dev.json, lecturas['distribucion_config.json'].prod.json);

  // 2) Bajar los endpoints de ambos entornos. Cualquier fallo → exit 2, sin arrancar nada.
  const descargas = {};
  for (const tab of tabs) {
    const ruta = TABS[tab].ruta;
    try {
      const [filasDev, filasProd] = await Promise.all([bajar(opt.dev, ruta), bajar(opt.prod, ruta)]);
      descargas[tab] = { filasDev, filasProd };
    } catch (err) {
      console.error(`ERROR: ${err.message}`);
      console.error('Verificá que AMBOS servidores estén levantados (dev 8081, producción 8080). Este script no los arranca.');
      process.exit(2);
    }
  }

  // 3) Comparar y reportar.
  const reporte = {
    generado: new Date().toISOString(),
    urls: { dev: opt.dev, prod: opt.prod },
    worktreeProd: dirProd,
    archivos,
    clavesListasDivergentes: difLis.clavesDivergentes,
    clavesConfigDivergentes: difCfg,
    tabs: tabs.map(tab => compararTab(tab, descargas[tab].filasDev, descargas[tab].filasProd, difLis, difCfg, opt.maxEjemplos)),
  };
  reporte.hayDiferencias = reporte.tabs.some(t => t.hayDiferencias);

  if (opt.json) { console.log(JSON.stringify(reporte, null, 2)); process.exit(reporte.hayDiferencias ? 1 : 0); }

  console.log(`===== PARIDAD DE ENTORNOS =====\n  dev=${opt.dev}   producción=${opt.prod}   tabs=${tabs.join(',')}`);
  imprimirConfig(reporte);
  for (const r of reporte.tabs) imprimirTab(r);
  console.log('\n===== VEREDICTO =====');
  if (!reporte.hayDiferencias) console.log('✓ Sin diferencias: dev y producción devuelven la misma distribución.');
  else {
    const cfgIdentica = Object.values(archivos).every(a => a.identico);
    console.log('✗ Hay diferencias entre entornos (detalle arriba).');
    console.log(cfgIdentica
      ? 'ℹ La configuración es idéntica → sospechar CÓDIGO o cache (data/a8020*.json, stock vivo de SIGA).'
      : 'ℹ La configuración DIFIERE → sincronizar los data/*.json antes de sospechar del código.');
  }
  process.exit(reporte.hayDiferencias ? 1 : 0);
}

main().catch(err => { console.error(`ERROR inesperado: ${err.message}`); process.exit(2); });
