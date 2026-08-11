'use strict';
// Resúmenes viejos de sala (data/resumenes/*.xlsx). Son la única fuente de producción anterior
// a que existieran produccion_registros.json y fraccionado_registros.json, así que sin esto el
// dashboard arranca recién en junio de 2026 y pierde medio año de cargas.
//
// Formato de la hoja "Fraccionado" (cabecera fija). Cada lote es un bloque de filas:
//   fila del producto      → cantidad positiva y, en las últimas 3 columnas, QUIÉN hizo cada rol
//   fila literal "CODIGO"  → en esas mismas columnas, la hora de INICIO de cada rol
//   fila siguiente         → la hora de FIN de cada rol (y ya es el primer componente)
//   filas con cantidad < 0 → los consumos del lote
// Las horas vienen como fracción de día de Excel (0.3333 = 08:00).
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const COL = { codigo: 0, nombre: 1, cant: 2, lote: 3, empleado: 4, sala: 6, horaIni: 7, horaFin: 8 };
const ROLES = [['Envasado', 10], ['Etiquetado', 11], ['Empaquetado', 12]];
// Packaging: nunca es el granel del lote aunque sea el consumo más grande en unidades.
const ES_PACKAGING = /envase|tapa|etiqueta|precinto|caja|bolsa|film|pouch|termocontra|cinta|separador/i;

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const redondear = (v, d = 4) => Math.round(num(v) * 10 ** d) / 10 ** d;
const texto = v => String(v == null ? '' : v).trim();

// Fracción de día de Excel → "HH:MM". Acepta también un "HH:MM" ya escrito.
function horaDeFraccion(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
    return m ? `${String(m[1]).padStart(2, '0')}:${m[2]}` : '';
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n >= 1) return '';
  const min = Math.round(n * 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// El lote trae la fecha real de la jornada ("230226/0-15205" → 2026-02-23), que es más
// confiable que el nombre del archivo: el resumen se exporta al día siguiente.
function fechaDeLote(lote) {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(texto(lote));
  if (!m) return '';
  const [, dd, mm, aa] = m;
  const d = Number(dd), mes = Number(mm);
  if (d < 1 || d > 31 || mes < 1 || mes > 12) return '';
  return `20${aa}-${mm}-${dd}`;
}

const esFilaVacia = row => !(row || []).some(v => texto(v) !== '');
const esSeparadora = row => texto(row && row[COL.codigo]).toUpperCase() === 'CODIGO';
const esCabecera = row => texto(row && row[COL.codigo]).toLowerCase().startsWith('codigo ingresado');
const esTareaExtra = lote => /^tareaextra/i.test(texto(lote));
// "Sala Fraccionado" / "Sala Produccion". Lo que no diga fraccionado va a producción.
const salaDe = v => /fraccion/i.test(texto(v)) ? 'fraccionado' : 'produccion';

// El granel del lote: entre los consumos, el de mayor cantidad que sea granel. Si ninguno se
// llama granel, el mayor consumo que no sea packaging (mismo criterio que usa el resto del
// sistema para deducir el componente principal de una fórmula).
function granelDe(componentes) {
  const candidatos = (componentes || []).filter(c => /granel/i.test(c.nombre));
  const pool = candidatos.length ? candidatos : (componentes || []).filter(c => !ES_PACKAGING.test(c.nombre));
  if (!pool.length) return null;
  return pool.reduce((mejor, c) => (c.cant > mejor.cant ? c : mejor), pool[0]);
}

// Un bloque de filas con el mismo lote → una carga con la forma que ya consume productividad.js.
function cargaDeBloque(filas, fechaArchivo) {
  const cabezaIdx = (filas || []).findIndex(r => !esSeparadora(r) && num(r[COL.cant]) > 0);
  if (cabezaIdx < 0) return null;
  const cabeza = filas[cabezaIdx];
  const lote = texto(cabeza[COL.lote]);
  const fecha = fechaDeLote(lote) || fechaArchivo || '';
  if (!fecha) return null;

  const sepIdx = filas.findIndex(esSeparadora);
  const filaInicio = sepIdx >= 0 ? filas[sepIdx] : null;
  const filaFin = sepIdx >= 0 ? filas[sepIdx + 1] : null;

  const roles = ROLES.map(([rol, col]) => ({
    rol,
    nombre: texto(cabeza[col]),
    desde: horaDeFraccion(filaInicio && filaInicio[col]),
    hasta: horaDeFraccion(filaFin && filaFin[col]),
  })).filter(r => r.nombre);
  // Sin roles cargados queda el empleado del lote, que es quien figura en toda la fila.
  const empleado = texto(cabeza[COL.empleado]);
  if (!roles.length && empleado) {
    roles.push({ rol: '', nombre: empleado,
                 desde: horaDeFraccion(cabeza[COL.horaIni]), hasta: horaDeFraccion(cabeza[COL.horaFin]) });
  }

  const componentes = filas
    .filter(r => !esSeparadora(r) && num(r[COL.cant]) < 0)
    .map(r => ({ plu: texto(r[COL.codigo]), nombre: texto(r[COL.nombre]), cant: Math.abs(num(r[COL.cant])) }));
  const granel = granelDe(componentes);

  const inicios = roles.map(r => r.desde).filter(Boolean).sort();
  const fines = roles.map(r => r.hasta).filter(Boolean).sort();
  return {
    // El lote ya es único por jornada y producto; el prefijo evita chocar con los ids numéricos
    // de las cargas nuevas cuando las dos colecciones se unen.
    id: `legacy:${lote}:${texto(cabeza[COL.codigo])}`,
    fecha,
    plu: texto(cabeza[COL.codigo]),
    nombre: texto(cabeza[COL.nombre]),
    seccion: texto(cabeza[COL.sala]),
    sala: salaDe(cabeza[COL.sala]),
    cantFraccionada: redondear(num(cabeza[COL.cant])),
    granelConsumido: granel ? redondear(granel.cant) : 0,
    granel: granel ? granel.plu : '',
    nombreGranel: granel ? granel.nombre : '',
    lote,
    empleado,
    desde: inicios[0] || '',
    hasta: fines[fines.length - 1] || '',
    roles,
    origen: 'resumen-legacy',
  };
}

// Tareas sin producto ("limpieza de arandanos"): ocupan tiempo de sala pero no producen
// unidades. Se devuelven aparte para que no hundan el ritmo de nadie.
function tareaDeFila(row, fechaArchivo) {
  const nombre = texto(row[COL.empleado]);
  if (!nombre) return null;
  return {
    id: `legacy-tarea:${fechaArchivo}:${texto(row[COL.lote])}`,
    fecha: fechaArchivo,
    persona: nombre,
    tarea: texto(row[COL.nombre]),
    sala: salaDe(row[COL.sala]),
    desde: horaDeFraccion(row[COL.horaIni]),
    hasta: horaDeFraccion(row[COL.horaFin]),
    origen: 'resumen-legacy',
  };
}

// Una hoja completa → { cargas, tareas }. Los bloques se cortan por cambio de lote.
function parseFilas(rows) {
  const utiles = (rows || []).filter(r => !esFilaVacia(r) && !esCabecera(r));
  // Fecha del archivo: la más repetida entre los lotes, para las tareas extra que no la traen.
  const conteo = new Map();
  for (const r of utiles) {
    const f = fechaDeLote(r[COL.lote]);
    if (f) conteo.set(f, (conteo.get(f) || 0) + 1);
  }
  const fechaArchivo = [...conteo.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0])[0] || '';

  const cargas = [], tareas = [];
  let bloque = [], loteActual = null;
  const cerrar = () => {
    if (bloque.length) {
      const c = cargaDeBloque(bloque, fechaArchivo);
      if (c) cargas.push(c);
    }
    bloque = [];
  };
  for (const r of utiles) {
    const lote = texto(r[COL.lote]);
    if (esTareaExtra(lote)) {
      cerrar(); loteActual = null;
      const t = tareaDeFila(r, fechaArchivo);
      if (t) tareas.push(t);
      continue;
    }
    if (lote !== loteActual) { cerrar(); loteActual = lote; }
    bloque.push(r);
  }
  cerrar();
  return { cargas, tareas };
}

// ── Lectura de la carpeta ─────────────────────────────────────────────────────
// Parsear 155 xlsx en cada request es caro y los archivos no cambian: se cachean por
// (mtime, tamaño), así un resumen reexportado se vuelve a leer solo.
const cache = new Map();

function leerArchivo(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { cargas: [], tareas: [] }; }
  const sello = `${st.mtimeMs}:${st.size}`;
  const previo = cache.get(file);
  if (previo && previo.sello === sello) return previo.datos;
  let datos = { cargas: [], tareas: [] };
  try {
    const wb = XLSX.readFile(file);
    // Sólo las hojas con la cabecera conocida: hay un CSV suelto con otro layout, sin empleado
    // ni horarios, que no sirve para medir productividad.
    for (const hoja of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '' });
      if (!rows.length || !esCabecera(rows[0])) continue;
      const r = parseFilas(rows);
      datos = { cargas: [...datos.cargas, ...r.cargas], tareas: [...datos.tareas, ...r.tareas] };
    }
  } catch (e) {
    // Un archivo corrupto no puede tumbar el dashboard entero: se ignora y siguen los demás.
    datos = { cargas: [], tareas: [] };
  }
  cache.set(file, { sello, datos });
  return datos;
}

function leerCarpeta(dir) {
  let archivos;
  try { archivos = fs.readdirSync(dir); } catch (e) { return { cargas: [], tareas: [] }; }
  const cargas = [], tareas = [];
  for (const f of archivos.filter(n => /\.xlsx$/i.test(n)).sort()) {
    const r = leerArchivo(path.join(dir, f));
    cargas.push(...r.cargas);
    tareas.push(...r.tareas);
  }
  return { cargas, tareas };
}

// Los resúmenes viejos se solapan con los registros nuevos (llegan hasta fines de julio y los
// JSON arrancan en junio). Cuando una jornada ya está cargada en el sistema nuevo, esa jornada
// manda: sumar las dos fuentes contaría la misma producción dos veces.
function sinFechasCubiertas(legacy, actuales) {
  const cubiertas = new Set((actuales || []).map(c => c && c.fecha).filter(Boolean));
  return (legacy || []).filter(c => c && !cubiertas.has(c.fecha));
}

module.exports = {
  horaDeFraccion, fechaDeLote, granelDe, cargaDeBloque, parseFilas, leerArchivo, leerCarpeta,
  sinFechasCubiertas, salaDe,
};
