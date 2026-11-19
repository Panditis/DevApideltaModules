'use strict';
// Configuración de responsables (solo Mantenimiento, meta.areaCerrada): cada responsable es un par usuario + área de trabajo.
// Las reglas espejan las del back: 1 a 30 pares, usuario obligatorio, área de 1 a 80 caracteres, sin pares ni etiquetas repetidas.
(() => {
  const MAX_OPCIONES = 30;
  const MAX_LARGO = 80;

  const clave = s => String(s).trim().toLowerCase();
  const nombreDe = (usuarios, login) => (usuarios.find(u => u.usuario === login) || {}).nombre || login || '';

  // Etiqueta visible del par: "Adriel / Sistema (Soporte)". Sin usuario elegido devuelve solo el área.
  function etiqueta(usuarios, fila) {
    const area = String(fila.area).trim();
    return fila.usuario ? `${nombreDe(usuarios, fila.usuario)} / ${area}` : area;
  }

  // Fila de la lista editada: { usuario, area, legado }. legado = vino de una etiqueta vieja sin usuario.
  // Con lista de usuarios: el login se busca sin distinguir mayúsculas (como el back) y se normaliza al de la lista;
  // si ya no existe (cuenta dada de baja) queda sin usuario y legado, para forzar a elegir uno vigente.
  function aFila(r, usuarios) {
    let usuario = r.usuario || '';
    if (usuario && Array.isArray(usuarios)) {
      const u = usuarios.find(x => clave(x.usuario) === clave(usuario));
      usuario = u ? u.usuario : '';
    }
    return { usuario, area: r.area || '', legado: !usuario };
  }

  // Devuelve [{ i, campo, msg }]; i es la fila con el problema (null = lista entera), campo 'usuario' | 'area' | null.
  function validarLista(filas, usuarios = []) {
    const errores = [];
    if (!filas.length) errores.push({ i: null, campo: null, msg: 'Tiene que haber al menos un responsable.' });
    if (filas.length > MAX_OPCIONES) errores.push({ i: null, campo: null, msg: `No puede haber más de ${MAX_OPCIONES} responsables.` });
    const pares = new Map();
    const etiquetas = new Map();
    filas.forEach((f, i) => {
      const area = String(f.area).trim();
      if (!f.usuario) errores.push({ i, campo: 'usuario', msg: f.legado ? 'Falta elegir usuario.' : 'Elegí un usuario.' });
      if (!area) errores.push({ i, campo: 'area', msg: 'Escribí el área de trabajo.' });
      else if (area.length > MAX_LARGO) errores.push({ i, campo: 'area', msg: `Máximo ${MAX_LARGO} caracteres.` });
      if (!f.usuario || !area) return;
      const kp = `${f.usuario.toLowerCase()}|${clave(area)}`;
      const ke = clave(etiqueta(usuarios, f));
      const previa = pares.has(kp) ? pares.get(kp) : etiquetas.get(ke);
      if (previa !== undefined) errores.push({ i, campo: 'area', msg: `Repetido (igual a la fila ${previa + 1}).` });
      else { pares.set(kp, i); etiquetas.set(ke, i); }
    });
    return errores;
  }

  const limpiarLista = filas => filas.map(f => ({ usuario: f.usuario, area: String(f.area).trim() }));

  // Copia con el elemento i movido delta posiciones (-1 arriba, +1 abajo); fuera de rango devuelve la lista igual.
  function mover(lista, i, delta) {
    const j = i + delta;
    if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return [...lista];
    const copia = [...lista];
    [copia[i], copia[j]] = [copia[j], copia[i]];
    return copia;
  }

  const quitar = (lista, i) => lista.filter((_, j) => j !== i);

  // UI del modal. Dependencias: el(), ico(), aviso() de tickets.js; guardar(pares) → Promise<{ responsables, areas }>; alGuardar(respuesta).
  function crearUI({ dlg, el, ico, guardar, alGuardar, aviso }) {
    const cuerpo = dlg.querySelector('#rLista');
    const caja = dlg.querySelector('#rErrores');
    const btnGuardar = dlg.querySelector('#rGuardar');
    const btnAgregar = dlg.querySelector('#rAgregar');
    let filas = [];
    let usuarios = [];

    function mostrarErrores(errores) {
      filas.forEach((_, i) => {
        const delFila = errores.filter(x => x.i === i);
        ['usuario', 'area'].forEach(c => {
          const ctl = cuerpo.querySelector(`[data-i="${i}"][data-campo="${c}"]`);
          if (ctl) ctl.setAttribute('aria-invalid', delFila.some(x => x.campo === c) ? 'true' : 'false');
        });
        const msg = cuerpo.querySelector(`#rMsg${i}`);
        msg.textContent = delFila.map(x => x.msg).join(' ');
        msg.classList.toggle('hidden', !delFila.length);
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

    function textoVista(f) {
      if (!f.usuario) return f.legado && f.area.trim() ? `Etiqueta actual: ${f.area.trim()} (falta elegir usuario)` : '';
      return f.area.trim() ? `Se verá como: ${etiqueta(usuarios, f)}` : '';
    }

    function celdaSelect(f, i) {
      const sel = el('select', 'ctl');
      sel.id = `rUs${i}`;
      sel.dataset.i = String(i);
      sel.dataset.campo = 'usuario';
      sel.setAttribute('aria-label', `Usuario del responsable ${i + 1}`);
      sel.setAttribute('aria-describedby', `rMsg${i}`);
      const vacia = el('option', null, 'Elegí un usuario…');
      vacia.value = '';
      sel.append(vacia, ...usuarios.map(u => { const o = el('option', null, u.nombre); o.value = u.usuario; return o; }));
      sel.value = f.usuario;
      return sel;
    }

    function celdaArea(f, i) {
      const inp = el('input', 'ctl resp-in');
      inp.type = 'text';
      inp.value = f.area;
      inp.placeholder = 'Área de trabajo, ej. Sistema (Soporte)';
      inp.maxLength = MAX_LARGO + 20; // deja pasarse para que la validación avise en vez de truncar en silencio
      inp.autocomplete = 'off';
      inp.id = `rIn${i}`;
      inp.dataset.i = String(i);
      inp.dataset.campo = 'area';
      inp.setAttribute('aria-label', `Área de trabajo del responsable ${i + 1}`);
      inp.setAttribute('aria-describedby', `rMsg${i}`);
      return inp;
    }

    function pintar(foco) {
      cuerpo.replaceChildren(...filas.map((f, i) => {
        const fila = el('li', 'resp-fila');
        const msg = el('div', 'resp-msg hidden');
        msg.id = `rMsg${i}`;
        const vista = el('div', 'ayuda', textoVista(f));
        vista.id = `rVista${i}`;
        const celda = el('div', 'min-w-0 flex-1 flex flex-col gap-1');
        celda.append(celdaSelect(f, i), celdaArea(f, i), vista, msg);
        fila.append(celda, boton('flechaArriba', 'Subir', 'sube', i, i === 0), boton('flechaAbajo', 'Bajar', 'baja', i, i === filas.length - 1),
          boton('x', 'Quitar', 'quita', i));
        return fila;
      }));
      btnAgregar.disabled = filas.length >= MAX_OPCIONES;
      if (foco) { const n = cuerpo.querySelector(foco); if (n && !n.disabled) n.focus(); else if (n) cuerpo.querySelector(`#rUs${n.dataset.i}`).focus(); }
    }

    const hayErroresVisibles = () => !caja.classList.contains('hidden') || cuerpo.querySelector('[aria-invalid=true]');
    function alEditar(e) {
      const i = Number(e.target.dataset.i);
      const campo = e.target.dataset.campo;
      if (!campo) return;
      filas = filas.map((f, j) => (j === i ? { ...f, [campo]: e.target.value } : f));
      cuerpo.querySelector(`#rVista${i}`).textContent = textoVista(filas[i]);
      if (hayErroresVisibles()) mostrarErrores(validarLista(filas, usuarios));
    }
    cuerpo.addEventListener('input', alEditar);
    cuerpo.addEventListener('change', alEditar);
    cuerpo.addEventListener('click', e => {
      const b = e.target.closest('button[data-accion]');
      if (!b) return;
      const i = Number(b.dataset.i);
      if (b.dataset.accion === 'quita') {
        filas = quitar(filas, i);
        pintar(`#rUs${Math.min(i, filas.length - 1)}`);
      } else {
        const d = b.dataset.accion === 'sube' ? -1 : 1;
        filas = mover(filas, i, d);
        pintar(`button[data-accion=${b.dataset.accion}][data-i="${i + d}"]`);
      }
      if (!caja.classList.contains('hidden')) mostrarErrores(validarLista(filas, usuarios));
    });
    btnAgregar.addEventListener('click', () => {
      filas = [...filas, { usuario: '', area: '', legado: false }];
      pintar(`#rUs${filas.length - 1}`);
    });
    dlg.querySelector('#rForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const errores = validarLista(filas, usuarios);
      mostrarErrores(errores);
      if (errores.length) { const p = cuerpo.querySelector('[aria-invalid=true]'); if (p) p.focus(); return; }
      btnGuardar.disabled = true;
      btnGuardar.textContent = 'Guardando…';
      try {
        const r = await guardar(limpiarLista(filas));
        alGuardar(r);
        dlg.close();
      } catch (e) {
        aviso('error', e.message, '#rAviso');
      } finally {
        btnGuardar.disabled = false;
        btnGuardar.textContent = 'Guardar';
      }
    });

    return {
      abrir(responsables, listaUsuarios) {
        usuarios = listaUsuarios || [];
        filas = responsables.map(r => aFila(r, usuarios));
        pintar();
        mostrarErrores([]);
        dlg.querySelector('#rAviso').className = 'hidden';
        dlg.showModal();
        const primero = cuerpo.querySelector('select');
        if (primero) primero.focus();
      },
    };
  }

  const api = { validarLista, limpiarLista, mover, quitar, etiqueta, aFila, crearUI, MAX_OPCIONES, MAX_LARGO };
  if (typeof window !== 'undefined') window.TicketsResponsables = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
