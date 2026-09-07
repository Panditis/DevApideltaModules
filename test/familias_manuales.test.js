'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  familiasSanitizadas, idsDeFamilias, agruparVentas, totalesPorSucursal, MAX_FAMILIAS,
} = require('../lib/familias_manuales');
const {
  sqlVentasPorProductoSucursal, idsCsvSeguro, modoPromoSeguro, filtroClientes, whereVentas,
} = require('../lib/analisis_ventas');

// ── Sanitización ─────────────────────────────────────────────────────────────

test('familiasSanitizadas recorta espacios y descarta familias sin nombre', () => {
  const out = familiasSanitizadas([
    { nombre: '  Mieles   premium ', productos: [{ id: '2544', nombre: 'MIEL PURA 1KG' }] },
    { nombre: '   ', productos: [{ id: '99' }] },
    { productos: [{ id: '98' }] },
  ]);
  assert.deepStrictEqual(out, [
    { nombre: 'Mieles premium', productos: [{ id: '2544', nombre: 'MIEL PURA 1KG' }] },
  ]);
});

test('familiasSanitizadas descarta nombres repetidos sin importar mayúsculas', () => {
  const out = familiasSanitizadas([
    { nombre: 'Granolas', productos: [{ id: '1' }] },
    { nombre: 'GRANOLAS', productos: [{ id: '2' }] },
  ]);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0].productos.map(p => p.id), ['1']);
});

test('familiasSanitizadas deduplica productos y acepta el formato de /api/productos/buscar', () => {
  const out = familiasSanitizadas([{
    nombre: 'Mix',
    productos: [{ codigo: '10', nombre: 'MIX A' }, { id: '10', nombre: 'MIX A' }, { id: ' 11 ' }],
  }]);
  assert.deepStrictEqual(out[0].productos, [
    { id: '10', nombre: 'MIX A' }, { id: '11', nombre: '' },
  ]);
});

test('familiasSanitizadas tolera basura y aplica el tope de familias', () => {
  assert.deepStrictEqual(familiasSanitizadas(null), []);
  assert.deepStrictEqual(familiasSanitizadas({ nombre: 'x' }), []);
  const muchas = Array.from({ length: MAX_FAMILIAS + 10 }, (_v, i) => ({ nombre: `F${i}`, productos: [] }));
  assert.strictEqual(familiasSanitizadas(muchas).length, MAX_FAMILIAS);
});

test('idsDeFamilias devuelve los códigos sin repetir entre familias', () => {
  const ids = idsDeFamilias([
    { nombre: 'A', productos: [{ id: '1' }, { id: '2' }] },
    { nombre: 'B', productos: [{ id: '2' }, { id: '3' }] },
  ]);
  assert.deepStrictEqual(ids, ['1', '2', '3']);
});

// ── Agrupación ───────────────────────────────────────────────────────────────

const FAMILIAS = [
  { nombre: 'Mieles', productos: [{ id: '1', nombre: 'viejo' }, { id: '2', nombre: '' }] },
  { nombre: 'Granolas', productos: [{ id: '3', nombre: 'GRANOLA' }] },
];
const ROWS = [
  { IdProducto: '1', IdSucursal: 2, Nombre: 'MIEL 1KG', Unidades: 10, Facturacion: 1000 },
  { IdProducto: '1', IdSucursal: 3, Nombre: 'MIEL 1KG', Unidades: 5, Facturacion: 500 },
  { IdProducto: '2', IdSucursal: 2, Nombre: 'MIEL 500G', Unidades: 4, Facturacion: 300 },
  { IdProducto: '3', IdSucursal: 3, Nombre: 'GRANOLA', Unidades: 2, Facturacion: 200 },
];

test('agruparVentas suma por familia y desglosa por sucursal', () => {
  const [mieles, granolas] = agruparVentas(ROWS, FAMILIAS, [2, 3]);
  assert.strictEqual(mieles.nombre, 'Mieles');
  assert.deepStrictEqual(mieles.total, { unidades: 19, facturacion: 1800 });
  assert.deepStrictEqual(mieles.porSucursal[2], { unidades: 14, facturacion: 1300 });
  assert.deepStrictEqual(mieles.porSucursal[3], { unidades: 5, facturacion: 500 });
  assert.deepStrictEqual(granolas.total, { unidades: 2, facturacion: 200 });
  // Ordena por facturación descendente: la familia más grande arriba.
  assert.deepStrictEqual([mieles.nombre, granolas.nombre], ['Mieles', 'Granolas']);
});

test('agruparVentas deja en cero la sucursal sin ventas para que el gráfico tenga la barra', () => {
  const [, granolas] = agruparVentas(ROWS, FAMILIAS, [2, 3]);
  assert.deepStrictEqual(granolas.porSucursal[2], { unidades: 0, facturacion: 0 });
});

test('agruparVentas desglosa cada producto por sucursal', () => {
  const [mieles] = agruparVentas(ROWS, FAMILIAS, [2, 3]);
  const miel1kg = mieles.productos.find(p => p.id === '1');
  const miel500 = mieles.productos.find(p => p.id === '2');
  assert.deepStrictEqual(miel1kg.porSucursal[2], { unidades: 10, facturacion: 1000 });
  assert.deepStrictEqual(miel1kg.porSucursal[3], { unidades: 5, facturacion: 500 });
  // La sucursal sin ventas de ese producto queda en cero, no ausente: el gráfico la dibuja.
  assert.deepStrictEqual(miel500.porSucursal[3], { unidades: 0, facturacion: 0 });
});

test('agruparVentas: el total de la familia es la suma de sus productos por sucursal', () => {
  const [mieles] = agruparVentas(ROWS, FAMILIAS, [2, 3]);
  [2, 3].forEach(id => {
    const suma = mieles.productos.reduce((a, p) => a + p.porSucursal[id].facturacion, 0);
    assert.strictEqual(suma, mieles.porSucursal[id].facturacion);
  });
});

test('agruparVentas pisa el nombre guardado con el de SIGA', () => {
  const [mieles] = agruparVentas(ROWS, FAMILIAS, [2, 3]);
  assert.deepStrictEqual(mieles.productos.map(p => p.nombre), ['MIEL 1KG', 'MIEL 500G']);
});

test('agruparVentas cuenta el producto en las dos familias que lo comparten', () => {
  const familias = [
    { nombre: 'A', productos: [{ id: '1' }] },
    { nombre: 'B', productos: [{ id: '1' }] },
  ];
  const grupos = agruparVentas(ROWS, familias, [2, 3]);
  assert.strictEqual(grupos[0].total.facturacion, 1500);
  assert.strictEqual(grupos[1].total.facturacion, 1500);
});

test('agruparVentas ignora las filas de productos que no están en ninguna familia', () => {
  const grupos = agruparVentas(
    [...ROWS, { IdProducto: '999', IdSucursal: 2, Unidades: 99, Facturacion: 9999 }],
    FAMILIAS, [2, 3]);
  assert.strictEqual(grupos.reduce((a, g) => a + g.total.facturacion, 0), 2000);
});

test('agruparVentas sin ventas devuelve las familias en cero', () => {
  const grupos = agruparVentas([], FAMILIAS, [2, 3]);
  assert.strictEqual(grupos.length, 2);
  assert.deepStrictEqual(grupos[0].total, { unidades: 0, facturacion: 0 });
});

test('totalesPorSucursal suma todas las familias por sucursal', () => {
  const grupos = agruparVentas(ROWS, FAMILIAS, [2, 3]);
  assert.deepStrictEqual(totalesPorSucursal(grupos, [2, 3]), [
    { idSucursal: 2, unidades: 14, facturacion: 1300 },
    { idSucursal: 3, unidades: 7, facturacion: 700 },
  ]);
});

// ── SQL ──────────────────────────────────────────────────────────────────────

test('sqlVentasPorProductoSucursal filtra por los códigos y agrupa por sucursal', () => {
  const sql = sqlVentasPorProductoSucursal(
    { desde: '2026-08-01', hasta: '2026-08-11', sucIdsCsv: '2,3' },
    idsCsvSeguro(['1', "O'Hara"]));
  assert.match(sql, /IN \('1','O''Hara'\)/);
  assert.match(sql, /GROUP BY vp\.IdProducto, vp\.IdSucursal, p\.NombreProducto/);
  assert.match(sql, /v\.IdSucursal IN \(2,3\)/);
  assert.match(sql, /!= 'ANULADO'/);
  // Sin recorte por rubro: los productos los eligió el usuario a mano.
  assert.doesNotMatch(sql, /NOT EXISTS/);
});

// ── Filtro de ventas de promoción ────────────────────────────────────────────

test('modoPromoSeguro sólo acepta los tres modos conocidos', () => {
  assert.strictEqual(modoPromoSeguro('solo'), 'solo');
  assert.strictEqual(modoPromoSeguro('sin'), 'sin');
  assert.strictEqual(modoPromoSeguro('todas'), 'todas');
  assert.strictEqual(modoPromoSeguro("x' OR 1=1--"), null);
  assert.strictEqual(modoPromoSeguro(undefined), null);
});

test('filtroClientes sin modo deja la condición histórica intacta', () => {
  const f = filtroClientes();
  assert.match(f, /!= 'SUCURSAL'/);
  assert.doesNotMatch(f, /PROMOCIONES/);
});

test('filtroClientes en "solo" pide únicamente las cuentas de promo', () => {
  const f = filtroClientes('solo');
  assert.match(f, /LIKE 'PROMOCIONES%'/);
  assert.doesNotMatch(f, /NOT /);
  // Sin descarte por categoría: las cuentas de promo son internas y quedarían en cero.
  assert.doesNotMatch(f, /!= 'SUCURSAL'/);
});

test('filtroClientes en "sin" saca la promo además de las transferencias internas', () => {
  const f = filtroClientes('sin');
  assert.match(f, /!= 'SUCURSAL'/);
  assert.match(f, /AND NOT UPPER\(ISNULL\(c\.NombreCliente,''\)\) LIKE 'PROMOCIONES%'/);
});

test('filtroClientes en "todas" suma la promo a la venta normal', () => {
  const f = filtroClientes('todas');
  assert.match(f, /OR UPPER\(ISNULL\(c\.NombreCliente,''\)\) LIKE 'PROMOCIONES%'/);
  assert.doesNotMatch(f, /NOT /);
});

test('whereVentas sin promo no cambia respecto de la condición histórica', () => {
  const p = { desde: '2026-08-01', hasta: '2026-08-11', sucIdsCsv: '2,3' };
  assert.strictEqual(whereVentas(p), whereVentas({ ...p, promo: undefined }));
  assert.doesNotMatch(whereVentas(p), /PROMOCIONES/);
});

test('sqlVentasPorProductoSucursal propaga el modo de promo al WHERE', () => {
  const p = { desde: '2026-08-01', hasta: '2026-08-11', sucIdsCsv: '2,3', promo: 'solo' };
  assert.match(sqlVentasPorProductoSucursal(p, "'1'"), /LIKE 'PROMOCIONES%'/);
});
