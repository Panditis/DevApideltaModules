'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { crearConsultasPrecios, granelDePresentacion, crearGranelPorNombre } = require('../lib/precios_consultas');

const RUBROS = {
  'Pesables Deposito': [{ IdProducto: 100, NombreProducto: 'Almendras DEPOSITO GRANEL' }],
  'Pesables Fraccionado': [{ IdProducto: 101, NombreProducto: 'Almendras 500G' }],
  'Pesables Venta Directa': [{ IdProducto: 102, NombreProducto: 'Almendras 1Kg' }, { IdProducto: 103, NombreProducto: 'Nueces 1Kg' }],
};
// SIGA falso: responde según la consulta (costos de un IN de PLUs, fórmula SIGA de los VD o productos de un rubro).
const query = async sql => {
  if (sql.includes('UcPrecioNeto')) {
    const ids = ((sql.match(/IdProducto IN \(([^)]*)\)/) || [])[1] || '').match(/\d+/g) || [];
    return ids.map(id => ({ IdProducto: id, NombreProducto: `P${id}`, CostoSistema: 1210, IvaCompraPct: 21, IngresoHoy: 0 }));
  }
  if (sql.includes('ProductosComponentes')) return [{ Plu: '103', Granel: '200', Nivel: 1 }];
  const rubro = Object.keys(RUBROS).find(r => sql.includes(`'${r}'`));
  return rubro ? RUBROS[rubro] : [];
};
const deps = { query, LISTA_PRECIOS_VENTA: 0, FORMULA_ACTIVA_SQL: '1=1', SIN_FORMULA_GENERICO_SQL: '1=1' };

test('universoFraccionado: graneles, presentaciones (VD sin fórmula con su granel SIGA) y costos de graneles + referenciados', async () => {
  const u = await crearConsultasPrecios(deps).universoFraccionado({ 101: { granel: 100 }, 102: { granel: 100 } });
  assert.deepStrictEqual(u.graneles, [{ plu: '100', nombre: 'Almendras DEPOSITO GRANEL', subrubroId: null, subrubro: null }]);
  assert.deepStrictEqual(u.presentaciones.map(p => [p.plu, !!p.ventaDirecta, p.granelSiga ?? null]),
    [['101', false, null], ['102', true, null], ['103', true, '200']]);
  assert.deepStrictEqual([...u.costos.keys()].sort(), ['100', '200']);
  assert.strictEqual(u.costos.get('100').costoSistema, 1210); // PrecioCosto de SIGA tal cual
});

test('universoAlmacen: productos activos del rubro Almacen con sus costos', async () => {
  const sqls = [];
  const { universoAlmacen } = crearConsultasPrecios({ ...deps, query: async sql => { sqls.push(sql); return [{ IdProducto: '7', NombreProducto: 'Arroz', CostoSistema: 1210, IvaCompraPct: 21 }]; } });
  const filas = await universoAlmacen();
  assert.match(sqls[0], /r\.NombreRubro = 'Almacen'/);
  assert.deepStrictEqual(filas.map(f => [f.plu, f.costoSistema]), [['7', 1210]]);
});

test('granelDePresentacion: fórmula › fórmula SIGA › nombre del granel › propio PLU (sólo venta directa)', () => {
  const porNombre = crearGranelPorNombre([{ plu: '100', nombre: 'Albahaca DEPOSITO GRANEL' }]);
  assert.strictEqual(granelDePresentacion({ 5: { granel: 7 } }, { plu: '5' }, porNombre), '7');
  assert.strictEqual(granelDePresentacion({}, { plu: '6', ventaDirecta: true, granelSiga: '9' }, porNombre), '9');
  assert.strictEqual(granelDePresentacion({}, { plu: '7', nombre: 'Albahaca 1Kg', ventaDirecta: true }, porNombre), '100');
  assert.strictEqual(granelDePresentacion({}, { plu: '8', nombre: 'Otra 1Kg', ventaDirecta: true }, porNombre), '8');
  assert.strictEqual(granelDePresentacion({}, { plu: '9', nombre: 'Fracc 50G' }, porNombre), null);
});

test('universoFraccionado: los PLUs extra (insumos de Fraccionado) también traen costo', async () => {
  const u = await crearConsultasPrecios(deps).universoFraccionado({ 101: { granel: 100 } }, ['900']);
  assert.ok(u.costos.has('900'));
});

test('graneles con subrubro: lo trae de SubRubros; sin la tabla cae a sin subrubro una sola vez; otro error sube', async () => {
  const conSub = async sql => (sql.includes('SubRubros')
    ? [{ IdProducto: 100, NombreProducto: 'Almendras', IdSubRubro: 7, NombreSubRubro: ' Frutos secos ' }, { IdProducto: 101, NombreProducto: 'Nueces', IdSubRubro: 7, NombreSubRubro: 'Frutos secos' },
      { IdProducto: 102, NombreProducto: 'Sal', IdSubRubro: null, NombreSubRubro: null }]
    : []);
  const c = crearConsultasPrecios({ ...deps, query: conSub });
  assert.deepStrictEqual((await c.universoFraccionado({})).graneles.map(g => [g.plu, g.subrubroId, g.subrubro]),
    [['100', '7', 'Frutos secos'], ['101', '7', 'Frutos secos'], ['102', null, null]]);

  let conSubRubros = 0;
  const sinTabla = async sql => {
    if (sql.includes('SubRubros')) { conSubRubros++; throw new Error("Invalid object name 'SubRubros'."); }
    return sql.includes("'Pesables Deposito'") ? [{ IdProducto: 100, NombreProducto: 'Almendras' }] : [];
  };
  const s = crearConsultasPrecios({ ...deps, query: sinTabla });
  assert.deepStrictEqual((await s.universoFraccionado({})).graneles, [{ plu: '100', nombre: 'Almendras', subrubroId: null, subrubro: null }]);
  await s.universoFraccionado({});
  assert.strictEqual(conSubRubros, 1); // se recuerda: no se vuelve a probar

  const caida = crearConsultasPrecios({ ...deps, query: async () => { throw new Error('timeout'); } });
  await assert.rejects(caida.universoFraccionado({}), /timeout/);
});
