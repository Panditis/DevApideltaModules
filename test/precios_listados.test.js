'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { htmlSelectDecision, filtrarFilas, ordenarListado, ordenSinNulo, filasDeClase, resumenExport, juntarListas, resumenJuntas, filasExportListado, textoAvisosCosto, textoCosteoGranel, claveGrupoLst, abiertoLst, htmlDesplegarLst,
  htmlBadgeMayoristaLst, accionesMayoristaLst, htmlAccionMayoristaLst, conMarcaMayoristaLst, contarOcultables, textoMotivosActividad, textoInactivoLst, htmlBadgesActividadLst, textoPrecioFijoLst } = require('../public/js/precios_listados.js');

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

test('filtrarFilas: proveedor — con la opción el texto también busca en el proveedor (sin tildes); sin ella, no', () => {
  const filas = [
    { plu: '1', nombre: 'Azúcar', proveedor: 'Distribuidora Sur' },
    { plu: '2', nombre: 'Arroz', proveedor: 'Molino Ñandú' },
    { plu: '3', nombre: 'Sal', proveedor: null },
  ];
  const plus = o => filtrarFilas(filas, o).map(f => f.plu);
  assert.deepStrictEqual(plus({ texto: 'distribuidora', proveedor: true }), ['1']);
  assert.deepStrictEqual(plus({ texto: 'nandu', proveedor: true }), ['2']);
  assert.deepStrictEqual(plus({ texto: 'sal', proveedor: true }), ['3'], 'sigue buscando por nombre; el proveedor null no rompe');
  assert.deepStrictEqual(plus({ texto: 'distribuidora' }), [], 'Fraccionado/Producción: el proveedor no entra en la búsqueda');
  assert.deepStrictEqual(plus({ texto: 'null', proveedor: true }), [], 'un proveedor vacío no se busca como texto "null"');
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

test('ordenarListado: proveedor como texto (es, sin mayúsculas ni acentos); vacíos al final en asc y en desc', () => {
  const filas = [{ nombre: 'a', proveedor: 'zeta' }, { nombre: 'b', proveedor: null }, { nombre: 'c', proveedor: 'Ángel' }, { nombre: 'd', proveedor: 'ñandú' }, { nombre: 'e', proveedor: '' }, { nombre: 'f', proveedor: 'Bolsa' }];
  assert.deepStrictEqual(nombres(ordenarListado(filas, { clave: 'proveedor', dir: 'asc' })), ['c', 'f', 'd', 'a', 'b', 'e']);
  assert.deepStrictEqual(nombres(ordenarListado(filas, { clave: 'proveedor', dir: 'desc' })), ['a', 'd', 'f', 'c', 'b', 'e']);
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

test('juntarListas / resumenJuntas: minorista + pack s/IVA + bulto s/IVA en un solo archivo (un encabezado, filas en ese orden); no toca las 5 listas', () => {
  const E = ['Codigo', 'Nombre', 'Costo', 'Venta'];
  const listas = { minorista: [E, [1, 'A', 1, 2]], packNeto: [E, [5, 'A x6', 1, 9]], packIva: [E, [5, 'A x6', 1, 11]], bultoNeto: [E, [9, 'A x10', 1, 15]], bultoIva: [E] };
  const copia = JSON.stringify(listas);
  assert.deepStrictEqual(juntarListas(listas, ['minorista', 'packNeto', 'bultoNeto']), [E, [1, 'A', 1, 2], [5, 'A x6', 1, 9], [9, 'A x10', 1, 15]]);
  assert.deepStrictEqual(resumenJuntas(listas).map(x => [x.lista, x.filas]), [['minoristaPackBultoNeto', 3]]);
  assert.match(resumenJuntas(listas)[0].etiqueta, /Minorista \+ Pack s\/IVA \+ Bulto s\/IVA/);
  assert.strictEqual(resumenJuntas({})[0].filas, 0); // listas faltantes = vacías
  assert.strictEqual(JSON.stringify(listas), copia);
  assert.strictEqual(resumenExport(listas).length, 5);
});

// ── Exportar listado (.xlsx, reporte) ──
test('filasExportListado Reventa: encabezado + una fila por producto, números reales y Δ% como fracción; sin dato → null', () => {
  const aoa = filasExportListado([
    { plu: '540', nombre: 'Arroz', costoSistema: 1000, costoUltimaCompra: 1100, fechaUltimaCompra: '2026-10-01', proveedor: 'Distribuidora Sur', tipoProveedor: 'distribuidor', vigente: 2000,
      sugeridos: { sistema: sug(2500), ultimaCompra: sug(2600) } },
    { plu: '7', nombre: 'Sal', costoSistema: null, costoUltimaCompra: null, vigente: null, sugeridos: { sistema: { error: 'x' }, ultimaCompra: null } },
  ], 'almacen');
  assert.deepStrictEqual(aoa[0], ['PLU', 'Nombre', 'Costo actual (sistema)', 'Costo última compra', 'Δ% costo (última vs actual)', 'Fecha última compra', 'Proveedor', 'Tipo proveedor',
    'Precio actual', 'Precio nuevo con costo actual', 'Δ% (vs precio actual)', 'Precio nuevo con costo última compra', 'Δ% (vs precio actual)']);
  assert.deepStrictEqual(aoa[1], [540, 'Arroz', 1000, 1100, 0.1, '2026-10-01', 'Distribuidora Sur', 'Distribuidor', 2000, 2500, 0.25, 2600, 0.3]);
  assert.deepStrictEqual(aoa[2], [7, 'Sal', null, null, null, null, null, null, null, null, null, null, null]);
  assert.strictEqual(aoa.length, 3);
});

test('filasExportListado: el Proveedor es sólo de Reventa; Fraccionado (aunque el granel traiga proveedor) y Producción no lo llevan', () => {
  const fracc = filasExportListado([{ plu: '50', nombre: 'Almendra granel', proveedor: 'Frutos SA', presentaciones: [{ plu: '51', nombre: 'Almendra 500G', sugeridos: {} }] }], 'fraccionado');
  const prod = filasExportListado([{ plu: '6319', nombre: 'Pepas', proveedor: 'Frutos SA', sugeridos: {} }], 'produccion');
  assert.strictEqual(fracc[0].includes('Proveedor'), false);
  assert.strictEqual(prod[0].includes('Proveedor'), false);
  assert.strictEqual(fracc[1].includes('Frutos SA'), false);
  assert.strictEqual(prod[1].includes('Frutos SA'), false);
});

test('filasExportListado Fraccionado: una fila por presentación con los costos $/kg de su granel; granel sin presentaciones → su fila sin precios', () => {
  const aoa = filasExportListado([
    { plu: '50', nombre: 'Almendra granel', costoSistema: 10000, costoUltimaCompra: 9000, fechaUltimaCompra: '2026-10-02', presentaciones: [
      { plu: '51', nombre: 'Almendra 500G', vigente: 20000, sugeridos: { sistema: sug(22000), ultimaCompra: sug(20000) } }] },
    { plu: '60', nombre: 'Nuez granel', costoSistema: 8000, costoUltimaCompra: null, presentaciones: [] },
    { plu: null, nombre: 'Sin granel asignado', costoSistema: null, presentaciones: [{ plu: '70', nombre: 'Pasas 1Kg', vigente: 5000, sugeridos: { sistema: null, ultimaCompra: null } }] },
  ], 'fraccionado');
  assert.deepStrictEqual(aoa[0].slice(0, 4), ['PLU', 'Nombre', 'Granel', 'Costo actual (sistema)']);
  assert.strictEqual(aoa[0].length, 15);
  assert.deepStrictEqual(aoa[0].slice(12), ['Mayorista', 'Precio mayorista con IVA', 'Precio minorista anterior']); // columnas nuevas al final: las 12 de antes no se mueven
  assert.deepStrictEqual(aoa[1], [51, 'Almendra 500G', '50 · Almendra granel', 10000, 9000, -0.1, '2026-10-02', 20000, 22000, 0.1, 20000, 0, 'No', null, null]);
  assert.deepStrictEqual(aoa[2], [60, 'Nuez granel', '60 · Nuez granel', 8000, null, null, null, null, null, null, null, null, null, null, null]);
  assert.deepStrictEqual(aoa[3], [70, 'Pasas 1Kg', 'Sin granel asignado', null, null, null, null, 5000, null, null, null, null, 'No', null, null]);
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

test('filtrarFilas: clasificacion (Reventa) — con = sólo las que tienen tipoProveedor, sin = sólo las sin clasificar; sin la opción, todas', () => {
  const filas = [{ plu: '1', nombre: 'A', tipoProveedor: 'directo' }, { plu: '2', nombre: 'B', tipoProveedor: 'distribuidor' }, { plu: '3', nombre: 'C', tipoProveedor: null }, { plu: '4', nombre: 'D' }];
  const plus = o => filtrarFilas(filas, o).map(f => f.plu);
  assert.deepStrictEqual(plus({ clasificacion: 'con' }), ['1', '2']);
  assert.deepStrictEqual(plus({ clasificacion: 'sin' }), ['3', '4']);
  assert.deepStrictEqual(plus({}), ['1', '2', '3', '4']);
  assert.deepStrictEqual(plus({ clasificacion: 'sin', texto: 'd' }), ['4']);
});

test('ordenarListado: por tipoProveedor (Directo antes que Distribuidor, sin clasificar al final)', () => {
  const filas = [{ plu: '1', nombre: 'A', tipoProveedor: 'distribuidor' }, { plu: '2', nombre: 'B', tipoProveedor: null }, { plu: '3', nombre: 'C', tipoProveedor: 'directo' }];
  assert.deepStrictEqual(ordenarListado(filas, { clave: 'tipoProveedor', dir: 'asc' }).map(f => f.plu), ['3', '1', '2']);
});

test('filasExportListado: Tipo proveedor sólo en Reventa', () => {
  const fracc = filasExportListado([{ plu: '50', nombre: 'Almendra granel', tipoProveedor: 'directo', presentaciones: [] }], 'fraccionado');
  const prod = filasExportListado([{ plu: '6319', nombre: 'Pepas', sugeridos: {} }], 'produccion');
  assert.strictEqual(fracc[0].includes('Tipo proveedor'), false);
  assert.strictEqual(prod[0].includes('Tipo proveedor'), false);
});

test('parsearPlanillaDecisiones: encabezado en la fila 1, columnas en cualquier orden, código número o texto', () => {
  const { parsearPlanillaDecisiones } = require('../public/js/precios_listados.js');
  assert.deepStrictEqual(parsearPlanillaDecisiones([['Precio', 'CÓDIGO ', 'Nombre', 'Costo'], [1800, 123, 'Arroz', 1000], [null, '045', 'Yerba', '1.234,50'], [], [2750.5, ' 7 ', null, null]]), {
    filas: [{ codigo: '123', nombre: 'Arroz', costo: 1000, precio: 1800, fila: 2 }, { codigo: '45', nombre: 'Yerba', costo: 1234.5, precio: null, fila: 3 },
      { codigo: '7', nombre: '', costo: null, precio: 2750.5, fila: 5 }],
    errores: [],
  });
});

test('parsearPlanillaDecisiones: encabezado en la fila 4 (formato SIGA, "Venta" = Precio); filas malas → errores con su nro de fila', () => {
  const { parsearPlanillaDecisiones } = require('../public/js/precios_listados.js');
  const hoja = [['Lista de precios'], [], [], ['Codigo', 'Nombre', 'Costo', 'Venta'], [10, 'A', 100, 180], ['ABC', 'Mal', 1, 1], [11, 'Texto', 'caro', 1],
    [12, 'Vacío', null, ''], [12.5, 'Decimal', 1, 1], [null, null, null, null], [13, 'B', '$ 200', null]];
  assert.deepStrictEqual(parsearPlanillaDecisiones(hoja), {
    filas: [{ codigo: '10', nombre: 'A', costo: 100, precio: 180, fila: 5 }, { codigo: '13', nombre: 'B', costo: 200, precio: null, fila: 11 }],
    errores: [{ fila: 6, codigo: 'ABC', nombre: 'Mal', motivo: 'Código inválido' }, { fila: 7, codigo: '11', nombre: 'Texto', motivo: 'Costo o precio no numérico' },
      { fila: 8, codigo: '12', nombre: 'Vacío', motivo: 'Sin costo ni precio' }, { fila: 9, codigo: '12.5', nombre: 'Decimal', motivo: 'Código inválido' }],
  });
  assert.strictEqual(parsearPlanillaDecisiones(hoja.slice(3), 4).filas[0].fila, 5); // la hoja empieza en la fila 4 (!ref)
  assert.match(parsearPlanillaDecisiones([['PLU', 'Nombre'], [1, 'x']]).error, /encabezado/);
  assert.match(parsearPlanillaDecisiones(null).error, /encabezado/);
});

test('Importar planilla: resumen de marcados por costo y planilla de no marcados (PLU numérico)', () => {
  const { textoResumenImportacion, filasNoMarcados } = require('../public/js/precios_listados.js');
  const j = { marcados: { sistema: 3, ultimaCompra: 2, manual: 0 }, sinCoincidencia: [{}], noEncontrados: [{}, {}] };
  assert.strictEqual(textoResumenImportacion(j), '5 marcados (3 con costo sistema, 2 con última compra) · 1 sin coincidencia · 2 códigos no encontrados');
  assert.strictEqual(textoResumenImportacion({ ...j, marcados: { sistema: 1, ultimaCompra: 0, manual: 2 } }, 4),
    '3 marcados (1 con costo sistema, 0 con última compra, 2 manual) · 1 sin coincidencia · 2 códigos no encontrados · 4 filas con error');
  assert.deepStrictEqual(filasNoMarcados([
    { codigo: '10', nombre: 'Arroz', costo: 1, precio: 2, costoSistema: 1000, costoUltimaCompra: null, sugeridoSistema: 1800, sugeridoUltimaCompra: null, motivo: 'Ningún costo ni precio coincide' },
    { codigo: '777', nombre: '', costo: 5, precio: null, motivo: 'Código no encontrado en Reventa' },
    { codigo: 'ABC', nombre: 'Mal', motivo: 'Código inválido (fila 6)' },
  ]), [
    ['PLU', 'Nombre', 'Costo planilla', 'Precio planilla', 'Costo sistema', 'Costo última compra', 'Sugerido sistema', 'Sugerido última compra', 'Motivo'],
    [10, 'Arroz', 1, 2, 1000, null, 1800, null, 'Ningún costo ni precio coincide'],
    [777, null, 5, null, null, null, null, null, 'Código no encontrado en Reventa'],
    ['ABC', 'Mal', null, null, null, null, null, null, 'Código inválido (fila 6)'],
  ]);
});

test('textoAvisosCosto: los avisos del costeo de ahora (sinPeso, sinMinutos, costoHora, sinBolsa, sinBobina) en texto legible; uno desconocido pasa tal cual; ninguno habla de facilidad', () => {
  assert.deepStrictEqual(textoAvisosCosto(['sinPeso', 'sinMinutos', 'costoHora', 'sinBolsa', 'sinBobina', 'raro']), [
    'presentación sin peso en el nombre (sólo mercadería)',
    'sin min/kg (ni del subrubro ni del producto): sin mano de obra ni máquina',
    'sin costo hora de Fraccionado',
    'sin bolsa cargada para su peso: el costo no incluye envase',
    'sin peso de bolsa cargado para su peso: el costo no incluye envase',
    'raro']);
  assert.deepStrictEqual(textoAvisosCosto(undefined), []);
  assert.doesNotMatch(textoAvisosCosto(['sinPeso', 'sinMinutos', 'costoHora', 'sinBolsa', 'sinBobina']).join(' '), /facilidad/i);
});

test('textoCosteoGranel: "subrubro · min/kg (propio) · máquina"; sin máquina no se nombra (es lo normal); sin min/kg lo dice', () => {
  assert.strictEqual(textoCosteoGranel({ subrubro: 'Frutos secos', minKgOrigen: 'subrubro', minKgSubrubro: 2, minKgPropio: null, maquina: null }), 'Frutos secos · 2 min/kg');
  assert.strictEqual(textoCosteoGranel({ subrubro: 'Frutos secos', minKgOrigen: 'granel', minKgSubrubro: 2, minKgPropio: 4.5, maquina: 'Selladora' }), 'Frutos secos · 4,5 min/kg (propio) · Selladora');
  assert.strictEqual(textoCosteoGranel({ subrubro: 'Frutos secos', minKgOrigen: 'granel', minKgSubrubro: 2, minKgPropio: 0, maquina: null }), 'Frutos secos · 0 min/kg (propio)'); // 0 pisa al subrubro
  assert.strictEqual(textoCosteoGranel({ subrubro: 'Frutos secos', minKgOrigen: null, minKgSubrubro: null, minKgPropio: null, maquina: 'Envasadora' }), 'Frutos secos · sin min/kg · Envasadora');
  assert.strictEqual(textoCosteoGranel({ subrubro: null, minKgOrigen: null, maquina: null }), 'sin subrubro · sin min/kg');
  assert.doesNotMatch(textoCosteoGranel({ subrubro: 'X', minKgOrigen: 'subrubro', minKgSubrubro: 1, maquina: null }), /sin máquina|facilidad/i);
  // envase: bobina se nombra al final; bolsa (el default) no
  assert.strictEqual(textoCosteoGranel({ subrubro: 'X', minKgOrigen: 'subrubro', minKgSubrubro: 1, maquina: 'Selladora', envase: 'bobina' }), 'X · 1 min/kg · Selladora · bobina');
  assert.strictEqual(textoCosteoGranel({ subrubro: 'X', minKgOrigen: 'subrubro', minKgSubrubro: 1, maquina: null, envase: 'bolsa' }), 'X · 1 min/kg');
});

test('badgeFaltanteCosto: PLU de bolsa → "sin costo: PLU 900", "_bobina" → "sin costo: bobina", escapado; sin faltantes nada', () => {
  // Arrange: el script como en el navegador (badgeFaltanteCosto no se exporta)
  const vm = require('node:vm');
  const { esc, ordenarCon } = require('../public/js/precios_comun.js');
  const ctx = vm.createContext({ esc, ordenarCon, fmtSug: String, PreciosEsquema: require('../lib/precios_esquema') });
  vm.runInContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/js/precios_listados.js'), 'utf8'), ctx);
  const badge = p => vm.runInContext(`badgeFaltanteCosto(${JSON.stringify(p)})`, ctx);
  // Act / Assert
  assert.match(badge({ faltantesCosto: ['900'] }), />sin costo: PLU 900</);
  assert.match(badge({ faltantesCosto: ['_bobina'] }), />sin costo: bobina</);
  assert.match(badge({ faltantesCosto: ['<b>'] }), /PLU &lt;b&gt;/);
  assert.strictEqual(badge({ faltantesCosto: [] }), '');
  assert.strictEqual(badge({}), '');
});

test('abiertoLst: cerrado por defecto; lo elegido con ▸/▾ manda; la búsqueda que sólo coincide con una presentación lo abre', () => {
  const g = { plu: '50', nombre: 'Almendra granel', presentaciones: [{ plu: '51', nombre: 'Almendra 500G' }] };
  const sin = { plu: null, nombre: 'Sin granel asignado', presentaciones: [{ plu: '70', nombre: 'Pasas 1Kg' }] };
  assert.deepStrictEqual([claveGrupoLst(g), claveGrupoLst(sin)], ['50', 'sin']);
  assert.strictEqual(abiertoLst(g, new Map(), ''), false);
  assert.strictEqual(abiertoLst(g, new Map([['50', true]]), ''), true);
  assert.strictEqual(abiertoLst(g, new Map(), '500g'), true);           // sólo la presentación coincide
  assert.strictEqual(abiertoLst(g, new Map(), ' 51 '), true);
  assert.strictEqual(abiertoLst(g, new Map(), 'almendra'), false);      // coincide el granel: queda como estaba
  assert.strictEqual(abiertoLst(g, new Map(), 'nuez'), false);
  assert.strictEqual(abiertoLst(g, new Map([['50', false]]), '500g'), false); // cerrado a mano: se respeta
  assert.strictEqual(abiertoLst(sin, new Map([['sin', true]])), true);
  assert.strictEqual(abiertoLst({ plu: '60', nombre: 'Nuez' }, new Map(), 'nuez'), false); // sin presentaciones
});

test('htmlDesplegarLst: botón ▸/▾ con aria-expanded y aria-label + "N presentaciones"; sin presentaciones → nada', () => {
  const g = { plu: '50', nombre: 'Almendra <A>', presentaciones: [{ plu: '51' }, { plu: '52' }] };
  const cerrado = htmlDesplegarLst(g, false);
  assert.match(cerrado, /class="lst-desplegar[^"]*" data-grupo="50" aria-expanded="false" aria-label="Mostrar las presentaciones de Almendra &lt;A&gt;">▸<\/button>/);
  assert.match(cerrado, /2 presentaciones/);
  const abierto = htmlDesplegarLst({ plu: null, nombre: 'Sin granel', presentaciones: [{ plu: '70' }] }, true);
  assert.match(abierto, /data-grupo="sin" aria-expanded="true" aria-label="Ocultar las presentaciones de Sin granel">▾<\/button>/);
  assert.match(abierto, /1 presentación</);
  assert.strictEqual(htmlDesplegarLst({ plu: '60', nombre: 'Nuez', presentaciones: [] }, false), '');
});

// ── Graneles REEFER e inactivos (spec 2026-10-26 §4) ──
const granel = (plu, extra = {}) => ({ plu, nombre: `Granel ${plu}`, reefer: false, activo: true, activoManual: null,
  actividad: { auto: 'activo', motivos: [] }, presentaciones: [], ...extra });
const inactivo = (plu, motivos = ['sinMovGranel'], extra = {}) => granel(plu, { activo: false, actividad: { auto: 'inactivo', motivos }, ...extra });

test('filtrarFilas: REEFER e inactivos se ocultan salvo toggle; REEFER no depende de la actividad; el "sin granel" siempre se ve', () => {
  const filas = [granel('1'), granel('2', { reefer: true }), inactivo('3'), inactivo('4', ['sinMovGranel'], { reefer: true }),
    granel('5', { activoManual: false, activo: false }), { plu: null, nombre: 'Sin granel asignado', presentaciones: [], activo: false }];
  const ver = o => filtrarFilas(filas, o).map(f => f.plu);
  assert.deepStrictEqual(ver({}), ['1', null]);
  assert.deepStrictEqual(ver({ verReefer: true }), ['1', '2', '4', null]);           // REEFER inactivo aparece con sólo "Ver REEFER"
  assert.deepStrictEqual(ver({ verInactivos: true }), ['1', '3', '5', null]);
  assert.deepStrictEqual(ver({ verReefer: true, verInactivos: true }), ['1', '2', '3', '4', '5', null]);
  // Combina con el texto y las otras tabs (filas sin reefer/activo) no se tocan
  assert.deepStrictEqual(filtrarFilas(filas, { texto: 'granel 3' }).map(f => f.plu), []);
  assert.deepStrictEqual(filtrarFilas(filas, { texto: 'granel 3', verInactivos: true }).map(f => f.plu), ['3']);
  assert.strictEqual(filtrarFilas([{ plu: '9', nombre: 'Reventa' }]).length, 1);
});

test('contarOcultables: cuántos REEFER y cuántos inactivos (no REEFER) hay en el tab', () => {
  const filas = [granel('1'), granel('2', { reefer: true }), inactivo('3'), inactivo('4', ['sinMovGranel'], { reefer: true }), inactivo('5')];
  assert.deepStrictEqual(contarOcultables(filas), { reefer: 2, inactivos: 2 });
  assert.deepStrictEqual(contarOcultables([]), { reefer: 0, inactivos: 0 });
});

test('textoMotivosActividad / textoInactivoLst: motivos legibles; fijado a mano gana sobre el automático', () => {
  assert.strictEqual(textoMotivosActividad(['sinMovGranel']), ''); // informativo: no es causa de inactividad
  assert.strictEqual(textoMotivosActividad(['sinMovGranel', 'sinMovPresentaciones']), 'sin movimientos de ninguna presentación en el último año');
  assert.strictEqual(textoMotivosActividad(['sinPresentaciones', 'sinMovPresentaciones']), 'sin presentaciones; sin movimientos de ninguna presentación en el último año');
  assert.strictEqual(textoMotivosActividad(undefined), '');
  assert.strictEqual(textoMotivosActividad(['otro']), 'otro');
  assert.strictEqual(textoInactivoLst(inactivo('3', ['sinMovGranel', 'sinMovPresentaciones'])), 'Inactivo: sin movimientos de ninguna presentación en el último año');
  assert.strictEqual(textoInactivoLst(inactivo('3', ['sinMovGranel'], { activoManual: false })), 'Fijado a mano como inactivo');
  assert.strictEqual(textoInactivoLst({ activo: false }), 'Inactivo');
});

test('htmlBadgesActividadLst: "activo por stock" solo con activoPorStock; title con sucursales y unidades', () => {
  const por = granel('5', { actividad: { auto: 'activo', motivos: [], activoPorStock: true, stockPresentaciones: 12, sucursalesConStock: [1, 3] } });
  assert.match(htmlBadgesActividadLst(por), /title="Sin movimientos recientes, pero hay stock en 2 sucursal\(es\): 12 unidades">activo por stock<\/span>/);
  assert.strictEqual(htmlBadgesActividadLst(granel('6', { actividad: { auto: 'activo', motivos: [], activoPorStock: false } })), '');
  assert.strictEqual(htmlBadgesActividadLst(granel('7')), '');
});

test('htmlBadgesActividadLst: "activo por presentación" solo con activoPorPresentaciones', () => {
  const por = granel('8', { actividad: { auto: 'activo', motivos: [], activoPorPresentaciones: true } });
  assert.match(htmlBadgesActividadLst(por), /title="El granel no tuvo movimientos propios en el último año, pero una presentación sí\.">activo por presentación<\/span>/);
  assert.doesNotMatch(htmlBadgesActividadLst(granel('9', { actividad: { auto: 'activo', motivos: [], activoPorPresentaciones: false } })), /presentación/);
  assert.doesNotMatch(htmlBadgesActividadLst(inactivo('3', ['sinMovPresentaciones'], { actividad: { auto: 'inactivo', motivos: [], activoPorPresentaciones: true } })), /activo por presentación/);
});

test('htmlBadgesActividadLst: badge REEFER y/o inactivo (con title); activo común → nada; escapa el title', () => {
  assert.strictEqual(htmlBadgesActividadLst(granel('1')), '');
  assert.strictEqual(htmlBadgesActividadLst({ plu: '1', nombre: 'x' }), '');
  const ree = htmlBadgesActividadLst(granel('2', { reefer: true }));
  assert.match(ree, />REEFER<\/span>/);
  assert.doesNotMatch(ree, /inactivo/);
  const ina = htmlBadgesActividadLst(inactivo('3', ['sinMovPresentaciones']));
  assert.match(ina, /title="Inactivo: sin movimientos de ninguna presentación en el último año">inactivo<\/span>/);
  assert.doesNotMatch(ina, /REEFER/);
  const ambos = htmlBadgesActividadLst(inactivo('4', ['otro"<'], { reefer: true }));
  assert.match(ambos, />REEFER<\/span>.*>inactivo<\/span>/);
  assert.match(ambos, /title="Inactivo: otro&quot;&lt;"/);
});

test('textoPrecioFijoLst: title del badge "$=" con el precio de cada canal fijado; sin precio fijo → vacío', () => {
  const { fmtSug } = require('../public/js/precios_modal_esquema.js');
  assert.strictEqual(textoPrecioFijoLst({ minorista: 3999, bulto: 12.5 }), `Minorista $ ${fmtSug(3999)} · Bulto $ ${fmtSug(12.5)}`);
  assert.strictEqual(textoPrecioFijoLst({ pack: 800 }), `Pack $ ${fmtSug(800)}`);
  assert.strictEqual(textoPrecioFijoLst(undefined), '');
});

// ── Actividad por granel (Activar / Desactivar / Volver a automático): botón sólo en el modal; la fila del listado no lo tiene ──
const { accionActividadLst, conActividadLst } = require('../public/js/precios_listados.js');

test('accionActividadLst: inactivo → Activar (true), activo → Desactivar (false); sin PLU o REEFER, sin botón', () => {
  assert.deepStrictEqual(accionActividadLst({ plu: '5', activo: false }), { activo: false, texto: 'Activar', valor: true, fijado: false });
  assert.deepStrictEqual(accionActividadLst({ plu: '5', activo: true, activoManual: true }), { activo: true, texto: 'Desactivar', valor: false, fijado: true });
  assert.strictEqual(accionActividadLst({ plu: null, activo: true }), null);
  assert.strictEqual(accionActividadLst({ plu: '9', reefer: true, activo: true }), null);
});

test('conActividadLst: fija true/false o vuelve al automático (según actividad.auto); no muta', () => {
  const f = { plu: '5', activo: false, activoManual: null, actividad: { auto: 'inactivo' } };
  assert.strictEqual(conActividadLst(f, true).activo, true);
  assert.strictEqual(conActividadLst(f, true).activoManual, true);
  const g = { plu: '5', activo: true, activoManual: true, actividad: { auto: 'inactivo' } };
  assert.deepStrictEqual([conActividadLst(g, null).activo, conActividadLst(g, null).activoManual], [false, null]);
  assert.strictEqual(conActividadLst({ plu: '5', activo: true }, null).activo, true); // sin actividad calculada: activo
  assert.strictEqual(f.activo, false);
});

test('filtrarFilas: siempreVisibles mantiene un granel inactivo aunque "Ver inactivos" esté apagado', () => {
  const filas = [{ plu: '5', nombre: 'A', activo: false }, { plu: '6', nombre: 'B', activo: false }];
  assert.strictEqual(filtrarFilas(filas, {}).length, 0);
  assert.deepStrictEqual(filtrarFilas(filas, { siempreVisibles: new Set(['5']) }).map(f => f.plu), ['5']);
});

test('export Fraccionado: "Mayorista" Sí/No al final de cada presentación (true → Sí, false/sin dato → No)', () => {
  const aoa = filasExportListado([{ plu: '50', nombre: 'G', presentaciones: [
    { plu: '51', nombre: 'A 5KG', mayorista: true, sugeridos: {} }, { plu: '52', nombre: 'A 100G', mayorista: false, sugeridos: {} }, { plu: '53', nombre: 'B', sugeridos: {} }] }], 'fraccionado');
  assert.deepStrictEqual(aoa.slice(1).map(f => f[12]), ['Sí', 'No', 'No']);
});

test('mayorista listado: badge sólo si es mayorista, con el origen en el tooltip', () => {
  assert.strictEqual(htmlBadgeMayoristaLst({ mayorista: false }), '');
  assert.match(htmlBadgeMayoristaLst({ mayorista: true, mayoristaOrigen: 'peso' }), /title="Por peso">Mayorista · Bulto</); // sin tipo = bulto
  assert.match(htmlBadgeMayoristaLst({ mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'pack' }), /title="Marcada a mano">Mayorista · Pack</);
  assert.match(htmlBadgeMayoristaLst({ mayorista: true, mayoristaOrigen: 'peso', mayoristaTipo: 'bulto' }), /Mayorista · Bulto</);
});

test('mayorista listado: control de 3 estados (Minorista | Mayorista · Pack | Mayorista · Bulto) con el efectivo presionado; volver a automático sólo si es manual; solo-config; sin PLU nada', () => {
  const estado = p => accionesMayoristaLst(p).map(a => `${a.texto}=${a.pressed}`).join(' | ');
  assert.strictEqual(estado({ plu: '5', mayorista: false, mayoristaOrigen: null }), 'Minorista=true | Mayorista · Pack=false | Mayorista · Bulto=false');
  assert.strictEqual(estado({ plu: '5', mayorista: true, mayoristaOrigen: 'peso', mayoristaTipo: 'bulto' }), 'Minorista=false | Mayorista · Pack=false | Mayorista · Bulto=true');
  assert.strictEqual(estado({ plu: '5', mayorista: true, mayoristaOrigen: 'peso' }), 'Minorista=false | Mayorista · Pack=false | Mayorista · Bulto=true'); // sin tipo = bulto
  assert.strictEqual(estado({ plu: '5', mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'pack' }), 'Minorista=false | Mayorista · Pack=true | Mayorista · Bulto=false | Volver a automático=false');
  assert.deepStrictEqual(accionesMayoristaLst({ plu: '5', mayorista: false, mayoristaOrigen: null }).map(a => a.valor), [false, 'pack', 'bulto']);
  assert.strictEqual(accionesMayoristaLst({ plu: null }), null);
  const h = htmlAccionMayoristaLst({ plu: '5', nombre: 'A "x"', mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'pack' });
  assert.match(h, /class="solo-config /);
  assert.match(h, /data-plu="5" data-valor="false" aria-pressed="false" aria-label="Minorista: A &quot;x&quot;"/);
  assert.match(h, /data-valor="&quot;pack&quot;" aria-pressed="true" aria-label="Mayorista · Pack: /);
  assert.match(h, /data-valor="&quot;bulto&quot;" aria-pressed="false"/);
  assert.match(h, /data-valor="null"[^>]*aria-label="Volver a automático: /);
  assert.doesNotMatch(htmlAccionMayoristaLst({ plu: '5', nombre: 'A', mayorista: false, mayoristaOrigen: null }), /Volver a automático/);
  assert.match(h, /class="lst-may-msg[^"]*" role="alert"/);
  assert.strictEqual(htmlAccionMayoristaLst({ plu: null }), '');
});

test('conMarcaMayoristaLst: false | "pack" | "bulto" (true ≡ bulto) = manual; null vuelve a automático (por peso = bulto; límite incluido; sin peso o sin umbral, no); no muta', () => {
  const p = { plu: '5', pesoG: 5000, mayorista: false, mayoristaOrigen: 'manual' };
  assert.deepStrictEqual(conMarcaMayoristaLst(p, true, null), { ...p, mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'bulto' });
  assert.deepStrictEqual(conMarcaMayoristaLst(p, 'bulto', null), { ...p, mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'bulto' });
  assert.deepStrictEqual(conMarcaMayoristaLst(p, 'pack', null), { ...p, mayorista: true, mayoristaOrigen: 'manual', mayoristaTipo: 'pack' });
  assert.deepStrictEqual(conMarcaMayoristaLst({ ...p, mayorista: true }, false, 1), { ...p, mayorista: false, mayoristaOrigen: 'manual', mayoristaTipo: null });
  assert.deepStrictEqual(conMarcaMayoristaLst(p, null, 5000), { ...p, mayorista: true, mayoristaOrigen: 'peso', mayoristaTipo: 'bulto' });
  assert.deepStrictEqual(conMarcaMayoristaLst(p, null, 5001), { ...p, mayorista: false, mayoristaOrigen: null, mayoristaTipo: null });
  assert.deepStrictEqual(conMarcaMayoristaLst(p, null, null), { ...p, mayorista: false, mayoristaOrigen: null, mayoristaTipo: null });
  assert.strictEqual(conMarcaMayoristaLst({ ...p, pesoG: null }, null, 1).mayorista, false);
  assert.strictEqual(p.mayorista, false);
});

// ── guardarMarcaMayoristaLst: refresco del listado tras cambiar la marca (se carga el script como en la página, con el servidor simulado) ──
const vmLst = require('node:vm'), fsLst = require('node:fs'), pathLst = require('node:path');
function ctxLst({ filasNuevas, falla }) {
  const base = pathLst.join(__dirname, '..');
  const pedidos = [], pintados = [];
  const nodo = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] });
  const ctx = vmLst.createContext({ console, document: { getElementById: nodo, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    fetch: (url, o) => { if (o && o.method === 'PUT') return Promise.resolve({ json: () => Promise.resolve({ mayorista: { pesoMinG: 700 } }) });
      pedidos.push(url); return Promise.resolve({ json: () => Promise.resolve(falla ? { error: 'boom' } : { filas: filasNuevas }) }); } });
  ctx.self = ctx;
  vmLst.runInContext(fsLst.readFileSync(pathLst.join(base, 'lib/precios_esquema.js'), 'utf8'), ctx);
  for (const f of ['precios_comun.js', 'precios_listados.js']) vmLst.runInContext(fsLst.readFileSync(pathLst.join(base, 'public/js', f), 'utf8'), ctx);
  ctx.API_FR = '/x';
  ctx.renderListado = t => pintados.push(t);
  return { ctx, pedidos, pintados, correr: s => vmLst.runInContext(s, ctx) };
}
const filaGr = (pack) => ({ plu: '100', presentaciones: [{ plu: '101', pesoG: 1000, mayorista: false, mayoristas: [{ tipo: 'pack', precio: pack }] }] });

test('guardarMarcaMayoristaLst: tras el PUT trae el listado y la fila queda con pack/bulto nuevos y visible', async () => {
  const t = ctxLst({ filasNuevas: [filaGr(5000)] });
  t.correr(`lstDatos = { fraccionado: [${JSON.stringify(filaGr(9000))}] }`);
  const umbral = await t.correr("guardarMarcaMayoristaLst('fraccionado', '101', true)");
  assert.equal(umbral, 700);
  assert.deepEqual(t.pedidos.filter(u => u.includes('/esquema/listado')), ['/api/precios/esquema/listado?tipo=fraccionado']);
  assert.equal(t.correr('lstDatos.fraccionado[0].presentaciones[0].mayoristas[0].precio'), 5000); // del server, no el viejo
  assert.equal(t.correr("visiblesLst.has('100')"), true);                                          // el granel tocado sigue visible
  assert.equal(t.pintados.length, 2);                                                               // repinte local y repinte con datos nuevos
});

test('guardarMarcaMayoristaLst: si falla el refresco tira un error visible con marcaGuardada y deja el cambio local', async () => {
  const t = ctxLst({ falla: true });
  t.correr(`lstDatos = { fraccionado: [${JSON.stringify(filaGr(9000))}] }`);
  await assert.rejects(t.correr("guardarMarcaMayoristaLst('fraccionado', '101', true)"), e => e.marcaGuardada === true && /se guardó.*boom/.test(e.message));
  assert.equal(t.correr('lstDatos.fraccionado[0].presentaciones[0].mayorista'), true);
  assert.equal(t.correr("textoErrorMarcaLst({ message: 'x', marcaGuardada: true })"), 'x');
  assert.match(t.correr("textoErrorMarcaLst(new Error('x'))"), /^No se pudo cambiar la marca: x$/);
});

test('granelDePresentacionLst: devuelve el PLU del granel que contiene la presentación; null si no está', () => {
  const { granelDePresentacionLst } = require('../public/js/precios_listados.js');
  assert.equal(granelDePresentacionLst([filaGr(1)], 101), '100');
  assert.equal(granelDePresentacionLst([filaGr(1)], '999'), null);
});

// ── Detalle mayorista (sugerido = bulto SIN IVA; antes y pack aparte) ──
const MIN_MAY = { precio: 1300, margenTotalPct: 18.2, deltaPct: -0.05, estado: 'bajar', minoristaOriginal: 2000, minoristaOriginalNeto: 1652.89,
  pack: { neto: 1487.6, conIva: 1800, margenPct: 31.4 }, bulto: { neto: 1300, conIva: 1573, margenPct: 18.2 } };
test('detalleMayoristaLst: mayorista con descuento → rótulo "Bulto s/IVA", pack c/IVA, antes y tooltip con márgenes; minorista o sin precio → null', () => {
  const { detalleMayoristaLst, htmlDetalleMayoristaLst } = require('../public/js/precios_listados.js');
  const d = detalleMayoristaLst({ mayorista: true }, { minorista: MIN_MAY });
  assert.deepStrictEqual([d.fijo, d.antes, d.packIva, d.packNeto, d.bultoIva], [false, 2000, 1800, 1487.6, 1573]);
  assert.match(d.titulo, /bulto SIN IVA.*Margen efectivo del bulto 18,2 %.*pack 31,4 %/);
  assert.strictEqual(detalleMayoristaLst({ mayorista: false }, { minorista: MIN_MAY }), null);
  assert.strictEqual(detalleMayoristaLst({ mayorista: true }, { error: 'costo' }), null);
  assert.strictEqual(detalleMayoristaLst({ mayorista: true }, undefined), null);
  assert.match(htmlDetalleMayoristaLst({ mayorista: true }, { minorista: MIN_MAY }), /Bulto s\/IVA<\/span> · Pack \$ 1\.800 c\/IVA · antes <s>\$ 2\.000<\/s>/);
});
test('detalleMayoristaLst: tipo pack → rótulo "Pack s/IVA" y el bulto c/IVA como dato secundario; el tipo del sugerido manda sobre la marca de la fila', () => {
  const { detalleMayoristaLst, htmlDetalleMayoristaLst } = require('../public/js/precios_listados.js');
  const minPack = { ...MIN_MAY, precio: 1487.6, tipoMayorista: 'pack' };
  const d = detalleMayoristaLst({ mayorista: true, mayoristaTipo: 'pack' }, { minorista: minPack });
  assert.deepStrictEqual([d.tipo, d.etiqueta, d.otroEtiqueta, d.otroIva], ['pack', 'Pack s/IVA', 'Bulto', 1573]);
  assert.match(d.titulo, /Precio sugerido = pack SIN IVA/);
  assert.match(htmlDetalleMayoristaLst({ mayorista: true, mayoristaTipo: 'pack' }, { minorista: minPack }), /Pack s\/IVA<\/span> · Bulto \$ 1\.573 c\/IVA · antes <s>\$ 2\.000<\/s>/);
  assert.strictEqual(detalleMayoristaLst({ mayorista: true, mayoristaTipo: 'bulto' }, { minorista: minPack }).tipo, 'pack'); // el server dice pack
  assert.strictEqual(detalleMayoristaLst({ mayorista: true, mayoristaTipo: 'pack' }, { minorista: MIN_MAY }).tipo, 'pack'); // sin tipoMayorista en el sugerido: la marca de la fila
});
test('aviso de exportación: omitidosMayorista > 0 → texto aparte con la cantidad; el diálogo lo muestra y sin omitidos no', () => {
  const { textoOmitidosMayoristaLst } = require('../public/js/precios_listados.js');
  assert.strictEqual(textoOmitidosMayoristaLst(3), '3 presentaciones mayoristas no se exportaron: precio sin IVA, falta definir a qué lista de SIGA va.');
  const abrir = (omitidos, omitidosMay) => {
    const d = { style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], showModal() {}, close() {} };
    const ctx = vmLst.createContext({ console, fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }), document: { getElementById: () => d, createElement: () => d, body: { appendChild() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} } });
    ctx.self = ctx;
    vmLst.runInContext(fsLst.readFileSync(pathLst.join(__dirname, '..', 'lib/precios_esquema.js'), 'utf8'), ctx);
    for (const f of ['precios_comun.js', 'precios_listados.js']) vmLst.runInContext(fsLst.readFileSync(pathLst.join(__dirname, '..', 'public/js', f), 'utf8'), ctx);
    vmLst.runInContext(`dialogoExport([{ lista: 'minorista', etiqueta: 'Minorista', filas: 2 }], () => {}, ${omitidos}, ${omitidosMay})`, ctx);
    return d.innerHTML;
  };
  assert.match(abrir(1, 4), /4 presentaciones mayoristas no se exportaron: precio sin IVA, falta definir a qué lista de SIGA va\./);
  assert.match(abrir(1, 4), /1 producto\(s\) decidido\(s\) sin precio con la fuente elegida/); // el aviso de siempre no cambia
  assert.doesNotMatch(abrir(0, 0), /mayoristas no se exportaron/);
  assert.doesNotMatch(abrir(2, undefined), /mayoristas no se exportaron/);
});
test('detalleMayoristaLst: mayorista sin los campos (margen fijo del producto) → texto "sin dto. mayorista" con tooltip', () => {
  const { detalleMayoristaLst, htmlDetalleMayoristaLst } = require('../public/js/precios_listados.js');
  assert.strictEqual(detalleMayoristaLst({ mayorista: true }, { minorista: { precio: 1800 } }).fijo, true);
  assert.match(htmlDetalleMayoristaLst({ mayorista: true }, { minorista: { precio: 1800 } }), /title="Margen fijo del producto: sin descuento mayorista">margen fijo · sin dto\. mayorista/);
  assert.strictEqual(htmlDetalleMayoristaLst({ mayorista: false }, { minorista: { precio: 1800 } }), '');
});
test('filasExportListado Fraccionado: columnas nuevas AL FINAL (mayorista con IVA y minorista anterior con costo actual); las existentes no se mueven', () => {
  const g = { plu: '50', nombre: 'Almendra', presentaciones: [
    { plu: '51', nombre: 'A 500G', mayorista: true, sugeridos: { sistema: { minorista: MIN_MAY } } },
    { plu: '52', nombre: 'A 1Kg', mayorista: false, sugeridos: { sistema: { minorista: { precio: 3000 } } } }] };
  const aoa = filasExportListado([g], 'fraccionado');
  assert.deepStrictEqual(aoa[0].slice(-3), ['Mayorista', 'Precio mayorista con IVA', 'Precio minorista anterior']);
  assert.strictEqual(aoa[0].length, 15);
  assert.deepStrictEqual(aoa[1].slice(-3), ['Sí', 1573, 2000]);
  assert.strictEqual(aoa[1][aoa[0].indexOf('Precio nuevo con costo actual')], 1300); // el sugerido exportado es el bulto sin IVA
  assert.deepStrictEqual(aoa[2].slice(-3), ['No', null, null]);
  assert.ok(aoa.every(f => f.length === 15));
});
test('filasExportListado Fraccionado: "Precio mayorista con IVA" sigue el tipo del sugerido (pack → pack con IVA, bulto → bulto con IVA)', () => {
  const fila = min => filasExportListado([{ plu: '50', nombre: 'A', presentaciones: [{ plu: '51', nombre: 'P', mayorista: true, sugeridos: { sistema: { minorista: min } } }] }], 'fraccionado')[1];
  assert.strictEqual(fila({ ...MIN_MAY, precio: 1487.6, tipoMayorista: 'pack' }).slice(-2)[0], 1800);
  assert.strictEqual(fila({ ...MIN_MAY, tipoMayorista: 'bulto' }).slice(-2)[0], 1573);
});

test('export xlsx: Δ% de una mayorista con descuento compara contra vigenteNeto, como el listado', () => {
  const { filasExportListado } = require('../public/js/precios_listados.js');
  const min = { precio: 10700, deltaPct: -0.0273, vigenteNeto: 11000 / 1.21 };
  const g = { plu: '9', nombre: 'G', presentaciones: [{ plu: '90993', nombre: 'P', vigente: 11000, mayorista: true, sugeridos: { sistema: { minorista: min } } }] };
  const fila = filasExportListado([g], 'fraccionado')[1];
  const i = filasExportListado([g], 'fraccionado')[0].indexOf('Δ% (vs precio actual)');
  assert.ok(fila[i] > 0.17 && fila[i] < 0.19, `Δ% ${fila[i]}`);
});
