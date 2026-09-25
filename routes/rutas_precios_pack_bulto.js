'use strict';
const express = require('express');
const path = require('path');
const { configPackBultoSanitizada, descuentosAlineados } = require('../lib/precios_pack_bulto');
const { crearConsultasPrecios } = require('../lib/precios_consultas');

// ── Precios, Fase 4: Pack / Bulto (config, overrides y vínculos) ─────────────
// Router propio para que rutas_precios.js no se acerque a 800 líneas. Sólo lee SIGA; escribe
// únicamente costeo.packBulto (el resto de costeo.json queda como estaba). El precio de pack/bulto
// se engancha en los listados existentes vía crearPackBultoDe (lib/precios_pack_bulto.js).
const PLU = /^\d{1,12}$/;

module.exports = function crearRutasPreciosPackBulto(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const { vinculosPackBulto, costosPorPlu, preciosVigentesAlmacen } = crearConsultasPrecios(deps);

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
    const { descPackPct, descBultoPct, descPorProducto } = cfg;
    return { config: { descPackPct, descBultoPct, descPorProducto }, vinculos: conNombre, sinVincular };
  }));

  // Alinear con SIGA (decisión 6): % propio por pack/bulto que reproduce su vigente sobre el vigente del
  // base. Pisa esos overrides; los omitidos (sin vigente o revisar unidad) conservan el suyo. Las dos
  // consultas van antes de leer costeo.json: la escritura queda sin await en el medio.
  router.post('/api/precios/pack-bulto/alinear-siga', apiRoute(async () => {
    const manuales = configPackBultoSanitizada(leerCosteo().packBulto).vinculosManuales;
    const [{ vinculos }, vigentes] = await Promise.all([vinculosPackBulto(manuales), preciosVigentesAlmacen()]);
    const { descuentos, omitidos } = descuentosAlineados({ vinculos, vigentes });
    const r = mutarPackBulto(pb => ({ ...pb, descPorProducto: { ...pb.descPorProducto, ...descuentos } }));
    return r.error ? r : { alineados: Object.keys(descuentos).length, omitidos };
  }));

  router.put('/api/precios/config/pack-bulto', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const cambios = Object.fromEntries(['descPackPct', 'descBultoPct'].filter(k => k in body).map(k => [k, body[k]]));
    if (!Object.keys(cambios).length) return { error: 'nada para editar: descPackPct o descBultoPct' };
    const r = mutarPackBulto(pb => ({ ...pb, ...cambios }));
    if (r.error) return r;
    return { descPackPct: r.packBulto.descPackPct, descBultoPct: r.packBulto.descBultoPct };
  }));

  // Override de % por PLU de pack/bulto. DELETE lo quita (vuelve al global del tipo).
  router.put('/api/precios/pack-bulto/descuento/:plu', apiRoute(async (req) => {
    const plu = pluDe(req);
    if (!plu) return { error: 'PLU inválido' };
    const descPct = (req.body || {}).descPct;
    const r = mutarPackBulto(pb => ({ ...pb, descPorProducto: { ...pb.descPorProducto, [plu]: descPct } }));
    return r.error ? r : { plu, descPct };
  }));
  router.delete('/api/precios/pack-bulto/descuento/:plu', apiRoute(async (req) => {
    const plu = pluDe(req);
    if (!plu) return { error: 'PLU inválido' };
    const r = mutarPackBulto(pb => ({ ...pb, descPorProducto: sinClave(pb.descPorProducto, plu) }));
    return r.error ? r : { plu, descPct: null };
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
