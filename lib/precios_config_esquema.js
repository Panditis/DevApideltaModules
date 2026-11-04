'use strict';
// ── Precios · configuración del esquema por canal (spec 2026-10-07-precios-esquema-canales-design §3.3 y §4) ──
// Pura, sin I/O: la vista de config que consume el motor (lib/precios_esquema) y la pantalla, la validación de lo que
// guarda Configuración (Costos, Márgenes, Precio) y la migración aditiva del costeo.json viejo
// (la corre a mano scripts/migrar_esquema_canales.js).
const E = require('./precios_esquema');
const { validarGastosVenta } = require('./precios_costeo');
const { normalizarCosteoFraccionado } = require('./precios_fraccionado_costo');

const TIPOS = ['almacen', 'fraccionado', 'produccion'];
// Tipos con configuración propia (switch de Configuración, spec 2026-10-21 §2). Producción usa la de Reventa (la raíz).
const TIPOS_CONFIG = ['almacen', 'fraccionado'];
const CANALES = ['minorista', 'pack', 'bulto'];
const MODOS_GASTOS = ['costo', 'precio'];
const REDONDEO_DEFAULT = Object.freeze({ minorista: 50, packNeto: 50, packIva: 50, bultoNeto: 50, bultoIva: 50 });
const LISTAS_REDONDEO = Object.keys(REDONDEO_DEFAULT);
const REDONDEO_MAX = 10000;
const IVA_DEFAULT_PCT = 21;
const TOLERANCIA_DEFAULT_PCT = 10;
const PCT_MAX = 100;
const ENERGIA_MAX = 100000; // $ por kWh
const AJUSTE_PESO_RANGO = [-100, 100];
const AJUSTES_PESO_MAX = E.AJUSTES_PESO_MAX;

const esNum = v => typeof v === 'number' && Number.isFinite(v);
const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Lo guardado con defaults para lo escalar. Sin margenes por canal (archivo sin migrar, o con los márgenes por tipo de
// antes) → migrado: false: el motor devuelve error 'margen' y la UI pide correr la migración.
function vistaDe(c) {
  return {
    migrado: 'minorista' in objeto(c.margenes),
    ivaVentaPct: esNum(c.ivaVentaPct) ? c.ivaVentaPct : IVA_DEFAULT_PCT,
    toleranciaPct: esNum(c.toleranciaPct) ? c.toleranciaPct : TOLERANCIA_DEFAULT_PCT,
    modoGastos: MODOS_GASTOS.includes(c.modoGastos) ? c.modoGastos : 'costo',
    gastosVenta: Array.isArray(c.gastosVenta) ? c.gastosVenta : [],
    extrasMinorista: Array.isArray(c.extrasMinorista) ? c.extrasMinorista : [],
    margenes: objeto(c.margenes),
    redondeo: { ...REDONDEO_DEFAULT, ...objeto(c.redondeo) },
    costoHora: esNum(c.costoHora) && c.costoHora >= 0 ? c.costoHora : null,
  };
}

// Lo propio de Fraccionado (Configuración › Costeo Fraccionado: máquinas, tramos de tiempo, subrubros, envase por peso, costo de bobina, min/kg y
// máquina por granel), con defaults y la forma vieja ya descartada (lib/precios_fraccionado_costo). costoHora va con la vista.
function propiasFraccionado(f) {
  const { costoHora: _h, ...propias } = normalizarCosteoFraccionado(f);
  return propias;
}

const SOLO_FRACCIONADO = Object.freeze({ almacen: false, fraccionado: true, produccion: false });
const esBloque = v => !!v && typeof v === 'object' && !Array.isArray(v);
// ¿Ya existe costeo.fraccionado? (lo crea scripts/migrar_config_fraccionado.js). Lo usan también los routers de Fraccionado.
const fraccionadoMigrado = costeo => esBloque(objeto(costeo).fraccionado);
const SIN_MIGRAR_FRACCIONADO = 'Fraccionado todavía usa la configuración de Reventa: corré node scripts/migrar_config_fraccionado.js';

// tipo 'fraccionado' → costeo.fraccionado (sus gastos/extras no tienen tildes: se devuelven con tilde sólo Fraccionado para
// que pctItems del motor no cambie). Sin migrar → la raíz, como antes (fraccionadoMigrado false). Cualquier otro tipo → la
// raíz (Reventa y Producción).
function configEsquemaDe(costeo, tipo = 'almacen') {
  const c = objeto(costeo);
  const migrado = fraccionadoMigrado(c);
  if (tipo !== 'fraccionado') return { ...vistaDe(c), fraccionadoMigrado: migrado };
  if (!migrado) return { ...vistaDe(c), fraccionadoMigrado: migrado, ...propiasFraccionado({}) };
  const v = vistaDe(c.fraccionado);
  const conTilde = items => items.map(it => ({ ...it, tipos: SOLO_FRACCIONADO }));
  return { ...v, margenes: { ...v.margenes, mayorista: E.descuentosMayorista(v.margenes.mayorista) }, gastosVenta: conTilde(v.gastosVenta), extrasMinorista: conTilde(v.extrasMinorista), fraccionadoMigrado: migrado, ...propiasFraccionado(c.fraccionado) };
}

// ?tipo= de los endpoints de Configuración: vacío = 'almacen'; inválido (Producción incluida: usa la de Reventa) → null.
const tipoConfig = v => (v == null || v === '' ? 'almacen' : TIPOS_CONFIG.includes(v) ? v : null);

// Body de PUT /api/precios/config/esquema/costo-hora → { costoHora } o throw. Costo hora de mano de obra ($/h) de Producción
// (minutos por unidad × costo hora ÷ 60, lib/precios_produccion). Número finito ≥ 0; null o vacío = sin cargar (MO 0 + aviso).
function validarCostoHora(body) {
  const b = objeto(body);
  if (!('costoHora' in b)) throw new Error('costoHora: falta (número desde 0, o null)');
  const v = b.costoHora;
  if (v == null || v === '') return { costoHora: null };
  if (!esNum(v) || v < 0) throw new Error('costoHora: debe ser un número desde 0 ($ por hora)');
  return { costoHora: v };
}

function validarTipos(t, campo) {
  const o = objeto(t);
  if (!TIPOS.every(k => typeof o[k] === 'boolean')) throw new Error(`${campo}: tildes almacen, fraccionado y produccion (true/false)`);
  return { almacen: o.almacen, fraccionado: o.fraccionado, produccion: o.produccion };
}

// Gastos variables o extras minoristas: [{ id?, concepto, pct, tipos }]. Concepto, pct, ids y total < 100 % con la
// validación de siempre (validarGastosVenta). `listas` ya no se guarda: fase 5. Fraccionado (conTipos false): sin tildes.
function validarItems(items, nombre, conTipos) {
  let base;
  try { base = validarGastosVenta(items); } catch (err) { throw new Error(`${nombre}: ${err.message}`); }
  return base.map((g, i) => {
    const { listas: _listas, tipos: _tipos, ...resto } = g;
    return conTipos ? { ...resto, tipos: validarTipos(items[i].tipos, `${nombre}[${i}].tipos`) } : resto;
  });
}

// Body de PUT /api/precios/config/esquema/costos[?tipo=fraccionado] → { modoGastos, gastosVenta, extrasMinorista } o throw.
function validarCostos(body, tipo = 'almacen') {
  const b = objeto(body);
  if (!MODOS_GASTOS.includes(b.modoGastos)) throw new Error("modoGastos: debe ser 'costo' o 'precio'");
  const conTipos = tipo !== 'fraccionado';
  // valorEnergiaKwh ($/kWh, sólo Fraccionado): clave ausente = no se toca; null/'' = sin cargar. Reventa la ignora.
  const energia = !conTipos && 'valorEnergiaKwh' in b ? { valorEnergiaKwh: validarValorEnergia(b.valorEnergiaKwh) } : {};
  return {
    modoGastos: b.modoGastos,
    gastosVenta: validarItems(b.gastosVenta, 'gastosVenta', conTipos),
    extrasMinorista: validarItems(b.extrasMinorista, 'extrasMinorista', conTipos),
    ...energia,
  };
}
function validarValorEnergia(v) {
  if (v == null || v === '') return null;
  if (!esNum(v) || v < 0 || v > ENERGIA_MAX) throw new Error(`valorEnergiaKwh: número de 0 a ${ENERGIA_MAX} ($ por kWh)`);
  return v;
}

// conFilas (sólo Fraccionado): la tabla manual `filas` se valida y se copia limpia; si no, se descarta antes de validar.
function validarTabla(t, campo, conFilas) {
  const { filas, ...generador } = objeto(t);
  const tabla = conFilas && filas != null ? { ...generador, filas } : generador;
  const err = E.validarTablaMargen(t && typeof t === 'object' ? tabla : t);
  if (err) throw new Error(`${campo}: ${err}`);
  const limpia = { minPct: t.minPct, maxPct: t.maxPct, escalones: t.escalones, rango: { desde: t.rango.desde, hasta: t.rango.hasta } };
  const conEstimado = t.rangoEstimado === true ? { ...limpia, rangoEstimado: true } : limpia;
  return tabla.filas ? { ...conEstimado, filas: tabla.filas.map(f => ({ hasta: f.hasta ?? null, margenPct: f.margenPct })) } : conEstimado;
}

// ponytail: copia chica de validarAjustesPeso de precios_costeo (esa se borra con la curva en la fase 5).
function validarAjustesPeso(aj) {
  if (aj == null) return null;
  const { tramosG, puntos } = objeto(aj);
  if (!Array.isArray(tramosG) || !tramosG.length || tramosG.length > AJUSTES_PESO_MAX) {
    throw new Error(`ajustesPeso.tramosG: lista de 1 a ${AJUSTES_PESO_MAX} pesos`);
  }
  tramosG.forEach((t, i) => {
    if (!esNum(t) || t <= 0 || (i > 0 && t <= tramosG[i - 1])) throw new Error(`ajustesPeso.tramosG[${i}]: pesos en gramos, positivos y ascendentes`);
  });
  const [lo, hi] = AJUSTE_PESO_RANGO;
  if (!Array.isArray(puntos) || puntos.length !== tramosG.length || !puntos.every(p => esNum(p) && p >= lo && p <= hi)) {
    throw new Error(`ajustesPeso.puntos: ${tramosG.length} valores entre ${lo} y ${hi}`);
  }
  return { tramosG: [...tramosG], puntos: [...puntos] };
}

// Descuento al margen para distribuidores (puntos %, Reventa con proveedor distribuidor): número ≥ 0 y < 100; null o
// vacío = sin descuento (no se guarda).
function validarDescuentoDistribuidor(v) {
  if (v == null || v === '') return null;
  if (!esNum(v) || v < 0 || v >= PCT_MAX) throw new Error(`descuentoDistribuidorPct: número desde 0 y menor a ${PCT_MAX} (puntos %)`);
  return v;
}

// Body de PUT /api/precios/config/esquema/margenes → { minorista, pack, bulto[, ajustesPeso][, descuentoDistribuidorPct] } o
// throw. Una tabla por canal para los tres tipos. sinConfigurar no pasa: guardar = configurarlo. rangoEstimado sí (lo saca
// "Recalcular rango"). ajustesPeso (sólo lo usa Fraccionado) lo edita Costeo Fraccionado (margenesConAjustePeso): el del
// body se ignora y queda el de `actuales` (los márgenes guardados del tipo). `filas` (tabla manual) sólo en Fraccionado;
// reemplazo total: una tabla sin `filas` vuelve a la automática.
function validarMargenes(body, actuales, tipo = 'almacen') {
  const b = objeto(body);
  // Fraccionado (2026-11-04): pack/bulto salen de los descuentos de `mayorista`, sus tablas son opcionales. Si vienen se
  // validan; si no, queda lo guardado (no se borran datos) o no hay tabla. minorista sigue obligatoria.
  const opcional = c => tipo === 'fraccionado' && c !== 'minorista' && b[c] == null;
  const tablas = Object.fromEntries(CANALES.flatMap(c => {
    if (!opcional(c)) return [[c, validarTabla(b[c], c, tipo === 'fraccionado')]];
    const guardada = objeto(actuales)[c];
    return guardada ? [[c, guardada]] : [];
  }));
  const dto = validarDescuentoDistribuidor(b.descuentoDistribuidorPct);
  const may = tipo === 'fraccionado' ? margenesMayorista(b, actuales) : null;
  return { ...conAjustesPeso(tablas, objeto(actuales).ajustesPeso), ...(dto != null ? { descuentoDistribuidorPct: dto } : {}),
    ...(may ? { mayorista: may } : {}) };
}

// Descuentos de las presentaciones mayoristas de Fraccionado (spec precios_fraccionado_mayorista_activar, C1):
// mayorista = { descPackPct, descBultoPct }, % desde 0 y menor a 100 (decimales). Reemplazo total como las tablas, salvo
// que sin `mayorista` en el body queda lo guardado (o el default 10/10 al leer); null = vuelve al default.
function margenesMayorista(b, actuales) {
  if (!('mayorista' in b)) return E.descuentosMayorista(objeto(actuales).mayorista);
  if (b.mayorista == null) return { ...E.DESC_MAYORISTA_DEFAULT };
  const m = b.mayorista;
  if (typeof m !== 'object' || Array.isArray(m)) throw new Error('mayorista: debe ser un objeto { descPackPct, descBultoPct }');
  for (const k of ['descPackPct', 'descBultoPct']) {
    if (!E.esDescValido(m[k])) throw new Error(`mayorista.${k}: número desde 0 y menor a ${PCT_MAX} (%)`);
  }
  return { descPackPct: m.descPackPct, descBultoPct: m.descBultoPct };
}

// Body de PUT /api/precios/config/esquema/fraccionado/ajustes-peso { ajustesPeso: { tramosG, puntos } | null } → margenes
// nuevos con ese ajuste (null o sin tramos = sin ajuste: se saca), o throw. No muta margenes.
function margenesConAjustePeso(margenes, body) {
  const b = objeto(body);
  if (!('ajustesPeso' in b)) throw new Error('ajustesPeso: falta ({ tramosG, puntos } o null)');
  const sinTramos = b.ajustesPeso == null || (Array.isArray(objeto(b.ajustesPeso).tramosG) && !b.ajustesPeso.tramosG.length);
  const aj = sinTramos ? null : validarAjustesPeso(b.ajustesPeso);
  const { ajustesPeso: _viejo, ...resto } = objeto(margenes);
  return aj ? { ...resto, ajustesPeso: aj } : resto;
}

function validarPctGeneral(v, campo) {
  if (!esNum(v) || v < 0 || v > PCT_MAX) throw new Error(`${campo}: número entre 0 y ${PCT_MAX}`);
  return v;
}

// Body de PUT /api/precios/config/esquema/precio → { ivaVentaPct, toleranciaPct, redondeo } o throw.
function validarPrecio(body) {
  const b = objeto(body);
  const r = objeto(b.redondeo);
  const redondeo = Object.fromEntries(LISTAS_REDONDEO.map(k => {
    if (!esNum(r[k]) || r[k] < 0 || r[k] > REDONDEO_MAX) throw new Error(`redondeo.${k}: múltiplo entre 0 y ${REDONDEO_MAX} (0 = exacto)`);
    return [k, r[k]];
  }));
  return { ivaVentaPct: validarPctGeneral(b.ivaVentaPct, 'ivaVentaPct'), toleranciaPct: validarPctGeneral(b.toleranciaPct, 'toleranciaPct'), redondeo };
}

// ── Migración aditiva (spec §4) ──────────────────────────────────────────────────────────────────────────
// Agrega lo que falta y no borra claves viejas (las borra la fase 5). Idempotente: cada pieza se agrega sólo si no
// está; sobre un archivo ya migrado devuelve null.
const ID_FINANCIEROS_MINORISTA = 'costos-financieros-minorista';
const todosLosTipos = () => ({ almacen: true, fraccionado: true, produccion: true });
const ESCALONES_INICIALES = 10;
// Sin SIGA no hay costos reales: rango de arranque amplio y rangoEstimado hasta "Recalcular rango". (Derivarlo de la
// curva vieja daba rangos absurdos: con techo = a, Fraccionado arrancaba en $1 y Producción terminaba en 3·10¹⁴.)
const RANGO_INICIAL = Object.freeze({ desde: 100, hasta: 100000 });
const MARGEN_RESPALDO = Object.freeze({ minPct: 30, maxPct: 50 });

// Tabla minorista de arranque: mín/máx = piso/techo de la curva vieja del tipo (respaldo si es inválida).
function tablaInicial(curva) {
  const c = objeto(curva);
  const ok = E.esMargenValido(c.pisoPct) && esNum(c.techoPct) && c.pisoPct <= c.techoPct;
  return {
    minPct: ok ? E.r2(c.pisoPct) : MARGEN_RESPALDO.minPct,
    maxPct: ok ? E.r2(c.techoPct) : MARGEN_RESPALDO.maxPct,
    escalones: ESCALONES_INICIALES, rango: { ...RANGO_INICIAL }, rangoEstimado: true,
  };
}

const conAjustesPeso = (tablas, aj) => (aj && Array.isArray(aj.tramosG) && Array.isArray(aj.puntos)
  ? { ...tablas, ajustesPeso: { tramosG: [...aj.tramosG], puntos: [...aj.puntos] } } : tablas);

// Una tabla por canal para los tres tipos. Minorista desde la curva de Reventa; pack y bulto arrancan como copia,
// marcados "sin configurar" hasta que se guarden. Ajuste por peso: el de la curva de Fraccionado.
function margenesIniciales(curvaGanancia) {
  const cg = objeto(curvaGanancia);
  const min = tablaInicial(cg.almacen);
  return conAjustesPeso({ minorista: min, pack: { ...min, sinConfigurar: true }, bulto: { ...min, sinConfigurar: true } },
    objeto(cg.fraccionado).ajustesPeso);
}

// Márgenes por tipo (la forma de la primera migración: { almacen: {minorista, pack, bulto}, fraccionado: {…, ajustesPeso},
// produccion }) → las tablas de Reventa + el ajuste por peso de Fraccionado.
function colapsarMargenesPorTipo(m) {
  const alm = objeto(m.almacen);
  return conAjustesPeso(Object.fromEntries(CANALES.filter(c => c in alm).map(c => [c, alm[c]])), objeto(m.fraccionado).ajustesPeso);
}

// decisiones { plu: { fuente, fecha } } desde marcadosExportar (fecha) + la fuente de costo de cada marcado:
// costo manual > última compra elegida > sistema. Un fuenteCosto sin marcado no es una decisión.
function decisionesIniciales(c) {
  const manual = objeto(c.costoPorProducto), fuente = objeto(c.fuenteCosto);
  return Object.fromEntries(Object.entries(objeto(c.marcadosExportar)).map(([plu, fecha]) => [plu, {
    fuente: esNum(manual[plu]) && manual[plu] > 0 ? 'manual' : fuente[plu] === 'ultimaCompra' ? 'ultimaCompra' : 'sistema',
    fecha: typeof fecha === 'string' ? fecha : null,
  }]));
}

// → { costeo, claves } (claves = lo que se agregó/cambió) o null si ya estaba migrado. No muta la entrada.
function migrarEsquemaCanales(costeo) {
  const c = objeto(costeo);
  const agregar = {};
  if (!MODOS_GASTOS.includes(c.modoGastos)) agregar.modoGastos = 'costo';
  const gastos = Array.isArray(c.gastosVenta) ? c.gastosVenta : [];
  // "Costos Financieros Minorista" sale de los gastos: lo reemplaza la tabla de extras minoristas.
  if (gastos.some(g => !g || g.id === ID_FINANCIEROS_MINORISTA || !g.tipos)) {
    agregar.gastosVenta = gastos.filter(g => g && g.id !== ID_FINANCIEROS_MINORISTA).map(g => (g.tipos ? g : { ...g, tipos: todosLosTipos() }));
  }
  if (!Array.isArray(c.extrasMinorista)) {
    agregar.extrasMinorista = (Array.isArray(c.conceptosPrecioFinal) ? c.conceptosPrecioFinal : [])
      .map(({ id, concepto, pct }) => ({ id, concepto, pct, tipos: todosLosTipos() }));
  }
  if (!c.margenes) agregar.margenes = margenesIniciales(c.curvaGanancia);
  else if (TIPOS.some(t => t in objeto(c.margenes))) agregar.margenes = colapsarMargenesPorTipo(c.margenes);
  if (!c.redondeo) agregar.redondeo = { ...REDONDEO_DEFAULT };
  if (!c.decisiones) agregar.decisiones = decisionesIniciales(c);
  const claves = Object.keys(agregar);
  return claves.length ? { costeo: { ...c, ...agregar }, claves } : null;
}

// ── Configuración propia de Fraccionado (spec 2026-10-21 §2.2) ─────────────────────────────────────────────
// Crea costeo.fraccionado copiando la raíz: IVA, tolerancia, modo, redondeo, costo hora, márgenes (con el ajuste por peso,
// sin el descuento de distribuidor, que es de Reventa) y los gastos/extras tildados para Fraccionado (sin tildes). Lo propio
// (máquinas, tiempos, …) arranca vacío. → { costeo, claves } o null si ya existe. No muta la entrada. La corre a mano
// scripts/migrar_config_fraccionado.js.
const sinTildes = items => (Array.isArray(items) ? items : [])
  .filter(it => it && it.tipos && it.tipos.fraccionado === true)
  .map(({ tipos: _t, listas: _l, ...resto }) => ({ ...resto }));

function migrarConfigFraccionado(costeo) {
  const c = objeto(costeo);
  if (esBloque(c.fraccionado)) return null;
  const v = vistaDe(c);
  if (!v.migrado) throw new Error('costeo.json sin esquema por canal: corré antes node scripts/migrar_esquema_canales.js');
  const { descuentoDistribuidorPct: _dto, ...margenes } = v.margenes;
  const fraccionado = {
    ivaVentaPct: v.ivaVentaPct, toleranciaPct: v.toleranciaPct, modoGastos: v.modoGastos,
    gastosVenta: sinTildes(c.gastosVenta), extrasMinorista: sinTildes(c.extrasMinorista),
    margenes: structuredClone(margenes), redondeo: { ...v.redondeo }, costoHora: v.costoHora,
    ...structuredClone(propiasFraccionado({})),
  };
  return { costeo: { ...c, fraccionado }, claves: ['fraccionado'] };
}

// ── Limpieza (fase 5, spec §4–§5) ────────────────────────────────────────────────────────────────────
// Claves de costeo.json que ya no lee nadie: curva y ganancia, departamentos y venta base, márgenes propios, conceptos,
// MO/insumos de Fraccionado, marcado y fuente de costo viejos, temporales, marcadores de las migraciones de
// arranque y restos de versiones anteriores. La corre a mano scripts/limpiar_esquema_canales.js.
const CLAVES_MUERTAS_COSTEO = Object.freeze([
  'margenPorProducto', 'fuenteCosto', 'marcadosExportar', 'presentacionesTemporales',
  'minutosFraccionado', 'insumosFraccionado', 'minutosFraccionadoStd', 'insumosFraccionadoStd',
  'curvaGanancia', 'metodoGanancia', 'bandasMarkup', 'markupFraccionado',
  'departamentos', 'ventaBase', 'conceptosGanancia', 'conceptosPrecioFinal', 'precioFinalConceptos', 'margenPropio', 'baseCosto',
  'correccionPresentacion', 'categoriaMaquinaPorProducto', 'insumosPorProducto', 'minutosPorPaqueteManual', 'recetas',
]);
const CLAVES_MUERTAS_PACK_BULTO = Object.freeze(['descPackPct', 'descBultoPct', 'descPorProducto']);
const sinClaves = (o, claves) => Object.fromEntries(Object.entries(o).filter(([k]) => !claves.includes(k)));

// → { datos, quitadas } o null si no había nada que sacar. No muta la entrada.
function limpiarCosteo(costeo) {
  const c = objeto(costeo), pb = objeto(c.packBulto);
  const gastos = Array.isArray(c.gastosVenta) ? c.gastosVenta : [];
  const quitadas = CLAVES_MUERTAS_COSTEO.filter(k => k in c);
  const pbMuertas = CLAVES_MUERTAS_PACK_BULTO.filter(k => k in pb);
  const conListas = gastos.some(g => g && 'listas' in g);
  if (!quitadas.length && !pbMuertas.length && !conListas) return null;
  return {
    datos: {
      ...sinClaves(c, quitadas),
      ...(pbMuertas.length ? { packBulto: sinClaves(pb, pbMuertas) } : {}),
      ...(conListas ? { gastosVenta: gastos.map(g => (g && 'listas' in g ? sinClaves(g, ['listas']) : g)) } : {}),
    },
    quitadas: [...quitadas, ...pbMuertas.map(k => `packBulto.${k}`), ...(conListas ? ['gastosVenta[].listas'] : [])],
  };
}

module.exports = {
  TIPOS, TIPOS_CONFIG, CANALES, REDONDEO_DEFAULT,
  configEsquemaDe, fraccionadoMigrado, SIN_MIGRAR_FRACCIONADO, tipoConfig, validarCostos, validarMargenes, margenesConAjustePeso, validarPrecio, validarCostoHora, migrarEsquemaCanales, migrarConfigFraccionado,
  limpiarCosteo, CLAVES_MUERTAS_COSTEO,
};
