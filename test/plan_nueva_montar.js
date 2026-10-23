'use strict';
// Monta routes/rutas_plan_nueva.js con un DATA_DIR temporal y un query falso que responde según el SQL.
// No termina en .test.js: lo requieren los tests de rutas de planificación nueva.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// filasSql: { 'fragmento del SQL': filas | (sql) => filas }. Gana la primera clave contenida en el SQL; una
// función que tira simula a SIGA caído. archivos: { 'nombre.json': contenido } precargados en DATA_DIR.
// usuario: login que queda en req.session.user.usuario.
function montar({ filasSql = {}, archivos = {}, usuario = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-nueva-'));
  const leerJSON = (p, def) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : def);
  const guardarJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));
  for (const [archivo, contenido] of Object.entries(archivos)) guardarJSON(path.join(dir, archivo), contenido);
  const sqls = [];
  const query = async sql => {
    sqls.push(sql);
    for (const [clave, filas] of Object.entries(filasSql)) {
      if (sql.includes(clave)) return typeof filas === 'function' ? filas(sql) : filas;
    }
    return [];
  };
  const app = express();
  app.use(express.json());
  if (usuario) app.use((req, _res, next) => { req.session = { user: { usuario } }; next(); });
  app.use(require('../routes/rutas_plan_nueva')({
    leerJSON, guardarJSON, query, DATA_DIR: dir,
    sqlStockPorPlu: l => `STOCKCENTRAL ${l.join(',')}`,
  }));
  return new Promise(ok => {
    const server = app.listen(0, () => ok({
      server, dir, sqls,
      base: `http://127.0.0.1:${server.address().port}`,
      leer: archivo => leerJSON(path.join(dir, archivo), null),
    }));
  });
}

async function pedir(base, metodo, url, body) {
  const r = await fetch(base + url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

function cerrar({ server, dir }) {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// Respuesta falsa de la consulta de nombres de SIGA: sólo los PLU pedidos que estén en `productos`.
const nombresDe = productos => sql => Object.entries(productos)
  .filter(([plu]) => sql.includes(`'${plu}'`))
  .map(([IdProducto, NombreProducto]) => ({ IdProducto, NombreProducto }));

module.exports = { montar, pedir, cerrar, nombresDe };
