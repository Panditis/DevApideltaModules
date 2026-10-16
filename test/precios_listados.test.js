'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { htmlSelectDecision, filtrarFilas, ordenarListado, ordenSinNulo, filasDeClase, resumenExport, filasExportListado } = require('../public/js/precios_listados.js');

test('htmlSelectDecision: una opción por entrada, la decisión guardada seleccionada, sin precio deshabilitada, aria-label con el producto', () => {
  const ops = [{ valor: '', texto: 'No cambiar', disabled: false }, { valor: 'sistema', texto: 'Sistema · $ 1.800 (+2.0%)', disabled: false },
    { valor: 'ultimaCompra', texto: 'Última compra · Sin compras registradas', disabled: true }];
  const sin = htmlSelectDecision({ plu: '7', nombre: 'Arroz "Gallo" <1kg>', decision: null }, ops);
  assert.match(sin, /<select class="lst-decision num-in text-left" data-plu="7" data-actual="" aria-label="Decisión de precio: Arroz &quot;Gallo&quot; &lt;1kg&gt;">/);
  assert.match(sin, /<option value="" selected>No cambiar<\/option>/);
  assert.match(sin, /<option value="ultimaCompra" disabled>Última compra · Sin compras registradas<\/option>/);
  assert.doesNotMatch(sin, /<option value="sistema"[^>]*(selected|disabled)/);
  assert.match(sin, /class="lst-dec-msg[^"]*" role="alert"/);
  const con = htmlSelectDecision({ plu: '7', nombre: 'Arroz', decision: { fuente: 'sistema' } }, ops);
  assert.match(con, /class="lst-decision num-in text-left on" data-plu="7" data-actual="sistema"/);
  assert.match(con, /<option value="sistema" selected>Sistema · \$ 1\.800 \(\+2\.0%\)<\/option>/);
  assert.doesNotMatch(con, /<option value=""[^>]* selected/);
});

test('htmlSelectDecision: deshabilitado entero (cambios sin guardar) con su título', () => {
  const html = htmlSelectDecision({ plu: '7', nombre: 'Arroz', decision: null }, [{ valor: '', texto: 'No cambiar', disabled: false }],
    { deshabilitado: true, titulo: 'Guardá los cambios' });
  assert.match(html, /aria-label="Decisión de precio: Arroz" disabled title="Guardá los cambios">/);
});

test('filtrarFilas: texto en PLU/nombre (y presentaciones), sólo decididos, última compra más cara', () => {
  const filas = [
    { plu: '1', nombre: 'Azúcar', decision: { fuente: 'sistema' }, costoSistema: 100, costoUltimaCompra: 120 },
    { plu: '2', nombre: 'Arroz', decision: null, costoSistema: 100, costoUltimaCompra: 90 },
    { plu: '3', nombre: 'Almendras', decision: null, presentaciones: [{ plu: '31', nombre: 'Almendras 500G' }] },
  ];
  assert.deepStrictEqual(filtrarFilas(filas, { texto: 'azucar' }).map(f => f.plu), ['1']);
  assert.deepStrictEqual(filtrarFilas(filas, { texto: '31' }).map(f => f.plu), ['3']);
  assert.deepStrictEqual(filtrarFilas(filas, { soloDecididos: true }).map(f => f.plu), ['1']);
  assert.deepStrictEqual(filtrarFilas(filas, { ultimaMasCara: true }).map(f => f.plu), ['1']);
  assert.strictEqual(filtrarFilas(filas).length, 3);
});

test('filtrarFilas: soloHoy deja sólo las filas con ingresoHoy y se combina con los otros filtros', () => {
  const filas = [
    { plu: '1', nombre: 'Azúcar', ingresoHoy: true, decision: { fuente: 'sistema' }, costoSistema: 100, costoUltimaCompra: 120 },
    { plu: '2', nombre: 'Arroz', ingresoHoy: true, decision: null, costoSistema: 100, costoUltimaCompra: 90 },
    { plu: '3', nombre: 'Almendras', ingresoHoy: false, decision: { fuente: 'sistema' }, costoSistema: 100, costoUltimaCompra: 150 },
    { plu: '4', nombre: 'Sal' }, // sin el campo (fila vieja / Producción): no cuenta como cargada hoy
  ];
  const plus = o => filtrarFilas(filas, o).map(f => f.plu);
  assert.deepStrictEqual(plus({ soloHoy: true }), ['1', '2']);
  assert.deepStrictEqual(plus({ soloHoy: false }), ['1', '2', '3', '4']);
  assert.deepStrictEqual(plus({ soloHoy: true, soloDecididos: true }), ['1']);
  assert.deepStrictEqual(plus({ soloHoy: true, ultimaMasCara: true }), ['1']);
  assert.deepStrictEqual(plus({ soloHoy: true, texto: 'arroz' }), ['2']);
  assert.deepStrictEqual(plus({ soloHoy: true, texto: 'almendras' }), []);
});

const nombres = filas => filas.map(f => f.nombre);
const conPlu = nombres => nombres.map((nombre, i) => ({ plu: String(i + 1), nombre }));
const sug = precio => ({ minorista: { precio } });

test('ordenarListado: sin orden elegido va por nombre A→Z, sin mayúsculas ni acentos (ñ después de n)', () => {
  const filas = conPlu(['zeta', 'Ñandú', 'árbol', 'Bolsa', 'angel b', 'Ángel', 'nuez']);
  assert.deepStrictEqual(nombres(ordenarListado(filas)), ['Ángel', 'angel b', 'árbol', 'Bolsa', 'nuez', 'Ñandú', 'zeta']);
  assert.deepStrictEqual(nombres(ordenarListado(filas, null)), nombres(ordenarListado(filas)));
  assert.strictEqual(filas[0].nombre, 'zeta', 'no muta la entrada');
});

test('ordenarListado: numéricas con nulls al final en asc y en desc; PLU como número', () => {
  const filas = [
    { plu: '10', nombre: 'a', costoSistema: 100, vigente: null, sugeridos: { sistema: sug(300) } },
    { plu: '9', nombre: 'b', costoSistema: null, vigente: 50, sugeridos: { sistema: { error: 'costo', minorista: null } } },
    { plu: '100', nombre: 'c', costoSistema: 50, vigente: 70, sugeridos: {} },
    { plu: null, nombre: 'd', costoSistema: 75, vigente: 60, sugeridos: { sistema: sug(200) } },
  ];
  const nom = (clave, dir) => nombres(ordenarListado(filas, { clave, dir }));
  assert.deepStrictEqual(nom('costoSistema', 'asc'), ['c', 'd', 'a', 'b']);
  assert.deepStrictEqual(nom('costoSistema', 'desc'), ['a', 'd', 'c', 'b']);
  assert.deepStrictEqual(nom('plu', 'asc'), ['b', 'a', 'c', 'd']);
  assert.deepStrictEqual(nom('vigente', 'desc'), ['c', 'd', 'b', 'a']);
  assert.deepStrictEqual(nom('sugeridoSistema', 'asc'), ['d', 'a', 'b', 'c']);
  assert.deepStrictEqual(nom('sugeridoSistema', 'desc'), ['a', 'd', 'b', 'c']);
});

test('ordenarListado: última compra y Δ% (negativos como número); nombre desc', () => {
  const filas = [
    { plu: '1', nombre: 'a', costoUltimaCompra: 120, deltaUltimaPct: 20 }, { plu: '2', nombre: 'b', costoUltimaCompra: null, deltaUltimaPct: null },
    { plu: '3', nombre: 'c', costoUltimaCompra: 90, deltaUltimaPct: -10 },
  ];
  assert.deepStrictEqual(nombres(ordenarListado(filas, { clave: 'ultimaCompra', dir: 'asc' })), ['c', 'a', 'b']);
  assert.deepStrictEqual(nombres(ordenarListado(filas, { clave: 'deltaUltima', dir: 'asc' })), ['c', 'a', 'b']);
  assert.deepStrictEqual(nombres(ordenarListado(filas, { clave: 'deltaUltima', dir: 'desc' })), ['a', 'c', 'b']);
  assert.deepStrictEqual(nombres(ordenarListado(filas, { clave: 'nombre', dir: 'desc' })), ['c', 'b', 'a']);
});

test('ordenarListado: Fraccionado ordena los granel y deja cada presentación bajo el suyo; Sin granel siempre al final', () => {
  const pres = (...plus) => plus.map(plu => ({ plu, nombre: 'pres ' + plu }));
  const grupos = [
    { plu: '1', nombre: 'Maní', costoSistema: 10, presentaciones: pres('11', '12') },
    { plu: '2', nombre: 'almendra', costoSistema: 30, presentaciones: pres('21', '22', '23') },
    { plu: null, nombre: 'Sin granel asignado', costoSistema: null, presentaciones: pres('91') },
    { plu: '3', nombre: 'Castaña', costoSistema: 20, presentaciones: pres('31') },
  ];
  const plus = o => ordenarListado(grupos, o).map(g => [g.plu, g.presentaciones.map(p => p.plu)]);
  assert.deepStrictEqual(plus(), [['2', ['21', '22', '23']], ['3', ['31']], ['1', ['11', '12']], [null, ['91']]]);
  assert.deepStrictEqual(plus({ clave: 'nombre', dir: 'desc' }), [['1', ['11', '12']], ['3', ['31']], ['2', ['21', '22', '23']], [null, ['91']]]);
  assert.deepStrictEqual(plus({ clave: 'costoSistema', dir: 'desc' }), [['2', ['21', '22', '23']], ['3', ['31']], ['1', ['11', '12']], [null, ['91']]]);
  assert.strictEqual(ordenarListado(grupos)[0].presentaciones, grupos[1].presentaciones, 'las presentaciones no se tocan');
});

test('ordenSinNulo: el ciclo de siguienteOrden (asc → desc → null) acá alterna asc ⇄ desc, nunca sin orden', () => {
  const { siguienteOrden } = require('../public/js/precios_comun.js');
  let orden = { clave: 'nombre', dir: 'asc' };
  const clic = clave => { orden = ordenSinNulo(orden, siguienteOrden(orden, clave)); return orden; };
  assert.deepStrictEqual(clic('nombre'), { clave: 'nombre', dir: 'desc' });
  assert.deepStrictEqual(clic('nombre'), { clave: 'nombre', dir: 'asc' });
  assert.deepStrictEqual(clic('vigente'), { clave: 'vigente', dir: 'asc' });
  assert.deepStrictEqual(clic('vigente'), { clave: 'vigente', dir: 'desc' });
  assert.deepStrictEqual(clic('vigente'), { clave: 'vigente', dir: 'asc' });
});

test('filasDeClase: Producción separa Con receta (default) y Envasado Apidelta; otras tabs sin filtro', () => {
  const filas = [{ plu: '1' }, { plu: '2', tipoProduccion: 'receta' }, { plu: '3', tipoProduccion: 'envasado' }];
  assert.deepStrictEqual(filasDeClase(filas, 'receta').map(f => f.plu), ['1', '2']);
  assert.deepStrictEqual(filasDeClase(filas, 'envasado').map(f => f.plu), ['3']);
  assert.strictEqual(filasDeClase(filas, null), filas);
});


test('resumenExport: las 5 listas en orden con su etiqueta y cuántas filas (sin encabezado); las vacías quedan con 0', () => {
  const E = ['Codigo', 'Nombre', 'Costo', 'Venta'];
  const listas = { minorista: [E, ['1', 'A', 1, 2], ['2', 'B', 1, 2]], packNeto: [E], packIva: [E], bultoNeto: [E, ['9', 'A x10', 1, 2]], bultoIva: [E, ['9', 'A x10', 1, 2]] };
  const r = resumenExport(listas);
  assert.deepStrictEqual(r.map(x => [x.lista, x.filas]), [['minorista', 2], ['packNeto', 0], ['packIva', 0], ['bultoNeto', 1], ['bultoIva', 1]]);
  assert.deepStrictEqual(r.map(x => x.etiqueta), ['Minorista', 'Pack s/IVA', 'Pack c/IVA', 'Bulto s/IVA', 'Bulto c/IVA']);
  assert.strictEqual(resumenExport({}).every(x => x.filas === 0), true); // lista faltante = vacía
});

// ── Exportar listado (.xlsx, reporte) ──
test('filasExportListado Reventa: encabezado + una fila por producto, números reales y Δ% como fracción; sin dato → null', () => {
  const aoa = filasExportListado([
    { plu: '540', nombre: 'Arroz', costoSistema: 1000, costoUltimaCompra: 1100, fechaUltimaCompra: '2026-10-01', vigente: 2000,
      sugeridos: { sistema: sug(2500), ultimaCompra: sug(2600) } },
    { plu: '7', nombre: 'Sal', costoSistema: null, costoUltimaCompra: null, vigente: null, sugeridos: { sistema: { error: 'x' }, ultimaCompra: null } },
  ], 'almacen');
  assert.deepStrictEqual(aoa[0], ['PLU', 'Nombre', 'Costo actual (sistema)', 'Costo última compra', 'Δ% costo (última vs actual)', 'Fecha última compra',
    'Precio actual', 'Precio nuevo con costo actual', 'Δ% (vs precio actual)', 'Precio nuevo con costo última compra', 'Δ% (vs precio actual)']);
  assert.deepStrictEqual(aoa[1], [540, 'Arroz', 1000, 1100, 0.1, '2026-10-01', 2000, 2500, 0.25, 2600, 0.3]);
  assert.deepStrictEqual(aoa[2], [7, 'Sal', null, null, null, null, null, null, null, null, null]);
  assert.strictEqual(aoa.length, 3);
});

test('filasExportListado Fraccionado: una fila por presentación con los costos $/kg de su granel; granel sin presentaciones → su fila sin precios', () => {
  const aoa = filasExportListado([
    { plu: '50', nombre: 'Almendra granel', costoSistema: 10000, costoUltimaCompra: 9000, fechaUltimaCompra: '2026-10-02', presentaciones: [
      { plu: '51', nombre: 'Almendra 500G', vigente: 20000, sugeridos: { sistema: sug(22000), ultimaCompra: sug(20000) } }] },
    { plu: '60', nombre: 'Nuez granel', costoSistema: 8000, costoUltimaCompra: null, presentaciones: [] },
    { plu: null, nombre: 'Sin granel asignado', costoSistema: null, presentaciones: [{ plu: '70', nombre: 'Pasas 1Kg', vigente: 5000, sugeridos: { sistema: null, ultimaCompra: null } }] },
  ], 'fraccionado');
  assert.deepStrictEqual(aoa[0].slice(0, 4), ['PLU', 'Nombre', 'Granel', 'Costo actual (sistema)']);
  assert.strictEqual(aoa[0].length, 12);
  assert.deepStrictEqual(aoa[1], [51, 'Almendra 500G', '50 · Almendra granel', 10000, 9000, -0.1, '2026-10-02', 20000, 22000, 0.1, 20000, 0]);
  assert.deepStrictEqual(aoa[2], [60, 'Nuez granel', '60 · Nuez granel', 8000, null, null, null, null, null, null, null, null]);
  assert.deepStrictEqual(aoa[3], [70, 'Pasas 1Kg', 'Sin granel asignado', null, null, null, null, 5000, null, null, null, null]);
});

test('filasExportListado Producción: costo de receta/envasado, sin columnas de última compra', () => {
  const aoa = filasExportListado([{ plu: '6319', nombre: 'Pepas', costoSistema: 330.58, vigente: 1000, sugeridos: { sistema: sug(900) } }], 'produccion');
  assert.deepStrictEqual(aoa, [['PLU', 'Nombre', 'Costo actual (receta/envasado)', 'Precio actual', 'Precio nuevo con costo actual', 'Δ% (vs precio actual)'],
    [6319, 'Pepas', 330.58, 1000, 900, -0.1]]);
});

test('filasExportListado: la columna PLU es un número en los tres tipos; un código no numérico o el granel sin PLU quedan como están', () => {
  const plu = aoa => aoa.slice(1).map(f => f[0]);
  assert.deepStrictEqual(plu(filasExportListado([{ plu: '540', nombre: 'A', sugeridos: {} }, { plu: 'AB-1', nombre: 'B', sugeridos: {} }], 'almacen')), [540, 'AB-1']);
  assert.deepStrictEqual(plu(filasExportListado([{ plu: '6319', nombre: 'P', sugeridos: {} }], 'produccion')), [6319]);
  assert.deepStrictEqual(plu(filasExportListado([
    { plu: '50', nombre: 'G', presentaciones: [{ plu: '51', nombre: 'G 500G', sugeridos: {} }] },
    { plu: '60', nombre: 'H', presentaciones: [] },
    { plu: null, nombre: 'Sin granel', presentaciones: [] },
  ], 'fraccionado')), [51, 60, null]);
});
