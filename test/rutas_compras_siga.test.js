'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { contextoFactcom, AHORA } = require('./siga_compras_fixture');
const { ErrorSiga } = require('../lib/siga_compras/sql_comun');

// Router real sobre Express, con DATA_DIR temporal y repo FALSO: ningún test toca SIGA.
const PEDIDO = {
  numero: 'P-0007', idProveedor: 328, proveedor: 'PROVEEDOR RI', fecha: '2026-10-01', estado: 'CERRADO',
  items: [
    { plu: '1001', nombre: 'Harina', cantidad: 1, precioUnitario: 31839.64, cantidadEntregada: 1, estado: 'entregado', obs: '' },
    { plu: '1003', nombre: 'Azúcar', cantidad: 5, precioUnitario: 900, cantidadEntregada: 0, estado: 'faltante', obs: '' },
    { plu: '1002', nombre: 'Huevos', cantidad: 0, precioUnitario: 3184.01, cantidadEntregada: 1, estado: 'extra', obs: '' },
  ],
};

const CATALOGOS = {
  proveedor: { idProveedor: 328, nombre: 'PROVEEDOR RI', idTipoComprobante: 'FACTCOM', idFormasPago: 3, descuentoRecargoPorc: 0, letraFiscalCompra: 'A', ivaDiscriminado: true },
  tipos: [{ idTipoComprobante: 'FACTCOM', descripcion: 'Factura de compra', letrasHabilitadas: ['A', 'B', 'C'], numeracionAutomatica: false, grabaLibro: true }],
  formasPago: [{ idFormasPago: 3, descripcion: 'Cta. Cte.', dias: 30 }],
  sucursales: [{ idSucursal: 1, nombre: 'Casa Central' }],
  ubicaciones: [{ idSucursal: 1, idDeposito: 1, idUbicacion: 1, nombre: 'Depósito 1 · Ubicación 1', sucursalAsociada: 0, depositoAsociado: 0, ubicacionAsociada: 0 }],
  periodos: [202610], provincias: [], avisos: [],
};

const CABECERA = {
  idTipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: 5007, numeroComprobante: 1071364, fecha: '2026-10-10',
  periodoFiscal: 202610, idSucursal: 1, idDeposito: 1, idUbicacion: 1, idFormasPago: 3, porcDescRecGeneral: 0,
  observacion: 'Pedido P-0007',
};
const cuerpo = (cambios = {}) => ({ pedido: 'P-0007', cabecera: CABECERA, precios: {}, percepciones: [{ tipo: 'PIVA', importe: 955.19 }], ...cambios });
const MENSAJE_SIN_CONFIRMAR = 'No se pudo confirmar la grabación del comprobante en SIGA: verificá en SiGA antes de reintentar.';
const MENSAJE_A_VERIFICAR = 'El pedido tiene una grabación sin confirmar: verificá en SiGA si el comprobante quedó cargado antes de reintentar.';
const TS = AHORA.toISOString();
const MARCA = (cambios = {}) => ({
  numeroPedido: 'P-0007', estado: 'a_verificar', motivo: 'sin_confirmar', clave: '1|FACTCOM|A|5007|1071364', ts: TS, usuario: 'adriel',
  historial: [{ evento: 'a_verificar', motivo: 'sin_confirmar', clave: '1|FACTCOM|A|5007|1071364', usuario: 'adriel', ts: TS }],
  ...cambios,
});

// fallaGuardar: archivos cuya escritura falla (un directorio ocupa el <archivo>.tmp de la escritura atómica).
// crudos: contenido literal de archivos (p. ej. un json corrupto).
function montar({ vinculos = {}, estado, repo: repoParcial = {}, fallaGuardar = [], crudos = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compras-siga-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const escribir = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  escribir(path.join(dir, 'pedidos_comprobantes.json'), vinculos);
  if (estado) escribir(path.join(dir, 'compras_siga_estado.json'), estado);
  for (const [nombre, texto] of Object.entries(crudos)) fs.writeFileSync(path.join(dir, nombre), texto);
  for (const nombre of fallaGuardar) fs.mkdirSync(path.join(dir, `${nombre}.tmp`));
  const grabados = [];
  const contextos = [];
  const repo = {
    catalogos: async () => CATALOGOS,
    contexto: async b => { contextos.push(b); return contextoFactcom(); },
    grabar: async filas => { grabados.push(filas); return { clave: filas.clave, numeroMovimiento: 42 }; },
    ...repoParcial,
  };
  const app = express();
  app.use(express.json());
  app.use(require('../routes/rutas_compras_siga')({
    DATA_DIR: dir, leerPedidosCompra: () => [PEDIDO],
    usuarioCompras: () => 'adriel.compras', repo, ahora: () => AHORA,
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({ server, dir, grabados, contextos, leerJSON, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function pedir(base, metodo, url, body) {
  const r = await fetch(base + url, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

const vinculosDe = ctx => ctx.leerJSON(path.join(ctx.dir, 'pedidos_comprobantes.json'), {});
const estadoDe = ctx => ctx.leerJSON(path.join(ctx.dir, 'compras_siga_estado.json'), {});

test('GET borrador: líneas entregadas + extra, descartadas, cabecera sugerida y catálogos', async () => {
  const ctx = await montar();
  try {
    const { status, data } = await pedir(ctx.base, 'GET', '/api/compras-siga/pedidos/P-0007/borrador');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(data.borrador.lineas, [
      { orden: 1, plu: '1001', nombre: 'Harina', cantidad: 1, precio: 31839.64 },
      { orden: 2, plu: '1002', nombre: 'Huevos', cantidad: 1, precio: 3184.01 },
    ]);
    assert.deepStrictEqual(data.borrador.descartadas, [{ plu: '1003', nombre: 'Azúcar', estado: 'faltante' }]);
    assert.deepStrictEqual(data.borrador.bloqueos, []);
    assert.strictEqual(data.borrador.idTipoComprobante, 'FACTCOM');
    assert.strictEqual(data.borrador.letra, 'A');
    assert.strictEqual(data.borrador.fecha, '2026-10-16');
    assert.strictEqual(data.borrador.idUbicacion, 1);
    assert.deepStrictEqual(data.catalogos, CATALOGOS);
    assert.deepStrictEqual(await pedir(ctx.base, 'GET', '/api/compras-siga/pedidos/P-9999/borrador'), { status: 404, data: { ok: false, error: 'No existe el pedido.' } });
    // El número de la URL no se refleja en la respuesta.
    const raro = await pedir(ctx.base, 'GET', `/api/compras-siga/pedidos/${encodeURIComponent('<b>x</b>')}/borrador`);
    assert.deepStrictEqual(raro, { status: 404, data: { ok: false, error: 'No existe el pedido.' } });
  } finally { cerrar(ctx); }
});

test('POST validar: recalcula del lado del servidor y devuelve los errores de SiGA', async () => {
  const ctx = await montar();
  try {
    const ok = await pedir(ctx.base, 'POST', '/api/compras-siga/validar', cuerpo());
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.data.errores, []);
    assert.strictEqual(ok.data.totales.importeTotal, 42665.16);
    assert.deepStrictEqual(ok.data.lineas.map(l => l.proporcionalImp), [878.7748, 76.4152]);
    const mal = await pedir(ctx.base, 'POST', '/api/compras-siga/validar', cuerpo({ cabecera: { ...CABECERA, numeroComprobante: '' } }));
    assert.strictEqual(mal.status, 200);
    assert.deepStrictEqual(mal.data.errores, [{ campo: 'numeroComprobante', mensaje: 'Debe cargar un el número del comprobante.' }]);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/compras-siga/validar', { ...cuerpo(), pedido: 'P-9999' })).status, 404);
  } finally { cerrar(ctx); }
});

test('POST validar y grabar: importes, cantidades, líneas y proveedor del navegador se ignoran', async () => {
  const ctx = await montar();
  try {
    const inyectado = cuerpo({
      idProveedor: 999, importeTotal: 1, iva: 0, totales: { importeTotal: 1, iva: 0 },
      lineas: [{ plu: '1001', cantidad: 999, precio: 1, importeTotal: 1 }, { plu: '9999', cantidad: 5, precio: 1 }],
      cabecera: { ...CABECERA, idProveedor: 999, importeTotal: 1, iva: 0 },
    });
    const v = await pedir(ctx.base, 'POST', '/api/compras-siga/validar', inyectado);
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.data.totales.importeTotal, 42665.16);
    assert.deepStrictEqual(v.data.lineas.map(l => [l.plu, l.cantidad, l.precio]), [['1001', 1, 31839.64], ['1002', 1, 3184.01]]);
    assert.strictEqual(ctx.contextos[0].idProveedor, 328);
    const g = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', inyectado);
    assert.strictEqual(g.status, 200);
    const filas = ctx.grabados[0];
    assert.deepStrictEqual(filas.comprasProductos.map(p => [p.IdProducto, p.Cantidad]), [['1001', 1], ['1002', 1]]);
    assert.strictEqual(filas.compras.ImporteTotal, 42665.16);
    assert.strictEqual(filas.clave.IdProveedor, 328);
  } finally { cerrar(ctx); }
});

test('POST grabar: arma las filas desde el pedido, graba con el usuario de la sesión (10 car.) y vincula el pedido', async () => {
  const ctx = await montar();
  try {
    const r = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.deepStrictEqual(r.data.comprobante, { idSucursal: 1, tipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: 5007, numeroComprobante: 1071364, idProveedor: 328 });
    assert.strictEqual(r.data.numeroMovimiento, 42);
    assert.strictEqual(r.data.vinculado, true);
    assert.strictEqual(ctx.grabados.length, 1);
    assert.strictEqual(ctx.grabados[0].compras.Usuario, 'adriel.com');
    assert.deepStrictEqual(vinculosDe(ctx), { 'P-0007': ['1|FACTCOM|A|5007|1071364'] });
  } finally { cerrar(ctx); }
});

test('POST grabar rechazado: con errores (o pedido ya vinculado) no llama a repo.grabar', async () => {
  const ctx = await montar({ vinculos: { 'P-0007': ['1|FACTCOM|A|5007|1'] } });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.data.ok, false);
    assert.deepStrictEqual(r.data.errores, [{ campo: 'pedido', mensaje: 'El pedido ya está vinculado a un comprobante de SIGA.' }]);
    const sinNumero = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo({ cabecera: { ...CABECERA, numeroComprobante: null } }));
    assert.strictEqual(sinNumero.status, 400);
    assert.strictEqual(ctx.grabados.length, 0);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', { ...cuerpo(), pedido: 'P-9999' })).status, 404);
  } finally { cerrar(ctx); }
});

test('POST grabar: si SIGA rechaza (ErrorSiga), 422 con el mensaje tal cual y no vincula', async () => {
  const ctx = await montar({ repo: { grabar: async () => { throw new ErrorSiga('Este comprobante ya fue INGRESADO con ANTERIORIDAD'); } } });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(r.status, 422);
    assert.deepStrictEqual(r.data, { ok: false, error: 'Este comprobante ya fue INGRESADO con ANTERIORIDAD' });
    assert.deepStrictEqual(vinculosDe(ctx), {});
    assert.deepStrictEqual(estadoDe(ctx), {});
  } finally { cerrar(ctx); }
});

test('ErrorSiga de configuración en borrador/validar → 422; cualquier otro error → 500 genérico y log en el servidor', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const ctx = await montar({
    repo: {
      catalogos: async () => { throw new ErrorSiga('Falta el parámetro CATEGORIAFISCALEMPRESA en SIGA para la empresa 1.'); },
      contexto: async () => { throw new Error('ConnectionError: login failed at 10.0.0.1'); },
    },
  });
  try {
    const b = await pedir(ctx.base, 'GET', '/api/compras-siga/pedidos/P-0007/borrador');
    assert.strictEqual(b.status, 422);
    assert.deepStrictEqual(b.data, { ok: false, error: 'Falta el parámetro CATEGORIAFISCALEMPRESA en SIGA para la empresa 1.' });
    const v = await pedir(ctx.base, 'POST', '/api/compras-siga/validar', cuerpo());
    assert.strictEqual(v.status, 500);
    assert.strictEqual(v.data.ok, false);
    assert.doesNotMatch(v.data.error, /ConnectionError|10\.0\.0\.1/);
    assert.strictEqual(log.mock.callCount(), 1);
    assert.match(String(log.mock.calls[0].arguments.join(' ')), /compras-siga.*validar.*P-0007/);
  } finally { cerrar(ctx); }
});

test('POST grabar sin confirmar (SIGA_SIN_CONFIRMAR): 409, no vincula y deja el pedido "a verificar"', async () => {
  const err = new ErrorSiga(MENSAJE_SIN_CONFIRMAR, 'SIGA_SIN_CONFIRMAR');
  const ctx = await montar({ repo: { grabar: async () => { throw err; } } });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(r.data, { ok: false, error: MENSAJE_SIN_CONFIRMAR, aVerificar: true });
    assert.deepStrictEqual(vinculosDe(ctx), {});
    const usuario = 'adriel.compras';
    assert.deepStrictEqual(estadoDe(ctx)['P-0007'], MARCA({
      usuario, historial: [{ ...MARCA().historial[0], usuario }],
    }));
  } finally { cerrar(ctx); }
});

test('POST grabar sin confirmar con numeración automática: la marca guarda la clave definitiva que trae el error', async () => {
  const clave = { IdSucursal: 1, IdTipoComprobante: 'FACTCOM', Letra: 'A', CentroEmisor: 1, NumeroComprobante: 77, IdProveedor: 328 };
  const err = Object.assign(new ErrorSiga(MENSAJE_SIN_CONFIRMAR, 'SIGA_SIN_CONFIRMAR'), { clave });
  const ctx = await montar({ repo: { grabar: async () => { throw err; } } });
  try {
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo())).status, 409);
    assert.strictEqual(estadoDe(ctx)['P-0007'].clave, '1|FACTCOM|A|1|77');
  } finally { cerrar(ctx); }
});

test('POST grabar OK pero falla el vínculo: aviso + pedido "a verificar" (motivo vinculo) y el reintento queda bloqueado', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const ctx = await montar({ fallaGuardar: ['pedidos_comprobantes.json'] });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
    assert.strictEqual(r.data.vinculado, false);
    assert.strictEqual(r.data.avisoVinculo, 'Se grabó en SIGA pero no se pudo vincular al pedido. Vinculalo desde Control de compras.');
    assert.deepStrictEqual(estadoDe(ctx)['P-0007'], MARCA({
      motivo: 'vinculo', usuario: 'adriel.compras',
      historial: [{ evento: 'a_verificar', motivo: 'vinculo', clave: '1|FACTCOM|A|5007|1071364', usuario: 'adriel.compras', ts: TS }],
    }));
    const otra = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(otra.status, 400);
    assert.deepStrictEqual(otra.data.errores, [{ campo: 'pedido', mensaje: MENSAJE_A_VERIFICAR }]);
    assert.strictEqual(ctx.grabados.length, 1);
    assert.ok(log.mock.callCount() >= 1);
  } finally { cerrar(ctx); }
});

test('POST grabar OK y fallan vínculo y estado: log con pedido y comprobante, y el aviso igual', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const ctx = await montar({ fallaGuardar: ['pedidos_comprobantes.json', 'compras_siga_estado.json'] });
  try {
    const r = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.vinculado, false);
    assert.match(r.data.avisoVinculo, /no se pudo vincular/);
    assert.ok(!JSON.stringify(r.data).includes(path.basename(ctx.dir)), 'el aviso no filtra rutas del disco');
    assert.deepStrictEqual(estadoDe(ctx), {});
    const lineas = log.mock.calls.map(c => c.arguments.join(' '));
    assert.ok(lineas.some(l => /a verificar/.test(l) && /P-0007/.test(l) && /1\|FACTCOM\|A\|5007\|1071364/.test(l)), lineas.join('\n'));
  } finally { cerrar(ctx); }
});

const liberar = (ctx, body, numero = 'P-0007') => pedir(ctx.base, 'POST', `/api/compras-siga/pedidos/${numero}/liberar-verificacion`, body);

test('liberar-verificacion no_cargado: borra la marca con traza y el pedido se puede volver a grabar', async () => {
  const ctx = await montar({ estado: { 'P-0007': MARCA() } });
  try {
    const r = await liberar(ctx, { resultado: 'no_cargado' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, { ok: true, numeroPedido: 'P-0007', resultado: 'no_cargado', vinculado: false });
    const marca = estadoDe(ctx)['P-0007'];
    assert.strictEqual(marca.estado, 'liberado');
    assert.deepStrictEqual(marca.historial, [...MARCA().historial, { evento: 'liberado', resultado: 'no_cargado', usuario: 'adriel.compras', ts: TS }]);
    assert.deepStrictEqual(vinculosDe(ctx), {});
    assert.deepStrictEqual((await pedir(ctx.base, 'GET', '/api/compras-siga/pedidos/P-0007/borrador')).data.borrador.bloqueos, []);
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo())).status, 200);
    // Ya liberada: no hay marca a verificar.
    assert.strictEqual((await liberar(ctx, { resultado: 'no_cargado' })).status, 404);
  } finally { cerrar(ctx); }
});

test('liberar-verificacion cargado: vincula la clave guardada y borra la marca con traza', async () => {
  const ctx = await montar({ estado: { 'P-0007': MARCA() } });
  try {
    const r = await liberar(ctx, { resultado: 'cargado' });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.data, { ok: true, numeroPedido: 'P-0007', resultado: 'cargado', vinculado: true });
    assert.deepStrictEqual(vinculosDe(ctx), { 'P-0007': ['1|FACTCOM|A|5007|1071364'] });
    const marca = estadoDe(ctx)['P-0007'];
    assert.strictEqual(marca.estado, 'liberado');
    assert.deepStrictEqual(marca.historial.at(-1), { evento: 'liberado', resultado: 'cargado', usuario: 'adriel.compras', ts: TS });
    const b = await pedir(ctx.base, 'GET', '/api/compras-siga/pedidos/P-0007/borrador');
    assert.deepStrictEqual(b.data.borrador.bloqueos, [{ tipo: 'estado', mensaje: 'El pedido ya está vinculado a un comprobante de SIGA.' }]);
  } finally { cerrar(ctx); }
});

test('liberar-verificacion cargado sin poder vincular: 500 con mensaje y la marca sigue', async t => {
  t.mock.method(console, 'error', () => {});
  const ctx = await montar({ estado: { 'P-0007': MARCA() }, fallaGuardar: ['pedidos_comprobantes.json'] });
  try {
    const r = await liberar(ctx, { resultado: 'cargado' });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.data.ok, false);
    assert.match(r.data.error, /No se pudo vincular el comprobante 1\|FACTCOM\|A\|5007\|1071364 al pedido P-0007/);
    assert.ok(!r.data.error.includes(path.basename(ctx.dir)), 'el error no filtra rutas del disco');
    assert.deepStrictEqual(estadoDe(ctx)['P-0007'], MARCA());
  } finally { cerrar(ctx); }
});

test('liberar-verificacion: sin marca → 404; resultado inválido → 400', async () => {
  const ctx = await montar();
  try {
    const sin = await liberar(ctx, { resultado: 'cargado' });
    assert.strictEqual(sin.status, 404);
    assert.deepStrictEqual(sin.data, { ok: false, error: 'El pedido no tiene una grabación a verificar.' });
    for (const body of [{ resultado: 'quizas' }, {}, undefined]) {
      const mal = await liberar(ctx, body);
      assert.strictEqual(mal.status, 400);
      assert.deepStrictEqual(mal.data, { ok: false, error: "El resultado tiene que ser 'cargado' o 'no_cargado'." });
    }
  } finally { cerrar(ctx); }
});

test('pedido "a verificar": borrador lo muestra bloqueado y grabar/validar no llaman a repo.grabar', async () => {
  const estado = { 'P-0007': { numeroPedido: 'P-0007', estado: 'a_verificar', clave: '1|FACTCOM|A|5007|1071364', ts: '2026-10-16T17:00:00.000Z', usuario: 'adriel' } };
  const ctx = await montar({ estado });
  try {
    const b = await pedir(ctx.base, 'GET', '/api/compras-siga/pedidos/P-0007/borrador');
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(b.data.borrador.bloqueos, [{ tipo: 'estado', mensaje: MENSAJE_A_VERIFICAR }]);
    const v = await pedir(ctx.base, 'POST', '/api/compras-siga/validar', cuerpo());
    assert.deepStrictEqual(v.data.errores, [{ campo: 'pedido', mensaje: MENSAJE_A_VERIFICAR }]);
    const g = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(g.status, 400);
    assert.deepStrictEqual(g.data.errores, [{ campo: 'pedido', mensaje: MENSAJE_A_VERIFICAR }]);
    assert.strictEqual(ctx.grabados.length, 0);
  } finally { cerrar(ctx); }
});

test('POST grabar: un segundo pedido de grabación simultáneo recibe 409 y el lock se libera al terminar', async () => {
  let soltar;
  const espera = new Promise(r => { soltar = r; });
  let llamadas = 0;
  const ctx = await montar({
    repo: { grabar: async () => { llamadas += 1; await espera; throw new ErrorSiga('Este comprobante ya fue INGRESADO con ANTERIORIDAD'); } },
  });
  try {
    const primero = pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    await new Promise(r => setTimeout(r, 50));
    const segundo = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.strictEqual(segundo.status, 409);
    assert.strictEqual(segundo.data.ok, false);
    soltar();
    assert.strictEqual((await primero).status, 422);
    // Liberado en finally aunque el primero haya fallado: el tercero vuelve a llegar a repo.grabar.
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo())).status, 422);
    assert.strictEqual(llamadas, 2);
  } finally { cerrar(ctx); }
});

test('json de vínculos corrupto: 500 con log, no graba y no reescribe el archivo', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const ctx = await montar({ crudos: { 'pedidos_comprobantes.json': '{"P-0001": ["1|FACTCOM|A|1|1"], ' } });
  const archivo = path.join(ctx.dir, 'pedidos_comprobantes.json');
  try {
    for (const [metodo, url, body] of [
      ['GET', '/api/compras-siga/pedidos/P-0007/borrador'], ['POST', '/api/compras-siga/validar', cuerpo()],
      ['POST', '/api/compras-siga/grabar', cuerpo()],
    ]) {
      const r = await pedir(ctx.base, metodo, url, body);
      assert.strictEqual(r.status, 500, url);
      assert.deepStrictEqual(r.data, { ok: false, error: 'pedidos_comprobantes.json ilegible: no se graba para no perder vínculos.' });
    }
    assert.strictEqual(ctx.grabados.length, 0);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), '{"P-0001": ["1|FACTCOM|A|1|1"], ');
    assert.ok(log.mock.callCount() >= 3);
  } finally { cerrar(ctx); }
});

test('json de estado corrupto: grabar y liberar-verificacion dan 500 sin reescribirlo', async t => {
  t.mock.method(console, 'error', () => {});
  const ctx = await montar({ crudos: { 'compras_siga_estado.json': 'no es json' } });
  const archivo = path.join(ctx.dir, 'compras_siga_estado.json');
  try {
    const g = await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo());
    assert.deepStrictEqual(g, { status: 500, data: { ok: false, error: 'compras_siga_estado.json ilegible: no se graba para no perder vínculos.' } });
    const l = await liberar(ctx, { resultado: 'no_cargado' });
    assert.strictEqual(l.status, 500);
    assert.strictEqual(fs.readFileSync(archivo, 'utf8'), 'no es json');
    assert.strictEqual(ctx.grabados.length, 0);
  } finally { cerrar(ctx); }
});

test('escritura atómica: el vínculo se suma a los existentes, el archivo queda completo y sin .tmp', async () => {
  const ctx = await montar({ vinculos: { 'P-0001': ['1|FACTCOM|A|1|1'] } });
  try {
    assert.strictEqual((await pedir(ctx.base, 'POST', '/api/compras-siga/grabar', cuerpo())).status, 200);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(ctx.dir, 'pedidos_comprobantes.json'), 'utf8')), {
      'P-0001': ['1|FACTCOM|A|1|1'], 'P-0007': ['1|FACTCOM|A|5007|1071364'],
    });
    assert.deepStrictEqual(fs.readdirSync(ctx.dir).filter(n => n.endsWith('.tmp')), []);
  } finally { cerrar(ctx); }
});
