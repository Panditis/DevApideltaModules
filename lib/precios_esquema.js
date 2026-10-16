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

  // Margen válido: número finito mayor a −100 % (con −100 % o menos el precio sería ≤ 0); sin tope superior.
  const MARGEN_MIN_PCT = -100;
  const ERROR_MARGEN = 'El margen debe ser mayor a −100 %';
  const ESCALONES_RANGO = [1, 30];
  const esNum = v => typeof v === 'number' && Number.isFinite(v);
  const esMargenValido = v => esNum(v) && v > MARGEN_MIN_PCT;

  function validarTablaMargen(t) {
    if (!t || typeof t !== 'object') return 'Falta la tabla de margen';
    if (!esMargenValido(t.minPct) || !esMargenValido(t.maxPct)) return ERROR_MARGEN;
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

  // Generador de tramos de peso para la pantalla (no guarda): cortes en escala log de desdeG a hastaG (extremos exactos),
  // redondeados a 1 g (<100 g), 10 g (<1 kg) o 50 g; el % va lineal del más liviano al más pesado, a 1 decimal.
  // Entrada inválida o cortes que se pisan al redondear → null.
  const AJUSTES_PESO_MAX = 20;
  const r1 = n => Math.round(n * 10) / 10 || 0; // || 0: sin -0
  const pasoG = g => (g < 100 ? 1 : g < 1000 ? 10 : 50);
  const ascendente = xs => xs.every((x, i) => i === 0 || x > xs[i - 1]);
  function generarAjustesPeso({ desdeG, hastaG, tramos, livianoPct, pesadoPct } = {}) {
    const fin = v => typeof v === 'number' && Number.isFinite(v);
    const pctOk = v => fin(v) && v >= -100 && v <= 100;
    if (!fin(desdeG) || !fin(hastaG) || desdeG <= 0 || hastaG <= desdeG || !Number.isInteger(tramos)
      || tramos < 2 || tramos > AJUSTES_PESO_MAX || !pctOk(livianoPct) || !pctOk(pesadoPct)) return null;
    const n = tramos - 1;
    const crudos = Array.from({ length: tramos }, (_, i) => (i === 0 ? desdeG : i === n ? hastaG : desdeG * Math.pow(hastaG / desdeG, i / n)));
    const extremos = (g, i) => (i === 0 || i === n ? g : null);
    const lindos = crudos.map((g, i) => extremos(g, i) ?? Math.round(g / pasoG(g)) * pasoG(g));
    const enteros = crudos.map((g, i) => extremos(g, i) ?? Math.round(g));
    const tramosG = [lindos, enteros].find(ascendente);
    if (!tramosG) return null;
    return { tramosG, puntos: tramosG.map((_, i) => r1(livianoPct + (pesadoPct - livianoPct) * i / n)) };
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
  function canalMayorista(costoCG, margenPct, unidades, ivaPct, vigente, pasoNeto, pasoIva, especial = {}) {
    const netoUnidad = r2(costoCG * (1 + margenPct / 100));
    const exactoNeto = r2(netoUnidad * unidades);
    const exactoIva = r2(exactoNeto * (1 + ivaPct / 100));
    return {
      margenPct, ...especial, netoUnidad, unidades, exactoNeto,
      neto: redondearMultiplo(exactoNeto, pasoNeto),
      exactoIva,
      conIva: alinear(exactoIva, vigente, pasoIva),
    };
  }

  // Minorista: neto (costo con gastos × margen) → con extras → exacto con IVA. Sin redondeo comercial.
  function cadenaMinorista(costoCG, margenPct, extrasPct, ivaPct) {
    const neto = r2(costoCG * (1 + margenPct / 100));
    const conExtras = r2(neto * (1 + extrasPct / 100));
    return { neto, conExtras, exacto: r2(conExtras * (1 + ivaPct / 100)) };
  }

  // Inversa del canal: margen % (fijo, ver margenProducto) con el que el exacto del canal (minorista: con extras e IVA;
  // pack/bulto: con IVA × unidades) da precioObjetivo, así alinear lo deja en el vigente de SIGA. 2 decimales si con eso el
  // exacto cae a menos de $0,50 del objetivo; si no (precios altos), 3 o 4. null si la entrada no sirve o el margen ≤ −100 %.
  // ponytail: con muchas unidades (bulto ≥ ~80) el r2 del neto unitario puede saltar la ventana de $0,50; queda aprox.
  function margenParaPrecio({ tipo, canal, costo, precioObjetivo, unidades, cfg = {} } = {}) {
    const mayor = canal === 'pack' || canal === 'bulto';
    if (!esNum(costo) || costo <= 0 || !esNum(precioObjetivo) || precioObjetivo <= 0) return null;
    if (!mayor && canal !== 'minorista') return null;
    if (mayor && !(unidades > 0)) return null;
    const costoCG = costoConGastos(costo, pctItems(cfg.gastosVenta, tipo), cfg.modoGastos);
    if (costoCG == null || costoCG <= 0) return null;
    const ivaPct = Number(cfg.ivaVentaPct) || 0;
    const extrasPct = pctItems(cfg.extrasMinorista, tipo);
    const factor = mayor ? unidades * (1 + ivaPct / 100) : (1 + extrasPct / 100) * (1 + ivaPct / 100);
    const crudo = (precioObjetivo / (costoCG * factor) - 1) * 100;
    if (!(crudo > MARGEN_MIN_PCT)) return null;
    const exacto = m => (mayor ? canalMayorista(costoCG, m, unidades, ivaPct, null, 0, 0).exactoIva : cadenaMinorista(costoCG, m, extrasPct, ivaPct).exacto);
    const redondeado = d => Math.round((crudo + Number.EPSILON) * 10 ** d) / 10 ** d || 0;
    const d = [2, 3].find(x => Math.abs(exacto(redondeado(x)) - precioObjetivo) < TOLERANCIA_ALINEADO) || 4;
    const m = redondeado(d);
    return m > MARGEN_MIN_PCT ? m : null;
  }

  // Los 5 precios de un producto. Los canales comparten solo costo + gastos variables; cada uno aplica su margen.
  // cfg.margenes = { minorista, pack, bulto, ajustesPeso }: una tabla por canal, la misma para los tres tipos; el ajuste
  // por peso sólo se suma en Fraccionado. margenExtra = { minorista, pack, bulto } en puntos % (margen especial de un
  // producto de Producción): se suma al margen del canal y viaja aparte como margenEspecialPct (sólo si ≠ 0).
  // margenProducto = { modo, minorista, pack, bulto } (costeo.margenProducto). modo 'ajuste' (o sin modo: dato viejo) =
  // puntos % que se suman encima del especial. modo 'fijo' = el valor ES el margen del canal (reemplaza tabla + ajuste por
  // peso + especial; canal vacío → el general). Viaja aparte: margenProductoPct + margenProductoModo, y en fijo margenGeneralPct
  // (el margen que reemplazó). distribuidor (Reventa con costeo.tipoProveedor 'distribuidor'): al margen calculado (tabla + ajuste
  // del producto) se le restan cfg.margenes.descuentoDistribuidorPct puntos; viaja como descuentoDistribuidorPct. El fijo no lo lleva.
  function preciosCanales({ tipo, costo, costoMargen, pesoG = null, unidades = {}, vigentes = {}, cfg = {}, margenExtra = null, margenProducto = null, distribuidor = false } = {}) {
    const vacio = error => ({ error, costo: costo ?? null, gastosPct: null, costoConGastos: null,
      minorista: null, pack: null, bulto: null });
    if (!esNum(costo) || costo <= 0) return vacio('costo');
    const tablas = cfg.margenes || {};
    if (CANALES.some(c => validarTablaMargen(tablas[c]) != null)) return vacio('margen');

    const gastosPct = pctItems(cfg.gastosVenta, tipo);
    const costoCG = costoConGastos(costo, gastosPct, cfg.modoGastos);
    if (costoCG == null) return vacio('gastos');

    const ivaPct = Number(cfg.ivaVentaPct) || 0;
    const red = cfg.redondeo || {};
    const ajuste = tipo === 'fraccionado' ? ajustePesoPct(tablas.ajustesPeso, pesoG) : 0;
    const puntos = (m, canal) => (m && esNum(m[canal]) ? m[canal] : 0);
    const extra = canal => puntos(margenExtra, canal);
    const esFijo = !!margenProducto && margenProducto.modo === 'fijo';
    const fijo = canal => (esFijo && esNum(margenProducto[canal]) ? margenProducto[canal] : null);
    const delProducto = canal => (esFijo ? 0 : puntos(margenProducto, canal));
    const general = canal => r2(margenDe(tablas[canal], costoMargen ?? costo) + ajuste + extra(canal));
    const dto = tablas.descuentoDistribuidorPct;
    const descuento = tipo === 'almacen' && distribuidor === true && esNum(dto) && dto > 0 ? dto : 0;
    const margen = canal => fijo(canal) ?? r2(general(canal) + delProducto(canal) - descuento);
    // Con el descuento el margen puede caer a −100 % o menos (precio ≤ 0): error, como una tabla inválida.
    if (descuento && CANALES.some(c => !esMargenValido(margen(c)))) return vacio('margen');
    const especial = canal => (fijo(canal) != null
      ? { margenProductoPct: fijo(canal), margenProductoModo: 'fijo', margenGeneralPct: general(canal) }
      : { ...(extra(canal) ? { margenEspecialPct: extra(canal) } : {}),
        ...(delProducto(canal) ? { margenProductoPct: delProducto(canal), margenProductoModo: 'ajuste' } : {}),
        ...(descuento ? { descuentoDistribuidorPct: descuento } : {}) });

    const margenMin = margen('minorista');
    const extrasPct = pctItems(cfg.extrasMinorista, tipo);
    const { neto, conExtras, exacto } = cadenaMinorista(costoCG, margenMin, extrasPct, ivaPct);
    const minorista = { margenPct: margenMin, ...especial('minorista'), neto, extrasPct, conExtras, ivaPct, exacto,
      precio: alinear(exacto, vigentes.minorista, red.minorista) };

    const mayorista = canal => (unidades[canal] > 0
      ? canalMayorista(costoCG, margen(canal), unidades[canal], ivaPct, vigentes[canal], red[`${canal}Neto`], red[`${canal}Iva`], especial(canal))
      : null);

    return { error: null, costo, gastosPct, costoConGastos: costoCG, minorista, pack: mayorista('pack'), bulto: mayorista('bulto') };
  }

  return { r2, redondearMultiplo, alinear, pctItems, costoConGastos, MARGEN_MIN_PCT, ERROR_MARGEN, esMargenValido, validarTablaMargen, quiebres, margenDe,
    ajustePesoPct, AJUSTES_PESO_MAX, generarAjustesPeso, rangoDesdeCostos, preciosCanales, margenParaPrecio };
}));
