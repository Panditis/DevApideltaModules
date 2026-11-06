'use strict';
// ── Cotizador mayorista · vista de la tabla "Productos y secciones" (filas agrupadas por sección) ──
// Los inputs actualizan el estado (tp) sin repintar para no perder el foco; las operaciones de estructura repintan.

const NUEVA_SECCION = '__nueva__';
// [título, ancho, grupo]: PACK y BULTO se agrupan bajo una fila de encabezado superior.
const COLUMNAS_TABLA = [
  ['Orden', '76px'], ['Incl.', '56px'], ['Cod', '96px'], ['Nombre', 'auto'], ['Sección', '146px'],
  ['Cantidad', '106px', 'pack'], ['Modo / PLU / descuento / precio', '284px', 'pack'], ['Cantidad', '106px', 'bulto'], ['PLU / precio', '112px', 'bulto'], ['Tipo y estado', '116px'],
];
const GRUPOS_TABLA = [['Producto', 5, ''], ['PACK', 2, 'pack'], ['BULTO', 2, 'bulto'], ['', 1, '']];

const etiquetaFila = f => f.cod || 'fila nueva';
function entrada(f, campo, opciones = {}) {
  return h('input', {
    class: `campo w-full ${opciones.num ? 'text-right tabular-nums' : ''}`, type: 'text', value: f[campo] ?? '', 'data-campo': campo,
    'aria-label': `${opciones.etiqueta || campo} de ${etiquetaFila(f)}`, placeholder: opciones.placeholder || null, disabled: !tp.puede,
    inputmode: opciones.num ? 'numeric' : null, autocomplete: 'off', spellcheck: 'false',
    oninput: e => { actualizarFila(f._id, { [campo]: e.target.value }); if (opciones.alCambiar) opciones.alCambiar(e.target); actualizarBarra(); },
  });
}

function notaCantidad(valor) {
  const n = normalizarCantidad(valor);
  if (n.valor === '') return h('span', { class: 'nota text-gris' }, 'Sin cantidad');
  if (n.valor === null) return h('span', { class: 'nota text-crit font-semibold' }, `⚠ ${n.aviso}`);
  return h('span', { class: 'nota text-gris' }, 'Se exporta: ', h('b', { class: 'text-ink' }, n.valor));
}
function celdaCantidad(f, campo, etiqueta) {
  if (campo === 'packQty' && modoDe(f) === 'ninguno') return h('td', { class: 'text-gris' }, '—');
  const nota = h('div', null, notaCantidad(f[campo]));
  const alCambiar = el => {
    montar(nota, notaCantidad(el.value));
    el.closest('tr').classList.toggle('fila-aviso', filaConAviso(tp.filas.find(x => x._id === f._id)));
  };
  const placeholder = campo === 'packQty' && modoDe(f) === 'descuento' ? 'obligatoria, ej. 12u' : null;
  return h('td', null, entrada(f, campo, { etiqueta, alCambiar, placeholder }), nota);
}
function celdaPluOPrecio(f, tipo) {
  if (f.manual) return h('td', null, entrada(f, `${tipo}Price`, { num: true, etiqueta: `Precio fijo ${tipo}`, placeholder: 'Precio $' }));
  return h('td', null, entrada(f, `${tipo}Plu`, { num: true, etiqueta: `PLU ${tipo}`, placeholder: 'automático' }));
}

// ── Pack de filas no manuales: modo (PLU / descuento / ninguno) ──
const MODOS_PACK = [['plu', 'PLU pack'], ['descuento', '% sobre minorista'], ['ninguno', 'Sin precio pack']];
function cambiarModoPack(f, modo) {
  actualizarFila(f._id, { modoPack: modo });
  pintarFilas();
  actualizarBarra();
  const sel = document.querySelector(`[data-fila="${f._id}"] select[data-campo="modoPack"]`);
  if (sel) sel.focus();
}
// Pack calculado que trajo la vista previa, sólo si corresponde al descuento tal como está cargado.
function packDeReferencia(f) {
  const r = exp.previa && (exp.previa.filas || []).find(x => x.cod === f.cod);
  const d = r && r.modoPack === 'descuento' ? r.descuento : null;
  return d && Number(d.pct) === parseDescuento(f.descuentoPack) && d.pack != null ? d.pack : null;
}
function notaDescuento(f) {
  if (!descuentoValido(f.descuentoPack)) return h('span', { class: 'nota text-crit font-semibold' }, '⚠ El descuento tiene que ser mayor que 0 y menor que 100');
  const ref = packDeReferencia(f);
  return h('span', { class: 'nota text-gris' }, ref != null ? ['Pack calculado: ', h('b', { class: 'text-ink' }, fmtPrecio(ref)), ' (vista previa)'] : 'Se calcula en la vista previa');
}
function celdaPack(f) {
  const modo = modoDe(f);
  const sel = h('select', { class: 'campo w-full', 'data-campo': 'modoPack', 'aria-label': `Precio pack de ${etiquetaFila(f)}`, disabled: !tp.puede,
    onchange: () => cambiarModoPack(f, sel.value) }, MODOS_PACK.map(([v, t]) => h('option', { value: v }, t)));
  sel.value = modo;
  if (modo === 'ninguno') return h('td', null, h('div', { class: 'pack-fila' }, sel), h('span', { class: 'nota text-gris' }, 'Sin precio pack'));
  if (modo === 'plu') return h('td', null, h('div', { class: 'pack-fila' }, sel, entrada(f, 'packPlu', { num: true, etiqueta: 'PLU pack', placeholder: 'automático' })));
  const nota = h('div', null, notaDescuento(f));
  const alCambiar = el => {
    const actual = tp.filas.find(x => x._id === f._id);
    montar(nota, notaDescuento(actual));
    el.closest('tr').classList.toggle('fila-aviso', filaConAviso(actual));
  };
  return h('td', null, h('div', { class: 'pack-fila' }, sel, entrada(f, 'descuentoPack', { num: true, etiqueta: '% de descuento', placeholder: '% desc.', alCambiar })), nota);
}

async function elegirSeccion(f, select) {
  let destino = select.value;
  if (destino === NUEVA_SECCION) {
    destino = (await apdPedir('Nombre de la nueva sección', '', { titulo: 'Nueva sección' }) || '').trim();
    if (!destino) { select.value = f.seccion; return; }
  }
  actualizarFila(f._id, { seccion: destino });
  tp.filas = aplanar(agrupar(tp.filas));
  pintarTabla();
}
function celdaSeccion(f, nombres) {
  const opciones = nombres.includes(f.seccion) ? nombres : [...nombres, f.seccion];
  const sel = h('select', { class: 'campo w-full', 'aria-label': `Sección de ${etiquetaFila(f)}`, disabled: !tp.puede, onchange: () => elegirSeccion(f, sel) },
    opciones.map(n => h('option', { value: n }, n)), h('option', { value: NUEVA_SECCION }, '＋ Nueva sección…'));
  sel.value = f.seccion;
  return h('td', null, sel);
}

const botonMover = (txt, etiqueta, dir, deshabilitado, alClick) =>
  h('button', { type: 'button', class: 'btn-icono', 'aria-label': etiqueta, title: etiqueta, disabled: deshabilitado, onclick: alClick }, txt);

function celdaOrden(f, pos) {
  const bloqueado = !tp.puede || filtrando();
  const tip = filtrando() ? 'Quitá la búsqueda y el filtro de estado para reordenar' : '';
  return h('td', { title: tip }, h('div', { class: 'grupo-mov' },
    botonMover('▲', `Subir ${etiquetaFila(f)}`, -1, bloqueado || pos.primera, () => moverFila(f._id, -1)),
    botonMover('▼', `Bajar ${etiquetaFila(f)}`, 1, bloqueado || pos.ultima, () => moverFila(f._id, 1))));
}
// Los chips de estado (aviso / no incluida) los muestra el CSS según la clase de la fila: no hace falta repintar al editar.
function celdaTipo(f) {
  const estados = [h('span', { class: 'est est-aviso' }, '⚠ Revisar'), h('span', { class: 'est est-off' }, 'No incluida')];
  if (!f.manual) return h('td', null, h('div', { class: 'est-col' }, chip('Sistema'), estados));
  return h('td', null, h('div', { class: 'est-col' }, h('div', { class: 'est-fila' }, chip('Manual', 'warn'),
    botonMover('✕', `Quitar la fila manual ${etiquetaFila(f)}`, 0, !tp.puede, () => quitarFila(f._id))), estados));
}

function filaTabla(f, nombres, pos) {
  const check = h('input', { type: 'checkbox', class: 'check', checked: f.incluido, disabled: !tp.puede, 'aria-label': `Incluir ${etiquetaFila(f)} en el catálogo`,
    onchange: e => { actualizarFila(f._id, { incluido: e.target.checked }); e.target.closest('tr').classList.toggle('fila-off', !e.target.checked); actualizarBarra(); } });
  return h('tr', { 'data-fila': f._id, class: `${f.incluido ? '' : 'fila-off'} ${filaConAviso(f) ? 'fila-aviso' : ''} ${f.manual ? 'fila-manual' : ''}` },
    celdaOrden(f, pos), h('td', null, check),
    f.manual ? h('td', null, entrada(f, 'cod', { etiqueta: 'Código' })) : h('td', { class: 'cod-fijo' }, f.cod),
    h('td', null, h('div', { title: f.nombre || null }, entrada(f, 'nombre', { etiqueta: 'Nombre' }))), celdaSeccion(f, nombres),
    celdaCantidad(f, 'packQty', 'Cantidad pack'), f.manual ? celdaPluOPrecio(f, 'pack') : celdaPack(f),
    celdaCantidad(f, 'bultoQty', 'Cantidad bulto'), celdaPluOPrecio(f, 'bulto'), celdaTipo(f));
}

function filaSeccion(g, indice, total) {
  const bloqueado = !tp.puede || tp.seccion !== '' || filtrando();
  return h('tr', { class: 'grupo fila-seccion' }, h('td', { colspan: String(COLUMNAS_TABLA.length) },
    h('div', { class: 'flex items-center gap-2' },
      h('strong', null, g.seccion), h('span', { class: 'sec-n' }, `${fmtNum(g.filas.length)} ${g.filas.length === 1 ? 'producto' : 'productos'}`),
      h('span', { class: 'ml-auto flex items-center gap-2' }, h('span', { class: 'grupo-mov' },
        botonMover('▲', `Subir la sección ${g.seccion}`, -1, bloqueado || indice === 0, () => moverSeccion(g.seccion, -1)),
        botonMover('▼', `Bajar la sección ${g.seccion}`, 1, bloqueado || indice === total - 1, () => moverSeccion(g.seccion, 1))),
        h('button', { type: 'button', class: 'btn-sec btn-chico', disabled: !tp.puede, onclick: async () => {
          const nuevo = await apdPedir('Nuevo nombre de la sección', g.seccion, { titulo: 'Renombrar sección' });
          if (nuevo != null) renombrarSeccion(g.seccion, nuevo);
        } }, 'Renombrar')))));
}

// ── Estados de la vista: cargando (esqueleto), vacío y sin resultados ──
function cargandoTabla(cont) {
  montar(cont, h('div', { class: 'carga-prod', role: 'status' }, h('div', { class: 'carga-tit' }, 'Cargando productos…'),
    [1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'carga-fila', 'aria-hidden': 'true' }))));
}
function vacioTabla(cont, { icono, titulo, detalle, accion }) {
  montar(cont, h('div', { class: 'vacio-prod' }, h('div', { class: `vacio-ico vacio-ico--${icono}`, 'aria-hidden': 'true' }),
    h('div', { class: 'vacio-tit' }, titulo), h('p', { class: 'vacio-det' }, detalle), accion));
}
function limpiarFiltros() {
  tp.q = ''; tp.estado = 'todos'; tp.seccion = '';
  $('tablaBuscar').value = '';
  $('tablaSeccion').value = '';
  pintarFilas();
  actualizarBarra();
}

function pintarFilas() {
  const cont = $('tablaCont');
  if (!tp.cargada) return;
  const scroll = cont.querySelector('.tabla-scroll');
  const top = scroll ? scroll.scrollTop : 0;
  const todos = agrupar(tp.filas);
  const nombres = todos.map(g => g.seccion);
  const visibles = todos.map((g, i) => ({ g, i, filas: g.filas.filter(pasaFiltro) })).filter(x => x.filas.length);
  if (!tp.filas.length) return vacioTabla(cont, { icono: 'lista', titulo: 'La tabla está vacía', detalle: 'Importá el Excel de la planilla o agregá filas manuales con el botón “Fila manual”.' });
  if (!visibles.length) {
    return vacioTabla(cont, { icono: 'lupa', titulo: 'Sin resultados', detalle: 'Ninguna fila coincide con la búsqueda o los filtros.',
      accion: h('button', { type: 'button', class: 'btn-sec', onclick: limpiarFiltros }, 'Limpiar búsqueda y filtros') });
  }
  const cuerpo = h('tbody', null, visibles.flatMap(({ g, i, filas }) => [
    filaSeccion({ ...g, filas }, i, todos.length),
    ...filas.map(f => filaTabla(f, nombres, { primera: g.filas[0] === f, ultima: g.filas[g.filas.length - 1] === f })),
  ]));
  const cabecera = h('thead', null,
    h('tr', null, GRUPOS_TABLA.map(([t, n, g]) => h('th', { colspan: String(n), class: g ? `gh-${g}` : '', scope: n > 1 ? 'colgroup' : 'col' }, t))),
    h('tr', null, COLUMNAS_TABLA.map(([t, , g]) => h('th', { scope: 'col', class: g ? `g-${g}` : '', 'aria-label': g ? `${t} ${g}` : null }, t))));
  const tabla = h('table', { class: 'tabla-fija tabla-edit tabla-prod' },
    h('colgroup', null, COLUMNAS_TABLA.map(([, w]) => h('col', { style: `width:${w}` }))), cabecera, cuerpo);
  const nuevo = h('div', { class: 'tabla-scroll tabla-scroll--alta' }, tabla);
  montar(cont, nuevo);
  nuevo.scrollTop = top;
}
