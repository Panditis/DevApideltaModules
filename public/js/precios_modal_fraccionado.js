// ── Precios · modal de Fraccionado: costo real por presentación y máquina del granel (spec 2026-10-21-precios-fraccionado-costeo-design §9.3) ──
// Script clásico después de precios_modal_esquema.js y precios_config_fraccionado.js. Va dentro de "Ver detalle" (sólo con
// precios-config): htmlVerDetalle llama a htmlCosteoFraccMd y conectarModalEsquema a conectarCosteoFraccMd. La facilidad y
// el tiempo son los del subrubro del granel y los insumos los del peso de la presentación (Configuración › Costeo Fraccionado,
// precios_config_fraccionado.js): acá se ven. Globales: esc, fmtMoney (precios_comun.js), mdEsq, mdFuente, guardarCostoEsq,
// htmlPasos (precios_modal_esquema.js), API_FR (precios_config_fraccionado.js), getJson (precios_produccion.js).
const ESC_FR_MD = typeof module === 'object' && module.exports ? require('./precios_comun.js').esc : esc;
const FACIL_MD = { facil: 'Fácil', normal: 'Normal', dificil: 'Difícil' };
const TIEMPO_MD = { rapido: 'Rápido', normal: 'Normal', lento: 'Lento' };

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
// Select de la máquina del granel: "" = la de su subrubro (se muestra cuál); cada máquina = excepción del granel.
const opcionesMaquinaMd = (maquinas, actual, delSubrubro) => `<option value="">Del subrubro (${ESC_FR_MD(delSubrubro || 'sin máquina')})</option>${(maquinas || [])
  .map(m => `<option value="${ESC_FR_MD(m.id)}"${m.id === actual ? ' selected' : ''}>${ESC_FR_MD(m.nombre)}</option>`).join('')}`;
const minMd = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(n);
// "base del tramo × factor del tiempo × factor de la facilidad = minutos" (c = costeoPresentacion); sin base (dato viejo) sólo los minutos.
const formulaMinutosMd = (c, minutos) => (c.minutosBase == null ? `${minMd(minutos)} min`
  : `${minMd(c.minutosBase)} × ${minMd(c.factorTiempo ?? 1)} (tiempo) × ${minMd(c.factorFacilidad ?? 1)} (facilidad) = ${minMd(minutos)} min`);
// Línea de MO o máquina sin importe: sin minutos (granel sin subrubro o subrubro sin tramos) o, con minutos, sin máquina.
const SIN_MINUTOS_MD = 'sin minutos (cargá los tiempos por peso del subrubro en Configuración › Costeo Fraccionado)';
function textoSinTiempoMd(rol, avisos) {
  const a = avisos || [];
  if (rol === 'maquina' && a.includes('sinMaquina') && !a.includes('sinSubrubro') && !a.includes('sinTramos')) return 'Máquina — sin asignar (ni del subrubro ni del granel)';
  return `${rol === 'maquina' ? 'Máquina' : 'Mano de obra'} — ${a.includes('sinSubrubro') ? 'sin minutos: el granel no tiene subrubro en SIGA' : SIN_MINUTOS_MD}`;
}
// "Normal · Lento": facilidad y tiempo del subrubro con que se costeó la presentación (c = costeoPresentacion).
const textoElegidoMd = c => `${FACIL_MD[(c || {}).facilidad] || 'sin facilidad'} · ${TIEMPO_MD[(c || {}).tiempo] || 'sin tiempo'}`;

if (typeof module === 'object' && module.exports) module.exports = { resumenCosteoFraccMd, opcionesMaquinaMd, formulaMinutosMd, textoSinTiempoMd, textoElegidoMd };

// ── DOM ──
let mdFrMaquinas = null; // máquinas de Configuración › Costeo Fraccionado (se piden cada vez que se conecta el modal: una máquina nueva aparece)

const textoMinutosMd = (l, falta, c) => `${formulaMinutosMd(c, l.cantidad)} × ${l.costoUnit == null ? `sin costo hora (${falta})` : `$ ${fmtMoney(l.costoUnit)}/h`}`;

function htmlCosteoFraccMd(f) {
  if (!f.costeoGranel) return ''; // sin migrar o "sin granel"
  const g = f.costeoGranel;
  const maquinas = mdFrMaquinas || (g.maquinaId ? [{ id: g.maquinaId, nombre: g.maquina || g.maquinaId }] : []);
  return `<div class="md-edicion" id="mdFr">
    <div class="lbl mb-1">Costeo del granel · ${g.subrubro ? `subrubro ${esc(g.subrubro)}` : 'sin subrubro en SIGA'}</div>
    <div class="flex flex-wrap items-center gap-2">
      <label class="text-sm">Máquina <select id="mdFrMaquina" class="num-in"${g.subrubro ? '' : ' disabled'}>${opcionesMaquinaMd(maquinas, g.maquinaId, g.maquinaSubrubro)}</select></label>
      ${g.subrubro ? '' : `<span class="text-xs text-gris">${esc('sin subrubro: no suma minutos')}</span>`}
      <button type="button" id="mdFrGuardar" class="cfg-btn2">Guardar</button></div>
    <p class="text-xs text-gris mt-1">Máquina, tiempos por peso, facilidad y tiempo del subrubro, e insumos por peso: Configuración › Costeo Fraccionado.</p>
    <p id="mdFrMsg" class="text-sm mt-1" role="status" aria-live="polite"></p>
    ${(f.presentaciones || []).map(p => htmlPresFraccMd(p, f)).join('')}</div>`;
}

function htmlPresFraccMd(p, f) {
  const titulo = `${p.nombre} · ${textoElegidoMd(p.costeoPresentacion)}`;
  if ((p.avisosCosto || []).includes('sinPeso')) return htmlPasos(titulo, [['', 'Sin peso en el nombre: sólo mercadería', null], ['=', 'Costo $/kg', (p.costos || {})[mdFuente]]]);
  const r = resumenCosteoFraccMd(p, mdFuente, f.costos);
  const linea = l => ['', `· ${l.nombre || l.plu} ${minMd(l.cantidad)} × ${l.costoUnit == null ? 'sin costo' : `$ ${fmtMoney(l.costoUnit)}`}`, l.importe];
  const c = p.costeoPresentacion || {}, avisos = p.avisosCosto || [], kg = minMd(p.pesoG / 1000);
  return htmlPasos(titulo, [
    ['', `Mercadería · ${kg} kg × ${r.mercaderiaKg == null ? 'sin costo' : `$ ${fmtMoney(r.mercaderiaKg)}/kg`}`, r.mercaderiaUnidad],
    ['+', r.insumos.length ? 'Insumos' : 'Insumos — sin cargar (Configuración › Costeo Fraccionado › Insumos por peso)', r.subtotalInsumos], ...r.insumos.map(linea),
    ['+', r.mo ? `Mano de obra · ${textoMinutosMd(r.mo, 'cargalo en Costos con el switch en Fraccionado', c)}` : textoSinTiempoMd('mo', avisos), r.mo ? r.mo.importe : 0],
    ['+', r.maquina ? `Máquina ${r.maquina.nombre} · ${textoMinutosMd(r.maquina, 'cargalo en la máquina', c)}` : textoSinTiempoMd('maquina', avisos), r.maquina ? r.maquina.importe : 0],
    ['=', r.porUnidad == null ? 'Costo real por unidad — falta el costo de un insumo' : 'Costo real por unidad', r.costoUnidad],
    ['÷', `${kg} kg de la presentación`, null], ['=', 'Costo real $/kg', r.costoKg],
  ]);
}

function conectarCosteoFraccMd() {
  if (!document.getElementById('mdFr')) return;
  const g = mdEsq.fila.costeoGranel;
  getJson(API_FR).then(cfg => {
    mdFrMaquinas = cfg.maquinas.map(({ id, nombre }) => ({ id, nombre }));
    const sel = document.getElementById('mdFrMaquina');
    if (!sel) return;
    const v = sel.value;
    sel.innerHTML = opcionesMaquinaMd(mdFrMaquinas, g.maquinaId, g.maquinaSubrubro);
    if ([...sel.options].some(o => o.value === v)) sel.value = v;
  }).catch(e => { const m = document.getElementById('mdFrMsg'); if (m) { m.className = 'text-sm mt-1 text-crit'; m.textContent = `No se pudieron leer las máquinas: ${e.message}`; } });
  document.getElementById('mdFrGuardar').onclick = () => guardarCostoEsq(`${API_FR}/granel/${encodeURIComponent(mdEsq.fila.plu)}`,
    { maquinaId: document.getElementById('mdFrMaquina').value || null }, 'PUT', 'mdFrMsg');
}
