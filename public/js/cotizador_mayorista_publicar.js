'use strict';
// ── Cotizador mayorista · publicar por FTP desde el servidor ──
// GET /publicar/config (destino y si hay contraseña cargada), POST /publicaciones/:version/publicar.
// La contraseña vive en un archivo de config del servidor: nunca pasa por esta pantalla.

const pub = { config: null, errorConfig: null, puede: false, corriendo: false, estado: null };

const configPublicar = Promise.all([
  api('/publicar/config').then(c => { pub.config = c; }).catch(err => { pub.errorConfig = err; }),
  permisoEditar.then(ok => { pub.puede = ok; }),
]);

const horaCorta = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
};
const horaYDia = iso => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${horaCorta(iso)} ${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}`;
};

// Motivo por el que no se puede publicar ('' = se puede). Sirve a todos los botones Publicar.
function motivoNoPublicar() {
  if (!pub.puede) return TIP_SIN_PERMISO;
  if (pub.errorConfig) return 'No se pudo leer la configuración de publicación';
  if (pub.config && !pub.config.tienePassword) return 'Falta la contraseña del FTP en el servidor';
  if (!pub.config) return 'Cargando la configuración de publicación…';
  return '';
}

function refrescarBotonesPublicar() {
  const motivo = motivoNoPublicar();
  document.querySelectorAll('.js-publicar').forEach(b => {
    const motivoGen = b.dataset.extra === 'generar' ? (pub.motivoGenerar || '') : '';
    b.disabled = !!b.dataset.ilegible || !!motivo || !!motivoGen || pub.corriendo || (b.dataset.extra === 'generar' && generando);
    b.title = motivo || motivoGen;
  });
}

function pintarEstadoPublicar() {
  const cont = $('publicarEstado');
  if (!cont) return;
  const e = pub.estado;
  if (!e) return vaciar(cont);
  if (e.tipo === 'subiendo') return montar(cont, h('div', { class: 'loading', role: 'status' }, `Subiendo la versión v${e.version} por FTP…`));
  if (e.tipo === 'ok') return montar(cont, h('div', { class: 'ok-box text-sm', role: 'status' }, `Versión v${e.version} publicada a las ${horaCorta(e.publicadoEn)}`));
  return montar(cont, h('div', { class: 'error text-sm', role: 'alert' }, `No se pudo publicar la versión v${e.version}: ${e.msg}`));
}

// Publica una versión ya generada. Devuelve true si salió bien. Un solo publicar a la vez (el server responde 409 si no).
async function publicarVersion(version) {
  if (pub.corriendo) return false;
  pub.corriendo = true;
  pub.estado = { tipo: 'subiendo', version };
  pintarEstadoPublicar();
  refrescarBotonesPublicar();
  try {
    const r = await apiJson(`/publicaciones/${encodeURIComponent(version)}/publicar`, 'POST', {});
    if (r.ok !== true) throw new Error(r.error || 'El servidor no confirmó la publicación');
    pub.estado = { tipo: 'ok', version: r.version ?? version, publicadoEn: r.publicadoEn };
    toast(`Versión v${version} publicada`);
    return true;
  } catch (err) {
    pub.estado = { tipo: 'error', version, msg: err.message };
    toast(`No se pudo publicar la versión v${version}`, 'crit');
    return false;
  } finally {
    pub.corriendo = false;
    pintarEstadoPublicar();
    refrescarBotonesPublicar();
  }
}

// Destino + aviso de contraseña (paso 2 de Exportar).
function pintarDestinoPublicar() {
  const cont = $('publicarDestino');
  if (pub.errorConfig) return montar(cont, h('div', { class: 'error text-sm', role: 'alert' }, `No se pudo leer el destino de la publicación: ${pub.errorConfig.message}`));
  const c = pub.config || {};
  const archivo = 'data/cotizador_ftp.json (campo password)';
  montar(cont,
    h('p', { class: 'text-sm' }, 'Destino: ', h('code', null, `${c.host || '—'}${c.puerto ? `:${c.puerto}` : ''}`), ' · carpeta ', h('code', null, c.rutaRemota || '—'),
      c.secure ? ' · conexión cifrada' : null),
    c.tienePassword === false
      ? h('div', { class: 'aviso-amarillo text-sm', role: 'alert' }, 'Falta la contraseña del FTP: cargala en ', h('code', null, archivo), ' y volvé a intentar.')
      : null,
    c.aviso ? h('div', { class: 'aviso-amarillo text-sm', role: 'status' }, c.aviso) : null);
}

async function publicarDesdeExportar() {
  if (pub.corriendo || generando) return;
  const version = await generarVersion();
  if (version != null) await publicarVersion(version);
}

async function iniciarPublicar() {
  $('btnPublicar').addEventListener('click', publicarDesdeExportar);
  await configPublicar;
  pintarDestinoPublicar();
  refrescarBotonesPublicar();
}
