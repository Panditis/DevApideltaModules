// ── Precios · Producción: "Traer fórmula de SIGA" a una receta base o variedad (decisión 12) y
// "Nuevo desde fórmula SIGA" del listado (producto nuevo armado por el server con esa fórmula) ──
// Script clásico, cargado después de los otros precios_produccion*.js: usa sus globales (prodDet,
// prodEdRecetas, editarReceta, getJson, API_PROD, conectarBuscadorSiga, htmlBuscadorSiga,
// componentesAIngredientes, esEmpaque, fmtNum, btnCls/btnPrim/campoCls, REQ, ayuda, textoFuente,
// avisoExito) y los de precios.html (esc, fmtMoney, chip, numOrNull).
// Las cantidades de SIGA son por unidad del producto (por kg): cantidad en la receta = cant × kg por tanda.
// Los componentes que parecen empaque (envase/tapa/etiqueta/precinto) arrancan destildados: no se costean (fase 4).

// fmEd = { recetaId, plu, nombre, componentes, sel: { plu: true }, kg, pedirKg, modo, cargando, mensaje }
let fmEd = null;

function dialogoFormula() {
  let d = document.getElementById('dlgFormula');
  if (d) return d;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="dlgFormula" class="p-0 rounded-xl border border-borde shadow-fluent bg-card text-ink w-[min(96vw,760px)] max-w-none max-h-[90vh] backdrop:bg-ink/40" aria-labelledby="fmTitulo">
      <div class="flex flex-col max-h-[90vh]">
        <div class="px-5 pt-4 pb-3 flex items-start gap-3 border-b border-borde">
          <div class="min-w-0"><h3 id="fmTitulo" class="font-disp text-lg font-bold">Traer fórmula de SIGA</h3><div id="fmSub" class="text-xs text-gris mt-0.5"></div></div>
          <button type="button" id="fmX" class="ml-auto -mr-2 w-8 h-8 shrink-0 rounded-lg text-gris hover:bg-bg hover:text-ink" aria-label="Cerrar">✕</button>
        </div>
        <div id="fmCuerpo" class="flex-1 min-h-0 overflow-y-auto p-5 text-sm"></div>
        <div id="fmPie" class="px-5 py-3 border-t border-borde flex items-center gap-2 flex-wrap"></div>
      </div>
    </dialog>`);
  d = document.getElementById('dlgFormula');
  d.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); }); // no llega al handler de #mDet
  d.querySelector('#fmX').onclick = () => d.close();
  return d;
}

// Kg contra los que se multiplica: en la base, su kg por tanda; en una variedad, SIEMPRE los kg de su
// receta base (los extras son para una tanda de la base, aunque la variedad tenga rendimiento propio).
function kgDeReceta(ed) {
  const r = ed.varianteDe ? prodEdRecetas[ed.varianteDe] || {} : ed;
  return Number(r.rendimientoKg) > 0 ? Number(r.rendimientoKg) : null;
}
function abrirImportarFormula(recetaId) {
  const ed = prodEdRecetas[recetaId];
  const kg = kgDeReceta(ed);
  fmEd = { recetaId, plu: null, nombre: null, componentes: [], sel: {}, kg, pedirKg: !(kg > 0), modo: 'reemplazar', cargando: false, mensaje: '' };
  const d = dialogoFormula();
  document.getElementById('fmSub').textContent = `${ed.varianteDe ? 'Variedad' : 'Receta base'}: ${ed.nombre}`;
  pintarFormula();
  if (!d.open) d.showModal();
  document.getElementById('fmPlu').focus();
}

// ── Pintado ─────────────────────────────────────────────────────────────────────
const yaEnReceta = plu => prodEdRecetas[fmEd.recetaId].items.some(it => String(it.plu) === String(plu));
function htmlKgFormula() {
  const deBase = !!prodEdRecetas[fmEd.recetaId].varianteDe;
  if (!fmEd.pedirKg) return `<p class="text-xs text-gris mt-3">Cantidad = cantidad de SIGA × <b class="text-ink">${fmtNum(fmEd.kg)} kg ${deBase ? 'de la receta base' : 'por tanda'}</b>.</p>`;
  return `<label class="block text-xs text-gris mt-3">Kg por tanda ${REQ}
    <input id="fmKg" type="number" step="any" min="0" placeholder="ej. 104" value="${fmEd.kg ?? ''}" class="block mt-1 ${campoCls} w-28 text-right tabular-nums">
    ${ayuda('La receta todavía no lo tiene: lo que rinde una tanda de máquina. Se guarda en la receta.')}</label>`;
}
function filaFormula(c) {
  const on = !!fmEd.sel[c.plu];
  const res = fmEd.kg > 0 ? fmtNum(Math.round(c.cantPorUnidad * fmEd.kg * 1e4) / 1e4) : '—';
  const badges = (esEmpaque(c) ? ' ' + chip(esc(c.tipo), 'bg-amarillo/30 text-ink') : '') + (yaEnReceta(c.plu) ? ' ' + chip('ya está', 'bg-verde/10 text-verde') : '');
  return `<tr class="border-t border-borde${esEmpaque(c) ? ' text-ink/60' : ''}">
    <td class="p-1.5"><input type="checkbox" class="fm-chk accent-verde w-4 h-4" data-plu="${esc(c.plu)}" aria-label="Importar ${esc(c.nombre)}"${on ? ' checked' : ''}></td>
    <td class="p-1.5 tabular-nums">${esc(c.plu)}</td><td class="p-1.5">${esc(c.nombre)}${badges}</td>
    <td class="p-1.5 text-right tabular-nums">${fmtNum(c.cantPorUnidad)}</td>
    <td class="p-1.5 text-right tabular-nums font-semibold">${res}</td>
    <td class="p-1.5 text-right tabular-nums">${c.costo != null ? '$ ' + fmtMoney(c.costo) : '<span class="text-crit text-xs">sin costo</span>'}</td></tr>`;
}
function htmlTablaFormula() {
  if (fmEd.cargando) return '<p class="text-gris mt-4"><span class="spin"></span> Buscando la fórmula…</p>';
  if (fmEd.mensaje) return `<p class="text-gris mt-4">${esc(fmEd.mensaje)}</p>`;
  if (!fmEd.componentes.length) return '';
  const hayEmpaque = fmEd.componentes.some(esEmpaque);
  const repetidos = fmEd.componentes.filter(c => fmEd.sel[c.plu] && yaEnReceta(c.plu)).length;
  return `<div class="overflow-x-auto mt-4"><table class="w-full text-sm"><thead class="text-xs text-gris"><tr><th class="p-1.5"></th>
      <th class="p-1.5 text-left">PLU</th><th class="p-1.5 text-left">Componente</th><th class="p-1.5 text-right">Cant. SIGA</th>
      <th class="p-1.5 text-right">En la receta</th><th class="p-1.5 text-right">Costo</th></tr></thead>
    <tbody>${fmEd.componentes.map(filaFormula).join('')}</tbody></table></div>
    ${hayEmpaque ? ayuda('Los marcados como envase/etiqueta/precinto arrancan destildados: el empaque no se costea.') : ''}
    ${ayuda('Destildá lo que no va en esta receta (ej. los dulces de las Pepas, para importarlos después uno por variedad).')}
    ${repetidos ? `<div class="mt-3 rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs">
      <b class="text-warn">${repetidos} ${repetidos === 1 ? 'ya está' : 'ya están'} en la receta.</b> Su cantidad:
      <label class="ml-2"><input type="radio" name="fmModo" value="reemplazar" class="accent-verde"${fmEd.modo === 'reemplazar' ? ' checked' : ''}> reemplazar</label>
      <label class="ml-2"><input type="radio" name="fmModo" value="sumar" class="accent-verde"${fmEd.modo === 'sumar' ? ' checked' : ''}> sumar</label></div>` : ''}`;
}
function pintarFormula() {
  const elegido = fmEd.plu ? `<div class="mb-1"><b class="tabular-nums">PLU ${esc(fmEd.plu)}</b> · ${esc(fmEd.nombre || '')}</div>` : '';
  document.getElementById('fmCuerpo').innerHTML = `
    <p class="text-xs text-gris mb-3">Elegí el producto de SIGA cuya fórmula querés copiar. Las cantidades de SIGA son por unidad (por kg) del producto.</p>
    <div class="text-xs text-gris">Producto de SIGA ${REQ}</div>${elegido}${htmlBuscadorSiga('fmPlu', fmEd.plu ? 'Cambiar producto…' : 'Buscá el producto, ej. PEPAS o 8104')}
    ${htmlKgFormula()}<div id="fmTabla">${htmlTablaFormula()}</div>`;
  conectarBuscadorSiga('fmPlu', elegirProductoFormula);
  const kg = document.getElementById('fmKg');
  if (kg) kg.addEventListener('input', () => { fmEd = { ...fmEd, kg: numOrNull(kg.value) }; pintarTablaFormula(); });
  conectarTablaFormula();
  pintarPieFormula();
}
function pintarTablaFormula() { document.getElementById('fmTabla').innerHTML = htmlTablaFormula(); conectarTablaFormula(); pintarPieFormula(); }
function conectarTablaFormula() {
  document.querySelectorAll('#fmTabla .fm-chk').forEach(chk => chk.addEventListener('change', () => {
    fmEd = { ...fmEd, sel: { ...fmEd.sel, [chk.dataset.plu]: chk.checked } };
    pintarTablaFormula();
  }));
  document.querySelectorAll('#fmTabla input[name=fmModo]').forEach(r => r.addEventListener('change', () => { fmEd = { ...fmEd, modo: r.value }; }));
}
const seleccionFormula = () => fmEd.componentes.filter(c => fmEd.sel[c.plu]);
function pintarPieFormula() {
  const n = seleccionFormula().length;
  const bloqueo = !n ? 'Tildá al menos un componente.' : !(fmEd.kg > 0) ? 'Completá los kg por tanda.' : '';
  document.getElementById('fmPie').innerHTML = `<button type="button" id="fmCancelar" class="ml-auto ${btnCls}">Cancelar</button>
    <span title="${esc(bloqueo)}"><button type="button" id="fmAgregar" class="${btnPrim}"${bloqueo ? ' disabled' : ''}>Agregar ${n} ${n === 1 ? 'ingrediente' : 'ingredientes'}</button></span>`;
  document.getElementById('fmCancelar').onclick = () => document.getElementById('dlgFormula').close();
  document.getElementById('fmAgregar').onclick = agregarDesdeFormula;
}

// ── Acciones ────────────────────────────────────────────────────────────────────
async function elegirProductoFormula({ plu, nombre }) {
  fmEd = { ...fmEd, plu, nombre, componentes: [], sel: {}, cargando: true, mensaje: '' };
  pintarFormula();
  try {
    const f = await getJson(`${API_PROD}/formula-siga/${encodeURIComponent(plu)}`);
    if (!fmEd || fmEd.plu !== plu) return;
    const sel = Object.fromEntries(f.componentes.map(c => [c.plu, !esEmpaque(c)]));
    fmEd = { ...fmEd, nombre: f.nombre || nombre, componentes: f.componentes, sel, cargando: false, mensaje: f.mensaje || '' };
  } catch (e) {
    fmEd = { ...fmEd, cargando: false, mensaje: 'No se pudo traer la fórmula: ' + e.message };
  }
  pintarFormula();
}
function agregarDesdeFormula() {
  const ed = prodEdRecetas[fmEd.recetaId];
  const comps = seleccionFormula();
  const repetidos = comps.filter(c => yaEnReceta(c.plu)).length;
  const cambio = { items: componentesAIngredientes(comps, fmEd.kg, ed.items, fmEd.modo) };
  if (fmEd.pedirKg && !ed.varianteDe) cambio.rendimientoKg = fmEd.kg; // el kg pedido acá queda en la receta
  editarReceta(fmEd.recetaId, cambio, true);
  document.getElementById('dlgFormula').close();
  const extra = repetidos ? ` (${repetidos} con cantidad ${fmEd.modo === 'sumar' ? 'sumada' : 'reemplazada'})` : '';
  avisoExito(`${comps.length} ${comps.length === 1 ? 'ingrediente agregado' : 'ingredientes agregados'}${extra}: revisá y guardá la receta`);
}

// ── "Nuevo desde fórmula SIGA" (listado): producto nuevo con receta base + variedad ──
// POST productos/desde-siga { nombre, plu, rendimientoKg, presentaciones }: el server arma la receta base con los
// componentes no-empaque (cant × kg por tanda), la variedad sin extras y las presentaciones de
// SIGA que usan ese PLU en su fórmula (con su variedad por extras). Acá sólo la vista previa y qué presentaciones van.
// dsEd = { nombre, plu, nombreSiga, componentes, presentaciones, selPres: { plu: bool }, kg, cargando, mensaje, enviando }
let dsEd = null;

// Helpers puros (testeados en test/precios_produccion_ui.test.js).
// "Yogurt Natural DEPOSITO GRANEL" → "Yogurt Natural": nombre propuesto para el producto.
const nombreSinGranel = n => String(n || '').trim().replace(/\s+(DEPOSITO\s+)?GRANEL$/i, '').trim();
// Tildadas por defecto, salvo las que ya son presentación de otro producto (el server las omitiría igual).
const seleccionInicialPres = pres => Object.fromEntries((pres || []).map(p => [p.plu, !p.yaEn]));
const plusElegidosPres = (pres, sel) => (pres || []).filter(p => !p.yaEn && sel[p.plu]).map(p => p.plu);
function textoOmitidas(omitidas) {
  if (!omitidas || !omitidas.length) return '';
  const n = omitidas.length;
  return `No se agregaron ${n} ${n === 1 ? 'presentación' : 'presentaciones'}:\n`
    + omitidas.map(o => `• ${o.plu}${o.nombre ? ' ' + o.nombre : ''}: ${o.motivo}`).join('\n');
}

function dialogoDesdeSiga() {
  let d = document.getElementById('dlgDesdeSiga');
  if (d) return d;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="dlgDesdeSiga" class="p-0 rounded-xl border border-borde shadow-fluent bg-card text-ink w-[min(96vw,760px)] max-w-none max-h-[90vh] backdrop:bg-ink/40" aria-labelledby="dsTitulo">
      <div class="flex flex-col max-h-[90vh]">
        <div class="px-5 pt-4 pb-3 flex items-start gap-3 border-b border-borde">
          <div class="min-w-0"><h3 id="dsTitulo" class="font-disp text-lg font-bold">Nuevo producto desde fórmula SIGA</h3>
            <div class="text-xs text-gris mt-0.5">Copia la fórmula de un producto de SIGA: los ingredientes van a la receta base (el empaque no se costea) y se traen las presentaciones de SIGA que lo usan.</div></div>
          <button type="button" id="dsX" class="ml-auto -mr-2 w-8 h-8 shrink-0 rounded-lg text-gris hover:bg-bg hover:text-ink" aria-label="Cerrar">✕</button>
        </div>
        <div id="dsCuerpo" class="flex-1 min-h-0 overflow-y-auto p-5 text-sm"></div>
        <div id="dsPie" class="px-5 py-3 border-t border-borde flex items-center gap-2 flex-wrap"></div>
      </div>
    </dialog>`);
  d = document.getElementById('dlgDesdeSiga');
  d.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); }); // no llega al handler de #mDet
  d.querySelector('#dsX').onclick = () => d.close();
  // Delegados (la vista previa se re-pinta entera): checkbox de presentación y "Marcar todas".
  d.addEventListener('change', e => {
    const chk = e.target.closest('.ds-pres');
    if (!chk || !dsEd) return;
    dsEd = { ...dsEd, selPres: { ...dsEd.selPres, [chk.dataset.plu]: chk.checked } };
    pintarPreviaDesdeSiga();
  });
  d.addEventListener('click', e => {
    if (!e.target.closest('#dsMarcarTodas') || !dsEd) return;
    dsEd = { ...dsEd, selPres: seleccionInicialPres(dsEd.presentaciones) };
    pintarPreviaDesdeSiga();
  });
  return d;
}
function abrirNuevoDesdeSiga() {
  dsEd = { nombre: '', plu: null, nombreSiga: null, componentes: [], presentaciones: [], selPres: {}, kg: null, cargando: false, mensaje: '', enviando: false };
  const d = dialogoDesdeSiga();
  pintarDesdeSiga();
  if (!d.open) d.showModal();
  document.getElementById('dsNombre').focus();
}

// Nombre, buscador y kg se pintan de nuevo sólo al elegir PLU; al tipear se re-pinta la vista previa y el pie (no se pierde el foco).
function pintarDesdeSiga() {
  const elegido = dsEd.plu ? `<div class="mb-1"><b class="tabular-nums">PLU ${esc(dsEd.plu)}</b> · ${esc(dsEd.nombreSiga || '')}</div>` : '';
  document.getElementById('dsCuerpo').innerHTML = `
    <label class="block text-xs text-gris">Nombre del producto ${REQ}
      <input id="dsNombre" maxlength="60" value="${esc(dsEd.nombre)}" placeholder="ej. Granola, Pepas" class="block mt-1 ${campoCls} py-2 w-80 max-w-full"></label>
    <div class="text-xs text-gris mt-4">Producto de SIGA cuya fórmula se copia ${REQ}</div>${elegido}${htmlBuscadorSiga('dsPlu', dsEd.plu ? 'Cambiar producto…' : 'Buscá el producto, ej. GRANOLA o 6319')}
    <label class="block text-xs text-gris mt-4">Kg por tanda ${REQ}
      <input id="dsKg" type="number" step="any" min="0" placeholder="ej. 104" value="${dsEd.kg ?? ''}" class="block mt-1 ${campoCls} w-28 text-right tabular-nums">
      ${ayuda('Lo que rinde una tanda de máquina: las cantidades de SIGA (por kg) se multiplican por este valor.')}</label>
    <div id="dsPrevia">${htmlPreviaDesdeSiga()}</div>`;
  const nombre = document.getElementById('dsNombre');
  nombre.addEventListener('input', () => { dsEd = { ...dsEd, nombre: nombre.value }; pintarPieDesdeSiga(); });
  const kg = document.getElementById('dsKg');
  kg.addEventListener('input', () => { dsEd = { ...dsEd, kg: numOrNull(kg.value) }; pintarPreviaDesdeSiga(); });
  conectarBuscadorSiga('dsPlu', elegirProductoDesdeSiga);
  pintarPieDesdeSiga();
}
function htmlGrupoPrevia(titulo, comps, conTanda) {
  if (!comps.length) return '';
  const tanda = c => (dsEd.kg > 0 ? fmtNum(Math.round(c.cantPorUnidad * dsEd.kg * 1e4) / 1e4) : '—');
  return `<div class="mt-4"><div class="text-xs font-semibold text-ink mb-1">${titulo}</div>
    <table class="w-full text-sm"><thead class="text-xs text-gris"><tr><th class="p-1.5 text-left">PLU</th><th class="p-1.5 text-left">Componente</th>
      <th class="p-1.5 text-right">Cant. SIGA</th>${conTanda ? '<th class="p-1.5 text-right">Por tanda</th>' : ''}<th class="p-1.5 text-right">Costo</th></tr></thead>
    <tbody>${comps.map(c => `<tr class="border-t border-borde"><td class="p-1.5 tabular-nums">${esc(c.plu)}</td>
      <td class="p-1.5">${esc(c.nombre)}${esEmpaque(c) ? ' ' + chip(esc(c.tipo), 'bg-amarillo/30 text-ink') : ''}</td>
      <td class="p-1.5 text-right tabular-nums">${fmtNum(c.cantPorUnidad)}</td>${conTanda ? `<td class="p-1.5 text-right tabular-nums font-semibold">${tanda(c)}</td>` : ''}
      <td class="p-1.5 text-right tabular-nums">${c.costo != null ? '$ ' + fmtMoney(c.costo) : '<span class="text-crit text-xs">sin costo</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}
function htmlPreviaDesdeSiga() {
  if (dsEd.cargando) return '<p class="text-gris mt-4"><span class="spin"></span> Buscando la fórmula…</p>';
  if (dsEd.mensaje) return `<p class="text-gris mt-4">${esc(dsEd.mensaje)}</p>`;
  if (!dsEd.componentes.length) return '';
  return htmlGrupoPrevia('Va a la receta base (ingredientes de una tanda)', dsEd.componentes.filter(c => !esEmpaque(c)), true)
    + htmlGrupoPrevia('Empaque (no se costea: queda afuera)', dsEd.componentes.filter(esEmpaque), false)
    + htmlPresentacionesDesdeSiga();
}
function pintarPreviaDesdeSiga() { document.getElementById('dsPrevia').innerHTML = htmlPreviaDesdeSiga(); pintarPieDesdeSiga(); }
// Presentaciones de SIGA cuya fórmula usa el PLU elegido: cada una con su variedad (por extras) y su empaque.
function htmlPresentacionesDesdeSiga() {
  const pres = dsEd.presentaciones;
  const titulo = `<div class="text-xs font-semibold text-ink mb-1">Presentaciones detectadas (${pres.length})</div>`;
  if (!pres.length) {
    return `<div class="mt-4">${titulo}<p class="text-gris">Ninguna presentación de SIGA usa este PLU en su fórmula: vas a cargarlas a mano (paso 4).</p>
      ${ayuda('Elegí el producto a granel / intermedio (ej. …DEPOSITO GRANEL), no la presentación.')}</div>`;
  }
  const fila = p => {
    const on = !p.yaEn && !!dsEd.selPres[p.plu];
    const empaque = p.empaque.map(e => `${e.nombre} × ${fmtNum(e.cantidad)}`).join('\n');
    return `<tr class="border-t border-borde${p.yaEn ? ' text-ink/50' : ''}">
      <td class="p-1.5"><input type="checkbox" class="ds-pres accent-verde w-4 h-4" data-plu="${esc(p.plu)}" aria-label="Agregar ${esc(p.nombre)}"${on ? ' checked' : ''}${p.yaEn ? ' disabled' : ''}></td>
      <td class="p-1.5 tabular-nums">${esc(p.plu)}</td>
      <td class="p-1.5">${esc(p.nombre)}${p.yaEn ? ' ' + chip('ya es de ' + esc(p.yaEn), 'bg-amarillo/30 text-ink') : ''}</td>
      <td class="p-1.5 text-right tabular-nums">${esc(formatoPeso(p.kgPorUnidad) || fmtNum(p.kgPorUnidad))}</td>
      <td class="p-1.5">${p.variedad ? esc(p.variedad) : '<span class="text-gris">Sin extras (la del producto)</span>'}</td>
      <td class="p-1.5 text-right tabular-nums" title="${esc(empaque)}">${p.empaque.length} ${p.empaque.length === 1 ? 'ítem' : 'ítems'}</td></tr>`;
  };
  return `<div class="mt-4"><div class="flex items-center gap-2">${titulo}<button type="button" id="dsMarcarTodas" class="ml-auto ${btnCls}">Marcar todas</button></div>
    <table class="w-full text-sm"><thead class="text-xs text-gris"><tr><th class="p-1.5"></th><th class="p-1.5 text-left">PLU</th>
      <th class="p-1.5 text-left">Presentación</th><th class="p-1.5 text-right">Kg por unidad</th><th class="p-1.5 text-left">Variedad</th>
      <th class="p-1.5 text-right">Empaque</th></tr></thead>
    <tbody>${pres.map(fila).join('')}</tbody></table>
    ${ayuda('Kg por unidad = granel + extras (ej. mermelada). Las variedades se arman por los extras de cada presentación.')}</div>`;
}
// Qué falta para crear ('' = listo); el server valida lo mismo.
function faltaDesdeSiga() {
  if (!dsEd.nombre.trim()) return 'Poné el nombre del producto.';
  if (!dsEd.plu) return 'Elegí el producto de SIGA cuya fórmula se copia.';
  if (dsEd.cargando) return 'Esperá a que cargue la fórmula.';
  if (!dsEd.componentes.some(c => !esEmpaque(c))) return 'La fórmula de ese producto no tiene ingredientes para la receta.';
  if (!(dsEd.kg > 0)) return 'Completá los kg por tanda (mayor a 0).';
  return '';
}
function pintarPieDesdeSiga() {
  const bloqueo = faltaDesdeSiga();
  document.getElementById('dsPie').innerHTML = `<span class="text-xs text-gris">${esc(bloqueo)}</span>
    <button type="button" id="dsCancelar" class="ml-auto ${btnCls}">Cancelar</button>
    <button type="button" id="dsCrear" class="${btnPrim}"${bloqueo || dsEd.enviando ? ' disabled' : ''}>Crear producto</button>`;
  document.getElementById('dsCancelar').onclick = () => document.getElementById('dlgDesdeSiga').close();
  document.getElementById('dsCrear').onclick = crearDesdeSiga;
}
async function elegirProductoDesdeSiga({ plu, nombre }) {
  dsEd = { ...dsEd, plu, nombreSiga: nombre, componentes: [], presentaciones: [], selPres: {}, cargando: true, mensaje: '' };
  pintarDesdeSiga();
  try {
    const f = await getJson(`${API_PROD}/formula-siga/${encodeURIComponent(plu)}`);
    if (!dsEd || dsEd.plu !== plu) return;
    const nombreSiga = f.nombre || nombre;
    const presentaciones = f.presentaciones || [];
    // Nombre vacío → se precarga con el del producto de SIGA, sin el "DEPOSITO GRANEL".
    dsEd = { ...dsEd, nombreSiga, nombre: dsEd.nombre.trim() ? dsEd.nombre : nombreSinGranel(nombreSiga), componentes: f.componentes || [],
      presentaciones, selPres: seleccionInicialPres(presentaciones), cargando: false, mensaje: f.mensaje || '' };
  } catch (e) {
    dsEd = { ...dsEd, cargando: false, mensaje: 'No se pudo traer la fórmula: ' + e.message };
  }
  pintarDesdeSiga();
}
async function crearDesdeSiga() {
  if (faltaDesdeSiga()) return;
  const nombre = dsEd.nombre.trim();
  dsEd = { ...dsEd, enviando: true };
  pintarPieDesdeSiga();
  try {
    const presentaciones = plusElegidosPres(dsEd.presentaciones, dsEd.selPres);
    const j = await pedirJson('POST', API_PROD + '/productos/desde-siga', { nombre, plu: dsEd.plu, rendimientoKg: dsEd.kg, presentaciones });
    document.getElementById('dlgDesdeSiga').close();
    irAProduccion(j.id);
    const n = (j.presentacionesCreadas || []).length;
    avisoExito(`Producto "${nombre}" creado con ${n} ${n === 1 ? 'presentación' : 'presentaciones'}`);
    if ((j.omitidas || []).length) avisar(textoOmitidas(j.omitidas));
  } catch (e) {
    avisar(e.message);
  } finally {
    dsEd = { ...dsEd, enviando: false };
    if (document.getElementById('dlgDesdeSiga').open) pintarPieDesdeSiga();
  }
}

if (typeof module === 'object' && module.exports) {
  module.exports = { nombreSinGranel, seleccionInicialPres, plusElegidosPres, textoOmitidas };
}
