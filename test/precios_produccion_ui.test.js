'use strict';
// Helpers puros de la UI de Producción (public/js/precios_produccion.js). El archivo es un script de
// browser: sin `document` no arranca nada, sólo exporta los helpers.
const test = require('node:test');
const assert = require('node:assert');
// Los helpers genéricos de precios_comun.js son globales en el navegador: acá se publican antes de cargar Producción.
Object.assign(globalThis, require('../public/js/precios_comun.js'));
const ui = require('../public/js/precios_produccion.js');
const { ordenarCon } = require('../public/js/precios_comun.js');

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

test('toggle Presentaciones | Recetas: vista de cada hash y entrada a la tab con la última elegida', () => {
  assert.strictEqual(ui.vistaToggleProduccion(ui.parsearHashProduccion('#produccion')), 'presentaciones');
  assert.strictEqual(ui.vistaToggleProduccion(ui.parsearHashProduccion('#produccion/recetas')), 'recetas');
  assert.strictEqual(ui.vistaToggleProduccion(ui.parsearHashProduccion('#produccion/p-granola')), null); // detalle: sin toggle
  assert.strictEqual(ui.hashEntradaProduccion('recetas'), '#produccion/recetas');
  assert.strictEqual(ui.hashEntradaProduccion('presentaciones'), '#produccion');
  assert.strictEqual(ui.hashEntradaProduccion(null), '#produccion'); // primera vez o sin storage
});

test('parsearHashProduccion: #produccion/<id>/<plu> abre el detalle con la presentación', () => {
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola/6319'), { vista: 'detalle', id: 'p-granola', plu: '6319' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola/n-granola-800'), { vista: 'detalle', id: 'p-granola', plu: 'n-granola-800' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/p-granola/<x>'), { vista: 'detalle', id: 'p-granola' }); // PLU inválido: sólo el detalle
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/..%2Fx/6319'), { vista: 'selector' });
});

test('seccionesAbiertas: sólo la primera incompleta; todo completo → el paso 3; las elecciones del usuario mandan', () => {
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'falta', 3: 'falta' }), { 1: false, 2: true, 3: false });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'ok', 3: 'parcial' }), { 1: false, 2: false, 3: true });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'parcial', 2: 'falta', 3: 'falta' }), { 1: true, 2: false, 3: false });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'ok', 3: 'ok' }), { 1: false, 2: false, 3: true });
  assert.deepStrictEqual(ui.seccionesAbiertas({ 1: 'ok', 2: 'ok', 3: 'ok' }, { 3: false, 1: true }), { 1: true, 2: false, 3: false });
  assert.deepStrictEqual(ui.seccionesAbiertas({}), { 1: false, 2: false, 3: true });
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

test('textoToast: singular/plural y 3 primeras con producto · nombre · materia prima antes → ahora (o Δ%)', () => {
  const componentes = [{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }];
  const items = [1, 2, 3, 4].map(n => ({ producto: 'Granola', nombre: `P${n}`, deltaPct: n === 1 ? 12.5 : -n, ...(n === 1 ? { componentes } : {}) }));
  const t = ui.textoToast({ total: 4, items });
  assert.strictEqual(t.titulo, '4 costos de producción cambiaron');
  assert.deepStrictEqual(t.lineas, ['Granola · P1 · Harina: $ 400 → $ 440', 'Granola · P2 · -2,0%', 'Granola · P3 · -3,0%']);
  assert.strictEqual(ui.textoToast({ total: 1, items: [{ producto: 'X', nombre: 'Y', deltaPct: null }] }).titulo, '1 costo de producción cambió');
});

test('textoRevisar: primera materia prima con costo anterior → nuevo y "y N más"; vacío → ""', () => {
  assert.strictEqual(ui.textoRevisar([{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }, { plu: '7', nombre: null, antes: 1, ahora: 2 }]),
    'Harina: $ 400 → $ 440 y 1 más');
  assert.strictEqual(ui.textoRevisar([{ plu: '7', nombre: null, antes: null, ahora: 1234.5 }]), '7: — → $ 1.234,5');
  assert.strictEqual(ui.textoRevisar([]), '');
  assert.strictEqual(ui.textoRevisar(null), '');
});

test('sugeridoProd: minorista del motor (fuente sistema) o null sin esquema / con error', () => {
  const m = { precio: 1800, deltaPct: 5, estado: 'ok' };
  assert.deepStrictEqual(ui.sugeridoProd({ esquema: { sugeridos: { sistema: { minorista: m } } } }), m);
  assert.strictEqual(ui.sugeridoProd({ esquema: { sugeridos: { sistema: { error: 'margen' } } } }), null);
  assert.strictEqual(ui.sugeridoProd({ esquema: null }), null);
  assert.strictEqual(ui.sugeridoProd({}), null);
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
  assert.strictEqual(plu.boton, 'Cargar costo');
  assert.deepStrictEqual(ui.mensajeFaltante('rendimientoKg').accion, { tipo: 'paso', paso: 1 });
  for (const k of ['rendimientoKg', 'mermaPct', 'receta', 'kgPorUnidad', '6009']) {
    assert.doesNotMatch(ui.mensajeFaltante(k).texto, /rendimientoKg|mermaPct|kgPorUnidad/, k);
  }
});

const det = (over = {}) => ({ recetas: {}, presentaciones: {}, ...over });
const receta = (o = {}) => ({ varianteDe: null, costoKg: 100, estado: 'sin-validar', faltantes: [], ...o });
const conPrecio = { esquema: { sugeridos: { sistema: { minorista: { precio: 1 } } } } };
const pres = (o = {}) => ({ ...conPrecio, estado: 'sin-validar', faltantes: [], ...o });

test('progresoProducto: producto vacío → falta todo; variedades obligatorias', () => {
  const p = ui.progresoProducto(det());
  assert.deepStrictEqual(p.map(x => [x.clave, x.estado, x.paso]), [
    ['base', 'falta', 1], ['variedades', 'falta', 2], ['presentaciones', 'falta', 3], ['validado', 'falta', 3],
  ]);
});

test('progresoProducto: parcial y completo', () => {
  const parcial = ui.progresoProducto(det({
    recetas: { base: receta({ costoKg: null, faltantes: ['300'] }) },
    presentaciones: { 1: pres(), 2: pres({ esquema: null, faltantes: ['receta'] }) },
  }));
  assert.deepStrictEqual(parcial.map(x => x.estado), ['parcial', 'falta', 'parcial', 'parcial']);
  const listo = ui.progresoProducto(det({
    recetas: { base: receta({ estado: 'ok' }), pasas: receta({ varianteDe: 'base', estado: 'ok' }) },
    presentaciones: { 1: pres({ estado: 'ok' }) },
  }));
  assert.deepStrictEqual(listo.map(x => x.estado), ['ok', 'ok', 'ok', 'ok']);
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
  assert.deepStrictEqual(Object.keys(vacio), ['1', '2', '3']);
  assert.strictEqual(vacio[1].ok, true);
  assert.strictEqual(vacio[2].ok, false);
  assert.match(vacio[2].motivo, /Primero guardá una receta base/);
  assert.strictEqual(vacio[2].paso, 1);
  assert.strictEqual(vacio[3].ok, false);
  const conBase = ui.pasosHabilitados(det({ recetas: { base: receta() } }));
  assert.strictEqual(conBase[2].ok, true);
  assert.strictEqual(conBase[3].ok, false);
  assert.match(conBase[3].motivo, /Primero creá una variedad/);
  assert.strictEqual(conBase[3].paso, 2);
  const conVariedad = ui.pasosHabilitados(det({ recetas: { base: receta(), clasica: receta({ varianteDe: 'base' }) } }));
  assert.strictEqual(conVariedad[3].ok, true);
});

test('nombreComponente: sólo _receta es especial; PLUs con nombre', () => {
  assert.strictEqual(ui.nombreComponente('_receta'), 'Receta');
  assert.strictEqual(ui.nombreComponente('_costoHora'), '_costoHora');
  assert.strictEqual(ui.nombreComponente('300', { 300: 'Harina' }), 'Harina (300)');
});

test('idRecetaNueva: la primera es base; después slug único', () => {
  assert.strictEqual(ui.idRecetaNueva('Granola clásica', []), 'base');
  assert.strictEqual(ui.idRecetaNueva('Con Pasas!', ['base']), 'con-pasas');
  assert.strictEqual(ui.idRecetaNueva('Con pasas', ['base', 'con-pasas']), 'con-pasas-2');
});

test('bodyReceta: base con materiasPrimas, variante con extras; vacíos no se mandan; sin MO ni máquina', () => {
  const base = ui.bodyReceta({ nombre: 'Masa', varianteDe: null, rendimientoKg: 104, mermaPct: null, minutosElaboracion: 90,
    categoriaMaquinaId: '', items: [{ plu: 300, cantidad: 5, unidad: 'kg', costoUnit: 10, pendiente: true }] });
  assert.deepStrictEqual(base, { nombre: 'Masa', materiasPrimas: [{ plu: '300', cantidad: 5, unidad: 'kg' }], rendimientoKg: 104 });
  const v = ui.bodyReceta({ nombre: 'Membrillo', varianteDe: 'base', rendimientoKg: null, categoriaMaquinaId: 'maq', items: [{ plu: '812', cantidad: 47.3 }] });
  assert.deepStrictEqual(v, { nombre: 'Membrillo', varianteDe: 'base', extras: [{ plu: '812', cantidad: 47.3, unidad: 'kg' }] });
});

test('bodyPresentacion: recetaId y kg por unidad', () => {
  assert.deepStrictEqual(ui.bodyPresentacion({ recetaId: 'v', kgPorUnidad: 0.5 }), { recetaId: 'v', kgPorUnidad: 0.5 });
});

test('opcionesVariedad: sólo variedades (la presentación no puede elegir la base), con su base', () => {
  const recetas = { base: { nombre: 'Masa' }, memb: { nombre: 'Membrillo', varianteDe: 'base' }, otra: { nombre: 'Otra' } };
  assert.deepStrictEqual(ui.opcionesVariedad(recetas), [['memb', 'Membrillo (de Masa)']]);
  assert.deepStrictEqual(ui.opcionesVariedad({ base: { nombre: 'Masa' } }), []);
});

test('rendimientoSugerido (pepas: 104 + 47,3 kg)', () => {
  assert.strictEqual(ui.rendimientoSugerido(104, [{ cantidad: 47.3, unidad: 'kg' }, { cantidad: 3, unidad: 'u' }]), 151.3);
  assert.strictEqual(ui.rendimientoSugerido(null, []), null);
});

test('formatoPeso: kg → "270 g" / "1,5 kg"; vacío o ≤ 0 → ""', () => {
  assert.strictEqual(ui.formatoPeso(0.27), '270 g');
  assert.strictEqual(ui.formatoPeso(0.0125), '12,5 g');
  assert.strictEqual(ui.formatoPeso(1), '1 kg');
  assert.strictEqual(ui.formatoPeso(1.5), '1,5 kg');
  assert.strictEqual(ui.formatoPeso(null), '');
  assert.strictEqual(ui.formatoPeso(0), '');
});

test('presentacionSucia: compara contra lo guardado (PLU, variedad, kg, alta sin SIGA)', () => {
  const base = { plu: '6319', recetaId: 'base', kg: 0.5 };
  assert.strictEqual(ui.presentacionSucia({ ...base }, base), false);
  assert.strictEqual(ui.presentacionSucia({ ...base, kg: 0.27 }, base), true);
  assert.strictEqual(ui.presentacionSucia({ ...base, recetaId: 'otra' }, base), true);
});

test('faltaObligatorioPres: PLU, variedad y kg > 0', () => {
  const ok = { plu: '6319', recetaId: 'base', kg: 0.5 };
  assert.strictEqual(ui.faltaObligatorioPres(ok), '');
  assert.match(ui.faltaObligatorioPres({ ...ok, plu: null }), /PLU/);
  assert.match(ui.faltaObligatorioPres({ ...ok, recetaId: '' }), /variedad/);
  assert.match(ui.faltaObligatorioPres({ ...ok, kg: 0 }), /Kg por unidad/);
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
  const v = { plu: null, sinSiga: true, nombreNuevo: 'Granola 800 g', recetaId: 'clasica', kg: 0.8 };
  assert.strictEqual(ui.faltaObligatorioPres(v), '');
  assert.match(ui.faltaObligatorioPres({ ...v, nombreNuevo: '  ' }), /nombre/);
  assert.strictEqual(ui.presentacionSucia({ ...v, nombreNuevo: 'Otro' }, v), true);
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

test('alertasDetalle: cambios con su paso y "a revisar", faltantes sin repetir con acción, precios del motor fuera de tolerancia', () => {
  const sug = (estado, deltaPct) => ({ esquema: { sugeridos: { sistema: { minorista: { precio: 1, estado, deltaPct } } } } });
  const revisar = [{ plu: '300', nombre: 'Harina', antes: 400, ahora: 440 }];
  const det = {
    recetas: {
      base: { nombre: 'Masa', estado: 'cambio', cambios: { deltaPct: 9.8 }, faltantes: [], revisar },
      memb: { nombre: 'Membrillo', varianteDe: 'base', estado: 'ok', faltantes: ['300'] },
      bat: { nombre: 'Batata', varianteDe: 'base', estado: 'ok', faltantes: ['300'] },
    },
    presentaciones: {
      6201: { plu: '6201', nombre: 'Pepas 250', estado: 'cambio', cambios: { deltaPct: 2 }, faltantes: [], ...sug('subir', 14.7) },
      6202: { plu: '6202', nombre: 'Batata 250', estado: 'ok', faltantes: ['receta'], ...sug('bajar', -5) },
      6203: { plu: '6203', nombre: 'Otra', estado: 'ok', faltantes: [], ...sug('ok', 0), avisos: ['variedad'] },
    },
  };
  const a = ui.alertasDetalle(det, { 300: 'Harina' });
  assert.deepStrictEqual(a.cambios.map(c => [c.tipo, c.id, c.paso, c.deltaPct, c.revisar]), [['receta', 'base', 1, 9.8, revisar], ['presentacion', '6201', 3, 2, null]]);
  // El PLU 300 sin costo aparece en dos recetas pero es un solo renglón (misma acción); variedad lleva su PLU.
  assert.deepStrictEqual(a.faltantes.map(f => [f.quien, f.accion && f.accion.tipo]), [['Membrillo', 'costo'], ['Batata 250', 'paso'], ['Otra', 'abrirPres']]);
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

// ── Orden de tablas de Producción ─────────────────────────────────────────────
const plus = filas => filas.map(f => f.plu);

test('columnasSelectorProd: estado = más alertas primero, sin alertas al final', () => {
  const filas = [{ plu: 'a', alertas: 0, faltantes: 0 }, { plu: 'b', alertas: 1, faltantes: 0 }, { plu: 'c', alertas: 0, faltantes: 2 }, { plu: 'd', alertas: 3, faltantes: 0 }];
  assert.deepStrictEqual(plus(ordenarCon(filas, { clave: 'estado', dir: 'asc' }, ui.columnasSelectorProd())), ['d', 'b', 'c', 'a']);
});

test('columnasPresProd: estado de Producción por severidad; sugerido y Δ del motor del esquema; sin empaque/real/markup', () => {
  const cols = ui.columnasPresProd({ estadoFila: p => p.e, nombreVariedad: p => p.v, kgDe: p => p.kg });
  const filas = [{ plu: '1', e: 'ok' }, { plu: '2', e: 'faltantes' }, { plu: '3', e: 'sin-validar' }, { plu: '4', e: 'cambio' }];
  assert.deepStrictEqual(plus(ordenarCon(filas, { clave: 'estado', dir: 'asc' }, cols)), ['2', '4', '3', '1']);
  assert.strictEqual(cols.variedad({ v: 'Clásica' }), 'Clásica');
  const conEsq = { esquema: { sugeridos: { sistema: { minorista: { precio: 1800, deltaPct: -5 } } } } };
  assert.deepStrictEqual([cols.sugerido(conEsq), cols.delta(conEsq)], [1800, -5]);
  assert.deepStrictEqual([cols.sugerido({}), cols.delta({ esquema: null })], [null, null]);
  for (const k of ['empaque', 'real', 'markup']) assert.ok(!(k in cols), k);
});

test('columna fecha ordenable en las tablas de Producción: por presentación y por producto (la más antigua)', () => {
  const asc = { clave: 'fecha', dir: 'asc' };
  const filas = [{ plu: 'a', fechaPrecio: '2026-05-01' }, { plu: 'b', fechaPrecio: null }, { plu: 'c', fechaPrecio: '2025-01-10' }];
  const presProd = ui.columnasPresProd({ estadoFila: () => 'ok', nombreVariedad: () => '', kgDe: () => 0 });
  assert.deepStrictEqual(plus(ordenarCon(filas, asc, presProd)), ['c', 'a', 'b']);
  const selector = ui.columnasSelectorProd();
  assert.strictEqual(selector.fecha({ exportables: [{ fechaPrecio: '2026-01-02' }, { fechaPrecio: '2025-06-30' }] }), '2025-06-30');
  assert.strictEqual(selector.fecha({}), null);
});

// ── Sub-tabs "Con receta | Envasado Apidelta" y editor de envasado ──
test('sub-tabs de Producción: rutas de Envasado, clase de cada vista y entrada con el último sub-tab', () => {
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/envasado'), { vista: 'envasado' });
  assert.deepStrictEqual(ui.parsearHashProduccion('#produccion/envasado/nuevo'), { vista: 'envasadoNuevo' });
  assert.strictEqual(ui.claseProduccion(ui.parsearHashProduccion('#produccion')), 'receta');
  assert.strictEqual(ui.claseProduccion(ui.parsearHashProduccion('#produccion/recetas')), 'receta');
  assert.strictEqual(ui.claseProduccion(ui.parsearHashProduccion('#produccion/envasado')), 'envasado');
  assert.strictEqual(ui.claseProduccion(ui.parsearHashProduccion('#produccion/envasado/nuevo')), null); // editor: sin sub-tabs
  assert.strictEqual(ui.claseProduccion(ui.parsearHashProduccion('#produccion/p-miel')), null); // detalle: sin sub-tabs
  assert.strictEqual(ui.vistaToggleProduccion(ui.parsearHashProduccion('#produccion/envasado')), null); // sin Presentaciones | Recetas
  assert.strictEqual(ui.hashEntradaProduccion('recetas', 'envasado'), '#produccion/envasado');
  assert.strictEqual(ui.hashEntradaProduccion('recetas', 'receta'), '#produccion/recetas');
  assert.strictEqual(ui.hashEntradaProduccion(null, null), '#produccion');
});

const env = require('../public/js/precios_produccion_envasado.js');
test('envasado: body del alta/edición, qué falta para guardar y edición desde la definición', () => {
  const ed = { nombre: ' Miel 500 ', plu: '6319', granelPlu: '7067', granelNombre: 'MIEL', kgPorUnidad: 0.5,
    componentes: [{ plu: '6334', nombre: 'Envase', cantidad: 1, costo: 180 }] };
  assert.deepStrictEqual(env.bodyEnvasado(ed), { nombre: 'Miel 500', plu: '6319', granelPlu: '7067', kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 1 }] });
  assert.deepStrictEqual(env.bodyEnvasado({ ...ed, id: 'p-miel' }).id, 'p-miel');
  assert.strictEqual(env.faltaObligatorioEnvasado(ed), '');
  assert.match(env.faltaObligatorioEnvasado({ ...ed, plu: null }), /PLU/);
  assert.match(env.faltaObligatorioEnvasado({ ...ed, granelPlu: null }), /granel/);
  assert.match(env.faltaObligatorioEnvasado({ ...ed, kgPorUnidad: 0 }), /[Kk]g/);
  assert.match(env.faltaObligatorioEnvasado({ ...ed, componentes: [{ plu: '6334', cantidad: null }] }), /cantidad/);
  assert.match(env.faltaObligatorioEnvasado({ ...ed, nombre: ' ' }), /nombre/);
  const det = { id: 'p-miel', definicion: { nombre: 'Miel', tipo: 'envasado', plu: '6319', granelPlu: '7067', kgPorUnidad: 0.5, componentes: [{ plu: '6334', cantidad: 2 }] },
    presentaciones: { 6319: { componentes: [{ plu: '7067', nombre: 'MIEL GRANEL', rol: 'granel' }, { plu: '6334', nombre: 'ENVASE', rol: 'empaque' }] } } };
  assert.deepStrictEqual(env.edicionEnvasado(det), { id: 'p-miel', nombre: 'Miel', plu: '6319', granelPlu: '7067', granelNombre: 'MIEL GRANEL', kgPorUnidad: 0.5,
    componentes: [{ plu: '6334', nombre: 'ENVASE', cantidad: 2 }] });
});
