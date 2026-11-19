'use strict';
// Configuración de responsables (solo Mantenimiento, meta.areaCerrada): lógica pura de la lista editada + modal #dlgResp.
// Las reglas espejan las de lib/tickets.js: 1 a 30 opciones, cada una de 1 a 80 caracteres, sin repetidas (sin distinguir mayúsculas).
(() => {
  const MAX_OPCIONES = 30;
  const MAX_LARGO = 80;

  const clave = s => String(s).trim().toLowerCase();

  // Devuelve [{ i, msg }]; i es el índice de la fila con el problema, null si el problema es de la lista entera.
  function validarLista(lista) {
    const errores = [];
    if (!lista.length) errores.push({ i: null, msg: 'Tiene que haber al menos un responsable.' });
    if (lista.length > MAX_OPCIONES) errores.push({ i: null, msg: `No puede haber más de ${MAX_OPCIONES} responsables.` });
    const vistos = new Map();
    lista.forEach((v, i) => {
      const t = String(v).trim();
      if (!t) { errores.push({ i, msg: 'Escribí el nombre o quitá la fila.' }); return; }
      if (t.length > MAX_LARGO) errores.push({ i, msg: `Máximo ${MAX_LARGO} caracteres.` });
      if (vistos.has(clave(t))) errores.push({ i, msg: `Repetido (igual a la fila ${vistos.get(clave(t)) + 1}).` });
      else vistos.set(clave(t), i);
    });
    return errores;
  }

  const limpiarLista = lista => lista.map(v => String(v).trim());

  // Copia con el elemento i movido delta posiciones (-1 arriba, +1 abajo); fuera de rango devuelve la lista igual.
  function mover(lista, i, delta) {
    const j = i + delta;
    if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return [...lista];
    const copia = [...lista];
    [copia[i], copia[j]] = [copia[j], copia[i]];
    return copia;
  }

  const quitar = (lista, i) => lista.filter((_, j) => j !== i);

  // UI del modal. Dependencias: el(), ico(), mostrarAviso() de tickets.js; guardar(areas) → Promise<{ areas }>; alGuardar(areas).
  function crearUI({ dlg, el, ico, guardar, alGuardar, aviso }) {
    const cuerpo = dlg.querySelector('#rLista');
    const caja = dlg.querySelector('#rErrores');
    const btnGuardar = dlg.querySelector('#rGuardar');
    const btnAgregar = dlg.querySelector('#rAgregar');
    let filas = [];

    function mostrarErrores(errores) {
      cuerpo.querySelectorAll('input').forEach((inp, i) => {
        const e = errores.find(x => x.i === i);
        inp.setAttribute('aria-invalid', e ? 'true' : 'false');
        const msg = cuerpo.querySelector(`#rMsg${i}`);
        msg.textContent = e ? e.msg : '';
        msg.classList.toggle('hidden', !e);
      });
      const generales = errores.filter(e => e.i == null);
      caja.classList.toggle('hidden', !generales.length);
      caja.replaceChildren(...generales.map(e => el('div', null, e.msg)));
    }

    const boton = (icono, titulo, accion, i, off) => {
      const b = el('button', 'btn-ico');
      b.type = 'button';
      b.title = titulo;
      b.setAttribute('aria-label', `${titulo}: fila ${i + 1}`);
      b.dataset.accion = accion;
      b.dataset.i = String(i);
      b.disabled = !!off;
      b.innerHTML = ico(icono);
      return b;
    };

    function pintar(foco) {
      cuerpo.replaceChildren(...filas.map((v, i) => {
        const fila = el('li', 'resp-fila');
        const inp = el('input', 'ctl resp-in');
        inp.type = 'text';
        inp.value = v;
        inp.maxLength = MAX_LARGO + 20; // deja pasarse para que la validación avise en vez de truncar en silencio
        inp.autocomplete = 'off';
        inp.id = `rIn${i}`;
        inp.setAttribute('aria-label', `Responsable ${i + 1}`);
        inp.setAttribute('aria-describedby', `rMsg${i}`);
        inp.dataset.i = String(i);
        const msg = el('div', 'resp-msg hidden');
        msg.id = `rMsg${i}`;
        const celda = el('div', 'min-w-0 flex-1');
        celda.append(inp, msg);
        fila.append(celda, boton('flechaArriba', 'Subir', 'sube', i, i === 0), boton('flechaAbajo', 'Bajar', 'baja', i, i === filas.length - 1),
          boton('x', 'Quitar', 'quita', i));
        return fila;
      }));
      btnAgregar.disabled = filas.length >= MAX_OPCIONES;
      if (foco) { const n = cuerpo.querySelector(foco); if (n && !n.disabled) n.focus(); else if (n) cuerpo.querySelector(`#rIn${n.dataset.i}`).focus(); }
    }

    cuerpo.addEventListener('input', e => {
      const i = Number(e.target.dataset.i);
      filas = filas.map((v, j) => (j === i ? e.target.value : v));
      if (!caja.classList.contains('hidden') || cuerpo.querySelector('[aria-invalid=true]')) mostrarErrores(validarLista(filas));
    });
    cuerpo.addEventListener('click', e => {
      const b = e.target.closest('button[data-accion]');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (b.dataset.accion === 'quita') {
        filas = quitar(filas, i);
        pintar(`#rIn${Math.min(i, filas.length - 1)}`);
      } else {
        const d = b.dataset.accion === 'sube' ? -1 : 1;
        filas = mover(filas, i, d);
        pintar(`button[data-accion=${b.dataset.accion}][data-i="${i + d}"]`);
      }
      if (!caja.classList.contains('hidden')) mostrarErrores(validarLista(filas));
    });
    btnAgregar.addEventListener('click', () => {
      filas = [...filas, ''];
      pintar(`#rIn${filas.length - 1}`);
    });
    dlg.querySelector('#rForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const errores = validarLista(filas);
      mostrarErrores(errores);
      if (errores.length) { const p = cuerpo.querySelector('[aria-invalid=true]'); if (p) p.focus(); return; }
      btnGuardar.disabled = true;
      btnGuardar.textContent = 'Guardando…';
      try {
        const r = await guardar(limpiarLista(filas));
        alGuardar(r.areas);
        dlg.close();
      } catch (e) {
        aviso('error', e.message, '#rAviso');
      } finally {
        btnGuardar.disabled = false;
        btnGuardar.textContent = 'Guardar';
      }
    });

    return {
      abrir(areas) {
        filas = [...areas];
        pintar();
        mostrarErrores([]);
        dlg.querySelector('#rAviso').className = 'hidden';
        dlg.showModal();
        const primero = cuerpo.querySelector('input');
        if (primero) primero.focus();
      },
    };
  }

  const api = { validarLista, limpiarLista, mover, quitar, crearUI, MAX_OPCIONES, MAX_LARGO };
  if (typeof window !== 'undefined') window.TicketsResponsables = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
