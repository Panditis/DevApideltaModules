'use strict';
// Pantalla "Importar a SIGA" (routes/rutas_compras_siga.js). Solo junta lo editable: todos los importes los
// calcula el servidor en /api/compras-siga/validar (nunca se usan importes del navegador). Sin alert/confirm/prompt:
// la confirmación es el modal propio #modal. Lo que viene del servidor o del pedido se pinta con textContent o
// pasa por esc() antes de ir a innerHTML.
(() => {
  const $ = sel => document.querySelector(sel);
  const pedido = new URLSearchParams(location.search).get('pedido') || '';
  const N2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const n2 = v => N2.format(Number(v) || 0);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // input type=number: '' (vacío o inválido) → null; si no, número (nunca texto con separadores).
  const num = v => (v === '' || v == null ? null : Number(v));
  const el = (tag, clase, texto) => {
    const n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto != null) n.textContent = texto;
    return n;
  };
  const TIPOS_PERCEPCION = [['PIVA', 'Percepción IVA'], ['PIIBB', 'Percepción IIBB'], ['PGANA', 'Percepción Ganancias'], ['PVAR', 'Percepciones varias'], ['IMINT', 'Impuestos internos']];
  // campo de errores[] (lib/siga_compras/validaciones.js) → control de la cabecera y nombre para la lista.
  const CAMPOS = {
    idTipoComprobante: ['#cTipo', 'Tipo de comprobante'], letra: ['#cLetra', 'Letra'], centroEmisor: ['#cEmisor', 'Punto de venta'],
    numeroComprobante: ['#cNumero', 'Número'], fecha: ['#cFecha', 'Fecha'], periodoFiscal: ['#cPeriodo', 'Período fiscal'],
    idSucursal: ['#cSucursal', 'Sucursal'], idUbicacion: ['#cUbicacion', 'Depósito / ubicación'], idFormasPago: ['#cFormaPago', 'Forma de pago'],
    percepciones: [null, 'Percepciones'], idProveedor: [null, 'Proveedor'], pedido: [null, 'Pedido'], total: [null, 'Total'],
  };
  const DEBOUNCE_MS = 400;
  const estado = {
    borrador: null, catalogos: null, precios: {}, percepciones: [], errores: [],
    grabacionHabilitada: false, validando: false, grabando: false, grabado: false, aVerificar: false, incierto: false, secuencia: 0, avisosBase: [],
  };
  let temporizador = null;

  async function api(url, opciones) {
    const r = await fetch(url, opciones);
    let esJSON = true;
    const datos = await r.json().catch(() => { esJSON = false; return {}; });
    return { ok: r.ok, status: r.status, datos, esJSON };
  }
  const postJSON = (url, cuerpo) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

  // partes: textos (van como texto, nunca como HTML) o nodos armados con el().
  function mostrarAviso(tono, ...partes) {
    const tonos = { error: 'border-crit text-crit', ok: 'border-ok text-ok', info: 'border-borde text-ink' };
    const caja = $('#aviso');
    caja.className = `rounded-lg border bg-white px-4 py-3 text-sm ${tonos[tono] || tonos.info}`;
    caja.replaceChildren(...partes);
  }

  // Vuelve al aviso fijo del borrador (bloqueos y avisos de catálogos) o lo oculta: borra errores ya superados.
  function limpiarAviso() {
    if (estado.incierto) return; // "No se sabe si se grabó" queda a la vista hasta recargar
    if (!estado.avisosBase.length) { $('#aviso').className = 'hidden'; $('#aviso').replaceChildren(); return; }
    const lista = el('ul', 'list-disc pl-5');
    lista.replaceChildren(...estado.avisosBase.map(a => el('li', null, a)));
    mostrarAviso('error', lista);
  }

  // ── Modal propio de confirmación ────────────────────────────────────────────
  let resolverModal = null;
  function confirmar({ titulo, texto, aceptar }) {
    $('#modalTitulo').textContent = titulo;
    $('#modalTexto').textContent = texto;
    $('#modalAceptar').textContent = aceptar;
    $('#modal').style.display = 'flex';
    $('#modalCancelar').focus(); // desde acá no se deshace: el foco arranca en Cancelar
    return new Promise(resolver => { resolverModal = resolver; });
  }
  function cerrarModal(aceptado) {
    $('#modal').style.display = 'none';
    const resolver = resolverModal;
    resolverModal = null;
    if (resolver) resolver(aceptado);
  }

  function llenarSelect(sel, items, valor) {
    sel.innerHTML = items.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
    if (valor != null && items.some(([v]) => String(v) === String(valor))) sel.value = String(valor);
  }

  const tipoElegido = () => (estado.catalogos.tipos || []).find(t => t.idTipoComprobante === $('#cTipo').value) || null;

  // DOC Parte I §3.1-§3.2: la letra depende del tipo; con numeración automática no se tipea emisor ni número;
  // el período fiscal solo se elige si el tipo graba libro.
  function aplicarTipo(letraPreferida) {
    const t = tipoElegido();
    const letras = t ? t.letrasHabilitadas : [];
    const prov = estado.catalogos.proveedor || {};
    const sugerida = letras.length === 1 ? letras[0] : (letras.includes(letraPreferida) ? letraPreferida : prov.letraFiscalCompra);
    llenarSelect($('#cLetra'), letras.map(l => [l, l]), sugerida);
    const automatico = !!(t && t.numeracionAutomatica);
    ['#cEmisor', '#cNumero'].forEach(id => { $(id).disabled = automatico; if (automatico) $(id).value = ''; });
    $('#cNumero').placeholder = automatico ? 'Se asigna al grabar' : '';
    $('#cPeriodo').disabled = !(t && t.grabaLibro);
  }

  function aplicarSucursal(idDeposito, idUbicacion) {
    const suc = Number($('#cSucursal').value);
    const ubicaciones = (estado.catalogos.ubicaciones || []).filter(u => u.idSucursal === suc);
    llenarSelect($('#cUbicacion'), ubicaciones.map(u => [`${u.idDeposito}|${u.idUbicacion}`, u.nombre]),
      idDeposito != null ? `${idDeposito}|${idUbicacion}` : null);
  }

  function cargarCabecera(b) {
    const c = estado.catalogos;
    llenarSelect($('#cTipo'), c.tipos.map(t => [t.idTipoComprobante, `${t.idTipoComprobante} · ${t.descripcion}`]), b.idTipoComprobante);
    llenarSelect($('#cPeriodo'), c.periodos.map(p => [p, String(p).replace(/^(\d{4})(\d{2})$/, '$2/$1')]), b.periodoFiscal);
    aplicarTipo(b.letra);
    $('#cEmisor').value = b.centroEmisor ?? '';
    $('#cNumero').value = b.numeroComprobante ?? '';
    $('#cFecha').value = b.fecha || '';
    llenarSelect($('#cSucursal'), c.sucursales.map(s => [s.idSucursal, `${s.idSucursal} · ${s.nombre}`]), b.idSucursal);
    aplicarSucursal(b.idDeposito, b.idUbicacion);
    llenarSelect($('#cFormaPago'), c.formasPago.map(f => [f.idFormasPago, `${f.descripcion} (${f.dias} días)`]), b.idFormasPago);
    $('#cDescGral').value = b.porcDescRecGeneral ?? 0;
    $('#cObs').value = b.observacion || '';
    $('#dlProvincias').innerHTML = (c.provincias || []).map(p => `<option value="${esc(p.idProvincia)}">${esc(p.nombre)}</option>`).join('');
  }

  // Se arma una sola vez: al validar solo se actualizan las celdas calculadas (no se pierde el foco del precio).
  function cargarLineas(lineas, descartadas) {
    $('#tLineas').innerHTML = lineas.map(l => `<tr data-orden="${esc(l.orden)}">
      <td>${esc(l.plu)}</td><td>${esc(l.nombre)}</td><td class="num">${n2(l.cantidad)}</td>
      <td class="num"><input type="number" step="0.01" min="0" data-plu="${esc(l.plu)}" value="${esc(l.precio ?? '')}" aria-label="Precio de ${esc(l.nombre)}"></td>
      <td class="num" data-c="porcentajeIVA"></td><td class="num" data-c="importeTotal"></td>
      <td class="num" data-c="iva"></td><td class="num" data-c="importeTotalNeto"></td></tr>`).join('');
    $('#descartadas').textContent = descartadas.length
      ? `No se importan (no entregadas): ${descartadas.map(d => `${d.nombre} (${d.estado})`).join(', ')}.` : '';
  }

  function pintarPercepciones() {
    const conBase = p => (p.tipo === 'PIIBB' ? '' : 'disabled');
    $('#tbPercep').innerHTML = estado.percepciones.map((p, i) => `<tr data-i="${i}">
      <td><select data-k="tipo" aria-label="Tipo de percepción">${TIPOS_PERCEPCION.map(([v, t]) => `<option value="${v}"${p.tipo === v ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
      <td><input data-k="idProvincia" list="dlProvincias" value="${esc(p.idProvincia || '')}" ${conBase(p)} aria-label="Provincia"></td>
      <td class="num"><input type="number" step="0.01" data-k="baseImponible" value="${esc(p.baseImponible ?? '')}" ${conBase(p)} aria-label="Base imponible"></td>
      <td class="num"><input type="number" step="0.01" data-k="alicuota" value="${esc(p.alicuota ?? '')}" ${conBase(p)} aria-label="Alícuota"></td>
      <td class="num"><input type="number" step="0.01" data-k="importe" value="${esc(p.importe ?? '')}" aria-label="Importe"></td>
      <td><button type="button" class="btn" data-quitar="${i}" aria-label="Quitar percepción">✕</button></td></tr>`).join('')
      || '<tr><td colspan="6" class="text-gris">Sin percepciones.</td></tr>';
  }

  function cuerpo() {
    const [idDeposito, idUbicacion] = ($('#cUbicacion').value || '|').split('|');
    return {
      pedido, precios: estado.precios, percepciones: estado.percepciones,
      cabecera: {
        idTipoComprobante: $('#cTipo').value, letra: $('#cLetra').value, centroEmisor: num($('#cEmisor').value),
        numeroComprobante: num($('#cNumero').value), fecha: $('#cFecha').value, periodoFiscal: num($('#cPeriodo').value),
        idSucursal: num($('#cSucursal').value), idDeposito: num(idDeposito), idUbicacion: num(idUbicacion),
        idFormasPago: num($('#cFormaPago').value), porcDescRecGeneral: num($('#cDescGral').value) ?? 0,
        observacion: $('#cObs').value,
      },
    };
  }

  function actualizarBotonGrabar() {
    $('#btnGrabar').disabled = !estado.grabacionHabilitada || estado.grabado || estado.grabando || estado.incierto || estado.validando || estado.aVerificar || estado.errores.length > 0;
  }

  // Errores junto al control de la cabecera (si tiene uno) y todos en la lista de abajo.
  function pintarErrores() {
    document.querySelectorAll('.msg-error').forEach(n => n.remove());
    document.querySelectorAll('.campo-error').forEach(n => n.classList.remove('campo-error'));
    const lineas = estado.borrador.lineas;
    const items = estado.errores.map(e => {
      const m = /^lineas\[(\d+)\]$/.exec(e.campo || '');
      if (m) return el('li', null, lineas[Number(m[1])] ? `${lineas[Number(m[1])].nombre}: ${e.mensaje}` : e.mensaje);
      const [sel, nombre] = CAMPOS[e.campo] || [null, null];
      if (sel) {
        const campo = $(sel).closest('.campo');
        campo.classList.add('campo-error');
        campo.append(el('span', 'msg-error', e.mensaje));
      }
      return el('li', null, nombre ? `${nombre}: ${e.mensaje}` : e.mensaje);
    });
    $('#errores').replaceChildren(...items);
    $('#cajaErrores').style.display = items.length ? '' : 'none';
    document.querySelectorAll('#tLineas tr[data-orden]').forEach((tr, i) => {
      tr.classList.toggle('fila-error', estado.errores.some(e => e.campo === `lineas[${i}]`));
    });
  }

  function pintarResultado(r) {
    const porOrden = new Map((r.lineas || []).map(l => [String(l.orden), l]));
    document.querySelectorAll('#tLineas tr[data-orden]').forEach(tr => {
      const l = porOrden.get(tr.dataset.orden);
      tr.querySelectorAll('[data-c]').forEach(td => { td.textContent = l ? n2(l[td.dataset.c]) : ''; });
    });
    // DOC decisión 15: el precio editable es el de la grilla de SiGA. Ni discrimina ni incluye IVA = comprobante sin
    // impuestos (p. ej. interno): el precio va tal cual, sin letra fiscal de por medio. Sin libro de IVA (p. ej.
    // COTIZACIONCOM) la v1 fija IVA 0 en todas las líneas (armar_comprobante.js, calcularComprobante).
    $('#thPrecio').textContent = r.sinLibroIVA ? 'Precio' : r.discrimina ? 'Precio s/IVA' : r.incluyeIVA ? 'Precio c/IVA' : 'Precio';
    $('#notaPrecio').textContent = r.sinLibroIVA ? 'Precios tal como los cargás. IVA 0 (comprobante sin libro de IVA).'
      : r.discrimina ? 'Precios SIN IVA: letra A, proveedor y empresa discriminan IVA.'
      : r.incluyeIVA ? 'Precios CON IVA incluido: letra B/C, no se discrimina IVA.'
        : 'Precios tal como los cargás (comprobante sin discriminación de IVA).';
    const t = r.totales || {};
    [['#totBruto', 'totalBruto'], ['#totNeto', 'totalNeto'], ['#totIVA', 'totalIVA'], ['#totPercep', 'totalPercepciones'], ['#totImpInt', 'impuestosInternos'], ['#totTotal', 'importeTotal']]
      .forEach(([id, k]) => { $(id).textContent = n2(t[k]); });
    estado.errores = r.errores || [];
    pintarErrores();
    actualizarBotonGrabar();
  }

  // secuencia: si llegan dos respuestas fuera de orden, solo se pinta la del último pedido.
  async function validar() {
    const yo = ++estado.secuencia;
    estado.validando = true;
    actualizarBotonGrabar();
    try {
      const { ok, status, datos } = await postJSON('/api/compras-siga/validar', cuerpo());
      if (yo !== estado.secuencia) return;
      if (!ok) { mostrarAviso('error', datos.error || `No se pudo validar (error ${status}).`); return; }
      limpiarAviso();
      pintarResultado(datos);
    } catch (e) {
      if (yo === estado.secuencia) mostrarAviso('error', `No se pudo validar: ${e.message}`);
    } finally {
      if (yo === estado.secuencia) { estado.validando = false; actualizarBotonGrabar(); }
    }
  }

  function programarValidacion() {
    clearTimeout(temporizador);
    estado.validando = true;
    actualizarBotonGrabar();
    temporizador = setTimeout(validar, DEBOUNCE_MS);
  }

  function mostrarVerificar() {
    estado.aVerificar = true;
    $('#panelVerificar').style.display = '';
    actualizarBotonGrabar();
  }

  function bloquearPantalla(datos) {
    estado.grabado = true;
    document.querySelectorAll('main input, main select, main button:not([data-verif])').forEach(n => { n.disabled = true; });
    const c = datos.comprobante || {};
    const volver = el('a', 'underline', 'Volver a Compras');
    volver.href = '/compras';
    mostrarAviso(datos.vinculado ? 'ok' : 'error',
      el('strong', null, 'Comprobante grabado en SIGA: '),
      `${c.tipoComprobante} ${c.letra} ${c.centroEmisor}-${c.numeroComprobante} · movimiento de stock ${datos.numeroMovimiento}. `,
      datos.vinculado ? 'Quedó vinculado al pedido. ' : `${datos.avisoVinculo || ''} `,
      volver);
    // Sin vínculo el pedido quedó "a verificar" en el servidor: se libera con "Quedó cargado en SiGA".
    if (!datos.vinculado) mostrarVerificar();
  }

  // Corte de red o respuesta ilegible al grabar: no se sabe si quedó en SIGA. Grabar queda trabado hasta recargar
  // (nunca se reintenta solo: en numeración automática duplicaría el comprobante).
  function quedoIncierto() {
    estado.incierto = true;
    actualizarBotonGrabar();
    mostrarAviso('error', 'No se sabe si se grabó: revisá en SiGA antes de reintentar y recargá la página.');
  }

  async function grabar() {
    const c = cuerpo().cabecera;
    const t = tipoElegido();
    const numero = t && t.numeracionAutomatica ? `${c.letra} (número automático)` : `${c.letra} ${c.centroEmisor}-${c.numeroComprobante}`;
    const aceptado = await confirmar({
      titulo: 'Confirmar grabación en SIGA',
      texto: `Se va a grabar en SIGA el comprobante ${c.idTipoComprobante} ${numero} por $ ${$('#totTotal').textContent}, `
        + 'con su movimiento de stock y, según el tipo, cuenta corriente y libro de IVA. Desde acá no se puede deshacer.',
      aceptar: 'Grabar',
    });
    if (!aceptado) return;
    estado.grabando = true;
    actualizarBotonGrabar();
    mostrarAviso('info', 'Grabando en SIGA…');
    try {
      const { ok, status, datos, esJSON } = await postJSON('/api/compras-siga/grabar', cuerpo());
      if (!esJSON) { quedoIncierto(); return; }
      if (status === 400 && datos.errores) {
        pintarResultado(datos);
        mostrarAviso('error', 'SIGA no aceptó el comprobante: revisá los errores.');
        return;
      }
      if (status === 409 && datos.aVerificar) { mostrarVerificar(); mostrarAviso('error', datos.error || 'Grabación sin confirmar.'); return; }
      if (!ok) { mostrarAviso('error', datos.error || `Error ${status}`); return; }
      bloquearPantalla(datos);
    } catch (e) {
      quedoIncierto();
    } finally {
      estado.grabando = false;
      actualizarBotonGrabar();
    }
  }

  const TEXTOS_VERIFICACION = {
    cargado: {
      titulo: 'El comprobante quedó cargado en SiGA',
      texto: 'Confirmás que el comprobante de este pedido está en SiGA: se vincula al pedido y ya no se puede volver a importar.',
      aceptar: 'Sí, quedó cargado',
    },
    no_cargado: {
      titulo: 'El comprobante NO quedó cargado en SiGA',
      texto: 'Confirmás que el comprobante NO está en SiGA: el pedido se libera para volver a importarlo. Si en realidad quedó cargado, se va a duplicar.',
      aceptar: 'Sí, no quedó cargado',
    },
  };

  async function liberarVerificacion(resultado) {
    if (!(await confirmar(TEXTOS_VERIFICACION[resultado]))) return;
    const botones = document.querySelectorAll('[data-verif]');
    botones.forEach(b => { b.disabled = true; });
    try {
      const { ok, status, datos } = await postJSON(`/api/compras-siga/pedidos/${encodeURIComponent(pedido)}/liberar-verificacion`, { resultado });
      if (!ok) { mostrarAviso('error', datos.error || `Error ${status}`); return; }
      location.reload(); // vuelve a pedir el borrador con el estado nuevo
    } catch (e) {
      mostrarAviso('error', `No se pudo registrar la verificación: ${e.message}`);
    } finally {
      botones.forEach(b => { b.disabled = false; });
    }
  }

  function enlazarEventos() {
    $('#cTipo').addEventListener('change', () => { aplicarTipo($('#cLetra').value); programarValidacion(); });
    $('#cSucursal').addEventListener('change', () => { aplicarSucursal(); programarValidacion(); });
    ['#cLetra', '#cEmisor', '#cNumero', '#cFecha', '#cPeriodo', '#cUbicacion', '#cFormaPago', '#cDescGral', '#cObs']
      .forEach(id => $(id).addEventListener('input', programarValidacion));
    $('#tLineas').addEventListener('input', e => {
      const plu = e.target.dataset.plu;
      if (!plu) return;
      estado.precios = { ...estado.precios, [plu]: num(e.target.value) };
      programarValidacion();
    });
    $('#tbPercep').addEventListener('input', e => {
      const tr = e.target.closest('tr[data-i]');
      const k = e.target.dataset.k;
      if (!tr || !k) return;
      const i = Number(tr.dataset.i);
      const valor = k === 'tipo' || k === 'idProvincia' ? e.target.value : num(e.target.value);
      // Provincia, base y alícuota son solo de PIIBB: al cambiar a otro tipo se limpian y no viajan.
      const limpiar = k === 'tipo' && valor !== 'PIIBB' ? { idProvincia: '', baseImponible: null, alicuota: null } : {};
      estado.percepciones = estado.percepciones.map((p, j) => (j === i ? { ...p, [k]: valor, ...limpiar } : p));
      if (k === 'tipo') pintarPercepciones();
      programarValidacion();
    });
    $('#tbPercep').addEventListener('click', e => {
      const b = e.target.closest('[data-quitar]');
      if (!b) return;
      estado.percepciones = estado.percepciones.filter((_, j) => j !== Number(b.dataset.quitar));
      pintarPercepciones();
      programarValidacion();
    });
    $('#btnAgregarPercep').addEventListener('click', () => {
      // Fila vacía: el servidor la ignora hasta que tenga algún monto.
      estado.percepciones = [...estado.percepciones, { tipo: 'PIVA', importe: null, baseImponible: null, alicuota: null, idProvincia: '' }];
      pintarPercepciones();
    });
    $('#btnGrabar').addEventListener('click', grabar);
  }

  async function iniciar() {
    $('#titPedido').textContent = pedido ? `Pedido ${pedido}` : '';
    if (!pedido) { mostrarAviso('error', 'Falta el pedido en la dirección (?pedido=P-NNNN).'); return; }
    const { ok, status, datos } = await api(`/api/compras-siga/pedidos/${encodeURIComponent(pedido)}/borrador`);
    if (!ok) { mostrarAviso('error', datos.error || `No se pudo cargar el pedido (error ${status}).`); return; }
    estado.borrador = datos.borrador;
    estado.catalogos = datos.catalogos;
    // COMPRAS_SIGA_GRABAR del servidor: sin ella la pantalla es solo vista previa (el servidor igual rechaza con 403).
    estado.grabacionHabilitada = datos.grabacionHabilitada === true;
    $('#avisoVistaPrevia').style.display = estado.grabacionHabilitada ? 'none' : '';
    cargarCabecera(datos.borrador);
    cargarLineas(datos.borrador.lineas, datos.borrador.descartadas);
    pintarPercepciones();
    if (datos.aVerificar) mostrarVerificar();
    const avisos = [...datos.borrador.bloqueos.map(b => b.mensaje), ...(datos.catalogos.avisos || [])];
    estado.avisosBase = avisos;
    limpiarAviso();
    enlazarEventos();
    await validar();
  }

  $('#modalCancelar').addEventListener('click', () => cerrarModal(false));
  $('#modalAceptar').addEventListener('click', () => cerrarModal(true));
  document.addEventListener('keydown', e => {
    if (!resolverModal) return;
    if (e.key === 'Escape') { cerrarModal(false); return; }
    if (e.key !== 'Tab') return;
    // Foco atrapado en el modal: Tab / Shift+Tab ciclan entre sus dos botones.
    const botones = [$('#modalCancelar'), $('#modalAceptar')];
    const i = botones.indexOf(document.activeElement);
    e.preventDefault();
    botones[(i + (e.shiftKey ? botones.length - 1 : 1)) % botones.length].focus();
  });
  document.querySelectorAll('[data-verif]').forEach(b => b.addEventListener('click', () => liberarVerificacion(b.dataset.verif)));

  iniciar().catch(e => mostrarAviso('error', `Error al iniciar: ${e.message}`));
})();
