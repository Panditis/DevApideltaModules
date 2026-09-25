'use strict';
// Módulo puro de Pack / Bulto — Precios, Fase 4. Sin fs/SQL/Express.
// Pack y bulto son el mismo producto que su versión normal (el "base") con un descuento % sobre el
// precio sugerido del base: precio = redondearPrecioVenta(sugeridoBase × (1 − desc/100)). El IVA ya
// está en el sugerido del base, no se vuelve a aplicar. Se recalcula solo cuando cambia el base.
const { redondearPrecioVenta, compararConVigente } = require('./precios_costeo');

// Defaults = mediana de (1 − vigente pack|bulto ÷ vigente base) en SIGA (pack n=220, bulto n=576).
// Sólo pesan en pack/bulto sin override: nuevos o sin vigente (el resto se alinea, decisión 6).
const PACK_BULTO_DEFAULT = Object.freeze({ descPackPct: 9.7, descBultoPct: 14.7, descPorProducto: {}, vinculosManuales: {} });
const DESC_MAX = 90;
// Override por producto: puede ser negativo (pack más caro por unidad que el suelto, dato real de SIGA).
const DESC_PRODUCTO_MIN = -50;
const RUBRO_GRANEL = 'Pesables Deposito';
const PLU_RE = /^\d{1,12}$/;
const TIPOS = ['pack', 'bulto'];
// Vigente pack/bulto ÷ vigente base fuera de este rango → probablemente cargado en otra unidad
// (ej. el bulto con el precio de la caja entera).
const RATIO_UNIDAD = [0.5, 1.2];

// 'pack' si el nombre dice Pack; 'bulto' si dice Bulto o Caja; ambos o ninguno → null (ambiguo).
function tipoPorNombre(nombre) {
  const n = String(nombre || '');
  const pack = /\bpack\b/i.test(n);
  const bulto = /\b(bulto|caja)\b/i.test(n);
  if (pack === bulto) return null;
  return pack ? 'pack' : 'bulto';
}

const limpio = v => (v == null ? null : String(v).trim());

// filas = una por componente de fórmula activa de cada producto del rubro 'Almacen Bultos/Cajas'
// ({ plu, nombre, basePlu, cantidad, baseNombre?, baseRubro? }; basePlu null = sin fórmula). Vínculo
// SIGA = exactamente un componente, que no sea granel, y tipo deducible del nombre.
// vinculosManuales { plu: { basePlu, tipo } } gana siempre (baseNombre lo completa el router).
function armarVinculos(filas, vinculosManuales) {
  const porPlu = new Map();
  for (const f of filas || []) {
    const plu = limpio(f.plu);
    if (!porPlu.has(plu)) porPlu.set(plu, { nombre: limpio(f.nombre), comps: [] });
    if (f.basePlu != null) {
      porPlu.get(plu).comps.push({
        basePlu: limpio(f.basePlu), baseNombre: limpio(f.baseNombre), baseRubro: limpio(f.baseRubro),
        cantidad: f.cantidad == null ? null : Number(f.cantidad),
      });
    }
  }
  const manuales = vinculosManuales || {};
  const vinculos = [];
  const sinVincular = [];
  for (const [plu, { nombre, comps }] of porPlu) {
    if (Object.hasOwn(manuales, plu)) continue;
    const tipo = tipoPorNombre(nombre);
    const motivo = motivoSinVincular(comps, tipo);
    if (motivo) sinVincular.push({ plu, nombre, motivo });
    else {
      const [c] = comps;
      vinculos.push({ plu, nombre, basePlu: c.basePlu, baseNombre: c.baseNombre, cantidad: c.cantidad, tipo, origen: 'siga' });
    }
  }
  for (const [plu, m] of Object.entries(manuales)) {
    const nombre = porPlu.has(plu) ? porPlu.get(plu).nombre : null;
    vinculos.push({ plu, nombre, basePlu: String(m.basePlu), baseNombre: null, cantidad: null, tipo: m.tipo, origen: 'manual' });
  }
  return { vinculos, sinVincular };
}

// Bulto de un granel: el granel no tiene precio sugerido propio (se costea por presentación), así
// que no hay contra qué derivar el precio — queda visible en "sin vincular" hasta que se defina.
function motivoSinVincular(comps, tipo) {
  if (!comps.length) return 'sin fórmula activa';
  if (comps.length > 1) return `fórmula con ${comps.length} componentes`;
  if (comps[0].baseRubro === RUBRO_GRANEL) return 'componente es granel (sin precio sugerido propio)';
  return tipo ? null : 'tipo ambiguo por nombre';
}

const esNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const esPct = v => esNum(v, 0, DESC_MAX);
const esPctProducto = v => esNum(v, DESC_PRODUCTO_MIN, DESC_MAX);

// Descuento: override del PLU (descPorProducto) ?? global por tipo ?? default. Base sin precio
// sugerido → faltante 'base' y sin precio (mismo criterio "nunca optimista" del resto del módulo).
// Alineado exacto (como Almacén): si el cálculo queda a < $0,50 del vigente del pack/bulto, se respeta
// el vigente — así, tras "alinear con SIGA", un pack cuyo base está alineado da Δ 0%.
function precioPackBulto({ precioSugeridoBase, tipo, cfg, plu, precioVigente = null }) {
  const c = cfg || {};
  const ov = (c.descPorProducto || {})[plu];
  const descOverride = esPctProducto(ov) ? ov : null;
  const clave = tipo === 'pack' ? 'descPackPct' : 'descBultoPct';
  const descPct = descOverride != null ? descOverride : esPct(c[clave]) ? c[clave] : PACK_BULTO_DEFAULT[clave];
  const base = Number(precioSugeridoBase);
  if (precioSugeridoBase == null || !Number.isFinite(base) || base <= 0) {
    return { descPct, descOverride, precioConIva: null, faltantes: ['base'] };
  }
  const exacto = base * (1 - descPct / 100);
  const alineado = precioVigente > 0 && Math.abs(exacto - precioVigente) < 0.5;
  return { descPct, descOverride, precioConIva: alineado ? precioVigente : redondearPrecioVenta(exacto), faltantes: [] };
}

function validarPct(v, campo, min = 0) {
  if (!esNum(v, min, DESC_MAX)) throw new Error(`${campo}: debe ser un número entre ${min} y ${DESC_MAX}`);
  return v;
}
function validarPlu(plu, campo) {
  if (!PLU_RE.test(String(plu))) throw new Error(`${campo}: PLU inválido (${plu})`);
  return String(plu);
}
const objeto = v => (v != null && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Config limpia de costeo.packBulto: defaults para lo que falte, sólo claves conocidas. Tira ante
// datos inválidos (% fuera de 0–90, PLU no numérico, tipo que no es pack/bulto, vínculo a sí mismo).
function configPackBultoSanitizada(body) {
  const b = objeto(body);
  const descPorProducto = {};
  for (const [plu, v] of Object.entries(objeto(b.descPorProducto))) {
    descPorProducto[validarPlu(plu, 'descPorProducto')] = validarPct(v, `descPorProducto.${plu}`, DESC_PRODUCTO_MIN);
  }
  const vinculosManuales = {};
  for (const [plu, m] of Object.entries(objeto(b.vinculosManuales))) {
    validarPlu(plu, 'vinculosManuales');
    const { basePlu, tipo } = objeto(m);
    validarPlu(basePlu, `vinculosManuales.${plu}.basePlu`);
    if (!TIPOS.includes(tipo)) throw new Error(`vinculosManuales.${plu}.tipo: debe ser 'pack' o 'bulto'`);
    if (String(basePlu) === plu) throw new Error(`vinculosManuales.${plu}: no se puede vincular a sí mismo`);
    vinculosManuales[plu] = { basePlu: String(basePlu), tipo };
  }
  return {
    descPackPct: validarPct(b.descPackPct ?? PACK_BULTO_DEFAULT.descPackPct, 'descPackPct'),
    descBultoPct: validarPct(b.descBultoPct ?? PACK_BULTO_DEFAULT.descBultoPct, 'descBultoPct'),
    descPorProducto, vinculosManuales,
  };
}

// Devuelve packBultoDe(basePlu, precioSugeridoBase) → sub-filas pack/bulto del base, aplicadas sobre
// el precioConIva ya calculado por cada listado (nunca recalcula el base). vigentes: Map plu → precio.
// marcado = el PLU del pack/bulto está en costeo.marcadosExportar (se exporta junto con los bases).
function crearPackBultoDe({ vinculos, vigentes, costeo }) {
  const cfg = (costeo || {}).packBulto || {};
  const tol = (costeo || {}).toleranciaPct;
  const marcados = (costeo || {}).marcadosExportar || {};
  const porBase = new Map();
  for (const v of vinculos || []) {
    if (!porBase.has(v.basePlu)) porBase.set(v.basePlu, []);
    porBase.get(v.basePlu).push(v);
  }
  const vig = plu => vigenteDe(vigentes, plu);
  return (basePlu, precioSugeridoBase) => (porBase.get(String(basePlu)) || []).map(v => {
    const precioVigente = vig(v.plu);
    const p = precioPackBulto({ precioSugeridoBase, tipo: v.tipo, cfg, plu: v.plu, precioVigente });
    const { deltaPct, estado: semaforo } = compararConVigente(p.precioConIva, precioVigente, tol);
    const ratio = ratioVigente(precioVigente, vig(String(basePlu)));
    return {
      plu: v.plu, nombre: v.nombre, tipo: v.tipo, descPct: p.descPct, descOverride: p.descOverride,
      precioSugerido: p.precioConIva, precioVigente, deltaPct, semaforo, faltantes: p.faltantes,
      revisarUnidad: ratio != null && !ratioOk(ratio), marcado: Object.hasOwn(marcados, v.plu),
    };
  });
}

const vigenteDe = (vigentes, plu) => (vigentes && vigentes.has(plu) ? vigentes.get(plu) : null);
const ratioVigente = (vigPB, vigBase) => (vigPB > 0 && vigBase > 0 ? vigPB / vigBase : null);
const ratioOk = ratio => ratio >= RATIO_UNIDAD[0] && ratio <= RATIO_UNIDAD[1];

// Alinear con SIGA (decisión 6): % propio de cada pack/bulto que reproduce su vigente sobre el vigente
// del base, 4 decimales. Sin vigente (de él o del base) o con ratio fuera de 0,5–1,2 (revisar unidad)
// no se alinea: va a omitidos con el motivo. Pura: el router guarda `descuentos` en una sola escritura.
function descuentosAlineados({ vinculos, vigentes }) {
  const descuentos = {};
  const omitidos = [];
  for (const v of vinculos || []) {
    const vigBase = vigenteDe(vigentes, String(v.basePlu));
    const vigPB = vigenteDe(vigentes, v.plu);
    const ratio = ratioVigente(vigPB, vigBase);
    const motivo = !(vigBase > 0) ? 'base sin precio vigente'
      : !(vigPB > 0) ? 'sin precio vigente'
      : !ratioOk(ratio) ? `revisar unidad (vigente ×${+ratio.toFixed(2)} del base)` : null;
    if (motivo) omitidos.push({ plu: v.plu, nombre: v.nombre, motivo });
    else descuentos[v.plu] = +((1 - ratio) * 100).toFixed(4);
  }
  return { descuentos, omitidos };
}

module.exports = {
  PACK_BULTO_DEFAULT, tipoPorNombre, armarVinculos, precioPackBulto, configPackBultoSanitizada, crearPackBultoDe, descuentosAlineados,
};
