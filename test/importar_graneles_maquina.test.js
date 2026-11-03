'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { importarGranelesMaquina: imp } = require('../lib/importar_graneles_maquina');

const base = (porGranel = {}, activoGranel, maquinas = [{ id: 'm1' }]) =>
  ({ otro: 1, ...(activoGranel && { activoGranel }), fraccionado: { maquinas, porGranel, costoHora: 5 } });
const pg = r => r.costeoNuevo.fraccionado.porGranel;

test('s → máquina + bobina, preserva minKg; código con ceros/espacios', () => {
  const c = base({ 10: { minKg: 2 } });
  const r = imp([{ Codigo: ' 010 ', Maquina: 'S ' }], c);
  assert.deepStrictEqual(pg(r)['10'], { minKg: 2, maquinaId: 'm1', envase: 'bobina' });
  assert.strictEqual(r.resumen.cambiosGranel, 1);
  assert.deepStrictEqual(c.fraccionado.porGranel['10'], { minKg: 2 }); // no muta
  assert.strictEqual(r.costeoNuevo.otro, 1);
});

test('x → inactivo y sin máquina; x sobre ya inactivo = sin cambio', () => {
  const r = imp([{ Codigo: '5', Maquina: 'x' }], base({ 5: { maquinaId: 'm1', envase: 'bobina' } }));
  assert.strictEqual(r.costeoNuevo.activoGranel['5'], false);
  assert.strictEqual(pg(r)['5'], undefined);
  const r2 = imp([{ Codigo: '5', Maquina: 'x' }], base({}, { 5: false }));
  assert.strictEqual(r2.resumen.cambiosGranel, 0);
  assert.strictEqual(r2.resumen.yaEstaban, 1);
});

test('vacío y no listado con máquina → sin máquina y bolsa, estado intacto', () => {
  const r = imp([{ Codigo: '1', Maquina: null }], base({ 1: { maquinaId: 'm1', envase: 'bobina', minKg: 1 }, 2: { maquinaId: 'm1' } }, { 1: true }));
  assert.deepStrictEqual(pg(r), { 1: { minKg: 1 } });
  assert.deepStrictEqual(r.costeoNuevo.activoGranel, { 1: true });
  assert.strictEqual(r.resumen.cambiosGranel, 2);
});

test('máquina sin bobina se normaliza a bobina', () => {
  const r = imp([{ Codigo: '3', Maquina: 's' }], base({ 3: { maquinaId: 'm1' } }));
  assert.deepStrictEqual(pg(r)['3'], { maquinaId: 'm1', envase: 'bobina' });
});

test('letra rara → no se toca y avisa', () => {
  const r = imp([{ Codigo: '4', Maquina: 'q' }], base({ 4: { maquinaId: 'm1' } }));
  assert.deepStrictEqual(pg(r)['4'], { maquinaId: 'm1' });
  assert.strictEqual(r.resumen.advertencias.length, 1);
});

test('0 o 2 máquinas → error; --maquina elige', () => {
  assert.throws(() => imp([], base({}, null, [])), /una sola máquina/);
  assert.throws(() => imp([], base({}, null, [{ id: 'a' }, { id: 'b' }])), /hay 2/);
  assert.strictEqual(imp([], base({}, null, [{ id: 'a' }, { id: 'b' }]), { maquina: 'b' }).resumen.maquinaId, 'b');
  assert.throws(() => imp([], base(), { maquina: 'zz' }), /no está/);
});
