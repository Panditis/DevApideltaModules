// ── Vínculos: helpers compartidos con Control + tab con el listado completo y alta por MLA ──

const normMla = s => {
  const t = String(s).trim().toUpperCase();
  return /^\d+$/.test(t) ? `MLA${t}` : t;
};

// pesoKg undefined = no se manda la clave (el servidor conserva peso y flag de estimado); null = borrar el peso.
const putVinculo = (id, codigo, unidades, pesoKg, cuotasQty) => api(`/api/ml-precios/vinculos/${encodeURIComponent(id)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo, unidades, pesoKg, cuotasQty: cuotasQty ?? null }),
});

// Valida lo tipeado (strings). campo = qué input marcar.
function validarVinculo(codigoCrudo, unidadesCrudo, pesoCrudo, cuotasCrudo) {
  const codigo = Number(String(codigoCrudo).trim());
  const unidades = Number(String(unidadesCrudo).trim() || 1);
  if (!(Number.isInteger(codigo) && codigo > 0)) return { campo: 'codigo', error: 'El código de producto debe ser un número entero positivo.' };
  if (!(Number.isInteger(unidades) && unidades >= 1)) return { campo: 'unidades', error: 'Las unidades deben ser un entero de 1 o más.' };
  const txt = String(pesoCrudo ?? '').trim();
  const pesoKg = txt === '' ? null : parseNum(txt);
  if (pesoKg !== null && !(Number.isFinite(pesoKg) && pesoKg > 0 && Math.abs(Math.round(pesoKg * 1000) - pesoKg * 1000) < 1e-6)) return { campo: 'peso', error: 'El peso debe ser un número mayor a 0, con hasta 3 decimales (kg), o dejarlo vacío.' };
  const ctxt = String(cuotasCrudo ?? '').trim();
  const cuotasQty = ctxt === '' ? null : Number(ctxt);
  if (cuotasQty !== null && !(Number.isInteger(cuotasQty) && cuotasQty >= 1 && cuotasQty <= 24)) return { campo: 'cuotas', error: 'Las cuotas deben ser un entero de 1 a 24, o dejarlo vacío (1 cuota).' };
  return { codigo, unidades, pesoKg, cuotasQty };
}

// Recargo % de la tabla de cuotas para esa cantidad (vacío = 1 cuota).
const recargoCuotasHtml = qty => (config ? fmtPct(recargoCuotas(config.tablaCuotas, qty ?? 1)) : '<span class="t-gris">—</span>');

// Texto del envío que resulta del peso, según la tabla de Costos (config).
const TIP_ESTIMADO = 'Estimado por el nombre del producto; editalo si no es correcto';
const tildeEstimado = v => (v.pesoEstimado ? `<span class="t-gris" title="${TIP_ESTIMADO}" aria-label="Peso estimado">~</span> ` : '');

// Sugerencia del peso estimado por nombre (alta de vínculo): "Usar" completa el campo, sin guardar.
let sugTimer = null;
function sugerirPesoAlta() {
  const el = $('vin-peso-sug');
  clearTimeout(sugTimer);
  const c = $('vin-codigo').value.trim();
  el.innerHTML = '';
  if (!/^\d+$/.test(c) || !(Number(c) > 0)) return;
  const unid = Number($('vin-unid').value.trim() || 1);
  sugTimer = setTimeout(async () => {
    const res = await consultarProducto(c);
    const u = num(res.producto && res.producto.pesoUnitarioEstimadoKg);
    if ($('vin-codigo').value.trim() !== c || u === null || !(u > 0)) return;
    const total = Number.isInteger(unid) && unid >= 1 ? Math.round(u * unid * 1000) / 1000 : null;
    el.innerHTML = `Estimado por nombre: ${escHtml(u)} kg por unidad${total !== null ? ` (&asymp; ${escHtml(total)} kg con ${fmtInt(unid)} un.)` : ''}`
      + (total !== null ? ` <button type="button" class="link-btn" id="vin-peso-usar" data-peso="${escHtml(total)}">Usar</button>` : '');
  }, 450);
}

function envioPorPesoHtml(pesoKg) {
  if (num(pesoKg) === null || !config) return '<span class="t-gris" title="usa envío por defecto">—</span>';
  const t = tramoEnvio(config.tablaEnvio, pesoKg, config.envioMonto);
  return `${fmtMoney(t.monto)} <span class="t-gris">${t.origen === 'tabla' ? `(hasta ${escHtml(t.topeKg)} kg)` : '(por defecto)'}</span>`;
}

// Nombre de un producto que ya conocemos por otra publicación vinculada (no hay endpoint de búsqueda por código).
function nombreDeCodigo(codigo) {
  const c = String(codigo).trim();
  const f = ((datos && datos.filas) || []).find(x => x.nombreProducto && String(x.codigo) === c);
  if (f) return f.nombreProducto;
  const v = ((vinculos && vinculos.vinculos) || []).find(x => x.nombreProducto && String(x.codigo) === c);
  return v ? v.nombreProducto : null;
}

function previewCodigoHtml(codigoCrudo) {
  const c = String(codigoCrudo).trim();
  if (!c) return '<span class="t-gris">Escribí el código del producto tal como figura en SIGA.</span>';
  if (!/^\d+$/.test(c)) return '<span class="t-crit">El código son solo números.</span>';
  const nombre = nombreDeCodigo(c);
  return nombre
    ? `Producto: <strong>${escHtml(nombre)}</strong>`
    : '<span class="t-gris">Al guardar se verifica en SIGA y te muestro el nombre para confirmar (con opción de deshacer).</span>';
}

// Consulta del producto en SIGA (GET /producto/:codigo). Se cachea lo definitivo (existe / no existe), no los fallos de red.
const cacheProductos = new Map();
async function consultarProducto(codigo) {
  if (cacheProductos.has(codigo)) return cacheProductos.get(codigo);
  try {
    const r = await api(`/api/ml-precios/producto/${encodeURIComponent(codigo)}`);
    cacheProductos.set(codigo, { producto: r });
    return { producto: r };
  } catch (err) {
    const noExiste = /no existe/i.test(err.message);
    const res = { error: err.message, noExiste };
    if (noExiste) cacheProductos.set(codigo, res);
    return res;
  }
}

function resultadoPreviewHtml(res, unidades, fila) {
  if (res.noExiste) return `<span class="t-crit">${escHtml(res.error)} Revisá el código antes de guardar.</span>`;
  if (res.error) return `<span class="t-warn">No se pudo consultar SIGA (${escHtml(res.error)}). Igual podés guardar: el servidor lo valida.</span>`;
  const p = res.producto;
  let html = `Producto: <strong>${escHtml(p.nombre)}</strong> &middot; ${p.carta > 0 ? `carta ${fmtMoney(p.carta)}` : '<span class="t-warn">sin precio en la lista</span>'}`;
  if (p.carta > 0 && fila && config && Number.isInteger(unidades) && unidades >= 1) {
    try {
      const f = calcularEsperado(p.carta, unidades, fila.envio, fila.cuotas, config, num(fila.pesoKg), num(fila.cuotasQty));
      if (f.esperado != null && Number.isFinite(f.gastosPct)) {
        const dif = num(fila.precioMl) === null ? '' : ` &middot; hoy en ML ${fmtMoney(fila.precioMl)} (${fmtDif(fila.precioMl - f.esperado)})`;
        html += `<br>Con ${fmtInt(unidades)} un. el esperado sería <strong>${fmtMoney(f.esperado)}</strong>${dif}`;
      }
    } catch (_e) { /* config inválida: sin esperado */ }
  }
  return html;
}

// Actualiza `el` con el nombre/carta/esperado del código tipeado. Debounce 300 ms; descarta respuestas viejas.
function actualizarPreview(el, codigoCrudo, unidadesCrudo, fila) {
  const c = String(codigoCrudo).trim();
  const tok = String((Number(el.dataset.tok) || 0) + 1);
  el.dataset.tok = tok;
  clearTimeout(el._timer);
  if (!/^\d+$/.test(c) || !(Number(c) > 0)) { el.innerHTML = previewCodigoHtml(c); return; }
  const cacheado = cacheProductos.get(c);
  const unidades = Number(String(unidadesCrudo).trim() || 1);
  if (cacheado) { el.innerHTML = resultadoPreviewHtml(cacheado, unidades, fila); return; }
  el.innerHTML = '<span class="t-gris">Buscando en SIGA...</span>';
  el._timer = setTimeout(async () => {
    const res = await consultarProducto(c);
    if (el.dataset.tok === tok) el.innerHTML = resultadoPreviewHtml(res, unidades, fila);
  }, 300);
}

// ── Tab ──────────────────────────────────────────────────────────────────────
function mostrarErrorVin(texto) { const e = $('vin-error'); e.hidden = !texto; e.textContent = texto || ''; }

function filtrarVinculos() {
  const q = $('vin-buscar').value.trim().toLowerCase();
  const soloHuerfanos = $('vin-huerfanos').checked;
  return (vinculos.vinculos || [])
    .filter(v => !soloHuerfanos || !v.enBajada)
    .filter(v => !q || `${v.id} ${v.codigo} ${v.titulo ?? ''} ${v.nombreProducto ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => Number(a.enBajada) - Number(b.enBajada) || String(a.id).localeCompare(String(b.id))); // huérfanos arriba
}

function vinculoHtml(v) {
  const id = escHtml(v.id);
  return `<tr data-id="${id}">
    <td><div class="pub-titulo" title="${escHtml(v.titulo || '')}">${v.titulo ? escHtml(v.titulo) : '<span class="t-gris">Sin título (no está en la bajada)</span>'}</div>
      <div class="pub-meta">${id} ${v.enBajada ? '<span class="chip chip--ok">En la bajada</span>' : '<span class="chip chip--warn">No está en la bajada</span>'}</div></td>
    <td><div class="prod-nombre" title="${escHtml(v.nombreProducto ?? '')}">${v.nombreProducto ? escHtml(v.nombreProducto) : '<span class="t-warn">No se encontró el producto</span>'}</div></td>
    <td class="num text-right"><input class="celda-input v-codigo" inputmode="numeric" autocomplete="off" value="${escHtml(v.codigo ?? '')}" aria-label="Código de producto de ${id}"></td>
    <td class="num text-right"><input class="celda-input unid v-unidades" inputmode="numeric" autocomplete="off" value="${escHtml(v.unidades ?? 1)}" aria-label="Unidades de ${id}"></td>
    <td class="num text-right">${tildeEstimado(v)}<input class="celda-input unid v-peso" inputmode="decimal" autocomplete="off" placeholder="—" title="Vacío: usa envío por defecto" value="${escHtml(v.pesoKg ?? '')}" aria-label="Peso en kg de ${id}"></td>
    <td class="num text-right text-sm">${envioPorPesoHtml(v.pesoKg)}</td>
    <td class="num text-right"><input class="celda-input unid v-cuotas" inputmode="numeric" autocomplete="off" placeholder="1" title="Vacío: 1 cuota" value="${escHtml(v.cuotasQty ?? '')}" aria-label="Cuotas de ${id}"></td>
    <td class="num text-right text-sm">${recargoCuotasHtml(num(v.cuotasQty))}</td>
    <td><button type="button" class="btn btn-peligro sm v-quitar" aria-label="Quitar vínculo de ${id}">Quitar</button></td>
  </tr>`;
}

function renderVinculos() {
  const wrap = $('vin-wrap');
  const todos = vinculos.vinculos || [];
  const filas = filtrarVinculos();
  $('vin-cuenta').textContent = `${fmtInt(filas.length)} de ${fmtInt(todos.length)} vínculos`;
  if (!filas.length) {
    wrap.innerHTML = `<p class="empty">${todos.length ? 'Ningún vínculo coincide con el filtro.' : 'Todavía no hay vínculos. Vinculá publicaciones desde Control o agregá uno arriba.'}</p>`;
    return;
  }
  wrap.innerHTML = `<table><thead><tr>
    <th scope="col">Publicación</th><th scope="col">Producto en SIGA</th><th scope="col" class="num text-right">Código</th>
    <th scope="col" class="num text-right">Unidades</th><th scope="col" class="num text-right">Peso (kg)</th><th scope="col" class="num text-right">Envío por peso</th><th scope="col" class="num text-right">Cuotas</th><th scope="col" class="num text-right">Recargo</th><th scope="col"><span class="sr-only">Acciones</span></th>
  </tr></thead><tbody>${filas.map(vinculoHtml).join('')}</tbody></table>`;
}

async function cargarVinculos() {
  try {
    vinculos = await api('/api/ml-precios/vinculos');
  } catch (err) {
    $('vin-cuenta').textContent = '';
    $('vin-wrap').innerHTML = `<div class="error" role="alert">${escHtml(err.message)}</div>`;
    return;
  }
  renderVinculos();
}

// Los cambios de vínculos alteran Control (carta, esperado): lo recarga.
async function refrescarTrasCambio() {
  await cargarVinculos();
  await cargarControl();
}

$('vin-form').addEventListener('submit', async e => {
  e.preventDefault();
  const mla = normMla($('vin-mla').value);
  const malMla = !/^MLA\d+$/.test(mla);
  const v = validarVinculo($('vin-codigo').value, $('vin-unid').value, $('vin-peso').value, $('vin-cuotas').value);
  $('vin-mla').setAttribute('aria-invalid', String(malMla));
  $('vin-codigo').setAttribute('aria-invalid', String(v.campo === 'codigo'));
  $('vin-unid').setAttribute('aria-invalid', String(v.campo === 'unidades'));
  $('vin-peso').setAttribute('aria-invalid', String(v.campo === 'peso'));
  $('vin-cuotas').setAttribute('aria-invalid', String(v.campo === 'cuotas'));
  if (malMla) { mostrarErrorVin('El código MLA debe ser como MLA123456789 (o solo los números).'); $('vin-mla').focus(); return; }
  if (v.error) { mostrarErrorVin(v.error); $({ codigo: 'vin-codigo', unidades: 'vin-unid', peso: 'vin-peso', cuotas: 'vin-cuotas' }[v.campo]).focus(); return; }
  mostrarErrorVin('');
  const btn = $('vin-agregar');
  btn.disabled = true;
  try {
    await putVinculo(mla, v.codigo, v.unidades, $('vin-peso').value.trim() === '' ? undefined : v.pesoKg, v.cuotasQty);
    $('vin-mla').value = ''; $('vin-codigo').value = ''; $('vin-peso').value = ''; $('vin-cuotas').value = ''; $('vin-unid').value = '1'; $('vin-peso-sug').innerHTML = '';
    await refrescarTrasCambio();
    const enBajada = ((vinculos && vinculos.vinculos) || []).find(x => x.id === mla);
    avisar(`Vínculo ${mla} guardado${enBajada && enBajada.nombreProducto ? ` («${enBajada.nombreProducto}»)` : ''}.${enBajada && !enBajada.enBajada ? ' No está en la última bajada: se controla cuando una bajada la traiga.' : ''}`);
    $('vin-mla').focus();
  } catch (err) {
    mostrarErrorVin(`No se guardó ${mla}: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
});

async function editarVinculo(tr) {
  const cod = tr.querySelector('.v-codigo'), uni = tr.querySelector('.v-unidades'), peso = tr.querySelector('.v-peso'), cuo = tr.querySelector('.v-cuotas');
  const v = validarVinculo(cod.value, uni.value, peso.value, cuo.value);
  cod.setAttribute('aria-invalid', String(v.campo === 'codigo'));
  uni.setAttribute('aria-invalid', String(v.campo === 'unidades'));
  peso.setAttribute('aria-invalid', String(v.campo === 'peso'));
  cuo.setAttribute('aria-invalid', String(v.campo === 'cuotas'));
  if (v.error) { avisar(`${v.error}${v.campo === 'codigo' ? ' Para quitarlo usá Quitar.' : ''}`, 'error'); return; }
  const id = tr.dataset.id;
  const previo = (vinculos.vinculos || []).find(x => String(x.id) === id);
  const tocado = peso.dataset.tocado === '1'; // si no tocó el peso no se manda la clave: un estimado sigue siendo estimado
  const pesoSinCambio = !previo || !tocado || (!previo.pesoEstimado && (num(previo.pesoKg) ?? null) === v.pesoKg);
  if (previo && Number(previo.codigo) === v.codigo && Number(previo.unidades ?? 1) === v.unidades && pesoSinCambio && (num(previo.cuotasQty) ?? null) === v.cuotasQty) return; // sin cambios
  avisar('');
  cod.disabled = uni.disabled = peso.disabled = cuo.disabled = true;
  try {
    await putVinculo(id, v.codigo, v.unidades, tocado ? v.pesoKg : undefined, v.cuotasQty);
    await refrescarTrasCambio();
    avisar(`Vínculo ${id} actualizado.`);
  } catch (err) {
    cod.disabled = uni.disabled = peso.disabled = cuo.disabled = false;
    cod.setAttribute('aria-invalid', 'true');
    avisar(`No se guardó ${id}: ${err.message}`, 'error');
  }
}

async function quitarVinculo(tr, boton) {
  const id = tr.dataset.id;
  if (!await apdConfirmar(`¿Quitar el vínculo de ${id}?`, { titulo: 'Quitar vínculo', aceptar: 'Quitar', cancelar: 'Cancelar', peligro: true })) return;
  const previo = (vinculos.vinculos || []).find(x => String(x.id) === id);
  boton.disabled = true;
  avisar('');
  try {
    await putVinculo(id, null, 1); // código null = sin vincular
    await refrescarTrasCambio();
    avisar(`Vínculo ${id} quitado.`, undefined, previo ? { texto: 'Deshacer', fn: () => /* peso previo reenviado: queda exacto (la API no restaura el flag de estimado) */ deshacerVinculo(id, { codigo: previo.codigo, unidades: previo.unidades, pesoKg: previo.pesoKg ?? null, cuotasQty: previo.cuotasQty ?? null }).then(cargarVinculos) } : undefined);
  } catch (err) {
    boton.disabled = false;
    avisar(`No se quitó ${id}: ${err.message}`, 'error');
  }
}

$('vin-wrap').addEventListener('input', e => { if (e.target.classList.contains('v-peso')) e.target.dataset.tocado = '1'; });
$('vin-wrap').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-id]');
  if (tr && e.target.classList.contains('celda-input')) editarVinculo(tr);
});
$('vin-wrap').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('celda-input')) e.target.blur();
});
$('vin-wrap').addEventListener('click', e => {
  const b = e.target.closest('.v-quitar');
  if (b) quitarVinculo(b.closest('tr'), b);
});
const previewAlta = () => actualizarPreview($('vin-prev'), $('vin-codigo').value, $('vin-unid').value,
  ((datos && datos.filas) || []).find(f => String(f.id) === normMla($('vin-mla').value)) || null);
['vin-mla', 'vin-codigo', 'vin-unid', 'vin-peso', 'vin-cuotas'].forEach(id => $(id).addEventListener('input', previewAlta));
['vin-codigo', 'vin-unid'].forEach(id => $(id).addEventListener('input', sugerirPesoAlta));
$('vin-peso-sug').addEventListener('click', e => {
  const b = e.target.closest('#vin-peso-usar');
  if (!b) return;
  $('vin-peso').value = b.dataset.peso;
  $('vin-peso').focus();
});
$('vin-buscar').addEventListener('input', () => { if (vinculos) renderVinculos(); });
$('vin-huerfanos').addEventListener('change', () => { if (vinculos) renderVinculos(); });
