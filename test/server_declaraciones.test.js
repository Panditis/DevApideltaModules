// server.js pasa las 10.000 líneas y se edita desde varios lados a la vez. Dos
// `function foo()` de nivel superior con el mismo nombre no son un error de sintaxis:
// se hoistean y gana la última, así que las llamadas a la primera se van en silencio
// a la otra implementación. Ya pasó una vez — dos `comprasDeProveedor`, una del módulo
// de Compras y otra del de control, y /api/compras/armado devolvía siempre vacío.
//
// Al extraer routers (rutas_compras.js) aparece un segundo modo de falla: la factory
// recibe sus dependencias POR NOMBRE. Si server.js y el router declaran cada uno un
// `foo` y el cableado inyecta el de server.js, el router usa una implementación que no
// es la suya — sin error, sin test roto y con `node --check` verde.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Cada router nuevo se suma acá.
const ARCHIVOS = ['server.js', 'routes/rutas_compras.js', 'routes/rutas_cruce_terminales.js', 'routes/rutas_productividad.js', 'routes/rutas_fraccionado_externo.js', 'routes/rutas_precios_proveedores.js', 'routes/rutas_rrhh.js', 'routes/rutas_mayoristas.js', 'routes/rutas_catalogo.js', 'routes/rutas_envases_tapas.js', 'routes/rutas_cotizador.js', 'routes/rutas_analisis.js', 'routes/rutas_cuentas_corrientes.js', 'routes/rutas_ventas_hora.js', 'routes/rutas_precios_historico.js', 'routes/rutas_compras_control.js', 'routes/rutas_auth.js', 'routes/rutas_produccion.js', 'routes/rutas_stock.js', 'routes/rutas_distribucion.js', 'routes/rutas_consumo.js', 'routes/rutas_facturador.js', 'routes/rutas_plan.js', 'routes/rutas_reservas.js', 'routes/rutas_precios.js', 'routes/rutas_cruce_bancario.js', 'routes/rutas_compras_siga.js', 'routes/rutas_tickets.js', 'routes/rutas_carteles_pesables.js', 'routes/rutas_plan_nueva.js']
  .map(f => path.join(__dirname, '..', f));

// Sólo nivel superior del archivo: una declaración anidada arranca indentada.
// (Los bloques movidos a rutas_compras.js conservan su indentación original de
// columna 0, así que siguen contando como declaraciones del módulo.)
function declaraciones(archivo) {
  const vistos = new Map();   // nombre → primera línea
  const duplicados = [];
  fs.readFileSync(archivo, 'utf8').split('\n').forEach((linea, i) => {
    const m = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(linea);
    if (!m) return;
    if (vistos.has(m[1])) duplicados.push(`${m[1]}: líneas ${vistos.get(m[1])} y ${i + 1}`);
    else vistos.set(m[1], i + 1);
  });
  return { vistos, duplicados };
}

// Nombres que el módulo recibe por deps: el `const { … } = deps;` de la factory.
function nombresDeDeps(archivo) {
  const src = fs.readFileSync(archivo, 'utf8');
  const nombres = new Set();
  for (const m of src.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*deps\s*;/g)) {
    for (const n of m[1].replace(/\/\/[^\n]*/g, ' ').match(/[A-Za-z_$][\w$]*/g) || []) nombres.add(n);
  }
  return nombres;
}

// Regla A — el bug del hoisting: dos declaraciones del mismo nombre en un archivo.
for (const archivo of ARCHIVOS) {
  const nombre = path.basename(archivo);
  test(`${nombre} no declara dos funciones de nivel superior con el mismo nombre`, () => {
    const { duplicados } = declaraciones(archivo);
    assert.deepStrictEqual(duplicados, [],
      `Declaraciones duplicadas en ${nombre} (la última pisa a la anterior):\n  ${duplicados.join('\n  ')}`);
  });
}

// Regla B — el bug del cableado: un nombre declarado en dos módulos Y que además
// viaja por deps. Homónimos que NO cruzan por deps son privados de cada módulo y
// están bien (`num`, `redondear`, `clavePlu`…): no se reportan.
test('ningún nombre que viaja por deps está declarado en dos módulos a la vez', () => {
  const porArchivo = ARCHIVOS.map(a => ({ archivo: path.basename(a), decls: declaraciones(a).vistos }));
  const deps = new Set(ARCHIVOS.flatMap(a => [...nombresDeDeps(a)]));

  const choques = [];
  for (const nombre of deps) {
    const donde = porArchivo.filter(x => x.decls.has(nombre));
    if (donde.length < 2) continue;
    choques.push(`${nombre}: declarada en ${donde.map(x => `${x.archivo}:${x.decls.get(nombre)}`).join(' y ')}` +
      ' — y además viaja por deps, así que el router puede terminar usando la implementación del otro módulo');
  }

  assert.deepStrictEqual(choques, [],
    `Nombres inyectados por deps con declaración propia en otro módulo:\n  ${choques.join('\n  ')}`);
});
