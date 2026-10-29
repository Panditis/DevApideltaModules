'use strict';
// Sugerido de min/kg desde el historial de fraccionado (spec 2026-10-29-…-tiempos-historial, E2). Fixtures sintéticos.
const test = require('node:test');
const assert = require('node:assert');
const H = require('../lib/precios_fraccionado_historial');

let sec = 0;
// Una carga de 1 kg en 50 min por defecto, de una persona propia (sin empleado → no se reparte con nadie).
const carga = (x = {}) => ({ id: `c${++sec}`, fecha: '2026-10-01', plu: '500', nombre: 'Almendra 1Kg', granel: '100',
  granelConsumido: 1, desde: '08:00', hasta: '08:50', ...x });
const muchas = (n, x) => Array.from({ length: n }, () => carga(x));
const TRAMOS = [{ hastaG: 100, minKg: 5 }, { hastaG: 500, minKg: 2 }, { hastaG: 1000, minKg: 0 }];

test('mediana y cuantiles con pares e impares; vacío → null; no muta', () => {
  const v = [3, 1, 2];
  assert.strictEqual(H.mediana(v), 2);
  assert.deepStrictEqual(v, [3, 1, 2]);
  assert.strictEqual(H.mediana([4, 1, 3, 2]), 2.5);
  assert.strictEqual(H.cuantil([1, 2, 3, 4, 5], 0.25), 2);
  assert.strictEqual(H.cuantil([1, 2, 3, 4], 0.75), 3.25);
  assert.strictEqual(H.mediana([]), null);
  assert.strictEqual(H.mediana(null), null);
  assert.strictEqual(H.cuantil([7], 0.25), 7);
});

test('solapadas de la misma persona 08:00-09:00 y 08:30-09:30 = 45 y 45; otra persona u otro día no se reparte', () => {
  const a = carga({ empleado: 'Ana', desde: '08:00', hasta: '09:00' });
  const b = carga({ empleado: 'ana ', desde: '08:30', hasta: '09:30' });
  const c = carga({ empleado: 'Beto', desde: '08:00', hasta: '09:00' });
  const d = carga({ empleado: 'Ana', fecha: '2026-10-02', desde: '08:00', hasta: '09:00' });
  assert.deepStrictEqual(H.repartirMinutos([a, b, c, d]), [45, 45, 60, 60]);
});

test('persona-minutos: dos personas en una carga suman; sin persona = propia; ACT también reparte; suma = minutosUnidos', () => {
  const dos = carga({ roles: [{ nombre: 'Ana' }, { nombre: 'Beto', desde: '08:00', hasta: '08:30' }], desde: '08:00', hasta: '09:00' });
  const act = carga({ plu: 'ACT', empleado: 'Ana', desde: '08:00', hasta: '09:00' });
  const sola1 = carga({ desde: '08:00', hasta: '09:00' });
  const sola2 = carga({ desde: '08:00', hasta: '09:00' });
  const sinHora = carga({ empleado: 'Ana', desde: '', hasta: '' });
  const m = H.repartirMinutos([dos, act, sola1, sola2, sinHora]);
  assert.deepStrictEqual(m, [60, 30, 60, 60, 0]); // Ana 30 + Beto 30 en `dos`; ACT 30
  assert.strictEqual(m[0] - 30 + m[1], 60); // Ana: 60 min unidos
  assert.deepStrictEqual(H.repartirMinutos(null), []);
});

test('10 kg en bolsas de 50 g en 70 min = 7 crudo; con +5 guardado para 50 g = 2', () => {
  assert.deepStrictEqual(H.minKgPorCarga({ minutos: 70, kilos: 10, pesoG: 50, tramos: [] }), { crudo: 7, minKg: 7 });
  assert.deepStrictEqual(H.minKgPorCarga({ minutos: 70, kilos: 10, pesoG: 50, tramos: TRAMOS }), { crudo: 7, minKg: 2 });
  const r = H.estadisticasHistorial({ cargas: muchas(5, { nombre: 'Almendra 50G', granelConsumido: 10, desde: '08:00', hasta: '09:10' }), tramos: TRAMOS });
  assert.strictEqual(r.productos['100'].mediana, 2);
});

test('descartes contados por motivo y fuera; total sin repetidos por id; mal formadas no tiran', () => {
  const ok = carga();
  const cargas = [ok, { ...ok }, 5, null, 'x',
    carga({ plu: 'ACT', granel: null }),
    carga({ desde: '09:00', hasta: '09:00' }), carga({ desde: '', hasta: '' }), carga({ desde: '06:00', hasta: '09:01' }),
    carga({ granelConsumido: 0 }),
    carga({ granel: null, plu: '777' }), carga({ granel: null, plu: '1, 2' }), carga({ granel: null, graneles: [{ granel: '1' }, { granel: '2' }] }),
    carga({ nombre: 'Almendra PEDIDOS' }), {}];
  const r = H.estadisticasHistorial({ cargas });
  assert.deepStrictEqual(r.cargas, { total: 11, usadas: 1, descartes: { act: 1, duracion: 4, sinKilos: 1, sinGranel: 3, sinPeso: 1 } });
  assert.strictEqual(r.minMuestras, 5);
});

test('granel: graneles[] único, fórmula de pesables_listas o PLU que es un granel', () => {
  const cargas = [carga({ granel: null, graneles: [{ granel: '200' }] }), carga({ granel: null, plu: '600' }), carga({ granel: null, plu: '300' })];
  const r = H.estadisticasHistorial({ cargas, formulas: { 600: { granel: '201' } }, graneles: [{ plu: '300', nombre: 'Nuez', subrubroId: null }] });
  assert.deepStrictEqual(Object.keys(r.productos).sort(), ['200', '201', '300']);
});

test('menos de 5 cargas → pocosDatos sin valor; nunca baja de 0', () => {
  const r = H.estadisticasHistorial({ cargas: [...muchas(4, { granel: '1' }), ...muchas(5, { granel: '2', nombre: 'Almendra 50G' })],
    tramos: [{ hastaG: 100, minKg: 80 }, { hastaG: 1000, minKg: 0 }] });
  assert.deepStrictEqual(r.productos['1'], { n: 4, mediana: null, p25: null, p75: null, subrubroId: null, pocosDatos: true });
  assert.strictEqual(r.productos['2'].mediana, 0); // crudo 50 − 80 → 0
});

test('subrubro = mediana de medianas (un producto, un voto); granel sin subrubro cuenta en producto y tramo, no en subrubro', () => {
  const graneles = [{ plu: '1', nombre: 'A', subrubroId: 9 }, { plu: '2', nombre: 'B', subrubroId: 9 }, { plu: '3', nombre: 'C', subrubroId: '9' },
    { plu: '4', nombre: 'D', subrubroId: 9 }, { plu: '5', nombre: 'Sin', subrubroId: null }];
  const cargas = [...muchas(20, { granel: '1', hasta: '08:10' }), ...muchas(5, { granel: '2', hasta: '08:20' }),
    ...muchas(5, { granel: '3', hasta: '08:30' }), ...muchas(2, { granel: '4' }), ...muchas(5, { granel: '5' })];
  const r = H.estadisticasHistorial({ cargas, graneles });
  assert.deepStrictEqual(r.subrubros, { 9: { n: 30, productos: 3, mediana: 20, p25: 15, p75: 25, pocosDatos: false } });
  assert.strictEqual(r.productos['5'].subrubroId, null);
  assert.strictEqual(r.productos['5'].mediana, 50);
  assert.deepStrictEqual(r.distribucion['9'].map(p => [p.plu, p.nombre, p.n, p.minKg]), [['1', 'A', 20, 10], ['2', 'B', 5, 20], ['3', 'C', 5, 30]]);
});

test('subrubro con productos sin valor → pocosDatos', () => {
  const r = H.estadisticasHistorial({ cargas: muchas(3, { granel: '1' }), graneles: [{ plu: '1', subrubroId: 9 }] });
  assert.deepStrictEqual(r.subrubros['9'], { n: 0, productos: 0, mediana: null, p25: null, p75: null, pocosDatos: true });
  assert.deepStrictEqual(r.distribucion, {});
});

test('tramos: crudos contra la base por producto, base sin sugerir, tabla guardada no entra', () => {
  // 5 productos: en 1 kg 10 min/kg; en 50 g 10+k min/kg (k = 1..5). Producto 6 sólo en 50 g: no vota.
  const cargas = [1, 2, 3, 4, 5].flatMap(k => [carga({ granel: String(k), hasta: '08:10' }),
    carga({ granel: String(k), nombre: 'X 50G', granelConsumido: 1, desde: '08:00', hasta: `08:${10 + k}` })])
    .concat(muchas(3, { granel: '6', nombre: 'X 50G' }));
  const guardada = [{ hastaG: 100, minKg: 99 }, { hastaG: 500, minKg: -7 }, { hastaG: 1000, minKg: 0 }];
  const r = H.estadisticasHistorial({ cargas, tramos: guardada });
  assert.deepStrictEqual(r.tramos, [
    { hastaG: 100, base: false, n: 5, mediana: 3, p25: 2, p75: 4, pocosDatos: false },
    { hastaG: 500, base: false, n: 0, mediana: null, p25: null, p75: null, pocosDatos: true },
    { hastaG: 1000, base: true, n: 5, mediana: 0, p25: 0, p75: 0, pocosDatos: false }]);
});

test('sin historial → ceros', () => {
  for (const arg of [undefined, { cargas: [] }, { cargas: 'basura', graneles: 3, tramos: {} }]) {
    assert.deepStrictEqual(H.estadisticasHistorial(arg), { cargas: { total: 0, usadas: 0, descartes: { act: 0, duracion: 0, sinKilos: 0, sinGranel: 0, sinPeso: 0 } },
      minMuestras: 5, productos: {}, subrubros: {}, tramos: [], distribucion: {} });
  }
});

test('no muta las entradas', () => {
  const cargas = muchas(5);
  const copia = JSON.parse(JSON.stringify(cargas));
  H.estadisticasHistorial({ cargas, tramos: TRAMOS, graneles: [{ plu: 100, subrubroId: 1 }] });
  assert.deepStrictEqual(cargas, copia);
});
