const test = require('node:test');
const assert = require('node:assert/strict');
const ml = require('../lib/ml_precios');

test('mismo producto o agrupador: un grupo con principal y todas usan su vínculo', () => {
  const pubs = [{ id: 'A', producto: 'U1', familia: 'F1' }, { id: 'B', producto: 'U1', familia: '' }, { id: 'C', producto: '', familia: 'F1' }, { id: 'D', producto: 'U2', familia: '' }, { id: 'E' }];
  const g = ml.agruparPublicaciones(pubs, { A: { codigo: 1, unidades: 2, actualizado: 'x' } });
  assert.equal(g.get('A').esPrincipal, true);
  for (const id of ['A', 'B', 'C']) { assert.equal(g.get(id).principal, 'A'); assert.equal(g.get(id).vinculo.codigo, 1); }
  assert.deepEqual(g.get('C').hermanas.sort(), ['A', 'B']);
  assert.equal(g.get('D').vinculo, null);
  assert.equal(g.get('E').hermanas.length, 0);
});

test('principal = vínculo más reciente y su vínculo pisa el de las hermanas', () => {
  const g = ml.agruparPublicaciones([{ id: 'A', producto: 'U' }, { id: 'B', producto: 'U' }], { A: { codigo: 1, actualizado: '2026-01-01' }, B: { codigo: 2, actualizado: '2026-02-01' } });
  assert.equal(g.get('A').principal, 'B');
  assert.equal(g.get('A').vinculo.codigo, 2);
});

test('sin vínculos la principal es la primera activa', () => {
  const g = ml.agruparPublicaciones([{ id: 'A', producto: 'U', activa: false }, { id: 'B', producto: 'U', activa: true }], {});
  assert.equal(g.get('A').principal, 'B');
});
