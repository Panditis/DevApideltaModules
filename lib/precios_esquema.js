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
    return t.filas != null ? validarFilas(t.filas) : null;
  }

  // Tabla manual (Fraccionado): [{ hasta, margenPct }], cortes ascendentes estrictos; la última sin corte ("en adelante").
  const FILAS_MAX = ESCALONES_RANGO[1];
  function validarFilas(filas) {
    if (!Array.isArray(filas) || filas.length < 1 || filas.length > FILAS_MAX) return `La tabla manual debe tener entre 1 y ${FILAS_MAX} filas`;
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i] || {};
      const n = `Fila ${i + 1}: `;
      if (i === filas.length - 1) {
        if (f.hasta != null) return `${n}la última fila no lleva corte (queda "en adelante")`;
      } else {
        if (!esNum(f.hasta) || f.hasta <= 0) return `${n}el corte debe ser un número mayor a 0`;
        if (i > 0 && f.hasta <= filas[i - 1].hasta) return `${n}el corte debe ser mayor al de la fila anterior`;
      }
      if (!esMargenValido(f.margenPct)) return `${n}${ERROR_MARGEN}`;
    }
    return null;
  }

  // Escalones de la tabla: las filas manuales si hay; si no, cortes logarítmicos entre rango.desde y rango.hasta y margen
  // lineal de máx (barato) a mín (caro).
  function quiebres(t) {
    if (t.filas != null) return t.filas.map(f => ({ hasta: f.hasta ?? null, margenPct: f.margenPct }));
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
  // El vigente de SIGA de pack/bulto es el precio SIN IVA: alinea al neto; el con IVA sólo se redondea.
  // margenInformado: el margenPct que viaja si no es el aplicado (mayorista por descuento: netoUnidad ya viene y margenPct = 0).
  function canalMayorista(costoCG, margenPct, unidades, ivaPct, vigente, pasoNeto, pasoIva, especial = {}, margenInformado = margenPct) {
    const netoUnidad = r2(costoCG * (1 + margenPct / 100));
    const exactoNeto = r2(netoUnidad * unidades);
    const exactoIva = r2(exactoNeto * (1 + ivaPct / 100));
    return {
      margenPct: margenInformado, ...especial, netoUnidad, unidades, exactoNeto,
      neto: alinear(exactoNeto, vigente, pasoNeto),
      exactoIva,
      conIva: redondearMultiplo(exactoIva, pasoIva),
    };
  }

  // Minorista: neto (costo con gastos × margen) → con extras → exacto con IVA. Sin redondeo comercial.
  function cadenaMinorista(costoCG, margenPct, extrasPct, ivaPct) {
    const neto = r2(costoCG * (1 + margenPct / 100));
    const conExtras = r2(neto * (1 + extrasPct / 100));
    return { neto, conExtras, exacto: r2(conExtras * (1 + ivaPct / 100)) };
  }

  // Minorista con precio final fijo (modo 'precio'): la cadena al revés — sin IVA, sin extras — y el margen sale del neto.
  function cadenaMinoristaFija(costoCG, precio, extrasPct, ivaPct) {
    const conExtras = r2(precio / (1 + ivaPct / 100));
    const neto = r2(conExtras / (1 + extrasPct / 100));
    return { neto, conExtras, exacto: precio, margenPct: r2((neto / costoCG - 1) * 100) };
  }

  // Margen % que da un precio fijo con el costo con gastos. Minorista: precio final con IVA (se le sacan IVA y extras);
  // pack/bulto: precio neto por unidad. Lo usa el motor y el modal (margen en vivo al tipear), así es una sola cuenta.
  function margenDePrecio({ canal, precio, costoCG, extrasPct = 0, ivaPct = 0 } = {}) {
    return canal === 'minorista' ? cadenaMinoristaFija(costoCG, precio, extrasPct, ivaPct).margenPct : r2((precio / costoCG - 1) * 100);
  }

  // Pack/bulto con precio neto por unidad fijo: el neto de la caja es exacto (sin alinear); el con IVA sí se redondea por la lista.
  function canalMayoristaFijo(precioUnidad, margenPct, unidades, ivaPct, pasoIva, especial = {}) {
    const exactoNeto = r2(precioUnidad * unidades);
    const exactoIva = r2(exactoNeto * (1 + ivaPct / 100));
    return { margenPct, ...especial, netoUnidad: precioUnidad, unidades, exactoNeto, neto: exactoNeto, exactoIva, conIva: redondearMultiplo(exactoIva, pasoIva) };
  }

  // Inversa del canal: margen % (fijo, ver margenProducto) con el que el exacto del canal (minorista: con extras e IVA;
  // pack/bulto: sin IVA × unidades) da precioObjetivo, así alinear lo deja en el vigente de SIGA. 2 decimales si con eso el
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
    const factor = mayor ? unidades : (1 + extrasPct / 100) * (1 + ivaPct / 100);
    const crudo = (precioObjetivo / (costoCG * factor) - 1) * 100;
    if (!(crudo > MARGEN_MIN_PCT)) return null;
    const exacto = m => (mayor ? canalMayorista(costoCG, m, unidades, ivaPct, null, 0, 0).exactoNeto : cadenaMinorista(costoCG, m, extrasPct, ivaPct).exacto);
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
  // (el margen que reemplazó). modo 'precio' (sólo Reventa) = el valor ES el precio del canal (minorista final con IVA; pack/bulto
  // neto por unidad): sale exacto, sin alinear ni redondear, y el margen se deriva del costo; viaja como precioFijo +
  // margenProductoModo + margenGeneralPct. distribuidor (Reventa con costeo.tipoProveedor 'distribuidor'): al margen calculado
  // (tabla + ajuste del producto) se le restan cfg.margenes.descuentoDistribuidorPct puntos; viaja como descuentoDistribuidorPct.
  // Ni el modo fijo ni el de precio llevan el descuento distribuidor. El modo 'precio' lo arma el listado de Reventa desde
  // costeo.precioFijo (sugeridos.precio, lib/precios_listado_esquema); no se guarda en margenProducto.
  // Fraccionado: pack/bulto (vinculados) salen SIEMPRE de minorista.conExtras ($/kg sin IVA) con cfg.margenes.mayorista
  // { descPackPct, descBultoPct } (default 10/10): pack = base × (1 − dPack), bulto = pack exacto × (1 − dBulto); las tablas
  // pack/bulto ya no se usan (2026-11-04). margenPct del canal = el que resulta sobre el costo con gastos; viaja
  // descuentoMayoristaPct. margenProducto 'fijo' del canal gana. variante ('minorista' | 'pack' | 'bulto'; 'mayorista' ≡ 'bulto'):
  // en pack/bulto el minorista pasa a ser ese canal $/kg SIN IVA (ver precioMayorista; minoristaOriginal guarda el de antes).
  function preciosCanales({ tipo, costo, costoMargen, pesoG = null, unidades = {}, vigentes = {}, cfg = {}, margenExtra = null, margenProducto = null, distribuidor = false, variante = 'minorista' } = {}) {
    const vacio = error => ({ error, costo: costo ?? null, gastosPct: null, costoConGastos: null,
      minorista: null, pack: null, bulto: null });
    if (!esNum(costo) || costo <= 0) return vacio('costo');
    const tablas = cfg.margenes || {};
    // Fraccionado (2026-11-04): pack/bulto salen de los descuentos (cfg.margenes.mayorista), sus tablas son opcionales.
    const esFracc = tipo === 'fraccionado';
    if (CANALES.some(c => (!esFracc || c === 'minorista' || tablas[c] != null) && validarTablaMargen(tablas[c]) != null)) return vacio('margen');

    const gastosPct = pctItems(cfg.gastosVenta, tipo);
    const costoCG = costoConGastos(costo, gastosPct, cfg.modoGastos);
    if (costoCG == null) return vacio('gastos');

    const ivaPct = Number(cfg.ivaVentaPct) || 0;
    const red = cfg.redondeo || {};
    const ajuste = tipo === 'fraccionado' ? ajustePesoPct(tablas.ajustesPeso, pesoG) : 0;
    const puntos = (m, canal) => (m && esNum(m[canal]) ? m[canal] : 0);
    const extra = canal => puntos(margenExtra, canal);
    // Modo del margen del producto: 'fijo' (el valor es el margen), 'precio' (el valor es el precio; sólo Reventa) o 'ajuste'
    // (o sin modo, dato viejo: puntos que se suman). Cualquier otro modo no se lee como puntos.
    const modoMp = margenProducto ? margenProducto.modo : null;
    const esFijo = modoMp === 'fijo';
    const esPrecio = modoMp === 'precio' && (tipo === 'almacen' || tipo === 'fraccionado'); // Fraccionado: el listado sólo pasa minorista ($/kg)
    const esAjuste = modoMp == null || modoMp === 'ajuste';
    const fijo = canal => (esFijo && esNum(margenProducto[canal]) ? margenProducto[canal] : null);
    const precioFijo = canal => (esPrecio && esNum(margenProducto[canal]) && margenProducto[canal] > 0 ? margenProducto[canal] : null);
    const delProducto = canal => (esAjuste ? puntos(margenProducto, canal) : 0);
    const general = canal => (tablas[canal] ? r2(margenDe(tablas[canal], costoMargen ?? costo) + ajuste + extra(canal)) : null);
    const extrasPct = pctItems(cfg.extrasMinorista, tipo);
    const dto = tablas.descuentoDistribuidorPct;
    const descuento = tipo === 'almacen' && distribuidor === true && esNum(dto) && dto > 0 ? dto : 0;
    const margen = canal => (precioFijo(canal) != null
      ? margenDePrecio({ canal, precio: precioFijo(canal), costoCG, extrasPct, ivaPct })
      : fijo(canal) ?? r2(general(canal) + delProducto(canal) - descuento));
    // Con el descuento el margen puede caer a −100 % o menos (precio ≤ 0): error, como una tabla inválida.
    if (descuento && CANALES.some(c => !esMargenValido(margen(c)))) return vacio('margen');
    const especial = canal => {
      if (precioFijo(canal) != null) return { precioFijo: precioFijo(canal), margenProductoModo: 'precio', margenGeneralPct: general(canal) };
      if (fijo(canal) != null) return { margenProductoPct: fijo(canal), margenProductoModo: 'fijo', margenGeneralPct: general(canal) };
      return { ...(extra(canal) ? { margenEspecialPct: extra(canal) } : {}),
        ...(delProducto(canal) ? { margenProductoPct: delProducto(canal), margenProductoModo: 'ajuste' } : {}),
        ...(descuento ? { descuentoDistribuidorPct: descuento } : {}) };
    };

    const margenMin = margen('minorista');
    const pMin = precioFijo('minorista');
    const { neto, conExtras, exacto } = pMin != null ? cadenaMinoristaFija(costoCG, pMin, extrasPct, ivaPct) : cadenaMinorista(costoCG, margenMin, extrasPct, ivaPct);
    const minoristaBase = { margenPct: margenMin, ...especial('minorista'), neto, extrasPct, conExtras, ivaPct, exacto,
      precio: pMin ?? alinear(exacto, vigentes.minorista, red.minorista) };

    // Fraccionado: los descuentos rigen SIEMPRE los pack/bulto vinculados (2026-11-04, sin tablas pack/bulto). variante
    // 'pack' | 'bulto' ('mayorista' ≡ 'bulto', dato viejo) = presentación mayorista: su minorista pasa a ese canal sin IVA.
    // Escala por costo (2026-11-06): si hay escalaPack/escalaBulto válidas, el descuento sale del costo de referencia de las
    // tablas de margen (costoMargen ?? costo); si no, el fijo de siempre.
    const descCfg = esFracc ? descuentosMayorista(tablas.mayorista) : null;
    const costoRef = costoMargen ?? costo;
    const desc = descCfg && {
      descPackPct: descCfg.escalaPack ? descuentoDeEscala(descCfg.escalaPack, costoRef) : descCfg.descPackPct,
      descBultoPct: descCfg.escalaBulto ? descuentoDeEscala(descCfg.escalaBulto, costoRef) : descCfg.descBultoPct,
    };
    const tipoMayorista = !esFracc ? null : variante === 'pack' ? 'pack' : variante === 'bulto' || variante === 'mayorista' ? 'bulto' : null;
    const netoKgMayorista = canal => r2(conExtras * (1 - desc.descPackPct / 100) * (canal === 'bulto' ? 1 - desc.descBultoPct / 100 : 1));
    // Presentación mayorista: su precio sugerido ($/kg) pasa a ser el PACK o BULTO SIN IVA (tipoMayorista, sinIva: true); exacto = ese neto sin
    // redondear. Redondeo: paso del minorista (red.minorista), alineado al vigente de SIGA tal cual; el
    // bultoNeto de la config es por caja, no por kg. Pack viaja informativo. Margen fijo del producto en minorista gana.
    // vigenteNeto = vigente de SIGA TAL CUAL (2026-11-04): el vigente de una mayorista ya está sin IVA, no se le resta; se
    // mantiene el campo por contrato con el front (modal/listado/export lo leen).
    const vigenteNeto = vigentes.minorista > 0 ? vigentes.minorista : null;
    const precioMayorista = canal => {
      const netoKg = netoKgMayorista(canal);
      const ex = r2(netoKg * (1 + ivaPct / 100));
      return { descuentoMayoristaPct: canal === 'pack' ? desc.descPackPct : desc.descBultoPct, neto: netoKg,
        precio: alinear(netoKg, vigenteNeto, red.minorista), exactoIva: ex, conIva: alinear(ex, vigentes.minorista, red.minorista),
        margenPct: r2((netoKg / costoCG - 1) * 100) };
    };
    const minorista = tipoMayorista && fijo('minorista') == null && pMin == null ? (() => {
      const pack = precioMayorista('pack'), bulto = precioMayorista('bulto');
      const elegido = tipoMayorista === 'pack' ? pack : bulto;
      return { ...minoristaBase, margenPct: elegido.margenPct, descuentoMayoristaPct: elegido.descuentoMayoristaPct, calculoMayorista: 'descuento',
        tipoMayorista, sinIva: true, vigenteNeto, exacto: elegido.neto, precio: elegido.precio,
        minoristaOriginal: { margenPct: margenMin, exacto, precio: minoristaBase.precio, neto: r2(minoristaBase.precio / (1 + ivaPct / 100)) },
        mayorista: { base: conExtras, descPackPct: desc.descPackPct, descBultoPct: desc.descBultoPct, pack, bulto,
          escala: { pack: !!descCfg.escalaPack, bulto: !!descCfg.escalaBulto } } };
    })() : minoristaBase;
    const mayorista = canal => {
      if (!(unidades[canal] > 0)) return null;
      if (desc && fijo(canal) == null) {
        const netoKg = netoKgMayorista(canal);
        return canalMayorista(netoKg, 0, unidades[canal], ivaPct, vigentes[canal], red[`${canal}Neto`], red[`${canal}Iva`],
          { descuentoMayoristaPct: canal === 'pack' ? desc.descPackPct : desc.descBultoPct }, r2((netoKg / costoCG - 1) * 100));
      }
      const p = precioFijo(canal);
      return p != null
        ? canalMayoristaFijo(p, margen(canal), unidades[canal], ivaPct, red[`${canal}Iva`], especial(canal))
        : canalMayorista(costoCG, margen(canal), unidades[canal], ivaPct, vigentes[canal], red[`${canal}Neto`], red[`${canal}Iva`], especial(canal));
    };

    return { error: null, costo, gastosPct, costoConGastos: costoCG, minorista, pack: mayorista('pack'), bulto: mayorista('bulto') };
  }

  // Descuentos mayoristas de Fraccionado efectivos: lo guardado válido o el default (sin migración).
  // pisoVinculadoPct: colchón % sobre el pack mayorista más barato del granel que no perfora un bulto/pack vinculado (0 = piso igual al pack, sin colchón).
  const DESC_MAYORISTA_DEFAULT = Object.freeze({ descPackPct: 10, descBultoPct: 10, pisoVinculadoPct: 2 });
  const esDescValido = v => esNum(v) && v >= 0 && v < 100;
  const PISO_VINCULADO_MAX = 50;
  const esPisoValido = v => esNum(v) && v >= 0 && v <= PISO_VINCULADO_MAX;
  function descuentosMayorista(m) {
    const o = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    return { descPackPct: esDescValido(o.descPackPct) ? o.descPackPct : DESC_MAYORISTA_DEFAULT.descPackPct,
      descBultoPct: esDescValido(o.descBultoPct) ? o.descBultoPct : DESC_MAYORISTA_DEFAULT.descBultoPct,
      pisoVinculadoPct: esPisoValido(o.pisoVinculadoPct) ? o.pisoVinculadoPct : DESC_MAYORISTA_DEFAULT.pisoVinculadoPct,
      ...(o.escalaPack != null && validarEscalaDescuento(o.escalaPack) == null ? { escalaPack: o.escalaPack } : {}),
      ...(o.escalaBulto != null && validarEscalaDescuento(o.escalaBulto) == null ? { escalaBulto: o.escalaBulto } : {}) };
  }

  // Escala de descuento por costo (pack/bulto de Fraccionado): misma forma que una tabla de margen pero con descPct
  // (0 ≤ % < 100) y al revés: más caro → más descuento (barato = minPct, caro = maxPct). filas manuales ganan.
  const ERROR_DESC = 'El descuento debe ser un número desde 0 y menor a 100 %';
  function validarEscalaDescuento(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return 'Falta la escala de descuento';
    if (!esDescValido(t.minPct) || !esDescValido(t.maxPct)) return ERROR_DESC;
    if (t.minPct > t.maxPct) return 'El descuento mínimo no puede superar al máximo';
    const [eLo, eHi] = ESCALONES_RANGO;
    if (!Number.isInteger(t.escalones) || t.escalones < eLo || t.escalones > eHi) return `Los escalones deben ser un entero entre ${eLo} y ${eHi}`;
    const r = t.rango;
    if (!r || !esNum(r.desde) || !esNum(r.hasta) || r.desde <= 0 || r.hasta <= r.desde) return 'El rango de costos debe tener desde > 0 y hasta > desde';
    if (t.filas == null) return null;
    // Reusa validarFilas mapeando descPct al lugar de margenPct; el mensaje de % se reemplaza por el de descuento.
    if (!Array.isArray(t.filas)) return validarFilas(t.filas);
    const err = validarFilas(t.filas.map(f => ({ hasta: f && f.hasta, margenPct: 0 })));
    if (err) return err;
    const i = t.filas.findIndex(f => !f || typeof f !== 'object' || !esDescValido(f.descPct));
    return i < 0 ? null : `Fila ${i + 1}: ${ERROR_DESC}`;
  }

  function quiebresEscala(t) {
    if (t.filas != null) return t.filas.map(f => ({ hasta: f.hasta ?? null, descPct: f.descPct }));
    const n = t.escalones;
    const { desde, hasta } = t.rango;
    const paso = n > 1 ? (t.maxPct - t.minPct) / (n - 1) : 0;
    return Array.from({ length: n }, (_, i) => ({
      hasta: i < n - 1 ? r2(desde * Math.pow(hasta / desde, (i + 1) / n)) : null,
      descPct: r2(t.minPct + i * paso),
    }));
  }

  function descuentoDeEscala(t, costo) {
    return quiebresEscala(t).find(q => q.hasta == null || costo < q.hasta).descPct;
  }

  // ¿Presentación mayorista? Gana la marca manual (porPlu: 'pack' | 'bulto' | false; true ≡ 'bulto', dato viejo); si no,
  // pesoG ≥ umbral → 'bulto' (default del usuario 2026-11-04). Sin umbral o sin peso → no (salvo marca).
  // → { mayorista, origen: 'manual' | 'peso' | null, tipo: 'pack' | 'bulto' | null }. Una sola regla: server y listados.
  const PESO_MIN_G_MAX = 1000000; // tope del umbral mayorista en g (entero 1..1.000.000)
  const TIPOS_MAYORISTA = ['pack', 'bulto'];
  function esMayoristaPresentacion(pesoG, plu, cfgMayorista) {
    const m = cfgMayorista && typeof cfgMayorista === 'object' && !Array.isArray(cfgMayorista) ? cfgMayorista : {};
    const porPlu = m.porPlu && typeof m.porPlu === 'object' && !Array.isArray(m.porPlu) ? m.porPlu : {};
    const manual = porPlu[String(plu)];
    if (manual === false) return { mayorista: false, origen: 'manual', tipo: null };
    if (manual === true) return { mayorista: true, origen: 'manual', tipo: 'bulto' };
    if (TIPOS_MAYORISTA.includes(manual)) return { mayorista: true, origen: 'manual', tipo: manual };
    if (m.pesoMinG > 0 && pesoG > 0 && pesoG >= m.pesoMinG) return { mayorista: true, origen: 'peso', tipo: 'bulto' };
    return { mayorista: false, origen: null, tipo: null };
  }

  // Regla por granel (2026-11-05): exactamente 2 mayoristas, ninguna con tipo manual y pesos distintos → la menor 'pack', la mayor
  // 'bulto'. items = [{ pesoG, plu }] de UN granel (no el grupo sin granel). → esMayoristaPresentacion + tipoOrigen por item
  // ('manual' | 'regla' | 'peso-defecto'; null si no es mayorista). La marca manual siempre gana.
  function mayoristasDeGranel(items, cfgMayorista, aplicaRegla = true) {
    const base = (items || []).map(it => {
      const may = esMayoristaPresentacion(it.pesoG, it.plu, cfgMayorista);
      return { ...may, tipoOrigen: !may.mayorista ? null : may.origen === 'manual' ? 'manual' : 'peso-defecto' };
    });
    const idx = base.map((m, i) => (m.mayorista ? i : -1)).filter(i => i >= 0);
    if (!aplicaRegla || idx.length !== 2 || idx.some(i => base[i].tipoOrigen === 'manual')) return base;
    const [a, b] = idx.map(i => items[i].pesoG);
    if (!(a > 0) || !(b > 0) || a === b) return base;
    const menor = a < b ? idx[0] : idx[1];
    return base.map((m, i) => (idx.includes(i) ? { ...m, tipo: i === menor ? 'pack' : 'bulto', tipoOrigen: 'regla' } : m));
  }

  return { esMayoristaPresentacion, mayoristasDeGranel, TIPOS_MAYORISTA, PESO_MIN_G_MAX, DESC_MAYORISTA_DEFAULT, esDescValido, PISO_VINCULADO_MAX, esPisoValido, descuentosMayorista, validarEscalaDescuento, quiebresEscala, descuentoDeEscala, r2, redondearMultiplo, alinear, pctItems, costoConGastos, MARGEN_MIN_PCT, ERROR_MARGEN, esMargenValido, validarTablaMargen, FILAS_MAX, validarFilas, quiebres, margenDe,
    ajustePesoPct, AJUSTES_PESO_MAX, generarAjustesPeso, rangoDesdeCostos, preciosCanales, margenParaPrecio, margenDePrecio };
}));
