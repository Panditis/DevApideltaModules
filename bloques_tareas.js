'use strict';

/**
 * Bloques de tareas de la agenda de producción: plantillas, duración, encadenado y solapes.
 *
 * Módulo puro (sin fs, sin SQL, sin DOM) y a la vez cargable en el navegador: la misma cuenta
 * la hace planificacion.html mientras se edita y server.js al validar lo que se guarda. Si el
 * cálculo viviera sólo en el server, cada tecleo de minutos sería un viaje de red; si viviera
 * sólo en el front, el archivo aceptaría cualquier cosa que mande un cliente viejo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BloquesTareas = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const HORA_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const FIN_DIA = 24 * 60 - 1;   // 23:59

  // "HH:MM" → minutos desde medianoche. null si no es una hora válida del día.
  // Se repite el helper de productividad.js a propósito: son seis líneas y ese módulo no se
  // puede cargar en el navegador (arrastra todo el tablero de productividad).
  function minutosDeHora(h) {
    const m = HORA_RE.exec(String(h == null ? '' : h).trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  // Minutos → "HH:MM". Una cadena que se pasa de la medianoche se topa en 23:59 en vez de dar
  // la vuelta al reloj: un bloque que aparece a las 00:30 se lee como "arranca temprano" y es
  // exactamente lo contrario. El que llama marca el exceso aparte.
  function horaDeMinutos(min) {
    if (!Number.isFinite(min) || min < 0) return null;
    const t = Math.min(Math.round(min), FIN_DIA);
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  }

  // Cantidad contra la que se multiplica la parte variable de la tarea.
  function cantidadBase(tarea, item) {
    const base = (tarea && tarea.base) === 'kg' ? 'kg' : 'unidad';
    const n = Number(base === 'kg' ? (item && item.granelNecesario) : (item && item.cantConfirmada));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Duración de reloj de la tarea. Que la hagan tres personas en vez de una no la acorta: eso
  // se ajusta a mano en el bloque cuando de verdad rinde más.
  function duracionTarea(tarea, item) {
    const fijos = Number(tarea && tarea.minFijos) || 0;
    const varia = Number(tarea && tarea.minVar)   || 0;
    return Math.max(0, Math.round(fijos + varia * cantidadBase(tarea, item)));
  }

  // La plantilla del producto puntual gana sobre la del rubro: es la excepción cargada a mano.
  function resolverPlantilla(plantillas, item) {
    const lista  = Array.isArray(plantillas) ? plantillas : [];
    const idProd = item && item.idProducto != null ? String(item.idProducto).trim() : '';
    const rubro  = String((item && item.rubro) || '').trim().toLowerCase();
    if (idProd) {
      const p = lista.find(x => x && x.alcance === 'producto' && String(x.clave).trim() === idProd);
      if (p) return p;
    }
    if (rubro) {
      const p = lista.find(x => x && x.alcance === 'rubro' && String(x.clave).trim().toLowerCase() === rubro);
      if (p) return p;
    }
    return null;
  }

  return { minutosDeHora, horaDeMinutos, cantidadBase, duracionTarea, resolverPlantilla };
});
