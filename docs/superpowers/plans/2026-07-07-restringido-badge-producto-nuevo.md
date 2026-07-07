# Badge Restringido + Producto Nuevo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar badge visual para celdas restringidas y para productos nuevos
(primera compra dentro de 30 días), con piso de prioridad para estos últimos.

**Architecture:** `server.js` calcula `esNuevo`/`primeraCompra` por PLU (query a
`MovimientosStock`) dentro de `calcularDistribucionAlmacen`/`calcularDistribucionPesables`,
aplica piso de prioridad como post-procesamiento sobre `impNorm`/`prioridad`/`prioridadSala`,
y expone los campos nuevos en la respuesta JSON. `distribucion.html` consume esos campos
para pintar 2 badges (Restr. / Nuevo) en las tablas de Almacén y Pesables.

**Tech Stack:** Node.js/Express, mssql, HTML/JS inline. Sin test framework — verificación
vía `node -c`, `node -e` con `new Function()` para el script inline, y curl contra el
server dev.

**Contexto de referencia:** `docs/superpowers/specs/2026-07-07-restringido-badge-producto-nuevo-design.md`

---

### Task 1: `calcularDistribucionAlmacen()` — detectar producto nuevo + piso de prioridad

**Files:**
- Modify: `server.js:1543-1596` (función `calcularDistribucionAlmacen`)

- [ ] **Step 1: Agregar cómputo de `esNuevo`/`primeraCompra`, después de tener `plus`**

Ubicar (dentro de `calcularDistribucionAlmacen`):
```javascript
  const plus = universoLista(basePlus, ed.siempreAlmacen, ed.noEnvasa);
  if (!plus.length) throw new Error('Sin productos activos de rubro "Almacen" en Siga.');
  const listas = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, productosAlmacen: {}, importanciaMinorista: impViva };
  const inList = plus.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga → citar
  const [stockRows, nombres, fact] = await Promise.all([
    query(sqlStockDistribucion(plus)),
    query(`SELECT p.IdProducto, p.NombreProducto, r.NombreRubro FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro WHERE p.IdProducto IN (${inList})`),
    calcularFactLive(),
  ]);
```

Reemplazar por:
```javascript
  const plus = universoLista(basePlus, ed.siempreAlmacen, ed.noEnvasa);
  if (!plus.length) throw new Error('Sin productos activos de rubro "Almacen" en Siga.');
  const listas = { noEnvasa: ed.noEnvasa, restringidos: ed.restringidos, productosAlmacen: {}, importanciaMinorista: impViva };
  const inList = plus.map(p => `'${p}'`).join(',');   // IdProducto es varchar en Siga → citar
  const nuevoCfg = distCfg.nuevo || {};
  const nuevoDias = nuevoCfg.dias || 30;
  const pisoImportancia = nuevoCfg.pisoImportancia || 0.8;
  const compraTipos = (distCfg.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [stockRows, nombres, fact, primeraCompraRows] = await Promise.all([
    query(sqlStockDistribucion(plus)),
    query(`SELECT p.IdProducto, p.NombreProducto, r.NombreRubro FROM Productos p LEFT JOIN Rubros r ON r.IdRubro=p.IdRubro WHERE p.IdProducto IN (${inList})`),
    calcularFactLive(),
    query(`SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
      FROM MovimientosStockProductos mp
      JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdProducto IN (${inList}) AND mp.IdTipoMovimiento IN (${compraTipos})
      GROUP BY mp.IdProducto`),
  ]);
  const primeraCompraMap = new Map(primeraCompraRows.map(r => [String(r.IdProducto), r.Primera]));
  const umbralNuevo = new Date(Date.now() - nuevoDias * 24 * 60 * 60 * 1000);
  const esNuevoSet = new Set([...primeraCompraMap.entries()]
    .filter(([, fecha]) => new Date(fecha) >= umbralNuevo)
    .map(([plu]) => plu));
```

- [ ] **Step 2: Aplicar piso de `impNorm` y agregar campos al output**

Ubicar:
```javascript
  return filas.map(f => {
    const rawStk = stocks.get(String(f.plu)) || {};
    const stkSuc = { riv: rawStk.riv||0, urq: rawStk.urq||0, nacion: rawStk.nacion||0,
      chaca: rawStk.chaca||0, pergamino: rawStk.pergamino||0,
      sanPedro: rawStk.sanpedro||0, sucursal9: rawStk.sucu9||0 };
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapA.get(String(f.plu)) || '', central: f.central,
      enviar: f.enviar, enviarOverride: f.enviarOverride || {}, enviarTexto: f.enviarTexto, enviarMicro: f.enviarMicro, ideal: f.ideal, factSucs: f.factSucs, pideTotal: f.pideTotal, importancia: f.importancia, impSuc: f.impSuc, impNorm: f.impNorm, meses: f.meses, stkSuc };
  });
}
```

Reemplazar por:
```javascript
  return filas.map(f => {
    const rawStk = stocks.get(String(f.plu)) || {};
    const stkSuc = { riv: rawStk.riv||0, urq: rawStk.urq||0, nacion: rawStk.nacion||0,
      chaca: rawStk.chaca||0, pergamino: rawStk.pergamino||0,
      sanPedro: rawStk.sanpedro||0, sucursal9: rawStk.sucu9||0 };
    const esNuevo = esNuevoSet.has(String(f.plu));
    const impNorm = esNuevo ? Math.max(f.impNorm, pisoImportancia) : f.impNorm;
    const primera = primeraCompraMap.get(String(f.plu));
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapA.get(String(f.plu)) || '', central: f.central,
      enviar: f.enviar, enviarOverride: f.enviarOverride || {}, enviarTexto: f.enviarTexto, enviarMicro: f.enviarMicro, ideal: f.ideal, factSucs: f.factSucs, pideTotal: f.pideTotal, importancia: f.importancia, impSuc: f.impSuc, impNorm, meses: f.meses, stkSuc,
      esNuevo, primeraCompra: primera ? new Date(primera).toISOString().slice(0, 10) : null };
  });
}
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output

- [ ] **Step 4: Verificar contra Siga real (server dev en 8081, después de reiniciar)**

Run: `curl -s http://localhost:8081/api/distribucion/almacen | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const nuevos=j.filter(x=>x.esNuevo);console.log('nuevos:',nuevos.length); console.log(nuevos.slice(0,3).map(x=>({plu:x.plu,nombre:x.nombre,primeraCompra:x.primeraCompra,impNorm:x.impNorm})));})"`
Expected: lista de productos con `esNuevo:true` y `impNorm >= 0.8`, `primeraCompra` en
los últimos 30 días. Si el array `nuevos` está vacío no es necesariamente un error —
puede que no haya productos con compra reciente ahora mismo.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: detecta producto nuevo (primera compra <30d) y aplica piso de prioridad en Almacen"
```

---

### Task 2: `calcularDistribucionPesables()` — mismo patrón

**Files:**
- Modify: `server.js:1608-1673` (función `calcularDistribucionPesables`)

- [ ] **Step 1: Agregar cómputo de `esNuevo`/`primeraCompra`, después de tener `plus`**

Ubicar:
```javascript
  const plus = universoLista(basePlus, ed.siemprePesable, ed.noEnvasa)
    .filter(p => !ocultos.has(String(p)));
  if (!plus.length) throw new Error('Sin productos activos de rubro "Pesables Fraccionado"/"Pesables Produccion" en Siga.');
  const quote = arr => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  // Códigos granel únicos (stock central de granel sale del depósito GRANEL, por código componente).
  const granelCodes = [...new Set(plus.map(p => (formulas[p] || {}).granel).filter(g => g != null).map(String))];
  const [stockRows, granelRows, nombres, fact] = await Promise.all([
    query(sqlStockDistribucion(plus)),   // producto terminado: DisponibleVenta=1 por IdSucursal (central + sucursales)
    granelCodes.length ? query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
       FROM ProductosDepositos pd
       INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
       INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
       WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${quote(granelCodes)})
       GROUP BY pd.IdProducto`) : Promise.resolve([]),
    query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${quote([...new Set([...plus, ...granelCodes])])})`),
    calcularFactLive(),
  ]);
```

Reemplazar por:
```javascript
  const plus = universoLista(basePlus, ed.siemprePesable, ed.noEnvasa)
    .filter(p => !ocultos.has(String(p)));
  if (!plus.length) throw new Error('Sin productos activos de rubro "Pesables Fraccionado"/"Pesables Produccion" en Siga.');
  const quote = arr => arr.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  // Códigos granel únicos (stock central de granel sale del depósito GRANEL, por código componente).
  const granelCodes = [...new Set(plus.map(p => (formulas[p] || {}).granel).filter(g => g != null).map(String))];
  const distCfgP = leerJSON(DISTRIB_CONFIG_PATH, {});
  const nuevoCfgP = distCfgP.nuevo || {};
  const nuevoDiasP = nuevoCfgP.dias || 30;
  const pisoImportanciaP = nuevoCfgP.pisoImportancia || 0.8;
  const compraTiposP = (distCfgP.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [stockRows, granelRows, nombres, fact, primeraCompraRows] = await Promise.all([
    query(sqlStockDistribucion(plus)),   // producto terminado: DisponibleVenta=1 por IdSucursal (central + sucursales)
    granelCodes.length ? query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
       FROM ProductosDepositos pd
       INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
       INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
       WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${quote(granelCodes)})
       GROUP BY pd.IdProducto`) : Promise.resolve([]),
    query(`SELECT IdProducto, NombreProducto FROM Productos WHERE IdProducto IN (${quote([...new Set([...plus, ...granelCodes])])})`),
    calcularFactLive(),
    query(`SELECT mp.IdProducto, MIN(m.FechaMovimiento) AS Primera
      FROM MovimientosStockProductos mp
      JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
      WHERE mp.IdProducto IN (${quote(plus)}) AND mp.IdTipoMovimiento IN (${compraTiposP})
      GROUP BY mp.IdProducto`),
  ]);
  const primeraCompraMapP = new Map(primeraCompraRows.map(r => [String(r.IdProducto), r.Primera]));
  const umbralNuevoP = new Date(Date.now() - nuevoDiasP * 24 * 60 * 60 * 1000);
  const esNuevoSetP = new Set([...primeraCompraMapP.entries()]
    .filter(([, fecha]) => new Date(fecha) >= umbralNuevoP)
    .map(([plu]) => plu));
```

Nota: se usa `quote(plus)` (no `inList`, que no existe en esta función — `quote` ya está
definida arriba en el mismo bloque) para la lista de PLUs de la query de compra.

- [ ] **Step 2: Aplicar piso a `prioridad`/`prioridadSala` y agregar campos al output**

Ubicar:
```javascript
  return filas.map(f => ({ plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapP.get(String(f.plu)) || '',
    granel: f.granel, nombreGranel: f.granel != null ? (nombreMap.get(String(f.granel)) || '') : '',
    cantFormula: (formulas[String(f.plu)] || {}).cantFormula ?? 1,
    peso: f.peso, F: f.F, H: f.H, BG: f.BG, enviar: f.enviar, enviarOverride: f.enviarOverride || {}, ideal: f.teorico, CG: f.CG,
    J: f.J, D: f.D, G: f.G, BL: f.BL, prioridad: f.prioridad, prioridadSala: f.prioridadSala,
    granelRatio: f.granelRatio, stkSuc: stocks.get(String(f.plu)) || {} }));
```

Reemplazar por:
```javascript
  return filas.map(f => {
    const esNuevo = esNuevoSetP.has(String(f.plu));
    const primera = primeraCompraMapP.get(String(f.plu));
    const prioridad = esNuevo ? Math.max(f.prioridad, pisoImportanciaP) : f.prioridad;
    const prioridadSala = esNuevo ? Math.max(f.prioridadSala, pisoImportanciaP) : f.prioridadSala;
    return { plu: f.plu, nombre: nombreMap.get(String(f.plu)) || '', rubro: rubroMapP.get(String(f.plu)) || '',
      granel: f.granel, nombreGranel: f.granel != null ? (nombreMap.get(String(f.granel)) || '') : '',
      cantFormula: (formulas[String(f.plu)] || {}).cantFormula ?? 1,
      peso: f.peso, F: f.F, H: f.H, BG: f.BG, enviar: f.enviar, enviarOverride: f.enviarOverride || {}, ideal: f.teorico, CG: f.CG,
      J: f.J, D: f.D, G: f.G, BL: f.BL, prioridad, prioridadSala,
      granelRatio: f.granelRatio, stkSuc: stocks.get(String(f.plu)) || {},
      esNuevo, primeraCompra: primera ? new Date(primera).toISOString().slice(0, 10) : null };
  });
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node -c server.js`
Expected: sin output

- [ ] **Step 4: Verificar contra Siga real**

Run: `curl -s http://localhost:8081/api/distribucion/pesables | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);const nuevos=j.filter(x=>x.esNuevo);console.log('nuevos:',nuevos.length); console.log(nuevos.slice(0,3).map(x=>({plu:x.plu,nombre:x.nombre,primeraCompra:x.primeraCompra,prioridad:x.prioridad})));})"`
Expected: análogo a Task 1 Step 4, sobre Pesables.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: detecta producto nuevo (primera compra <30d) y aplica piso de prioridad en Pesables"
```

---

### Task 3: `distribucion.html` — badges "Restr." y "NUEVO"

**Files:**
- Modify: `distribucion.html:1508-1517` (render celda Almacén)
- Modify: `distribucion.html:1523` (celda nombre Almacén)
- Modify: `distribucion.html:1552-1560` (render celda Pesables)
- Modify: `distribucion.html:1571` (celda nombre Pesables)

- [ ] **Step 1: Badge "Restr." en celda de Almacén**

Ubicar:
```javascript
      if (v === 'Fact') return `${stkTd}<td class="env fact" title="ideal ${fmtA(id)}"><span>Fact</span></td>`;
      if (esMicro(r, k)) {
```

Reemplazar por:
```javascript
      if (v === 'Fact') return `${stkTd}<td class="env fact" title="ideal ${fmtA(id)}"><span>Fact</span></td>`;
      if (v === 'Restringido') return `${stkTd}<td class="env restr" title="Restringido para esta sucursal"><span style="background:rgba(192,57,43,.15);color:#c0392b;font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid rgba(192,57,43,.4);display:inline-block">Restr.</span></td>`;
      if (esMicro(r, k)) {
```

- [ ] **Step 2: Badge "NUEVO" en celda de nombre de Almacén**

Ubicar:
```javascript
      <td class="l nombre" title="${(r.nombre||'').replace(/"/g,'&quot;')}">${r.nombre || ''}${tipoTag(r.plu)}</td>
```

Reemplazar por:
```javascript
      <td class="l nombre" title="${(r.nombre||'').replace(/"/g,'&quot;')}">${r.nombre || ''}${tipoTag(r.plu)}${nuevoTag(r)}</td>
```

- [ ] **Step 3: Definir `nuevoTag()`, junto a `errHTML` (funciones comunes, cerca del inicio del script)**

Ubicar:
```javascript
const errHTML = (msg) => `<div style="font-size:30px">⚠</div><div>${msg}</div>
  <div style="color:var(--faint);font-size:12px">¿Está Siga accesible?</div>`;
```

Agregar justo después:
```javascript
const nuevoTag = (r) => r.esNuevo ? `<span title="Primera compra: ${r.primeraCompra || '?'}" style="background:rgba(41,128,185,.15);color:#2980b9;font-weight:700;padding:1px 6px;border-radius:5px;border:1px solid rgba(41,128,185,.4);font-size:10px;margin-left:5px">NUEVO</span>` : '';
```

- [ ] **Step 4: Badge "Restr." en celda de Pesables**

Ubicar:
```javascript
      if (v === 'Fact') return `${stkTd}<td class="env fact" title="ideal ${fmt(id)}"><span>Fact</span></td>`;
      const isOvrP = (r.enviarOverride || {})[k];
```

Reemplazar por:
```javascript
      if (v === 'Fact') return `${stkTd}<td class="env fact" title="ideal ${fmt(id)}"><span>Fact</span></td>`;
      if (v === 'Restringido') return `${stkTd}<td class="env restr" title="Restringido para esta sucursal"><span style="background:rgba(192,57,43,.15);color:#c0392b;font-weight:700;padding:2px 7px;border-radius:5px;border:1px solid rgba(192,57,43,.4);display:inline-block">Restr.</span></td>`;
      const isOvrP = (r.enviarOverride || {})[k];
```

- [ ] **Step 5: Badge "NUEVO" en celda de nombre de Pesables**

Ubicar:
```javascript
      <td class="l nombre" title="${(r.nombre||'').replace(/"/g,'&quot;')}">${r.nombre || ''}${prodHoyMap[String(r.plu)] ? `<span class="prod-ind">✓ ${fmt(prodHoyMap[String(r.plu)])} kg</span>` : ''}</td>
```

Reemplazar por:
```javascript
      <td class="l nombre" title="${(r.nombre||'').replace(/"/g,'&quot;')}">${r.nombre || ''}${nuevoTag(r)}${prodHoyMap[String(r.plu)] ? `<span class="prod-ind">✓ ${fmt(prodHoyMap[String(r.plu)])} kg</span>` : ''}</td>
```

- [ ] **Step 6: Verificar sintaxis del script inline**

Run:
```
node -e "
const fs = require('fs');
const html = fs.readFileSync('distribucion.html','utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
scripts.forEach((s,i) => { try { new Function(s); console.log('script',i,'OK'); } catch(e) { console.log('script',i,'SYNTAX ERROR:', e.message); } });
"
```
Expected: `script 0 OK`

- [ ] **Step 7: Verificación manual en navegador**

Abrir `http://localhost:8081/distribucion`, tab Almacén. Confirmar: productos con
compra reciente (si hay alguno) muestran badge azul "NUEVO" junto al nombre. Si algún
producto tiene sucursal restringida (agregar uno de prueba en la tab "Restringidos" y
recalcular), la celda de esa sucursal muestra badge rojo "Restr." en vez de punto vacío.
Repetir en tab Pesables.

- [ ] **Step 8: Commit**

```bash
git add distribucion.html
git commit -m "feat: badges Restringido y Nuevo en tablas Almacen/Pesables"
```

---

## Resumen de archivos tocados
- `server.js` — `calcularDistribucionAlmacen`, `calcularDistribucionPesables`
- `distribucion.html` — render de celdas Almacén/Pesables, celda nombre, función `nuevoTag`
- Sin cambios: `distribucion.js`, `pesables.js` (piso de prioridad es post-procesamiento
  en server.js, motor de cálculo no se toca, según spec)
- `data/distribucion_config.json` — opcional, sin migración necesaria (defaults en código
  si no existe la clave `nuevo`)
