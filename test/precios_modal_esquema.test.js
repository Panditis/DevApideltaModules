'use strict';
// Contrato server → modal: las filas por canal salen de lo que manda el detalle (lib/precios_listado_esquema filaPublica).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../lib/precios_listado_esquema');
const { filasCanales } = require('../public/js/precios_modal_esquema.js');
const { CFG } = require('./precios_esquema_fixture');

// Pack/bulto en SIGA = precio por unidad (unidades 1): el vigente del bulto es el de 1 unidad.
const vigentes = new Map([['1', 1800], ['50', 1750]]);
const vinculos = [{ plu: '50', nombre: 'Arroz Bulto x6', basePlu: '1', cantidad: 6, tipo: 'bulto' }];

test('filasCanales: minorista + bulto sin y con IVA de la fuente elegida; fuente sin costo → sin sugeridos', () => {
  const [f] = L.listadoReventa({ universo: [{ plu: '1', nombre: 'Arroz', costoSistema: 1000 }], vigentes,
    mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes }), costeo: {}, cfg: CFG });
  const pub = L.filaPublica(f);
  assert.deepStrictEqual(filasCanales(pub, 'sistema').map(r => [r.canal, r.plu, r.vigente, r.sugerido, r.deltaPct]), [
    ['Minorista', '1', 1800, 1800, 0], ['Bulto sin IVA', '50', null, 1430, null], ['Bulto con IVA', '50', 1750, 1750, 0]]);
  assert.deepStrictEqual(filasCanales(pub, 'ultimaCompra').map(r => r.sugerido), [null, null, null]);
});

test('filasCanales Fraccionado: una fila minorista por presentación; el granel no tiene minorista', () => {
  const [g] = L.listadoFraccionado({
    grupos: [{ plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }, { plu: '102', nombre: 'Almendras 1Kg' }] }],
    costos: new Map([['100', { costoSistema: 1000 }]]), vigentes: new Map(), mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }),
    costeo: {}, cfg: CFG,
  });
  assert.deepStrictEqual(filasCanales(L.filaPublica(g), 'sistema').map(r => [r.canal, r.plu, r.sugerido]),
    [['Minorista · Almendras 500G', '101', 1950], ['Minorista · Almendras 1Kg', '102', 1800]]);
});
