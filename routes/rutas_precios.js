'use strict';
const express = require('express');
const path = require('path');
const preciosCosteo = require('../lib/precios_costeo');
const { compararItem } = require('../lib/precios_proveedores');

// ── Rutas del módulo Precios (costeo sugerido) ───────────────────────────────
// Fase 1: listado/detalle/config de Almacén. Fraccionado/Producción llegan en fases
// futuras — comparten el shape de costearAlmacen pero no tienen SQL propia todavía.
//
// data/costeo.json ya nace con el schema completo (bandasMarkup, recetas,
// insumosPorProducto, etc.) para que las fases siguientes no tengan que migrar
// el archivo, pero /api/precios/config expone sólo lo que esta fase usa: costoHora,
// toleranciaPct y costosVariosPctAlmacen (el resto no tiene todavía lógica que lo
// use ni UI que lo edite).
//
// costosVariosPctAlmacen es un campo nuevo (no estaba en el schema original de la
// Fase 0): costearAlmacen() necesita un costosVariosPct global y no había dónde
// leerlo — una iteración de planificación anterior lo tenía por "familia", pero el
// motor actual banda por costo, no por familia. Se agrega como config global única
// en vez de reabrir ese concepto.
module.exports = function crearRutasPrecios(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR, LISTA_PRECIOS_VENTA } = deps;
  const router = express.Router();

  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const COSTEO_DEFAULT = {
    costoHora: 4500, toleranciaPct: 10, costosVariosPctAlmacen: 3,
    bandasMarkup: { almacen: [], fraccionado: [], produccion: [] },
  };

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  router.get('/api/precios/config', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    return {
      costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct,
      costosVariosPctAlmacen: costeo.costosVariosPctAlmacen,
    };
  }));

  // Costo de mercadería del universo Almacén (rubro 'Almacen', activo), sucursal central.
  // Precedente verificado: rutas_distribucion.js:108-110 y rutas_precios_proveedores.js:35-48.
  async function universoAlmacen() {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto, CAST(ps.PrecioCosto AS FLOAT) AS PrecioCosto
      FROM Productos p
      JOIN Rubros r ON r.IdRubro = p.IdRubro
      LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
        AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
      WHERE p.Activo = 1 AND r.NombreRubro = 'Almacen'`);
    return rows.map(r => ({
      plu: String(r.IdProducto), nombre: r.NombreProducto,
      costoMercaderia: r.PrecioCosto != null ? +r.PrecioCosto : null,
    }));
  }

  // Precio vigente de mostrador (sucursal central, lista de venta) por plu. Precedente
  // verificado: rutas_precios_historico.js:63-66 (mismo patrón SUCURSAL_PRECIOS_HIST=1).
  const SUCURSAL_PRECIOS_ALMACEN = 1;
  async function preciosVigentesAlmacen() {
    const rows = await query(`
      SELECT IdProducto, CAST(PrecioVenta AS FLOAT) AS Precio
      FROM ProductosSucursalesPrecios
      WHERE IdSucursal = ${SUCURSAL_PRECIOS_ALMACEN} AND IdListaPrecios = ${LISTA_PRECIOS_VENTA}`);
    return new Map(rows.map(r => [String(r.IdProducto), r.Precio != null ? +r.Precio : null]));
  }

  // Fila completa (costeo + comparación) para todo el universo Almacén. Compartida por
  // listado y detalle — el único lugar que trae las dos queries SQL y las cruza por plu.
  // ponytail: detalle también recalcula el universo entero para traer un solo producto
  // (sin query filtrada por plu) — subir si el universo Almacén crece lo bastante para
  // que el round-trip duela; hoy es el mismo volumen que ya trae /api/precios-proveedores/listado.
  async function filasAlmacen(costeo) {
    const [universo, vigentes] = await Promise.all([universoAlmacen(), preciosVigentesAlmacen()]);
    return universo.map(p => calcularFilaAlmacen({
      plu: p.plu, nombre: p.nombre, costoMercaderia: p.costoMercaderia,
      precioVigente: vigentes.has(p.plu) ? vigentes.get(p.plu) : null,
      costeoConfig: costeo,
    }));
  }

  router.get('/api/precios/listado', apiRoute(async (req) => {
    if (String(req.query.tipo || '') !== 'almacen') return { error: 'tipo no soportado todavía' };
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const filas = await filasAlmacen(costeo);
    // Listado liviano: sin el desglose de componentes (eso es para detalle).
    return filas.map(f => ({
      plu: f.plu, nombre: f.nombre, costoTotal: f.costoTotal, markupPct: f.markupPct, banda: f.banda,
      precioNeto: f.precioNeto, precioConIva: f.precioConIva, precioVigente: f.precioVigente,
      deltaPct: f.deltaPct, semaforo: f.semaforo, faltantes: f.faltantes,
    }));
  }));

  router.get('/api/precios/detalle/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const filas = await filasAlmacen(costeo);
    const fila = filas.find(f => f.plu === plu);
    if (!fila) return { error: `PLU ${plu} no encontrado en el universo Almacén` };
    return fila;
  }));

  router.put('/api/precios/config/bandas-markup', apiRoute(async (req) => {
    const { almacen, fraccionado, produccion } = req.body || {};
    if (!Array.isArray(almacen) || !Array.isArray(fraccionado) || !Array.isArray(produccion)) {
      return { error: 'bandasMarkup requiere los tres arrays: almacen, fraccionado, produccion' };
    }
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    let sanitizado;
    try {
      // configSanitizada valida ANTES de escribir y devuelve el config completo (no pisa
      // el resto de costeo.json: sólo bandasMarkup queda distinto del que ya había).
      sanitizado = preciosCosteo.configSanitizada({ ...costeo, bandasMarkup: { almacen, fraccionado, produccion } });
    } catch (err) {
      return { error: err.message };
    }
    guardarJSON(COSTEO_PATH, sanitizado);
    return { bandasMarkup: sanitizado.bandasMarkup };
  }));

  return router;
};

// Fila calculada para un producto Almacén: costeo (banda + markup + IVA) contra el precio
// vigente de mostrador. Pura — sin SQL/fs — para poder testearla sin base de datos; la SQL
// vive en universoAlmacen/preciosVigentesAlmacen arriba, que son lo único que necesita `query`.
// Comparación IVA-incluido en ambos lados: precioVigente (SIGA) y precioConIva (costeo) son
// ambos brutos — comparar precioVigente contra un neto sería comparar peras con manzanas.
function calcularFilaAlmacen({ plu, nombre, costoMercaderia, precioVigente, costeoConfig }) {
  const cfg = costeoConfig || {};
  const overridePct = (cfg.margenPorProducto || {})[plu];
  const { markupPct, banda } = preciosCosteo.resolverBanda(costoMercaderia, (cfg.bandasMarkup || {}).almacen, overridePct);
  const costeado = preciosCosteo.costearAlmacen({
    costoMercaderia, costosVariosPct: cfg.costosVariosPctAlmacen, markupPct, banda, plu, nombre,
  });
  // compararItem trata precioLista:null como 0 (Number(null)===0), lo que daría un
  // delta -100%/"verde" falso para un producto sin precio de mostrador todavía — no es
  // que esté "regalado", es que no hay dato. Se corta antes de llamarla.
  const { deltaPct, semaforo } = precioVigente != null
    ? compararItem({ precioLista: precioVigente, costoActual: costeado.precioConIva, toleranciaPct: cfg.toleranciaPct })
    : { deltaPct: null, semaforo: null };
  return { ...costeado, precioVigente: precioVigente != null ? precioVigente : null, deltaPct, semaforo };
}

module.exports.calcularFilaAlmacen = calcularFilaAlmacen;
