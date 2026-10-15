'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { etiquetaDecision, filtrarFilas, ordenarListado, ordenSinNulo, filasDeClase, resumenExport } = require('../public/js/precios_listados.js');

test('etiquetaDecision: badge de la fila decidida con su fuente; sin decisión → null; Producción = aumentar', () => {
  assert.strictEqual(etiquetaDecision({ decision: null }, 'almacen'), null);
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'ultimaCompra' } }, 'almacen'), '↑ última compra');
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'sistema' } }, 'fraccionado'), '↑ sistema');
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'manual' } }, 'almacen'), '↑ manual');
  assert.strictEqual(etiquetaDecision({ decision: { fuente: 'sistema' } }, 'produccion'), '↑ aumentar');
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
