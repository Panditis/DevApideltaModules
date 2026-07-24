# Reservas por número de movimiento — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gestionar las reservas de mercadería por número de movimiento SIGA: bloquear órdenes ya reservadas con badge, reservar solo las órdenes nuevas, resumir movimientos del plan, y conciliar reservado-vs-usado por movimiento.

**Architecture:** Se mantiene toda la maquinaria SIGA existente (`trasladarStock`, `ejecutarYRegistrar`, `componentesDePlan`, log de movimientos). Se introduce un ledger `plan.reservas[]` (una entrada por movimiento de reserva) como fuente de verdad para el resumen, los badges y el agrupamiento de conciliación. La lógica pura nueva vive en un módulo aislado `reservas_movimiento.js` con tests `node:test`. `plan.reserva` (single, formato viejo) se migra transparentemente al ledger. El sello por-ítem `reservaMovimiento` (ya existente) sigue marcando badge + candado por orden.

**Tech Stack:** Node.js, Express (monolito `server.js`), JSON files (`data/*.json`), SIGA (SQL Server vía ODBC), HTML/JS vanilla, tests con `node:test` + `assert`.

**Referencias de código (dev tree):**
- Reserva: `server.js:5013` (devolución), `5059` (GET), `5144` (reservar), `5267` (actualizar), `5400` (devolver)
- Conciliación: `server.js:5587` (fn), `5800` (endpoint), `5836` (líneas), `5877` (registrar-movimiento)
- Log/SIGA: `server.js:3997` (log), `4093` (ejecutarYRegistrar), `4115-4180` (endpoints movimientos), `3951` (multilínea)
- Helpers reserva: `saldoReserva`/`saldoItemReserva` (`server.js:4583` aprox), `sincronizarReservaConLog`, `cambiosDelPlan`, `firmaPlanReserva`, `sellarItems`, `itemsDeComponentes`, `componentesPendientes`, `sucursalDeReserva`, `chequearSucursalReserva`
- Órdenes: `server.js:1522-1526` (CRUD), `3267` (enviar-produccion)
- Planificación UI: `planificacion.html:440` (btnMovStock), `5205/5271/5357` (modal mov), reserva modal `439/847-885`, render de ítems y botón eliminar
- Producción UI: `apidelta_produccion_dia.html:2648` (abrirConciliacion), `2874-3130` (render conciliación), tabs y render de órdenes; terminados

---

## Convenciones

- Tests con `node:test`: `node --test test/<archivo>.test.js`. Cada test importa funciones puras de un módulo (patrón `compras_modulo.js`).
- Nunca requerir `./server.js` directo en tests (ejecuta el bootstrap SQL+listen). La lógica testeable se extrae a `reservas_movimiento.js`.
- Verificación sintáctica de server.js: `node --check server.js`.
- No reiniciar el servidor (lo hace el usuario). Commits frecuentes por tarea.
- Formato de fecha: `YYYY-MM-DD` (plan) e ISO (`new Date().toISOString()`) para timestamps.

## Modelo de datos objetivo

`plan.reservas[]` — ledger append-only, una entrada por movimiento de reserva:
```
{
  numeroMovimiento,          // SIGA; null si el movimiento quedó pendiente/fallido
  idRegistro,                // id del log movimientos_stock.json
  estado: "activa"|"anulada",// una reserva se anula al revertir su movimiento
  fecha,                     // ISO, cuándo se reservó
  fechaPlanificacion,        // fecha del plan (YYYY-MM-DD)
  idSucursal, depOrigen, depDestino,
  ordenes: [itemId, ...],    // ids de plan.items que cubre este movimiento
  lineas: [{plu, nombre, cantidad, porItem}],  // componentes movidos
  devoluciones: [{numeroMovimiento, fecha, lineas}],
  ajuste: { numeroMovimiento, fecha, conciliado }  // se llena al conciliar (Fase 4)
}
```
- Sello por-ítem: `item.reservaMovimiento = { numeroMovimiento, fecha, idRegistro, depOrigen, depDestino }` (ya existe). Es el que dibuja badge + candado.
- Migración: plan con `reserva` (objeto) y sin `reservas` → `reservas = [reservaVieja]` (misma forma, agregando `ordenes` derivadas del sello por-ítem, y `fechaPlanificacion = plan.fecha`).

---

## FASE 0 — Módulo puro `reservas_movimiento.js` (TDD)

Concentra la lógica nueva testeable. No toca SIGA ni archivos: funciones puras sobre objetos plan.

**Files:**
- Create: `reservas_movimiento.js`
- Test: `test/reservas_movimiento.test.js`

### Task 0.1: Migración `reserva` → `reservas[]`

- [ ] **Step 1: Test que falla**

Crear `test/reservas_movimiento.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { migrarReservas } = require('../reservas_movimiento');

test('migrarReservas: plan sin reserva devuelve reservas vacío', () => {
  const plan = { fecha: '2026-07-24', items: [] };
  assert.deepStrictEqual(migrarReservas(plan).reservas, []);
});

test('migrarReservas: convierte reserva vieja activa en un elemento del ledger', () => {
  const plan = {
    fecha: '2026-07-24',
    reserva: { numeroMovimiento: 111, estado: 'activa', fecha: '2026-07-24T10:00:00Z',
               idSucursal: 1, depOrigen: 1, depDestino: 5,
               lineas: [{ plu: '9', nombre: 'Granel', cantidad: 100 }], devoluciones: [] },
    items: [{ id: 1, reservaMovimiento: { numeroMovimiento: 111 } },
            { id: 2 }],
  };
  const r = migrarReservas(plan).reservas;
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].numeroMovimiento, 111);
  assert.strictEqual(r[0].fechaPlanificacion, '2026-07-24');
  assert.deepStrictEqual(r[0].ordenes, [1]); // sólo el ítem sellado con ese movimiento
});

test('migrarReservas: plan que ya tiene reservas no se altera', () => {
  const plan = { fecha: '2026-07-24', reservas: [{ numeroMovimiento: 9 }], reserva: { numeroMovimiento: 1 } };
  assert.strictEqual(migrarReservas(plan).reservas.length, 1);
  assert.strictEqual(migrarReservas(plan).reservas[0].numeroMovimiento, 9);
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `node --test test/reservas_movimiento.test.js`
Expected: FAIL — `Cannot find module '../reservas_movimiento'`

- [ ] **Step 3: Implementación mínima**

Crear `reservas_movimiento.js`:
```js
'use strict';

// Órdenes (ids de plan.items) selladas con un número de movimiento dado.
function ordenesDeMovimiento(items, numeroMovimiento) {
  return (items || [])
    .filter(it => it && it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento === numeroMovimiento)
    .map(it => it.id);
}

// Devuelve una COPIA del plan con reservas[] poblado. No muta el original.
// - Si ya tiene reservas[], se respeta.
// - Si tiene reserva (formato viejo), se convierte en un elemento del ledger.
// - Si no tiene ninguna, reservas = [].
function migrarReservas(plan) {
  if (!plan) return { reservas: [] };
  if (Array.isArray(plan.reservas)) return plan;
  const vieja = plan.reserva;
  if (!vieja) return { ...plan, reservas: [] };
  const entrada = {
    numeroMovimiento: vieja.numeroMovimiento ?? null,
    idRegistro: vieja.idRegistro ?? null,
    estado: vieja.estado === 'anulada' ? 'anulada' : 'activa',
    fecha: vieja.fecha ?? null,
    fechaPlanificacion: plan.fecha ?? null,
    idSucursal: vieja.idSucursal ?? null,
    depOrigen: vieja.depOrigen ?? null,
    depDestino: vieja.depDestino ?? null,
    ordenes: ordenesDeMovimiento(plan.items, vieja.numeroMovimiento ?? null),
    lineas: Array.isArray(vieja.lineas) ? vieja.lineas : [],
    devoluciones: Array.isArray(vieja.devoluciones) ? vieja.devoluciones : [],
  };
  return { ...plan, reservas: [entrada] };
}

module.exports = { migrarReservas, ordenesDeMovimiento };
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `node --test test/reservas_movimiento.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add reservas_movimiento.js test/reservas_movimiento.test.js
git commit -m "feat: modulo reservas_movimiento con migracion a ledger reservas[]"
```

### Task 0.2: Saldo agregado sobre el ledger

`saldoReserva` hoy suma `reserva.lineas` menos `reserva.devoluciones`. La versión de ledger suma sobre todas las reservas activas.

**Files:** Modify `reservas_movimiento.js`; Test `test/reservas_movimiento.test.js`

- [ ] **Step 1: Test que falla**

Agregar:
```js
const { saldoLedger } = require('../reservas_movimiento');

test('saldoLedger: suma reservas activas y descuenta devoluciones', () => {
  const reservas = [
    { estado: 'activa', lineas: [{ plu: '9', nombre: 'G', cantidad: 100 }],
      devoluciones: [{ lineas: [{ plu: '9', cantidad: 30 }] }] },
    { estado: 'activa', lineas: [{ plu: '9', nombre: 'G', cantidad: 50 }], devoluciones: [] },
    { estado: 'anulada', lineas: [{ plu: '9', nombre: 'G', cantidad: 999 }], devoluciones: [] },
  ];
  const saldo = saldoLedger(reservas);
  const g = saldo.find(l => l.plu === '9');
  assert.strictEqual(g.cantidad, 120); // (100-30) + 50 ; la anulada no cuenta
});

test('saldoLedger: omite líneas que quedan en 0', () => {
  const reservas = [{ estado: 'activa', lineas: [{ plu: '9', nombre: 'G', cantidad: 40 }],
                      devoluciones: [{ lineas: [{ plu: '9', cantidad: 40 }] }] }];
  assert.strictEqual(saldoLedger(reservas).length, 0);
});
```

- [ ] **Step 2: Correr → FAIL** (`saldoLedger is not a function`)

Run: `node --test test/reservas_movimiento.test.js`

- [ ] **Step 3: Implementar** en `reservas_movimiento.js` (antes de `module.exports`):
```js
function redondear4(n) { return Math.round((Number(n) || 0) * 1e4) / 1e4; }

// Saldo neto por PLU sobre las reservas ACTIVAS del ledger (líneas menos devoluciones).
// Devuelve [{plu, nombre, cantidad}] con cantidad > 0.
function saldoLedger(reservas) {
  const acc = new Map();
  for (const r of (reservas || [])) {
    if (!r || r.estado !== 'activa') continue;
    for (const l of (r.lineas || [])) {
      const k = String(l.plu);
      const prev = acc.get(k) || { plu: k, nombre: l.nombre || '', cantidad: 0 };
      prev.cantidad += Number(l.cantidad) || 0;
      acc.set(k, prev);
    }
    for (const d of (r.devoluciones || [])) {
      for (const l of (d.lineas || [])) {
        const k = String(l.plu);
        const prev = acc.get(k) || { plu: k, nombre: l.nombre || '', cantidad: 0 };
        prev.cantidad -= Number(l.cantidad) || 0;
        acc.set(k, prev);
      }
    }
  }
  return [...acc.values()]
    .map(l => ({ ...l, cantidad: redondear4(l.cantidad) }))
    .filter(l => l.cantidad > 0);
}
```
Actualizar `module.exports` a `{ migrarReservas, ordenesDeMovimiento, saldoLedger }`.

- [ ] **Step 4: Correr → PASS**

Run: `node --test test/reservas_movimiento.test.js`

- [ ] **Step 5: Commit**
```bash
git add reservas_movimiento.js test/reservas_movimiento.test.js
git commit -m "feat: saldoLedger agrega saldo sobre reservas activas"
```

### Task 0.3: Órdenes sin reservar + agrupación por movimiento

**Files:** Modify `reservas_movimiento.js`; Test `test/reservas_movimiento.test.js`

- [ ] **Step 1: Test que falla**
```js
const { itemsSinReservar, reservadoPorMovimiento } = require('../reservas_movimiento');

test('itemsSinReservar: sólo ítems sin sello de movimiento', () => {
  const items = [
    { id: 1, reservaMovimiento: { numeroMovimiento: 5 } },
    { id: 2 },
    { id: 3, reservaMovimiento: null },
  ];
  assert.deepStrictEqual(itemsSinReservar(items).map(i => i.id), [2, 3]);
});

test('reservadoPorMovimiento: agrupa lineas por numeroMovimiento', () => {
  const reservas = [
    { numeroMovimiento: 10, estado: 'activa', ordenes: [1],
      lineas: [{ plu: '9', nombre: 'G', cantidad: 100 }], devoluciones: [] },
    { numeroMovimiento: 11, estado: 'activa', ordenes: [2],
      lineas: [{ plu: '9', nombre: 'G', cantidad: 40 }], devoluciones: [] },
  ];
  const grupos = reservadoPorMovimiento(reservas);
  assert.strictEqual(grupos.length, 2);
  const g10 = grupos.find(g => g.numeroMovimiento === 10);
  assert.strictEqual(g10.saldo.find(l => l.plu === '9').cantidad, 100);
  assert.deepStrictEqual(g10.ordenes, [1]);
});
```

- [ ] **Step 2: Correr → FAIL**

Run: `node --test test/reservas_movimiento.test.js`

- [ ] **Step 3: Implementar**:
```js
// Órdenes (plan.items) todavía SIN reservar: las que no tienen sello reservaMovimiento.
function itemsSinReservar(items) {
  return (items || []).filter(it => it && !(it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento != null));
}

// Saldo por cada movimiento de reserva activo (para conciliar por movimiento).
// Devuelve [{numeroMovimiento, ordenes, saldo:[{plu,nombre,cantidad}]}].
function reservadoPorMovimiento(reservas) {
  return (reservas || [])
    .filter(r => r && r.estado === 'activa')
    .map(r => ({
      numeroMovimiento: r.numeroMovimiento ?? null,
      ordenes: Array.isArray(r.ordenes) ? r.ordenes : [],
      saldo: saldoLedger([r]),
    }));
}
```
Agregar ambas al `module.exports`.

- [ ] **Step 4: Correr → PASS**

Run: `node --test test/reservas_movimiento.test.js`

- [ ] **Step 5: Commit**
```bash
git add reservas_movimiento.js test/reservas_movimiento.test.js
git commit -m "feat: itemsSinReservar y reservadoPorMovimiento"
```

---

## FASE 1 — Backend: reserva incremental por movimiento

Cablea el módulo en `server.js`. La reserva pasa a append-only: cada "Reservar" mueve sólo las órdenes sin sello y agrega una entrada al ledger.

### Task 1.1: Migración al leer el plan

**Files:** Modify `server.js` (helper de lectura de planes; buscar `leerJSON(PLANES_PATH` y el punto donde se resuelve `plan` en `GET /api/plan/:fecha/reserva:5073`, `conciliacionProduccion:5595`, `reservar:5177`)

- [ ] **Step 1:** Al inicio de `server.js` (junto a los otros `require`), agregar:
```js
const { migrarReservas, saldoLedger, itemsSinReservar, reservadoPorMovimiento, ordenesDeMovimiento } = require('./reservas_movimiento');
```

- [ ] **Step 2:** Crear un helper único de lectura que migre. Buscar la definición de `leerJSON`/acceso a `PLANES_PATH` y agregar cerca de `saldoReserva`:
```js
// Lee planes.json y garantiza que cada plan tenga reservas[] (migra formato viejo en memoria;
// no reescribe el archivo salvo que el caller guarde). Devuelve { planes, plan }.
function leerPlanReservas(fecha) {
  const planes = leerJSON(PLANES_PATH, {});
  const plan = planes[fecha] ? migrarReservas(planes[fecha]) : null;
  return { planes, plan };
}
```

- [ ] **Step 3:** Verificar sintaxis.

Run: `node --check server.js`
Expected: sin salida (OK)

- [ ] **Step 4: Commit**
```bash
git add server.js
git commit -m "feat: leerPlanReservas migra planes al ledger reservas[]"
```

### Task 1.2: `saldoReservaPlan` sobre el ledger (backward-compatible)

Objetivo: agregar cálculo de saldo desde el ledger sin romper devolución/conciliación existentes (que siguen usando `saldoReserva` sobre `plan.reserva`).

**Files:** Modify `server.js` (junto a `saldoReserva`, ~`server.js:4583`)

- [ ] **Step 1:** Localizar `saldoReserva`. Leer su implementación actual:

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8').split('\n'); console.log(s.slice(4570,4620).map((l,i)=>(4571+i)+': '+l).join('\n'))"`

- [ ] **Step 2:** Añadir junto a `saldoReserva` una función nueva `saldoReservaPlan(plan)` que use el ledger (no reemplaza a `saldoReserva`, la complementa):
```js
// Saldo total reservado del plan (nuevo, sobre el ledger). Los callers viejos que pasan
// una reserva única siguen usando saldoReserva; los nuevos pasan el plan entero.
function saldoReservaPlan(plan) {
  const p = migrarReservas(plan);
  return saldoLedger(p.reservas);
}
```

- [ ] **Step 3:** Verificar sintaxis: `node --check server.js`

- [ ] **Step 4: Commit**
```bash
git add server.js
git commit -m "feat: saldoReservaPlan calcula saldo desde el ledger"
```

### Task 1.3: `POST /api/plan/:fecha/reservar` incremental

Reemplaza el bloqueo "ya hay reserva activa" por reserva incremental de las órdenes sin sello.

**Files:** Modify `server.js:5144-5262`

- [ ] **Step 1:** Leer el handler actual completo. Cambios:
  1. Reemplazar el bloque `5185-5194` (rechazo si reserva activa) por: calcular `itemsSinReservar(plan.items)`; si vacío → error "Todas las órdenes del plan ya están reservadas. Agregá productos nuevos para reservar." con `yaReservado: true`.
  2. Calcular componentes SOLO de las órdenes sin sello:
     ```js
     const sinReservar = itemsSinReservar(plan.items);
     if (!sinReservar.length) return { error: 'Todas las órdenes del plan ya están reservadas. Agregá productos nuevos para reservar.', yaReservado: true };
     const { componentes } = await componentesDePlan(sinReservar);
     ```
     (Reemplaza el `componentesDePlan(plan.items)` de la línea `5196`.)
  3. Tras `ejecutarYRegistrar` (líneas `5232-5243`), en vez de `plan.reserva = {...}`, hacer append al ledger + sellar sólo esas órdenes:
     ```js
     plan = migrarReservas(plan);
     const nueva = {
       numeroMovimiento: numero, idRegistro: r.idRegistro ?? null, estado: 'activa',
       fecha: new Date().toISOString(), fechaPlanificacion: fecha,
       idSucursal: cr.idSucursal, depOrigen, depDestino,
       ordenes: itemsDeComponentes(componentes),
       lineas: componentes.map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: c.necesario, porItem: c.porItem })),
       devoluciones: [],
     };
     plan.reservas = [...plan.reservas, nueva];
     plan.items = sellarItems(plan.items, itemsDeComponentes(componentes), 'reservaMovimiento',
       { numeroMovimiento: numero, fecha: nueva.fecha, idRegistro: r.idRegistro ?? null, depOrigen, depDestino },
       { limpiarDevuelta: true });
     // Compat: mantener plan.reserva apuntando a la última reserva activa para el código viejo.
     plan.reserva = { ...nueva, usuario: cr.usuario, firma: firmaPlanReserva(plan.items), items: itemsFirmables(plan.items), ajustes: [] };
     planes[fecha] = plan;
     guardarJSON(PLANES_PATH, planes);
     ```
  Nota: se conserva `plan.reserva` como "última reserva activa" para no romper devolución/actualizar/conciliación existentes hasta la Fase 4. Confirmar que `planes` y `plan` estén en scope (el handler ya hace `const planes = leerJSON(PLANES_PATH, {})` en `5169` y `const plan = planes[fecha]` en `5177`; cambiar `const plan` por `let plan` para poder reasignar con `migrarReservas`).

- [ ] **Step 2:** Verificar sintaxis: `node --check server.js`

- [ ] **Step 3: Prueba manual documentada** (el usuario reinicia el server). Caso a validar: reservar plan nuevo → 1 entrada en `reservas[]`; agregar producto y reservar de nuevo → 2 entradas, la primera intacta.

- [ ] **Step 4: Commit**
```bash
git add server.js
git commit -m "feat: reservar incremental agrega movimiento solo para ordenes sin sello"
```

### Task 1.4: Bloqueo backend de borrado de orden reservada

**Files:** Modify `server.js` (DELETE/PUT de ítem del plan ~`server.js:3220-3245` y `/api/ordenes` DELETE ~`1522-1526`)

- [ ] **Step 1:** Localizar el handler que elimina un ítem del plan.

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8').split('\n'); s.forEach((l,i)=>{ if(/app\.(delete|put).*(plan|item|orden)/i.test(l)) console.log((i+1)+': '+l.trim()); })"`

- [ ] **Step 2:** Antes de borrar, rechazar si el ítem tiene sello:
```js
const item = (plan.items || []).find(it => String(it.id) === String(idItem));
if (item && item.reservaMovimiento && item.reservaMovimiento.numeroMovimiento != null) {
  return { error: `La orden está reservada (movimiento #${item.reservaMovimiento.numeroMovimiento}) y no se puede eliminar. Anulá esa reserva primero.` };
}
```

- [ ] **Step 3:** Verificar sintaxis: `node --check server.js`

- [ ] **Step 4: Commit**
```bash
git add server.js
git commit -m "feat: backend rechaza borrar orden con reserva activa"
```

---

## FASE 2 — Planificación UI: badge, candado y resumen

**Files:** Modify `planificacion.html`

### Task 2.1: Badge + candado por orden reservada

- [ ] **Step 1:** Leer el render de ítems del plan y el botón eliminar. Localizar:

Run: `node -e "const s=require('fs').readFileSync('planificacion.html','utf8').split('\n'); const idx=[]; s.forEach((l,i)=>{ if(/eliminar|borrar|✕|reservaMovimiento|renderItem|chipMovimiento/i.test(l)) idx.push((i+1)+': '+l.trim()); }); console.log(idx.slice(0,60).join('\n'))"`

- [ ] **Step 2:** En el render de cada ítem, si `item.reservaMovimiento?.numeroMovimiento` existe: (a) ocultar/deshabilitar el botón eliminar, (b) mostrar badge `#<numeroMovimiento>`. Reusar el estilo de chip existente (`chipMovimientoItem` en `planificacion.html:1699`). Añadir clase CSS `orden-reservada` que marque visualmente el candado.

- [ ] **Step 3:** Interceptar el handler JS de eliminar: si el ítem tiene sello, mostrar alerta "Orden reservada (#N): anulá la reserva primero" y no llamar al backend.

- [ ] **Step 4: Commit**
```bash
git add planificacion.html
git commit -m "feat: planificacion badge y candado en ordenes reservadas"
```

### Task 2.2: Botón Reservar re-habilitado sólo con órdenes sin badge

- [ ] **Step 1:** Localizar el handler del botón "Reservar mercadería" y la lógica de habilitación.

Run: `node -e "const s=require('fs').readFileSync('planificacion.html','utf8').split('\n'); s.forEach((l,i)=>{ if(/reservar|btnReserv|abrirReserva/i.test(l)) console.log((i+1)+': '+l.trim()); })"`

- [ ] **Step 2:** Habilitar el botón cuando exista al menos un ítem sin `reservaMovimiento`. Texto "Reservar órdenes nuevas" cuando ya hay reservas previas. Al confirmar, llamar el mismo `POST /reservar` (ahora incremental).

- [ ] **Step 3:** Refrescar la vista tras reservar: los ítems recién reservados muestran su badge; el botón queda deshabilitado si no quedan órdenes sin sello.

- [ ] **Step 4: Commit**
```bash
git add planificacion.html
git commit -m "feat: reservar solo ordenes nuevas y refresco de badges"
```

### Task 2.3: Reemplazar 🧾 Movimientos por "Resumen de reservas"

**Files:** Modify `server.js` (endpoint nuevo) y `planificacion.html` (btn `:440`, modal `:890-912`, JS `renderMovStock:5205`, `abrirModalMovStock:5271`)

- [ ] **Step 1 (backend):** En `server.js`, agregar `GET /api/plan/:fecha/reservas-resumen`:
```js
app.get('/api/plan/:fecha/reservas-resumen', apiRoute(async req => {
  const fecha = safeDate(req.params.fecha);
  const { plan } = leerPlanReservas(fecha);
  if (!plan) return { fecha, reservas: [] };
  const porItem = new Map((plan.items || []).map(it => [String(it.id), it]));
  return {
    fecha,
    reservas: (plan.reservas || []).map(r => ({
      numeroMovimiento: r.numeroMovimiento, estado: r.estado, fecha: r.fecha,
      fechaPlanificacion: r.fechaPlanificacion, idRegistro: r.idRegistro,
      ordenes: (r.ordenes || []).map(id => {
        const it = porItem.get(String(id));
        return { id, producto: it ? (it.producto || it.nombre || '') : '' };
      }),
      productos: (r.lineas || []).map(l => ({ plu: String(l.plu), nombre: l.nombre || '', cantidad: l.cantidad })),
    })),
  };
}));
```

- [ ] **Step 2:** `node --check server.js`

- [ ] **Step 3 (frontend):** Reetiquetar `#btnMovStock` a "🧾 Resumen de reservas". Reescribir `abrirModalMovStock`/`renderMovStock` para consumir `/api/plan/:fecha/reservas-resumen` y renderizar una tabla por movimiento: Nº movimiento, estado, fecha planificación, órdenes (productos), cantidades por componente. Mantener el botón **Revertir** por movimiento (llama a `POST /api/stock/movimientos/:id/revertir` con el `idRegistro`).

- [ ] **Step 4: Commit**
```bash
git add server.js planificacion.html
git commit -m "feat: resumen de reservas del plan reemplaza modal de movimientos"
```

### Task 2.4: Revertir un movimiento limpia sus badges

**Files:** Modify `server.js` (endpoint revertir `4148`, post-proceso)

- [ ] **Step 1:** Tras revertir un movimiento cuyo `origen === 'reserva'`, marcar en el ledger `estado: 'anulada'` la reserva con ese `idRegistro`/`numeroMovimiento` y limpiar el sello `reservaMovimiento` de las órdenes de esa reserva. Post-proceso en el handler de revertir:
```js
const { planes, plan } = leerPlanReservas(planFecha);
if (plan) {
  plan.reservas = (plan.reservas || []).map(r =>
    r.idRegistro === idRegistroRevertido ? { ...r, estado: 'anulada' } : r);
  plan.items = (plan.items || []).map(it =>
    (it.reservaMovimiento && it.reservaMovimiento.numeroMovimiento === numeroRevertido)
      ? { ...it, reservaMovimiento: null } : it);
  planes[planFecha] = plan;
  guardarJSON(PLANES_PATH, planes);
}
```
(`planFecha`, `idRegistroRevertido`, `numeroRevertido` salen del registro de log que se está revirtiendo; leerlos del log antes de revertir.)

- [ ] **Step 2:** `node --check server.js`

- [ ] **Step 3: Commit**
```bash
git add server.js
git commit -m "feat: revertir reserva anula ledger y libera ordenes"
```

---

## FASE 3 — Producción: código(s) de reserva por orden

### Task 3.1: `ordenes.json` hereda el/los número(s) de movimiento

**Files:** Modify `server.js:3267` (`/api/enviar-produccion`)

- [ ] **Step 1:** Leer el handler `enviar-produccion` y ver cómo matchea ítems de plan con órdenes (por `producto`, `codigo`, o id).

Run: `node -e "const s=require('fs').readFileSync('server.js','utf8').split('\n'); console.log(s.slice(3266,3330).map((l,i)=>(3267+i)+': '+l).join('\n'))"`

- [ ] **Step 2:** Al construir cada orden, adjuntar los números de movimiento de reserva de los ítems de plan correspondientes (dedupe). Ajustar el criterio de match al real detectado en Step 1:
```js
// reservaMovimientos: números de movimiento que reservaron componentes de esta orden.
reservaMovimientos: [...new Set(itemsPlan
  .filter(it => it.producto === orden.producto && it.reservaMovimiento?.numeroMovimiento != null)
  .map(it => it.reservaMovimiento.numeroMovimiento))],
```

- [ ] **Step 3:** `node --check server.js`

- [ ] **Step 4: Commit**
```bash
git add server.js
git commit -m "feat: ordenes heredan numeros de movimiento de reserva"
```

### Task 3.2: Chips de movimiento por producto en producción

**Files:** Modify `apidelta_produccion_dia.html` (render de órdenes)

- [ ] **Step 1:** Localizar el render de cada orden en la lista de producción.

Run: `node -e "const s=require('fs').readFileSync('apidelta_produccion_dia.html','utf8').split('\n'); s.forEach((l,i)=>{ if(/renderOrden|orden\.|reservaMovimiento|chip/i.test(l)) console.log((i+1)+': '+l.trim()); })" | head -40`

- [ ] **Step 2:** Si `orden.reservaMovimientos?.length`, renderizar un chip por número (`#N`) junto al producto. Reusar el estilo de chip existente.

- [ ] **Step 3: Commit**
```bash
git add apidelta_produccion_dia.html
git commit -m "feat: produccion muestra chips de reserva por producto"
```

---

## FASE 4 — Conciliación por orden y por movimiento (ajuste 1:1)

### Task 4.1: Conciliación agrupa reservado-vs-usado por movimiento

**Files:** Modify `server.js:5587` (`conciliacionProduccion`); Test para la función pura en `reservas_movimiento.js`

- [ ] **Step 1: Test que falla** — agregar a `test/reservas_movimiento.test.js`:
```js
const { conciliarPorMovimiento } = require('../reservas_movimiento');

test('conciliarPorMovimiento: compara reservado vs usado por movimiento', () => {
  const grupos = [
    { numeroMovimiento: 10, ordenes: [1], saldo: [{ plu: '9', nombre: 'G', cantidad: 100 }] },
    { numeroMovimiento: 11, ordenes: [2], saldo: [{ plu: '9', nombre: 'G', cantidad: 40 }] },
  ];
  const usadoPorPlu = new Map([['9', 90]]); // consumo total real del componente 9
  const res = conciliarPorMovimiento(grupos, usadoPorPlu);
  // El usado se imputa por orden de movimiento hasta agotar: mov10 usa 90, mov11 usa 0.
  const m10 = res.find(m => m.numeroMovimiento === 10);
  const m11 = res.find(m => m.numeroMovimiento === 11);
  assert.strictEqual(m10.componentes[0].usado, 90);
  assert.strictEqual(m10.componentes[0].sobrante, 10);
  assert.strictEqual(m11.componentes[0].usado, 0);
  assert.strictEqual(m11.componentes[0].sobrante, 40);
});
```

- [ ] **Step 2: Correr → FAIL** (`conciliarPorMovimiento is not a function`)

Run: `node --test test/reservas_movimiento.test.js`

- [ ] **Step 3: Implementar** en `reservas_movimiento.js`:
```js
// Imputa el consumo real de cada PLU contra los movimientos que lo reservaron, en orden,
// hasta agotar. Devuelve por movimiento:
// [{numeroMovimiento, ordenes, componentes:[{plu,nombre,reservado,usado,sobrante,faltante}]}].
function conciliarPorMovimiento(grupos, usadoPorPlu) {
  const restante = new Map([...(usadoPorPlu || new Map())].map(([k, v]) => [String(k), Number(v) || 0]));
  return (grupos || []).map(g => ({
    numeroMovimiento: g.numeroMovimiento,
    ordenes: g.ordenes || [],
    componentes: (g.saldo || []).map(l => {
      const plu = String(l.plu);
      const reservado = Number(l.cantidad) || 0;
      const disp = restante.get(plu) || 0;
      const usado = redondear4(Math.min(reservado, disp));
      restante.set(plu, redondear4(disp - usado));
      return { plu, nombre: l.nombre || '', reservado, usado,
               sobrante: redondear4(Math.max(0, reservado - usado)), faltante: 0 };
    }),
  }));
}
```
Agregar al `module.exports`. Nota: el faltante (usado > reservado total) se maneja fuera, contra el depósito de salida, como hoy.

- [ ] **Step 4: Correr → PASS**

Run: `node --test test/reservas_movimiento.test.js`

- [ ] **Step 5:** En `conciliacionProduccion` (`server.js:5587`), tras calcular `consumo` y el saldo, construir el desglose por movimiento:
```js
const p = migrarReservas(plan || {});
const grupos = reservadoPorMovimiento(p.reservas);
const usadoPorPlu = new Map([...consumo.componentes.values()].filter(u => u.plu).map(u => [String(u.plu), u.usado]));
const porMovimiento = conciliarPorMovimiento(grupos, usadoPorPlu);
```
Agregar `porMovimiento` al objeto de retorno de la conciliación (junto a `componentes`, ~`server.js:5768`).

- [ ] **Step 6:** `node --check server.js`

- [ ] **Step 7: Commit**
```bash
git add reservas_movimiento.js test/reservas_movimiento.test.js server.js
git commit -m "feat: conciliacion desglosa reservado-vs-usado por movimiento"
```

### Task 4.2: Un ajuste SIGA por movimiento de reserva

**Files:** Modify `server.js:5877` (`registrar-movimiento`) y `5836` (`lineasProduccionDesdeConciliacion`)

- [ ] **Step 1:** Agregar a `lineasProduccionDesdeConciliacion` un modo que arme líneas para el subconjunto de UN movimiento: recibe `{ componentes: porMovimiento[k].componentes, productos: <terminados de las órdenes de ese movimiento> }` y devuelve las mismas líneas firmadas (consumo-reserva / consumo-salida / sobrante) acotadas a ese movimiento.

- [ ] **Step 2:** En `registrar-movimiento`, iterar `c.porMovimiento`: por cada movimiento con consumo/sobrante, ejecutar UN `ejecutarYRegistrar` propio con observación `${cp.observacion} ${fecha} mov ${numeroMovimiento}`. Mantener un comprobante aparte para los terminados (alta de producto) o incluirlos en el primero. Guardar el `numeroMovimiento` de cada ajuste.

- [ ] **Step 3:** Persistir en cada `plan.reservas[k]`: `ajuste = { numeroMovimiento, fecha, conciliado: true }`. Guardar el plan.

- [ ] **Step 4:** `node --check server.js`

- [ ] **Step 5: Prueba manual documentada:** reservar 2 movimientos, producir, conciliar → 2 comprobantes de ajuste distintos, cada `reservas[k]` con su `ajuste`.

- [ ] **Step 6: Commit**
```bash
git add server.js
git commit -m "feat: un ajuste SIGA por movimiento de reserva en conciliacion"
```

### Task 4.3: Vista de conciliación desglosada por orden y movimiento

**Files:** Modify `apidelta_produccion_dia.html` (`renderConciliacion:2943`)

- [ ] **Step 1:** Consumir `porMovimiento` del endpoint. Renderizar una sección por movimiento (Nº, órdenes) con su tabla reservado/usado/sobrante por componente.

- [ ] **Step 2: Commit**
```bash
git add apidelta_produccion_dia.html
git commit -m "feat: vista de conciliacion por orden y movimiento"
```

---

## FASE 5 — Terminados: badge `⚠ sin conciliar`

### Task 5.1: Marca de reserva sin conciliar en el tab Terminados

**Files:** Modify `apidelta_produccion_dia.html` (tab Terminados) y `server.js` (flag por orden)

- [ ] **Step 1 (backend):** En el endpoint que lista órdenes/terminados, adjuntar por orden `sinConciliar: true|false`. Una orden está "sin conciliar" si alguno de sus `reservaMovimientos` corresponde a una `plan.reservas[k]` activa sin `ajuste.conciliado`. Reutilizar `leerPlanReservas`.

- [ ] **Step 2:** Localizar el render del tab Terminados.

Run: `node -e "const s=require('fs').readFileSync('apidelta_produccion_dia.html','utf8').split('\n'); s.forEach((l,i)=>{ if(/terminad|tab|renderTerminados/i.test(l)) console.log((i+1)+': '+l.trim()); })" | head -40`

- [ ] **Step 3:** Para órdenes con `sinConciliar`, mostrar el badge único `⚠ sin conciliar` (clase CSS ámbar diferenciada). Al conciliar → la orden deja de tener el badge.

- [ ] **Step 4: Commit**
```bash
git add apidelta_produccion_dia.html server.js
git commit -m "feat: badge sin conciliar en tab terminados"
```

---

## FASE 6 — Verificación end-to-end

### Task 6.1: Suite de tests + syntax check

- [ ] **Step 1:** Correr toda la suite.

Run: `node --test test/`
Expected: PASS (todos, incluyendo `reservas_movimiento.test.js`)

- [ ] **Step 2:** `node --check server.js`. Revisar el `<script>` de los HTML modificados (o cargar en el navegador tras reinicio del usuario).

- [ ] **Step 3: Prueba manual guiada** (el usuario reinicia el server). Checklist:
  - Reservar plan nuevo → badge en órdenes, botón deshabilitado.
  - Agregar producto nuevo → botón "Reservar órdenes nuevas" habilitado; reservar → 2° movimiento, primeras órdenes intactas.
  - Intentar eliminar orden reservada → bloqueado (UI + API).
  - Resumen de reservas → tabla por movimiento con revertir; revertir libera esas órdenes.
  - Producción: mismo producto en 2 órdenes → 2 chips de movimiento.
  - Conciliación → desglose por movimiento; registrar → 1 ajuste por movimiento.
  - Terminados: orden con reserva sin conciliar → badge `⚠ sin conciliar`; tras conciliar desaparece.

- [ ] **Step 4: Commit** (si hubo ajustes)
```bash
git add -A
git commit -m "test: verificacion e2e reservas por movimiento"
```

---

## Self-Review (cobertura del spec)

- Reservas por número de movimiento → Fase 0-1 (ledger + reservar incremental). ✓
- Bloquear/badge órdenes reservadas → Task 1.4 (backend), 2.1 (UI). ✓
- Re-habilitar sólo órdenes sin badge → Task 1.3, 2.2. ✓
- Resumen reemplaza Movimientos (con revertir) → Task 2.3, 2.4. ✓
- Guardar por planificación: productos, cantidades, Nº movimiento, fecha → modelo `plan.reservas[]` (Fase 0). ✓
- Producción: código(s) de reserva por orden, varios movimientos → Task 3.1, 3.2. ✓
- Conciliación por orden y movimiento, ajuste por movimiento → Task 4.1-4.3. ✓
- Terminados: sin conciliar diferenciado → Task 5.1. ✓

## Riesgos / notas

- **Blast radius del ledger:** hasta la Fase 4 se conserva `plan.reserva` como "última reserva activa" para no romper devolución/actualizar. `/reserva/devolver` y `/reserva/actualizar` siguen operando sobre `plan.reserva`; migrarlas a operar por movimiento del ledger queda como iteración posterior (deuda documentada).
- **planes.json indexado sólo por fecha** (no fecha+sucursal): se mantiene la limitación existente; la sucursal sigue congelada por reserva.
- **Movimientos pendientes/fallidos:** una reserva cuyo movimiento quedó `pendiente` no debe sellar la orden como confirmada; verificar el estado devuelto por `ejecutarYRegistrar` antes de sellar (`r.numeroMovimiento` null si no confirmó).
- **Verificar en implementación:** criterio real de match ítem↔orden en `enviar-produccion` (Task 3.1), y nombres exactos de handlers UI en los HTML (los Step de localización con `node -e` los resuelven).
