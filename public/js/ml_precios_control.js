// ── Tab Control: resumen, lista priorizada, vinculación en la fila, copiar precio sugerido e importar ──
const GRUPOS = {
  pend: f => f.estado !== 'ok',
  desviada: f => f.estado === 'desviada',
  sin_vincular: f => f.estado === 'sin_vincular',
  sin_peso: f => f.estado === 'sin_peso',
  datos: f => ['sin_carta', 'sin_precio'].includes(f.estado),
  ok: f => f.estado === 'ok',
  todas: () => true,
};
const RANGO_ESTADO = { desviada: 0, sin_vincular: 1, sin_carta: 2, sin_precio: 2, sin_peso: 2, ok: 3 };
const NOTA_ESTADO = {
  sin_carta: 'El producto no tiene precio de carta en SIGA.',
  sin_precio: 'La publicación no tiene precio en ML.',
  sin_peso: 'El precio de SIGA es por kg y falta el peso de la publicación.',
  ok: 'Precio en orden.',
};
const COLUMNAS = [
  { k: 'pub', t: 'Publicación' }, { k: null, t: 'Producto en SIGA' }, { k: 'ml', t: 'Precio actual (ML)', num: true },
  { k: 'esperado', t: 'Precio nuevo', num: true }, { k: 'dif', t: 'Diferencia', num: true }, { k: null, t: 'Estado y qué hacer' },
];

const abiertos = new Set(); // ids de principales con el desplegable de vinculadas abierto
let editor = null; // { id, codigo, unidades, peso, cuotas } de la fila que se está vinculando/editando
let prefs = leerPrefs();

const difDe = f => (num(f.esperado) !== null && num(f.precioMl) !== null ? f.precioMl - f.esperado : null);
const valorOrden = {
  pub: f => String(f.titulo || '').toLowerCase(), ml: f => num(f.precioMl), esperado: f => num(f.esperado), dif: f => difDe(f),
};

function filasActivas() {
  return (datos.filas || []).filter(f => prefs.activa === 'todas' || (prefs.activa === 'activas') === !!f.activa);
}

function ordenar(filas) {
  const get = valorOrden[prefs.orden];
  if (!get) { // prioridad: lo accionable primero; en desviadas, mayor diferencia en $
    const peso = f => (f.estado === 'desviada' ? Math.abs(difDe(f) ?? 0) : 0);
    return filas.sort((a, b) => RANGO_ESTADO[a.estado] - RANGO_ESTADO[b.estado] || peso(b) - peso(a) || String(a.titulo).localeCompare(String(b.titulo), 'es'));
  }
  const m = prefs.dir === 'asc' ? 1 : -1;
  return filas.sort((a, b) => {
    const x = get(a), y = get(b);
    if (x === null || y === null) return (x === null) - (y === null); // sin valor, al final
    return (typeof x === 'string' ? x.localeCompare(y, 'es') : x - y) * m;
  });
}

// Una fila por grupo (la principal); el grupo se muestra si alguna de sus publicaciones pasa los filtros.
function filtrar() {
  const q = $('f-buscar').value.trim().toLowerCase();
  const pasan = filasActivas()
    .filter(GRUPOS[prefs.grupo] || GRUPOS.pend)
    .filter(f => !q || `${f.id} ${f.titulo} ${f.nombreProducto ?? ''} ${f.codigo ?? ''}`.toLowerCase().includes(q));
  const ids = new Set(pasan.map(f => f.principal));
  return ordenar((datos.filas || []).filter(f => f.esPrincipal && ids.has(f.id)));
}
const hijasDe = f => (datos.filas || []).filter(x => x.principal === f.id && !x.esPrincipal);

// ── Resumen ──────────────────────────────────────────────────────────────────
function renderResumen() {
  const filas = filasActivas();
  const n = { desviada: 0, sin_vincular: 0, sin_peso: 0, datos: 0, ok: 0 };
  for (const f of filas) n[['ok', 'desviada', 'sin_vincular', 'sin_peso'].includes(f.estado) ? f.estado : 'datos']++;
  const total = filas.length;
  const pct = total ? Math.round(n.ok / total * 100) : 0;
  const pend = total - n.ok;
  $('res-titulo').textContent = total ? `${pct} % en precio` : 'Sin publicaciones';
  $('res-sub').textContent = total ? (pend ? `${fmtInt(pend)} de ${fmtInt(total)} publicaciones necesitan atención` : `Las ${fmtInt(total)} publicaciones están bien`) : 'No hay publicaciones con este filtro de estado.';
  const tramo = (v, color) => (v ? `<i style="width:${v / total * 100}%;background:${color}"></i>` : '');
  $('res-barra').innerHTML = total ? tramo(n.ok, '#0e700e') + tramo(n.desviada, '#a4262c') + tramo(n.sin_vincular, '#e0a800') + tramo(n.sin_peso, '#e0a800') + tramo(n.datos, '#9a9d92') : '';
  const items = [
    { g: 'desviada', lbl: 'Desviadas', val: n.desviada, sub: 'Corregir el precio en ML', tono: 't-crit' },
    { g: 'sin_vincular', lbl: 'Sin vincular', val: n.sin_vincular, sub: 'Asociar a un producto de SIGA', tono: 't-warn' },
    { g: 'sin_peso', lbl: 'Sin peso', val: n.sin_peso, sub: 'Precio por kg sin peso cargado', tono: 't-warn' },
    { g: 'datos', lbl: 'Faltan datos', val: n.datos, sub: 'Sin carta o sin precio', tono: 't-gris' },
    { g: 'ok', lbl: 'En precio', val: n.ok, sub: `Dentro de ±${config ? config.toleranciaPct : '…'} %`, tono: 't-ok' },
  ];
  $('kpis').innerHTML = items.map(i => `<button type="button" class="kpi${prefs.grupo === i.g ? ' on' : ''}" data-grupo="${i.g}" aria-pressed="${prefs.grupo === i.g}">
    <div class="val ${i.val ? i.tono : 't-gris'}">${fmtInt(i.val)}</div><div class="lbl">${i.lbl}</div><div class="sub">${escHtml(i.sub)}</div></button>`).join('');
}

// ── Tabla ────────────────────────────────────────────────────────────────────
function difHtml(f) {
  const dif = difDe(f), d = num(f.desvioPct);
  if (dif === null) return '<span class="t-gris">-</span>';
  const clase = f.estado === 'ok' ? 't-ok' : dif < 0 ? 't-crit' : 't-warn';
  return `<div class="font-semibold ${clase}">${fmtDif(dif)}</div><div class="text-xs ${clase}">${d === null ? '' : signo(d) + fmtPct(Math.abs(d))}</div>`;
}

function accionHtml(f) {
  const id = escHtml(f.id);
  const calc = num(f.esperado) !== null ? `<button type="button" class="link-btn" data-act="calc" data-id="${id}">Ver cálculo</button>` : '';
  if (f.estado === 'desviada') {
    const debajo = difDe(f) < 0;
    return `<span class="chip ${debajo ? 'chip--crit' : 'chip--warn'}">${debajo ? 'Cobrás de menos' : 'Cobrás de más'}</span>
      <button type="button" class="btn btn-primario sm" data-act="copiar" data-id="${id}" title="Copia el precio esperado para pegarlo en ML">Copiar ${fmtMoney(f.esperado)}</button>${calc}`;
  }
  if (f.estado === 'sin_vincular') {
    return `<span class="chip chip--warn">Sin vincular</span><button type="button" class="btn btn-primario sm" data-act="vincular" data-id="${id}">Vincular</button>`;
  }
  if (f.estado === 'sin_peso') {
    return `<span class="chip chip--warn">Sin peso</span><span class="nota">${escHtml(NOTA_ESTADO.sin_peso)}</span><button type="button" class="btn btn-primario sm" data-act="cargar-peso" data-id="${id}">Cargar peso</button>`;
  }
  const chip = f.estado === 'ok' ? 'chip--ok' : f.estado === 'sin_precio' ? 'chip--gris' : 'chip--warn';
  const txt = { ok: 'Ok', sin_carta: 'Sin carta', sin_precio: 'Sin precio' }[f.estado] || f.estado;
  return `<span class="chip ${chip}">${escHtml(txt)}</span><span class="nota">${escHtml(NOTA_ESTADO[f.estado] || '')}</span>${calc}`;
}

// Publicaciones con el mismo Número de producto o Agrupador de ML: la principal replica código SIGA, unidades, peso y cuotas.
function vinculadasHtml(f) {
  if (!f.hermanas || !f.hermanas.length) return '';
  if (!f.esPrincipal) return `<div class="pub-meta"><span class="chip chip--gris" title="Usa el vínculo de la principal. Si lo editás, se replica en todas.">Vinculada a ${escHtml(f.principal)}</span></div>`;
  const hijas = hijasDe(f);
  const mal = hijas.filter(h => h.estado !== 'ok').length;
  const abierto = abiertos.has(f.id);
  return `<div class="pub-meta"><button type="button" class="link-btn" data-act="toggle-grupo" data-id="${escHtml(f.id)}" aria-expanded="${abierto}">${abierto ? '▾' : '▸'} Principal &middot; ${hijas.length} vinculada${hijas.length === 1 ? '' : 's'}${mal ? ` (${mal} para revisar)` : ''}</button></div>`;
}

function productoHtml(f) {
  if (f.codigo === null || f.codigo === undefined) return '<span class="t-gris">-</span>';
  const id = escHtml(f.id);
  return `<div class="prod-nombre" title="${escHtml(f.nombreProducto || '')}">${f.nombreProducto ? escHtml(f.nombreProducto) : '<span class="t-warn">No se encontró el producto</span>'}</div>
    <div class="pub-meta"><span class="num">Cód. ${escHtml(f.codigo)} &times; ${escHtml(f.unidades)} un.${f.precioPorKg ? ' &middot; <span class="chip chip--gris" title="El precio de SIGA es por kg: se multiplica por el peso de la publicación.">Por kg</span>' : ''}${num(f.pesoKg) === null ? '' : ` &middot; ${f.pesoEstimado ? `<span title="Estimado por el nombre del producto; editalo si no es correcto">~${escHtml(f.pesoKg)}</span>` : escHtml(f.pesoKg)} kg`}${num(f.carta) === null ? '' : ` &middot; carta ${fmtMoney(f.carta)}`}</span>
    <button type="button" class="link-btn" data-act="editar" data-id="${id}" aria-label="Editar vínculo de ${id}">Editar</button></div>`;
}

function filaHtml(f, hija = false) {
  const id = escHtml(f.id);
  const idNum = String(f.id).replace(/\D/g, '');
  const meta = [
    idNum ? `<a href="https://articulo.mercadolibre.com.ar/MLA-${idNum}" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${id} en Mercado Libre (pestaña nueva)">${id}</a>` : id,
    f.activa ? '' : '<span class="chip chip--gris">Inactiva</span>',
    ENVIO[f.envio] === 'Envío gratis' ? '<span>Envío gratis</span>' : f.envioPorUmbral ? '<span class="chip chip--gris" title="El precio llega al mínimo de envío gratis obligatorio: se suma el envío.">Envío por umbral</span>' : '',
    f.envioBonificado ? '<span class="chip chip--gris" title="ML bonifica la mitad del costo de envío.">Envío bonificado 50 %</span>' : '',
    num(f.cuotasQty) > 1 ? `<span>${escHtml(f.cuotasQty)} cuotas</span>` : '',
  ].filter(Boolean).join('');
  const promo = f.precioPromo ? '<div class="text-xs t-gris">promo</div>' : '';
  return `<tr data-id="${id}"${hija ? ' class="fila-hija"' : ''}>
    <td><div class="pub-titulo" title="${escHtml(f.titulo)}">${escHtml(f.titulo)}</div><div class="pub-meta">${meta}</div>${vinculadasHtml(f)}</td>
    <td>${productoHtml(f)}</td>
    <td class="num text-right">${num(f.precioMl) === null ? '-' : fmtMoney(f.precioMl)}${promo}</td>
    <td class="num text-right">${num(f.esperado) === null ? '-' : fmtMoney(f.esperado)}</td>
    <td class="num text-right">${difHtml(f)}</td>
    <td><div class="accion">${accionHtml(f)}</div></td>
  </tr>`;
}

function editorHtml(f) {
  const id = escHtml(f.id);
  const vinculada = f.codigo !== null && f.codigo !== undefined;
  return `<tr class="fila-vinc" data-editor="${id}"><td colspan="6">
    <div class="vinc-form">
      <div class="campo"><label for="ed-codigo">Código de producto en SIGA</label><input id="ed-codigo" inputmode="numeric" autocomplete="off" value="${escHtml(editor.codigo)}" aria-describedby="ed-prev"></div>
      <div class="campo"><label for="ed-unid">Unidades en la publicación</label><input id="ed-unid" inputmode="numeric" autocomplete="off" value="${escHtml(editor.unidades)}" style="width:110px"></div>
      <div class="campo"><label for="ed-cuotas">Cuotas (vacío = 1)</label><input id="ed-cuotas" inputmode="numeric" autocomplete="off" value="${escHtml(editor.cuotas)}" style="width:110px"></div>
      <div class="campo"><label for="ed-peso">Peso (kg, opcional)</label><input id="ed-peso" inputmode="decimal" autocomplete="off" value="${escHtml(editor.peso)}" style="width:110px" title="Vacío: usa envío por defecto" aria-describedby="ed-peso-ayuda">${f.pesoEstimado ? `<span id="ed-peso-ayuda" class="ayuda">~ Estimado por el nombre del producto; editalo si no es correcto</span>` : ''}</div>
      <div class="campo"><label class="flex items-center gap-2 text-sm" title="${TIP_POR_KG}"><input type="checkbox" id="ed-porkg"${editor.precioPorKg ? ' checked' : ''}> Precio SIGA por kg</label></div>
      <button type="button" class="btn btn-primario" data-act="guardar">${vinculada ? 'Guardar vínculo' : 'Vincular'}</button>
      <button type="button" class="btn btn-secundario" data-act="cancelar">Cancelar</button>
      ${vinculada ? '<button type="button" class="btn btn-peligro" data-act="quitar">Quitar vínculo</button>' : ''}
    </div>
    <div class="vinc-prev" id="ed-prev" aria-live="polite">${previewCodigoHtml(editor.codigo)}</div>
    <div id="ed-error" class="error mt-2" role="alert" hidden></div>
    ${f.hermanas && f.hermanas.length ? `<p class="text-xs t-gris mt-1">Se aplica también a las ${f.hermanas.length} publicaciones vinculadas (mismo producto/agrupador en ML).</p>` : ''}
    <p class="text-xs t-gris mt-1">Si la publicación es un combo de varias unidades del mismo producto, poné cuántas trae (el precio se calcula como carta &times; unidades). Con "Precio SIGA por kg" se calcula como carta &times; peso.</p>
  </td></tr>`;
}

const editorDe = f => (editor && editor.id === String(f.id) ? editorHtml(f) : '');
function filaGrupoHtml(f) {
  const hijas = abiertos.has(f.id) ? hijasDe(f) : [];
  return filaHtml(f) + editorDe(f) + hijas.map(h => filaHtml(h, true) + editorDe(h)).join('');
}

function renderTabla() {
  const wrap = $('tabla-wrap');
  const filas = filtrar();
  const todas = datos.filas || [];
  const mostradas = filas.reduce((n, f) => n + 1 + f.hermanas.length, 0);
  $('cuenta').textContent = `${fmtInt(mostradas)} de ${fmtInt(todas.length)} publicaciones`;
  if (!filas.length) {
    const hayFiltro = prefs.grupo !== 'todas' || $('f-buscar').value.trim();
    const bien = prefs.grupo === 'pend' && !$('f-buscar').value.trim() && todas.length;
    wrap.innerHTML = `<p class="empty">${bien ? 'No hay publicaciones pendientes: todo está en precio.' : hayFiltro ? 'Ninguna publicación coincide con los filtros.' : 'No hay publicaciones.'}
      ${hayFiltro ? '<br><button type="button" class="link-btn" data-act="ver-todas">Ver todas las publicaciones</button>' : ''}</p>`;
    return;
  }
  const th = c => {
    const orden = c.k && prefs.orden === c.k;
    const sort = orden ? (prefs.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="${c.num ? 'num text-right' : ''}"${c.k ? ` aria-sort="${sort}"` : ''}>${c.k ? `<button type="button" class="th-btn" data-orden="${c.k}">${c.t}</button>` : c.t}</th>`;
  };
  wrap.innerHTML = `<table><thead><tr>${COLUMNAS.map(th).join('')}</tr></thead><tbody>${filas.map(filaGrupoHtml).join('')}</tbody></table>`;
}

function renderControl() {
  const hay = !!(datos && (datos.filas || []).length);
  $('ctl-vacio').hidden = hay;
  $('ctl-contenido').hidden = !hay;
  if (!hay) return;
  $('f-grupo').value = prefs.grupo;
  document.querySelectorAll('#f-activa button').forEach(b => { b.classList.toggle('on', b.dataset.v === prefs.activa); b.setAttribute('aria-pressed', String(b.dataset.v === prefs.activa)); });
  renderResumen();
  renderTabla();
}

async function cargarControl() {
  $('ctl-error').hidden = true;
  try {
    datos = await api('/api/ml-precios/control');
  } catch (err) {
    $('ctl-vacio').hidden = true;
    $('ctl-contenido').hidden = true;
    $('ctl-error').hidden = false;
    $('ctl-error').innerHTML = `${escHtml(err.message)} <button type="button" class="link-btn" data-act="reintentar">Reintentar</button>`;
    return;
  }
  const dias = datos.importadoEn ? Math.floor((Date.now() - new Date(datos.importadoEn).getTime()) / 86400000) : null;
  $('importado').textContent = datos.importadoEn
    ? `Bajada del ${new Date(datos.importadoEn).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}${dias >= 2 ? ` (hace ${dias} días, conviene importar una nueva)` : ''}`
    : 'Sin bajada importada';
  renderControl();
}

// ── Copiar precio sugerido ───────────────────────────────────────────────────
async function copiarPrecioSugerido(id, boton) {
  const f = (datos.filas || []).find(x => String(x.id) === String(id));
  if (!f || num(f.esperado) === null) return;
  const texto = String(f.esperado).replace('.', ',');
  const ok = await copiarTexto(texto);
  if (!ok) { avisar(`No se pudo copiar. El precio sugerido es ${texto}.`, 'error'); return; }
  const original = boton.textContent;
  boton.textContent = 'Copiado';
  setTimeout(() => { boton.textContent = original; }, 1500);
}

// ── Vincular / editar en la fila ─────────────────────────────────────────────
function abrirEditor(id) {
  const f = (datos.filas || []).find(x => String(x.id) === String(id));
  if (!f) return;
  editor = { id: String(f.id), codigo: f.codigo ?? '', unidades: f.unidades ?? 1, peso: f.pesoKg ?? '', pesoTocado: false, cuotas: f.cuotasQty ?? '', precioPorKg: !!f.precioPorKg };
  renderTabla();
  const c = $('ed-codigo');
  if (c) { actualizarPreview($('ed-prev'), editor.codigo, editor.unidades, f, editor.precioPorKg); c.focus(); c.select(); c.closest('tr').scrollIntoView({ block: 'nearest' }); }
}
const filaEditada = () => (datos.filas || []).find(x => String(x.id) === editor.id);
function cerrarEditor() { editor = null; renderTabla(); }

function errorEditor(texto, foco) {
  const e = $('ed-error');
  e.hidden = !texto; e.textContent = texto || '';
  if (foco) foco.focus();
}

async function guardarEditor() {
  if (!editor) return;
  const v = validarVinculo(editor.codigo, editor.unidades, editor.peso, editor.cuotas);
  $('ed-codigo').setAttribute('aria-invalid', String(v.campo === 'codigo'));
  $('ed-unid').setAttribute('aria-invalid', String(v.campo === 'unidades'));
  $('ed-peso').setAttribute('aria-invalid', String(v.campo === 'peso'));
  $('ed-cuotas').setAttribute('aria-invalid', String(v.campo === 'cuotas'));
  if (v.error) { errorEditor(v.error, $({ codigo: 'ed-codigo', unidades: 'ed-unid', peso: 'ed-peso', cuotas: 'ed-cuotas' }[v.campo])); return; }
  errorEditor('');
  const id = editor.id;
  const previo = (datos.filas || []).find(x => String(x.id) === id);
  const antes = previo ? { codigo: previo.codigo ?? null, unidades: previo.unidades ?? 1, pesoKg: editor.pesoTocado ? previo.pesoKg ?? null : undefined, cuotasQty: previo.cuotasQty ?? null, precioPorKg: !!previo.precioPorKg } : { codigo: null, unidades: 1, pesoKg: null, cuotasQty: null, precioPorKg: false };
  const botones = document.querySelectorAll('tr.fila-vinc button');
  botones.forEach(b => { b.disabled = true; });
  try {
    await putVinculo(id, v.codigo, v.unidades, editor.pesoTocado ? v.pesoKg : undefined, v.cuotasQty, editor.precioPorKg); // sin tocar el peso no se manda: un estimado sigue siendo estimado
    editor = null;
    await cargarControl();
    const f = (datos.filas || []).find(x => String(x.id) === id);
    avisar(resumenVinculo(f), undefined, { texto: 'Deshacer', fn: () => deshacerVinculo(id, antes) });
  } catch (err) {
    botones.forEach(b => { b.disabled = false; });
    errorEditor(`No se guardó: ${err.message}`, $('ed-codigo'));
  }
}

function resumenVinculo(f) {
  if (!f) return 'Vínculo guardado.';
  const quien = f.nombreProducto ? `Vinculada a «${f.nombreProducto}».` : 'Vínculo guardado.';
  if (f.estado === 'desviada') return `${quien} Esperado ${fmtMoney(f.esperado)}, en ML ${fmtMoney(f.precioMl)}.`;
  if (f.estado === 'ok') return `${quien} El precio está en orden.`;
  return `${quien} ${NOTA_ESTADO[f.estado] || ''}`;
}

async function deshacerVinculo(id, antes) {
  try {
    await putVinculo(id, antes.codigo, antes.unidades, antes.pesoKg, antes.cuotasQty, antes.precioPorKg);
    await cargarControl();
    avisar('Vínculo restaurado.');
  } catch (err) { avisar(`No se pudo deshacer: ${err.message}`, 'error'); }
}

async function quitarEditor() {
  const id = editor.id;
  const previo = (datos.filas || []).find(x => String(x.id) === id);
  if (!await apdConfirmar(`¿Quitar el vínculo de ${id}? La publicación vuelve a quedar sin vincular.`, { titulo: 'Quitar vínculo', aceptar: 'Quitar', cancelar: 'Cancelar', peligro: true })) return;
  const antes = { codigo: previo ? previo.codigo : null, unidades: previo ? previo.unidades : 1, pesoKg: previo ? previo.pesoKg ?? null : null, // se reenvía como exacto: la API no restaura el flag de estimado
    cuotasQty: previo ? previo.cuotasQty ?? null : null, precioPorKg: !!(previo && previo.precioPorKg) };
  try {
    await putVinculo(id, null, 1);
    editor = null;
    await cargarControl();
    avisar(`Vínculo de ${id} quitado.`, undefined, { texto: 'Deshacer', fn: () => deshacerVinculo(id, antes) });
  } catch (err) { errorEditor(`No se quitó: ${err.message}`); }
}

// ── Eventos de la tabla ──────────────────────────────────────────────────────
const ACCIONES = {
  vincular: id => abrirEditor(id),
  editar: id => abrirEditor(id),
  calc: id => abrirDetalle(id),
  'toggle-grupo': id => { if (abiertos.has(id)) abiertos.delete(id); else abiertos.add(id); renderTabla(); },
  'cargar-peso': id => { abrirEditor(id); const p = $('ed-peso'); if (p) { p.focus(); p.select(); } },
  copiar: (id, b) => copiarPrecioSugerido(id, b),
  guardar: () => guardarEditor(),
  cancelar: () => cerrarEditor(),
  quitar: () => quitarEditor(),
  'ver-todas': () => { $('f-buscar').value = ''; fijarGrupo('todas'); },
  reintentar: () => cargarControl(),
};

$('tabla-wrap').addEventListener('click', e => {
  const o = e.target.closest('[data-orden]');
  if (o) { ciclarOrden(o.dataset.orden); return; }
  const b = e.target.closest('[data-act]');
  if (b && ACCIONES[b.dataset.act]) ACCIONES[b.dataset.act](b.dataset.id, b);
});
$('ctl-error').addEventListener('click', e => { if (e.target.dataset.act === 'reintentar') cargarControl(); });
$('tabla-wrap').addEventListener('input', e => {
  if (!editor) return;
  if (e.target.id === 'ed-codigo') editor.codigo = e.target.value;
  if (e.target.id === 'ed-unid') editor.unidades = e.target.value;
  if (e.target.id === 'ed-peso') { editor.peso = e.target.value; editor.pesoTocado = true; }
  if (e.target.id === 'ed-cuotas') editor.cuotas = e.target.value;
  if (e.target.id === 'ed-codigo' || e.target.id === 'ed-unid') actualizarPreview($('ed-prev'), editor.codigo, editor.unidades, filaEditada(), editor.precioPorKg);
});
$('tabla-wrap').addEventListener('change', e => {
  if (!editor || e.target.id !== 'ed-porkg') return;
  editor.precioPorKg = e.target.checked;
  actualizarPreview($('ed-prev'), editor.codigo, editor.unidades, filaEditada(), editor.precioPorKg);
  if (editor.precioPorKg && num(editor.peso) === null && num(filaEditada().pesoKg) === null) errorEditor('Para el precio por kg hace falta el peso de la publicación.', $('ed-peso'));
  else errorEditor('');
});
$('tabla-wrap').addEventListener('keydown', e => {
  if (!editor || !e.target.closest('tr.fila-vinc')) return;
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); guardarEditor(); }
  if (e.key === 'Escape') { e.preventDefault(); cerrarEditor(); }
});

function ciclarOrden(k) {
  if (prefs.orden !== k) prefs = guardarPrefs({ orden: k, dir: k === 'pub' ? 'asc' : 'desc' });
  else if (prefs.dir === (k === 'pub' ? 'asc' : 'desc')) prefs = guardarPrefs({ dir: prefs.dir === 'asc' ? 'desc' : 'asc' });
  else prefs = guardarPrefs({ orden: null }); // tercer clic: vuelve a la prioridad
  renderTabla();
}

// ── Filtros ──────────────────────────────────────────────────────────────────
function fijarGrupo(g) { prefs = guardarPrefs({ grupo: g }); renderControl(); }
$('kpis').addEventListener('click', e => {
  const b = e.target.closest('[data-grupo]');
  if (b && datos) fijarGrupo(prefs.grupo === b.dataset.grupo ? 'pend' : b.dataset.grupo); // segundo clic = quitar el filtro
});
$('f-grupo').addEventListener('change', e => fijarGrupo(e.target.value));
$('f-activa').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]');
  if (b && datos) { prefs = guardarPrefs({ activa: b.dataset.v }); renderControl(); }
});
$('f-buscar').addEventListener('input', () => { if (datos) renderTabla(); });
$('f-buscar').addEventListener('keydown', e => {
  if (e.key === 'Escape' && e.target.value) { e.target.value = ''; if (datos) renderTabla(); }
});
document.addEventListener('keydown', e => { // "/" enfoca la búsqueda
  const t = e.target.tagName;
  if (e.key !== '/' || e.ctrlKey || e.metaKey || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || $('panel-control').classList.contains('hidden')) return;
  e.preventDefault();
  $('f-buscar').focus();
});

// ── Importar (botón, vacío guiado o arrastrando el .xlsx) ────────────────────
const MAX_BYTES = 10 * 1024 * 1024;
async function importarArchivo(file) {
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { avisar(`"${file.name}" no es un archivo .xlsx.`, 'error'); return; }
  if (file.size > MAX_BYTES) { avisar('El archivo supera los 10 MB.', 'error'); return; }
  const btns = [$('importar'), $('importar-vacio')];
  btns.forEach(b => { b.disabled = true; });
  $('importar').textContent = 'Importando...';
  avisar('');
  try {
    const form = new FormData();
    form.append('archivo', file);
    const r = await api('/api/ml-precios/importar', { method: 'POST', body: form });
    editor = null;
    prefs = guardarPrefs({ grupo: 'pend' });
    await cargarControl();
    location.hash = 'control';
    const extra = [r.nuevasSinVincular > 0 && `${fmtInt(r.nuevasSinVincular)} nuevas sin vincular`, r.variantesIgnoradas > 0 && `${fmtInt(r.variantesIgnoradas)} variantes ignoradas`].filter(Boolean).join(', ');
    avisar(`Se importaron ${fmtInt(r.importadas)} publicaciones${extra ? ` (${extra})` : ''}.`);
  } catch (err) {
    avisar(`No se pudo importar: ${err.message}`, 'error');
  } finally {
    btns.forEach(b => { b.disabled = false; });
    $('importar').textContent = 'Importar bajada de ML';
  }
}
// ── Exportar: xlsx de la bajada con PRICE = esperado del módulo ──────────────
function nombreDescarga(resp) {
  const cd = resp.headers.get('Content-Disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
  if (!m) return 'bajada_precios_modulo.xlsx';
  try { return decodeURIComponent(m[1]); } catch (_e) { return m[1]; }
}
async function exportarPrecios(file) {
  if (!file) return;
  if (!/\.xlsx$/i.test(file.name)) { avisar(`"${file.name}" no es un archivo .xlsx.`, 'error'); return; }
  if (file.size > MAX_BYTES) { avisar('El archivo supera los 10 MB.', 'error'); return; }
  const btn = $('exportar');
  btn.disabled = true;
  avisar('');
  try {
    const form = new FormData();
    form.append('archivo', file);
    let r;
    try { r = await fetch('/api/ml-precios/exportar', { method: 'POST', body: form }); } catch (_e) { throw new Error('No se pudo conectar con el servidor.'); }
    if (!r.ok) {
      let cuerpo = null;
      try { cuerpo = await r.json(); } catch (_e) { /* sin JSON */ }
      throw new Error((cuerpo && cuerpo.error) || `Error ${r.status} del servidor.`);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreDescarga(r);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    const exp = r.headers.get('X-Ml-Exportadas');
    const sin = r.headers.get('X-Ml-Sin-Cambio');
    avisar(exp === null || sin === null
      ? 'Excel exportado.'
      : `Exportadas ${fmtInt(exp)} · ${fmtInt(sin)} sin cambio (sin vincular o sin carta)`);
  } catch (err) {
    avisar(`No se pudo exportar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('exportar').addEventListener('click', () => $('archivo-exportar').click());
$('archivo-exportar').addEventListener('change', e => { const file = e.target.files[0]; e.target.value = ''; exportarPrecios(file); });

const elegirArchivo = () => $('archivo').click();
$('importar').addEventListener('click', elegirArchivo);
$('importar-vacio').addEventListener('click', elegirArchivo);
$('archivo').addEventListener('change', e => { const file = e.target.files[0]; e.target.value = ''; importarArchivo(file); });
document.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('panel-control').classList.add('arrastrando'); } });
document.addEventListener('dragleave', e => { if (!e.relatedTarget) $('panel-control').classList.remove('arrastrando'); });
document.addEventListener('drop', e => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  $('panel-control').classList.remove('arrastrando');
  importarArchivo(e.dataTransfer.files[0]);
});
