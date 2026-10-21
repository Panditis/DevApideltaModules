'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { valorFP, conCambioFP, cambiosFP, celdasFP, conInsumosFP, trozosFP, errorInsumosFP, cambioLoteFP, sinGuardadosFP, soloVisiblesFP, textoSelFP, htmlBarraFP } = require('../public/js/precios_fraccionado_presentaciones.js');

const P = { plu: '101', nombre: 'Almendra <500G>', fraccPresentacion: { facilidad: 'dificil', tiempo: null, insumos: [{ plu: '900', cantidad: 1, nombre: 'Bolsa "A"' }] } };

test('valorFP: lo pendiente pisa lo guardado; null saca', () => {
  assert.deepStrictEqual(valorFP(P, {}), { facilidad: 'dificil', tiempo: null, insumos: [{ plu: '900', cantidad: 1, nombre: 'Bolsa "A"' }] });
  assert.deepStrictEqual(valorFP(P, { 101: { tiempo: 'lento', insumos: null } }), { facilidad: 'dificil', tiempo: 'lento', insumos: [] });
  assert.deepStrictEqual(valorFP({ plu: '102' }, {}), { facilidad: null, tiempo: null, insumos: [] });
});

test('conCambioFP: el mismo cambio a varias presentaciones, sin mutar; "" = sacar', () => {
  const pend = { 101: { facilidad: 'facil' } };
  assert.deepStrictEqual(conCambioFP(pend, ['101', '102'], { tiempo: 'rapido' }), { 101: { facilidad: 'facil', tiempo: 'rapido' }, 102: { tiempo: 'rapido' } });
  assert.deepStrictEqual(pend, { 101: { facilidad: 'facil' } });
  assert.deepStrictEqual(conCambioFP({}, ['101'], { facilidad: '' }), { 101: { facilidad: null } });
});

test('cambiosFP: body del PUT, insumos sin el nombre', () => {
  assert.deepStrictEqual(cambiosFP({ 101: { facilidad: 'normal', insumos: [{ plu: '900', cantidad: 2, nombre: 'Bolsa' }] }, 102: { insumos: null } }),
    [{ plu: '101', facilidad: 'normal', insumos: [{ plu: '900', cantidad: 2 }] }, { plu: '102', insumos: null }]);
});

test('celdasFP: selects con lo elegido, chips escapados, selección y marca de pendiente; sin fraccPresentacion → celdas vacías', () => {
  const html = celdasFP(P, {}, new Set(['101']));
  assert.match(html, /<option value="dificil" selected>Difícil<\/option>/);
  assert.match(html, /Bolsa &quot;A&quot; × 1/);
  assert.match(html, /class="fp-sel" data-plu="101" checked/);
  assert.match(html, /aria-label="Facilidad de Almendra &lt;500G&gt;"/);
  assert.doesNotMatch(html, /fp-pend/);
  assert.match(celdasFP(P, { 101: { tiempo: 'lento' } }, new Set()), /fp-pend/);
  assert.strictEqual(celdasFP({ plu: '1' }, {}, new Set()), '<td class="fp-col"></td><td class="fp-col"></td><td class="fp-col"></td><td class="fp-col"></td>');
  assert.strictEqual(html.match(/<td class="[^"]*fp-col/g).length, 4); // las 4 columnas se ocultan juntas si no está migrado
});

test('conInsumosFP: agrega los elegidos con cantidad 1 sin repetir', () => {
  assert.deepStrictEqual(conInsumosFP([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }], [{ plu: 900, nombre: 'Bolsa' }, { plu: '901', nombre: 'Etiqueta' }]),
    [{ plu: '900', nombre: 'Bolsa', cantidad: 2 }, { plu: '901', nombre: 'Etiqueta', cantidad: 1 }]);
});

test('trozosFP: parte los cambios por cantidad y por tamaño del body, en orden y sin perder ninguno', () => {
  const cambios = Array.from({ length: 5 }, (_, i) => ({ plu: String(100 + i), facilidad: 'normal' }));
  assert.deepStrictEqual(trozosFP(cambios, 2).map(t => t.map(c => c.plu)), [['100', '101'], ['102', '103'], ['104']]);
  assert.deepStrictEqual(trozosFP([], 2), []);
  const bytes = JSON.stringify(cambios[0]).length;
  assert.deepStrictEqual(trozosFP(cambios, 500, bytes * 2 + 1).map(t => t.length), [2, 2, 1]);
  assert.deepStrictEqual(trozosFP([cambios[0]], 500, 1).map(t => t.length), [1]); // uno solo nunca se parte, aunque pase el tamaño
  assert.strictEqual(trozosFP(cambios).length, 1);
});

test('errorInsumosFP: cantidad mayor que 0 en cada insumo', () => {
  assert.strictEqual(errorInsumosFP([{ plu: '900', nombre: 'Bolsa', cantidad: 2 }]), null);
  assert.strictEqual(errorInsumosFP([]), null);
  assert.match(errorInsumosFP([{ plu: '900', nombre: 'Bolsa "A"', cantidad: null }]), /Bolsa "A"/);
  assert.notStrictEqual(errorInsumosFP([{ plu: '900', cantidad: 0 }]), null);
  assert.notStrictEqual(errorInsumosFP([{ plu: '900', cantidad: -1 }]), null);
});

test('cambioLoteFP: "no cambiar" no entra, "sacar" borra (null) y el valor se asigna', () => {
  assert.deepStrictEqual(cambioLoteFP('', ''), {});
  assert.deepStrictEqual(cambioLoteFP('facil', ''), { facilidad: 'facil' });
  assert.deepStrictEqual(cambioLoteFP('sacar', 'lento'), { facilidad: null, tiempo: 'lento' });
  assert.deepStrictEqual(conCambioFP({ 101: { tiempo: 'lento' } }, ['101'], cambioLoteFP('', 'sacar')), { 101: { tiempo: null } });
});

test('sinGuardadosFP: sale lo guardado; lo editado durante el guardado sigue pendiente', () => {
  const foto = { 101: { facilidad: 'facil' }, 102: { tiempo: 'lento' }, 103: { insumos: [{ plu: '900', cantidad: 1, nombre: 'Bolsa' }] } };
  const ahora = { ...foto, 101: { facilidad: 'dificil' }, 104: { tiempo: 'rapido' } }; // 101 se volvió a editar y 104 es nuevo
  assert.deepStrictEqual(sinGuardadosFP(ahora, foto, ['101', '102', '103']), { 101: { facilidad: 'dificil' }, 104: { tiempo: 'rapido' } });
  assert.deepStrictEqual(sinGuardadosFP(foto, foto, ['101']), { 102: foto[102], 103: foto[103] }); // sólo el trozo guardado
  assert.deepStrictEqual(sinGuardadosFP(foto, foto, []), foto);
  assert.deepStrictEqual(foto[101], { facilidad: 'facil' }); // no muta
});

test('soloVisiblesFP / textoSelFP: el lote alcanza sólo a las seleccionadas que se ven', () => {
  assert.deepStrictEqual(soloVisiblesFP(new Set(['101', '103', '999']), ['101', '102', '103']), ['101', '103']);
  assert.deepStrictEqual(soloVisiblesFP(new Set(), ['101']), []);
  assert.strictEqual(textoSelFP(1), '1 seleccionada visible');
  assert.strictEqual(textoSelFP(3), '3 seleccionadas visibles');
});

test('htmlBarraFP: los selects del lote distinguen "no cambiar" de "Sacar"; los botones dicen a cuántas aplican', () => {
  const html = htmlBarraFP();
  assert.match(html, /<select class="fp-lote-facilidad[^>]*><option value="">no cambiar<[/]option>[^]*<option value="sacar">Sacar<[/]option><[/]select>/);
  assert.match(html, /<select class="fp-lote-tiempo[^>]*><option value="">no cambiar<[/]option>[^]*<option value="sacar">Sacar<[/]option><[/]select>/);
  assert.match(html, /Aplicar a 0 seleccionadas visibles/);
  assert.match(html, /Insumos a 0 seleccionadas visibles…/);
});
