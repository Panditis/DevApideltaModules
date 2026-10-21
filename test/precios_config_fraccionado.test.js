'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CF = require('../lib/precios_config_fraccionado');

test('validarMaquinas: id estable del nombre (sin tildes, sin repetir), conserva el id que viene; valida nombre y costo', () => {
  const { maquinas } = CF.validarMaquinas({ maquinas: [
    { id: 'env', nombre: ' Envasadora ', costoHora: 3000 },
    { nombre: 'Selladora Única', costoHora: 0 },
    { nombre: 'Selladora única', costoHora: 10 },
  ] });
  assert.deepStrictEqual(maquinas, [
    { id: 'env', nombre: 'Envasadora', costoHora: 3000 },
    { id: 'selladora-unica', nombre: 'Selladora Única', costoHora: 0 },
    { id: 'selladora-unica-2', nombre: 'Selladora única', costoHora: 10 },
  ]);
  assert.throws(() => CF.validarMaquinas({ maquinas: [{ nombre: '', costoHora: 1 }] }), /maquinas\[0\]\.nombre/);
  assert.throws(() => CF.validarMaquinas({ maquinas: [{ nombre: 'X', costoHora: -1 }] }), /maquinas\[0\]\.costoHora/);
  assert.throws(() => CF.validarMaquinas({}), /maquinas: debe ser una lista/);
});

test('validarMaquinas: no deja borrar una máquina que usa algún granel', () => {
  const previo = { maquinas: [{ id: 'env', nombre: 'Envasadora', costoHora: 1 }], porGranel: { 1: { maquinaId: 'env' }, 2: { maquinaId: 'env' } } };
  assert.throws(() => CF.validarMaquinas({ maquinas: [] }, previo), /Envasadora la usan 2 graneles/);
  assert.deepStrictEqual(CF.usosMaquinas(previo.porGranel), { env: 2 });
});

test('validarTiempos: tramos en g enteros y crecientes, minutos 0..600, los 3 factores > 0', () => {
  const ok = CF.validarTiempos({ tiempos: [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }], facilidades: { facil: 1, medio: 1.25, dificil: 1.5 } });
  assert.deepStrictEqual(ok, { tiempos: [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }], facilidades: { facil: 1, medio: 1.25, dificil: 1.5 } });
  const F = { facil: 1, medio: 1, dificil: 1 };
  assert.throws(() => CF.validarTiempos({ tiempos: [{ hastaG: 500, minutos: 1 }, { hastaG: 500, minutos: 1 }], facilidades: F }), /tiempos\[1\]\.hastaG/);
  assert.throws(() => CF.validarTiempos({ tiempos: [{ hastaG: 500, minutos: 601 }], facilidades: F }), /tiempos\[0\]\.minutos/);
  assert.throws(() => CF.validarTiempos({ tiempos: [], facilidades: { facil: 1, medio: 0, dificil: 1 } }), /facilidades\.medio/);
});

test('validarTiempos: factor no numérico, negativo o fuera de rango se rechaza (nunca 0 ni NaN)', () => {
  for (const malo of ['1.5', null, undefined, NaN, Infinity, -1, 11]) {
    assert.throws(() => CF.validarTiempos({ tiempos: [], facilidades: { facil: 1, medio: 1, dificil: malo } }), /facilidades\.dificil/);
  }
  assert.throws(() => CF.validarTiempos({ tiempos: [], facilidades: { facil: 1, medio: 1 } }), /facilidades\.dificil/);
});

test('validarInsumosSubrubro: por subrubro, tramos con insumos válidos; subrubro sin tramos no se guarda', () => {
  const r = CF.validarInsumosSubrubro({ insumosSubrubro: {
    7: [{ hastaG: 500, insumos: [{ plu: 900, cantidad: 1 }] }],
    8: [],
  } });
  assert.deepStrictEqual(r, { insumosSubrubro: { 7: [{ hastaG: 500, insumos: [{ plu: '900', cantidad: 1 }] }] } });
  assert.throws(() => CF.validarInsumosSubrubro({ insumosSubrubro: { abc: [] } }), /subrubro abc/);
  assert.throws(() => CF.validarInsumosSubrubro({ insumosSubrubro: { 7: [{ hastaG: 500, insumos: [{ plu: '900', cantidad: 1 }, { plu: '900', cantidad: 2 }] }] } }), /repetido/);
  assert.throws(() => CF.validarInsumosSubrubro({ insumosSubrubro: { 7: [{ hastaG: 500, insumos: [{ plu: '900', cantidad: 0 }] }] } }), /cantidad/);
  assert.throws(() => CF.validarInsumosSubrubro({}), /insumosSubrubro: falta/);
});

test('aplicarGranel: facilidad y máquina existentes; los dos null borran la entrada', () => {
  const maquinas = [{ id: 'env', nombre: 'Envasadora', costoHora: 1 }];
  assert.deepStrictEqual(CF.aplicarGranel({}, '100', { facilidad: 'medio', maquinaId: 'env' }, maquinas), { 100: { facilidad: 'medio', maquinaId: 'env' } });
  assert.deepStrictEqual(CF.aplicarGranel({ 100: { facilidad: 'medio', maquinaId: 'env' } }, '100', { facilidad: null, maquinaId: null }, maquinas), {});
  assert.throws(() => CF.aplicarGranel({}, '100', { facilidad: 'rapido' }, maquinas), /facilidad/);
  assert.throws(() => CF.aplicarGranel({}, '100', { maquinaId: 'otra' }, maquinas), /maquinaId/);
  assert.throws(() => CF.aplicarGranel({}, 'x', {}, maquinas), /PLU inválido/);
});

test('aplicarInsumosPresentacion: lista válida la guarda; vacía vuelve a la regla', () => {
  assert.deepStrictEqual(CF.aplicarInsumosPresentacion({}, '101', { insumos: [{ plu: '902', cantidad: 3 }] }), { 101: [{ plu: '902', cantidad: 3 }] });
  assert.deepStrictEqual(CF.aplicarInsumosPresentacion({ 101: [{ plu: '902', cantidad: 3 }] }, '101', { insumos: [] }), {});
  assert.throws(() => CF.aplicarInsumosPresentacion({}, '101', { insumos: [{ plu: 'abc', cantidad: 1 }] }), /insumos\[0\]\.plu/);
});

test('validarInsumosSubrubro: null, lista o texto NO borran las reglas (error), sólo un objeto', () => {
  for (const malo of [null, [], 'x', 5]) {
    assert.throws(() => CF.validarInsumosSubrubro({ insumosSubrubro: malo }), /insumosSubrubro: debe ser un objeto/);
  }
  assert.deepStrictEqual(CF.validarInsumosSubrubro({ insumosSubrubro: {} }), { insumosSubrubro: {} });
});

test('los demás validadores tampoco aceptan null ni no-listas como "vacío" (maquinas, tiempos, facilidades, insumos, granel)', () => {
  for (const malo of [null, {}, 'x']) {
    assert.throws(() => CF.validarMaquinas({ maquinas: malo }), /maquinas: debe ser una lista/);
    assert.throws(() => CF.validarTiempos({ tiempos: malo, facilidades: { facil: 1, medio: 1, dificil: 1 } }), /tiempos: debe ser una lista/);
    assert.throws(() => CF.aplicarInsumosPresentacion({}, '101', { insumos: malo }), /insumos: debe ser una lista/);
  }
  assert.throws(() => CF.validarTiempos({ tiempos: [], facilidades: null }), /facilidades\.facil/);
  for (const malo of [null, [], 'x', 5]) {
    assert.throws(() => CF.aplicarGranel({ 100: { facilidad: 'medio', maquinaId: null } }, '100', malo, []), /body: debe ser un objeto/);
  }
});

test('validarMaquinas: el id que manda el cliente debe ser [a-z0-9-]{1,60}; el generado siempre lo cumple (también nombres largos)', () => {
  for (const malo of ['Env', 'a b', 'ñ', 'x'.repeat(61), 7, {}]) {
    assert.throws(() => CF.validarMaquinas({ maquinas: [{ id: malo, nombre: 'X', costoHora: 1 }] }), /maquinas\[0\]\.id/);
  }
  // id vacío o ausente = máquina nueva → se genera
  assert.strictEqual(CF.validarMaquinas({ maquinas: [{ id: '', nombre: 'Nueva', costoHora: 1 }] }).maquinas[0].id, 'nueva');
  // 60 caracteres de nombre repetidos: los ids generados caben en 60 y vuelven a pasar por el validador
  const largo = 'a'.repeat(60);
  const { maquinas } = CF.validarMaquinas({ maquinas: [{ nombre: largo, costoHora: 1 }, { nombre: largo, costoHora: 2 }] });
  assert.ok(maquinas.every(m => /^[a-z0-9-]{1,60}$/.test(m.id)));
  assert.strictEqual(new Set(maquinas.map(m => m.id)).size, 2);
  assert.doesNotThrow(() => CF.validarMaquinas({ maquinas }));
});
