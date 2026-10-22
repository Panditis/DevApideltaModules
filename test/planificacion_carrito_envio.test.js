const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Carrito de planificación: orden por rankingPos y payload del envío ────────
// (Los casos de "granel previo" automático se fueron con el Resumen: el Tablero no los dispara.)
//
// Las funciones viven en public/js/planificacion_*.js (scripts del navegador, no hay módulo que
// requerir): se extraen por nombre y se evalúan inyectando los bordes (API, toast, picker) como stubs.

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const HTML = fs.readdirSync(JS_DIR).filter(f => /^planificacion_.*\.js$/.test(f))
  .map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n');

// Corta el fuente de una función balanceando llaves desde `function nombre(`, para que sirva
// tanto con las de una línea como con las de varias (enviarCarrito).
function fuenteDe(nombre) {
  const ini = HTML.search(new RegExp(`(?:async )?function ${nombre}\\(`));
  assert.notStrictEqual(ini, -1, `no se encontró function ${nombre}(`);
  let nivel = 0, visto = false;
  for (let i = ini; i < HTML.length; i++) {
    if (HTML[i] === '{') { nivel++; visto = true; }
    else if (HTML[i] === '}') { nivel--; if (visto && nivel === 0) return HTML.slice(ini, i + 1); }
  }
  assert.fail(`no se pudo cerrar function ${nombre}(`);
}

// La declaración completa de una const de una línea, tal cual está en el archivo.
function constDe(nombre) {
  const ini = HTML.indexOf(`const ${nombre} =`);
  assert.notStrictEqual(ini, -1, `no se encontró const ${nombre}`);
  return HTML.slice(ini, HTML.indexOf('\n', ini));
}


// ── carrito: orden por rankingPos y payload del envío ─────────────────────────

// Arma lineasOrdenadas y enviarCarrito sobre `lineas`, con los bordes (API, MP, toast, picker)
// stubbeados. `carrito` es un parámetro porque el fuente lo reasigna (let en el navegador).
function carritoEnvioEntorno(lineas) {
  const posts = [];
  const src = [
    constDe('nombreLinea'),
    constDe('_posLinea'),
    constDe('lineasOrdenadas'),
    fuenteDe('enviarCarrito'),
    'return { lineasOrdenadas, enviarCarrito };',
  ].join('\n');
  const api = new Function(
    'carrito', 'CARRITO_VACIO', 'cargarGruposCfgSiVacio', 'mostrarMPResumen', 'avisosCarrito',
    'api', 'guardarCarrito', 'document', 'formatFecha', 'toast', 'irAlDia', 'mensajeApiError', src
  )(
    { fecha: '2026-10-22', lineas, notas: '' }, { fecha: null, lineas: [], notas: '' },
    async () => {}, async () => true, async () => '',
    async (metodo, url, body) => { posts.push({ metodo, url, body }); return { nuevas: 1, actualizadas: 0, omitidos: [] }; },
    () => {}, { getElementById: () => ({}) }, f => f, () => {}, () => {}, e => String(e),
  );
  return { ...api, posts };
}

test('el carrito se ordena por rankingPos: sin rankingPos al final, empates en orden de alta', () => {
  const { lineasOrdenadas } = carritoEnvioEntorno([
    { _id: 1 }, { _id: 2, rankingPos: 3 }, { _id: 3, rankingPos: 1 }, { _id: 4 }, { _id: 5, rankingPos: 3 },
  ]);

  assert.deepStrictEqual(lineasOrdenadas().map(l => l._id), [3, 2, 5, 1, 4]);
});

test('el envío manda las líneas en ese orden con prioridad = lugar + 1 y sin campos de UI', async () => {
  const { enviarCarrito, posts } = carritoEnvioEntorno([
    { _id: 11, _pkOk: true, producto: 'Manual', cantConfirmada: 2 },
    { _id: 12, _pkOk: true, rankingPos: 5, producto: 'Zeta', cantConfirmada: 1 },
    { _id: 13, _pkOk: true, rankingPos: 2, producto: 'Apimani', cantConfirmada: 4 },
  ]);

  await enviarCarrito();

  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, '/api/plan/2026-10-22/envio');
  assert.deepStrictEqual(posts[0].body.items, [
    { producto: 'Apimani', cantConfirmada: 4, prioridad: 1 },
    { producto: 'Zeta', cantConfirmada: 1, prioridad: 2 },
    { producto: 'Manual', cantConfirmada: 2, prioridad: 3 },
  ]);
});
