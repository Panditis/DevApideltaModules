# Módulo Compras — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Módulo web nuevo (`/compras-modulo`) que unifica déficit de reposición A8020, micro-envíos no cumplidos y faltante real de central en un listado accionable con stock central/sucursales/granel/fraccionado, buscador de proveedores, carrito con costos SIGA y redondeo a bulto, generación de orden de pedido persistida + imprimible, gestión de presentaciones y seguimiento de consumos de producción.

**Architecture:** `compras_modulo.js` = funciones puras (sin SQL/fs) testeables por unidad. `server.js` orquesta: reutiliza `calcularDistribucionAlmacen()` y `calcularDistribucionPesables()` ya existentes + una query `ProductosProveedores` + helpers puros + `leerJSON`/`guardarJSON`. Frontend `compras_modulo.html` (Tailwind CDN + paleta Apidelta, Fluent minimalista, 5 tabs). No se modifica `dashboard_compras.html`.

**Tech Stack:** Node/Express (server.js monolito, rutas inline), SQL Server SIGA (helper `query()`), JSON en `data/`, Tailwind CDN, fuentes Barlow Condensed/Roboto.

---

## Contexto de código reutilizado (firmas exactas verificadas)

Estas firmas fueron verificadas leyendo el código. **PLU === IdProducto** (numérico interno SIGA, sin tabla de traducción).

### `calcularDistribucionAlmacen()` — server.js:1543-1647 (ya existe, async, sin params)
Devuelve `Array<fila>` de productos rubro `'Almacen'`. Cada fila:
```js
{
  plu, nombre, rubro,
  central,        // stock del depósito central (número)
  enviar,         // { riv, urq, nacion, chaca, pergamino, sanPedro, logia, sucursal9, sucursal11 } — número | 'Fact' | 0
  enviarMicro,    // { [key]: { qty, umbral, S, min } }  key ∈ riv,urq,nacion,chaca,pergamino,sanPedro,sucu8,sucu9,sucu11
  ideal,          // { riv, urq, nacion, chaca, pergamino, sanPedro, sucursal9 } = MAX(S-stock,0) pedido teórico
  pideTotal,      // número (total teórico agregado)
  stkSuc,         // { riv, urq, nacion, chaca, pergamino, sanPedro, sucursal9 } stock actual por sucursal
  impNorm, esNuevo, primeraCompra
}
```

### `calcularDistribucionPesables(aplicarOcultar=true)` — server.js:1659-1746 (ya existe, async)
Devuelve `Array<fila>` de productos rubro `'Pesables Fraccionado'`. Cada fila:
```js
{
  plu, nombre, rubro,
  granel,         // código PLU del granel (string) | null
  nombreGranel,   // nombre del granel
  ideal,          // { <sucKey>: teorico }  pedido teórico por sucursal
  enviar,         // { <sucKey>: número | 'Fact' }
  stkSuc,         // { <sucKey>: stock } stock del terminado por sucursal (keys PES_SUC_MAP: riv,urq,nacion,chaca,pergamino,sanpedro,logia,ramallo,sucu11)
  D, granelRatio, prioridad, esNuevo, primeraCompra
}
```
**Ojo:** esta fila NO expone el stock central del granel (se calcula internamente en `granelMap` pero no se retorna). El plan agrega una query de granel propia (ver Task 7).

### `pisoMinimo(S, tramos, pisoAbsoluto)` — distribucion.js:54-58 (EXPORTADO)
```js
function pisoMinimo(S, tramos, pisoAbsoluto) {
  const s = S || 0;
  const tramo = (tramos||[]).find(t => t.hastaS == null || s <= t.hastaS) || { pct: 0 };
  return Math.max(pisoAbsoluto || 0, round(s * (tramo.pct || 0), 0));
}
```
`tramos = [{hastaS, pct}]` ASC con `hastaS:null` catch-all. Exportado en `module.exports` de distribucion.js:382.

### Query proveedor + costo + última compra — server.js:1191-1199 (patrón `calcularPanelCompras`)
```sql
SELECT pp.IdProducto, p.NombreProducto, pv.NombreProveedor,
       CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
       CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS FechaPrecio
FROM ProductosProveedores pp
JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
JOIN Productos p ON p.IdProducto = pp.IdProducto
WHERE pp.UltimoPrecioCompra > 0 AND p.Activo = 1
ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC
```
Tomar la **primera fila por IdProducto** = proveedor de la compra más reciente. `pp.IdProducto` es VARCHAR en SIGA.

### Última cantidad comprada — patrón MovimientosStock (server.js:1567-1571)
```sql
SELECT mp.IdProducto, m.FechaMovimiento, mp.Cantidad
FROM MovimientosStockProductos mp
JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
WHERE mp.IdProducto IN (${inList}) AND mp.IdTipoMovimiento IN (${compraTipos})
```
`compraTipos` desde `distribucion_config.json.tiposMovimientoCompra` = `["COMPRA","COMPRA-NC"]`, citados con comillas.

### Helpers server.js (ya existen)
- `query(sql)` → `recordset` (Array). server.js:52-62. Interpola IDs directo (numéricos internos).
- `leerJSON(path, def)` / `guardarJSON(path, data)` — server.js:932-959. fs síncrono, indent 2.
- `apiRoute(fn)` — server.js:966-968. `app.get('/api/x', apiRoute(async req => objeto))`, throws → 500.
- `const DATA_DIR = path.join(__dirname, 'data')`. Patrón: `const XXX_PATH = path.join(DATA_DIR, 'archivo.json')`.
- Servir HTML: `app.get('/ruta', (_req, res) => res.sendFile(path.join(__dirname, 'x.html')))`.
- POST/DELETE escritura: handler crudo `(req, res)`, valida `if(!campo) return res.status(400)`, patrón upsert leerJSON→filter→push→guardarJSON→res.json.

### grupos_config.json (mapeo producto→granel)
Objeto `{ [nombreProducto]: true | false | { activo, granelPlu, granelDirecto?, esMiel? } }`. Cuando el valor es objeto con `granelPlu`, ese es el código PLU del granel. Fuente del vínculo granel↔fraccionado a nivel nombre de producto (informativo; el granel real de pesables sale de `calcularDistribucionPesables` fila `.granel`).

### Query granel central (reusar de pesables server.js:1685-1690)
```sql
SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
FROM ProductosDepositos pd
INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${quote(granelCodes)})
GROUP BY pd.IdProducto
```

### Config nueva (agregar a config.json)
```json
"comprasPisoCentral": { "tramos": [{ "hastaS": 20, "pct": 0.5 }, { "hastaS": null, "pct": 0.25 }], "pisoAbsoluto": 3 }
```
Usada por `faltanteReal` (piso mínimo de seguridad del depósito central).

---

## Modelo del "sugerido a comprar"

Por producto, tres señales visibles en columnas propias; `sugerido = deficitReposicion + deficitMicro + faltanteReal` (suma simple, decisión del usuario).

- **deficitReposicion** = `max(pideTotal − central, 0)` — lo que las sucursales necesitan para llegar a su nivel objetivo S y que el stock central NO alcanza a cubrir hoy.
- **deficitMicro** = `Σ_key enviarMicro[key].qty` — micro-envíos suprimidos (demanda chica insatisfecha que el motor de distribución no despacha).
- **faltanteReal** = `max(pisoMinimo(pideTotal, tramos, pisoAbsoluto) − central, 0)` — colchón de seguridad del depósito central (que no quede por debajo del piso mínimo escalonado).

Estas tres pueden solaparse parcialmente; se muestran separadas para que el usuario audite. Es la definición explícita elegida.

## Estructura de archivos

- **Crear** `compras_modulo.js` — funciones puras + `module.exports`. ~150 líneas.
- **Crear** `test/compras_modulo.test.js` — unit tests con `node:test` + `node:assert` (sin dependencias nuevas).
- **Crear** `compras_modulo.html` — frontend 5 tabs.
- **Crear** `data/presentaciones_compra.json` — `{}` inicial.
- **Modificar** `config.json` — agregar `comprasPisoCentral`.
- **Modificar** `server.js` — importar `compras_modulo` + `pisoMinimo` de distribucion; agregar rutas.
- **Modificar** `inicio.html` — enlace al módulo.
- Reutiliza (sin tocar) `data/ordenes.json` (ya `[]`), `data/grupos_config.json`, `distribucion.js`, `a8020.js`.

---

## Task 1: Módulo puro `compras_modulo.js` — fórmula del sugerido

**Files:**
- Create: `compras_modulo.js`
- Test: `test/compras_modulo.test.js`

- [ ] **Step 1: Verificar runner de tests disponible**

Run: `node --version`
Expected: v18+ (trae `node:test`). Si el repo ya tiene `test/`, respetar patrón existente; si no, usar `node:test`.

- [ ] **Step 2: Escribir test que falla — `sugeridoCompra`**

Create `test/compras_modulo.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { sugeridoCompra } = require('../compras_modulo');

test('sugeridoCompra suma las tres señales', () => {
  const r = sugeridoCompra({
    pideTotal: 50, central: 30,
    enviarMicro: { riv: { qty: 4 }, urq: { qty: 2 } },
    tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 3,
  });
  // deficitReposicion = max(50-30,0) = 20
  // deficitMicro = 4+2 = 6
  // faltanteReal = max(pisoMinimo(50,[.25],3) - 30,0) = max(round(12.5)-30,0)=max(13-30,0)=0
  assert.strictEqual(r.deficitReposicion, 20);
  assert.strictEqual(r.deficitMicro, 6);
  assert.strictEqual(r.faltanteReal, 0);
  assert.strictEqual(r.sugerido, 26);
});

test('sugeridoCompra faltanteReal cuando central bajo piso', () => {
  const r = sugeridoCompra({
    pideTotal: 100, central: 5,
    enviarMicro: {},
    tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 3,
  });
  // deficitReposicion = 95 ; deficitMicro = 0
  // faltanteReal = max(pisoMinimo(100,[.25],3) - 5,0) = max(25-5,0)=20
  assert.strictEqual(r.faltanteReal, 20);
  assert.strictEqual(r.sugerido, 115);
});

test('sugeridoCompra clampa a 0 y tolera entradas vacías', () => {
  const r = sugeridoCompra({ pideTotal: 0, central: 100, enviarMicro: {}, tramos: [], pisoAbsoluto: 0 });
  assert.strictEqual(r.sugerido, 0);
});
```

- [ ] **Step 3: Correr test para verificar que falla**

Run: `node --test test/compras_modulo.test.js`
Expected: FAIL — `Cannot find module '../compras_modulo'`.

- [ ] **Step 4: Implementar mínimo en `compras_modulo.js`**

Create `compras_modulo.js`:
```js
'use strict';
// Módulo de cálculo puro para Compras. Sin SQL ni fs — todo se inyecta por parámetros.
// Reutiliza pisoMinimo de distribucion.js (mismo piso escalonado que el racionamiento).
const { pisoMinimo } = require('./distribucion');

// sugerido = deficitReposicion + deficitMicro + faltanteReal (suma simple, ver plan)
function sugeridoCompra({ pideTotal = 0, central = 0, enviarMicro = {}, tramos = [], pisoAbsoluto = 0 }) {
  const deficitReposicion = Math.max((pideTotal || 0) - (central || 0), 0);
  const deficitMicro = Object.values(enviarMicro || {})
    .reduce((s, m) => s + (m && Number(m.qty) > 0 ? Number(m.qty) : 0), 0);
  const piso = pisoMinimo(pideTotal || 0, tramos, pisoAbsoluto);
  const faltanteReal = Math.max(piso - (central || 0), 0);
  const sugerido = deficitReposicion + deficitMicro + faltanteReal;
  return { deficitReposicion, deficitMicro, faltanteReal, sugerido };
}

module.exports = { sugeridoCompra };
```

- [ ] **Step 5: Correr test — debe pasar**

Run: `node --test test/compras_modulo.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add compras_modulo.js test/compras_modulo.test.js
git commit -m "feat(compras): módulo puro con fórmula de sugerido (3 señales)"
```

---

## Task 2: `redondearABulto` en `compras_modulo.js`

**Files:**
- Modify: `compras_modulo.js`
- Test: `test/compras_modulo.test.js`

- [ ] **Step 1: Escribir test que falla**

Append a `test/compras_modulo.test.js`:
```js
const { redondearABulto } = require('../compras_modulo');

test('redondearABulto redondea hacia arriba al múltiplo', () => {
  assert.strictEqual(redondearABulto(15, 12).cantidad, 24); // 2 bultos
  assert.strictEqual(redondearABulto(15, 12).bultos, 2);
});
test('redondearABulto múltiplo exacto no cambia', () => {
  assert.strictEqual(redondearABulto(24, 12).cantidad, 24);
  assert.strictEqual(redondearABulto(24, 12).bultos, 2);
});
test('redondearABulto sin bulto cargado devuelve la cantidad tal cual', () => {
  const r = redondearABulto(15, null);
  assert.strictEqual(r.cantidad, 15);
  assert.strictEqual(r.bultos, null);
  assert.strictEqual(r.sinBulto, true);
});
test('redondearABulto 1 unidad sobre múltiplo sube un bulto', () => {
  assert.strictEqual(redondearABulto(13, 12).cantidad, 24);
});
```

- [ ] **Step 2: Correr test — debe fallar**

Run: `node --test test/compras_modulo.test.js`
Expected: FAIL — `redondearABulto is not a function`.

- [ ] **Step 3: Implementar**

En `compras_modulo.js`, agregar antes de `module.exports`:
```js
// Redondea la cantidad al múltiplo de unidadesPorBulto (hacia arriba). Si no hay bulto cargado, pasa la cantidad tal cual.
function redondearABulto(cantidad, unidadesPorBulto) {
  const q = Math.max(0, Number(cantidad) || 0);
  const b = Number(unidadesPorBulto);
  if (!b || b <= 0) return { cantidad: q, bultos: null, sinBulto: true };
  const bultos = Math.ceil(q / b);
  return { cantidad: bultos * b, bultos, sinBulto: false };
}
```
Actualizar `module.exports`:
```js
module.exports = { sugeridoCompra, redondearABulto };
```

- [ ] **Step 4: Correr test — debe pasar**

Run: `node --test test/compras_modulo.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add compras_modulo.js test/compras_modulo.test.js
git commit -m "feat(compras): redondeo a bulto cerrado"
```

---

## Task 3: `coberturaPorProveedor` en `compras_modulo.js`

**Files:**
- Modify: `compras_modulo.js`
- Test: `test/compras_modulo.test.js`

- [ ] **Step 1: Escribir test que falla**

Append:
```js
const { coberturaPorProveedor } = require('../compras_modulo');

test('coberturaPorProveedor agrupa items por proveedor con costo y cobertura', () => {
  const items = [
    { plu: '1', cantidad: 10, proveedor: 'ACME', costoUnit: 2 },
    { plu: '2', cantidad: 5,  proveedor: 'ACME', costoUnit: 4 },
    { plu: '3', cantidad: 3,  proveedor: 'BETA', costoUnit: 10 },
    { plu: '4', cantidad: 2,  proveedor: null,   costoUnit: 0 }, // sin proveedor
  ];
  const r = coberturaPorProveedor(items);
  const acme = r.find(p => p.proveedor === 'ACME');
  assert.strictEqual(acme.itemsCubiertos, 2);
  assert.strictEqual(acme.totalItems, 4);
  assert.strictEqual(acme.costoTotal, 10*2 + 5*4); // 40
  const beta = r.find(p => p.proveedor === 'BETA');
  assert.strictEqual(beta.itemsCubiertos, 1);
  assert.strictEqual(beta.costoTotal, 30);
  // ordenado por itemsCubiertos desc
  assert.strictEqual(r[0].proveedor, 'ACME');
});
```

- [ ] **Step 2: Correr — debe fallar**

Run: `node --test test/compras_modulo.test.js`
Expected: FAIL — `coberturaPorProveedor is not a function`.

- [ ] **Step 3: Implementar**

```js
// Agrupa los items del carrito por proveedor asociado → cuántos ítems cubre cada uno y su costo total.
// totalItems = cantidad total de ítems del carrito (incluye los sin proveedor), para mostrar "X de Y".
function coberturaPorProveedor(items) {
  const lista = Array.isArray(items) ? items : [];
  const totalItems = lista.length;
  const porProv = new Map();
  for (const it of lista) {
    const prov = it.proveedor;
    if (!prov) continue;
    if (!porProv.has(prov)) porProv.set(prov, { proveedor: prov, itemsCubiertos: 0, costoTotal: 0, totalItems });
    const p = porProv.get(prov);
    p.itemsCubiertos += 1;
    p.costoTotal += (Number(it.cantidad) || 0) * (Number(it.costoUnit) || 0);
  }
  return [...porProv.values()]
    .map(p => ({ ...p, costoTotal: Math.round(p.costoTotal) }))
    .sort((a, b) => b.itemsCubiertos - a.itemsCubiertos || b.costoTotal - a.costoTotal);
}
```
Actualizar exports: `module.exports = { sugeridoCompra, redondearABulto, coberturaPorProveedor };`

- [ ] **Step 4: Correr — debe pasar**

Run: `node --test test/compras_modulo.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add compras_modulo.js test/compras_modulo.test.js
git commit -m "feat(compras): cobertura por proveedor para el carrito"
```

---

## Task 4: `construirOrden` en `compras_modulo.js`

**Files:**
- Modify: `compras_modulo.js`
- Test: `test/compras_modulo.test.js`

- [ ] **Step 1: Escribir test que falla**

Append:
```js
const { construirOrden } = require('../compras_modulo');

test('construirOrden arma la orden con total y estado GENERADA', () => {
  const orden = construirOrden({
    id: 123, fechaISO: '2026-07-10',
    proveedor: 'ACME',
    items: [
      { plu: '1', nombre: 'Prod 1', cantidad: 10, costoUnit: 2 },
      { plu: '2', nombre: 'Prod 2', cantidad: 5,  costoUnit: 4 },
    ],
  });
  assert.strictEqual(orden.id, 123);
  assert.strictEqual(orden.fecha, '2026-07-10');
  assert.strictEqual(orden.proveedor, 'ACME');
  assert.strictEqual(orden.estado, 'GENERADA');
  assert.strictEqual(orden.total, 10*2 + 5*4); // 40
  assert.strictEqual(orden.items.length, 2);
  assert.strictEqual(orden.items[0].subtotal, 20);
});
test('construirOrden lanza si no hay items', () => {
  assert.throws(() => construirOrden({ id: 1, fechaISO: '2026-07-10', proveedor: 'X', items: [] }));
});
```

- [ ] **Step 2: Correr — debe fallar**

Run: `node --test test/compras_modulo.test.js`
Expected: FAIL — `construirOrden is not a function`.

- [ ] **Step 3: Implementar**

```js
// Construye el objeto orden persistible. id y fechaISO se inyectan desde el caller (server.js) — módulo puro sin Date.now().
function construirOrden({ id, fechaISO, proveedor, items }) {
  const lista = Array.isArray(items) ? items : [];
  if (!lista.length) throw new Error('La orden no tiene items');
  if (!proveedor) throw new Error('Falta proveedor');
  const detalle = lista.map(it => {
    const cantidad = Number(it.cantidad) || 0;
    const costoUnit = Number(it.costoUnit) || 0;
    return { plu: String(it.plu), nombre: it.nombre || String(it.plu), cantidad, costoUnit, subtotal: Math.round(cantidad * costoUnit) };
  });
  const total = detalle.reduce((s, it) => s + it.subtotal, 0);
  return { id, fecha: fechaISO, proveedor, items: detalle, total, estado: 'GENERADA' };
}
```
Actualizar exports: `module.exports = { sugeridoCompra, redondearABulto, coberturaPorProveedor, construirOrden };`

- [ ] **Step 4: Correr — debe pasar**

Run: `node --test test/compras_modulo.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add compras_modulo.js test/compras_modulo.test.js
git commit -m "feat(compras): construcción de orden de pedido"
```

---

## Task 5: Config `comprasPisoCentral` + `data/presentaciones_compra.json`

**Files:**
- Modify: `config.json`
- Create: `data/presentaciones_compra.json`

- [ ] **Step 1: Agregar bloque a config.json**

Leer `config.json` y agregar la clave `comprasPisoCentral` (junto a los otros `compras*`):
```json
"comprasPisoCentral": { "tramos": [{ "hastaS": 20, "pct": 0.5 }, { "hastaS": null, "pct": 0.25 }], "pisoAbsoluto": 3 }
```
Verificar JSON válido: `node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 2: Crear archivo de presentaciones vacío**

Create `data/presentaciones_compra.json` con contenido: `{}`

- [ ] **Step 3: Commit**

```bash
git status   # revisar si data/ está en .gitignore
git add config.json
git add data/presentaciones_compra.json   # si data/ está ignorado: git add -f data/presentaciones_compra.json
git commit -m "chore(compras): config piso central + archivo presentaciones"
```
Nota: `data/` es untracked runtime; si `.gitignore` excluye `data/`, forzar con `git add -f`. Revisar `git status` antes del commit.

---

## Task 6: Backend — imports + helper de proveedor (server.js)

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Agregar imports (bloque de requires ~server.js:15-17)**

Modificar el destructuring existente de `./distribucion` para incluir `pisoMinimo`, y agregar el require del módulo:
```js
const { calcularAlmacen, pisoMinimo } = require('./distribucion');
const comprasModulo = require('./compras_modulo');
```
(Verificar primero cómo está el require actual de `./distribucion` — puede ser solo `{ calcularAlmacen }`. Agregar `pisoMinimo` a esa lista sin romper otros nombres ya importados.)

- [ ] **Step 2: Agregar constantes de path (cerca de DATA_DIR / otros *_PATH, ~server.js:932)**

```js
const PRESENTACIONES_COMPRA_PATH = path.join(DATA_DIR, 'presentaciones_compra.json');
const ORDENES_COMPRA_PATH = path.join(DATA_DIR, 'ordenes.json');
```

- [ ] **Step 3: Implementar `_provMapCompras()` (proveedor+precio+fecha+últ. cantidad por IdProducto)**

Insertar cerca de las rutas de distribución (después de `calcularDistribucionPesables`, ~server.js:1746, o cualquier punto entre server.js:970 y server.js:3080):
```js
// Mapa IdProducto(String) -> { proveedor, precio, fecha, ultimaCantidad, ultimaFecha } desde SIGA.
async function _provMapCompras() {
  const distCfg = leerJSON(DISTRIB_CONFIG_PATH, {});
  const compraTipos = (distCfg.tiposMovimientoCompra || ['COMPRA', 'COMPRA-NC']).map(t => `'${t}'`).join(',');
  const [provRows, movRows] = await Promise.all([
    query(`SELECT pp.IdProducto, pv.NombreProveedor,
                  CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
                  CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS FechaPrecio
           FROM ProductosProveedores pp
           JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
           JOIN Productos p ON p.IdProducto = pp.IdProducto
           WHERE pp.UltimoPrecioCompra > 0 AND p.Activo = 1
           ORDER BY pp.IdProducto, pp.UltimaFechaCompra DESC`),
    query(`SELECT mp.IdProducto,
                  CONVERT(varchar(10), MAX(m.FechaMovimiento), 23) AS UltimaFecha,
                  SUM(mp.Cantidad) AS CantTotal, COUNT(*) AS N
           FROM MovimientosStockProductos mp
           JOIN MovimientosStock m ON m.IdSucursal=mp.IdSucursal AND m.IdTipoMovimiento=mp.IdTipoMovimiento AND m.NumeroMovimiento=mp.NumeroMovimiento
           WHERE mp.IdTipoMovimiento IN (${compraTipos})
           GROUP BY mp.IdProducto`).catch(() => []),
  ]);
  const map = new Map();
  for (const r of provRows) {
    const id = String(r.IdProducto);
    if (!map.has(id)) map.set(id, { proveedor: r.NombreProveedor, precio: r.Precio, fecha: r.FechaPrecio, ultimaCantidad: null, ultimaFecha: null });
  }
  for (const r of movRows) {
    const id = String(r.IdProducto);
    const cant = r.N > 0 ? Math.round((r.CantTotal || 0) / r.N) : null; // promedio por movimiento de compra
    if (!map.has(id)) map.set(id, { proveedor: null, precio: null, fecha: null, ultimaCantidad: cant, ultimaFecha: r.UltimaFecha });
    else { const m = map.get(id); m.ultimaCantidad = cant; m.ultimaFecha = r.UltimaFecha; }
  }
  return map;
}
```

- [ ] **Step 4: Smoke test manual del helper**

Con el server corriendo (puerto 8081, iniciado por el usuario), agregar temporalmente:
```js
app.get('/api/compras-modulo/_provtest', apiRoute(async () => { const m = await _provMapCompras(); return { size: m.size, sample: [...m.entries()].slice(0,2) }; }));
```
Probar: `curl -s http://localhost:8081/api/compras-modulo/_provtest`
Expected: `size > 0` y sample con `{proveedor, precio, fecha}`. **Quitar la ruta temporal luego** (no commitear).

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(compras): imports + helper _provMapCompras (proveedor+precio+últ. compra desde SIGA)"
```

---

## Task 7: Backend — endpoint listado `/api/compras-modulo/listado`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Implementar `calcularListadoCompras()`**

Insertar tras `_provMapCompras()`:
```js
// Unifica productos rubro Almacen (calcularDistribucionAlmacen) + Pesables Fraccionado (calcularDistribucionPesables),
// enriquece con proveedor/costo/última compra y calcula las 3 señales de compra.
async function calcularListadoCompras() {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const pisoCfg = c.comprasPisoCentral || { tramos: [{ hastaS: null, pct: 0.25 }], pisoAbsoluto: 0 };
  const [almacen, pesables, provMap] = await Promise.all([
    calcularDistribucionAlmacen(),
    calcularDistribucionPesables().catch(() => []),
    _provMapCompras(),
  ]);
  // Stock central del granel por código (para columna granel de fraccionables)
  const granelCodes = [...new Set(pesables.map(f => f.granel).filter(g => g != null).map(String))];
  const granelMap = new Map();
  if (granelCodes.length) {
    const q = granelCodes.map(g => `'${String(g).replace(/'/g, "''")}'`).join(',');
    const rows = await query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
      FROM ProductosDepositos pd
      INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
      INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
      WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${q}) GROUP BY pd.IdProducto`).catch(() => []);
    for (const r of rows) granelMap.set(String(r.IdProducto), parseFloat(r.Stock || 0));
  }

  const filaComun = (plu, nombre, tipo, central, stkSuc, pideTotal, enviarMicro, extra) => {
    const prov = provMap.get(String(plu)) || {};
    const sig = comprasModulo.sugeridoCompra({ pideTotal, central, enviarMicro, tramos: pisoCfg.tramos, pisoAbsoluto: pisoCfg.pisoAbsoluto });
    const consolidado = (central || 0) + Object.values(stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return {
      plu: String(plu), nombre, tipo, // 'almacen' | 'fraccionable'
      central: central || 0, stkSuc: stkSuc || {}, consolidado,
      deficitReposicion: sig.deficitReposicion, deficitMicro: sig.deficitMicro, faltanteReal: sig.faltanteReal, sugerido: sig.sugerido,
      proveedor: prov.proveedor || null, costo: prov.precio || null,
      ultimaCompraFecha: prov.ultimaFecha || prov.fecha || null, ultimaCompraCantidad: prov.ultimaCantidad || null,
      ...extra,
    };
  };

  const rows = [];
  for (const f of almacen) {
    const pideTotal = Object.values(f.ideal || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    rows.push(filaComun(f.plu, f.nombre, 'almacen', f.central, f.stkSuc, pideTotal, f.enviarMicro, {
      granelCentral: null, granelPlu: null, nombreGranel: '', fraccionado: null,
    }));
  }
  for (const f of pesables) {
    const pideTotal = Object.values(f.ideal || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const fraccionado = Object.values(f.stkSuc || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const granelCentral = f.granel != null ? (granelMap.get(String(f.granel)) || 0) : null;
    // Pesables no expone central del terminado como Almacén; se usa 0 (el stock relevante es granel + sucursales).
    rows.push(filaComun(f.plu, f.nombre, 'fraccionable', 0, f.stkSuc, pideTotal, {}, {
      granelCentral, granelPlu: f.granel || null, nombreGranel: f.nombreGranel || '', fraccionado,
    }));
  }
  rows.sort((a, b) => b.sugerido - a.sugerido);
  return { productos: rows, fechaCalculo: new Date().toISOString(), total: rows.length };
}
```
**Nota:** `calcularDistribucionAlmacen` y `calcularDistribucionPesables` ya están en scope de server.js. `enviarMicro` de pesables no existe → `{}` (deficitMicro=0 para fraccionables).

- [ ] **Step 2: Agregar la ruta**

Cerca de las otras rutas de compras/distribución:
```js
app.get('/api/compras-modulo/listado', apiRoute(async () => calcularListadoCompras()));
```

- [ ] **Step 3: Smoke test manual**

Run: `curl -s http://localhost:8081/api/compras-modulo/listado | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('total',j.total);console.log(j.productos.slice(0,2));})"`
Expected: `total > 0`, filas con `sugerido`, `deficitReposicion`, `proveedor`, `central`, `stkSuc`.

- [ ] **Step 4: Commit**

```bash
git add server.js
git commit -m "feat(compras): endpoint /api/compras-modulo/listado (almacen+pesables+señales+proveedor)"
```

---

## Task 8: Backend — buscador de proveedores `/api/compras-modulo/proveedores/buscar`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Implementar ruta**

```js
// Busca proveedores por nombre parcial y devuelve los productos que maneja con último precio/fecha.
app.get('/api/compras-modulo/proveedores/buscar', apiRoute(async (req) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return { proveedores: [] };
  const like = q.replace(/'/g, "''");
  const rows = await query(`SELECT pv.NombreProveedor, pp.IdProducto, p.NombreProducto,
      CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
      CONVERT(varchar(10), pp.UltimaFechaCompra, 23) AS Fecha
    FROM ProductosProveedores pp
    JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
    JOIN Productos p ON p.IdProducto = pp.IdProducto
    WHERE pv.NombreProveedor LIKE '%${like}%' AND p.Activo = 1 AND pp.UltimoPrecioCompra > 0
    ORDER BY pv.NombreProveedor, p.NombreProducto`);
  const porProv = new Map();
  for (const r of rows) {
    const nom = r.NombreProveedor;
    if (!porProv.has(nom)) porProv.set(nom, { proveedor: nom, productos: [] });
    porProv.get(nom).productos.push({ plu: String(r.IdProducto), nombre: r.NombreProducto, precio: r.Precio, fecha: r.Fecha });
  }
  return { proveedores: [...porProv.values()].map(p => ({ ...p, cantProductos: p.productos.length })) };
}));
```

- [ ] **Step 2: Smoke test manual**

Run: `curl -s "http://localhost:8081/api/compras-modulo/proveedores/buscar?q=KIBAR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).proveedores.map(p=>[p.proveedor,p.cantProductos])))"`
Expected: array `[nombreProveedor, cantProductos]` (usar un proveedor real de `data/lead_times.json`, ej "KIBAR").

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(compras): buscador de proveedores por nombre"
```

---

## Task 9: Backend — cobertura del carrito `/api/compras-modulo/carrito/cobertura`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Implementar ruta (usa helper puro)**

```js
// Recibe { items:[{plu,cantidad,proveedor,costoUnit}] } y devuelve cobertura agrupada por proveedor.
app.post('/api/compras-modulo/carrito/cobertura', (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items debe ser array' });
  res.json({ cobertura: comprasModulo.coberturaPorProveedor(items) });
});
```

- [ ] **Step 2: Smoke test manual**

```bash
curl -s -X POST http://localhost:8081/api/compras-modulo/carrito/cobertura -H "Content-Type: application/json" -d '{"items":[{"plu":"1","cantidad":10,"proveedor":"ACME","costoUnit":2},{"plu":"2","cantidad":5,"proveedor":"ACME","costoUnit":4}]}'
```
Expected: `{"cobertura":[{"proveedor":"ACME","itemsCubiertos":2,"costoTotal":40,"totalItems":2}]}`

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(compras): cobertura del carrito por proveedor"
```

---

## Task 10: Backend — presentaciones CRUD

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Implementar rutas GET/POST/DELETE**

```js
// Presentaciones de compra: { [plu]: { unidadesPorBulto:Number, nombreBulto?:String } }
app.get('/api/compras-modulo/presentaciones', apiRoute(async () => leerJSON(PRESENTACIONES_COMPRA_PATH, {})));
app.post('/api/compras-modulo/presentaciones', (req, res) => {
  const b = req.body || {};
  const plu = String(b.plu || '').trim();
  const uxb = Number(b.unidadesPorBulto);
  if (!plu || !(uxb > 0)) return res.status(400).json({ error: 'plu y unidadesPorBulto (>0) requeridos' });
  const d = leerJSON(PRESENTACIONES_COMPRA_PATH, {});
  d[plu] = { unidadesPorBulto: uxb, nombreBulto: (b.nombreBulto || '').trim() || undefined };
  guardarJSON(PRESENTACIONES_COMPRA_PATH, d);
  res.json({ ok: true, presentaciones: d });
});
app.delete('/api/compras-modulo/presentaciones/:plu', (req, res) => {
  const d = leerJSON(PRESENTACIONES_COMPRA_PATH, {});
  delete d[String(req.params.plu)];
  guardarJSON(PRESENTACIONES_COMPRA_PATH, d);
  res.json({ ok: true, presentaciones: d });
});
```

- [ ] **Step 2: Smoke test manual**

```bash
curl -s -X POST http://localhost:8081/api/compras-modulo/presentaciones -H "Content-Type: application/json" -d '{"plu":"999","unidadesPorBulto":12,"nombreBulto":"Caja x12"}'
curl -s http://localhost:8081/api/compras-modulo/presentaciones
curl -s -X DELETE http://localhost:8081/api/compras-modulo/presentaciones/999
```
Expected: alta devuelve `{ok:true, presentaciones:{"999":{unidadesPorBulto:12,...}}}`; GET lo muestra; DELETE lo quita.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(compras): CRUD de presentaciones (bultos)"
```

---

## Task 11: Backend — consumos de producción con déficit `/api/compras-modulo/produccion-deficit`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Implementar**

Reutiliza `data/formulas.json` (`{ [idProductoPadre]: [{plu, nombre, cantPorUnidad}] }`), cruza componentes contra stock central por PLU.
```js
// Componentes de producción (formulas.json) con déficit de stock central.
async function calcularProduccionDeficit() {
  const formulas = leerJSON(path.join(DATA_DIR, 'formulas.json'), {});
  const consumoPorComp = new Map();   // plu -> { plu, nombre, consumo, usadoPor:Set }
  for (const [padre, comps] of Object.entries(formulas)) {
    for (const c of (comps || [])) {
      const plu = String(c.plu);
      if (!consumoPorComp.has(plu)) consumoPorComp.set(plu, { plu, nombre: c.nombre || plu, consumo: 0, usadoPor: new Set() });
      const rec = consumoPorComp.get(plu);
      rec.consumo += Number(c.cantPorUnidad) || 0;   // proxy: suma de coeficientes (consumo por unidad producida)
      rec.usadoPor.add(String(padre));
    }
  }
  const plus = [...consumoPorComp.keys()];
  if (!plus.length) return { componentes: [], total: 0 };
  const q = plus.map(p => `'${String(p).replace(/'/g, "''")}'`).join(',');
  const stockRows = await query(`SELECT pd.IdProducto, COALESCE(SUM(pd.Stock),0) AS Stock
    FROM ProductosDepositos pd
    INNER JOIN SucursalesDepositos sd ON pd.IdDeposito=sd.IdDeposito AND pd.IdSucursal=sd.IdSucursal
    INNER JOIN Sucursales s ON s.IdSucursal=pd.IdSucursal
    WHERE s.SoyLaCentral=1 AND pd.IdProducto IN (${q}) GROUP BY pd.IdProducto`).catch(() => []);
  const stockMap = new Map(stockRows.map(r => [String(r.IdProducto), parseFloat(r.Stock || 0)]));
  const provMap = await _provMapCompras();
  const comps = plus.map(plu => {
    const rec = consumoPorComp.get(plu);
    const stock = stockMap.get(plu) || 0;
    const deficit = Math.max(rec.consumo - stock, 0);
    const prov = provMap.get(plu) || {};
    return { plu, nombre: rec.nombre, stock, consumoProyectado: Math.round(rec.consumo * 100) / 100,
      deficit: Math.round(deficit * 100) / 100, usadoPor: [...rec.usadoPor],
      proveedor: prov.proveedor || null, costo: prov.precio || null };
  }).filter(x => x.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);
  return { componentes: comps, total: comps.length };
}
app.get('/api/compras-modulo/produccion-deficit', apiRoute(async () => calcularProduccionDeficit()));
```
**Nota:** el "consumo proyectado" v1 es un proxy simple (suma de coeficientes de receta), no demanda real. Documentado como limitación conocida.

- [ ] **Step 2: Smoke test manual**

Run: `curl -s http://localhost:8081/api/compras-modulo/produccion-deficit | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('total',j.total);console.log(j.componentes.slice(0,3));})"`
Expected: lista de componentes con `deficit > 0` (o `total: 0`).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(compras): consumos de producción con déficit de stock"
```

---

## Task 12: Backend — órdenes (crear + listar) `/api/compras-modulo/ordenes`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Implementar rutas**

```js
app.get('/api/compras-modulo/ordenes', apiRoute(async () => leerJSON(ORDENES_COMPRA_PATH, [])));
app.post('/api/compras-modulo/ordenes', (req, res) => {
  const b = req.body || {};
  try {
    const orden = comprasModulo.construirOrden({
      id: Date.now(),
      fechaISO: new Date().toISOString().slice(0, 10),
      proveedor: b.proveedor,
      items: b.items,
    });
    const arr = leerJSON(ORDENES_COMPRA_PATH, []);
    arr.push(orden);
    guardarJSON(ORDENES_COMPRA_PATH, arr);
    res.json({ ok: true, orden });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Smoke test manual**

```bash
curl -s -X POST http://localhost:8081/api/compras-modulo/ordenes -H "Content-Type: application/json" -d '{"proveedor":"ACME","items":[{"plu":"1","nombre":"Prod 1","cantidad":10,"costoUnit":2}]}'
curl -s http://localhost:8081/api/compras-modulo/ordenes
```
Expected: POST → `{ok:true, orden:{id,fecha,proveedor,total:20,estado:"GENERADA"}}`; GET lista la orden. Verificar que `data/ordenes.json` ya no es `[]`.

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(compras): crear y listar órdenes de pedido"
```

---

## Task 13: Backend — servir HTML `/compras-modulo`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Agregar la ruta HTML (junto a las otras rutas sendFile ~server.js:921-929)**

```js
app.get('/compras-modulo', (_req, res) => res.sendFile(path.join(__dirname, 'compras_modulo.html')));
```

- [ ] **Step 2: Verificar (tras crear el HTML en Task 14) que la ruta responde**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/compras-modulo`
Expected: `200` (una vez creado el HTML).

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat(compras): ruta /compras-modulo"
```

---

## Task 14: Frontend — `compras_modulo.html` (estructura + tema + tab Listado)

**Files:**
- Create: `compras_modulo.html`

- [ ] **Step 1: Crear el HTML con tema Apidelta y tab Listado funcional**

Crear `compras_modulo.html` con el contenido completo siguiente. Implementa la estructura de 5 tabs + el tab **Listado** funcional; los tabs Proveedores/Carrito/Presentaciones/Producción se completan en Tasks 15-18 (sus funciones quedan como stubs aquí).

```html
<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Compras · Apidelta</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<script>
tailwind.config = { theme: { extend: {
  colors: { verde:'#405936', verdeDark:'#2e4027', verdeHover:'#4f6e42', amarillo:'#FFCC00',
    bg:'#eef2e9', card:'#ffffff', borde:'#c3c9bc', ink:'#1a1c18',
    rojo:'#D32F2F', naranja:'#E65100', ambar:'#F57F17', ok:'#388E3C' },
  fontFamily: { disp:['"Barlow Condensed"','sans-serif'], body:['Roboto','sans-serif'] },
  boxShadow: { fluent:'0 1px 3px rgba(26,28,24,.08), 0 4px 16px rgba(26,28,24,.06)' } } } };
</script>
<style>
  body{background:#eef2e9;}
  .acrylic{background:rgba(255,255,255,.72);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}
  .tab-btn.active{background:#405936;color:#fff;}
  th{font-family:'Barlow Condensed';text-transform:uppercase;letter-spacing:.02em;}
</style>
</head>
<body class="font-body text-ink">
<header class="acrylic sticky top-0 z-20 border-b border-borde shadow-fluent">
  <div class="max-w-[1400px] mx-auto px-4 py-3 flex items-center gap-3">
    <h1 class="font-disp text-2xl font-bold text-verde">COMPRAS</h1>
    <span class="text-sm text-ink/60">Apidelta</span>
    <a href="/" class="ml-auto text-sm text-verde hover:text-verdeHover">← Inicio</a>
  </div>
  <nav class="max-w-[1400px] mx-auto px-4 pb-2 flex gap-1 flex-wrap">
    <button class="tab-btn active px-4 py-2 rounded-lg font-disp text-lg border border-borde" data-tab="listado">Listado</button>
    <button class="tab-btn px-4 py-2 rounded-lg font-disp text-lg border border-borde" data-tab="proveedores">Proveedores</button>
    <button class="tab-btn px-4 py-2 rounded-lg font-disp text-lg border border-borde" data-tab="carrito">Carrito <span id="cartBadge" class="hidden ml-1 px-2 rounded-full bg-amarillo text-ink text-xs">0</span></button>
    <button class="tab-btn px-4 py-2 rounded-lg font-disp text-lg border border-borde" data-tab="presentaciones">Presentaciones</button>
    <button class="tab-btn px-4 py-2 rounded-lg font-disp text-lg border border-borde" data-tab="produccion">Producción</button>
  </nav>
</header>
<main class="max-w-[1400px] mx-auto px-4 py-5">
  <section id="tab-listado" class="tab-panel">
    <div class="flex gap-2 mb-3 items-center flex-wrap">
      <input id="buscarListado" placeholder="Buscar producto…" class="px-3 py-2 rounded-lg border border-borde w-64">
      <label class="text-sm flex items-center gap-1"><input type="checkbox" id="soloSugerido"> Solo con sugerido &gt; 0</label>
      <span id="listadoCount" class="ml-auto text-sm text-ink/60"></span>
    </div>
    <div class="overflow-x-auto rounded-xl border border-borde shadow-fluent bg-card">
      <table class="w-full text-sm">
        <thead class="bg-verde/5 text-verde"><tr>
          <th class="text-left p-2">Producto</th><th class="p-2">Central</th><th class="p-2">Granel</th>
          <th class="p-2">Fraccionado</th><th class="p-2">Consolidado</th>
          <th class="p-2">Déf. A8020</th><th class="p-2">Micro</th><th class="p-2">Falt. real</th>
          <th class="p-2 bg-amarillo/30">Sugerido</th><th class="p-2">Proveedor</th><th class="p-2">Últ. compra</th><th class="p-2"></th>
        </tr></thead>
        <tbody id="listadoBody"></tbody>
      </table>
    </div>
  </section>
  <section id="tab-proveedores" class="tab-panel hidden"></section>
  <section id="tab-carrito" class="tab-panel hidden"></section>
  <section id="tab-presentaciones" class="tab-panel hidden"></section>
  <section id="tab-produccion" class="tab-panel hidden"></section>
</main>
<script>
const $ = s => document.querySelector(s);
const fmt = n => n == null ? '—' : (Math.round(n*100)/100).toLocaleString('es-AR');
const money = n => n == null ? '—' : '$'+Math.round(n).toLocaleString('es-AR');
const carrito = new Map();  // plu -> { plu, nombre, cantidad, proveedor, costoUnit, unidadesPorBulto }
let listadoData = [], presentaciones = {};

// ---- Tabs ----
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  $('#tab-'+btn.dataset.tab).classList.remove('hidden');
  if (btn.dataset.tab === 'carrito') renderCarrito();
  if (btn.dataset.tab === 'presentaciones') cargarPresentaciones();
  if (btn.dataset.tab === 'produccion') cargarProduccion();
}));

// ---- Listado ----
async function cargarListado() {
  const [lst, pres] = await Promise.all([
    fetch('/api/compras-modulo/listado').then(r => r.json()),
    fetch('/api/compras-modulo/presentaciones').then(r => r.json()),
  ]);
  listadoData = lst.productos || []; presentaciones = pres || {};
  renderListado();
}
function renderListado() {
  const q = $('#buscarListado').value.toLowerCase();
  const solo = $('#soloSugerido').checked;
  const rows = listadoData.filter(p =>
    (!q || p.nombre.toLowerCase().includes(q) || p.plu.includes(q)) &&
    (!solo || p.sugerido > 0));
  $('#listadoCount').textContent = rows.length + ' productos';
  $('#listadoBody').innerHTML = rows.map(p => {
    const sucDet = Object.entries(p.stkSuc || {}).map(([s,v]) => `${s}:${fmt(v)}`).join('  ');
    const sugClass = p.sugerido > 0 ? 'font-bold text-verde' : 'text-ink/40';
    return `<tr class="border-t border-borde hover:bg-verde/5">
      <td class="p-2 text-left"><button class="text-verde hover:underline" onclick="toggleSuc('${p.plu}')">${p.nombre}</button>
        <div id="suc-${p.plu}" class="hidden text-xs text-ink/60 mt-1">${sucDet||'sin desglose'}</div></td>
      <td class="p-2 text-center">${fmt(p.central)}</td>
      <td class="p-2 text-center">${p.granelCentral==null?'—':fmt(p.granelCentral)}</td>
      <td class="p-2 text-center">${p.fraccionado==null?'—':fmt(p.fraccionado)}</td>
      <td class="p-2 text-center">${fmt(p.consolidado)}</td>
      <td class="p-2 text-center">${fmt(p.deficitReposicion)}</td>
      <td class="p-2 text-center">${fmt(p.deficitMicro)}</td>
      <td class="p-2 text-center">${fmt(p.faltanteReal)}</td>
      <td class="p-2 text-center ${sugClass}">${fmt(p.sugerido)}</td>
      <td class="p-2 text-left text-xs">${p.proveedor||'—'}${p.costo?`<div class="text-ink/50">${money(p.costo)}</div>`:''}</td>
      <td class="p-2 text-center text-xs">${p.ultimaCompraFecha||'—'}${p.ultimaCompraCantidad?`<div class="text-ink/50">${fmt(p.ultimaCompraCantidad)}u</div>`:''}</td>
      <td class="p-2 text-center"><button class="px-2 py-1 rounded bg-verde text-white text-xs hover:bg-verdeHover" onclick="addCarrito('${p.plu}')">+ carrito</button></td>
    </tr>`;
  }).join('');
}
function toggleSuc(plu){ $('#suc-'+plu).classList.toggle('hidden'); }
$('#buscarListado').addEventListener('input', renderListado);
$('#soloSugerido').addEventListener('change', renderListado);

// ---- Carrito (agregar; render en Task 16) ----
function addCarrito(plu) {
  const p = listadoData.find(x => x.plu === plu); if (!p) return;
  const uxb = (presentaciones[plu]||{}).unidadesPorBulto || null;
  const base = p.sugerido > 0 ? p.sugerido : 1;
  const cantidad = uxb ? Math.ceil(base/uxb)*uxb : base;
  carrito.set(plu, { plu, nombre: p.nombre, cantidad, proveedor: p.proveedor, costoUnit: p.costo || 0, unidadesPorBulto: uxb });
  actualizarBadge();
}
function actualizarBadge(){ const b=$('#cartBadge'); b.textContent=carrito.size; b.classList.toggle('hidden', carrito.size===0); }
function renderCarrito(){ /* Task 16 */ }
function cargarPresentaciones(){ /* Task 17 */ }
function cargarProduccion(){ /* Task 18 */ }

cargarListado();
</script>
</body>
</html>
```

- [ ] **Step 2: Verificar en navegador (usuario reinicia server si hace falta)**

Abrir `http://localhost:8081/compras-modulo`. Verificar: carga el tab Listado con datos reales, filtro por texto, checkbox "solo sugerido", click en producto expande stock por sucursal, "+carrito" incrementa el badge.

- [ ] **Step 3: Commit**

```bash
git add compras_modulo.html
git commit -m "feat(compras): frontend base + tab Listado"
```

---

## Task 15: Frontend — tab Proveedores

**Files:**
- Modify: `compras_modulo.html`

- [ ] **Step 1: Reemplazar `<section id="tab-proveedores">` y agregar JS**

Reemplazar la línea `<section id="tab-proveedores" class="tab-panel hidden"></section>` por:
```html
<section id="tab-proveedores" class="tab-panel hidden">
  <div class="flex gap-2 mb-3">
    <input id="buscarProv" placeholder="Buscar proveedor (mín. 2 letras)…" class="px-3 py-2 rounded-lg border border-borde w-80">
    <button id="btnBuscarProv" class="px-4 py-2 rounded-lg bg-verde text-white hover:bg-verdeHover font-disp">Buscar</button>
  </div>
  <div id="provResultados" class="space-y-4"></div>
</section>
```
Agregar JS antes de `cargarListado();`:
```js
async function buscarProveedores() {
  const q = $('#buscarProv').value.trim();
  if (q.length < 2) { $('#provResultados').innerHTML = '<p class="text-ink/60">Escribí al menos 2 letras.</p>'; return; }
  $('#provResultados').innerHTML = '<p class="text-ink/60">Buscando…</p>';
  const r = await fetch('/api/compras-modulo/proveedores/buscar?q='+encodeURIComponent(q)).then(x=>x.json());
  if (!r.proveedores.length) { $('#provResultados').innerHTML = '<p class="text-ink/60">Sin resultados.</p>'; return; }
  $('#provResultados').innerHTML = r.proveedores.map(p => `
    <div class="rounded-xl border border-borde bg-card shadow-fluent p-4">
      <h3 class="font-disp text-xl text-verde">${p.proveedor} <span class="text-sm text-ink/50">(${p.cantProductos} productos)</span></h3>
      <div class="overflow-x-auto mt-2"><table class="w-full text-sm">
        <thead class="text-verde"><tr><th class="text-left p-1">Producto</th><th class="p-1">PLU</th><th class="p-1">Precio</th><th class="p-1">Fecha</th></tr></thead>
        <tbody>${p.productos.map(x=>`<tr class="border-t border-borde"><td class="p-1 text-left">${x.nombre}</td><td class="p-1 text-center">${x.plu}</td><td class="p-1 text-center">${money(x.precio)}</td><td class="p-1 text-center">${x.fecha||'—'}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`).join('');
}
$('#btnBuscarProv').addEventListener('click', buscarProveedores);
$('#buscarProv').addEventListener('keydown', e => { if (e.key === 'Enter') buscarProveedores(); });
```

- [ ] **Step 2: Verificar en navegador**

Tab Proveedores → buscar un proveedor real (ej "KIBAR") → card con productos, precios, fechas.

- [ ] **Step 3: Commit**

```bash
git add compras_modulo.html
git commit -m "feat(compras): tab buscador de proveedores"
```

---

## Task 16: Frontend — tab Carrito + cobertura + generar orden

**Files:**
- Modify: `compras_modulo.html`

- [ ] **Step 1: Implementar `renderCarrito()` y generación de orden**

Reemplazar el stub `function renderCarrito(){ /* Task 16 */ }` por:
```js
async function renderCarrito() {
  const panel = $('#tab-carrito');
  if (!carrito.size) { panel.innerHTML = '<p class="text-ink/60">Carrito vacío. Agregá productos desde el Listado.</p>'; return; }
  const items = [...carrito.values()];
  const filas = items.map(it => `
    <tr class="border-t border-borde">
      <td class="p-2 text-left">${it.nombre}${it.unidadesPorBulto?`<span class="ml-1 text-xs text-ok">bulto x${it.unidadesPorBulto}</span>`:`<span class="ml-1 text-xs text-naranja cursor-pointer" onclick="irPresentacion('${it.plu}')">sin bulto ⚠</span>`}</td>
      <td class="p-2 text-center"><input type="number" min="0" value="${it.cantidad}" class="w-20 border border-borde rounded px-1 text-center" onchange="setCant('${it.plu}', this.value)"></td>
      <td class="p-2 text-center text-xs">${it.proveedor||'—'}</td>
      <td class="p-2 text-center">${money(it.costoUnit)}</td>
      <td class="p-2 text-center">${money(it.cantidad*it.costoUnit)}</td>
      <td class="p-2 text-center"><button class="text-rojo" onclick="delCarrito('${it.plu}')">✕</button></td>
    </tr>`).join('');
  const total = items.reduce((s,it)=>s+it.cantidad*it.costoUnit,0);
  const cob = await fetch('/api/compras-modulo/carrito/cobertura', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})}).then(r=>r.json());
  const cobHtml = cob.cobertura.map(c => `
    <div class="rounded-lg border border-borde p-3 flex items-center gap-3">
      <div class="flex-1"><b>${c.proveedor}</b> · cubre ${c.itemsCubiertos}/${c.totalItems} ítems · ${money(c.costoTotal)}</div>
      <button class="px-3 py-1 rounded bg-verde text-white text-sm hover:bg-verdeHover" onclick="generarOrden('${c.proveedor.replace(/'/g,"\\'")}')">Generar orden</button>
    </div>`).join('');
  panel.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-borde bg-card shadow-fluent mb-4"><table class="w-full text-sm">
      <thead class="text-verde"><tr><th class="text-left p-2">Producto</th><th class="p-2">Cantidad</th><th class="p-2">Proveedor</th><th class="p-2">Costo u.</th><th class="p-2">Subtotal</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr class="border-t-2 border-verde font-bold"><td class="p-2 text-right" colspan="4">Total</td><td class="p-2 text-center">${money(total)}</td><td></td></tr></tfoot>
    </table></div>
    <h3 class="font-disp text-xl text-verde mb-2">Cobertura por proveedor</h3>
    <div class="space-y-2">${cobHtml}</div>`;
}
function setCant(plu,v){ const it=carrito.get(plu); if(it){ it.cantidad=Math.max(0,Number(v)||0); renderCarrito(); } }
function delCarrito(plu){ carrito.delete(plu); actualizarBadge(); renderCarrito(); }
function irPresentacion(plu){ document.querySelector('.tab-btn[data-tab="presentaciones"]').click(); setTimeout(()=>{ const i=$('#presPlu'); if(i){i.value=plu; i.focus();} },50); }
async function generarOrden(proveedor) {
  const items = [...carrito.values()].filter(it => it.proveedor === proveedor)
    .map(it => ({ plu: it.plu, nombre: it.nombre, cantidad: it.cantidad, costoUnit: it.costoUnit }));
  if (!items.length) return;
  const r = await fetch('/api/compras-modulo/ordenes', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({proveedor,items})}).then(x=>x.json());
  if (r.ok) { imprimirOrden(r.orden); items.forEach(it => carrito.delete(it.plu)); actualizarBadge(); renderCarrito(); }
  else alert('Error: '+(r.error||'desconocido'));
}
function imprimirOrden(orden) {
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Orden ${orden.id}</title>
    <style>body{font-family:Roboto,sans-serif;padding:24px;color:#1a1c18}h1{color:#405936;font-family:'Barlow Condensed',sans-serif}
    table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #c3c9bc;padding:6px;text-align:left}
    th{background:#eef2e9}tfoot td{font-weight:bold}@media print{button{display:none}}</style></head><body>
    <h1>ORDEN DE PEDIDO</h1>
    <p><b>Proveedor:</b> ${orden.proveedor}<br><b>Fecha:</b> ${orden.fecha}<br><b>N°:</b> ${orden.id}</p>
    <table><thead><tr><th>Producto</th><th>PLU</th><th>Cantidad</th><th>Costo u.</th><th>Subtotal</th></tr></thead>
    <tbody>${orden.items.map(it=>`<tr><td>${it.nombre}</td><td>${it.plu}</td><td>${it.cantidad}</td><td>$${it.costoUnit}</td><td>$${it.subtotal}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="4">TOTAL</td><td>$${orden.total}</td></tr></tfoot></table>
    <button onclick="window.print()" style="margin-top:16px;padding:8px 16px;background:#405936;color:#fff;border:none;border-radius:6px;cursor:pointer">Imprimir</button>
    </body></html>`);
  w.document.close();
}
```

- [ ] **Step 2: Verificar en navegador**

Agregar 2-3 productos al carrito (algunos del mismo proveedor) → tab Carrito muestra tabla editable, total, cobertura por proveedor. Editar cantidad recalcula. "Generar orden" abre ventana imprimible con totales correctos y quita esos ítems. Verificar que la orden quedó en `data/ordenes.json`.

- [ ] **Step 3: Commit**

```bash
git add compras_modulo.html
git commit -m "feat(compras): tab Carrito con cobertura, redondeo a bulto y orden imprimible"
```

---

## Task 17: Frontend — tab Presentaciones

**Files:**
- Modify: `compras_modulo.html`

- [ ] **Step 1: Implementar `cargarPresentaciones()`**

Reemplazar el stub `function cargarPresentaciones(){ /* Task 17 */ }` por:
```js
async function cargarPresentaciones() {
  const panel = $('#tab-presentaciones');
  presentaciones = await fetch('/api/compras-modulo/presentaciones').then(r=>r.json());
  const sinBulto = listadoData.filter(p => p.sugerido > 0 && !presentaciones[p.plu]);
  const cargadas = Object.entries(presentaciones);
  panel.innerHTML = `
    <div class="grid md:grid-cols-2 gap-4">
      <div class="rounded-xl border border-borde bg-card shadow-fluent p-4">
        <h3 class="font-disp text-xl text-verde mb-2">Cargar bulto</h3>
        <div class="flex flex-col gap-2">
          <input id="presPlu" placeholder="PLU" class="border border-borde rounded px-2 py-1" list="pluList">
          <datalist id="pluList">${listadoData.map(p=>`<option value="${p.plu}">${p.nombre}</option>`).join('')}</datalist>
          <input id="presUxb" type="number" min="1" placeholder="Unidades por bulto" class="border border-borde rounded px-2 py-1">
          <input id="presNombre" placeholder="Nombre bulto (opcional)" class="border border-borde rounded px-2 py-1">
          <button id="btnPres" class="px-4 py-2 rounded bg-verde text-white hover:bg-verdeHover font-disp">Guardar</button>
        </div>
        <h4 class="font-disp text-lg text-naranja mt-4 mb-1">Sin bulto (${sinBulto.length})</h4>
        <div class="text-sm max-h-40 overflow-y-auto">${sinBulto.map(p=>`<div class="flex justify-between border-b border-borde py-1"><span>${p.nombre}</span><button class="text-verde text-xs" onclick="prefillPres('${p.plu}')">cargar</button></div>`).join('')||'<span class="text-ink/50">Todos tienen bulto.</span>'}</div>
      </div>
      <div class="rounded-xl border border-borde bg-card shadow-fluent p-4">
        <h3 class="font-disp text-xl text-verde mb-2">Cargadas (${cargadas.length})</h3>
        <div class="text-sm max-h-96 overflow-y-auto">${cargadas.map(([plu,v])=>{
          const nom=(listadoData.find(p=>p.plu===plu)||{}).nombre||plu;
          return `<div class="flex justify-between items-center border-b border-borde py-1"><span>${nom} · <b>x${v.unidadesPorBulto}</b>${v.nombreBulto?` (${v.nombreBulto})`:''}</span><button class="text-rojo text-xs" onclick="delPres('${plu}')">✕</button></div>`;
        }).join('')||'<span class="text-ink/50">Ninguna.</span>'}</div>
      </div>
    </div>`;
  $('#btnPres').addEventListener('click', guardarPres);
}
function prefillPres(plu){ $('#presPlu').value=plu; $('#presUxb').focus(); }
async function guardarPres() {
  const plu=$('#presPlu').value.trim(), uxb=Number($('#presUxb').value), nombreBulto=$('#presNombre').value.trim();
  if (!plu || !(uxb>0)) { alert('PLU y unidades por bulto (>0) requeridos'); return; }
  const r = await fetch('/api/compras-modulo/presentaciones',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({plu,unidadesPorBulto:uxb,nombreBulto})}).then(x=>x.json());
  if (r.ok){ presentaciones=r.presentaciones; cargarPresentaciones(); } else alert('Error: '+(r.error||''));
}
async function delPres(plu){ const r=await fetch('/api/compras-modulo/presentaciones/'+encodeURIComponent(plu),{method:'DELETE'}).then(x=>x.json()); if(r.ok){presentaciones=r.presentaciones;cargarPresentaciones();} }
```

- [ ] **Step 2: Verificar en navegador**

Tab Presentaciones → lista "sin bulto", form de alta funciona, aparece en "Cargadas", eliminar funciona. Volver al Carrito: un producto recién cargado redondea a bulto al agregarse.

- [ ] **Step 3: Commit**

```bash
git add compras_modulo.html
git commit -m "feat(compras): tab Presentaciones (alta/baja de bultos)"
```

---

## Task 18: Frontend — tab Producción

**Files:**
- Modify: `compras_modulo.html`

- [ ] **Step 1: Implementar `cargarProduccion()`**

Reemplazar el stub `function cargarProduccion(){ /* Task 18 */ }` por:
```js
async function cargarProduccion() {
  const panel = $('#tab-produccion');
  panel.innerHTML = '<p class="text-ink/60">Cargando…</p>';
  const r = await fetch('/api/compras-modulo/produccion-deficit').then(x=>x.json());
  if (!r.componentes.length) { panel.innerHTML = '<p class="text-ok">Sin componentes en déficit. 👍</p>'; return; }
  panel.innerHTML = `
    <p class="text-sm text-ink/60 mb-2">${r.total} componentes de producción por debajo del consumo proyectado.</p>
    <div class="overflow-x-auto rounded-xl border border-borde bg-card shadow-fluent"><table class="w-full text-sm">
      <thead class="text-verde"><tr><th class="text-left p-2">Componente</th><th class="p-2">Stock central</th><th class="p-2">Consumo proy.</th><th class="p-2 bg-amarillo/30">Déficit</th><th class="p-2">Proveedor</th><th class="text-left p-2">Usado por</th></tr></thead>
      <tbody>${r.componentes.map(c=>`<tr class="border-t border-borde hover:bg-verde/5">
        <td class="p-2 text-left">${c.nombre} <span class="text-xs text-ink/40">${c.plu}</span></td>
        <td class="p-2 text-center">${fmt(c.stock)}</td><td class="p-2 text-center">${fmt(c.consumoProyectado)}</td>
        <td class="p-2 text-center font-bold text-rojo">${fmt(c.deficit)}</td>
        <td class="p-2 text-center text-xs">${c.proveedor||'—'}</td>
        <td class="p-2 text-left text-xs text-ink/60">${(c.usadoPor||[]).join(', ')}</td></tr>`).join('')}</tbody>
    </table></div>`;
}
```

- [ ] **Step 2: Verificar en navegador**

Tab Producción → tabla de componentes con déficit (o mensaje "sin déficit"). Verificar nombres, stock, déficit, proveedor.

- [ ] **Step 3: Commit**

```bash
git add compras_modulo.html
git commit -m "feat(compras): tab Producción (componentes con déficit)"
```

---

## Task 19: Enlace desde inicio + verificación integral

**Files:**
- Modify: `inicio.html`

- [ ] **Step 1: Agregar enlace en inicio.html**

Localizar el grid de módulos en `inicio.html` y agregar una tarjeta a `/compras-modulo` con el mismo patrón (icono Lucide, título "Compras", color verde). Copiar la estructura exacta de una tarjeta existente (ej la de `/compras` o `/distribucion`) cambiando href/título/icono. Si ya existe una tarjeta "/compras" (dashboard viejo), diferenciar el título (ej "Compras (nuevo)").

- [ ] **Step 2: Verificación integral en navegador (usuario)**

Recorrer los 5 tabs con datos reales en puerto 8081:
1. Listado: filtros, expandir sucursal, sugerido coherente (al menos 3 productos con distintas señales: A8020 puro, con micro, con faltante real).
2. Proveedores: búsqueda real devuelve productos.
3. Carrito: agregar, editar cantidad, redondeo a bulto en producto con presentación cargada, cobertura por proveedor, generar orden → imprimible con totales correctos → orden en `data/ordenes.json`.
4. Presentaciones: alta/baja, "sin bulto" refleja estado.
5. Producción: componentes con déficit.

- [ ] **Step 3: Correr toda la suite de tests**

Run: `node --test test/compras_modulo.test.js`
Expected: PASS (10 tests).

- [ ] **Step 4: Commit final**

```bash
git add inicio.html
git commit -m "feat(compras): enlace a módulo compras desde inicio"
```

---

## Notas de verificación / limitaciones conocidas

- **Consumo de producción v1** usa un proxy simple (suma de coeficientes de receta), no demanda real proyectada del producto padre. Mejorable en v2 cruzando con `analizarConsumoCompras()`.
- **Fraccionables (pesables)** no exponen `enviarMicro` ni stock central del terminado; su `deficitMicro`=0 y `central`=0 (el stock relevante es granel central + fraccionado en sucursales). Documentado.
- **Solapamiento de señales**: las 3 columnas del sugerido pueden solaparse; es intencional (suma simple, decisión del usuario) y auditable por columnas.
- **No reiniciar el servidor**: lo hace el usuario. Cambios de `.js`/`.html`/`.json` requieren reinicio; coordinar antes de cada verificación en navegador.
- **Seguridad SQL**: las queries interpolan IDs numéricos internos (patrón existente del repo). El único input de texto libre es `q` del buscador de proveedores, escapado con `replace(/'/g,"''")`. Mantener ese escape.
```