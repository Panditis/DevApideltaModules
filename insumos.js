'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  insumos.js — control de insumos de Casa Central.
//
//  Qué se consume por mes y cuánto dura el stock que hay, leído de los
//  movimientos de stock: en SIGA la Cantidad de MovimientosStockProductos ya
//  viene firmada (negativa = salió del depósito) y la suma de todas las líneas
//  de un depósito es exactamente su stock actual. El consumo de un insumo es,
//  entonces, la suma de sus líneas negativas mes a mes.
//
//  Todo acá es puro: no lee disco, no consulta SQL y no mira el reloj. El mes de
//  referencia se inyecta, para que los tests sean deterministas.
// ─────────────────────────────────────────────────────────────────────────────

const { proyectar, redondear, mesesDeVentana } = require('./prediccion_consumo');

// Ventana de análisis. 24 meses permiten comparar contra el mes homólogo del año
// anterior, que es lo que necesita el factor estacional de prediccion_consumo.
const VENTANA_MESES = 24;

// El "por mes" del dashboard. No son los días del mes en curso: es la unidad en
// la que se habla de consumo (μ diario × 30), estable entre febrero y julio.
const DIAS_MES = 30;

// Tipos de movimiento cuyas salidas NO son consumo:
//   COMPRA / COMPRA-NC → reposición y su nota de crédito.
//   AJUSTE / AJUSTE-NC → corrección de inventario contra la realidad.
// Un ajuste contado como consumo mete un pico que no se va a repetir nunca y
// arrastra detrás suyo el promedio y la compra sugerida. Caso real: los guantes
// medianos tienen 1925 unidades de salida por AJUSTE contra ~30 por mes de
// consumo real; sin esta exclusión el insumo pasa a "dura 1 día".
const TIPOS_NO_CONSUMO = ['COMPRA', 'COMPRA-NC', 'AJUSTE', 'AJUSTE-NC'];

// Cobertura en días: por debajo de crítico hay que comprar hoy, por encima de
// exceso hay capital dormido en el depósito.
const UMBRALES = { criticoDias: 15, bajoDias: 30, excesoDias: 180 };

// Qué es un insumo: lo dice el nombre, no el rubro. El rubro "Insumos" de Siga
// no sirve como criterio — se le cargaron etiquetas, envases y tapas, que son
// materiales de producto terminado, y al mismo tiempo deja afuera bolsas de
// fraccionado (Embalajes), estampillas (ADMINISTRACION) y bobinas (Bobinas) que
// sí se compran y consumen como insumos. La convención que usa la gente al dar
// de alta el producto es "Insumo …", y esa es la definición del módulo.
// rubros queda vacío a propósito: config.json puede sumar alguno si hace falta.
const RUBROS = [];
const PREFIJO_NOMBRE = 'INSUMO';  // el nombre ARRANCA con esto, no lo menciona al pasar

// Predicado SQL "esto es un insumo", para que las queries de stock y de
// movimientos no puedan discrepar entre sí. alias: el de la tabla Productos.
// rubros son números y el prefijo sale de config.json, no de la request; se
// filtra y escapa igual, porque un día alguien lo va a atar a un input.
function condicionSQL({ rubros = RUBROS, prefijoNombre = PREFIJO_NOMBRE, alias = 'p' } = {}) {
  const a = /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(alias)) ? alias : 'p';
  // Enteros positivos y nada más: Number(null) es 0 y pasaría el isFinite pelado,
  // metiendo un rubro 0 que no existe en el IN.
  const ids = (rubros || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
  const cond = [];
  if (ids.length) cond.push(`${a}.IdRubro IN (${ids.join(',')})`);
  const pref = String(prefijoNombre || '').toUpperCase().replace(/'/g, "''").replace(/[%_[\]]/g, '');
  if (pref) cond.push(`UPPER(LTRIM(${a}.NombreProducto)) LIKE '${pref}%'`);
  // Sin criterios no se filtra nada: devolver "1=0" vaciaría el módulo en silencio
  // y "1=1" traería el catálogo entero. Que falle fuerte y se vea.
  if (!cond.length) throw new Error('insumos: hay que definir rubros o prefijoNombre');
  return cond.length > 1 ? `(${cond.join(' OR ')})` : cond[0];
}

const ESTADO = {
  SIN_STOCK:   'SIN_STOCK',    // se consume y no queda nada
  CRITICO:     'CRITICO',
  BAJO:        'BAJO',
  OK:          'OK',
  EXCESO:      'EXCESO',
  SIN_CONSUMO: 'SIN_CONSUMO',  // sin salidas en la ventana: no se puede estimar duración
};

const RE_MES = /^\d{4}-\d{2}$/;

function esTipoConsumo(tipo, excluidos) {
  const lista = Array.isArray(excluidos) ? excluidos : TIPOS_NO_CONSUMO;
  return !lista.includes(String(tipo || '').toUpperCase());
}

// filas: [{ plu, mes, tipo, salidas, entradas }] agregadas en SQL por plu+mes+tipo.
// Devuelve { [plu]: { 'YYYY-MM': salidaDelMes } } con sólo los tipos de consumo.
function serieMensual(filas, excluidos) {
  const out = {};
  for (const f of (filas || [])) {
    const plu = String(f && f.plu != null ? f.plu : '').trim();
    const mes = String((f && f.mes) || '');
    if (!plu || !RE_MES.test(mes)) continue;
    if (!esTipoConsumo(f.tipo, excluidos)) continue;
    const salida = Number(f.salidas) || 0;
    if (salida <= 0) continue;
    if (!out[plu]) out[plu] = {};
    out[plu][mes] = redondear((out[plu][mes] || 0) + salida);
  }
  return out;
}

// Desglose por tipo de movimiento de un solo insumo, para la vista de detalle:
// [{ tipo, salidas, entradas, esConsumo }] ordenado por salidas desc.
function desglosePorTipo(filas, excluidos) {
  const acc = new Map();
  for (const f of (filas || [])) {
    const tipo = String((f && f.tipo) || '').toUpperCase();
    if (!tipo) continue;
    const prev = acc.get(tipo) || { tipo, salidas: 0, entradas: 0, esConsumo: esTipoConsumo(tipo, excluidos) };
    prev.salidas  = redondear(prev.salidas  + (Number(f.salidas)  || 0));
    prev.entradas = redondear(prev.entradas + (Number(f.entradas) || 0));
    acc.set(tipo, prev);
  }
  return [...acc.values()].sort((a, b) => b.salidas - a.salidas);
}

// Estado de cobertura. El orden de los cortes importa: un insumo que se consume
// y quedó en cero es SIN_STOCK aunque su cobertura sea 0 días (que también es
// crítica), porque no es lo mismo "comprar ya" que "ya faltó".
function clasificar({ stock = 0, muDiario = 0, diasCobertura = null } = {}, umbrales = UMBRALES) {
  const u = { ...UMBRALES, ...(umbrales || {}) };
  if (!(Number(muDiario) > 0)) return ESTADO.SIN_CONSUMO;
  if (!(Number(stock) > 0))    return ESTADO.SIN_STOCK;
  const dias = Number(diasCobertura);
  if (!Number.isFinite(dias))  return ESTADO.SIN_CONSUMO;
  if (dias < u.criticoDias)    return ESTADO.CRITICO;
  if (dias < u.bajoDias)       return ESTADO.BAJO;
  if (dias > u.excesoDias)     return ESTADO.EXCESO;
  return ESTADO.OK;
}

// Cuántos de los meses de la ventana tuvieron salida, y cuál fue el último.
// Un insumo con un solo mes movido en dos años no tiene un promedio confiable:
// el dashboard lo marca para que nadie compre contra un dato de una sola vez.
function actividad(serie, mesActual, ventanaMeses = VENTANA_MESES) {
  const s = serie || {};
  const meses = mesesDeVentana(mesActual, ventanaMeses);
  let conConsumo = 0, ultimo = null;
  for (const m of meses) {
    if ((Number(s[m]) || 0) > 0) { conConsumo++; ultimo = m; }
  }
  return { mesesConConsumo: conConsumo, mesesVentana: meses.length, ultimoMesConConsumo: ultimo };
}

// Una fila del dashboard: stock de Casa Central + consumo estimado + duración.
//   consumoMensual → μ diario × 30 × estacionalidad (lo que se espera consumir).
//   promedioMensual → el promedio pelado de la ventana, para contrastar a ojo.
//   diasCobertura → stock ÷ μ diario. null si no hay consumo con qué dividir.
function resumenInsumo({ plu, nombre, rubro = null, stock = 0,
                         serie = {}, mesActual, ventanaMeses = VENTANA_MESES,
                         umbrales = UMBRALES } = {}) {
  const st = Number(stock) || 0;
  const s = serie || {};
  const p = proyectar(s, { mesActual, dias: DIAS_MES, ventanaMeses });
  const act = actividad(s, mesActual, ventanaMeses);
  const meses = mesesDeVentana(mesActual, ventanaMeses);
  const totalVentana = meses.reduce((acc, m) => acc + (Number(s[m]) || 0), 0);
  const promedioMensual = meses.length ? redondear(totalVentana / meses.length) : 0;
  // El stock de Siga puede quedar en negativo (entregas cargadas antes que la
  // compra). Para la cobertura vale cero: no hay unidades que duren, y un número
  // negativo de días ordenaría la tabla de cualquier manera.
  const diasCobertura = p.muDiario > 0 ? redondear(Math.max(st, 0) / p.muDiario) : null;
  const estado = clasificar({ stock: st, muDiario: p.muDiario, diasCobertura }, umbrales);
  return {
    plu: String(plu),
    nombre: nombre || '',
    rubro,
    stock: redondear(st),
    consumoMensual: redondear(p.proyeccion),
    promedioMensual,
    muDiario: p.muDiario,
    sigmaDiario: p.sigmaDiario,
    estacional: p.estacional,
    totalVentana: redondear(totalVentana),
    diasCobertura,
    mesesCobertura: diasCobertura == null ? null : redondear(diasCobertura / DIAS_MES),
    estado,
    ...act,
  };
}

// ── Stock mínimo y máximo (reposición manual) ───────────────────────────────────
// El mínimo es el punto de pedido y el máximo el nivel al que se repone. Los pone
// una persona, insumo por insumo: son el criterio de quien compra, no una cuenta.

// Un nivel válido o null. Guardar basura acá se paga después: un máximo menor que
// el mínimo pide compras negativas y un mínimo sin máximo no sabe cuánto pedir.
function normalizarNivel({ min, max } = {}) {
  const n = v => (v === '' || v == null ? null : Number(v));
  const mn = n(min), mx = n(max);
  if (mn == null && mx == null) return null;                      // sin niveles: se borra
  if (mn == null || mx == null) throw new Error('mínimo y máximo van juntos');
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) throw new Error('mínimo y máximo tienen que ser números');
  if (mn < 0 || mx < 0) throw new Error('mínimo y máximo no pueden ser negativos');
  if (mx < mn) throw new Error('el máximo no puede ser menor que el mínimo');
  return { min: redondear(mn), max: redondear(mx) };
}

// Cuánto comprar: nada hasta tocar el mínimo, y ahí lo que falta para el máximo.
// Tocar el mínimo cuenta como haber llegado (es el punto de pedido, no el piso).
// Con stock negativo la diferencia sale más grande, y está bien: hay que reponer
// lo que falta y además cubrir el rojo.
function sugerirCompra({ stock = 0, nivel = null } = {}) {
  if (!nivel) return 0;
  const st = Number(stock) || 0;
  if (st > nivel.min) return 0;
  return redondear(Math.max(nivel.max - st, 0));
}

// Pega los niveles guardados sobre las filas ya calculadas.
// niveles: { [plu]: { min, max } }
function aplicarNiveles(filas, niveles = {}) {
  const n = niveles || {};
  return (filas || []).map(f => {
    const nivel = n[String(f.plu)] || null;
    const aComprar = sugerirCompra({ stock: f.stock, nivel });
    return { ...f,
      min: nivel ? nivel.min : null,
      max: nivel ? nivel.max : null,
      aComprar,
      pideCompra: aComprar > 0 };
  });
}

// Urgencia: primero lo que se va a romper antes. Los que no tienen consumo no
// compiten por la cabeza de la lista (no hay urgencia que medir), van al final.
const PESO_ESTADO = {
  [ESTADO.SIN_STOCK]: 0, [ESTADO.CRITICO]: 1, [ESTADO.BAJO]: 2,
  [ESTADO.OK]: 3, [ESTADO.EXCESO]: 4, [ESTADO.SIN_CONSUMO]: 5,
};

function ordenarPorUrgencia(filas) {
  return [...(filas || [])].sort((a, b) => {
    const pa = PESO_ESTADO[a.estado] ?? 9, pb = PESO_ESTADO[b.estado] ?? 9;
    if (pa !== pb) return pa - pb;
    const da = a.diasCobertura == null ? Infinity : a.diasCobertura;
    const db = b.diasCobertura == null ? Infinity : b.diasCobertura;
    if (da !== db) return da - db;
    // Empate en cobertura (todos los sin stock dan 0): primero el que más se gasta.
    const ca = Number(a.consumoMensual) || 0, cb = Number(b.consumoMensual) || 0;
    if (ca !== cb) return cb - ca;
    return String(a.nombre).localeCompare(String(b.nombre));
  });
}

// productos: [{ plu, nombre, rubro, stock }] · filasMov: las de serieMensual().
function calcularListado({ productos = [], filasMov = [], mesActual,
                           ventanaMeses = VENTANA_MESES, umbrales = UMBRALES,
                           tiposExcluidos = TIPOS_NO_CONSUMO, niveles = {} } = {}) {
  const series = serieMensual(filasMov, tiposExcluidos);
  const filas = (productos || []).map(p => resumenInsumo({
    plu: p.plu, nombre: p.nombre, rubro: p.rubro, stock: p.stock,
    serie: series[String(p.plu)] || {}, mesActual, ventanaMeses, umbrales,
  }));
  return ordenarPorUrgencia(aplicarNiveles(filas, niveles));
}

// Contadores para las tarjetas de arriba del dashboard.
function totales(filas) {
  const out = { total: 0, consumoMensual: 0, stockCero: 0, pideCompra: 0, aComprar: 0, conNiveles: 0 };
  for (const k of Object.keys(ESTADO)) out[ESTADO[k]] = 0;
  for (const f of (filas || [])) {
    out.total++;
    out[f.estado] = (out[f.estado] || 0) + 1;
    out.consumoMensual = redondear(out.consumoMensual + (Number(f.consumoMensual) || 0));
    if (!(Number(f.stock) > 0)) out.stockCero++;
    if (f.min != null) out.conNiveles++;
    if (f.pideCompra) { out.pideCompra++; out.aComprar = redondear(out.aComprar + (Number(f.aComprar) || 0)); }
  }
  return out;
}

module.exports = {
  VENTANA_MESES, DIAS_MES, TIPOS_NO_CONSUMO, UMBRALES, ESTADO,
  RUBROS, PREFIJO_NOMBRE, condicionSQL,
  esTipoConsumo, serieMensual, desglosePorTipo, clasificar, actividad,
  normalizarNivel, sugerirCompra, aplicarNiveles,
  resumenInsumo, ordenarPorUrgencia, calcularListado, totales,
};
