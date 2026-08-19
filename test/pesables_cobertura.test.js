const test = require('node:test');
const assert = require('node:assert');
const { calcularPesables } = require('../pesables');

// ── Cobertura de depósito ────────────────────────────────────────────────────────────────────
// El motor envasaba sólo contra la demanda del día (CH), así que el depósito se vaciaba en cada
// corrida y todo dependía del fraccionado. Con coberturaDeposito, D crece para dejar
// objDep = MIN(μdia · dias, techoKg) kg en central. Ver docs/pesables-calculo.html §7.

const PLU = 500;
const A8020 = { '500': { minRiv: 1, SRiv: 3, minChaca: 1, SChaca: 3, rankGeneral: 0.5 } };
const PES_LISTAS = { formulas: { '500': { granel: 9500, cantFormula: 1 } }, pesosGranel: { '9500': 10 }, fraccionadora: [] };
const DIST_LISTAS = { noEnvasa: [], restringidos: {}, importanciaMinorista: {} };

// μ = 2 kg/día → con 7 días de cobertura el objetivo son 14 kg (por debajo del techo de 50).
const COBERTURA = { dias: 7, clases: ['A'], techoKg: 50 };
const OPTS_BASE = { corregirBugs: true, presPorPlu: { '500': 0.5 }, abcPorPlu: { '500': 'A' } };

function fila(stocks, opts) {
  const filas = calcularPesables([{ plu: PLU, stocks }], A8020, PES_LISTAS, DIST_LISTAS,
    Object.assign({}, OPTS_BASE, opts));
  return filas[0];
}

// Depósito con 20 kg y sucursales vacías: alcanza para el envío de hoy (CG ≈ 8,5), así que sin
// cobertura el motor no envasa nada y el stock se va consumiendo corrida tras corrida.
const STOCK_CUBIERTO = { central: 20, granel: 40, riv: 0, chaca: 0 };

test('sin cobertura configurada el motor no envasa si el depósito cubre el envío', () => {
  const r = fila(STOCK_CUBIERTO, {});

  assert.strictEqual(r.J, 'No');
  assert.strictEqual(r.D, 0);
  assert.strictEqual(r.objDep, 0);
});

test('con cobertura de 7 días envasa para dejar el buffer en depósito', () => {
  const r = fila(STOCK_CUBIERTO, { coberturaDeposito: COBERTURA, muPorPlu: { '500': 2 } });

  assert.strictEqual(r.objDep, 14);          // 2 kg/día × 7 días
  assert.strictEqual(r.J, 'Si');
  assert.ok(r.G >= r.objDep, `G ${r.G} debería cubrir el objetivo ${r.objDep}`);
});

test('el techo limita el buffer de los PLU de mucha rotación', () => {
  const r = fila(STOCK_CUBIERTO, { coberturaDeposito: COBERTURA, muPorPlu: { '500': 30 } });

  assert.strictEqual(r.objDep, 50);          // 30 × 7 = 210 kg, recortado al techo
});

test('las clases fuera de la lista no reciben cobertura', () => {
  const r = fila(STOCK_CUBIERTO, { coberturaDeposito: COBERTURA, muPorPlu: { '500': 2 },
    abcPorPlu: { '500': 'C' } });

  assert.strictEqual(r.objDep, 0);
  assert.strictEqual(r.J, 'No');
});

test('la cobertura nunca inventa granel: D queda topeado por F', () => {
  // Sólo 3 kg de granel contra un objetivo de 14 kg.
  const r = fila({ central: 20, granel: 3, riv: 0, chaca: 0 },
    { coberturaDeposito: COBERTURA, muPorPlu: { '500': 2 } });

  assert.strictEqual(r.objDep, 14);
  assert.ok(r.D <= 3, `D ${r.D} no puede superar los 3 kg de granel`);
});

test('con el depósito ya por encima del objetivo no se envasa de nuevo', () => {
  // 30 kg en depósito: tras el envío quedan ~21,5, por encima del objetivo de 14 → no hace falta.
  const r = fila({ central: 30, granel: 40, riv: 0, chaca: 0 },
    { coberturaDeposito: COBERTURA, muPorPlu: { '500': 2 } });

  assert.strictEqual(r.J, 'No');
  assert.strictEqual(r.D, 0);
});
