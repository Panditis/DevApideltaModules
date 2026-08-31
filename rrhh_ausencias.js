// ── rrhh_ausencias.js ────────────────────────────────────────────────────────
// Módulo puro de Ausencias (RRHH). Sin I/O ni express: acá viven los parsers de
// las dos planillas (el resumen histórico y la bajada del reloj de fichadas) y
// las agregaciones del dashboard. Lo usan el server (require) y el front (script).
//
// Un registro de ausencia tiene siempre la misma forma, venga de donde venga:
//   { id, fecha:'YYYY-MM-DD', fuente, persona, hoja, legajo, grupo, tipo, codigo, obs, impId }
'use strict';

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.RRHHAusencias = api;
})(typeof self !== 'undefined' ? self : this, function () {

const MESES_ABR = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DIAS_ABR  = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];
const DIAS_SEMANA_ORDEN = ['Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab', 'Dom'];
const GRUPO_DEFAULT = 'Ausencia/Licencia';
const FUENTE_RELOJ = 'RELOJ';
const SIN_CLASIFICAR = 'Sin clasificar';

function texto(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

// 'MIÉRCOLES' → 'MIERCOLES'. Los encabezados del reloj vienen con acentos y a
// veces mal codificados, así que se compara siempre sin diacríticos.
function sinTildes(s) {
  return texto(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Fecha → 'YYYY-MM-DD'. Acepta Date (lo que devuelve xlsx con cellDates),
// serial de Excel, o texto ya ISO / 'DD/MM/AAAA'.
function aISO(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return [v.getFullYear(), String(v.getMonth() + 1).padStart(2, '0'), String(v.getDate()).padStart(2, '0')].join('-');
  }
  if (typeof v === 'number' && isFinite(v)) {
    // Serial de Excel (1900-based). Se lee en UTC para que no lo corra el huso.
    const d = new Date(Math.round((v - 25569) * 86400000));
    if (isNaN(d)) return '';
    return [d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')].join('-');
  }
  const s = texto(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

// Se trabaja en UTC a propósito: las fechas son días calendario, no instantes,
// y con hora local un ISO 'YYYY-MM-DD' se corre un día en husos negativos.
function partes(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (isNaN(d)) return null;
  return { anio: +m[1], mes: +m[2], dia: +m[3], dow: d.getUTCDay() };
}

function etiquetaMes(iso) {
  const p = partes(iso);
  return p ? `${p.anio}-${String(p.mes).padStart(2, '0')} ${MESES_ABR[p.mes - 1]}` : '';
}
function diaSemana(iso) {
  const p = partes(iso);
  return p ? DIAS_ABR[p.dow] : '';
}

// ── Normalización (trust boundary del server) ────────────────────────────────
function normalizarRegistro(r, i) {
  const src = r || {};
  const fecha = aISO(src.fecha);
  if (!fecha) throw new Error('El registro no tiene una fecha válida.');
  const persona = texto(src.persona);
  if (!persona) throw new Error(`El registro del ${fecha} no tiene persona.`);
  return {
    id:      texto(src.id) || `${fecha}|${persona}|${i || 0}`,
    fecha,
    fuente:  texto(src.fuente) || FUENTE_RELOJ,
    persona,
    hoja:    texto(src.hoja),
    legajo:  texto(src.legajo),
    destino: texto(src.destino),
    grupo:   texto(src.grupo) || GRUPO_DEFAULT,
    tipo:    texto(src.tipo) || SIN_CLASIFICAR,
    codigo:  texto(src.codigo),
    obs:     texto(src.obs),
    impId:   texto(src.impId),
  };
}

function normalizarRegistros(lista) {
  return (Array.isArray(lista) ? lista : []).map(normalizarRegistro);
}

// Dos registros son el mismo hecho si coinciden persona+fecha+tipo. Sirve para
// no duplicar cuando se reimporta una bajada que pisa días ya cargados.
function clave(r) {
  return [aISO((r || {}).fecha), texto((r || {}).persona).toLowerCase(), texto((r || {}).tipo).toLowerCase()].join('|');
}

// ── Parser 1: hoja "Detalle Ausencias" del resumen histórico ─────────────────
// Matriz = array de arrays (XLSX.utils.sheet_to_json con header:1).
function parsearDetalleHistorico(matriz) {
  const filas = Array.isArray(matriz) ? matriz : [];
  if (!filas.length) return [];
  const cab = (filas[0] || []).map(c => sinTildes(c).toLowerCase());
  const col = n => cab.indexOf(n);
  const iFecha = col('fecha');
  if (iFecha < 0) throw new Error('La hoja no tiene la columna "Fecha"; ¿es el resumen de ausencias?');
  const iFuente = col('fuente'), iPersona = col('persona'), iHoja = col('hoja');
  const iGrupo = col('grupo'), iTipo = col('tipo'), iObs = col('observacion');

  const out = [];
  for (let f = 1; f < filas.length; f++) {
    const r = filas[f] || [];
    const fecha = aISO(r[iFecha]);
    const persona = texto(iPersona >= 0 ? r[iPersona] : '');
    if (!fecha || !persona) continue;
    out.push(normalizarRegistro({
      fecha,
      fuente: iFuente >= 0 ? r[iFuente] : '',
      persona,
      hoja:   iHoja   >= 0 ? r[iHoja]   : '',
      grupo:  iGrupo  >= 0 ? r[iGrupo]  : '',
      tipo:   iTipo   >= 0 ? r[iTipo]   : '',
      obs:    iObs    >= 0 ? r[iObs]    : '',
      impId:  'historico',
    }, out.length));
  }
  return out;
}

// ── Parser 2: bajada del reloj de fichadas ──────────────────────────────────
// La planilla es una sábana ancha: fila 0 = un bloque por día ("1-AGO SÁBADO"),
// fila 1 = subcolumnas del bloque (Ausencia | Entrada | Salida | ...), filas
// 2+ = una por empleado. La ausencia del día vive en la subcolumna "Ausencia",
// y su contenido es un código del reloj ('ESC-5', 'VA5', 'Exam'...), no el tipo.

// 'Apidelta_Fichajes_182026a2682026' → 2026 (dd mm aaaa 'a' dd mm aaaa).
function anioDesdeNombre(nombre) {
  const s = sinTildes(nombre);
  const m = s.match(/(\d{1,2})(\d{1,2})(\d{4})a(\d{1,2})(\d{1,2})(\d{4})/);
  if (m) return +m[3];
  const y = s.match(/(20\d{2})/);
  return y ? +y[1] : null;
}

function indiceMes(abr) {
  const a = sinTildes(abr).toUpperCase().slice(0, 3);
  return MESES_ABR.findIndex(m => m.toUpperCase() === a);
}

// Localiza los bloques por día y, dentro de cada uno, la columna "Ausencia".
function bloquesDeDia(fila0, fila1, anioBase) {
  const inicios = [];
  for (let c = 0; c < fila0.length; c++) {
    const m = sinTildes(fila0[c]).match(/^(\d{1,2})\s*-\s*([A-Za-z]{3})/);
    if (m) inicios.push({ col: c, dia: +m[1], mes: indiceMes(m[2]) });
  }
  const bloques = [];
  let anio = anioBase, mesPrev = -1;
  for (let i = 0; i < inicios.length; i++) {
    const b = inicios[i];
    if (b.mes < 0) continue;
    // La planilla puede cruzar fin de año (DIC → ENE): cuando el mes retrocede, sube el año.
    if (mesPrev >= 0 && b.mes < mesPrev) anio++;
    mesPrev = b.mes;
    const fin = i + 1 < inicios.length ? inicios[i + 1].col : Math.max(fila1.length, b.col + 1);
    let colAus = -1;
    for (let c = b.col; c < fin; c++) {
      if (sinTildes(fila1[c]).toLowerCase() === 'ausencia') { colAus = c; break; }
    }
    if (colAus < 0) continue;
    bloques.push({
      colAus,
      fecha: `${anio}-${String(b.mes + 1).padStart(2, '0')}-${String(b.dia).padStart(2, '0')}`,
    });
  }
  return bloques;
}

// mapeo: { 'ESC-5': 'Licencia con Goce de Sueldo', ... }. Código sin mapear →
// tipo vacío: el registro igual se devuelve, pero listado en `sinMapear` para
// que el front obligue a clasificarlo antes de guardar. Mapeo a '' = ignorar.
function parsearFichajes(matriz, opts) {
  const o = opts || {};
  const filas = Array.isArray(matriz) ? matriz : [];
  if (filas.length < 3) throw new Error('La planilla de fichajes está vacía o no tiene el formato esperado.');
  const fila0 = filas[0] || [], fila1 = filas[1] || [];
  const anio = +o.anio || new Date().getFullYear();
  const bloques = bloquesDeDia(fila0, fila1, anio);
  if (!bloques.length) throw new Error('No se encontraron columnas de "Ausencia" por día; ¿es la bajada del reloj de fichadas?');

  const mapeo = o.mapeo && typeof o.mapeo === 'object' ? o.mapeo : {};
  const tieneMapeo = c => Object.prototype.hasOwnProperty.call(mapeo, c);
  const ignorados = {};
  const registros = [];
  const codigos = new Map();

  const cab1 = fila1.map(c => sinTildes(c).toLowerCase());
  const iLeg = Math.max(0, cab1.indexOf('legajo'));
  const iNom = cab1.indexOf('apellido y nombre') >= 0 ? cab1.indexOf('apellido y nombre') : 1;
  const iDes = cab1.indexOf('destino');

  for (let f = 2; f < filas.length; f++) {
    const r = filas[f] || [];
    const persona = texto(r[iNom]);
    if (!persona) continue;
    for (const b of bloques) {
      const codigo = texto(r[b.colAus]);
      if (!codigo) continue;
      const cnt = codigos.get(codigo) || { codigo, cantidad: 0 };
      cnt.cantidad++;
      codigos.set(codigo, cnt);
      const tipo = tieneMapeo(codigo) ? texto(mapeo[codigo]) : '';
      // Mapeo explícito a vacío = "no es una ausencia real", se descarta.
      if (tieneMapeo(codigo) && !tipo) { ignorados[codigo] = (ignorados[codigo] || 0) + 1; continue; }
      registros.push({
        id:      `${b.fecha}|${persona}|${codigo}`,
        fecha:   b.fecha,
        fuente:  FUENTE_RELOJ,
        persona,
        hoja:    '',
        legajo:  texto(r[iLeg]),
        destino: iDes >= 0 ? texto(r[iDes]) : '',
        grupo:   GRUPO_DEFAULT,
        tipo,
        codigo,
        obs:     '',
        impId:   '',
      });
    }
  }

  const fechas = bloques.map(b => b.fecha).sort();
  return {
    registros,
    codigos: [...codigos.values()].sort((a, b) => b.cantidad - a.cantidad || a.codigo.localeCompare(b.codigo, 'es')),
    sinMapear: [...codigos.keys()].filter(c => !tieneMapeo(c)).sort((a, b) => a.localeCompare(b, 'es')),
    ignorados,
    personas: new Set(registros.map(r => r.persona)).size,
    periodo: { desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || '' },
  };
}

// ── Agregaciones del dashboard ──────────────────────────────────────────────
function contarPor(registros, fn) {
  const m = new Map();
  for (const r of registros) {
    const k = fn(r);
    if (k === '' || k === null || k === undefined) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function ordenadoDesc(mapa) {
  return [...mapa.entries()]
    .map(([clave, cantidad]) => ({ clave, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad || a.clave.localeCompare(b.clave, 'es'));
}
function ordenadoAsc(mapa) {
  return [...mapa.entries()]
    .map(([clave, cantidad]) => ({ clave, cantidad }))
    .sort((a, b) => a.clave.localeCompare(b.clave, 'es'));
}

function filtrar(registros, f) {
  const flt = f || {};
  const desde = aISO(flt.desde), hasta = aISO(flt.hasta);
  const set = k => (Array.isArray(flt[k]) && flt[k].length ? new Set(flt[k]) : null);
  const fuentes = set('fuentes'), tipos = set('tipos'), personas = set('personas');
  const q = texto(flt.q).toLowerCase();
  return (Array.isArray(registros) ? registros : []).filter(r =>
    (!desde || r.fecha >= desde) &&
    (!hasta || r.fecha <= hasta) &&
    (!fuentes || fuentes.has(r.fuente)) &&
    (!tipos || tipos.has(r.tipo)) &&
    (!personas || personas.has(r.persona)) &&
    (!q || `${r.persona} ${r.tipo} ${r.obs} ${r.codigo}`.toLowerCase().includes(q))
  );
}

// Pivot persona × tipo: es la tabla "Por persona" del resumen original.
function porPersona(registros) {
  const tipos = ordenadoDesc(contarPor(registros, r => r.tipo)).map(t => t.clave);
  const m = new Map();
  for (const r of registros) {
    let p = m.get(r.persona);
    if (!p) { p = { persona: r.persona, fuente: r.fuente, total: 0, porTipo: {} }; m.set(r.persona, p); }
    p.total++;
    p.porTipo[r.tipo] = (p.porTipo[r.tipo] || 0) + 1;
  }
  return {
    tipos,
    filas: [...m.values()].sort((a, b) => b.total - a.total || a.persona.localeCompare(b.persona, 'es')),
  };
}

function resumen(registros) {
  const regs = Array.isArray(registros) ? registros : [];
  const porMes = ordenadoAsc(contarPor(regs, r => etiquetaMes(r.fecha)));
  const fechas = regs.map(r => r.fecha).filter(Boolean).sort();
  const dow = contarPor(regs, r => diaSemana(r.fecha));
  return {
    total: regs.length,
    personas: new Set(regs.map(r => r.persona)).size,
    meses: porMes.length,
    promedioMes: porMes.length ? +(regs.length / porMes.length).toFixed(1) : 0,
    periodo: { desde: fechas[0] || '', hasta: fechas[fechas.length - 1] || '' },
    porFuente: ordenadoDesc(contarPor(regs, r => r.fuente)),
    porTipo:   ordenadoDesc(contarPor(regs, r => r.tipo)),
    porGrupo:  ordenadoDesc(contarPor(regs, r => r.grupo)),
    porMes,
    // Lun→Dom, no alfabético: el orden natural de la semana es el que se lee.
    porDiaSem: DIAS_SEMANA_ORDEN.map(d => ({ clave: d, cantidad: dow.get(d) || 0 })),
    porPersona: porPersona(regs),
  };
}

return {
  MESES_ABR, DIAS_ABR, DIAS_SEMANA_ORDEN, GRUPO_DEFAULT, FUENTE_RELOJ, SIN_CLASIFICAR,
  texto, sinTildes, aISO, etiquetaMes, diaSemana,
  normalizarRegistro, normalizarRegistros, clave,
  parsearDetalleHistorico, parsearFichajes, anioDesdeNombre, bloquesDeDia,
  filtrar, resumen, porPersona,
};

});
