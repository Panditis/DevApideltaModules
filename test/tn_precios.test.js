'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tn = require('../lib/tn_precios');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'tiendanube_muestra.csv'));
const CFG = { recargoPct: 10, toleranciaPct: 2, redondeoPaso: 0 };
const fila = (o = {}) => ({ clave: 'a|', url: 'a', nombre: 'A', variante: '', sku: '7', visible: true, stock: 1, precioTn: 1100, ...o });
const cartas = (precio = 1000) => new Map([['7', { precio, nombre: 'P7' }]]);

test('fixture: 170 filas / 161 con SKU / 9 sin SKU / 4 SKU repetidos', () => {
  const r = tn.parsearBajada(FIXTURE);
  assert.deepStrictEqual([r.filas.length, r.conSku, r.sinSku, r.skuRepetidos], [170, 161, 9, 4]);
});

test('variantes heredan nombre del padre y acentos sobreviven latin1', () => {
  const r = tn.parsearBajada(FIXTURE);
  const v = r.filas.filter(f => f.url === 'castanas-caju-tostada-sin-sal-w4');
  assert.ok(v.length >= 2);
  for (const f of v) assert.strictEqual(f.nombre, 'Castañas Caju Tostada sin Sal W4');
});

test('archivo vacío, no CSV o cabecera distinta: ErrorBajada', () => {
  assert.throws(() => tn.parsearBajada(Buffer.alloc(0)), tn.ErrorBajada);
  assert.throws(() => tn.parsearBajada(Buffer.from('PK\x03\x04basura')), tn.ErrorBajada);
  assert.throws(() => tn.parsearBajada(Buffer.from('Nombre;Precio;SKU\nx;1;2\n')), tn.ErrorBajada);
});

test('precios: parseo y formato', () => {
  assert.strictEqual(tn.parsearPrecio('2,700.00'), 2700);
  assert.strictEqual(tn.parsearPrecio(''), null);
  assert.strictEqual(tn.parsearPrecio('abc'), null);
  assert.strictEqual(tn.formatearPrecio(1234567.5), '1,234,567.50');
  assert.strictEqual(tn.formatearPrecio(0), '0.00');
});

test('esperado 1100 con carta 1000 y recargo 10', () => {
  assert.strictEqual(tn.precioEsperado(1000, 1, CFG), 1100);
  const r = tn.armarFila(fila(), null, cartas(), CFG);
  assert.strictEqual(r.esperado, 1100);
  assert.strictEqual(r.estado, 'ok');
  assert.strictEqual(tn.armarFila(fila(), { codigo: 7, unidades: 3 }, cartas(), CFG).esperado, 3300);
});

test('desvío justo igual a toleranciaPct = ok; apenas encima = desviada', () => {
  assert.strictEqual(tn.armarFila(fila({ precioTn: 1122 }), null, cartas(), CFG).estado, 'ok'); // +2%
  assert.strictEqual(tn.armarFila(fila({ precioTn: 1078 }), null, cartas(), CFG).estado, 'ok'); // -2%
  const d = tn.armarFila(fila({ precioTn: 1123 }), null, cartas(), CFG);
  assert.strictEqual(d.estado, 'desviada');
});

test('estados: sin_codigo (sin SKU, SKU no numérico o código inexistente), sin_precio, sin_carta', () => {
  assert.strictEqual(tn.armarFila(fila({ sku: '' }), null, cartas(), CFG).estado, 'sin_codigo');
  assert.strictEqual(tn.armarFila(fila({ sku: 'ABC' }), null, cartas(), CFG).estado, 'sin_codigo');
  assert.strictEqual(tn.armarFila(fila({ sku: '0' }), null, cartas(), CFG).estado, 'sin_codigo');
  assert.strictEqual(tn.armarFila(fila({ sku: '99' }), null, cartas(), CFG).estado, 'sin_codigo');
  assert.strictEqual(tn.armarFila(fila({ precioTn: null }), null, cartas(), CFG).estado, 'sin_precio');
  assert.strictEqual(tn.armarFila(fila(), null, cartas(0), CFG).estado, 'sin_carta');
  assert.strictEqual(tn.armarFila(fila(), null, cartas(null), CFG).estado, 'sin_carta');
});

test('combos: detección por categoría ("Combos " y "Combos , Keto"), variantes heredan; resto no', () => {
  const filas = tn.parsearBajada(FIXTURE).filas;
  const combos = filas.filter(f => f.esCombo);
  assert.ok(combos.length >= 4);
  assert.ok(combos.some(f => f.categorias === 'Combos , Keto'));
  for (const f of filas) assert.strictEqual(f.esCombo, f.nombre.startsWith('Combo'), f.clave);
  const mk = t => tn.parsearBajada(Buffer.from(`"Identificador de URL";Nombre;Categor\xedas;"Valor de propiedad 1";Precio;SKU\nx;X;${t};a;1;\nx;;;b;1;\n`, 'latin1')).filas;
  assert.deepStrictEqual(mk('COMBOS').map(f => f.esCombo), [true, true]);
  assert.deepStrictEqual(mk('C\xf3mbos').map(f => f.esCombo), [true, true]);
  assert.deepStrictEqual(mk('Keto').map(f => f.esCombo), [false, false]);
});

test('combo: suma carta × unidades con recargo, tolerancia, sin_componentes, sin_carta, sin_precio', () => {
  const c = new Map([['1', { precio: 1000, nombre: 'P1' }], ['2', { precio: 500, nombre: 'P2' }], ['3', { precio: 0, nombre: 'P3' }]]);
  const comp = [{ codigo: 1, unidades: 2 }, { codigo: 2, unidades: 1.5 }]; // 2750 × 1.1 = 3025
  const r = tn.armarCombo(fila({ precioTn: 3025 }), comp, c, CFG);
  assert.deepStrictEqual([r.esperado, r.estado, r.esCombo, r.codigo], [3025, 'ok', true, null]);
  assert.deepStrictEqual(r.componentes[0], { codigo: 1, unidades: 2, nombre: 'P1', carta: 1000 });
  assert.strictEqual(tn.armarCombo(fila({ precioTn: 3025 * 1.02 }), comp, c, CFG).estado, 'ok');
  assert.strictEqual(tn.armarCombo(fila({ precioTn: 3100 }), comp, c, CFG).estado, 'desviada');
  assert.strictEqual(tn.armarCombo(fila(), undefined, c, CFG).estado, 'sin_componentes');
  assert.strictEqual(tn.armarCombo(fila(), [], c, CFG).estado, 'sin_componentes');
  const sc = tn.armarCombo(fila(), [...comp, { codigo: 3, unidades: 1 }, { codigo: 9, unidades: 1 }], c, CFG);
  assert.deepStrictEqual([sc.estado, sc.esperado, sc.componentes[2].carta, sc.componentes[3].nombre], ['sin_carta', null, null, null]);
  assert.strictEqual(tn.armarCombo(fila({ precioTn: null }), comp, c, CFG).estado, 'sin_precio');
  assert.strictEqual(tn.armarCombo(fila({ precioTn: 3000 }), comp, c, { ...CFG, redondeoPaso: 100 }).esperado, 3000);
});

test('fila no combo: skuOriginal, codigo efectivo y vinculado', () => {
  const f = tn.armarFila(fila({ sku: '' }), { codigo: 7, unidades: 1 }, cartas(), CFG);
  assert.deepStrictEqual([f.skuOriginal, f.codigo, f.vinculado, f.esCombo], ['', 7, true, false]);
  const g = tn.armarFila(fila(), null, cartas(), CFG);
  assert.deepStrictEqual([g.skuOriginal, g.codigo, g.vinculado], ['7', 7, false]);
});

test('kpis cuenta estados y ocultas', () => {
  const filas = [{ estado: 'ok', visible: true }, { estado: 'desviada', visible: false }, { estado: 'sin_codigo', visible: true },
    { estado: 'desviada', visible: true, esCombo: true }, { estado: 'sin_componentes', visible: true, esCombo: true }];
  assert.deepStrictEqual(tn.kpis(filas), { ok: 1, desviadas: 2, sinCodigo: 1, sinCarta: 0, sinPrecio: 0, sinComponentes: 1, ocultas: 1, combos: 2, combosDesviadas: 1, sinPresentacion: 0 });
  const sd = { texto: null, kg: null, origen: 'sin_dato' };
  assert.strictEqual(tn.kpis([{ estado: 'ok', visible: true, esFraccionado: true, presentacion: sd }, { estado: 'ok', visible: true, esFraccionado: false, presentacion: sd }, { estado: 'ok', visible: true, esFraccionado: true, presentacion: { ...sd, origen: 'nombre' } }, { estado: 'sin_componentes', visible: true, esCombo: true, presentacion: sd }]).sinPresentacion, 1);
});

test('validarConfig rechaza fuera de rango y acepta límites', () => {
  assert.strictEqual(tn.validarConfig(CFG), null);
  assert.strictEqual(tn.validarConfig({ recargoPct: 0, toleranciaPct: 0, redondeoPaso: 0 }), null);
  for (const m of [null, { ...CFG, recargoPct: -1 }, { ...CFG, recargoPct: 1000 }, { ...CFG, toleranciaPct: 100 },
    { ...CFG, toleranciaPct: '2' }, { ...CFG, redondeoPaso: -5 }, { ...CFG, redondeoPaso: NaN }]) assert.ok(tn.validarConfig(m), JSON.stringify(m));
});

test('exportar con precio propio = idéntico byte a byte a las filas originales', () => {
  const { filas } = tn.parsearBajada(FIXTURE);
  const f = filas.find(x => x.url === 'castanas-caju-tostada-sin-sal-w4' && x.precioTn > 0);
  const out = tn.exportarCsv(FIXTURE, { [f.clave]: f.precioTn });
  const lineas = FIXTURE.toString('latin1').split('\n');
  const esperado = [lineas[0], ...lineas.filter(l => l.startsWith('castanas-caju-tostada-sin-sal-w4;'))].join('\n') + '\n';
  assert.ok(Buffer.from(esperado, 'latin1').equals(out));
});

test('exportar sin cambios en ninguna fila = cabecera sola; acentos de cabecera intactos', () => {
  const out = tn.exportarCsv(FIXTURE, {});
  assert.ok(out.toString('latin1').startsWith('"Identificador de URL";Nombre;Categorías;'));
});

test('al corregir solo cambia la celda Precio y solo producto con fila desviada (padre + variantes)', () => {
  const { filas } = tn.parsearBajada(FIXTURE);
  const v = filas.filter(x => x.url === 'castanas-caju-tostada-sin-sal-w4');
  const out = tn.exportarCsv(FIXTURE, { [v[0].clave]: 1234.5 });
  const reparse = tn.parsearBajada(out);
  assert.deepStrictEqual(reparse.filas.map(x => x.clave), v.map(x => x.clave));
  const orig = FIXTURE.toString('latin1').split('\n');
  const nuevo = out.toString('latin1').split('\n');
  const iPrecio = orig[0].split(';').indexOf('Precio');
  let cambiadas = 0;
  for (let i = 1; i < nuevo.length - 1; i++) {
    const o = orig.find(l => l.startsWith(nuevo[i].split(';')[0] + ';') && l.split(';')[4] === nuevo[i].split(';')[4]) || '';
    const a = o.split(';'); const b = nuevo[i].split(';');
    if (o === nuevo[i]) continue;
    cambiadas++;
    assert.deepStrictEqual(b.filter((_, j) => j !== iPrecio), a.filter((_, j) => j !== iPrecio));
    assert.strictEqual(b[iPrecio], '1,234.50');
  }
  assert.strictEqual(cambiadas, 1);
  assert.strictEqual(reparse.filas[0].precioTn, 1234.5);
  assert.strictEqual(reparse.filas[0].nombre, 'Castañas Caju Tostada sin Sal W4');
});

test('parsearPeso: g/gr/grs/gramos y kg/kgs/kilo(s), coma o punto', () => {
  const casos = { '100gr': 0.1, '500 gr': 0.5, '1kg': 1, '1 Kg': 1, '250 g': 0.25, '1,5 kg': 1.5, '2kg': 2, '300 grs': 0.3, '2 kilos': 2, '750 gramos': 0.75, '0.5 kgs': 0.5 };
  for (const [t, kg] of Object.entries(casos)) assert.strictEqual(tn.parsearPeso(t), kg, t);
  for (const t of ['', 'Membrillo', 'x6 unidades', '1 Lt', '500cc', '10 grande']) assert.strictEqual(tn.parsearPeso(t), null, t);
});

const bajada = filas => Buffer.from(`"Identificador de URL";Nombre;"Valor de propiedad 1";"Valor de propiedad 2";Precio;"Peso (kg)";SKU\n${filas.join('\n')}\n`, 'latin1');

test('presentación: Peso (kg) > propiedad > nombre > sin_dato, sin heredar del padre', () => {
  const f = tn.parsearBajada(bajada([
    'a;Nuez 1kg;500 gr;;1;0.25;7', // Peso TN manda
    'a;;200gr;;1;;7', // variante: su propiedad, no el peso del padre
    'a;;Grande;1,5 kg;1;0;7', // propiedad 2
    'b;Miel 250gr;;;1;;7', // simple: nombre
    'c;Pack x6;;;1;;7', // sin dato
  ])).filas.map(x => x.presentacion);
  assert.deepStrictEqual(f, [
    { texto: '0.25 kg (Peso TN)', kg: 0.25, origen: 'peso_tn' },
    { texto: '200gr', kg: 0.2, origen: 'propiedad' },
    { texto: '1,5 kg', kg: 1.5, origen: 'propiedad' },
    { texto: 'Miel 250gr', kg: 0.25, origen: 'nombre' },
    { texto: null, kg: null, origen: 'sin_dato' },
  ]);
});

test('esperado = carta × kg × (1+recargo) solo en Fraccionado; vínculo decimal pisa; sin_dato y Almacén usan 1', () => {
  const frac = new Map([['7', { precio: 1000, nombre: 'P7', rubro: 'Pesables Fraccionado' }]]);
  const pres = { texto: '500 gr', kg: 0.5, origen: 'propiedad' };
  const r = tn.armarFila(fila({ presentacion: pres, precioTn: 550 }), null, frac, CFG);
  assert.deepStrictEqual([r.unidades, r.unidadesManual, r.origenUnidades, r.esperado, r.estado, r.carta, r.linea, r.esFraccionado, r.presentacion],
    [0.5, null, 'presentacion', 550, 'ok', 1000, 'fraccionado', true, { ...pres, aplicada: true }]);
  const v = tn.armarFila(fila({ presentacion: pres }), { codigo: 7, unidades: 0.25 }, frac, CFG);
  assert.deepStrictEqual([v.unidades, v.unidadesManual, v.origenUnidades, v.esperado, v.presentacion.origen], [0.25, 0.25, 'vinculo', 275, 'vinculo']);
  const sinU = tn.armarFila(fila({ presentacion: pres }), { codigo: 7, unidades: null }, frac, CFG);
  assert.deepStrictEqual([sinU.unidades, sinU.unidadesManual, sinU.esperado, sinU.presentacion.origen], [0.5, null, 550, 'propiedad']);
  const sd = tn.armarFila(fila({ presentacion: { texto: null, kg: null, origen: 'sin_dato' } }), null, frac, CFG);
  assert.deepStrictEqual([sd.unidades, sd.origenUnidades, sd.esperado, sd.presentacion.origen], [1, 'defecto', 1100, 'sin_dato']);
  // Almacén (y otra línea o rubro sin dato): x1 aunque se detecte presentación; el vínculo manual sigue mandando.
  for (const rubro of ['Almacen', 'Bebidas', null]) {
    const alm = new Map([['7', { precio: 1000, nombre: 'P7', rubro }]]);
    const a = tn.armarFila(fila({ presentacion: pres }), null, alm, CFG);
    assert.deepStrictEqual([a.unidades, a.origenUnidades, a.esperado, a.linea, a.esFraccionado, a.presentacion], [1, 'defecto', 1100, rubro === 'Almacen' ? 'almacen' : 'otra', false, { ...pres, aplicada: false }]);
    assert.strictEqual(tn.armarFila(fila({ presentacion: pres }), { codigo: 7, unidades: 2 }, alm, CFG).esperado, 2200);
  }
});
