'use strict';
// Redistribución sucursal → sucursal (pestaña "Redistribución" de Distribución). Ver
// docs/specs/redistribucion_sucursales.md. Solo informa: nada se graba en Siga.
//   faltante = max(0, Σ necesidad − stock central)       necesidad = ideal del motor (S − stock)
//   donante  = pocas ventas y sin necesidad propia       sobrante  = stock − objetivo (presencia)
//   mover    = lo que se pueda cubrir con los sobrantes, en múltiplos de la presentación
// Todo se cuenta en pasos enteros de `unidad` (caja o bolsa) para no arrastrar decimales.

const SUC_FICTICIAS = new Set(['6', '8', '11']);   // nunca origen ni destino
const r3 = x => Math.round(x * 1000) / 1000;

function esPocasVentas(ventas, dias, pesable, umbrales) {
  const umbral = pesable ? umbrales.kgDia : umbrales.unidDia;
  return (Number(ventas) || 0) / dias < umbral;
}

// Pocas ventas → presencia de góndola (sin clase ABC: min A8020). Si vende → S A8020.
function objetivoFinal({ pocasVentas, presencia, min, S }) {
  if (pocasVentas) return presencia > 0 ? presencia : (Number(min) || 0);
  return Number(S) || 0;
}

// Reparte `total` pasos entre claves: cada una arranca en `inicial`, nunca pasa su `cupo`, y la
// que arranca en 0 entra con `minPasos` de golpe. Paso a paso al que menos tiene respecto de su peso.
// ponytail: un paso por vuelta, O(total × claves); alcanza para decenas de cajas/bolsas por producto.
function llenar(total, cupo, peso, minPasos, inicial = {}) {
  const out = Object.fromEntries(Object.keys(cupo).map(k => [k, inicial[k] || 0]));
  let resto = total - Object.values(out).reduce((a, v) => a + v, 0);
  while (resto > 0) {
    let mejor = null;
    for (const k of Object.keys(out)) {
      const dar = out[k] ? 1 : minPasos;
      if (dar > resto || out[k] + dar > cupo[k] || !(peso[k] > 0)) continue;
      const ratio = out[k] / peso[k];
      if (!mejor || ratio < mejor.ratio) mejor = { k, dar, ratio };
    }
    if (!mejor) break;
    out[mejor.k] += mejor.dar;
    resto -= mejor.dar;
  }
  return out;
}

const suma = o => Object.values(o).reduce((a, v) => a + v, 0);
const sinCeros = (o, unidad) => Object.fromEntries(Object.entries(o).filter(([, v]) => v > 0).map(([k, v]) => [k, r3(v * unidad)]));

// → { sale:{suc:cant}, entra:{suc:cant} } con Σsale = Σentra, múltiplos de `unidad`, ninguna
// cantidad menor a `minimo`. Piso primero (a las que más venden), resto proporcional a ventas
// (a necesidad si nadie vendió), tope en la necesidad. Sale proporcional al sobrante.
function repartirFaltante({ faltante, donantes, receptoras, unidad, minimo = unidad }) {
  const pasos = x => Math.floor((Number(x) || 0) / unidad + 1e-9);
  const minPasos = Math.max(1, Math.ceil(minimo / unidad - 1e-9));
  const cupoSale = Object.fromEntries(Object.entries(donantes).map(([s, v]) => [s, pasos(v)]));
  const cupoEntra = Object.fromEntries(Object.entries(receptoras).map(([s, r]) => [s, pasos(r.necesidad)]));
  const porVentas = Object.values(receptoras).some(r => r.ventas > 0);
  const pesoEntra = Object.fromEntries(Object.entries(receptoras).map(([s, r]) =>
    [s, porVentas ? Number(r.ventas) || 0 : cupoEntra[s]]));
  let total = Math.min(pasos(faltante), suma(cupoSale), suma(cupoEntra));

  // Pasada 1: el piso de envío (al menos el mínimo) a cada receptora, mientras alcance.
  const piso = {};
  let resto = total;
  const orden = Object.keys(receptoras).sort((a, b) => (receptoras[b].ventas || 0) - (receptoras[a].ventas || 0));
  for (const s of orden) {
    const p = Math.max(minPasos, Math.ceil((Number(receptoras[s].piso) || 0) / unidad - 1e-9));
    if (p > cupoEntra[s] || p > resto) continue;
    piso[s] = p;
    resto -= p;
  }
  // Pasada 2 y salidas; si el mínimo deja un lado más corto, se achica el otro y se rehace.
  let entra = {}, sale = {};
  for (let i = 0; i < 4; i++) {
    entra = llenar(total, cupoEntra, pesoEntra, minPasos, piso);
    sale = llenar(suma(entra), cupoSale, cupoSale, minPasos);
    if (suma(sale) === suma(entra)) break;
    total = Math.min(suma(sale), suma(entra));
    for (const s of Object.keys(piso)) if (suma(piso) > total) delete piso[s];
  }
  if (suma(sale) !== suma(entra)) return { sale: {}, entra: {} };
  return { sale: sinCeros(sale, unidad), entra: sinCeros(entra, unidad) };
}

// Mayor sobrante a mayor necesidad. ponytail: greedy; un resto puede quedar bajo `minimo` cuando
// los totales lo fuerzan (el reparto ya garantiza que cada sale/entra lo supera).
function emparejar(sale, entra) {
  const d = Object.entries(sale).map(([s, v]) => ({ s, v }));
  const r = Object.entries(entra).map(([s, v]) => ({ s, v }));
  const out = [];
  for (;;) {
    d.sort((a, b) => b.v - a.v);
    r.sort((a, b) => b.v - a.v);
    if (!d.length || !r.length || d[0].v <= 1e-9 || r[0].v <= 1e-9) break;
    const q = r3(Math.min(d[0].v, r[0].v));
    out.push({ origen: Number(d[0].s), destino: Number(r[0].s), cantidad: q });
    d[0].v = r3(d[0].v - q);
    r[0].v = r3(r[0].v - q);
  }
  return out;
}

/**
 * Arma la redistribución de un producto. null si no hay faltante o nada que mover.
 * @param {{ plu, nombre, rubro, pesable:boolean, central:number, unidad:number, minimo:number,
 *   sucursales:{ [idSuc]:{ stock, necesidad, min, S, presencia, piso } } }} fila
 *   unidad = caja (almacén) o bolsa en kg (pesables); minimo = movimiento mínimo.
 *   necesidad = ideal del motor (0 si la sucursal sale Fact/Restringido).
 * @param {{ [idSuc]:number }} ventasPorSuc  unidades (almacén) o kg (pesables) del rango
 * @param {{ dias:number, umbrales:{ unidDia:number, kgDia:number } }} cfg
 */
function redistribuirProducto(fila, ventasPorSuc, cfg) {
  const sucs = {};
  const donantes = {}, receptoras = {};
  for (const [s, x] of Object.entries(fila.sucursales || {})) {
    if (SUC_FICTICIAS.has(String(s))) continue;
    const stock = Number(x.stock) || 0;
    const ventas = Number((ventasPorSuc || {})[s]) || 0;
    const pocasVentas = esPocasVentas(ventas, cfg.dias, fila.pesable, cfg.umbrales);
    const objetivo = objetivoFinal({ pocasVentas, presencia: x.presencia, min: x.min, S: x.S });
    const necesidad = Math.max(0, Number(x.necesidad) || 0);
    const sobrante = pocasVentas && !necesidad ? r3(Math.max(0, stock - objetivo)) : 0;
    sucs[s] = { stock, ventas, ventaDia: r3(ventas / cfg.dias), pocasVentas, objetivo, necesidad, sobrante, stockFinal: stock };
    if (sobrante > 0) donantes[s] = sobrante;
    if (necesidad > 0) receptoras[s] = { necesidad, ventas, piso: x.piso };
  }
  const demanda = r3(suma(Object.fromEntries(Object.entries(sucs).map(([s, v]) => [s, v.necesidad]))));
  const faltante = r3(Math.max(0, demanda - Math.max(0, Number(fila.central) || 0)));
  if (faltante <= 0) return null;
  const disponible = r3(suma(donantes));
  const { sale, entra } = repartirFaltante({ faltante, donantes, receptoras, unidad: fila.unidad, minimo: fila.minimo });
  const movimientos = emparejar(sale, entra);
  if (!movimientos.length) return null;
  for (const [s, v] of Object.entries(sale)) sucs[s] = { ...sucs[s], stockFinal: r3(sucs[s].stock - v) };
  for (const [s, v] of Object.entries(entra)) sucs[s] = { ...sucs[s], stockFinal: r3(sucs[s].stock + v) };
  const mover = r3(suma(entra));
  return { plu: fila.plu, nombre: fila.nombre, rubro: fila.rubro, pesable: !!fila.pesable,
    unidad: fila.pesable ? 'kg' : 'u', central: Number(fila.central) || 0, demanda, faltante, disponible,
    mover, cubierto: Math.min(1, mover / faltante), sucursales: sucs, movimientos };
}

module.exports = { esPocasVentas, objetivoFinal, repartirFaltante, emparejar, redistribuirProducto, SUC_FICTICIAS };
