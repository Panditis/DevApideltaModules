'use strict';
const express = require('express');
const path = require('path');
const preciosCosteo = require('../lib/precios_costeo');
const { pesoTokenKg } = require('../lib/producto_carga');

// ── Rutas del módulo Precios (costeo sugerido) ───────────────────────────────
// Fase 1: listado/detalle/config de Almacén. Fase 2: Fraccionado (listado agrupado por granel). Producción llega
// en una fase futura — comparte el shape de costearAlmacen pero no tiene SQL propia todavía.
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
    // costosExtraFraccionado guarda los costos extra por PLU de Fraccionado (granel) Y de Almacén
    // (producto): los PLU de los dos universos no se pisan, así que una sola clave alcanza. El
    // nombre quedó de cuando sólo existía Fraccionado; renombrarla obligaría a migrar costeo.json
    // de cada instalación por un cambio cosmético — no vale la pena.
    marcadosExportar: {}, costosExtraFraccionado: {},
    // Presentaciones simuladas (sin código en SIGA) por granel: { [granelPlu]: [{ id, pesoG, markupPct, nombre? }] }.
    presentacionesTemporales: {},
    markupFraccionado: MARKUP_FRACCIONADO_DEFAULT,
  };

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  router.get('/api/precios/config', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    return {
      costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct,
      costosVariosPctAlmacen: costeo.costosVariosPctAlmacen,
      bandasMarkup: costeo.bandasMarkup,
      markupFraccionado: costeo.markupFraccionado || MARKUP_FRACCIONADO_DEFAULT,
    };
  }));

  // Costo de sistema (sucursal central) + última compra neta de un producto `p`. Compartido
  // por Almacén y el granel de Fraccionado: un solo criterio de "costo" para los dos tabs.
  const SQL_COSTOS_PRODUCTO = `
      LEFT JOIN ProductosSucursales ps ON ps.IdProducto = p.IdProducto
        AND ps.IdSucursal = (SELECT MIN(IdSucursal) FROM Sucursales WHERE SoyLaCentral = 1)
      OUTER APPLY (
        SELECT TOP 1 CAST(pp.UltimoPrecioCompra AS FLOAT) AS Precio,
          pv.NombreProveedor AS Proveedor, pp.UltimaFechaCompra AS FechaCompra
        FROM ProductosProveedores pp
        LEFT JOIN Proveedores pv ON pv.IdProveedor = pp.IdProveedor
        WHERE pp.IdProducto = p.IdProducto AND pp.UltimaFechaCompra IS NOT NULL AND pp.UltimoPrecioCompra > 0
        ORDER BY pp.UltimaFechaCompra DESC
      ) uc`;

  // Productos activos con sus dos costos posibles (compartido por Almacén y el granel de Fraccionado):
  // - CostoSistema: ProductosSucursales.PrecioCosto de SIGA (fuente por defecto). Trae el IVA
  //   de compra adentro, así que se usa sin IVA (costoSistemaSinIva, con Productos.Alicuota)
  //   — si no, costearAlmacen volvería a sumar IVA y daría doble IVA.
  // - CostoCompra: última compra NETA (UltimoPrecioCompra del proveedor con compra más
  //   reciente, mismo origen que ultimoProveedorPorProducto en rutas_precios_proveedores.js),
  //   elegible por producto (fuenteCosto[plu] = 'ultimaCompra').
  // `filtroSql` es siempre una constante de este archivo o un IN de ids ya validados, nunca input crudo.
  async function productosConCostos(filtroSql) {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto, uc.Precio AS CostoCompra, uc.Proveedor,
        CAST(ps.PrecioCosto AS FLOAT) AS CostoSistema, CAST(p.Alicuota AS FLOAT) AS IvaCompraPct,
        CONVERT(varchar(10), uc.FechaCompra, 23) AS FechaCompraTxt,
        -- "Ingreso hoy" = el producto está en un comprobante de compra CARGADO hoy en SIGA
        -- (Compras.FechaActualizacion), no con fecha de factura de hoy: una factura del 15/9
        -- ingresada hoy tiene Fecha=15/9 y FechaActualizacion=hoy. Mismo join que rutas_compras.js.
        CASE WHEN EXISTS (
          SELECT 1 FROM ComprasProductos cp
          JOIN Compras c ON c.IdSucursal=cp.IdSucursal AND c.IdTipoComprobante=cp.IdTipoComprobante
            AND c.Letra=cp.Letra AND c.CentroEmisor=cp.CentroEmisor AND c.NumeroComprobante=cp.NumeroComprobante
            AND c.IdProveedor=cp.IdProveedor
          WHERE cp.IdProducto = p.IdProducto AND c.FechaActualizacion >= CAST(GETDATE() AS date)
        ) THEN 1 ELSE 0 END AS IngresoHoy
      FROM Productos p
      LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
      ${SQL_COSTOS_PRODUCTO}
      -- IvaCompraPct = Productos.Alicuota: el propio campo de IVA del producto en SIGA (el que
      -- SIGA usa para su "costo sin IVA"). Null → costoSistemaSinIva asume 21% y marca ivaSupuesto.
      WHERE ${filtroSql}`);
    return rows.map(r => {
      // Costo de sistema SIGA (fuente por defecto): se usa SIN IVA.
      const sis = costoSistemaSinIva(r.CostoSistema, r.IvaCompraPct);
      return {
        plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim(),
        costoMercaderia: r.CostoCompra != null ? +r.CostoCompra : null,
        costoSistema: sis.costo,
        costoSistemaConIva: r.CostoSistema != null && +r.CostoSistema > 0 ? +r.CostoSistema : null,
        ivaCompraPct: sis.ivaPct, ivaCompraSupuesto: sis.ivaSupuesto,
        proveedor: r.Proveedor || null, fechaUltimaCompra: r.FechaCompraTxt || null,
        ingresoHoy: r.IngresoHoy === 1,
      };
    });
  }

  // Universo Almacén: rubro 'Almacen', activo. (Los graneles no filtran Activo: un granel referenciado
  // por fórmula se costea aunque esté inactivo, como antes.)
  const universoAlmacen = () => productosConCostos(`p.Activo = 1 AND r.NombreRubro = 'Almacen'`);

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

  // ── Fraccionado ────────────────────────────────────────────────────────────
  // Graneles = rubro 'Pesables Deposito'; presentaciones = rubro 'Pesables Fraccionado' (mismo
  // filtro que rutas_fraccionado_externo), unidas por pesables_listas.formulas[plu].granel.
  // `rubro` es siempre una constante de este archivo, nunca input del request.
  async function productosDeRubro(rubro) {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto
      FROM Productos p JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE p.Activo = 1 AND r.NombreRubro = '${rubro}'`);
    return rows.map(r => ({ plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim() }));
  }

  // Costos de los graneles (mismo shape que el universo Almacén). Los IdProducto vienen de
  // SIGA/pesables_listas.json (no del request); igual se filtran por formato antes de interpolarlos.
  // IdProducto es varchar (hay códigos no numéricos): con un IN de ints SQL Server convierte
  // toda la columna a int y revienta. Van como strings, igual que en rutas_compras.js.
  async function costosGranel(granelPlus) {
    const ids = [...new Set(granelPlus.map(String).filter(id => /^[\w-]{1,30}$/.test(id)))];
    if (!ids.length) return new Map();
    const rows = await productosConCostos(`p.IdProducto IN (${ids.map(id => `'${id}'`).join(',')})`);
    return new Map(rows.map(r => [r.plu, r]));
  }

  async function gruposFraccionado(costeo) {
    const [graneles, presentaciones, vigentes] = await Promise.all([
      productosDeRubro('Pesables Deposito'), productosDeRubro('Pesables Fraccionado'), preciosVigentesAlmacen(),
    ]);
    const formulas = (leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas || {};
    const referenciados = presentaciones.map(p => granelDe(formulas, p.plu)).filter(Boolean);
    const costos = await costosGranel([...graneles.map(g => g.plu), ...referenciados]);
    return armarGruposFraccionado({ graneles, presentaciones, formulas, costos, vigentes, costeoConfig: costeo });
  }

  router.get('/api/precios/listado', apiRoute(async (req) => {
    const tipo = String(req.query.tipo || '');
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    if (tipo === 'fraccionado') return gruposFraccionado(costeo);
    if (tipo !== 'almacen') return { error: 'tipo no soportado todavía' };
    const filas = await filasAlmacen(costeo);
    // Listado liviano: sin el desglose de componentes (eso es para detalle).
    return filas.map(f => ({
      plu: f.plu, nombre: f.nombre, costoBase: f.costoBase, costoTotal: f.costoTotal, markupPct: f.markupPct, banda: f.banda,
      markupBanda: f.markupBanda, markupOverride: f.markupOverride, costoOverride: f.costoOverride, costoFuente: f.costoFuente,
      costosExtra: f.costosExtra, costoExtraTotal: f.costoExtraTotal,
      precioNeto: f.precioNeto, precioConIva: f.precioConIva, precioVigente: f.precioVigente,
      deltaPct: f.deltaPct, semaforo: f.semaforo, faltantes: f.faltantes,
      proveedor: f.proveedor, fechaUltimaCompra: f.fechaUltimaCompra, ingresoHoy: f.ingresoHoy,
      marcado: f.marcado,
    }));
  }));

  router.get('/api/precios/detalle/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    if (String(req.query.tipo || '') === 'fraccionado') {
      // ponytail: arma todos los grupos para devolver uno (mismo criterio que Almacén abajo).
      const grupo = (await gruposFraccionado(costeo)).find(g => g.granelPlu === plu);
      return grupo || { error: `Granel ${plu} no encontrado en Fraccionado` };
    }
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
  // Mínimo negativo: un precio de SIGA por debajo del costo es dato real (ver alinear-siga).
  const MARKUP_MIN_PCT = -99;
  const MARKUP_MAX_PCT = 1000;
  router.put('/api/precios/margen-producto/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'margenPorProducto', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).markupPct, min: MARKUP_MIN_PCT, max: MARKUP_MAX_PCT,
  })));

  // Margen standard Fraccionado (matriz banda de costo × tramo de peso). Valida antes de escribir.
  router.put('/api/precios/config/markup-fraccionado', apiRoute(async (req) => {
    const { bandas, tramosG, markupPct } = req.body || {};
    const matriz = { bandas, tramosG, markupPct };
    try {
      preciosCosteo.validarMarkupFraccionado(matriz);
    } catch (err) {
      return { error: err.message };
    }
    guardarJSON(COSTEO_PATH, { ...leerJSON(COSTEO_PATH, COSTEO_DEFAULT), markupFraccionado: matriz });
    return { markupFraccionado: matriz };
  }));

  // Alinear con SIGA: markup propio por producto que reproduce su precio vigente con el costo
  // actual. Pisa los margenPorProducto de esos productos; sólo toca esa clave de costeo.json.
  router.post('/api/precios/alinear-siga', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const [filas, grupos] = await Promise.all([filasAlmacen(costeo), gruposFraccionado(costeo)]);
    // Fraccionado: cada presentación se alinea con el costo total $/kg de su granel (base +
    // costos extra, el mismo para todas).
    const presentaciones = grupos.flatMap(g => g.presentaciones.map(p => ({
      plu: p.plu, costoTotal: g.costoTotal, precioVigente: p.precioVigente,
    })));
    const { markups, alineados, sinDatos, negativos } = markupsAlineadosConSiga([...filas, ...presentaciones]);
    const actual = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    guardarJSON(COSTEO_PATH, { ...actual, margenPorProducto: { ...(actual.margenPorProducto || {}), ...markups } });
    return { alineados, sinDatos, negativos };
  }));

  // Costos extra de un granel de Fraccionado o de un producto de Almacén (misma clave, ver
  // COSTEO_DEFAULT): body { items: [{ concepto, tipo: 'kg'|'pct', valor }] } — 'kg' es $/kg en
  // Fraccionado y $ por unidad en Almacén. items [] borra la entrada. Valida todo antes de
  // escribir; sólo toca costosExtraFraccionado.
  router.put('/api/precios/costos-extra/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    if (!/^[\w-]{1,30}$/.test(plu)) return { error: 'PLU inválido' };
    let items;
    try {
      items = preciosCosteo.validarCostosExtra((req.body || {}).items);
    } catch (err) {
      return { error: err.message };
    }
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const mapa = { ...(costeo.costosExtraFraccionado || {}) };
    if (items.length) mapa[plu] = items; else delete mapa[plu];
    guardarJSON(COSTEO_PATH, { ...costeo, costosExtraFraccionado: mapa });
    return { plu, items };
  }));

  // Presentaciones temporales de Fraccionado (simular un peso que todavía no tiene código en SIGA).
  // Nunca se marcan, exportan ni alinean: viven sólo en costeo.presentacionesTemporales.
  // ponytail: no se verifica que el granel exista en SIGA (haría falta SQL); una temporal de un
  // plu inexistente simplemente no aparece en ningún grupo.
  const ID_TEMPORAL = /^t-[a-z0-9]{1,24}$/;
  function guardarTemporal(req, op) {
    const plu = String(req.params.granelPlu || '').trim();
    if (!/^[\w-]{1,30}$/.test(plu)) return { error: 'PLU inválido' };
    const id = op === 'crear'
      ? `t-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
      : String(req.params.id || '');
    if (!ID_TEMPORAL.test(id)) return { error: 'id de presentación temporal inválido' };
    let datos = null;
    if (op !== 'borrar') {
      try {
        datos = preciosCosteo.validarPresentacionTemporal(req.body, { parcial: op === 'editar' });
      } catch (err) {
        return { error: err.message };
      }
    }
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const r = aplicarTemporal(costeo.presentacionesTemporales, plu, { op, id, datos });
    if (r.error) return r;
    guardarJSON(COSTEO_PATH, { ...costeo, presentacionesTemporales: r.mapa });
    return { granelPlu: plu, temporal: r.item, temporales: r.mapa[plu] || [] };
  }
  router.post('/api/precios/presentaciones-temporales/:granelPlu', apiRoute(async (req) => guardarTemporal(req, 'crear')));
  router.put('/api/precios/presentaciones-temporales/:granelPlu/:id', apiRoute(async (req) => guardarTemporal(req, 'editar')));
  router.delete('/api/precios/presentaciones-temporales/:granelPlu/:id', apiRoute(async (req) => guardarTemporal(req, 'borrar')));

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

// Alta/edición/baja de una presentación temporal sobre el mapa { granelPlu: [...] }. Pura: devuelve
// { mapa, item } nuevos (sin mutar la entrada) o { error }. datos ya validados
// (validarPresentacionTemporal); en editar, nombre: null lo quita. Sin temporales se borra la entrada.
const TEMPORALES_MAX = 30;
function aplicarTemporal(mapaActual, granelPlu, { op, id, datos }) {
  const mapa = { ...(mapaActual || {}) };
  const lista = Array.isArray(mapa[granelPlu]) ? mapa[granelPlu] : [];
  let item = null;
  if (op === 'crear') {
    if (lista.length >= TEMPORALES_MAX) return { error: `máximo ${TEMPORALES_MAX} presentaciones temporales por granel` };
    item = { id, ...datos };
    mapa[granelPlu] = [...lista, item];
    return { mapa, item };
  }
  const actual = lista.find(t => t.id === id);
  if (!actual) return { error: `presentación temporal ${id} no encontrada` };
  if (op === 'borrar') {
    const resto = lista.filter(t => t.id !== id);
    if (resto.length) mapa[granelPlu] = resto; else delete mapa[granelPlu];
    return { mapa, item: actual };
  }
  const { nombre, ...resto } = { ...actual, ...datos };
  item = nombre ? { ...resto, nombre } : resto;
  mapa[granelPlu] = lista.map(t => (t.id === id ? item : t));
  return { mapa, item };
}

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
  // Costo base (manual → última compra si se eligió → sistema sin IVA): preciosCosteo.elegirCosto,
  // el mismo criterio que el granel de Fraccionado. La banda se busca por el costo que efectivamente se usa.
  const { costoBase, costoFuente, costoOverride } = preciosCosteo.elegirCosto({
    plu, costoUltimaCompra: costoMercaderia, costoSistema, cfg,
  });
  const overridePct = (cfg.margenPorProducto || {})[plu];
  const bandasAlmacen = (cfg.bandasMarkup || {}).almacen;
  const { markupPct, banda } = preciosCosteo.resolverBanda(costoBase, bandasAlmacen, overridePct);
  // Lo que daría la banda sin override: el detalle lo muestra al lado del markup propio.
  const markupBanda = preciosCosteo.resolverBanda(costoBase, bandasAlmacen).markupPct;
  const markupOverride = typeof overridePct === 'number' && Number.isFinite(overridePct) ? overridePct : null;
  const costosVariosPct = Number(cfg.costosVariosPctAlmacen) || 0;
  // Costos extra del producto: misma clave que los graneles de Fraccionado (ver COSTEO_DEFAULT).
  const costosExtra = costosExtraDe(cfg, plu);
  const costeado = preciosCosteo.costearAlmacen({
    costoMercaderia: costoBase, costosVariosPct, costosExtra, markupPct, banda, plu, nombre,
  });
  // Sólo los extras del producto (sin los costos varios globales), como en Fraccionado.
  const conExtras = preciosCosteo.aplicarCostosExtra(costeado.costoTotal == null ? null : costoBase, costosExtra, '$');
  const costoExtraTotal = conExtras.costoTotal == null ? null
    : Math.round((conExtras.costoTotal - costoBase) * 100) / 100;
  // El redondeo a $50 se aplica cuando el precio cambia; si costo y markup reproducen el precio
  // vigente de SIGA, se respeta ese precio (así un producto alineado da 0% aunque SIGA no
  // tenga el precio en múltiplo de 50).
  if (precioVigente > 0 && costeado.precioConIvaExacto != null
    && Math.abs(costeado.precioConIvaExacto - precioVigente) < 0.5) {
    costeado.precioConIva = precioVigente;
  }
  // semaforo: 'ok' | 'subir' | 'bajar' | null (sin vigente o sin precio sugerido).
  const { deltaPct, estado: semaforo } = preciosCosteo.compararConVigente(costeado.precioConIva, precioVigente, cfg.toleranciaPct);
  return {
    ...costeado, markupBanda, markupOverride, costosExtra, costoExtraTotal,
    costoBase: costoBase != null ? costoBase : null, costoOverride, costoFuente,
    costoSistema: costoSistema != null ? costoSistema : null,
    precioUltimaCompra: costoMercaderia != null ? costoMercaderia : null, costosVariosPct,
    precioVigente: precioVigente != null ? precioVigente : null, deltaPct, semaforo,
  };
}

// Margen standard Fraccionado por defecto (si costeo.json no tiene markupFraccionado).
// Valores = (1+markupExcel) × correcciónExcel − 1: reproduce los precios del Excel sin envase/MO.
const MARKUP_FRACCIONADO_DEFAULT = Object.freeze({
  bandas: [9999, 19999, null],
  tramosG: [100, 200, 400, 500, 1000, 5000, 10000],
  markupPct: [[84.35, 76.33, 68.32, 68.32, 60.3, 53.89, 50.68],
              [87.33, 78.82, 73.71, 73.71, 70.3, 63.49, 60.08],
              [73.57, 70.26, 66.95, 66.95, 65.3, 58.69, 55.38]],
});

function costosExtraDe(cfg, plu) {
  const items = plu != null ? (cfg.costosExtraFraccionado || {})[plu] : null;
  return Array.isArray(items) ? items : [];
}

function granelDe(formulas, plu) {
  const f = (formulas || {})[plu];
  return f && f.granel != null ? String(f.granel) : null;
}

// Listado Fraccionado agrupado por granel. Pura (sin SQL/fs): recibe graneles y presentaciones
// de SIGA, formulas de pesables_listas, costos (Map granelPlu → fila de productosConCostos:
// costoMercaderia, costoSistema, ...) y vigentes (Map plu → precio por kg). Todas las presentaciones
// de un granel llevan su costo $/kg; varía el margen: margenPorProducto[plu] ?? standard.
const SIN_GRANEL = 'Sin granel asignado';
function armarGruposFraccionado({ graneles, presentaciones, formulas, costos, vigentes, costeoConfig }) {
  const cfg = costeoConfig || {};
  const matriz = cfg.markupFraccionado || MARKUP_FRACCIONADO_DEFAULT;
  const overrides = cfg.margenPorProducto || {};
  const marcados = cfg.marcadosExportar || {};
  const grupos = new Map();
  // Costo del granel: mismo selector que Almacén (elegirCosto), con las claves por PLU del granel.
  const nuevoGrupo = (plu, nombre) => {
    const c = (plu != null && costos.get(plu)) || {};
    const { costoBase, costoFuente, costoOverride } = preciosCosteo.elegirCosto({
      plu, costoUltimaCompra: c.costoMercaderia ?? null, costoSistema: c.costoSistema ?? null, cfg,
    });
    // Costos extra del granel ($/kg o % del costo base): las presentaciones se costean sobre costoTotal.
    const extras = costosExtraDe(cfg, plu);
    const { costoTotal } = preciosCosteo.aplicarCostosExtra(costoBase, extras);
    return {
      granelPlu: plu, granelNombre: nombre || c.nombre || '',
      costoBase, costoFuente: plu == null ? null : costoFuente, costoOverride,
      costosExtra: extras, costoTotal,
      costoExtraTotal: costoTotal != null ? Math.round((costoTotal - costoBase) * 100) / 100 : null,
      costoSistema: c.costoSistema ?? null, costoSistemaConIva: c.costoSistemaConIva ?? null,
      ivaCompraPct: c.ivaCompraPct ?? null, ivaCompraSupuesto: !!c.ivaCompraSupuesto,
      precioUltimaCompra: c.costoMercaderia ?? null,
      proveedor: c.proveedor || null, fechaUltimaCompra: c.fechaUltimaCompra || null, ingresoHoy: !!c.ingresoHoy,
      banda: preciosCosteo.markupStdFraccionado(costoBase, null, matriz).fila, presentaciones: [],
    };
  };
  for (const g of graneles || []) grupos.set(g.plu, nuevoGrupo(g.plu, g.nombre));
  const sinGranel = nuevoGrupo(null, SIN_GRANEL);

  for (const p of presentaciones || []) {
    const gPlu = granelDe(formulas, p.plu);
    // Granel referenciado fuera del rubro pero existente en SIGA: grupo propio.
    if (gPlu && !grupos.has(gPlu) && costos.has(gPlu)) grupos.set(gPlu, nuevoGrupo(gPlu, null));
    const grupo = gPlu && grupos.has(gPlu) ? grupos.get(gPlu) : sinGranel;
    grupo.presentaciones.push({
      ...filaPresentacion(p, grupo, matriz, overrides, vigentes, cfg.toleranciaPct),
      marcado: Object.prototype.hasOwnProperty.call(marcados, p.plu),
    });
  }
  const porNombre = (a, b) => String(a).localeCompare(String(b), 'es');
  const lista = [...grupos.values()].sort((a, b) => porNombre(a.granelNombre, b.granelNombre));
  if (sinGranel.presentaciones.length) lista.push(sinGranel);
  const peso = f => (f.pesoG != null ? f.pesoG : Infinity);
  const temporales = cfg.presentacionesTemporales || {};
  for (const g of lista) {
    g.presentaciones.sort((a, b) => (peso(a) - peso(b)) || porNombre(a.nombre, b.nombre));
    const tmp = g.granelPlu != null && Array.isArray(temporales[g.granelPlu]) ? temporales[g.granelPlu] : [];
    g.temporales = tmp.map(t => filaTemporal(t, g, matriz)).sort((a, b) => a.pesoG - b.pesoG);
  }
  return lista;
}

function filaPresentacion(p, grupo, matriz, overrides, vigentes, toleranciaPct) {
  const pesoKg = pesoTokenKg(p.nombre);
  const pesoG = pesoKg > 0 ? Math.round(pesoKg * 1000) : null;
  // La banda del margen standard se busca con el costo SELECCIONADO (costoBase), no con
  // base + extras — igual que Almacén busca la banda por costoBase y suma costos varios aparte.
  // El precio sí se calcula sobre costoTotal (base + costos extra del granel).
  const markupStd = preciosCosteo.markupStdFraccionado(grupo.costoBase, pesoG, matriz).markupPct;
  const ov = overrides[p.plu];
  const markupOverride = typeof ov === 'number' && Number.isFinite(ov) ? ov : null;
  const c = preciosCosteo.costearFraccionado({
    plu: p.plu, nombre: p.nombre, costoKg: grupo.costoTotal,
    markupPct: markupOverride != null ? markupOverride : markupStd,
  });
  const precioVigente = vigentes.has(p.plu) ? vigentes.get(p.plu) : null;
  // Misma regla "alineado exacto" que Almacén: si reproduce el vigente, se respeta ese precio.
  const precioConIva = precioVigente > 0 && c.precioConIvaExacto != null
    && Math.abs(c.precioConIvaExacto - precioVigente) < 0.5 ? precioVigente : c.precioConIva;
  const { deltaPct, estado: semaforo } = preciosCosteo.compararConVigente(precioConIva, precioVigente, toleranciaPct);
  return {
    plu: p.plu, nombre: p.nombre,
    presentacion: etiquetaPeso(pesoG), pesoG,
    markupStd, markupOverride, markupPct: c.markupPct,
    precioNeto: c.precioNeto, precioConIva, precioVigente, deltaPct, semaforo,
    // Sin costo el standard tampoco existe: el faltante real es el costo, no el margen.
    faltantes: grupo.granelPlu == null ? ['granel'] : grupo.costoBase == null ? ['costoGranel'] : c.faltantes,
  };
}

const etiquetaPeso = pesoG => (pesoG == null ? '' : pesoG >= 1000 ? `${pesoG / 1000}KG` : `${pesoG}G`);

// Presentación temporal (simulada): mismo costo del granel y margen (standard por pesoG u override
// markupPct) que una real, pero sin PLU ni precio vigente → sin semáforo; nunca marcable.
function filaTemporal(t, grupo, matriz) {
  const markupStd = preciosCosteo.markupStdFraccionado(grupo.costoBase, t.pesoG, matriz).markupPct;
  const markupOverride = typeof t.markupPct === 'number' && Number.isFinite(t.markupPct) ? t.markupPct : null;
  const c = preciosCosteo.costearFraccionado({
    plu: null, nombre: t.nombre || null, costoKg: grupo.costoTotal,
    markupPct: markupOverride != null ? markupOverride : markupStd,
  });
  return {
    id: t.id, temporal: true, nombre: t.nombre || null,
    presentacion: etiquetaPeso(t.pesoG), pesoG: t.pesoG,
    markupStd, markupOverride, markupPct: c.markupPct,
    precioNeto: c.precioNeto, precioConIva: c.precioConIva, precioVigente: null, deltaPct: null, semaforo: null,
    faltantes: grupo.costoBase == null ? ['costoGranel'] : c.faltantes,
    marcado: false,
  };
}

// Markup por producto que reproduce el precio vigente de SIGA con el costo total actual.
// Filas sin costoTotal o sin vigente cuentan en sinDatos; negativos = vigente bajo el costo
// (se incluyen igual).
function markupsAlineadosConSiga(filas) {
  const markups = {};
  let sinDatos = 0, negativos = 0;
  for (const f of filas || []) {
    const m = f.costoTotal > 0 && f.precioVigente > 0
      ? preciosCosteo.markupParaPrecio(f.costoTotal, f.precioVigente) : null;
    if (m == null) { sinDatos++; continue; }
    markups[f.plu] = m;
    if (m < 0) negativos++;
  }
  return { markups, alineados: Object.keys(markups).length, sinDatos, negativos };
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
module.exports.markupsAlineadosConSiga = markupsAlineadosConSiga;
module.exports.armarGruposFraccionado = armarGruposFraccionado;
module.exports.MARKUP_FRACCIONADO_DEFAULT = MARKUP_FRACCIONADO_DEFAULT;
module.exports.aplicarTemporal = aplicarTemporal;
module.exports.TEMPORALES_MAX = TEMPORALES_MAX;
