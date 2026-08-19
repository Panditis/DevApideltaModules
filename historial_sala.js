'use strict';
// Historial de sala: los resúmenes viejos (data/resumenes/*.xlsx) mirados por su dato propio,
// el que ningún registro nuevo tiene — QUIÉN hizo cada rol y en qué horario.
//
// En esos archivos cada lote trae tres columnas de tarea (Envasado, Etiquetado, Empaquetado) y
// cada una su encargado con hora de inicio y de fin. resumenes_legacy.js ya las deja en
// carga.roles[] = [{ rol, nombre, desde, hasta }]; acá se miden.
//
// El resto del dashboard (totales, personas, familias, períodos) se reusa de productividad.js:
// este módulo sólo agrega el corte por rol, que es lo que no existe en el sistema nuevo.
const P = require('./productividad');

// Orden fijo de la cabecera del xlsx: es el orden real de la línea, no alfabético.
const ROLES = ['Envasado', 'Etiquetado', 'Empaquetado'];
// Lotes viejos sin las tres columnas cargadas: el parser cae al empleado del lote, sin rol.
const SIN_ROL = 'Sin rol';

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const redondear = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;
const prom = (total, cant) => (cant > 0 ? redondear(total / cant) : null);

// ── Valorización ──────────────────────────────────────────────────────────────
// Lo producido medido en plata: unidades × precio de venta de lista. Los kilos comparan mal
// entre presentaciones (100 g de polen y 10 kg de mix no pesan lo mismo pero tampoco valen lo
// mismo por kilo); el precio pone todo en la misma unidad.
//
// `precios` es un Map plu → precio, o una función. Sin precio, el lote no se valoriza y se
// cuenta aparte: inventarle un precio taparía el agujero en vez de mostrarlo.
function precioDe(precios, plu) {
  if (!precios) return 0;
  const p = typeof precios === 'function' ? precios(plu) : precios.get(String(plu));
  return num(p) > 0 ? num(p) : 0;
}

function valorDeCarga(c, precios) {
  const precio = precioDe(precios, c && c.plu);
  return precio > 0 ? redondear(num(c && c.cantFraccionada) * precio) : 0;
}

// Minutos de un rol, o null si no trae las dos horas (o vienen al revés).
function minutosDeRol(r) {
  const iv = P.intervaloDe(r && r.desde, r && r.hasta);
  return iv ? iv[1] - iv[0] : null;
}

const rolDe = r => (r && r.rol ? String(r.rol).trim() : SIN_ROL);
// Los roles se recorren siempre por acá: una carga sin roles[] no aporta nada y no rompe.
const rolesDe = c => (Array.isArray(c && c.roles) ? c.roles : []).filter(r => r && r.nombre);
const intervalosDe = c => rolesDe(c).map(r => P.intervaloDe(r.desde, r.hasta)).filter(Boolean);

// ── Tiempo sin doble conteo ───────────────────────────────────────────────────
// Envasar, etiquetar y empaquetar un lote se registran con su propia hora, pero muchas veces
// pasan a la vez: el mismo bloque 08:00-09:00 en las tres columnas es UNA hora de trabajo, no
// tres. Sumar los roles de frente triplica el tiempo del lote y hunde cualquier ritmo.
function minutosEfectivos(c) {
  return P.minutosUnidos(intervalosDe(c));
}

// Lo mismo un escalón arriba: los minutos que la sala estuvo ocupada cada día, uniendo los
// intervalos de todos los lotes de esa jornada. Dos lotes en paralelo tampoco se suman dos veces.
function minutosSalaPorDia(cargas) {
  const porDia = new Map();
  for (const c of cargas || []) {
    const dia = (c && c.fecha) || '';
    if (!dia) continue;
    const ivs = intervalosDe(c);
    if (!ivs.length) continue;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(...ivs);
  }
  return new Map([...porDia].map(([dia, ivs]) => [dia, P.minutosUnidos(ivs)]));
}

const horasSalaDe = cargas =>
  redondear([...minutosSalaPorDia(cargas).values()].reduce((s, m) => s + m, 0) / 60);

// ── Roles ─────────────────────────────────────────────────────────────────────
// Una fila por tarea de la línea: cuánto tiempo se le va a envasar contra etiquetar, con
// cuánta gente y sobre cuántos productos. `sinHorario` avisa cuántos lotes no se pueden medir.
function resumenRoles(cargas) {
  const acc = new Map();
  for (const c of cargas || []) {
    for (const r of rolesDe(c)) {
      const rol = rolDe(r);
      let g = acc.get(rol);
      if (!g) {
        g = { rol, cargas: 0, sinHorario: 0, minutos: 0, medidas: 0,
              personas: new Set(), productos: new Set(), dias: new Set() };
        acc.set(rol, g);
      }
      g.cargas += 1;
      g.personas.add(P.claveNombre(r.nombre));
      if (c.plu != null && c.plu !== '') g.productos.add(String(c.plu));
      if (c.fecha) g.dias.add(c.fecha);
      const min = minutosDeRol(r);
      if (min == null) { g.sinHorario += 1; continue; }
      g.minutos += min;
      g.medidas += 1;
    }
  }
  return [...acc.values()]
    .map(g => ({
      rol: g.rol,
      cargas: g.cargas,
      sinHorario: g.sinHorario,
      minutos: g.minutos,
      horas: redondear(g.minutos / 60),
      minPromedio: prom(g.minutos, g.medidas),
      personas: g.personas.size,
      productos: g.productos.size,
      dias: g.dias.size,
    }))
    // El orden de la línea manda; lo que no sea un rol conocido va al final.
    .sort((a, b) => {
      const ia = ROLES.indexOf(a.rol), ib = ROLES.indexOf(b.rol);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.rol.localeCompare(b.rol, 'es');
    });
}

// ── Personas por rol ──────────────────────────────────────────────────────────
// Quién hace qué. Una fila por (persona, rol): la misma persona aparece tantas veces como
// tareas distintas cubrió. Los minutos se fusionan por día, igual que en el resto del módulo:
// dos lotes envasados en el mismo bloque horario son un bloque trabajado, no dos.
function resumenPersonasPorRol(cargas) {
  const acc = new Map();
  for (const c of cargas || []) {
    const roles = rolesDe(c);
    if (!roles.length) continue;
    // Las cantidades se reparten entre los roles del lote: si envasado y etiquetado se lo
    // anotan entero cada uno, la suma de las filas duplica la producción real.
    const parte = 1 / roles.length;
    const unidades = num(c.cantFraccionada) * parte;
    const kilos = P.kilosDeCarga(c) * parte;
    for (const r of roles) {
      const rol = rolDe(r);
      const clave = `${P.claveNombre(r.nombre)}|${rol}`;
      let g = acc.get(clave);
      if (!g) {
        g = { persona: P.nombreLindo(r.nombre), rol, cargas: 0, sinHorario: 0, medidas: 0,
              minutos: 0, unidades: 0, kilos: 0, dias: new Set(), productos: new Set(),
              intervalos: new Map() };
        acc.set(clave, g);
      }
      g.cargas += 1;
      g.unidades += unidades;
      g.kilos += kilos;
      if (c.fecha) g.dias.add(c.fecha);
      if (c.plu != null && c.plu !== '') g.productos.add(String(c.plu));
      const iv = P.intervaloDe(r.desde, r.hasta);
      if (!iv) { g.sinHorario += 1; continue; }
      g.minutos += iv[1] - iv[0];
      g.medidas += 1;
      const dia = c.fecha || '';
      if (!g.intervalos.has(dia)) g.intervalos.set(dia, []);
      g.intervalos.get(dia).push(iv);
    }
  }
  return [...acc.values()].map(g => {
    const efectivos = [...g.intervalos.values()].reduce((s, ivs) => s + P.minutosUnidos(ivs), 0);
    const horas = efectivos / 60;
    return {
      persona: g.persona,
      rol: g.rol,
      cargas: g.cargas,
      productos: g.productos.size,
      unidades: redondear(g.unidades),
      kilos: redondear(g.kilos),
      dias: g.dias.size,
      horas: redondear(horas),
      minPromedio: prom(g.minutos, g.medidas),
      unidPorHora: horas > 0 ? redondear(g.unidades / horas) : null,
      kgPorHora: horas > 0 ? redondear(g.kilos / horas) : null,
      sinHorario: g.sinHorario,
    };
  }).sort((a, b) => b.horas - a.horas || b.kilos - a.kilos);
}

// ── Productos por rol ─────────────────────────────────────────────────────────
// Cuánto tarda cada producto en cada tarea. Es lo que sirve para estimar una jornada: si
// etiquetar polen 100 g lleva el doble que envasarlo, el cuello de botella está ahí.
function resumenProductosPorRol(cargas, precios) {
  const acc = new Map();
  for (const c of cargas || []) {
    const plu = String(c && c.plu == null ? '' : c.plu);
    let g = acc.get(plu);
    if (!g) {
      g = { plu, producto: (c && c.nombre) || '', cargas: 0, unidades: 0, kilos: 0, valor: 0,
            precio: precioDe(precios, plu), dias: new Set(), personas: new Set(),
            porRol: new Map(), minLote: 0, lotesMedidos: 0 };
      acc.set(plu, g);
    }
    g.cargas += 1;
    g.unidades += num(c.cantFraccionada);
    g.kilos += P.kilosDeCarga(c);
    g.valor += valorDeCarga(c, precios);
    if (c.fecha) g.dias.add(c.fecha);
    // Duración real del lote: la unión de sus tareas, no la suma. Las que se hicieron a la vez
    // cuentan una sola vez.
    const minLote = minutosEfectivos(c);
    if (minLote > 0) { g.minLote += minLote; g.lotesMedidos += 1; }
    for (const r of rolesDe(c)) {
      g.personas.add(P.nombreLindo(r.nombre));
      const rol = rolDe(r);
      const min = minutosDeRol(r);
      if (min == null) continue;
      const acu = g.porRol.get(rol) || { min: 0, n: 0 };
      g.porRol.set(rol, { min: acu.min + min, n: acu.n + 1 });
    }
  }
  return [...acc.values()].map(g => {
    const fila = {
      plu: g.plu,
      producto: g.producto,
      cargas: g.cargas,
      unidades: redondear(g.unidades),
      kilos: redondear(g.kilos),
      precio: g.precio || null,
      valor: redondear(g.valor) || null,
      dias: g.dias.size,
      minTanda: prom(g.minLote, g.lotesMedidos),
      minPorKilo: g.lotesMedidos && g.kilos > 0 ? redondear(g.minLote / g.kilos) : null,
      personas: [...g.personas].sort(),
    };
    // Una columna por rol conocido: `minEnvasado`, `minEtiquetado`, `minEmpaquetado`.
    for (const rol of ROLES) {
      const acu = g.porRol.get(rol);
      fila['min' + rol] = acu ? prom(acu.min, acu.n) : null;
    }
    return fila;
  }).sort((a, b) => (b.valor || 0) - (a.valor || 0) || b.kilos - a.kilos);
}

// ── Detalle ───────────────────────────────────────────────────────────────────
// Una fila por lote con las tres tareas desplegadas, que es la vista más parecida al xlsx
// original: sirve para auditar un día puntual sin abrir el archivo.
function registros(cargas, precios) {
  return (cargas || []).map(c => {
    const fila = {
      fecha: c.fecha || '',
      lote: c.lote || '',
      plu: String(c.plu == null ? '' : c.plu),
      producto: c.nombre || '',
      unidades: redondear(num(c.cantFraccionada)),
      kilos: redondear(P.kilosDeCarga(c)),
      valor: valorDeCarga(c, precios) || null,
      granel: c.nombreGranel || '',
      desde: c.desde || '',
      hasta: c.hasta || '',
      // Los minutos que ocupó el lote de verdad: las tareas simultáneas cuentan una vez.
      minLote: minutosEfectivos(c) || null,
    };
    const porRol = new Map(rolesDe(c).map(r => [rolDe(r), r]));
    for (const rol of ROLES) {
      const r = porRol.get(rol);
      fila[rol] = r ? P.nombreLindo(r.nombre) : '';
      fila['hs' + rol] = r && r.desde && r.hasta ? `${r.desde}–${r.hasta}` : '';
      fila['min' + rol] = r ? minutosDeRol(r) : null;
    }
    const sinRol = porRol.get(SIN_ROL);
    if (sinRol) fila.empleado = P.nombreLindo(sinRol.nombre);
    return fila;
  }).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))
    || String(a.producto).localeCompare(String(b.producto), 'es'));
}

// ── Períodos ──────────────────────────────────────────────────────────────────
// Los rankings los arma productividad.js; acá sólo se le agrega el reloj de sala, que él no
// puede calcular porque no sabe de roles. `horas` sigue siendo horas-persona: dos personas una
// hora son dos horas-persona pero una sola hora de sala, y las dos cifras dicen cosas distintas.
function resumenPeriodos(cargas, unidad, tareas, precios) {
  const minPorDia = minutosSalaPorDia(cargas);
  return P.resumenPeriodos(cargas, unidad, tareas).map(p => {
    let min = 0;
    for (const [dia, m] of minPorDia) if (dia >= p.desde && dia <= p.hasta) min += m;
    const delPeriodo = (cargas || []).filter(c => c && c.fecha >= p.desde && c.fecha <= p.hasta);
    const valor = delPeriodo.reduce((s, c) => s + valorDeCarga(c, precios), 0);
    return {
      ...p,
      horasSala: redondear(min / 60),
      valor: redondear(valor),
      // Lotes que no se pudieron valorizar: el total de plata es de los otros nada más.
      sinPrecio: delPeriodo.filter(c => precioDe(precios, c.plu) <= 0).length,
      // Plata por hora de sala: el ritmo real del período, comparable entre semanas.
      valorPorHora: min > 0 ? redondear(valor / (min / 60)) : null,
    };
  });
}

// ── Filtro ────────────────────────────────────────────────────────────────────
// Acota qué se mide: un rango de fechas, un producto o una persona. Filtra las cargas ANTES de
// medir, así todo el tablero (totales, roles, semanas, detalle) queda recalculado sobre ese
// subconjunto en vez de esconder filas de una tabla ya sumada.
function filtrar(cargas, filtro) {
  const plu = String((filtro && filtro.plu) || '').trim();
  const persona = P.claveNombre((filtro && filtro.persona) || '');
  const desde = (filtro && filtro.desde) || null;
  const hasta = (filtro && filtro.hasta) || null;
  if (!plu && !persona && !desde && !hasta) return cargas || [];
  return (cargas || []).filter(c => {
    if (!P.enRango(c && c.fecha, desde, hasta)) return false;
    if (plu && String(c && c.plu) !== plu) return false;
    if (persona && !rolesDe(c).some(r => P.claveNombre(r.nombre) === persona)) return false;
    return true;
  });
}

// Rango completo del archivo, siempre sobre el historial entero: es lo que necesita el botón
// "Todo el historial" para poder salir de un rango que dejó la pantalla vacía.
function rangoTotal(cargas) {
  const fechas = (cargas || []).map(c => c && c.fecha).filter(Boolean).sort();
  return { desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || '' };
}

// Opciones de los selectores de búsqueda. Salen del historial completo, no del filtrado: si no,
// elegir una persona vaciaría la lista de productos y no se podría volver.
function opciones(cargas) {
  const productos = new Map(), personas = new Map();
  for (const c of cargas || []) {
    const plu = String(c && c.plu == null ? '' : c.plu);
    if (plu && !productos.has(plu)) productos.set(plu, (c && c.nombre) || plu);
    for (const r of rolesDe(c)) {
      const k = P.claveNombre(r.nombre);
      if (k && !personas.has(k)) personas.set(k, P.nombreLindo(r.nombre));
    }
  }
  return {
    productos: [...productos.entries()].map(([plu, nombre]) => ({ plu, nombre }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
    personas: [...personas.values()].sort((a, b) => a.localeCompare(b, 'es')),
  };
}

// ── Cobertura ─────────────────────────────────────────────────────────────────
// Cuánto del histórico se puede medir de verdad. Sin esto, un promedio de "18 min por lote"
// no dice si sale de 400 lotes o de 6.
function cobertura(cargas, tareas) {
  const fechas = [...new Set((cargas || []).map(c => c && c.fecha).filter(Boolean))].sort();
  const conRoles = (cargas || []).filter(c => rolesDe(c).length).length;
  const medibles = (cargas || []).filter(c => rolesDe(c).some(r => minutosDeRol(r) != null)).length;
  return {
    jornadas: fechas.length,
    desde: fechas[0] || '',
    hasta: fechas[fechas.length - 1] || '',
    cargas: (cargas || []).length,
    conRoles,
    medibles,
    sinHorario: (cargas || []).length - medibles,
    tareas: (tareas || []).length,
  };
}

// ── Referencia ────────────────────────────────────────────────────────────────
// Los promedios del archivo ENTERO, congelados en una foto que se guarda aparte. Los gráficos
// comparan contra esto y no contra el rango que se está mirando: una semana no se juzga contra
// las otras tres que quedaron en pantalla sino contra lo que la sala viene haciendo siempre, y
// mover el filtro de fechas ya no mueve la vara.
//
// No se recalcula sola con cada carga nueva: si lo hiciera, la referencia se correría justo
// cuando hay que medir contra ella. El recálculo es un pedido explícito y `calculadoEl` dice de
// cuándo es la foto que se está usando (lo pone quien la guarda: acá no se lee el reloj).
//
// Las semanas de las puntas entran aunque estén cortadas: son dos sobre decenas y descartarlas
// obligaría a explicar por qué el promedio no cubre todo el archivo.
function referencia(datos, precios, calculadoEl) {
  const cargas = (datos && datos.cargas) || [];
  const semanas = resumenPeriodos(cargas, 'semana', [], precios);
  const total = (f) => semanas.reduce((s, x) => s + (f(x) || 0), 0);
  const tareas = {};
  for (const r of resumenRoles(cargas)) tareas[r.rol] = r.minPromedio;
  const productos = {};
  for (const p of resumenProductosPorRol(cargas, precios)) {
    productos[p.plu] = { producto: p.producto, cargas: p.cargas,
      minEnvasado: p.minEnvasado, minEtiquetado: p.minEtiquetado, minEmpaquetado: p.minEmpaquetado };
  }
  return {
    calculadoEl: calculadoEl || '',
    ...rangoTotal(cargas),
    cargas: cargas.length,
    semanas: semanas.length,
    semanal: {
      valor: prom(total(s => s.valor), semanas.length),
      cargas: prom(total(s => s.cargas), semanas.length),
      horasSala: prom(total(s => s.horasSala), semanas.length),
    },
    tareas,
    productos,
  };
}

// Todo el historial de una sola pasada. `filtro` es opcional: { plu, persona } acota la medición
// a un producto o a una persona. Las opciones de los selectores salen siempre del historial
// entero, para que un filtro no se pueda deshacer solo.
function resumen(datos, filtro, precios) {
  const todas = (datos && datos.cargas) || [];
  const cargas = filtrar(todas, filtro);
  const tareas = ((datos && datos.tareas) || [])
    .filter(t => {
      if (!P.enRango(t && t.fecha, (filtro && filtro.desde) || null, (filtro && filtro.hasta) || null)) return false;
      // Con una persona elegida, sus tareas sin producto también acompañan; con un producto, no
      // hay tarea que corresponda porque las tareas extra no tienen producto.
      if (filtro && filtro.plu) return false;
      if (filtro && filtro.persona) return P.claveNombre(t && t.persona) === P.claveNombre(filtro.persona);
      return true;
    });
  return {
    filtro: {
      plu: (filtro && filtro.plu) || '', persona: (filtro && filtro.persona) || '',
      desde: (filtro && filtro.desde) || '', hasta: (filtro && filtro.hasta) || '',
    },
    rangoTotal: rangoTotal(todas),
    opciones: opciones(todas),
    cobertura: cobertura(cargas, tareas),
    totales: {
      ...P.totales(cargas),
      horasSala: horasSalaDe(cargas),
      valor: redondear(cargas.reduce((s, c) => s + valorDeCarga(c, precios), 0)),
      sinPrecio: cargas.filter(c => precioDe(precios, c.plu) <= 0).length,
    },
    roles: resumenRoles(cargas),
    // El promedio por tarea de cada producto: un lote sin las dos horas de esa tarea no entra
    // al promedio (minutosDeRol devuelve null y no suma ni al total ni al conteo).
    productos: resumenProductosPorRol(cargas, precios),
    // resumenPersonasPorRol queda exportado y probado, pero fuera del payload: el tablero ya
    // no lo muestra y era la mitad del peso de la respuesta.
    porSemana: resumenPeriodos(cargas, 'semana', tareas, precios),
    porMes: resumenPeriodos(cargas, 'mes', tareas, precios),
    // Horas de sala de cada jornada. El detalle del día las necesita y no se pueden reconstruir
    // en el navegador: hay que unir los intervalos, no sumarlos.
    horasPorDia: Object.fromEntries([...minutosSalaPorDia(cargas)].map(([d, m]) => [d, redondear(m / 60)])),
    registros: registros(cargas, precios),
    tareas,
  };
}

module.exports = {
  ROLES, SIN_ROL, minutosDeRol, minutosEfectivos, minutosSalaPorDia, horasSalaDe,
  precioDe, valorDeCarga, resumenRoles, resumenPersonasPorRol, resumenProductosPorRol,
  resumenPeriodos, filtrar, rangoTotal, opciones, registros, cobertura, referencia, resumen,
};
