'use strict';
// ── Cotizador mayorista · pestaña Historial (GET /historial) ──

function insigniaPublicacion(p, f) {
  if (f && f.metaIlegible) return chip('Datos ilegibles', 'warn');
  if (!p) return chip('Sin publicar', 'gris');
  if (p.ok) return chip(`Publicada ${horaYDia(p.fecha)}`, 'ok');
  const c = chip(`Falló: ${p.error || 'sin detalle'}`, 'crit');
  c.title = p.error || '';
  c.style.cssText = 'max-width:100%;white-space:normal';
  return c;
}

async function republicar(version) {
  const ok = await apdConfirmar(`Se va a subir la versión v${version} al cotizador y va a reemplazar los precios que ven hoy los clientes.`,
    { titulo: `¿Publicar la versión v${version}?`, aceptar: 'Publicar', peligro: true });
  if (!ok) return;
  await publicarVersion(version);
  cargarHistorial();
}

const histTabla = crearTabla({
  vacio: 'Todavía no se generó ninguna versión.',
  cols: [
    { key: 'version', titulo: 'Versión', ancho: '90px', valor: f => f.version, celda: f => h('strong', null, f.version == null ? '—' : `v${f.version}`) },
    { key: 'generado', titulo: 'Fecha', ancho: '175px', valor: f => String(f.generado || ''), celda: f => (f.generado ? fmtFecha(f.generado) : '—') },
    { key: 'usuario', titulo: 'Usuario', ancho: 'auto', valor: f => f.usuario || '', celda: f => f.usuario || '—' },
    { key: 'productos', titulo: 'Productos', ancho: '90px', num: true, valor: f => f.productos, celda: f => fmtNum(f.productos) },
    { key: 'nuevos', titulo: 'Nuevos', ancho: '80px', num: true, valor: f => f.nuevos, celda: f => fmtNum(f.nuevos) },
    { key: 'quitados', titulo: 'Quitados', ancho: '84px', num: true, valor: f => f.quitados, celda: f => fmtNum(f.quitados) },
    { key: 'cambiados', titulo: 'Cambiados', ancho: '96px', num: true, valor: f => f.cambiados, celda: f => fmtNum(f.cambiados) },
    { key: 'sha', titulo: 'sha256', ancho: '110px', valor: f => f.sha256 || '', celda: f => h('code', { title: f.sha256 || '' }, String(f.sha256 || '').slice(0, 10)) },
    { key: 'publicado', titulo: 'Publicación', ancho: '190px', valor: f => (f.publicado ? String(f.publicado.fecha || '') : ''), celda: f => insigniaPublicacion(f.publicado, f) },
    { key: 'republicar', titulo: '', ancho: '90px', celda: f => h('button', { type: 'button', class: 'btn-sec btn-chico js-publicar', 'data-ilegible': f.metaIlegible || f.version == null ? '1' : null, 'aria-label': `Publicar la versión ${f.version}`, onclick: () => republicar(f.version) }, 'Publicar') },
    { key: 'archivos', titulo: 'Descargar', ancho: '210px',
      celda: f => h('div', { class: 'flex gap-2' },
        ['catalogo.csv', 'version.json'].map(a => h('a', { class: 'enlace', href: urlArchivo(f.version, a), download: a, 'aria-label': `Descargar ${a} de la versión ${f.version}` }, a))) },
  ],
});
histTabla.el.classList.add('tabla-scroll--alta');

async function cargarHistorial() {
  const cont = $('historialCont');
  estadoCarga(cont, 'Cargando el historial…');
  try {
    const lista = await api('/historial');
    if (!Array.isArray(lista)) throw new Error('Respuesta inesperada del historial');
    await configPublicar;
    montar(cont, histTabla.el);
    histTabla.set(lista);
    refrescarBotonesPublicar();
  } catch (err) {
    estadoError(cont, err);
  }
}
function iniciarHistorial() {
  $('btnHistorial').addEventListener('click', cargarHistorial);
}
