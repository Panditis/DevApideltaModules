'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/cotizador_mayorista');

// Listado falso (sólo vínculos): base 100 con pack 101 y bulto 102. Precios de SIGA: 101 → 1000, 102 → 900.
const listado = { almacen: [{ plu: '100', mayoristas: [{ plu: '101', tipo: 'pack' }, { plu: '102', tipo: 'bulto' }] }] };
const PRECIOS = new Map([['101', 1000], ['102', 900]]);
const fila = x => ({ cod: '100', seccion: 'S', nombre: 'Miel', packQty: '12u', bultoQty: '32u', ...x });
const armar = (f, precios = PRECIOS) => C.armarCatalogo({ tabla: { filas: C.validarTabla([f]) }, indice: C.indicePrecios(listado), precios });

test('modoPack plu: fila vieja sin el campo sigue usando el PLU pack (regresión)', () => {
  const r = armar(fila({}));
  assert.deepStrictEqual([r.filas[0].pack_price, r.filas[0].modoPack, r.filas[0].origen.pack], [1000, 'plu', 'siga']);
  assert.strictEqual(C.validarTabla([fila({ modoPack: '' })])[0].modoPack, 'plu');
});

test('modoPack descuento ya no existe: validarTabla lo rechaza', () => {
  assert.throws(() => C.validarTabla([fila({ modoPack: 'descuento', descuentoPack: 10 })]), /^Error: Fila 1: modoPack inválido \(plu o ninguno\)/);
  assert.throws(() => C.validarTabla([fila({ modoPack: 'x' })]), /Fila 1: modoPack inválido \(plu o ninguno\)/);
  assert.strictEqual(C.validarTabla([fila({ descuentoPack: 10 })])[0].descuentoPack, undefined); // campo viejo suelto se descarta
});

test('filas manuales ya no existen: validarTabla las rechaza', () => {
  assert.throws(() => C.validarTabla([{ cod: '9001', seccion: 'S', nombre: 'Pallet', manual: true, bultoQty: '10u', bultoPrice: 5 }]),
    /^Error: Fila 1: las filas manuales con precio fijo ya no existen/);
  const [f] = C.validarTabla([fila({ manual: false, packPrice: 5, bultoPrice: 6 })]);
  assert.deepStrictEqual([f.manual, f.packPrice, f.bultoPrice], [undefined, undefined, undefined]);
});

test('modoPack ninguno: pack vacío sin error, aviso ni revisar; CSV con cabecera exacta', () => {
  const r = armar(fila({ modoPack: 'ninguno' }));
  assert.deepStrictEqual([r.filas[0].pack_qty, r.filas[0].pack_price, r.filas[0].bulto_price, r.errores.length, r.revisar.length, r.avisos.length],
    ['', '', 900, 0, 0, 0]);
  assert.ok(C.generarCsv(r.filas).startsWith('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n100,S,Miel,,,32u,900\n'));
  assert.strictEqual(armar(fila({ modoPack: 'ninguno', packQty: 'media docena' })).errores.length, 0);
});

test('importar Excel: sin Codigo Pack ni pack_price → ninguno; si no → plu', () => {
  const p = C.filasDesdePlanilla([{ cod: '1', nombre: 'a', pack_qty: '', pack_price: '', bulto_qty: '2u', bulto_price: 5 },
    { cod: '2', nombre: 'b', pack_qty: '6u', pack_price: 9 }, { cod: '3', nombre: 'c', 'Codigo Pack': '33' }]).filas;
  assert.deepStrictEqual(p.map(f => f.modoPack), ['ninguno', 'plu', 'plu']);
});

test('vínculos: ninguno no figura como pack sin vincular', () => {
  const v = C.resumenVinculos(C.validarTabla([fila({ modoPack: 'ninguno', cod: '5' }), fila({ cod: '7' })]), new Map());
  assert.deepStrictEqual(v.sinVincular.map(x => x.faltan), [['bulto'], ['pack', 'bulto']]);
  assert.strictEqual(v.manuales, undefined);
});

test('comparación: catálogo armado vs último publicado, por cod+tipo; conSiga/conRespaldo', () => {
  const pub = C.parsearCsv('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n100,S,Miel,12u,1000,32u,900\n200,S,Vieja,,,5u,50\n');
  const d = C.compararConPublicado(pub, armar(fila({})).filas);
  const por = Object.fromEntries(d.detalle.map(x => [`${x.cod}:${x.tipo}`, x]));
  assert.deepStrictEqual([por['100:pack'].publicado, por['100:pack'].sistema, por['100:pack'].origen, por['100:pack'].estado], [1000, 1000, 'siga', 'igual']);
  assert.deepStrictEqual([por['100:bulto'].estado, por['100:bulto'].pct], ['igual', 0]);
  assert.deepStrictEqual([por['200:bulto'].estado, por['200:bulto'].sistema, por['200:bulto'].publicado], ['quitado', null, 50]);
  assert.strictEqual(por['200:pack'], undefined);
  assert.deepStrictEqual([d.conSiga, d.conRespaldo, d.conDecision, d.conVigente], [2, 0, undefined, undefined]);
  const c = C.compararConPublicado(C.parsearCsv('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n100,S,Miel,12u,800,32u,\n'),
    armar(fila({})).filas);
  const pc = Object.fromEntries(c.detalle.map(x => [x.tipo, x]));
  assert.deepStrictEqual([pc.pack.estado, pc.pack.pct, pc.bulto.estado], ['cambió', 25, 'sin dato']);
  assert.deepStrictEqual([c.iguales, c.cambiaron, c.sinDato, c.nuevos, c.quitados], [0, 1, 1, 0, 0]);
  const n = C.compararConPublicado([], armar(fila({ modoPack: 'ninguno' })).filas);
  assert.deepStrictEqual(n.detalle.map(x => [x.tipo, x.estado]), [['bulto', 'nuevo']]);
});

test('validarTabla: cod no numérico se rechaza', () => {
  assert.throws(() => C.validarTabla([{ cod: 'ABC', seccion: 'S', nombre: 'n', bultoQty: '1u' }]), /cod debe ser numérico/);
});

test('filasDesdePlanilla: cod no numérico se descarta', () => {
  const r = C.filasDesdePlanilla([{ cod: '1', nombre: 'a' }, { cod: 'PALLET', nombre: 'b', bulto_price: 5 }]);
  assert.deepStrictEqual(r.filas.map(f => f.cod), ['1']);
  assert.deepStrictEqual(r.descartadas, [3]);
});
