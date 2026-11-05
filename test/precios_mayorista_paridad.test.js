'use strict';
// Paridad: el front reclasifica local (conMarcaMayoristaGranelLst, 1 presentación) lo mismo que el server (esMayoristaPresentacion). Si una cambia, esto falla.
// Además: export a SIGA con Almacén + Fraccionado mantiene encabezado y orden (Almacén, presentaciones, granel al final).
const test = require('node:test');
const assert = require('node:assert');
const { esMayoristaPresentacion } = require('../lib/precios_fraccionado_costo');
const { conMarcaMayoristaGranelLst } = require('../public/js/precios_listados.js');
const L = require('../lib/precios_listado_esquema');

test('paridad front/back: misma clasificación para pesos, umbrales y marcas', () => {
  for (const pesoG of [null, 0, 1, 499, 500, 501, 5000])
    for (const pesoMinG of [null, 1, 500, 5000])
      for (const marca of [undefined, true, false, 'pack', 'bulto']) {
        const porPlu = marca === undefined ? {} : { 7: marca };
        const back = esMayoristaPresentacion(pesoG, '7', { pesoMinG, porPlu });
        const front = conMarcaMayoristaGranelLst([{ plu: '7', pesoG }], '7', marca === undefined ? null : marca, pesoMinG)[0];
        assert.deepStrictEqual({ mayorista: front.mayorista, origen: front.mayoristaOrigen, tipo: front.mayoristaTipo }, back, JSON.stringify({ pesoG, pesoMinG, marca }));
      }
});

test('una sola regla: el back re-exporta la de precios_esquema (la que usa el front)', () => {
  assert.strictEqual(esMayoristaPresentacion, require('../lib/precios_esquema').esMayoristaPresentacion);
});

test('export SIGA: encabezado Codigo|Nombre|Costo|Venta y orden almacén → presentaciones → granel', () => {
  const sug = precio => ({ minorista: { precio }, mayoristas: [] });
  const almacen = [{ plu: '50', nombre: 'Yerba', costoSistema: 10, sugeridos: { sistema: sug(20) }, mayoristas: [], decision: { fuente: 'sistema' } }];
  const fraccionado = [{ plu: '100', nombre: 'Nuez', costoSistema: 1000, sugeridos: { sistema: sug(1800) }, mayoristas: [], decision: { fuente: 'sistema' },
    presentaciones: [{ plu: '101', nombre: 'Nuez 100G', sugeridos: { sistema: sug(250) }, mayoristas: [], mayorista: true }] }];
  const { items } = L.itemsDecididos({ almacen, fraccionado });
  assert.deepStrictEqual(L.listasExport(items).minorista,
    [['Codigo', 'Nombre', 'Costo', 'Venta'], [50, 'Yerba', 10, 20], [101, 'Nuez 100G', 1000, 250], [100, 'Nuez', 1000, 1800]]);
});

// Regla pack/bulto por granel (2026-11-05): front (conMarcaMayoristaGranelLst) = back (listadoFraccionado vía mayoristasDeGranel) y el export toma el tipo.
const FC = require('../lib/precios_fraccionado_costo');
const { mayoristasDeGranel } = require('../lib/precios_esquema');
const T40 = { minPct: 40, maxPct: 40, escalones: 1, rango: { desde: 1, hasta: 2 } };
const CFG40 = { ivaVentaPct: 21, toleranciaPct: 5, modoGastos: 'costo', gastosVenta: [], extrasMinorista: [],
  margenes: { minorista: T40, pack: T40, bulto: T40 }, redondeo: { minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 } };
const listadoChia = (porPlu, nombres = ['Chia 5Kg', 'Chia 20Kg']) => L.listadoFraccionado({
  grupos: [{ plu: '700', nombre: 'Chia granel', presentaciones: [{ plu: '701', nombre: nombres[0] }, { plu: '702', nombre: nombres[1] }] }],
  costos: new Map([['700', { nombre: 'Chia granel', costoSistema: 1000 }]]), vigentes: new Map(), costeo: {}, cfg: CFG40,
  costeoF: FC.normalizarCosteoFraccionado({ costoHora: 6000, mayorista: { pesoMinG: 5000, porPlu } }),
  mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }) });

test('paridad granel: listadoFraccionado = mayoristasDeGranel = conMarcaMayoristaGranelLst (auto, manual, volver a auto)', () => {
  for (const porPlu of [{}, { 701: 'bulto' }, { 702: 'pack' }, { 701: 'pack', 702: 'bulto' }, { 701: false }, { 702: true }]) {
    const fila = L.filaPublica(listadoChia(porPlu)[0]);
    const back = fila.presentaciones.map(p => [p.mayorista, p.mayoristaOrigen, p.mayoristaTipo, p.mayoristaTipoOrigen]);
    const esq = mayoristasDeGranel(fila.presentaciones.map(p => ({ plu: p.plu, pesoG: p.pesoG })), { pesoMinG: 5000, porPlu });
    assert.deepStrictEqual(esq.map(m => [m.mayorista, m.origen, m.tipo, m.tipoOrigen]), back, JSON.stringify(porPlu));
    // front: partiendo de la fila automática, aplicar cada marca del porPlu una a una da lo mismo que el server
    let pres = L.filaPublica(listadoChia({})[0]).presentaciones;
    for (const [plu, v] of Object.entries(porPlu)) pres = conMarcaMayoristaGranelLst(pres, plu, v, 5000);
    assert.deepStrictEqual(pres.map(p => [p.mayorista, p.mayoristaOrigen, p.mayoristaTipo, p.mayoristaTipoOrigen]), back, 'front ' + JSON.stringify(porPlu));
  }
  // volver a automático (valor null) sobre una manual restaura la regla
  const manual = L.filaPublica(listadoChia({ 701: 'bulto' })[0]).presentaciones;
  assert.deepStrictEqual(conMarcaMayoristaGranelLst(manual, '701', null, 5000).map(p => p.mayoristaTipoOrigen), ['regla', 'regla']);
});

test('regla: presentación sin peso en el nombre (pesoG null) no rompe; la marcada a mano queda mayorista, sin regla', () => {
  const fila = L.filaPublica(listadoChia({ 701: true }, ['Chia suelta', 'Chia 20Kg'])[0]);
  assert.deepStrictEqual(Object.fromEntries(fila.presentaciones.map(p => [p.plu, [p.pesoG, p.mayoristaTipo, p.mayoristaTipoOrigen]])), { 701: [null, 'bulto', 'manual'], 702: [20000, 'bulto', 'peso-defecto'] });
});

test('export SIGA: 5Kg/20Kg del mismo granel → el sugerido sale del tipo por regla (pack / bulto) según EXPORTAR_MAYORISTA_SIN_IVA', () => {
  const granel = { ...listadoChia({})[0], decision: { fuente: 'sistema' } };
  const [p5, p20] = granel.presentaciones.map(p => p.sugeridos.sistema.minorista);
  assert.deepStrictEqual([p5.tipoMayorista, p20.tipoMayorista], ['pack', 'bulto']);
  const venta = (l, plu) => (l.minorista.find(f => String(f[0]) === plu) || [])[3];
  const off = L.itemsDecididos({ fraccionado: [granel] }); // flag vigente (false): ambas omitidas
  assert.strictEqual(off.omitidosMayorista, 2);
  assert.strictEqual(venta(L.listasExport(off.items), '701'), undefined);
  const on = L.listasExport(L.itemsDecididos({ fraccionado: [granel] }, { exportarMayoristaSinIva: true }).items);
  assert.deepStrictEqual([venta(on, '701'), venta(on, '702')], [p5.pack.neto, p20.bulto.neto]);
});
