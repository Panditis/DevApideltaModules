'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const XLSX = require('xlsx');
const C = require('../lib/cotizador_mayorista');

const ENC = ['Codigo', 'Producto', 'CodigoPack', 'Cantidad pack', 'CodigoBulto', 'CantidadBulto', 'NombrePack', 'NombreBulto'];
// SIGA: cod 100 tiene pack 101 y bulto 102.
const listados = { almacen: [{ plu: '100', mayoristas: [{ plu: '101', tipo: 'pack', nombre: 'Pack101' }, { plu: '102', tipo: 'bulto', nombre: 'Bulto102' }] }] };
const filas = [
  { cod: '100', seccion: 'A', nombre: 'Siga', packQty: '4', bultoQty: 'caja x 8u' },
  { cod: '200', seccion: 'B', nombre: 'Explicito', packQty: 'raro', bultoQty: '', packPlu: '201', bultoPlu: '202', incluido: false },
  { cod: 'X1', seccion: 'A', nombre: 'Manual', packQty: '10kg', bultoQty: '', manual: true, packPlu: '9' },
  { cod: '100', seccion: 'A', nombre: 'Ninguno', packQty: '4', bultoQty: '8', modoPack: 'ninguno', packPlu: '777' },
];

test('filasExportarCodigos: encabezados, orden por sección, explícito, SIGA, manual, ninguno', () => {
  const r = C.filasExportarCodigos(filas, C.indicePrecios(listados));
  assert.deepStrictEqual(r, [
    ENC,
    [100, 'Siga', 101, '4u', 102, '8u', 'Pack101', 'Bulto102'],
    ['X1', 'Manual', '', '10kg', '', '', '', ''],
    [100, 'Ninguno', '', '4u', 102, '8u', '', 'Bulto102'],
    [200, 'Explicito', 201, 'raro', 202, '', '', ''],
  ]);
});

function montar(listadosVigentes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cotmay-cod-'));
  fs.writeFileSync(path.join(dir, 'cotizador_mayorista.json'), JSON.stringify({ filas }));
  const apiRoute = fn => async (req, res) => res.json(await fn(req));
  const app = express();
  app.use(require('../routes/rutas_cotizador_mayorista')({ apiRoute, DATA_DIR: dir, tienePermiso: () => false, listadosVigentes }));
  return new Promise(ok => { const server = app.listen(0, () => ok({ server, dir, url: `http://127.0.0.1:${server.address().port}/api/cotizador-mayorista/codigos.xlsx` })); });
}
const cerrar = ({ server, dir }) => { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); };
const leer = async r => XLSX.utils.sheet_to_json(XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' }).Sheets.codigos, { header: 1, defval: '' });

test('ruta codigos.xlsx: headers y contenido releído (sin permiso de escritura)', async () => {
  const ctx = await montar(async () => listados);
  try {
    const r = await fetch(ctx.url);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="cotizador_codigos_\d{4}-\d{2}-\d{2}\.xlsx"$/);
    const aoa = await leer(r);
    assert.deepStrictEqual(aoa[0], ENC);
    assert.strictEqual(aoa.length, filas.length + 1);
    assert.deepStrictEqual(aoa[1], [100, 'Siga', 101, '4u', 102, '8u', 'Pack101', 'Bulto102']);
  } finally { cerrar(ctx); }
});

test('ruta codigos.xlsx: listados falla → exporta sólo PLU explícitos', async () => {
  const ctx = await montar(async () => { throw new Error('sql caído'); });
  try {
    const r = await fetch(ctx.url);
    assert.strictEqual(r.status, 200);
    const aoa = await leer(r);
    assert.deepStrictEqual(aoa[1], [100, 'Siga', '', '4u', '', '8u', '', '']);
    assert.deepStrictEqual(aoa[4], [200, 'Explicito', 201, 'raro', 202, '', '', '']);
  } finally { cerrar(ctx); }
});
