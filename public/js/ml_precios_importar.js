// ── Vínculos: importar el cruce PLU Siga <-> Código ML pegado desde Excel (POST /vinculos/importar) ──
const IMP_MAX_FILAS = 2000;
const IMP_MAX_LISTA = 50;
const REGEX_MLA = /^MLA\d+$/i;
const REGEX_CABECERA = /plu|c[oó]digo|codigo|mla|siga|publicaci|cantidad|unidades/i;

let impResp = null; // respuesta de la última revisión
let impClave = null; // texto + opción con las que se hizo esa revisión
let impPares = []; // pares {id, codigo} parseados

// Cada línea: un token MLA (id) y uno o dos enteros, en cualquier orden, separados por tab, ; , o espacios.
// Con dos enteros: el que está antes del MLA es el PLU y el de después la cantidad (si ambos quedan del mismo lado,
// el primero es el PLU y el segundo la cantidad). La cantidad es un entero de 1 a 9999.
function parsearCruce(texto) {
  const vistos = new Set();
  const filas = [];
  const noReconocidas = [];
  for (const linea of String(texto).split(/\r?\n/)) {
    const tokens = linea.split(/[\t;]/.test(linea) ? /[\t;\s]+/ : /[,\s]+/).filter(Boolean); // con tab o ; la coma es de miles, no separa
    if (!tokens.length) continue;
    const par = parLinea(linea, tokens);
    if (par) {
      const k = `${par.id}|${par.codigo}|${par.unidades ?? ''}`;
      if (!vistos.has(k)) { vistos.add(k); filas.push(par); } // un par idéntico repetido cuenta una vez
      continue;
    }
    if (!tokens.some(t => REGEX_MLA.test(t) || /^\d+$/.test(t)) && REGEX_CABECERA.test(linea)) continue; // encabezado
    noReconocidas.push(linea.trim());
  }
  return { filas, noReconocidas };
}

function parLinea(linea, tokens) {
  if (tokens.length < 2 || tokens.length > 3) return null;
  if (!/[\t;]/.test(linea) && /\d,\d{3}(?!\d)/.test(linea)) return null; // "2,309": separador de miles, no dos columnas
  const iMla = tokens.findIndex(t => REGEX_MLA.test(t));
  if (iMla < 0 || tokens.filter(t => REGEX_MLA.test(t)).length !== 1) return null;
  const enteros = tokens.map((t, i) => ({ t, i })).filter(x => x.i !== iMla);
  if (!enteros.every(x => /^\d+$/.test(x.t))) return null;
  const id = tokens[iMla].toUpperCase();
  if (enteros.length === 1) return { id, codigo: Number(enteros[0].t) };
  const antes = enteros.filter(x => x.i < iMla), despues = enteros.filter(x => x.i > iMla);
  const [plu, cant] = antes.length === 1 && despues.length === 1 ? [antes[0], despues[0]] : [enteros[0], enteros[1]];
  const unidades = Number(cant.t);
  if (!(unidades >= 1 && unidades <= 9999)) return null;
  return { id, codigo: Number(plu.t), unidades };
}

const impClaveActual = () => `${$('imp-texto').value}\u0000${$('imp-pisar').checked}\u0000${$('imp-estimar').checked}`;

function impPostear(soloValidar) {
  return api('/api/ml-precios/vinculos/importar', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filas: impPares, pisar: $('imp-pisar').checked, soloValidar, estimarPeso: $('imp-estimar').checked }),
  });
}

// Lista expandible de un grupo con problemas: máx 50 líneas y botón para copiar todas.
function grupoHtml(clave, titulo, lineas, tono) {
  if (!lineas.length) return '';
  const visibles = lineas.slice(0, IMP_MAX_LISTA).map(l => `<li>${escHtml(l)}</li>`).join('');
  const mas = lineas.length > IMP_MAX_LISTA ? `<li class="t-gris">&hellip;y ${fmtInt(lineas.length - IMP_MAX_LISTA)} más</li>` : '';
  return `<details class="imp-grupo"><summary class="${tono}">${escHtml(titulo)}: ${fmtInt(lineas.length)}</summary>
    <ul class="imp-lista num">${visibles}${mas}</ul>
    <button type="button" class="btn btn-secundario sm" data-copiar-lista="${clave}">Copiar lista</button></details>`;
}

let impListas = {}; // clave -> todas las líneas (para copiar)

function lineasDe(r) {
  return {
    omitidos: (r.omitidosExistentes || []).map(String),
    invalidas: (r.invalidas || []).map(x => `${x.id} · ${x.codigo} — ${x.motivo}`),
    conflictos: (r.conflictos || []).map(x => `${x.id}: códigos ${(x.codigos || []).join(', ')}${(x.unidades || []).length ? ` · cantidades ${x.unidades.join(', ')}` : ''}`),
    inexistentes: (r.codigosInexistentes || []).map(x => `${x.id} · ${x.codigo}`),
    fuera: (r.fueraDeBajada || []).map(String),
    sinPeso: (r.sinPesoEstimado || []).map(x => `${x.id} · ${x.codigo} — ${x.nombre ?? ''}${x.motivo ? ` (${x.motivo})` : ''}`),
  };
}

function resumenImportHtml(r) {
  impListas = lineasDe(r);
  const tarjeta = (v, l, tono) => `<div><div class="l">${l}</div><div class="v ${tono || ''}">${fmtInt(v)}</div></div>`;
  const sinBajada = r.enBajada === 0 || !(datos && (datos.filas || []).length);
  return `<div class="comparar imp-cards">
      ${tarjeta(r.nuevos, 'Nuevos', 't-ok')}${tarjeta(r.actualizados, 'Actualizados')}
      ${tarjeta(impListas.omitidos.length, 'Ya vinculadas (omitidas)')}${tarjeta(impListas.invalidas.length, 'Inválidas', impListas.invalidas.length ? 't-crit' : '')}
      ${tarjeta(impListas.conflictos.length, 'Conflictos', impListas.conflictos.length ? 't-crit' : '')}${tarjeta(impListas.inexistentes.length, 'No existen en SIGA', impListas.inexistentes.length ? 't-crit' : '')}
      ${tarjeta(r.pesosEstimados || 0, 'Pesos estimados')}${tarjeta(impListas.sinPeso.length, 'Sin peso estimado', impListas.sinPeso.length ? 't-warn' : '')}
    </div>
    ${grupoHtml('omitidos', 'Ya vinculadas (se omiten)', impListas.omitidos, 't-warn')}
    ${grupoHtml('invalidas', 'Inválidas', impListas.invalidas, 't-crit')}
    ${grupoHtml('conflictos', 'Conflictos (la misma publicación con códigos distintos)', impListas.conflictos, 't-crit')}
    ${grupoHtml('inexistentes', 'Códigos que no existen en SIGA', impListas.inexistentes, 't-crit')}
    ${grupoHtml('sinPeso', 'Sin peso estimado (cargalo a mano en Vínculos)', impListas.sinPeso, 't-warn')}
    ${grupoHtml('fuera', 'Publicaciones fuera de la bajada de ML (informativo)', impListas.fuera, 't-gris')}
    ${sinBajada ? '<p class="text-sm t-warn mt-2">Importá la bajada de ML para ver los faltantes.</p>' : ''}`;
}

function impRefrescarEstado() {
  const vigente = impResp && impClave === impClaveActual();
  const algo = vigente && (impResp.nuevos + impResp.actualizados) > 0;
  $('imp-importar').disabled = !algo;
  $('imp-revisar').disabled = !impPares.length;
  if (impResp && !vigente) $('imp-resumen').innerHTML = '<p class="text-sm t-warn">Cambió el texto o la opción: volvé a revisar.</p>';
}

function impAnalizarTexto() {
  const { filas, noReconocidas } = parsearCruce($('imp-texto').value);
  impPares = filas;
  let msg = filas.length ? `${fmtInt(filas.length)} pares reconocidos.` : 'Todavía no hay pares reconocidos.';
  if (filas.length > IMP_MAX_FILAS) msg = `Hay ${fmtInt(filas.length)} pares: el máximo por importación es ${fmtInt(IMP_MAX_FILAS)}.`;
  $('imp-parseo').innerHTML = `${escHtml(msg)}${noReconocidas.length ? `<div class="t-warn mt-1">${fmtInt(noReconocidas.length)} líneas no reconocidas${noReconocidas.length > 5 ? ' (primeras 5)' : ''}:<ul class="imp-lista">${noReconocidas.slice(0, 5).map(l => `<li>${escHtml(l)}</li>`).join('')}</ul></div>` : ''}`;
  if (filas.length > IMP_MAX_FILAS) impPares = [];
  impRefrescarEstado();
}

function impError(texto) { const e = $('imp-error'); e.hidden = !texto; e.textContent = texto || ''; }

async function impRevisar() {
  impError('');
  const btn = $('imp-revisar');
  btn.disabled = true; btn.textContent = 'Revisando...';
  const clave = impClaveActual();
  try {
    impResp = await impPostear(true);
    impClave = clave;
    $('imp-resumen').innerHTML = resumenImportHtml(impResp);
  } catch (err) {
    impResp = null;
    $('imp-resumen').innerHTML = '';
    impError(`No se pudo revisar: ${err.message}`);
  } finally {
    btn.textContent = 'Revisar';
    impRefrescarEstado();
  }
}

async function impImportar() {
  if (!impResp || impClave !== impClaveActual()) return;
  impError('');
  const btn = $('imp-importar');
  btn.disabled = true; btn.textContent = 'Importando...';
  try {
    const r = await impPostear(false);
    const n = (r.nuevos || 0) + (r.actualizados || 0);
    $('dlg-importar').close();
    await refrescarTrasCambio();
    const pesos = $('imp-estimar').checked ? ` Pesos estimados: ${fmtInt(r.pesosEstimados || 0)}; sin peso: ${fmtInt((r.sinPesoEstimado || []).length)}.` : '';
    avisar(`Importados ${fmtInt(n)}.${pesos} Los faltantes están en Control → Sin vincular.`, undefined,
      { texto: 'Ver faltantes', fn: () => { location.hash = 'control'; fijarGrupo('sin_vincular'); } });
  } catch (err) {
    impError(`No se importó: ${err.message}`);
  } finally {
    btn.textContent = 'Importar';
    impRefrescarEstado();
  }
}

function abrirImportar() {
  $('imp-texto').value = ''; $('imp-pisar').checked = false; $('imp-estimar').checked = true;
  impResp = null; impClave = null; impPares = [];
  $('imp-resumen').innerHTML = ''; impError('');
  impAnalizarTexto();
  $('dlg-importar').showModal();
  $('imp-texto').focus();
}

$('vin-importar').addEventListener('click', abrirImportar);
$('imp-cerrar').addEventListener('click', () => $('dlg-importar').close());
$('dlg-importar').addEventListener('click', e => { if (e.target === $('dlg-importar')) $('dlg-importar').close(); });
$('imp-texto').addEventListener('input', impAnalizarTexto);
$('imp-pisar').addEventListener('change', impRefrescarEstado);
$('imp-estimar').addEventListener('change', impRefrescarEstado);
$('imp-revisar').addEventListener('click', impRevisar);
$('imp-importar').addEventListener('click', impImportar);
$('imp-resumen').addEventListener('click', async e => {
  const b = e.target.closest('[data-copiar-lista]');
  if (!b) return;
  const ok = await copiarTexto((impListas[b.dataset.copiarLista] || []).join('\n'));
  const antes = b.textContent;
  b.textContent = ok ? 'Copiada' : 'No se pudo copiar';
  setTimeout(() => { b.textContent = antes; }, 1500);
});
