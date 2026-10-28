'use strict';
// Piezas de UI de adjuntos para /tickets y Mantenimiento: validación en el cliente, botón "Adjuntar", chips de los archivos
// elegidos (todavía sin subir) y lista de adjuntos ya guardados. Sin red ni estado propio: tickets.js decide cuándo subir.
// Los nombres de archivo los tipea cualquiera: se pintan siempre con textContent, nunca con innerHTML.
// Los helpers puros (validar, formatoTamano, esImagen) también se cargan desde Node para testearlos.
(() => {
  const MAX_BYTES = 10 * 1024 * 1024; // espejo de lib/tickets.js
  const MAX_ARCHIVOS = 5;
  const EXTENSIONES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt'];
  const IMAGENES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const ACCEPT = EXTENSIONES.map(e => `.${e}`).join(',');

  const extensionDe = nombre => (String(nombre).includes('.') ? String(nombre).split('.').pop().toLowerCase() : '');
  const esImagen = nombre => IMAGENES.includes(extensionDe(nombre));

  function formatoTamano(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
  }

  // { validos, errores }: `elegidos` son los que ya estaban; entre todos no pasan de MAX_ARCHIVOS.
  function validar(nuevos, elegidos = []) {
    const validos = [];
    const errores = [];
    for (const f of nuevos) {
      if (elegidos.length + validos.length >= MAX_ARCHIVOS) errores.push(`Máximo ${MAX_ARCHIVOS} archivos por vez: «${f.name}» no se agregó.`);
      else if (!EXTENSIONES.includes(extensionDe(f.name))) errores.push(`«${f.name}»: tipo no permitido (se aceptan ${EXTENSIONES.join(', ')}).`);
      else if (!f.size) errores.push(`«${f.name}» está vacío.`);
      else if (f.size > MAX_BYTES) errores.push(`«${f.name}» pesa más de ${MAX_BYTES / (1024 * 1024)} MB.`);
      else validos.push(f);
    }
    return { validos, errores };
  }

  // `ico(nombre)` y `el(tag, clase, texto)` son los de tickets.js.
  function crearUI({ ico, el }) {
    const boton = (texto, clase, id, alClic) => {
      const b = el('button', `btn btn-sm ${clase}`, texto);
      b.type = 'button';
      b.id = id;
      b.addEventListener('click', alClic);
      return b;
    };

    // Botón con un <input type=file> oculto. alElegir(File[]) recibe lo elegido; el input se limpia para poder repetir el mismo archivo.
    function botonAdjuntar({ id, texto = 'Adjuntar', alElegir, deshabilitado = false }) {
      const raiz = el('span', 'adj-boton');
      const entrada = el('input');
      Object.assign(entrada, { type: 'file', id: `${id}-input`, multiple: true, accept: ACCEPT, hidden: true, tabIndex: -1 });
      entrada.addEventListener('change', () => {
        const elegidos = [...entrada.files];
        entrada.value = '';
        if (elegidos.length) alElegir(elegidos);
      });
      const b = el('button', 'btn btn-sm');
      Object.assign(b, { type: 'button', id, disabled: deshabilitado });
      b.innerHTML = ico('clip');
      b.append(texto);
      b.addEventListener('click', () => entrada.click());
      raiz.append(entrada, b);
      return raiz;
    }

    // Archivos elegidos y todavía sin subir (alta y nota nueva), cada uno con su botón para quitarlo.
    function chipsArchivos(archivos, alQuitar, idBase) {
      const ul = el('ul', 'adj-chips');
      ul.setAttribute('aria-label', 'Archivos para adjuntar');
      ul.replaceChildren(...archivos.map((f, i) => {
        const li = el('li', 'adj-chip');
        li.innerHTML = ico('archivo');
        li.append(el('span', 'adj-nombre', f.name), el('span', 'adj-peso', formatoTamano(f.size)));
        const quitar = el('button', 'btn-ico');
        Object.assign(quitar, { type: 'button', id: `${idBase}-quitar-${i}`, title: `Quitar ${f.name}` });
        quitar.setAttribute('aria-label', `Quitar ${f.name}`);
        quitar.innerHTML = ico('x');
        quitar.addEventListener('click', () => alQuitar(i));
        li.append(quitar);
        return li;
      }));
      return ul;
    }

    function listaErrores(errores) {
      const ul = el('ul', 'adj-errores');
      ul.setAttribute('role', 'alert');
      ul.replaceChildren(...errores.map(m => el('li', null, m)));
      return ul;
    }

    // Adjuntos ya guardados: miniatura si es imagen (se abre en otra pestaña), ícono si no (se descarga). `pendiente` = id del
    // adjunto con la confirmación "¿Quitar?" a la vista. Los ids de los botones llevan idBase para devolver el foco tras repintar.
    function listaAdjuntos(adjuntos, { idBase, urlDe, leyenda, quitable = false, ocupado = false, pendiente = null, alPedirQuitar, alCancelar, alConfirmar }) {
      const controlQuitar = a => {
        if (pendiente === a.id) {
          const grupo = el('span', 'adj-confirm');
          grupo.setAttribute('role', 'group');
          grupo.setAttribute('aria-label', `Confirmar quitar ${a.nombre}`);
          const si = boton('Sí', 'btn-peligro', `${idBase}-si-${a.id}`, () => alConfirmar(a));
          const no = boton('No', '', `${idBase}-no-${a.id}`, () => alCancelar(a));
          si.disabled = no.disabled = ocupado; // mientras se quita, un segundo clic no manda otro DELETE
          grupo.append(el('span', null, '¿Quitar?'), si, no);
          grupo.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); alCancelar(a); } });
          return grupo;
        }
        const b = el('button', 'btn-ico');
        Object.assign(b, { type: 'button', id: `${idBase}-del-${a.id}`, disabled: ocupado, title: `Quitar ${a.nombre}` });
        b.setAttribute('aria-label', `Quitar ${a.nombre}`);
        b.innerHTML = ico('papelera');
        b.addEventListener('click', () => alPedirQuitar(a));
        return b;
      };
      const ul = el('ul', 'adj-lista');
      ul.setAttribute('aria-label', 'Archivos adjuntos');
      ul.replaceChildren(...adjuntos.map(a => {
        const li = el('li', 'adj-item');
        const enlace = el('a', 'adj-enlace');
        enlace.href = urlDe(a);
        if (esImagen(a.nombre)) {
          Object.assign(enlace, { target: '_blank', rel: 'noopener' });
          const img = el('img', 'adj-thumb');
          Object.assign(img, { src: urlDe(a), alt: '', loading: 'lazy' });
          enlace.append(img);
        } else {
          enlace.download = a.nombre;
          const icono = el('span', 'adj-icono');
          icono.innerHTML = ico('archivo');
          enlace.append(icono);
        }
        const texto = el('span', 'adj-texto');
        texto.append(el('span', 'adj-nombre', a.nombre), el('span', 'adj-peso', `${formatoTamano(a.tamano)} · ${leyenda(a)}`));
        enlace.append(texto);
        li.append(enlace);
        if (quitable) li.append(controlQuitar(a));
        return li;
      }));
      return ul;
    }

    return { validar, botonAdjuntar, chipsArchivos, listaErrores, listaAdjuntos };
  }

  const api = { validar, formatoTamano, esImagen, crearUI };
  if (typeof window !== 'undefined') window.TicketsAdjuntos = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
