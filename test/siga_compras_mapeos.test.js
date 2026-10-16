'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../lib/siga_compras/mapeos');
const { contextoFactcom, FILAS_SIGA } = require('./siga_compras_fixture');

test('las filas crudas de SIGA mapean exactamente al contexto del fixture', () => {
  const ctx = contextoFactcom();
  assert.deepStrictEqual({ ...M.mapearProveedor(FILAS_SIGA.Proveedores[0]), categoriaFiscal: ctx.proveedor.categoriaFiscal }, ctx.proveedor);
  assert.deepStrictEqual(M.mapearCategoriaFiscal(FILAS_SIGA.CategoriasFiscales[0]), ctx.proveedor.categoriaFiscal);
  assert.deepStrictEqual(M.mapearTipoComprobante(FILAS_SIGA.TiposComprobantes[0]), ctx.tipo);
  assert.deepStrictEqual(M.mapearFormaPago(FILAS_SIGA.VentasFormasPago[0]), ctx.formaPago);
  const productos = Object.fromEntries(FILAS_SIGA.Productos.map(f => { const p = M.mapearProducto(f); return [p.idProducto, p]; }));
  assert.deepStrictEqual(productos, ctx.productos);
  assert.deepStrictEqual(M.mapearUbicacion(FILAS_SIGA.SucursalesUbicaciones[0]), ctx.destino.ubicacion);
  assert.deepStrictEqual(M.mapearTipoMovimiento(FILAS_SIGA.TiposMovimientos[0]), ctx.tipoMovimiento);
  assert.deepStrictEqual(M.mapearProvincia(FILAS_SIGA.Provincias[0]), { idProvincia: 'SF', nombre: 'Santa Fe' });
});

test('si falta una columna SIGA-INFERIDO, el error dice cuál (no se inventa un default)', () => {
  const { GrabaLibro, ...sinGrabaLibro } = FILAS_SIGA.TiposComprobantes[0];
  assert.throws(() => M.mapearTipoComprobante(sinGrabaLibro), /Falta la columna TiposComprobantes\.GrabaLibro en SIGA/);
  const { IvaDiscriminado, ...sinIva } = FILAS_SIGA.CategoriasFiscales[0];
  assert.throws(() => M.mapearCategoriaFiscal(sinIva), /Falta la columna CategoriasFiscales\.IvaDiscriminado en SIGA/);
  const { Alicuota, ...sinAlicuota } = FILAS_SIGA.Productos[0];
  assert.throws(() => M.mapearProducto(sinAlicuota), /Falta la columna Productos\.Alicuota en SIGA/);
  assert.ok(GrabaLibro && IvaDiscriminado && Alicuota);
});

test('mapearParametros: las filas de Parametros del fixture dan los parámetros del contexto', () => {
  assert.deepStrictEqual(M.mapearParametros(FILAS_SIGA.Parametros), contextoFactcom().parametros);
});

test('mapearParametros: valores de la tabla y defaults de SiGA', () => {
  assert.deepStrictEqual(M.mapearParametros([]), {
    categoriaFiscalEmpresa: 2, decimalesTotal: 2, decimalesPrecio: 4, pasajeIncluyeImpuestos: true,
  });
  assert.deepStrictEqual(M.mapearParametros([
    { IdParametro: 'CATEGORIAFISCALEMPRESA', ValorParametro: '2' },
    { IdParametro: 'COMPRASDECIMALESENTOTALGENERAL ', ValorParametro: '3' },
    { IdParametro: 'COMPRASDECIMALESREDONDEOENPRECIO', ValorParametro: '2' },
    { IdParametro: 'EXPENSASPASAJECOMPRASINCLUYEIMPUESTOS', ValorParametro: 'False' },
  ]), { categoriaFiscalEmpresa: 2, decimalesTotal: 3, decimalesPrecio: 2, pasajeIncluyeImpuestos: false });
});

test('booleanos de SIGA: bit, "True", "1", "S"', () => {
  const tipo = valor => M.mapearTipoComprobante({ ...FILAS_SIGA.TiposComprobantes[0], GrabaLibro: valor }).grabaLibro;
  assert.deepStrictEqual([true, 1, 'True', '1', 'S', false, 0, 'False', null].map(tipo),
    [true, true, true, true, true, false, false, false, false]);
});

test('requerido busca la columna sin distinguir mayúsculas (SQL Server no distingue)', () => {
  const fila = { ...FILAS_SIGA.TiposComprobantes[0] };
  fila.informalibroiva = fila.InformaLibroIVA;
  delete fila.InformaLibroIVA;
  assert.strictEqual(M.mapearTipoComprobante(fila).informaLibroIva, true);
});

test('el mensaje de columna faltante no dice SIGA-INFERIDO', () => {
  const { Tipo, ...sinTipo } = FILAS_SIGA.TiposComprobantes[0];
  assert.throws(() => M.mapearTipoComprobante(sinTipo), /^Error: Falta la columna TiposComprobantes\.Tipo en SIGA\.$/);
  assert.ok(Tipo);
});
