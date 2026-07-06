# Reservar Componentes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "🔒 Reservar componentes" button in `planificacion.html` (tab "Plan del día") that reserves the raw-material components needed for the day's plan by moving stock between depots in Siga, calling `POST /api/stock/movimiento`.

**Architecture:** 3 new read-only GET endpoints in `server.js` (empleados, ubicaciones, stock-por-depósito) feed a new modal in `planificacion.html` that reuses the existing `calcularMPParaItems()` component list and calls the already-implemented `POST /api/stock/movimiento` twice per component (baja origen + alta destino).

**Tech Stack:** Node/Express, mssql/msnodesqlv8, vanilla JS/HTML (no build step, no test framework in this repo — verification is manual via `node --check` + `curl`/`Invoke-RestMethod` + browser).

**Spec:** `docs/superpowers/specs/2026-07-06-reservar-componentes-design.md`

---

## Notes for the engineer

- This repo has **no automated test suite** (no jest/mocha, no `test` script in `package.json`). Every task below verifies with `node --check` (syntax) and manual HTTP calls / browser interaction instead of unit tests. Do not introduce a test framework — out of scope.
- The dev server runs on port 8081. **Never start/stop/restart the server yourself** — ask the user to restart after each backend task that needs a live check, then continue once they confirm.
- `server.js` write pool (`getPoolStock()`) is for `/api/stock/movimiento` only. All 3 new endpoints in this plan are **read-only** and use the existing `query()` helper (read pool `getPool()`), no new pool needed.
- `IdProducto` in Siga is `varchar`, not `int` — when building the `ids` list for Task 3's query, sanitize each id the same way the codebase already does elsewhere (`server.js:969`, `.replace(/'/g,"''")`), do not use string concat unsanitized.

---

### Task 1: Backend — `GET /api/stock/empleados`

**Files:**
- Modify: `server.js` (insert right after the `GET /api/stock/depositos` route, before `async function registrarMovimientoStock`)

- [ ] **Step 1: Add the route**

Find this block in `server.js` (added in a previous session):

```javascript
app.get('/api/stock/depositos', apiRoute(async req => {
  const idSucursal = Number(req.query.idSucursal);
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) return { error: 'Falta idSucursal (entero positivo)' };
  return query(`SELECT IdDeposito, IdSucursal, RTRIM(NombreDeposito) AS NombreDeposito, TipoDeposito, DisponibleVenta
    FROM SucursalesDepositos WHERE IdSucursal=${idSucursal} AND Activo=1 ORDER BY IdDeposito`);
}));
```

Add this new route directly after it:

```javascript
app.get('/api/stock/empleados', apiRoute(async () => {
  // Empleados.IdUsuario referencia a Usuarios.Id (login). Un solo registro trae
  // IdEmpleado (para MovimientosStock.IdEmpleado) y Usuario (para MovimientosStock.Usuario).
  // Nunca seleccionar Usuarios.Clave (contraseña en texto plano).
  return query(`SELECT e.IdEmpleado, RTRIM(e.NombreEmpleado) AS NombreEmpleado, e.IdUsuario AS Usuario
    FROM Empleados e
    INNER JOIN Usuarios u ON u.Id = e.IdUsuario
    WHERE u.Activo = 1 AND e.IdUsuario IS NOT NULL
    ORDER BY e.NombreEmpleado`);
}));
```

- [ ] **Step 2: Check syntax**

Run: `cd "c:/Users/Adriel/ApideltaSubSystem/dev" && node --check server.js`
Expected: no output (exit code 0).

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add server.js
git commit -m "feat: agrega GET /api/stock/empleados (join Empleados+Usuarios)"
```

---

### Task 2: Backend — `GET /api/stock/ubicaciones`

**Files:**
- Modify: `server.js` (insert right after the `/api/stock/empleados` route added in Task 1)

- [ ] **Step 1: Add the route**

```javascript
app.get('/api/stock/ubicaciones', apiRoute(async req => {
  const idSucursal = Number(req.query.idSucursal);
  const idDeposito = Number(req.query.idDeposito);
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) return { error: 'Falta idSucursal (entero positivo)' };
  if (!Number.isInteger(idDeposito) || idDeposito <= 0) return { error: 'Falta idDeposito (entero positivo)' };
  return query(`SELECT IdUbicacion, IdSucursal, IdDeposito, RTRIM(NombreUbicacion) AS NombreUbicacion
    FROM SucursalesUbicaciones
    WHERE IdSucursal=${idSucursal} AND IdDeposito=${idDeposito} AND Activo=1
    ORDER BY IdUbicacion`);
}));
```

- [ ] **Step 2: Check syntax**

Run: `cd "c:/Users/Adriel/ApideltaSubSystem/dev" && node --check server.js`
Expected: no output (exit code 0).

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add server.js
git commit -m "feat: agrega GET /api/stock/ubicaciones"
```

---

### Task 3: Backend — `GET /api/stock/producto-deposito`

**Files:**
- Modify: `server.js` (insert right after the `/api/stock/ubicaciones` route added in Task 2)

- [ ] **Step 1: Add the route**

```javascript
app.get('/api/stock/producto-deposito', apiRoute(async req => {
  const idSucursal = Number(req.query.idSucursal);
  const idDeposito = Number(req.query.idDeposito);
  const ids = String(req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!Number.isInteger(idSucursal) || idSucursal <= 0) return { error: 'Falta idSucursal (entero positivo)' };
  if (!Number.isInteger(idDeposito) || idDeposito <= 0) return { error: 'Falta idDeposito (entero positivo)' };
  if (!ids.length) return [];
  const idsIn = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',');
  return query(`SELECT IdProducto, Stock
    FROM ProductosDepositos
    WHERE IdSucursal=${idSucursal} AND IdDeposito=${idDeposito} AND IdProducto IN (${idsIn})`);
}));
```

- [ ] **Step 2: Check syntax**

Run: `cd "c:/Users/Adriel/ApideltaSubSystem/dev" && node --check server.js`
Expected: no output (exit code 0).

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add server.js
git commit -m "feat: agrega GET /api/stock/producto-deposito"
```

---

### Task 4: Manual verification of the 3 new endpoints

**Files:** none (verification only)

- [ ] **Step 1: Ask the user to restart the dev server**

Say: "Reiniciá el server dev (puerto 8081) para cargar los 3 endpoints nuevos." Wait for confirmation before continuing.

- [ ] **Step 2: Verify `/api/stock/empleados`**

Run (PowerShell): `Invoke-RestMethod http://localhost:8081/api/stock/empleados | Select-Object -First 5`
Expected: array of objects with `IdEmpleado`, `NombreEmpleado`, `Usuario` — **no** `Clave` field anywhere in the response.

- [ ] **Step 3: Verify `/api/stock/ubicaciones`**

Run: `Invoke-RestMethod "http://localhost:8081/api/stock/ubicaciones?idSucursal=1&idDeposito=1"`
Expected: array with at least one `{IdUbicacion, NombreUbicacion, ...}`.

- [ ] **Step 4: Verify `/api/stock/producto-deposito`**

Run: `Invoke-RestMethod "http://localhost:8081/api/stock/producto-deposito?ids=1010&idSucursal=1&idDeposito=1"`
Expected: `[{ IdProducto: "1010", Stock: <number> }]` (or `[]` if the product has no row in that depot).

- [ ] **Step 5: Verify validation errors**

Run: `Invoke-RestMethod "http://localhost:8081/api/stock/ubicaciones"` (no query params)
Expected: `{ error: "Falta idSucursal (entero positivo)" }`, HTTP 200 (matches existing `apiRoute` convention of `{error}` payloads, not HTTP status codes).

No commit for this task (verification only).

---

### Task 5: Frontend — button + modal skeleton (HTML)

**Files:**
- Modify: `planificacion.html:419` (filter-bar, add button)
- Modify: `planificacion.html:802` (after `overlayMPResumen`, add new modal)

- [ ] **Step 1: Add the button next to "📦 Resumen MP"**

Find in `planificacion.html`:

```html
    <button class="btn btn-secondary btn-sm" id="btnResumenMP"     disabled title="Ver resumen de materia prima del plan">📦 Resumen MP</button>
```

Add immediately after it:

```html
    <button class="btn btn-secondary btn-sm" id="btnReservarComp"  disabled title="Reservar componentes de materia prima para este plan">🔒 Reservar componentes</button>
```

- [ ] **Step 2: Add the modal HTML**

Find in `planificacion.html` the closing of `overlayMPResumen`:

```html
    <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
      <button class="btn btn-secondary btn-sm" id="btnMPResumenCancelar">Cancelar</button>
      <button class="btn btn-primary" id="btnMPResumenContinuar">Continuar →</button>
    </div>
  </div>
</div>

<!-- MODAL VER FÓRMULA (planificación) -->
```

Insert the new modal between `</div>` (closing `overlayMPResumen`) and the `<!-- MODAL VER FÓRMULA -->` comment:

```html
<!-- MODAL RESERVAR COMPONENTES -->
<div class="overlay" id="overlayReservarComp">
  <div class="modal" style="width:640px;max-height:86vh;display:flex;flex-direction:column">
    <div class="modal-header" style="background:var(--md-primary)">
      <span id="rcTitulo">Reservar componentes</span>
      <span class="close" id="cerrarReservarComp">✕</span>
    </div>
    <div style="padding:10px 16px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:1fr 1fr;gap:8px;flex-shrink:0">
      <div>
        <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:2px">Depósito origen</label>
        <select id="rcDepOrigen" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:6px;font-size:13px"></select>
      </div>
      <div>
        <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:2px">Ubicación origen</label>
        <select id="rcUbicOrigen" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:6px;font-size:13px"></select>
      </div>
      <div>
        <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:2px">Depósito destino</label>
        <select id="rcDepDestino" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:6px;font-size:13px"></select>
      </div>
      <div>
        <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:2px">Ubicación destino</label>
        <select id="rcUbicDestino" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:6px;font-size:13px"></select>
      </div>
      <div style="grid-column:1/-1">
        <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:2px">Empleado</label>
        <select id="rcEmpleado" style="width:100%;border:1px solid var(--border);border-radius:6px;padding:6px;font-size:13px">
          <option value="">Elegí quién hace la reserva…</option>
        </select>
      </div>
    </div>
    <div id="rcBody" style="flex:1;overflow-y:auto;max-height:40vh;padding:12px 16px">
      <div style="color:var(--muted);font-size:13px">Calculando…</div>
    </div>
    <div id="rcResumen" style="padding:8px 16px;font-size:12px;color:var(--muted);border-top:1px solid var(--border);flex-shrink:0;display:none"></div>
    <div style="padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;flex-shrink:0">
      <button class="btn btn-secondary btn-sm" id="btnRcCancelar">Cerrar</button>
      <button class="btn btn-primary" id="btnRcConfirmar" disabled>Confirmar reserva</button>
    </div>
  </div>
</div>

```

- [ ] **Step 3: Verify in browser (structure only, no JS yet)**

Open `planificacion.html` in the browser (via the running dev server, not `file://`), go to tab "Plan del día". The button "🔒 Reservar componentes" should appear next to "📦 Resumen MP", disabled (grayed out) since no plan is loaded yet. Clicking it should do nothing yet (no JS wired) — that's expected at this step.

- [ ] **Step 4: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add planificacion.html
git commit -m "feat: agrega boton y modal (HTML) para Reservar componentes"
```

---

### Task 6: Frontend — open/close modal + populate selects (JS)

**Files:**
- Modify: `planificacion.html` (JS section, after the `calcularMPParaItems` function, currently ending around line 3590)
- Modify: `planificacion.html:1295` (`renderPlan`, add disabled toggle for the new button)

- [ ] **Step 1: Wire the disabled state**

Find in `renderPlan()`:

```javascript
  document.getElementById('btnResumenMP').disabled    = items.length === 0;
```

Add right after it:

```javascript
  document.getElementById('btnReservarComp').disabled = items.length === 0;
```

- [ ] **Step 2: Add state + open/close/populate logic**

Add this new block right after the end of `calcularMPParaItems` (after the closing `}` that follows `return Object.entries(mpMap)...` — i.e. right after the blank line that follows line 3590 in the current file). Do **not** add a `</script>` tag — this continues inside the existing script block:

```javascript
// ══════════════════ MODAL RESERVAR COMPONENTES ══════════════════════

let rcDepositosCache  = [];
let rcEmpleadosCache  = [];
let rcComponentes     = []; // [{ plu, nombre, total, stock, reservar, cantidad }]
let rcProcesando      = false;

document.getElementById('btnReservarComp').addEventListener('click', () => {
  const items = planCache?.items || [];
  if (!items.length) return;
  abrirModalReservarComp(items);
});

function cerrarModalReservarComp() {
  document.getElementById('overlayReservarComp').classList.remove('open');
}
document.getElementById('cerrarReservarComp').addEventListener('click', cerrarModalReservarComp);
document.getElementById('btnRcCancelar').addEventListener('click', cerrarModalReservarComp);
document.getElementById('overlayReservarComp').addEventListener('click', e => {
  if (e.target === e.currentTarget) cerrarModalReservarComp();
});

async function abrirModalReservarComp(items) {
  document.getElementById('rcTitulo').textContent = `Reservar componentes — ${fechaPlanActual || 'plan'}`;
  document.getElementById('rcResumen').style.display = 'none';
  document.getElementById('rcResumen').textContent = '';
  document.getElementById('btnRcConfirmar').disabled = true;
  rcProcesando = false;
  document.getElementById('rcBody').innerHTML = '<div style="color:var(--muted);font-size:13px">Calculando…</div>';
  document.getElementById('overlayReservarComp').classList.add('open');

  const [mpList, depositos, empleados] = await Promise.all([
    calcularMPParaItems(items),
    api('GET', '/api/stock/depositos?idSucursal=1').catch(() => []),
    api('GET', '/api/stock/empleados').catch(() => [])
  ]);

  rcDepositosCache = depositos;
  rcEmpleadosCache = empleados;

  const selDep = (sel, valorDefault) => {
    sel.innerHTML = rcDepositosCache.map(d =>
      `<option value="${d.IdDeposito}">${escHtml(d.NombreDeposito)} (${d.IdDeposito})</option>`).join('');
    if (valorDefault !== undefined && rcDepositosCache.some(d => d.IdDeposito === valorDefault)) {
      sel.value = String(valorDefault);
    }
  };
  const depOrigenSel  = document.getElementById('rcDepOrigen');
  const depDestinoSel = document.getElementById('rcDepDestino');
  selDep(depOrigenSel, 1);
  selDep(depDestinoSel, rcDepositosCache.some(d => d.IdDeposito === 99) ? 99
    : (rcDepositosCache.find(d => String(d.IdDeposito) !== depOrigenSel.value) || {}).IdDeposito);

  document.getElementById('rcEmpleado').innerHTML =
    '<option value="">Elegí quién hace la reserva…</option>' +
    rcEmpleadosCache.map(e => `<option value="${e.IdEmpleado}" data-usuario="${escHtml(e.Usuario)}">${escHtml(e.NombreEmpleado)}</option>`).join('');

  await recargarUbicacionesRc('origen');
  await recargarUbicacionesRc('destino');

  rcComponentes = mpList.map(m => ({ ...m, reservar: m.total > 0, cantidad: m.total, stock: null }));
  await recargarStockOrigenRc();
  renderTablaRc();
  actualizarBotonConfirmarRc();
}

async function recargarUbicacionesRc(cual) {
  const depSel  = document.getElementById(cual === 'origen' ? 'rcDepOrigen' : 'rcDepDestino');
  const ubicSel = document.getElementById(cual === 'origen' ? 'rcUbicOrigen' : 'rcUbicDestino');
  const idDeposito = Number(depSel.value);
  if (!idDeposito) { ubicSel.innerHTML = ''; return; }
  const ubicaciones = await api('GET', `/api/stock/ubicaciones?idSucursal=1&idDeposito=${idDeposito}`).catch(() => []);
  ubicSel.innerHTML = ubicaciones.map(u => `<option value="${u.IdUbicacion}">${escHtml(u.NombreUbicacion)}</option>`).join('');
}

async function recargarStockOrigenRc() {
  if (!rcComponentes.length) return;
  const idDeposito = Number(document.getElementById('rcDepOrigen').value);
  if (!idDeposito) return;
  const ids = rcComponentes.map(c => c.plu).join(',');
  const rows = await api('GET', `/api/stock/producto-deposito?ids=${ids}&idSucursal=1&idDeposito=${idDeposito}`).catch(() => []);
  const stockMap = new Map(rows.map(r => [String(r.IdProducto), Number(r.Stock)]));
  rcComponentes.forEach(c => { c.stock = stockMap.has(c.plu) ? stockMap.get(c.plu) : 0; });
}

document.getElementById('rcDepOrigen').addEventListener('change', async () => {
  await recargarUbicacionesRc('origen');
  await recargarStockOrigenRc();
  renderTablaRc();
});
document.getElementById('rcDepDestino').addEventListener('change', () => recargarUbicacionesRc('destino'));
document.getElementById('rcEmpleado').addEventListener('change', actualizarBotonConfirmarRc);

function actualizarBotonConfirmarRc() {
  const empleadoElegido = document.getElementById('rcEmpleado').value !== '';
  const depsListos = document.getElementById('rcDepOrigen').value && document.getElementById('rcDepDestino').value
    && document.getElementById('rcUbicOrigen').value && document.getElementById('rcUbicDestino').value;
  document.getElementById('btnRcConfirmar').disabled = rcProcesando || !empleadoElegido || !depsListos;
}
```

`renderTablaRc` and `actualizarBotonConfirmarRc`'s callers are added in Task 7 — `renderTablaRc` itself doesn't exist yet after this step, so the browser check below will show a JS console error when opening the modal; that's expected and gets fixed by Task 7. Don't skip ahead — verify only what this task adds.

- [ ] **Step 3: Verify in browser**

Reload `planificacion.html` from the running dev server, open tab "Plan del día", load a day with plan items. Open browser devtools console. Click "🔒 Reservar componentes" — selects for depósito/ubicación/empleado should populate (check Network tab: `/api/stock/depositos`, `/api/stock/empleados`, `/api/stock/ubicaciones` all 200). Console will show `renderTablaRc is not defined` — expected until Task 7.

- [ ] **Step 4: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add planificacion.html
git commit -m "feat: abre/cierra modal Reservar componentes y puebla selects"
```

---

### Task 7: Frontend — render component table with live stock (JS)

**Files:**
- Modify: `planificacion.html` (JS section, add `renderTablaRc` right after `actualizarBotonConfirmarRc` from Task 6)

- [ ] **Step 1: Add the render function**

Add right after `actualizarBotonConfirmarRc` from Task 6:

```javascript
function renderTablaRc() {
  const body = document.getElementById('rcBody');
  if (!rcComponentes.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">Sin fórmulas definidas para estas presentaciones.</div>';
    return;
  }
  body.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f1f5f9">
      <th style="padding:5px 8px"></th>
      <th style="text-align:left;padding:5px 8px;font-size:11px;color:var(--muted)">Componente</th>
      <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Cantidad</th>
      <th style="text-align:right;padding:5px 8px;font-size:11px;color:var(--muted)">Stock origen</th>
      <th style="padding:5px 8px;font-size:11px;color:var(--muted)">Estado</th>
    </tr></thead><tbody>
    ${rcComponentes.map((c, idx) => {
      const falta = c.stock !== null && c.cantidad > c.stock;
      return `<tr style="border-bottom:1px solid var(--md-outline-variant)" data-rc-row="${idx}">
        <td style="padding:6px 8px"><input type="checkbox" ${c.reservar ? 'checked' : ''} onchange="rcToggleReservar(${idx}, this.checked)"></td>
        <td style="padding:6px 8px">${escHtml(c.nombre)} <span style="font-size:10px;color:var(--muted)">PLU ${escHtml(c.plu)}</span></td>
        <td style="text-align:right;padding:6px 8px">
          <input type="number" step="0.01" value="${c.cantidad}" style="width:80px;text-align:right;border:1px solid var(--border);border-radius:4px;padding:3px 5px"
            onchange="rcCambiarCantidad(${idx}, this.value)">
        </td>
        <td style="text-align:right;padding:6px 8px;color:${c.stock === null ? 'var(--muted)' : falta ? 'var(--red-text)' : 'var(--verde)'}">
          ${c.stock !== null ? c.stock : '—'}
        </td>
        <td style="padding:6px 8px;font-size:12px" data-rc-estado="${idx}">
          ${falta ? '<span style="color:var(--red-text)">⚠ supera stock</span>' : ''}
        </td>
      </tr>`;
    }).join('')}
    </tbody></table>`;
}

function rcToggleReservar(idx, checked) {
  rcComponentes[idx].reservar = checked;
}

function rcCambiarCantidad(idx, valor) {
  const n = parseFloat(valor);
  rcComponentes[idx].cantidad = Number.isFinite(n) ? n : 0;
  renderTablaRc();
}
```

- [ ] **Step 2: Verify in browser**

Reopen the modal (Task 6's console error should be gone now). The table should list each component with a checkbox (checked when `total > 0`), an editable "Cantidad" input prefilled with the needed amount, and a "Stock origen" column. Manually set a component's quantity above its stock and confirm the row shows "⚠ supera stock" without disabling anything.

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add planificacion.html
git commit -m "feat: renderiza tabla de componentes en modal Reservar componentes"
```

---

### Task 8: Frontend — confirm reservation flow (JS)

**Files:**
- Modify: `planificacion.html` (JS section, add after `rcCambiarCantidad` from Task 7)

- [ ] **Step 1: Add the confirm handler**

```javascript
document.getElementById('btnRcConfirmar').addEventListener('click', confirmarReservarComp);

async function confirmarReservarComp() {
  if (rcProcesando) return;
  rcProcesando = true;
  document.getElementById('btnRcConfirmar').disabled = true;

  const idDepOrigen  = Number(document.getElementById('rcDepOrigen').value);
  const idUbicOrigen = Number(document.getElementById('rcUbicOrigen').value);
  const idDepDestino = Number(document.getElementById('rcDepDestino').value);
  const idUbicDestino = Number(document.getElementById('rcUbicDestino').value);
  const empSel  = document.getElementById('rcEmpleado');
  const idEmpleado = Number(empSel.value);
  const usuario = empSel.selectedOptions[0]?.dataset.usuario || '';
  const observacion = `Reserva componentes plan ${fechaPlanActual || ''}`.trim();

  const resumenEl = document.getElementById('rcResumen');
  resumenEl.style.display = '';

  let ok = 0, total = 0;
  for (let idx = 0; idx < rcComponentes.length; idx++) {
    const c = rcComponentes[idx];
    if (!c.reservar || !(c.cantidad > 0)) continue;
    total++;
    const estadoCell = document.querySelector(`[data-rc-estado="${idx}"]`);
    try {
      await api('POST', '/api/stock/movimiento', {
        idSucursal: 1, idDeposito: idDepOrigen, idUbicacion: idUbicOrigen,
        idTipoMovimiento: 'BIENESUSO', idProducto: c.plu, cantidad: -c.cantidad,
        usuario, idEmpleado, observacion
      });
      await api('POST', '/api/stock/movimiento', {
        idSucursal: 1, idDeposito: idDepDestino, idUbicacion: idUbicDestino,
        idTipoMovimiento: 'BIENESUSO', idProducto: c.plu, cantidad: c.cantidad,
        usuario, idEmpleado, observacion
      });
      ok++;
      if (estadoCell) estadoCell.innerHTML = '<span style="color:var(--verde)">✅ reservado</span>';
    } catch (e) {
      if (estadoCell) estadoCell.innerHTML = `<span style="color:var(--red-text)">❌ ${escHtml(e.message)}</span>`;
    }
    resumenEl.textContent = `${ok} de ${total} componentes reservados…`;
  }

  resumenEl.textContent = `${ok} de ${total} componentes reservados correctamente.`;
  toast(ok === total ? 'Reserva completa' : `Reserva con errores: ${ok}/${total}`, ok !== total);
  // btnRcConfirmar queda deshabilitado (guardia anti-doble-click) hasta que se reabra el modal.
}
```

- [ ] **Step 2: Verify end-to-end (small real quantities)**

1. Open tab "Plan del día", load a day with at least one item that has a BOM/fórmula.
2. Click "🔒 Reservar componentes".
3. Pick empleado, leave depósito origen=1, destino=99 (or whatever defaults loaded).
4. Set one component's cantidad to a small test value (e.g. `0.5`).
5. Uncheck all other components (avoid moving real stock for everything during this first test).
6. Click "Confirmar reserva". Expect the row to turn ✅, resumen shows "1 de 1 componentes reservados correctamente.", and `btnRcConfirmar` stays disabled (click it again to confirm it does nothing).
7. Verify in SIGA (Stock → Movimientos de Stock) that 2 new BIENESUSO movements were created, and that depósito 1 stock dropped by 0.5 and depósito 99 stock rose by 0.5 for that product.

- [ ] **Step 3: Commit**

```bash
cd "c:/Users/Adriel/ApideltaSubSystem/dev"
git add planificacion.html
git commit -m "feat: confirma reserva de componentes via POST /api/stock/movimiento"
```

---

## Self-review checklist (already applied by the plan author)

- **Spec coverage:** empleados/ubicaciones/producto-deposito endpoints (Task 1-3), button+modal skeleton (Task 5), selects population (Task 6), component table with stock/warning (Task 7), sequential confirm flow with independent per-row error handling and anti-double-click guard (Task 8). All spec sections covered.
- **No placeholders:** every step has full, runnable code.
- **Type/name consistency:** `rcComponentes` shape `{plu, nombre, total, reservar, cantidad, stock}` is defined once in Task 6 (`abrirModalReservarComp`) and used identically in Task 7 (`renderTablaRc`, `rcToggleReservar`, `rcCambiarCantidad`) and Task 8 (`confirmarReservarComp`). Endpoint field names (`IdEmpleado`, `NombreEmpleado`, `Usuario`, `IdDeposito`, `NombreDeposito`, `IdUbicacion`, `NombreUbicacion`, `IdProducto`, `Stock`) match exactly between the SQL `SELECT` aliases in Tasks 1-3 and the JS consumers in Task 6-7.
