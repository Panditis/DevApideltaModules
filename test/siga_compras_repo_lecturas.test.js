'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crearRepo = require('../lib/siga_compras/repo');
const { SQL_CATEGORIA_FISCAL } = require('../lib/siga_compras/mapeos');
const { crearSqlFalso, assertParametrizado } = require('./siga_compras_sql_falso');
const { borradorFactcom, contextoFactcom, FILAS_SIGA } = require('./siga_compras_fixture');

// Responde según la primera tabla del FROM; `extra` pisa la respuesta de alguna tabla.
const porTabla = (extra = {}) => texto => {
  const m = /FROM (\w+)/.exec(texto);
  const tabla = m && m[1];
  if (extra[tabla]) return extra[tabla](texto);
  return { recordset: FILAS_SIGA[tabla] || [] };
};

test('contexto: arma el contexto completo desde SIGA (solo lectura, todo parametrizado)', async () => {
  const falso = crearSqlFalso(porTabla());
  const ctx = await crearRepo(falso).contexto(borradorFactcom(), { hoy: '2026-10-16' });
  assert.deepStrictEqual(ctx, contextoFactcom());
  assert.ok(falso.registro.every(e => e.pool === 'lectura'));
  assertParametrizado(falso.registro);
});

test('contexto: categoría fiscal del proveedor y de la empresa con SQL_CATEGORIA_FISCAL (CFC por CATEGORIAFISCALEMPRESA)', async () => {
  const proveedorMonotributo = [{ ...FILAS_SIGA.Proveedores[0], IdCategoriaFiscal: 6 }];
  const falso = crearSqlFalso(porTabla({ Proveedores: () => ({ recordset: proveedorMonotributo }) }));
  await crearRepo(falso).contexto(borradorFactcom(), { hoy: '2026-10-16' });
  const usos = falso.registro.filter(e => e.texto === SQL_CATEGORIA_FISCAL).map(e => e.params);
  assert.deepStrictEqual(usos, [
    { idCategoriaFiscal: 6, categoriaFiscalEmpresa: 2 },
    { idCategoriaFiscal: 2, categoriaFiscalEmpresa: 2 },
  ]);
  const parametros = falso.registro.find(e => /FROM Parametros/.test(e.texto));
  assert.strictEqual(parametros.params.idEmpresa, 1);
});

test('contexto: sin CATEGORIAFISCALEMPRESA (o NULL) en Parametros corta con error claro', async () => {
  const sinFila = FILAS_SIGA.Parametros.filter(f => f.IdParametro !== 'CATEGORIAFISCALEMPRESA');
  const conNull = [...sinFila, { IdParametro: 'CATEGORIAFISCALEMPRESA', ValorParametro: null }];
  for (const filas of [sinFila, conNull]) {
    const falso = crearSqlFalso(porTabla({ Parametros: () => ({ recordset: filas }) }));
    await assert.rejects(crearRepo(falso).contexto(borradorFactcom(), { hoy: '2026-10-16' }),
      /^Error: Falta el parámetro CATEGORIAFISCALEMPRESA en SIGA para la empresa 1\.$/);
  }
});

test('contexto: duplicado por proveedor en cualquier sucursal, sin lock (el lock va en grabar)', async () => {
  const falso = crearSqlFalso(porTabla({ Compras: () => ({ recordset: [{ IdSucursal: 11 }] }) }));
  const ctx = await crearRepo(falso).contexto(borradorFactcom(), { hoy: '2026-10-16' });
  assert.deepStrictEqual(ctx.duplicado, { enCompras: true, enCtaCte: false });
  const dup = falso.registro.find(e => /FROM Compras C/.test(e.texto));
  assert.match(dup.texto, /C\.IdProveedor = @idProveedor/);
  assert.match(dup.texto, /\(TC\.InformaLibroIVA = 1 OR S\.IdEmpresa = @idEmpresa\)/);
  assert.doesNotMatch(dup.texto, /C\.IdSucursal =/);
  assert.doesNotMatch(dup.texto, /UPDLOCK/);
  assert.deepStrictEqual(
    [dup.params.idProveedor, dup.params.idTipoComprobante, dup.params.letra, dup.params.centroEmisor, dup.params.numeroComprobante, dup.params.idEmpresa],
    [328, 'FACTCOM', 'A', 5007, 1071364, 1]);
});

test('contexto: los PLU NUEVO- no van a SQL y sin emisor no se controla duplicado', async () => {
  const falso = crearSqlFalso(porTabla());
  const b = borradorFactcom({
    centroEmisor: 0,
    lineas: [...borradorFactcom().lineas, { orden: 3, plu: 'NUEVO-ab12', nombre: 'Té', cantidad: 1, precio: 1, nuevo: true }],
  });
  await crearRepo(falso).contexto(b, { hoy: '2026-10-16' });
  const productos = falso.registro.find(e => /FROM Productos WHERE/.test(e.texto));
  assert.deepStrictEqual(Object.values(productos.params), ['1001', '1002']);
  assert.strictEqual(falso.registro.findIndex(e => /FROM Compras C/.test(e.texto)), -1);
});

test('catalogos: combos para la pantalla; si falla Provincias, avisa y sigue', async () => {
  const falso = crearSqlFalso(porTabla({ Provincias: () => { throw new Error("Invalid object name 'Provincias'."); } }));
  const cat = await crearRepo(falso).catalogos({ idProveedor: 328 });
  assert.deepStrictEqual(cat.proveedor, {
    idProveedor: 328, nombre: 'PROVEEDOR RI', cuit: '20-12345678-6', idCategoriaFiscal: 2, idRubroCompra: 1, idFormasPago: 3,
    descuentoRecargoPorc: 0, idTipoComprobante: 'FACTCOM', letraFiscalCompra: 'A', ivaDiscriminado: true,
  });
  assert.deepStrictEqual(cat.tipos, [{
    idTipoComprobante: 'FACTCOM', descripcion: 'Factura de compra', letrasHabilitadas: ['A', 'B', 'C', 'E', 'I', 'M'],
    numeracionAutomatica: false, grabaLibro: true,
  }]);
  assert.deepStrictEqual(cat.formasPago, [{ idFormasPago: 3, descripcion: 'Cta. Cte.', dias: 30 }]);
  assert.deepStrictEqual(cat.sucursales, [{ idSucursal: 1, nombre: 'Casa Central' }]);
  assert.deepStrictEqual(cat.ubicaciones, [contextoFactcom().destino.ubicacion]);
  assert.deepStrictEqual(cat.periodos, [202610]);
  assert.deepStrictEqual(cat.provincias, []);
  assert.match(cat.avisos[0], /Provincias/);
  assert.ok(falso.registro.every(e => e.pool === 'lectura'));
  assert.deepStrictEqual(falso.registro.filter(e => e.texto === SQL_CATEGORIA_FISCAL).map(e => e.params),
    [{ idCategoriaFiscal: 2, categoriaFiscalEmpresa: 2 }]);
  assertParametrizado(falso.registro);
  const ok = await crearRepo(crearSqlFalso(porTabla())).catalogos({ idProveedor: 328 });
  assert.deepStrictEqual(ok.provincias, [{ idProvincia: 'SF', nombre: 'Santa Fe' }]);
  assert.deepStrictEqual(ok.avisos, []);
});
