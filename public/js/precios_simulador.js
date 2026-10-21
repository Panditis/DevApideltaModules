// ── Precios · Configuración › Simulador: costo de compra → los 5 precios por canal con la config guardada ──
// Script clásico. Navegador: global PreciosEsquema (/js/precios_esquema.js); Node (tests): require del lib. Es el mismo
// cálculo que listados, modal y export (lib/precios_esquema preciosCanales). Pack y bulto por unidad (unidades 1).
// Nada se guarda.
const PE_SIM = typeof module === 'object' && module.exports ? require('../../lib/precios_esquema') : PreciosEsquema;
const SIM_TIPOS = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const SIM_IVA_COMPRA_DEFAULT = 21;
const SIM_PESO_DEFAULT_G = 1000;
const SIM_UNIDADES = Object.freeze({ pack: 1, bulto: 1 });
const SIM_ERRORES = {
  costo: 'El costo tiene que ser mayor a 0.',
  margen: 'Faltan o son inválidas las tablas de margen (Márgenes).',
  gastos: 'Con el modo "sobre precio", los gastos variables del tipo llegan al 100 %.',
};

// Costo de compra (con o sin IVA) → costo neto → preciosCanales. { faltantes: [texto] } si no se puede calcular.
// distribuidor: Reventa con proveedor distribuidor (descuento al margen de Márgenes; el motor lo ignora en otros tipos).
function simularCanales(cfg, { costo, tipo = 'almacen', conIva = false, ivaCompraPct = SIM_IVA_COMPRA_DEFAULT, pesoG = SIM_PESO_DEFAULT_G, distribuidor = false } = {}) {
  const fracc = tipo === 'fraccionado';
  const faltantes = [];
  if (!(costo > 0)) faltantes.push('Cargá el costo de compra (mayor a 0).');
  if (conIva && !(ivaCompraPct >= 0 && ivaCompraPct <= 100)) faltantes.push('La alícuota de IVA de compra tiene que estar entre 0 y 100 %.');
  if (fracc && !(pesoG > 0)) faltantes.push('Cargá el peso de la presentación (g).');
  if (faltantes.length) return { faltantes };
  const costoNeto = conIva ? PE_SIM.r2(costo / (1 + ivaCompraPct / 100)) : costo;
  const r = PE_SIM.preciosCanales({ tipo, costo: costoNeto, pesoG: fracc ? pesoG : null, unidades: SIM_UNIDADES, cfg, distribuidor });
  if (r.error) return { faltantes: [SIM_ERRORES[r.error] || r.error] };
  return { faltantes: [], tipo, fracc, costoCompra: costo, conIva, ivaCompraPct, ivaCompra: conIva ? PE_SIM.r2(costo - costoNeto) : 0, costoNeto, r };
}

if (typeof module === 'object' && module.exports) module.exports = { simularCanales, SIM_TIPOS };

// ── Sub-tab Simulador (DOM) ─────────────────────────────────────────────────────
let simCfg = null;
let simTipo = 'almacen';
const pctSim = n => `${String(+(+n).toFixed(2)).replace('.', ',')} %`;
const simPaso = (op, txt, v, fuerte = false) => `<div class="ec sec s-costo"><span class="ec-op" aria-hidden="true">${op}</span>
  <span class="${fuerte ? 'font-semibold' : ''}">${esc(txt)}</span><span class="ec-val${fuerte ? ' font-semibold' : ''}">${esc('$ ' + fmtMoney(v))}</span></div>`;

function htmlSimuladorForm() {
  const tipos = Object.entries(SIM_TIPOS).map(([t, n]) =>
    `<button type="button" class="seg-opt" data-tipo="${t}" aria-pressed="${t === simTipo}">${esc(n)}</button>`).join('');
  const link = (sub, txt) => `<button type="button" data-ir="${sub}" class="text-verde underline underline-offset-2 hover:text-verdeHover">${txt}</button>`;
  return `<p class="cfg-cab"><b>Simulador</b> — cargá un costo de compra y mirá los 5 precios (minorista, pack y bulto sin y con IVA) con la configuración guardada. Pack y bulto por unidad. No guarda nada.</p>
  <div class="grid gap-5 items-start" style="grid-template-columns:360px minmax(0,1fr)">
    <div class="cfg-card">
      <h3 class="cfg-h">Producto de prueba</h3>
      <label for="simCosto" class="block text-sm font-semibold mb-1" id="simCostoLbl">Costo de compra ($)</label>
      ${campoU(`<input id="simCosto" type="number" min="0" step="any" inputmode="decimal" placeholder="0,00" class="text-lg font-semibold">`, '$', { pre: true, w: 'w-full' })}
      <div class="text-sm font-semibold mt-4 mb-1" id="simTipoLbl">Tipo</div>
      <div id="simTipo" class="seg seg-sub" role="group" aria-labelledby="simTipoLbl">${tipos}</div>
      <label id="simDistribFila" class="flex items-center gap-2 text-sm mt-4 cursor-pointer"><input id="simDistrib" type="checkbox" class="accent-verde"> Distribuidor
        <span class="cfg-nota">descuento al margen de Márgenes</span></label>
      <label class="flex items-center gap-2 text-sm mt-4 cursor-pointer"><input id="simConIva" type="checkbox" class="accent-verde"> El costo incluye IVA</label>
      <div class="flex items-center justify-between gap-2 text-sm text-gris mt-2 ml-6"><label for="simIvaCompra">Alícuota de compra</label>
        ${campoU(`<input id="simIvaCompra" type="number" min="0" max="100" step="any" value="${SIM_IVA_COMPRA_DEFAULT}" disabled>`, '%', { w: 'w-24' })}</div>
      <div id="simPesoFila" class="hidden mt-4">
        <div class="flex items-center justify-between gap-2 text-sm"><label for="simPeso" class="font-semibold">Peso de la presentación</label>
          ${campoU(`<input id="simPeso" type="number" min="1" step="any" value="${SIM_PESO_DEFAULT_G}">`, 'g', { w: 'w-28' })}</div>
        <span class="cfg-nota mt-1">El costo es $/kg del granel; el peso elige el ajuste por peso. Los precios son por kg.</span>
      </div>
    </div>
    <div class="cfg-card text-sm min-w-0">
      <h3 class="cfg-h mb-2">Resultado</h3>
      <div id="simResultado" aria-live="polite"></div>
      <div class="text-xs text-gris mt-4 pt-3 border-t border-borde">Ver parámetros: ${link('costos', 'Costos')} · ${link('margenes', 'Márgenes')} · ${link('precio', 'Precio')}</div>
    </div>
  </div>`;
}

const dtoSim = c => (c.descuentoDistribuidorPct ? ` (con descuento distribuidor −${pctSim(c.descuentoDistribuidorPct)})` : '');
function htmlCanalesSim(s) {
  const r = s.r, m = r.minorista, kg = s.fracc ? ' /kg' : '';
  const minorista = `<div class="cfg-card min-w-0"><h4 class="font-semibold text-sm mb-1">Minorista${kg}</h4>
    ${simPaso('', 'Costo con gastos', r.costoConGastos)}
    ${simPaso('×', `Margen ${pctSim(m.margenPct)}${dtoSim(m)}`, m.neto)}
    ${simPaso('×', `Extras minoristas ${pctSim(m.extrasPct)}`, m.conExtras)}
    ${simPaso('×', `IVA ${pctSim(m.ivaPct)}`, m.exacto)}
    ${simPaso('=', 'Precio redondeado', m.precio, true)}</div>`;
  const mayorista = (titulo, c) => `<div class="cfg-card min-w-0"><h4 class="font-semibold text-sm mb-1">${titulo} (por unidad${kg})</h4>
    ${simPaso('', 'Costo con gastos', r.costoConGastos)}
    ${simPaso('×', `Margen ${pctSim(c.margenPct)}${dtoSim(c)}`, c.netoUnidad)}
    ${simPaso('=', 'Sin IVA redondeado', c.neto, true)}
    ${simPaso('×', 'IVA', c.exactoIva)}
    ${simPaso('=', 'Con IVA redondeado', c.conIva, true)}</div>`;
  return `<div class="grid grid-cols-3 gap-3">${minorista}${mayorista('Mayorista pack', r.pack)}${mayorista('Mayorista bulto', r.bulto)}</div>`;
}

function htmlResultadoSim(s) {
  if (s.faltantes.length) return `<div class="text-crit">${s.faltantes.map(f => `<p>${esc(f)}</p>`).join('')}</div>`;
  const kg = s.fracc ? ' /kg' : '';
  return `${s.conIva ? simPaso('', 'Costo de compra con IVA', s.costoCompra) + simPaso('−', `IVA de compra ${pctSim(s.ivaCompraPct)}`, s.ivaCompra) : ''}
    ${simPaso(s.conIva ? '=' : '', `Costo neto${kg}`, s.costoNeto, true)}
    ${simPaso('+', `Gastos variables ${pctSim(s.r.gastosPct)}`, PE_SIM.r2(s.r.costoConGastos - s.r.costo))}
    <div class="mt-4">${htmlCanalesSim(s)}</div>`;
}

function entradaSim() {
  const val = id => numOrNull(document.getElementById(id).value);
  return { costo: val('simCosto'), tipo: simTipo, conIva: document.getElementById('simConIva').checked, ivaCompraPct: val('simIvaCompra'), pesoG: val('simPeso'),
    distribuidor: document.getElementById('simDistrib').checked };
}
function recalcularSim() {
  if (simCfg) document.getElementById('simResultado').innerHTML = htmlResultadoSim(simularCanales(simCfg, entradaSim()));
}
function elegirTipoSim(t) {
  simTipo = t;
  document.querySelectorAll('#simTipo .seg-opt').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.tipo === t)));
  document.getElementById('simPesoFila').classList.toggle('hidden', t !== 'fraccionado');
  document.getElementById('simDistribFila').classList.toggle('hidden', t !== 'almacen'); // sólo Reventa
  document.getElementById('simCostoLbl').textContent = t === 'fraccionado' ? 'Costo de compra ($/kg)' : 'Costo de compra ($)';
  recalcularSim();
}
// Tipos según el switch de Configuración (tipoCfgEsq, precios_config_esquema.js): en Fraccionado sólo Fraccionado; en
// Reventa, Reventa y Producción (las dos usan la configuración de Reventa).
function ajustarTiposSim() {
  const fracc = tipoCfgEsq === 'fraccionado';
  document.querySelectorAll('#simTipo .seg-opt').forEach(x => x.classList.toggle('hidden', (x.dataset.tipo === 'fraccionado') !== fracc));
  if (fracc !== (simTipo === 'fraccionado')) elegirTipoSim(fracc ? 'fraccionado' : 'almacen');
}
function conectarSimulador() {
  const panel = document.getElementById('panel-simulador');
  panel.addEventListener('input', e => { if (['simCosto', 'simIvaCompra', 'simPeso'].includes(e.target.id)) recalcularSim(); });
  document.getElementById('simConIva').addEventListener('change', e => { document.getElementById('simIvaCompra').disabled = !e.target.checked; recalcularSim(); });
  document.getElementById('simDistrib').addEventListener('change', recalcularSim);
  document.querySelectorAll('#simTipo .seg-opt').forEach(b => b.addEventListener('click', () => elegirTipoSim(b.dataset.tipo)));
  panel.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', irASubConfig)); // precios_config.js
}
// La llama activarSubConfig (precios_config.js). El formulario se arma una vez; la config (del tipo del switch) se relee
// en cada entrada.
async function cargarSimulador() {
  const panel = document.getElementById('panel-simulador');
  if (!document.getElementById('simCosto')) { panel.innerHTML = htmlSimuladorForm(); conectarSimulador(); }
  simCfg = null; // hasta leer la del tipo actual, ajustarTiposSim no recalcula con la del otro
  ajustarTiposSim();
  const el = document.getElementById('simResultado');
  el.innerHTML = '<span class="spin"></span> Cargando configuración…';
  document.getElementById('simCosto').focus();
  try { simCfg = await leerCfgEsq(); recalcularSim(); } // precios_config_esquema.js
  catch (e) { simCfg = null; el.innerHTML = `<p class="text-crit">No se pudo cargar la configuración: ${esc(e.message)}</p>`; }
}
