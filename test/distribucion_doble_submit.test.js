const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Doble-submit en la carga de fraccionado ───────────────────────────────────
// El 02/09/26 el PLU 1218 entró 12 veces con el mismo lote, empleado y tramo horario, en una
// ventana de 335 ms: la operaria apretó Guardar varias veces porque el server estaba trabado y no
// respondía, las requests se encolaron y entraron todas juntas. El id lo pone el server con
// Date.now() al procesar, no al enviar, por eso el burst. El POST ahora rebota el reenvío.
//
// server.js no se puede requerir (el require dispara el bootstrap: conexión SQL + listen), así que
// el handler se extrae del fuente por nombre y se evalúa con el disco y la respuesta simulados.
// Las rutas de fraccionado-registros/historial viven en rutas_distribucion.js (refactor de
// ruteo): ahí registran con `router.post(...)`, no `app.post(...)`.

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'rutas_distribucion.js'), 'utf8');
const DISTRIB = fs.readFileSync(path.join(__dirname, '..', 'distribucion.html'), 'utf8');

// Devuelve el bloque de código que arranca en `desde` y termina en su llave de cierre. Arrastra el
// `);` que cierra la llamada cuando el bloque es un callback (app.post('...', (req, res) => {...})),
// que si no queda cortado a la mitad y no compila.
function bloqueDesde(fuente, desde, etiqueta) {
  const ini = fuente.indexOf(desde);
  assert.notStrictEqual(ini, -1, `no se encontró ${etiqueta}`);
  let nivel = 0, visto = false;
  for (let i = ini; i < fuente.length; i++) {
    if (fuente[i] === '{') { nivel++; visto = true; }
    else if (fuente[i] === '}') {
      nivel--;
      if (!visto || nivel !== 0) continue;
      const cola = (fuente.slice(i + 1).match(/^\s*\)?\s*;?/) || [''])[0];
      return fuente.slice(ini, i + 1) + cola;
    }
  }
  assert.fail(`no se pudo cerrar ${etiqueta}`);
}

// Monta el handler del POST con leerJSON/guardarJSON apuntando a un array en memoria.
function montarPost() {
  const disco = { arr: [] };
  const handler = new Function('disco', `
    const FRAC_REG_PATH = '/fake';
    const leerJSON = () => disco.arr;
    const guardarJSON = (_p, d) => { disco.arr = d; };
    let capturado = null;
    const router = { post: (_ruta, fn) => { capturado = fn; } };
    ${bloqueDesde(SERVER, 'function claveRegistroFrac(', 'function claveRegistroFrac(')}
    ${bloqueDesde(SERVER, "router.post('/api/distribucion/fraccionado-registros'", 'POST fraccionado-registros')}
    return capturado;
  `)(disco);
  // res mínimo: guarda el status y el cuerpo devuelto.
  const post = body => {
    const out = { status: 200, body: null };
    handler({ body }, { status(c) { out.status = c; return this; }, json(j) { out.body = j; return this; } });
    return out;
  };
  return { post, disco };
}

const CARGA = {
  plu: '1218', nombre: 'Casc Naranja Glaseada 100G', fecha: '2026-09-02', empleado: 'Malena',
  desde: '13:00', hasta: '14:30', cantFraccionada: 5.975, granelConsumido: 5.97,
  lote: '020926MALE1-1218',
};

test('doce clicks en la misma carga dejan un solo registro', () => {
  const { post, disco } = montarPost();
  const respuestas = Array.from({ length: 12 }, () => post({ ...CARGA }));
  assert.strictEqual(disco.arr.length, 1, 'quedó más de un registro');
  assert.ok(respuestas.every(r => r.body.ok), 'algún reenvío devolvió error al front');
  // Todos apuntan al mismo registro: el front puede marcar la línea de orden sin importar cuál ganó.
  const ids = new Set(respuestas.map(r => r.body.id));
  assert.strictEqual(ids.size, 1, `los reenvíos devolvieron ids distintos: ${[...ids]}`);
  assert.ok(respuestas.slice(1).every(r => r.body.duplicado), 'los reenvíos no vinieron marcados');
});

test('el mismo producto en otro tramo horario sí es una carga nueva', () => {
  const { post, disco } = montarPost();
  post({ ...CARGA });
  post({ ...CARGA, desde: '15:00', hasta: '16:00' });
  assert.strictEqual(disco.arr.length, 2);
});

test('el mismo tramo con otra cantidad sí es una carga nueva', () => {
  const { post, disco } = montarPost();
  post({ ...CARGA });
  post({ ...CARGA, cantFraccionada: 8 });
  assert.strictEqual(disco.arr.length, 2);
});

test('mismo producto y tramo pero otro empleado no se pisan', () => {
  const { post, disco } = montarPost();
  post({ ...CARGA });
  post({ ...CARGA, empleado: 'Noelia', lote: '020926NOEL1-1218' });
  assert.strictEqual(disco.arr.length, 2);
});

test('la misma carga en otra fecha no se toma por duplicada', () => {
  const { post, disco } = montarPost();
  post({ ...CARGA });
  post({ ...CARGA, fecha: '2026-09-03', lote: '030926MALE1-1218' });
  assert.strictEqual(disco.arr.length, 2);
});

test('sigue rechazando el cuerpo incompleto', () => {
  const { post, disco } = montarPost();
  assert.strictEqual(post({ plu: '1218' }).status, 400);
  assert.strictEqual(disco.arr.length, 0);
});

// ── Archivado del día ─────────────────────────────────────────────────────────
// El mismo doble click dejó dos entradas de historial del 02/09 (10:57 y 11:01 UTC).
test('archivar dos veces el mismo día deja un solo snapshot, el último', () => {
  const disco = { arr: [] };
  const handler = new Function('disco', `
    const HISTORIAL_PATH = '/fake';
    const leerJSON = () => disco.arr;
    const guardarJSON = (_p, d) => { disco.arr = d; };
    let capturado = null;
    const router = { post: (_ruta, fn) => { capturado = fn; } };
    ${bloqueDesde(SERVER, "router.post('/api/distribucion/historial'", 'POST historial')}
    return capturado;
  `)(disco);
  const post = body => handler({ body }, { status() { return this; }, json() { return this; } });

  post({ fecha: '2026-09-02', produccion: [{ plu: '1218' }] });
  post({ fecha: '2026-09-02', produccion: [{ plu: '1218' }, { plu: '3807' }] });
  post({ fecha: '2026-09-01', produccion: [] });

  const delDia = disco.arr.filter(x => x.fecha === '2026-09-02');
  assert.strictEqual(delDia.length, 1, 'quedó más de un snapshot del mismo día');
  assert.strictEqual(delDia[0].produccion.length, 2, 'no ganó el snapshot más nuevo');
  assert.strictEqual(disco.arr.length, 2, 'se perdió el historial de otra fecha');
});

// ── Guardia en el front ───────────────────────────────────────────────────────
// El server ya deduplica, pero sin esto el botón no da señal de estar guardando y la operaria
// vuelve a apretar. Se verifica sobre el fuente porque el listener vive inline en el HTML.
test('el botón Guardar del modal se bloquea mientras la carga está en vuelo', () => {
  const listener = bloqueDesde(DISTRIB, "document.getElementById('mr-save').addEventListener(",
    'listener de mr-save');
  assert.match(listener, /if\s*\(\s*_mrGuardando\s*\)\s*return/, 'falta el corte por reentrada');
  assert.match(listener, /btn\.disabled\s*=\s*true/, 'no deshabilita el botón');
  // El finally es lo que evita que un error de red deje el botón muerto para siempre.
  assert.match(listener, /finally\s*\{[^}]*_mrGuardando\s*=\s*false/, 'no libera el flag en finally');
  assert.match(listener, /finally\s*\{[^}]*btn\.disabled\s*=\s*false/, 'no rehabilita el botón en finally');
});
