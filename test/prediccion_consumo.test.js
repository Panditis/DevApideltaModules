const test = require('node:test');
const assert = require('node:assert');
const { mesesDeVentana, diasDelMes, mesAnterior } = require('../prediccion_consumo');

test('diasDelMes contempla bisiestos', () => {
  assert.strictEqual(diasDelMes('2026-01'), 31);
  assert.strictEqual(diasDelMes('2026-02'), 28);
  assert.strictEqual(diasDelMes('2024-02'), 29);
  assert.strictEqual(diasDelMes('2026-04'), 30);
});

test('diasDelMes con mes inválido devuelve null', () => {
  assert.strictEqual(diasDelMes('no-es-mes'), null);
  assert.strictEqual(diasDelMes(null), null);
});

test('mesAnterior retrocede y cruza el año', () => {
  assert.strictEqual(mesAnterior('2026-08', 1), '2026-07');
  assert.strictEqual(mesAnterior('2026-01', 1), '2025-12');
  assert.strictEqual(mesAnterior('2026-08', 12), '2025-08');
});

test('mesesDeVentana lista los N meses cerrados, sin el mes en curso', () => {
  // El mes en curso está incompleto: incluirlo aplasta el promedio justo en el dato que más pesa.
  assert.deepStrictEqual(mesesDeVentana('2026-08', 3), ['2026-05', '2026-06', '2026-07']);
});

test('mesesDeVentana devuelve orden cronológico ascendente', () => {
  const r = mesesDeVentana('2026-03', 4);
  assert.deepStrictEqual(r, ['2025-11', '2025-12', '2026-01', '2026-02']);
});

const { demandaDiaria, PESOS_RECIENCIA } = require('../prediccion_consumo');

test('PESOS_RECIENCIA da más peso a los meses recientes', () => {
  assert.deepStrictEqual(PESOS_RECIENCIA, { reciente: 3, medio: 2, viejo: 1 });
});

test('demandaDiaria con consumo constante da el promedio plano', () => {
  // 10 unidades por día en cada mes, con la cantidad de días que tenga cada uno
  const meses = ['2026-05', '2026-06', '2026-07'];
  const serie = {};
  for (const m of meses) serie[m] = 10 * diasDelMes(m);
  const r = demandaDiaria(serie, meses);
  assert.strictEqual(r.mu, 10);
  assert.strictEqual(r.sigma, 0);
});

test('demandaDiaria pondera: una subida reciente levanta el promedio', () => {
  // 6 meses: los 3 de atrás a 10/día, los 3 recientes a 20/día.
  // En una ventana de 6, los 3 de atrás caen en el tramo "medio" (peso 2), no en
  // "viejo" (peso 1): ese tramo recién empieza en el séptimo mes hacia atrás.
  // Ponderado = (3·20·3 + 2·10·3) / (3·3 + 2·3) = (180+60)/15 = 16
  const meses = ['2026-02','2026-03','2026-04','2026-05','2026-06','2026-07'];
  const serie = {};
  meses.forEach((m, i) => { serie[m] = (i >= 3 ? 20 : 10) * diasDelMes(m); });
  const r = demandaDiaria(serie, meses);
  assert.strictEqual(r.mu, 16);
  assert.ok(r.mu > 15, 'el promedio plano daría 15; la ponderación tiene que superarlo');
});

test('demandaDiaria calcula sigma sobre la dispersión mensual', () => {
  const meses = ['2026-06', '2026-07'];
  const serie = { '2026-06': 0, '2026-07': 31 * 20 };   // 0/día y 20/día
  const r = demandaDiaria(serie, meses);
  assert.ok(r.sigma > 0, 'con meses dispares sigma no puede ser cero');
});

test('demandaDiaria con meses faltantes los cuenta como cero', () => {
  const r = demandaDiaria({ '2026-07': 310 }, ['2026-06', '2026-07']);
  assert.ok(r.mu > 0 && r.mu < 10, 'el mes ausente arrastra el promedio hacia abajo');
});

test('demandaDiaria sin meses devuelve ceros', () => {
  assert.deepStrictEqual(demandaDiaria({}, []), { mu: 0, sigma: 0 });
  assert.deepStrictEqual(demandaDiaria(null, null), { mu: 0, sigma: 0 });
});

const { factorEstacional, ESTACIONAL_MIN, ESTACIONAL_MAX } = require('../prediccion_consumo');

// Serie con pico de diciembre, todos los años. Arranca en 2024-07 y no en 2025-01
// porque la ventana del factor son los 12 meses móviles que terminan en el mes
// homólogo: para junio 2026 el homólogo es junio 2025, y ahí atrás hay medio 2024.
const serie2025 = (() => {
  const s = {};
  for (let m = 7; m <= 12; m++) s[`2024-${String(m).padStart(2,'0')}`] = 100;
  for (let m = 1; m <= 12; m++) s[`2025-${String(m).padStart(2,'0')}`] = 100;
  s['2024-12'] = 200;
  s['2025-12'] = 200;
  return s;
})();

test('factorEstacional compara el mes homólogo contra el promedio del año', () => {
  // diciembre 2025 = 200 vs promedio 108,33 → ~1,846
  const f = factorEstacional(serie2025, '2026-12');
  assert.ok(f > 1.8 && f < 1.9, `esperaba ~1,85 y dio ${f}`);
});

test('factorEstacional da cerca de 1 en un mes normal', () => {
  const f = factorEstacional(serie2025, '2026-06');
  assert.ok(f > 0.9 && f < 1.0);
});

test('factorEstacional se acota en ambos extremos', () => {
  const pico = {};
  for (let m = 7; m <= 12; m++) pico[`2024-${String(m).padStart(2,'0')}`] = 1;
  for (let m = 1; m <= 12; m++) pico[`2025-${String(m).padStart(2,'0')}`] = 1;
  pico['2025-06'] = 10000;
  assert.strictEqual(factorEstacional(pico, '2026-06'), ESTACIONAL_MAX);
  const hueco = {};
  for (let m = 7; m <= 12; m++) hueco[`2024-${String(m).padStart(2,'0')}`] = 100;
  for (let m = 1; m <= 12; m++) hueco[`2025-${String(m).padStart(2,'0')}`] = 100;
  hueco['2025-06'] = 0;
  assert.strictEqual(factorEstacional(hueco, '2026-06'), ESTACIONAL_MIN);
});

test('factorEstacional es 1 sin 12 meses de historia', () => {
  assert.strictEqual(factorEstacional({ '2025-12': 200 }, '2026-12'), 1);
  assert.strictEqual(factorEstacional({}, '2026-12'), 1);
  assert.strictEqual(factorEstacional(null, '2026-12'), 1);
});

test('factorEstacional es 1 si el año homólogo no tuvo consumo', () => {
  const cero = {};
  for (let m = 7; m <= 12; m++) cero[`2024-${String(m).padStart(2,'0')}`] = 0;
  for (let m = 1; m <= 12; m++) cero[`2025-${String(m).padStart(2,'0')}`] = 0;
  assert.strictEqual(factorEstacional(cero, '2026-06'), 1);
});
