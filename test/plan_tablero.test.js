'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { pesoPresentacionKg, armarTablero } = require('../lib/plan_tablero');

test('pesoPresentacionKg: texto de la presentación, base, fórmula, enKg', () => {
  assert.strictEqual(pesoPresentacionKg({ presentacion: '250G' }), 0.25);
  assert.strictEqual(pesoPresentacionKg({ presentacion: '1KG' }), 1);
  assert.strictEqual(pesoPresentacionKg({ presentacion: '10 kg' }), 10);
  assert.strictEqual(pesoPresentacionKg({ presentacion: '1,5Kg' }), 1.5);
  assert.strictEqual(pesoPresentacionKg({ presentacion: '500gr' }), 0.5);
  assert.strictEqual(pesoPresentacionKg({ presentacion: 'Unidad', baseNombre: 'Alfajor 70G' }), 0.07);
  assert.strictEqual(pesoPresentacionKg({ presentacion: 'Unidad' }, { pesoFormula: 0.3 }), 0.3);
  assert.strictEqual(pesoPresentacionKg({ presentacion: 'Unidad' }), null);
  assert.strictEqual(pesoPresentacionKg({ presentacion: '250G' }, { enKg: true }), 1);
});

const m = obj => new Map(Object.entries(obj));
function datos() {
  const it = (plu, productoRef, presentacion, esVariante = false) => ({ plu, producto: `${productoRef} ${presentacion}`, baseNombre: `${productoRef} ${presentacion}`, presentacion, esVariante, refId: 1, productoRef });
  return {
    catalogo: [
      it(1, 'Pepas Membrillo', '250G'), it(2, 'Pepas Membrillo', '500G'), it(3, 'Pepas Membrillo', '250G', true),
      it(4, 'Pepas Batata', '250G'), it(5, 'Mix Europeo', '1Kg'), it(6, 'Miel Fason', '250G'), it(8, 'Viejo', '1Kg'),
      it(9, 'Pausado X', '1Kg'), it(10, 'G. Almendra', 'G. Almendra'), it(11, 'Sin Peso', 'Unidad'), it(12, 'Huerfana', '1Kg'),
    ],
    gruposCfg: {
      'Pepas Membrillo': { tipo: 'granel', granelPlu: '100', estado: 'activo', responsables: ['Ana'], proximaFecha: '2026-10-28' },
      'Pepas Batata': { tipo: 'granel', granelPlu: '100', estado: 'pausado', motivo: 'Máquina rota' },
      'Mix Europeo': true,
      'Miel Fason': { tipo: 'directo', estado: 'activo', clienteId: 7 },
      Viejo: false,
      'Pausado X': { tipo: 'directo', estado: 'pausado', motivo: 'Falta MP' },
      'G. Almendra': true,
      'Sin Peso': true,
      Huerfana: { tipo: 'granel', granelPlu: '200', estado: 'activo' },
    },
    granelesBase: { 100: { nombre: 'Masa pepas', estado: 'activo', responsables: ['Juan'] } },
    enKgRefs: new Set(['G. Almendra']),
    ventas: m({ 1: 1200, 2: 240, 3: 120, 5: 360, 10: 60 }),
    factur: m({ 1: 1000, 5: 500, 10: 100 }),
    stockCentral: m({ 1: 100, 2: 10, 3: 999, 5: 100, 6: 40 }),
    stockSuc: m({ 1: 40 }),
    stockGranel: m({ 100: 20 }),
    bomGranel: new Map([['1', [{ granelPlu: '100', cantPorUnidad: 0.2 }]], ['2', [{ granelPlu: '100', cantPorUnidad: 0.4 }]], ['3', [{ granelPlu: '100', cantPorUnidad: 2.4 }]]]),
    nombres: new Map(),
    clientes: [{ id: 7, nombre: 'Melar' }],
  };
}
const opts = { dias: 30, ventana: 120 };
const nombre = f => (f.nivel === 'granel' ? f.nombre : f.productoRef);

test('armarTablero: orden por urgencia, pausados al final, sin discontinuados ni fasón', () => {
  const t = armarTablero(datos(), opts);
  assert.strictEqual(t.dias, 30);
  assert.strictEqual(t.ventana, 120);
  assert.deepStrictEqual(t.filas.map(nombre), ['G. Almendra', 'Masa pepas', 'Mix Europeo', 'Sin Peso', 'Huerfana', 'Pausado X']);
});

test('armarTablero: variedad en kg — venta/día, stock central (sin variantes), locales informativo, estimado', () => {
  const granel = armarTablero(datos(), opts).filas.find(f => f.nivel === 'granel');
  const v = granel.variedades[0];
  assert.strictEqual(v.productoRef, 'Pepas Membrillo');
  assert.strictEqual(v.ventaDiaKg, 3.75);      // (1200×0.25 + 240×0.5 + 120×0.25) / 120
  assert.strictEqual(v.stockCentralKg, 30);    // 100×0.25 + 10×0.5 (la variante 3 no suma stock)
  assert.strictEqual(v.stockLocalesKg, 10);
  assert.strictEqual(v.coberturaDias, 8);
  assert.strictEqual(v.estimadoKg, 82.5);      // 3.75×30 − 30 (locales no restan)
  assert.deepStrictEqual(v.ratios, { 100: 0.8 }); // la variante (bulto) no entra al ratio
  assert.deepStrictEqual(v.responsables, ['Ana']);
  assert.strictEqual(v.proximaFecha, '2026-10-28');
  assert.strictEqual(v.urgencia, 'PRONTO');    // clase A, cobertura (30+10)/3.75 = 10.7 < 14
  assert.strictEqual(v.rankingPos, 1);
  assert.deepStrictEqual(v.presentaciones.map(p => [p.plu, p.pesoKg, p.ventasKg]), [['1', 0.25, 330], ['2', 0.5, 120]]);
});

test('armarTablero: fila de granel — Σ necesario × ratio − stock granel, pausadas no suman', () => {
  const g = armarTablero(datos(), opts).filas.find(f => f.nivel === 'granel');
  assert.strictEqual(g.plu, '100');
  assert.strictEqual(g.stockGranelKg, 20);
  assert.strictEqual(g.granelNecesarioKg, 66);  // 82.5 × 0.8
  assert.strictEqual(g.estimadoKg, 46);
  assert.strictEqual(g.ventaDiaKg, 3);
  assert.strictEqual(g.coberturaDias, 6.7);
  assert.strictEqual(g.urgencia, 'PRONTO');
  assert.deepStrictEqual(g.responsables, ['Juan']);
  assert.deepStrictEqual(g.variedades.map(v => [v.productoRef, v.estado]), [['Pepas Membrillo', 'activo'], ['Pepas Batata', 'pausado']]);
  assert.strictEqual(g.variedades[1].motivo, 'Máquina rota');
});

test('armarTablero: directo, enKg, sin peso, granel sin configurar', () => {
  const f = Object.fromEntries(armarTablero(datos(), opts).filas.filter(x => x.nivel === 'producto').map(x => [x.productoRef, x]));
  assert.strictEqual(f['Mix Europeo'].estimadoKg, 0);          // 3×30 − 100 < 0
  assert.strictEqual(f['Mix Europeo'].urgencia, 'OK');
  assert.strictEqual(f['Mix Europeo'].stockGranelKg, null);
  assert.strictEqual(f['G. Almendra'].ventaDiaKg, 0.5);         // enKg: 60 kg / 120
  assert.strictEqual(f['G. Almendra'].estimadoKg, 15);
  assert.strictEqual(f['G. Almendra'].urgencia, 'URGENTE');
  assert.deepStrictEqual(f['Sin Peso'].sinPeso, ['11']);
  assert.strictEqual(f.Huerfana.granelSinConfigurar, true);
  assert.strictEqual(f['Pausado X'].estado, 'pausado');
  assert.ok(!('Viejo' in f));
});

test('armarTablero: fasón agrupado por cliente, sin estimado', () => {
  const t = armarTablero(datos(), opts);
  assert.deepStrictEqual(t.fason.map(g => [g.cliente, g.filas.map(x => x.productoRef)]), [['Melar', ['Miel Fason']]]);
  assert.strictEqual(t.fason[0].filas[0].estimadoKg, null);
  assert.strictEqual(t.fason[0].filas[0].stockCentralKg, 10);
  assert.ok(!t.filas.some(x => x.productoRef === 'Miel Fason'));
});

test('armarTablero: granel discontinuado → sus variedades quedan sueltas con aviso', () => {
  const d = datos();
  d.granelesBase = { 100: { estado: 'discontinuado' } };
  const t = armarTablero(d, opts);
  assert.ok(!t.filas.some(x => x.nivel === 'granel'));
  assert.strictEqual(t.filas.find(x => x.productoRef === 'Pepas Membrillo').granelSinConfigurar, true);
});

test('armarTablero: granel sin nombre usa el de SIGA; stock negativo cuenta 0', () => {
  const d = datos();
  d.granelesBase = { 100: {} };
  d.nombres = new Map([['100', 'MASA PEPAS DEPOSITO GRANEL']]);
  d.stockGranel = m({ 100: -5 });
  const g = armarTablero(d, opts).filas.find(x => x.nivel === 'granel');
  assert.strictEqual(g.nombre, 'MASA PEPAS DEPOSITO GRANEL');
  assert.strictEqual(g.stockGranelKg, 0);
  assert.strictEqual(g.estimadoKg, 66);
});

test('armarTablero: el mismo PLU repetido en el catálogo cuenta una sola vez', () => {
  const d = datos();
  d.catalogo.push({ ...d.catalogo[0] }); // PLU 1 (250G con peso) duplicado en el mismo productoRef
  const v = armarTablero(d, opts).filas.find(f => f.nivel === 'granel').variedades[0];
  assert.strictEqual(v.ventaDiaKg, 3.75);
  assert.strictEqual(v.stockCentralKg, 30);
  assert.deepStrictEqual(armarTablero(d, opts), armarTablero(datos(), opts));
});

test('armarTablero: dos PLU base con el mismo baseNombre → una presentación con el PLU más vendido', () => {
  const d = datos();
  const mix = plu => ({ plu, producto: 'Mix Cervecero 200G', baseNombre: 'Mix Cervecero 200G', presentacion: '200G', esVariante: false, refId: 1, productoRef: 'Mix Cervecero' });
  const fila = t => t.filas.find(f => f.productoRef === 'Mix Cervecero');
  d.catalogo.push(mix(13), mix(14));
  d.gruposCfg['Mix Cervecero'] = true;
  d.stockCentral.set('13', 10);
  d.stockCentral.set('14', 20);
  d.ventas.set('13', 120);
  d.ventas.set('14', 360);
  let f = fila(armarTablero(d, opts));
  assert.strictEqual(f.presentaciones.length, 1);
  assert.strictEqual(f.presentaciones[0].plu, '14');     // 360 u vendidas contra 120
  assert.strictEqual(f.presentaciones[0].pesoKg, 0.2);
  assert.strictEqual(f.presentaciones[0].ventasKg, 96);  // las ventas siguen sumando: (120+360)×0.2
  assert.strictEqual(f.stockCentralKg, 6);                // y el stock también: (10+20)×0.2
  d.ventas.set('13', 360); // empate → el primero del catálogo
  assert.strictEqual(fila(armarTablero(d, opts)).presentaciones[0].plu, '13');
  d.ventas.delete('13');
  d.ventas.delete('14'); // sin ventas → el primero
  f = fila(armarTablero(d, opts));
  assert.strictEqual(f.presentaciones[0].plu, '13');
});
