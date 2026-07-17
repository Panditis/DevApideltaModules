# Análisis de Ventas por Sucursal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo web que calcula ticket promedio, días/horas pico, productos más vendidos, comparativa entre sucursales y tendencia diaria de ventas en un rango de fechas, para las sucursales 2,3,4,5,7,9,10.

**Architecture:** Módulo puro `analisis_ventas.js` (sanitización de params + builders de SQL + derivaciones de KPIs, sin I/O) importado por `server.js`, que expone un endpoint `GET /api/analisis-ventas` corriendo ~7 queries a SIGA en `Promise.all`. UI en `analisis_ventas.html` (vanilla JS + Chart.js 4.4.0 por CDN). Card de acceso en `inicio.html`.

**Tech Stack:** Node.js + Express 5, `mssql/msnodesqlv8` (SQL Server SIGA), `node:test`/`node:assert` para tests, Chart.js 4.4.0 (CDN), vanilla JS.

**Spec:** `docs/superpowers/specs/2026-07-17-analisis-ventas-sucursal-design.md`

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `analisis_ventas.js` (crear) | Módulo puro: `SUCURSALES_ANALISIS`, sanitización (`sucIdsSeguras`, `clampTopN`), derivaciones (`ticketProm`, `kpisGlobales`, `mapDiaSemana`), builders SQL (`whereVentas`, `sql*`). Sin `require('mssql')`, sin `fs`. |
| `test/analisis_ventas.test.js` (crear) | Unit tests del módulo puro. |
| `server.js` (modificar) | `require('./analisis_ventas')`, ruta HTML `/analisis-ventas`, endpoint `/api/analisis-ventas`. |
| `analisis_ventas.html` (crear) | UI: controles (fechas + sucursales), KPI cards, charts, tablas top productos. |
| `inicio.html` (modificar) | Card de acceso al módulo. |
| `publicar.ps1` (modificar, si existe) | Registrar archivos nuevos en `$extras` para el deploy. |

### Contrato del módulo puro (types)

```
SUCURSALES_ANALISIS = [2,3,4,5,7,9,10]           // whitelist fija
NOMBRE_DIA = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']  // 0=Lunes

sucIdsSeguras(raw: string|undefined) -> number[]  // ∩ whitelist; vacío -> whitelist completa
clampTopN(raw) -> number                           // entero 1..100, default 20
ticketProm(facturacion: number, tickets: number) -> number   // tickets>0 ? fact/tickets : 0
kpisGlobales(comparativa: Row[], resumen: {Unidades,ProductosDistintos}) -> KpisObj
mapDiaSemana(dow: number) -> string                // NOMBRE_DIA[dow] ?? String(dow)

whereVentas({desde, hasta, sucIdsCsv}) -> string   // cláusula WHERE
sqlComparativa(p) / sqlResumenRenglon(p) / sqlTendencia(p) / sqlDiaSemana(p) / sqlHora(p) -> string
sqlTopProductos(p, orden: 'unidades'|'facturacion', topN: number) -> string
```

Donde `p = { desde, hasta, sucIdsCsv }` con `sucIdsCsv` = string tipo `"2,3,4,5,7,9,10"` (ya saneada por el endpoint).

---

## Task 1: Módulo puro — sanitización y derivaciones (TDD)

**Files:**
- Create: `analisis_ventas.js`
- Test: `test/analisis_ventas.test.js`

- [ ] **Step 1: Write the failing test**

Crear `test/analisis_ventas.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const {
  SUCURSALES_ANALISIS, NOMBRE_DIA,
  sucIdsSeguras, clampTopN, ticketProm, kpisGlobales, mapDiaSemana,
} = require('../analisis_ventas');

test('SUCURSALES_ANALISIS es la whitelist fija', () => {
  assert.deepStrictEqual(SUCURSALES_ANALISIS, [2, 3, 4, 5, 7, 9, 10]);
});

test('sucIdsSeguras filtra a la whitelist e ignora ids ajenos', () => {
  assert.deepStrictEqual(sucIdsSeguras('2,3,999,1'), [2, 3]); // 999 y 1 (central) fuera
});

test('sucIdsSeguras sin input devuelve whitelist completa', () => {
  assert.deepStrictEqual(sucIdsSeguras(undefined), [2, 3, 4, 5, 7, 9, 10]);
  assert.deepStrictEqual(sucIdsSeguras(''), [2, 3, 4, 5, 7, 9, 10]);
});

test('sucIdsSeguras con solo ids inválidos cae a whitelist completa', () => {
  assert.deepStrictEqual(sucIdsSeguras('1,999'), [2, 3, 4, 5, 7, 9, 10]);
});

test('clampTopN limita a 1..100 con default 20', () => {
  assert.strictEqual(clampTopN(undefined), 20);
  assert.strictEqual(clampTopN('50'), 50);
  assert.strictEqual(clampTopN('0'), 1);
  assert.strictEqual(clampTopN('9999'), 100);
  assert.strictEqual(clampTopN('abc'), 20);
});

test('ticketProm divide y evita división por cero', () => {
  assert.strictEqual(ticketProm(1000, 4), 250);
  assert.strictEqual(ticketProm(1000, 0), 0);
});

test('mapDiaSemana mapea 0=Lunes .. 6=Domingo', () => {
  assert.strictEqual(mapDiaSemana(0), 'Lunes');
  assert.strictEqual(mapDiaSemana(6), 'Domingo');
});

test('kpisGlobales agrega comparativa y suma resumen de renglón', () => {
  const comparativa = [
    { IdSucursal: 2, Nombre: 'Urquiza', Facturacion: 600, Tickets: 3 },
    { IdSucursal: 3, Nombre: 'Nación',  Facturacion: 400, Tickets: 1 },
  ];
  const resumen = { Unidades: 120, ProductosDistintos: 45 };
  const k = kpisGlobales(comparativa, resumen);
  assert.strictEqual(k.facturacion, 1000);
  assert.strictEqual(k.tickets, 4);
  assert.strictEqual(k.ticketProm, 250);
  assert.strictEqual(k.unidades, 120);
  assert.strictEqual(k.productosDistintos, 45);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/analisis_ventas.test.js`
Expected: FAIL con `Cannot find module '../analisis_ventas'`.

- [ ] **Step 3: Write minimal implementation**

Crear `analisis_ventas.js`:

```javascript
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Análisis de Ventas por Sucursal — módulo puro (sin I/O ni SQL exec)
//  Sanitización de params, builders de SQL y derivaciones de KPIs.
// ─────────────────────────────────────────────────────────────────────────────

// Sucursales en alcance (la central id=1 se excluye siempre).
const SUCURSALES_ANALISIS = [2, 3, 4, 5, 7, 9, 10];
const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const TOP_N_DEFAULT = 20;

// Intersección de los ids pedidos con la whitelist. Vacío/ inválido -> whitelist completa.
function sucIdsSeguras(raw) {
  if (!raw) return [...SUCURSALES_ANALISIS];
  const pedidos = String(raw).split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n));
  const filtradas = pedidos.filter(n => SUCURSALES_ANALISIS.includes(n));
  return filtradas.length ? filtradas : [...SUCURSALES_ANALISIS];
}

function clampTopN(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n)) return TOP_N_DEFAULT;
  return Math.min(100, Math.max(1, n));
}

function ticketProm(facturacion, tickets) {
  return tickets > 0 ? facturacion / tickets : 0;
}

function mapDiaSemana(dow) {
  return NOMBRE_DIA[dow] ?? String(dow);
}

function kpisGlobales(comparativa, resumen) {
  const facturacion = comparativa.reduce((a, r) => a + Number(r.Facturacion || 0), 0);
  const tickets     = comparativa.reduce((a, r) => a + Number(r.Tickets || 0), 0);
  return {
    facturacion,
    tickets,
    ticketProm: ticketProm(facturacion, tickets),
    unidades: Number(resumen?.Unidades || 0),
    productosDistintos: Number(resumen?.ProductosDistintos || 0),
  };
}

module.exports = {
  SUCURSALES_ANALISIS, NOMBRE_DIA, TOP_N_DEFAULT,
  sucIdsSeguras, clampTopN, ticketProm, mapDiaSemana, kpisGlobales,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/analisis_ventas.test.js`
Expected: PASS (todos los tests de Task 1).

- [ ] **Step 5: Commit**

```bash
git add analisis_ventas.js test/analisis_ventas.test.js
git commit -m "feat: módulo puro análisis-ventas (sanitización + derivaciones)"
```

---

## Task 2: Módulo puro — builders de SQL (TDD)

**Files:**
- Modify: `analisis_ventas.js`
- Test: `test/analisis_ventas.test.js`

- [ ] **Step 1: Write the failing test**

Agregar al final de `test/analisis_ventas.test.js`:

```javascript
const {
  whereVentas, sqlComparativa, sqlResumenRenglon,
  sqlTendencia, sqlDiaSemana, sqlHora, sqlTopProductos,
} = require('../analisis_ventas');

const P = { desde: '2026-07-01', hasta: '2026-07-17', sucIdsCsv: '2,3,4,5,7,9,10' };

test('whereVentas incluye los filtros comunes obligatorios', () => {
  const w = whereVentas(P);
  assert.match(w, /v\.Fecha >= '2026-07-01 00:00:00'/);
  assert.match(w, /v\.Fecha <= '2026-07-17 23:59:59'/);
  assert.match(w, /IdEstadoComprobante,''\) != 'ANULADO'/);
  assert.match(w, /v\.IdSucursal IN \(2,3,4,5,7,9,10\)/);
  assert.match(w, /NombreCategoria,''\) != 'SUCURSAL'/);
});

test('sqlComparativa agrupa por sucursal a nivel cabecera (sin VentasProductos)', () => {
  const s = sqlComparativa(P);
  assert.match(s, /FROM Ventas v/);
  assert.doesNotMatch(s, /VentasProductos/);       // cabecera: no debe joinear renglones
  assert.match(s, /SUM\(v\.ImporteTotal\) AS Facturacion/);
  assert.match(s, /COUNT\(\*\) AS Tickets/);
  assert.match(s, /GROUP BY v\.IdSucursal, s\.Nombre/);
});

test('sqlResumenRenglon suma unidades y cuenta productos distintos', () => {
  const s = sqlResumenRenglon(P);
  assert.match(s, /FROM VentasProductos vp/);
  assert.match(s, /SUM\(vp\.Cantidad\) AS Unidades/);
  assert.match(s, /COUNT\(DISTINCT vp\.IdProducto\) AS ProductosDistintos/);
});

test('sqlTendencia agrupa por día calendario', () => {
  assert.match(sqlTendencia(P), /GROUP BY CAST\(v\.Fecha AS DATE\)/);
});

test('sqlDiaSemana normaliza el día independiente de DATEFIRST (0=Lunes)', () => {
  assert.match(sqlDiaSemana(P), /\(DATEPART\(WEEKDAY, v\.Fecha\) \+ @@DATEFIRST - 2\) % 7/);
});

test('sqlHora agrupa por hora del día', () => {
  assert.match(sqlHora(P), /DATEPART\(HOUR, v\.Fecha\)/);
});

test('sqlTopProductos ordena por la métrica y limita con TOP', () => {
  const u = sqlTopProductos(P, 'unidades', 20);
  assert.match(u, /SELECT TOP 20/);
  assert.match(u, /ORDER BY Unidades DESC/);
  const f = sqlTopProductos(P, 'facturacion', 10);
  assert.match(f, /SELECT TOP 10/);
  assert.match(f, /ORDER BY Facturacion DESC/);
  assert.match(f, /INNER JOIN Productos p ON p\.IdProducto = vp\.IdProducto/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/analisis_ventas.test.js`
Expected: FAIL — `whereVentas is not a function` (los builders aún no existen).

- [ ] **Step 3: Write minimal implementation**

En `analisis_ventas.js`, antes de `module.exports`, agregar los builders. Las constantes de join y where se comparten:

```javascript
// Join cabecera→renglón por la clave compuesta de 5 columnas de SIGA.
const JOIN_CLAVE5 = `INNER JOIN Ventas v
    ON  v.IdSucursal=vp.IdSucursal AND v.IdTipoComprobante=vp.IdTipoComprobante
    AND v.Letra=vp.Letra AND v.CentroEmisor=vp.CentroEmisor
    AND v.NumeroComprobante=vp.NumeroComprobante`;

// Joins a Clientes/Categorias para excluir transferencias internas (categoría SUCURSAL).
const JOIN_CLIENTE_CAT = `LEFT JOIN Clientes c ON c.IdCliente = v.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria = c.IdCategoria`;

// Cláusula WHERE con los filtros comunes. desde/hasta/sucIdsCsv YA saneados por el endpoint.
function whereVentas({ desde, hasta, sucIdsCsv }) {
  return `v.Fecha >= '${desde} 00:00:00' AND v.Fecha <= '${hasta} 23:59:59'
      AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
      AND v.IdSucursal IN (${sucIdsCsv})
      AND UPPER(ISNULL(cat.NombreCategoria,'')) != 'SUCURSAL'
      AND v.ImporteTotal > 0`;
}

// KPIs + comparativa: nivel cabecera (Ventas), 1 fila por comprobante.
function sqlComparativa(p) {
  return `SELECT v.IdSucursal, s.Nombre AS Nombre,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    LEFT JOIN Sucursales s ON s.IdSucursal = v.IdSucursal
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY v.IdSucursal, s.Nombre
    ORDER BY Facturacion DESC`;
}

// Totales de unidades y productos distintos: nivel renglón (VentasProductos).
function sqlResumenRenglon(p) {
  return `SELECT SUM(vp.Cantidad) AS Unidades, COUNT(DISTINCT vp.IdProducto) AS ProductosDistintos
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}`;
}

function sqlTendencia(p) {
  return `SELECT CAST(v.Fecha AS DATE) AS Fecha,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY CAST(v.Fecha AS DATE)
    ORDER BY Fecha`;
}

function sqlDiaSemana(p) {
  return `SELECT (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7 AS Dow,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY (DATEPART(WEEKDAY, v.Fecha) + @@DATEFIRST - 2) % 7
    ORDER BY Dow`;
}

function sqlHora(p) {
  return `SELECT DATEPART(HOUR, v.Fecha) AS Hora,
      SUM(v.ImporteTotal) AS Facturacion, COUNT(*) AS Tickets
    FROM Ventas v
    ${JOIN_CLIENTE_CAT}
    WHERE ${whereVentas(p)}
    GROUP BY DATEPART(HOUR, v.Fecha)
    ORDER BY Hora`;
}

// Top productos por 'unidades' o 'facturacion'. topN ya clampeado a entero.
function sqlTopProductos(p, orden, topN) {
  const col = orden === 'unidades' ? 'Unidades' : 'Facturacion';
  return `SELECT TOP ${topN} vp.IdProducto AS IdProducto, p.Nombre AS Nombre,
      SUM(vp.Cantidad) AS Unidades, SUM(vp.ImporteTotalNeto) AS Facturacion
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    WHERE ${whereVentas(p)}
    GROUP BY vp.IdProducto, p.Nombre
    ORDER BY ${col} DESC`;
}
```

Y ampliar `module.exports` para incluir: `whereVentas, sqlComparativa, sqlResumenRenglon, sqlTendencia, sqlDiaSemana, sqlHora, sqlTopProductos`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/analisis_ventas.test.js`
Expected: PASS (Task 1 + Task 2).

- [ ] **Step 5: Commit**

```bash
git add analisis_ventas.js test/analisis_ventas.test.js
git commit -m "feat: builders SQL de análisis-ventas (cabecera/renglón + filtros)"
```

---

## Task 3: Endpoint backend en server.js

**Files:**
- Modify: `server.js:20` (agregar require), `server.js:933` (ruta HTML), zona de endpoints cerca de `server.js:3241` (endpoint API)

- [ ] **Step 1: Agregar el require del módulo**

En `server.js`, después de la línea 20 (`const { computeA8020, ... } = require('./a8020');`), agregar:

```javascript
const analisisVentas = require('./analisis_ventas');
```

- [ ] **Step 2: Agregar la ruta HTML**

En `server.js`, en el bloque "Rutas HTML", después de la línea 933 (`app.get('/compras-modulo', ...)`), agregar:

```javascript
app.get('/analisis-ventas', (_req, res) => res.sendFile(path.join(__dirname, 'analisis_ventas.html')));
```

- [ ] **Step 3: Agregar el endpoint API**

En `server.js`, después del bloque `/api/ventas-hora/sucursales` (termina en línea 3241), agregar:

```javascript
// ── Análisis de Ventas por Sucursal ──────────────────────────────────────────
app.get('/api/analisis-ventas', apiRoute(async req => {
  const desde = safeDate(req.query.desde);
  const hasta = safeDate(req.query.hasta);
  const sucIds = analisisVentas.sucIdsSeguras(req.query.sucursales);
  const sucIdsCsv = sucIds.join(',');
  const topN = analisisVentas.clampTopN(req.query.top);
  const p = { desde, hasta, sucIdsCsv };

  const [comparativa, resumenArr, tendencia, diaSemana, horas, topUnidades, topFacturacion] =
    await Promise.all([
      query(analisisVentas.sqlComparativa(p)),
      query(analisisVentas.sqlResumenRenglon(p)),
      query(analisisVentas.sqlTendencia(p)),
      query(analisisVentas.sqlDiaSemana(p)),
      query(analisisVentas.sqlHora(p)),
      query(analisisVentas.sqlTopProductos(p, 'unidades', topN)),
      query(analisisVentas.sqlTopProductos(p, 'facturacion', topN)),
    ]);

  const resumen = resumenArr[0] || { Unidades: 0, ProductosDistintos: 0 };

  return {
    rango: { desde, hasta },
    sucursales: sucIds,
    kpis: analisisVentas.kpisGlobales(comparativa, resumen),
    comparativa: comparativa.map(r => ({
      idSuc: r.IdSucursal, nombre: r.Nombre || `Suc. ${r.IdSucursal}`,
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
      ticketProm: analisisVentas.ticketProm(Number(r.Facturacion || 0), Number(r.Tickets || 0)),
    })),
    tendencia: tendencia.map(r => ({
      fecha: r.Fecha instanceof Date ? r.Fecha.toISOString().slice(0, 10) : String(r.Fecha).slice(0, 10),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    diaSemana: diaSemana.map(r => ({
      dow: Number(r.Dow), nombre: analisisVentas.mapDiaSemana(Number(r.Dow)),
      facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    horas: horas.map(r => ({
      hora: Number(r.Hora), facturacion: Number(r.Facturacion || 0), tickets: Number(r.Tickets || 0),
    })),
    topUnidades: topUnidades.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
    topFacturacion: topFacturacion.map(r => ({
      idProd: r.IdProducto, nombre: r.Nombre,
      unidades: Number(r.Unidades || 0), facturacion: Number(r.Facturacion || 0),
    })),
  };
}));
```

- [ ] **Step 4: Verificar sintaxis**

Run: `node --check server.js`
Expected: sin salida (exit 0). Si falla, revisar la llave/paréntesis del bloque agregado.

> NOTA: NO reiniciar el servidor manualmente (regla del proyecto). El dev corre bajo `nodemon` y recarga solo al guardar. Si no está corriendo, el usuario lo inicia.

- [ ] **Step 5: Smoke test contra SIGA (verificación manual)**

Con el server dev arriba (puerto de `config.json`, típicamente 8081 en dev), correr:

```bash
curl "http://localhost:8081/api/analisis-ventas?desde=2026-07-01&hasta=2026-07-17&sucursales=2,3,4,5,7,9,10"
```

Expected: JSON con claves `rango, kpis, comparativa, tendencia, diaSemana, horas, topUnidades, topFacturacion`. `kpis.tickets` > 0 y `kpis.ticketProm` ≈ `facturacion/tickets`. Verificar que `comparativa` no incluye la sucursal 1 y que aparecen solo ids del set pedido.

**Validación del assumption del spec:** si el endpoint devuelve error tipo *Invalid column name 'ImporteTotalNeto'*, revisar el nombre real de la columna de importe neto en `VentasProductos` (candidatos: `ImporteNeto`, `Importe`) y ajustar `sqlTopProductos` + `sqlResumenRenglon` si aplica. Documentar el nombre correcto.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: endpoint /api/analisis-ventas (7 queries en paralelo)"
```

---

## Task 4: Frontend `analisis_ventas.html`

**Files:**
- Create: `analisis_ventas.html`

- [ ] **Step 1: Crear el archivo completo**

Crear `analisis_ventas.html` con este contenido (paleta verde Apidelta, Chart.js 4.4.0 CDN, vanilla JS):

```html
<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Análisis de Ventas por Sucursal — Apidelta</title>
<link rel="icon" href="/favicon.png">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root{
    --green:#405936; --green-dark:#2E4027; --green-mid:#4E6B43; --green-light:#E8F0E4;
    --yellow:#FFCC00; --gold:#C98A00;
    --bg:#F5F5F5; --surface:#FFFFFF; --text:#1C1B1F; --muted:#6B6B6B; --border:#E6E6E6;
    --radius:12px; --radius-sm:8px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:'Barlow',system-ui,sans-serif}
  header{background:var(--green);color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px}
  header .logo{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:22px;letter-spacing:.5px}
  header .logo b{color:var(--yellow)}
  header a{color:#fff;text-decoration:none;opacity:.85;font-size:14px;margin-left:auto}
  .wrap{max-width:1200px;margin:0 auto;padding:20px}
  .controls{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
  .controls label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
  .controls input[type=date]{padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);font-family:inherit}
  .chips{display:flex;flex-wrap:wrap;gap:6px}
  .chip{padding:6px 10px;border:1px solid var(--border);border-radius:999px;font-size:13px;cursor:pointer;user-select:none;background:#fff}
  .chip.active{background:var(--green-light);border-color:var(--green-mid);color:var(--green-dark);font-weight:600}
  .btn{background:var(--green);color:#fff;border:0;padding:10px 18px;border-radius:var(--radius-sm);font-weight:600;cursor:pointer;font-family:inherit}
  .btn:disabled{opacity:.6;cursor:default}
  .link-mini{font-size:12px;color:var(--green-mid);cursor:pointer}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:16px}
  .kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px}
  .kpi .lbl{font-size:12px;color:var(--muted)}
  .kpi .val{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:28px;color:var(--green-dark);margin-top:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
  .card h3{margin:0 0 12px;font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;color:var(--green-dark)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border)}
  th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .error{background:#fdecea;color:#b3261e;border:1px solid #f5c6c2;padding:12px;border-radius:var(--radius-sm);margin-top:16px}
  .loading{color:var(--muted);padding:20px;text-align:center}
  .empty{color:var(--muted);padding:16px;text-align:center;font-size:14px}
  @media(max-width:820px){.grid2{grid-template-columns:1fr}}
</style></head><body>
<header>
  <span class="logo">API<b>DELTA</b></span>
  <span style="font-size:14px;opacity:.9">Análisis de Ventas por Sucursal</span>
  <a href="/">← Inicio</a>
</header>
<div class="wrap">
  <div class="controls">
    <div><label for="desde">Desde</label><input type="date" id="desde"></div>
    <div><label for="hasta">Hasta</label><input type="date" id="hasta"></div>
    <div style="flex:1">
      <label>Sucursales <span class="link-mini" id="selAll">todas</span> · <span class="link-mini" id="selNone">ninguna</span></label>
      <div class="chips" id="chips"></div>
    </div>
    <button class="btn" id="btnAplicar">Aplicar</button>
  </div>

  <div id="msg"></div>
  <div class="kpis" id="kpis"></div>

  <div class="grid2">
    <div class="card"><h3>Comparativa por sucursal</h3><canvas id="chComparativa" height="200"></canvas>
      <div id="tblComparativa" style="margin-top:12px"></div></div>
    <div class="card"><h3>Tendencia diaria</h3><canvas id="chTendencia" height="200"></canvas></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Facturación por día de semana</h3><canvas id="chDow" height="200"></canvas></div>
    <div class="card"><h3>Facturación por hora</h3><canvas id="chHora" height="200"></canvas></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Top productos — unidades</h3><div id="tblTopU"></div></div>
    <div class="card"><h3>Top productos — facturación</h3><div id="tblTopF"></div></div>
  </div>
</div>

<script>
// Sucursales fijas del módulo (id -> nombre). La central (1) no se incluye.
const SUCURSALES = [
  {id:2,nombre:'Urquiza'},{id:3,nombre:'Nación'},{id:4,nombre:'Chacabuco'},
  {id:5,nombre:'Rivadavia'},{id:7,nombre:'San Pedro'},{id:9,nombre:'Villa Ramallo'},
  {id:10,nombre:'Pergamino'},
];
const GREEN = '#405936', YELLOW = '#C98A00', MID = '#4E6B43';
let sel = new Set(SUCURSALES.map(s => s.id));
let charts = {};

const $ = id => document.getElementById(id);
const fmtMoney = n => '$' + Math.round(n).toLocaleString('es-AR');
const fmtNum   = n => Math.round(n).toLocaleString('es-AR');

function firstOfMonth(){ const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }

function initFechas(){
  $('desde').value = firstOfMonth().toISOString().slice(0,10);
  $('hasta').value = new Date().toISOString().slice(0,10);
}

function renderChips(){
  const wrap = $('chips'); wrap.innerHTML = '';
  SUCURSALES.forEach(s => {
    const c = document.createElement('span');
    c.className = 'chip' + (sel.has(s.id) ? ' active' : '');
    c.textContent = s.nombre;
    c.onclick = () => { sel.has(s.id) ? sel.delete(s.id) : sel.add(s.id); c.classList.toggle('active'); };
    wrap.appendChild(c);
  });
}

function destroyChart(key){ if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

function tabla(headers, rows){
  if (!rows.length) return '<div class="empty">Sin datos en el rango.</div>';
  const head = '<tr>' + headers.map(h => `<th class="${h.num?'num':''}">${h.label}</th>`).join('') + '</tr>';
  const body = rows.map(r => '<tr>' + headers.map(h => `<td class="${h.num?'num':''}">${h.fmt ? h.fmt(r[h.key]) : r[h.key]}</td>`).join('') + '</tr>').join('');
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderKpis(k){
  $('kpis').innerHTML = [
    ['Facturación', fmtMoney(k.facturacion)],
    ['Tickets', fmtNum(k.tickets)],
    ['Ticket promedio', fmtMoney(k.ticketProm)],
    ['Unidades', fmtNum(k.unidades)],
    ['Productos distintos', fmtNum(k.productosDistintos)],
  ].map(([lbl,val]) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`).join('');
}

function renderComparativa(rows){
  destroyChart('comp');
  charts.comp = new Chart($('chComparativa'), {
    type:'bar',
    data:{ labels: rows.map(r=>r.nombre),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), backgroundColor: GREEN }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
  $('tblComparativa').innerHTML = tabla([
    {key:'nombre',label:'Sucursal'},
    {key:'facturacion',label:'Facturación',num:true,fmt:fmtMoney},
    {key:'tickets',label:'Tickets',num:true,fmt:fmtNum},
    {key:'ticketProm',label:'Ticket prom.',num:true,fmt:fmtMoney},
  ], rows);
}

function renderTendencia(rows){
  destroyChart('tend');
  charts.tend = new Chart($('chTendencia'), {
    type:'line',
    data:{ labels: rows.map(r=>r.fecha),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), borderColor: GREEN, backgroundColor:'rgba(64,89,54,.1)', fill:true, tension:.25 }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
}

function renderDow(rows){
  destroyChart('dow');
  charts.dow = new Chart($('chDow'), {
    type:'bar',
    data:{ labels: rows.map(r=>r.nombre),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), backgroundColor: MID }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
}

function renderHora(rows){
  destroyChart('hora');
  charts.hora = new Chart($('chHora'), {
    type:'bar',
    data:{ labels: rows.map(r=>`${r.hora}h`),
      datasets:[{ label:'Facturación', data: rows.map(r=>r.facturacion), backgroundColor: YELLOW }] },
    options:{ plugins:{legend:{display:false}}, scales:{ y:{ ticks:{ callback:v=>fmtMoney(v) } } } }
  });
}

function renderTop(rows, elId){
  $(elId).innerHTML = tabla([
    {key:'nombre',label:'Producto'},
    {key:'unidades',label:'Unid.',num:true,fmt:fmtNum},
    {key:'facturacion',label:'Facturación',num:true,fmt:fmtMoney},
  ], rows);
}

async function consultar(){
  if (!sel.size){ $('msg').innerHTML = '<div class="error">Seleccioná al menos una sucursal.</div>'; return; }
  const btn = $('btnAplicar'); btn.disabled = true; btn.textContent = 'Consultando...';
  $('msg').innerHTML = '<div class="loading">Cargando datos...</div>';
  const desde = $('desde').value, hasta = $('hasta').value;
  const url = `/api/analisis-ventas?desde=${desde}&hasta=${hasta}&sucursales=${[...sel].join(',')}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    $('msg').innerHTML = '';
    renderKpis(d.kpis);
    renderComparativa(d.comparativa);
    renderTendencia(d.tendencia);
    renderDow(d.diaSemana);
    renderHora(d.horas);
    renderTop(d.topUnidades, 'tblTopU');
    renderTop(d.topFacturacion, 'tblTopF');
  } catch(e){
    $('msg').innerHTML = `<div class="error">Error: ${e.message}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Aplicar';
  }
}

$('btnAplicar').onclick = consultar;
$('selAll').onclick  = () => { sel = new Set(SUCURSALES.map(s=>s.id)); renderChips(); };
$('selNone').onclick = () => { sel.clear(); renderChips(); };

initFechas(); renderChips(); consultar();
</script>
</body></html>
```

- [ ] **Step 2: Verificación manual en navegador**

Con el server dev arriba, abrir `http://localhost:8081/analisis-ventas`. Expected: carga con el mes actual por defecto, chips de las 7 sucursales activas, KPI cards con números, 4 gráficos y 2 tablas de top productos. Cambiar fechas + deseleccionar una sucursal + "Aplicar" refresca los datos.

- [ ] **Step 3: Commit**

```bash
git add analisis_ventas.html
git commit -m "feat: UI análisis de ventas por sucursal (KPIs, charts, top productos)"
```

---

## Task 5: Card de acceso en inicio.html

**Files:**
- Modify: `inicio.html:219` (dentro del array de módulos, después de la card de precios-proveedores)

- [ ] **Step 1: Agregar la card**

En `inicio.html`, dentro del array de módulos, reemplazar el cierre del objeto de `precios-proveedores` (líneas 215-219) para agregar la nueva card después. El bloque actual termina así:

```javascript
  {
    href:'/precios-proveedores', titulo:'Precios de Proveedores', icon:'tags',
    desc:'Comparación de listas de proveedores contra costos SIGA: carga por PDF, URL o manual.',
    accent:'#2f855a', soft:'#d9f2e5', ink:'#1c3f2e'
  }

];
```

Cambiarlo por (agrega coma tras el objeto anterior y la nueva card antes del `]`):

```javascript
  {
    href:'/precios-proveedores', titulo:'Precios de Proveedores', icon:'tags',
    desc:'Comparación de listas de proveedores contra costos SIGA: carga por PDF, URL o manual.',
    accent:'#2f855a', soft:'#d9f2e5', ink:'#1c3f2e'
  },
  {
    href:'/analisis-ventas', titulo:'Análisis de Ventas', icon:'bar-chart-3',
    desc:'Rendimiento por sucursal: ticket promedio, días y horas pico, top productos y comparativa entre sucursales por rango de fechas.',
    accent:'#8f5c3d', soft:'#f3e2d6', ink:'#4c2e1a'
  }

];
```

- [ ] **Step 2: Verificación manual**

Abrir `http://localhost:8081/`. Expected: aparece la card "Análisis de Ventas" con ícono de barras; al clickearla navega a `/analisis-ventas`.

- [ ] **Step 3: Commit**

```bash
git add inicio.html
git commit -m "feat: card de acceso a análisis de ventas en el hub"
```

---

## Task 6: Registrar archivos nuevos en el deploy (prevención de regresión)

> Contexto: `publicar.ps1` solo publica archivos comunes a dev y prod; los archivos nuevos deben listarse en `$extras` o nunca llegan a producción (regresión ya vista con `precios_proveedores.*`).

**Files:**
- Modify: `publicar.ps1` (si existe)

- [ ] **Step 1: Localizar el script y el array $extras**

Run: `grep -n "extras" publicar.ps1`
Expected: una o más líneas mostrando la definición del array `$extras`. Si `publicar.ps1` no existe, saltear esta task (no aplica en este entorno) y anotarlo.

- [ ] **Step 2: Agregar los archivos nuevos**

Agregar `'analisis_ventas.html'` y `'analisis_ventas.js'` al array `$extras` (mismo formato que las entradas existentes de `precios_proveedores.*`).

- [ ] **Step 3: Verificar sintaxis**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('publicar.ps1', [ref]$null, [ref]$null); 'OK'"`
Expected: `OK` (sin errores de parseo).

- [ ] **Step 4: Commit**

```bash
git add publicar.ps1
git commit -m "chore: registrar archivos de análisis-ventas en el deploy"
```

---

## Verificación final

- [ ] `node --test test/analisis_ventas.test.js` → todos PASS.
- [ ] `node --check server.js` → exit 0.
- [ ] `curl "http://localhost:8081/api/analisis-ventas?desde=2026-07-01&hasta=2026-07-17"` → JSON completo, `kpis.tickets > 0`, sin sucursal 1.
- [ ] `http://localhost:8081/analisis-ventas` → dashboard carga y refresca al cambiar filtros.
- [ ] Card visible y funcional en `http://localhost:8081/`.
- [ ] Assumption del importe neto (`vp.ImporteTotalNeto`) confirmada contra el esquema real; ajustado si el nombre difería.
```
