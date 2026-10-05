'use strict';
// Migración única bandas/matriz → curva de ganancia (spec 2026-10-02-precios-costo-neto-iva-curva, Parte B).
// Pura (sin fs): costeoConCurva(costeo) devuelve el mismo objeto si ya tiene metodoGanancia 'curva'; si no, uno
// nuevo con curvaGanancia { almacen, fraccionado, produccion } (siempre activas, sobre costo NETO), sin
// bandasMarkup ni markupFraccionado, y con el marcador. La ruta la aplica al leer costeo.json y la persiste
// una vez al arrancar (backup costeo.json.bak-antes-curva).
//
// Las bandas y la matriz tenían topes en costo CON IVA (costo neto × 1,21; todas las alícuotas reales son 21 %):
// se muestrea cada banda en MUESTRAS_POR_BANDA costos en escala log dentro de [tope anterior (o tope/10 en la
// primera), tope] (última "sin tope" hasta 2× su inicio), se pasa cada costo a neto (÷ 1,21) y se ajusta
// g = a − b·ln(c) por mínimos cuadrados; piso/techo = mín/máx de las ganancias. Una curva vieja activa se usa
// tal cual pasada a base neta: a' = a − b·ln(1,21).
const { CURVA_GANANCIA_DEFAULT, gananciaBaseCurva, mediana } = require('./precios_costeo');

const METODO_GANANCIA_CURVA = 'curva';
const FACTOR_IVA_MIGRACION = 1.21;
const MUESTRAS_POR_BANDA = 10;
const AJUSTE_PESO_RANGO = [-100, 100];

// Matriz Fraccionado que se usaba si costeo.json no traía markupFraccionado (sólo para migrar esa instalación).
const MARKUP_FRACCIONADO_LEGADO = Object.freeze({
  bandas: [9999, 19999, null],
  tramosG: [100, 200, 400, 500, 1000, 5000, 10000],
  markupPct: [[84.35, 76.33, 68.32, 68.32, 60.3, 53.89, 50.68],
              [87.33, 78.82, 73.71, 73.71, 70.3, 63.49, 60.08],
              [73.57, 70.26, 66.95, 66.95, 65.3, 58.69, 55.38]],
});

const r4 = n => Math.round(n * 1e4) / 1e4;
const esNumero = v => typeof v === 'number' && Number.isFinite(v);

// Rango [desde, hasta] (costo con IVA) de cada tope de una lista ascendente con null = sin tope al final.
function rangosDeTopes(topes) {
  return topes.map((tope, i) => {
    const anterior = i > 0 ? topes[i - 1] : null;
    const desde = anterior != null ? anterior : tope != null ? tope / 10 : 1000;
    return [desde, tope != null ? tope : 2 * desde];
  });
}

// n costos en escala log en el centro de n tramos iguales de [desde, hasta] (sin tocar los bordes, que comparten
// dos bandas), pasados a neto.
function muestrasNetas([desde, hasta], n = MUESTRAS_POR_BANDA) {
  const l0 = Math.log(desde), l1 = Math.log(hasta);
  return Array.from({ length: n }, (_, i) => Math.exp(l0 + (l1 - l0) * (i + 0.5) / n) / FACTOR_IVA_MIGRACION);
}

// Mínimos cuadrados g = a − b·ln(c) sobre [{ costo, ganancia }]; piso/techo = mín/máx de las ganancias.
function curvaPorMinimosCuadrados(puntos) {
  const xs = puntos.map(p => Math.log(p.costo)), gs = puntos.map(p => p.ganancia);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, mg = gs.reduce((s, g) => s + g, 0) / gs.length;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const pend = sxx > 0 ? xs.reduce((s, x, i) => s + (x - mx) * (gs[i] - mg), 0) / sxx : 0;
  return { a: r4(mg - pend * mx), b: r4(-pend) || 0, pisoPct: r4(Math.min(...gs)), techoPct: r4(Math.max(...gs)) };
}

const curvaPlana = g => ({ a: r4(g), b: 0, pisoPct: r4(g), techoPct: r4(g) });
const bandasValidas = lista => (Array.isArray(lista) ? lista : [])
  .filter(b => b && esNumero(b.markupMaxPct) && (b.costoHastaARS === null || esNumero(b.costoHastaARS)));

// Bandas [{ costoHastaARS, markupMaxPct }] → { a, b, pisoPct, techoPct } en base neta, o null sin bandas.
function curvaDesdeBandas(bandas) {
  const lista = bandasValidas(bandas);
  if (!lista.length) return null;
  const rangos = rangosDeTopes(lista.map(b => b.costoHastaARS));
  const puntos = lista.flatMap((b, i) => muestrasNetas(rangos[i]).map(costo => ({ costo, ganancia: b.markupMaxPct })));
  return curvaPorMinimosCuadrados(puntos);
}

// Curva vieja (base con IVA) → base neta, sin `activa`: a' = a − b·ln(1,21).
function curvaANeta(c) {
  const { activa: _sinUso, ...resto } = c;
  return { ...resto, a: r4(c.a - c.b * Math.log(FACTOR_IVA_MIGRACION)) };
}
const curvaActiva = c => !!c && c.activa === true && [c.a, c.b, c.pisoPct, c.techoPct].every(esNumero);

// Matriz { bandas, tramosG, markupPct[fila][col] } → curva por costo (media de columnas de cada fila) +
// ajustesPeso = residuo medio de cada columna contra la curva (1 decimal, ±100).
function curvaDesdeMatriz(m) {
  const ok = m && Array.isArray(m.bandas) && m.bandas.length && Array.isArray(m.tramosG) && m.tramosG.length
    && Array.isArray(m.markupPct) && m.markupPct.length === m.bandas.length;
  if (!ok) return null;
  const rangos = rangosDeTopes(m.bandas);
  const media = fila => fila.reduce((s, v) => s + v, 0) / fila.length;
  const muestras = m.bandas.flatMap((_, i) => muestrasNetas(rangos[i]).map(costo => ({ costo, fila: m.markupPct[i] })));
  const curva = curvaPorMinimosCuadrados(muestras.map(p => ({ costo: p.costo, ganancia: media(p.fila) })));
  const [min, max] = AJUSTE_PESO_RANGO;
  const puntos = m.tramosG.map((_, j) => {
    const residuo = muestras.reduce((s, p) => s + (p.fila[j] - gananciaBaseCurva(curva, p.costo)), 0) / muestras.length;
    return Math.min(max, Math.max(min, Math.round(residuo * 10) / 10)) || 0; // || 0: sin −0
  });
  return { ...curva, ajustesPeso: { tramosG: [...m.tramosG], puntos } };
}

const conMeta = c => ({ ajustadaEl: null, n: null, ...c });

// Las tres curvas migradas desde la config vieja (ver encabezado). Producción sin bandas → plana con la mediana
// de las ganancias de las bandas de Reventa (0 si tampoco hay).
function curvasMigradas(costeo) {
  const bm = costeo.bandasMarkup || {};
  const cg = costeo.curvaGanancia || {};
  const almacen = curvaActiva(cg.almacen) ? curvaANeta(cg.almacen)
    : curvaDesdeBandas(bm.almacen) || { ...CURVA_GANANCIA_DEFAULT.almacen };
  const gananciasReventa = bandasValidas(bm.almacen).map(b => b.markupMaxPct);
  const produccion = curvaDesdeBandas(bm.produccion) || curvaPlana(gananciasReventa.length ? mediana(gananciasReventa) : 0);
  const fraccionado = curvaActiva(cg.fraccionado) ? { ajustesPeso: null, ...curvaANeta(cg.fraccionado) }
    : curvaDesdeMatriz(costeo.markupFraccionado || MARKUP_FRACCIONADO_LEGADO) || { ...CURVA_GANANCIA_DEFAULT.fraccionado };
  return { almacen: conMeta(almacen), fraccionado: conMeta(fraccionado), produccion: conMeta(produccion) };
}

// Idempotente: con el marcador devuelve el mismo objeto. Copia nueva, no muta.
function costeoConCurva(costeo) {
  const c = costeo && typeof costeo === 'object' ? costeo : {};
  if (c.metodoGanancia === METODO_GANANCIA_CURVA) return c;
  const { bandasMarkup: _b, markupFraccionado: _m, ...resto } = c;
  return { ...resto, curvaGanancia: curvasMigradas(c), metodoGanancia: METODO_GANANCIA_CURVA };
}

module.exports = { costeoConCurva, curvaDesdeBandas, curvaDesdeMatriz, curvaANeta, METODO_GANANCIA_CURVA, MARKUP_FRACCIONADO_LEGADO };
