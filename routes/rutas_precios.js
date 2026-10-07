'use strict';
const express = require('express');
const path = require('path');
const { validarCostosExtra } = require('../lib/precios_costeo');
const { configEsquemaDe } = require('../lib/precios_config_esquema');

// ── Rutas del módulo Precios: página, permiso y costos por producto ───────────────────────────────────
// El esquema por canal (config, listados, decisión, export) vive en rutas_precios_esquema.js; Producción en
// rutas_precios_produccion.js; vínculos y venta de pack/bulto en rutas_precios_pack_bulto.js. Acá quedan la página, lo
// que el front necesita saber del permiso y el costo manual / costos extra por PLU (Reventa y graneles de Fraccionado).
const PLU_COSTEO = /^[\w-]{1,30}$/;
const COSTO_MAX = 1e9;

module.exports = function crearRutasPrecios(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  const sinConfig = req => !!(req && req.preciosSinConfig === true); // lo marca guardPrecios (server.js)

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  // Lo mínimo para el front de cualquier usuario del módulo: si tiene el permiso de Configuración y la tolerancia.
  router.get('/api/precios/config/publica', apiRoute(async (req) => ({
    puedeConfig: !sinConfig(req), toleranciaPct: configEsquemaDe(leerCosteo()).toleranciaPct,
  })));

  // Costos extra de un granel de Fraccionado o de un producto de Reventa (costosExtraFraccionado[plu]: una sola clave para
  // los dos universos, sus PLU no se pisan). body { items: [{ concepto, tipo: 'kg'|'pct', valor }] }; [] borra la entrada.
  router.put('/api/precios/costos-extra/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    if (!PLU_COSTEO.test(plu)) return { error: 'PLU inválido' };
    let items;
    try { items = validarCostosExtra((req.body || {}).items); } catch (err) { return { error: err.message }; }
    const costeo = leerCosteo();
    const { [plu]: _fuera, ...resto } = costeo.costosExtraFraccionado || {};
    guardarJSON(COSTEO_PATH, { ...costeo, costosExtraFraccionado: items.length ? { ...resto, [plu]: items } : resto });
    return { plu, items };
  }));

  // Costo manual (costoPorProducto[plu], neto). body { fuente: 'manual', costo } lo guarda; { fuente: 'sistema' } lo quita
  // y limpia la decisión 'manual' de ese PLU (sin costo manual nunca exportaría).
  router.put('/api/precios/costo-producto/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    if (!PLU_COSTEO.test(plu)) return { error: 'PLU inválido' };
    const { fuente, costo } = req.body || {};
    if (fuente !== 'manual' && fuente !== 'sistema') return { error: "fuente inválida: 'manual' o 'sistema'" };
    const costeo = leerCosteo();
    const { [plu]: _fuera, ...resto } = costeo.costoPorProducto || {};
    if (fuente === 'manual') {
      const n = Number(costo);
      if (costo === null || costo === '' || typeof costo === 'boolean' || !Number.isFinite(n) || n <= 0 || n > COSTO_MAX) {
        return { error: 'valor inválido: debe ser un número mayor a 0' };
      }
      guardarJSON(COSTEO_PATH, { ...costeo, costoPorProducto: { ...resto, [plu]: n } });
      return { plu, fuente, costo: n };
    }
    const { [plu]: decision, ...otras } = costeo.decisiones || {};
    const limpiar = decision && decision.fuente === 'manual';
    guardarJSON(COSTEO_PATH, { ...costeo, costoPorProducto: resto, ...(limpiar ? { decisiones: otras } : {}) });
    return { plu, fuente };
  }));

  return router;
};
