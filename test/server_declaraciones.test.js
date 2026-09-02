// server.js pasa las 10.000 líneas y se edita desde varios lados a la vez. Dos
// `function foo()` de nivel superior con el mismo nombre no son un error de sintaxis:
// se hoistean y gana la última, así que las llamadas a la primera se van en silencio
// a la otra implementación. Ya pasó una vez — dos `comprasDeProveedor`, una del módulo
// de Compras y otra del de control, y /api/compras/armado devolvía siempre vacío.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'server.js');

test('server.js no declara dos funciones de nivel superior con el mismo nombre', () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  const vistos = new Map();
  const duplicados = [];

  src.split('\n').forEach((linea, i) => {
    // Sólo nivel superior: una declaración anidada arranca indentada.
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(linea);
    if (!m) return;
    const nombre = m[1];
    if (vistos.has(nombre)) duplicados.push(`${nombre}: líneas ${vistos.get(nombre)} y ${i + 1}`);
    else vistos.set(nombre, i + 1);
  });

  assert.deepStrictEqual(duplicados, [],
    `Declaraciones duplicadas en server.js (la última pisa a la anterior):\n  ${duplicados.join('\n  ')}`);
});
