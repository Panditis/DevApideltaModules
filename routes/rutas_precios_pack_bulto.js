'use strict';
const express = require('express');
const path = require('path');
const { configPackBultoSanitizada } = require('../lib/precios_pack_bulto');
const { crearConsultasPrecios } = require('../lib/precios_consultas');

// ── Precios · Pack / Bulto ─────
// Vínculos manuales pack/bulto → producto normal y modo de venta de los pesables (costeo.packBulto). Los precios los
// calcula el esquema (lib/precios_listado_esquema crearMayoristasDe). Sólo lee SIGA; escribe únicamente costeo.packBulto.
const PLU = /^\d{1,12}$/;

module.exports = function crearRutasPreciosPackBulto(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const { vinculosPackBulto, costosPorPlu } = crearConsultasPrecios(deps);

  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  // Aplica cambio(packBultoActual) → packBulto nuevo, valida TODO antes de escribir y guarda sólo
  // esa clave. Devuelve { error } si no valida (no escribe nada).
  function mutarPackBulto(cambio) {
    const costeo = leerCosteo();
    let packBulto;
    try {
      packBulto = configPackBultoSanitizada(cambio(configPackBultoSanitizada(costeo.packBulto)));
    } catch (err) {
      return { error: err.message };
    }
    guardarJSON(COSTEO_PATH, { ...costeo, packBulto });
    return { packBulto };
  }
  const pluDe = req => {
    const plu = String(req.params.plu || '').trim();
    return PLU.test(plu) ? plu : null;
  };
  const sinClave = (obj, clave) => { const { [clave]: _fuera, ...resto } = obj || {}; return resto; };

  router.get('/api/precios/pack-bulto/vinculos', apiRoute(async () => {
    const cfg = configPackBultoSanitizada(leerCosteo().packBulto);
    const { vinculos, sinVincular } = await vinculosPackBulto(cfg.vinculosManuales);
    // Nombre del base de los vínculos manuales (los de SIGA ya lo traen de la query).
    const faltan = vinculos.filter(v => v.baseNombre == null).map(v => v.basePlu);
    const bases = faltan.length ? await costosPorPlu(faltan) : new Map();
    const conNombre = vinculos.map(v => (v.baseNombre != null ? v : { ...v, baseNombre: (bases.get(v.basePlu) || {}).nombre || null }));
    return { vinculos: conNombre, sinVincular };
  }));

  // Modo de venta de un pack/bulto pesable: { modo: 'kg'|'paquete', pesoKg } (peso requerido por paquete,
  // lo valida configPackBultoSanitizada). DELETE lo quita (vuelve a 'kg' con el peso de la fórmula).
  router.put('/api/precios/pack-bulto/venta/:plu', apiRoute(async (req) => {
    const plu = pluDe(req);
    if (!plu) return { error: 'PLU inválido' };
    const { modo, pesoKg = null } = req.body || {};
    const venta = pesoKg == null ? { modo } : { modo, pesoKg };
    const r = mutarPackBulto(pb => ({ ...pb, ventaPesable: { ...pb.ventaPesable, [plu]: venta } }));
    return r.error ? r : { plu, modo, pesoKg };
  }));
  router.delete('/api/precios/pack-bulto/venta/:plu', apiRoute(async (req) => {
    const plu = pluDe(req);
    if (!plu) return { error: 'PLU inválido' };
    const r = mutarPackBulto(pb => ({ ...pb, ventaPesable: sinClave(pb.ventaPesable, plu) }));
    return r.error ? r : { plu, modo: null };
  }));

  // Vínculo manual pack/bulto → producto normal (gana sobre el de SIGA). El base tiene que existir
  // en SIGA: se consulta ANTES de leer costeo.json, así la escritura queda sin await en el medio.
  router.put('/api/precios/pack-bulto/vinculo/:plu', apiRoute(async (req) => {
    const plu = pluDe(req);
    if (!plu) return { error: 'PLU inválido' };
    const { basePlu, tipo } = req.body || {};
    if (!PLU.test(String(basePlu))) return { error: 'basePlu: PLU inválido' };
    if (tipo !== 'pack' && tipo !== 'bulto') return { error: "tipo: debe ser 'pack' o 'bulto'" };
    const siga = await costosPorPlu([String(basePlu)]);
    if (!siga.has(String(basePlu))) return { error: `basePlu: el PLU ${basePlu} no existe en SIGA` };
    const r = mutarPackBulto(pb => ({ ...pb, vinculosManuales: { ...pb.vinculosManuales, [plu]: { basePlu: String(basePlu), tipo } } }));
    return r.error ? r : { plu, basePlu: String(basePlu), tipo, baseNombre: siga.get(String(basePlu)).nombre };
  }));
  router.delete('/api/precios/pack-bulto/vinculo/:plu', apiRoute(async (req) => {
    const plu = pluDe(req);
    if (!plu) return { error: 'PLU inválido' };
    const r = mutarPackBulto(pb => ({ ...pb, vinculosManuales: sinClave(pb.vinculosManuales, plu) }));
    return r.error ? r : { plu, borrado: true };
  }));

  return router;
};
