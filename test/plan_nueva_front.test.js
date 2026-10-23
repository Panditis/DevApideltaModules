'use strict';
const test = require('node:test');
const assert = require('node:assert');
// Script del navegador con export condicional al final (typeof module): se requiere directo, sin DOM.
const f = require('../public/js/plan_nueva_comun.js');

test('esc escapa HTML, comillas incluidas', () => {
  assert.strictEqual(f.esc(`<b a="1">'x'&</b>`), '&lt;b a=&quot;1&quot;&gt;&#39;x&#39;&amp;&lt;/b&gt;');
  assert.strictEqual(f.esc(null), '');
});

test('normalizarTexto quita acentos y mayúsculas', () => {
  assert.strictEqual(f.normalizarTexto('  Maní ÑANDÚ '), 'mani nandu');
});

test('fmtNum: null/undefined → —; números en es-AR', () => {
  assert.strictEqual(f.fmtNum(null), '—');
  assert.strictEqual(f.fmtNum(undefined), '—');
  assert.strictEqual(f.fmtNum(0), '0');
  assert.strictEqual(f.fmtNum(1234.5), '1.234,5');
});

test('duenioPlu: nombre de otra categoría que ya tiene el PLU, ignorando la propia', () => {
  const cats = [{ id: 'a', nombre: 'Almendras', plus: ['1'] }, { id: 'b', nombre: 'Nueces', plus: ['2'] }];
  assert.strictEqual(f.duenioPlu(cats, 1), 'Almendras');
  assert.strictEqual(f.duenioPlu(cats, '1', 'a'), null);
  assert.strictEqual(f.duenioPlu(cats, '9'), null);
});

// ── Tablero y carrito ───────────────────────────────────────────────────────────────────────
const fila = (x = {}) => ({ plu: '100', nombre: 'ALMENDRA 500G', consumoDia: 2, consumoMes: 60, stockCentral: 5, sugerido: 15, ...x });

test('filtrarTablero: sin texto todo; categoría que coincide entra entera; si no, filtra por nombre/PLU; sin acentos', () => {
  const cats = [
    { id: 'a', nombre: 'Maní', presentaciones: [fila({ plu: '1', nombre: 'MANI 500G' }), fila({ plu: '2', nombre: 'MANI 1KG' })] },
    { id: 'b', nombre: 'Nueces', presentaciones: [fila({ plu: '30', nombre: 'NUEZ MARIPOSA' })] },
    { id: 'c', nombre: 'Pasas', presentaciones: [] },
  ];
  assert.strictEqual(f.filtrarTablero(cats, '  '), cats);
  assert.deepStrictEqual(f.filtrarTablero(cats, 'MANÍ').map(c => [c.id, c.presentaciones.length]), [['a', 2]]);
  assert.deepStrictEqual(f.filtrarTablero(cats, 'mariposa').map(c => [c.id, c.presentaciones.map(p => p.plu)]), [['b', ['30']]]);
  assert.deepStrictEqual(f.filtrarTablero(cats, '3').map(c => c.id), ['b']);
  assert.deepStrictEqual(f.filtrarTablero(cats, 'pasas').map(c => c.id), ['c']); // categoría vacía que coincide por nombre
  assert.deepStrictEqual(f.filtrarTablero(cats, 'zzz'), []);
});

test('agregarAlCarrito: cantidad = sugerido (o 1 si es 0), PLU como texto, no duplica y no muta', () => {
  const vacio = f.carritoVacio('2026-10-22');
  const c1 = f.agregarAlCarrito(vacio, fila(), 'Almendras');
  assert.deepStrictEqual(c1.lineas, [{ plu: '100', nombre: 'ALMENDRA 500G', categoria: 'Almendras', cantidad: 15, responsables: [], notas: '' }]);
  assert.deepStrictEqual(vacio.lineas, []);
  assert.strictEqual(f.agregarAlCarrito(c1, fila(), 'Almendras'), c1);
  const c2 = f.agregarAlCarrito(c1, fila({ plu: 101, sugerido: 0 }), 'Almendras');
  assert.strictEqual(c2.lineas[1].plu, '101');
  assert.strictEqual(c2.lineas[1].cantidad, 1);
  assert.ok(f.enCarrito(c2, 101));
  assert.ok(!f.enCarrito(c1, '101'));
});

test('editarLinea y quitarDelCarrito devuelven carritos nuevos', () => {
  const c = f.agregarAlCarrito(f.agregarAlCarrito(f.carritoVacio('2026-10-22'), fila(), 'A'), fila({ plu: '2' }), 'A');
  const e = f.editarLinea(c, '100', { cantidad: 3, responsables: ['Ana'] });
  assert.deepStrictEqual([e.lineas[0].cantidad, e.lineas[0].responsables], [3, ['Ana']]);
  assert.strictEqual(c.lineas[0].cantidad, 15);
  assert.deepStrictEqual(f.quitarDelCarrito(e, 100).lineas.map(l => l.plu), ['2']);
  assert.strictEqual(e.lineas.length, 2);
});

test('payloadOrden: fecha, notas y líneas sin la categoría', () => {
  const c = { ...f.agregarAlCarrito(f.carritoVacio('2026-10-22'), fila(), 'Almendras'), notas: 'lunes' };
  assert.deepStrictEqual(f.payloadOrden(c), {
    fecha: '2026-10-22', notas: 'lunes',
    lineas: [{ plu: '100', nombre: 'ALMENDRA 500G', cantidad: 15, responsables: [], notas: '' }],
  });
});

test('leerCarrito: nada, roto, forma inválida o storage que tira → vacío de hoy; válido → el guardado', () => {
  const hoy = '2026-10-22';
  const st = valor => ({ getItem: () => valor });
  assert.deepStrictEqual(f.leerCarrito(st(null), hoy), f.carritoVacio(hoy));
  assert.deepStrictEqual(f.leerCarrito(st('{roto'), hoy), f.carritoVacio(hoy));
  assert.deepStrictEqual(f.leerCarrito(st('{"lineas":3}'), hoy), f.carritoVacio(hoy));
  assert.deepStrictEqual(f.leerCarrito({ getItem: () => { throw new Error('bloqueado'); } }, hoy), f.carritoVacio(hoy));
  const guardado = { fecha: '2026-10-20', notas: 'x', lineas: [] };
  assert.deepStrictEqual(f.leerCarrito(st(JSON.stringify(guardado)), hoy), guardado);
});

test('guardarCarrito escribe en la clave del módulo y no rompe si el storage tira', () => {
  const datos = {};
  f.guardarCarrito({ setItem: (k, v) => { datos[k] = v; } }, f.carritoVacio('2026-10-22'));
  assert.deepStrictEqual(JSON.parse(datos['planNueva.carrito.v1']), f.carritoVacio('2026-10-22'));
  assert.doesNotThrow(() => f.guardarCarrito({ setItem: () => { throw new Error('lleno'); } }, f.carritoVacio('x')));
});

test('hoyISO devuelve la fecha local (a las 23:30 sigue siendo hoy)', () => {
  assert.strictEqual(f.hoyISO(new Date(2026, 9, 22, 23, 30)), '2026-10-22');
});
