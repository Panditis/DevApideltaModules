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

console.log('OK: pisoMinimo escala el piso según S (S alto → % bajo, S bajo → % alto), con piso absoluto de respaldo.');
console.log('OK: racionarPorPrioridad sirve en orden fijo, completo o nada por sucursal, cascada hasta agotar D o la cola.');
