'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { conTramoFr, faltaSubrubroFr, cuentaProductosFr, resumenSubrubroFr, textoUsosFr, coincideFr, subrubrosListaFr, conInsumosFr, errorInsumosFr,
  costoUnidadFr, filasPesosFr, textoPesoFr, efectoFactorFr, textoEfectoSubFr } = require('../public/js/precios_config_fraccionado.js');

test('conTramoFr: 250 g el primero, después el doble del último; no muta', () => {
  assert.deepStrictEqual(conTramoFr([]), [{ hastaG: 250, minutos: null }]);
  const ts = [{ hastaG: 300, minutos: 1 }];
  assert.deepStrictEqual(conTramoFr(ts)[1], { hastaG: 600, minutos: null });
  assert.strictEqual(ts.length, 1);
});

test('faltaSubrubroFr: qué le falta a un subrubro para costear', () => {
  const tramos = [{ hastaG: 1, minutos: 1 }];
  assert.deepStrictEqual(faltaSubrubroFr(undefined), ['máquina', 'tramos', 'facilidad', 'tiempo']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos: [], facilidad: 'facil', tiempo: 'lento' }), ['tramos']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: null, tramos, facilidad: null, tiempo: 'normal' }), ['máquina', 'facilidad']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos }), ['facilidad', 'tiempo']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos, facilidad: 'normal', tiempo: 'rapido' }), []);
});

test('cuentaProductosFr / resumenSubrubroFr / textoUsosFr: textos de la fila del subrubro y de la máquina', () => {
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1, 2] }, { presentaciones: [] }] }), '2 productos · 2 presentaciones');
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1] }] }), '1 producto · 1 presentación');
  assert.strictEqual(resumenSubrubroFr({ maquinaId: 'env', tramos: [{}, {}], facilidad: 'dificil', tiempo: 'rapido' }, [{ id: 'env', nombre: 'Envasadora' }]),
    'Envasadora · 2 tramos · Difícil · Rápido');
  assert.strictEqual(resumenSubrubroFr(undefined, []), 'sin máquina · sin tramos · sin facilidad · sin tiempo');
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

test('conInsumosFr: agrega los elegidos con cantidad 1 sin repetir', () => {
  assert.deepStrictEqual(conInsumosFr([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }], [{ plu: 900, nombre: 'Bolsa' }, { plu: '901', nombre: 'Etiqueta' }]),
    [{ plu: '900', nombre: 'Bolsa', cantidad: 2 }, { plu: '901', nombre: 'Etiqueta', cantidad: 1 }]);
});

test('errorInsumosFr: cantidad mayor que 0 en cada insumo', () => {
  assert.strictEqual(errorInsumosFr([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }]), null);
  assert.strictEqual(errorInsumosFr([]), null);
  assert.match(errorInsumosFr([{ plu: '900', nombre: 'Bolsa "A"', cantidad: null }]), /Bolsa "A"/);
  assert.notStrictEqual(errorInsumosFr([{ plu: '900', cantidad: 0 }]), null);
  assert.notStrictEqual(errorInsumosFr([{ plu: '900', cantidad: -1 }]), null);
});

test('costoUnidadFr: suma cantidad × costo de cada insumo; null si alguno no tiene costo', () => {
  assert.strictEqual(costoUnidadFr([{ cantidad: 1, costo: 20 }, { cantidad: 2, costo: 1.255 }]), 22.51);
  assert.strictEqual(costoUnidadFr([{ cantidad: 1, costo: 20 }, { cantidad: 1, costo: null }]), null);
  assert.strictEqual(costoUnidadFr([]), 0);
  assert.strictEqual(costoUnidadFr(undefined), 0);
});

test('filasPesosFr: un peso por fila, ascendente, con sus insumos; también los configurados que ya no tienen presentaciones', () => {
  const pesos = [{ pesoG: 250, presentaciones: 34 }, { pesoG: 1000, presentaciones: 2 }];
  const ipp = { 1000: [{ plu: '900', cantidad: 1, nombre: 'Bolsa', costo: 20 }], 500: [{ plu: '901', cantidad: 1, nombre: 'Etiqueta', costo: 5 }] };
  assert.deepStrictEqual(filasPesosFr(pesos, ipp), [
    { pesoG: 250, presentaciones: 34, insumos: [] },
    { pesoG: 500, presentaciones: 0, insumos: ipp[500] },
    { pesoG: 1000, presentaciones: 2, insumos: ipp[1000] },
  ]);
  assert.deepStrictEqual(filasPesosFr(undefined, undefined), []);
  assert.strictEqual(pesos.length, 2); // no muta
});

test('textoPesoFr: "250 g · 34 presentaciones", kilos enteros en kg, sin presentaciones marcado', () => {
  assert.strictEqual(textoPesoFr({ pesoG: 250, presentaciones: 34 }), '250 g · 34 presentaciones');
  assert.strictEqual(textoPesoFr({ pesoG: 1000, presentaciones: 1 }), '1 kg · 1 presentación');
  assert.strictEqual(textoPesoFr({ pesoG: 1500, presentaciones: 0 }), '1500 g · sin presentaciones');
});

test('efectoFactorFr: factor y % de minutos que suma o resta', () => {
  assert.strictEqual(efectoFactorFr(1.5), '× 1,5 (+50% minutos)');
  assert.strictEqual(efectoFactorFr(0.75), '× 0,75 (−25% minutos)');
  assert.strictEqual(efectoFactorFr(1), '× 1 (sin cambio)');
});

test('textoEfectoSubFr: factor combinado de facilidad × tiempo; sin elegir → × 1', () => {
  const escalas = { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 }, tiempo: { rapido: 0.75, normal: 1, lento: 1.5 } };
  const t = textoEfectoSubFr(escalas, 'dificil', 'rapido');
  assert.match(t, /× 1,5 \(difícil\) × 0,75 \(rápido\) = base × 1,125 \(\+12,5% minutos\)/);
  assert.match(t, /mano de obra y la máquina/);
  assert.match(textoEfectoSubFr(escalas, '', null), /× 1 \(sin elegir\) × 1 \(sin elegir\) = base × 1 \(sin cambio\)/);
});
