'use strict';
// Helpers puros de la UI de Producción (public/js/precios_produccion.js). El archivo es un script de
// browser: sin `document` no arranca nada, sólo exporta los helpers.
const test = require('node:test');
const assert = require('node:assert');
const ui = require('../public/js/precios_produccion.js');

test('parsearHashProduccion: selector, detalle, id inválido y otras tabs', () => {
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion'), { vista: 'selector' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/recetas'), { vista: 'recetas' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola'), { vista: 'detalle', id: 'p-granola' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/..%2Fx'), { vista: 'selector' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/%E0%A4%A'), { vista: 'selector' }); // URI mal formada
  assert.strictEqual(ui.parsearHashProduccion(''), null);
  assert.strictEqual(ui.parsearHashProduccion('#almacen'), null);
  assert.strictEqual(ui.parsearHashProduccion('#produccionX'), null);
});

test('parsearHashProduccion: #produccion/<id>/<plu> abre el detalle con la presentación', () => {
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola/6319'), { vista: 'detalle', id: 'p-granola', plu: '6319' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola/n-granola-800'), { vista: 'detalle', id: 'p-granola', plu: 'n-granola-800' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola/<x>'), { vista: 'detalle', id: 'p-granola' }); // PLU inválido: sólo el detalle
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/..%2Fx/6319'), { vista: 'selector' });
});

test('seccionesAbiertas: sólo la primera incompleta; todo completo → el paso 4; las elecciones del usuario mandan', () => {
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'falta', 3: 'opcional', 4: 'falta' }), { 1: false, 2: true, 3: false, 4: false });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'ok', 3: 'opcional', 4: 'parcial' }), { 1: false, 2: false, 3: false, 4: true });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'parcial', 2: 'falta', 3: 'opcional', 4: 'falta' }), { 1: true, 2: false, 3: false, 4: false });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'ok', 3: 'ok', 4: 'ok' }), { 1: false, 2: false, 3: false, 4: true });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'ok', 3: 'opcional', 4: 'ok' }, { 4: false, 1: true }), { 1: true, 2: false, 3: false, 4: false });
  assert.deepStrictEqual(ui.seccionesAbiertas({}), { 1: false, 2: false, 3: false, 4: true });
});

test('firmaAlertas: independiente del orden, cambia con el Δ% o con una alerta nueva', () => {
  const a = { productoId: 'p-a', tipo: 'receta', id: 'base', deltaPct: 5 };
  const b = { productoId: 'p-b', tipo: 'presentacion', id: '6319', deltaPct: -4 };
  assert.strictEqual(ui.firmaAlertas({ items: [a, b] }), ui.firmaAlertas({ items: [b, a] }));
  assert.notStrictEqual(ui.firmaAlertas({ items: [a] }), ui.firmaAlertas({ items: [{ ...a, deltaPct: 8 }] }));
  assert.notStrictEqual(ui.firmaAlertas({ items: [a] }), ui.firmaAlertas({ items: [a, b] }));
  assert.strictEqual(ui.firmaAlertas(null), '');
});

test('destinoToast: un producto → su detalle; varios → selector con "solo con cambios"', () => {
  assert.deepStrictEqual(ui.destinoToast([{ productoId: 'p-a' }, { productoId: 'p-a' }]), { hash: '#produccion/p-a', soloCambios: false });
  assert.deepStrictEqual(ui.destinoToast([{ productoId: 'p-a' }, { productoId: 'p-b' }]), { hash: '#produccion', soloCambios: true });
});

test('textoToast: singular/plural y 3 primeras con producto · nombre · Δ%', () => {
  const items = [1, 2, 3, 4].map(n => ({ producto: 'Granola', nombre: `P${n}`, deltaPct: n === 1 ? 12.5 : -n }));
  const t = ui.textoToast({ total: 4, items });
  assert.strictEqual(t.titulo, '4 costos de producción cambiaron');
  assert.deepStrictEqual(t.lineas, ['Granola · P1 · +12,5%', 'Granola · P2 · -2,0%', 'Granola · P3 · -3,0%']);
  assert.strictEqual(ui.textoToast({ total: 1, items: [{ producto: 'X', nombre: 'Y', deltaPct: null }] }).titulo, '1 costo de producción cambió');
});

test('estadoFila: faltantes gana; si no, el estado del server', () => {
  assert.strictEqual(ui.estadoFila({ estado: 'cambio', faltantes: ['6334'] }), 'faltantes');
  assert.strictEqual(ui.estadoFila({ estado: 'cambio', faltantes: [] }), 'cambio');
  assert.strictEqual(ui.estadoFila({ faltantes: [] }), 'sin-validar');
});

test('mensajeFaltante: lenguaje humano + acción, nunca claves internas', () => {
  const plu = ui.mensajeFaltante('6009', { nombres: { 6009: 'AVENA' } });
  assert.strictEqual(plu.texto, 'El PLU 6009 (AVENA) no tiene costo en SIGA → cargá un costo manual');
  assert.deepStrictEqual(plu.accion, { tipo: 'costo', clave: '6009' });
  assert.deepStrictEqual(ui.mensajeFaltante('m-etiq', { nombres: { 'm-etiq': 'Etiqueta' } }).accion, { tipo: 'costo', clave: 'm-etiq' });
  const hora = ui.mensajeFaltante('_costoHora');
  assert.match(hora.texto, /costo\/hora de mano de obra/);
  assert.deepStrictEqual(hora.accion, { tipo: 'config' });
  const mk = ui.mensajeFaltante('markupPct', { plu: '6319' });
  assert.match(mk.texto, /Sin markup/);
  assert.deepStrictEqual(mk.accion, { tipo: 'margen', plu: '6319' });
  const mkSinPlu = ui.mensajeFaltante('markupPct');
  assert.deepStrictEqual([mkSinPlu.accion, mkSinPlu.boton], [{ tipo: 'ganancia' }, 'Ir a Ganancia']);
  assert.deepStrictEqual(ui.mensajeFaltante('rendimientoKg').accion, { tipo: 'paso', paso: 1 });
  for (const k of ['_costoHora', '_maquina', 'markupPct', 'rendimientoKg', 'mermaPct', 'receta', 'kgPorUnidad', '6009', 'm-x']) {
    assert.doesNotMatch(ui.mensajeFaltante(k).texto, /_costoHora|_maquina|markupPct|rendimientoKg|mermaPct|kgPorUnidad/, k);
  }
});

const det = (over = {}) => ({ recetas: {}, presentaciones: {}, insumos: [], ...over });
const receta = (o = {}) => ({ varianteDe: null, costoKg: 100, estado: 'sin-validar', faltantes: [], ...o });
const pres = (o = {}) => ({ precioConIva: 1000, estado: 'sin-validar', faltantes: [], ...o });

test('progresoProducto: producto vacío → falta todo; variedades obligatorias, insumos opcionales', () => {
  const p = ui.progresoProducto(det());
  assert.deepStrictEqual(p.map(x => [x.clave, x.estado, x.paso]), [
    ['base', 'falta', 1], ['variedades', 'falta', 2], ['insumos', 'opcional', 3], ['presentaciones', 'falta', 4], ['validado', 'falta', 4],
  ]);
});

test('progresoProducto: parcial y completo', () => {
  const parcial = ui.progresoProducto(det({
    recetas: { base: receta({ costoKg: null, faltantes: ['300'] }) },
    presentaciones: { 1: pres(), 2: pres({ precioConIva: null, faltantes: ['markupPct'] }) }, insumos: [{ clave: '6334' }],
  }));
  assert.deepStrictEqual(parcial.map(x => x.estado), ['parcial', 'falta', 'ok', 'parcial', 'parcial']);
  const listo = ui.progresoProducto(det({
    recetas: { base: receta({ estado: 'ok' }), pasas: receta({ varianteDe: 'base', estado: 'ok' }) },
    presentaciones: { 1: pres({ estado: 'ok' }) }, insumos: [{ clave: '6334' }],
  }));
  assert.deepStrictEqual(listo.map(x => x.estado), ['ok', 'ok', 'ok', 'ok', 'ok']);
});

test('progresoProducto: con una variedad (la automática sin extras) el paso 2 está listo; sin ninguna, avisa que se crea sola', () => {
  const una = ui.progresoProducto(det({ recetas: { base: receta(), granola: receta({ varianteDe: 'base' }) } }));
  assert.strictEqual(una[1].estado, 'ok');
  assert.match(una[1].detalle, /1 cargada/);
  const ninguna = ui.progresoProducto(det({ recetas: { base: receta() } }));
  assert.match(ninguna[1].detalle, /se crea sola/);
});

test('pasosHabilitados: variedades esperan una base; presentaciones esperan una variedad', () => {
  const vacio = ui.pasosHabilitados(det());
  assert.strictEqual(vacio[1].ok, true);
  assert.strictEqual(vacio[3].ok, true);
  assert.strictEqual(vacio[2].ok, false);
  assert.match(vacio[2].motivo, /Primero guardá una receta base/);
  assert.strictEqual(vacio[2].paso, 1);
  assert.strictEqual(vacio[4].ok, false);
  const conBase = ui.pasosHabilitados(det({ recetas: { base: receta() } }));
  assert.strictEqual(conBase[2].ok, true);
  assert.strictEqual(conBase[4].ok, false);
  assert.match(conBase[4].motivo, /Primero creá una variedad/);
  assert.strictEqual(conBase[4].paso, 2);
  const conVariedad = ui.pasosHabilitados(det({ recetas: { base: receta(), clasica: receta({ varianteDe: 'base' }) } }));
  assert.strictEqual(conVariedad[4].ok, true);
});

test('nombreComponente: pseudo-componentes y PLUs con nombre', () => {
  assert.strictEqual(ui.nombreComponente('_costoHora'), 'Mano de obra (costo/hora)');
  assert.strictEqual(ui.nombreComponente('m-x'), 'm-x');
});

test('idRecetaNueva: la primera es base; después slug único', () => {
  assert.strictEqual(ui.idRecetaNueva('Granola clásica', []), 'base');
  assert.strictEqual(ui.idRecetaNueva('Con Pasas!', ['base']), 'con-pasas');
  assert.strictEqual(ui.idRecetaNueva('Con pasas', ['base', 'con-pasas']), 'con-pasas-2');
  assert.match(ui.idManualNuevo('Etiqueta Ñandú 2027', 'abc123'), /^m-[a-z0-9-]{1,40}$/);
});

test('bodyReceta: base con materiasPrimas, variante con extras; vacíos no se mandan', () => {
  const base = ui.bodyReceta({ nombre: 'Masa', varianteDe: null, rendimientoKg: 104, mermaPct: null, minutosElaboracion: 90,
    categoriaMaquinaId: '', items: [{ plu: 300, cantidad: 5, unidad: 'kg', costoUnit: 10, pendiente: true }] });
  assert.deepStrictEqual(base, { nombre: 'Masa', materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }], rendimientoKg: 104, minutosElaboracion: 90 });
  const v = ui.bodyReceta({ nombre: 'Membrillo', varianteDe: 'base', rendimientoKg: null, categoriaMaquinaId: 'maq', items: [{ plu: '812', cantidad: 47.3 }] });
  assert.deepStrictEqual(v, { nombre: 'Membrillo', varianteDe: 'base', extras: [{ plu: '812', cantidad: 47.3, unidad: 'kg' }], categoriaMaquinaId: 'maq' });
});

test('bodyPresentacion: cada fila de insumo va (PLU o manual); la cantidad vacía la rechaza el server', () => {
  const b = ui.bodyPresentacion({ recetaId: 'base', kgPorUnidad: 0.5, correccionPct: null, minutosEmpaquetado: 0.8 },
    [{ clave: '6334', cantidad: 1 }, { clave: 'm-etiq-x', cantidad: 2 }, { clave: '6320', cantidad: null }]);
  assert.deepStrictEqual(b, { recetaId: 'base', kgPorUnidad: 0.5, minutosEmpaquetado: 0.8,
    insumos: [{ plu: '6334', cantidad: 1 }, { manualId: 'm-etiq-x', cantidad: 2 }, { plu: '6320', cantidad: null }] });
});

test('opcionesVariedad: sólo variedades (la presentación no puede elegir la base), con su base', () => {
  const recetas = { base: { nombre: 'Masa' }, memb: { nombre: 'Membrillo', varianteDe: 'base' }, otra: { nombre: 'Otra' } };
  assert.deepStrictEqual(ui.opcionesVariedad(recetas), [['memb', 'Membrillo (de Masa)']]);
  assert.deepStrictEqual(ui.opcionesVariedad({ base: { nombre: 'Masa' } }), []);
});

test('rendimientoSugerido (pepas: 104 + 47,3 kg) e importeEmpaque', () => {
  assert.strictEqual(ui.rendimientoSugerido(104, [{ cantidad: 47.3, unidad: 'kg' }, { cantidad: 3, unidad: 'u' }]), 151.3);
  assert.strictEqual(ui.rendimientoSugerido(null, []), null);
  const comp = [{ plu: '_receta', importe: 240 }, { plu: '6334', importe: 180 }, { plu: 'm-x', importe: 60.5 }, { plu: '_costoHora', importe: 9 }];
  assert.strictEqual(ui.importeEmpaque(comp), 240.5);
  assert.strictEqual(ui.importeEmpaque([...comp, { plu: '1', importe: null }]), null);
});

test('formatoPeso: kg → "270 g" / "1,5 kg"; vacío o ≤ 0 → ""', () => {
  assert.strictEqual(ui.formatoPeso(0.27), '270 g');
  assert.strictEqual(ui.formatoPeso(0.0125), '12,5 g');
  assert.strictEqual(ui.formatoPeso(1), '1 kg');
  assert.strictEqual(ui.formatoPeso(1.5), '1,5 kg');
  assert.strictEqual(ui.formatoPeso(null), '');
  assert.strictEqual(ui.formatoPeso(0), '');
});

test('presentacionSucia: compara contra lo guardado sin importar el orden de los insumos', () => {
  const base = { plu: '6319', recetaId: 'base', kg: 0.5, correccion: null, minutos: 0.8, sel: { 6334: 1, 'm-x': 2 } };
  assert.strictEqual(ui.presentacionSucia({ ...base, sel: { 'm-x': 2, 6334: 1 } }, base), false);
  assert.strictEqual(ui.presentacionSucia({ ...base, kg: 0.27 }, base), true);
  assert.strictEqual(ui.presentacionSucia({ ...base, sel: { 6334: 1 } }, base), true);
  assert.strictEqual(ui.presentacionSucia({ ...base, correccion: 5 }, base), true);
});

test('faltaObligatorioPres: PLU, variedad, kg > 0 y cantidad de cada insumo tildado', () => {
  const ok = { plu: '6319', recetaId: 'base', kg: 0.5, sel: { 6334: 1 } };
  assert.strictEqual(ui.faltaObligatorioPres(ok), '');
  assert.match(ui.faltaObligatorioPres({ ...ok, plu: null }), /PLU/);
  assert.match(ui.faltaObligatorioPres({ ...ok, recetaId: '' }), /variedad/);
  assert.match(ui.faltaObligatorioPres({ ...ok, kg: 0 }), /Kg por unidad/);
  assert.match(ui.faltaObligatorioPres({ ...ok, sel: { 6334: null } }), /cantidad/);
  assert.strictEqual(ui.faltaObligatorioPres({ ...ok, plu: null }, { sinPlu: true }), ''); // la vista previa no necesita PLU
});

test('ordenarFilas: números como número, nulls al final, texto con acentos, estable, sin mutar', () => {
  const filas = [
    { plu: '300', nombre: 'Harina', cantidad: 5, costoUnit: 400 },
    { plu: '7067', nombre: 'Azúcar', cantidad: 1.5, costoUnit: null },
    { plu: '812', nombre: 'azucar negra', cantidad: 5, costoUnit: 2800 },
    { plu: '90', nombre: 'Ñandú', cantidad: 1, costoUnit: 100 },
  ];
  const copia = JSON.stringify(filas);
  const plus = (f, c, d) => ui.ordenarFilas(f, c, d).map(x => x.plu);
  assert.deepStrictEqual(plus(filas, 'plu', 'asc'), ['90', '300', '812', '7067']); // PLU numérico, no texto
  assert.deepStrictEqual(plus(filas, 'plu', 'desc'), ['7067', '812', '300', '90']);
  assert.deepStrictEqual(plus(filas, 'costoUnit', 'asc'), ['90', '300', '812', '7067']); // null al final
  assert.deepStrictEqual(plus(filas, 'costoUnit', 'desc'), ['812', '300', '90', '7067']); // null al final también en desc
  assert.deepStrictEqual(plus(filas, 'nombre', 'asc'), ['7067', '812', '300', '90']); // Azúcar < azucar negra < Harina < Ñandú
  assert.deepStrictEqual(plus(filas, 'cantidad', 'asc'), ['90', '7067', '300', '812']); // empate 5: estable (300 antes que 812)
  assert.deepStrictEqual(plus(filas, 'cantidad', 'desc'), ['300', '812', '7067', '90']); // estable también en desc
  assert.deepStrictEqual(plus(filas, 'cantidad', null), ['300', '7067', '812', '90']); // sin orden = original
  assert.strictEqual(JSON.stringify(filas), copia);
});

test('siguienteOrden: asc → desc → sin orden; otra columna arranca en asc', () => {
  assert.deepStrictEqual(ui.siguienteOrden(null, 'plu'), { clave: 'plu', dir: 'asc' });
  assert.deepStrictEqual(ui.siguienteOrden({ clave: 'plu', dir: 'asc' }, 'plu'), { clave: 'plu', dir: 'desc' });
  assert.strictEqual(ui.siguienteOrden({ clave: 'plu', dir: 'desc' }, 'plu'), null);
  assert.deepStrictEqual(ui.siguienteOrden({ clave: 'plu', dir: 'desc' }, 'nombre'), { clave: 'nombre', dir: 'asc' });
});

test('escalarCantidades: × factor a 4 decimales (kg y u), sin mutar; factor inválido → igual', () => {
  const items = [{ plu: '300', cantidad: 5, unidad: 'kg' }, { plu: '9', cantidad: 3, unidad: 'u' }, { plu: '1', cantidad: 0.3333 }];
  assert.deepStrictEqual(ui.escalarCantidades(items, 1.25).map(i => i.cantidad), [6.25, 3.75, 0.4166]);
  assert.strictEqual(items[0].cantidad, 5);
  assert.strictEqual(ui.escalarCantidades(items, 0), items);
  assert.strictEqual(ui.escalarCantidades(items, null), items);
  assert.deepStrictEqual(ui.escalarCantidades([{ plu: '1', cantidad: null }], 2), [{ plu: '1', cantidad: null }]);
});

test('componentesAIngredientes: cant × kg por tanda; agrega nuevos (kg), reemplaza o suma existentes', () => {
  const comp = [{ plu: '300', nombre: 'Harina', cantPorUnidad: 0.5, costo: 400, fuente: 'sistema' },
    { plu: '7067', nombre: 'Azúcar', cantPorUnidad: 0.1, costo: null, fuente: null }];
  const existentes = [{ plu: '7067', nombre: 'Azúcar', cantidad: 3, unidad: 'u', costoUnit: 2800 }];
  const reemplazo = ui.componentesAIngredientes(comp, 104, existentes, 'reemplazar');
  assert.deepStrictEqual(reemplazo.map(i => [i.plu, i.cantidad, i.unidad, !!i.pendiente]), [['7067', 10.4, 'u', true], ['300', 52, 'kg', true]]);
  assert.deepStrictEqual(ui.componentesAIngredientes(comp, 104, existentes, 'sumar').map(i => i.cantidad), [13.4, 52]);
  assert.strictEqual(reemplazo[1].nombre, 'Harina');
  assert.strictEqual(existentes[0].cantidad, 3); // sin mutar
  assert.deepStrictEqual(ui.componentesAIngredientes([], 104, existentes, 'reemplazar'), existentes);
});

test('esEmpaque: envase/tapa/etiqueta/precinto van a Insumos, no a la receta', () => {
  assert.strictEqual(ui.esEmpaque({ tipo: 'envase' }), true);
  assert.strictEqual(ui.esEmpaque({ tipo: 'precinto' }), true);
  assert.strictEqual(ui.esEmpaque({ tipo: 'otro' }), false);
});

test('claveProvisoria: n-<slug> único para una presentación que todavía no está en SIGA', () => {
  assert.strictEqual(ui.claveProvisoria('Granola 800 g', []), 'n-granola-800-g');
  assert.strictEqual(ui.claveProvisoria('Granola 800 g', ['n-granola-800-g']), 'n-granola-800-g-2');
  assert.match(ui.claveProvisoria('x'.repeat(80), []), /^n-[a-z0-9-]{1,40}$/);
  assert.strictEqual(ui.esProvisoria('n-granola'), true);
  assert.strictEqual(ui.esProvisoria('6319'), false);
});

test('textoFormulaSiga: tabulado para pegar (encabezado + una línea por componente)', () => {
  const t = ui.textoFormulaSiga([{ plu: '300', cantidad: 0.2273, unidad: 'kg' }, { plu: null, manualId: 'm-x', cantidad: 1, unidad: 'u' }],
    { 300: 'HARINA', 'm-x': 'Etiqueta' });
  assert.strictEqual(t, 'PLU\tComponente\tCantidad\tUnidad\n300\tHARINA\t0,2273\tkg\n(sin PLU)\tEtiqueta\t1\tu');
});

test('mensajeFaltante: aviso "variedad" (presentación sobre la base) con acción que abre la presentación', () => {
  const m = ui.mensajeFaltante('variedad', { plu: '6319' });
  assert.match(m.texto, /Elegí una variedad/);
  assert.deepStrictEqual(m.accion, { tipo: 'abrirPres', clave: '6319' });
});


test('faltaObligatorioPres / presentacionSucia: presentación "todavía no está en SIGA" pide nombre en vez de PLU', () => {
  const v = { plu: null, sinSiga: true, nombreNuevo: 'Granola 800 g', recetaId: 'clasica', kg: 0.8, sel: {} };
  assert.strictEqual(ui.faltaObligatorioPres(v), '');
  assert.match(ui.faltaObligatorioPres({ ...v, nombreNuevo: '  ' }), /nombre/);
  assert.strictEqual(ui.presentacionSucia({ ...v, nombreNuevo: 'Otro' }, v), true);
});

test('idCategoriaNueva: slug del nombre que cumple ID_CATEGORIA, único; _maquina lleva a la tab Máquinas', () => {
  const ID_CATEGORIA = /^[a-z0-9][a-z0-9-]{0,39}$/;
  assert.strictEqual(ui.idCategoriaNueva('Horno Rotativo', []), 'horno-rotativo');
  assert.strictEqual(ui.idCategoriaNueva('Horno rotativo', ['horno-rotativo', 'horno-rotativo-2']), 'horno-rotativo-3');
  assert.strictEqual(ui.idCategoriaNueva('¡¡!!', []), 'x');
  const largo = ui.idCategoriaNueva('Mezcladora planetaria industrial de doble velocidad', ['mezcladora-planetaria-industrial-de']);
  assert.match(largo, ID_CATEGORIA);
  assert.deepStrictEqual(ui.mensajeFaltante('_maquina').accion, { tipo: 'maquinas' });
});

test('productosConCambios: cuenta productos distintos con alertas (no ítems)', () => {
  assert.strictEqual(ui.productosConCambios({ items: [{ productoId: 'p-a' }, { productoId: 'p-a' }, { productoId: 'p-b' }] }), 2);
  assert.strictEqual(ui.productosConCambios({ total: 0, items: [] }), 0);
  assert.strictEqual(ui.productosConCambios(null), 0);
});

test('plusCambiados: componentes que movieron + agregados, como strings; sin cambios → vacío', () => {
  const s = ui.plusCambiados({ estado: 'cambio', componentes: [{ plu: '101' }, { plu: '_costoHora' }], nuevos: ['202'], quitados: ['303'] });
  assert.deepStrictEqual([...s].sort(), ['101', '202', '_costoHora']);
  assert.strictEqual(ui.plusCambiados({ estado: 'ok', componentes: [{ plu: '101' }], nuevos: [], quitados: [] }).size, 0);
  assert.strictEqual(ui.plusCambiados(null).size, 0);
});

test('alertasDetalle: cambios con su paso, faltantes sin repetir con acción, precios fuera de tolerancia', () => {
  const det = {
    recetas: {
      base: { nombre: 'Masa', estado: 'cambio', cambios: { deltaPct: 9.8 }, faltantes: [] },
      memb: { nombre: 'Membrillo', varianteDe: 'base', estado: 'ok', faltantes: ['_costoHora'] },
      bat: { nombre: 'Batata', varianteDe: 'base', estado: 'ok', faltantes: ['_costoHora'] },
    },
    presentaciones: {
      6201: { plu: '6201', nombre: 'Pepas 250', estado: 'cambio', cambios: { deltaPct: 2 }, faltantes: [], semaforo: 'subir', deltaPct: 14.7 },
      6202: { plu: '6202', nombre: 'Batata 250', estado: 'ok', faltantes: ['markupPct'], semaforo: 'bajar', deltaPct: -5 },
      6203: { plu: '6203', nombre: 'Otra', estado: 'ok', faltantes: [], semaforo: 'ok', avisos: ['variedad'] },
    },
  };
  const a = ui.alertasDetalle(det);
  assert.deepStrictEqual(a.cambios.map(c => [c.tipo, c.id, c.paso, c.deltaPct]), [['receta', 'base', 1, 9.8], ['presentacion', '6201', 4, 2]]);
  // _costoHora aparece en dos recetas pero es un solo renglón (misma acción); markupPct y variedad llevan su PLU.
  assert.deepStrictEqual(a.faltantes.map(f => [f.quien, f.accion && f.accion.tipo]), [['Membrillo', 'config'], ['Batata 250', 'margen'], ['Otra', 'abrirPres']]);
  // La de faltantes no cuenta como precio a revisar aunque traiga semáforo.
  assert.deepStrictEqual(a.precios, [{ plu: '6201', nombre: 'Pepas 250', semaforo: 'subir', deltaPct: 14.7 }]);
  assert.strictEqual(a.total, 6);
  assert.strictEqual(ui.alertasDetalle({}).total, 0);
});

// ── Diálogo "Nuevo desde fórmula SIGA" (public/js/precios_produccion_formula.js) ──
const fm = require('../public/js/precios_produccion_formula.js');

test('nombreSinGranel: saca " DEPOSITO GRANEL" / " GRANEL" del final; el resto queda igual', () => {
  assert.strictEqual(fm.nombreSinGranel('Yogurt Natural Tipo Griego DEPOSITO GRANEL'), 'Yogurt Natural Tipo Griego');
  assert.strictEqual(fm.nombreSinGranel('Dulce de Leche GRANEL '), 'Dulce de Leche');
  assert.strictEqual(fm.nombreSinGranel('Granola Granel'), 'Granola');
  assert.strictEqual(fm.nombreSinGranel('GRANELADO'), 'GRANELADO');
  assert.strictEqual(fm.nombreSinGranel(null), '');
});

test('presentaciones del alta: tildadas por defecto salvo las que ya son de otro producto; elegidas en orden', () => {
  const pres = [{ plu: '11121', yaEn: null }, { plu: '1968', yaEn: 'Yogur' }, { plu: '3035', yaEn: null }];
  const sel = fm.seleccionInicialPres(pres);
  assert.deepStrictEqual(sel, { 11121: true, 1968: false, 3035: true });
  assert.deepStrictEqual(fm.plusElegidosPres(pres, { ...sel, 3035: false }), ['11121']);
  assert.deepStrictEqual(fm.plusElegidosPres(pres, { 1968: true }), []); // una de otro producto nunca se manda
  assert.deepStrictEqual(fm.plusElegidosPres(undefined, {}), []);
});

test('textoOmitidas: una línea por omitida con PLU, nombre y motivo', () => {
  assert.strictEqual(fm.textoOmitidas([]), '');
  assert.strictEqual(fm.textoOmitidas([{ plu: '1968', nombre: 'Yogur 370G', motivo: 'ya es presentación de "X"' }, { plu: '777', nombre: null, motivo: 'no lo usa' }]),
    'No se agregaron 2 presentaciones:\n• 1968 Yogur 370G: ya es presentación de "X"\n• 777: no lo usa');
});
