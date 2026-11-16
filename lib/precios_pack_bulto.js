'use strict';
// Vínculos pack/bulto (rubro "Almacen Bultos/Cajas" o manuales) y su config (vinculosManuales, ventaPesable). Puro. El
// precio lo calcula el esquema.
const RUBRO_GRANEL = 'Pesables Deposito';
const PLU_RE = /^\d{1,12}$/;
const TIPOS = ['pack', 'bulto'];
const MODOS_VENTA = ['kg', 'paquete'];
const PESO_MAX_KG = 1000;

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
// SIGA = exactamente un componente, sin importar el nombre: el nombre sólo decide el tipo cuando lo dice
// (pack/bulto/caja); si es ambiguo, 'bulto'. Si ese componente es un granel, el vínculo va con
// `granel: true`: se muestra en el detalle del granel con su vigente, sin precio sugerido.
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
    const granel = comps.length === 1 && comps[0].baseRubro === RUBRO_GRANEL;
    const motivo = granel ? null : motivoSinVincular(comps);
    if (motivo) sinVincular.push({ plu, nombre, motivo });
    else {
      const [c] = comps;
      vinculos.push({
        plu, nombre, basePlu: c.basePlu, baseNombre: c.baseNombre, cantidad: c.cantidad, tipo: tipo || 'bulto', origen: 'siga',
        ...(granel ? { granel: true } : {}),
      });
    }
  }
  for (const [plu, m] of Object.entries(manuales)) {
    const nombre = porPlu.has(plu) ? porPlu.get(plu).nombre : null;
    vinculos.push({ plu, nombre, basePlu: String(m.basePlu), baseNombre: null, cantidad: null, tipo: m.tipo, origen: 'manual' });
  }
  return { vinculos, sinVincular };
}

function motivoSinVincular(comps) {
  if (!comps.length) return 'sin fórmula activa';
  if (comps.length > 1) return `fórmula con ${comps.length} componentes`;
  return null;
}

const esNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const esPeso = v => esNum(v, 0, PESO_MAX_KG) && v > 0;

function validarPlu(plu, campo) {
  if (!PLU_RE.test(String(plu))) throw new Error(`${campo}: PLU inválido (${plu})`);
  return String(plu);
}
const objeto = v => (v != null && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Config limpia de costeo.packBulto: sólo vinculosManuales y ventaPesable (los descuentos de la fase 4 vieja se descartan).
// Tira ante datos inválidos (PLU no numérico, tipo que no es pack/bulto, vínculo a sí mismo, modo de venta que no es
// kg/paquete, peso fuera de (0, 1000] kg o faltante en modo paquete).
function configPackBultoSanitizada(body) {
  const b = objeto(body);
  const vinculosManuales = {};
  for (const [plu, m] of Object.entries(objeto(b.vinculosManuales))) {
    validarPlu(plu, 'vinculosManuales');
    const { basePlu, tipo } = objeto(m);
    validarPlu(basePlu, `vinculosManuales.${plu}.basePlu`);
    if (!TIPOS.includes(tipo)) throw new Error(`vinculosManuales.${plu}.tipo: debe ser 'pack' o 'bulto'`);
    if (String(basePlu) === plu) throw new Error(`vinculosManuales.${plu}: no se puede vincular a sí mismo`);
    vinculosManuales[plu] = { basePlu: String(basePlu), tipo };
  }
  const ventaPesable = {};
  for (const [plu, m] of Object.entries(objeto(b.ventaPesable))) ventaPesable[validarPlu(plu, 'ventaPesable')] = validarVenta(objeto(m), plu);
  return { vinculosManuales, ventaPesable };
}

function validarVenta({ modo, pesoKg }, plu) {
  if (!MODOS_VENTA.includes(modo)) throw new Error(`ventaPesable.${plu}.modo: debe ser 'kg' o 'paquete'`);
  if (pesoKg == null && modo === 'kg') return { modo };
  if (!esPeso(pesoKg)) throw new Error(`ventaPesable.${plu}.pesoKg: debe ser un número mayor a 0 y hasta ${PESO_MAX_KG} kg`);
  return { modo, pesoKg };
}

module.exports = { tipoPorNombre, armarVinculos, configPackBultoSanitizada };
