const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Buscador manual del plan del día: SAVONA pasa la exclusión de rubro ───────
// El modal "+ Agregar producto" pega a /api/plan/sugerencias?q=..., que descarta el rubro
// "Almacen Bultos/Cajas" (no se producen por unidad). Casi todos los SAVONA viven en ese rubro,
// así que quedaban invisibles: son productos especiales y pasan por encima de la exclusión,
// mismo criterio que ya usa /api/productos/buscar.
//
// server.js no se puede requerir (el require arranca el bootstrap: SQL + listen), así que se
// extraen las dos constantes y la línea del filtro por texto y se evalúan.

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function lineaQueEmpiezaCon(prefijo) {
  const linea = SRC.split('\n').find(l => l.trim().startsWith(prefijo));
  assert.ok(linea, `no se encontró la línea que empieza con ${prefijo}`);
  return linea.trim();
}

const filtro = (() => {
  const src = [
    lineaQueEmpiezaCon('const RUBRO_MANUAL_EXCLUIDO_RE ='),
    lineaQueEmpiezaCon('const PRODUCTO_SAVONA_RE ='),
    'return r => (' + lineaQueEmpiezaCon('out = out.filter(r =>').replace(/^out = out\.filter\(r => /, '').replace(/\);$/, '') + ');'
  ].join('\n');
  return new Function(src)();
})();

test('deja pasar los SAVONA aunque estén en Almacen Bultos/Cajas', () => {
  assert.strictEqual(filtro({ producto: 'SAVONA Aceto Balsamico 500Cc', rubro: 'Almacen Bultos/Cajas' }), true);
  assert.strictEqual(filtro({ producto: 'Aceite Oliva Savona Fit Jengibre 500Ml', rubro: 'Almacen Bultos/Cajas' }), true);
});

test('sigue excluyendo los bultos/cajas que no son SAVONA', () => {
  assert.strictEqual(filtro({ producto: 'Arroz Largo Fino 1Kg CAJA', rubro: 'Almacen Bultos/Cajas' }), false);
});

test('no toca los productos de otros rubros', () => {
  assert.strictEqual(filtro({ producto: 'SAVONA Vinagre De Manzana 250Cc UNIDAD', rubro: 'Productos terceros' }), true);
  assert.strictEqual(filtro({ producto: 'Mani Tostado 500G', rubro: 'Pesables Deposito' }), true);
});
