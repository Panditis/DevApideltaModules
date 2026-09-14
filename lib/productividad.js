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

// Peso en kg de una presentación tipo "500G", "1Kg", "250 G", "1L". null si no matchea.
function pesoPresentacionKg(presentacion) {
  const m = /^(\d+(?:[.,]\d+)?)\s*(KG|GR?|ML|L)$/i.exec(String(presentacion || '').trim());
  if (!m) return null;
  const v = parseFloat(m[1].replace(',', '.'));
  const u = m[2].toUpperCase();
  return (u === 'KG' || u === 'L') ? v : v / 1000;
}

// Paquetes reales por producto: kilos de granel consumido / peso de la presentación, en vez de
// cantFraccionada tal cual. Ese campo lo carga el operario a mano y en presentaciones chicas a
// veces queda anotado en kilos totales en vez de en paquetes (ej: "10" cargado en una tanda de
// orégano 50G son 10 kilos = 200 paquetes, no 10 paquetes = medio kilo).
function paquetesRealesPorProducto(cargas, pesoPresentacionDe) {
  const acc = new Map();
  for (const c of cargas || []) {
    const plu = String(c && c.plu != null ? c.plu : '');
    if (!plu) continue;
    let g = acc.get(plu);
    if (!g) {
      g = { plu, producto: c.nombre || '', cargas: 0, kilos: 0, minutos: 0, conHorario: 0 };
      acc.set(plu, g);
    }
    g.cargas += 1;
    g.kilos += kilosDeCarga(c);
    const iv = intervaloDe(c.desde, c.hasta);
    if (iv) { g.minutos += iv[1] - iv[0]; g.conHorario += 1; }
  }
  return [...acc.values()].map(g => {
    const peso = pesoPresentacionDe(g.plu);
    const paquetes = peso ? g.kilos / peso : null;
    const minPorPaquete = (paquetes && g.conHorario > 0) ? g.minutos / paquetes : null;
    return {
      plu: g.plu, producto: g.producto, cargas: g.cargas, cargasConHorario: g.conHorario,
      kilos: redondear(g.kilos), minutos: redondear(g.minutos, 1),
      paquetes: paquetes != null ? redondear(paquetes, 1) : null,
      minPorPaquete: minPorPaquete != null ? redondear(minPorPaquete, 3) : null,
    };
  });
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

  return { filas, sinPlan, idsUsadas: [...usadas].map(String) };
}

// Vista por día para la sala de producción: un renglón por jornada con órdenes asignadas y,
// adentro, el detalle de esas órdenes. Cada día se resuelve por separado para que las horas
// del día salgan de las cargas realmente imputadas a él y no de sumar filas (dos productos
// hechos por la misma persona en el mismo bloque son una hora, no dos).
function resumenPorDia(planItems, cargas, ordenes) {
  const porFecha = new Map();
  for (const it of planItems || []) {
    const f = it && it.fecha;
    if (!f) continue;
    if (!porFecha.has(f)) porFecha.set(f, []);
    porFecha.get(f).push(it);
  }
  // Cada carga se imputa a UN solo día: si el plan se movió de fecha, el mismo número de
  // movimiento queda en dos jornadas y las dos reclamarían la misma producción. Los días se
  // recorren de más viejo a más nuevo y lo ya imputado sale del pool.
  let pool = (cargas || []).slice();
  const fechasAsc = [...porFecha.keys()].sort();
  return fechasAsc.map(fecha => {
    const items = porFecha.get(fecha);
    const { filas, idsUsadas } = resumenOrdenes(items, pool, ordenes);
    const set = new Set(idsUsadas);
    const usadas = pool.filter(c => c && set.has(String(c.id)));
    pool = pool.filter(c => !(c && set.has(String(c.id))));
    const personas = resumenPersonas(usadas);
    const planificado = filas.reduce((s, f) => s + f.planificado, 0);
    const producido = filas.reduce((s, f) => s + f.producido, 0);
    return {
      fecha,
      ordenes: filas,
      lineas: filas.length,
      planificado,
      producido,
      pct: planificado > 0 ? redondear((producido / planificado) * 100, 1) : null,
      kilos: redondear(usadas.reduce((s, c) => s + kilosDeCarga(c), 0)),
      cargas: usadas.length,
      horas: redondear(personas.reduce((s, p) => s + p.horas, 0)),
      personas: personas.map(p => p.persona),
      // Quién quedó asignado en el plan aunque todavía no haya cargado nada.
      asignados: [...new Map((items || []).flatMap(it => (it.responsables || [])
        .filter(Boolean).map(n => [claveNombre(n), nombreLindo(n)]))).values()],
    };
  }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

// Catálogo de lo producido: un renglón por producto con cuánto se hizo y cuánto tarda.
// El promedio es por carga (una carga = una tanda del producto); minPorKilo permite comparar
// productos de tandas distintas entre sí, que el promedio por carga solo no deja ver.
function resumenProductos(cargas, familiaDe) {
  const acc = new Map();
  for (const c of cargas || []) {
    const plu = String(c && c.plu != null ? c.plu : '');
    if (!plu) continue;
    let g = acc.get(plu);
    if (!g) {
      g = { plu, producto: c.nombre || '', familia: familiaDe ? familiaDe(c) : '',
            cargas: 0, unidades: 0, kilos: 0,
            minutos: 0, conHorario: 0, personas: new Map(), dias: new Set() };
      acc.set(plu, g);
    }
    g.cargas += 1;
    g.unidades += num(c.cantFraccionada);
    g.kilos += kilosDeCarga(c);
    if (c.fecha) g.dias.add(c.fecha);
    for (const p of personasDeCarga(c)) g.personas.set(claveNombre(p.nombre), nombreLindo(p.nombre));
    const iv = intervaloDe(c.desde, c.hasta);
    // Sólo las cargas con horario entran al promedio: si no, una carga sin hora lo hunde.
    if (iv) { g.minutos += iv[1] - iv[0]; g.conHorario += 1; }
  }
  return [...acc.values()].map(g => ({
    plu: g.plu,
    producto: g.producto,
    familia: g.familia,
    cargas: g.cargas,
    unidades: redondear(g.unidades),
    kilos: redondear(g.kilos),
    dias: g.dias.size,
    minPromedio: g.conHorario > 0 ? redondear(g.minutos / g.conHorario, 1) : null,
    minPorKilo: g.conHorario > 0 && g.kilos > 0 ? redondear(g.minutos / g.kilos, 2) : null,
    kgPorHora: g.minutos > 0 ? redondear(g.kilos / (g.minutos / 60), 2) : null,
    sinHorario: g.cargas - g.conHorario,
    personas: [...g.personas.values()],
  })).sort((a, b) => b.kilos - a.kilos || b.cargas - a.cargas);
}

// ── Resúmenes por período ─────────────────────────────────────────────────────
// Semana ISO (arranca lunes) en formato "2026-W32", con el lunes y el domingo del período.
// Se calcula en UTC a partir de las partes de la fecha: construir un Date desde el string
// "2026-08-10" lo interpretaría en UTC y en Argentina caería un día antes.
function claveSemana(fecha) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime())) return null;
  const dia = (d.getUTCDay() + 6) % 7;               // lunes = 0
  const lunes = new Date(d.getTime() - dia * 86400000);
  const domingo = new Date(lunes.getTime() + 6 * 86400000);
  // El jueves de la semana define a qué año ISO pertenece (semanas a caballo de enero).
  const jueves = new Date(lunes.getTime() + 3 * 86400000);
  const iniAnio = new Date(Date.UTC(jueves.getUTCFullYear(), 0, 1));
  const semana = Math.floor((jueves - iniAnio) / 86400000 / 7) + 1;
  return {
    clave: `${jueves.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`,
    desde: lunes.toISOString().slice(0, 10),
    hasta: domingo.toISOString().slice(0, 10),
  };
}

// Mes calendario: "2026-08", del 1 al último día. El último día se saca pidiendo el día 0
// del mes siguiente, que en JS es el último del actual.
function claveMes(fecha) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(fecha || ''));
  if (!m) return null;
  const fin = new Date(Date.UTC(+m[1], +m[2], 0));
  return { clave: `${m[1]}-${m[2]}`, desde: `${m[1]}-${m[2]}-01`, hasta: fin.toISOString().slice(0, 10) };
}

// Día, semana ISO o mes calendario. El día es su propio período: desde y hasta son la fecha.
function clavePeriodo(fecha, unidad) {
  if (unidad === 'semana') return claveSemana(fecha);
  if (unidad === 'mes') return claveMes(fecha);
  const f = String(fecha || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? { clave: f, desde: f, hasta: f } : null;
}

// Producción por familia de producto: MIEL 500G y MIEL 1KG son la misma familia, así que las
// unidades no se suman entre sí (no significan nada juntas) pero los kilos y las horas sí.
function resumenFamilias(cargas, familiaDe) {
  const acc = new Map();
  for (const c of cargas || []) {
    const familia = (familiaDe ? familiaDe(c) : '') || 'Sin familia';
    const clave = claveNombre(familia);
    let g = acc.get(clave);
    if (!g) {
      g = { familia, cargas: [], productos: new Set(), personas: new Set() };
      acc.set(clave, g);
    }
    g.cargas.push(c);
    if (c && c.plu != null && c.plu !== '') g.productos.add(String(c.plu));
    for (const p of personasDeCarga(c)) g.personas.add(claveNombre(p.nombre));
  }
  return [...acc.values()].map(g => {
    const t = totales(g.cargas);
    return {
      familia: g.familia,
      cargas: t.cargas,
      productos: g.productos.size,
      personas: g.personas.size,
      unidades: t.unidades,
      kilos: t.kilos,
      horas: t.horas,
      dias: t.dias,
      kgPorHora: t.horas > 0 ? redondear(t.kilos / t.horas, 2) : null,
    };
  }).sort((a, b) => b.kilos - a.kilos || b.cargas - a.cargas);
}

// Resúmenes por día o por semana: por cada período, el ranking de productos y el de personas.
// Es la misma agregación que los totales generales, sólo que acotada al período, así los
// rankings se leen igual sin importar la ventana elegida.
function resumenPeriodos(cargas, unidad, tareas, familiaDe) {
  const porPeriodo = new Map();
  for (const c of cargas || []) {
    if (!c || !c.fecha) continue;
    const per = clavePeriodo(c.fecha, unidad);
    if (!per) continue;
    if (!porPeriodo.has(per.clave)) {
      porPeriodo.set(per.clave, {
        clave: per.clave, desde: per.desde, hasta: per.hasta,
        cargas: [], tareas: 0, minutosTareas: 0,
      });
    }
    porPeriodo.get(per.clave).cargas.push(c);
  }
  // Las tareas extra no producen unidades pero ocupan la sala: se cuentan aparte, en su
  // propio renglón, para que el período muestre también ese esfuerzo.
  for (const t of tareas || []) {
    if (!t || !t.fecha) continue;
    const per = clavePeriodo(t.fecha, unidad);
    if (!per) continue;
    const g = porPeriodo.get(per.clave);
    if (!g) continue;   // sin producción en el período, la tarea suelta no crea un renglón
    g.tareas += 1;
    const iv = intervaloDe(t.desde, t.hasta);
    if (iv) g.minutosTareas += iv[1] - iv[0];
  }
  return [...porPeriodo.values()].map(g => {
    const personas = resumenPersonas(g.cargas);
    const productos = resumenProductos(g.cargas, familiaDe);
    const familias = resumenFamilias(g.cargas, familiaDe);
    const t = totales(g.cargas);
    return {
      clave: g.clave,
      desde: g.desde,
      hasta: g.hasta,
      cargas: t.cargas,
      unidades: t.unidades,
      kilos: t.kilos,
      horas: t.horas,
      dias: t.dias,
      productosDistintos: productos.length,
      personasTotal: personas.length,
      familiasTotal: familias.length,
      familias,
      tareas: g.tareas,
      horasTareas: redondear(g.minutosTareas / 60),
      // El ranking ya viene ordenado: productos por kilos, personas por kilos producidos.
      productos,
      // "Cuántos productos produce cada persona" es el criterio del ranking de gente.
      personas: personas.slice().sort((a, b) => b.productos - a.productos || b.unidades - a.unidades),
    };
  }).sort((a, b) => String(b.clave).localeCompare(String(a.clave)));
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
  nombreLindo, consolidarPlan, resumenPersonas, resumenOrdenes, resumenPorDia,
  resumenProductos, claveSemana, claveMes, clavePeriodo, resumenPeriodos, resumenFamilias,
  totales, unirPorId, enRango, indexarMovimientos, pesoPresentacionKg, paquetesRealesPorProducto,
  // Nombre viejo del catálogo de productos: quedó cuando sólo lo usaba la sala de fraccionado.
  resumenProductosFraccionado: resumenProductos,
};
