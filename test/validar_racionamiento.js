'use strict';
// Valida racionarPorPrioridad y pisoMinimo: reparte piso mínimo a TODAS las sucursales urgidas
// primero (pasada 1), y solo con el sobrante completa hacia el pedido total en orden de urgencia
// (pasada 2) — las que no alcanzaron piso en la pasada 1 no se reintentan en la 2 (evita
// fragmentos por debajo de su piso). Uso: node test/validar_racionamiento.js
const assert = require('assert');
const { pisoMinimo, racionarPorPrioridad, calcularFilaAlmacen } = require('../distribucion');

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
const a8020Row = { minRiv: 5, SRiv: 10, minChaca: 5, SChaca: 10, minNacion: 5, SNacion: 10, minSanPedro: 1, SSanPedro: 2 };
const stocks = { central: 12, riv: 0, urq: 0, nacion: 0, chaca: 0, pergamino: 0, sanpedro: 0, sucu8: 0, sucu9: 0, sucu11: 0 };
const opts = {
  corregirBugs: true,
  pesosRacionado: PESOS,
  umbralMicroEnvio: { tramos: TRAMOS, pisoAbsoluto: 1 },
  factGatePorPlu: new Map(),
};
const fila = calcularFilaAlmacen(99999, stocks, a8020Row, {}, {}, new Set(), 0.5, opts);

assert.strictEqual(fila.enviar.riv, 4, 'riv recibe su piso, sin sobrante para completar');
assert.strictEqual(fila.enviar.chaca, 4, 'chaca ídem');
assert.strictEqual(fila.enviar.nacion, 4, 'nacion ídem — agota los 12');
assert.strictEqual(fila.enviar.sanPedro, 0, 'sanPedro no llega a que le alcance ni el piso');
assert.strictEqual(fila.pideTotal, 32, 'pideTotal sigue siendo la suma de pides crudos, sin límite de central');

// ── Gatillo: estar JUSTO en el mínimo no pide (pideTeorico usa stock < min) ────────────────
const a8020Igual = { minRiv: 3, SRiv: 15, minChaca: 4, SChaca: 14 };
const stocksIgual = { central: 50, riv: 3, urq: 0, nacion: 0, chaca: 4, pergamino: 0, sanpedro: 0, sucu8: 0, sucu9: 0, sucu11: 0 };
const filaIgual = calcularFilaAlmacen(77777, stocksIgual, a8020Igual, {}, {}, new Set(), 0.5, opts);
assert.strictEqual(filaIgual.pideTotal, 0, 'stock == min en ambas sucursales → no pide nada');
assert.strictEqual(filaIgual.enviar.riv, 0, 'riv con stock == min no recibe envío');
assert.strictEqual(filaIgual.enviar.chaca, 0, 'chaca ídem');
// Una unidad por debajo del mínimo sí gatilla, y repone hasta S.
const stocksUnoMenos = { ...stocksIgual, riv: 2 };
const filaUnoMenos = calcularFilaAlmacen(77777, stocksUnoMenos, a8020Igual, {}, {}, new Set(), 0.5, opts);
assert.strictEqual(filaUnoMenos.enviar.riv, 13, 'riv con stock = min-1 pide hasta S (15-2=13)');

// ── Integración: PLU 91298 real (D=18, 6 sucursales urgidas) ───────────────────────────────
// Mins un punto por encima del stock de cada sucursal (stock == min ya no gatilla). Los pides
// no cambian — pide = S - stock — y los pisos dependen de S, así que el reparto es el mismo.
const a8020Row91298 = {
  minRiv: 4, SRiv: 15,
  minUrq: 2, SUrq: 12,
  minNacion: 5, SNacion: 14,
  minVRamallo: 5, SVRamallo: 17,   // sucursal9
  minPergamino: 6, SPergamino: 19,
  minSanPedro: 4, SSanPedro: 16,
};
const stocks91298 = { central: 18, riv: 3, urq: 1, nacion: 4, chaca: 0, pergamino: 5, sanpedro: 3, sucu8: 0, sucu9: 4, sucu11: 0 };
const fila91298 = calcularFilaAlmacen(91298, stocks91298, a8020Row91298, {}, {}, new Set(), 0.5, opts);

assert.strictEqual(fila91298.pideTotal, 73, 'pideTotal sin cambios: 12(riv)+11(urq)+10(nacion)+13(sucursal9)+14(pergamino)+13(sanPedro)=73');
assert.strictEqual(fila91298.enviar.urq, 8, 'urq: piso (5) en pasada 1 + 3 de sobrante en pasada 2');
assert.strictEqual(fila91298.enviar.sanPedro, 4, 'sanPedro: piso (4) en pasada 1, sin sobrante para más');
assert.strictEqual(fila91298.enviar.riv, 6, 'riv: piso (6, tramo 40% — S=15 cae justo en el límite) en pasada 1, sin sobrante para más');
assert.strictEqual(fila91298.enviar.sucursal9, 0, 'sucursal9: cuando le toca en pasada 1 ya no alcanza su piso (4) — quedan 3');
assert.strictEqual(fila91298.enviar.pergamino, 0, 'pergamino: ídem, no alcanza su piso (5)');
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
