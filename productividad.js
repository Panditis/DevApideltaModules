'use strict';
// Productividad de la sala de producción: agrega las cargas ya existentes (producción y
// fraccionado) contra lo planificado. Todo acá es puro —entra JSON, sale JSON— para poder
// testearlo sin servidor ni SQL: el endpoint sólo lee los archivos y llama a estas funciones.

const HORA_RE = /^(\d{1,2}):(\d{2})$/;

function minutosDeHora(h) {
  const m = HORA_RE.exec(String(h == null ? '' : h).trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

// Intervalo [desde, hasta) en minutos, o null si la carga no trae horario usable.
// Sin horario no hay ritmo: el registro suma cantidades pero no tiempo.
function intervaloDe(desde, hasta) {
  const a = minutosDeHora(desde), b = minutosDeHora(hasta);
  if (a == null || b == null || b <= a) return null;
  return [a, b];
}

// Minutos efectivos de una lista de intervalos: tres cargas en el bloque 08:00-09:00 son
// UNA hora trabajada, no tres. Sin fusionar, el ritmo (kg/h) queda dividido por tres.
function minutosUnidos(intervalos) {
  const ord = (intervalos || []).filter(Boolean).slice().sort((x, y) => x[0] - y[0]);
  let total = 0, ini = null, fin = null;
  for (const [a, b] of ord) {
    if (ini === null) { ini = a; fin = b; continue; }
    if (a <= fin) { fin = Math.max(fin, b); } else { total += fin - ini; ini = a; fin = b; }
  }
  if (ini !== null) total += fin - ini;
  return total;
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const redondear = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;

// Kilos de granel de una carga. granelConsumido es el dato cargado por el operario; si falta
// (cargas viejas), se reconstruye con la fórmula: unidades × kg por unidad.
function kilosDeCarga(c) {
  if (!c) return 0;
  const directo = num(c.granelConsumido);
  if (directo > 0) return directo;
  const porGraneles = Array.isArray(c.graneles)
    ? c.graneles.reduce((s, g) => s + num(g && g.granelConsumido), 0) : 0;
  if (porGraneles > 0) return porGraneles;
  return num(c.cantFraccionada) * num(c.cantFormula);
}

// La misma persona se carga escrita de cualquier forma ("MILAGROS", "milagros"): sin
// normalizar aparece dos veces en el ranking con la mitad de la producción cada una.
const claveNombre = n => String(n || '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
const nombreLindo = n => String(n || '').trim().replace(/\s+/g, ' ')
  .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

// Personas de una carga con su ventana horaria. roles[] es la forma nueva (rol + horario
// propio); responsables[] y empleado son las formas viejas, que heredan el horario de la carga.
function personasDeCarga(c) {
  if (!c) return [];
  const base = Array.isArray(c.roles) && c.roles.length ? c.roles
    : (Array.isArray(c.responsables) && c.responsables.length ? c.responsables
      : (c.empleado ? [{ nombre: c.empleado }] : []));
  return base
    .map(r => ({
      nombre: String((r && r.nombre) || '').trim(),
      rol: String((r && r.rol) || '').trim(),
      desde: (r && r.desde) || c.desde,
      hasta: (r && r.hasta) || c.hasta,
    }))
    .filter(p => p.nombre);
}

// Ranking por persona. Cuando una carga tiene varios responsables, las cantidades se
// prorratean entre ellos: así la suma de las filas sigue dando el total de la sala.
function resumenPersonas(cargas) {
  const acc = new Map();
  for (const c of cargas || []) {
    const personas = personasDeCarga(c);
    if (!personas.length) continue;
    const parte = 1 / personas.length;
    const unidades = num(c.cantFraccionada) * parte;
    const kilos = kilosDeCarga(c) * parte;
    for (const p of personas) {
      const clave = claveNombre(p.nombre);
      let g = acc.get(clave);
      if (!g) {
        g = { persona: nombreLindo(p.nombre), cargas: 0, unidades: 0, kilos: 0, roles: new Set(),
              productos: new Set(), dias: new Set(), intervalos: new Map() };
        acc.set(clave, g);
      }
      g.cargas += 1;
      g.unidades += unidades;
      g.kilos += kilos;
      if (p.rol) g.roles.add(p.rol);
      if (c.plu != null && c.plu !== '') g.productos.add(String(c.plu));
      if (c.fecha) g.dias.add(c.fecha);
      const iv = intervaloDe(p.desde, p.hasta);
      // Los intervalos se fusionan por día: dos días distintos nunca se solapan entre sí.
      if (iv) {
        const dia = c.fecha || '';
        if (!g.intervalos.has(dia)) g.intervalos.set(dia, []);
        g.intervalos.get(dia).push(iv);
      }
    }
  }
  return [...acc.values()].map(g => {
    const minutos = [...g.intervalos.values()].reduce((s, ivs) => s + minutosUnidos(ivs), 0);
    const horas = minutos / 60;
    return {
      persona: g.persona,
      cargas: g.cargas,
      productos: g.productos.size,
      unidades: redondear(g.unidades),
      kilos: redondear(g.kilos),
      dias: g.dias.size,
      horas: redondear(horas),
      unidPorHora: horas > 0 ? redondear(g.unidades / horas) : null,
      kgPorHora: horas > 0 ? redondear(g.kilos / horas) : null,
      roles: [...g.roles].sort(),
    };
  }).sort((a, b) => b.kilos - a.kilos || b.unidades - a.unidades);
}

// Clave de vínculo carga ↔ ítem del plan. El plan sella el número de movimiento con el que
// se mandó a producción (produccionMovimiento) y la carga archivada guarda el mismo número,
// así que ese par (movimiento + plu) identifica qué se produjo de qué línea del plan.
// Sin movimiento se cae a fecha + plu, que es lo único que comparten las cargas manuales.
const claveMov = (mov, plu) => `m${mov}|${plu}`;
const claveFecha = (fecha, plu) => `f${fecha}|${plu}`;

function movDeCarga(carga, movPorOrden) {
  const archivado = carga && carga.archivado;
  if (archivado && archivado.numeroMovimiento != null) return archivado.numeroMovimiento;
  const porOrden = movPorOrden && carga && carga.ordenId != null
    ? movPorOrden.get(String(carga.ordenId)) : undefined;
  return porOrden == null ? null : porOrden;
}

// Índice orden → movimiento: las cargas vivas no tienen sello de archivado, pero su orden sí
// guarda los movimientos de reserva con los que se envió a producción.
function indexarMovimientos(ordenes) {
  const m = new Map();
  for (const o of ordenes || []) {
    const movs = Array.isArray(o && o.reservaMovimientos) ? o.reservaMovimientos : [];
    if (o && o.id != null && movs.length) m.set(String(o.id), movs[movs.length - 1]);
  }
  return m;
}

// Un plan puede tener el mismo producto en varias líneas (se agrega dos veces con distinta
// prioridad, o se parte la tanda). Todas apuntan a las mismas cargas, así que si no se
// consolidan cada una se lleva la producción entera y el total sale multiplicado.
function consolidarPlan(planItems) {
  const acc = new Map();
  for (const it of planItems || []) {
    const plu = String(it.idProducto != null ? it.idProducto : '');
    const mov = it.produccionMovimiento && it.produccionMovimiento.numeroMovimiento;
    const clave = mov != null ? claveMov(mov, plu) : claveFecha(it.fecha, plu);
    const prev = acc.get(clave);
    const planificado = num(it.cantConfirmada != null ? it.cantConfirmada : it.cantSugerida);
    if (!prev) {
      acc.set(clave, { ...it, idProducto: plu, cantConfirmada: planificado, cantSugerida: undefined,
                       lineas: 1, responsables: [...(it.responsables || [])].filter(Boolean) });
      continue;
    }
    prev.cantConfirmada += planificado;
    prev.lineas += 1;
    for (const r of it.responsables || []) if (r && !prev.responsables.includes(r)) prev.responsables.push(r);
    // Si alguna línea sigue pendiente, la fila consolidada muestra pendiente.
    if (it.estado && it.estado !== 'listo') prev.estado = it.estado;
  }
  return [...acc.values()];
}

// Órdenes planificadas vs producido. Devuelve una fila por producto planificado (las líneas
// repetidas del mismo producto se suman) y, aparte, las cargas que no matchean ningún ítem
// del plan: producción no planificada, cargas manuales o extras.
function resumenOrdenes(planItems, cargas, ordenes) {
  const movPorOrden = indexarMovimientos(ordenes);
  const porMov = new Map(), porFecha = new Map();
  for (const c of cargas || []) {
    const plu = String(c && c.plu != null ? c.plu : '');
    const mov = movDeCarga(c, movPorOrden);
    if (mov != null) {
      const k = claveMov(mov, plu);
      if (!porMov.has(k)) porMov.set(k, []);
      porMov.get(k).push(c);
    }
    const kf = claveFecha(c && c.fecha, plu);
    if (!porFecha.has(kf)) porFecha.set(kf, []);
    porFecha.get(kf).push(c);
  }

  const usadas = new Set();
  const filas = consolidarPlan(planItems).map(it => {
    const plu = String(it.idProducto != null ? it.idProducto : '');
    const mov = it.produccionMovimiento && it.produccionMovimiento.numeroMovimiento;
    let match = mov != null ? porMov.get(claveMov(mov, plu)) : null;
    if (!match || !match.length) match = porFecha.get(claveFecha(it.fecha, plu)) || [];
    match.forEach(c => usadas.add(c.id));
    const planificado = num(it.cantConfirmada != null ? it.cantConfirmada : it.cantSugerida);
    const producido = match.reduce((s, c) => s + num(c.cantFraccionada), 0);
    const kilos = match.reduce((s, c) => s + kilosDeCarga(c), 0);
    const minutos = minutosUnidos(match.map(c => intervaloDe(c.desde, c.hasta)));
    const personas = [...new Map(match.flatMap(c => personasDeCarga(c)
      .map(p => [claveNombre(p.nombre), nombreLindo(p.nombre)]))).values()];
    return {
      fecha: it.fecha,
      plu,
      producto: it.producto || '',
      presentacion: it.presentacion || '',
      planificado,
      producido,
      kilos: redondear(kilos),
      pct: planificado > 0 ? redondear((producido / planificado) * 100, 1) : null,
      estado: it.estado || '',
      movimiento: mov == null ? null : mov,
      lineasPlan: it.lineas || 1,
      cargas: match.length,
      horas: redondear(minutos / 60),
      unidPorHora: minutos > 0 ? redondear(producido / (minutos / 60)) : null,
      planificadoPor: Array.isArray(it.responsables) ? it.responsables.filter(Boolean) : [],
      personas,
    };
  }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || b.producido - a.producido);

  const sinPlan = (cargas || []).filter(c => !usadas.has(c.id)).map(c => ({
    fecha: c.fecha,
    plu: String(c.plu != null ? c.plu : ''),
    producto: c.nombre || '',
    presentacion: c.presentacion || '',
    seccion: c.seccion || '',
    producido: num(c.cantFraccionada),
    kilos: redondear(kilosDeCarga(c)),
    horas: redondear(minutosUnidos([intervaloDe(c.desde, c.hasta)]) / 60),
    personas: personasDeCarga(c).map(p => nombreLindo(p.nombre)),
  })).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  return { filas, sinPlan };
}

// Totales de una lista de cargas (KPI de las dos pestañas). Las horas se fusionan por día y
// persona, igual que en el ranking: es la hora-persona real de sala, no la suma de bloques.
function totales(cargas) {
  const personas = resumenPersonas(cargas);
  return {
    cargas: (cargas || []).length,
    unidades: redondear((cargas || []).reduce((s, c) => s + num(c.cantFraccionada), 0)),
    kilos: redondear((cargas || []).reduce((s, c) => s + kilosDeCarga(c), 0)),
    personas: personas.length,
    horas: redondear(personas.reduce((s, p) => s + p.horas, 0)),
    productos: new Set((cargas || []).map(c => String(c && c.plu)).filter(p => p && p !== 'undefined')).size,
    dias: new Set((cargas || []).map(c => c && c.fecha).filter(Boolean)).size,
  };
}

// Une colecciones de registros descartando repetidos por id: la misma carga vive a la vez en
// el archivo vivo, en el historial y en el snapshot de cierre del día.
function unirPorId(...listas) {
  const vistos = new Set(), out = [];
  for (const lista of listas) {
    for (const r of lista || []) {
      if (!r) continue;
      const k = r.id != null ? String(r.id) : null;
      if (k && vistos.has(k)) continue;
      if (k) vistos.add(k);
      out.push(r);
    }
  }
  return out;
}

// Filtro de rango inclusivo sobre la fecha ISO corta (AAAA-MM-DD): comparar como texto
// alcanza y evita el desfasaje de zona horaria de new Date('2026-08-10').
function enRango(fecha, desde, hasta) {
  const f = String(fecha || '');
  if (!f) return false;
  if (desde && f < desde) return false;
  if (hasta && f > hasta) return false;
  return true;
}

module.exports = {
  minutosDeHora, intervaloDe, minutosUnidos, kilosDeCarga, personasDeCarga, claveNombre,
  nombreLindo, consolidarPlan, resumenPersonas, resumenOrdenes, totales, unirPorId, enRango,
  indexarMovimientos,
};
