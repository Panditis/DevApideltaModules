'use strict';
// Contrato back↔front de la presentación mayorista de Fraccionado (caso de control: costo 1000, margen 40 %, IVA 21 %, 10/10,
// vigente 1700 con IVA). Los test con { todo } reproducen bugs reportados por QA: no rompen la suite hasta que se arreglen.
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');
const MD = require('../public/js/precios_modal_fraccionado.js');

const T40 = { minPct: 40, maxPct: 40, escalones: 1, rango: { desde: 1, hasta: 2 } };
const CFG = { ivaVentaPct: 21, toleranciaPct: 5, modoGastos: 'costo', gastosVenta: [], extrasMinorista: [],
  margenes: { minorista: T40, pack: T40, bulto: T40 }, redondeo: { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 } };
const filaCtrl = () => ({ ...L.filaProducto({ plu: '1', nombre: 'X 25Kg', tipo: 'fraccionado', costos: { sistema: 1000, ultimaCompra: null, manual: null },
  vigente: 1700, cfg: CFG, variante: 'mayorista' }), mayorista: true });

test('contrato: sugeridos.minorista trae precio, Δ, minoristaOriginal, pack y bulto que lee el front', () => {
  const m = filaCtrl().sugeridos.sistema.minorista;
  assert.strictEqual(m.precio, 1150);
  assert.strictEqual(m.minoristaOriginal, 1700);
  assert.deepStrictEqual(Object.keys(m.pack).sort(), ['conIva', 'margenPct', 'neto']);
  assert.deepStrictEqual(Object.keys(m.bulto).sort(), ['conIva', 'margenPct', 'neto']);
  assert.strictEqual(m.pack.conIva, 1500);
  for (const k of ['margenTotalPct', 'deltaPct', 'estado']) assert.ok(k in m, k);
});

test('contrato 2026-11-04: tipoMayorista en minorista y desglose; mayoristaTipo en la fila pública; pack → sugerido = pack neto', () => {
  const FC = require('../lib/precios_fraccionado_costo');
  const filaTipo = variante => L.filaProducto({ plu: '1', nombre: 'X 25Kg', tipo: 'fraccionado', costos: { sistema: 1000, ultimaCompra: null, manual: null },
    vigente: 1700, cfg: CFG, variante }).sugeridos.sistema;
  const pk = filaTipo('pack'), bu = filaTipo('bulto');
  assert.deepStrictEqual([pk.minorista.tipoMayorista, pk.desglose.minorista.tipoMayorista, pk.minorista.precio, pk.minorista.sinIva], ['pack', 'pack', 1250, true]);
  assert.deepStrictEqual([bu.minorista.tipoMayorista, bu.desglose.minorista.tipoMayorista, bu.minorista.precio], ['bulto', 'bulto', 1150]);
  for (const s of [pk, bu]) {
    for (const k of ['pack', 'bulto', 'minoristaOriginal', 'minoristaOriginalNeto', 'vigenteNeto', 'deltaPct', 'estado', 'margenTotalPct']) assert.ok(k in s.minorista, k);
    assert.strictEqual(s.minorista.vigenteNeto, 1700); // vigente de SIGA tal cual (mayorista ya sin IVA)
  }
  assert.strictEqual(filaTipo('minorista').minorista.tipoMayorista, undefined);
  const grupos = [{ plu: '700', nombre: 'G', presentaciones: [{ plu: '701', nombre: 'G 500G' }, { plu: '702', nombre: 'G 5Kg' }] }];
  const fila = L.listadoFraccionado({ grupos, costos: new Map([['700', { costoSistema: 1000 }]]), vigentes: new Map(), costeo: {}, cfg: CFG,
    costeoF: FC.normalizarCosteoFraccionado({ mayorista: { pesoMinG: 5000, porPlu: { 701: 'pack' } } }), mayoristasDe: () => [] })[0];
  const pub = L.filaPublica(fila).presentaciones.map(p => [p.plu, p.mayorista, p.mayoristaOrigen, p.mayoristaTipo]);
  assert.deepStrictEqual(pub, [['701', true, 'manual', 'pack'], ['702', true, 'peso', 'bulto']]);
});

test('modal: fila del minorista mayorista muestra el vigente de SIGA tal cual (sin restar IVA)', () => {
    const r = MD.filasPreciosFraccMd(filaCtrl(), 'sistema')[0];
    assert.strictEqual(r.vigente, 1700);
    assert.ok(r.deltaPesos < 0 === r.deltaPct < 0, 'Δ$ y Δ% con el mismo signo');
  });

test('BUG modal "Cómo se conforma": pack con IVA y exactos de pack/bulto', () => {
    const pasos = MD.pasosMinoristaFraccMd(filaCtrl().sugeridos.sistema.desglose, 'Costo');
    const v = txt => pasos.find(p => p[1].startsWith(txt))[2];
    assert.strictEqual(v('Precio pack con IVA'), 1500);
    assert.ok(pasos.every(p => p[0] !== '×' || p[2] != null), 'cada × lleva su importe');
  });
