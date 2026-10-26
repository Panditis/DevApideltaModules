'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { conTramoFr, faltaSubrubroFr, cuentaProductosFr, celdasSubrubroFr, subrubrosIncompletosFr, textoUsosFr, coincideFr, subrubrosListaFr, conInsumosFr,
  errorInsumosFr, costoUnidadFr, filasPesosFr, textoPesoFr, pesoCortoFr, estadoPesosFr, estadoConfigFr, pctMinutosFr, efectoFactorFr,
  textoEfectoSubFr, textoAjustesPesoFr } = require('../public/js/precios_config_fraccionado.js');

test('conTramoFr: 250 g el primero, después el doble del último; no muta', () => {
  assert.deepStrictEqual(conTramoFr([]), [{ hastaG: 250, minutos: null }]);
  const ts = [{ hastaG: 300, minutos: 1 }];
  assert.deepStrictEqual(conTramoFr(ts)[1], { hastaG: 600, minutos: null });
  assert.strictEqual(ts.length, 1);
});

test('faltaSubrubroFr: qué le falta a un subrubro para costear', () => {
  const tramos = [{ hastaG: 1, minutos: 1 }];
  assert.deepStrictEqual(faltaSubrubroFr(undefined), ['máquina', 'tramos', 'facilidad']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos: [], facilidad: 'facil' }), ['tramos']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: null, tramos, facilidad: null }), ['máquina', 'facilidad']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos }), ['facilidad']);
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos, facilidad: 'normal' }), []);
  // un `tiempo` viejo guardado ya no cuenta: ni falta ni sobra
  assert.deepStrictEqual(faltaSubrubroFr({ maquinaId: 'env', tramos, facilidad: 'normal', tiempo: null }), []);
});

test('cuentaProductosFr / textoUsosFr: textos de la fila del subrubro y de la máquina', () => {
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1, 2] }, { presentaciones: [] }] }), '2 productos · 2 presentaciones');
  assert.strictEqual(cuentaProductosFr({ graneles: [{ presentaciones: [1] }] }), '1 producto · 1 presentación');
  assert.strictEqual(textoUsosFr({ graneles: 1, subrubros: 2 }), '2 subrubros · 1 granel');
  assert.strictEqual(textoUsosFr({ graneles: 0, subrubros: 0 }), 'sin uso');
});

test('celdasSubrubroFr: máquina, tramos y facilidad de la fila; lo que falta, marcado', () => {
  const maquinas = [{ id: 'env', nombre: 'Envasadora' }];
  assert.deepStrictEqual(celdasSubrubroFr({ maquinaId: 'env', tramos: [{}, {}], facilidad: 'dificil' }, maquinas), [
    { t: 'Envasadora', falta: false }, { t: '2 tramos', falta: false }, { t: 'Difícil', falta: false }]);
  assert.deepStrictEqual(celdasSubrubroFr(undefined, []).map(c => [c.t, c.falta]),
    [['sin máquina', true], ['sin tramos', true], ['sin facilidad', true]]);
  assert.strictEqual(celdasSubrubroFr({ maquinaId: 'env', tramos: [{}] }, maquinas)[1].t, '1 tramo');
});

test('subrubrosIncompletosFr: los de la lista a los que les falta algo para costear', () => {
  const lista = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const ok = { maquinaId: 'env', tramos: [{ hastaG: 1, minutos: 1 }], facilidad: 'normal' };
  assert.deepStrictEqual(subrubrosIncompletosFr(lista, { 1: ok, 2: { ...ok, facilidad: null } }).map(s => s.id), ['2', '3']);
  assert.strictEqual(subrubrosIncompletosFr(lista, undefined).length, 3);
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

test('textoPesoFr / pesoCortoFr: "250 g · 34 presentaciones", kilos enteros en kg, sin presentaciones marcado', () => {
  assert.strictEqual(textoPesoFr({ pesoG: 250, presentaciones: 34 }), '250 g · 34 presentaciones');
  assert.strictEqual(textoPesoFr({ pesoG: 1000, presentaciones: 1 }), '1 kg · 1 presentación');
  assert.strictEqual(textoPesoFr({ pesoG: 1500, presentaciones: 0 }), '1500 g · sin presentaciones');
  assert.deepStrictEqual([pesoCortoFr(250), pesoCortoFr(2000), pesoCortoFr(1500)], ['250 g', '2 kg', '1500 g']);
});

test('estadoPesosFr: pesos con insumos y pesos con algún insumo sin costo', () => {
  const filas = [{ pesoG: 250, insumos: [] }, { pesoG: 500, insumos: [{ cantidad: 1, costo: 5 }] }, { pesoG: 1000, insumos: [{ cantidad: 1, costo: null }] }];
  assert.deepStrictEqual(estadoPesosFr(filas), { total: 3, conInsumos: 2, sinCosto: 1 });
  assert.deepStrictEqual(estadoPesosFr([]), { total: 0, conInsumos: 0, sinCosto: 0 });
});

test('textoAjustesPesoFr: cuántos tramos tiene el ajuste por peso; null o sin tramos → sin ajuste', () => {
  assert.strictEqual(textoAjustesPesoFr(null), 'sin ajuste');
  assert.strictEqual(textoAjustesPesoFr(undefined), 'sin ajuste');
  assert.strictEqual(textoAjustesPesoFr({ tramosG: [], puntos: [] }), 'sin ajuste');
  assert.strictEqual(textoAjustesPesoFr({ tramosG: [1000], puntos: [0] }), '1 tramo');
  assert.strictEqual(textoAjustesPesoFr({ tramosG: [100, 1000], puntos: [8, 0] }), '2 tramos');
});

test('estadoConfigFr: máquinas, subrubros, insumos por peso y ajuste por peso con su estado (ok | falta | info)', () => {
  const ok = { maquinaId: 'env', tramos: [{ hastaG: 1, minutos: 1 }], facilidad: 'normal' };
  const filas = [{ pesoG: 250, insumos: [{ cantidad: 1, costo: 5 }] }, { pesoG: 500, insumos: [] }];
  const e = estadoConfigFr([{ id: 'env' }], [{ id: '1' }, { id: '2' }], { 1: ok }, filas, { tramosG: [100, 1000], puntos: [8, 0] });
  assert.deepStrictEqual(e.map(p => [p.id, p.texto, p.estado]), [
    ['frMaquinas', '1 cargada', 'ok'], ['frSubrubrosCard', '1 de 2 completos', 'falta'], ['frPesos', '1 de 2 pesos con insumos', 'info'],
    ['frAjustes', '2 tramos', 'info']]);
  const vacio = estadoConfigFr([], [], {}, []);
  assert.deepStrictEqual(vacio.map(p => [p.texto, p.estado]), [['ninguna cargada', 'falta'], ['sin subrubros', 'info'], ['sin pesos', 'info'], ['sin ajuste', 'info']]);
  assert.deepStrictEqual(estadoConfigFr([{}, {}], [{ id: '1' }], { 1: ok }, [{ pesoG: 250, insumos: [{ cantidad: 1, costo: null }] }], null).map(p => [p.texto, p.estado]),
    [['2 cargadas', 'ok'], ['1 de 1 completos', 'ok'], ['1 sin costo', 'falta'], ['sin ajuste', 'info']]);
});

test('pctMinutosFr: % de minutos que suma o resta un factor', () => {
  assert.deepStrictEqual([pctMinutosFr(1.5), pctMinutosFr(0.75), pctMinutosFr(1)], ['+50% minutos', '−25% minutos', 'sin cambio']);
});

test('efectoFactorFr: factor y % de minutos que suma o resta', () => {
  assert.strictEqual(efectoFactorFr(1.5), '× 1,5 (+50% minutos)');
  assert.strictEqual(efectoFactorFr(0.75), '× 0,75 (−25% minutos)');
  assert.strictEqual(efectoFactorFr(1), '× 1 (sin cambio)');
});

test('textoEfectoSubFr: minutos del tramo × factor de facilidad; sin elegir → × 1', () => {
  const escalas = { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } };
  assert.strictEqual(textoEfectoSubFr(escalas, 'dificil'), 'Minutos por unidad = minutos del tramo × 1,5 (facilidad difícil: +50% minutos)');
  assert.strictEqual(textoEfectoSubFr(escalas, 'facil'), 'Minutos por unidad = minutos del tramo × 1 (facilidad fácil: sin cambio)');
  assert.strictEqual(textoEfectoSubFr(escalas, ''), 'Minutos por unidad = minutos del tramo × 1 (facilidad sin elegir: sin cambio)');
  assert.doesNotMatch(textoEfectoSubFr(escalas, 'normal'), /tiempo/i);
});
