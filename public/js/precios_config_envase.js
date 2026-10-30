// ── Precios · Configuración › Costeo Fraccionado › tarjeta "Envase" (spec 2026-10-29-precios-fraccionado-envase-bolsa-bobina-design) ──
// Script clásico, después de precios_config_fraccionado.js: usa sus globales (cfFr, API_FR, pedirEsq, guardarFr, repintarFr, pieFr, esc,
// campoU, numOrNull, msgEsq, limpiarSucio, fmtMoney) y el buscador de SIGA de precios_produccion.js (htmlBuscadorSiga, conectarBuscadorSiga).
// El envase es un COSTO que se suma al del producto antes de calcular los precios (los márgenes van después). Hay un envase por peso de
// presentación, con dos formas independientes que se pueden cargar a la vez (cada producto elige cuál usa en su modal; sin elegir, bolsa):
// bolsa = el PLU de SIGA (cuesta lo que diga su tab) y bobina = gramos de bolsa × $ por kg de bobina (un solo $/kg para todos los pesos).
// La tarjeta tiene dos pasos (1 costo de la bobina, 2 la tabla de pesos, editable en la fila) y UN solo Guardar: PUT /envase
// { costoBobinaKg?, pesos?: { [pesoG]: { bolsaPlu, bobinaG } } } con sólo lo que cambió. Se valida en el cliente antes (mismos límites que
// el servidor) y el costo por unidad de la bobina se recalcula al tipear, sin guardar. El PUT devuelve el envase crudo (sin el nombre ni el
// costo de la bolsa): después de guardar se recargan pesos y envasePorPeso del GET /costeo. Enter en un campo no hace nada (la tarjeta no
// es un <form>): guardar es siempre el botón. El buscador de bolsas es el diálogo #dlgFP de precios.html (sólo elige un producto de SIGA).
const BOBINA_G_MAX_FR = 1000;
const COSTO_BOBINA_MAX_FR = 1e7;
const PLU_BOLSA_FR = /^\d{1,12}$/;

// ── Puros (test/precios_config_envase_ui.test.js) ──
// De los inputs de una fila (texto, '' = vacío): null si está bien; si no { campo, mensaje } del primero que falla, para marcar dónde.
function errorEnvaseFr(plu, peso) {
  const p = String(plu).trim(), s = String(peso).trim(), n = Number(s);
  if (p !== '' && !PLU_BOLSA_FR.test(p)) return { campo: 'bolsaPlu', mensaje: 'El PLU lleva sólo dígitos, hasta 12 (ej. 4521)' };
  if (s !== '' && !(Number.isFinite(n) && n > 0 && n <= BOBINA_G_MAX_FR)) return { campo: 'bobinaG', mensaje: `Los gramos son un número mayor que 0, hasta ${BOBINA_G_MAX_FR} (ej. 8)` };
  return null;
}
// Body de un peso en el PUT /envase: vacío = null (saca el campo); los dos vacíos borran el peso.
const cuerpoEnvaseFr = (plu, peso) => ({ bolsaPlu: String(plu).trim() || null, bobinaG: numOrNull(peso) });
// Del campo "Costo de la bobina" ($/kg, texto): null si está bien (vacío = sin cargar); 0 no vale.
const errorCostoBobinaFr = txt => {
  const s = String(txt).trim(), n = Number(s);
  return s !== '' && !(Number.isFinite(n) && n > 0 && n <= COSTO_BOBINA_MAX_FR) ? 'El costo de bobina es un número mayor que 0 ($ por kg), o vacío para sacarlo' : null;
};
// Todo lo que está mal antes de guardar, en el orden de la pantalla: [{ campo: 'costoBobinaKg' | 'bolsaPlu' | 'bobinaG', pesoG?, mensaje }].
// filas = [{ pesoG, plu, g }] con el texto de cada input; el PLU y los gramos de una fila se marcan por separado.
function erroresEnvaseFr(costoTxt, filas) {
  const errores = [], costo = errorCostoBobinaFr(costoTxt);
  if (costo) errores.push({ campo: 'costoBobinaKg', mensaje: costo });
  filas.forEach(f => [errorEnvaseFr(f.plu, ''), errorEnvaseFr('', f.g)].forEach(e => { if (e) errores.push({ ...e, pesoG: f.pesoG }); }));
  return errores;
}
// Body del PUT /envase con sólo lo que cambió respecto de lo guardado (costoGuardado, envasePorPeso con claves string); null si no cambió nada.
function cuerpoCambiosEnvaseFr(costoTxt, filas, costoGuardado, envasePorPeso) {
  const body = {}, costo = numOrNull(costoTxt), pesos = {};
  if (costo !== (costoGuardado ?? null)) body.costoBobinaKg = costo;
  filas.forEach(f => {
    const antes = (envasePorPeso || {})[f.pesoG] || {}, ahora = cuerpoEnvaseFr(f.plu, f.g);
    if (ahora.bolsaPlu !== (antes.bolsaPlu ?? null) || ahora.bobinaG !== (antes.bobinaG ?? null)) pesos[f.pesoG] = ahora;
  });
  if (Object.keys(pesos).length) body.pesos = pesos;
  return Object.keys(body).length ? body : null;
}
// Filas de la tabla: los pesos del universo (pesos del GET /costeo) + los configurados que ya no tienen presentaciones (0), ascendente,
// cada uno con su envase (envasePorPeso: claves string, { bolsaPlu?, bobinaG?, bolsaNombre?, bolsaCosto? }).
const filasPesosFr = (pesos, envasePorPeso) => {
  const epp = envasePorPeso || {}, n = new Map((pesos || []).map(p => [Number(p.pesoG), p.presentaciones]));
  return [...new Set([...n.keys(), ...Object.keys(epp).map(Number)])].sort((a, b) => a - b)
    .map(pesoG => ({ pesoG, presentaciones: n.get(pesoG) || 0, ...epp[pesoG] }));
};
// "250 g" / "1 kg" (kilos enteros en kg) y "34 productos".
const pesoCortoFr = pesoG => (pesoG % 1000 ? `${pesoG} g` : `${pesoG / 1000} kg`);
const productosFr = n => (n ? `${n} producto${n === 1 ? '' : 's'}` : 'sin productos');
// Costo por unidad de la bobina: gramos de bolsa / 1000 × $ por kg. null si falta alguno de los dos o no es mayor que 0.
const costoBobinaUnidadFr = (gramos, costoKg) => (gramos > 0 && costoKg > 0 ? gramos / 1000 * costoKg : null);
// Qué se sabe de la bolsa que hay tipeada en una fila: plu = texto del input, f = la fila guardada (con bolsaNombre y bolsaCosto de
// SIGA), elegidos = { plu: nombre } de lo elegido con el buscador. tipo: vacia | ok | sinCosto | noSiga | nueva (cambiada, sin guardar).
function infoBolsaFr(plu, f, elegidos = {}) {
  const p = String(plu).trim();
  if (!p) return { tipo: 'vacia' };
  if (p !== f.bolsaPlu) return { tipo: 'nueva', nombre: elegidos[p] || null };
  if (f.bolsaNombre == null) return { tipo: 'noSiga' };
  return { tipo: f.bolsaCosto == null ? 'sinCosto' : 'ok', nombre: f.bolsaNombre, costo: f.bolsaCosto };
}
// Chip "Envase" de la barra de estado (filas de filasPesosFr), el primero que aplique: { texto, estado }.
function estadoEnvaseFr(filas, costoBobinaKg) {
  const sinCostoBolsa = filas.filter(f => f.bolsaPlu && f.bolsaCosto == null).length, sinNada = filas.filter(f => !f.bolsaPlu && !f.bobinaG).length;
  if (!filas.length) return { texto: 'sin pesos', estado: 'info' };
  if (costoBobinaKg == null && filas.some(f => f.bobinaG)) return { texto: 'falta costo de bobina', estado: 'falta' };
  if (sinCostoBolsa) return { texto: `${sinCostoBolsa} bolsa${sinCostoBolsa === 1 ? '' : 's'} sin costo`, estado: 'falta' };
  if (sinNada) return { texto: `${sinNada} sin bolsa ni bobina`, estado: 'info' };
  return { texto: 'todos con envase', estado: 'ok' };
}

if (typeof module === 'object' && module.exports) module.exports = { errorEnvaseFr, cuerpoEnvaseFr, errorCostoBobinaFr, erroresEnvaseFr,
  cuerpoCambiosEnvaseFr, filasPesosFr, pesoCortoFr, productosFr, costoBobinaUnidadFr, infoBolsaFr, estadoEnvaseFr };

// ── DOM ──
const elegidosFr = {}; // ponytail: plu → nombre de lo elegido con el buscador (la tabla aún no lo sabe por SIGA), estado de UI que se muta en el lugar
const SIN_DATO_FR = '<span class="text-gris">—</span>';
const faltaFr = txt => `<span class="text-crit font-semibold">⚠ ${txt}</span>`;
const AYUDA_ENVASE_FR = `El envase es un <b>costo</b> que se suma al del producto <b>antes</b> de calcular los precios: los márgenes se aplican después, sobre el costo ya
  con envase. Cada producto elige bolsa o bobina en su ficha (por defecto: bolsa).`;

// Bajo el PLU: el nombre y el costo de la bolsa en gris (o el motivo por el que falta).
function htmlNotaBolsaFr(info) {
  if (info.tipo === 'vacia') return '';
  if (info.tipo === 'noSiga') return faltaFr('Este PLU no está en SIGA');
  if (info.tipo === 'nueva') return info.nombre ? `${esc(info.nombre)} · el costo se ve al guardar` : 'Se busca en SIGA al guardar';
  return `${esc(info.nombre)} · ${info.costo == null ? faltaFr('sin costo') : `<b class="text-ink tabular-nums">$ ${fmtMoney(info.costo)}</b>`}`;
}
// A la derecha de los gramos: lo que cuesta cada unidad, con el costo de la bobina que esté tipeado arriba.
function htmlCostoBobinaFr(gramos, costoKg) {
  if (!(gramos > 0)) return SIN_DATO_FR;
  const c = costoBobinaUnidadFr(gramos, costoKg);
  return c == null ? faltaFr('falta el costo de bobina') : `<b class="whitespace-nowrap tabular-nums">$ ${fmtMoney(c)}</b> <span class="text-gris">por unidad</span>`;
}
function htmlFilaPesoFr(f) {
  const k = f.pesoG, peso = esc(pesoCortoFr(k));
  return `<tr data-peso="${k}"><td class="fr-peso${f.presentaciones ? '' : ' fr-peso-vacio'}"><b>${peso}</b><span>${esc(productosFr(f.presentaciones))}</span></td>
    <td class="ev-campo"><div class="ev-plu-fila"><input type="text" inputmode="numeric" autocomplete="off" class="num-in text-left ev-plu" data-k="bolsaPlu" value="${esc(f.bolsaPlu || '')}"
        placeholder="ej. 4521" aria-label="PLU de la bolsa de ${peso}" aria-describedby="evNota-${k} evErrPlu-${k}">
      <button type="button" class="ev-buscar cfg-btn2" aria-label="Buscar la bolsa de ${peso} en SIGA">Buscar</button></div>
      <span class="ev-nota" id="evNota-${k}">${htmlNotaBolsaFr(infoBolsaFr(f.bolsaPlu || '', f))}</span><span class="ev-err" id="evErrPlu-${k}" hidden></span></td>
    <td class="ev-campo ev-col-bobina"><div class="ev-bob-fila">${campoU(`<input type="number" min="0" max="${BOBINA_G_MAX_FR}" step="any" data-k="bobinaG" value="${esc(f.bobinaG ?? '')}"
        placeholder="ej. 8" aria-label="Gramos de bolsa para ${peso} (por bobina)" aria-describedby="evBob-${k} evErrG-${k}">`, 'g', { w: 'w-28' })}
      <span class="ev-bob" id="evBob-${k}">${htmlCostoBobinaFr(f.bobinaG, cfFr.costoBobinaKg)}</span></div><span class="ev-err" id="evErrG-${k}" hidden></span></td></tr>`;
}
function htmlTablaPesosFr() {
  const filas = filasPesosFr(cfFr.pesos, cfFr.envasePorPeso);
  if (!filas.length) return `<p class="ev-vacio">Todavía no hay pesos para cargar: ninguna presentación de Fraccionado tiene el peso escrito en su nombre (por ejemplo «ALMENDRAS 500G»).
    Cuando aparezcan, se listan acá.</p>`;
  return `<table class="cfg-tabla fr-filas ev-tabla w-full" id="evTabla"><caption class="sr-only">Envase de cada peso de presentación</caption>
    <thead><tr><th scope="col">Peso</th>
      <th scope="col" class="ev-grupo">Si el producto va por BOLSA<span>PLU de la bolsa en SIGA y su costo</span></th>
      <th scope="col" class="ev-grupo ev-col-bobina">Si va por BOBINA<span>Gramos de bolsa y su costo por unidad (con el costo del paso 1)</span></th></tr></thead>
    <tbody>${filas.map(htmlFilaPesoFr).join('')}</tbody></table>`;
}
const htmlPasoBobinaFr = () => `<section class="ev-paso" aria-labelledby="evT1"><h4 class="ev-paso-t" id="evT1"><span class="fr-n" aria-hidden="true">1</span>Costo de la bobina</h4>
    <div class="ev-paso-cuerpo ev-campo"><div class="ev-bobina">${campoU(`<input type="number" id="frBobinaKg" data-k="costoBobinaKg" min="0" max="${COSTO_BOBINA_MAX_FR}" step="any"
        value="${esc(cfFr.costoBobinaKg ?? '')}" placeholder="ej. 6000" aria-label="Costo de la bobina, en pesos por kilo" aria-describedby="evAyudaBobina evErrBobina">`, '$/kg', { w: 'w-40' })}
      <span class="ev-hint" id="evAyudaBobina">Lo que cuesta un kilo de bobina. Es el mismo para todos los pesos de abajo; si lo cambiás, sus costos se recalculan.</span></div>
      <span class="ev-err" id="evErrBobina" hidden></span></div></section>`;
const htmlPasoPesosFr = () => `<section class="ev-paso" aria-labelledby="evT2"><h4 class="ev-paso-t" id="evT2"><span class="fr-n" aria-hidden="true">2</span>Envase de cada peso</h4>
    <p class="ev-paso-ayuda">Cada peso tiene su envase, igual para todos los productos de ese peso. Podés cargar la bolsa, la bobina o las dos: no se pisan y cada producto usa la que elija.
      Dejá vacío lo que no uses.</p>
    <div id="evTablaWrap">${htmlTablaPesosFr()}</div></section>`;
const htmlPesosFr = () => `<div class="cfg-card fr-card fr-ancla min-w-0 mt-4" data-guardable data-nombre="Envase" id="frPesos"><div class="fr-cuerpo">
    <h3 class="cfg-h">Envase</h3>
    <p class="cfg-ayuda ev-ayuda">${AYUDA_ENVASE_FR}</p>
    <div class="ev-formas"><div><b>Por bolsa:</b> el costo de la bolsa (PLU de SIGA).</div>
      <div><b>Por bobina:</b> gramos de bolsa × $ por kg de bobina. Ej.: 8 g × $ 6.000/kg = $ 48.</div></div>
    ${htmlPasoBobinaFr()}${htmlPasoPesosFr()}</div>${pieFr('Guardar envase')}</div>`;

// Chip "Envase" de la barra de estado, con lo guardado (la barra la arma precios_config_fraccionado.js).
const estadoEnvaseActualFr = () => estadoEnvaseFr(filasPesosFr(cfFr.pesos, cfFr.envasePorPeso), cfFr.costoBobinaKg);

// Error junto al campo: aria-invalid y el mensaje en el .ev-err de su celda (el aria-describedby del input ya lo nombra).
const errDeFr = i => i.closest('.ev-campo').querySelector('.ev-err');
function marcarErrorFr(i, texto) {
  const e = errDeFr(i);
  i.setAttribute('aria-invalid', 'true');
  e.textContent = texto;
  e.hidden = false;
}
function limpiarErrorFr(i) {
  const e = errDeFr(i);
  i.removeAttribute('aria-invalid');
  e.textContent = '';
  e.hidden = true;
}
// Marca todos los errores, manda el foco al primero y lo cuenta en el pie.
function avisarErroresEnvaseFr(card, errores) {
  const campo = e => (e.campo === 'costoBobinaKg' ? card.querySelector('#frBobinaKg') : card.querySelector(`tr[data-peso="${e.pesoG}"] [data-k="${e.campo}"]`));
  errores.forEach(e => marcarErrorFr(campo(e), e.mensaje));
  campo(errores[0]).focus();
  msgEsq(card.querySelector('.esq-msg'), `Hay ${errores.length} campo${errores.length === 1 ? '' : 's'} para corregir (marcados en rojo)`, 'text-crit');
}

// Recalcula, sin guardar, lo que depende de lo tipeado en una fila: la nota de la bolsa y el costo por unidad de la bobina.
function refrescarFilaFr(tr) {
  const f = (cfFr.envasePorPeso || {})[tr.dataset.peso] || {};
  tr.querySelector('.ev-nota').innerHTML = htmlNotaBolsaFr(infoBolsaFr(tr.querySelector('[data-k="bolsaPlu"]').value, f, elegidosFr));
  tr.querySelector('.ev-bob').innerHTML = htmlCostoBobinaFr(numOrNull(tr.querySelector('[data-k="bobinaG"]').value), numOrNull(document.getElementById('frBobinaKg').value));
}
// Un número que no se puede leer (texto en un campo numérico) no se confunde con vacío.
const leerCampoFr = i => (i.validity.badInput ? 'x' : i.value);
function guardarEnvaseFr(card) {
  const costo = leerCampoFr(card.querySelector('#frBobinaKg'));
  const filas = [...card.querySelectorAll('#evTabla tbody tr')].map(tr => ({ pesoG: Number(tr.dataset.peso),
    plu: tr.querySelector('[data-k="bolsaPlu"]').value, g: leerCampoFr(tr.querySelector('[data-k="bobinaG"]')) }));
  card.querySelectorAll('[aria-invalid]').forEach(limpiarErrorFr);
  const errores = erroresEnvaseFr(costo, filas);
  if (errores.length) return avisarErroresEnvaseFr(card, errores);
  const body = cuerpoCambiosEnvaseFr(costo, filas, cfFr.costoBobinaKg, cfFr.envasePorPeso);
  if (!body) { limpiarSucio(card); return msgEsq(card.querySelector('.esq-msg'), 'No hay cambios para guardar'); }
  return guardarFr(card, '/envase', body, async () => {
    try { // la respuesta del PUT trae el envase crudo: los nombres y costos de las bolsas salen del GET /costeo
      const { pesos, envasePorPeso } = await pedirEsq('GET', `${API_FR}/costeo`);
      cfFr = { ...cfFr, pesos, envasePorPeso };
    } catch (e) { throw new Error(`Se guardó, pero no se pudieron recargar los nombres y costos de las bolsas: ${e.message}`); }
    return repintarFr('frPesos', htmlPesosFr, conectarPesosFr);
  });
}

// Buscador de bolsas (#dlgFP): elegir un producto de SIGA completa el PLU de la fila (queda sin guardar, como si lo hubieran tipeado).
function abrirBuscadorBolsaFr(tr) {
  const d = document.getElementById('dlgFP'), plu = tr.querySelector('[data-k="bolsaPlu"]');
  d.querySelector('.fp-dlg-titulo').textContent = `Buscar la bolsa de ${pesoCortoFr(Number(tr.dataset.peso))}`;
  d.querySelector('.fp-dlg-bus').innerHTML = htmlBuscadorSiga('fpDlgBus', 'Nombre o PLU, ej. bolsa zipper 500');
  d.querySelector('#fpDlgBus').setAttribute('aria-label', 'Buscar la bolsa por nombre o PLU');
  conectarBuscadorSiga('fpDlgBus', e => {
    elegidosFr[e.plu] = e.nombre;
    plu.value = e.plu;
    plu.dispatchEvent(new Event('input', { bubbles: true })); // ensucia la tarjeta y repinta la nota de la fila
    d.close();
  });
  d.querySelector('.fp-dlg-cancelar').onclick = () => d.close();
  d.addEventListener('close', () => plu.focus(), { once: true });
  d.showModal();
  d.querySelector('#fpDlgBus').focus();
}
function conectarPesosFr(card) {
  card.oninput = e => {
    const i = e.target;
    if (!i.matches('input[data-k]')) return;
    limpiarErrorFr(i);
    msgEsq(card.querySelector('.esq-msg'), '');
    if (i.id === 'frBobinaKg') card.querySelectorAll('#evTabla tbody tr').forEach(refrescarFilaFr); // el costo de la bobina mueve todas las filas
    else refrescarFilaFr(i.closest('tr'));
  };
  card.onclick = e => { const b = e.target.closest('.ev-buscar'); if (b) abrirBuscadorBolsaFr(b.closest('tr')); };
  card.querySelector('.fr-guardar').onclick = () => guardarEnvaseFr(card);
}
