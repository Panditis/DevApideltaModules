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

  // Instancia la plantilla sobre un item del plan. Los bloques salen sin horario: el horario
  // lo pone recalcularHorarios, que es el único que sabe de la cadena entera del día.
  function generarBloques(item, plantilla, ts) {
    if (!item || !plantilla || !Array.isArray(plantilla.tareas)) return [];
    const base = Number(ts) || 0;
    return plantilla.tareas.map((t, i) => ({
      id: base + i,
      itemId: item.id,
      producto: item.producto || '',
      tarea: String((t && t.nombre) || '').trim() || 'Tarea',
      responsables: Array.isArray(t && t.responsables) ? t.responsables.slice() : [],
      minutos: duracionTarea(t, item),
      inicio: '', fin: '', orden: i + 1, manual: false,
      // Contra qué cantidad se calculó. Si después cambian cantConfirmada en el plan, la agenda
      // avisa que ese producto quedó viejo en vez de mentir un horario que ya no cierra.
      cantGenerada: cantidadBase(t, item),
    }));
  }

  // Encadena los bloques de cada producto: el primero arranca con la jornada, cada uno sigue al
  // anterior. Un bloque con `manual` fijado por el usuario manda sobre la cadena y los que le
  // siguen arrancan desde él. Devuelve copias: no muta lo que le pasan.
  function recalcularHorarios(bloques, jornadaInicio) {
    const arranque  = minutosDeHora(jornadaInicio);
    const inicioDia = arranque == null ? 8 * 60 : arranque;
    const porItem = new Map();
    for (const b of (bloques || [])) {
      if (!b) continue;
      const k = String(b.itemId);
      if (!porItem.has(k)) porItem.set(k, []);
      porItem.get(k).push(b);
    }
    const salida = [];
    for (const lista of porItem.values()) {
      lista.sort((a, b) => (Number(a.orden) || 0) - (Number(b.orden) || 0));
      let cursor = inicioDia;
      for (const b of lista) {
        const ancla = b.manual === true ? minutosDeHora(b.inicio) : null;
        const ini   = ancla == null ? cursor : ancla;
        const dur   = Math.max(0, Math.round(Number(b.minutos) || 0));
        const fin   = ini + dur;
        salida.push({ ...b, inicio: horaDeMinutos(ini), fin: horaDeMinutos(fin), excedeDia: fin > FIN_DIA });
        cursor = fin;
      }
    }
    return salida;
  }

  // Ids de los bloques que pisan a otro de la misma persona. Avisa, no bloquea: dos tareas a la
  // misma hora a veces son reales (el tambor calienta solo mientras se etiqueta otra cosa).
  function detectarSolapes(bloques) {
    const lista = (bloques || []).filter(b => b && Array.isArray(b.responsables) && b.responsables.length);
    const ids = new Set();
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const a = lista[i], b = lista[j];
        if (!a.responsables.some(r => b.responsables.includes(r))) continue;
        const ai = minutosDeHora(a.inicio), af = minutosDeHora(a.fin);
        const bi = minutosDeHora(b.inicio), bf = minutosDeHora(b.fin);
        if (ai == null || af == null || bi == null || bf == null) continue;
        if (ai < bf && bi < af) { ids.add(a.id); ids.add(b.id); }
      }
    }
    return [...ids];
  }

  // Filas del Gantt: una por persona con bloques, ordenadas alfabéticamente, y al final la de
  // los bloques que todavía no tienen a nadie asignado.
  function carrilesPorResponsable(bloques) {
    const mapa = new Map();
    for (const b of (bloques || [])) {
      if (!b) continue;
      const resps = Array.isArray(b.responsables) && b.responsables.length ? b.responsables : [''];
      for (const r of resps) {
        if (!mapa.has(r)) mapa.set(r, []);
        mapa.get(r).push(b);
      }
    }
    const conNombre = [...mapa.keys()].filter(Boolean).sort();
    const orden = mapa.has('') ? [...conNombre, ''] : conNombre;
    return orden.map(r => ({ responsable: r, bloques: mapa.get(r) }));
  }

  // Topes de cordura: la agenda de un día real tiene decenas de bloques, no miles, y ninguna
  // tarea dura más que el día entero. Sin tope, un bug del front deja planes.json inutilizable.
  const MAX_BLOQUES    = 500;
  const MAX_MINUTOS    = 24 * 60;
  const MAX_PLANTILLAS = 300;
  const MAX_TAREAS     = 40;

  function validarBloquesBody(body) {
    const errores = [];
    const jornada = body && body.jornadaInicio;
    if (jornada != null && jornada !== '' && minutosDeHora(jornada) == null) {
      errores.push('jornadaInicio inválida: se espera HH:MM');
    }
    const bloques = body && body.bloques;
    if (!Array.isArray(bloques)) { errores.push('bloques debe ser un array'); return errores; }
    if (bloques.length > MAX_BLOQUES) { errores.push(`máximo ${MAX_BLOQUES} bloques por día`); return errores; }
    bloques.forEach((b, i) => {
      if (!b || typeof b !== 'object') return errores.push(`bloque ${i}: inválido`);
      if (b.inicio && minutosDeHora(b.inicio) == null) errores.push(`bloque ${i}: inicio inválido`);
      const min = Number(b.minutos);
      if (!Number.isFinite(min) || min < 0 || min > MAX_MINUTOS) errores.push(`bloque ${i}: minutos inválidos`);
      if (b.responsables != null && !Array.isArray(b.responsables)) errores.push(`bloque ${i}: responsables debe ser un array`);
    });
    return errores;
  }

  function textoCorto(v, max) {
    return String(v == null ? '' : v).trim().slice(0, max || 120);
  }

  function listaResponsables(v) {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(r => textoCorto(r, 40)).filter(Boolean))];
  }

  // Se guarda sólo lo conocido: el archivo del plan no es un depósito de lo que mande el front.
  function normalizarBloques(bloques) {
    return (Array.isArray(bloques) ? bloques : []).filter(Boolean).map(b => {
      const itemIdNum = Number(b.itemId);
      const itemIdEsNumero = Number.isFinite(itemIdNum) && String(itemIdNum) === String(b.itemId).trim();
      return {
        id: Number(b.id) || 0,
        itemId: itemIdEsNumero ? itemIdNum : textoCorto(b.itemId, 40),
        producto: textoCorto(b.producto, 120),
        tarea: textoCorto(b.tarea, 80),
        responsables: listaResponsables(b.responsables),
        minutos: Math.max(0, Math.min(MAX_MINUTOS, Math.round(Number(b.minutos) || 0))),
        inicio: minutosDeHora(b.inicio) == null ? '' : String(b.inicio).trim(),
        fin: minutosDeHora(b.fin) == null ? '' : String(b.fin).trim(),
        orden: Math.max(0, Math.round(Number(b.orden) || 0)),
        manual: b.manual === true || b.manual === 'true',
        cantGenerada: Number(b.cantGenerada) || 0,
      };
    });
  }

  function validarPlantillas(lista) {
    const errores = [];
    if (!Array.isArray(lista)) { errores.push('las plantillas deben venir en un array'); return errores; }
    if (lista.length > MAX_PLANTILLAS) { errores.push(`máximo ${MAX_PLANTILLAS} plantillas`); return errores; }
    lista.forEach((p, i) => {
      if (!p || typeof p !== 'object') return errores.push(`plantilla ${i}: inválida`);
      if (p.alcance !== 'producto' && p.alcance !== 'rubro') errores.push(`plantilla ${i}: alcance debe ser producto o rubro`);
      if (!textoCorto(p.clave, 120)) errores.push(`plantilla ${i}: falta la clave`);
      if (!Array.isArray(p.tareas)) return errores.push(`plantilla ${i}: tareas debe ser un array`);
      if (p.tareas.length > MAX_TAREAS) return errores.push(`plantilla ${i}: máximo ${MAX_TAREAS} tareas`);
      p.tareas.forEach((t, j) => {
        if (!t || typeof t !== 'object') return errores.push(`plantilla ${i}, tarea ${j}: inválida`);
        if (!textoCorto(t.nombre, 80)) errores.push(`plantilla ${i}, tarea ${j}: falta el nombre`);
        const fijos = Number(t.minFijos) || 0, varia = Number(t.minVar) || 0;
        if (fijos < 0 || fijos > MAX_MINUTOS) errores.push(`plantilla ${i}, tarea ${j}: minFijos inválido`);
        if (varia < 0 || varia > MAX_MINUTOS) errores.push(`plantilla ${i}, tarea ${j}: minVar inválido`);
      });
    });
    return errores;
  }

  function normalizarPlantillas(lista) {
    return (Array.isArray(lista) ? lista : []).filter(Boolean).map(p => ({
      id: Number(p.id) || 0,
      alcance: p.alcance === 'producto' ? 'producto' : 'rubro',
      clave: textoCorto(p.clave, 120),
      nombre: textoCorto(p.nombre, 120),
      tareas: (Array.isArray(p.tareas) ? p.tareas : []).filter(Boolean).map(t => ({
        nombre: textoCorto(t.nombre, 80),
        minFijos: Math.max(0, Math.min(MAX_MINUTOS, Number(t.minFijos) || 0)),
        minVar: Math.max(0, Math.min(MAX_MINUTOS, Number(t.minVar) || 0)),
        base: t.base === 'kg' ? 'kg' : 'unidad',
        responsables: listaResponsables(t.responsables),
      })),
    }));
  }

  return {
    MAX_BLOQUES, MAX_PLANTILLAS, MAX_TAREAS,
    minutosDeHora, horaDeMinutos, cantidadBase, duracionTarea, resolverPlantilla,
    generarBloques, recalcularHorarios, detectarSolapes, carrilesPorResponsable,
    validarBloquesBody, normalizarBloques, validarPlantillas, normalizarPlantillas,
  };
});
