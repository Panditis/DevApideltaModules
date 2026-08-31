// ── rrhh_ropa.js ─────────────────────────────────────────────────────────────
// Módulo puro del relevamiento de ropa de trabajo (RRHH). Sin I/O ni express:
// acá vive la normalización (trust boundary del server) y el cálculo del
// resumen de faltantes. El server sólo lee/escribe el JSON y llama a esto.
'use strict';

// Estado de cada prenda por empleado:
//   'si'  la tiene · 'no' le falta · 'na' no aplica al puesto · '' sin relevar
const ESTADOS = ['si', 'no', 'na', ''];
const AREA_SIN_ASIGNAR = 'Sin área asignada';
// Áreas donde el calzado de seguridad es obligatorio salvo que se indique lo contrario.
const AREAS_CALZADO_OBLIGATORIO = ['Producción', 'Logística'];

function texto(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function normalizarEstado(v) {
  const s = texto(v).toLowerCase().replace(/í/g, 'i');
  if (s === 'si') return 'si';
  if (s === 'no') return 'no';
  if (s === 'na' || s === 'n/a') return 'na';
  return '';
}

// Slug estable para el id de una prenda nueva ("Guantes de nitrilo" → "guantes-de-nitrilo").
function slugPrenda(nombre) {
  return texto(nombre)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Id único dentro de la lista: al slug repetido se le suma un sufijo numérico.
function idUnico(base, usados) {
  const raiz = base || 'prenda';
  if (!usados.includes(raiz)) return raiz;
  let n = 2;
  while (usados.includes(`${raiz}-${n}`)) n++;
  return `${raiz}-${n}`;
}

// Id correlativo de empleado: emp-001, emp-002… (toma el máximo existente + 1).
function siguienteIdEmpleado(empleados) {
  const max = (Array.isArray(empleados) ? empleados : []).reduce((acc, e) => {
    const m = /^emp-(\d+)$/.exec(texto(e && e.id));
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return `emp-${String(max + 1).padStart(3, '0')}`;
}

function normalizarPrenda(prenda, usados = []) {
  const nombre = texto(prenda && prenda.nombre);
  if (!nombre) throw new Error('La prenda necesita un nombre.');
  const id = texto(prenda && prenda.id) || idUnico(slugPrenda(nombre), usados);
  return { id, nombre };
}

// Deja al empleado con exactamente una entrada por prenda del catálogo: las que
// no vienen quedan sin relevar y las de prendas borradas se descartan.
function normalizarEmpleado(empleado, prendas) {
  const e = empleado || {};
  const nombre = texto(e.nombre);
  if (!nombre) throw new Error('El empleado necesita un nombre.');
  const area = texto(e.area) || AREA_SIN_ASIGNAR;
  const entrada = (e.prendas && typeof e.prendas === 'object') ? e.prendas : {};
  const salida = {};
  for (const p of Array.isArray(prendas) ? prendas : []) {
    const v = entrada[p.id] || {};
    salida[p.id] = { talle: texto(v.talle), estado: normalizarEstado(v.estado) };
  }
  return {
    id: texto(e.id),
    nombre,
    area,
    puesto: texto(e.puesto),
    ubicacion: texto(e.ubicacion),
    calzadoObligatorio: typeof e.calzadoObligatorio === 'boolean'
      ? e.calzadoObligatorio
      : AREAS_CALZADO_OBLIGATORIO.includes(area),
    observaciones: texto(e.observaciones),
    // Marca visual compartida: cualquiera puede resaltar una fila desde la tabla.
    destacado: e.destacado === true,
    prendas: salida,
  };
}

// Documento completo saneado: catálogo de prendas + empleados alineados a él.
function normalizarDocumento(doc) {
  const d = doc || {};
  const usados = [];
  const prendas = (Array.isArray(d.prendas) ? d.prendas : []).map(p => {
    const n = normalizarPrenda(p, usados);
    usados.push(n.id);
    return n;
  });
  const empleados = (Array.isArray(d.empleados) ? d.empleados : []).map(e => normalizarEmpleado(e, prendas));
  return { prendas, empleados };
}

// Resumen para el encabezado: cuánta gente hay, cuántas prendas faltan y dónde.
function resumen(doc) {
  const { prendas, empleados } = normalizarDocumento(doc);
  const faltantesPorPrenda = {};
  const porArea = new Map();
  let faltantes = 0;
  let sinRelevar = 0;

  for (const p of prendas) faltantesPorPrenda[p.id] = 0;

  for (const e of empleados) {
    const areaAcc = porArea.get(e.area) || { area: e.area, empleados: 0, faltantes: 0 };
    areaAcc.empleados++;
    for (const p of prendas) {
      const est = e.prendas[p.id].estado;
      if (est === 'no') { faltantes++; areaAcc.faltantes++; faltantesPorPrenda[p.id]++; }
      else if (est === '') sinRelevar++;
    }
    porArea.set(e.area, areaAcc);
  }

  return {
    empleados: empleados.length,
    prendas: prendas.length,
    faltantes,
    sinRelevar,
    faltantesPorPrenda,
    porArea: [...porArea.values()].sort((a, b) => a.area.localeCompare(b.area, 'es')),
  };
}

module.exports = {
  ESTADOS,
  AREA_SIN_ASIGNAR,
  AREAS_CALZADO_OBLIGATORIO,
  slugPrenda,
  siguienteIdEmpleado,
  normalizarEstado,
  normalizarPrenda,
  normalizarEmpleado,
  normalizarDocumento,
  resumen,
};
