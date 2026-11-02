// ── Precios · Configuración › Costeo Fraccionado › tarjeta "Envase" (spec 2026-10-29-precios-fraccionado-envase-bolsa-bobina-design) ──
// Script clásico, después de precios_config_fraccionado.js: usa sus globales (cfFr, API_FR, pedirEsq, guardarFr, repintarFr, pieFr, esc,
// campoU, numOrNull, msgEsq, limpiarSucio, fmtMoney, coincideFr) y el buscador de SIGA de precios_produccion.js (htmlBuscadorSiga, conectarBuscadorSiga).
// El envase es un COSTO que se suma al del producto antes de calcular los precios (los márgenes van después). Hay un envase por peso de
// presentación, con dos formas independientes que se pueden cargar a la vez (cada producto elige cuál usa en su modal; sin elegir, bolsa):
// bolsa = el PLU de SIGA (cuesta lo que diga su tab) y bobina = gramos de bolsa × $ por kg de bobina (un solo $/kg para todos los pesos).
// La tarjeta tiene dos pasos (1 costo de la bobina, 2 la tabla de pesos, editable en la fila) y UN solo Guardar: PUT /envase
// { costoBobinaKg?, pesos?: { [pesoG]: { bolsaPlu, bobinaG } } } con sólo lo que cambió. Se valida en el cliente antes (mismos límites que
// el servidor) y el costo por unidad de la bobina se recalcula al tipear, sin guardar. El PUT devuelve el envase crudo (sin el nombre ni el
// costo de la bolsa): después de guardar se recargan pesos y envasePorPeso del GET /costeo. Enter en un campo no hace nada (la tarjeta no
// es un <form>): guardar es siempre el botón. El buscador de bolsas es el diálogo #dlgFP de precios.html (sólo elige un producto de SIGA).
// La lista de pesos sale de las presentaciones; encima se puede AGREGAR un peso a mano (fila nueva con el peso tipeable: sin envase no se
// guarda) y QUITAR cualquiera con el ✕ (la fila sale de la tabla y queda pendiente hasta Guardar). Un peso SIN productos se borra
// (null/null). Un peso CON productos no puede desaparecer (lo arman ellos): queda "sin envase" ({ sinEnvase: true }, el servidor borra su
// bolsa y bobina), sus productos se costean sin envase y sin aviso, y pasa a la tira "Pesos sin envase" (#evSinEnvase) bajo la tabla, desde
// donde se lo puede "Volver a poner" (fila vacía y editable; si estaba guardado sin envase, el PUT manda sinEnvase: false). Lo quitado se
// deduce de la tabla: un peso con envase guardado, o con productos, que ya no tiene fila (pesosQuitadosFr), así que quitar + agregar el
// mismo peso SIN productos es un reemplazo; uno con productos que está en la tira no se puede agregar a mano (hay que "Volver a poner").
// La cantidad "34 productos" de la celda del peso es un botón: abre el modal #dlgEvProductos con cuáles son (los de cfFr.subrubrosSiga y
// cfFr.sinSubrubro con ese pesoG, los mismos que cuenta cfFr.pesos) y un buscador. Muestra lo GUARDADO (cfFr), no lo tipeado sin guardar.
const BOBINA_G_MAX_FR = 1000;
const COSTO_BOBINA_MAX_FR = 1e7;
const PESO_MAX_FR = 999999; // peso de un envase: gramos enteros de hasta 6 cifras (espejo del servidor)
const PESO_REPETIDO_FR = 'Ese peso ya está en la lista';
const PESO_EN_TIRA_FR = 'Ese peso está en «Pesos sin envase»: usá «Volver a poner»';
const SIN_ENVASE_TXT_FR = 'Sin envase: no suma costo ni avisa';
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
// Peso (texto) de una fila agregada a mano: obligatorio, gramos enteros de 1 a PESO_MAX_FR y que no esté ya en la lista (yaEstan = Set de
// pesos en número) ni estar en la tira "Pesos sin envase" (enTira, otro Set: ahí se usa "Volver a poner"). null si está bien; si no { campo: 'pesoG', mensaje }.
function errorPesoNuevoFr(txt, yaEstan, enTira = new Set()) {
  const s = String(txt).trim(), n = Number(s);
  if (s === '') return { campo: 'pesoG', mensaje: 'Escribí el peso, en gramos' };
  if (!Number.isInteger(n) || n < 1 || n > PESO_MAX_FR) return { campo: 'pesoG', mensaje: `Gramos enteros, de 1 a ${PESO_MAX_FR}` };
  if (yaEstan.has(n)) return { campo: 'pesoG', mensaje: PESO_REPETIDO_FR };
  return enTira.has(n) ? { campo: 'pesoG', mensaje: PESO_EN_TIRA_FR } : null;
}
// Un peso sin bolsa ni bobina no existe (el servidor lo borra): la fila nueva tiene que traer alguno de los dos.
const errorNuevoSinEnvaseFr = f => (!String(f.plu).trim() && !String(f.g).trim()
  ? { campo: 'bolsaPlu', mensaje: 'Cargá la bolsa o la bobina de este peso, o quitá la fila' } : null);
// Todo lo que está mal antes de guardar, en el orden de la pantalla: [{ campo: 'costoBobinaKg' | 'pesoG' | 'bolsaPlu' | 'bobinaG', pesoG?, nuevo?, mensaje }].
// filas = [{ pesoG, plu, g, nuevo? }] con el texto de cada input; el PLU y los gramos de una fila se marcan por separado. Una fila agregada a mano
// trae nuevo (su id) y su pesoG es lo tipeado: no puede repetir un peso de la tabla ni el de otra fila nueva (los quitados ya no están en filas)
// ni uno de la tira "Pesos sin envase" (enTira: Set de pesos en número, opcional).
function erroresEnvaseFr(costoTxt, filas, enTira) {
  const errores = [], costo = errorCostoBobinaFr(costoTxt), yaEstan = new Set(filas.filter(f => !f.nuevo).map(f => Number(f.pesoG)));
  if (costo) errores.push({ campo: 'costoBobinaKg', mensaje: costo });
  filas.forEach(f => {
    const peso = f.nuevo ? errorPesoNuevoFr(f.pesoG, yaEstan, enTira) : null;
    if (f.nuevo && !peso) yaEstan.add(Number(f.pesoG));
    const sinEnvase = f.nuevo && !peso ? errorNuevoSinEnvaseFr(f) : null;
    [peso, errorEnvaseFr(f.plu, ''), errorEnvaseFr('', f.g), sinEnvase].forEach(e => { if (e) errores.push({ ...e, pesoG: f.pesoG, nuevo: f.nuevo }); });
  });
  return errores;
}
// { pesoG: presentaciones } de cfFr.pesos (viene del universo: incluye los pesos sin envase).
const presentacionesPorPesoFr = pesos => Object.fromEntries((pesos || []).map(p => [p.pesoG, p.presentaciones]));
// Pesos quitados de la tabla que todavía no se guardaron (ascendente): los que tienen envase guardado o productos y ya no tienen fila. Uno sin
// productos se borra al guardar (null/null); uno con productos queda sin envase ({ sinEnvase: true }). Los que YA están guardados sin envase no
// cuentan: no hay nada que guardar. pesos = cfFr.pesos (para saber cuáles tienen productos; sin él sólo cuentan los de envasePorPeso).
function pesosQuitadosFr(filas, envasePorPeso, pesos) {
  const quedan = new Set(filas.map(f => Number(f.pesoG))), epp = envasePorPeso || {}, n = presentacionesPorPesoFr(pesos);
  const candidatos = [...Object.keys(epp), ...Object.keys(n).filter(g => n[g] > 0)].map(Number);
  return [...new Set(candidatos)].filter(g => !quedan.has(g) && !(epp[g] && epp[g].sinEnvase)).sort((a, b) => a - b);
}
// Pesos "sin envase": los guardados con sinEnvase y los con productos que ya no tienen fila en la tabla (quitados con ✕, pendientes de guardar).
// [{ pesoG, presentaciones, guardado }] ascendente; guardado = ya viene así del servidor. Una fila NUEVA con ese peso no cuenta como fila: es un
// error al guardar (hay que "Volver a poner"). filas = las de la tabla; guardadas = filasPesosFr(...).
function pesosSinEnvaseFr(filas, guardadas) {
  const quedan = new Set(filas.filter(f => !f.nuevo).map(f => Number(f.pesoG)));
  return guardadas.filter(f => !quedan.has(f.pesoG) && (f.sinEnvase || f.presentaciones))
    .map(f => ({ pesoG: f.pesoG, presentaciones: f.presentaciones, guardado: !!f.sinEnvase }));
}
// Lo que pasa con los productos de un peso quitado, para el aviso y el ✕: "su producto se costea" / "sus 34 productos se costean".
const efectoQuitarFr = n => (n === 1 ? 'su producto se costea' : `sus ${n} productos se costean`);
// Aviso de lo quitado que todavía no se guardó ('' si no hay). presentaciones = { pesoG: productos } (cfFr.pesos): un peso con productos dice su
// efecto real (se costean sin envase y sin aviso); uno sin productos, que se saca de la lista. Con los dos tipos, una frase por tipo.
function textoQuitadosFr(pesos, presentaciones = {}) {
  const lista = ps => new Intl.ListFormat('es').format(ps.map(pesoCortoFr)), con = pesos.filter(g => presentaciones[g] > 0), sin = pesos.filter(g => !(presentaciones[g] > 0));
  const n = con.reduce((t, g) => t + presentaciones[g], 0);
  return [con.length && `Quitaste ${lista(con)}: ${efectoQuitarFr(n)} sin envase y sin aviso al guardar.`,
    sin.length && `Quitaste ${lista(sin)}: ${sin.length === 1 ? 'se saca' : 'se sacan'} de la lista al guardar.`].filter(Boolean).join(' ');
}
// Body del PUT /envase con sólo lo que cambió respecto de lo guardado (costoGuardado, envasePorPeso con claves string, pesos = cfFr.pesos); null si no cambió nada.
// Quitado sin productos: los dos campos null (el servidor borra el peso); quitado con productos: { sinEnvase: true }; un peso guardado sin envase que vuelve
// a la tabla: { sinEnvase: false, bolsaPlu, bobinaG } con lo que tengan los inputs; uno nuevo o editado, con su envase; el vaciado, igual que el quitado sin productos.
// Un peso sin envase que no se tocó no se manda.
function cuerpoCambiosEnvaseFr(costoTxt, filas, costoGuardado, envasePorPeso, pesos) {
  const body = {}, costo = numOrNull(costoTxt), cambios = {}, epp = envasePorPeso || {}, n = presentacionesPorPesoFr(pesos);
  if (costo !== (costoGuardado ?? null)) body.costoBobinaKg = costo;
  filas.forEach(f => {
    const pesoG = Number(f.pesoG), antes = epp[pesoG] || {}, ahora = cuerpoEnvaseFr(f.plu, f.g);
    if (antes.sinEnvase) cambios[pesoG] = { sinEnvase: false, ...ahora };
    else if (ahora.bolsaPlu !== (antes.bolsaPlu ?? null) || ahora.bobinaG !== (antes.bobinaG ?? null)) cambios[pesoG] = ahora;
  });
  pesosQuitadosFr(filas, epp, pesos).forEach(g => { cambios[g] = n[g] > 0 ? { sinEnvase: true } : { bolsaPlu: null, bobinaG: null }; });
  if (Object.keys(cambios).length) body.pesos = cambios;
  return Object.keys(body).length ? body : null;
}
// Filas: los pesos del universo (pesos del GET /costeo) + los configurados que ya no tienen presentaciones (0), ascendente, cada uno con su envase
// (envasePorPeso: claves string, { bolsaPlu?, bobinaG?, bolsaNombre?, bolsaCosto? } o { sinEnvase: true }). El flag sinEnvase llega a la fila (sólo
// cuando es true: el servidor no manda false); la tabla muestra las que no lo tienen y la tira "Pesos sin envase", las que sí.
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
// Chip "Envase" de la barra de estado (filas de filasPesosFr), el primero que aplique: { texto, estado }. Cuenta sólo las filas visibles de la tabla:
// un peso sin envase a propósito (f.sinEnvase) no es "sin bolsa ni bobina". Si todos son así: info "todos sin envase".
function estadoEnvaseFr(todas, costoBobinaKg) {
  const filas = todas.filter(f => !f.sinEnvase);
  const sinCostoBolsa = filas.filter(f => f.bolsaPlu && f.bolsaCosto == null).length, sinNada = filas.filter(f => !f.bolsaPlu && !f.bobinaG).length;
  if (!todas.length) return { texto: 'sin pesos', estado: 'info' };
  if (!filas.length) return { texto: 'todos sin envase', estado: 'info' };
  if (costoBobinaKg == null && filas.some(f => f.bobinaG)) return { texto: 'falta costo de bobina', estado: 'falta' };
  if (sinCostoBolsa) return { texto: `${sinCostoBolsa} bolsa${sinCostoBolsa === 1 ? '' : 's'} sin costo`, estado: 'falta' };
  if (sinNada) return { texto: `${sinNada} sin bolsa ni bobina`, estado: 'info' };
  return { texto: 'todos con envase', estado: 'ok' };
}
// Productos de un peso (cf = cfFr): las presentaciones con ese pesoG de todos los graneles (con y sin subrubro), por nombre A→Z. envase = el que
// elige su granel en cf.porGranel (sin elegir, bolsa).
function productosDePesoFr(cf, pesoG) {
  const graneles = [...(cf.subrubrosSiga || []).flatMap(s => s.graneles || []), ...(cf.sinSubrubro || [])], porGranel = cf.porGranel || {};
  return graneles.flatMap(g => (g.presentaciones || []).filter(p => p.pesoG === pesoG).map(p => ({ plu: p.plu, nombre: p.nombre, granelPlu: g.plu, granelNombre: g.nombre,
    envase: (porGranel[g.plu] || {}).envase === 'bobina' ? 'bobina' : 'bolsa' }))).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
}
// Filtro del modal: todas las palabras en el nombre, el PLU, el granel o su PLU, sin mayúsculas ni tildes (coincideFr). Vacío = todos.
const filtrarProductosPesoFr = (productos, texto) => productos.filter(p => coincideFr(`${p.nombre} ${p.plu} ${p.granelNombre} ${p.granelPlu}`, texto));
// El envase que tiene hoy un peso (e = envasePorPeso[pesoG]): "Bolsa PLU 4521 (Zipper) · Bobina 8 g", o SIN_ENVASE_TXT_FR si es sinEnvase.
function textoEnvasePesoFr(e) {
  const x = e || {}, partes = [x.bolsaPlu && `Bolsa PLU ${x.bolsaPlu}${x.bolsaNombre ? ` (${x.bolsaNombre})` : ''}`,
    x.bobinaG > 0 && `Bobina ${String(x.bobinaG).replace('.', ',')} g`].filter(Boolean);
  if (x.sinEnvase) return SIN_ENVASE_TXT_FR;
  return partes.length ? partes.join(' · ') : 'Sin envase cargado';
}

if (typeof module === 'object' && module.exports) module.exports = { errorEnvaseFr, cuerpoEnvaseFr, errorCostoBobinaFr, erroresEnvaseFr,
  cuerpoCambiosEnvaseFr, filasPesosFr, pesoCortoFr, productosFr, costoBobinaUnidadFr, infoBolsaFr, estadoEnvaseFr,
  errorPesoNuevoFr, errorNuevoSinEnvaseFr, pesosQuitadosFr, pesosSinEnvaseFr, textoQuitadosFr, productosDePesoFr, filtrarProductosPesoFr, textoEnvasePesoFr };

// ── DOM ──
const elegidosFr = {}; // ponytail: plu → nombre de lo elegido con el buscador (la tabla aún no lo sabe por SIGA), estado de UI que se muta en el lugar
let seqNuevoFr = 0;    // ponytail: id de la próxima fila agregada a mano (n1, n2…) hasta que se guarda; estado de UI
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
// Bajo el peso: "34 productos" como botón que abre la lista (#dlgEvProductos); sin productos, texto plano. sinEnvase: el botón de la tira "Pesos sin envase".
function htmlProductosPesoFr(f, sinEnvase = false) {
  if (!f.presentaciones) return `<span>${esc(productosFr(0))}</span>`;
  const cuales = f.presentaciones === 1 ? 'el producto' : `los ${f.presentaciones} productos`;
  return `<button type="button" class="ev-prod-ver" data-prod-peso="${f.pesoG}"${sinEnvase ? ' data-sin-envase' : ''} aria-haspopup="dialog" aria-label="Ver ${cuales} de ${esc(pesoCortoFr(f.pesoG))}">${esc(productosFr(f.presentaciones))}</button>`;
}
// Celda del peso: el peso con sus productos o, en una fila nueva, el input para tipearlo (gramos enteros) con el chip "nuevo".
function htmlCeldaPesoFr(f, k) {
  if (!f.nuevo) return `<td class="fr-peso${f.presentaciones ? '' : ' fr-peso-vacio'}"><b>${esc(pesoCortoFr(f.pesoG))}</b>${htmlProductosPesoFr(f)}</td>`;
  return `<td class="ev-campo"><div class="ev-peso-fila">${campoU(`<input type="number" min="1" max="${PESO_MAX_FR}" step="1" data-k="pesoG" placeholder="ej. 750"
      aria-label="Peso en gramos de la fila nueva" aria-describedby="evErrPeso-${k}">`, 'g', { w: 'w-28' })}</div>
    <span class="fp-chip ev-chip-nuevo">nuevo</span><span class="ev-err" id="evErrPeso-${k}" hidden></span></td>`;
}
// Último botón de la fila: ✕ que la saca de la tabla; el aria-label y el title dicen el efecto. Fila nueva: se descarta. Peso sin productos: al guardar
// se borra su envase. Peso con productos: sus productos se costean sin envase y sin aviso (pasa a la tira "Pesos sin envase", de donde se vuelve a poner).
function htmlAccionFilaFr(f) {
  const quien = f.nuevo ? 'la fila nueva' : `el peso ${esc(pesoCortoFr(f.pesoG))}`, efecto = f.presentaciones ? efectoQuitarFr(f.presentaciones) + ' sin envase' : '';
  const titulo = f.nuevo ? 'Quitar esta fila' : f.presentaciones ? `Quitar este peso: ${efecto} y sin aviso. Después lo podés volver a poner` : 'Quitar este peso de la lista: al guardar se borra su envase';
  return `<button type="button" class="ev-quitar btn-quitar" aria-label="Quitar ${quien}${efecto ? `: ${efecto}` : ''}" title="${titulo}">✕</button>`;
}
// Una fila. f = { pesoG, presentaciones, bolsaPlu?, bobinaG?, bolsaNombre?, bolsaCosto? } o, agregada a mano, { nuevo: 'n1', presentaciones: 0 } (sin pesoG:
// se tipea en su primera celda, así que los ids de aria no salen de él).
function htmlFilaPesoFr(f) {
  const k = f.nuevo || f.pesoG, peso = f.nuevo ? 'la fila nueva' : esc(pesoCortoFr(f.pesoG));
  return `<tr ${f.nuevo ? `class="ev-nueva" data-nuevo="${k}"` : `data-peso="${k}"`}>${htmlCeldaPesoFr(f, k)}
    <td class="ev-campo"><div class="ev-plu-fila"><input type="text" inputmode="numeric" autocomplete="off" class="num-in text-left ev-plu" data-k="bolsaPlu" value="${esc(f.bolsaPlu || '')}"
        placeholder="ej. 4521" aria-label="PLU de la bolsa de ${peso}" aria-describedby="evNota-${k} evErrPlu-${k}">
      <button type="button" class="ev-buscar cfg-btn2" aria-label="Buscar la bolsa de ${peso} en SIGA">Buscar</button></div>
      <span class="ev-nota" id="evNota-${k}">${htmlNotaBolsaFr(infoBolsaFr(f.bolsaPlu || '', f))}</span><span class="ev-err" id="evErrPlu-${k}" hidden></span></td>
    <td class="ev-campo ev-col-bobina"><div class="ev-bob-fila">${campoU(`<input type="number" min="0" max="${BOBINA_G_MAX_FR}" step="any" data-k="bobinaG" value="${esc(f.bobinaG ?? '')}"
        placeholder="ej. 8" aria-label="Gramos de bolsa para ${peso} (por bobina)" aria-describedby="evBob-${k} evErrG-${k}">`, 'g', { w: 'w-28' })}
      <span class="ev-bob" id="evBob-${k}">${htmlCostoBobinaFr(f.bobinaG, cfFr.costoBobinaKg)}</span></div><span class="ev-err" id="evErrG-${k}" hidden></span></td>
    <td class="ev-acc">${htmlAccionFilaFr(f)}</td></tr>`;
}
// Las filas de la tabla al pintarla: todas menos los pesos guardados sin envase (esos van a la tira).
const filasVisiblesFr = () => filasPesosFr(cfFr.pesos, cfFr.envasePorPeso).filter(f => !f.sinEnvase);
// La tabla va siempre (aunque no haya filas): "+ Agregar peso" necesita dónde poner la fila nueva. Sin filas el CSS esconde el encabezado
// y muestra el texto de vacío (table:has(>tbody:empty)+.fr-vacio): el <tbody> no puede llevar espacios.
function htmlTablaPesosFr() {
  const filas = filasVisiblesFr();
  return `<table class="cfg-tabla fr-filas ev-tabla w-full" id="evTabla"><caption class="sr-only">Envase de cada peso de presentación</caption>
    <thead><tr><th scope="col">Peso</th>
      <th scope="col" class="ev-grupo">Si el producto va por BOLSA<span>PLU de la bolsa en SIGA y su costo</span></th>
      <th scope="col" class="ev-grupo ev-col-bobina">Si va por BOBINA<span>Gramos de bolsa y su costo por unidad (con el costo del paso 1)</span></th>
      <th scope="col"><span class="sr-only">Quitar el peso</span></th></tr></thead>
    <tbody>${filas.map(htmlFilaPesoFr).join('')}</tbody></table>
    <p class="fr-vacio ev-vacio">No hay pesos en la tabla. Se arman con las presentaciones de Fraccionado que tienen el peso escrito en su nombre
      (por ejemplo «ALMENDRAS 500G»). Si falta uno, agregalo abajo.</p>`;
}
// Tira "Pesos sin envase" (#evSinEnvase), bajo la tabla: los pesos sin envase (guardados o recién quitados) con sus productos (abre el modal) y "Volver a poner".
const listaSinEnvaseFr = filas => pesosSinEnvaseFr(filas, filasPesosFr(cfFr.pesos, cfFr.envasePorPeso));
const htmlItemSinEnvaseFr = p => `<li class="ev-sin-item"><b>${esc(pesoCortoFr(p.pesoG))}</b><span class="ev-sin-prod">${htmlProductosPesoFr(p, true)}</span>
  <button type="button" class="ev-poner cfg-btn2" data-poner="${esc(p.pesoG)}" aria-label="Volver a poner el peso ${esc(pesoCortoFr(p.pesoG))}">Volver a poner</button></li>`;
const htmlSinEnvaseFr = lista => `<h5 class="ev-sin-t" id="evSinT">Pesos sin envase</h5>
  <p class="ev-sin-ayuda">Estos pesos no suman costo de envase y no avisan. Volvé a ponerlos para cargarles bolsa o bobina.</p>
  <ul class="ev-sin-lista">${lista.map(htmlItemSinEnvaseFr).join('')}</ul>`;
const htmlTiraSinEnvaseFr = () => { const lista = listaSinEnvaseFr(filasVisiblesFr());
  return `<section class="ev-sin" id="evSinEnvase" aria-labelledby="evSinT"${lista.length ? '' : ' hidden'}>${htmlSinEnvaseFr(lista)}</section>`; };
const htmlPasoBobinaFr = () => `<section class="ev-paso" aria-labelledby="evT1"><h4 class="ev-paso-t" id="evT1"><span class="fr-n" aria-hidden="true">1</span>Costo de la bobina</h4>
    <div class="ev-paso-cuerpo ev-campo"><div class="ev-bobina">${campoU(`<input type="number" id="frBobinaKg" data-k="costoBobinaKg" min="0" max="${COSTO_BOBINA_MAX_FR}" step="any"
        value="${esc(cfFr.costoBobinaKg ?? '')}" placeholder="ej. 6000" aria-label="Costo de la bobina, en pesos por kilo" aria-describedby="evAyudaBobina evErrBobina">`, '$/kg', { w: 'w-40' })}
      <span class="ev-hint" id="evAyudaBobina">Lo que cuesta un kilo de bobina. Es el mismo para todos los pesos de abajo; si lo cambiás, sus costos se recalculan.</span></div>
      <span class="ev-err" id="evErrBobina" hidden></span></div></section>`;
const htmlPasoPesosFr = () => `<section class="ev-paso" aria-labelledby="evT2"><h4 class="ev-paso-t" id="evT2"><span class="fr-n" aria-hidden="true">2</span>Envase de cada peso</h4>
    <p class="ev-paso-ayuda">Cada peso tiene su envase, igual para todos los productos de ese peso. Podés cargar la bolsa, la bobina o las dos: no se pisan y cada producto usa la que elija.
      Dejá vacío lo que no uses. Con la ✕ quitás un peso: sus productos se costean sin envase y sin aviso, hasta que lo vuelvas a poner.</p>
    <div id="evTablaWrap">${htmlTablaPesosFr()}</div>
    <p class="ev-quitados" id="evQuitados" role="status" aria-live="polite"></p>
    <div class="ev-agregar-fila"><button type="button" class="ev-agregar cfg-btn2" data-edita aria-describedby="evAyudaAgregar">+ Agregar peso</button>
      <span class="ev-hint" id="evAyudaAgregar">¿Falta un peso? Agregalo: vale para todos los productos de ese peso.</span></div>
    ${htmlTiraSinEnvaseFr()}</section>`;
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
  const fila = e => (e.nuevo ? `tr[data-nuevo="${e.nuevo}"]` : `tr[data-peso="${e.pesoG}"]`); // una fila nueva no tiene peso todavía: se la busca por su id
  const campo = e => (e.campo === 'costoBobinaKg' ? card.querySelector('#frBobinaKg') : card.querySelector(`${fila(e)} [data-k="${e.campo}"]`));
  errores.forEach(e => marcarErrorFr(campo(e), e.mensaje));
  campo(errores[0]).focus();
  msgEsq(card.querySelector('.esq-msg'), `Hay ${errores.length} campo${errores.length === 1 ? '' : 's'} para corregir (marcados en rojo)`, 'text-crit');
}

// Un número que no se puede leer (texto en un campo numérico) no se confunde con vacío.
const leerCampoFr = i => (i.validity && i.validity.badInput ? 'x' : i.value);
// Recalcula, sin guardar, lo que depende de lo tipeado en una fila: la nota de la bolsa, el costo por unidad de la bobina.
function refrescarFilaFr(tr) {
  const f = (cfFr.envasePorPeso || {})[tr.dataset.peso] || {}, plu = tr.querySelector('[data-k="bolsaPlu"]').value, g = tr.querySelector('[data-k="bobinaG"]');
  tr.querySelector('.ev-nota').innerHTML = htmlNotaBolsaFr(infoBolsaFr(plu, f, elegidosFr));
  tr.querySelector('.ev-bob').innerHTML = htmlCostoBobinaFr(numOrNull(g.value), numOrNull(document.getElementById('frBobinaKg').value));
}
// La tabla como la leen el guardado y el aviso de lo quitado: [{ pesoG, plu, g }] (texto de los inputs); una fila nueva, además { nuevo } y su peso tipeado.
function leerFilasEnvaseFr(card) {
  return [...card.querySelectorAll('#evTabla tbody tr')].map(tr => {
    const peso = tr.querySelector('[data-k="pesoG"]'), campos = { plu: tr.querySelector('[data-k="bolsaPlu"]').value, g: leerCampoFr(tr.querySelector('[data-k="bobinaG"]')) };
    return peso ? { nuevo: tr.dataset.nuevo, pesoG: leerCampoFr(peso), ...campos } : { pesoG: Number(tr.dataset.peso), ...campos };
  });
}
function guardarEnvaseFr(card) {
  const costo = leerCampoFr(card.querySelector('#frBobinaKg')), filas = leerFilasEnvaseFr(card);
  card.querySelectorAll('[aria-invalid]').forEach(limpiarErrorFr);
  const errores = erroresEnvaseFr(costo, filas, new Set(listaSinEnvaseFr(filas).map(x => x.pesoG)));
  if (errores.length) return avisarErroresEnvaseFr(card, errores);
  const body = cuerpoCambiosEnvaseFr(costo, filas, cfFr.costoBobinaKg, cfFr.envasePorPeso, cfFr.pesos);
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
// El peso de la fila: el de la tabla o, en una fila nueva, el que lleva tipeado (NaN si todavía no vale).
const pesoDeFilaFr = tr => Number(tr.dataset.peso || (tr.querySelector('[data-k="pesoG"]') || {}).value);
function abrirBuscadorBolsaFr(tr) {
  const d = document.getElementById('dlgFP'), plu = tr.querySelector('[data-k="bolsaPlu"]'), g = pesoDeFilaFr(tr);
  d.querySelector('.fp-dlg-titulo').textContent = `Buscar la bolsa de ${g > 0 ? pesoCortoFr(g) : 'la fila nueva'}`;
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

// Agregar, quitar y volver a poner pesos. Nada se guarda hasta el Guardar: la tarjeta queda "sin guardar", lo quitado se anuncia bajo la tabla y la tira
// "Pesos sin envase" muestra los que quedaron sin envase.
// La lista cambió (se tipeó un peso, se quitó una fila o se volvió a poner): un "ya está en la lista" / "está en Pesos sin envase" puede haber dejado
// de valer, puede haber un reemplazo y la tira cambia.
function refrescarPesosFr(card) {
  card.querySelectorAll('[data-k="pesoG"][aria-invalid]').forEach(i => { if ([PESO_REPETIDO_FR, PESO_EN_TIRA_FR].includes(errDeFr(i).textContent)) limpiarErrorFr(i); });
  const filas = leerFilasEnvaseFr(card), tira = card.querySelector('#evSinEnvase'), lista = listaSinEnvaseFr(filas);
  card.querySelector('#evQuitados').textContent = textoQuitadosFr(pesosQuitadosFr(filas, cfFr.envasePorPeso, cfFr.pesos), presentacionesPorPesoFr(cfFr.pesos));
  tira.innerHTML = htmlSinEnvaseFr(lista);
  tira.hidden = !lista.length;
}
// "+ Agregar peso": fila nueva al final con el foco en su peso. No se reordena mientras se tipea: se ordena al guardar (la tarjeta se repinta).
function agregarPesoFr(card) {
  seqNuevoFr += 1;
  const cuerpo = card.querySelector('#evTabla tbody');
  cuerpo.insertAdjacentHTML('beforeend', htmlFilaPesoFr({ nuevo: `n${seqNuevoFr}`, presentaciones: 0 }));
  cuerpo.lastElementChild.querySelector('[data-k="pesoG"]').focus();
  msgEsq(card.querySelector('.esq-msg'), '');
}
// ✕ de cualquier fila: sale de la tabla (el foco pasa al botón de la fila de al lado, o a "+ Agregar peso"). Un peso con productos pasa a la tira "Pesos sin envase".
function quitarPesoFr(card, tr) {
  const vecina = tr.nextElementSibling || tr.previousElementSibling;
  tr.remove();
  marcarSucio(card); // la fila ya no está: el listener de data-edita de Configuración no encuentra la tarjeta
  msgEsq(card.querySelector('.esq-msg'), '');
  refrescarPesosFr(card);
  ((vecina && vecina.querySelector('.ev-acc button:not(:disabled)')) || card.querySelector('.ev-agregar')).focus();
}
// "Volver a poner" de la tira: la fila del peso vuelve a la tabla en su lugar (ascendente), editable y con lo que tenga guardado (vacía si estaba guardado sin
// envase; si apenas se había quitado, lo de antes: es deshacer). El foco va a su PLU. Al guardar, un peso guardado sin envase manda sinEnvase: false.
function ponerPesoFr(card, pesoG) {
  const f = filasPesosFr(cfFr.pesos, cfFr.envasePorPeso).find(x => x.pesoG === pesoG), cuerpo = card.querySelector('#evTabla tbody');
  if (!f) return;
  const despues = [...cuerpo.children].find(tr => Number(tr.dataset.peso) > pesoG), html = htmlFilaPesoFr(f);
  if (despues) despues.insertAdjacentHTML('beforebegin', html); else cuerpo.insertAdjacentHTML('beforeend', html);
  const tr = despues ? despues.previousElementSibling : cuerpo.lastElementChild;
  marcarSucio(card); // el botón de la tira se repinta: el listener de data-edita de Configuración no encontraría la tarjeta
  msgEsq(card.querySelector('.esq-msg'), '');
  refrescarPesosFr(card);
  tr.querySelector('[data-k="bolsaPlu"]').focus();
}
// Modal de los productos de un peso (#dlgEvProductos): solo lectura, con buscador y contador. Todo lo que viene de SIGA pasa por esc().
const htmlProductoPesoFr = p => `<li><b>${esc(p.nombre)}</b><span>PLU ${esc(p.plu)} · Granel: ${esc(p.granelNombre)}${p.envase ? ` · Usa: ${p.envase === 'bobina' ? 'Bobina' : 'Bolsa'}` : ''}</span></li>`;
// Lo que se ve para un texto buscado: { cuenta, html } (la lista, o el aviso de que nada coincide).
function vistaProductosPesoFr(lista, texto) {
  const vistos = filtrarProductosPesoFr(lista, texto);
  return { cuenta: `Mostrando ${vistos.length} de ${lista.length}`,
    html: vistos.length ? `<ul class="ev-prod-lista">${vistos.map(htmlProductoPesoFr).join('')}</ul>` : `<p class="ev-prod-vacio">Ningún producto coincide con «${esc(texto.trim())}»</p>` };
}
// El foco entra al buscador y, al cerrar (botón o Esc), vuelve al botón que abrió el modal. Se muestra lo guardado (cfFr), no lo tipeado en la tabla.
function abrirProductosPesoFr(pesoG, opener, sinEnvase = false) {
  const e = (cfFr.envasePorPeso || {})[pesoG], sin = sinEnvase || !!(e && e.sinEnvase); // sinEnvase: abierto desde la tira (también un peso recién quitado, sin guardar)
  const d = document.getElementById('dlgEvProductos'), bus = d.querySelector('.ev-prod-bus'), lista = productosDePesoFr(cfFr, pesoG).map(p => (sin ? { ...p, envase: null } : p));
  const pintar = () => {
    const v = vistaProductosPesoFr(lista, bus.value), cuerpo = d.querySelector('.ev-prod-cuerpo');
    d.querySelector('.ev-prod-cuenta').textContent = v.cuenta;
    cuerpo.innerHTML = v.html;
    cuerpo.scrollTop = 0;
  };
  d.querySelector('.ev-prod-titulo').textContent = `Productos de ${pesoCortoFr(pesoG)}`;
  d.querySelector('.ev-prod-envase').textContent = sin ? SIN_ENVASE_TXT_FR : `Envase: ${textoEnvasePesoFr(e)}`;
  bus.value = '';
  bus.oninput = pintar;
  d.querySelector('.ev-prod-cerrar').onclick = () => d.close();
  d.addEventListener('close', () => opener.focus(), { once: true });
  pintar();
  d.showModal();
  bus.focus();
}
function conectarPesosFr(card) {
  card.oninput = e => {
    const i = e.target;
    if (!i.matches('input[data-k]')) return;
    limpiarErrorFr(i);
    msgEsq(card.querySelector('.esq-msg'), '');
    if (i.id === 'frBobinaKg') card.querySelectorAll('#evTabla tbody tr').forEach(refrescarFilaFr); // el costo de la bobina mueve todas las filas
    else if (i.matches('[data-k="pesoG"]')) refrescarPesosFr(card);
    else refrescarFilaFr(i.closest('tr'));
  };
  card.onclick = e => {
    const b = e.target.closest('.ev-buscar, .ev-poner, .ev-quitar, .ev-agregar, .ev-prod-ver');
    if (!b) return;
    if (b.matches('.ev-prod-ver')) abrirProductosPesoFr(Number(b.dataset.prodPeso), b, b.dataset.sinEnvase !== undefined);
    else if (b.matches('.ev-agregar')) agregarPesoFr(card);
    else if (b.matches('.ev-quitar')) quitarPesoFr(card, b.closest('tr'));
    else if (b.matches('.ev-poner')) ponerPesoFr(card, Number(b.dataset.poner));
    else abrirBuscadorBolsaFr(b.closest('tr'));
  };
  card.querySelector('.fr-guardar').onclick = () => guardarEnvaseFr(card);
}
