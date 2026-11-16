// ── Precios · Configuración › General › Pack / Bulto ──────────────────────────────
// Vínculos manuales y productos del rubro sin vincular. El precio lo calcula el esquema por canal; el modo de venta de
// los pesables se edita en el detalle de Fraccionado (precios_modal_esquema.js).
// Script clásico: usa esc, inputCls, pedirJson (precios_comun.js), avisar, confirmar (precios_config.js) y
// htmlBuscadorSiga, conectarBuscadorSiga (precios_produccion*.js).
const PB_TIPO = { pack: 'Pack', bulto: 'Bulto' };
const API_PB = '/api/precios/pack-bulto';

// ── Configuración › Pack / Bulto ────────────────────────────────────────────────
let pbConfig = null; // GET /api/precios/pack-bulto/vinculos: { vinculos, sinVincular }
const cardPB = cuerpo => `<div class="cfg-card">
  <h3 class="cfg-h">Pack / Bulto</h3>${cuerpo}</div>`;

async function cargarConfigPB() {
  const cont = document.getElementById('configPackBulto');
  if (!cont) return;
  cont.innerHTML = cardPB('<div class="text-sm text-ink/50 py-4"><span class="spin"></span> Cargando vínculos de SIGA…</div>');
  try {
    const j = await (await fetch(`${API_PB}/vinculos`)).json();
    if (j.error) throw new Error(j.error);
    pbConfig = j;
    pintarConfigPB();
  } catch (e) {
    cont.innerHTML = cardPB(`<p class="text-crit text-sm">No se pudo cargar: ${esc(e.message)}</p>`);
  }
}

function pintarConfigPB() {
  const { vinculos, sinVincular } = pbConfig;
  const manuales = vinculos.filter(v => v.origen === 'manual');
  document.getElementById('configPackBulto').innerHTML = cardPB(`
    <p class="cfg-ayuda">Vínculo automático: productos del rubro "Almacen Bultos/Cajas" con un solo componente en su fórmula activa de SIGA, sin importar el nombre. El tipo sale del nombre (Pack → pack; Bulto o Caja → bulto); si no lo dice, es bulto (se cambia vinculando a mano).
      ${vinculos.length} vinculados · ${sinVincular.length} sin vincular.</p>
    ${htmlManualesPB(manuales)}
    ${htmlSinVincularPB(sinVincular)}`);
  conectarConfigPB();
}

function htmlManualesPB(manuales) {
  if (!manuales.length) return '';
  return `<div class="mt-5 border-t border-borde pt-4"><div class="font-semibold mb-2">Vínculos manuales <span class="text-gris font-normal">(${manuales.length})</span></div>
    ${manuales.map(v => `<div class="flex flex-wrap items-center gap-2 text-sm py-1">
      <span class="tabular-nums">${esc(v.plu)}</span> ${esc(v.nombre || '')} → <b>${esc(PB_TIPO[v.tipo] || v.tipo)}</b> de
      <span class="tabular-nums">${esc(v.basePlu)}</span> ${esc(v.baseNombre || '')}
      <button type="button" class="pb-quitar-vinc ml-auto text-xs text-gris hover:text-crit" data-plu="${esc(v.plu)}">Quitar vínculo</button></div>`).join('')}</div>`;
}

function htmlSinVincularPB(lista) {
  const filas = lista.length ? lista.map(s => `<tr class="border-t border-borde" data-sv="${esc(s.plu)}">
      <td class="p-1.5 tabular-nums">${esc(s.plu)}</td><td class="p-1.5">${esc(s.nombre || '')}</td><td class="p-1.5 text-gris text-xs">${esc(s.motivo)}</td>
      <td class="p-1.5 text-right"><button type="button" class="pb-vincular text-xs font-semibold text-verde hover:text-verdeHover">Vincular…</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="p-3 text-center text-gris text-sm">Todos los productos del rubro quedaron vinculados.</td></tr>';
  return `<details class="mt-5 border-t border-borde pt-4" open>
    <summary class="font-semibold cursor-pointer">Sin vincular <span class="text-gris font-normal">(${lista.length})</span></summary>
    <p class="text-[11px] text-gris mt-1">Sin fórmula o fórmula con varios componentes (los de un granel se ven en su detalle de Fraccionado). Vinculalos a mano con su producto normal.</p>
    <div class="overflow-auto mt-2 rounded-lg border border-borde" style="max-height:420px"><table class="w-full text-sm"><tbody id="pbSinVincular">${filas}</tbody></table></div></details>`;
}

// Editor en línea de un vínculo manual (uno a la vez): buscador SIGA del producto normal + tipo.
function abrirVinculoPB(tr) {
  document.querySelectorAll('#pbSinVincular tr.pb-editor').forEach(x => x.remove());
  const plu = tr.dataset.sv;
  const sugerido = /\bpack\b/i.test(tr.children[1].textContent) ? 'pack' : 'bulto';
  const opt = t => `<option value="${t}"${sugerido === t ? ' selected' : ''}>${PB_TIPO[t]}</option>`;
  tr.insertAdjacentHTML('afterend', `<tr class="pb-editor bg-bg/60"><td colspan="4" class="p-2"><div class="flex flex-wrap items-center gap-2">
    ${htmlBuscadorSiga('pbBuscaBase', 'Producto normal (PLU o nombre)…')}
    <span id="pbBaseElegida" class="text-sm text-gris">sin elegir</span>
    <select id="pbTipo" class="${inputCls}" style="text-align:left" aria-label="Tipo">${opt('pack')}${opt('bulto')}</select>
    <button type="button" id="pbGuardarVinc" class="px-3 py-1 rounded-lg bg-verde text-white text-sm hover:bg-verdeHover disabled:opacity-40" disabled>Vincular</button>
    <button type="button" id="pbCancelarVinc" class="px-2 py-1 text-sm text-gris hover:text-ink">Cancelar</button></div></td></tr>`);
  let base = null;
  conectarBuscadorSiga('pbBuscaBase', elegido => {
    base = elegido;
    document.getElementById('pbBaseElegida').textContent = `${elegido.plu} · ${elegido.nombre}`;
    document.getElementById('pbGuardarVinc').disabled = false;
  });
  document.getElementById('pbCancelarVinc').onclick = () => tr.nextElementSibling.remove();
  document.getElementById('pbGuardarVinc').onclick = () => accionConfigPB(() => pedirJson('PUT', `${API_PB}/vinculo/${encodeURIComponent(plu)}`,
    { basePlu: base.plu, tipo: document.getElementById('pbTipo').value }));
  document.getElementById('pbBuscaBase').focus();
}

// Ejecuta una escritura y recarga la sección; errores → diálogo del theme.
async function accionConfigPB(fn) {
  try { await fn(); } catch (e) { avisar(e.message); return; }
  await cargarConfigPB();
}

function conectarConfigPB() {
  document.querySelectorAll('.pb-quitar-vinc').forEach(b => {
    b.onclick = async () => {
      if (!(await confirmar('¿Quitar el vínculo manual? Vuelve al vínculo automático de SIGA (si lo tiene).', { textoOk: 'Quitar' }))) return;
      accionConfigPB(() => pedirJson('DELETE', `${API_PB}/vinculo/${encodeURIComponent(b.dataset.plu)}`));
    };
  });
  document.querySelectorAll('#pbSinVincular .pb-vincular').forEach(b => { b.onclick = () => abrirVinculoPB(b.closest('tr')); });
}
