# Ranking de importancia por sucursal en A8020 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar un score 0-1 de importancia por (sucursal, PLU) en A8020, basado en facturación por sucursal (desempate por volumen de ventas), visible como columna nueva en `a8020.html` junto a cada sucursal.

**Architecture:** Función pura nueva `calcularRankingPorSucursal` en `a8020.js` (ordena PLUs por facturación desc dentro de cada sucursal, empate por volumen desc, score = percentil de posición). Server.js suma un query SQL nuevo (facturación agrupada por sucursal+PLU, hoy solo se agrupa por PLU global) y mergea el resultado en la estructura `detalle` que ya persiste en `a8020_calc.json`. `a8020.html` lee ese campo y agrega columna por sucursal.

**Tech Stack:** Node.js/Express, SQL Server (msnodesqlv8), HTML/vanilla JS sin build step.

Spec: `docs/superpowers/specs/2026-07-08-ranking-importancia-sucursal-a8020-design.md`

---

### Task 1: `calcularRankingPorSucursal` en a8020.js

**Files:**
- Modify: `a8020.js`
- Test: `validar_ranking.js` (nuevo, raíz del repo — mismo patrón que `validar_almacen.js`)

- [ ] **Step 1: Escribir el script de validación (falla porque la función no existe)**

Crear `validar_ranking.js`:

```javascript
'use strict';
// Valida calcularRankingPorSucursal: orden por facturación desc, empate por volumen desc,
// score = percentil de posición (1.0 primero, 0 último, n=1 → 1).
// Uso: node validar_ranking.js
const assert = require('assert');
const { calcularRankingPorSucursal } = require('./a8020');

// Sucursal 'a' (idSucursal=1): plu2 y plu1 empatan en facturación (100), plu2 tiene más volumen → va primero.
// plu3 tiene menos facturación (50) → último, score 0.
const metricPorSuc = {
  1: { '1': 100, '2': 100, '3': 50 },
  2: { '9': 30 },
};
const statRows = [
  { idSucursal: 1, plu: 1, sumQ: 5, sumQ2: 25, dcv: 5 },
  { idSucursal: 1, plu: 2, sumQ: 10, sumQ2: 100, dcv: 5 },
  { idSucursal: 1, plu: 3, sumQ: 1, sumQ2: 1, dcv: 1 },
  { idSucursal: 2, plu: 9, sumQ: 7, sumQ2: 49, dcv: 3 },
];
const sucById = { 1: 'a', 2: 'b' };

const ranking = calcularRankingPorSucursal(metricPorSuc, statRows, sucById);

assert.strictEqual(ranking.a[2], 1, `plu2 (mayor volumen en empate) debería ser 1, dio ${ranking.a[2]}`);
assert.strictEqual(ranking.a[1], 0.5, `plu1 (empate, menor volumen) debería ser 0.5, dio ${ranking.a[1]}`);
assert.strictEqual(ranking.a[3], 0, `plu3 (menor facturación) debería ser 0, dio ${ranking.a[3]}`);
assert.strictEqual(ranking.b[9], 1, `único plu de la sucursal b debería ser 1, dio ${ranking.b[9]}`);
assert.strictEqual(ranking.a[999], undefined, 'plu inexistente no debería tener score');

console.log('OK: calcularRankingPorSucursal ordena por facturación, desempata por volumen y da percentil correcto.');
```

- [ ] **Step 2: Correr el script para confirmar que falla**

Run: `node validar_ranking.js`
Expected: `TypeError: calcularRankingPorSucursal is not a function` (o similar — todavía no existe en a8020.js)

- [ ] **Step 3: Implementar `calcularRankingPorSucursal` en a8020.js**

Agregar al final de `a8020.js`, antes de `module.exports` (línea 118):

```javascript
// metricPorSuc: { idSucursal: { plu: facturación } }  ·  statRows: mismo array que recibe computeA8020
// (usa sumQ como volumen de desempate)  ·  sucById: { idSucursal: sucKey }
// Retorna { sucKey: { plu: score } } — score 0-1, percentil de posición dentro de la sucursal
// (1=más importante, ordenado por facturación desc, empate → volumen desc).
function calcularRankingPorSucursal(metricPorSuc, statRows, sucById) {
  const volPorSuc = {};
  for (const r of statRows) {
    (volPorSuc[r.idSucursal] = volPorSuc[r.idSucursal] || {})[r.plu] = Number(r.sumQ) || 0;
  }
  const idSucs = new Set([
    ...Object.keys(metricPorSuc || {}),
    ...Object.keys(volPorSuc),
  ].map(Number));

  const ranking = {};
  for (const idSucursal of idSucs) {
    const sucKey = sucById[idSucursal];
    if (!sucKey) continue;
    const fact = (metricPorSuc && metricPorSuc[idSucursal]) || {};
    const vol = volPorSuc[idSucursal] || {};
    const plus = new Set([...Object.keys(fact), ...Object.keys(vol)]);
    const items = [...plus].map((plu) => ({
      plu, fact: Number(fact[plu]) || 0, vol: Number(vol[plu]) || 0,
    }));
    items.sort((a, b) => (b.fact - a.fact) || (b.vol - a.vol));
    const n = items.length;
    const scoreByPlu = {};
    items.forEach((it, idx) => {
      scoreByPlu[it.plu] = n <= 1 ? 1 : roundDec(1 - idx / (n - 1), 4);
    });
    ranking[sucKey] = scoreByPlu;
  }
  return ranking;
}
```

Actualizar el export (línea 118):

```javascript
module.exports = { computeA8020, calcularRankingPorSucursal, clasificarABC, roundDec };
```

- [ ] **Step 4: Correr el script y confirmar que pasa**

Run: `node validar_ranking.js`
Expected: `OK: calcularRankingPorSucursal ordena por facturación, desempata por volumen y da percentil correcto.`

- [ ] **Step 5: Commit**

```bash
git add a8020.js validar_ranking.js
git commit -m "feat: calcularRankingPorSucursal — score de importancia por sucursal en A8020"
```

---

### Task 2: Wiring en server.js — query nuevo, cálculo, merge en detalle

**Files:**
- Modify: `server.js:17` (import)
- Modify: `server.js:1801-1807` (agregar función SQL nueva después de `sqlAbcMetric`)
- Modify: `server.js:1808-1845` (`recalcularA8020`)

- [ ] **Step 1: Importar `calcularRankingPorSucursal`**

En `server.js:17`, cambiar:

```javascript
const { computeA8020, roundDec } = require('./a8020');
```

por:

```javascript
const { computeA8020, calcularRankingPorSucursal, roundDec } = require('./a8020');
```

- [ ] **Step 2: Agregar el query SQL agrupado por sucursal+PLU**

En `server.js`, inmediatamente después de `sqlAbcMetric` (línea 1801-1807), agregar:

```javascript
function sqlAbcMetricPorSucursal(idList, meses, metrica) {   // métrica ABC por (sucursal, PLU) — ranking local
  const col = metrica === 'unidades' ? 'vp.Cantidad' : 'vp.ImporteTotalNeto';
  return `SELECT vp.IdSucursal, vp.IdProducto, SUM(${col}) AS Metric
  FROM VentasProductos vp ${_ventasJoin}
  WHERE ${_ventasWhere(idList, meses)}
  GROUP BY vp.IdSucursal, vp.IdProducto`;
}
```

- [ ] **Step 3: Sumar el query al `Promise.all` y construir `metricPorSuc` + `sucById`**

En `recalcularA8020()`, el bloque actual (línea 1812-1822) es:

```javascript
  const sucs = config.sucursales || {};
  const idList = Object.values(sucs).map(s => s.idSucursal).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');
  const meses = config.ventanaMeses || 12;
  const [stats, ops, abcRows] = await Promise.all([
    query(sqlVentasStats(idList, meses)),
    query(sqlDiasOperativos(idList, meses)),
    query(sqlAbcMetric(idList, meses, (config.abc || {}).metrica || 'facturacion')),
  ]);
  const opsDays = {}; for (const r of ops) opsDays[r.IdSucursal] = Number(r.DiasOperativos) || 0;
  const metricByPlu = {}; for (const r of abcRows) metricByPlu[String(r.IdProducto)] = Number(r.Metric) || 0;
```

Reemplazarlo por:

```javascript
  const sucs = config.sucursales || {};
  const idList = Object.values(sucs).map(s => s.idSucursal).join(',');
  if (!idList) throw new Error('Falta data/distribucion_config.json (sucursales).');
  const meses = config.ventanaMeses || 12;
  const metrica = (config.abc || {}).metrica || 'facturacion';
  const [stats, ops, abcRows, abcRowsPorSuc] = await Promise.all([
    query(sqlVentasStats(idList, meses)),
    query(sqlDiasOperativos(idList, meses)),
    query(sqlAbcMetric(idList, meses, metrica)),
    query(sqlAbcMetricPorSucursal(idList, meses, metrica)),
  ]);
  const opsDays = {}; for (const r of ops) opsDays[r.IdSucursal] = Number(r.DiasOperativos) || 0;
  const metricByPlu = {}; for (const r of abcRows) metricByPlu[String(r.IdProducto)] = Number(r.Metric) || 0;
  const metricPorSuc = {};
  for (const r of abcRowsPorSuc) {
    (metricPorSuc[r.IdSucursal] = metricPorSuc[r.IdSucursal] || {})[String(r.IdProducto)] = Number(r.Metric) || 0;
  }
  const sucById = {};
  for (const [key, c] of Object.entries(sucs)) sucById[c.idSucursal] = key;
```

- [ ] **Step 4: Calcular el ranking y mergearlo en `detalle`**

El bloque actual (línea 1836-1845) es:

```javascript
  const { abc, filas } = computeA8020(statRows, opsDays, metricByPlu, config, pesablesSet, overrides);

  const mins = {}, sLevels = {}, detalle = {};
  for (const f of filas) {
    (mins[f.plu] = mins[f.plu] || {})[f.sucursal] = f.min;
    (sLevels[f.plu] = sLevels[f.plu] || {})[f.sucursal] = f.S;
    (detalle[f.plu] = detalle[f.plu] || {})[f.sucursal] =
      { mu: Math.round(f.mu * 1000) / 1000, sigma: Math.round(f.sigma * 1000) / 1000, S: f.S, min: f.min,
        ...(f.propBase ? { propBase: f.propBase, propSoloBase: !!f.propSoloBase } : {}) };
  }
```

Reemplazarlo por:

```javascript
  const { abc, filas } = computeA8020(statRows, opsDays, metricByPlu, config, pesablesSet, overrides);
  const ranking = calcularRankingPorSucursal(metricPorSuc, statRows, sucById);

  const mins = {}, sLevels = {}, detalle = {};
  for (const f of filas) {
    (mins[f.plu] = mins[f.plu] || {})[f.sucursal] = f.min;
    (sLevels[f.plu] = sLevels[f.plu] || {})[f.sucursal] = f.S;
    const rk = (ranking[f.sucursal] || {})[String(f.plu)];
    (detalle[f.plu] = detalle[f.plu] || {})[f.sucursal] =
      { mu: Math.round(f.mu * 1000) / 1000, sigma: Math.round(f.sigma * 1000) / 1000, S: f.S, min: f.min,
        ...(rk != null ? { ranking: rk } : {}),
        ...(f.propBase ? { propBase: f.propBase, propSoloBase: !!f.propSoloBase } : {}) };
  }
```

- [ ] **Step 5: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output (exit 0 = sintaxis válida)

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: server.js calcula y persiste ranking por sucursal en a8020_calc.json"
```

---

### Task 3: Columna "R" por sucursal en a8020.html

**Files:**
- Modify: `a8020.html:53-54` (CSS)
- Modify: `a8020.html:129-136` (construcción de columnas del thead)
- Modify: `a8020.html:143-149` (`valor(r,c)` — soporte de sort)
- Modify: `a8020.html:179-190` (render de filas)

- [ ] **Step 1: Agregar estilos para la celda de ranking**

En `a8020.html`, después de la línea 54 (`.abc.A{...}.abc.B{...}.abc.C{...}`), agregar:

```css
  .rank{font-weight:700;font-size:10.5px;padding:2px 6px;border-radius:5px;display:inline-block;min-width:30px;text-align:center}
  .rank.hi{background:var(--verde);color:#fff}.rank.mid{background:var(--amarillo-cont);color:var(--amarillo-on)}.rank.lo{background:var(--surface3);color:var(--faint)}
```

- [ ] **Step 2: Agregar columna de ranking al thead**

En `a8020.html:129-131`, el bloque actual:

```javascript
  const cols = [['plu','PLU','l'],['nombre','Producto','l'],['abc','ABC','']]
    .concat(SUC.map(([k,n])=>[k,n,'suc']))
    .concat([['tot','Σ S','']]);
```

Reemplazarlo por:

```javascript
  const cols = [['plu','PLU','l'],['nombre','Producto','l'],['abc','ABC','']]
    .concat(SUC.flatMap(([k,n])=>[[k,n,'suc'],[k+'_r','R','suc-rank']]))
    .concat([['tot','Σ S','']]);
```

En `a8020.html:134`, el bloque actual:

```javascript
    const sub = cls==='suc' ? opsTxt(k) : '';
```

Reemplazarlo por:

```javascript
    const sub = cls==='suc' ? opsTxt(k) : cls==='suc-rank' ? `<small>${k.slice(0,-2)}</small>` : '';
```

- [ ] **Step 3: Agregar soporte de sort para las columnas de ranking**

En `a8020.html:143-149`, el bloque actual:

```javascript
function valor(r,c){
  if(c==='tot') return sumS(r);
  if(SUC.some(([k])=>k===c)) return r.mins[c]||0;
  if(c==='nombre') return (r.nombre||'').toLowerCase();
  if(c==='abc') return ({A:0,B:1,C:2})[r.abc] ?? 3;
  return r[c]??0;
}
```

Reemplazarlo por:

```javascript
function valor(r,c){
  if(c==='tot') return sumS(r);
  if(c.endsWith('_r')){ const k=c.slice(0,-2); const d=(r.detalle||{})[k]||{}; return d.ranking??-1; }
  if(SUC.some(([k])=>k===c)) return r.mins[c]||0;
  if(c==='nombre') return (r.nombre||'').toLowerCase();
  if(c==='abc') return ({A:0,B:1,C:2})[r.abc] ?? 3;
  return r[c]??0;
}
```

- [ ] **Step 4: Renderizar la celda de ranking junto a cada celda de sucursal**

En `a8020.html:179-185`, el bloque actual:

```javascript
    const celdas = SUC.map(([k])=>{ const s=r.mins[k]; const d=(r.detalle||{})[k]||{};
      const boot = d.bootstrap===true;
      const mn=(r.trig||{})[k];
      const tip = d.mu!=null?`${boot?'~bootstrap~ ':''}S=${fmt(s)}  ·  min=${fmt(mn)}  ·  μ=${d.mu}  σ=${d.sigma}`:'';
      if(s>0 && boot) return `<td class="s boot"><span title="${tip}">~${fmt(s)}</span></td>`;
      return s>0 ? `<td class="s pos"><span title="${tip}">${fmt(s)}</span></td>` : `<td class="s">·</td>`; }).join('');
```

Reemplazarlo por:

```javascript
    const celdas = SUC.map(([k])=>{ const s=r.mins[k]; const d=(r.detalle||{})[k]||{};
      const boot = d.bootstrap===true;
      const mn=(r.trig||{})[k];
      const tip = d.mu!=null?`${boot?'~bootstrap~ ':''}S=${fmt(s)}  ·  min=${fmt(mn)}  ·  μ=${d.mu}  σ=${d.sigma}`:'';
      const sCell = (s>0 && boot) ? `<td class="s boot"><span title="${tip}">~${fmt(s)}</span></td>`
        : s>0 ? `<td class="s pos"><span title="${tip}">${fmt(s)}</span></td>` : `<td class="s">·</td>`;
      const rk = d.ranking;
      const rkCls = rk==null ? '' : rk>=0.8 ? 'hi' : rk>=0.5 ? 'mid' : 'lo';
      const rkCell = rk==null ? '<td class="s">·</td>' : `<td><span class="rank ${rkCls}">${rk.toFixed(2)}</span></td>`;
      return sCell + rkCell; }).join('');
```

- [ ] **Step 5: Verificar sintaxis del JS embebido**

Run: `node -e "new Function(require('fs').readFileSync('a8020.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1])"`
Expected: sin output (exit 0 = sintaxis válida)

- [ ] **Step 6: Commit**

```bash
git add a8020.html
git commit -m "feat: columna de ranking por sucursal en la tabla A8020"
```

---

### Task 4: Verificación end-to-end

**Files:** ninguno (solo verificación manual)

- [ ] **Step 1: Levantar el server de dev y recalcular A8020**

Con el server de dev corriendo (puerto 8081, lo levanta el usuario — no lo reinicies vos), pegarle al endpoint de recálculo:

Run: `curl http://localhost:8081/api/distribucion/a8020/recalcular`
Expected: JSON de éxito (mismo shape que ya devolvía antes, sin errores 500)

- [ ] **Step 2: Confirmar que `a8020_calc.json` tiene el campo `ranking` poblado**

Run: `node -e "const c=require('./data/a8020_calc.json'); const plu=Object.keys(c.detalle)[0]; console.log(plu, c.detalle[plu])"`
Expected: al menos una sucursal del objeto impreso tiene `ranking` numérico entre 0 y 1.

- [ ] **Step 3: Verificación visual en el navegador**

Abrir `http://localhost:8081/distribucion/a8020` (o la ruta servida — confirmar en `server.js:2047`), confirmar:
- Aparece una columna "R" al lado de cada columna de sucursal.
- El header de "R" tiene el subtexto con la clave de sucursal (`riv`, `urq`, etc.).
- Clickear el header "R" de una sucursal ordena la tabla por ese score.
- Celdas sin dato de ranking muestran "·" en vez de romper el render.

- [ ] **Step 4: Confirmar que no rompió nada existente**

Run: `node validar_almacen.js`
Expected: mismo veredicto que antes de este cambio (✓ PARIDAD 100%) — `calcularAlmacen`/`distribucion.js` no se tocaron, así que no debería haber cambiado nada.
