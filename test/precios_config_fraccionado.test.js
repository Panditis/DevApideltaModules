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
