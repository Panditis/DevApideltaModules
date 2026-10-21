'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { conTramoFr, faltaSubrubroFr, cuentaProductosFr, resumenSubrubroFr, textoUsosFr, coincideFr, subrubrosListaFr } = require('../public/js/precios_config_fraccionado.js');

test('conTramoFr: 250 g el primero, después el doble del último; no muta', () => {
  assert.deepStrictEqual(conTramoFr([]), [{ hastaG: 250, minutos: null }]);
  const ts = [{ hastaG: 300, minutos: 1 }];
  assert.deepStrictEqual(conTramoFr(ts)[1], { hastaG: 600, minutos: null });
  assert.strictEqual(ts.length, 1);
});

test('faltaSubrubroFr: qué le falta a un subrubro para costear', () => {
  assert.deepStrictEqual(faltaSubrubroFr(undefined), ['máquina', 'tramos']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos: [] }), ['tramos']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: null, tramos: [{ hastaG: 1, minutos: 1 }] }), ['máquina']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos: [{ hastaG: 1, minutos: 1 }] }), []);
});

test('cuentaProductosFr / resumenSubrubroFr / textoUsosFr: textos de la fila del subrubro y de la máquina', () => {
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1, 2] }, { presentaciones: [] }] }), '2 productos · 2 presentaciones');
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1] }] }), '1 producto · 1 presentación');
  assert.strictEqual(resumenSubrubroFr({ maquinaId: 'env', tramos: [{}, {}] }, [{ id: 'env', nombre: 'Envasadora' }]), 'Envasadora · 2 tramos');
  assert.strictEqual(resumenSubrubroFr(undefined, []), 'sin máquina · sin tramos');
  assert.strictEqual(textoUsosFr({ graneles: 1, subrubros: 2 }), '2 subrubros · 1 granel');
  assert.strictEqual(textoUsosFr({ graneles: 0, subrubros: 0 }), 'sin uso');
});

test('coincideFr: todas las palabras, sin importar mayúsculas ni tildes; vacío coincide con todo', () => {
  assert.strictEqual(coincideFr('Almendra Pelada (Almendra 500G)', 'ALMENDRA 500'), true);
  assert.strictEqual(coincideFr('Maní tostado', 'mani'), true);
  assert.strictEqual(coincideFr('Maní tostado', 'mani sal'), false);
  assert.strictEqual(coincideFr('Maní tostado', '  '), true);
});

test('subrubrosListaFr: los de SIGA + los configurados que SIGA ya no trae (para poder soltarles la máquina)', () => {
  const siga = [{ id: '7', nombre: 'Frutos secos', graneles: [{ presentaciones: [] }] }];
  assert.deepStrictEqual(subrubrosListaFr(siga, { 7: {}, 9: {} }).map(s => [s.id, s.nombre, s.graneles.length]),
    [['7', 'Frutos secos', 1], ['9', 'Subrubro 9 (ya no tiene productos en SIGA)', 0]]);
  assert.strictEqual(subrubrosListaFr(siga, undefined).length, 1);
  assert.strictEqual(siga.length, 1); // no muta
});
