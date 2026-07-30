const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Contrato del archivo REAL data/listas_distribucion.json ───────────────────────────────────
// Estos tests no prueban código: prueban la CONFIGURACIÓN que está commiteada en el repo.
// Existen porque la divergencia entre dev y prod en estas listas ya causó un bug en producción
// (un PLU que aparecía en una planilla y no en la otra). Un invariante roto acá es un hallazgo
// real de datos, no un test a relajar: hay que arreglar el JSON, no el assert.
const LISTAS_PATH = path.join(__dirname, '..', 'data', 'listas_distribucion.json');

// Réplica literal de RESTR_SUCURSALES en server.js (~línea 2790). Está duplicada a propósito:
// server.js no se puede requerir desde un test (su require ejecuta el bootstrap: SQL + listen).
// SI SE AGREGA O RENOMBRA UNA SUCURSAL EN server.js, HAY QUE ACTUALIZAR ESTA CONSTANTE.
const RESTR_SUCURSALES_ESPERADAS = ['rivadavia', 'urquiza', 'chacabuco', 'nacion', 'pergamino', 'sanPedro', 'villaRamallo'];

const LISTAS_PLANAS = ['noEnvasa', 'siempreAlmacen', 'siemprePesable', 'siemprePesableSinGranel', 'ocultarPesable'];

// El archivo se siembra en el primer arranque del server, así que en un clon limpio puede no
// existir todavía. En ese caso los invariantes no aplican y saltamos en lugar de fallar.
function leerListas(t) {
  if (!fs.existsSync(LISTAS_PATH)) {
    t.skip('data/listas_distribucion.json no existe todavia (se siembra al primer arranque)');
    return null;
  }
  return JSON.parse(fs.readFileSync(LISTAS_PATH, 'utf8'));
}

test('ningun PLU esta a la vez en siemprePesable y en ocultarPesable', (t) => {
  const l = leerListas(t);
  if (!l) return;
  // Contradicción de intención: "mostralo siempre" contra "ocultalo". La implementación resuelve
  // a favor de ocultarPesable (se aplica al final), así que el PLU de siemprePesable queda
  // silenciosamente inerte y el operador no se entera de por qué no lo ve.
  const ocultos = new Set((l.ocultarPesable || []).map(Number));
  const choque = (l.siemprePesable || []).map(Number).filter(p => ocultos.has(p));
  assert.deepStrictEqual(choque, [],
    `PLUs en siemprePesable y ocultarPesable a la vez: ${choque.join(', ')}`);
});

test('siemprePesableSinGranel esta contenido en siemprePesable', (t) => {
  const l = leerListas(t);
  if (!l) return;
  // siemprePesableSinGranel marca "pesable que no se arma desde granel". El universo real de
  // Pesables es (rubro Pesables Fraccionado) ∪ siemprePesable, y desde un test no se puede
  // consultar SQL para saber el rubro. Así que validamos la parte verificable: todo PLU de
  // siemprePesableSinGranel que NO esté en siemprePesable depende de que el rubro de Siga lo
  // incluya, y eso no está documentado en ninguna parte del JSON → lo tratamos como violación.
  const enSiempre = new Set((l.siemprePesable || []).map(Number));
  const huerfanos = (l.siemprePesableSinGranel || []).map(Number).filter(p => !enSiempre.has(p));
  assert.deepStrictEqual(huerfanos, [],
    `PLUs de siemprePesableSinGranel sin respaldo en siemprePesable (dependen del rubro de Siga, ` +
    `no verificable offline): ${huerfanos.join(', ')}`);
});

test('ninguna lista tiene PLUs duplicados', (t) => {
  const l = leerListas(t);
  if (!l) return;
  // Un duplicado no cambia el resultado (todo termina en un Set) pero delata edición manual del
  // JSON o un merge mal resuelto entre dev y prod, que es exactamente el origen del bug histórico.
  for (const k of LISTAS_PLANAS) {
    const arr = (l[k] || []).map(Number);
    const dups = [...new Set(arr.filter((p, i) => arr.indexOf(p) !== i))];
    assert.deepStrictEqual(dups, [], `${k} tiene PLUs duplicados: ${dups.join(', ')}`);
  }
  for (const suc of RESTR_SUCURSALES_ESPERADAS) {
    const arr = ((l.restringidos || {})[suc] || []).map(Number);
    const dups = [...new Set(arr.filter((p, i) => arr.indexOf(p) !== i))];
    assert.deepStrictEqual(dups, [], `restringidos.${suc} tiene PLUs duplicados: ${dups.join(', ')}`);
  }
});

test('todos los PLUs de todas las listas son enteros positivos', (t) => {
  const l = leerListas(t);
  if (!l) return;
  // universoLista descarta cualquier cosa no numérica de basePlus, pero NO valida las listas:
  // un null, un "" o un 0 entrarían al universo y se interpolarían en el IN (...) de las queries.
  const esPluValido = p => Number.isInteger(p) && p > 0;
  const revisar = (nombre, arr) => {
    const malos = (arr || []).filter(p => !esPluValido(p));
    assert.deepStrictEqual(malos, [],
      `${nombre} tiene valores que no son enteros positivos: ${JSON.stringify(malos)}`);
  };
  for (const k of LISTAS_PLANAS) revisar(k, l[k]);
  for (const suc of RESTR_SUCURSALES_ESPERADAS) revisar(`restringidos.${suc}`, (l.restringidos || {})[suc]);
});

test('las claves de restringidos coinciden exactamente con RESTR_SUCURSALES', (t) => {
  const l = leerListas(t);
  if (!l) return;
  // Una clave de más quedaría muerta (leerListasDistrib sólo itera RESTR_SUCURSALES) y una de
  // menos se rellenaría con [] en silencio, dejando una sucursal sin restricciones sin aviso.
  const claves = Object.keys(l.restringidos || {}).sort();
  assert.deepStrictEqual(claves, [...RESTR_SUCURSALES_ESPERADAS].sort(),
    'las claves de restringidos divergen de RESTR_SUCURSALES en server.js');
});
