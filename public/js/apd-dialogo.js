'use strict';

// Diálogos propios en lugar de alert()/confirm()/prompt() nativos, que rompen el estilo del
// módulo y bloquean el hilo. Un <dialog> modal creado al vuelo y borrado al cerrar; el mensaje
// va siempre por textContent (los \n se respetan con pre-line). Esc = cancelar. Todo devuelve
// una Promesa, así que el que llama hace `await`.
//   apdAvisar(msg, { titulo })                                          → Promise<void>
//   apdConfirmar(msg, { titulo, aceptar, cancelar, peligro })           → Promise<boolean>
//   apdPedir(msg, valorInicial, { titulo, tipo })                       → Promise<string|null>
// Estilos inline con la paleta del theme (no depende de Tailwind). Pensado sólo para escritorio.

const APD_BTN = 'padding:6px 14px;border-radius:8px;font:600 13px system-ui,"Segoe UI",sans-serif;cursor:pointer;';

function apdNodo(tag, estilo, texto) {
  const n = document.createElement(tag);
  if (estilo) n.style.cssText = estilo;
  if (texto != null) n.textContent = String(texto);
  return n;
}

// Resuelve true/false (o, con `campo`, el texto escrito / null) según cómo se cerró.
function apdAbrir(mensaje, { titulo, aceptar = 'Aceptar', cancelar = null, peligro = false, campo = null } = {}) {
  const d = apdNodo('dialog', 'border:1px solid rgba(26,28,24,.16);border-radius:12px;padding:20px;width:420px;max-width:92vw;'
    + 'background:var(--card, #fff);color:var(--ink, #242423);font:14px system-ui,"Segoe UI",sans-serif;'
    + 'box-shadow:0 6.4px 14.4px rgba(26,28,24,.13),0 1.2px 3.6px rgba(26,28,24,.1);');
  if (titulo) d.appendChild(apdNodo('h3', 'margin:0 0 8px;font-size:16px;font-weight:600', titulo));
  d.appendChild(apdNodo('p', 'margin:0;white-space:pre-line;line-height:1.45', mensaje ?? ''));
  let input = null;
  if (campo) {
    input = apdNodo('input', 'display:block;box-sizing:border-box;width:100%;margin-top:12px;padding:6px 10px;'
      + 'border:1px solid rgba(26,28,24,.3);border-radius:8px;font:14px system-ui,"Segoe UI",sans-serif;');
    input.type = campo.tipo || 'text';
    input.value = campo.valor ?? '';
    d.appendChild(input);
  }
  const pie = apdNodo('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:18px');
  if (cancelar) {
    const no = apdNodo('button', APD_BTN + 'background:#fff;color:#242423;border:1px solid rgba(26,28,24,.25)', cancelar);
    no.type = 'button';
    no.addEventListener('click', () => d.close());
    pie.appendChild(no);
  }
  const ok = apdNodo('button', APD_BTN + 'color:#fff;border:1px solid transparent;background:'
    + (peligro ? '#a4262c' : 'var(--md-primary, #405936)'), aceptar);
  ok.type = 'button';
  pie.appendChild(ok);
  d.appendChild(pie);
  document.body.appendChild(d);

  return new Promise(resolve => {
    let aceptado = false;
    const confirmar = () => { aceptado = true; d.close(); };
    ok.addEventListener('click', confirmar);
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmar(); } });
    // Esc dispara 'cancel' y después 'close' con aceptado = false.
    d.addEventListener('close', () => {
      d.remove();
      resolve(input ? (aceptado ? input.value : null) : aceptado);
    });
    d.showModal();
    (input || ok).focus();
  });
}

function apdAvisar(mensaje, { titulo } = {}) {
  return apdAbrir(mensaje, { titulo }).then(() => {});
}

function apdConfirmar(mensaje, { titulo, aceptar = 'Aceptar', cancelar = 'Cancelar', peligro = false } = {}) {
  return apdAbrir(mensaje, { titulo, aceptar, cancelar, peligro });
}

function apdPedir(mensaje, valorInicial = '', { titulo, tipo = 'text' } = {}) {
  return apdAbrir(mensaje, { titulo, cancelar: 'Cancelar', campo: { tipo, valor: valorInicial } });
}

if (typeof module === 'object' && module.exports) module.exports = { apdAvisar, apdConfirmar, apdPedir };
