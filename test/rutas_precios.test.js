'use strict';
// Rutas compartidas de /precios (routes/rutas_precios.js): config/publica, costo manual y costos extra.
const test = require('node:test');
const assert = require('node:assert');
const crearRutasPrecios = require('../routes/rutas_precios');

// Router con costeo.json en memoria: llamar(metodo, path, body, { sinConfig }) → respuesta del handler.
function routerConArchivo(archivo) {
  const estado = { archivo };
  const router = crearRutasPrecios({
    apiRoute: fn => fn, leerJSON: () => estado.archivo, guardarJSON: (_p, d) => { estado.archivo = d; }, DATA_DIR: '/tmp',
  });
  const llamar = (metodo, ruta, body = {}, { sinConfig = false } = {}) => {
    const capa = router.stack.find(l => l.route && l.route.methods[metodo] && l.match(ruta.split('?')[0]));
    if (!capa) throw new Error(`sin ruta ${metodo} ${ruta}`);
    return capa.route.stack[0].handle({ params: capa.params, body, query: {}, preciosSinConfig: sinConfig });
  };
  return { llamar, estado };
}

test('GET config/publica: puedeConfig según el permiso y la tolerancia (default 10)', async () => {
  const { llamar } = routerConArchivo({ toleranciaPct: 3 });
  assert.deepStrictEqual(await llamar('get', '/api/precios/config/publica'), { puedeConfig: true, toleranciaPct: 3 });
  assert.deepStrictEqual(await llamar('get', '/api/precios/config/publica', {}, { sinConfig: true }), { puedeConfig: false, toleranciaPct: 3 });
  assert.strictEqual((await routerConArchivo({}).llamar('get', '/api/precios/config/publica')).toleranciaPct, 10);
});

test('PUT costos-extra: valida, guarda y [] borra la entrada; PLU inválido', async () => {
  const { llamar, estado } = routerConArchivo({ costosExtraFraccionado: { 9: [] } });
  const items = [{ concepto: 'Flete', tipo: 'kg', valor: 50 }];
  assert.deepStrictEqual(await llamar('put', '/api/precios/costos-extra/5', { items }), { plu: '5', items });
  assert.deepStrictEqual(estado.archivo.costosExtraFraccionado, { 9: [], 5: items });
  assert.match((await llamar('put', '/api/precios/costos-extra/5', { items: [{ concepto: '', tipo: 'kg', valor: 1 }] })).error, /concepto/);
  await llamar('put', '/api/precios/costos-extra/5', { items: [] });
  assert.deepStrictEqual(estado.archivo.costosExtraFraccionado, { 9: [] });
  assert.match((await llamar('put', '/api/precios/costos-extra/a%20b', { items })).error, /PLU/);
});

test('costo-producto: manual guarda; sistema lo quita y limpia la decisión manual de ese PLU y sólo esa', async () => {
  const { llamar, estado } = routerConArchivo({ costoPorProducto: { 2: 50 }, decisiones: { 1: { fuente: 'manual' }, 2: { fuente: 'manual' }, 3: { fuente: 'sistema' } } });
  assert.deepStrictEqual(await llamar('put', '/api/precios/costo-producto/1', { fuente: 'manual', costo: 120 }), { plu: '1', fuente: 'manual', costo: 120 });
  assert.deepStrictEqual(estado.archivo.costoPorProducto, { 2: 50, 1: 120 });
  assert.deepStrictEqual(Object.keys(estado.archivo.decisiones), ['1', '2', '3']); // poner o cambiar no toca decisiones
  assert.match((await llamar('put', '/api/precios/costo-producto/1', { fuente: 'manual', costo: 0 })).error, /mayor a 0/);
  assert.match((await llamar('put', '/api/precios/costo-producto/1', { fuente: 'ultimaCompra' })).error, /fuente/);
  assert.deepStrictEqual(await llamar('put', '/api/precios/costo-producto/2', { fuente: 'sistema' }), { plu: '2', fuente: 'sistema' });
  assert.deepStrictEqual(estado.archivo.costoPorProducto, { 1: 120 });
  assert.deepStrictEqual(Object.keys(estado.archivo.decisiones), ['1', '3']);
  await llamar('put', '/api/precios/costo-producto/3', { fuente: 'sistema' });
  assert.deepStrictEqual(Object.keys(estado.archivo.decisiones), ['1', '3']); // decisión 'sistema' no se toca
});
