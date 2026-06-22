'use strict';
// Golden test: corre pesables.js (corregirBugs:false) sobre los inputs de la planilla
// y compara columnas calculadas contra los valores que produjo la planilla.
const fs = require('fs');
const path = require('path');
const { calcularPesables, SUC } = require('./pesables');

const DATA = path.join(__dirname, 'data');
const j = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const a8020 = j('a8020.json');
const pesLis = j('pesables_listas.json');
const distLis = j('distribucion_listas.json');
const golden = j('pesables_golden.json');

const productos = golden.map((g) => ({ plu: g.plu, stocks: g.stocks }));
const res = calcularPesables(productos, a8020, pesLis, distLis, { corregirBugs: false });

const TOL = 1e-4;
const numEq = (a, b) => Math.abs((a || 0) - (b || 0)) <= TOL + 1e-6 * Math.max(Math.abs(a || 0), Math.abs(b || 0));
const txt = (v) => (v == null ? '' : String(v).trim());
const cellEq = (a, b) => {
  const an = typeof a === 'number', bn = typeof b === 'number';
  if (an && bn) return numEq(a, b);
  return txt(a) === txt(b);
};

const diffs = {};
const add = (campo, plu, got, exp) => { (diffs[campo] = diffs[campo] || []).push({ plu, got, exp }); };

for (let i = 0; i < golden.length; i++) {
  const g = golden[i], r = res[i];
  if (g.plu !== r.plu) { add('ORDEN', g.plu, r.plu, g.plu); continue; }
  const isNA = txt(g.sn.riv) === '#N/A';   // PLU ausente del A8020 → fila #N/A (min coercionado a 0 al importar)
  for (const suc of SUC) {
    if (!isNA && !numEq(r.mins[suc.key], g.mins[suc.key])) add('min.' + suc.key, g.plu, r.mins[suc.key], g.mins[suc.key]);
    if (txt(r.sn[suc.key]) !== txt(g.sn[suc.key])) add('sn.' + suc.key, g.plu, r.sn[suc.key], g.sn[suc.key]);
    if (!isNA && !numEq(r.teorico[suc.key], g.teorico[suc.key])) add('teo.' + suc.key, g.plu, r.teorico[suc.key], g.teorico[suc.key]);
    if (!cellEq(r.enviar[suc.key], g.enviar[suc.key])) add('env.' + suc.key, g.plu, r.enviar[suc.key], g.enviar[suc.key]);
  }
  if (!numEq(r.BG, g.BG_imp)) add('BG', g.plu, r.BG, g.BG_imp);
  if (!isNA && !numEq(r.CH, g.CH)) add('CH', g.plu, r.CH, g.CH);   // CH=#N/A en filas-gap (importer coerciona a 0)
  if (!numEq(r.CI, g.CI)) add('CI', g.plu, r.CI, g.CI);
  if (!numEq(r.M, g.M_uso)) add('M', g.plu, r.M, g.M_uso);
  if (!numEq(r.I, g.I_deseada)) add('I', g.plu, r.I, g.I_deseada);
  if (!numEq(r.CG, g.CG_total)) add('CG', g.plu, r.CG, g.CG_total);
  if (!numEq(r.L, g.L_teorico)) add('L', g.plu, r.L, g.L_teorico);
  if (!numEq(r.K, g.K_envasar)) add('K', g.plu, r.K, g.K_envasar);
  if (!numEq(r.D, g.D_aenvasar)) add('D', g.plu, r.D, g.D_aenvasar);
  if (!numEq(r.E, g.E_impEnv)) add('E', g.plu, r.E, g.E_impEnv);
  if (!numEq(r.BM, g.BM)) add('BM', g.plu, r.BM, g.BM);
  if (!numEq(r.G, g.G_deposito)) add('G', g.plu, r.G, g.G_deposito);
  if (txt(r.J) !== txt(g.J_envasar)) add('J', g.plu, r.J, g.J_envasar);
  if (txt(r.BJ) !== txt(g.BJ)) add('BJ', g.plu, r.BJ, g.BJ);
  if (txt(r.BK) !== txt(g.BK)) add('BK', g.plu, r.BK, g.BK);
  if (txt(r.BL) !== txt(g.BL_grupo)) add('BL', g.plu, r.BL, g.BL_grupo);
}

const campos = Object.keys(diffs).sort((a, b) => diffs[b].length - diffs[a].length);
console.log(`Filas: ${golden.length}`);
if (!campos.length) { console.log('PARIDAD 100% — 0 diffs.'); process.exit(0); }
let total = 0;
for (const c of campos) {
  const d = diffs[c]; total += d.length;
  const ej = d.slice(0, 4).map((x) => `plu ${x.plu}: got ${JSON.stringify(x.got)} exp ${JSON.stringify(x.exp)}`).join('  |  ');
  console.log(`  ${c.padEnd(14)} ${String(d.length).padStart(4)} diffs   ${ej}`);
}
console.log(`TOTAL diffs: ${total}`);
