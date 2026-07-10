# Piso mínimo con cola de prioridad fija — racionamiento Almacén Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando el stock central no alcanza para cubrir el pedido de todas las sucursales, dejar de prorratear proporcional (fragmenta en 1-5 unidades no viables logísticamente) y en su lugar servir en orden fijo de prioridad — cada sucursal recibe su pedido completo o nada, nunca menos que un piso mínimo escalonado según su propio nivel objetivo (S).

**Architecture:** Dos funciones puras nuevas en `distribucion.js` (`pisoMinimo`, `racionarPorPrioridad`) reemplazan el bloque de prorrateo proporcional (waterfall + reparto de resto) dentro de `calcularFilaAlmacen`. La función de piso de micro-envío existente (`piso()`, usada para UI y para el gate de importancia) pasa a compartir el mismo cálculo de piso, en vez de tener su propio umbral inline. Cambio de config: `umbralMicroEnvio` pasa de número plano a `{tramos, pisoAbsoluto}`.

**Tech Stack:** Node.js (CommonJS), sin framework de test — validación manual vía scripts `node validar_*.js` (patrón ya usado en el repo).

Spec: `docs/superpowers/specs/2026-07-10-racionamiento-piso-minimo-almacen-design.md`

---

## Task 1: `pisoMinimo` — piso mínimo escalonado por S

**Files:**
- Modify: `distribucion.js:47-48` (nueva función, entre `minConPiso` y el comentario de `calcularFilaAlmacen`)
- Modify: `distribucion.js:349` (`module.exports`)
- Create: `validar_racionamiento.js`

- [ ] **Step 1: Escribir el test que falla**

Crear `validar_racionamiento.js`:

```javascript
'use strict';
// Valida racionarPorPrioridad y pisoMinimo: cuando el central no alcanza para todas las
// sucursales, sirve en orden fijo (opts.pesosRacionado como ranking) y nunca manda menos que el
// piso mínimo escalonado por S — en vez de prorratear en fracciones de 1-5 unidades no viables
// logísticamente. Uso: node validar_racionamiento.js
const assert = require('assert');
const { pisoMinimo, racionarPorPrioridad, calcularFilaAlmacen } = require('./distribucion');

const TRAMOS = [{ hastaS: 5, pct: 0.60 }, { hastaS: 15, pct: 0.40 }, { hastaS: 40, pct: 0.25 }, { hastaS: null, pct: 0.10 }];

// ── pisoMinimo ───────────────────────────────────────────────────────────────
assert.strictEqual(pisoMinimo(2, TRAMOS, 1), 1, 'S=2 (tramo 60%): round(1.2)=1, coincide con piso absoluto');
assert.strictEqual(pisoMinimo(10, TRAMOS, 1), 4, 'S=10 (tramo 40%): round(4)=4');
assert.strictEqual(pisoMinimo(30, TRAMOS, 1), 8, 'S=30 (tramo 25%): round(7.5)=8 (medio afuera del cero)');
assert.strictEqual(pisoMinimo(100, TRAMOS, 1), 10, 'S=100 (catch-all 10%): round(10)=10 — no espera acumular de más');
assert.strictEqual(pisoMinimo(0, TRAMOS, 1), 1, 'S=0: pct*0=0, pero pisoAbsoluto=1 manda');

console.log('OK: pisoMinimo escala el piso según S (S alto → % bajo, S bajo → % alto), con piso absoluto de respaldo.');
```

- [ ] **Step 2: Correr y confirmar que falla**

Run: `node validar_racionamiento.js`
Expected: `TypeError: pisoMinimo is not a function` (todavía no existe en `distribucion.js`).

- [ ] **Step 3: Implementar `pisoMinimo`**

En `distribucion.js`, reemplazar (líneas 44-48):

```javascript
// Min con piso: flag ProductosAlmacen>0 ⇒ 0; sino MAX(minA8020, piso)
function minConPiso(flag, minA8020, piso) {
  return flag > 0 ? 0 : Math.max(minA8020 || 0, piso);
}

```

Por:

```javascript
// Min con piso: flag ProductosAlmacen>0 ⇒ 0; sino MAX(minA8020, piso)
function minConPiso(flag, minA8020, piso) {
  return flag > 0 ? 0 : Math.max(minA8020 || 0, piso);
}

// Piso mínimo de envío: por debajo de esto no vale la pena mandar (abrir cajas, parada de
// transporte extra por 1-2 unidades). Escala con S de la sucursal para ese PLU: S alto usa % más
// bajo (no exige acumular demasiado para gatillar), S bajo usa % más alto (una unidad suelta sigue
// sin ser viable aunque sea "20% de casi nada"). tramos: [{hastaS, pct}], ordenado asc, hastaS=null
// es el catch-all final.
function pisoMinimo(S, tramos, pisoAbsoluto) {
  const s = S || 0;
  const tramo = (tramos || []).find(t => t.hastaS == null || s <= t.hastaS) || { pct: 0 };
  return Math.max(pisoAbsoluto || 0, round(s * (tramo.pct || 0), 0));
}

```

- [ ] **Step 4: Exportar `pisoMinimo`**

En `distribucion.js:349`, reemplazar:

```javascript
module.exports = { calcularAlmacen, calcularFilaAlmacen, SUCURSALES_SALIDA, round, roundup };
```

Por:

```javascript
module.exports = { calcularAlmacen, calcularFilaAlmacen, SUCURSALES_SALIDA, round, roundup, pisoMinimo, racionarPorPrioridad };
```

(`racionarPorPrioridad` se agrega en la Tarea 2 — exportarla ya ahora evita un segundo cambio a esta línea.)

- [ ] **Step 5: Correr y confirmar que pasa**

Run: `node validar_racionamiento.js`
Expected: imprime `OK: pisoMinimo escala el piso según S...` y termina sin error (exit 0). `racionarPorPrioridad` todavía no está definida — si el require la desestructura pero no se usa en este punto del script, no rompe nada.

- [ ] **Step 6: Commit**

```bash
git add distribucion.js validar_racionamiento.js
git commit -m "feat: piso mínimo escalonado por S para racionamiento Almacén"
```

---

## Task 2: `racionarPorPrioridad` — cola de prioridad fija

**Files:**
- Modify: `distribucion.js` (nueva función, justo después de `pisoMinimo`)
- Modify: `validar_racionamiento.js`

- [ ] **Step 1: Extender el test que falla**

Agregar al final de `validar_racionamiento.js` (antes del último `console.log`, que se mueve al final del archivo):

```javascript

// ── racionarPorPrioridad ────────────────────────────────────────────────────
const PESOS = { riv: 0.50, chaca: 0.20, nacion: 0.12, urq: 0.08, pergamino: 0.06, sucu9: 0.03, sanpedro: 0.01, sucu8: 0, sucu11: 0 };
const ORDEN = ['riv', 'urq', 'nacion', 'chaca', 'pergamino', 'sanpedro', 'sucu8', 'sucu9', 'sucu11'];

// Caso 1: alcanza para el primero en prioridad completo; lo que sobra prueba con el resto de la
// cola según SU piso propio — una sucursal de menor prioridad pero S bajo (piso chico) puede
// terminar recibiendo aunque una de mayor prioridad (S más alto, piso más alto) se quede en 0.
let r1 = racionarPorPrioridad(
  { riv: 10, chaca: 10, nacion: 10, sanpedro: 2 },
  { riv: 10, chaca: 10, nacion: 10, sanpedro: 2 },
  12, PESOS, ORDEN, TRAMOS, 1
);
assert.strictEqual(r1.riv, 10, 'riv (prioridad 1, pide=10, piso=4) recibe su pide completo');
assert.strictEqual(r1.chaca, 0, 'chaca (pide=10, piso=4) no alcanza con lo que sobra (2) — se salta');
assert.strictEqual(r1.nacion, 0, 'nacion (pide=10, piso=4) tampoco alcanza — sigue probando la cola, no corta');
assert.strictEqual(r1.sanpedro, 2, 'sanpedro (S=2, piso=1) sí alcanza con el remanente — cascada hasta el final de la cola');
assert.strictEqual(r1.urq, 0, 'sin pide (no vino en pidePorClave) — queda en 0');

// Caso 2: D no alcanza ni el piso de la primera en prioridad — no se manda nada (mejor eso que
// fragmentar).
let r2 = racionarPorPrioridad({ riv: 10 }, { riv: 10 }, 2, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r2.riv, 0, 'D=2 < piso de riv (4): no se asigna, se pierde este ciclo (se recalcula la próxima corrida)');

// Caso 3: D sobra para todos los que piden — cada uno recibe su pide completo (mismo resultado
// que la rama D>pideTotal de calcularFilaAlmacen, pero ejercitando la función en aislado).
let r3 = racionarPorPrioridad({ riv: 3, chaca: 3 }, { riv: 3, chaca: 3 }, 20, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r3.riv, 3, 'riv recibe su pide completo (D sobra)');
assert.strictEqual(r3.chaca, 3, 'chaca también (D sobra para ambos)');

console.log('OK: racionarPorPrioridad sirve en orden fijo, completo o nada por sucursal, cascada hasta agotar D o la cola.');
```

- [ ] **Step 2: Correr y confirmar que falla**

Run: `node validar_racionamiento.js`
Expected: `TypeError: racionarPorPrioridad is not a function`.

- [ ] **Step 3: Implementar `racionarPorPrioridad`**

En `distribucion.js`, justo después del cierre de `pisoMinimo` (agregado en la Tarea 1), agregar:

```javascript

// Reparte D entre sucursales activas (pide>0) en orden fijo de prioridad (pesosRacionado usado
// como ranking, no como %): cada una recibe su pedido completo o nada — nunca una fracción por
// debajo de su piso mínimo. Si no alcanza el piso de una, prueba la siguiente en la cola (no
// corta el recorrido) para no desperdiciar stock que sí le alcanzaría a una sucursal más chica
// más abajo en el orden.
function racionarPorPrioridad(pidePorClave, sPorClave, D, pesosRacionado, ordenClaves, tramos, pisoAbsoluto) {
  const orden = [...ordenClaves].sort((a, b) => (pesosRacionado[b] || 0) - (pesosRacionado[a] || 0));
  const racionPorClave = {};
  for (const k of ordenClaves) racionPorClave[k] = 0;
  let restante = Math.max(D, 0);
  for (const k of orden) {
    const pide = pidePorClave[k] || 0;
    if (pide <= 0) continue;
    const piso = pisoMinimo(sPorClave[k], tramos, pisoAbsoluto);
    if (restante < piso) continue;
    const asignado = round(Math.min(pide, restante), 0);
    racionPorClave[k] = asignado;
    restante -= asignado;
  }
  return racionPorClave;
}
```

- [ ] **Step 4: Correr y confirmar que pasa**

Run: `node validar_racionamiento.js`
Expected: imprime ambos `OK:` (pisoMinimo y racionarPorPrioridad) y termina sin error.

- [ ] **Step 5: Commit**

```bash
git add distribucion.js validar_racionamiento.js
git commit -m "feat: racionarPorPrioridad — cola de prioridad fija con piso mínimo"
```

---

## Task 3: Wiring — reemplazar el prorrateo proporcional en `calcularFilaAlmacen`

**Files:**
- Modify: `distribucion.js:120-124` (comentario)
- Modify: `distribucion.js:149-194` (bloque de racionamiento)
- Modify: `distribucion.js:230-244` (`piso()`)
- Modify: `validar_racionamiento.js`

- [ ] **Step 1: Extender el test que falla — fixture de integración**

Agregar al final de `validar_racionamiento.js` (antes del último `console.log`):

```javascript

// ── Integración: calcularFilaAlmacen con escasez real ──────────────────────
// central=12, tres sucursales piden 10 cada una (pideTotal=30 > D=12) más San Pedro pide 2
// (S bajo). Reproduce el bug reportado: hoy esto fragmenta ~4 unidades a cada una; con la cola
// de prioridad, riv (prioridad 1) se lleva su pedido completo y el resto cascadea.
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

assert.strictEqual(fila.enviar.riv, 10, 'riv (prioridad 1) se lleva su pedido completo');
assert.strictEqual(fila.enviar.chaca, 0, 'chaca no alcanza su piso con lo que sobra — no fragmenta');
assert.strictEqual(fila.enviar.nacion, 0, 'nacion tampoco — sigue probando la cola');
assert.strictEqual(fila.enviar.sanPedro, 2, 'sanPedro (S bajo, piso bajo) recibe el remanente — cascada hasta el final');
assert.strictEqual(fila.pideTotal, 32, 'pideTotal sigue siendo la suma de pides crudos (10+10+10+2), sin límite de central');

console.log('OK: calcularFilaAlmacen concentra en las sucursales de mayor prioridad en vez de fragmentar 1-5 unidades a todas.');
```

- [ ] **Step 2: Correr y confirmar que falla**

Run: `node validar_racionamiento.js`
Expected: `AssertionError` en el primer `assert.strictEqual(fila.enviar.riv, 10, ...)` — con el prorrateo proporcional viejo, `riv` recibe una fracción (~4-5), no 10.

- [ ] **Step 3: Reemplazar el comentario de racionamiento**

En `distribucion.js`, reemplazar (líneas 120-124):

```javascript
  // Racionamiento por prioridad (porcentaje con waterfall): cuando el stock central no
  // alcanza para todos, se reparte según el peso de cada sucursal; si a alguna le sobra
  // porque cubre el 100% de su pedido con su cuota, el excedente se redistribuye entre
  // el resto según sus pesos (no se pierde stock). Pesos configurables vía
  // opts.pesosRacionado.
```

Por:

```javascript
  // Racionamiento por prioridad fija: cuando el stock central no alcanza para todos, NO se
  // prorratea proporcional (fragmenta en pedazos chicos no viables logísticamente). Se sirve
  // en orden fijo de opts.pesosRacionado (usado como ranking, no como %): cada sucursal recibe
  // su pedido completo o nada — nunca menos que su piso mínimo (opts.umbralMicroEnvio, escalado
  // por el S de esa sucursal). Si una no alcanza su piso, se prueba la siguiente en la cola (no
  // corta) para no desperdiciar stock que sí le alcanza a una más chica más abajo.
```

(Las líneas siguientes, 125-128, sobre exclusión de sucursales Fact/Restringido del pool, quedan igual — el `GATEADO` no cambia.)

- [ ] **Step 4: Reemplazar el bloque de cálculo de `racionPorClave`**

En `distribucion.js`, reemplazar (líneas 149-194, desde `const minPorClave` hasta `const racion = ...`):

```javascript
  const minPorClave = { riv: minRiv, urq: minUrq, nacion: minNacion, chaca: minChaca, pergamino: minPergamino, sanpedro: minSanPedro, sucu8: minSucu8, sucu9: minSucu9, sucu11: minSucu11 };
  const stockPorClave = { riv: st.riv||0, urq: st.urq||0, nacion: st.nacion||0, chaca: st.chaca||0, pergamino: st.pergamino||0, sanpedro: st.sanpedro||0, sucu8: st.sucu8||0, sucu9: st.sucu9||0, sucu11: st.sucu11||0 };
  // Urgencia de stock (0=cómoda, 1=en/bajo mínimo) manda sobre la prioridad fija de
  // sucursal: una diferencia de urgencia de 0.1 ya pesa más que toda la escala de
  // importancia (máx 0.5) — la importancia solo desempata entre urgencias parecidas.
  const pesoEfectivo = (k) => {
    const min = minPorClave[k];
    const urgencia = min > 0 ? Math.max(0, 1 - stockPorClave[k] / min) : (stockPorClave[k] <= 0 ? 1 : 0);
    return urgencia * 10 + (pesosRacionado[k] || 0);
  };
  const racionPorClave = {};
  if (D > pideTotal) {
    for (const k of ORDEN_CLAVES) racionPorClave[k] = pidePorClave[k] || 0;
  } else {
    const asignCrudo = {}; for (const k of ORDEN_CLAVES) asignCrudo[k] = 0;
    let activos = new Set(ORDEN_CLAVES.filter(k => (pidePorClave[k] || 0) > 0));
    let restante = Math.max(D, 0);
    let guard = 0;
    while (restante > 1e-9 && activos.size && guard++ < ORDEN_CLAVES.length + 1) {
      const sumaPesos = [...activos].reduce((s, k) => s + pesoEfectivo(k), 0);
      if (sumaPesos <= 0) break;
      let sobra = 0;
      for (const k of [...activos]) {
        const cuota = restante * (pesoEfectivo(k) / sumaPesos);
        const falta = (pidePorClave[k] || 0) - asignCrudo[k];
        if (cuota >= falta) { asignCrudo[k] += falta; sobra += cuota - falta; activos.delete(k); }
        else { asignCrudo[k] += cuota; }
      }
      restante = sobra;
    }
    // Redondeo con reparto de resto (largest remainder): si cada sucursal se redondea
    // independiente, la suma final puede no dar D exacto (queda remanente sin repartir).
    // Se redondea todo hacia abajo y las unidades sobrantes van a quienes tengan mayor
    // parte fraccionaria, hasta agotar el stock racionado.
    const enteros = {}; let sumaEnteros = 0;
    for (const k of ORDEN_CLAVES) { enteros[k] = Math.floor(asignCrudo[k]); sumaEnteros += enteros[k]; }
    let sobranteEntero = Math.round(Math.min(D, pideTotal)) - sumaEnteros;
    const porFraccion = ORDEN_CLAVES.filter(k => asignCrudo[k] > 0)
      .sort((a, b) => (asignCrudo[b] - enteros[b]) - (asignCrudo[a] - enteros[a]));
    for (const k of porFraccion) {
      if (sobranteEntero <= 0) break;
      enteros[k] += 1; sobranteEntero -= 1;
    }
    for (const k of ORDEN_CLAVES) racionPorClave[k] = enteros[k];
  }
  const racion = (key) => racionPorClave[key];
```

Por:

```javascript
  const sPorClave = { riv: sRiv, urq: sUrq, nacion: sNac, chaca: sCha, pergamino: sPer, sanpedro: sSan, sucu8: sSu8, sucu9: sSu9, sucu11: sS11 };
  const umbralCfg = (opts && opts.umbralMicroEnvio) || {};
  const tramosMicro = umbralCfg.tramos || [{ hastaS: null, pct: 0.20 }];
  const pisoAbsolutoMicro = umbralCfg.pisoAbsoluto != null ? umbralCfg.pisoAbsoluto : 1;
  const racionPorClave = D > pideTotal
    ? Object.fromEntries(ORDEN_CLAVES.map(k => [k, pidePorClave[k] || 0]))
    : racionarPorPrioridad(pidePorClave, sPorClave, D, pesosRacionado, ORDEN_CLAVES, tramosMicro, pisoAbsolutoMicro);
  const racion = (key) => racionPorClave[key];
```

- [ ] **Step 5: Actualizar `piso()` para reusar el piso compartido**

En `distribucion.js`, reemplazar (líneas 230-244):

```javascript
  // Piso de micro-envío: descarta envío calculado < umbral% del S de esa sucursal (opts.umbralMicroEnvio),
  // salvo que supere UMBRAL_UNIDADES_MICRO unidades (ahí se considera envío normal, no Micro).
  // Aplica siempre, sin importar el stock propio de la sucursal (no vale la pena logísticamente igual).
  // Sí afecta a importancia (usa eXxxM post-piso) — un envío Micro no debe impulsar la importancia del producto.
  // enviarMicro guarda {qty,umbral,S,min} de las sucursales suprimidas (pre-piso), para mostrar en UI.
  const umbralMicro = (opts && opts.umbralMicroEnvio) || 0;
  const UMBRAL_UNIDADES_MICRO = 6;   // envío >= este valor nunca es Micro, aunque no llegue al % del umbral
  const enviarMicro = {};
  const piso = (valor, S, min, key) => {
    if (!isNum(valor) || valor <= 0 || umbralMicro <= 0) return valor;
    if (valor >= UMBRAL_UNIDADES_MICRO) return valor;   // 6 o más unidades → envío normal, no Micro
    const umbralAbs = round(Math.max(umbralMicro * (S || 0), 1), 0);   // piso = umbral·S redondeado, mínimo absoluto 1
    if (valor < umbralAbs) { enviarMicro[key] = { qty: valor, umbral: umbralAbs, S, min }; return 'Micro'; }   // valor >= umbralAbs para enviar
    return valor;
  };
```

Por:

```javascript
  // Piso mínimo de envío: descarta envío calculado < pisoMinimo(S) escalonado
  // (opts.umbralMicroEnvio.tramos) — mismo piso que ya usó racionarPorPrioridad arriba para decidir
  // quién entra a la cola. Se reaplica acá porque D > pideTotal no pasa por esa función (cada
  // sucursal recibe su pide crudo, que igual puede ser chico sin que haya escasez de por medio).
  // Sí afecta a importancia (usa eXxxM post-piso) — un envío Micro no debe impulsar la importancia
  // del producto. enviarMicro guarda {qty,umbral,S,min} de las suprimidas (pre-piso), para la UI.
  const enviarMicro = {};
  const piso = (valor, S, min, key) => {
    if (!isNum(valor) || valor <= 0) return valor;
    const umbralAbs = pisoMinimo(S, tramosMicro, pisoAbsolutoMicro);
    if (valor < umbralAbs) { enviarMicro[key] = { qty: valor, umbral: umbralAbs, S, min }; return 'Micro'; }
    return valor;
  };
```

- [ ] **Step 6: Correr y confirmar que pasa**

Run: `node validar_racionamiento.js`
Expected: imprime los tres `OK:` (pisoMinimo, racionarPorPrioridad, calcularFilaAlmacen) y termina sin error.

- [ ] **Step 7: Regresión — correr las validaciones existentes**

Run: `node validar_almacen.js`
Expected: en modo `PARIDAD (corregirBugs=false)`, revisar `mis.enviar` — si aparecen mismatches nuevos, deben ser **solo** en `enviar` (nunca en `mins` ni en `importancia` más allá de lo ya documentado) y solo para PLUs donde el golden tenía `central < pideTotal` (escasez real). Eso es la divergencia intencional de este cambio (la planilla vieja prorrateaba, el motor ahora concentra) — no un bug. Si hay mismatches en `mins` o en filas sin escasez, hay un error en el wiring — revisar antes de continuar.

Run: `node validar_ranking.js`
Expected: sin cambios, ambos `OK:` (no toca nada de A8020/ranking).

- [ ] **Step 8: Commit**

```bash
git add distribucion.js validar_racionamiento.js
git commit -m "fix: racionamiento Almacén concentra por prioridad fija en vez de fragmentar"
```

---

## Task 4: Config — nueva forma de `umbralMicroEnvio`

**Files:**
- Modify: `data/distribucion_config.json:24`
- Modify: `server.js:1548`

- [ ] **Step 1: Actualizar el config**

En `data/distribucion_config.json`, reemplazar (línea 24):

```json
  "umbralMicroEnvio": 0.20,
```

Por:

```json
  "umbralMicroEnvio": { "tramos": [ { "hastaS": 5, "pct": 0.60 }, { "hastaS": 15, "pct": 0.40 }, { "hastaS": 40, "pct": 0.25 }, { "hastaS": null, "pct": 0.10 } ], "pisoAbsoluto": 1 },
```

- [ ] **Step 2: Actualizar el default en `server.js`**

En `server.js:1548`, reemplazar:

```javascript
  const umbralMicroEnvio = distCfg.umbralMicroEnvio || 0;
```

Por:

```javascript
  const umbralMicroEnvio = distCfg.umbralMicroEnvio || { tramos: [{ hastaS: null, pct: 0.20 }], pisoAbsoluto: 1 };
```

(Paridad con el comportamiento viejo si `distribucion_config.json` no tuviera la clave — no debería pasar tras el Step 1, pero evita un `NaN` silencioso si alguien la borra a mano.)

- [ ] **Step 3: Verificar que no quedan lecturas del shape viejo**

Run: `grep -n "umbralMicroEnvio" server.js distribucion.js`
Expected: todas las ocurrencias leen/pasan el objeto (`.tramos`, `.pisoAbsoluto`) — ninguna lo trata como número plano (`umbralMicro * S`, `umbralMicroEnvio || 0` seguido de multiplicación directa).

- [ ] **Step 4: Commit**

```bash
git add data/distribucion_config.json server.js
git commit -m "config: umbralMicroEnvio escalonado por S en vez de % fijo"
```

---

## Task 5: Verificación end-to-end contra datos reales

**Files:** ninguno (solo verificación manual, no hay entorno de staging con DB de prueba)

- [ ] **Step 1: Confirmar que el server dev está corriendo**

El usuario ya tiene su propio flujo para levantar el server (puerto 8081 dev). No reiniciar el servidor — pedirle al usuario que confirme que está arriba, o pegarle directo si ya lo está.

- [ ] **Step 2: Pegarle al endpoint real**

Run: `curl -s http://localhost:8081/api/distribucion/almacen | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const frag=d.filter(f=>Object.values(f.enviar).filter(v=>typeof v==='number'&&v>0).length>=3); console.log('Filas con envío a 3+ sucursales:', frag.length); console.log(frag.slice(0,5).map(f=>({plu:f.plu, enviar:f.enviar})));"`
Expected: el conteo de filas con envío fragmentado a 3+ sucursales simultáneas baja considerablemente vs. antes del cambio (no hay baseline numérico exacto sin correrlo antes — comparar contra la sensación reportada por el usuario: "casi todo lo escaso salía fragmentado").

- [ ] **Step 3: Revisar visualmente en `distribucion.html`**

Abrir `/distribucion` en el browser, tab Almacén, ordenar por `pideTotal` desc (los productos con más demanda total son los más propensos a escasez) y confirmar a ojo: los que antes mostraban 1-2-1-1 unidades por sucursal ahora muestran un número grande en una sucursal y 0/"Micro" en el resto, o "Micro" en todas si ni la prioridad #1 alcanza su piso.

- [ ] **Step 4: Ajustar tramos si hace falta**

Si los pisos resultan muy altos (deja demasiado stock sin usar) o muy bajos (siguen viéndose envíos chicos), ajustar los `pct`/`hastaS` en `data/distribucion_config.json` — no requiere tocar código, solo el config (Task 4, Step 1). Confirmar con el usuario antes de recalibrar en producción.

---

## Notas para quien ejecute

- El spec (`Componente 1`) describía `ordenPrioridad` como función separada. Acá queda plegada
  dentro de `racionarPorPrioridad` (un `.sort()` inline) — mismo comportamiento, una función menos
  que mantener/testear por separado. Si hace falta reusar el orden solo (sin racionar), extraerla
  en ese momento, no antes.
- No tocar `pesables.js` — quedó fuera de alcance (mecanismo de racionamiento distinto, confirmado con el usuario).
- `pesoEfectivo`, `minPorClave`, `stockPorClave` se eliminan enteros en la Tarea 3 — no quedan usados en ningún otro punto de `calcularFilaAlmacen` (verificado por grep antes de escribir este plan).
- El campo `ideal` (línea ~321, pedido teórico sin límite de central) no cambia — sigue siendo `pRiv`/`pUrq`/etc. crudos, no pasa por `racionarPorPrioridad`.
- `enviarMicro` (para UI) sigue teniendo la misma forma `{qty, umbral, S, min}` — no rompe nada del lado de `distribucion.html` que ya lo consuma.
