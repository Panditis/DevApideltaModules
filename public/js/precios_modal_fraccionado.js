// ── Precios · modal de Fraccionado: costo real por presentación, facilidad/máquina del granel e insumos propios ──
// (spec 2026-10-21-precios-fraccionado-costeo-design §5). Script clásico después de precios_modal_esquema.js y
// precios_config_fraccionado.js. Va dentro de "Ver detalle" (sólo con precios-config): htmlVerDetalle llama a
// htmlCosteoFraccMd y conectarModalEsquema a conectarCosteoFraccMd. Globales: esc, fmtMoney, numOrNull (precios_comun.js),
// mdEsq, mdFuente, pintarModalEsquema, guardarCostoEsq, htmlPasos (precios_modal_esquema.js), API_FR
// (precios_config_fraccionado.js), getJson, htmlBuscadorSiga, conectarBuscadorSiga (precios_produccion.js).
const ESC_FR_MD = typeof module === 'object' && module.exports ? require('./precios_comun.js').esc : esc;
const FACIL_MD = { facil: 'Fácil', medio: 'Medio', dificil: 'Difícil' };

// ── Puros (test/precios_modal_fraccionado.test.js) ──
// componentesCosto de una presentación (lib/precios_fraccionado_costo) por concepto. fuente = la elegida en el modal;
// mercaderiaKg = $/kg del granel con esa fuente (con sus costos extra); costoKg = el de la presentación con esa fuente; los
// dos también por unidad (× kg de la presentación; null sin costo o sin peso).
function resumenCosteoFraccMd(p, fuente, costosGranel) {
  const lineas = p.componentesCosto || [];
  const porUnidad = kgCosto => (kgCosto == null || !(p.pesoG > 0) ? null : Math.round(kgCosto * (p.pesoG / 1000) * 100) / 100);
  const insumos = lineas.filter(l => l.rol === 'insumo');
  const c = p.costeoPresentacion || {};
  return {
    insumos,
    subtotalInsumos: insumos.some(l => l.importe == null) ? null : Math.round(insumos.reduce((s, l) => s + l.importe, 0) * 100) / 100,
    mo: lineas.find(l => l.rol === 'mo') || null, maquina: lineas.find(l => l.rol === 'maquina') || null,
    porUnidad: c.porUnidad ?? null, extraKg: c.extraKg ?? null,
    mercaderiaKg: (costosGranel || {})[fuente] ?? null, costoKg: (p.costos || {})[fuente] ?? null,
    mercaderiaUnidad: porUnidad((costosGranel || {})[fuente]), costoUnidad: porUnidad((p.costos || {})[fuente]),
  };
}
// Elegidos del buscador al borrador de insumos propios: cantidad 1, sin repetir.
const conInsumosMd = (lista, elegidos) => [...lista,
  ...elegidos.filter(e => !lista.some(x => x.plu === String(e.plu))).map(e => ({ plu: String(e.plu), nombre: e.nombre, cantidad: 1 }))];
const opcionesMaquinaMd = (maquinas, actual) => `<option value="">Sin máquina</option>${(maquinas || [])
  .map(m => `<option value="${ESC_FR_MD(m.id)}"${m.id === actual ? ' selected' : ''}>${ESC_FR_MD(m.nombre)}</option>`).join('')}`;

const minMd = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n);
// "minutos = base del tramo × factor de la facilidad": c = costeoPresentacion, minutos = los de la línea (MO o máquina).
const formulaMinutosMd = (c, minutos) => (c.minutosBase == null ? `${minMd(minutos)} min` : `${minMd(c.minutosBase)} × ${minMd(c.factor ?? 1)} = ${minMd(minutos)} min`);
// Línea de MO o máquina que no tiene importe: sin tiempos cargados (o minutos 0) → "sin minutos"; con minutos y sin máquina → "sin asignar".
const SIN_MINUTOS_MD = 'sin minutos (cargá los tiempos en Configuración › Costeo Fraccionado)';
const textoSinTiempoMd = (rol, avisos) => (rol === 'maquina'
  ? `Máquina — ${(avisos || []).includes('sinMaquina') && !(avisos || []).includes('sinTiempos') ? 'sin asignar' : SIN_MINUTOS_MD}`
  : `Mano de obra — ${SIN_MINUTOS_MD}`);

if (typeof module === 'object' && module.exports) module.exports = { resumenCosteoFraccMd, conInsumosMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd };

// ── DOM ──
let mdFrEdit = null;     // { plu, insumos: [{ plu, nombre, cantidad }] }: la presentación con el editor de insumos propios abierto
let mdFrMaquinas = null; // máquinas de Configuración › Costeo Fraccionado (se piden cada vez que se conecta el modal: una máquina nueva aparece)

// La llama cerrarDetalle (precios_comun.js): un borrador sin guardar no sobrevive a cerrar el modal.
function descartarBorradorFraccMd() { mdFrEdit = null; }

const textoMinutosMd = (l, falta, c) => `${formulaMinutosMd(c, l.cantidad)} × ${l.costoUnit == null ? `sin costo hora (${falta})` : `$ ${fmtMoney(l.costoUnit)}/h`}`;

function htmlCosteoFraccMd(f) {
  if (!f.costeoGranel) return ''; // sin migrar o "sin granel"
  // ponytail: el borrador de otro granel (modal reabierto en otro producto) se descarta al pintar
  if (mdFrEdit && !(f.presentaciones || []).some(p => p.plu === mdFrEdit.plu)) mdFrEdit = null;
  const g = f.costeoGranel;
  const maquinas = mdFrMaquinas || (g.maquinaId ? [{ id: g.maquinaId, nombre: g.maquina || g.maquinaId }] : []);
  return `<div class="md-edicion" id="mdFr">
    <div class="lbl mb-1">Costeo del granel · ${g.subrubro ? `subrubro ${esc(g.subrubro)}` : 'sin subrubro en SIGA'}</div>
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-sm">Facilidad <select id="mdFrFacilidad" class="num-in"><option value="">Sin asignar (× 1)</option>
        ${Object.entries(FACIL_MD).map(([k, t]) => `<option value="${k}"${g.facilidad === k ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="text-sm">Máquina <select id="mdFrMaquina" class="num-in">${opcionesMaquinaMd(maquinas, g.maquinaId)}</select></label>
      <button type="button" id="mdFrGuardar" class="cfg-btn2">Guardar</button></div>
    <p id="mdFrMsg" class="text-sm mt-1" role="status" aria-live="polite"></p>
    ${(f.presentaciones || []).map(p => htmlPresFraccMd(p, f)).join('')}</div>`;
}

function htmlPresFraccMd(p, f) {
  if ((p.avisosCosto || []).includes('sinPeso')) return htmlPasos(p.nombre, [['', 'Sin peso en el nombre: sólo mercadería', null], ['=', 'Costo $/kg', (p.costos || {})[mdFuente]]]);
  const r = resumenCosteoFraccMd(p, mdFuente, f.costos);
  const linea = l => ['', `· ${l.nombre || l.plu} ${minMd(l.cantidad)} × ${l.costoUnit == null ? 'sin costo' : `$ ${fmtMoney(l.costoUnit)}`}`, l.importe];
  const c = p.costeoPresentacion || {}, avisos = p.avisosCosto || [], kg = minMd(p.pesoG / 1000);
  const origen = c.origenInsumos === 'propios' ? 'propios' : 'regla del subrubro';
  return htmlPasos(p.nombre, [
    ['', `Mercadería · ${kg} kg × ${r.mercaderiaKg == null ? 'sin costo' : `$ ${fmtMoney(r.mercaderiaKg)}/kg`}`, r.mercaderiaUnidad],
    ['+', r.insumos.length ? `Insumos (${origen})` : 'Insumos — sin cargar', r.subtotalInsumos], ...r.insumos.map(linea),
    ['+', r.mo ? `Mano de obra · ${textoMinutosMd(r.mo, 'cargalo en Costos con el switch en Fraccionado', c)}` : textoSinTiempoMd('mo', avisos), r.mo ? r.mo.importe : 0],
    ['+', r.maquina ? `Máquina ${r.maquina.nombre} · ${textoMinutosMd(r.maquina, 'cargalo en la máquina', c)}` : textoSinTiempoMd('maquina', avisos), r.maquina ? r.maquina.importe : 0],
    ['=', r.porUnidad == null ? 'Costo real por unidad — falta el costo de un insumo' : 'Costo real por unidad', r.costoUnidad],
    ['÷', `${kg} kg de la presentación`, null], ['=', 'Costo real $/kg', r.costoKg],
  ]) + htmlInsumosPropiosMd(p);
}

function htmlInsumosPropiosMd(p) {
  if (!mdFrEdit || mdFrEdit.plu !== p.plu) {
    const propios = (p.costeoPresentacion || {}).origenInsumos === 'propios';
    return `<div class="flex gap-2 -mt-1 mb-3"><button type="button" class="md-fr-propios cfg-btn2" data-plu="${esc(p.plu)}">${propios ? 'Editar insumos propios' : 'Usar insumos propios'}</button>
      ${propios ? `<button type="button" class="md-fr-regla text-sm text-gris hover:text-crit" data-plu="${esc(p.plu)}">Volver a la regla</button>` : ''}</div>`;
  }
  const filas = mdFrEdit.insumos.map(x => `<tr data-plu="${esc(x.plu)}"><td class="py-1 pr-2">${esc(x.nombre || x.plu)} <span class="text-gris text-xs">${esc(x.plu)}</span></td>
      <td class="py-1 pr-2"><input type="number" min="0" step="any" class="num-in w-20" data-k="cantidad" value="${esc(x.cantidad ?? '')}" aria-label="Cantidad por unidad"></td>
      <td class="py-1"><button type="button" class="md-fr-quitar text-gris hover:text-crit" aria-label="Quitar">✕</button></td></tr>`).join('');
  return `<div class="mb-3 p-2 border border-borde rounded-lg"><div class="lbl mb-1">Insumos propios de ${esc(p.nombre)} (reemplazan a la regla)</div>
    <table class="w-full text-sm"><tbody id="mdFrIns">${filas || '<tr><td class="text-gris py-1">Sin insumos: agregalos con el buscador (guardar vacío vuelve a la regla).</td></tr>'}</tbody></table>
    <div class="mt-1">${htmlBuscadorSiga('mdFrBus', 'Agregar insumos (nombre o PLU)')}</div>
    <div class="flex gap-2 mt-2"><button type="button" class="md-fr-guardar-ins cfg-btn2">Guardar insumos</button>
      <button type="button" class="md-fr-cancelar text-sm text-gris">Cancelar</button></div></div>`;
}

function conectarCosteoFraccMd() {
  const caja = document.getElementById('mdFr');
  if (!caja) return;
  const granel = encodeURIComponent(mdEsq.fila.plu);
  getJson(API_FR).then(cfg => {
    mdFrMaquinas = cfg.maquinas.map(({ id, nombre }) => ({ id, nombre }));
    const sel = document.getElementById('mdFrMaquina');
    if (sel) sel.innerHTML = opcionesMaquinaMd(mdFrMaquinas, mdEsq.fila.costeoGranel.maquinaId);
  }).catch(e => { const m = document.getElementById('mdFrMsg'); if (m) { m.className = 'text-sm mt-1 text-crit'; m.textContent = `No se pudieron leer las máquinas: ${e.message}`; } });
  document.getElementById('mdFrGuardar').onclick = () => guardarCostoEsq(`${API_FR}/granel/${granel}`,
    { facilidad: document.getElementById('mdFrFacilidad').value || null, maquinaId: document.getElementById('mdFrMaquina').value || null }, 'PUT', 'mdFrMsg');
  // Lo tipeado en las cantidades al borrador (antes de repintar o guardar).
  const cantidades = () => {
    if (!mdFrEdit) return;
    mdFrEdit = { ...mdFrEdit, insumos: mdFrEdit.insumos.map(x => ({ ...x,
      cantidad: numOrNull(caja.querySelector(`#mdFrIns tr[data-plu="${CSS.escape(x.plu)}"] [data-k="cantidad"]`).value) })) };
  };
  const guardarInsumos = (pres, insumos) => guardarCostoEsq(`${API_FR}/insumos-presentacion/${encodeURIComponent(pres)}`,
    { insumos: insumos.map(({ plu, cantidad }) => ({ plu, cantidad })) }, 'PUT', 'mdFrMsg');
  caja.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.classList.contains('md-fr-propios')) {
      const p = mdEsq.fila.presentaciones.find(x => x.plu === b.dataset.plu);
      mdFrEdit = { plu: p.plu, insumos: (p.componentesCosto || []).filter(l => l.rol === 'insumo').map(l => ({ plu: l.plu, nombre: l.nombre, cantidad: l.cantidad })) };
      pintarModalEsquema();
    } else if (b.classList.contains('md-fr-regla')) {
      cantidades(); // si hay otro borrador abierto sobrevive al repintado
      guardarInsumos(b.dataset.plu, []);
    } else if (b.classList.contains('md-fr-quitar')) {
      cantidades();
      mdFrEdit = { ...mdFrEdit, insumos: mdFrEdit.insumos.filter(x => x.plu !== b.closest('tr').dataset.plu) };
      pintarModalEsquema();
    } else if (b.classList.contains('md-fr-cancelar')) {
      mdFrEdit = null;
      pintarModalEsquema();
    } else if (b.classList.contains('md-fr-guardar-ins')) {
      cantidades();
      const editado = mdFrEdit;
      mdFrEdit = null; // al guardar bien el modal se recarga sin editor; si falla vuelve (el editor sigue en pantalla)
      if (!(await guardarInsumos(editado.plu, editado.insumos))) mdFrEdit = editado;
    }
  };
  if (mdFrEdit) {
    conectarBuscadorSiga('mdFrBus', elegidos => { cantidades(); mdFrEdit = { ...mdFrEdit, insumos: conInsumosMd(mdFrEdit.insumos, elegidos) }; pintarModalEsquema(); },
      { multiple: true, deshabilitado: plu => (mdFrEdit?.insumos.some(x => x.plu === String(plu)) ? 'ya está' : null) });
  }
}
