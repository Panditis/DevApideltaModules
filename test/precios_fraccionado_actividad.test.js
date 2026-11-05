'use strict';
// Actividad de graneles de Fraccionado (spec 2026-10-26-precios-fraccionado-activos-reefer): casos que faltaban en los tests
// de cada módulo. movimientosRecientes con más de 1000 PLUs; venta directa que es su propio granel; contrato back → front
// (lo que arma listadoFraccionado, tras filaPublica y JSON, es lo que leen los filtros, badges y el modal).
const test = require('node:test');
const assert = require('node:assert');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const L = require('../lib/precios_listado_esquema');
const { CFG } = require('./precios_esquema_fixture');
const { filtrarFilas, contarOcultables, htmlBadgesActividadLst, filasExportListado } = require('../public/js/precios_listados.js');
const { activoGuardadoFr, estadoDeActivoFr } = require('../public/js/precios_config_fraccionado.js');

const deps = { LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' };
const plusDelIn = sql => ((sql.match(/d\.IdProducto IN \(([^)]*)\)/) || [])[1] || '').match(/\d+/g) || [];

test('movimientosRecientes: 1201 PLUs → 3 tandas (500 + 500 + 201) sin repetir ni perder PLUs; junta las filas de todas', async () => {
  const sqls = [];
  const { movimientosRecientes } = crearConsultasPrecios({ ...deps, query: async sql => {
    sqls.push(sql);
    return plusDelIn(sql).filter(id => Number(id) % 400 === 0).map(id => ({ IdProducto: id, N: 1, Ultimo: '2026-10-01' }));
  } });
  const plus = Array.from({ length: 1201 }, (_, i) => String(i + 1));
  const m = await movimientosRecientes([...plus, ...plus.slice(0, 50)], '2026-04-26'); // repetidos: no suman tandas
  assert.deepStrictEqual(sqls.map(s => plusDelIn(s).length), [500, 500, 201]);
  assert.deepStrictEqual(sqls.flatMap(plusDelIn).sort(), [...plus].sort());
  assert.deepStrictEqual([...m.keys()], ['400', '800', '1200']); // una por tanda
  assert.deepStrictEqual(m.get('1200'), { n: 1, ultimo: '2026-10-01' });
});

test('movimientosRecientes: si una tanda falla, rechaza (la ruta lo convierte en avisoActividad)', async () => {
  let n = 0;
  const { movimientosRecientes } = crearConsultasPrecios({ ...deps, query: async () => { if (++n === 2) throw new Error('timeout'); return []; } });
  await assert.rejects(movimientosRecientes(Array.from({ length: 600 }, (_, i) => String(i + 1)), '2026-04-26'), /timeout/);
});

test('venta directa que es su propio granel: el mismo PLU es granel y presentación; la actividad sale de ese único PLU', () => {
  const presentaciones = [{ plu: '700', nombre: 'Chia 1Kg', ventaDirecta: true }];
  const costos = new Map([['700', { nombre: 'Chia 1Kg', costoSistema: 1000 }]]);
  const grupos = L.agruparPorGranel({ graneles: [], presentaciones, formulas: {}, costos });
  assert.deepStrictEqual(grupos.map(g => [g.plu, g.presentaciones.map(p => p.plu)]), [['700', ['700']]]);
  const listar = movimientos => L.listadoFraccionado({ grupos, costos, vigentes: new Map(), costeo: {}, cfg: CFG, movimientos,
    mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }) })[0];
  const con = listar(new Map([['700', { n: 2, ultimo: '2026-10-10' }]]));
  assert.deepStrictEqual([con.activo, con.actividad.motivos, con.actividad.presentacionesActivas, con.presentaciones[0].movReciente], [true, [], 1, true]);
  const sin = listar(new Map());
  assert.deepStrictEqual([sin.activo, sin.actividad.motivos, sin.presentaciones[0].movReciente], [false, ['sinMovPresentaciones'], false]);
});

// Contrato: filas como llegan al navegador (listadoFraccionado → filaPublica → JSON) usadas por el front sin adaptar.
const GRUPOS = [
  { plu: '100', nombre: 'Almendras', presentaciones: [{ plu: '101', nombre: 'Almendras 500G' }] },
  { plu: '200', nombre: 'Nueces REEFER', presentaciones: [{ plu: '201', nombre: 'Nueces 1Kg' }] }, // REEFER e inactivo
  { plu: '300', nombre: 'Maní', presentaciones: [{ plu: '301', nombre: 'Maní 500G' }] },              // inactivo automático
  { plu: '400', nombre: 'Pasas', presentaciones: [{ plu: '401', nombre: 'Pasas 500G' }] },            // activo, fijado inactivo
  { plu: null, nombre: 'Sin granel asignado', presentaciones: [{ plu: '104', nombre: 'Rara 50G' }] },
];
const MOV = new Map(['100', '101', '400', '401'].map(p => [p, { n: 1, ultimo: '2026-10-01' }]));
const alNavegador = (movimientos, costeo = { activoGranel: { 400: false } }) => JSON.parse(JSON.stringify(L.listadoFraccionado({
  grupos: GRUPOS, costos: new Map(), vigentes: new Map(), costeo, cfg: CFG, movimientos,
  mayoristasDe: L.crearMayoristasDe({ vinculos: [], vigentes: new Map() }) }).map(f => L.filaPublica(f))));

test('contrato back → front: filtros, conteos y badges del listado leen reefer / activo / activoManual / actividad del server', () => {
  const filas = alNavegador(MOV);
  const ver = o => filtrarFilas(filas, o).map(f => f.plu);
  assert.deepStrictEqual(ver({}), ['100', null]);
  assert.deepStrictEqual(ver({ verReefer: true }), ['100', '200', null]);           // REEFER inactivo: lo gobierna "Ver REEFER"
  assert.deepStrictEqual(ver({ verInactivos: true }), ['100', '300', '400', null]);
  assert.deepStrictEqual(contarOcultables(filas), { reefer: 1, inactivos: 2 });
  const porPlu = Object.fromEntries(filas.map(f => [f.plu, f]));
  assert.match(htmlBadgesActividadLst(porPlu[200]), />REEFER<.*>inactivo</);
  assert.match(htmlBadgesActividadLst(porPlu[300]), /title="Inactivo: sin movimientos de ninguna presentación en el último año"/);
  assert.match(htmlBadgesActividadLst(porPlu[400]), /title="Fijado a mano como inactivo"/);
  // Export del listado: recibe las filas ya filtradas (filtrosBusqueda incluye los toggles) → sin REEFER ni inactivos
  const exp = filasExportListado(filtrarFilas(filas, {}), 'fraccionado').flat();
  // una fila por presentación con su granel ("100 · Almendras"): ni las de REEFER ni las de inactivos
  assert.deepStrictEqual(exp.filter(c => typeof c === 'number'), [101, 104], JSON.stringify(exp));
});

test('contrato back → front: el select de Configuración lee el mismo activoGranel que usa el listado', () => {
  // Arrange: Pasas (400) fijado a mano inactivo con automático activo
  const pasas = alNavegador(MOV).find(f => f.plu === '400');
  // Act + Assert: el listado lo trae inactivo a mano y la fila de Configuración muestra "inactivo"
  assert.deepStrictEqual([pasas.activoManual, pasas.activo, pasas.actividad.auto], [false, false, 'activo']);
  assert.strictEqual(estadoDeActivoFr(activoGuardadoFr({ 400: pasas.activoManual }, '400')), 'inactivo');
  // sin el manual (Automático = null en el PUT, la clave sale) el server lo devuelve activo por movimientos
  const delServer = alNavegador(MOV, {}).find(f => f.plu === '400');
  assert.deepStrictEqual([delServer.activoManual, delServer.activo], [null, true]);
  assert.strictEqual(estadoDeActivoFr(activoGuardadoFr({}, '400')), 'auto');
});

test('contrato back → front: consulta de movimientos caída (null) → nadie oculto salvo a mano y REEFER', () => {
  const filas = alNavegador(null);
  assert.deepStrictEqual(filtrarFilas(filas, {}).map(f => f.plu), ['100', '300', null]);
  assert.deepStrictEqual(contarOcultables(filas), { reefer: 1, inactivos: 1 }); // sólo el fijado a mano
  const mani = filas.find(f => f.plu === '300');
  assert.deepStrictEqual([mani.actividad, mani.presentaciones[0].movReciente], [null, null]);
});
