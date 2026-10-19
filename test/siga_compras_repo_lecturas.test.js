'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crearRepo = require('../lib/siga_compras/repo');
const { SQL_CATEGORIA_FISCAL } = require('../lib/siga_compras/mapeos');
const { ErrorSiga } = require('../lib/siga_compras/sql_comun');
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

test('contexto y catalogos: sin CATEGORIAFISCALEMPRESA (o NULL) en Parametros cortan con ErrorSiga SIGA_CONFIG', async () => {
  const sinFila = FILAS_SIGA.Parametros.filter(f => f.IdParametro !== 'CATEGORIAFISCALEMPRESA');
  const conNull = [...sinFila, { IdParametro: 'CATEGORIAFISCALEMPRESA', ValorParametro: null }];
  const esConfig = err => err instanceof ErrorSiga && err.code === 'SIGA_CONFIG'
    && err.message === 'Falta el parámetro CATEGORIAFISCALEMPRESA en SIGA para la empresa 1.';
  for (const filas of [sinFila, conNull]) {
    const repo = crearRepo(crearSqlFalso(porTabla({ Parametros: () => ({ recordset: filas }) })));
    await assert.rejects(repo.contexto(borradorFactcom(), { hoy: '2026-10-16' }), esConfig);
    await assert.rejects(repo.catalogos({ idProveedor: 328 }), esConfig);
  }
});

test('contexto: tipo de movimiento como TiposMovimientos.GetUnoPorComprobanteAsociado (split exacto, gana la última)', async () => {
  const filas = [
    { IdTipoMovimiento: 'AJUSTE', ComprobantesAsociados: 'FACTCOMX', CoeficienteStock: -1 },
    { IdTipoMovimiento: 'COMPRA', ComprobantesAsociados: 'REMCOM,FACTCOM', CoeficienteStock: 1 },
    { IdTipoMovimiento: 'COMPRA2', ComprobantesAsociados: 'FACTCOM,NCCOM', CoeficienteStock: 2 },
    { IdTipoMovimiento: 'OTRO', ComprobantesAsociados: '', CoeficienteStock: 3 },
  ];
  const falso = crearSqlFalso(porTabla({ TiposMovimientos: () => ({ recordset: filas }) }));
  const ctx = await crearRepo(falso).contexto(borradorFactcom(), { hoy: '2026-10-16' });
  assert.deepStrictEqual(ctx.tipoMovimiento, { idTipoMovimiento: 'COMPRA2', coeficienteStock: 2 });
  const q = falso.registro.find(e => /FROM TiposMovimientos/.test(e.texto));
  assert.match(q.texto, /ComprobantesAsociados IS NOT NULL/);
  assert.match(q.texto, /ORDER BY IdTipoMovimiento$/);
  assert.doesNotMatch(q.texto, /LIKE/);
  const sinCoincidencia = crearSqlFalso(porTabla({ TiposMovimientos: () => ({ recordset: [filas[0]] }) }));
  assert.strictEqual((await crearRepo(sinCoincidencia).contexto(borradorFactcom(), { hoy: '2026-10-16' })).tipoMovimiento, null);
});

test('contexto: VentasNumeros_G1 (empresa, tipo, letra, emisor) marca numeración compartida con ventas', async () => {
  const ventasNumeros = texto => ({ recordset: /IdTipoComprobanteRelacionado/.test(texto) ? [] : [{ IdTipoComprobante: 'FACTCOM' }] });
  const falso = crearSqlFalso(porTabla({ VentasNumeros: ventasNumeros }));
  const ctx = await crearRepo(falso).contexto(borradorFactcom(), { hoy: '2026-10-16' });
  assert.strictEqual(ctx.numeracionCompartidaConVentas, true);
  assert.strictEqual(ctx.ventasNumerosRelacionado, false);
  const g1 = falso.registro.find(e => /FROM VentasNumeros VN/.test(e.texto) && !/Relacionado/.test(e.texto));
  assert.match(g1.texto, /VN\.LetraFiscal = @letra AND VN\.CentroEmisor = @centroEmisor/);
  assert.deepStrictEqual([g1.params.idEmpresa, g1.params.idTipoComprobante, g1.params.letra, g1.params.centroEmisor], [1, 'FACTCOM', 'A', 5007]);
  assertParametrizado(falso.registro);
  const sinEmisor = crearSqlFalso(porTabla({ VentasNumeros: ventasNumeros }));
  const ctx2 = await crearRepo(sinEmisor).contexto(borradorFactcom({ centroEmisor: 0 }), { hoy: '2026-10-16' });
  assert.strictEqual(ctx2.numeracionCompartidaConVentas, false);
});

test('contexto: numeración automática por proveedor consulta VentasNumeros_G1 con emisor 1 y sin número (Win L22998)', async () => {
  const automatico = [{ ...FILAS_SIGA.TiposComprobantes[0], NumeracionAutomatica: true }];
  const b = borradorFactcom({ centroEmisor: 0, numeroComprobante: 0 });
  for (const [filasVN, esperado] of [[[{ IdTipoComprobante: 'FACTCOM' }], true], [[], false]]) {
    const falso = crearSqlFalso(porTabla({
      TiposComprobantes: () => ({ recordset: automatico }),
      VentasNumeros: texto => ({ recordset: /IdTipoComprobanteRelacionado/.test(texto) ? [] : filasVN }),
    }));
    const ctx = await crearRepo(falso).contexto(b, { hoy: '2026-10-16' });
    assert.strictEqual(ctx.numeracionCompartidaConVentas, esperado);
    const g1 = falso.registro.find(e => /FROM VentasNumeros VN/.test(e.texto) && !/Relacionado/.test(e.texto));
    assert.deepStrictEqual([g1.params.idEmpresa, g1.params.idTipoComprobante, g1.params.letra, g1.params.centroEmisor], [1, 'FACTCOM', 'A', 1]);
    assert.strictEqual(falso.registro.findIndex(e => /^SELECT TOP 1 C\.IdSucursal FROM Compras C/.test(e.texto)), -1);
  }
});

test('contexto: numeración automática por proveedor → proximoNumero = MAX + 1 sin lock, con emisor vacío = 1', async () => {
  const automatico = [{ ...FILAS_SIGA.TiposComprobantes[0], NumeracionAutomatica: true }];
  const falso = crearSqlFalso(porTabla({
    TiposComprobantes: () => ({ recordset: automatico }),
    Compras: texto => ({ recordset: /MAX\(/.test(texto) ? [{ Siguiente: 51 }] : [] }),
  }));
  const ctx = await crearRepo(falso).contexto(borradorFactcom({ centroEmisor: null, numeroComprobante: null }), { hoy: '2026-10-16' });
  assert.strictEqual(ctx.proximoNumero, 51);
  const max = falso.registro.find(e => /MAX\(C\.NumeroComprobante\)/.test(e.texto));
  assert.doesNotMatch(max.texto, /UPDLOCK/);
  assert.deepStrictEqual(max.params, { idProveedor: 328, idSucursal: 1, idTipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: 1 });
  assertParametrizado(falso.registro);
  // Número tipeado: el aviso de duplicado se pide con el emisor efectivo (1).
  const tipeado = crearSqlFalso(porTabla({ TiposComprobantes: () => ({ recordset: automatico }) }));
  await crearRepo(tipeado).contexto(borradorFactcom({ centroEmisor: null, numeroComprobante: 77 }), { hoy: '2026-10-16' });
  const dup = tipeado.registro.find(e => /^SELECT TOP 1 C\.IdSucursal FROM Compras C/.test(e.texto));
  assert.deepStrictEqual([dup.params.centroEmisor, dup.params.numeroComprobante], [1, 77]);
  // Manual (FACTCOM) o con VentasNumeros relacionado: no hay número propuesto.
  const manual = crearSqlFalso(porTabla());
  assert.strictEqual((await crearRepo(manual).contexto(borradorFactcom(), { hoy: '2026-10-16' })).proximoNumero, null);
  assert.strictEqual(manual.registro.findIndex(e => /MAX\(/.test(e.texto)), -1);
  const relacionado = crearSqlFalso(porTabla({
    TiposComprobantes: () => ({ recordset: automatico }),
    VentasNumeros: texto => ({ recordset: /IdTipoComprobanteRelacionado/.test(texto) ? [{ IdTipoComprobante: 'FACTCOM' }] : [] }),
  }));
  assert.strictEqual((await crearRepo(relacionado).contexto(borradorFactcom({ numeroComprobante: null }), { hoy: '2026-10-16' })).proximoNumero, null);
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
  const cc = falso.registro.find(e => /FROM CuentasCorrientesProv CCP/.test(e.texto));
  assert.match(cc.texto, /INNER JOIN TiposComprobantes TC ON TC\.IdTipoComprobante = CCP\.IdTipoComprobante/);
  assert.match(cc.texto, /INNER JOIN Sucursales S ON S\.IdSucursal = CCP\.IdSucursal/);
  assert.match(cc.texto, /WHERE CCP\.IdSucursal > 0 AND CCP\.IdProveedor = @idProveedor/);
  assert.match(cc.texto, /\(TC\.InformaLibroIVA = 1 OR S\.IdEmpresa = @idEmpresa\)/);
  assert.doesNotMatch(cc.texto, /UPDLOCK/);
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

test('contexto: PLU repetidos van una sola vez a SQL y nunca más de 200 parámetros', async () => {
  const linea = (plu, i) => ({ orden: i + 1, plu, nombre: plu, cantidad: 1, precio: 1 });
  const falso = crearSqlFalso(porTabla());
  await crearRepo(falso).contexto(borradorFactcom({ lineas: ['1001', '1002', '1001'].map(linea) }), { hoy: '2026-10-16' });
  const productos = falso.registro.find(e => /FROM Productos WHERE/.test(e.texto));
  assert.deepStrictEqual(Object.values(productos.params), ['1001', '1002']);
  const muchos = crearSqlFalso(porTabla());
  const plus = Array.from({ length: 2500 }, (_, i) => String(5000 + i));
  await crearRepo(muchos).contexto(borradorFactcom({ lineas: plus.map(linea) }), { hoy: '2026-10-16' });
  const consulta = muchos.registro.find(e => /FROM Productos WHERE/.test(e.texto));
  assert.strictEqual(Object.keys(consulta.params).length, 200);
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

test('catalogos: puntos de venta de Impresoras (S.Impresoras L25-29); si la tabla o una columna no existe, lista vacía y aviso', async () => {
  const falso = crearSqlFalso(porTabla());
  const cat = await crearRepo(falso).catalogos({ idProveedor: 328 });
  assert.deepStrictEqual(cat.impresoras, [
    { idSucursal: 1, idImpresora: 'FISCAL1', centroEmisor: 3, comprobantesHabilitados: ['FACTCOM', 'COTIZACIONCOM'] },
    { idSucursal: 1, idImpresora: 'MANUAL', centroEmisor: 7, comprobantesHabilitados: [] },
  ]);
  const q = falso.registro.find(e => /FROM Impresoras/.test(e.texto));
  assert.strictEqual(q.texto, 'SELECT IdSucursal, IdImpresora, CentroEmisor, ComprobantesHabilitados FROM Impresoras ORDER BY IdSucursal, CentroEmisor');
  const sinColumna = crearSqlFalso(porTabla({ Impresoras: () => { throw new Error("Invalid column name 'ComprobantesHabilitados'."); } }));
  const mal = await crearRepo(sinColumna).catalogos({ idProveedor: 328 });
  assert.deepStrictEqual(mal.impresoras, []);
  assert.match(mal.avisos.join(' '), /Impresoras.*punto de venta se tipea a mano/);
});
