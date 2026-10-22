'use strict';
// Tablero de planificación (spec 2026-10-22-planificacion-centro §3): filas en kg por variedad/directo,
// filas madre por granel base y sección fasón. Función pura: la ruta hace las queries y pasa Maps por PLU.
const { puntajePrioridad, clasesABC, nivelUrgencia, compararUrgencia, calcularCobertura } = require('./plan_prioridad');
const { metaDeEntrada, metaDeGranel, granelPlusDe } = require('./plan_catalogo_meta');

const r1 = n => Math.round(n * 10) / 10;
const r2 = n => Math.round(n * 100) / 100;
const RANGO = { URGENTE: 0, PRONTO: 1, OK: 2 };
const val = (mapa, plu) => Number(mapa.get(String(plu))) || 0;
const positivo = (mapa, plu) => Math.max(0, val(mapa, plu));

function pesoDesdeTexto(txt) {
  const m = /(\d+(?:[.,]\d+)?)\s*(kgs?|grs?|g)\b/i.exec(String(txt || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!(n > 0)) return null;
  return /^k/i.test(m[2]) ? n : n / 1000;
}

// Kg por unidad vendida: grupos enKg (SIGA ya vende en kg) = 1; si no, del texto de la presentación o
// del nombre base; si no, del componente granel de la fórmula. null = sin peso (⚠ en la fila).
function pesoPresentacionKg(item, { enKg = false, pesoFormula = null } = {}) {
  if (enKg) return 1;
  const p = pesoDesdeTexto(item && item.presentacion) ?? pesoDesdeTexto(item && item.baseNombre);
  if (p !== null) return p;
  return Number(pesoFormula) > 0 ? Number(pesoFormula) : null;
}

function filaDeGrupo(ref, items, d, o) {
  const cfg = d.gruposCfg[ref];
  const meta = metaDeEntrada(cfg);
  const granelPlus = granelPlusDe(cfg);
  const enKg = d.enKgRefs.has(ref);
  const pres = new Map();
  const sinPeso = [];
  const granelKg = new Map(granelPlus.map(g => [g, { granel: 0, producto: 0 }]));
  let ventasKg = 0, stockCentralKg = 0, stockLocalesKg = 0, factur = 0;
  for (const it of items) {
    const plu = String(it.plu);
    const boms = it.esVariante ? [] : (d.bomGranel.get(plu) || []);
    const bomPropio = boms.find(b => granelPlus.includes(b.granelPlu));
    const peso = pesoPresentacionKg(it, { enKg, pesoFormula: bomPropio ? bomPropio.cantPorUnidad : null });
    const f = val(d.factur, plu);
    factur += f;
    if (!pres.has(it.baseNombre)) pres.set(it.baseNombre, { plu: null, nombre: it.baseNombre, presentacion: it.presentacion, pesoKg: null, ventasKg: 0, facturacion: 0 });
    const p = pres.get(it.baseNombre);
    p.facturacion += f;
    if (peso === null) { sinPeso.push(plu); continue; }
    const vKg = val(d.ventas, plu) * peso;
    ventasKg += vKg;
    p.ventasKg += vKg;
    if (it.esVariante) continue; // las variantes (pack/bulto) suman ventas, no stock ni ratio
    p.plu = plu;
    p.pesoKg = peso;
    stockCentralKg += positivo(d.stockCentral, plu) * peso;
    stockLocalesKg += positivo(d.stockSuc, plu) * peso;
    for (const b of boms) {
      const g = granelKg.get(b.granelPlu);
      if (g && b.cantPorUnidad > 0 && vKg > 0) { g.granel += vKg * b.cantPorUnidad / peso; g.producto += vKg; }
    }
  }
  const ventaDiaKg = o.ventana > 0 ? ventasKg / o.ventana : 0;
  const cobertura = calcularCobertura(stockCentralKg, ventaDiaKg);
  const coberturaUrg = calcularCobertura(stockCentralKg + stockLocalesKg, ventaDiaKg);
  const mensual = x => (o.ventana > 0 ? x * 30 / o.ventana : 0);
  const cliente = meta.clienteId === null ? null
    : ((d.clientes || []).find(c => String(c.id) === String(meta.clienteId)) || {}).nombre || String(meta.clienteId);
  return {
    nivel: 'producto', productoRef: ref, ...meta, cliente, granelPlus,
    ratios: Object.fromEntries([...granelKg].map(([g, x]) => [g, x.producto > 0 ? Math.round(x.granel / x.producto * 10000) / 10000 : 1])),
    ventaDiaKg: r2(ventaDiaKg),
    stockCentralKg: r2(stockCentralKg),
    stockLocalesKg: r2(stockLocalesKg),
    stockGranelKg: granelPlus.length ? r2(granelPlus.reduce((s, g) => s + positivo(d.stockGranel, g), 0)) : null,
    coberturaDias: cobertura === null ? null : r1(cobertura),
    coberturaUrgenciaDias: coberturaUrg === null ? null : r1(coberturaUrg),
    estimadoKg: meta.clienteId === null ? r2(Math.max(0, ventaDiaKg * o.dias - stockCentralKg)) : null,
    facturacionMensual: r2(mensual(factur)),
    rankingScore: puntajePrioridad([...pres.values()].map(x => mensual(x.facturacion))),
    sinPeso,
    granelSinConfigurar: false,
    presentaciones: [...pres.values()].filter(x => x.plu).map(x => ({ plu: x.plu, nombre: x.nombre, presentacion: x.presentacion, pesoKg: x.pesoKg, ventasKg: r2(x.ventasKg) })),
  };
}

const ordenarConPausados = lista => [
  ...lista.filter(f => f.estado !== 'pausado').sort(compararUrgencia),
  ...lista.filter(f => f.estado === 'pausado'),
];
const peorUrgencia = filas => filas.reduce((peor, f) => ((RANGO[f.urgencia] ?? 2) < (RANGO[peor] ?? 2) ? f.urgencia : peor), 'OK');

function filaDeGranel(plu, v, propias, d) {
  const m = metaDeGranel(v);
  const variedades = ordenarConPausados(propias.filter(f => f.tipo === 'granel' && f.granelPlus.includes(plu)));
  const activas = variedades.filter(f => f.estado === 'activo');
  const stock = positivo(d.stockGranel, plu);
  const ratio = f => f.ratios[plu] ?? 1;
  const necesario = activas.reduce((s, f) => s + f.estimadoKg * ratio(f), 0);
  const ventaDia = activas.reduce((s, f) => s + f.ventaDiaKg * ratio(f), 0);
  const cobertura = calcularCobertura(stock, ventaDia);
  const posiciones = activas.map(f => f.rankingPos).filter(Number.isFinite);
  return {
    nivel: 'granel', plu, nombre: m.nombre || (d.nombres && d.nombres.get(plu)) || `PLU ${plu}`,
    estado: m.estado, motivo: m.motivo, responsables: m.responsables, proximaFecha: m.proximaFecha,
    stockGranelKg: r2(stock), ventaDiaKg: r2(ventaDia), coberturaDias: cobertura === null ? null : r1(cobertura),
    granelNecesarioKg: r2(necesario), estimadoKg: r2(Math.max(0, necesario - stock)),
    urgencia: peorUrgencia(activas),
    rankingPos: posiciones.length ? Math.min(...posiciones) : undefined,
    facturacionMensual: r2(activas.reduce((s, f) => s + f.facturacionMensual, 0)),
    variedades,
  };
}

function armarTablero(d, o) {
  const porRef = new Map();
  for (const it of d.catalogo) {
    const ref = String(it.productoRef || '');
    if (!porRef.has(ref)) porRef.set(ref, []);
    porRef.get(ref).push(it);
  }
  const filas = [...porRef]
    .filter(([ref]) => metaDeEntrada(d.gruposCfg[ref]).estado !== 'discontinuado')
    .map(([ref, items]) => filaDeGrupo(ref, items, d, o));
  const propias = filas.filter(f => f.clienteId === null);
  const clases = clasesABC(propias.map(f => f.rankingScore));
  [...propias].sort((a, b) => b.rankingScore - a.rankingScore).forEach((f, i) => { f.rankingPos = i + 1; });
  propias.forEach((f, i) => {
    f.claseABC = clases[i];
    f.urgencia = nivelUrgencia(f.coberturaUrgenciaDias, f.claseABC, o.urgenciaDias);
  });
  const graneles = Object.entries(d.granelesBase || {})
    .filter(([, v]) => metaDeGranel(v).estado !== 'discontinuado')
    .map(([plu, v]) => filaDeGranel(String(plu), v, propias, d));
  const enGranel = new Set(graneles.flatMap(g => g.variedades));
  const sueltas = propias.filter(f => f.tipo === 'granel' && !enGranel.has(f)).map(f => ({ ...f, granelSinConfigurar: true }));
  const directos = propias.filter(f => f.tipo === 'directo');
  const porCliente = new Map();
  for (const f of filas.filter(x => x.clienteId !== null)) {
    const k = String(f.clienteId);
    if (!porCliente.has(k)) porCliente.set(k, { clienteId: f.clienteId, cliente: f.cliente, filas: [] });
    porCliente.get(k).filas.push(f);
  }
  const porNombre = (a, b) => a.productoRef.localeCompare(b.productoRef);
  const fason = [...porCliente.values()]
    .map(g => ({ ...g, filas: [...g.filas.filter(f => f.estado !== 'pausado').sort(porNombre), ...g.filas.filter(f => f.estado === 'pausado')] }))
    .sort((a, b) => a.cliente.localeCompare(b.cliente));
  return { dias: o.dias, ventana: o.ventana, filas: ordenarConPausados([...graneles, ...sueltas, ...directos]), fason };
}

module.exports = { pesoPresentacionKg, armarTablero };
