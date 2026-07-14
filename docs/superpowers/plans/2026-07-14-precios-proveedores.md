# Módulo Precios de Proveedores — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo de comparación y gestión de precios de proveedores: listado de productos paraCompra de SIGA con costo/último proveedor/historial anual, tabs por proveedor con listas cargadas por PDF, URL o manual, matcheadas contra SIGA con semáforo Δ%.

**Architecture:** Patrón `compras_modulo`: módulo puro `precios_proveedores.js` (parsing + matching + comparación, sin I/O), endpoints `/api/precios-proveedores/*` en `server.js` (SIGA solo lectura, persistencia en `data/precios_proveedores.json`), página vanilla `precios_proveedores.html` con estética ChakraUI (blanco/verde, acentos amarillos).

**Tech Stack:** Node CommonJS, Express 5, mssql/msnodesqlv8, multer (ya presente), `pdf-parse` y `cheerio` (nuevas), `node:test` para tests, HTML+JS vanilla.

**Spec:** `docs/superpowers/specs/2026-07-14-precios-proveedores-design.md`

**Nota servidor:** NUNCA matar/levantar el server — lo hace el usuario. Si corre con nodemon (`npm run dev`) recarga solo al guardar; si no, pedirle al usuario que reinicie antes de los smoke tests. Puerto dev: 8081.

---

## Task 1: Dependencias nuevas

**Files:**
- Modify: `package.json` (vía npm)

- [ ] **Step 1: Instalar pdf-parse y cheerio**

```bash
cd c:\Users\Adriel\ApideltaSubSystem\dev
npm install pdf-parse@1 cheerio@1
```

- [ ] **Step 2: Verificar que cargan**

```bash
node -e "require('pdf-parse'); require('cheerio'); console.log('deps ok')"
```

Esperado: `deps ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: agrega pdf-parse y cheerio para módulo precios proveedores"
```

---

## Task 2: Módulo puro — parsearPrecioAR + parsearTextoPdf (TDD)

**Files:**
- Create: `precios_proveedores.js`
- Test: `test/precios_proveedores.test.js`

- [ ] **Step 1: Escribir tests que fallan**

Crear `test/precios_proveedores.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { parsearPrecioAR, parsearTextoPdf } = require('../precios_proveedores');

test('parsearPrecioAR formatos argentinos', () => {
  assert.strictEqual(parsearPrecioAR('1.234,56'), 1234.56);
  assert.strictEqual(parsearPrecioAR('1234.56'), 1234.56);
  assert.strictEqual(parsearPrecioAR('$ 1.234'), 1234);
  assert.strictEqual(parsearPrecioAR('2,50'), 2.5);
  assert.strictEqual(parsearPrecioAR('1.234.567'), 1234567);
  assert.strictEqual(parsearPrecioAR('abc'), null);
  assert.strictEqual(parsearPrecioAR(''), null);
});

test('parsearTextoPdf detecta código, descripción y precio', () => {
  const texto = [
    'LISTA DE PRECIOS JULIO 2026',
    'ALM-100 Almendras Nonpareil x 1kg 12.500,00',
    'Nueces peladas extra light 9.800,50',
    'CODIGO DESCRIPCION PRECIO',
    '',
  ].join('\n');
  const r = parsearTextoPdf(texto);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.items[0], { codigoProveedor: 'ALM-100', descripcion: 'Almendras Nonpareil x 1kg', precio: 12500 });
  assert.deepStrictEqual(r.items[1], { codigoProveedor: '', descripcion: 'Nueces peladas extra light', precio: 9800.5 });
  assert.strictEqual(r.descartadas, 2);
});

test('parsearTextoPdf no confunde años con precios', () => {
  const r = parsearTextoPdf('Vigencia desde enero 2026\nMIEL-1 Miel pura x 500g 4.200,00');
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(r.items[0].precio, 4200);
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: FAIL — `Cannot find module '../precios_proveedores'`.

- [ ] **Step 3: Implementación mínima**

Crear `precios_proveedores.js`:

```js
'use strict';
// Módulo puro para Precios de Proveedores. Sin SQL ni fs — todo se inyecta por parámetros.
// Parsing de listas (texto PDF / HTML), matching a productos SIGA y comparación de precios.
const cheerio = require('cheerio');

const UMBRAL_NOMBRE = 0.6; // score mínimo de solapamiento de tokens para aceptar match por nombre

// "1.234,56" | "1234.56" | "$ 1.234" → número, o null si no es un número.
// Con punto y coma, el separador que aparece último es el decimal.
function parsearPrecioAR(token) {
  if (token == null) return null;
  let s = String(token).trim().replace(/^\$\s*/, '');
  if (!s || !/^\d[\d.,]*$/.test(s)) return null;
  const p = s.lastIndexOf('.'), c = s.lastIndexOf(',');
  if (p >= 0 && c >= 0) {
    s = c > p ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (c >= 0) {
    const dec = s.slice(c + 1);
    s = (s.indexOf(',') === c && dec.length <= 2) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (p >= 0) {
    const dec = s.slice(p + 1);
    if (!(s.indexOf('.') === p && dec.length <= 2)) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Un token cuenta como precio si parsea Y (tiene separador, o es entero largo que no parece año).
// Evita que "2026" en un encabezado se lea como precio.
function esPrecioToken(tok) {
  const v = parsearPrecioAR(tok);
  if (v == null) return null;
  const s = String(tok).trim().replace(/^\$\s*/, '');
  const tieneSep = /[.,]/.test(s);
  if (!tieneSep && (s.length < 4 || (v >= 1900 && v <= 2100))) return null;
  return v;
}

const RE_CODIGO = /^[A-Za-z0-9][A-Za-z0-9\-._\/]{1,14}$/;

// Texto plano (de pdf-parse) → { items: [{codigoProveedor, descripcion, precio}], descartadas }.
// Heurística por línea: precio = último token numérico; código = primer token corto con dígito.
function parsearTextoPdf(texto) {
  const items = [];
  let descartadas = 0;
  for (const cruda of String(texto || '').split(/\r?\n/)) {
    const linea = cruda.trim();
    if (!linea) continue;
    const tokens = linea.split(/\s+/);
    if (tokens.length < 2) { descartadas++; continue; }
    let precio = null, iPrecio = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const v = esPrecioToken(tokens[i]);
      if (v != null) { precio = v; iPrecio = i; break; }
    }
    if (precio == null || iPrecio === 0) { descartadas++; continue; }
    const resto = tokens.slice(0, iPrecio);
    let codigoProveedor = '';
    if (resto.length > 1 && RE_CODIGO.test(resto[0]) && /\d/.test(resto[0])) codigoProveedor = resto.shift();
    const descripcion = resto.join(' ').trim();
    if (!descripcion) { descartadas++; continue; }
    items.push({ codigoProveedor, descripcion, precio });
  }
  return { items, descartadas };
}

module.exports = { UMBRAL_NOMBRE, parsearPrecioAR, parsearTextoPdf };
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add precios_proveedores.js test/precios_proveedores.test.js
git commit -m "feat: parser heurístico de listas de precios en texto PDF (precios AR)"
```

---

## Task 3: Módulo puro — parsearHtml (TDD)

**Files:**
- Modify: `precios_proveedores.js`
- Test: `test/precios_proveedores.test.js`

- [ ] **Step 1: Agregar tests que fallan**

Agregar al final de `test/precios_proveedores.test.js` (y sumar `parsearHtml` al require de arriba):

```js
const { parsearHtml } = require('../precios_proveedores');

test('parsearHtml extrae tabla con código/descripción/precio', () => {
  const html = `<html><body><table>
    <tr><th>Código</th><th>Descripción</th><th>Precio</th></tr>
    <tr><td>ALM-100</td><td>Almendras x 1kg</td><td>$ 12.500,00</td></tr>
    <tr><td></td><td>Nueces peladas</td><td>9.800,50</td></tr>
  </table></body></html>`;
  const r = parsearHtml(html);
  assert.strictEqual(r.items.length, 2);
  assert.deepStrictEqual(r.items[0], { codigoProveedor: 'ALM-100', descripcion: 'Almendras x 1kg', precio: 12500 });
  assert.strictEqual(r.items[1].codigoProveedor, '');
  assert.strictEqual(r.items[1].precio, 9800.5);
});

test('parsearHtml sin tablas devuelve vacío', () => {
  const r = parsearHtml('<html><body><p>Sin tablas acá</p></body></html>');
  assert.strictEqual(r.items.length, 0);
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: FAIL — `parsearHtml is not a function`.

- [ ] **Step 3: Implementar parsearHtml**

Agregar a `precios_proveedores.js` (antes del `module.exports`) y exportarla:

```js
// HTML → { items, descartadas }. Recorre <table>: precio = última celda numérica,
// código = primera celda si es corta y alfanumérica, descripción = el resto.
function parsearHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const items = [];
  let descartadas = 0;
  $('table tr').each((_, tr) => {
    const celdas = $(tr).find('td,th').toArray().map(c => $(c).text().replace(/\s+/g, ' ').trim());
    if (celdas.length < 2) { if (celdas.length) descartadas++; return; }
    let precio = null, iPrecio = -1;
    for (let i = celdas.length - 1; i >= 0; i--) {
      const v = esPrecioToken(celdas[i]);
      if (v != null) { precio = v; iPrecio = i; break; }
    }
    if (precio == null) { descartadas++; return; }
    const resto = celdas.slice(0, iPrecio).filter(Boolean);
    if (!resto.length) { descartadas++; return; }
    let codigoProveedor = '';
    if (resto.length > 1 && RE_CODIGO.test(resto[0])) codigoProveedor = resto.shift();
    const descripcion = resto.join(' ').trim();
    if (!descripcion) { descartadas++; return; }
    items.push({ codigoProveedor, descripcion, precio });
  });
  return { items, descartadas };
}

module.exports = { UMBRAL_NOMBRE, parsearPrecioAR, parsearTextoPdf, parsearHtml };
```

(El `module.exports` reemplaza al anterior.)

- [ ] **Step 4: Correr y verificar que pasa**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add precios_proveedores.js test/precios_proveedores.test.js
git commit -m "feat: parser de tablas de precios en HTML de proveedores"
```

---

## Task 4: Módulo puro — matching ítem → producto SIGA (TDD)

**Files:**
- Modify: `precios_proveedores.js`
- Test: `test/precios_proveedores.test.js`

- [ ] **Step 1: Agregar tests que fallan**

```js
const { matchearItems, scoreNombre, normalizarNombre } = require('../precios_proveedores');

test('normalizarNombre saca acentos y símbolos', () => {
  assert.strictEqual(normalizarNombre('Almendra Ñandú x 1kg (Prem.)'), 'almendra nandu x 1kg prem');
});

test('matchearItems prioriza manual > codigo > barras > nombre', () => {
  const items = [
    { codigoProveedor: 'A1', descripcion: 'Cualquiera', precio: 10 },
    { codigoProveedor: 'B2', descripcion: 'Otra cosa', precio: 20 },
    { codigoProveedor: '7791234567890', descripcion: 'Con barras', precio: 30 },
    { codigoProveedor: '', descripcion: 'Almendras Nonpareil 1kg', precio: 40 },
    { codigoProveedor: '', descripcion: 'Producto desconocido xyz', precio: 50 },
  ];
  const ctx = {
    matcheosManuales: { A1: '100' },
    codigosProveedor: new Map([['A1', '999'], ['B2', '200']]),
    barras: new Map([['7791234567890', '300']]),
    catalogo: [{ plu: '400', nombre: 'Almendras Nonpareil x 1kg' }, { plu: '500', nombre: 'Miel pura' }],
  };
  const r = matchearItems(items, ctx);
  assert.deepStrictEqual(r.map(x => [x.plu, x.matchTipo]), [
    ['100', 'manual'], ['200', 'codigo'], ['300', 'barras'], ['400', 'nombre'], [null, null],
  ]);
  assert.ok(r[3].matchScore >= 0.6);
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: FAIL — `matchearItems is not a function`.

- [ ] **Step 3: Implementar matching**

Agregar a `precios_proveedores.js` y exportar:

```js
// minúsculas, sin acentos, sin símbolos — para comparar nombres.
function normalizarNombre(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Solapamiento de tokens: intersección / máx(|a|,|b|). 0..1.
function scoreNombre(a, b) {
  const ta = new Set(normalizarNombre(a).split(' ').filter(Boolean));
  const tb = new Set(normalizarNombre(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

// Resuelve plu por: 1) matcheo manual, 2) código de proveedor SIGA, 3) código de barras,
// 4) nombre (score >= UMBRAL_NOMBRE). Sin match → plu null.
// ctx: { matcheosManuales: {cod→plu}, codigosProveedor: Map, barras: Map, catalogo: [{plu, nombre}] }
function matchearItems(items, ctx = {}) {
  const manuales = ctx.matcheosManuales || {};
  const codigos = ctx.codigosProveedor instanceof Map ? ctx.codigosProveedor : new Map(Object.entries(ctx.codigosProveedor || {}));
  const barras = ctx.barras instanceof Map ? ctx.barras : new Map(Object.entries(ctx.barras || {}));
  const catalogo = Array.isArray(ctx.catalogo) ? ctx.catalogo : [];
  return (Array.isArray(items) ? items : []).map(it => {
    const cod = String(it.codigoProveedor || '');
    if (cod && manuales[cod]) return { ...it, plu: String(manuales[cod]), matchTipo: 'manual', matchScore: 1 };
    if (cod && codigos.has(cod)) return { ...it, plu: String(codigos.get(cod)), matchTipo: 'codigo', matchScore: 1 };
    if (/^\d{8,14}$/.test(cod) && barras.has(cod)) return { ...it, plu: String(barras.get(cod)), matchTipo: 'barras', matchScore: 1 };
    let mejor = null, mejorScore = 0;
    for (const p of catalogo) {
      const s = scoreNombre(it.descripcion, p.nombre);
      if (s > mejorScore) { mejorScore = s; mejor = p; }
    }
    if (mejor && mejorScore >= UMBRAL_NOMBRE) return { ...it, plu: String(mejor.plu), matchTipo: 'nombre', matchScore: +mejorScore.toFixed(2) };
    return { ...it, plu: null, matchTipo: null, matchScore: 0 };
  });
}

module.exports = { UMBRAL_NOMBRE, parsearPrecioAR, parsearTextoPdf, parsearHtml, normalizarNombre, scoreNombre, matchearItems };
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add precios_proveedores.js test/precios_proveedores.test.js
git commit -m "feat: matching de items de lista a productos SIGA (manual/código/barras/nombre)"
```

---

## Task 5: Módulo puro — compararItem (TDD)

**Files:**
- Modify: `precios_proveedores.js`
- Test: `test/precios_proveedores.test.js`

- [ ] **Step 1: Agregar tests que fallan**

```js
const { compararItem } = require('../precios_proveedores');

test('compararItem semáforo con tolerancia', () => {
  assert.deepStrictEqual(compararItem({ precioLista: 90, costoActual: 100, toleranciaPct: 2 }), { deltaPct: -10, semaforo: 'verde' });
  assert.deepStrictEqual(compararItem({ precioLista: 101, costoActual: 100, toleranciaPct: 2 }), { deltaPct: 1, semaforo: 'amarillo' });
  assert.deepStrictEqual(compararItem({ precioLista: 110, costoActual: 100, toleranciaPct: 2 }), { deltaPct: 10, semaforo: 'rojo' });
  assert.deepStrictEqual(compararItem({ precioLista: 110, costoActual: 0 }), { deltaPct: null, semaforo: null });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: FAIL — `compararItem is not a function`.

- [ ] **Step 3: Implementar**

```js
// Δ% del precio de lista contra el costo actual + semáforo.
// verde = más barato que costo-tolerancia, amarillo = dentro de ±tolerancia, rojo = más caro.
function compararItem({ precioLista, costoActual, toleranciaPct = 2 }) {
  const precio = Number(precioLista), costo = Number(costoActual);
  if (!Number.isFinite(precio) || !Number.isFinite(costo) || costo <= 0) return { deltaPct: null, semaforo: null };
  const deltaPct = +(((precio - costo) / costo) * 100).toFixed(1);
  const tol = Number(toleranciaPct) || 0;
  return { deltaPct, semaforo: deltaPct < -tol ? 'verde' : deltaPct > tol ? 'rojo' : 'amarillo' };
}

module.exports = { UMBRAL_NOMBRE, parsearPrecioAR, parsearTextoPdf, parsearHtml, normalizarNombre, scoreNombre, matchearItems, compararItem };
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
node --test test/precios_proveedores.test.js
```

Esperado: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add precios_proveedores.js test/precios_proveedores.test.js
git commit -m "feat: comparación Δ% con semáforo y tolerancia para precios de proveedores"
```

---

## Task 6: Server — persistencia + helpers SQL + GET listado

**Files:**
- Modify: `server.js` (requires junto a los otros módulos propios; helpers y rutas en bloque nuevo al final del archivo, antes del `app.listen`)

**Contexto para quien implementa:** `server.js` ya tiene `leerJSON(p, def)` y `guardarJSON(p, data)` (~línea 960), `apiRoute(fn)` (~línea 972), `query(q)` (~línea 59), `DATA_DIR`, y el patrón de páginas `app.get('/ruta', sendFile)` (~línea 923). SIGA es SOLO lectura. Strings en SQL siempre escapados con `.replace(/'/g, "''")`.

- [ ] **Step 1: Requires y persistencia**

Buscar `const comprasModulo = require('./compras_modulo')` y agregar debajo:

```js
const preciosProv = require('./precios_proveedores');
const pdfParse = require('pdf-parse');
```

Al final del archivo (antes de `app.listen`), iniciar bloque nuevo:

```js
// ── Precios de Proveedores ─────────────────────────────────────────────────────
const PRECIOS_PROV_PATH = path.join(DATA_DIR, 'precios_proveedores.json');
const PRECIOS_PROV_DEF = { toleranciaPct: 2, proveedores: [] };
function leerPreciosProv() { return leerJSON(PRECIOS_PROV_PATH, PRECIOS_PROV_DEF); }
function guardarPreciosProv(d) { guardarJSON(PRECIOS_PROV_PATH, d); }
```

- [ ] **Step 2: Helpers SQL**

```js
// Universo paraCompra (EsDeCompras=1, Activo=1) + costo actual de la central + código de barras.
async function universoParaCompra() {
  const rows = await query(`
    SELECT p.IdProducto, p.NombreProducto, p.CodigoDeBarras,
           CAST(ps.PrecioCosto AS FLOAT) AS PrecioCosto
    FROM Productos p
    LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
      AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
    WHERE p.EsDeCompras = 1 AND p.Activo = 1`);
  return rows.map(r => ({
    plu: String(r.IdProducto), nombre: r.NombreProducto,
    barras: String(r.CodigoDeBarras || '').trim(),
    costo: r.PrecioCosto != null ? +r.PrecioCosto : null,
  }));
}

// plu → { proveedor, precio, fecha } del proveedor con última fecha de compra.
async function ultimoProveedorPorProducto() {
  const rows = await query(`
    SELECT pp.IdProducto, pv.NombreProveedor, CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
           CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS Fecha
    FROM ProductosProveedores pp
    JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
    WHERE pp.UltimaFechaCompra IS NOT NULL
    ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC`);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, { proveedor: r.NombreProveedor, precio: r.Precio, fecha: r.Fecha });
  }
  return map;
}

// plu → [{proveedor, fecha (última), precio (de la última compra), cantidad (total)}] del año en curso.
async function historialComprasAnio() {
  const inicio = `${new Date().getFullYear()}-01-01`;
  const rows = await query(`
    SELECT cp.IdProducto, pv.NombreProveedor,
           CONVERT(varchar(10), c.Fecha, 23) AS Fecha,
           CAST(cp.Precio AS FLOAT) AS Precio, CAST(cp.Cantidad AS FLOAT) AS Cantidad
    FROM ComprasProductos cp
    JOIN Compras c ON c.IdSucursal = cp.IdSucursal AND c.IdTipoComprobante = cp.IdTipoComprobante
      AND c.Letra = cp.Letra AND c.CentroEmisor = cp.CentroEmisor AND c.NumeroComprobante = cp.NumeroComprobante
    JOIN Proveedores pv ON pv.IdProveedor = c.IdProveedor
    WHERE c.Fecha >= '${inicio}'
    ORDER BY cp.IdProducto, c.Fecha DESC`);
  const map = new Map();
  for (const r of rows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, new Map());
    const prov = map.get(id);
    if (!prov.has(r.NombreProveedor)) {
      prov.set(r.NombreProveedor, { proveedor: r.NombreProveedor, fecha: r.Fecha, precio: r.Precio, cantidad: r.Cantidad || 0 });
    } else {
      prov.get(r.NombreProveedor).cantidad += r.Cantidad || 0;
    }
  }
  const out = new Map();
  for (const [id, provs] of map) out.set(id, [...provs.values()]);
  return out;
}
```

- [ ] **Step 3: Ruta GET listado + ruta de página**

```js
app.get('/precios-proveedores', (_req, res) => res.sendFile(path.join(__dirname, 'precios_proveedores.html')));

app.get('/api/precios-proveedores/listado', apiRoute(async () => {
  const [universo, ultimo, historial] = await Promise.all([
    universoParaCompra(), ultimoProveedorPorProducto(), historialComprasAnio(),
  ]);
  const productos = universo.map(p => {
    const u = ultimo.get(p.plu) || {};
    return {
      plu: p.plu, nombre: p.nombre, costo: p.costo,
      ultimoProveedor: u.proveedor || null, ultimoPrecio: u.precio || null, ultimaFecha: u.fecha || null,
      proveedoresAnio: historial.get(p.plu) || [],
    };
  });
  return { productos, total: productos.length, fechaCalculo: new Date().toISOString() };
}));
```

- [ ] **Step 4: Verificar sintaxis y smoke**

```bash
node --check server.js
```

Esperado: sin output (OK). Luego (con el server dev recargado — nodemon recarga solo; si no, pedir reinicio al usuario):

```bash
curl -s "http://localhost:8081/api/precios-proveedores/listado" | head -c 400
```

Esperado: JSON con `"productos":[...` y `"total":` ≈ 3274.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: endpoint listado precios-proveedores (universo paraCompra + último proveedor + historial año)"
```

---

## Task 7: Server — CRUD de tabs de proveedores + búsqueda SIGA

**Files:**
- Modify: `server.js` (mismo bloque de Task 6)

- [ ] **Step 1: Rutas**

```js
app.get('/api/precios-proveedores/proveedores', apiRoute(async () => leerPreciosProv()));

app.get('/api/precios-proveedores/proveedores-siga', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { proveedores: [] };
  const like = q.replace(/'/g, "''");
  const rows = await query(`SELECT IdProveedor, NombreProveedor FROM Proveedores
    WHERE NombreProveedor LIKE '%${like}%' ORDER BY NombreProveedor`);
  return { proveedores: rows.map(r => ({ idProveedorSiga: Number(r.IdProveedor), nombre: r.NombreProveedor })) };
}));

app.post('/api/precios-proveedores/proveedores', apiRoute(async (req) => {
  const { idProveedorSiga, nombre, url } = req.body || {};
  const idNum = Number(idProveedorSiga);
  if (!Number.isFinite(idNum) || idNum <= 0 || !nombre) throw new Error('Proveedor inválido: falta idProveedorSiga o nombre');
  const data = leerPreciosProv();
  const id = `prov-${idNum}`;
  if (data.proveedores.some(p => p.id === id)) throw new Error('El proveedor ya tiene tab');
  const nuevo = { id, idProveedorSiga: idNum, nombre: String(nombre), url: url ? String(url) : '', listaVigente: null, matcheosManuales: {} };
  guardarPreciosProv({ ...data, proveedores: [...data.proveedores, nuevo] });
  return nuevo;
}));

app.delete('/api/precios-proveedores/proveedores/:id', apiRoute(async (req) => {
  const data = leerPreciosProv();
  const quedan = data.proveedores.filter(p => p.id !== req.params.id);
  if (quedan.length === data.proveedores.length) throw new Error('Proveedor no encontrado');
  guardarPreciosProv({ ...data, proveedores: quedan });
  return { ok: true };
}));
```

Nota: verificar que `app.use(express.json())` (o equivalente) ya esté configurado globalmente en `server.js` — los POST existentes (`/api/compras-modulo/carrito/cobertura`) lo usan. Si no está global, agregar `express.json()` como middleware en estas rutas.

- [ ] **Step 2: Verificar**

```bash
node --check server.js
curl -s "http://localhost:8081/api/precios-proveedores/proveedores"
curl -s "http://localhost:8081/api/precios-proveedores/proveedores-siga?q=car" | head -c 300
```

Esperado: primero `{"toleranciaPct":2,"proveedores":[]}`; segundo, proveedores SIGA cuyo nombre contenga "car".

- [ ] **Step 3: Probar alta y baja**

```bash
curl -s -X POST "http://localhost:8081/api/precios-proveedores/proveedores" -H "Content-Type: application/json" -d "{\"idProveedorSiga\":1,\"nombre\":\"Prueba\"}"
curl -s -X DELETE "http://localhost:8081/api/precios-proveedores/proveedores/prov-1"
```

Esperado: alta devuelve el proveedor con `"id":"prov-1"`; baja devuelve `{"ok":true}`. Verificar que `data/precios_proveedores.json` quedó sin proveedores.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat: tabs de proveedores persistidas y búsqueda de proveedores SIGA"
```

---

## Task 8: Server — parse-pdf, parse-url, confirmar lista, comparación

**Files:**
- Modify: `server.js` (mismo bloque)

- [ ] **Step 1: Contexto de matching + guard de URL**

```js
// Contexto para matchearItems: códigos del proveedor en SIGA + barras + catálogo del universo.
async function contextoMatching(idProveedorSiga, matcheosManuales) {
  const universo = await universoParaCompra();
  const catalogo = universo.map(p => ({ plu: p.plu, nombre: p.nombre }));
  const barras = new Map(universo.filter(p => p.barras).map(p => [p.barras, p.plu]));
  const codigosProveedor = new Map();
  const idNum = Number(idProveedorSiga);
  if (Number.isFinite(idNum) && idNum > 0) {
    const rows = await query(`SELECT IdProducto, CodigoProductoProveedor FROM ProductosProveedores
      WHERE IdProveedor = ${idNum} AND LTRIM(RTRIM(ISNULL(CodigoProductoProveedor,''))) <> ''`);
    for (const r of rows) codigosProveedor.set(String(r.CodigoProductoProveedor).trim(), String(r.IdProducto));
  }
  return { matcheosManuales: matcheosManuales || {}, codigosProveedor, barras, catalogo };
}

// Solo http/https públicas — bloquea localhost y rangos privados (SSRF).
function urlPermitida(u) {
  let parsed;
  try { parsed = new URL(String(u)); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const h = parsed.hostname;
  return !(h === 'localhost' || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^0\.|^\[?::1/.test(h));
}
```

- [ ] **Step 2: parse-pdf y parse-url (devuelven propuesta, NO persisten)**

```js
const uploadPreciosPdf = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/precios-proveedores/parse-pdf', uploadPreciosPdf.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(422).json({ error: 'Falta el archivo PDF (campo "pdf")' });
    const data = leerPreciosProv();
    const prov = data.proveedores.find(p => p.id === String(req.body.id || ''));
    if (!prov) return res.status(422).json({ error: 'Proveedor no encontrado' });
    let texto = '';
    try { texto = (await pdfParse(req.file.buffer)).text || ''; }
    catch { return res.status(422).json({ error: 'PDF corrupto o ilegible' }); }
    if (!texto.trim()) return res.status(422).json({ error: 'PDF sin texto extraíble (¿escaneado? OCR fuera de alcance)' });
    const { items, descartadas } = preciosProv.parsearTextoPdf(texto);
    if (!items.length) return res.status(422).json({ error: 'No se detectaron líneas con precio en el PDF', descartadas });
    const ctx = await contextoMatching(prov.idProveedorSiga, prov.matcheosManuales);
    res.json({ items: preciosProv.matchearItems(items, ctx), descartadas });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});

app.post('/api/precios-proveedores/parse-url', async (req, res) => {
  try {
    const { url, id } = req.body || {};
    if (!urlPermitida(url)) return res.status(422).json({ error: 'URL inválida (solo http/https públicas)' });
    const data = leerPreciosProv();
    const prov = data.proveedores.find(p => p.id === String(id || ''));
    if (!prov) return res.status(422).json({ error: 'Proveedor no encontrado' });
    let html = '';
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (ApideltaSubSystem)' } });
      clearTimeout(t);
      if (!resp.ok) return res.status(422).json({ error: `La página respondió ${resp.status}` });
      html = await resp.text();
    } catch { return res.status(422).json({ error: 'No se pudo acceder a la URL (timeout o red)' }); }
    const { items, descartadas } = preciosProv.parsearHtml(html);
    if (!items.length) return res.status(422).json({ error: 'No se encontraron tablas con precios en la página', descartadas });
    const ctx = await contextoMatching(prov.idProveedorSiga, prov.matcheosManuales);
    res.json({ items: preciosProv.matchearItems(items, ctx), descartadas });
  } catch (err) { console.error(err.message); res.status(500).json({ error: err.message }); }
});
```

- [ ] **Step 3: Confirmar lista (persiste) + comparación**

```js
app.put('/api/precios-proveedores/proveedores/:id/lista', apiRoute(async (req) => {
  const { origen, items, matcheosManuales } = req.body || {};
  if (!['pdf', 'url', 'manual'].includes(origen)) throw new Error('Origen inválido (pdf|url|manual)');
  if (!Array.isArray(items) || !items.length) throw new Error('La lista no tiene items');
  const limpios = items.map(it => {
    const precio = Number(it.precio);
    if (!Number.isFinite(precio) || precio <= 0) throw new Error(`Precio inválido en "${it.descripcion || it.codigoProveedor || '?'}"`);
    if (!it.descripcion) throw new Error('Item sin descripción');
    return {
      codigoProveedor: String(it.codigoProveedor || ''), descripcion: String(it.descripcion),
      precio, plu: it.plu != null && it.plu !== '' ? String(it.plu) : null,
      matchTipo: it.matchTipo || null, matchScore: Number(it.matchScore) || 0,
    };
  });
  const data = leerPreciosProv();
  const i = data.proveedores.findIndex(p => p.id === req.params.id);
  if (i < 0) throw new Error('Proveedor no encontrado');
  const prov = data.proveedores[i];
  const manuales = { ...prov.matcheosManuales };
  if (matcheosManuales && typeof matcheosManuales === 'object') {
    for (const [cod, plu] of Object.entries(matcheosManuales)) if (cod && plu) manuales[String(cod)] = String(plu);
  }
  const actualizado = {
    ...prov, matcheosManuales: manuales,
    listaVigente: { fechaCarga: new Date().toISOString(), origen, items: limpios },
  };
  guardarPreciosProv({ ...data, proveedores: data.proveedores.map((p, j) => (j === i ? actualizado : p)) });
  return actualizado;
}));

app.get('/api/precios-proveedores/proveedores/:id/comparacion', apiRoute(async (req) => {
  const data = leerPreciosProv();
  const prov = data.proveedores.find(p => p.id === req.params.id);
  if (!prov) throw new Error('Proveedor no encontrado');
  if (!prov.listaVigente) return { proveedor: prov.nombre, fechaCarga: null, origen: null, filas: [], sinMatchear: [] };
  const [universo, ultimo] = await Promise.all([universoParaCompra(), ultimoProveedorPorProducto()]);
  const porPlu = new Map(universo.map(p => [p.plu, p]));
  const filas = [], sinMatchear = [];
  for (const it of prov.listaVigente.items) {
    if (!it.plu || !porPlu.has(it.plu)) { sinMatchear.push(it); continue; }
    const p = porPlu.get(it.plu), u = ultimo.get(it.plu) || {};
    const cmp = preciosProv.compararItem({ precioLista: it.precio, costoActual: p.costo, toleranciaPct: data.toleranciaPct });
    filas.push({ ...it, nombreSiga: p.nombre, costoActual: p.costo, ultimoPagado: u.precio || null, ...cmp });
  }
  return { proveedor: prov.nombre, fechaCarga: prov.listaVigente.fechaCarga, origen: prov.listaVigente.origen, filas, sinMatchear };
}));
```

- [ ] **Step 4: Verificar**

```bash
node --check server.js
```

Smoke (server recargado): crear proveedor de prueba, confirmar lista manual, pedir comparación, borrar:

```bash
curl -s -X POST "http://localhost:8081/api/precios-proveedores/proveedores" -H "Content-Type: application/json" -d "{\"idProveedorSiga\":1,\"nombre\":\"Prueba\"}"
curl -s -X PUT "http://localhost:8081/api/precios-proveedores/proveedores/prov-1/lista" -H "Content-Type: application/json" -d "{\"origen\":\"manual\",\"items\":[{\"codigoProveedor\":\"X1\",\"descripcion\":\"Item prueba\",\"precio\":100,\"plu\":null}]}"
curl -s "http://localhost:8081/api/precios-proveedores/proveedores/prov-1/comparacion"
curl -s -X DELETE "http://localhost:8081/api/precios-proveedores/proveedores/prov-1"
```

Esperado: lista guardada con `fechaCarga`; comparación con `sinMatchear` de 1 item; delete ok.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat: carga de listas por PDF/URL con revisión, confirmación y comparación contra SIGA"
```

---

## Task 9: Página `precios_proveedores.html` + tile en inicio

**Files:**
- Create: `precios_proveedores.html`
- Modify: `inicio.html` (array `MODULOS`, ~línea 169)

- [ ] **Step 1: Crear la página completa**

Crear `precios_proveedores.html` con este contenido exacto:

```html
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Precios de Proveedores · Apidelta</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
/* ── Tokens estética Chakra / colores Apidelta: blanco + verde, acentos amarillos ── */
:root{
  --verde-600:#2f855a; --verde-500:#38a169; --verde-50:#e6f4ec;
  --amarillo-500:#d69e2e; --amarillo-100:#fefcbf;
  --rojo-500:#e53e3e; --rojo-50:#fed7d7;
  --gris-900:#1a202c; --gris-600:#4a5568; --gris-500:#718096;
  --gris-200:#e2e8f0; --gris-100:#edf2f7; --gris-50:#f7fafc;
  --radius:8px; --sombra:0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.04);
  --ring:0 0 0 3px rgba(56,161,105,.35);
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fff;color:var(--gris-900);font-size:14px}
a{color:var(--verde-600)}
.wrap{max-width:1280px;margin:0 auto;padding:16px 20px 60px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:2px solid var(--verde-600);margin-bottom:14px}
header.top h1{font-size:20px;font-weight:700;color:var(--verde-600)}
header.top .sub{color:var(--gris-500);font-size:12px}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:var(--radius);padding:8px 14px;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.btn:focus-visible{outline:none;box-shadow:var(--ring)}
.btn-solid{background:var(--verde-500);color:#fff}
.btn-solid:hover{background:var(--verde-600)}
.btn-outline{background:#fff;color:var(--verde-600);border:1px solid var(--verde-500)}
.btn-outline:hover{background:var(--verde-50)}
.btn-ghost{background:transparent;color:var(--gris-600)}
.btn-ghost:hover{background:var(--gris-100)}
.btn-sm{padding:4px 10px;font-size:12.5px}
.input{border:1px solid var(--gris-200);border-radius:var(--radius);padding:8px 12px;font-size:14px;background:#fff;color:var(--gris-900)}
.input:focus{outline:none;border-color:var(--verde-500);box-shadow:var(--ring)}
.card{background:#fff;border:1px solid var(--gris-200);border-radius:var(--radius);box-shadow:var(--sombra)}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:11.5px;font-weight:700}
.badge-amarillo{background:var(--amarillo-100);color:#744210;cursor:pointer}
.badge-verde{background:var(--verde-50);color:var(--verde-600)}
.badge-gris{background:var(--gris-100);color:var(--gris-600)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:14px}
.tab{border:none;background:transparent;border-radius:var(--radius) var(--radius) 0 0;padding:9px 16px;font-size:14px;font-weight:600;color:var(--gris-600);cursor:pointer;border-bottom:2.5px solid transparent}
.tab:hover{color:var(--verde-600);background:var(--gris-50)}
.tab.activa{color:var(--verde-600);border-bottom-color:var(--verde-500);background:var(--verde-50)}
.tab .cerrar{margin-left:8px;color:var(--gris-500);font-weight:400}
.tab .cerrar:hover{color:var(--rojo-500)}
table{width:100%;border-collapse:collapse}
th{position:sticky;top:0;background:var(--verde-600);color:#fff;text-align:left;padding:9px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.03em;cursor:pointer;user-select:none;white-space:nowrap}
th.num,td.num{text-align:right}
td{padding:7px 10px;border-bottom:1px solid var(--gris-100);vertical-align:middle}
tbody tr:hover{background:var(--gris-50)}
tr.expandida>td{background:var(--amarillo-100)}
tr.detalle td{background:#fffef2;font-size:13px;color:var(--gris-600);padding-left:28px}
.sem{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:baseline}
.sem-verde{background:var(--verde-500)}.sem-amarillo{background:var(--amarillo-500)}.sem-rojo{background:var(--rojo-500)}
.delta-verde{color:var(--verde-600);font-weight:700}
.delta-amarillo{color:var(--amarillo-500);font-weight:700}
.delta-rojo{color:var(--rojo-500);font-weight:700}
.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px;border-bottom:1px solid var(--gris-200)}
.toolbar .info{color:var(--gris-500);font-size:12.5px;margin-left:auto}
#banner{display:none;background:var(--rojo-50);color:#742a2a;border:1px solid var(--rojo-500);border-radius:var(--radius);padding:10px 14px;margin-bottom:12px;font-weight:600}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(26,32,44,.55);z-index:50;align-items:flex-start;justify-content:center;padding:40px 16px}
.modal{background:#fff;border-radius:var(--radius);box-shadow:0 10px 40px rgba(0,0,0,.25);width:min(960px,100%);max-height:85vh;display:flex;flex-direction:column}
.modal h2{font-size:16px;padding:14px 18px;border-bottom:1px solid var(--gris-200);color:var(--verde-600)}
.modal .cuerpo{overflow:auto;padding:12px 18px;flex:1}
.modal .pie{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid var(--gris-200)}
td .input{padding:4px 8px;font-size:13px}
.dudosa{background:var(--amarillo-100)}
.lista-busqueda div{padding:8px 10px;border-radius:6px;cursor:pointer}
.lista-busqueda div:hover{background:var(--verde-50)}
.vacio{padding:40px;text-align:center;color:var(--gris-500)}
.tbl-scroll{overflow-x:auto}
h3.seccion{font-size:14px;color:var(--gris-600);margin:18px 0 8px}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>Precios de Proveedores</h1>
      <div class="sub">Comparación de listas contra costos SIGA · productos para compra</div>
    </div>
    <a class="btn btn-ghost" href="/">← Inicio</a>
  </header>

  <div id="banner"></div>

  <div class="tabs" id="tabs"></div>
  <div id="contenido"></div>
</div>

<!-- Modal agregar proveedor -->
<div class="modal-bg" id="modalProv">
  <div class="modal" style="width:min(520px,100%)">
    <h2>Agregar proveedor</h2>
    <div class="cuerpo">
      <input class="input" id="buscaProv" placeholder="Buscar proveedor SIGA (mín. 2 letras)…" style="width:100%">
      <div class="lista-busqueda" id="resultProv" style="margin-top:10px"></div>
    </div>
    <div class="pie"><button class="btn btn-ghost" onclick="cerrarModales()">Cancelar</button></div>
  </div>
</div>

<!-- Modal revisión de lista -->
<div class="modal-bg" id="modalRev">
  <div class="modal">
    <h2 id="revTitulo">Revisión de lista</h2>
    <div class="cuerpo">
      <div id="revInfo" style="margin-bottom:10px;color:var(--gris-500);font-size:12.5px"></div>
      <div class="tbl-scroll"><table>
        <thead><tr><th>Código</th><th>Descripción</th><th class="num">Precio</th><th>Producto SIGA (PLU)</th><th></th></tr></thead>
        <tbody id="revFilas"></tbody>
      </table></div>
      <button class="btn btn-outline btn-sm" style="margin-top:10px" onclick="revAgregarFila()">+ Agregar ítem</button>
    </div>
    <div class="pie">
      <button class="btn btn-ghost" onclick="cerrarModales()">Cancelar</button>
      <button class="btn btn-solid" onclick="confirmarRevision()">Confirmar y guardar</button>
    </div>
  </div>
</div>

<datalist id="catalogoSiga"></datalist>

<script>
'use strict';
// ── Estado ──────────────────────────────────────────────────────────────────
let LISTADO = [];        // productos del universo paraCompra (GET /listado)
let CONFIG = { toleranciaPct: 2, proveedores: [] };
let TAB = 'listado';     // 'listado' | id de proveedor
let ORDEN = { col: 'nombre', asc: true };
let FILTRO = '';
let EXPANDIDAS = new Set();
let REV = null;          // { provId, origen, items:[...] } durante revisión

const $ = s => document.querySelector(s);
const fmt = n => n == null ? '—' : new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function banner(msg) {
  const b = $('#banner');
  if (!msg) { b.style.display = 'none'; return; }
  b.textContent = msg; b.style.display = 'block';
  setTimeout(() => { b.style.display = 'none'; }, 8000);
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function renderTabs() {
  const t = $('#tabs');
  const tabs = [`<button class="tab ${TAB === 'listado' ? 'activa' : ''}" onclick="irA('listado')">Listado</button>`];
  for (const p of CONFIG.proveedores) {
    tabs.push(`<button class="tab ${TAB === p.id ? 'activa' : ''}" onclick="irA('${p.id}')">${esc(p.nombre)}
      <span class="cerrar" onclick="event.stopPropagation();quitarProveedor('${p.id}')" title="Quitar tab">✕</span></button>`);
  }
  tabs.push(`<button class="btn btn-outline btn-sm" onclick="abrirModalProv()">+ Proveedor</button>`);
  t.innerHTML = tabs.join('');
}

function irA(tab) { TAB = tab; renderTabs(); TAB === 'listado' ? renderListado() : renderProveedor(tab); }

// ── Vista Listado ───────────────────────────────────────────────────────────
function ordenar(col) {
  ORDEN = { col, asc: ORDEN.col === col ? !ORDEN.asc : true };
  renderListado();
}

function renderListado() {
  const cont = $('#contenido');
  const filtro = FILTRO.toLowerCase();
  const filas = LISTADO.filter(p => !filtro || p.plu.includes(filtro) || p.nombre.toLowerCase().includes(filtro));
  const dir = ORDEN.asc ? 1 : -1;
  filas.sort((a, b) => {
    const va = a[ORDEN.col], vb = b[ORDEN.col];
    if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * dir;
  });
  const cuerpo = filas.map(p => {
    const nProv = p.proveedoresAnio.length;
    const badge = nProv > 1
      ? `<span class="badge badge-amarillo" onclick="toggleExp('${p.plu}')">${nProv} prov.</span>`
      : '';
    let html = `<tr class="${EXPANDIDAS.has(p.plu) ? 'expandida' : ''}">
      <td>${esc(p.plu)}</td><td>${esc(p.nombre)} ${badge}</td>
      <td class="num">${fmt(p.costo)}</td>
      <td>${esc(p.ultimoProveedor || '—')}</td>
      <td class="num">${fmt(p.ultimoPrecio)}</td>
      <td>${esc(p.ultimaFecha || '—')}</td></tr>`;
    if (EXPANDIDAS.has(p.plu) && nProv) {
      html += p.proveedoresAnio.map(h => `<tr class="detalle"><td colspan="2">↳ ${esc(h.proveedor)}</td>
        <td class="num">${fmt(h.precio)}</td><td>últ. compra ${esc(h.fecha)}</td>
        <td class="num">${fmt(h.cantidad)}</td><td>cant. año</td></tr>`).join('');
    }
    return html;
  }).join('');
  cont.innerHTML = `<div class="card">
    <div class="toolbar">
      <input class="input" id="filtro" placeholder="Buscar por código o nombre…" value="${esc(FILTRO)}" style="width:320px">
      <span class="info">${filas.length} de ${LISTADO.length} productos · amarillo = más de un proveedor en el año</span>
    </div>
    <div class="tbl-scroll"><table>
      <thead><tr>
        <th onclick="ordenar('plu')">Código</th><th onclick="ordenar('nombre')">Nombre</th>
        <th class="num" onclick="ordenar('costo')">Costo</th>
        <th onclick="ordenar('ultimoProveedor')">Último proveedor</th>
        <th class="num" onclick="ordenar('ultimoPrecio')">Últ. precio</th>
        <th onclick="ordenar('ultimaFecha')">Fecha</th>
      </tr></thead>
      <tbody>${cuerpo || `<tr><td colspan="6" class="vacio">Sin resultados</td></tr>`}</tbody>
    </table></div></div>`;
  const inp = $('#filtro');
  inp.addEventListener('input', () => { FILTRO = inp.value; renderListado(); });
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
}

function toggleExp(plu) { EXPANDIDAS.has(plu) ? EXPANDIDAS.delete(plu) : EXPANDIDAS.add(plu); renderListado(); }

// ── Vista Proveedor ─────────────────────────────────────────────────────────
async function renderProveedor(id) {
  const prov = CONFIG.proveedores.find(p => p.id === id);
  if (!prov) return irA('listado');
  const cont = $('#contenido');
  cont.innerHTML = `<div class="vacio">Cargando…</div>`;
  let cmp;
  try { cmp = await api(`/api/precios-proveedores/proveedores/${id}/comparacion`); }
  catch (e) { banner(e.message); cont.innerHTML = ''; return; }
  const acciones = `<div class="toolbar">
    <button class="btn btn-solid btn-sm" onclick="subirPdf('${id}')">Subir PDF</button>
    <button class="btn btn-outline btn-sm" onclick="cargarUrl('${id}')">Cargar desde URL</button>
    <button class="btn btn-outline btn-sm" onclick="editarManual('${id}')">Editar lista</button>
    <input type="file" id="filePdf" accept="application/pdf" style="display:none">
    <span class="info">${cmp.fechaCarga ? `Lista vigente: ${cmp.origen} · ${new Date(cmp.fechaCarga).toLocaleString('es-AR')}` : 'Sin lista cargada'}</span>
  </div>`;
  const filas = cmp.filas.map(f => {
    const cls = f.semaforo ? `delta-${f.semaforo}` : '';
    const sem = f.semaforo ? `<span class="sem sem-${f.semaforo}"></span>` : '';
    return `<tr><td>${esc(f.codigoProveedor)}</td><td>${esc(f.descripcion)}</td>
      <td class="num">${fmt(f.precio)}</td>
      <td>${esc(f.nombreSiga)} <span class="badge badge-gris">${esc(f.plu)}</span></td>
      <td class="num">${fmt(f.costoActual)}</td><td class="num">${fmt(f.ultimoPagado)}</td>
      <td class="num ${cls}">${sem}${f.deltaPct == null ? '—' : (f.deltaPct > 0 ? '+' : '') + f.deltaPct + '%'}</td></tr>`;
  }).join('');
  const sinMatch = cmp.sinMatchear.length ? `<h3 class="seccion">Sin matchear (${cmp.sinMatchear.length}) — usá "Editar lista" para asignar producto</h3>
    <div class="card tbl-scroll"><table>
      <thead><tr><th>Código</th><th>Descripción</th><th class="num">Precio</th></tr></thead>
      <tbody>${cmp.sinMatchear.map(f => `<tr><td>${esc(f.codigoProveedor)}</td><td>${esc(f.descripcion)}</td><td class="num">${fmt(f.precio)}</td></tr>`).join('')}</tbody>
    </table></div>` : '';
  cont.innerHTML = `<div class="card">${acciones}
    <div class="tbl-scroll"><table>
      <thead><tr><th>Código prov.</th><th>Descripción</th><th class="num">Precio lista</th>
        <th>Producto SIGA</th><th class="num">Costo actual</th><th class="num">Últ. pagado</th><th class="num">Δ%</th></tr></thead>
      <tbody>${filas || `<tr><td colspan="7" class="vacio">${cmp.fechaCarga ? 'Ningún ítem matcheado todavía' : 'Cargá una lista con los botones de arriba'}</td></tr>`}</tbody>
    </table></div></div>${sinMatch}`;
}

// ── Alta / baja de proveedores ──────────────────────────────────────────────
function abrirModalProv() {
  $('#modalProv').style.display = 'flex';
  const inp = $('#buscaProv'); inp.value = ''; $('#resultProv').innerHTML = ''; inp.focus();
}

async function buscarProvSiga(q) {
  if (q.trim().length < 2) { $('#resultProv').innerHTML = ''; return; }
  try {
    const r = await api(`/api/precios-proveedores/proveedores-siga?q=${encodeURIComponent(q.trim())}`);
    $('#resultProv').innerHTML = r.proveedores.map(p =>
      `<div onclick="agregarProveedor(${p.idProveedorSiga}, '${esc(p.nombre).replace(/'/g, '&#39;')}')">${esc(p.nombre)} <span class="badge badge-gris">#${p.idProveedorSiga}</span></div>`
    ).join('') || '<div style="color:var(--gris-500)">Sin resultados</div>';
  } catch (e) { banner(e.message); }
}

async function agregarProveedor(idSiga, nombre) {
  try {
    const nuevo = await api('/api/precios-proveedores/proveedores', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idProveedorSiga: idSiga, nombre }),
    });
    CONFIG.proveedores.push(nuevo);
    cerrarModales(); irA(nuevo.id);
  } catch (e) { banner(e.message); }
}

async function quitarProveedor(id) {
  const prov = CONFIG.proveedores.find(p => p.id === id);
  if (!prov || !confirm(`¿Quitar la tab de ${prov.nombre}? Se pierde su lista cargada.`)) return;
  try {
    await api(`/api/precios-proveedores/proveedores/${id}`, { method: 'DELETE' });
    CONFIG.proveedores = CONFIG.proveedores.filter(p => p.id !== id);
    if (TAB === id) TAB = 'listado';
    renderTabs(); irA(TAB);
  } catch (e) { banner(e.message); }
}

// ── Carga PDF / URL / manual → revisión ────────────────────────────────────
function subirPdf(id) {
  const file = $('#filePdf');
  file.onchange = async () => {
    if (!file.files[0]) return;
    const fd = new FormData();
    fd.append('pdf', file.files[0]); fd.append('id', id);
    try {
      const r = await api('/api/precios-proveedores/parse-pdf', { method: 'POST', body: fd });
      abrirRevision(id, 'pdf', r.items, `${r.items.length} ítems detectados · ${r.descartadas} líneas descartadas`);
    } catch (e) { banner(e.message); }
    file.value = '';
  };
  file.click();
}

async function cargarUrl(id) {
  const prov = CONFIG.proveedores.find(p => p.id === id);
  const url = prompt('URL de la lista de precios del proveedor:', prov?.url || 'https://');
  if (!url) return;
  try {
    const r = await api('/api/precios-proveedores/parse-url', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, id }),
    });
    prov.url = url;
    abrirRevision(id, 'url', r.items, `${r.items.length} ítems detectados · ${r.descartadas} filas descartadas`);
  } catch (e) { banner(e.message); }
}

function editarManual(id) {
  const prov = CONFIG.proveedores.find(p => p.id === id);
  const items = prov?.listaVigente?.items ? JSON.parse(JSON.stringify(prov.listaVigente.items)) : [];
  abrirRevision(id, 'manual', items, 'Edición manual de la lista vigente');
}

// ── Modal revisión ──────────────────────────────────────────────────────────
function abrirRevision(provId, origen, items, info) {
  REV = { provId, origen, items };
  const prov = CONFIG.proveedores.find(p => p.id === provId);
  $('#revTitulo').textContent = `Revisión — ${prov ? prov.nombre : provId}`;
  $('#revInfo').textContent = info + ' · las filas amarillas necesitan revisión (sin match o match dudoso)';
  renderRevision();
  $('#modalRev').style.display = 'flex';
}

function renderRevision() {
  $('#revFilas').innerHTML = REV.items.map((it, i) => {
    const dudosa = !it.plu || (it.matchTipo === 'nombre' && it.matchScore < 0.8);
    return `<tr class="${dudosa ? 'dudosa' : ''}">
      <td><input class="input" value="${esc(it.codigoProveedor)}" onchange="REV.items[${i}].codigoProveedor=this.value"></td>
      <td><input class="input" style="width:100%" value="${esc(it.descripcion)}" onchange="REV.items[${i}].descripcion=this.value"></td>
      <td class="num"><input class="input" style="width:90px;text-align:right" value="${it.precio ?? ''}" onchange="REV.items[${i}].precio=parseFloat(this.value.replace(',', '.'))"></td>
      <td><input class="input" list="catalogoSiga" style="width:100%" value="${esc(it.plu || '')}" placeholder="PLU o buscar…"
        onchange="asignarPlu(${i}, this.value)">${it.matchTipo ? `<span class="badge badge-verde">${it.matchTipo}${it.matchTipo === 'nombre' ? ' ' + Math.round(it.matchScore * 100) + '%' : ''}</span>` : ''}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="REV.items.splice(${i},1);renderRevision()" title="Quitar fila">✕</button></td>
    </tr>`;
  }).join('');
}

// El datalist muestra "PLU — Nombre"; acepta pegar el PLU solo o elegir del datalist.
function asignarPlu(i, valor) {
  const plu = String(valor).split('—')[0].trim();
  const existe = LISTADO.find(p => p.plu === plu);
  REV.items[i].plu = existe ? plu : null;
  REV.items[i].matchTipo = existe ? 'manual' : null;
  REV.items[i].matchScore = existe ? 1 : 0;
  renderRevision();
}

function revAgregarFila() {
  REV.items.push({ codigoProveedor: '', descripcion: '', precio: null, plu: null, matchTipo: null, matchScore: 0 });
  renderRevision();
}

async function confirmarRevision() {
  const validos = REV.items.filter(it => it.descripcion && Number(it.precio) > 0);
  if (!validos.length) { banner('La lista no tiene ítems válidos (descripción + precio > 0)'); return; }
  // Matcheos asignados a mano (matchTipo manual con código) se persisten para próximas cargas.
  const manuales = {};
  for (const it of validos) if (it.matchTipo === 'manual' && it.codigoProveedor && it.plu) manuales[it.codigoProveedor] = it.plu;
  try {
    const actualizado = await api(`/api/precios-proveedores/proveedores/${REV.provId}/lista`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origen: REV.origen, items: validos, matcheosManuales: manuales }),
    });
    const i = CONFIG.proveedores.findIndex(p => p.id === REV.provId);
    if (i >= 0) CONFIG.proveedores[i] = actualizado;
    const provId = REV.provId;
    cerrarModales(); irA(provId);
  } catch (e) { banner(e.message); }
}

function cerrarModales() {
  $('#modalProv').style.display = 'none';
  $('#modalRev').style.display = 'none';
  REV = null;
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  $('#buscaProv').addEventListener('input', e => buscarProvSiga(e.target.value));
  document.querySelectorAll('.modal-bg').forEach(m => m.addEventListener('click', e => { if (e.target === m) cerrarModales(); }));
  try {
    const [cfg, lst] = await Promise.all([
      api('/api/precios-proveedores/proveedores'),
      api('/api/precios-proveedores/listado'),
    ]);
    CONFIG = cfg; LISTADO = lst.productos;
    $('#catalogoSiga').innerHTML = LISTADO.map(p => `<option value="${esc(p.plu)}">${esc(p.plu)} — ${esc(p.nombre)}</option>`).join('');
    renderTabs(); renderListado();
  } catch (e) {
    banner('No se pudo cargar el módulo: ' + e.message);
    $('#contenido').innerHTML = '<div class="vacio">Error de carga. Revisá el servidor.</div>';
  }
}
init();
</script>
</body>
</html>
```

- [ ] **Step 2: Tile en inicio.html**

En `inicio.html`, dentro del array `MODULOS` (~línea 169), agregar después de la entrada `Ventas por Hora` (ojo con la coma — la entrada anterior hoy no termina en coma):

```js
  ,{
    href:'/precios-proveedores', titulo:'Precios de Proveedores', icon:'tags',
    desc:'Comparación de listas de proveedores contra costos SIGA: carga por PDF, URL o manual.',
    accent:'#2f855a', soft:'#d9f2e5', ink:'#1c3f2e'
  }
```

- [ ] **Step 3: Verificar en navegador**

Con el server dev recargado, abrir `http://localhost:8081/precios-proveedores`:
- Tab Listado carga productos con costo/último proveedor.
- Badge amarillo "N prov." expande historial.
- "+ Proveedor" busca y agrega tab.
- En la tab: "Editar lista" permite carga manual y confirma; comparación muestra Δ% con semáforo.
- `http://localhost:8081/` muestra el tile nuevo.

- [ ] **Step 4: Commit**

```bash
git add precios_proveedores.html inicio.html
git commit -m "feat: página precios de proveedores (listado, tabs, revisión) + tile en inicio"
```

---

## Task 10: Verificación integral

- [ ] **Step 1: Suite completa**

```bash
node --test test/
```

Esperado: todos los tests PASS (los 8 nuevos + los existentes).

- [ ] **Step 2: Sintaxis**

```bash
node --check server.js && node --check precios_proveedores.js
```

- [ ] **Step 3: Smoke E2E con curl**

```bash
curl -s "http://localhost:8081/api/precios-proveedores/listado" -o /dev/null -w "listado %{http_code}\n"
curl -s "http://localhost:8081/precios-proveedores" -o /dev/null -w "página %{http_code}\n"
curl -s -X POST "http://localhost:8081/api/precios-proveedores/parse-url" -H "Content-Type: application/json" -d "{\"url\":\"http://localhost/x\",\"id\":\"nada\"}" -o /dev/null -w "ssrf-guard %{http_code}\n"
```

Esperado: `listado 200`, `página 200`, `ssrf-guard 422`.

- [ ] **Step 4: Commit final (si quedó algo suelto) y resumen al usuario**

```bash
git status --short
```

Si hay pendientes, commitear con mensaje descriptivo. Reportar al usuario: qué quedó implementado, tests corridos, y recordar restricciones fase 1 (sin OCR, sin páginas con login).
