const test = require('node:test');
const assert = require('node:assert');
const { puntajePrioridad } = require('../lib/plan_prioridad');
test('puntajePrioridad: Σx²/Σx, ignora no numéricos y negativos, 0 sin ventas', () => {
  assert.strictEqual(puntajePrioridad([100, 10, 10]), 85);
  assert.strictEqual(puntajePrioridad([50]), 50);
  assert.strictEqual(puntajePrioridad([]), 0);
  assert.strictEqual(puntajePrioridad([0, 0]), 0);
  assert.strictEqual(puntajePrioridad([10, null, 'x', -5, 10]), 10);
  assert.strictEqual(puntajePrioridad([1, 2]), 1.67);
});

const { clasesABC, nivelUrgencia, compararUrgencia } = require('../lib/plan_prioridad');

test('clasesABC: Pareto 80/15/5 sobre el puntaje, el que cruza el 80% queda en A', () => {
  assert.deepStrictEqual(clasesABC([80, 15, 5]), ['A', 'B', 'C']);
  assert.deepStrictEqual(clasesABC([5, 80, 15]), ['C', 'A', 'B']);          // respeta el orden de entrada
  assert.deepStrictEqual(clasesABC([50, 40, 6, 4]), ['A', 'A', 'B', 'C']);   // 50 → 90%: el 2º cruza el 80% y es A
  assert.deepStrictEqual(clasesABC([100]), ['A']);
});

test('clasesABC: puntaje 0, inválido o negativo es C; sin puntaje total todo es C; vacío', () => {
  assert.deepStrictEqual(clasesABC([0, 0]), ['C', 'C']);
  assert.deepStrictEqual(clasesABC([90, 0, null, 'x', -3, 10]), ['A', 'C', 'C', 'C', 'C', 'B']);
  assert.deepStrictEqual(clasesABC([]), []);
  assert.deepStrictEqual(clasesABC(undefined), []);
});

test('clasesABC: los empates comparten clase aunque crucen un corte', () => {
  assert.deepStrictEqual(clasesABC([1, 1, 1, 1, 1]), ['A', 'A', 'A', 'A', 'A']);
  assert.deepStrictEqual(clasesABC([60, 10, 10, 10, 10]), ['A', 'A', 'A', 'A', 'A']);   // el bloque empatado arranca en 60% (< 80%): va entero a A
  assert.deepStrictEqual(clasesABC([85, 5, 5, 5]), ['A', 'B', 'B', 'B']);             // el bloque arranca en 85%: entero a B aunque cruce el 95%
});

test('nivelUrgencia: < umbral URGENTE, < 2×umbral PRONTO, si no OK; umbral por clase', () => {
  const u = { A: 7, B: 5, C: 3 };
  assert.strictEqual(nivelUrgencia(6.9, 'A', u), 'URGENTE');
  assert.strictEqual(nivelUrgencia(7, 'A', u), 'PRONTO');
  assert.strictEqual(nivelUrgencia(13.9, 'A', u), 'PRONTO');
  assert.strictEqual(nivelUrgencia(14, 'A', u), 'OK');
  assert.strictEqual(nivelUrgencia(4, 'B', u), 'URGENTE');
  assert.strictEqual(nivelUrgencia(4, 'C', u), 'PRONTO');
  assert.strictEqual(nivelUrgencia(0, 'C', u), 'URGENTE');
  assert.strictEqual(nivelUrgencia(-2, 'C', u), 'URGENTE');      // stock negativo en SiGA
});

test('nivelUrgencia: sin cobertura (sin ventas) es OK; umbrales faltantes o inválidos caen al default 7/5/3', () => {
  assert.strictEqual(nivelUrgencia(null, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(undefined, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(Infinity, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(NaN, 'A'), 'OK');
  assert.strictEqual(nivelUrgencia(6, 'A'), 'URGENTE');
  assert.strictEqual(nivelUrgencia(6, 'A', { A: 'x' }), 'URGENTE');
  assert.strictEqual(nivelUrgencia(6, 'A', { A: 10 }), 'URGENTE');
  assert.strictEqual(nivelUrgencia(6, 'B', { A: 10 }), 'PRONTO');      // B sin configurar → default 5
  assert.strictEqual(nivelUrgencia(4, 'Z'), 'PRONTO');                 // clase desconocida se trata como C
});

test('compararUrgencia: urgencia (URGENTE > PRONTO > OK), después rankingPos; sin rankingPos, más facturación primero', () => {
  const g = (urgencia, rankingPos, facturacionMensual) => ({ urgencia, rankingPos, facturacionMensual });
  const orden = lista => [...lista].sort(compararUrgencia).map(x => `${x.urgencia}${x.rankingPos ?? '-'}`);
  assert.deepStrictEqual(
    orden([g('OK', 1), g('PRONTO', 5), g('URGENTE', 9), g('URGENTE', 2), g('PRONTO', 3)]),
    ['URGENTE2', 'URGENTE9', 'PRONTO3', 'PRONTO5', 'OK1']);
  assert.deepStrictEqual(orden([g('OK', undefined), g('OK', 4), g('OK', 2)]), ['OK2', 'OK4', 'OK-']);
  const pres = [g('PRONTO', undefined, 10), g('PRONTO', undefined, 500), g('URGENTE', undefined, 1)];
  assert.deepStrictEqual([...pres].sort(compararUrgencia).map(p => p.facturacionMensual), [1, 500, 10]);
  assert.strictEqual(compararUrgencia(g('OK', 3), g('OK', 3)), 0);
});

const { calcularCobertura } = require('../lib/plan_prioridad');

test('calcularCobertura: stock ÷ venta diaria en días, sin redondear; negativo se trunca en 0', () => {
  assert.strictEqual(calcularCobertura(10, 2), 5);
  assert.strictEqual(calcularCobertura(1, 3), 1 / 3);
  assert.strictEqual(calcularCobertura(0, 3), 0);
  assert.strictEqual(calcularCobertura(-4, 2), 0);       // stock negativo en SiGA
  assert.strictEqual(calcularCobertura(null, 2), 0);     // sin stock cargado
});

test('calcularCobertura: sin venta (0, negativa, null o no numérica) no hay cobertura', () => {
  assert.strictEqual(calcularCobertura(5, 0), null);
  assert.strictEqual(calcularCobertura(5, -1), null);
  assert.strictEqual(calcularCobertura(5, null), null);
  assert.strictEqual(calcularCobertura(5, undefined), null);
  assert.strictEqual(calcularCobertura(5, 'x'), null);
  assert.strictEqual(calcularCobertura(5, Infinity), null);
});

const { umbralDeClase } = require('../lib/plan_prioridad');

test('umbralDeClase: días de la clase; config pisa el default clave por clave; inválido o clase desconocida cae al default', () => {
  assert.strictEqual(umbralDeClase('A'), 7);
  assert.strictEqual(umbralDeClase('B'), 5);
  assert.strictEqual(umbralDeClase('C'), 3);
  assert.strictEqual(umbralDeClase('B', { B: 10 }), 10);
  assert.strictEqual(umbralDeClase('A', { B: 10 }), 7);
  assert.strictEqual(umbralDeClase('A', { A: 'x' }), 7);
  assert.strictEqual(umbralDeClase('A', { A: 0 }), 7);
  assert.strictEqual(umbralDeClase('Z', { C: 4 }), 4);        // clase desconocida = C
  assert.strictEqual(umbralDeClase(undefined), 3);
});

const { urgenciaGrupoPorPeso, umbralPesoGrupo, UMBRAL_PESO_DEFAULT } = require('../lib/plan_prioridad');

const pres = (urgencia, facturacionMensual, ventasVentana) => ({ urgencia, facturacionMensual, ventasVentana });

test('urgenciaGrupoPorPeso: Mieles, 5 % de la facturación urgente (60/35/5) no alcanza → OK', () => {
  const r = urgenciaGrupoPorPeso([pres('OK', 60), pres('OK', 35), pres('URGENTE', 5)]);
  assert.strictEqual(r.urgencia, 'OK');
  assert.strictEqual(r.pesoUrgente, 0.05);
  assert.strictEqual(r.pesoUrgentePronto, 0.05);
});

test('urgenciaGrupoPorPeso: urgente desde el umbral (20 % justo cuenta); PRONTO si lo urgente + lo pronto llega', () => {
  assert.strictEqual(urgenciaGrupoPorPeso([pres('URGENTE', 20), pres('OK', 80)]).urgencia, 'URGENTE');            // exactamente 20 %
  assert.strictEqual(urgenciaGrupoPorPeso([pres('URGENTE', 19.99), pres('OK', 80.01)]).urgencia, 'OK');
  assert.strictEqual(urgenciaGrupoPorPeso([pres('URGENTE', 90), pres('OK', 10)]).urgencia, 'URGENTE');
  const r = urgenciaGrupoPorPeso([pres('URGENTE', 10), pres('PRONTO', 15), pres('OK', 75)]);
  assert.deepStrictEqual(r, { urgencia: 'PRONTO', pesoUrgente: 0.1, pesoUrgentePronto: 0.25 });
  assert.strictEqual(urgenciaGrupoPorPeso([pres('PRONTO', 50), pres('OK', 50)]).urgencia, 'PRONTO');
  assert.strictEqual(urgenciaGrupoPorPeso([pres('OK', 50), pres('OK', 50)]).urgencia, 'OK');
});

test('urgenciaGrupoPorPeso: umbral propio; inválido cae al 20 %', () => {
  assert.strictEqual(UMBRAL_PESO_DEFAULT, 0.2);
  const ps = [pres('URGENTE', 30), pres('OK', 70)];
  assert.strictEqual(urgenciaGrupoPorPeso(ps, 0.5).urgencia, 'OK');
  assert.strictEqual(urgenciaGrupoPorPeso(ps, 0.3).urgencia, 'URGENTE');
  assert.strictEqual(urgenciaGrupoPorPeso(ps, 1).urgencia, 'OK');
  for (const malo of [0, -1, 1.5, 'x', null, undefined, NaN]) assert.strictEqual(urgenciaGrupoPorPeso(ps, malo).urgencia, 'URGENTE', String(malo));
});

test('urgenciaGrupoPorPeso: sin facturación usa las unidades vendidas; si tampoco hay ventas, OK', () => {
  const r = urgenciaGrupoPorPeso([pres('URGENTE', 0, 30), pres('OK', 0, 70)]);
  assert.deepStrictEqual(r, { urgencia: 'URGENTE', pesoUrgente: 0.3, pesoUrgentePronto: 0.3 });
  assert.strictEqual(urgenciaGrupoPorPeso([pres('URGENTE', 0, 5), pres('OK', 0, 95)]).urgencia, 'OK');
  assert.deepStrictEqual(urgenciaGrupoPorPeso([pres('URGENTE', 0, 0), pres('OK', 0, 0)]), { urgencia: 'OK', pesoUrgente: 0, pesoUrgentePronto: 0 });
  // con alguna facturación se pesa solo por facturación, aunque haya unidades
  assert.strictEqual(urgenciaGrupoPorPeso([pres('URGENTE', 0, 1000), pres('OK', 100, 1)]).urgencia, 'OK');
});

test('urgenciaGrupoPorPeso: vacío, nulos y valores raros no rompen', () => {
  const vacio = { urgencia: 'OK', pesoUrgente: 0, pesoUrgentePronto: 0 };
  assert.deepStrictEqual(urgenciaGrupoPorPeso([]), vacio);
  assert.deepStrictEqual(urgenciaGrupoPorPeso(undefined), vacio);
  assert.deepStrictEqual(urgenciaGrupoPorPeso(null, 0.2), vacio);
  assert.strictEqual(urgenciaGrupoPorPeso([pres('URGENTE', -5), pres('URGENTE', 'x'), pres('OK', 100)]).urgencia, 'OK');   // facturación negativa o inválida no pesa
  assert.strictEqual(urgenciaGrupoPorPeso([pres(undefined, 100)]).urgencia, 'OK');
});

test('umbralPesoGrupo: valor de config entre 0 (exclusivo) y 1; si no, 0.20', () => {
  assert.strictEqual(umbralPesoGrupo(0.35), 0.35);
  assert.strictEqual(umbralPesoGrupo(1), 1);
  for (const malo of [0, -0.1, 1.01, 'x', null, undefined, NaN]) assert.strictEqual(umbralPesoGrupo(malo), 0.2, String(malo));
});

test('minUnidadesUrgencia: número >= 0 de config; si no, el default', () => {
  const { minUnidadesUrgencia, MIN_UNIDADES_URGENCIA_DEFAULT } = require('../lib/plan_prioridad');
  assert.strictEqual(minUnidadesUrgencia(0), 0);
  assert.strictEqual(minUnidadesUrgencia(5), 5);
  for (const malo of [-1, 'x', null, undefined, NaN]) assert.strictEqual(minUnidadesUrgencia(malo), MIN_UNIDADES_URGENCIA_DEFAULT, String(malo));
});

test('unidadesAProducir: lo que falta para cubrir diasObjetivo con el stock de la red', () => {
  const { unidadesAProducir } = require('../lib/plan_prioridad');
  assert.strictEqual(unidadesAProducir(0, 0.2, 30), 6);      // miel sin stock, 0.2 u/día: 6 u
  assert.strictEqual(unidadesAProducir(4, 0.2, 30), 2);
  assert.strictEqual(unidadesAProducir(10, 0.2, 30), 0);     // stock de sobra
  assert.strictEqual(unidadesAProducir(-3, 2, 30), 60);      // stock negativo cuenta como 0
  assert.strictEqual(unidadesAProducir(0, null, 30), 0);
});

test('caso Miel Naranjo: sin stock, 0.2 u/día, 30 días => 6 u, menor al mínimo 10 (no urgente); mínimo 0 nunca filtra', () => {
  const { unidadesAProducir, minUnidadesUrgencia, urgenciaGrupoPorPeso } = require('../lib/plan_prioridad');
  const falta = unidadesAProducir(0, 0.2, 30);
  assert.strictEqual(falta, 6);
  assert.ok(falta < minUnidadesUrgencia(undefined));
  assert.ok(!(falta < minUnidadesUrgencia(0)));
  assert.ok(!(0 < minUnidadesUrgencia(0)));
  const g = urgenciaGrupoPorPeso([{ urgencia: 'OK', facturacionMensual: 100 }], 0.2);
  assert.strictEqual(g.urgencia, 'OK');
});
