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
  assert.deepStrictEqual(u.graneles, [{ plu: '100', nombre: 'Almendras DEPOSITO GRANEL' }]);
  assert.deepStrictEqual(u.presentaciones.map(p => [p.plu, !!p.ventaDirecta, p.granelSiga ?? null]),
    [['101', false, null], ['102', true, null], ['103', true, '200']]);
  assert.deepStrictEqual([...u.costos.keys()].sort(), ['100', '200']);
  assert.strictEqual(u.costos.get('100').costoSistema, 1000);
});

test('universoAlmacen: productos activos del rubro Almacen con sus costos', async () => {
  const sqls = [];
  const { universoAlmacen } = crearConsultasPrecios({ ...deps, query: async sql => { sqls.push(sql); return [{ IdProducto: '7', NombreProducto: 'Arroz', CostoSistema: 1210, IvaCompraPct: 21 }]; } });
  const filas = await universoAlmacen();
  assert.match(sqls[0], /r\.NombreRubro = 'Almacen'/);
  assert.deepStrictEqual(filas.map(f => [f.plu, f.costoSistema]), [['7', 1000]]);
});

test('granelDePresentacion: fórmula › fórmula SIGA › nombre del granel › propio PLU (sólo venta directa)', () => {
  const porNombre = crearGranelPorNombre([{ plu: '100', nombre: 'Albahaca DEPOSITO GRANEL' }]);
  assert.strictEqual(granelDePresentacion({ 5: { granel: 7 } }, { plu: '5' }, porNombre), '7');
  assert.strictEqual(granelDePresentacion({}, { plu: '6', ventaDirecta: true, granelSiga: '9' }, porNombre), '9');
  assert.strictEqual(granelDePresentacion({}, { plu: '7', nombre: 'Albahaca 1Kg', ventaDirecta: true }, porNombre), '100');
  assert.strictEqual(granelDePresentacion({}, { plu: '8', nombre: 'Otra 1Kg', ventaDirecta: true }, porNombre), '8');
  assert.strictEqual(granelDePresentacion({}, { plu: '9', nombre: 'Fracc 50G' }, porNombre), null);
});
