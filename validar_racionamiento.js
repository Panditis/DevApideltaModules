'use strict';
// Valida racionarPorPrioridad y pisoMinimo: cuando el central no alcanza para todas las
// sucursales, sirve por URGENCIA relativa a su S (order-up-to) — 0=llena a su objetivo,
// 1=vacía — no por pesosRacionado fijo (eso ahora solo desempata urgencias iguales). Nunca manda
// menos que el piso mínimo escalonado por S. Uso: node validar_racionamiento.js
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

// Caso 1: las 4 sucursales activas parten de stock=0 (pide=S para cada una) → urgencia=1.0 para
// las 4, EMPATE total. Se desempata por pesosRacionado (riv>chaca>nacion>sanpedro) — mismo
// resultado que daba el criterio viejo (pesosRacionado puro), porque acá no hay diferencia de
// urgencia que lo pise.
let r1 = racionarPorPrioridad(
  { riv: 10, chaca: 10, nacion: 10, sanpedro: 2 },
  { riv: 10, chaca: 10, nacion: 10, sanpedro: 2 },
  12, PESOS, ORDEN, TRAMOS, 1
);
assert.strictEqual(r1.riv, 10, 'riv (empate de urgencia, gana por pesosRacionado) recibe su pide completo');
assert.strictEqual(r1.chaca, 0, 'chaca (pide=10, piso=4) no alcanza con lo que sobra (2) — se salta');
assert.strictEqual(r1.nacion, 0, 'nacion (pide=10, piso=4) tampoco alcanza — sigue probando la cola, no corta');
assert.strictEqual(r1.sanpedro, 2, 'sanpedro (S=2, piso=1) sí alcanza con el remanente — cascada hasta el final de la cola');
assert.strictEqual(r1.urq, 0, 'sin pide (no vino en pidePorClave) — queda en 0');

// Caso 2: D no alcanza ni el piso de la única sucursal activa — no se manda nada.
let r2 = racionarPorPrioridad({ riv: 10 }, { riv: 10 }, 2, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r2.riv, 0, 'D=2 < piso de riv (4): no se asigna, se pierde este ciclo (se recalcula la próxima corrida)');

// Caso 3: D sobra para todos los que piden (ambas en stock=0, empatan en urgencia, pero D
// alcanza para las dos sin importar el orden) — cada uno recibe su pide completo.
let r3 = racionarPorPrioridad({ riv: 3, chaca: 3 }, { riv: 3, chaca: 3 }, 20, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r3.riv, 3, 'riv recibe su pide completo (D sobra)');
assert.strictEqual(r3.chaca, 3, 'chaca también (D sobra para ambos)');

// Caso 4: pide propio por debajo del piso de la sucursal, aunque el pool (restante) sí alcance —
// no debe asignarle igual, tiene que saltarla igual que si el pool no alcanzara. S=60 cae en el
// tramo catch-all (10%) → piso=6; pide=5 < 6.
let r4 = racionarPorPrioridad({ riv: 5 }, { riv: 60 }, 100, PESOS, ORDEN, TRAMOS, 1);
assert.strictEqual(r4.riv, 0, 'riv (pide=5 < piso=6 propio) no recibe, aunque el pool (100) le sobre de lejos');

// Caso 5: urgencia (relativa a S) prioriza sobre pesosRacionado. riv tiene el pesosRacionado más
// alto de la config (0.50) pero solo 60% de urgencia (stock=8 de S=20); urq tiene el
// pesosRacionado más bajo (0.08) pero 90% de urgencia (stock=1 de S=10, casi vacía). Antes de
// este cambio riv se llevaba todo (12) por ranking fijo, dejando a urq en 0 aunque estuviera casi
// sin stock; ahora gana urq por estar más urgida.
let r5 = racionarPorPrioridad(
  { riv: 12, urq: 9 },
  { riv: 20, urq: 10 },
  12, PESOS, ORDEN, TRAMOS, 1
);
assert.strictEqual(r5.urq, 9, 'urq (urgencia 0.9, pide=9, piso=4) gana la cola pese a pesosRacionado bajo (0.08)');
assert.strictEqual(r5.riv, 0, 'riv (urgencia 0.6, pesosRacionado alto) se queda sin stock — solo sobran 3, no le alcanza su piso (5)');

// ── Integración: calcularFilaAlmacen con escasez real (empate en urgencia) ─────────────────
// central=12, tres sucursales piden 10 cada una (pideTotal=30 > D=12) más San Pedro pide 2
// (S bajo) — las 4 parten de stock=0, EMPATAN en urgencia (1.0), se desempata por
// pesosRacionado. riv (prioridad 1 por peso) se lleva su pedido completo y el resto cascadea.
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

assert.strictEqual(fila.enviar.riv, 10, 'riv (empate de urgencia, gana por pesosRacionado) se lleva su pedido completo');
assert.strictEqual(fila.enviar.chaca, 0, 'chaca no alcanza su piso con lo que sobra — no fragmenta');
assert.strictEqual(fila.enviar.nacion, 0, 'nacion tampoco — sigue probando la cola');
assert.strictEqual(fila.enviar.sanPedro, 2, 'sanPedro (S bajo, piso bajo) recibe el remanente — cascada hasta el final');
assert.strictEqual(fila.pideTotal, 32, 'pideTotal sigue siendo la suma de pides crudos (10+10+10+2), sin límite de central');

// ── Integración: PLU 91298 real (urgencia distinta, caso reportado en producción) ──────────
// central=18. Reproduce el caso real reportado: hoy (antes de este fix) riv (stock=3) y nacion
// (stock=4, parcial) se llevaban casi todo mientras urq (stock=1, la más vacía de todas) quedaba
// en 0, solo por ranking fijo. Con urgencia relativa a S: urq (92% vacía) pasa a ser prioridad 1,
// sanPedro (81% vacía) segunda con el remanente — riv (80% vacía, pero pesosRacionado alto) ya
// no alcanza a que le sobre nada.
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

assert.strictEqual(fila91298.pideTotal, 73, 'pideTotal = 12+11+10+13+14+13 (riv+urq+nacion+sucursal9+pergamino+sanPedro), coincide con el valor real de producción');
assert.strictEqual(fila91298.enviar.urq, 11, 'urq (urgencia 0.9167, la más vacía) gana la cola, recibe su pedido completo');
assert.strictEqual(fila91298.enviar.sanPedro, 7, 'sanPedro (urgencia 0.8125, segunda) recibe el remanente (18-11=7) — no le alcanza para su pedido completo (13) pero supera su piso (4)');
assert.strictEqual(fila91298.enviar.riv, 0, 'riv (urgencia 0.80, tercera) ya no le alcanza nada — antes de este fix se llevaba 12 solo por ranking fijo');
assert.strictEqual(fila91298.enviar.sucursal9, 0, 'sucursal9 (urgencia 0.7647) sin stock disponible');
assert.strictEqual(fila91298.enviar.nacion, 0, 'nacion (urgencia 0.7143, la menos urgida de las 6) sin stock — antes de este fix recibía 6 parciales');

console.log('OK: pisoMinimo escala el piso según S (S alto → % bajo, S bajo → % alto), con piso absoluto de respaldo.');
console.log('OK: racionarPorPrioridad prioriza por urgencia relativa a S, pesosRacionado solo desempata empates exactos.');
console.log('OK: calcularFilaAlmacen (caso empate) sigue concentrando en la de mayor peso cuando todas están igual de urgidas.');
console.log('OK: calcularFilaAlmacen (PLU 91298 real) prioriza la sucursal más vacía relativamente, no la de mayor ranking fijo.');
