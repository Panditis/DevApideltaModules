'use strict';
// ── Cotizador mayorista · paso 3 de Exportar: descarga de archivos e instrucciones de subida por FTP ──
// El sistema NO sube nada ni guarda contraseñas: el usuario sube a mano (curl o WinSCP) y el FTP pide la clave.

const subida = { datos: null, comandos: [], version: null, error: null };

const urlArchivo = (version, archivo) => `${API}/publicaciones/${encodeURIComponent(version)}/${archivo}`;

function enlaceDescarga(version, archivo, desc) {
  return h('a', { class: 'btn-descarga', href: urlArchivo(version, archivo), download: archivo },
    h('strong', null, archivo), h('span', { class: 'text-xs text-gris' }, desc));
}

function bloqueArchivos() {
  if (subida.version == null) return h('div', { class: 'empty' }, 'Todavía no hay ninguna versión generada. Generá una en el paso 2 para poder descargarla.');
  return h('div', { class: 'space-y-2' },
    h('p', { class: 'text-sm' }, 'Archivos de la ', h('strong', null, `versión v${subida.version}`), ':'),
    h('div', { class: 'flex flex-wrap gap-3' },
      enlaceDescarga(subida.version, 'catalogo.csv', 'Los productos y precios'),
      enlaceDescarga(subida.version, 'version.json', 'Avisa al cotizador que hay datos nuevos')));
}

function bloqueInstrucciones() {
  return h('div', { class: 'space-y-1' },
    h('h4', { class: 'subtitulo' }, 'Cómo subirlos al cotizador'),
    h('ol', { class: 'pasos-lista' },
      h('li', null, 'Subí primero ', h('code', null, 'catalogo.csv'), '.'),
      h('li', null, 'Después subí ', h('code', null, 'version.json'), ': es el que hace que el cotizador se actualice.'),
      h('li', null, 'Verificá abriendo el cotizador y mirando que aparezca la versión y los precios nuevos.')));
}

function bloqueComandos() {
  const cajas = subida.comandos.map(cmd => h('div', { class: 'cmd' },
    h('code', { class: 'cmd-txt' }, cmd),
    h('button', { type: 'button', class: 'btn-sec', onclick: async e => {
      const b = e.currentTarget;
      b.textContent = (await copiarTexto(cmd)) ? 'Copiado' : 'No se pudo copiar';
      setTimeout(() => { b.textContent = 'Copiar'; }, 1800);
    } }, 'Copiar')));
  return h('div', { class: 'space-y-2' },
    h('h4', { class: 'subtitulo' }, 'Opción A: comandos curl'),
    h('p', { class: 'text-sm text-gris' }, 'Abrí una consola en la carpeta donde descargaste los archivos y ejecutá los comandos en este orden. curl te pide la contraseña por teclado.'),
    cajas.length ? cajas : h('div', { class: 'empty' }, 'No se pudieron armar los comandos.'));
}

function bloqueWinscp() {
  const d = subida.datos || {};
  return h('div', { class: 'space-y-1' },
    h('h4', { class: 'subtitulo' }, 'Opción B: WinSCP'),
    h('p', { class: 'text-sm' }, 'Protocolo FTP, host ', h('code', null, d.host || '—'), ', usuario ', h('code', null, d.usuario || '—'),
      ', carpeta remota ', h('code', null, d.ruta || '—'), '. La contraseña la escribís vos en WinSCP; acá no se guarda.'));
}

function campoSubida(id, etiqueta, valor, ancho) {
  return h('label', { class: 'campo-etq', for: id }, etiqueta, h('input', { id, class: 'campo', style: `width:${ancho}`, value: valor || '', autocomplete: 'off', spellcheck: 'false' }));
}

function formularioSubida() {
  const d = subida.datos || {};
  const guardar = h('button', { type: 'button', id: 'btnGuardarSubida', class: 'btn-sec', onclick: guardarSubida }, 'Guardar datos de conexión');
  permisoEditar.then(ok => { guardar.disabled = !ok; guardar.title = ok ? '' : TIP_SIN_PERMISO; ['subHost', 'subUsuario', 'subRuta'].forEach(i => { $(i).disabled = !ok; }); });
  return h('div', { class: 'space-y-2' },
    h('h4', { class: 'subtitulo' }, 'Datos de conexión'),
    h('div', { class: 'flex flex-wrap items-end gap-3' }, campoSubida('subHost', 'Host', d.host, '16rem'), campoSubida('subUsuario', 'Usuario', d.usuario, '10rem'),
      campoSubida('subRuta', 'Ruta remota', d.ruta, '14rem'), guardar),
    h('p', { id: 'subMsg', class: 'text-sm', 'aria-live': 'polite' }));
}

async function guardarSubida() {
  const msg = $('subMsg');
  try {
    const r = await apiJson('/subida', 'PUT', { host: $('subHost').value, usuario: $('subUsuario').value, ruta: $('subRuta').value });
    subida.datos = r.subida;
    subida.comandos = r.comandos;
    renderDescarga(subida.version);
    toast('Datos de conexión guardados');
  } catch (err) {
    msg.className = 'text-sm text-crit';
    msg.textContent = err.message;
  }
}

const NOTA_SEGURIDAD = 'Ojo: el FTP común no cifra nada (usuario y contraseña viajan en claro). Si el hosting lo permite, usá FTPS o SFTP.';

function renderDescarga(version) {
  if (version !== undefined) subida.version = version;
  const cont = $('descarga');
  if (subida.error) return estadoError(cont, subida.error);
  if (!subida.datos) return estadoCarga(cont);
  return montar(cont, bloqueArchivos(), h('details', { class: 'acordeon' },
    h('summary', { class: 'acordeon-sum' }, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▶'), 'Subir a mano'),
    h('div', { class: 'p-3 space-y-4' }, h('p', { class: 'text-sm text-gris' }, 'Respaldo por si la publicación automática no anda. Solo hace falta si no usaste el botón Publicar.'),
      bloqueInstrucciones(), bloqueComandos(), bloqueWinscp(), formularioSubida(),
      h('p', { class: 'aviso-amarillo text-sm' }, NOTA_SEGURIDAD))));
}

async function iniciarSubida() {
  estadoCarga($('descarga'));
  try {
    const t = await api('/tabla');
    subida.datos = t.subida;
    subida.comandos = t.comandos || [];
    subida.error = null;
  } catch (err) {
    subida.error = err;
  }
  renderDescarga();
}
