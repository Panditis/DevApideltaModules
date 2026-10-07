// ── Precios · Esquema por canal de venta (spec 2026-10-07-precios-esquema-canales-design) ──
// Motor puro, sin I/O. Cadena: costo de mercadería (neto) → gastos variables del tipo → margen escalonado del canal
// → (minorista) extras → IVA → redondeo por lista. UMD: require en el server, <script> en el navegador
// (global PreciosEsquema), así hay un solo cálculo para listados, modal, export y simulador.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PreciosEsquema = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Sin esto, costo × pct / 100 deja ruido de punto flotante (ej 24.999750000000002) que no debe llegar a la UI.
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

  // Múltiplo de `paso` más cercano; paso 0 (o inválido) = sin redondeo comercial, 2 decimales.
  function redondearMultiplo(n, paso) {
    return paso > 0 ? Math.round(n / paso) * paso : r2(n);
  }

  // "Alineado exacto": si el exacto reproduce el vigente de SIGA (±$0,50) se respeta el vigente en vez del múltiplo.
  const TOLERANCIA_ALINEADO = 0.5;
  function alinear(exacto, vigente, paso) {
    if (vigente > 0 && Math.abs(exacto - vigente) < TOLERANCIA_ALINEADO) return vigente;
    return redondearMultiplo(exacto, paso);
  }

  // Σ pct de los ítems (gastos variables o extras minoristas) tildados para el tipo de producto.
  function pctItems(items, tipo) {
    return r2((items || []).reduce((s, it) => s + (it && it.tipos && it.tipos[tipo] === true ? Number(it.pct) || 0 : 0), 0));
  }

  // Modo 'costo' (default): markup sobre el costo. Modo 'precio': los gastos son % del precio (divisor); null si
  // los gastos llegan al 100 % (no hay precio posible).
  function costoConGastos(costo, gastosPct, modo) {
    if (modo === 'precio') return gastosPct >= 100 ? null : r2(costo / (1 - gastosPct / 100));
    return r2(costo * (1 + gastosPct / 100));
  }

  // Límites de una tabla de margen (los mismos que validan la Configuración).
  const MARGEN_RANGO_PCT = [-50, 300];
  const ESCALONES_RANGO = [1, 30];
  const esNum = v => typeof v === 'number' && Number.isFinite(v);

  function validarTablaMargen(t) {
    if (!t || typeof t !== 'object') return 'Falta la tabla de margen';
    const [lo, hi] = MARGEN_RANGO_PCT;
    if (!esNum(t.minPct) || t.minPct < lo || t.minPct > hi) return `El margen mínimo debe estar entre ${lo} y ${hi}`;
    if (!esNum(t.maxPct) || t.maxPct < lo || t.maxPct > hi) return `El margen máximo debe estar entre ${lo} y ${hi}`;
    if (t.minPct > t.maxPct) return 'El margen mínimo no puede superar al máximo';
    const [eLo, eHi] = ESCALONES_RANGO;
    if (!Number.isInteger(t.escalones) || t.escalones < eLo || t.escalones > eHi) return `Los escalones deben ser un entero entre ${eLo} y ${eHi}`;
    const r = t.rango;
    if (!r || !esNum(r.desde) || !esNum(r.hasta) || r.desde <= 0 || r.hasta <= r.desde) return 'El rango de costos debe tener desde > 0 y hasta > desde';
    return null;
  }

  // Escalones de la tabla: cortes logarítmicos entre rango.desde y rango.hasta; margen lineal de máx (barato) a mín (caro).
  function quiebres(t) {
    const n = t.escalones;
    const { desde, hasta } = t.rango;
    const paso = n > 1 ? (t.maxPct - t.minPct) / (n - 1) : 0;
    return Array.from({ length: n }, (_, i) => ({
      hasta: i < n - 1 ? r2(desde * Math.pow(hasta / desde, (i + 1) / n)) : null,
      margenPct: r2(t.maxPct - i * paso),
    }));
  }

  function margenDe(t, costo) {
    return quiebres(t).find(q => q.hasta == null || costo < q.hasta).margenPct;
  }

  // Ajuste ±% por tramo de peso (Fraccionado). Mismo criterio que tramoDePeso de precios_costeo.
  const PESO_SIN_DATO_G = 1000;
  function ajustePesoPct(aj, pesoG) {
    if (!aj || !Array.isArray(aj.tramosG) || !aj.tramosG.length || !Array.isArray(aj.puntos)) return 0;
    const peso = pesoG > 0 ? pesoG : PESO_SIN_DATO_G;
    const i = aj.tramosG.findIndex(t => peso <= t);
    return Number(aj.puntos[i < 0 ? aj.tramosG.length - 1 : i]) || 0;
  }

  // Rango sugerido para una tabla: percentiles 5 y 95 (nearest-rank) de los costos reales del tipo. null si no
  // alcanza para un rango (menos de 2 costos o todos iguales).
  const PCT_RANGO = [5, 95];
  function rangoDesdeCostos(costos) {
    const xs = (costos || []).filter(c => esNum(c) && c > 0).sort((a, b) => a - b);
    if (xs.length < 2) return null;
    const pct = p => xs[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)];
    const desde = r2(pct(PCT_RANGO[0]));
    const hasta = r2(pct(PCT_RANGO[1]));
    return hasta > desde ? { desde, hasta } : null;
  }

  const CANALES = ['minorista', 'pack', 'bulto'];

  // Canal mayorista (pack/bulto): precio de la caja = neto unitario × unidades del vínculo; dos listas, sin y con IVA.
  function canalMayorista(costoCG, margenPct, unidades, ivaPct, vigente, pasoNeto, pasoIva) {
    const netoUnidad = r2(costoCG * (1 + margenPct / 100));
    const exactoNeto = r2(netoUnidad * unidades);
    const exactoIva = r2(exactoNeto * (1 + ivaPct / 100));
    return {
      margenPct, netoUnidad, unidades, exactoNeto,
      neto: redondearMultiplo(exactoNeto, pasoNeto),
      exactoIva,
      conIva: alinear(exactoIva, vigente, pasoIva),
    };
  }

  // Los 5 precios de un producto. Los canales comparten solo costo + gastos variables; cada uno aplica su margen.
  function preciosCanales({ tipo, costo, costoMargen, pesoG = null, unidades = {}, vigentes = {}, cfg = {} } = {}) {
    const vacio = error => ({ error, costo: costo ?? null, gastosPct: null, costoConGastos: null,
      minorista: null, pack: null, bulto: null });
    if (!esNum(costo) || costo <= 0) return vacio('costo');
    const tablas = (cfg.margenes || {})[tipo] || {};
    if (CANALES.some(c => validarTablaMargen(tablas[c]) != null)) return vacio('margen');

    const gastosPct = pctItems(cfg.gastosVenta, tipo);
    const costoCG = costoConGastos(costo, gastosPct, cfg.modoGastos);
    if (costoCG == null) return vacio('gastos');

    const ivaPct = Number(cfg.ivaVentaPct) || 0;
    const red = cfg.redondeo || {};
    const ajuste = tipo === 'fraccionado' ? ajustePesoPct(tablas.ajustesPeso, pesoG) : 0;
    const margen = canal => r2(margenDe(tablas[canal], costoMargen ?? costo) + ajuste);

    const margenMin = margen('minorista');
    const neto = r2(costoCG * (1 + margenMin / 100));
    const extrasPct = pctItems(cfg.extrasMinorista, tipo);
    const conExtras = r2(neto * (1 + extrasPct / 100));
    const exacto = r2(conExtras * (1 + ivaPct / 100));
    const minorista = { margenPct: margenMin, neto, extrasPct, conExtras, ivaPct, exacto,
      precio: alinear(exacto, vigentes.minorista, red.minorista) };

    const mayorista = canal => (unidades[canal] > 0
      ? canalMayorista(costoCG, margen(canal), unidades[canal], ivaPct, vigentes[canal], red[`${canal}Neto`], red[`${canal}Iva`])
      : null);

    return { error: null, costo, gastosPct, costoConGastos: costoCG, minorista, pack: mayorista('pack'), bulto: mayorista('bulto') };
  }

  return { r2, redondearMultiplo, alinear, pctItems, costoConGastos, validarTablaMargen, quiebres, margenDe,
    ajustePesoPct, rangoDesdeCostos, preciosCanales };
}));
