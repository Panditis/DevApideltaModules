// ── Precios · Configuración › Simulador: costo de compra → precio final al público, como un producto real ──
// Script clásico cargado al final de precios.html. Todo en el cliente con la config guardada (/api/precios/config,
// leerConfig de precios_config.js) y los espejos del costeo del server ya testeados por paridad: gananciaPorCurvaCliente,
// gastosTipoCli, markupDesdeGananciaCli, fmtPctGastos (precios_config_gastos.js); desgloseCli, gastosDesgloseCli,
// ivaVentaCli, conceptosCli, conceptosFinalCli, totalConceptosCli, gananciaFinalCli, r2Cli (precios_orden.js);
// htmlDesglose (precios_detalle.js).
// Nada se guarda. Paridad con lib/precios_costeo.js: test/precios_simulador.test.js.

// En Node (tests) los espejos vienen por require; en el navegador son globales de los otros scripts.
if (typeof module === 'object' && module.exports) {
  Object.assign(globalThis, require('./precios_orden.js'), require('./precios_config_gastos.js'));
}

// ── Helpers puros (sin DOM) ─────────────────────────────────────────────────────
const SIM_TIPOS = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const SIM_IVA_COMPRA_DEFAULT = 21;
const SIM_PESO_DEFAULT_G = 1000;

// Costo de compra → precio, con el mismo camino que el server: costo neto (÷ (1 + alícuota) si trae IVA, como
// costoSistemaNeto; Fraccionado sin MO ni insumos: son propios de cada presentación real) → curva del tipo sobre
// el costo neto base (Fraccionado con el ajuste por peso) + conceptos = ganancia → markup con los gastos del tipo →
// desgloseCli (precio neto, IVA de venta, conceptos sobre precio final, redondeo a $50). Devuelve { faltantes: [texto] }
// si no se puede calcular.
function simularPrecio(cfg, { costo, tipo = 'almacen', conIva = false, ivaCompraPct = SIM_IVA_COMPRA_DEFAULT, pesoG = SIM_PESO_DEFAULT_G } = {}) {
  const c = cfg || {};
  const nombre = SIM_TIPOS[tipo] || tipo;
  const fracc = tipo === 'fraccionado';
  const faltantes = [];
  if (!(costo > 0)) faltantes.push('Cargá el costo de compra (mayor a 0).');
  if (conIva && !(ivaCompraPct >= 0 && ivaCompraPct <= 100)) faltantes.push('La alícuota de IVA de compra tiene que estar entre 0 y 100 %.');
  if (fracc && !(pesoG > 0)) faltantes.push('Cargá el peso de la presentación (g).');
  if (faltantes.length) return { faltantes };

  const costoNeto = conIva ? r2Cli(costo / (1 + ivaCompraPct / 100)) : costo;
  // Sin presentación real no hay MO ni insumos propios: no suman (igual que una temporal en el server).
  const costoTotal = r2Cli(costoNeto);

  const curvaPct = gananciaPorCurvaCliente((c.curvaGanancia || {})[tipo], costoNeto, fracc ? pesoG : null);
  if (curvaPct == null) return { faltantes: [`La curva de ganancia de ${nombre} no da una ganancia para este costo: revisala en Ganancia.`] };
  const gastosPct = gastosTipoCli(c, tipo);
  if (gastosPct == null) {
    return { faltantes: [`Faltan los gastos de ${nombre}: hay departamentos imputados y no hay venta mensual base (Costos › Departamentos).`] };
  }
  if (gastosPct >= 100) return { faltantes: [`Los gastos de ${nombre} (${fmtPctGastos(gastosPct)}) tienen que ser menores a 100 %.`] };
  const conceptos = conceptosCli(c);
  const gananciaPct = +(curvaPct + totalConceptosCli(conceptos)).toFixed(6);
  const markup = markupDesdeGananciaCli(gananciaPct, gastosPct);
  if (markup == null || markup <= -100) return { faltantes: [`La ganancia de ${nombre} (${fmtPctGastos(gananciaPct)}) deja el precio en cero o negativo.`] };

  const d = desgloseCli({ costo: costoTotal, markup, gastos: gastosDesgloseCli(c, tipo), ivaPct: ivaVentaCli(c), conceptos,
    conceptosFinal: conceptosFinalCli(c) });
  return {
    faltantes: [], tipo, fracc, costoCompra: costo, conIva, ivaCompraPct, ivaCompra: conIva ? r2Cli(costo - costoNeto) : 0,
    costoNeto, pesoG: fracc ? pesoG : null, costoTotal,
    curvaPct, gananciaPct, gastosPct, markup, d, resumen: resumenSimulacion(d, gastosPct),
  };
}

// Margen de costos (gastos % s/ precio neto = G, y s/ costo = G ÷ (1 − G)), markups y ganancia final sobre el precio
// final REDONDEADO: precio neto final = precio final × (1 − F) ÷ (1 + IVA); ganancia final = neto final − costo real
// (gananciaFinalCli, el mismo cálculo que el pie del desglose).
function resumenSimulacion(d, gastosPct) {
  const { netoFinal, gananciaFinal } = gananciaFinalCli(d);
  const pctDe = (x, base) => (base > 0 ? r2Cli(x / base * 100) : null);
  return {
    margenCostosPctNeto: gastosPct, margenCostosPctCosto: r2Cli(gastosPct / (100 - gastosPct) * 100),
    gastos: r2Cli(d.variables + d.departamentos),
    markupNetoPct: d.markupNetoPct, markupFinalPct: d.markupFinalPct,
    netoFinal, gananciaFinal, gananciaFinalPctNeto: pctDe(gananciaFinal, netoFinal), gananciaFinalPctFinal: pctDe(gananciaFinal, d.precioFinal),
    impuestosFinal: d.conceptosFinalImporte, impuestosFinalPct: d.conceptosFinalPct,
  };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { simularPrecio, resumenSimulacion, SIM_TIPOS };
}

// ── Sub-tab Simulador ───────────────────────────────────────────────────────────
let simCfg = null;         // config leída al entrar al sub-tab
let simTipo = 'almacen';

function htmlSimuladorForm() {
  const tipos = Object.entries(SIM_TIPOS).map(([t, n]) =>
    `<button type="button" class="seg-opt" data-tipo="${t}" aria-pressed="${t === simTipo}">${esc(n)}</button>`).join('');
  const link = (sub, txt) => `<button type="button" data-ir="${sub}" class="text-verde underline underline-offset-2 hover:text-verdeHover">${txt}</button>`;
  return `<p class="cfg-cab"><b>Simulador</b> — cargá un costo de compra y mirá el precio final con la configuración guardada, paso por paso. No guarda nada.</p>
  <div class="grid gap-5 items-start" style="grid-template-columns:360px minmax(0,1fr)">
    <div class="cfg-card">
      <h3 class="cfg-h">Producto de prueba</h3>
      <p class="cfg-ayuda">Se calcula como un producto real: costos, curva, conceptos de ganancia, IVA y conceptos sobre precio final.</p>
      <label for="simCosto" class="block text-sm font-semibold mb-1" id="simCostoLbl">Costo de compra ($)</label>
      ${campoU(`<input id="simCosto" type="number" min="0" step="any" inputmode="decimal" placeholder="0,00" class="text-lg font-semibold">`, '$', { pre: true, w: 'w-full' })}
      <div class="text-sm font-semibold mt-4 mb-1" id="simTipoLbl">Tipo</div>
      <div id="simTipo" class="seg seg-sub" role="group" aria-labelledby="simTipoLbl">${tipos}</div>
      <label class="flex items-center gap-2 text-sm mt-4 cursor-pointer"><input id="simConIva" type="checkbox" class="accent-verde">
        El costo incluye IVA</label>
      <div class="flex items-center justify-between gap-2 text-sm text-gris mt-2 ml-6"><label for="simIvaCompra">Alícuota de compra</label>
        ${campoU(`<input id="simIvaCompra" type="number" min="0" max="100" step="any" value="${SIM_IVA_COMPRA_DEFAULT}" disabled>`, '%', { w: 'w-24' })}</div>
      <div id="simPesoFila" class="hidden mt-4">
        <div class="flex items-center justify-between gap-2 text-sm"><label for="simPeso" class="font-semibold">Peso de la presentación</label>
          ${campoU(`<input id="simPeso" type="number" min="1" step="any" value="${SIM_PESO_DEFAULT_G}">`, 'g', { w: 'w-28' })}</div>
        <span class="cfg-nota mt-1">El costo es $/kg del granel. El peso elige el ajuste de la curva. Sin mano de obra ni
          insumos: son propios de cada presentación (sin valor propio no suman).</span>
      </div>
    </div>
    <div class="cfg-card text-sm" style="max-width:760px">
      <h3 class="cfg-h mb-2">Resultado</h3>
      <div id="simResultado" aria-live="polite"></div>
      <div class="text-xs text-gris mt-4 pt-3 border-t border-borde">Ver parámetros: ${link('costos', 'Costos')} · ${link('ganancia', 'Ganancia')} ·
        ${link('precioFinal', 'Precio final')}</div>
    </div>
  </div>`;
}

const simFila = (op, txt, valor, cls = '', fuerte = false) =>
  `<div class="ec sec s-costo ${cls}"><span class="ec-op" aria-hidden="true">${op}</span><span class="${fuerte ? 'font-semibold' : ''}">${txt}</span><span class="ec-val${fuerte ? ' font-semibold' : ''}">${valor}</span></div>`;
const simDato = (lbl, valor, title = '') =>
  `<div${title ? ` title="${esc(title)}"` : ''}><div class="lbl">${esc(lbl)}</div><div class="font-semibold tabular-nums">${esc(valor)}</div></div>`;

// Costo de compra → costo neto (IVA de compra).
function htmlCostoSim(r) {
  const kg = r.fracc ? ' /kg' : '';
  const $ = v => esc('$ ' + fmtMoney(v) + kg);
  const s = txt => ` <span class="text-xs text-gris">(${esc(txt)})</span>`;
  if (!r.conIva) return simFila('', 'Costo neto', $(r.costoTotal), '', true);
  const filas = [simFila('', 'Costo de compra' + s('con IVA'), $(r.costoCompra))];
  filas.push(simFila('−', 'IVA de compra' + s(fmtPctGastos(r.ivaCompraPct)), $(r.ivaCompra)));
  filas.push(simFila('=', 'Costo neto', $(r.costoTotal), 'ec-total', true));
  return filas.join('');
}

function htmlResultadoSim(r) {
  if (r.faltantes.length) {
    return `<div class="text-crit">${r.faltantes.map(f => `<p>${esc(f)}</p>`).join('')}</div>
      <p class="text-xs text-gris mt-1">Sin precio hasta completar lo que falta.</p>`;
  }
  const res = r.resumen;
  const nota = ` <span class="text-xs text-gris font-normal">(margen de costos ${esc(fmtPctGastos(res.margenCostosPctNeto))} s/ precio neto · ${esc(fmtPctGastos(res.margenCostosPctCosto))} s/ costo)</span>`;
  const kg = r.fracc ? ' /kg' : '';
  return `<div role="group" aria-label="Cálculo del precio simulado">
      ${htmlCostoSim(r)}
      ${htmlDesglose(r.d, r.fracc ? '$/kg' : '$', false, nota)}
      <div class="ec ec-total sec s-final mt-2"><span class="ec-op" aria-hidden="true">=</span>
        <div><div class="font-semibold text-verde">Precio final al público</div>
          <div class="text-xs text-gris">precio final exacto redondeado a $50${r.fracc ? ' · por kg' : ''}</div></div>
        <span class="ec-val text-3xl font-bold text-verde">${esc('$ ' + fmtPrecio(r.d.precioFinal) + kg)}</span></div>
    </div>
    <div class="grid grid-cols-3 gap-x-6 gap-y-3 mt-4">
      ${simDato('Markup s/ neto', fmtPctGastos(res.markupNetoPct), 'Precio neto ÷ costo neto − 1')}
      ${simDato('Markup final', fmtPctGastos(res.markupFinalPct), 'Precio final al público ÷ costo neto − 1')}
      ${simDato('Gastos totales', '$ ' + fmtMoney(res.gastos) + kg, 'Variables sobre venta + departamentos')}
      ${simDato('Ganancia final', '$ ' + fmtMoney(res.gananciaFinal) + kg, 'Precio final × (1 − impuestos s/ precio final) ÷ (1 + IVA) − costo real (con el redondeo a $50)')}
      ${simDato('Ganancia s/ precio neto', fmtPctGastos(res.gananciaFinalPctNeto), 'Ganancia final ÷ precio neto final')}
      ${simDato('Margen neto', fmtPctGastos(res.gananciaFinalPctFinal), 'Ganancia final ÷ precio final al público')}
      ${simDato('Impuestos s/ precio final', '$ ' + fmtMoney(res.impuestosFinal) + kg + ' (' + fmtPctGastos(res.impuestosFinalPct) + ')', 'Conceptos sobre precio final (Ganancia › Conceptos sobre precio final) sobre el precio final exacto')}
    </div>`;
}

function entradaSim() {
  const val = id => numOrNull(document.getElementById(id).value);
  return { costo: val('simCosto'), tipo: simTipo, conIva: document.getElementById('simConIva').checked,
    ivaCompraPct: val('simIvaCompra'), pesoG: val('simPeso') };
}

function recalcularSim() {
  const el = document.getElementById('simResultado');
  if (!simCfg) return;
  el.innerHTML = htmlResultadoSim(simularPrecio(simCfg, entradaSim()));
}

function conectarSimulador() {
  const panel = document.getElementById('panel-simulador');
  panel.addEventListener('input', e => { if (['simCosto', 'simIvaCompra', 'simPeso'].includes(e.target.id)) recalcularSim(); });
  document.getElementById('simConIva').addEventListener('change', e => {
    document.getElementById('simIvaCompra').disabled = !e.target.checked;
    recalcularSim();
  });
  document.querySelectorAll('#simTipo .seg-opt').forEach(b => b.addEventListener('click', () => {
    simTipo = b.dataset.tipo;
    document.querySelectorAll('#simTipo .seg-opt').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    document.getElementById('simPesoFila').classList.toggle('hidden', simTipo !== 'fraccionado');
    document.getElementById('simCostoLbl').textContent = simTipo === 'fraccionado' ? 'Costo de compra ($/kg)' : 'Costo de compra ($)';
    recalcularSim();
  }));
  panel.querySelectorAll('[data-ir]').forEach(b => b.addEventListener('click', irASubConfig)); // precios_config.js
}

// La llama activarSubConfig (precios_config.js). El formulario se arma una vez (conserva lo cargado); la config se
// relee en cada entrada para simular con lo último guardado.
async function cargarSimulador() {
  const panel = document.getElementById('panel-simulador');
  if (!document.getElementById('simCosto')) { panel.innerHTML = htmlSimuladorForm(); conectarSimulador(); }
  const el = document.getElementById('simResultado');
  el.innerHTML = '<span class="spin"></span> Cargando configuración…';
  document.getElementById('simCosto').focus();
  try {
    simCfg = await leerConfig(); // precios_config.js
    recalcularSim();
  } catch (e) {
    simCfg = null;
    el.innerHTML = `<p class="text-crit">No se pudo cargar la configuración: ${esc(e.message)}</p>`;
  }
}
