# Piso primero + sobrante por urgencia — racionamiento Almacén Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `racionarPorPrioridad` reparte piso mínimo a todas las sucursales urgidas primero, y solo después vuelca el sobrante hacia las más urgidas — en vez de dar el pedido completo a la primera hasta agotar el pool.

**Architecture:** Reemplaza el loop único de `racionarPorPrioridad` por dos pasadas sobre la misma cola de urgencia. Sin cambios de firma, sin cambios en `pisoMinimo` ni en la rama `D > pideTotal`.

**Tech Stack:** Node.js (CommonJS), validación manual vía `node validar_racionamiento.js`.

Spec: `docs/superpowers/specs/2026-07-13-piso-primero-sobrante-racionamiento-design.md`

---

## Task 1: Dos pasadas — piso a todas, sobrante por urgencia

**Files:**
- Modify: `distribucion.js:83-91` (cuerpo del loop en `racionarPorPrioridad`)
- Modify: `validar_racionamiento.js` (reescritura completa — recalcula TODOS los fixtures existentes bajo el algoritmo nuevo, no son iguales a los actuales)

- [ ] **Step 1: Reescribir `validar_racionamiento.js` completo (test que falla)**

Reemplazar el contenido completo del archivo por:

```javascript
'use strict';
// Valida racionarPorPrioridad y pisoMinimo: reparte piso mínimo a TODAS las sucursales urgidas
// primero (pasada 1), y solo con el sobrante completa hacia el pedido total en orden de urgencia
// (pasada 2) — las que no alcanzaron piso en la pasada 1 no se reintentan en la 2 (evita
// fragmentos por debajo de su piso). Uso: node validar_racionamiento.js
const assert = require('assert');
const { pisoMinimo, racionarPorPrioridad, calcularFilaAlmacen } = require('./distribucion');

const TRAMOS = [{ hastaS: 5, pct: 0.60 }, { hastaS: 15, pct: 0.40 }, { hastaS: 40, pct: 0.25 }, { hastaS: null, pct: 0.10 }];

// ── pisoMinimo ───────────────────────────────────────────────────────────────
assert.strictEqual(pisoMinimo(2, TRAMOS, 1), 1, 'S=2 (tramo 60%): round(1.2)=1, coincide con piso absoluto');
assert.strictEqual(pisoMinimo(10, TRAMOS, 1), 4, 'S=10 (tramo 40%): round(4)=4');
assert.strictEqual(pisoMinimo(30, TRAMOS, 1), 8, 'S=30 (tramo 25%): round(7.5)=8 (medio afuera del cero)');
assert.strictEqual(pisoMinimo(100, TRAMOS, 1), 10, 'S=100 (catch-all 10%): round(10)=10 — no espera acumular de más');
assert.strictEqual(pisoMinimo(0, TRAMOS, 1), 1, 'S=0: pct*0=0, pero pisoAbsoluto=1 manda');

// ── racionarPorPrioridad ────────────────────────────────────────────────────
const PESOS = { riv: 0.50, chaca: 0.20, nacion: 0.12, urq: 0.08, pergamino: 0.06, sucu9: 0.03, sanpedro: 0.01, sucu8: 0, sucu11: 0 };
const ORDEN = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanpedro', 'sucu8', 'sucu9', 'sucu11'];

// Caso 1: 4 sucursales empatan en urgencia (todas parten de stock=0, pide=S). Pasada 1 reparte
// piso (4,4,4) a riv/chaca/nacion en orden de pesosRacionado hasta agotar D=12; sanpedro (piso=1)
// no llega a que le alcance. Pasada 2 no tiene restante para completar a nadie.
let r1 = racionarPorPrioridad(
  { riv: 10, chaca: 10, nacion: 10, sanpedro: 2 },
  { riv: 10, chaca: 10, nacion: 10, sanpedro: 2 },
  12, PESOS, ORDEN, TRAMOS, 1
);
assert.strictEqual(r1.riv, 4, 'riv recibe su piso (4) en la pasada 1, sin sobrante para completar en la 2');
assert.strictEqual(r1.chaca, 4, 'chaca ídem — pasada 1 reparte piso a todas antes de completar a nadie');
assert.strictEqual(r1.nacion, 4, 'nacion ídem — agota el pool (4+4+4=12)');
assert.strictEqual(r1.sanpedro, 0, 'sanpedro: cuando le toca en la pasada 1 ya no queda ni para su piso (1)');
assert.strictEqual(r1.urq, 0, 'sin pide — queda en 0');

// Caso 2: D no alcanza ni el piso de la única sucursal activa — no se manda nada.
let r2 = racionarPorPrioridad({ riv: 10 }, { riv: 10 }, 2, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r2.riv, 0, 'D=2 < piso de riv (4): no se asigna ni en pasada 1 ni en la 2');

// Caso 3: D sobra de lejos para las dos — pasada 1 da el piso a cada una, pasada 2 completa a
// ambas hasta su pedido total.
let r3 = racionarPorPrioridad({ riv: 3, chaca: 3 }, { riv: 3, chaca: 3 }, 20, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r3.riv, 3, 'riv: piso (2) en pasada 1 + completa a su pedido (3) en pasada 2 — D sobra');
assert.strictEqual(r3.chaca, 3, 'chaca ídem');

// Caso 4: pide propio por debajo del piso — no entra ni a la pasada 1.
let r4 = racionarPorPrioridad({ riv: 5 }, { riv: 60 }, 100, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r4.riv, 0, 'riv (pide=5 < piso=6 propio) no recibe, aunque D sobre de lejos');

// Caso 5: urgencia prioriza sobre pesosRacionado, y con piso-primero AMBAS reciben algo (antes de
// este cambio urq se llevaba todo, riv quedaba en 0). urq (urgencia 0.9, piso=4) recibe su piso
// en pasada 1 y se completa parcial en pasada 2; riv (urgencia 0.6, piso=5) también recibe su
// piso en pasada 1 con lo que queda.
let r5 = racionarPorPrioridad(
  { riv: 12, urq: 9 },
  { riv: 20, urq: 10 },
  12, PESOS, ORDEN, TRAMOS, 1
);
assert.strictEqual(r5.urq, 7, 'urq: piso (4) en pasada 1 + 3 de sobrante en pasada 2 (restante tras riv)');
assert.strictEqual(r5.riv, 5, 'riv: piso (5) en pasada 1 — no queda sobrante para completarla en pasada 2');

// ── Integración: calcularFilaAlmacen con escasez real (empate en urgencia) ─────────────────
// central=12, tres sucursales piden 10 c/u + sanPedro pide 2 (S bajo) — mismo fixture que Caso 1
// pero pasando por calcularFilaAlmacen completo.
const a8020Row = { minRiv: 5, SRiv: 10, minChaca: 5, SChaca: 10, minNacion: 5, SNacion: 10, minSanPedro: 1, SSanPedro: 2 };
const stocks = { central: 12, riv: 0, urq: 0, nacion: 0, chaca: 0, pergamino: 0, sanpedro: 0, sucu8: 0, sucu9: 0, sucu11: 0 };
const opts = {
  corregirBugs: true,
  pesosRacionado: PESOS,
  umbralMicroEnvio: { tramos: TRAMOS, pisoAbsoluto: 1 },
  esNuevoSet: new Set(),
  factGatePorPlu: new Map(),
};
const fila = calcularFilaAlmacen(99999, stocks, a8020Row, {}, {}, new Set(), 0.5, opts);

assert.strictEqual(fila.enviar.riv, 4, 'riv recibe su piso, sin sobrante para completar');
assert.strictEqual(fila.enviar.chaca, 4, 'chaca ídem');
assert.strictEqual(fila.enviar.nacion, 4, 'nacion ídem — agota los 12');
assert.strictEqual(fila.enviar.sanPedro, 0, 'sanPedro no llega a que le alcance ni el piso');
assert.strictEqual(fila.pideTotal, 32, 'pideTotal sigue siendo la suma de pides crudos, sin límite de central');

// ── Integración: PLU 91298 real (D=18, 6 sucursales urgidas) ───────────────────────────────
const a8020Row91298 = {
  minRiv: 3, SRiv: 15,
  minUrq: 1, SUrq: 12,
  minNacion: 4, SNacion: 14,
  minVRamallo: 4, SVRamallo: 17,   // sucursal9
  minPergamino: 5, SPergamino: 19,
  minSanPedro: 3, SSanPedro: 16,
};
const stocks91298 = { central: 18, riv: 3, urq: 1, nacion: 4, chaca: 0, pergamino: 5, sanpedro: 3, sucu8: 0, sucu9: 4, sucu11: 0 };
const fila91298 = calcularFilaAlmacen(91298, stocks91298, a8020Row91298, {}, {}, new Set(), 0.5, opts);

assert.strictEqual(fila91298.pideTotal, 73, 'pideTotal sin cambios: 12(riv)+11(urq)+10(nacion)+13(sucursal9)+14(pergamino)+13(sanPedro)=73');
assert.strictEqual(fila91298.enviar.urq, 6, 'urq: piso (5) en pasada 1 + 1 de sobrante en pasada 2');
assert.strictEqual(fila91298.enviar.sanPedro, 4, 'sanPedro: piso (4) en pasada 1, sin sobrante para más');
assert.strictEqual(fila91298.enviar.riv, 4, 'riv: piso (4) en pasada 1, sin sobrante para más');
assert.strictEqual(fila91298.enviar.sucursal9, 4, 'sucursal9: piso (4) en pasada 1, agota los 18 (5+4+4+4=17, sobra 1 que va entero a urq)');
assert.strictEqual(fila91298.enviar.pergamino, 0, 'pergamino: cuando le toca en pasada 1 ya no alcanza su piso (5)');
assert.strictEqual(fila91298.enviar.nacion, 0, 'nacion: ídem, no alcanza su piso (6)');

// ── Integración: PLU 90259 real (D=99, 7 sucursales — caso que motivó este cambio) ─────────
const a8020Row90259 = {
  minRiv: 22, SRiv: 43,
  minUrq: 20, SUrq: 40,
  minNacion: 21, SNacion: 41,
  minChaca: 25, SChaca: 50,
  minPergamino: 16, SPergamino: 31,
  minSanPedro: 39, SSanPedro: 78,
  minVRamallo: 15, SVRamallo: 29,   // sucursal9
};
const stocks90259 = { central: 99, riv: -3, urq: 10, nacion: 5, chaca: 7, pergamino: 9, sanpedro: 4, sucu8: 0, sucu9: 10, sucu11: 0 };
const fila90259 = calcularFilaAlmacen(90259, stocks90259, a8020Row90259, {}, {}, new Set(), 0.5, opts);

assert.strictEqual(fila90259.enviar.riv, 46, 'riv: piso (4) en pasada 1 + 42 de sobrante en pasada 2 — pedido completo (stock negativo, la más urgida)');
assert.strictEqual(fila90259.enviar.sanPedro, 19, 'sanPedro: piso (8) en pasada 1 + 11 de sobrante en pasada 2 — no llega a su pedido completo (74)');
assert.strictEqual(fila90259.enviar.nacion, 4, 'nacion: piso (4) en pasada 1, sin sobrante para más');
assert.strictEqual(fila90259.enviar.chaca, 5, 'chaca: piso (5) en pasada 1, sin sobrante para más');
assert.strictEqual(fila90259.enviar.urq, 10, 'urq: piso (10) en pasada 1, sin sobrante para más');
assert.strictEqual(fila90259.enviar.pergamino, 8, 'pergamino: piso (8) en pasada 1, sin sobrante para más');
assert.strictEqual(fila90259.enviar.sucursal9, 7, 'sucursal9: piso (7) en pasada 1, sin sobrante para más — agota los 99 (4+8+4+5+10+8+7=46 en pasada 1, +42+11 en pasada 2=99)');

console.log('OK: pisoMinimo escala el piso según S (S alto → % bajo, S bajo → % alto), con piso absoluto de respaldo.');
console.log('OK: racionarPorPrioridad reparte piso a todas primero, sobrante por urgencia después — no gana-todo-la-primera.');
console.log('OK: calcularFilaAlmacen (empate) reparte piso entre las 3 primeras hasta agotar D, no concentra en una sola.');
console.log('OK: calcularFilaAlmacen (PLU 91298) reparte piso a 4 de 6 sucursales urgidas, no solo a la top.');
console.log('OK: calcularFilaAlmacen (PLU 90259, caso real que motivó el cambio) reparte a las 7 sucursales, ninguna en 0.');
```

- [ ] **Step 2: Correr y confirmar que falla**

Run: `node validar_racionamiento.js`
Expected: `AssertionError` en el primer assert de `r1` (`r1.riv` da `10`, no `4`, con el algoritmo de 1 sola pasada actual).

- [ ] **Step 3: Implementar las 2 pasadas en `racionarPorPrioridad`**

En `distribucion.js`, reemplazar (líneas ~83-91, el loop dentro de `racionarPorPrioridad` — buscar por texto exacto, no por número de línea a ciegas):

```javascript
  for (const k of orden) {
    const pide = pidePorClave[k] || 0;
    if (pide <= 0) continue;
    const piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto);
    if (pide < piso || restante < piso) continue;
    const asignado = round(Math.min(pide, restante), 0);
    racionPorClave[k] = asignado;
    restante -= asignado;
  }
```

Por:

```javascript
  // Pasada 1: piso mínimo a cada sucursal activa que el pool alcance a cubrir, en orden de
  // urgencia. Si D es "importante" (alcanza para el piso de varias), reparte primero un mínimo
  // viable a todas antes de concentrar en la más urgida. Si no alcanza ni para el piso de una,
  // se la salta (no corta, prueba la siguiente).
  for (const k of orden) {
    const pide = pidePorClave[k] || 0;
    if (pide <= 0) continue;
    const piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto);
    if (pide < piso || restante < piso) continue;
    racionPorClave[k] = piso;
    restante -= piso;
  }
  // Pasada 2: con lo que sobra, completa hacia el pedido total — SOLO a las que ya limpiaron su
  // piso en la pasada 1. Las que quedaron en 0 no se reintentan acá: con lo poco que sobre al
  // final podría tocarles menos que su piso, y ese es justo el problema que esta función existe
  // para evitar.
  for (const k of orden) {
    if (racionPorClave[k] <= 0 || restante <= 0) continue;
    const pide = pidePorClave[k] || 0;
    const falta = pide - racionPorClave[k];
    if (falta <= 0) continue;
    const dar = round(Math.min(falta, restante), 0);
    racionPorClave[k] += dar;
    restante -= dar;
  }
```

Actualizar también el comentario arriba de la función (líneas 60-69) — reemplazar la frase "Cada sucursal recibe su pedido completo o nada" por algo que refleje las 2 pasadas (ej: "Primero reparte el piso mínimo a todas las urgidas que el pool alcance, después vuelca el sobrante hacia las más urgidas hasta agotar D o los pedidos").

- [ ] **Step 4: Correr y confirmar que pasa**

Run: `node validar_racionamiento.js`
Expected: imprime los 5 `OK:` finales, exit 0.

- [ ] **Step 5: Regresión — `validar_almacen.js`**

Run: `node validar_almacen.js`
Expected: `mins` sigue en el rango ~13600-14000 (pre-existente, no relacionado). `enviar` va a moverse bastante más que en el cambio anterior (este es un cambio de algoritmo más profundo, no solo de criterio de orden) — no hay número esperado, pero confirmar que ninguna fila queda con TODAS las sucursales en 0 cuando `pideTotal>0` y `central>0` (sería señal de un bug, no de reparto más parejo).

## Notas para quien ejecute

- **No commitear.** `distribucion.js` sigue con WIP ajeno sin relación (rewrite de "importancia real", `a.rankRiv`/`a.rankGeneral`) sin commitear en el working tree — no tocar. Terminar en el Step 5 y parar ahí; el controller hace el `git add -p`/commit para separar el trabajo del WIP ajeno.
- Solo Almacén — no tocar `pesables.js`.
