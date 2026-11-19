'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { grillaMes, moverMes, agruparPorDia, ordenSinFecha, formatoFecha, hoyISO, esInicioPorFecha } = require('../public/js/tickets_calendario.js');

test('esInicioPorFecha: solo el auto de estado con motivo fecha', () => {
  const base = { fecha: 'x', usuario: 'sistema', tipo: 'estado', de: 'pendiente', a: 'en_proceso', auto: true };
  assert.strictEqual(esInicioPorFecha({ ...base, motivo: 'fecha' }), true);
  assert.strictEqual(esInicioPorFecha(base), false); // auto de etapas: sin motivo
  assert.strictEqual(esInicioPorFecha({ ...base, auto: false, motivo: 'fecha' }), false);
  assert.strictEqual(esInicioPorFecha({ ...base, tipo: 'nota', motivo: 'fecha' }), false);
  assert.strictEqual(esInicioPorFecha(undefined), false);
});

const RANGO = { baja: 0, media: 1, alta: 2, urgente: 3 };
const rango = p => RANGO[p];
const t = (id, prioridad, extra = {}) => ({ id, prioridad, estado: 'pendiente', fecha: null, ...extra });

test('formatoFecha pasa YYYY-MM-DD a dd/mm/aaaa y devuelve vacío si no es fecha', () => {
  assert.strictEqual(formatoFecha('2026-11-05'), '05/11/2026');
  assert.strictEqual(formatoFecha(null), '');
  assert.strictEqual(formatoFecha('basura'), '');
});

test('hoyISO usa la fecha local', () => {
  assert.strictEqual(hoyISO(new Date(2026, 0, 9)), '2026-01-09');
});

test('grillaMes: semanas completas que empiezan en lunes', () => {
  const g = grillaMes(2026, 10); // noviembre 2026: el 1 es domingo
  assert.strictEqual(g.length % 7, 0);
  assert.strictEqual(g[0].iso, '2026-10-26');
  assert.strictEqual(g[0].delMes, false);
  assert.strictEqual(g[6].iso, '2026-11-01');
  assert.strictEqual(g[6].delMes, true);
  assert.strictEqual(g.filter(d => d.delMes).length, 30);
  assert.strictEqual(g.at(-1).iso, '2026-12-06');
});

test('grillaMes: un mes que arranca en lunes y tiene 28 días ocupa 4 semanas', () => {
  const g = grillaMes(2027, 1); // febrero 2027: lunes 1, 28 días
  assert.strictEqual(g.length, 28);
  assert.strictEqual(g[0].iso, '2027-02-01');
});

test('moverMes cruza de año en los dos sentidos', () => {
  assert.deepStrictEqual(moverMes(2026, 11, 1), { anio: 2027, mes0: 0 });
  assert.deepStrictEqual(moverMes(2026, 0, -1), { anio: 2025, mes0: 11 });
});

test('agruparPorDia agrupa por fecha, ordena por prioridad y orden, e incluye cerrados', () => {
  const lista = [
    t(1, 'baja', { fecha: '2026-11-10', orden: 1 }),
    t(2, 'urgente', { fecha: '2026-11-10', orden: 5 }),
    t(3, 'media', { fecha: '2026-11-10', orden: 2 }),
    t(4, 'media', { fecha: '2026-11-10', orden: 1 }),
    t(5, 'alta', { fecha: '2026-11-11', estado: 'terminado' }),
    t(6, 'alta'),
  ];
  const m = agruparPorDia(lista, rango);
  assert.deepStrictEqual(m.get('2026-11-10').map(x => x.id), [2, 4, 3, 1]);
  assert.deepStrictEqual(m.get('2026-11-11').map(x => x.id), [5]);
  assert.strictEqual(m.size, 2);
});

test('ordenSinFecha excluye con fecha, terminados y cancelados; prioridad, luego orden manual, sin orden al final', () => {
  const lista = [
    t(1, 'media', { orden: 3 }),
    t(2, 'media', { orden: 1 }),
    t(3, 'media'),
    t(4, 'urgente', { orden: 9 }),
    t(5, 'alta', { fecha: '2026-11-10' }),
    t(6, 'alta', { estado: 'terminado' }),
    t(7, 'baja', { estado: 'cancelado' }),
    t(8, 'baja', { orden: 1 }),
  ];
  assert.deepStrictEqual(ordenSinFecha(lista, rango).map(x => x.id), [4, 2, 1, 3, 8]);
});
