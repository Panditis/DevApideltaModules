'use strict';
const express = require('express');
const path = require('path');
const preciosCosteo = require('../lib/precios_costeo');

// ── Rutas del módulo Precios (costeo sugerido) ───────────────────────────────
// Fase 1: listado/detalle/config de Almacén. Fraccionado/Producción llegan en fases
// futuras — comparten el shape de costearAlmacen pero no tienen SQL propia todavía.
//
// data/costeo.json ya nace con el schema completo (bandasMarkup, recetas,
// insumosPorProducto, etc.) para que las fases siguientes no tengan que migrar
// el archivo, pero /api/precios/config expone sólo lo que esta fase usa: costoHora,
// toleranciaPct, costosVariosPctAlmacen y bandasMarkup completo (recetas/insumosPorProducto
// siguen sin lógica ni UI que los use).
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
    costoHora: 4500, toleranciaPct: 10, costosVariosPctAlmacen: 0,
    bandasMarkup: { almacen: [], fraccionado: [], produccion: [] },
    margenPorProducto: {}, costoPorProducto: {}, fuenteCosto: {},
    marcadosExportar: {},
  };

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  router.get('/api/precios/config', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    return {
      costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct,
      costosVariosPctAlmacen: costeo.costosVariosPctAlmacen,
      bandasMarkup: costeo.bandasMarkup,
    };
  }));

  // Universo Almacén (rubro 'Almacen', activo) con sus dos costos posibles:
  // - CostoSistema: ProductosSucursales.PrecioCosto de SIGA (fuente por defecto). Trae el IVA
  //   de compra adentro, así que se usa sin IVA (costoSistemaSinIva, con Productos.Alicuota)
  //   — si no, costearAlmacen volvería a sumar IVA y daría doble IVA.
  // - CostoCompra: última compra NETA (UltimoPrecioCompra del proveedor con compra más
  //   reciente, mismo origen que ultimoProveedorPorProducto en rutas_precios_proveedores.js),
  //   elegible por producto (fuenteCosto[plu] = 'ultimaCompra').
  async function universoAlmacen() {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto, uc.Precio AS CostoCompra, uc.Proveedor,
        CAST(ps.PrecioCosto AS FLOAT) AS CostoSistema, CAST(p.Alicuota AS FLOAT) AS IvaCompraPct,
        CONVERT(varchar(10), uc.FechaCompra, 23) AS FechaCompraTxt,
        CASE WHEN CAST(uc.FechaCompra AS date) = CAST(GETDATE() AS date) THEN 1 ELSE 0 END AS IngresoHoy
      FROM Productos p
      JOIN Rubros r ON r.IdRubro = p.IdRubro
      LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
        AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
      OUTER APPLY (
        SELECT TOP 1 CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
          pv.NombreProveedor AS Proveedor, pp.UltimaFechaCompra AS FechaCompra
        FROM ProductosProveedores pp
        LEFT JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
        WHERE pp.IdProducto = p.IdProducto AND pp.UltimaFechaCompra IS NOT NULL AND pp.UltimoPrecioCompra > 0
        ORDER BY pp.UltimaFechaCompra DESC
      ) uc
      -- IvaCompraPct = Productos.Alicuota: el propio campo de IVA del producto en SIGA (el que
      -- SIGA usa para su "costo sin IVA"). Null → costoSistemaSinIva asume 21% y marca ivaSupuesto.
      WHERE p.Activo = 1 AND r.NombreRubro = 'Almacen'`);
    // "Ingreso hoy" = la última fecha de compra del producto es hoy (fecha del server SQL,
    // ProductosProveedores.UltimaFechaCompra). Si hace falta una fuente más estricta
    // (documento de Compras del día), cambiarla acá.
    return rows.map(r => {
      // Costo de sistema SIGA (fuente por defecto): se usa SIN IVA.
      const sis = costoSistemaSinIva(r.CostoSistema, r.IvaCompraPct);
      return {
      plu: String(r.IdProducto), nombre: r.NombreProducto,
      costoMercaderia: r.CostoCompra != null ? +r.CostoCompra : null,
      costoSistema: sis.costo,
      costoSistemaConIva: r.CostoSistema != null && +r.CostoSistema > 0 ? +r.CostoSistema : null,
      ivaCompraPct: sis.ivaPct, ivaCompraSupuesto: sis.ivaSupuesto,
      proveedor: r.Proveedor || null, fechaUltimaCompra: r.FechaCompraTxt || null,
      ingresoHoy: r.IngresoHoy === 1,
      };
    });
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
    const marcados = costeo.marcadosExportar || {};
    return universo.map(p => ({
      ...calcularFilaAlmacen({
        plu: p.plu, nombre: p.nombre, costoMercaderia: p.costoMercaderia, costoSistema: p.costoSistema,
        precioVigente: vigentes.has(p.plu) ? vigentes.get(p.plu) : null,
        costeoConfig: costeo,
      }),
      proveedor: p.proveedor, fechaUltimaCompra: p.fechaUltimaCompra, ingresoHoy: p.ingresoHoy,
      costoSistemaConIva: p.costoSistemaConIva, ivaCompraPct: p.ivaCompraPct, ivaCompraSupuesto: p.ivaCompraSupuesto,
      marcado: Object.prototype.hasOwnProperty.call(marcados, p.plu),
    }));
  }

  router.get('/api/precios/listado', apiRoute(async (req) => {
    if (String(req.query.tipo || '') !== 'almacen') return { error: 'tipo no soportado todavía' };
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const filas = await filasAlmacen(costeo);
    // Listado liviano: sin el desglose de componentes (eso es para detalle).
    return filas.map(f => ({
      plu: f.plu, nombre: f.nombre, costoTotal: f.costoTotal, markupPct: f.markupPct, banda: f.banda,
      markupBanda: f.markupBanda, markupOverride: f.markupOverride, costoOverride: f.costoOverride, costoFuente: f.costoFuente,
      precioNeto: f.precioNeto, precioConIva: f.precioConIva, precioVigente: f.precioVigente,
      deltaPct: f.deltaPct, semaforo: f.semaforo, faltantes: f.faltantes,
      proveedor: f.proveedor, fechaUltimaCompra: f.fechaUltimaCompra, ingresoHoy: f.ingresoHoy,
      marcado: f.marcado,
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

  // Config general (cualquier subconjunto). Valida todo antes de escribir y sólo toca esas claves.
  const LIMITES_GENERAL = { toleranciaPct: 100, costoHora: 10000000, costosVariosPctAlmacen: 100 };
  router.put('/api/precios/config/general', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const cambios = {};
    for (const [clave, max] of Object.entries(LIMITES_GENERAL)) {
      if (!(clave in body)) continue;
      const raw = body[clave];
      const n = Number(raw);
      if (raw === null || raw === '' || typeof raw === 'boolean' || !Number.isFinite(n) || n < 0 || n > max) {
        return { error: `${clave} inválido: debe ser un número entre 0 y ${max}` };
      }
      cambios[clave] = n;
    }
    const costeo = { ...leerJSON(COSTEO_PATH, COSTEO_DEFAULT), ...cambios };
    guardarJSON(COSTEO_PATH, costeo);
    return { costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct, costosVariosPctAlmacen: costeo.costosVariosPctAlmacen };
  }));

  // Valores manuales por producto en costeo.json (un mapa plu → número). valor null quita
  // la entrada (vuelve al automático). Sólo toca esa clave del archivo.
  function guardarValorProducto({ clave, plu, raw, min, max, excluirMin }) {
    if (!/^[\w-]{1,30}$/.test(plu)) return { error: 'PLU inválido' };
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const mapa = { ...(costeo[clave] || {}) };
    if (raw === null) {
      delete mapa[plu];
    } else {
      const n = Number(raw);
      const bajoMin = excluirMin ? n <= min : n < min;
      if (raw === '' || typeof raw === 'boolean' || !Number.isFinite(n) || bajoMin || n > max) {
        return { error: `valor inválido: debe ser un número ${excluirMin ? 'mayor a' : 'entre'} ${min}${excluirMin ? '' : ` y ${max}`}` };
      }
      mapa[plu] = n;
    }
    guardarJSON(COSTEO_PATH, { ...costeo, [clave]: mapa });
    return { plu, valor: mapa[plu] ?? null };
  }

  // Markup propio (margenPorProducto[plu]): pisa la banda por costo. { markupPct: null } lo quita.
  const MARKUP_MAX_PCT = 1000;
  router.put('/api/precios/margen-producto/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'margenPorProducto', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).markupPct, min: 0, max: MARKUP_MAX_PCT,
  })));

  // Fuente del costo base de un producto ('sistema' = PrecioCosto de SIGA sin IVA, ver
  // costoSistemaSinIva). body { fuente: 'ultimaCompra' | 'sistema' | 'manual',
  // costo? }. 'sistema' (default) borra ambas marcas; 'ultimaCompra' marca fuenteCosto[plu];
  // 'manual' guarda costoPorProducto[plu] (neto sin IVA), que gana sobre cualquier fuente.
  const COSTO_MAX = 1e9;
  const FUENTES_COSTO = ['ultimaCompra', 'sistema', 'manual'];
  router.put('/api/precios/costo-producto/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const { fuente, costo } = req.body || {};
    if (!FUENTES_COSTO.includes(fuente)) return { error: `fuente inválida: ${FUENTES_COSTO.join(', ')}` };
    if (fuente === 'manual') {
      const r = guardarValorProducto({ clave: 'costoPorProducto', plu, raw: costo, min: 0, max: COSTO_MAX, excluirMin: true });
      if (r.error) return r;
      guardarValorProducto({ clave: 'fuenteCosto', plu, raw: null });
      return { plu, fuente, costo: r.valor };
    }
    const r = guardarValorProducto({ clave: 'costoPorProducto', plu, raw: null });
    if (r.error) return r;
    if (fuente === 'ultimaCompra') {
      const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
      guardarJSON(COSTEO_PATH, { ...costeo, fuenteCosto: { ...(costeo.fuenteCosto || {}), [plu]: 'ultimaCompra' } });
    } else {
      guardarValorProducto({ clave: 'fuenteCosto', plu, raw: null });
    }
    return { plu, fuente };
  }));

  // Productos marcados para actualizar precio en SIGA (exportación xlsx client-side).
  // marcadosExportar = { [plu]: 'YYYY-MM-DD' } (fecha en que se marcó). Compartido entre PCs.
  const MARCADOS_MAX = 5000;
  router.put('/api/precios/marcados', apiRoute(async (req) => {
    const { plus, marcado } = req.body || {};
    if (!Array.isArray(plus) || !plus.length || plus.length > MARCADOS_MAX) {
      return { error: `plus debe ser una lista de 1 a ${MARCADOS_MAX} PLUs` };
    }
    if (!plus.every(p => typeof p === 'string' && /^[\w-]{1,30}$/.test(p))) return { error: 'PLU inválido' };
    if (typeof marcado !== 'boolean') return { error: 'marcado debe ser true o false' };
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const d = new Date();
    const hoy = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const mapa = aplicarMarcados(costeo.marcadosExportar, plus, marcado, hoy);
    guardarJSON(COSTEO_PATH, { ...costeo, marcadosExportar: mapa });
    return { marcados: Object.keys(mapa) };
  }));

  router.delete('/api/precios/marcados', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    guardarJSON(COSTEO_PATH, { ...costeo, marcadosExportar: {} });
    return { marcados: [] };
  }));

  return router;
};

// Agrega (marcado=true) o quita PLUs del mapa { plu: fecha }. Devuelve un objeto nuevo;
// re-marcar un PLU ya marcado conserva la fecha original.
function aplicarMarcados(mapaActual, plus, marcado, fecha) {
  const mapa = { ...(mapaActual || {}) };
  for (const plu of plus) {
    if (marcado) { if (!Object.prototype.hasOwnProperty.call(mapa, plu)) mapa[plu] = fecha; }
    else delete mapa[plu];
  }
  return mapa;
}

// Fila calculada para un producto Almacén: costeo (banda + markup + IVA) contra el precio
// vigente de mostrador. Pura — sin SQL/fs — para poder testearla sin base de datos; la SQL
// vive en universoAlmacen/preciosVigentesAlmacen arriba, que son lo único que necesita `query`.
// Comparación IVA-incluido en ambos lados: precioVigente (SIGA) y precioConIva (costeo) son
// ambos brutos — comparar precioVigente contra un neto sería comparar peras con manzanas.
function calcularFilaAlmacen({ plu, nombre, costoMercaderia, costoSistema = null, precioVigente, costeoConfig }) {
  const cfg = costeoConfig || {};
  // Costo base, por prioridad: manual (costoPorProducto[plu]) → última compra sin IVA
  // (costoMercaderia) si el producto eligió esa fuente (fuenteCosto[plu] === 'ultimaCompra')
  // → costo de sistema SIGA sin IVA (default). La banda se busca por el costo que efectivamente se usa.
  const manual = (cfg.costoPorProducto || {})[plu];
  const costoOverride = typeof manual === 'number' && Number.isFinite(manual) && manual > 0 ? manual : null;
  const costoFuente = costoOverride != null ? 'manual'
    : (cfg.fuenteCosto || {})[plu] === 'ultimaCompra' ? 'ultimaCompra' : 'sistema';
  const costoBase = costoFuente === 'manual' ? costoOverride
    : costoFuente === 'ultimaCompra' ? costoMercaderia
    : (costoSistema != null ? costoSistema : null);
  const overridePct = (cfg.margenPorProducto || {})[plu];
  const bandasAlmacen = (cfg.bandasMarkup || {}).almacen;
  const { markupPct, banda } = preciosCosteo.resolverBanda(costoBase, bandasAlmacen, overridePct);
  // Lo que daría la banda sin override: el detalle lo muestra al lado del markup propio.
  const markupBanda = preciosCosteo.resolverBanda(costoBase, bandasAlmacen).markupPct;
  const markupOverride = typeof overridePct === 'number' && Number.isFinite(overridePct) ? overridePct : null;
  const costosVariosPct = Number(cfg.costosVariosPctAlmacen) || 0;
  const costeado = preciosCosteo.costearAlmacen({
    costoMercaderia: costoBase, costosVariosPct, markupPct, banda, plu, nombre,
  });
  // semaforo: 'ok' | 'subir' | 'bajar' | null (sin vigente o sin precio sugerido).
  const { deltaPct, estado: semaforo } = preciosCosteo.compararConVigente(costeado.precioConIva, precioVigente, cfg.toleranciaPct);
  return {
    ...costeado, markupBanda, markupOverride,
    costoBase: costoBase != null ? costoBase : null, costoOverride, costoFuente,
    costoSistema: costoSistema != null ? costoSistema : null,
    precioUltimaCompra: costoMercaderia != null ? costoMercaderia : null, costosVariosPct,
    precioVigente: precioVigente != null ? precioVigente : null, deltaPct, semaforo,
  };
}

// ProductosSucursales.PrecioCosto viene con el IVA de compra adentro. Se saca con la alícuota
// del producto en SIGA (Productos.Alicuota — el mismo campo que usa SIGA para su "costo sin
// IVA"). Si el producto no tiene alícuota cargada se asume 21% y se marca ivaSupuesto para
// que la UI lo avise.
const IVA_COMPRA_SUPUESTO = 21;
function costoSistemaSinIva(precioCostoConIva, ivaCompraPct) {
  const bruto = Number(precioCostoConIva);
  const conocido = ivaCompraPct != null && Number.isFinite(Number(ivaCompraPct));
  const ivaPct = conocido ? Number(ivaCompraPct) : IVA_COMPRA_SUPUESTO;
  if (precioCostoConIva == null || !Number.isFinite(bruto) || bruto <= 0) {
    return { costo: null, ivaPct, ivaSupuesto: !conocido };
  }
  return { costo: Math.round((bruto / (1 + ivaPct / 100)) * 100) / 100, ivaPct, ivaSupuesto: !conocido };
}

module.exports.calcularFilaAlmacen = calcularFilaAlmacen;
module.exports.costoSistemaSinIva = costoSistemaSinIva;
module.exports.aplicarMarcados = aplicarMarcados;
