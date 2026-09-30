'use strict';
const express = require('express');
const path = require('path');
const preciosCosteo = require('../lib/precios_costeo');
const { pesoTokenKg } = require('../lib/producto_carga');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const { crearPackBultoDe, configPackBultoSanitizada, PACK_BULTO_DEFAULT } = require('../lib/precios_pack_bulto');

// ── Rutas del módulo Precios (costeo sugerido) ───────────────────────────────
// Fase 1: listado/detalle/config de Almacén. Fase 2: Fraccionado (listado agrupado por granel). Producción (Fase 3)
// vive en rutas_precios_produccion.js; las consultas SIGA de costo/vigente se comparten vía lib/precios_consultas.js.
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
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR, LISTA_PRECIOS_VENTA, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL } = deps;
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
    // Mano de obra de fraccionado: minutos por unidad standard y propios por PLU (a costoHora).
    minutosFraccionadoStd: 0, minutosFraccionado: {},
    // Insumos básicos de fraccionado ($ por unidad): standard y propios por PLU (mismo patrón que la MO).
    insumosFraccionadoStd: 0, insumosFraccionado: {},
    // Gastos sobre venta [{ id, concepto, pct, listas }]: los standards (bandas, matriz) son ganancia y se
    // convierten a markup total con el total de la lista sucursal. [] = conversión identidad.
    gastosVenta: [],
    // Curva de ganancia según costo por tipo (inactiva = bandas/matriz). Ver lib/precios_costeo.
    curvaGanancia: preciosCosteo.CURVA_GANANCIA_DEFAULT,
    // Fase 4: % de descuento pack/bulto sobre el sugerido del base, overrides y vínculos manuales
    // (config/overrides/vínculos en rutas_precios_pack_bulto.js).
    packBulto: PACK_BULTO_DEFAULT,
  };

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  router.get('/api/precios/config', apiRoute(async () => {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const pb = configPackBultoSanitizada(costeo.packBulto);
    return {
      costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct,
      costosVariosPctAlmacen: costeo.costosVariosPctAlmacen,
      bandasMarkup: costeo.bandasMarkup,
      markupFraccionado: costeo.markupFraccionado || MARKUP_FRACCIONADO_DEFAULT,
      minutosFraccionadoStd: costeo.minutosFraccionadoStd || 0,
      insumosFraccionadoStd: costeo.insumosFraccionadoStd || 0,
      gastosVenta: Array.isArray(costeo.gastosVenta) ? costeo.gastosVenta : [],
      gastosVentaPct: preciosCosteo.totalGastosVenta(costeo.gastosVenta),
      curvaGanancia: preciosCosteo.curvasGananciaConDefault(costeo.curvaGanancia),
      // % generales de pack/bulto (la UI los muestra al quitar un % propio).
      packBulto: { descPackPct: pb.descPackPct, descBultoPct: pb.descBultoPct },
    };
  }));

  // Consultas SIGA compartidas con Producción (lib/precios_consultas.js): costo por PLU
  // (productosConCostos) y precio vigente de mostrador (preciosVigentesAlmacen).
  const { productosConCostos, costosPorPlu, preciosVigentesAlmacen, fechasPrecioAlmacen, vinculosPackBulto, comprasHoy } = crearConsultasPrecios({
    query, LISTA_PRECIOS_VENTA, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL,
  });
  // Vínculos pack/bulto → base (una query por request). Las sub-filas se aplican sobre el
  // precioConIva ya calculado de cada fila base: nunca se recalcula el base.
  const vinculosDe = async costeo => (await vinculosPackBulto((costeo.packBulto || {}).vinculosManuales || {})).vinculos;

  // Universo Almacén: rubro 'Almacen', activo. (Los graneles no filtran Activo: un granel referenciado
  // por fórmula se costea aunque esté inactivo, como antes.)
  const universoAlmacen = () => productosConCostos(`p.Activo = 1 AND r.NombreRubro = 'Almacen'`);

  // Fila completa (costeo + comparación) para todo el universo Almacén. Compartida por
  // listado y detalle — el único lugar que trae las dos queries SQL y las cruza por plu.
  // ponytail: detalle también recalcula el universo entero para traer un solo producto
  // (sin query filtrada por plu) — subir si el universo Almacén crece lo bastante para
  // que el round-trip duela; hoy es el mismo volumen que ya trae /api/precios-proveedores/listado.
  async function filasAlmacen(costeo) {
    const [universo, vigentes, fechas, vinculos, compras] = await Promise.all([
      universoAlmacen(), preciosVigentesAlmacen(), fechasPrecioAlmacen(), vinculosDe(costeo), comprasHoy(),
    ]);
    const marcados = costeo.marcadosExportar || {};
    const packBultoDe = crearPackBultoDe({ vinculos, vigentes, fechas, costeo });
    return universo.map(p => {
      const fila = calcularFilaAlmacen({
        plu: p.plu, nombre: p.nombre, costoMercaderia: p.costoMercaderia, costoSistema: p.costoSistema,
        precioVigente: vigentes.has(p.plu) ? vigentes.get(p.plu) : null,
        costeoConfig: costeo,
      });
      return {
        ...fila,
        proveedor: p.proveedor, fechaUltimaCompra: p.fechaUltimaCompra, ingresoHoy: p.ingresoHoy,
        compraHoy: compraHoyDe(compras, p.plu, costeo.toleranciaPct),
        costoSistemaConIva: p.costoSistemaConIva, ivaCompraPct: p.ivaCompraPct, ivaCompraSupuesto: p.ivaCompraSupuesto,
        tipoComprobanteUltimaCompra: p.tipoComprobanteUltimaCompra,
        marcado: Object.prototype.hasOwnProperty.call(marcados, p.plu),
        fechaPrecio: fechas.get(clavePlu(p.plu)) || null,
        packBulto: packBultoDe(p.plu, fila.precioConIva),
      };
    });
  }

  // ── Fraccionado ────────────────────────────────────────────────────────────
  // Graneles = rubro 'Pesables Deposito'; presentaciones = rubro 'Pesables Fraccionado' (mismo
  // filtro que rutas_fraccionado_externo) + 'Pesables Venta Directa', unidas por
  // pesables_listas.formulas[plu].granel. Un venta directa sin fórmula es su propio granel.
  // `rubro` es siempre una constante de este archivo, nunca input del request.
  async function productosDeRubro(rubro) {
    const rows = await query(`
      SELECT p.IdProducto, p.NombreProducto
      FROM Productos p JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE p.Activo = 1 AND r.NombreRubro = '${rubro}'`);
    return rows.map(r => ({ plu: String(r.IdProducto), nombre: String(r.NombreProducto || '').trim() }));
  }

  // Granel ('Pesables Deposito') de la fórmula activa en SIGA de cada PLU: componente directo o a dos
  // niveles (por el intermedio de producción); gana el directo. Map plu → granelPlu.
  async function granelesEnFormulaSiga(plus) {
    const ids = plus.filter(id => /^\d{1,12}$/.test(id));
    if (!ids.length) return new Map();
    const lista = ids.map(id => `'${id}'`).join(',');
    const formulaActivaPc2 = FORMULA_ACTIVA_SQL.replace(/\bpc\./g, 'pc2.');
    const rows = await query(`
      SELECT CAST(pc.IdProducto AS VARCHAR) AS Plu, CAST(p.IdProducto AS VARCHAR) AS Granel, 1 AS Nivel
      FROM ProductosComponentes pc JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
      JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE pc.IdProducto IN (${lista}) AND r.NombreRubro = 'Pesables Deposito' AND ${FORMULA_ACTIVA_SQL}
      UNION ALL
      SELECT CAST(pc.IdProducto AS VARCHAR), CAST(p.IdProducto AS VARCHAR), 2
      FROM ProductosComponentes pc JOIN ProductosComponentes pc2 ON pc2.IdProducto = pc.IdProductoComponente
      JOIN Productos p ON p.IdProducto = pc2.IdProductoComponente JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE pc.IdProducto IN (${lista}) AND r.NombreRubro = 'Pesables Deposito' AND ${FORMULA_ACTIVA_SQL} AND ${formulaActivaPc2}`);
    const mapa = new Map();
    for (const r of [...rows].sort((a, b) => a.Nivel - b.Nivel)) {
      const plu = String(r.Plu).trim();
      if (!mapa.has(plu)) mapa.set(plu, String(r.Granel).trim());
    }
    return mapa;
  }

  async function gruposFraccionado(costeo) {
    const [graneles, fraccionados, ventaDirecta, vigentes, fechas, vinculos, compras] = await Promise.all([
      productosDeRubro('Pesables Deposito'), productosDeRubro('Pesables Fraccionado'), productosDeRubro('Pesables Venta Directa'),
      preciosVigentesAlmacen(), fechasPrecioAlmacen(), vinculosDe(costeo), comprasHoy(),
    ]);
    const formulas = (leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas || {};
    const granelSiga = await granelesEnFormulaSiga(ventaDirecta.filter(p => !granelDe(formulas, p.plu)).map(p => p.plu));
    const presentaciones = [...fraccionados, ...ventaDirecta.map(p => ({ ...p, ventaDirecta: true, granelSiga: granelSiga.get(p.plu) || null }))];
    const referenciados = presentaciones.map(p => granelDePresentacion(formulas, p)).filter(Boolean);
    const costos = await costosPorPlu([...graneles.map(g => g.plu), ...referenciados]);
    const packBultoDe = crearPackBultoDe({ vinculos, vigentes, fechas, costeo });
    return armarGruposFraccionado({ graneles, presentaciones, formulas, costos, vigentes, fechas, costeoConfig: costeo, packBultoDe, comprasHoy: compras });
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
      markupBanda: f.markupBanda, markupOverride: f.markupOverride, gananciaBanda: f.gananciaBanda, gastosVentaPct: f.gastosVentaPct,
      costoOverride: f.costoOverride, costoFuente: f.costoFuente,
      costosExtra: f.costosExtra, costoExtraTotal: f.costoExtraTotal,
      precioNeto: f.precioNeto, precioConIva: f.precioConIva, precioVigente: f.precioVigente,
      deltaPct: f.deltaPct, semaforo: f.semaforo, faltantes: f.faltantes,
      costoSistema: f.costoSistema, costoSistemaConIva: f.costoSistemaConIva, ivaCompraPct: f.ivaCompraPct, precioUltimaCompra: f.precioUltimaCompra,
      tipoComprobanteUltimaCompra: f.tipoComprobanteUltimaCompra,
      proveedor: f.proveedor, fechaUltimaCompra: f.fechaUltimaCompra, ingresoHoy: f.ingresoHoy, compraHoy: f.compraHoy,
      marcado: f.marcado, packBulto: f.packBulto, fechaPrecio: f.fechaPrecio,
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
  const LIMITES_GENERAL = {
    toleranciaPct: 100, costoHora: 10000000, costosVariosPctAlmacen: 100, minutosFraccionadoStd: MINUTOS_MO_MAX,
    insumosFraccionadoStd: INSUMOS_FRACC_MAX,
  };
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
    return {
      costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct, costosVariosPctAlmacen: costeo.costosVariosPctAlmacen,
      minutosFraccionadoStd: costeo.minutosFraccionadoStd || 0, insumosFraccionadoStd: costeo.insumosFraccionadoStd || 0,
    };
  }));

  // Gastos sobre venta. body { items, conservarPrecios }: conservarPrecios (default true) reescala las
  // ganancias de bandas y matriz para que el markup total (y los precios) no cambien. Valida todo
  // (gastos + bandas/matriz reescaladas) antes de escribir; el total no se guarda, se calcula.
  router.put('/api/precios/config/gastos-venta', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    let nuevo;
    try {
      const gastosVenta = preciosCosteo.validarGastosVenta(body.items);
      const base = { ...costeo, markupFraccionado: costeo.markupFraccionado || MARKUP_FRACCIONADO_DEFAULT, gastosVenta };
      const reescalado = body.conservarPrecios === false ? base : preciosCosteo.reescalarGanancias(base,
        preciosCosteo.totalGastosVenta(costeo.gastosVenta), preciosCosteo.totalGastosVenta(gastosVenta));
      nuevo = preciosCosteo.configSanitizada(reescalado);
      preciosCosteo.validarMarkupFraccionado(nuevo.markupFraccionado);
      for (const [tipo, c] of Object.entries(nuevo.curvaGanancia || {})) preciosCosteo.validarCurvaGanancia(c, tipo);
    } catch (err) {
      return { error: err.message };
    }
    guardarJSON(COSTEO_PATH, nuevo);
    return {
      gastosVenta: nuevo.gastosVenta, gastosVentaPct: preciosCosteo.totalGastosVenta(nuevo.gastosVenta),
      bandasMarkup: nuevo.bandasMarkup, markupFraccionado: nuevo.markupFraccionado,
      curvaGanancia: preciosCosteo.curvasGananciaConDefault(nuevo.curvaGanancia),
    };
  }));

  // Curva de ganancia de un tipo (almacen | fraccionado): valida antes de escribir, sólo toca ese tipo.
  router.put('/api/precios/config/curva-ganancia/:tipo', apiRoute(async (req) => {
    let curva;
    try {
      curva = preciosCosteo.validarCurvaGanancia(req.body, String(req.params.tipo || ''));
    } catch (err) {
      return { error: err.message };
    }
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const curvaGanancia = { ...(costeo.curvaGanancia || {}), [req.params.tipo]: curva };
    guardarJSON(COSTEO_PATH, { ...costeo, curvaGanancia });
    return { curvaGanancia: preciosCosteo.curvasGananciaConDefault(curvaGanancia) };
  }));

  // Propuesta de curva ajustada a los precios vigentes de SIGA. NO guarda: la UI la muestra y el
  // usuario la acepta/corrige y guarda con el PUT de arriba.
  router.post('/api/precios/curva-ganancia/ajustar/:tipo', apiRoute(async (req) => {
    const tipo = String(req.params.tipo || '');
    if (!preciosCosteo.TIPOS_CURVA.includes(tipo)) return { error: `tipo inválido (${preciosCosteo.TIPOS_CURVA.join(', ')})` };
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    const datos = tipo === 'almacen' ? await filasAlmacen(costeo) : await gruposFraccionado(costeo);
    try {
      return preciosCosteo.propuestaCurva(tipo, datos, {
        gastosPct: preciosCosteo.totalGastosVenta(costeo.gastosVenta),
        tramosG: (costeo.markupFraccionado || MARKUP_FRACCIONADO_DEFAULT).tramosG,
      });
    } catch (err) {
      return { error: err.message };
    }
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

  // Minutos de fraccionado propios de una presentación (minutosFraccionado[plu]): pisan el standard.
  // { minutos: null } lo quita.
  router.put('/api/precios/minutos-fraccionado/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'minutosFraccionado', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).minutos, min: 0, max: MINUTOS_MO_MAX,
  })));

  // Insumos básicos propios de una presentación ($ por unidad, insumosFraccionado[plu]): pisan el
  // standard. { pesos: null } lo quita.
  router.put('/api/precios/insumos-fraccionado/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'insumosFraccionado', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).pesos, min: 0, max: INSUMOS_FRACC_MAX,
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
    // Fraccionado: cada presentación se alinea con su costo $/kg (granel base + costos extra + MO
    // de fraccionado de esa presentación).
    const presentaciones = grupos.flatMap(g => g.presentaciones.map(p => ({
      plu: p.plu, costoTotal: p.costoKg, precioVigente: p.precioVigente,
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

  // Fuente del costo base de un producto ('sistema' = PrecioCosto de SIGA tal cual, ver filaCostos
  // en lib/precios_consultas). body { fuente: 'ultimaCompra' | 'sistema' | 'manual',
  // costo? }. 'sistema' (default) borra ambas marcas; 'ultimaCompra' marca fuenteCosto[plu];
  // 'manual' guarda costoPorProducto[plu] (el costo que va a la cuenta), que gana sobre cualquier fuente.
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

  // Migración única de márgenes propios al costo "tal cual SIGA" sin ×1,21 (migrarCosteoBaseCosto):
  // flag costeo.baseCosto = 'siga', backup antes de escribir. Corre sola ~30 s después de arrancar;
  // si SIGA no responde, loguea y reintenta en el próximo arranque (no tumba el server).
  async function migrarBaseCosto() {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    // leerJSON devuelve el default si el archivo falta o está roto: no escribir encima de eso.
    if (costeo === COSTEO_DEFAULT || costeo.baseCosto === preciosCosteo.BASE_COSTO_SIGA) return;
    const [filas, grupos] = await Promise.all([filasAlmacen(costeo), gruposFraccionado(costeo)]);
    const actual = leerJSON(COSTEO_PATH, COSTEO_DEFAULT); // releído: pudo cambiar durante las queries
    const r = actual === COSTEO_DEFAULT ? null : preciosCosteo.migrarCosteoBaseCosto(actual, alicuotasParaMigrar(filas, grupos));
    if (!r) return;
    guardarJSON(`${COSTEO_PATH}.bak-base-costo`, actual);
    guardarJSON(COSTEO_PATH, r.costeo);
    console.log(`[precios/migracion] ${r.ajustados} márgenes ajustados`);
  }
  const DEMORA_MIGRACION_MS = 30000;
  setTimeout(() => migrarBaseCosto().catch(err => console.error('[precios/migracion] falló, se reintenta al reiniciar:', err.message)),
    DEMORA_MIGRACION_MS).unref();

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

// Markup de un producto Almacén. La banda por costo guarda GANANCIA (gananciaBanda) y se convierte a
// markup total con los gastos sobre venta de la lista sucursal (markupBanda: lo que daría la banda,
// el detalle lo muestra al lado del markup propio). El override por producto ya es markup total.
// Con la curva de ganancia activa, la ganancia standard sale de la curva (banda 'curva') en vez de las bandas.
function markupAlmacen(cfg, plu, costoBase) {
  const gastosVentaPct = preciosCosteo.totalGastosVenta(cfg.gastosVenta);
  const curva = (cfg.curvaGanancia || {}).almacen;
  const std = curva && curva.activa === true
    ? { markupPct: preciosCosteo.gananciaPorCurva(curva, costoBase), banda: 'curva' }
    : preciosCosteo.resolverBanda(costoBase, (cfg.bandasMarkup || {}).almacen);
  const gananciaBanda = std.markupPct;
  const markupBanda = gananciaBanda == null ? null : preciosCosteo.markupDesdeGanancia(gananciaBanda, gastosVentaPct);
  const markupOverride = numeroONull((cfg.margenPorProducto || {})[plu]);
  return {
    markupPct: markupOverride ?? markupBanda, banda: markupOverride != null ? 'override' : std.banda,
    markupBanda, markupOverride, gananciaBanda, gastosVentaPct,
  };
}

// Fila calculada para un producto Almacén: costeo (banda + markup, redondeo a $50) contra el precio
// vigente de mostrador. Pura — sin SQL/fs — para poder testearla sin base de datos; la SQL
// vive en universoAlmacen/preciosVigentesAlmacen arriba, que son lo único que necesita `query`.
// precioConIva es el precio final (costo × (1 + markup), ver IVA_VENTA): se compara con el vigente de SIGA.
function calcularFilaAlmacen({ plu, nombre, costoMercaderia, costoSistema = null, precioVigente, costeoConfig }) {
  const cfg = costeoConfig || {};
  // Costo base (manual → última compra si se eligió → sistema tal cual): preciosCosteo.elegirCosto,
  // el mismo criterio que el granel de Fraccionado. La banda se busca por el costo que efectivamente se usa.
  const { costoBase, costoFuente, costoOverride } = preciosCosteo.elegirCosto({
    plu, costoUltimaCompra: costoMercaderia, costoSistema, cfg,
  });
  const { markupPct, banda, markupBanda, markupOverride, gananciaBanda, gastosVentaPct } = markupAlmacen(cfg, plu, costoBase);
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
    ...costeado, markupBanda, markupOverride, gananciaBanda, gastosVentaPct, costosExtra, costoExtraTotal,
    costoBase: costoBase != null ? costoBase : null, costoOverride, costoFuente,
    costoSistema: costoSistema != null ? costoSistema : null,
    precioUltimaCompra: costoMercaderia != null ? costoMercaderia : null, costosVariosPct,
    precioVigente: precioVigente != null ? precioVigente : null, deltaPct, semaforo,
  };
}

// Margen standard Fraccionado por defecto (si costeo.json no tiene markupFraccionado).
// Valores = (1+markupExcel) × correcciónExcel − 1: reproduce los precios del Excel sin envase/MO.
// Tope de minutos de fraccionado por unidad (standard y propio).
const MINUTOS_MO_MAX = 600;
// Tope de insumos básicos de fraccionado, $ por unidad (standard y propio).
const INSUMOS_FRACC_MAX = 10000000;

const MARKUP_FRACCIONADO_DEFAULT = Object.freeze({
  bandas: [9999, 19999, null],
  tramosG: [100, 200, 400, 500, 1000, 5000, 10000],
  markupPct: [[84.35, 76.33, 68.32, 68.32, 60.3, 53.89, 50.68],
              [87.33, 78.82, 73.71, 73.71, 70.3, 63.49, 60.08],
              [73.57, 70.26, 66.95, 66.95, 65.3, 58.69, 55.38]],
});

// Clave de los Map armados con String(IdProducto).trim() (comprasHoy, fechasPrecioAlmacen): SIGA puede
// traer IdProducto con espacios y el plu de filaCostos no se recorta.
const clavePlu = plu => (plu == null ? null : String(plu).trim());

// Compra de hoy del plu con su tendencia contra la anterior (±toleranciaPct global), o null.
function compraHoyDe(compras, plu, toleranciaPct) {
  const ch = plu != null ? compras.get(clavePlu(plu)) : null;
  return ch ? { ...ch, tendencia: preciosCosteo.tendenciaCompraHoy(ch.deltaPct, toleranciaPct) } : null;
}

function costosExtraDe(cfg, plu) {
  const items = plu != null ? (cfg.costosExtraFraccionado || {})[plu] : null;
  return Array.isArray(items) ? items : [];
}

function granelDe(formulas, plu) {
  const f = (formulas || {})[plu];
  return f && f.granel != null ? String(f.granel) : null;
}

// Granel de una presentación: fórmula de pesables_listas; un venta directa sin ella usa la fórmula de
// SIGA (granelSiga), después el granel del mismo nombre ("Albahaca 1Kg" ↔ "Albahaca DEPOSITO GRANEL")
// y si no, es su propio granel: sus fraccionados (50G...) y temporales cuelgan de su PLU.
// Su costo SIGA ya es $/kg, como todo pesable.
const granelDePresentacion = (formulas, p, granelPorNombre = () => null) => granelDe(formulas, p.plu)
  ?? (p.ventaDirecta ? p.granelSiga || granelPorNombre(p.nombre) || p.plu : null);

// Nombre sin peso, paréntesis ("(Precio Por Kilo)"), "DEPOSITO"/"GRANEL", puntuación, tildes ni
// mayúsculas: clave para unir VD y granel. soloLetras también saca números (calibre "9/11").
const nombreBase = (nombre, soloLetras = false) => String(nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\([^)]*\)/g, ' ').replace(/\d+(?:[.,]\d+)?\s*(?:kgs?|grs?|gramos|g)\b/g, ' ')
  .replace(/\b(?:deposito|granel)\b/g, ' ').replace(soloLetras ? /[^a-z]+/g : /[^a-z0-9]+/g, ' ').trim();

// Buscador de granel por nombre: primero con calibre exacto; sin calibre sólo si el granel es único
// ("Avellanas Chicas 1Kg" ↔ "Avellanas Chicas - 9/11"; "Almendras 1Kg" con dos calibres no se une).
function crearGranelPorNombre(graneles) {
  const exacto = new Map((graneles || []).map(g => [nombreBase(g.nombre), g.plu]));
  const porLetras = new Map();
  for (const g of graneles || []) {
    const k = nombreBase(g.nombre, true);
    porLetras.set(k, porLetras.has(k) ? null : g.plu);
  }
  return nombre => exacto.get(nombreBase(nombre)) || porLetras.get(nombreBase(nombre, true)) || null;
}

// Listado Fraccionado agrupado por granel. Pura (sin SQL/fs): recibe graneles y presentaciones
// de SIGA, formulas de pesables_listas, costos (Map granelPlu → fila de productosConCostos:
// costoMercaderia, costoSistema, ...) y vigentes (Map plu → precio por kg). Todas las presentaciones
// de un granel llevan su costo $/kg; varía el margen: margenPorProducto[plu] ?? standard.
const SIN_GRANEL = 'Sin granel asignado';
// packBultoDe(plu, precioConIva, { pesable: true }) → sub-filas pack/bulto de la presentación (crearPackBultoDe):
// el base es $/kg, así que cada pack/bulto se vende por kg o por paquete (ventaPesable); sin él, [].
// packBultoGranel = bultos/packs cuya fórmula es el granel mismo: packBultoDe(granelPlu, null), sin sugerido.
// fechas: Map plu → 'YYYY-MM-DD' del último cambio de precio en SIGA (fechaPrecio de cada presentación).
// comprasHoy: Map granelPlu → compra cargada hoy (lib/precios_consultas comprasHoy); el grupo la lleva con tendencia.
function armarGruposFraccionado({ graneles, presentaciones, formulas, costos, vigentes, fechas = new Map(), costeoConfig, packBultoDe = () => [], comprasHoy = new Map() }) {
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
      precioUltimaCompra: c.costoMercaderia ?? null, tipoComprobanteUltimaCompra: c.tipoComprobanteUltimaCompra ?? null,
      proveedor: c.proveedor || null, fechaUltimaCompra: c.fechaUltimaCompra || null, ingresoHoy: !!c.ingresoHoy,
      compraHoy: compraHoyDe(comprasHoy, plu, cfg.toleranciaPct),
      banda: preciosCosteo.markupStdFraccionado(costoBase, null, matriz).fila, presentaciones: [],
      packBultoGranel: plu == null ? [] : packBultoDe(plu, null),
    };
  };
  for (const g of graneles || []) grupos.set(g.plu, nuevoGrupo(g.plu, g.nombre));
  const granelPorNombre = crearGranelPorNombre(graneles);
  const sinGranel = nuevoGrupo(null, SIN_GRANEL);
  const ctx = {
    matriz, overrides, vigentes, toleranciaPct: cfg.toleranciaPct, curva: (cfg.curvaGanancia || {}).fraccionado,
    gastosVentaPct: preciosCosteo.totalGastosVenta(cfg.gastosVenta),
    mo: { costoHora: Number(cfg.costoHora) || 0, std: Number(cfg.minutosFraccionadoStd) || 0, overrides: cfg.minutosFraccionado || {} },
    ins: { std: Number(cfg.insumosFraccionadoStd) || 0, overrides: cfg.insumosFraccionado || {} },
  };

  for (const p of presentaciones || []) {
    const gPlu = granelDePresentacion(formulas, p, granelPorNombre);
    // Granel referenciado fuera del rubro pero existente en SIGA: grupo propio.
    if (gPlu && !grupos.has(gPlu) && costos.has(gPlu)) grupos.set(gPlu, nuevoGrupo(gPlu, null));
    const grupo = gPlu && grupos.has(gPlu) ? grupos.get(gPlu) : sinGranel;
    const fila = filaPresentacion(p, grupo, ctx);
    grupo.presentaciones.push({
      ...fila,
      marcado: Object.prototype.hasOwnProperty.call(marcados, p.plu),
      fechaPrecio: fechas.get(clavePlu(p.plu)) || null,
      packBulto: packBultoDe(p.plu, fila.precioConIva, { pesable: true }),
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
    g.temporales = tmp.map(t => filaTemporal(t, g, ctx)).sort((a, b) => a.pesoG - b.pesoG);
  }
  return lista;
}

const numeroONull = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Mano de obra de fraccionado: minutos por unidad (override por PLU ?? standard) × costoHora/60,
// pasada a $/kg con el peso de la presentación. Un venta directa que es su propio granel no se
// fracciona: sin MO standard. Minutos > 0 sin peso → costoMoKg null (faltante pesoMo).
function manoObraFraccionado({ minutosOverride = null, propio = false, pesoKg, mo }) {
  const minutosStd = propio ? 0 : mo.std;
  const minutos = minutosOverride ?? minutosStd;
  const costoMoKg = !(minutos > 0) ? 0 : pesoKg > 0 ? preciosCosteo.redondear2(mo.costoHora / 60 * minutos / pesoKg) : null;
  return { minutosStd, minutosOverride, minutos, costoMoKg };
}

// Insumos básicos de fraccionado (bolsa, etiqueta...): $ por unidad (override por PLU ?? standard)
// pasados a $/kg con el peso. Mismo criterio que la MO: propio granel sin standard, $ > 0 sin peso → null.
function insumosFraccionado({ insumosOverride = null, propio = false, pesoKg, ins }) {
  const insumosStd = propio ? 0 : ins.std;
  const insumos = insumosOverride ?? insumosStd;
  const costoInsumosKg = !(insumos > 0) ? 0 : pesoKg > 0 ? preciosCosteo.redondear2(insumos / pesoKg) : null;
  return { insumosStd, insumosOverride, insumos, costoInsumosKg };
}

// Costo $/kg de una presentación = costo total del granel + MO + insumos. plu null (temporal) = standards.
function costosPresentacion({ plu = null, propio = false, pesoKg, costoTotal, ctx }) {
  const propios = mapa => (plu == null ? null : numeroONull(mapa[plu]));
  const manoObra = manoObraFraccionado({ minutosOverride: propios(ctx.mo.overrides), propio, pesoKg, mo: ctx.mo });
  const insumos = insumosFraccionado({ insumosOverride: propios(ctx.ins.overrides), propio, pesoKg, ins: ctx.ins });
  const partes = [costoTotal, manoObra.costoMoKg, insumos.costoInsumosKg];
  const costoKg = partes.some(v => v == null) ? null : preciosCosteo.redondear2(partes.reduce((s, v) => s + v, 0));
  return { ...manoObra, ...insumos, costoKg };
}

// Margen standard: la celda de la matriz es GANANCIA (gananciaStd); markupStd es el markup total
// con los gastos sobre venta. La celda se sigue buscando por costo base × peso. Con la curva de
// Fraccionado activa, la ganancia sale de la curva (costo base del granel + ajuste por peso).
function stdFraccionado(costoBase, pesoG, ctx) {
  const gananciaStd = ctx.curva && ctx.curva.activa === true
    ? preciosCosteo.gananciaPorCurva(ctx.curva, costoBase, pesoG)
    : preciosCosteo.markupStdFraccionado(costoBase, pesoG, ctx.matriz).markupPct;
  return { gananciaStd, markupStd: gananciaStd == null ? null : preciosCosteo.markupDesdeGanancia(gananciaStd, ctx.gastosVentaPct) };
}

function filaPresentacion(p, grupo, ctx) {
  const pesoKg = pesoTokenKg(p.nombre);
  const pesoG = pesoKg > 0 ? Math.round(pesoKg * 1000) : null;
  // La banda del margen standard se busca con el costo SELECCIONADO (costoBase), no con
  // base + extras — igual que Almacén busca la banda por costoBase y suma costos varios aparte.
  // El precio sí se calcula sobre costoKg (base + costos extra del granel + MO + insumos).
  const { gananciaStd, markupStd } = stdFraccionado(grupo.costoBase, pesoG, ctx);
  const markupOverride = numeroONull(ctx.overrides[p.plu]);
  const costos = costosPresentacion({ plu: p.plu, propio: grupo.granelPlu === p.plu, pesoKg, costoTotal: grupo.costoTotal, ctx });
  const c = preciosCosteo.costearFraccionado({
    plu: p.plu, nombre: p.nombre, costoKg: costos.costoKg,
    markupPct: markupOverride != null ? markupOverride : markupStd,
  });
  const precioVigente = ctx.vigentes.has(p.plu) ? ctx.vigentes.get(p.plu) : null;
  // Misma regla "alineado exacto" que Almacén: si reproduce el vigente, se respeta ese precio.
  const precioConIva = precioVigente > 0 && c.precioConIvaExacto != null
    && Math.abs(c.precioConIvaExacto - precioVigente) < 0.5 ? precioVigente : c.precioConIva;
  const { deltaPct, estado: semaforo } = preciosCosteo.compararConVigente(precioConIva, precioVigente, ctx.toleranciaPct);
  return {
    plu: p.plu, nombre: p.nombre, ventaDirecta: !!p.ventaDirecta,
    presentacion: etiquetaPeso(pesoG), pesoG,
    gananciaStd, markupStd, markupOverride, markupPct: c.markupPct, ...costos,
    precioNeto: c.precioNeto, precioConIva, precioVigente, deltaPct, semaforo,
    // Sin costo el standard tampoco existe: el faltante real es el costo, no el margen.
    faltantes: grupo.granelPlu == null ? ['granel'] : grupo.costoBase == null ? ['costoGranel']
      : costos.costoMoKg == null || costos.costoInsumosKg == null ? ['pesoMo'] : c.faltantes,
  };
}

const etiquetaPeso = pesoG => (pesoG == null ? '' : pesoG >= 1000 ? `${pesoG / 1000}KG` : `${pesoG}G`);

// Presentación temporal (simulada): mismo costo del granel y margen (standard por pesoG u override
// markupPct) que una real, pero sin PLU ni precio vigente → sin semáforo; nunca marcable.
// MO e insumos: siempre los standard.
function filaTemporal(t, grupo, ctx) {
  const { gananciaStd, markupStd } = stdFraccionado(grupo.costoBase, t.pesoG, ctx);
  const markupOverride = numeroONull(t.markupPct);
  const costos = costosPresentacion({ pesoKg: t.pesoG / 1000, costoTotal: grupo.costoTotal, ctx });
  const c = preciosCosteo.costearFraccionado({
    plu: null, nombre: t.nombre || null, costoKg: costos.costoKg,
    markupPct: markupOverride != null ? markupOverride : markupStd,
  });
  return {
    id: t.id, temporal: true, nombre: t.nombre || null,
    presentacion: etiquetaPeso(t.pesoG), pesoG: t.pesoG,
    gananciaStd, markupStd, markupOverride, markupPct: c.markupPct,
    costoMoKg: costos.costoMoKg, costoInsumosKg: costos.costoInsumosKg, costoKg: costos.costoKg,
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

// Alícuota con la que se migra el margen propio de cada PLU (Map plu → % para migrarMargenesBaseCosto):
// Almacén = la del producto; presentación de Fraccionado / venta directa = la de su granel (el costo es
// el del granel). 0 cuando el costo base no cambia con la regla nueva: costo manual, o última compra
// por cotización (antes neto, ahora neto tal cual). Sin alícuota en SIGA → null (se asume 21 %: igual).
function alicuotaDeCosto({ costoFuente, ivaCompraPct, tipoComprobanteUltimaCompra }) {
  if (costoFuente === 'manual') return 0;
  if (costoFuente === 'ultimaCompra' && tipoComprobanteUltimaCompra === 'cotización') return 0;
  return costoFuente == null ? null : ivaCompraPct ?? null;
}
function alicuotasParaMigrar(filas, grupos) {
  return new Map([
    ...(filas || []).map(f => [f.plu, alicuotaDeCosto(f)]),
    ...(grupos || []).flatMap(g => (g.presentaciones || []).map(p => [p.plu, alicuotaDeCosto(g)])),
  ]);
}

module.exports.calcularFilaAlmacen = calcularFilaAlmacen;
module.exports.alicuotasParaMigrar = alicuotasParaMigrar;
module.exports.aplicarMarcados = aplicarMarcados;
module.exports.markupsAlineadosConSiga = markupsAlineadosConSiga;
module.exports.armarGruposFraccionado = armarGruposFraccionado;
module.exports.MARKUP_FRACCIONADO_DEFAULT = MARKUP_FRACCIONADO_DEFAULT;
module.exports.aplicarTemporal = aplicarTemporal;
module.exports.TEMPORALES_MAX = TEMPORALES_MAX;
