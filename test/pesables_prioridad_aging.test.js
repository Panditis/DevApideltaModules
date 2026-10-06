const test = require('node:test');
const assert = require('node:assert');
const { calcularPesables, esperaNorm, ultimoFraccionadoPorPlu } = require('../lib/pesables');

// ── Aging en la prioridad de pesables ────────────────────────────────────────────────────────
// La prioridad era estática: los de baja prioridad no se fraccionaban nunca. Ahora suma
// w.espera · MIN(1, díasSinFraccionar / diasEsperaMax).

const PLU = 600;
const A8020 = { '600': { minRiv: 1, SRiv: 3, minChaca: 1, SChaca: 3, rankGeneral: 0.1 } };
const PES_LISTAS = { formulas: { '600': { granel: 9600, cantFormula: 1 } }, pesosGranel: { '9600': 10 }, fraccionadora: [] };
const DIST_LISTAS = { noEnvasa: [], restringidos: {}, importanciaMinorista: {} };
const HOY = '2026-09-30';

function fila(stocks, opts) {
  return calcularPesables([{ plu: PLU, stocks }], A8020, PES_LISTAS, DIST_LISTAS,
    Object.assign({ corregirBugs: true, hoy: HOY }, opts))[0];
}
// Con demanda: sucursales vacías y granel para fraccionar.
const CON_DEMANDA = { central: 5, granel: 40, riv: 0, chaca: 0 };
// Sin demanda: todas las sucursales por encima de S (las de min fallback también piden).
const SIN_DEMANDA = { central: 5, granel: 40, riv: 10, urq: 10, nacion: 10, chaca: 10, pergamino: 10, sanpedro: 10, ramallo: 10 };

test('esperaN crece con los días sin techo (el tope va sobre el aporte)', () => {
  assert.strictEqual(esperaNorm(0, 30, true), 0);
  assert.strictEqual(esperaNorm(15, 30, true), 0.5);
  assert.strictEqual(esperaNorm(30, 30, true), 1);
  assert.strictEqual(esperaNorm(90, 30, true), 3);
});

test('el aporte de la espera sigue subiendo después de 30 días y se topa en 0.7', () => {
  const d30 = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-08-31' } });   // 30 días → 0.2
  const d60 = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-08-01' } });   // 60 días → 0.4
  const d300 = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2025-12-04' } });  // 300 días → 2.0 → tope 0.7

  assert.ok(Math.abs((d60.prioridad - d30.prioridad) - 0.2) < 1e-9);
  assert.ok(Math.abs((d300.prioridad - d30.prioridad) - 0.5) < 1e-9);
  assert.ok(Math.abs((d300.prioridadSala - d30.prioridadSala) - 0.5) < 1e-9);
});

test('sin demanda la espera no sube, aunque nunca se haya fraccionado', () => {
  assert.strictEqual(esperaNorm(null, 30, false), 0);
  assert.strictEqual(esperaNorm(60, 30, false), 0);
});

test('sin fecha conocida y con demanda → espera máxima', () => {
  assert.strictEqual(esperaNorm(null, 30, true), 1);
});

test('la prioridad sube con los días sin fraccionar', () => {
  const reciente = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-09-29' } });
  const viejo = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-08-31' } });

  assert.strictEqual(reciente.diasSinFraccionar, 1);
  assert.strictEqual(viejo.diasSinFraccionar, 30);
  assert.strictEqual(viejo.ultimoFraccionado, '2026-08-31');
  assert.ok(Math.abs((viejo.prioridad - reciente.prioridad) - 0.2 * (29 / 30)) < 1e-9);
  assert.ok(viejo.prioridadSala > reciente.prioridadSala);
});

test('prioridadBase = prioridad sin el aporte del aging (no cambia con los días)', () => {
  const reciente = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-09-29' } });
  const viejo = fila(CON_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-08-01' } });   // 60 días → 0.4

  assert.strictEqual(viejo.prioridadBase, reciente.prioridadBase);
  assert.ok(Math.abs((viejo.prioridad - viejo.prioridadBase) - 0.4) < 1e-9);
  assert.ok(Math.abs((viejo.prioridadSala - viejo.prioridadSalaBase) - 0.4) < 1e-9);
});

test('un producto sin demanda no sube por aging', () => {
  const reciente = fila(SIN_DEMANDA, { ultimoFraccionadoPorPlu: { '600': '2026-09-29' } });
  const sinFecha = fila(SIN_DEMANDA, {});

  assert.strictEqual(sinFecha.diasSinFraccionar, null);
  assert.strictEqual(sinFecha.prioridad, reciente.prioridad);
});

test('último fraccionado = máximo entre cargas de la app y REC-SUC de Siga', () => {
  const cargas = [{ plu: 600, fecha: '2026-09-10' }, { plu: '700', fecha: '2026-09-20' }, null];
  const recSuc = [{ IdProducto: '600', Ultima: new Date('2026-09-15T00:00:00Z') },
    { IdProducto: 700, Ultima: '2026-09-01T00:00:00Z' }, { IdProducto: 800, Ultima: null }];

  assert.deepStrictEqual(ultimoFraccionadoPorPlu(cargas, recSuc), { '600': '2026-09-15', '700': '2026-09-20' });
});
