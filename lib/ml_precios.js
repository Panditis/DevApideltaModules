'use strict';
// ── Control de precios Mercado Libre (spec 2026-11-10-control-precios-ml) ──────
// Lógica pura: parseo de la bajada de ML, precio esperado, estado y KPIs. Sin I/O ni SQL.
// El cálculo de margen y gastos es el de lib/precios_esquema.js (no se reescribe).
//
// IVA: la carta (ProductosSucursalesPrecios, lista 0) es el precio de mostrador CON IVA (ver
// lib/precios_listado_esquema.js "la lista minorista de SIGA va con IVA" y docs/modulo_precios_plan.md),
// igual que PRICE de ML. Por eso el esperado NO multiplica por (1 + iva/100). Sin verificar contra SQL.
const XLSX = require('xlsx');
const { r2, redondearMultiplo, costoConGastos, margenDe, validarTablaMargen } = require('./precios_esquema');

class ErrorBajada extends Error {}

const HOJA = 'Publicaciones';
const FILA_DATOS = 5; // índice 0-based: fila 6 de la hoja (las 5 primeras son headers/ayuda)
const MAX_FILAS = 20000;
const FIRMA_ZIP = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
const CUOTAS = ['no', 'agregar', 'interes_bajo'];

const CONFIG_DEFAULT = Object.freeze({
  comisionPct: 14.8, // valor inicial: data/comisiones_mercadolibre.json (Buenos Aires / Alimentos y Bebidas)
  envioGratisPct: 0,
  cuotasPct: { no: 0, agregar: 0, interes_bajo: 0 },
  toleranciaPct: 2,
  redondeoPaso: 0,
  tablaMargen: { minPct: 20, maxPct: 40, escalones: 5, rango: { desde: 1000, hasta: 100000 } },
});

const texto = v => String(v ?? '').trim();
const numero = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function envioDe(v) {
  const s = texto(v);
  if (s === 'Mercado Envíos gratis') return 'gratis';
  if (s === 'Mercado Envíos a cargo del comprador') return 'comprador';
  if (s === 'No realizo envíos') return 'sin';
  return 'nd';
}

function cuotasDe(v) {
  const s = texto(v);
  if (s === 'Agregar cuotas') return 'agregar';
  if (/inter[eé]s bajo/i.test(s)) return 'interes_bajo';
  return 'no';
}

// Bajada de publicaciones de ML (xlsx) → publicaciones padre. Las variantes (VARIATION_ID con valor) se cuentan y se
// ignoran; dedup por ITEM_ID, gana la última.
function parsearBajada(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 4).equals(FIRMA_ZIP)) throw new ErrorBajada('El archivo tiene que ser el .xlsx de publicaciones de Mercado Libre.');
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', sheetRows: MAX_FILAS + 1, cellNF: false, cellText: false });
  } catch (_err) {
    throw new ErrorBajada('No pude leer el xlsx.');
  }
  const hoja = wb.Sheets[HOJA];
  if (!hoja) throw new ErrorBajada(`El xlsx no tiene la hoja "${HOJA}".`);
  const filas = XLSX.utils.sheet_to_json(hoja, { header: 1, raw: true, defval: '' });
  if (filas.length > MAX_FILAS) throw new ErrorBajada('La hoja es demasiado grande para ser una bajada de ML.');
  const header = (filas[0] || []).map(texto);
  const col = nombre => header.indexOf(nombre);
  const c = {
    id: col('ITEM_ID'), variante: col('VARIATION_ID'), titulo: col('TITLE'), stock: col('QUANTITY'), precio: col('PRICE'),
    promo: col('SALE_PRICE'), iva: col('VALUE_ADDED_TAX'), envio: col('SHIPPING_METHOD'), estado: col('STATUS'), cuotas: col('LISTING_TYPE_V3'),
  };
  const faltan = ['id', 'variante', 'titulo', 'precio'].filter(k => c[k] < 0);
  if (faltan.length) throw new ErrorBajada('El xlsx no tiene las columnas de la bajada de ML (ITEM_ID, VARIATION_ID, TITLE, PRICE).');

  const porId = new Map();
  let total = 0;
  let variantesIgnoradas = 0;
  for (const f of filas.slice(FILA_DATOS)) {
    const id = texto(f[c.id]);
    if (!id) continue;
    total++;
    if (texto(f[c.variante])) { variantesIgnoradas++; continue; }
    const promo = numero(f[c.promo]);
    porId.set(id, {
      id,
      titulo: texto(f[c.titulo]),
      precio: numero(f[c.precio]),
      precioPromo: promo > 0 ? promo : null,
      envio: envioDe(f[c.envio]),
      activa: texto(f[c.estado]) === 'Activa',
      cuotas: cuotasDe(f[c.cuotas]),
      stock: Number(f[c.stock]) || 0,
      iva: parseFloat(texto(f[c.iva])) || 0,
    });
  }
  return { total, variantesIgnoradas, publicaciones: [...porId.values()] };
}

// Precio con el que se compara: la promo si hay, si no el precio de lista. null si no hay precio > 0.
function precioMlDe(pub) {
  const p = pub.precioPromo ?? pub.precio;
  return p > 0 ? p : null;
}

// esperado = costoConGastos(base × (1 + margen), gastos, 'precio') redondeado. esperado null si los gastos llegan al 100 %.
function precioEsperado(carta, unidades, envio, cuotas, cfg) {
  const base = r2(carta * unidades);
  const margenPct = margenDe(cfg.tablaMargen, base);
  const gastosPct = r2(cfg.comisionPct + (envio === 'gratis' ? cfg.envioGratisPct : 0) + (cfg.cuotasPct[cuotas] || 0));
  const conMargen = r2(base * (1 + margenPct / 100));
  const exacto = costoConGastos(conMargen, gastosPct, 'precio');
  return { base, margenPct, gastosPct, esperado: exacto == null ? null : redondearMultiplo(exacto, cfg.redondeoPaso) };
}

// Estado de control de una publicación. desvioPct a 2 decimales (así el borde de la tolerancia no depende del float).
function estadoDe({ vinculado, carta, precioMl, esperado, toleranciaPct }) {
  if (!vinculado) return { estado: 'sin_vincular', desvioPct: null };
  if (!(precioMl > 0)) return { estado: 'sin_precio', desvioPct: null };
  if (!(carta > 0)) return { estado: 'sin_carta', desvioPct: null };
  if (!(esperado > 0)) return { estado: 'sin_margen', desvioPct: null };
  const desvioPct = r2((precioMl - esperado) / esperado * 100);
  return { estado: Math.abs(desvioPct) <= toleranciaPct ? 'ok' : 'desviada', desvioPct };
}

function kpis(filas) {
  const k = { activas: 0, inactivas: 0, ok: 0, desviadas: 0, sinVincular: 0, sinCarta: 0, sinMargen: 0, sinPrecio: 0 };
  const clave = { ok: 'ok', desviada: 'desviadas', sin_vincular: 'sinVincular', sin_carta: 'sinCarta', sin_margen: 'sinMargen', sin_precio: 'sinPrecio' };
  for (const f of filas) {
    k[f.activa ? 'activas' : 'inactivas']++;
    k[clave[f.estado]]++;
  }
  return k;
}

// Una fila de la tabla: publicación + vínculo + carta en vivo (cartas: Map String(código) → { precio, nombre }).
function armarFila(pub, vinculo, cartas, cfg) {
  const precioMl = precioMlDe(pub);
  const info = vinculo ? cartas.get(String(vinculo.codigo)) : null;
  const carta = info && info.precio > 0 ? info.precio : null;
  const calc = vinculo && carta ? precioEsperado(carta, vinculo.unidades, pub.envio, pub.cuotas, cfg) : null;
  const { estado, desvioPct } = estadoDe({ vinculado: !!vinculo, carta, precioMl, esperado: calc && calc.esperado, toleranciaPct: cfg.toleranciaPct });
  return {
    id: pub.id, titulo: pub.titulo, activa: pub.activa, envio: pub.envio, cuotas: pub.cuotas, stock: pub.stock,
    precioLista: pub.precio, precioPromo: pub.precioPromo, precioMl,
    codigo: vinculo ? vinculo.codigo : null, unidades: vinculo ? vinculo.unidades : null, nombreProducto: info ? info.nombre : null,
    carta, base: calc ? calc.base : null, margenPct: calc ? calc.margenPct : null, gastosPct: calc ? calc.gastosPct : null,
    esperado: calc ? calc.esperado : null, desvioPct, estado,
  };
}

// Config del PUT: devuelve un mensaje de error o null.
function validarConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return 'Falta la configuración';
  const pct = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100;
  for (const k of ['comisionPct', 'envioGratisPct', 'toleranciaPct']) if (!pct(cfg[k])) return `${k} debe ser un número ≥ 0 y < 100`;
  if (!cfg.cuotasPct || CUOTAS.some(k => !pct(cfg.cuotasPct[k]))) return 'cuotasPct debe traer no, agregar e interes_bajo, cada uno ≥ 0 y < 100';
  const maxGastos = cfg.comisionPct + cfg.envioGratisPct + Math.max(...CUOTAS.map(k => cfg.cuotasPct[k]));
  if (maxGastos >= 100) return 'Comisión + envío + cuotas no puede llegar al 100 %';
  if (typeof cfg.redondeoPaso !== 'number' || !Number.isFinite(cfg.redondeoPaso) || cfg.redondeoPaso < 0) return 'redondeoPaso debe ser un número ≥ 0';
  return validarTablaMargen(cfg.tablaMargen);
}

module.exports = { ErrorBajada, CONFIG_DEFAULT, CUOTAS, parsearBajada, precioMlDe, precioEsperado, estadoDe, kpis, armarFila, validarConfig };
