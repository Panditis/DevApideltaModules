'use strict';
// Export a SIGA con una presentación mayorista de Fraccionado: el pack/bulto vinculado sale con el precio por descuento
// (spec precios_fraccionado_mayorista_activar); desde 2026-11-04 también el de una presentación minorista (sin tablas pack/bulto).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');

// Ejemplo de control: costo 1000, margen 40 %, extras 0, IVA 21 %, redondeo 50, desc 10/10.
const T40 = { minPct: 40, maxPct: 40, escalones: 1, rango: { desde: 1, hasta: 2 } };
const CFG = { ivaVentaPct: 21, toleranciaPct: 5, modoGastos: 'costo', gastosVenta: [], extrasMinorista: [],
  margenes: { minorista: T40, pack: T40, bulto: T40 }, redondeo: { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 } };
const VINC = [{ tipo: 'pack', plu: '201', nombre: 'Pack 201', unidades: 25, vigente: null }, { tipo: 'bulto', plu: '202', nombre: 'Bulto 202', unidades: 25, vigente: null }];

const presentacion = variante => ({ ...L.filaProducto({ plu: '101', nombre: 'Almendras 25Kg', tipo: 'fraccionado',
  costos: { sistema: 1000, ultimaCompra: null, manual: null }, pesoG: 25000, mayoristas: VINC, cfg: CFG, variante }), mayorista: variante === 'mayorista' });
const exportar = variante => {
  const granel = { plu: '100', nombre: 'Almendras', costoSistema: 1000, sugeridos: {}, mayoristas: [], presentaciones: [presentacion(variante)], decision: { fuente: 'sistema' } };
  return L.listasExport(L.itemsDecididos({ fraccionado: [granel] }).items);
};
const venta = (lista, plu) => (lista.find(f => String(f[0]) === plu) || [])[3];

test('export: presentación mayorista → pack/bulto vinculados con el precio por descuento (31500/38100 y 28350/34300)', () => {
  const l = exportar('mayorista');
  assert.deepStrictEqual([venta(l.packNeto, '201'), venta(l.packIva, '201')], [31500, 38100]);
  assert.deepStrictEqual([venta(l.bultoNeto, '202'), venta(l.bultoIva, '202')], [28350, 34300]);
});

test('export: la misma presentación minorista → pack/bulto TAMBIÉN por descuento (tablas pack/bulto ya no se usan); Venta minorista 1700', () => {
  const min = exportar('minorista'), may = exportar('mayorista');
  assert.strictEqual(venta(min.packNeto, '201'), 31500); // 1400 × 0,9 × 25 (antes 35000 con la tabla 40 %)
  assert.strictEqual(venta(min.bultoNeto, '202'), 28350); // 1260 × 0,9 × 25
  assert.deepStrictEqual([venta(min.packIva, '201'), venta(min.bultoIva, '202')], [venta(may.packIva, '201'), venta(may.bultoIva, '202')]);
  assert.strictEqual(venta(min.minorista, '101'), 1700);
  assert.strictEqual(venta(may.minorista, '101'), undefined); // sin IVA: no se exporta (EXPORTAR_MAYORISTA_SIN_IVA)
  assert.strictEqual(min.minorista.length, may.minorista.length + 1);
});

// Mayorista con descuento (minorista.sinIva): no sale en el export a SIGA hasta definir la lista (EXPORTAR_MAYORISTA_SIN_IVA).
test('export: mayorista con descuento → fuera de toda lista, cuenta en omitidosMayorista; vinculados siguen', () => {
  const granel = { plu: '100', nombre: 'Almendras', costoSistema: 1000, sugeridos: {}, mayoristas: [], presentaciones: [presentacion('mayorista')], decision: { fuente: 'sistema' } };
  const r = L.itemsDecididos({ fraccionado: [granel] });
  assert.strictEqual(r.omitidosMayorista, 1);
  assert.deepStrictEqual(r.omitidosDetalle, [{ plu: '101', nombre: 'Almendras 25Kg', motivo: 'mayoristaSinIva' }]);
  const l = L.listasExport(r.items);
  for (const lista of L.LISTAS_EXPORT) assert.strictEqual(venta(l[lista], '101'), undefined, lista);
  assert.strictEqual(venta(l.packNeto, '201'), 31500);
  assert.strictEqual(venta(l.bultoIva, '202'), 34300);
});

test('export: mayorista tipo pack también queda fuera (sinIva); con el flag sale 1250 sin IVA', () => {
  const granel = { plu: '100', nombre: 'Almendras', costoSistema: 1000, sugeridos: {}, mayoristas: [], presentaciones: [presentacion('pack')], decision: { fuente: 'sistema' } };
  const r = L.itemsDecididos({ fraccionado: [granel] });
  assert.strictEqual(r.omitidosMayorista, 1);
  assert.strictEqual(venta(L.listasExport(r.items).packNeto, '201'), 31500);
  assert.strictEqual(venta(L.listasExport(L.itemsDecididos({ fraccionado: [granel] }, { exportarMayoristaSinIva: true }).items).minorista, '101'), 1250);
});

test('export: con exportarMayoristaSinIva=true la mayorista vuelve a salir (1150 sin IVA)', () => {
  const granel = { plu: '100', nombre: 'Almendras', costoSistema: 1000, sugeridos: {}, mayoristas: [], presentaciones: [presentacion('mayorista')], decision: { fuente: 'sistema' } };
  const r = L.itemsDecididos({ fraccionado: [granel] }, { exportarMayoristaSinIva: true });
  assert.strictEqual(r.omitidosMayorista, 0);
  assert.strictEqual(venta(L.listasExport(r.items).minorista, '101'), 1150);
});

test('export: mayorista sin sinIva (margen fijo), minorista y granel salen como siempre; contador en 0', () => {
  const pres = (plu, mayorista) => ({ plu, nombre: 'P' + plu, mayorista, mayoristas: [], sugeridos: { sistema: { minorista: { precio: 2000 }, mayoristas: [] } } });
  const granel = { plu: '100', nombre: 'Granel', costoSistema: 1000, mayoristas: [], decision: { fuente: 'sistema' },
    sugeridos: { sistema: { minorista: { precio: 1500 }, mayoristas: [] } }, presentaciones: [pres('110', true), pres('111', false)] };
  const r = L.itemsDecididos({ fraccionado: [granel] });
  assert.strictEqual(r.omitidosMayorista, 0);
  assert.deepStrictEqual(r.omitidosDetalle, []);
  const l = L.listasExport(r.items);
  assert.deepStrictEqual(['110', '111', '100'].map(p => venta(l.minorista, p)), [2000, 2000, 1500]);
});

// 2026-11-05: pack/bulto de una presentación NO mayorista = por paquete (unidades = peso); de una mayorista = por kilo (unidades 1).
// El costo exportado va × unidades, coherente con su precio.
test('export: bulto de una 100G va por paquete (costo × 0,1) y el de una mayorista por kilo (costo × 1)', () => {
  const { CFG: CFGF } = require('./precios_esquema_fixture');
  const FC = require('../lib/precios_fraccionado_costo');
  const vinculos = [{ plu: '301', nombre: 'Bulto 100G', basePlu: '101', cantidad: 10, tipo: 'bulto' }, { plu: '305', nombre: 'Bulto 5Kg', basePlu: '105', cantidad: 1, tipo: 'bulto' }];
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Chia', presentaciones: [{ plu: '101', nombre: 'Chia 100G' }, { plu: '105', nombre: 'Chia 5Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes: new Map() }), costeo: {}, cfg: CFGF,
    costeoF: FC.normalizarCosteoFraccionado({ costoHora: 6000, mayorista: { pesoMinG: 5000, porPlu: {} } }),
  });
  const { items } = L.itemsDecididos({ fraccionado: [{ ...g, decision: { fuente: 'sistema' } }] });
  const listas = L.listasExport(items);
  const fila = plu => listas.bultoNeto.find(r => r[0] === Number(plu));
  const it = plu => items.find(i => i.mayoristas.some(m => m.plu === plu));
  const m = plu => it(plu).mayoristas.find(x => x.plu === plu);
  assert.deepStrictEqual([m('301').unidades, m('305').unidades], [0.1, 1]);
  assert.strictEqual(fila('301')[2], Math.round(it('301').costo * 0.1 * 100) / 100);
  assert.strictEqual(fila('305')[2], Math.round(it('305').costo * 100) / 100);
  // Coherencia: el bulto de la 100G cuesta y vale ~0,1 de lo mismo por kilo (precio y costo escalan igual).
  const pkg = it('301').mayoristas.find(x => x.plu === '301');
  assert.ok(pkg.neto > 0 && pkg.neto < it('301').costo, 'precio del paquete de 100 g menor al costo de 1 kg');
  assert.ok(fila('301')[3] / fila('301')[2] > 1, 'margen positivo sobre el costo × 0,1');
});
