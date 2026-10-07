// ── Precios · tab Producción (Fase 3): helpers, ruteo, selector, guardado y toasts ──
// Script clásico cargado después de precios.html y precios_fraccionado.js: reusa sus globales
// (esc, fmtMoney, fmtPrecio, fmtPct, chip, normTxt, numOrNull, avisar, confirmar, pedirJson,
// activarTab). El detalle es un flujo guiado en 4 pasos: encabezado + pasos 1-2 (recetas) en
// precios_produccion_detalle.js; pasos 3-4 (insumos, presentaciones) en precios_produccion_presentaciones.js;
// el modal de presentación en precios_produccion_modal.js.
// Los costos SIEMPRE salen del server (GET del detalle después de cada guardado): acá no se
// recalcula ninguna fórmula. Plan: docs/superpowers/plans/2026-09-25-precios-fase3-produccion.md
// Rutas: #produccion = selector · #produccion/<productoId> = detalle (recargar y "atrás" funcionan) ·
// #produccion/<productoId>/<plu> = detalle con esa presentación abierta (clic en la vista plana).

// ── Helpers puros (sin DOM; test/precios_produccion_ui.test.js) ─────────────────
const ID_PRODUCTO_UI = /^p-[a-z0-9-]{1,48}$/;
const ESPECIALES = {
  _costoHora: 'Mano de obra (costo/hora)', _maquina: 'Máquina (costo/hora)', _receta: 'Receta', _correccion: 'Corrección',
};
const PLU_PRES_UI = /^(\d{1,12}|n-[a-z0-9-]{1,40})$/; // PLU de SIGA o presentación provisoria
// '#produccion' → selector; '#produccion/<id>' → detalle (id inválido → selector);
// '#produccion/<id>/<plu>' → detalle + abrir esa presentación (plu inválido → sólo el detalle); otra cosa → null.
function parsearHashProduccion(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (h === 'produccion') return { vista: 'selector' };
  if (h === 'produccion/recetas') return { vista: 'recetas' };
  if (!h.startsWith('produccion/')) return null;
  const dec = s => { try { return decodeURIComponent(s); } catch { return ''; } };
  const [id, plu] = h.slice('produccion/'.length).split('/').map(dec);
  if (!ID_PRODUCTO_UI.test(id)) return { vista: 'selector' };
  return PLU_PRES_UI.test(plu || '') ? { vista: 'detalle', id, plu } : { vista: 'detalle', id };
}

// Qué pasos (1..4) arrancan abiertos: sólo el primero incompleto (ni 'ok' ni 'opcional'); si están todos, el 4.
// elecciones = { paso: bool } que el usuario abrió/cerró a mano en este producto: mandan sobre el default.
function seccionesAbiertas(estados = {}, elecciones = {}) {
  const pasos = [1, 2, 3, 4];
  const primera = pasos.find(n => !['ok', 'opcional'].includes(estados[n] || 'ok')) || 4;
  return Object.fromEntries(pasos.map(n => [n, typeof elecciones[n] === 'boolean' ? elecciones[n] : n === primera]));
}

// Firma del set de alertas: si cambia (alerta nueva, otro Δ%), el toast cerrado vuelve a aparecer.
function firmaAlertas(alertas) {
  return ((alertas && alertas.items) || [])
    .map(i => [i.productoId, i.tipo, i.id, i.deltaPct].join('|')).sort().join(';');
}

// Adónde lleva "Ver": un solo producto → su detalle; varios → selector con "solo con cambios".
function destinoToast(items) {
  const ids = [...new Set((items || []).map(i => i.productoId))];
  return ids.length === 1 ? { hash: '#produccion/' + ids[0], soloCambios: false } : { hash: '#produccion', soloCambios: true };
}
// Productos distintos con alertas (badge de la tab Producción).
const productosConCambios = alertas => new Set(((alertas && alertas.items) || []).map(i => i.productoId)).size;
// PLUs que movieron el costo de una receta/presentación desde su validación (componentes + agregados;
// los quitados ya no tienen fila). Sin estado 'cambio' → vacío.
const plusCambiados = cambios => new Set(!cambios || cambios.estado !== 'cambio' ? []
  : [...(cambios.componentes || []).map(c => String(c.plu)), ...(cambios.nuevos || []).map(String)]);

// Estado de una fila (receta o presentación): con faltantes gana 'faltantes'; si no, el del server.
function estadoFila(f) {
  if (f && Array.isArray(f.faltantes) && f.faltantes.length) return 'faltantes';
  return (f && f.estado) || 'sin-validar';
}

const pctTxt = n => (n == null ? '' : (n > 0 ? '+' : '') + Number(n).toFixed(1).replace('.', ',') + '%');

// Nombre legible de un componente (PLU, id manual o pseudo-componente _costoHora/_maquina…).
function nombreComponente(clave, nombres = {}) {
  if (ESPECIALES[clave]) return ESPECIALES[clave];
  return nombres[clave] ? `${nombres[clave]} (${clave})` : String(clave);
}

// Faltante (clave interna del costeo) → mensaje para humanos + acción que lo resuelve.
// accion: { tipo: 'config' | 'maquinas' | 'ganancia' } (sub-tabs de Configuración) | { tipo: 'paso', paso } | { tipo: 'costo', clave } | { tipo: 'margen', plu } | null.
const FALTANTES_FIJOS = {
  _costoHora: ['Falta el costo/hora de mano de obra — se carga en Configuración → General', { tipo: 'config' }, 'Ir a Configuración'],
  _maquina: ['La categoría de máquina no tiene costo/hora — se carga en Configuración → Máquinas', { tipo: 'maquinas' }, 'Ir a Máquinas'],
  rendimientoKg: ['Falta cuántos kg rinde una tanda (Kg por tanda)', { tipo: 'paso', paso: 1 }, 'Ir a la receta'],
  mermaPct: ['La merma tiene que ser un % entre 0 y 99', { tipo: 'paso', paso: 1 }, 'Ir a la receta'],
  receta: ['La receta elegida todavía no tiene costo: completá lo que le falta', { tipo: 'paso', paso: 1 }, 'Ir a las recetas'],
  kgPorUnidad: ['Falta cuántos kg de receta lleva cada unidad', null, ''],
};
// Avisos (no bloquean el precio) con acción: 'variedad' = presentación de datos viejos sobre la base.
function mensajeFaltante(clave, { nombres = {}, plu = null } = {}) {
  if (FALTANTES_FIJOS[clave]) { const [texto, accion, boton] = FALTANTES_FIJOS[clave]; return { texto, accion, boton }; }
  if (clave === 'variedad') {
    return { texto: 'Elegí una variedad para esta presentación (ahora no puede apuntar a la receta base)',
      accion: plu ? { tipo: 'abrirPres', clave: String(plu) } : null, boton: 'Elegir variedad' };
  }
  if (clave === 'markupPct') {
    if (typeof preciosSinConfig !== 'undefined' && preciosSinConfig) { // sin el permiso no hay Configuración (precios_almacen.js)
      return { texto: 'Sin markup standard: cargá un margen propio para este PLU o pedí que revisen la configuración',
        accion: plu ? { tipo: 'margen', plu: String(plu) } : null, boton: plu ? 'Cargar margen' : '' };
    }
    return { texto: 'Sin markup: revisá la curva de Producción (Configuración → Ganancia) o cargá un margen propio para este PLU',
      accion: plu ? { tipo: 'margen', plu: String(plu) } : { tipo: 'ganancia' }, boton: plu ? 'Cargar margen' : 'Ir a Ganancia' };
  }
  const nombre = nombres[clave];
  const texto = /^\d+$/.test(clave)
    ? `El PLU ${clave}${nombre ? ` (${nombre})` : ''} no tiene costo en SIGA → cargá un costo manual`
    : `El insumo manual "${nombre || clave}" no tiene costo → cargale uno`;
  return { texto, accion: { tipo: 'costo', clave: String(clave) }, boton: 'Cargar costo' };
}
const textoFaltante = (clave, nombres = {}) => mensajeFaltante(clave, { nombres }).texto;

// Checklist de progreso del producto (encabezado del detalle). estado: ok | parcial | falta | opcional.
function progresoProducto(det) {
  const recetas = Object.values(det.recetas || {});
  const bases = recetas.filter(r => !r.varianteDe), variedades = recetas.filter(r => r.varianteDe);
  const pres = Object.values(det.presentaciones || {});
  const filas = [...recetas, ...pres];
  const conPrecio = pres.filter(p => p.precioConIva != null).length;
  const validadas = filas.filter(f => f.estado === 'ok').length;
  const nInsumos = (det.insumos || []).length;
  return [
    { clave: 'base', paso: 1, texto: 'Receta base', estado: !bases.length ? 'falta' : bases.some(r => r.costoKg != null) ? 'ok' : 'parcial',
      detalle: !bases.length ? 'cargá ingredientes y kg por tanda' : bases.some(r => r.costoKg != null) ? 'con costo/kg' : 'le faltan datos para costear' },
    { clave: 'variedades', paso: 2, texto: 'Variedades', estado: variedades.length ? 'ok' : 'falta',
      detalle: variedades.length ? `${variedades.length} cargada${variedades.length === 1 ? '' : 's'}` : 'se crea sola al guardar la receta base' },
    { clave: 'insumos', paso: 3, texto: 'Insumos', estado: nInsumos ? 'ok' : 'opcional', detalle: nInsumos ? `${nInsumos} en la lista` : 'opcional' },
    { clave: 'presentaciones', paso: 4, texto: 'Presentaciones con precio', estado: !pres.length ? 'falta' : conPrecio === pres.length ? 'ok' : 'parcial',
      detalle: pres.length ? `${conPrecio} de ${pres.length} con precio` : 'ninguna todavía' },
    { clave: 'validado', paso: 4, texto: 'Validado', estado: !filas.length ? 'falta' : validadas === filas.length ? 'ok' : 'parcial',
      detalle: filas.length ? `${validadas} de ${filas.length} validados` : 'nada para validar' },
  ];
}

// Qué pasos se pueden usar: variedades necesitan una base guardada; presentaciones, una variedad
// (decisión 14: la presentación elige variedad, no base). paso = adónde lleva el botón del bloqueo.
function pasosHabilitados(det) {
  const recetas = Object.values(det.recetas || {});
  const hayBase = recetas.some(r => !r.varianteDe), hayVariedad = recetas.some(r => r.varianteDe);
  const libre = { ok: true, motivo: '', paso: null };
  const p2 = hayBase ? libre : { ok: false, motivo: 'Primero guardá una receta base (paso 1).', paso: 1 };
  const p4 = !hayBase ? p2 : hayVariedad ? libre
    : { ok: false, motivo: 'Primero creá una variedad (paso 2). Si el producto no tiene sabores, una variedad sin extras.', paso: 2 };
  return { 1: libre, 2: p2, 3: libre, 4: p4 };
}

// Panel "Para revisar" arriba del detalle: qué cambió (con su paso), qué falta para costear (sin repetir,
// con la acción que lo resuelve) y qué presentaciones tienen el vigente fuera de tolerancia.
function alertasDetalle(det, nombres = {}) {
  const recetas = Object.entries((det && det.recetas) || {}), pres = Object.values((det && det.presentaciones) || {});
  const delta = f => (f.cambios && f.cambios.deltaPct != null ? f.cambios.deltaPct : null);
  const cambios = [
    ...recetas.filter(([, r]) => estadoFila(r) === 'cambio')
      .map(([id, r]) => ({ tipo: 'receta', id, nombre: r.nombre || id, paso: r.varianteDe ? 2 : 1, deltaPct: delta(r) })),
    ...pres.filter(p => estadoFila(p) === 'cambio')
      .map(p => ({ tipo: 'presentacion', id: String(p.plu), nombre: p.nombre || String(p.plu), paso: 4, deltaPct: delta(p) })),
  ];
  const faltantes = [], vistos = new Set();
  const sumar = (claves, quien, plu = null) => [...new Set(claves || [])].forEach(k => {
    const m = mensajeFaltante(k, { nombres, plu });
    const firma = m.texto + JSON.stringify(m.accion);
    if (!vistos.has(firma)) { vistos.add(firma); faltantes.push({ ...m, quien }); }
  });
  recetas.forEach(([id, r]) => sumar(r.faltantes, r.nombre || id));
  pres.forEach(p => sumar([...(p.faltantes || []), ...((p.avisos || []).includes('variedad') ? ['variedad'] : [])], p.nombre || String(p.plu), String(p.plu)));
  const precios = pres.filter(p => !(p.faltantes || []).length && (p.semaforo === 'subir' || p.semaforo === 'bajar'))
    .map(p => ({ plu: String(p.plu), nombre: p.nombre || String(p.plu), semaforo: p.semaforo, deltaPct: p.deltaPct ?? null }));
  return { cambios, faltantes, precios, total: cambios.length + faltantes.length + precios.length };
}

// Texto del toast: título + las 3 primeras alertas (producto · nombre · Δ%).
function textoToast(alertas) {
  const total = (alertas && alertas.total) || 0;
  const titulo = total === 1 ? '1 costo de producción cambió' : `${total} costos de producción cambiaron`;
  const lineas = ((alertas && alertas.items) || []).slice(0, 3)
    .map(i => [i.producto, i.nombre, pctTxt(i.deltaPct)].filter(Boolean).join(' · '));
  return { titulo, lineas };
}

// "Pepas de Membrillo" → "pepas-de-membrillo" (mismo criterio que slug() del router).
function slugProd(nombre, max = 36) {
  const s = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return s || 'x';
}

// base, base-2, base-3… el primero que no está en existentes (mismo criterio que idUnico() del router).
function idLibre(base, existentes) {
  const ids = new Set(existentes || []);
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
// Id nuevo de receta: la primera es 'base'; después el slug del nombre, sin pisar existentes.
const idRecetaNueva = (nombre, existentes) => ((existentes || []).length ? idLibre(slugProd(nombre), existentes) : 'base');
// Id de categoría de máquina (ID_CATEGORIA del router: [a-z0-9-], hasta 40): slug del nombre, único.
const idCategoriaNueva = (nombre, existentes) => idLibre(slugProd(nombre), existentes);

// Id de insumo manual: m-<slug>-<sufijo> (el PUT es upsert: el sufijo evita pisar otro del mismo nombre).
const idManualNuevo = (nombre, sufijo) => `m-${slugProd(nombre, 30)}-${sufijo}`;

// Body del PUT de receta desde la copia editable (vacío = no se manda = hereda / default del server).
function bodyReceta(ed) {
  const items = (ed.items || []).map(it => ({ plu: String(it.plu), cantidad: it.cantidad, unidad: it.unidad || 'kg' }));
  const opc = (k, v) => (v == null || v === '' ? {} : { [k]: v });
  return {
    nombre: ed.nombre, ...(ed.varianteDe ? { varianteDe: ed.varianteDe, extras: items } : { materiasPrimas: items }),
    ...opc('rendimientoKg', ed.rendimientoKg), ...opc('mermaPct', ed.mermaPct),
    ...opc('minutosElaboracion', ed.minutosElaboracion), ...opc('categoriaMaquinaId', ed.categoriaMaquinaId),
  };
}

// Body del PUT de presentación: campos opcionales vacíos no se mandan; cada fila de insumo va
// (una cantidad vacía la rechaza el server con su mensaje).
function bodyPresentacion({ recetaId, kgPorUnidad, correccionPct, minutosEmpaquetado }, cantidades) {
  const opc = (k, v) => (v == null ? {} : { [k]: v });
  const insumos = (cantidades || [])
    .map(c => ({ ...(/^\d+$/.test(c.clave) ? { plu: c.clave } : { manualId: c.clave }), cantidad: c.cantidad }));
  return { recetaId, kgPorUnidad, ...opc('correccionPct', correccionPct), ...opc('minutosEmpaquetado', minutosEmpaquetado), insumos };
}

// Opciones del selector "Variedad / receta" de una presentación: bases primero, después cada variedad.
function opcionesVariedad(recetas) {
  const nombre = id => (recetas[id] || {}).nombre || id;
  return Object.entries(recetas || {}).filter(([, r]) => r.varianteDe).map(([id, r]) => [id, `${r.nombre} (de ${nombre(r.varianteDe)})`]);
}

// ── Presentación todavía no dada de alta en SIGA (decisión 13: el módulo no escribe en SIGA) ──
const esProvisoria = clave => /^n-/.test(String(clave || ''));
const claveProvisoria = (nombre, existentes) => idLibre('n-' + slugProd(nombre, 34), existentes);
// "Fórmula para cargar en SIGA" como texto tabulado (se pega en una planilla o se tipea en SIGA).
function textoFormulaSiga(filas, nombres = {}) {
  const num = v => String(v).replace('.', ',');
  return ['PLU\tComponente\tCantidad\tUnidad', ...(filas || []).map(f =>
    [f.plu || '(sin PLU)', nombres[f.plu || f.manualId] || f.plu || f.manualId, num(f.cantidad), f.unidad].join('\t'))].join('\n');
}

// ── Escalar e importar ingredientes (decisión 12) ──
const redondear4 = n => Math.round(n * 1e4) / 1e4;
// Cantidades × factor (kg y u), a 4 decimales. Factor inválido o 1 → la misma lista.
function escalarCantidades(items, factor) {
  if (!(Number(factor) > 0) || factor === 1) return items;
  return (items || []).map(it => (it.cantidad == null ? it : { ...it, cantidad: redondear4(Number(it.cantidad) * factor) }));
}
// Componentes de una fórmula SIGA → ingredientes de la receta: cantidad = cantPorUnidad × kg por tanda.
// Los que ya están se reemplazan (o suman) en su lugar; los nuevos van al final con unidad 'kg'
// (decisión: siempre kg, predecible; el usuario cambia a 'u' si corresponde).
function componentesAIngredientes(componentes, kgPorTanda, existentes, modo = 'reemplazar') {
  const nuevos = new Map();
  for (const c of componentes || []) {
    const cant = redondear4(Number(c.cantPorUnidad) * Number(kgPorTanda));
    const prev = nuevos.get(String(c.plu));
    nuevos.set(String(c.plu), prev ? { ...prev, cant: redondear4(prev.cant + cant) } : { c, cant });
  }
  const actualizados = (existentes || []).map(it => {
    const n = nuevos.get(String(it.plu));
    if (!n) return it;
    return { ...it, cantidad: modo === 'sumar' ? redondear4((Number(it.cantidad) || 0) + n.cant) : n.cant, pendiente: true };
  });
  const yaEstan = new Set((existentes || []).map(it => String(it.plu)));
  const agregados = [...nuevos.values()].filter(n => !yaEstan.has(String(n.c.plu))).map(({ c, cant }) => ({
    plu: String(c.plu), nombre: c.nombre || null, cantidad: cant, unidad: 'kg', costoUnit: c.costo ?? null, importe: null, fuente: c.fuente || null, pendiente: true,
  }));
  return [...actualizados, ...agregados];
}
const TIPOS_EMPAQUE = ['envase', 'tapa', 'etiqueta', 'precinto'];
const esEmpaque = c => TIPOS_EMPAQUE.includes(c && c.tipo);

// ── Modal de presentación: helpers puros ──
// Peso legible del "kg por unidad": 0.27 → "270 g", 1.5 → "1,5 kg".
function formatoPeso(kg) {
  const n = Number(kg);
  if (kg == null || !(n > 0)) return '';
  const fmt = v => String(Math.round(v * 10) / 10).replace('.', ',');
  return n < 1 ? `${fmt(n * 1000)} g` : `${fmt(n)} kg`;
}
// Firma del formulario de presentación { plu, recetaId, kg, correccion, minutos, sel: { clave: cantidad } }.
const firmaPresentacion = v => JSON.stringify([v.plu || null, v.recetaId || null, v.kg ?? null, v.correccion ?? null, v.minutos ?? null,
  Object.entries(v.sel || {}).map(([k, c]) => [String(k), c ?? null]).sort(), !!v.sinSiga, (v.nombreNuevo || '').trim()]);
const presentacionSucia = (actual, inicial) => firmaPresentacion(actual) !== firmaPresentacion(inicial);
// Qué obligatorio falta ('' = se puede guardar). sinPlu: para la vista previa (costea sin PLU elegido).
function faltaObligatorioPres(v, { sinPlu = false } = {}) {
  if (v.sinSiga && !(v.nombreNuevo || '').trim()) return 'Poné el nombre de la presentación nueva en ① (todavía no está en SIGA).';
  if (!sinPlu && !v.sinSiga && !v.plu) return 'Elegí el producto a la venta (PLU de SIGA) en ①, o marcá que todavía no está en SIGA.';
  if (!v.recetaId) return 'Elegí de qué variedad sale en ②.';
  if (!(Number(v.kg) > 0)) return 'Completá "Kg por unidad" en ③ (ej. 0,5).';
  if (Object.values(v.sel || {}).some(c => !(Number(c) > 0))) return 'Completá la cantidad de cada empaque tildado en ④.';
  return '';
}

// Pista de rendimiento de una variante (decisión 7): kg de la base + Σ kg de extras en kg. Sólo placeholder.
function rendimientoSugerido(rendBase, extras) {
  const kg = (extras || []).filter(e => (e.unidad || 'kg') === 'kg').reduce((s, e) => s + (Number(e.cantidad) || 0), 0);
  return Number(rendBase) > 0 ? Math.round((Number(rendBase) + kg) * 1000) / 1000 : null;
}

// Importe de empaque de una presentación = suma de sus insumos (null si alguno no tiene costo).
function importeEmpaque(componentes) {
  const ins = (componentes || []).filter(c => !String(c.plu).startsWith('_'));
  if (ins.some(c => c.importe == null)) return null;
  return Math.round(ins.reduce((s, c) => s + c.importe, 0) * 100) / 100;
}

if (typeof module === 'object' && module.exports) {
  module.exports = {
    parsearHashProduccion, seccionesAbiertas, firmaAlertas, destinoToast, productosConCambios, plusCambiados, estadoFila, nombreComponente, textoFaltante, textoToast,
    mensajeFaltante, progresoProducto, pasosHabilitados, alertasDetalle, formatoPeso, presentacionSucia, faltaObligatorioPres, esProvisoria, claveProvisoria, textoFormulaSiga,
    escalarCantidades, componentesAIngredientes, esEmpaque,
    slugProd, idRecetaNueva, idCategoriaNueva, idManualNuevo, bodyReceta, bodyPresentacion, opcionesVariedad, rendimientoSugerido, importeEmpaque,
    // Orden de tablas: vive en precios_orden.js (compartido por todos los tabs).
    ordenarFilas: require('./precios_orden.js').ordenarFilas, siguienteOrden: require('./precios_orden.js').siguienteOrden,
  };
}

// ── Estado y API ────────────────────────────────────────────────────────────────
const API_PROD = '/api/precios/produccion';
let prodLista = null;          // filas del selector
let prodBusqueda = '';
let prodSoloCambios = false;
let prodSoloRevisar = false;   // vista plana: sólo presentaciones con semáforo subir/bajar
const VISTA_KEY = 'precios.produccion.vista';
let prodVista = (() => { try { return sessionStorage.getItem(VISTA_KEY) === 'presentaciones' ? 'presentaciones' : 'productos'; } catch { return 'productos'; } })();
let prodDet = null;            // detalle del producto abierto, tal como vino del server
let prodSeccionesElegidas = {}; // paso → abierto/cerrado a mano por el usuario (se resetea al cambiar de producto)
let prodAlertas = { total: 0, items: [] };
const TOAST_KEY = 'precios.produccion.toastCerrado';

const getJson = url => fetch(url).then(r => r.json()).then(j => { if (j && j.error) throw new Error(j.error); return j; });
const urlProd = (id, resto = '') => `${API_PROD}/productos/${encodeURIComponent(id)}${resto}`;
// Contenido de la tab (selector o detalle); la barra de marcados de arriba es fija en precios.html.
const panelProd = () => document.getElementById('prodContenido');
const cargandoHtml = txt => `<div class="p-10 text-center text-ink/50"><span class="spin"></span> ${esc(txt)}</div>`;
const fmtNum = n => (n == null ? '—' : new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(n));
const btnCls = 'px-3 py-1.5 rounded-lg border border-borde text-sm hover:bg-white disabled:opacity-40';
const btnPrim = 'px-3 py-1.5 rounded-lg bg-verde text-white text-sm font-semibold hover:bg-verdeHover disabled:opacity-40';
const campoCls = 'px-2 py-1 rounded-lg border border-borde bg-white text-sm focus:outline-none focus:border-verde focus:ring-2 focus:ring-verde/20';

// Marca de "componentes modificados": borde izquierdo warn + fondo cálido (selector, recetas y presentaciones).
const MARCA_CAMBIO = 'bg-warn/5 border-l-4 border-l-warn';
const TIT_CAMBIO = 'Componentes modificados: revisar y validar';
const ESTADO_PROD = {
  cambio: ['bg-warn/15 text-warn', 'Costo cambió'], ok: ['bg-ok/15 text-ok', 'Validado'],
  'sin-validar': ['bg-gris/15 text-gris', 'Sin validar'], faltantes: ['bg-gris/15 text-gris', 'Faltan datos'],
};
// Badge de estado de receta/presentación; con faltantes el tooltip los lista.
function badgeEstadoProd(f, nombres) {
  const e = estadoFila(f);
  const [cls, txt] = ESTADO_PROD[e] || ESTADO_PROD['sin-validar'];
  const delta = e === 'cambio' && f.cambios && f.cambios.deltaPct != null ? ' ' + pctTxt(f.cambios.deltaPct) : '';
  const tip = e === 'faltantes' ? ` title="${esc('Falta: ' + f.faltantes.map(k => textoFaltante(k, nombres)).join(', '))}"` : '';
  return `<span class="px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap ${cls}"${tip}>${txt}${delta}</span>`;
}

// ── Diálogo con campos (themed, como #dlgAviso): Promise<{campo: valor} | null> ─────
function dialogoCampos() {
  let d = document.getElementById('dlgProd');
  if (d) return d;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="dlgProd" class="rounded-xl border border-borde shadow-fluent p-0 w-[min(92vw,420px)] bg-card text-ink backdrop:bg-ink/40" aria-labelledby="dlgProdTit">
      <form method="dialog" class="p-5">
        <h3 id="dlgProdTit" class="font-disp text-lg font-bold mb-3"></h3>
        <div class="dp-campos space-y-3"></div>
        <div class="flex justify-end gap-2 mt-5">
          <button value="cancelar" formnovalidate class="${btnCls}">Cancelar</button>
          <button value="ok" class="dp-ok ${btnPrim}">Aceptar</button>
        </div>
      </form>
    </dialog>`);
  d = document.getElementById('dlgProd');
  // Escape cierra sólo este diálogo (cancel nativo), no el #mDet que puede estar abajo.
  d.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
  return d;
}
function htmlCampoDialogo(c) {
  const attrs = `name="${esc(c.name)}" class="mt-1 w-full ${campoCls} py-2"${c.required ? ' required' : ''}`;
  const control = c.options
    ? `<select ${attrs}>${c.options.map(([v, t]) => `<option value="${esc(v)}"${v === c.value ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`
    : `<input ${attrs} type="${c.type || 'text'}"${c.type === 'number' ? ' step="any" min="0"' : ' maxlength="60"'} value="${esc(c.value ?? '')}">`;
  return `<label class="block text-sm">${esc(c.label)}${control}</label>`;
}
function pedirCampos(titulo, campos, textoOk = 'Guardar') {
  const d = dialogoCampos();
  d.querySelector('#dlgProdTit').textContent = titulo;
  d.querySelector('.dp-campos').innerHTML = campos.map(htmlCampoDialogo).join('');
  d.querySelector('.dp-ok').textContent = textoOk;
  d.returnValue = '';
  d.showModal();
  d.querySelector('input, select').focus();
  return new Promise(res => d.addEventListener('close', () => {
    if (d.returnValue !== 'ok') { res(null); return; }
    res(Object.fromEntries(campos.map(c => [c.name, d.querySelector(`[name="${c.name}"]`).value.trim()])));
  }, { once: true }));
}

// ── Buscador SIGA (GET /api/siga/buscar, el mismo de Planificación) ─────────────
// Lista flotante `fixed` (los acordeones tienen overflow:hidden); se cierra al scrollear.
const BUSCAR_DEBOUNCE_MS = 250;
function htmlBuscadorSiga(id, placeholder) {
  return `<input type="search" id="${id}" placeholder="${esc(placeholder)}" autocomplete="off" aria-expanded="false"
      aria-controls="${id}-lista" class="${campoCls} w-full sm:w-80">
    <div id="${id}-lista" role="listbox" class="bs-lista hidden fixed z-[60] bg-card border border-borde rounded-xl shadow-fluent overflow-y-auto" style="max-height:280px"></div>`;
}
function htmlResultadosSiga(rows) {
  if (!rows.length) return '<div class="px-3 py-3 text-sm text-gris">Sin resultados</div>';
  return rows.map(r => `<button type="button" role="option" data-plu="${esc(r.plu)}" data-nombre="${esc(r.producto)}"
      class="block w-full text-left px-3 py-1.5 text-sm hover:bg-verde/10 focus:bg-verde/10 focus:outline-none">
      <b class="tabular-nums">${esc(r.plu)}</b> · ${esc(r.producto)} <span class="text-xs text-gris">${esc(r.rubro)}</span></button>`).join('');
}
function conectarBuscadorSiga(id, onElegir) {
  const input = document.getElementById(id), lista = document.getElementById(id + '-lista');
  let timer = null, seq = 0;
  const mostrar = html => {
    const r = input.getBoundingClientRect();
    lista.innerHTML = html;
    lista.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 368)) + 'px';
    lista.style.top = (r.bottom + 4) + 'px';
    lista.style.width = Math.min(360, window.innerWidth - 16) + 'px';
    lista.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true');
  };
  const cerrar = () => { lista.classList.add('hidden'); input.setAttribute('aria-expanded', 'false'); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { cerrar(); return; }
    timer = setTimeout(async () => {
      const n = ++seq;
      mostrar('<div class="px-3 py-3 text-sm text-gris"><span class="spin"></span> Buscando…</div>');
      try { const rows = await getJson('/api/siga/buscar?q=' + encodeURIComponent(q)); if (n === seq) mostrar(htmlResultadosSiga(rows)); }
      catch (e) { if (n === seq) mostrar(`<div class="px-3 py-3 text-sm text-crit">${esc(e.message)}</div>`); }
    }, BUSCAR_DEBOUNCE_MS);
  });
  lista.addEventListener('click', e => {
    const b = e.target.closest('[data-plu]');
    if (!b) return;
    cerrar(); input.value = '';
    onElegir({ plu: b.dataset.plu, nombre: b.dataset.nombre });
  });
  input.addEventListener('keydown', e => {
    // Con la lista abierta, Escape sólo la cierra (preventDefault: no cierra el diálogo que la contiene).
    if (e.key === 'Escape' && !lista.classList.contains('hidden')) { cerrar(); e.stopPropagation(); e.preventDefault(); }
    const primero = lista.querySelector('[data-plu]');
    if (e.key === 'ArrowDown' && primero) { e.preventDefault(); primero.focus(); }
  });
  lista.addEventListener('keydown', e => {
    const b = e.target.closest('[data-plu]');
    if (!b) return;
    const sig = e.key === 'ArrowDown' ? b.nextElementSibling : e.key === 'ArrowUp' ? b.previousElementSibling : null;
    if (sig) { e.preventDefault(); sig.focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cerrar(); input.focus(); }
  });
}

// ── Ruteo por hash ──────────────────────────────────────────────────────────────
const tabActiva = () => (document.querySelector('#tabs .navtab.on') || {}).dataset?.tipo;
function rutearProduccion() {
  const r = parsearHashProduccion(location.hash);
  if (!r) { if (tabActiva() === 'produccion') activarTab('almacen'); return; }
  activarTab('produccion');
  if (r.vista === 'detalle') cargarDetalleProduccion(r.id, { abrirPlu: r.plu || null });
  else if (r.vista === 'recetas') cargarSelectorProduccion();
  else cargarListado('produccion'); // precios_listados.js: precios de Producción con el esquema por canal
}
function irAProduccion(id, plu = null) {
  const h = id ? '#produccion/' + encodeURIComponent(id) + (plu ? '/' + encodeURIComponent(plu) : '') : '#produccion';
  if (location.hash === h) rutearProduccion(); else location.hash = h;
}
// Al ir a otra tab se saca el hash (entrada nueva: "atrás" vuelve a Producción).
function salirDeProduccion() {
  if (parsearHashProduccion(location.hash)) history.pushState(null, '', location.pathname + location.search);
}

// ── Vista 1: selector de productos ──────────────────────────────────────────────
async function cargarSelectorProduccion() {
  prodDet = null;
  const panel = panelProd();
  panel.innerHTML = htmlSelectorMarco();
  conectarSelector();
  try {
    prodLista = await getJson(API_PROD + '/productos');
    tomarExportProd(prodLista); // precios_produccion_export.js: presentaciones marcables/marcadas
    pintarListadoProd();
  } catch (e) {
    const tbody = document.querySelector('#prCuerpo, #prPlanas');
    if (tbody) tbody.innerHTML = `<tr><td colspan="${COLS_SELECTOR}" class="p-8 text-center text-crit">No se pudo cargar: ${esc(e.message)}</td></tr>`;
  }
}
const COLS_SELECTOR = 7;
const esVistaPlana = () => prodVista === 'presentaciones';
const pintarListadoProd = () => (esVistaPlana() ? pintarFilasPlanas() : pintarFilasSelector()); // pintarFilasPlanas: precios_produccion_export.js
// Toggle "Por producto" | "Todas las presentaciones": re-arma el marco con los datos ya cargados (sin otro GET).
function cambiarVistaProd(vista) {
  if (vista === prodVista) return;
  prodVista = vista;
  try { sessionStorage.setItem(VISTA_KEY, vista); } catch { /* sin storage: dura hasta recargar */ }
  panelProd().innerHTML = htmlSelectorMarco();
  conectarSelector();
  if (prodLista) pintarListadoProd();
}
const htmlToggleVista = () => `<div class="pr-vista" role="group" aria-label="Ver el listado">${[['productos', 'Por producto'], ['presentaciones', 'Todas las presentaciones']]
  .map(([v, t]) => `<button type="button" data-vista="${v}" aria-pressed="${prodVista === v}">${t}</button>`).join('')}</div>`;
const htmlTablaSelector = () => `<table class="pr-tabla pr-sel">
        <thead><tr><th class="text-left" data-orden="nombre">Producto</th><th class="num" data-orden="variantes">Variedades</th>
          <th class="num" data-orden="presentaciones">Presentaciones</th><th class="num" data-orden="costo">Costo/kg base</th>
          <th data-orden="fecha" title="Último cambio de precio en SIGA: el de la presentación más desactualizada">Act. precio</th><th class="text-left" data-orden="estado">Estado</th><th class="w-10"><span class="sr-only">Abrir</span></th></tr></thead>
        <tbody id="prCuerpo"><tr><td colspan="${COLS_SELECTOR}">${cargandoHtml('Cargando…')}</td></tr></tbody>
      </table>`;
// Listado: encabezado con CTA, tiras de resumen, toggle de vista, buscador y tabla (por producto o todas las presentaciones).
function htmlSelectorMarco() {
  const plana = esVistaPlana();
  const filtro = plana
    ? `<button id="prSoloRevisar" class="fbtn${prodSoloRevisar ? ' on' : ''}" aria-pressed="${prodSoloRevisar}" title="Vigente de SIGA fuera de tolerancia (subir o bajar)">A revisar <span id="prNRevisar"></span></button>`
    : `<button id="prSoloCambios" class="fbtn${prodSoloCambios ? ' on' : ''}" aria-pressed="${prodSoloCambios}"><span class="text-warn">●</span> Con cambios de componentes <span id="prNCambios"></span></button>`;
  const ph = plana ? 'Buscar presentación, producto o PLU…' : 'Buscar producto…';
  return `
    <div class="pr-cab">
      <div><h2 class="pr-tit">Productos de producción</h2>
        <p class="cfg-cab !mb-0">Cada producto se costea en 4 pasos: <b>receta base → variedades → insumos → presentaciones y precios</b>. Abrí uno para ver su costo y precio sugerido.</p></div>
      <span class="flex gap-2 shrink-0"><button id="prNuevoSiga" class="cfg-btn2" title="Crea el producto con la receta base y los insumos de la fórmula de un producto de SIGA">Nuevo desde fórmula SIGA</button>
        <button id="prNuevo" class="cfg-btn pr-cta">+ Nuevo producto</button></span>
    </div>
    <div id="prKpis" class="pr-kpis" aria-live="polite"></div>
    <div class="pr-filtros">
      ${htmlToggleVista()}
      <input id="prBuscar" type="search" placeholder="${ph}" value="${esc(prodBusqueda)}" aria-label="${ph.slice(0, -1)}" class="campo-t w-80">
      ${filtro}
      <span id="prConteo" class="ml-auto text-sm text-gris"></span>
    </div>
    <div class="pr-tabla-caja">
      ${plana ? htmlTablaPlanas() /* precios_produccion_export.js */ : htmlTablaSelector()}
    </div>`;
}
// Fecha de precio más vieja del producto, si pasó DIAS_PRECIO_VIEJO (precios_orden.js).
const precioViejoProd = p => { const r = rangoFechas((p.exportables || []).map(e => e.fechaPrecio)); return !!(r && esPrecioViejo(r.min)); };
function htmlKpisSelector() {
  const l = prodLista || [];
  const kpi = (n, txt, cls, tip) => `<div class="pr-kpi ${n ? cls : 'k-cero'}" title="${esc(tip)}"><b>${n}</b><span>${txt}</span></div>`;
  return kpi(l.length, l.length === 1 ? 'producto' : 'productos', 'k-neutro', 'Productos de producción cargados')
    + kpi(l.reduce((s, p) => s + p.presentaciones, 0), 'presentaciones', 'k-neutro', 'PLUs vendibles en total')
    + kpi(l.filter(p => p.alertas > 0).length, 'con costos que cambiaron', 'k-warn', TIT_CAMBIO)
    + kpi(l.filter(p => p.faltantes > 0).length, 'con datos faltantes', 'k-crit', 'Recetas o presentaciones que no se pueden costear')
    + kpi(l.filter(precioViejoProd).length, `con precio de más de ${DIAS_PRECIO_VIEJO} días`, 'k-warn', 'Alguna presentación sin cambio de precio en SIGA hace mucho');
}
function pintarKpisProd() {
  const k = document.getElementById('prKpis');
  if (k) k.innerHTML = prodLista && prodLista.length ? htmlKpisSelector() : '';
}
function conectarSelector() {
  document.getElementById('prBuscar').addEventListener('input', e => { prodBusqueda = e.target.value; pintarListadoProd(); });
  const filtro = document.getElementById(esVistaPlana() ? 'prSoloRevisar' : 'prSoloCambios');
  filtro.onclick = () => {
    const on = esVistaPlana() ? (prodSoloRevisar = !prodSoloRevisar) : (prodSoloCambios = !prodSoloCambios);
    filtro.classList.toggle('on', on);
    filtro.setAttribute('aria-pressed', String(on));
    pintarListadoProd();
  };
  document.querySelectorAll('.pr-vista [data-vista]').forEach(b => { b.onclick = () => cambiarVistaProd(b.dataset.vista); });
  document.getElementById('prNuevo').onclick = nuevoProducto;
  document.getElementById('prNuevoSiga').onclick = abrirNuevoDesdeSiga; // precios_produccion_formula.js
  if (esVistaPlana()) montarOrdenPlanasProd(); else montarOrdenSelectorProd(); // precios_produccion_export.js / precios_orden.js
}
// Estado del producto: chips accionables a simple vista (cambios, faltantes, precio viejo) o "al día".
function htmlEstadoSelector(p) {
  const partes = [];
  if (p.alertas) partes.push(chip(`● ${p.alertas} ${p.alertas === 1 ? 'costo cambió' : 'costos cambiaron'}`, 'bg-warn/15 text-warn'));
  if (p.faltantes) partes.push(chip(`${p.faltantes} con faltantes`, 'bg-crit/10 text-crit'));
  if (precioViejoProd(p)) partes.push(chip(`precio +${DIAS_PRECIO_VIEJO} días`, 'bg-amarillo/30 text-ink'));
  if (!p.presentaciones) partes.push(chip('sin presentaciones', 'bg-gris/15 text-gris'));
  return partes.join(' ') || chip('✓ al día', 'bg-ok/15 text-ok');
}
// Presentaciones: total + cuántas tienen precio sugerido (exportables = las que tienen PLU de SIGA).
function htmlPresSelector(p) {
  if (!p.presentaciones) return '<span class="text-gris">—</span>';
  const conPrecio = (p.exportables || []).filter(e => e.precioConIva != null).length;
  return `<b>${p.presentaciones}</b><span class="pr-sub">${conPrecio} con precio</span>`;
}
function pintarFilasSelector() {
  const tbody = document.getElementById('prCuerpo');
  if (!tbody || !prodLista) return;
  const q = normTxt(prodBusqueda.trim());
  const filas = ordenarSelectorProd(prodLista.filter(p => (!q || normTxt(p.nombre).includes(q)) && (!prodSoloCambios || p.alertas > 0)));
  pintarKpisProd();
  document.getElementById('prConteo').textContent = prodLista.length ? `${filas.length} de ${prodLista.length} productos` : '';
  document.getElementById('prNCambios').textContent = `(${prodLista.filter(p => p.alertas > 0).length})`;
  if (!prodLista.length) { tbody.innerHTML = `<tr><td colspan="${COLS_SELECTOR}">${htmlSelectorVacio()}</td></tr>`; conectarSelectorVacio(); return; }
  if (!filas.length) { tbody.innerHTML = `<tr><td colspan="${COLS_SELECTOR}" class="p-10 text-center text-ink/50">Ningún producto coincide</td></tr>`; return; }
  tbody.innerHTML = filas.map(p => `
    <tr class="pr-fila-prod${p.alertas > 0 ? ' pr-cambio' : ''}" data-id="${esc(p.id)}">
      <td><a href="#produccion/${esc(encodeURIComponent(p.id))}" class="pr-nombre-prod">${esc(p.nombre)}</a></td>
      <td class="num">${p.variantes || '<span class="text-gris">—</span>'}</td>
      <td class="num">${htmlPresSelector(p)}</td>
      <td class="num">${p.costoKgBase != null ? '<b>$ ' + fmtMoney(p.costoKgBase) + '</b><span class="pr-sub">por kg</span>' : '<span class="text-gris">—</span>'}</td>
      ${htmlFechaPrecio((p.exportables || []).map(e => e.fechaPrecio), 'pr-td')}
      <td><div class="flex flex-wrap gap-1">${htmlEstadoSelector(p)}</div></td>
      <td class="text-right"><span class="pr-abrir" aria-hidden="true">›</span></td>
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) irAProduccion(tr.dataset.id); });
}
// Selector vacío: el flujo en 4 pasos + CTA.
const PASOS_FLUJO = [
  ['Receta base', 'ingredientes de una tanda de máquina y cuántos kg rinde'],
  ['Variedades (opcional)', 'la sin extras se crea sola con la receta base; agregá otras solo si tiene sabores, ej. Pepas de membrillo'],
  ['Insumos', 'envases, etiquetas, tapas y precintos que usa el producto'],
  ['Presentaciones', 'cada PLU vendible (250 g, 500 g, 1 kg…) con su precio sugerido'],
];
function htmlSelectorVacio() {
  return `<div class="p-6 sm:p-10 max-w-xl mx-auto text-left">
    <h3 class="font-disp text-lg font-bold text-ink">Todavía no hay productos de producción</h3>
    <p class="text-sm text-gris mt-1">Un producto (Granola, Pepas…) se arma en 4 pasos y el módulo calcula costo y precio sugerido. Si ya existe en SIGA, usá <b>Nuevo desde fórmula SIGA</b>.</p>
    <ol class="mt-4 space-y-2">${PASOS_FLUJO.map(([t, d], i) => `<li class="flex gap-3 text-sm">
      <span class="w-6 h-6 shrink-0 rounded-full bg-verde/10 text-verde font-bold grid place-items-center text-xs">${i + 1}</span>
      <span><b>${t}</b> <span class="text-gris">— ${d}</span></span></li>`).join('')}</ol>
    <button id="prPrimerProducto" class="mt-5 ${btnPrim}">Crear tu primer producto</button></div>`;
}
function conectarSelectorVacio() { document.getElementById('prPrimerProducto').onclick = nuevoProducto; }
async function nuevoProducto() {
  const v = await pedirCampos('Nuevo producto', [{ name: 'nombre', label: 'Nombre (ej. Granola, Pepas)', required: true }], 'Crear');
  if (!v) return;
  try {
    const j = await pedirJson('POST', API_PROD + '/productos', { nombre: v.nombre });
    irAProduccion(j.id);
  } catch (e) { avisar(e.message); }
}

// ── Vista 2: detalle del producto (flujo guiado; lo pinta precios_produccion_detalle.js) ──
// abrirPlu (ruta #produccion/<id>/<plu>, desde la vista plana): abre esa presentación y deja el hash en el detalle.
async function cargarDetalleProduccion(id, { silencioso = false, abrirPlu = null } = {}) {
  const panel = panelProd();
  if (!silencioso) panel.innerHTML = cargandoHtml('Cargando producto…');
  try {
    const d = await getJson(urlProd(id));
    const mismo = prodDet && prodDet.id === d.id;
    prodDet = d;
    if (!mismo) prodSeccionesElegidas = {};
    iniciarEdicionesProd(mismo); // precios_produccion_detalle.js
    pintarDetalleProduccion();
    if (abrirPlu) {
      history.replaceState(null, '', '#produccion/' + encodeURIComponent(id));
      if (prodDet.presentaciones[abrirPlu]) abrirPresentacion(abrirPlu); // precios_produccion_modal.js
    }
  } catch (e) {
    panel.innerHTML = `<div class="p-8 text-center"><p class="text-crit mb-3">No se pudo cargar: ${esc(e.message)}</p>
      <a href="#produccion" class="text-verde hover:text-verdeHover">← Productos</a></div>`;
  }
}
// Después de cualquier guardado: re-GET del detalle (costos del server) + re-chequeo del toast.
async function recargarDetalleProd() {
  if (prodDet) await cargarDetalleProduccion(prodDet.id, { silencioso: true });
  refrescarAlertasProduccion();
}
// Corre fn (un guardado); errores del server en el diálogo themed; al terminar, recarga y confirma.
// msgOk puede ser una función: se evalúa después del guardado (mensaje según la respuesta).
async function guardarProd(fn, btn, msgOk = 'Guardado') {
  if (btn) btn.disabled = true;
  try { await fn(); await recargarDetalleProd(); avisoExito(typeof msgOk === 'function' ? msgOk() : msgOk); return true; }
  catch (e) { avisar(e.message); return false; }
  finally { if (btn && document.contains(btn)) btn.disabled = false; }
}

// POST validar: { tipo: 'receta'|'presentacion'|'todo', id? }. 'todo' informa lo omitido por faltantes.
async function validarProd(pedido, btn) {
  let omitidos = [];
  const ok = await guardarProd(async () => {
    const j = await pedirJson('POST', urlProd(prodDet.id, '/validar'), pedido);
    omitidos = j.omitidos || [];
  }, btn, 'Costo validado');
  if (ok && omitidos.length) {
    const nombre = o => ((o.tipo === 'receta' ? prodDet.recetas : prodDet.presentaciones)[o.id] || {}).nombre || o.id;
    avisar('No se validaron porque les faltan datos:\n' + omitidos.map(o => `• ${nombre(o)}: ${o.faltantes.map(k => textoFaltante(k)).join('; ')}`).join('\n'));
  }
  return ok;
}
// ── Toast de éxito (corto, distinto del de alertas) ─────────────────────────────
const EXITO_MS = 2500;
let exitoTimer = null;
function avisoExito(msg) {
  const t = document.getElementById('prExito');
  if (!t || !msg) return;
  t.innerHTML = `<div class="fade-in bg-card border border-ok/40 border-l-4 border-l-ok rounded-xl shadow-fluent px-4 py-2 text-sm font-semibold text-ok">✓ ${esc(msg)}</div>`;
  clearTimeout(exitoTimer);
  exitoTimer = setTimeout(() => { t.innerHTML = ''; }, EXITO_MS);
}

// ── Toast de alertas (todas las tabs) ───────────────────────────────────────────
function leerCerrado() { try { return sessionStorage.getItem(TOAST_KEY); } catch { return null; } }
function guardarCerrado(firma) { try { sessionStorage.setItem(TOAST_KEY, firma); } catch { /* sin storage: se oculta sólo hasta recargar */ } }
let toastCerradoMem = null;

function pintarToast() {
  const t = document.getElementById('prToast');
  if (!t) return;
  const firma = firmaAlertas(prodAlertas);
  if (!prodAlertas.total || firma === (leerCerrado() ?? toastCerradoMem)) { t.innerHTML = ''; return; }
  const { titulo, lineas } = textoToast(prodAlertas);
  t.innerHTML = `
    <div class="fade-in bg-card border border-borde border-l-4 border-l-warn rounded-xl shadow-fluent p-3 text-sm">
      <div class="flex items-start gap-2">
        <span class="font-semibold text-warn">⚠ ${esc(titulo)}</span>
        <button id="prToastVer" class="ml-auto font-semibold text-verde hover:text-verdeHover underline underline-offset-2">Ver</button>
        <button id="prToastX" class="w-6 h-6 -mr-1 rounded-lg text-gris hover:bg-bg hover:text-ink" aria-label="Cerrar aviso">✕</button>
      </div>
      <ul class="mt-1 text-xs text-gris space-y-0.5">${lineas.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    </div>`;
  document.getElementById('prToastVer').onclick = () => {
    const dest = destinoToast(prodAlertas.items);
    prodSoloCambios = dest.soloCambios;
    if (dest.soloCambios) prodVista = 'productos'; // el filtro "con cambios" es de la vista por producto
    if (location.hash === dest.hash) rutearProduccion(); else location.hash = dest.hash;
  };
  document.getElementById('prToastX').onclick = () => { toastCerradoMem = firma; guardarCerrado(firma); pintarToast(); };
}
// Hook global: se llama al abrir /precios y después de cualquier guardado que pueda mover costos
// (costo-producto de Almacén/Fraccionado, config general, ediciones de Producción).
async function refrescarAlertasProduccion() {
  try { prodAlertas = await getJson(API_PROD + '/alertas'); }
  catch { return; } // ponytail: el toast es un aviso; si la consulta falla queda el último estado, sin romper la tab que guardó
  pintarToast();
  pintarBadgeTabProd();
}
// Badge de la tab Producción: cantidad de productos con cambios de componentes (oculto si 0).
function pintarBadgeTabProd() {
  const b = document.getElementById('tabProdBadge');
  if (!b) return;
  const n = productosConCambios(prodAlertas);
  b.textContent = String(n);
  b.title = `${n} ${n === 1 ? 'producto' : 'productos'} con componentes modificados: revisar y validar`;
  b.classList.toggle('hidden', !n);
}
if (typeof window !== 'undefined') window.refrescarAlertasProduccion = refrescarAlertasProduccion; // explícito: lo llaman precios.html y precios_fraccionado.js

function iniciarProduccion() {
  document.body.insertAdjacentHTML('beforeend',
    '<div id="prToast" role="status" aria-live="polite" class="fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)]"></div>'
    + '<div id="prExito" role="status" aria-live="polite" class="fixed bottom-4 left-1/2 -translate-x-1/2 z-[70] max-w-[calc(100vw-2rem)]"></div>');
  // Botones de acción de faltantes/pasos bloqueados/checklist (detalle y modal): delegado.
  document.addEventListener('click', e => { const b = e.target.closest('[data-pr-accion]'); if (b) ejecutarAccionProd(b.dataset); }); // precios_produccion_detalle.js
  window.addEventListener('hashchange', rutearProduccion);
  // Scroll de la página (no de la propia lista) → cerrar listas flotantes del buscador SIGA.
  window.addEventListener('scroll', e => document.querySelectorAll('.bs-lista').forEach(l => {
    if (!l.contains(e.target)) l.classList.add('hidden');
  }), { passive: true, capture: true });
  // Click fuera de la lista y de su input → cerrarla.
  document.addEventListener('click', e => document.querySelectorAll('.bs-lista:not(.hidden)').forEach(l => {
    if (!l.contains(e.target) && e.target.id !== l.id.replace(/-lista$/, '')) l.classList.add('hidden');
  }));
  if (parsearHashProduccion(location.hash)) rutearProduccion();
  refrescarAlertasProduccion();
}
// Al DOMContentLoaded ya corrieron precios.html, precios_fraccionado.js y los otros dos precios_produccion_*.js.
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', iniciarProduccion);
