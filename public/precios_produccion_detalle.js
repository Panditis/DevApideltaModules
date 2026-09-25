// ── Precios · Producción: detalle como flujo guiado — encabezado, checklist y pasos 1-2 (recetas) ──
// Script clásico, cargado después de precios_produccion.js: usa sus globales (prodDet, pedirCampos,
// guardarProd, validarProd, urlProd, API_PROD, conectarBuscadorSiga, htmlBuscadorSiga, badgeEstadoProd,
// mensajeFaltante, textoFaltante, nombreComponente, progresoProducto, pasosHabilitados, bodyReceta,
// idRecetaNueva, rendimientoSugerido, fmtNum, pctTxt, btnCls/btnPrim/campoCls, panelProd,
// prodSeccionesCerradas, irAProduccion, salirDeProduccion) y los de precios.html (esc, fmtMoney, chip,
// numOrNull, avisar, confirmar, pedirJson, activarTab) y de precios_produccion_modal.js (presAbierta, cerrarPresentacion). Pasos 3-4 (insumos y
// presentaciones) en precios_produccion_presentaciones.js. Los importes y costos se muestran tal como
// vienen del server: después de cada guardado se vuelve a pedir el detalle.

// ── Recetas: copias editables ───────────────────────────────────────────────────
// prodEdRecetas[recetaId] = { nombre, varianteDe, rendimientoKg, mermaPct, minutosElaboracion,
// categoriaMaquinaId, items: [{ plu, nombre, cantidad, unidad, costoUnit, importe, fuente, pendiente? }],
// sucio, nueva }. items = materias primas (base) o extras (variedad), con el costo del server.
let prodEdRecetas = {};
// Orden elegido por tabla de ingredientes ("<productoId>/<recetaId>" → { clave, dir }). Sólo visual:
// no toca el orden guardado ni marca "sin guardar". Vive mientras dure la página (sobrevive al re-GET).
let prodOrdenRecetas = {};
const claveOrdenReceta = id => `${prodDet.id}/${id}`;

function edicionReceta(id) {
  const def = prodDet.definicion.recetas[id];
  const comp = (prodDet.recetas[id] || {}).componentes || [];
  // componentes = [MP de la base…, extras…, _costoHora, _maquina] en el orden de la definición.
  const nBase = def.varianteDe ? ((prodDet.definicion.recetas[def.varianteDe] || {}).materiasPrimas || []).length : 0;
  const lista = def.varianteDe ? def.extras || [] : def.materiasPrimas || [];
  const items = lista.map((it, i) => {
    const c = comp[nBase + i] || {};
    return { plu: String(it.plu), cantidad: it.cantidad, unidad: it.unidad || 'kg', nombre: c.nombre || null, costoUnit: c.costoUnit ?? null, importe: c.importe ?? null, fuente: c.fuente || null };
  });
  return {
    nombre: def.nombre, varianteDe: def.varianteDe || null, rendimientoKg: def.rendimientoKg ?? null, mermaPct: def.mermaPct ?? null,
    minutosElaboracion: def.minutosElaboracion ?? null, categoriaMaquinaId: def.categoriaMaquinaId || '', items, sucio: false, nueva: false,
  };
}
// Tras cada GET: se reconstruyen desde el server, salvo las que tienen cambios sin guardar (mismo producto).
function iniciarEdicionesProd(mismoProducto) {
  const prev = mismoProducto ? prodEdRecetas : {};
  const ids = Object.keys(prodDet.definicion.recetas || {});
  const guardadas = Object.fromEntries(ids.map(id => [id, prev[id] && prev[id].sucio && !prev[id].nueva ? prev[id] : edicionReceta(id)]));
  const borradores = Object.fromEntries(Object.entries(prev).filter(([id, ed]) => ed.nueva && !ids.includes(id)));
  prodEdRecetas = { ...guardadas, ...borradores };
}
const sinReceta = id => Object.fromEntries(Object.entries(prodEdRecetas).filter(([k]) => k !== id));
const idsBase = () => Object.keys(prodEdRecetas).filter(id => !prodEdRecetas[id].varianteDe);
const idsVariedades = () => Object.keys(prodEdRecetas).filter(id => prodEdRecetas[id].varianteDe);
// Bases guardadas (una variedad sólo puede colgar de una base que ya existe en el server).
const basesGuardadas = () => Object.entries(prodDet.definicion.recetas || {}).filter(([, r]) => !r.varianteDe);

// Nombres de todos los componentes del producto (para cambios, faltantes y tooltips).
function nombresProd() {
  const m = {};
  for (const f of [...Object.values(prodDet.recetas), ...Object.values(prodDet.presentaciones)]) {
    for (const c of f.componentes) if (c.nombre && !String(c.plu).startsWith('_')) m[c.plu] = c.nombre;
  }
  for (const it of prodDet.insumos) if (it.nombre) m[it.clave] = it.nombre;
  return m;
}

// ── Faltantes con acción + tabla antes/ahora ────────────────────────────────────
// Botón de acción (lo resuelve ejecutarAccionProd, delegado en precios_produccion.js).
function btnAccion(accion, texto) {
  if (!accion) return '';
  const datos = Object.entries(accion).filter(([k]) => k !== 'tipo').map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<button type="button" data-pr-accion="${esc(accion.tipo)}"${datos} class="text-xs font-semibold text-verde hover:text-verdeHover underline underline-offset-2">${esc(texto)}</button>`;
}
// Qué falta para costear (en lenguaje humano, con su acción) + avisos. plu = presentación (para "Cargar margen").
function htmlNotas(f, nombres, plu = null) {
  const faltan = [...new Set(f.faltantes || [])].map(k => mensajeFaltante(k, { nombres, plu }));
  const lista = faltan.length ? `<div class="mt-3 rounded-lg border border-borde bg-bg/60 p-3">
    <div class="text-xs font-semibold text-ink mb-1">Para calcular el costo falta:</div>
    <ul class="space-y-1">${faltan.map(m => `<li class="flex flex-wrap items-center gap-x-2 text-xs text-gris"><span>• ${esc(m.texto)}</span>${btnAccion(m.accion, m.boton)}</li>`).join('')}</ul></div>` : '';
  const avisos = (f.avisos || []).map(a => `<p class="text-xs text-warn mt-2">⚠ ${esc(a)}</p>`).join('');
  return lista + avisos;
}
const valorCambio = (k, v) => (v == null ? 'sin costo' : '$ ' + fmtMoney(v) + (k === '_costoHora' || k === '_maquina' ? '/h' : ''));
// Componentes que movieron desde la validación (detectarCambios del server).
function htmlCambios(cambios, nombres) {
  if (!cambios || cambios.estado !== 'cambio') return '';
  const filas = [
    ...cambios.componentes.map(x => [nombreComponente(x.plu, nombres), valorCambio(x.plu, x.antes), valorCambio(x.plu, x.ahora), x.deltaPct == null ? '—' : pctTxt(x.deltaPct)]),
    ...cambios.nuevos.map(k => [nombreComponente(k, nombres), '—', 'agregado', '']),
    ...cambios.quitados.map(k => [nombreComponente(k, nombres), 'estaba', 'quitado', '']),
  ];
  return `<div class="mt-3 rounded-lg border border-warn/30 bg-warn/5 p-2">
    <div class="text-xs font-semibold text-warn mb-1">Cambios desde la última validación${cambios.deltaPct != null ? ' · total ' + esc(pctTxt(cambios.deltaPct)) : ''}</div>
    <div class="overflow-x-auto"><table class="w-full text-xs"><thead class="text-gris"><tr><th class="text-left p-1">Componente</th>
      <th class="text-right p-1">Antes</th><th class="text-right p-1">Ahora</th><th class="text-right p-1">Δ%</th></tr></thead>
      <tbody>${filas.map(f => `<tr><td class="p-1">${esc(f[0])}</td><td class="p-1 text-right tabular-nums">${esc(f[1])}</td>
        <td class="p-1 text-right tabular-nums">${esc(f[2])}</td><td class="p-1 text-right tabular-nums font-semibold">${esc(f[3])}</td></tr>`).join('')}</tbody></table></div></div>`;
}

// ── Acciones (faltantes, checklist, pasos bloqueados) ───────────────────────────
async function irAPaso(n) {
  if (!(await cerrarPresentacion())) return; // con cambios sin guardar pregunta
  const paso = document.getElementById('paso-' + n);
  if (!paso) return;
  paso.open = true;
  paso.scrollIntoView({ behavior: 'smooth', block: 'start' });
  paso.querySelector('summary').focus({ preventScroll: true });
}
async function cargarCostoManual(clave) {
  const esPlu = /^\d+$/.test(clave);
  const m = (prodDet.insumosManuales || []).find(x => x.id === clave);
  const v = await pedirCampos(`Costo de ${nombresProd()[clave] || (m && m.nombre) || clave}`,
    [{ name: 'costo', label: 'Costo por unidad, sin IVA ($) *', type: 'number', required: true }], 'Guardar costo');
  if (!v) return;
  const costo = numOrNull(v.costo);
  const put = esPlu ? () => pedirJson('PUT', '/api/precios/costo-producto/' + encodeURIComponent(clave), { fuente: 'manual', costo })
    : () => pedirJson('PUT', `${API_PROD}/insumos-manuales/${encodeURIComponent(clave)}`, { nombre: m ? m.nombre : clave, costo, tipo: m ? m.tipo : undefined });
  if (await guardarProd(put, null, 'Costo guardado')) refrescarModalPres(); // precios_produccion_modal.js
}
async function cargarMargen(plu) {
  const v = await pedirCampos(`Margen para el PLU ${plu}`,
    [{ name: 'markupPct', label: 'Markup % sobre el costo (ej. 50) *', type: 'number', required: true }], 'Guardar margen');
  if (!v) return;
  const ok = await guardarProd(() => pedirJson('PUT', '/api/precios/margen-producto/' + encodeURIComponent(plu), { markupPct: numOrNull(v.markupPct) }), null, 'Margen guardado');
  if (ok) refrescarModalPres();
}
function ejecutarAccionProd(ds) {
  if (ds.prAccion === 'paso') irAPaso(Number(ds.paso));
  else if (ds.prAccion === 'costo') cargarCostoManual(ds.clave);
  else if (ds.prAccion === 'margen') cargarMargen(ds.plu);
  else if (ds.prAccion === 'abrirPres') abrirPresentacion(ds.clave); // precios_produccion_modal.js
  else if (ds.prAccion === 'config') irAConfiguracion();
}
async function irAConfiguracion() {
  if (!(await cerrarPresentacion())) return; // con cambios sin guardar pregunta
  salirDeProduccion();
  activarTab('configuracion');
  window.scrollTo(0, 0);
}

// ── Encabezado + checklist de progreso ──────────────────────────────────────────
const ICONO_PROGRESO = {
  ok: ['✓', 'text-ok border-ok/40 bg-ok/5'], parcial: ['◐', 'text-warn border-warn/40 bg-warn/5'],
  falta: ['○', 'text-gris border-borde bg-card'], opcional: ['–', 'text-gris border-borde bg-card'],
};
function htmlChecklist(prog) {
  return `<ol class="flex flex-wrap gap-2 mb-4" aria-label="Progreso del producto">${prog.map(p => {
    const [ic, cls] = ICONO_PROGRESO[p.estado];
    return `<li><button type="button" data-pr-accion="paso" data-paso="${p.paso}" class="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left hover:shadow-fluent ${cls}">
      <span class="font-bold" aria-hidden="true">${ic}</span><span><span class="block text-sm font-semibold text-ink">${esc(p.texto)}</span>
      <span class="block text-[11px] text-gris">${esc(p.detalle)}</span></span></button></li>`;
  }).join('')}</ol>`;
}
function htmlEncabezadoDetalle(d, prog) {
  const { alertas } = d.resumen;
  return `
    <div class="flex items-center gap-2 flex-wrap mb-3">
      <a href="#produccion" class="text-sm text-verde hover:text-verdeHover whitespace-nowrap">← Productos</a>
      <input id="prNombre" maxlength="60" aria-label="Nombre del producto" value="${esc(d.nombre)}" title="Tocá para renombrar"
        class="font-disp text-xl font-bold text-ink bg-transparent border border-transparent hover:border-borde focus:border-verde focus:bg-white rounded-lg px-2 py-0.5 min-w-0 w-64 max-w-full focus:outline-none">
      ${alertas ? chip(`${alertas} costo${alertas === 1 ? '' : 's'} cambiaron`, 'bg-warn/15 text-warn') : ''}
      <span class="ml-auto flex gap-2">
        <button id="prValidarTodo" class="${btnCls}" title="Guarda el costo actual de todas las recetas y presentaciones sin faltantes">Validar todo</button>
        <button id="prEliminar" class="px-3 py-1.5 rounded-lg text-sm text-crit hover:bg-crit/10">Eliminar producto</button>
      </span>
    </div>
    ${htmlChecklist(prog)}`;
}
function conectarEncabezado() {
  const inNombre = document.getElementById('prNombre');
  inNombre.addEventListener('change', () => {
    const nombre = inNombre.value.trim();
    if (!nombre || nombre === prodDet.nombre) { inNombre.value = prodDet.nombre; return; }
    guardarProd(() => pedirJson('PUT', urlProd(prodDet.id), { nombre }), null, 'Nombre guardado');
  });
  inNombre.addEventListener('keydown', e => { if (e.key === 'Enter') inNombre.blur(); });
  document.getElementById('prValidarTodo').onclick = e => validarProd({ tipo: 'todo' }, e.currentTarget);
  document.getElementById('prEliminar').onclick = eliminarProducto;
}
async function eliminarProducto() {
  const n = Object.keys(prodDet.recetas).length, m = Object.keys(prodDet.presentaciones).length;
  if (!(await confirmar(`¿Eliminar "${prodDet.nombre}"? Se borran sus ${n} receta(s) y ${m} presentación(es). No se puede deshacer.`, { textoOk: 'Eliminar' }))) return;
  try {
    await pedirJson('DELETE', urlProd(prodDet.id));
    refrescarAlertasProduccion();
    irAProduccion('');
  } catch (e) { avisar(e.message); }
}

// ── Marco de pasos ──────────────────────────────────────────────────────────────
const ESTADO_PASO = {
  ok: ['bg-ok/15 text-ok', 'Listo'], parcial: ['bg-warn/15 text-warn', 'Incompleto'],
  falta: ['bg-gris/15 text-gris', 'Pendiente'], opcional: ['bg-gris/15 text-gris', 'Opcional'],
};
const PASOS = {
  1: ['Receta base', 'Define el costo por kg de lo que produce una tanda de máquina.', 'Ingredientes de una tanda y cuántos kg rinde.'],
  2: ['Variedades', 'Lo que se vende: la receta base + 0, 1 o 2 ingredientes extra (ej. Pepas de membrillo = masa + membrillo). Las presentaciones eligen una variedad.', 'Al menos una variedad: nombre y receta base; los extras son opcionales (sin extras = la base tal cual).'],
  3: ['Insumos', 'Lista de envases, etiquetas, tapas y precintos que usa este producto. Cada presentación elige de acá.', 'Los insumos de SIGA (o manuales si no tienen PLU), con su costo.'],
  4: ['Presentaciones', 'Cada PLU vendible (250 g, 500 g, 1 kg…) con su costo y precio sugerido.', 'PLU de SIGA, variedad/receta, kg por unidad y qué insumos lleva.'],
};
function htmlPaso(n, estado, hab, cuerpoFn) {
  const [titulo, para, necesitas] = PASOS[n];
  const [cls, txt] = hab.ok ? ESTADO_PASO[estado] : ['bg-gris/15 text-gris', 'Bloqueado'];
  const cuerpo = hab.ok ? cuerpoFn() : `<div class="rounded-lg border border-dashed border-borde bg-bg/60 p-4 text-sm text-gris flex flex-wrap items-center gap-3">
      <span>${esc(hab.motivo)}</span><button type="button" data-pr-accion="paso" data-paso="${hab.paso}" class="${btnCls}">Ir al paso ${hab.paso}</button></div>`;
  return `<details class="acordeon" id="paso-${n}" data-sec="${n}"${prodSeccionesCerradas.has(String(n)) ? '' : ' open'}>
    <summary><span class="caret" aria-hidden="true">▶</span>
      <span class="w-7 h-7 shrink-0 rounded-full bg-verde/10 text-verde font-bold grid place-items-center text-sm">${n}</span>
      <span class="min-w-0"><span class="block font-disp text-base font-bold text-verde">${titulo}</span>
        <span class="block text-xs text-gris">${esc(para)}</span></span>
      <span class="ml-auto shrink-0 px-2 py-0.5 rounded-full text-xs font-semibold ${cls}">${txt}</span></summary>
    <div class="cuerpo pt-3"><p class="text-xs text-gris mb-3"><b class="text-ink">Qué necesitás cargar:</b> ${esc(necesitas)}
      <span class="ml-1">Los campos con <span class="text-crit">*</span> son obligatorios.</span></p>${cuerpo}</div></details>`;
}
function pintarDetalleProduccion() {
  const hab = pasosHabilitados(prodDet), prog = progresoProducto(prodDet);
  const est = Object.fromEntries(prog.map(p => [p.clave, p.estado]));
  panelProd().innerHTML = htmlEncabezadoDetalle(prodDet, prog)
    + htmlPaso(1, est.base, hab[1], htmlPaso1) + htmlPaso(2, est.variedades, hab[2], htmlPaso2)
    + htmlPaso(3, est.insumos, hab[3], htmlSeccionInsumos) + htmlPaso(4, est.presentaciones, hab[4], htmlSeccionPresentaciones);
  conectarEncabezado();
  conectarRecetas();
  if (hab[3].ok) conectarSeccionInsumos();          // precios_produccion_presentaciones.js
  if (hab[4].ok) conectarSeccionPresentaciones();   // precios_produccion_presentaciones.js
  panelProd().querySelectorAll('details[data-sec]').forEach(det => det.addEventListener('toggle', () => {
    const s = new Set(prodSeccionesCerradas);
    if (det.open) s.delete(det.dataset.sec); else s.add(det.dataset.sec);
    prodSeccionesCerradas = s;
  }));
}

// ── Pasos 1 y 2: cuerpo ─────────────────────────────────────────────────────────
const cajaVacia = (texto, boton) => `<div class="rounded-xl border border-dashed border-borde bg-bg/40 p-5 text-sm text-gris">
  <p class="mb-3">${texto}</p>${boton}</div>`;
function htmlPaso1() {
  const bases = idsBase();
  if (!bases.length) {
    return cajaVacia('Todavía no hay receta base. Es <b class="text-ink">una tanda de máquina</b>: sus ingredientes y cuántos kg rinde. Con eso el módulo calcula el costo por kg.',
      `<button id="prNuevaReceta" class="${btnPrim}">Crear receta base</button>`);
  }
  return bases.map(htmlReceta).join('') + `<button id="prNuevaReceta" class="${btnCls} mt-3">+ Otra receta base</button>`;
}
function htmlPaso2() {
  const vars = idsVariedades();
  if (!vars.length) {
    return cajaVacia('Cada presentación sale de una variedad: la receta base + algún ingrediente extra (ej. Pepas de membrillo). <b class="text-ink">Si el producto no tiene sabores, creá una variedad sin extras</b> (ej. Clásica).',
      `<button id="prNuevaVariedad" class="${btnPrim}">Crear variedad</button>`);
  }
  return vars.map(htmlReceta).join('') + `<button id="prNuevaVariedad" class="${btnCls} mt-3">+ Otra variedad</button>`;
}
function conectarRecetas() {
  const nb = document.getElementById('prNuevaReceta');
  if (nb) nb.onclick = nuevaRecetaBase;
  const nv = document.getElementById('prNuevaVariedad');
  if (nv) nv.onclick = () => crearVariedad();
  Object.keys(prodEdRecetas).forEach(conectarReceta);
}

// ── Tarjeta de receta (base) y de variedad ──────────────────────────────────────
const REQ = '<span class="text-crit" aria-hidden="true">*</span>';
const ayuda = txt => `<span class="block text-[11px] text-gris/90 mt-0.5 font-normal">${txt}</span>`;
function htmlReceta(id) {
  const ed = prodEdRecetas[id];
  const c = prodDet.recetas[id] || null; // null = borrador sin guardar
  const nombres = nombresProd();
  const esVar = !!ed.varianteDe;
  return `<article class="rounded-xl border border-borde bg-card p-3 sm:p-4 mt-3" data-receta="${esc(id)}">
    ${htmlRecetaCabecera(ed, c, nombres)}
    ${esVar ? htmlVariedadBase(ed, c) : htmlRecetaCampos(ed)}
    <div class="mt-4 text-sm font-semibold text-ink">${esVar ? `Extras: cantidad para los ${fmtNum(kgBaseDe(ed))} kg de la receta base <span class="font-normal text-xs text-gris">(opcional)</span>` : `Ingredientes de una tanda ${REQ}`}
      ${ayuda(esVar ? `Ej. dulce de batata para los ${fmtNum(kgBaseDe(ed))} kg de masa. Si el producto no tiene sabores, dejala sin extras.${ed.rendimientoKg != null && ed.rendimientoKg !== '' ? ` La variedad tiene rendimiento propio (${fmtNum(ed.rendimientoKg)} kg) en Opciones avanzadas: los extras siguen siendo para los kg de la base.` : ''}` : 'Cantidad de cada ingrediente para una tanda, en kg o unidades. Al menos uno.')}</div>
    ${htmlRecetaTabla(id, ed, c)}
    <div class="mt-2 flex flex-wrap items-center gap-2">${htmlBuscadorSiga('prBusca-' + id, esVar ? 'Buscar ingrediente extra en SIGA (PLU o nombre)…' : 'Buscar ingrediente en SIGA (PLU o nombre)…')}
      <button type="button" class="rc-formula ${btnCls}" title="Copiar los componentes de la fórmula de un producto de SIGA">Traer fórmula de SIGA</button></div>
    ${esVar ? `<details class="mt-3"${['rendimientoKg', 'mermaPct', 'minutosElaboracion', 'categoriaMaquinaId'].some(k => ed[k] != null && ed[k] !== '') ? ' open' : ''}>
      <summary class="text-xs text-gris cursor-pointer hover:text-ink">Opciones avanzadas (pisar lo que hereda de la base)</summary>${htmlRecetaCampos(ed)}</details>` : ''}
    ${c ? htmlNotas(c, nombres) + htmlCambios(c.cambios, nombres) : ''}
    ${htmlRecetaAcciones(ed, c)}
  </article>`;
}
function htmlRecetaCabecera(ed, c, nombres) {
  const tag = ed.varianteDe ? chip('variedad', 'bg-verde/10 text-verde') : chip('base', 'bg-verde/10 text-verde');
  return `<div class="flex items-center gap-2 flex-wrap">
    <label class="text-xs text-gris">Nombre ${REQ}<input class="rc-campo block mt-0.5 font-semibold ${campoCls} w-56 max-w-full" data-campo="nombre" maxlength="60" value="${esc(ed.nombre)}"></label>
    ${tag} ${c ? badgeEstadoProd(c, nombres) : chip('sin guardar', 'bg-amarillo/30 text-ink')}
    <span class="rc-sucio text-xs text-warn${ed.sucio && c ? '' : ' hidden'}">● cambios sin guardar</span>
    <span class="ml-auto text-sm text-gris whitespace-nowrap">Costo/kg <b class="text-lg text-verde tabular-nums">${c && c.costoKg != null ? '$ ' + fmtMoney(c.costoKg) : '—'}</b></span>
  </div>`;
}
function htmlVariedadBase(ed, c) {
  const bases = basesGuardadas().map(([bid, r]) => `<option value="${esc(bid)}"${bid === ed.varianteDe ? ' selected' : ''}>${esc(r.nombre)}</option>`).join('');
  return `<div class="flex flex-wrap items-end gap-x-6 gap-y-2 mt-3">
    <label class="block text-xs text-gris">Receta base ${REQ}
      <select class="rc-campo mt-1 ${campoCls} min-w-[12rem]" data-campo="varianteDe">${bases}</select></label>
    <div class="text-sm text-gris">${htmlDesglose(c)}</div></div>`;
}
// "Producto terminado por tanda: 120 kg de base + 47,3 kg de extras = 167,3 kg (−3% merma → 162,3 kg)".
// Todos los números vienen del server (costeo de la variedad: desglose); el extra no altera la base.
function htmlDesglose(c) {
  const d = c && c.desglose;
  if (!d || d.totalKg == null) return 'Producto terminado por tanda: —';
  const kg = n => `<b class="text-ink tabular-nums">${fmtNum(n)} kg</b>`;
  const cuenta = d.rendimientoPropio ? `${kg(d.totalKg)} <span class="text-xs">(rendimiento propio de la variedad)</span>`
    : `${kg(d.baseKg)} de base + ${kg(d.extrasKg)} de extras = ${kg(d.totalKg)}`;
  const merma = d.mermaPct ? ` (−${fmtNum(d.mermaPct)}% merma → ${kg(d.utilKg)})` : '';
  const u = d.extrasEnUnidades ? ' <span class="text-xs">(los extras en unidades no suman peso)</span>' : '';
  return `Producto terminado por tanda: ${cuenta}${merma}${u}`;
}
// Kg de la receta base de una variedad (los extras son "para una tanda de la base").
const kgBaseDe = ed => { const b = prodDet.definicion.recetas[ed.varianteDe] || {}; return Number(b.rendimientoKg) > 0 ? Number(b.rendimientoKg) : null; };
function opcionesCategoria(ed, esVariedad) {
  const cats = prodDet.categoriasMaquina || [];
  const opciones = [['', esVariedad ? 'Hereda de la base' : 'Sin máquina (costo $0)'],
    ...cats.map(c => [c.id, `${c.nombre} · $ ${fmtMoney(c.costoHora)}/h`])];
  if (ed.categoriaMaquinaId && !cats.some(c => c.id === ed.categoriaMaquinaId)) opciones.push([ed.categoriaMaquinaId, `${ed.categoriaMaquinaId} (no existe)`]);
  return opciones.map(([v, t]) => `<option value="${esc(v)}"${v === ed.categoriaMaquinaId ? ' selected' : ''}>${esc(t)}</option>`).join('');
}
function htmlRecetaCampos(ed) {
  const base = ed.varianteDe ? prodEdRecetas[ed.varianteDe] : null;
  const hereda = (k, ej) => (base ? (base[k] != null && base[k] !== '' ? `hereda: ${base[k]}` : 'hereda de la base') : ej);
  const num = (campo, label, ph, txt) => `<label class="block text-xs text-gris">${label}
      <input type="number" step="any" min="0" class="rc-campo mt-1 w-full ${campoCls} text-right tabular-nums" data-campo="${campo}" value="${ed[campo] ?? ''}" placeholder="${esc(ph)}">${ayuda(txt)}</label>`;
  const rendPh = base ? `por defecto: ${fmtNum(rendimientoSugerido(base.rendimientoKg, ed.items))}` : 'ej. 104';
  return `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
    <div>${num('rendimientoKg', `Kg por tanda ${base ? '' : REQ}`, rendPh, 'Lo que rinde una tanda de máquina.')}${htmlAjuste(ed)}</div>
    ${num('mermaPct', 'Merma %', hereda('mermaPct', 'ej. 3'), base ? 'Opcional: pérdida del proceso.' : 'Solo si "Kg por tanda" son los kg que entran; si ya es lo que sale, dejalo en 0.')}
    ${num('minutosElaboracion', 'Minutos de elaboración', hereda('minutosElaboracion', 'ej. 90'), 'Opcional: tiempo de una tanda (suma mano de obra).')}
    <label class="block text-xs text-gris">Máquina
      <select class="rc-campo mt-1 w-full ${campoCls}" data-campo="categoriaMaquinaId">${opcionesCategoria(ed, !!base)}</select>
      ${ayuda('Opcional: suma el costo/hora de la máquina.')}</label>
  </div>`;
}
// Aviso inline tras escalar por cambio de kg por tanda (decisión 12), con Deshacer.
function htmlAjuste(ed) {
  const a = ed.ajuste;
  if (!a) return '';
  const fx = String(Math.round(a.factor * 1000) / 1000).replace('.', ',');
  return `<p class="text-[11px] text-ok mt-1">Cantidades ajustadas ×${fx} (de ${fmtNum(a.de)} a ${fmtNum(a.a)} kg) ·
    <button type="button" class="rc-deshacer underline font-semibold">Deshacer</button>
    ${ed.varianteDe ? '' : '<span class="block text-gris">Al guardar, los extras de sus variedades se ajustan igual.</span>'}</p>`;
}
// Cambio de kg por tanda confirmado (evento change): escala todas las cantidades por nuevo/anterior.
// Si antes estaba vacío o 0, o no hay ingredientes, no escala.
function escalarPorRendimiento(id, anterior, nuevo) {
  const ed = prodEdRecetas[id];
  if (!(anterior > 0) || !(nuevo > 0) || anterior === nuevo || !ed.items.length) return;
  const previo = ed.ajuste || { itemsPrevios: ed.items, de: anterior };
  const factor = nuevo / anterior;
  editarReceta(id, { items: escalarCantidades(ed.items, factor), ajuste: { ...previo, a: nuevo, factor: nuevo / previo.de } }, true);
}
function deshacerAjuste(id) {
  const a = prodEdRecetas[id].ajuste;
  editarReceta(id, { items: a.itemsPrevios, rendimientoKg: a.de, ajuste: null }, true);
}

const celdaCosto = v => (v != null ? '$ ' + fmtMoney(v) : '<span class="text-crit text-xs">sin costo</span>');
function celdasCosto(r) {
  if (r.pendiente) return '<td colspan="3" class="p-1.5 text-xs text-gris">se calcula al guardar</td>';
  return `<td class="p-1.5 text-right tabular-nums">${celdaCosto(r.costoUnit)}</td>
    <td class="p-1.5 text-right tabular-nums">${r.importe != null ? '$ ' + fmtMoney(r.importe) : '—'}</td>
    <td class="p-1.5 text-xs text-gris">${textoFuente(r.fuente)}</td>`;
}
const filaItem = (it, i) => `<tr class="border-t border-borde" data-i="${i}"><td class="p-1.5 tabular-nums">${esc(it.plu)}</td>
  <td class="p-1.5">${esc(it.nombre || '—')}</td>
  <td class="p-1.5 text-right"><input type="number" min="0" step="any" class="rc-cant num-in w-24" placeholder="ej. 5" aria-label="Cantidad de ${esc(it.nombre || it.plu)} (obligatoria)" value="${it.cantidad ?? ''}"></td>
  <td class="p-1.5"><select class="rc-unidad num-in" aria-label="Unidad de ${esc(it.nombre || it.plu)}">
    <option value="kg"${it.unidad === 'u' ? '' : ' selected'}>kg</option><option value="u"${it.unidad === 'u' ? ' selected' : ''}>u</option></select></td>
  ${celdasCosto(it)}
  <td class="p-1.5 text-center"><button type="button" class="rc-quitar w-7 h-7 rounded-lg text-gris hover:text-crit hover:bg-crit/10" aria-label="Quitar ${esc(it.nombre || it.plu)}" title="Quitar">✕</button></td></tr>`;
// Mano de obra / máquina de la tanda (del server, sólo lectura).
const filaElab = c => `<tr><td></td><td class="p-1.5" colspan="3">${esc(c.plu === '_costoHora' ? 'Mano de obra' : 'Máquina · ' + (c.nombre || ''))}
  <span class="text-xs">${fmtNum(c.cantidad)} min × ${c.costoUnit != null ? '$ ' + fmtMoney(c.costoUnit) + '/min' : '—'}</span></td>
  <td></td><td class="p-1.5 text-right tabular-nums">${c.importe != null ? '$ ' + fmtMoney(c.importe) : '—'}</td><td class="p-1.5 text-xs">config</td><td></td></tr>`;
// Header ordenable: <th aria-sort> con un <button> (teclado) e indicador ▲/▼ en la columna activa.
function thOrden(clave, texto, orden, der = false) {
  const activo = orden && orden.clave === clave;
  const aria = activo ? (orden.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return `<th class="p-1.5 ${der ? 'text-right' : 'text-left'}" aria-sort="${aria}"><button type="button" data-orden="${clave}"
    class="inline-flex items-center gap-1 uppercase tracking-[.02em] hover:text-verde ${activo ? 'text-verde' : ''}" title="Ordenar por ${esc(texto.replace(/<[^>]+>/g, ''))}">
    ${texto}<span aria-hidden="true" class="text-[9px]">${activo ? (orden.dir === 'asc' ? '▲' : '▼') : ''}</span></button></th>`;
}
// Variedad: fila fija arriba (fuera del orden) con lo que aporta la receta base, para que la suma
// "Costo de la tanda" cierre. El importe es costoBaseIngredientes del server.
function htmlFilaBase(ed, c) {
  if (!ed.varianteDe) return '';
  const b = prodDet.definicion.recetas[ed.varianteDe] || {};
  const imp = c && c.costoBaseIngredientes != null ? '$ ' + fmtMoney(c.costoBaseIngredientes) : '—';
  return `<tbody><tr class="bg-verde/5 font-medium"><td class="p-1.5" colspan="2">${esc(b.nombre || ed.varianteDe)} — ${fmtNum(b.rendimientoKg)} kg
    <span class="text-xs text-gris font-normal">(ingredientes de la base)</span></td>
    <td colspan="3"></td><td class="p-1.5 text-right tabular-nums">${imp}</td><td class="p-1.5 text-xs text-gris">receta</td><td></td></tr></tbody>`;
}
function htmlRecetaTabla(id, ed, c) {
  const vacio = `<tr><td colspan="8" class="p-3 text-xs text-gris">Todavía no agregaste ${ed.varianteDe ? 'extras' : 'ingredientes'}: buscalos abajo.</td></tr>`;
  const elab = c ? c.componentes.filter(x => x.plu === '_costoHora' || x.plu === '_maquina') : [];
  const orden = prodOrdenRecetas[claveOrdenReceta(id)] || null;
  // Filas con su índice original (data-i): editar/quitar siguen apuntando al ítem correcto.
  const filas = ordenarFilas(ed.items.map((it, i) => ({ ...it, _i: i })), orden && orden.clave, orden && orden.dir);
  return `<div class="overflow-x-auto mt-2"><table class="w-full text-sm">
    <thead class="text-xs text-gris"><tr>${thOrden('plu', 'PLU', orden)}${thOrden('nombre', ed.varianteDe ? 'Extra' : 'Ingrediente', orden)}
      ${thOrden('cantidad', `Cantidad ${REQ}`, orden, true)}${thOrden('unidad', 'Unidad', orden)}${thOrden('costoUnit', 'Costo unit.', orden, true)}
      ${thOrden('importe', 'Importe', orden, true)}${thOrden('fuente', 'Fuente', orden)}<th></th></tr></thead>
    ${htmlFilaBase(ed, c)}<tbody>${filas.map(f => filaItem(f, f._i)).join('') || (ed.varianteDe ? '' : vacio)}</tbody>
    <tfoot class="text-gris">${elab.map(filaElab).join('')}
      <tr class="border-t border-borde"><td colspan="5" class="p-1.5 text-right">Costo de la tanda</td>
        <td class="p-1.5 text-right tabular-nums font-semibold text-ink">${c && c.costoBatch != null ? '$ ' + fmtMoney(c.costoBatch) : '—'}</td><td colspan="2"></td></tr></tfoot>
  </table></div>`;
}
function htmlRecetaAcciones(ed, c) {
  const tip = !c ? '' : c.faltantes.length ? 'Con datos faltantes no se puede validar' : c.estado === 'ok' ? 'Ya está validada con el costo actual' : 'Guarda el costo actual como referencia para detectar cambios';
  const puedeValidar = c && !c.faltantes.length && c.estado !== 'ok';
  const guardar = ed.varianteDe ? 'Guardar variedad' : c ? 'Guardar receta' : 'Crear receta';
  return `<div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-borde">
    <button type="button" class="rc-guardar ${btnPrim}">${guardar}</button>
    ${c ? `<button type="button" class="rc-validar ${btnCls}" title="${esc(tip)}"${puedeValidar ? '' : ' disabled'}>Validar costo</button>` : ''}
    <button type="button" class="rc-eliminar ml-auto px-3 py-1.5 rounded-lg text-xs text-crit hover:bg-crit/10">${c ? 'Eliminar' : 'Descartar'}</button>
  </div>`;
}

// ── Recetas: eventos ────────────────────────────────────────────────────────────
const articuloReceta = id => document.querySelector(`article[data-receta="${id}"]`);
function repintarReceta(id) {
  articuloReceta(id).outerHTML = htmlReceta(id);
  conectarReceta(id);
}
// Cambio en la copia editable (inmutable). repintar = cambió la lista de ítems.
function editarReceta(id, cambio, repintar = false) {
  prodEdRecetas = { ...prodEdRecetas, [id]: { ...prodEdRecetas[id], ...cambio, sucio: true } };
  if (repintar) { repintarReceta(id); return; }
  if (prodDet.recetas[id]) articuloReceta(id).querySelector('.rc-sucio').classList.remove('hidden');
}
function conectarItemsReceta(id, art) {
  const items = () => prodEdRecetas[id].items;
  art.querySelectorAll('tr[data-i]').forEach(tr => {
    const i = Number(tr.dataset.i);
    const setItem = cambio => editarReceta(id, { items: items().map((it, k) => (k === i ? { ...it, ...cambio } : it)) });
    tr.querySelector('.rc-cant').addEventListener('input', e => setItem({ cantidad: numOrNull(e.target.value) }));
    tr.querySelector('.rc-unidad').addEventListener('change', e => setItem({ unidad: e.target.value }));
    tr.querySelector('.rc-quitar').onclick = () => editarReceta(id, { items: items().filter((_, k) => k !== i) }, true);
  });
  conectarBuscadorSiga('prBusca-' + id, ({ plu, nombre }) => {
    if (items().some(it => it.plu === plu)) { avisar(`El PLU ${plu} ya está en la receta.`); return; }
    editarReceta(id, { items: [...items(), { plu, nombre, cantidad: null, unidad: 'kg', pendiente: true }] }, true);
    const cants = articuloReceta(id).querySelectorAll('.rc-cant');
    if (cants.length) cants[cants.length - 1].focus();
  });
}
function conectarReceta(id) {
  const art = articuloReceta(id);
  if (!art) return;
  const rend = art.querySelector('[data-campo=rendimientoKg]');
  if (rend) { // al confirmar el kg por tanda se escalan las cantidades (anterior = el de cuando entró el foco)
    let anterior = null;
    rend.addEventListener('focus', () => { anterior = prodEdRecetas[id].rendimientoKg; });
    rend.addEventListener('change', () => escalarPorRendimiento(id, Number(anterior), numOrNull(rend.value)));
  }
  const deshacer = art.querySelector('.rc-deshacer');
  if (deshacer) deshacer.onclick = () => deshacerAjuste(id);
  art.querySelector('.rc-formula').onclick = () => abrirImportarFormula(id); // precios_produccion_formula.js
  art.querySelectorAll('.rc-campo').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const campo = el.dataset.campo;
    const texto = ['nombre', 'categoriaMaquinaId', 'varianteDe'].includes(campo);
    editarReceta(id, { [campo]: texto ? el.value : numOrNull(el.value) });
  }));
  conectarItemsReceta(id, art);
  art.querySelectorAll('[data-orden]').forEach(b => b.onclick = () => {
    const k = claveOrdenReceta(id);
    prodOrdenRecetas = { ...prodOrdenRecetas, [k]: siguienteOrden(prodOrdenRecetas[k], b.dataset.orden) };
    repintarReceta(id);
    articuloReceta(id).querySelector(`[data-orden="${b.dataset.orden}"]`).focus();
  });
  art.querySelector('.rc-guardar').onclick = e => guardarReceta(id, e.currentTarget);
  const validar = art.querySelector('.rc-validar');
  if (validar) validar.onclick = () => {
    if (prodEdRecetas[id].sucio) { avisar('Guardá los cambios antes de validar.'); return; }
    validarProd({ tipo: 'receta', id }, validar);
  };
  art.querySelector('.rc-eliminar').onclick = () => eliminarReceta(id);
}
const urlReceta = id => urlProd(prodDet.id, '/recetas/' + encodeURIComponent(id));
// Chequeo previo (lo mismo que exige el server) para decirlo en criollo antes del PUT.
function faltaEnReceta(ed) {
  if (!ed.nombre || !ed.nombre.trim()) return 'Poné un nombre.';
  if (!ed.varianteDe && !(ed.rendimientoKg > 0)) return 'Completá "Kg por tanda": lo que rinde una tanda de máquina (ej. 104).';
  if (!ed.varianteDe && !ed.items.length) return 'Agregá al menos un ingrediente (buscalo en SIGA).';
  if (ed.items.some(it => !(it.cantidad > 0))) return 'Completá la cantidad de cada ingrediente (mayor a 0).';
  return '';
}
function guardarReceta(id, btn) {
  const ed = prodEdRecetas[id];
  const falta = faltaEnReceta(ed);
  if (falta) { avisar(falta); return; }
  guardarProd(async () => {
    // Base: el server escala los extras de sus variedades si cambió el kg por tanda (misma escritura).
    await pedirJson('PUT', urlReceta(id), ed.varianteDe ? bodyReceta(ed) : { ...bodyReceta(ed), escalarVariantes: true });
    prodEdRecetas = sinReceta(id); // se reconstruye con lo guardado al recargar
  }, btn, ed.varianteDe ? 'Variedad guardada' : 'Receta guardada');
}
async function nuevaRecetaBase() {
  const v = await pedirCampos('Nueva receta base', [
    { name: 'nombre', label: 'Nombre * (ej. Masa pepas, Granola clásica)', required: true },
    { name: 'rendimientoKg', label: 'Kg por tanda * — lo que rinde una tanda de máquina (ej. 104)', type: 'number', required: true },
  ], 'Continuar');
  if (!v) return;
  const id = idRecetaNueva(v.nombre, Object.keys(prodEdRecetas));
  prodEdRecetas = { ...prodEdRecetas, [id]: {
    nombre: v.nombre, varianteDe: null, rendimientoKg: numOrNull(v.rendimientoKg), mermaPct: null, minutosElaboracion: null,
    categoriaMaquinaId: '', items: [], sucio: true, nueva: true,
  } };
  pintarDetalleProduccion();
  document.getElementById('prBusca-' + id).focus();
}
// Nueva variedad: nombre + receta base. Se crea sin extras y se completan en su tarjeta.
async function crearVariedad() {
  const bases = basesGuardadas().map(([id, r]) => [id, r.nombre]);
  if (!bases.length) { avisar('Primero guardá una receta base (paso 1).'); return; }
  const v = await pedirCampos('Nueva variedad', [
    { name: 'nombre', label: 'Nombre * (ej. Pepas de membrillo, Granola con pasas)', required: true },
    { name: 'base', label: 'Receta base *', options: bases, value: bases[0][0] },
  ], 'Crear variedad');
  if (!v) return;
  const id = idRecetaNueva(v.nombre, Object.keys(prodEdRecetas));
  const ok = await guardarProd(() => pedirJson('PUT', urlReceta(id), { nombre: v.nombre, varianteDe: v.base, extras: [] }), null, 'Variedad creada: agregale los extras');
  if (ok) { const b = document.getElementById('prBusca-' + id); if (b) { b.scrollIntoView({ block: 'center' }); b.focus(); } }
}
async function eliminarReceta(id) {
  const ed = prodEdRecetas[id];
  if (ed.nueva) { prodEdRecetas = sinReceta(id); pintarDetalleProduccion(); return; }
  if (!(await confirmar(`¿Eliminar "${ed.nombre}"?`, { textoOk: 'Eliminar' }))) return;
  // El server rechaza si tiene variedades o la usa una presentación (el mensaje dice cuál).
  guardarProd(async () => { await pedirJson('DELETE', urlReceta(id)); prodEdRecetas = sinReceta(id); }, null, 'Eliminada');
}
