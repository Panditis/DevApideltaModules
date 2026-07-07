# Distribución: universo de artículos directo de Siga — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El universo de artículos de las tabs Almacén y Pesables sale de una query
directa a Siga por rubro (activos), no de `importar_distribucion.py`/Excel. "Fact" pasa
a ser 100% dinámico. "Restringidos" pasa a lista editable por sucursal.

**Architecture:** `server.js` reemplaza la fuente de `plus` (universo de PLUs) en
`calcularDistribucionAlmacen()`/`calcularDistribucionPesables()` por queries SQL a
`Productos`/`Rubros`. `leerListasDistrib()` gana un campo `restringidos` (objeto
por-sucursal) persistido en `data/listas_distribucion.json`, con seed único desde el
snapshot Excel existente. `pesables.js` deja de leer flags estáticos de Fact.
`distribucion.html` gana una tab "Restringidos" con selector de sucursal.

**Tech Stack:** Node.js/Express, mssql (SQL Server/Siga), JSON como storage de config,
sin framework de test — verificación vía scripts `node -e` contra la DB real y curl
contra el server dev (puerto 8081), mismo patrón que `validar_almacen.js`.

**Contexto de referencia:** `docs/superpowers/specs/2026-07-07-distribucion-universo-siga-design.md`

---

### Task 0: Confirmar servidor dev corriendo

**Files:** ninguno (solo verificación de entorno)

- [ ] **Step 1: Confirmar server dev responde**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/api/distribucion/rubros-lista`
Expected: `200`

Si no responde, avisar al usuario — NO iniciar el servidor (lo maneja el usuario, ver
memoria de proyecto "No reiniciar servidor").

---

### Task 1: `leerListasDistrib()` — agregar lista editable "restringidos"

**Files:**
- Modify: `server.js:1981-1994` (función `leerListasDistrib`)

- [ ] **Step 1: Reemplazar la función `leerListasDistrib`**

Ubicar el bloque actual:
```javascript
function leerListasDistrib() {
  let l = leerJSON(LISTAS_DISTRIB_PATH, null);
  if (!l) {   // seed: noEnvasa del snapshot de la planilla; siempre* vacíos
    const snap = leerJSON(DISTRIB_LISTAS_PATH, {});
    l = { noEnvasa: (snap.noEnvasa || []).map(Number).sort((a, b) => a - b), siempreAlmacen: [], siemprePesable: [], siemprePesableSinGranel: [], ocultarPesable: [] };
    guardarJSON(LISTAS_DISTRIB_PATH, l);
  }
  l.noEnvasa = (l.noEnvasa || []).map(Number);
  l.siempreAlmacen = (l.siempreAlmacen || []).map(Number);
  l.siemprePesable = (l.siemprePesable || []).map(Number);
  l.siemprePesableSinGranel = (l.siemprePesableSinGranel || []).map(Number);
  l.ocultarPesable = (l.ocultarPesable || []).map(Number);   // ocultos solo en Pesables
  return l;
}
```

Reemplazar por:
```javascript
const RESTR_SUCURSALES = ['rivadavia', 'urquiza', 'chacabuco', 'nacion', 'pergamino', 'sanPedro', 'villaRamallo'];
function leerListasDistrib() {
  let l = leerJSON(LISTAS_DISTRIB_PATH, null);
  if (!l) {   // seed: noEnvasa + restringidos del snapshot de la planilla; siempre* vacíos
    const snap = leerJSON(DISTRIB_LISTAS_PATH, {});
    const restrSnap = snap.restringidos || {};
    l = { noEnvasa: (snap.noEnvasa || []).map(Number).sort((a, b) => a - b), siempreAlmacen: [], siemprePesable: [], siemprePesableSinGranel: [], ocultarPesable: [],
      restringidos: Object.fromEntries(RESTR_SUCURSALES.map(k => [k, (restrSnap[k] || []).map(Number).sort((a, b) => a - b)])) };
    guardarJSON(LISTAS_DISTRIB_PATH, l);
  }
  l.noEnvasa = (l.noEnvasa || []).map(Number);
  l.siempreAlmacen = (l.siempreAlmacen || []).map(Number);
  l.siemprePesable = (l.siemprePesable || []).map(Number);
  l.siemprePesableSinGranel = (l.siemprePesableSinGranel || []).map(Number);
  l.ocultarPesable = (l.ocultarPesable || []).map(Number);   // ocultos solo en Pesables
  l.restringidos = l.restringidos || {};
  for (const k of RESTR_SUCURSALES) l.restringidos[k] = (l.restringidos[k] || []).map(Number);
  return l;
}
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: agrega lista editable restringidos por sucursal en leerListasDistrib"
```

---

### Task 2: Endpoint `/api/distribucion/listas` — soportar sub-lista por sucursal

**Files:**
- Modify: `server.js:2096-2118` (endpoints GET/POST `/api/distribucion/listas`)

- [ ] **Step 1: Reemplazar el bloque de los 2 endpoints**

Ubicar:
```javascript
app.get('/api/distribucion/listas', apiRoute(async () => {
  const l = leerListasDistrib();
  const all = [...new Set([...l.noEnvasa, ...l.siempreAlmacen, ...l.siemprePesable, ...l.siemprePesableSinGranel, ...l.ocultarPesable])];
  const nombres = {};
  if (all.length) {
    const inList = all.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga
    const rows = await query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${inList})`);
    for (const r of rows) nombres[String(r.IdProducto)] = r.NombreProducto;
  }
  return { ...l, nombres };
}));
app.post('/api/distribucion/listas', (req, res) => {
  const cur = leerListasDistrib();
  const { lista, accion, plu } = req.body || {};
  if (!['noEnvasa', 'siempreAlmacen', 'siemprePesable', 'siemprePesableSinGranel', 'ocultarPesable'].includes(lista) ||
      !['add', 'remove'].includes(accion) || !Number.isFinite(Number(plu)))
    return res.status(400).json({ error: 'parámetros inválidos' });
  const set = new Set(cur[lista]);
  if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
  cur[lista] = [...set].sort((a, b) => a - b);
  guardarJSON(LISTAS_DISTRIB_PATH, cur);
  res.json({ ok: true, lista, count: cur[lista].length });
});
```

Reemplazar por:
```javascript
app.get('/api/distribucion/listas', apiRoute(async () => {
  const l = leerListasDistrib();
  const all = [...new Set([...l.noEnvasa, ...l.siempreAlmacen, ...l.siemprePesable, ...l.siemprePesableSinGranel, ...l.ocultarPesable,
    ...Object.values(l.restringidos).flat()])];
  const nombres = {};
  if (all.length) {
    const inList = all.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga
    const rows = await query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${inList})`);
    for (const r of rows) nombres[String(r.IdProducto)] = r.NombreProducto;
  }
  return { ...l, nombres };
}));
app.post('/api/distribucion/listas', (req, res) => {
  const cur = leerListasDistrib();
  const { lista, accion, plu, sucursal } = req.body || {};
  if (!['add', 'remove'].includes(accion) || !Number.isFinite(Number(plu)))
    return res.status(400).json({ error: 'parámetros inválidos' });
  if (lista === 'restringidos') {
    if (!RESTR_SUCURSALES.includes(sucursal))
      return res.status(400).json({ error: 'sucursal inválida' });
    const set = new Set(cur.restringidos[sucursal]);
    if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
    cur.restringidos[sucursal] = [...set].sort((a, b) => a - b);
    guardarJSON(LISTAS_DISTRIB_PATH, cur);
    return res.json({ ok: true, lista, sucursal, count: cur.restringidos[sucursal].length });
  }
  if (!['noEnvasa', 'siempreAlmacen', 'siemprePesable', 'siemprePesableSinGranel', 'ocultarPesable'].includes(lista))
    return res.status(400).json({ error: 'parámetros inválidos' });
  const set = new Set(cur[lista]);
  if (accion === 'add') set.add(Number(plu)); else set.delete(Number(plu));
  cur[lista] = [...set].sort((a, b) => a - b);
  guardarJSON(LISTAS_DISTRIB_PATH, cur);
  res.json({ ok: true, lista, count: cur[lista].length });
});
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: endpoint listas soporta alta/baja de restringidos por sucursal"
```

(La verificación end-to-end de estos endpoints contra el server real se hace en Task 6,
después de que el usuario reinicie el servidor con todos los cambios.)

---

### Task 3: `calcularDistribucionAlmacen()` — universo directo de Siga

**Files:**
- Modify: `server.js:1543-1558` (inicio de `calcularDistribucionAlmacen`, hasta la línea del `throw`)

- [ ] **Step 1: Reemplazar el bloque inicial de la función**

Ubicar (dentro de `calcularDistribucionAlmacen`):
```javascript
async function calcularDistribucionAlmacen() {
  const a8020  = leerJSON(A8020_PATH, {});
  const listas = leerJSON(DISTRIB_LISTAS_PATH, {});
  const distCfg = leerJSON(DISTRIB_CONFIG_PATH, {});
  const empujePresencia = (distCfg.empujeDeposito || {}).presencia || 0;
  const importanciaCfg = distCfg.importancia || {};
  const umbralMicroEnvio = distCfg.umbralMicroEnvio || 0;
  // BG vivo: usa facturación de Siga (a8020_calc.json) como importancia en vez de la planilla estática.
  if ((importanciaCfg.fuente || 'siga') !== 'planilla') {
    const impViva = (leerJSON(A8020_CALC_PATH, {}) || {}).impFacturacion;
    if (impViva && Object.keys(impViva).length) listas.importanciaMinorista = impViva;
  }
  const ed = leerListasDistrib();
  listas.noEnvasa = ed.noEnvasa;   // usa la lista editable de exclusión
  const plus = universoLista(Object.keys(listas.productosAlmacen || {}), ed.siempreAlmacen, ed.noEnvasa);
  if (!plus.length) throw new Error('Falta data/distribucion_listas.json — corré: python importar_distribucion.py');
```

Reemplazar por:
```javascript
async function calcularDistribucionAlmacen() {
  const a8020  = leerJSON(A8020_PATH, {});
  const distCfg = leerJSON(DISTRIB_CONFIG_PATH, {});
  const empujePresencia = (distCfg.empujeDeposito || {}).presencia || 0;
  const importanciaCfg = distCfg.importancia || {};
  const umbralMicroEnvio = distCfg.umbralMicroEnvio || 0;
  const impViva = (leerJSON(A8020_CALC_PATH, {}) || {}).impFacturacion || {};
  const ed = leerListasDistrib();
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro='Almacen'`);
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoLista(basePlus, ed.siempreAlmacen, ed.noEnvasa);
  if (!plus.length) throw new Error('Sin productos activos de rubro "Almacen" en Siga.');
  const listas = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, productosAlmacen: {}, importanciaMinorista: impViva };
```

- [ ] **Step 2: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: universo Almacen sale de rubro Siga en vivo, no de Excel"
```

---

### Task 4: `calcularDistribucionPesables()` — universo directo de Siga

**Files:**
- Modify: `server.js:1609-1624` (inicio de `calcularDistribucionPesables`)
- Modify: `server.js:1669-1674` (mapeo final de salida, campo `rubro`)
- Modify: `server.js:1655-1658` (sacar `recKeys`, ya no lo usa `calcularPesables`)

- [ ] **Step 1: Reemplazar el bloque inicial de la función**

Ubicar:
```javascript
async function calcularDistribucionPesables(aplicarOcultar = true) {
  const a8020   = leerJSON(A8020_PATH, {});
  const pesLis  = leerJSON(PESABLES_LISTAS_PATH, {});
  const distLis = leerJSON(DISTRIB_LISTAS_PATH, {});
  const ed = leerListasDistrib();
  distLis.noEnvasa = ed.noEnvasa;   // lista editable de exclusión
  // BG vivo: facturación de Siga como importancia (BG) en vez de la planilla estática.
  if ((((leerJSON(DISTRIB_CONFIG_PATH, {}).importancia) || {}).fuente || 'siga') !== 'planilla') {
    const impViva = (leerJSON(A8020_CALC_PATH, {}) || {}).impFacturacion;
    if (impViva && Object.keys(impViva).length) distLis.importanciaMinorista = impViva;
  }
  const formulas = pesLis.formulas || {};
  const ocultos = new Set(aplicarOcultar ? ed.ocultarPesable.map(String) : []);   // checkbox "Ocultar códigos" en Pesables
  const plus = universoLista(Object.keys(pesLis.productosPesables || {}), ed.siemprePesable, ed.noEnvasa)
    .filter(p => !ocultos.has(String(p)));
  if (!plus.length) throw new Error('Falta data/pesables_listas.json — corré: python importar_distribucion.py');
```

Reemplazar por:
```javascript
async function calcularDistribucionPesables(aplicarOcultar = true) {
  const a8020   = leerJSON(A8020_PATH, {});
  const pesLis  = leerJSON(PESABLES_LISTAS_PATH, {});
  const ed = leerListasDistrib();
  const impViva = (leerJSON(A8020_CALC_PATH, {}) || {}).impFacturacion || {};
  const distLis = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, importanciaMinorista: impViva };
  const formulas = pesLis.formulas || {};
  const ocultos = new Set(aplicarOcultar ? ed.ocultarPesable.map(String) : []);   // checkbox "Ocultar códigos" en Pesables
  const rubroRows = await query(`SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, r.NombreRubro
    FROM Productos p JOIN Rubros r ON r.IdRubro=p.IdRubro
    WHERE p.Activo=1 AND r.NombreRubro IN ('Pesables Fraccionado','Pesables Produccion')`);
  const rubroMapP = new Map(rubroRows.map(r => [r.IdProducto, r.NombreRubro]));
  const basePlus = rubroRows.map(r => r.IdProducto);
  const plus = universoLista(basePlus, ed.siemprePesable, ed.noEnvasa)
    .filter(p => !ocultos.has(String(p)));
  if (!plus.length) throw new Error('Sin productos activos de rubro "Pesables Fraccionado"/"Pesables Produccion" en Siga.');
```

- [ ] **Step 2: Actualizar el campo `rubro` de salida para usar el mapa en vivo**

Ubicar (mapeo final, cerca del final de la función):
```javascript
  return filas.map(f => ({ plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: f.rubro,
```

Reemplazar por:
```javascript
  return filas.map(f => ({ plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapP.get(String(f.plu)) || '',
```

- [ ] **Step 3: Sacar `recKeys` (ya no lo usa `calcularPesables`, Task 5)**

Ubicar:
```javascript
  const recKeys = new Set(Object.keys(fact.recByKey));
  const pesParams = leerJSON(PESABLES_PARAMS_PATH, {});   // pesos de prioridad editables (opcional)
  const filas = calcularPesables(productos, a8020, pesLis, distLis,
    { corregirBugs: true, prioPesos: pesParams.prioPesos, granelCap: pesParams.granelCap }, recKeys);
```

Reemplazar por:
```javascript
  const pesParams = leerJSON(PESABLES_PARAMS_PATH, {});   // pesos de prioridad editables (opcional)
  const filas = calcularPesables(productos, a8020, pesLis, distLis,
    { corregirBugs: true, prioPesos: pesParams.prioPesos, granelCap: pesParams.granelCap });
```

- [ ] **Step 4: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: universo Pesables sale de rubro Siga en vivo, no de Excel"
```

---

### Task 5: `pesables.js` — Fact 100% dinámico (sin flags estáticos del Excel)

**Files:**
- Modify: `pesables.js:107-119` (`enviarTeorico`, `enviarFinal`)
- Modify: `pesables.js:123-168` (`calcularPesables`, firma + pasada 1)
- Modify: `pesables.js:184-185` (pasada 2, llamada a `enviarFinal`)
- Modify: `pesables.js:272-274` (`formatearFila`)

- [ ] **Step 1: Simplificar `enviarTeorico` y `enviarFinal`**

Ubicar:
```javascript
function enviarTeorico(suc, sn, S, stock, flags, recKeys) {
  if (suc.teoFlag && !(recKeys && recKeys.has(suc.key)) && (flags[suc.teoFlag] || 0) === 1) return 0;
  if (sn !== 'Si') return 0;
  return Math.min(Math.max(S - stock, 0), P.maxEnviar);
}

function enviarFinal(suc, plu, sn, teo, M, restrSets, flags, recKeys) {
  if (suc.restr && restrSets[suc.restr] && restrSets[suc.restr].has(plu)) return 'Restringido';
  // Si la sucursal tiene REC-SUC registrado, ignorar flag estático — calcularFactLive() maneja Fact en vivo
  if (suc.envFlag && !(recKeys && recKeys.has(suc.key)) && (flags[suc.envFlag] || 0) > 0) return 'Fact';
  if (sn !== 'Si') return sn;
  return Math.min(M < 1 ? teo : teo / M, P.maxEnviar);
}
```

Reemplazar por:
```javascript
function enviarTeorico(sn, S, stock) {
  if (sn !== 'Si') return 0;
  return Math.min(Math.max(S - stock, 0), P.maxEnviar);
}

// Fact es 100% dinámico (calcularFactLive() en server.js, post-cálculo) — no hay
// fallback estático de planilla.
function enviarFinal(suc, plu, sn, teo, M, restrSets) {
  if (suc.restr && restrSets[suc.restr] && restrSets[suc.restr].has(plu)) return 'Restringido';
  if (sn !== 'Si') return sn;
  return Math.min(M < 1 ? teo : teo / M, P.maxEnviar);
}
```

- [ ] **Step 2: Actualizar `calcularPesables` — firma y pasada 1 (sacar `prodPes`/`flags`/`recKeys`)**

Ubicar:
```javascript
function calcularPesables(productos, a8020, pesLis, distLis, opts, recKeys = new Set()) {
  const corregir = !opts || opts.corregirBugs !== false;
  const prodPes = pesLis.productosPesables || {};
  const formulas = pesLis.formulas || {};
```

Reemplazar por:
```javascript
function calcularPesables(productos, a8020, pesLis, distLis, opts) {
  const corregir = !opts || opts.corregirBugs !== false;
  const formulas = pesLis.formulas || {};
```

Ubicar (dentro de la pasada 1, construcción de cada fila):
```javascript
  const rows = productos.map((pp) => {
    const plu = Number(pp.plu);
    const st = pp.stocks || {};
    const pInfo = prodPes[String(plu)] || {};
    const flags = pInfo.flags || {};
    const fInfo = formulas[String(plu)] || {};
```

Reemplazar por:
```javascript
  const rows = productos.map((pp) => {
    const plu = Number(pp.plu);
    const st = pp.stocks || {};
    const fInfo = formulas[String(plu)] || {};
```

Ubicar (fin de la pasada 1, `for` de sucursales y return de la fila):
```javascript
      sn[suc.key] = enviarSN(BK === 'Si', stock, m, H, F, suc);   // gatillo con min (punto de pedido)
      teo[suc.key] = enviarTeorico(suc, sn[suc.key], s, stock, flags, recKeys);   // repone hasta S
    }
    const sumTeo = SUC.reduce((s, suc) => s + teo[suc.key], 0);
    // PLU ausente del A8020: los teóricos son #N/A ⇒ CH = SUM(#N/A) = #N/A (NaN).
    // El #N/A contamina el SUMIF del grupo granel ⇒ CI=0 para todo el grupo (réplica exacta).
    const CH = a ? Math.max(sumTeo - H, 0) : NaN;
    return { plu, granel, gkey, cl, BK, BG, F, H, flags, mins, sn, teo, sumTeo, CH,
             rubro: pInfo.rubro || '', peso: Number(pesos[gkey]) || 0, fracOk: fracSet.has(plu) };
```

Reemplazar por:
```javascript
      sn[suc.key] = enviarSN(BK === 'Si', stock, m, H, F, suc);   // gatillo con min (punto de pedido)
      teo[suc.key] = enviarTeorico(sn[suc.key], s, stock);   // repone hasta S
    }
    const sumTeo = SUC.reduce((s, suc) => s + teo[suc.key], 0);
    // PLU ausente del A8020: los teóricos son #N/A ⇒ CH = SUM(#N/A) = #N/A (NaN).
    // El #N/A contamina el SUMIF del grupo granel ⇒ CI=0 para todo el grupo (réplica exacta).
    const CH = a ? Math.max(sumTeo - H, 0) : NaN;
    return { plu, granel, gkey, cl, BK, BG, F, H, mins, sn, teo, sumTeo, CH,
             peso: Number(pesos[gkey]) || 0, fracOk: fracSet.has(plu) };
```

Nota: se saca `rubro: pInfo.rubro||''` del objeto — `formatearFila` deja de exponer
`rubro` (server.js ya lo agrega en el mapeo final con datos en vivo, Task 4 Step 2).

- [ ] **Step 3: Actualizar la llamada a `enviarFinal` en la pasada 2**

Ubicar:
```javascript
    for (const suc of SUC) {
      const e = enviarFinal(suc, r.plu, r.sn[suc.key], r.teo[suc.key], r.M, restrSets, r.flags, recKeys);
```

Reemplazar por:
```javascript
    for (const suc of SUC) {
      const e = enviarFinal(suc, r.plu, r.sn[suc.key], r.teo[suc.key], r.M, restrSets);
```

- [ ] **Step 4: Sacar `rubro` de `formatearFila`**

Ubicar:
```javascript
function formatearFila(r) {
  return {
    plu: r.plu, granel: r.granel, rubro: r.rubro, peso: r.peso,
```

Reemplazar por:
```javascript
function formatearFila(r) {
  return {
    plu: r.plu, granel: r.granel, peso: r.peso,
```

- [ ] **Step 5: Verificar sintaxis**

Run: `node -c pesables.js`
Expected: sin output

- [ ] **Step 6: Commit**

```bash
git add pesables.js
git commit -m "refactor: Fact dinamico en pesables, saca fallback estatico del Excel"
```

---

### Task 6: Verificación end-to-end contra el server dev

**Files:** ninguno (solo verificación — requiere que el usuario reinicie el server dev
con `npm run dev`/`node server.js`, ver memoria "No reiniciar servidor": avisar al
usuario y esperar confirmación antes de este task).

- [ ] **Step 1: Avisar al usuario que reinicie el server dev y esperar confirmación**

No reiniciar el proceso — el usuario lo hace manualmente.

- [ ] **Step 2: Verificar que 5733 aparece en Almacén**

Run: `curl -s http://localhost:8081/api/distribucion/almacen | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const f=j.find(x=>String(x.plu)==='5733');console.log(f?'OK: '+f.nombre:'FALTA 5733');})"`
Expected: `OK: Leche Descremada La Serenisima Protein 1L`

- [ ] **Step 3: Verificar conteo de universo Almacén razonable (~2180 +overrides)**

Run: `curl -s http://localhost:8081/api/distribucion/almacen | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('total:',JSON.parse(d).length))"`
Expected: número cercano a 2180 (puede variar levemente por `siempreAlmacen`/`noEnvasa`)

- [ ] **Step 4: Verificar tab Pesables responde sin error**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/api/distribucion/pesables`
Expected: `200`

- [ ] **Step 5: Verificar endpoint restringidos — alta y baja**

Run:
```
curl -s -X POST http://localhost:8081/api/distribucion/listas -H "Content-Type: application/json" -d '{"lista":"restringidos","sucursal":"rivadavia","accion":"add","plu":99999}'
curl -s http://localhost:8081/api/distribucion/listas | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.restringidos.rivadavia.includes(99999)?'OK add':'FALLO add')})"
curl -s -X POST http://localhost:8081/api/distribucion/listas -H "Content-Type: application/json" -d '{"lista":"restringidos","sucursal":"rivadavia","accion":"remove","plu":99999}'
curl -s http://localhost:8081/api/distribucion/listas | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(!j.restringidos.rivadavia.includes(99999)?'OK remove':'FALLO remove')})"
```
Expected: `OK add` y `OK remove`

- [ ] **Step 6: Comparar universo viejo vs nuevo — detectar productos que desaparecen**

Run:
```bash
node -e "
const oldListas = require('./data/distribucion_listas.json');
const oldPlus = new Set(Object.keys(oldListas.productosAlmacen || {}));
fetch('http://localhost:8081/api/distribucion/almacen').then(r=>r.json()).then(rows => {
  const newPlus = new Set(rows.map(r => String(r.plu)));
  const perdidos = [...oldPlus].filter(p => !newPlus.has(p));
  console.log('productos que ya no aparecen:', perdidos.length);
  console.log(perdidos.slice(0, 30));
});
"
```
Expected: revisar la lista impresa — son productos que estaban en el Excel pero no
tienen rubro "Almacen" activo en Siga hoy (mal categorizados, dados de baja, o
requieren agregarse a "Siempre en Almacén"). Reportar al usuario, no auto-corregir.

- [ ] **Step 7: Reportar resultado al usuario**

Resumir: cuántos productos nuevos aparecieron, cuántos "perdidos" (Step 6) y sus
nombres/PLUs para que el usuario decida si van a "Siempre en Almacén" o se corrige el
rubro en Siga.

---

### Task 7: UI — tab "Restringidos" en distribucion.html

**Files:**
- Modify: `distribucion.html:356-370` (nav de tabs, agregar botón)
- Modify: `distribucion.html:468-473` (panel section)
- Modify: `distribucion.html:1055` (`activarTab`, rama del `else` genérico)
- Modify: `distribucion.html` (agregar funciones JS nuevas cerca de `renderLista`/`modificarLista`, ~línea 1107)
- Modify: `distribucion.html:998-999` (`errHTML`, mensaje ya no menciona Excel)

- [ ] **Step 1: Agregar botón de tab**

Ubicar:
```html
      <button class="tab cfg-tab" data-tab="ocultar-pesable">Ocultar Pesable <span class="pill" id="pillOcultarPesable">🚫</span></button>
```

Agregar justo después:
```html
      <button class="tab cfg-tab" data-tab="restringidos">Restringidos <span class="pill" id="pillRestringidos">🔒</span></button>
```

- [ ] **Step 2: Agregar panel section**

Ubicar:
```html
    <section class="panel listpanel" id="panel-ocultar-pesable"></section>
```

Agregar justo después:
```html
    <section class="panel listpanel" id="panel-restringidos"></section>
```

- [ ] **Step 3: Agregar branch en `activarTab` (excluye "restringidos" del editor genérico de un solo array)**

Ubicar:
```javascript
  else { construirEditor(name); if(!listasData) cargarListas().then(()=>renderLista(name)); else renderLista(name); }
```

Reemplazar por:
```javascript
  else if (name==='restringidos') { construirEditorRestr(); if(!listasData) cargarListas().then(()=>renderRestr()); else renderRestr(); }
  else { construirEditor(name); if(!listasData) cargarListas().then(()=>renderLista(name)); else renderLista(name); }
```

- [ ] **Step 4: Agregar funciones JS de la tab Restringidos**

Ubicar (después de la función `modificarLista`, línea ~1107):
```javascript
async function modificarLista(key,accion,plu){
  await fetch('/api/distribucion/listas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lista:key,accion,plu:Number(plu)})});
  await cargarListas(); renderLista(tabActual);
  datos=[]; datosP=[]; pCargado=false;   // invalida data principal: refleja el cambio al volver
}
```

Agregar justo después:
```javascript
// ── Tab Restringidos (por sucursal) ──────────────────────────────────────────
const RESTR_SUC_LABEL = { rivadavia:'Rivadavia', urquiza:'Urquiza', chacabuco:'Chacabuco', nacion:'Nación', pergamino:'Pergamino', sanPedro:'San Pedro', villaRamallo:'Villa Ramallo' };
let restrSucActual = 'rivadavia';
function construirEditorRestr(){
  const cont=document.getElementById('panel-restringidos'); if(cont.dataset.built) return;
  cont.innerHTML = `<div class="lista-editor">
    <div class="lista-head"><h2>Restringidos por sucursal</h2><span class="lista-count"></span></div>
    <p class="hint">Productos que nunca se envían a la sucursal seleccionada.</p>
    <div class="suc-tog-row">${Object.entries(RESTR_SUC_LABEL).map(([k,l])=>`<button class="suc-tog${k==='rivadavia'?' on':''}" data-suc="${k}">${l}</button>`).join('')}</div>
    <div class="lista-add"><input class="lsearch" placeholder="Buscar PLU o producto para agregar…"><div class="resultados"></div></div>
    <div class="lista-items"></div></div>`;
  cont.querySelectorAll('.suc-tog').forEach(b=> b.onclick=()=>{ restrSucActual=b.dataset.suc; cont.querySelectorAll('.suc-tog').forEach(x=>x.classList.toggle('on',x===b)); renderRestr(); });
  const inp=cont.querySelector('.lsearch'); let tmr;
  inp.oninput=()=>{ clearTimeout(tmr); tmr=setTimeout(()=>buscarProductoRestr(inp.value),220); };
  document.addEventListener('click',e=>{ if(!cont.contains(e.target)) cont.querySelector('.resultados').innerHTML=''; });
  cont.dataset.built='1';
}
function renderRestr(){
  const cont=document.getElementById('panel-restringidos');
  const plus=(listasData.restringidos && listasData.restringidos[restrSucActual]) || [];
  const items=plus.map(plu=>({plu, nombre:(listasData.nombres||{})[plu]||''}));
  cont.querySelector('.lista-count').textContent=items.length+' productos';
  cont.querySelector('.lista-items').innerHTML = items.length
    ? items.map(it=>`<div class="chip"><b>${it.plu}</b><span class="nom">${it.nombre||'<sin nombre>'}</span><button class="rm" data-plu="${it.plu}" title="Quitar">✕</button></div>`).join('')
    : '<div class="vacio">Lista vacía. Buscá un producto arriba para agregarlo.</div>';
  cont.querySelectorAll('.rm').forEach(b=> b.onclick=()=>modificarRestr('remove',b.dataset.plu));
}
async function buscarProductoRestr(q){
  const box=document.querySelector('#panel-restringidos .resultados');
  if(q.trim().length<2){ box.innerHTML=''; return; }
  const r=await fetch('/api/distribucion/buscar?q='+encodeURIComponent(q.trim())); const rows=await r.json();
  const ya=new Set(((listasData.restringidos && listasData.restringidos[restrSucActual]) || []).map(Number));
  box.innerHTML = rows.length ? rows.map(p=>`<div class="res" data-plu="${p.IdProducto}"><b>${p.IdProducto}</b><span>${p.NombreProducto}${ya.has(Number(p.IdProducto))?' ✓':''}</span></div>`).join('') : '<div class="vacio">Sin resultados</div>';
  box.querySelectorAll('.res').forEach(d=> d.onclick=()=>{ modificarRestr('add',d.dataset.plu); box.innerHTML=''; document.querySelector('#panel-restringidos .lsearch').value=''; });
}
async function modificarRestr(accion,plu){
  await fetch('/api/distribucion/listas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lista:'restringidos',sucursal:restrSucActual,accion,plu:Number(plu)})});
  await cargarListas(); renderRestr();
  datos=[]; datosP=[]; pCargado=false;
}
```

- [ ] **Step 5: Actualizar mensaje de error genérico (ya no depende del Excel)**

Ubicar:
```javascript
const errHTML = (msg) => `<div style="font-size:30px">⚠</div><div>${msg}</div>
  <div style="color:var(--faint);font-size:12px">¿Corriste <code>python importar_distribucion.py</code> y está Siga accesible?</div>`;
```

Reemplazar por:
```javascript
const errHTML = (msg) => `<div style="font-size:30px">⚠</div><div>${msg}</div>
  <div style="color:var(--faint);font-size:12px">¿Está Siga accesible?</div>`;
```

- [ ] **Step 6: Verificación manual en navegador**

Abrir `http://localhost:8081/distribucion`, click en el engranaje (⚙) para mostrar tabs
de config, click en tab "Restringidos". Verificar: selector de 7 sucursales visible,
buscador funciona, agregar/quitar un PLU de prueba actualiza el pill count.

- [ ] **Step 7: Commit**

```bash
git add distribucion.html
git commit -m "feat: agrega tab UI Restringidos por sucursal"
```

---

## Resumen de archivos tocados
- `server.js` — `leerListasDistrib`, endpoints `/api/distribucion/listas`,
  `calcularDistribucionAlmacen`, `calcularDistribucionPesables`
- `pesables.js` — `enviarTeorico`, `enviarFinal`, `calcularPesables`, `formatearFila`
- `distribucion.html` — nueva tab "Restringidos"
- Sin cambios: `distribucion.js`, `a8020.js`, `importar_distribucion.py` (sigue
  existiendo para fórmulas granel, fuera de alcance), `validar_almacen.js`,
  `validar_pesables.js`
