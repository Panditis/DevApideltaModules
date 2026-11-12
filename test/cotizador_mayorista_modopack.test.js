'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/cotizador_mayorista');

// Listado falso: base 100 decidida (sistema), minorista final `min` con IVA 21 %, pack 101 (999,6) y bulto 102 (900,4).
const listado = (min, extra = {}) => ({ almacen: [{ plu: '100', decision: { fuente: 'sistema' },
  mayoristas: [{ plu: '101', tipo: 'pack' }, { plu: '102', tipo: 'bulto' }],
  sugeridos: { sistema: { minorista: { precio: min }, desglose: { minorista: { ivaPct: 21 } },
    mayoristas: [{ plu: '101', neto: 999.6 }, { plu: '102', neto: 900.4 }] } }, ...extra }] });
const fila = x => ({ cod: '100', seccion: 'S', nombre: 'Miel', packQty: '12u', bultoQty: '32u', ...x });
const armar = (f, lst = listado(1210)) => C.armarCatalogo({ tabla: { filas: C.validarTabla([f]) }, indice: C.indicePrecios(lst) });

test('modoPack plu: fila vieja sin el campo sigue usando el PLU pack (regresión)', () => {
  const r = armar(fila({}));
  assert.deepStrictEqual([r.filas[0].pack_price, r.filas[0].modoPack, r.filas[0].origen.pack], [1000, 'plu', 'decision']);
  assert.strictEqual(r.filas[0].descuento, undefined);
  assert.strictEqual(C.validarTabla([fila({ modoPack: '' })])[0].modoPack, 'plu');
});

test('modoPack descuento: sobre el minorista sin IVA, redondeado', () => {
  let r = armar(fila({ modoPack: 'descuento', descuentoPack: '10' }));
  assert.strictEqual(r.filas[0].pack_price, 900);
  assert.strictEqual(r.filas[0].pack_qty, '12u');
  assert.strictEqual(r.filas[0].origen.pack, 'descuento');
  assert.deepStrictEqual(r.filas[0].descuento, { pct: 10, minoristaFinal: 1210, ivaPct: 21, minoristaNeto: 1000, pack: 900 });
  assert.strictEqual(r.filas[0].bulto_price, 900); // bulto sigue por PLU
  assert.strictEqual(armar(fila({ modoPack: 'descuento', descuentoPack: '12,5' }), listado(2420)).filas[0].pack_price, 1750);
  assert.strictEqual(armar(fila({ modoPack: 'descuento', descuentoPack: '33.3' })).filas[0].pack_price, 667);
});

test('modoPack descuento: validación del servidor', () => {
  for (const d of [0, 100, -5, 'abc', '', null, undefined, '100,0'])
    assert.throws(() => C.validarTabla([fila({ modoPack: 'descuento', descuentoPack: d })]), /^Error: Fila 1: descuentoPack inválido \(porcentaje mayor que 0 y menor que 100\)/, String(d));
  assert.throws(() => C.validarTabla([fila({ modoPack: 'x' })]), /Fila 1: modoPack inválido \(plu, descuento o ninguno\)/);
  assert.strictEqual(C.validarTabla([fila({ modoPack: 'descuento', descuentoPack: 99.9 })])[0].descuentoPack, 99.9);
});

test('modoPack descuento: sin packQty o sin minorista decidido → error y la fila no sale', () => {
  let r = armar(fila({ modoPack: 'descuento', descuentoPack: 10, packQty: '' }));
  assert.strictEqual(r.filas.length, 0);
  assert.match(r.errores[0], /sin cantidad/);
  r = armar(fila({ modoPack: 'descuento', descuentoPack: 10 }), listado(1210, { decision: null }));
  assert.strictEqual(r.filas.length, 0);
  assert.match(r.errores[0], /minorista no tiene precio decidido/);
  // sugerido con error del motor (desglose null) → tampoco hay minorista
  const conError = listado(1210); conError.almacen[0].sugeridos.sistema.error = 'costo';
  assert.match(armar(fila({ modoPack: 'descuento', descuentoPack: 10 }), conError).errores[0], /minorista/);
});

test('modoPack ninguno: pack vacío sin error, aviso ni revisar; CSV con cabecera exacta', () => {
  const r = armar(fila({ modoPack: 'ninguno' }));
  assert.deepStrictEqual([r.filas[0].pack_qty, r.filas[0].pack_price, r.filas[0].bulto_price, r.errores.length, r.revisar.length, r.avisos.length],
    ['', '', 900, 0, 0, 0]);
  assert.ok(C.generarCsv(r.filas).startsWith('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n100,S,Miel,,,32u,900\n'));
  // packQty basura no importa en 'ninguno'
  assert.strictEqual(armar(fila({ modoPack: 'ninguno', packQty: 'media docena' })).errores.length, 0);
});

test('filas manuales no llevan modoPack', () => {
  const [m] = C.validarTabla([{ cod: '9001', seccion: 'S', nombre: 'Pallet', manual: true, packQty: '', bultoQty: '10u', bultoPrice: 5, modoPack: 'descuento' }]);
  assert.strictEqual(m.modoPack, undefined);
  assert.strictEqual(m.descuentoPack, undefined);
});

test('importar Excel: sin Codigo Pack ni pack_price → ninguno; si no → plu; nunca descuento', () => {
  const p = C.filasDesdePlanilla([{ cod: '1', nombre: 'a', pack_qty: '', pack_price: '', bulto_qty: '2u', bulto_price: 5 },
    { cod: '2', nombre: 'b', pack_qty: '6u', pack_price: 9 }, { cod: '3', nombre: 'c', 'Codigo Pack': '33' }]).filas;
  assert.deepStrictEqual(p.map(f => f.modoPack), ['ninguno', 'plu', 'plu']);
});

test('vínculos: descuento y ninguno no figuran como pack sin vincular', () => {
  const v = C.resumenVinculos(C.validarTabla([fila({ modoPack: 'ninguno', cod: '5' }), fila({ modoPack: 'descuento', descuentoPack: 5, cod: '6' }),
    fila({ cod: '7' })]), new Map());
  assert.deepStrictEqual(v.sinVincular.map(x => x.faltan), [['bulto'], ['bulto'], ['pack', 'bulto']]);
});

test('comparación: catálogo armado vs último publicado, por cod+tipo', () => {
  const pub = C.parsearCsv('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n100,S,Miel,12u,900,32u,900\n200,S,Vieja,,,5u,50\n');
  const d = C.compararConPublicado(pub, armar(fila({ modoPack: 'descuento', descuentoPack: 10 })).filas);
  const por = Object.fromEntries(d.detalle.map(x => [`${x.cod}:${x.tipo}`, x]));
  assert.deepStrictEqual([por['100:pack'].publicado, por['100:pack'].sistema, por['100:pack'].origen, por['100:pack'].estado], [900, 900, 'descuento', 'igual']);
  assert.deepStrictEqual([por['100:bulto'].estado, por['100:bulto'].pct], ['igual', 0]);
  assert.deepStrictEqual([por['200:bulto'].estado, por['200:bulto'].sistema, por['200:bulto'].publicado], ['quitado', null, 50]);
  assert.strictEqual(por['200:pack'], undefined); // sin precio de ningún lado → no figura
  const c = C.compararConPublicado(C.parsearCsv('cod,seccion,nombre,pack_qty,pack_price,bulto_qty,bulto_price\n100,S,Miel,12u,800,32u,\n'),
    armar(fila({})).filas);
  const pc = Object.fromEntries(c.detalle.map(x => [x.tipo, x]));
  assert.deepStrictEqual([pc.pack.estado, pc.pack.pct, pc.bulto.estado], ['cambió', 25, 'sin dato']);
  assert.deepStrictEqual([c.iguales, c.cambiaron, c.sinDato, c.nuevos, c.quitados], [0, 1, 1, 0, 0]);
  const n = C.compararConPublicado([], armar(fila({ modoPack: 'ninguno' })).filas);
  assert.deepStrictEqual(n.detalle.map(x => [x.tipo, x.estado]), [['bulto', 'nuevo']]);
});

test('validarTabla: cod no numérico se rechaza, manual o no', () => {
  for (const manual of [true, false])
    assert.throws(() => C.validarTabla([{ cod: 'ABC', seccion: 'S', nombre: 'n', manual, bultoQty: '1u', bultoPrice: 5 }]), /cod debe ser numérico/);
  assert.strictEqual(C.validarTabla([{ cod: '9001', seccion: 'S', nombre: 'n', manual: true, bultoQty: '1u', bultoPrice: 5 }])[0].bultoPrice, 5);
});

test('filasDesdePlanilla: cod no numérico se descarta (no crea manual)', () => {
  const r = C.filasDesdePlanilla([{ cod: '1', nombre: 'a' }, { cod: 'PALLET', nombre: 'b', bulto_price: 5 }]);
  assert.deepStrictEqual(r.filas.map(f => f.cod), ['1']);
  assert.deepStrictEqual(r.descartadas, [3]);
  assert.ok(!r.filas.some(f => f.manual));
});
