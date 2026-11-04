'use strict';
// ── Cotizador mayorista · importar el Excel de la planilla (POST /importar, multipart "file") ──
// El backend guarda la tabla directo y REEMPLAZA la anterior: por eso se pide confirmación antes y recién después
// se muestra el resumen (conteos, descartadas y los productos sin vincular).

const MENSAJE_IMPORTAR = 'Importar reemplaza TODA la tabla actual (productos, secciones, orden y filas manuales) por el contenido del Excel, '
  + 'y se guarda enseguida. Los cambios sin guardar de esta pantalla se pierden.';

const dato = (rotulo, valor) => [h('dt', null, rotulo), h('dd', null, valor)];

function listaSinVincular(sin) {
  if (!sin.length) return h('p', { class: 'text-sm text-ok' }, 'Todos los productos del sistema quedaron vinculados.');
  const tabla = crearTabla({
    cols: [
      { key: 'cod', titulo: 'Cod', ancho: '100px', valor: f => f.cod },
      { key: 'nombre', titulo: 'Nombre', ancho: 'auto', valor: f => f.nombre },
      { key: 'faltan', titulo: 'Sin vínculo en', ancho: '170px', valor: f => f.faltan.join(', '), celda: f => f.faltan.map(t => (t === 'pack' ? 'Pack' : 'Bulto')).join(' y ') },
    ],
  });
  tabla.el.classList.add('max-h-[240px]');
  tabla.set(sin);
  return h('details', { class: 'acordeon', open: true }, h('summary', { class: 'acordeon-sum' }, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▶'), `Sin vincular (${fmtNum(sin.length)})`),
    h('div', { class: 'p-3 space-y-2' }, h('p', { class: 'text-sm text-gris' }, 'Estos productos no tienen precio vinculado en el módulo Precios: van a usar el respaldo hasta que se vinculen (podés cargar el PLU a mano en la tabla).'), tabla.el));
}

function resumenImportacion(r) {
  const v = r.vinculos;
  return h('div', { class: 'ok-box space-y-2', role: 'status' },
    h('div', { class: 'flex items-center' }, h('strong', null, 'Importación hecha: la tabla fue reemplazada'),
      h('button', { type: 'button', class: 'btn-sec btn-chico ml-auto', onclick: () => vaciar($('importResultado')) }, 'Cerrar')),
    h('dl', { class: 'datos' }, dato('Filas', fmtNum(r.filas)), dato('Secciones', fmtNum(r.secciones)), dato('Manuales', fmtNum(r.manuales)),
      dato('Descartadas', (r.descartadas || []).length ? `${fmtNum(r.descartadas.length)} (filas del Excel: ${r.descartadas.join(', ')})` : '0'),
      v ? dato('Vinculados', fmtNum(v.vinculados)) : null, v ? dato('Sin vincular', fmtNum(v.sinVincular.length)) : null),
    r.aviso ? h('div', { class: 'aviso-amarillo text-sm' }, r.aviso) : null,
    v ? listaSinVincular(v.sinVincular) : null);
}

async function importarArchivo(archivo) {
  if (!(await apdConfirmar(`${MENSAJE_IMPORTAR}\n\nArchivo: ${archivo.name}`, { titulo: '¿Reemplazar la tabla?', aceptar: 'Importar y reemplazar', peligro: true }))) return;
  const destino = $('importResultado');
  estadoCarga(destino, 'Importando el Excel…');
  const fd = new FormData();
  fd.append('file', archivo);
  try {
    const r = await api('/importar', { method: 'POST', body: fd });
    montar(destino, resumenImportacion(r));
    await cargarTabla();
  } catch (err) {
    estadoError(destino, err);
  }
}

function iniciarImportar() {
  const input = $('importArchivo');
  $('btnImportar').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const archivo = input.files && input.files[0];
    input.value = '';
    if (archivo) importarArchivo(archivo);
  });
}
