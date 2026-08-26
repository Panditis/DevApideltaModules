// Planilla de precios del facturador en la carpeta de red: detección de columnas, mapeo a
// catálogo y elección del archivo más nuevo. Todo con grillas sintéticas y un directorio
// temporal: el test no depende de que la carpeta compartida esté montada.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const P = require('../precios_facturador');

// Encabezado real de la exportación de SiGA, con los prefijos de la consulta.
const ENCABEZADO = ['IdProducto', 'ProductosSucursales.Productos.NombreProducto',
  'ProductosSucursales.Productos.IdRubro', 'ProductosSucursales.Productos.CodigoDeBarras', 'PrecioVenta'];

test('detecta las columnas de la exportación de SiGA', () => {
  const cols = P.detectarColumnas([ENCABEZADO, ['1878', 'Producto Ejemplo 250Gr', '23', '2001878', '11960']]);
  assert.deepEqual(cols, { filaEncabezado: 0, plu: 0, nombre: 1, precio: 4, barra: 3 });
});

test('encuentra el encabezado aunque haya filas de título arriba', () => {
  const cols = P.detectarColumnas([['Precios facturador'], [], ENCABEZADO]);
  assert.equal(cols.filaEncabezado, 2);
  assert.equal(cols.nombre, 1);
});

test('sin columna de nombre o de precio no hay catálogo posible', () => {
  assert.equal(P.detectarColumnas([['IdProducto', 'IdRubro'], ['1878', '23']]), null);
});

test('mapea las filas al mismo shape que el catálogo de SQL', () => {
  const grilla = [ENCABEZADO,
    ['1878', 'Producto Ejemplo 250Gr', '23', '2001878', '11960'],
    ['69', 'Otro Producto 16ml', '4', '763571766675', '3850']];
  const productos = P.filasACatalogo(grilla, P.detectarColumnas(grilla));
  assert.deepEqual(productos[0],
    { plu: '1878', nombre: 'Producto Ejemplo 250Gr', precio: 11960, barra: '2001878', modalidad: null, unidad: '' });
  assert.equal(productos[1].barra, '763571766675');
});

test('descarta filas sin nombre o sin precio, y códigos de barra que son restos de carga', () => {
  const grilla = [ENCABEZADO,
    ['1', '', '23', '2001878', '11960'],          // sin nombre
    ['2', 'Sin Precio', '23', '2001878', ''],     // sin precio
    ['3', 'Precio Cero', '23', '2001878', '0'],   // precio 0 no es precio
    ['4', 'Barra Corta', '23', '1', '500']];      // "1" no es un código de barra real
  const productos = P.filasACatalogo(grilla, P.detectarColumnas(grilla));
  assert.equal(productos.length, 1);
  assert.deepEqual([productos[0].nombre, productos[0].barra], ['Barra Corta', '']);
});

test('lee precios en formato argentino y con signo', () => {
  assert.equal(P.parsearPrecio('11960'), 11960);
  assert.equal(P.parsearPrecio('1.234,56'), 1234.56);
  assert.equal(P.parsearPrecio('$ 1.234'), 1234);
  assert.equal(P.parsearPrecio('1234.56'), 1234.56);
  assert.equal(P.parsearPrecio(''), null);
  assert.equal(P.parsearPrecio('s/precio'), null);
});

test('elige la planilla más nueva e ignora la macro y los temporales de Excel', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preciosfact-'));
  const escribir = (nombre, minutosAtras) => {
    const ruta = path.join(dir, nombre);
    fs.writeFileSync(ruta, '');
    const t = new Date(Date.parse('2026-08-26T09:00:00Z') - minutosAtras * 60000);
    fs.utimesSync(ruta, t, t);
  };
  escribir('PreciosProductos.xlsx', 5);
  escribir('Macro de precio de lector.xlsm', 0);  // la macro es más nueva y aun así no gana
  escribir('~$PreciosProductos.xlsx', 0);        // temporal de Excel abierto: no cuenta
  escribir('por si se borra la conexion.odc', 0); // no es planilla
  try {
    assert.equal(P.planillaMasNueva(dir).nombre, 'PreciosProductos.xlsx');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('avisa cuando la carpeta no tiene ninguna planilla', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preciosfact-vacia-'));
  try {
    assert.throws(() => P.planillaMasNueva(dir), /No hay planillas/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
