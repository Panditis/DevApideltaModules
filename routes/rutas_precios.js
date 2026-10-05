'use strict';
const express = require('express');
const path = require('path');
const preciosCosteo = require('../lib/precios_costeo');
const preciosCostos = require('../lib/precios_costos');
const preciosProduccion = require('../lib/precios_produccion');
const { costeoConCurva, METODO_GANANCIA_CURVA } = require('../lib/precios_migracion_curva');
const { pesoTokenKg } = require('../lib/producto_carga');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const { crearPackBultoDe, configPackBultoSanitizada, PACK_BULTO_DEFAULT } = require('../lib/precios_pack_bulto');
const preciosMargenes = require('../lib/precios_margenes_propios');
// Costeo de Producción (sin el router): presentaciones para los márgenes propios.
const { costearTodos, plusUsados, normalizarDatos } = require('./rutas_precios_produccion');

// ── Rutas del módulo Precios (costeo sugerido) ───────────────────────────────
// Fase 1: listado/detalle/config de Almacén. Fase 2: Fraccionado (listado agrupado por granel). Producción (Fase 3)
// vive en rutas_precios_produccion.js; las consultas SIGA de costo/vigente se comparten vía lib/precios_consultas.js.
//
// data/costeo.json: config del módulo. La ganancia standard de los tres tipos es la curva de ganancia
// (curvaGanancia, lib/precios_costeo); las bandas y la matriz viejas se migran una vez a curva al leer
// (leerCosteo → lib/precios_migracion_curva) y se persiste al arrancar.
module.exports = function crearRutasPrecios(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR, LISTA_PRECIOS_VENTA, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL } = deps;
  const router = express.Router();

  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const COSTEO_DEFAULT = {
    costoHora: 4500, toleranciaPct: 10,
    margenPorProducto: {}, costoPorProducto: {}, fuenteCosto: {},
    // costosExtraFraccionado guarda los costos extra por PLU de Fraccionado (granel) Y de Almacén
    // (producto): los PLU de los dos universos no se pisan, así que una sola clave alcanza. El
    // nombre quedó de cuando sólo existía Fraccionado; renombrarla obligaría a migrar costeo.json
    // de cada instalación por un cambio cosmético — no vale la pena.
    marcadosExportar: {}, costosExtraFraccionado: {},
    // Presentaciones simuladas (sin código en SIGA) por granel: { [granelPlu]: [{ id, pesoG, markupPct, nombre? }] }.
    presentacionesTemporales: {},
    // Mano de obra de fraccionado: minutos por unidad propios por PLU (a costoHora). Sin propios = sin MO
    // (no hay standard: minutosFraccionadoStd viejo en el archivo se ignora).
    minutosFraccionado: {},
    // Insumos básicos de fraccionado ($ por unidad) propios por PLU (mismo patrón que la MO; sin standard).
    insumosFraccionado: {},
    // Gastos sobre venta [{ id, concepto, pct, listas }]: las curvas son ganancia y se convierten a markup
    // total con los gastos del tipo. [] = conversión identidad.
    gastosVenta: [],
    // Sin curvaGanancia ni metodoGanancia: leerCosteo arma las curvas por defecto con la migración (Fraccionado
    // con la matriz que se usaba de fábrica).
    // Fase 4: % de descuento pack/bulto sobre el sugerido del base, overrides y vínculos manuales
    // (config/overrides/vínculos en rutas_precios_pack_bulto.js).
    packBulto: PACK_BULTO_DEFAULT,
    // Tab Costos: departamentos imputados por tipo y venta mensual base (lib/precios_costos). [] = gastos por
    // tipo iguales a los variables (idéntico a antes).
    departamentos: [],
    ventaBase: preciosCostos.ventaBaseConDefault(null),
    // Tab Ganancia (spec Parte C): conceptos de ganancia [{ id, concepto, pct }] que se suman a la curva de los
    // tres tipos e IVA de venta global (se aplica al final sobre el precio neto). margenPropio = 'ganancia':
    // margenPorProducto y temporales guardan ganancia s/ costo real (marcador de la migración).
    conceptosGanancia: [], ivaVentaPct: preciosCosteo.IVA_DEFAULT_PCT, margenPropio: preciosCosteo.MARGEN_PROPIO_GANANCIA,
    // Parte D: conceptos sobre precio final [{ id, concepto, pct }] (gross-up después del IVA, ej. IIBB);
    // precioFinalConceptos = marcador de la migración que los sacó de gastosVenta.
    conceptosPrecioFinal: [], precioFinalConceptos: preciosCosteo.PRECIO_FINAL_MIGRADO,
  };

  // Config con las curvas (migra en memoria bandas/matriz si el archivo todavía no tiene el marcador).
  const leerCosteo = () => costeoConCurva(leerJSON(COSTEO_PATH, COSTEO_DEFAULT));
  // Migración persistida una sola vez al crear el router (archivo sin el marcador): backup y escritura.
  (function persistirMigracionCurva() {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    if (!costeo || costeo === COSTEO_DEFAULT || costeo.metodoGanancia === METODO_GANANCIA_CURVA) return;
    guardarJSON(`${COSTEO_PATH}.bak-antes-curva`, costeo);
    guardarJSON(COSTEO_PATH, costeoConCurva(costeo));
  })();

  // PLUs SIGA de la tab Producción (una sola definición: lib/precios_produccion plusProduccion). Con
  // vinculos (vinculosPackBulto) suma los pack/bulto de cada presentación, como las sub-filas de la tab.
  const plusProduccion = (vinculos = []) =>
    preciosProduccion.plusProduccion(leerJSON(path.join(DATA_DIR, 'recetas_produccion.json'), {}), vinculos);

  // Tipo de un PLU para los márgenes propios (G del tipo): presentaciones de Producción (recetas_produccion.json)
  // y de Fraccionado con fórmula en pesables_listas.json; el resto, Reventa.
  // ponytail: un venta directa sin fórmula en pesables_listas cae en Reventa (G casi igual: difiere sólo en
  // departamentos); exacto haría falta SIGA (rubro), y la migración corre sin SIGA al arrancar.
  function crearTipoDePlu() {
    const prod = new Set(plusProduccion());
    const fracc = new Set(Object.keys(((leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas) || {}));
    return plu => (prod.has(String(plu)) ? 'produccion' : fracc.has(String(plu)) ? 'fraccionado' : 'almacen');
  }

  // Migración de márgenes propios markup total → ganancia s/ costo real (marcador margenPropio), una sola vez al
  // crear el router, con backup data/costeo.json.bak-antes-ganancia.
  (function persistirMigracionGanancia() {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    if (!costeo || costeo === COSTEO_DEFAULT) return;
    const r = preciosCosteo.migrarMargenesAGanancia(costeo, preciosCostos.gastosPorTipo(costeo), crearTipoDePlu());
    if (!r) return;
    guardarJSON(`${COSTEO_PATH}.bak-antes-ganancia`, costeo);
    guardarJSON(COSTEO_PATH, r.costeo);
    console.log(`[precios/migracion] ${r.ajustados} márgenes propios pasados a ganancia`);
  })();

  // Parte D: IIBB e impuesto débitos/créditos salen de gastosVenta y pasan a conceptosPrecioFinal (marcador
  // precioFinalConceptos), una vez al crear el router, después de la de ganancia (que usa el G viejo), con backup
  // data/costeo.json.bak-antes-precio-final. No reescala: los precios suben un poco a propósito.
  (function persistirMigracionPrecioFinal() {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    if (!costeo || costeo === COSTEO_DEFAULT) return;
    const r = preciosCosteo.migrarConceptosPrecioFinal(costeo);
    if (!r) return;
    guardarJSON(`${COSTEO_PATH}.bak-antes-precio-final`, costeo);
    guardarJSON(COSTEO_PATH, r.costeo);
    console.log(`[precios/migracion] ${r.movidos} conceptos pasados a sobre precio final`);
  })();

  // Parte E.2: Producción no absorbe departamentos (ventaBase.produccionSinDepartamentos, default true). Un archivo sin
  // el flag cuyo G de Producción cambia se migra una vez manteniendo precios (reescala curva y ganancias propias de
  // Producción), con backup data/costeo.json.bak-antes-prod-sin-deptos. Curva fuera de rango → log y no escribe.
  (function persistirProduccionSinDepartamentos() {
    const costeo = leerJSON(COSTEO_PATH, COSTEO_DEFAULT);
    if (!costeo || costeo === COSTEO_DEFAULT) return;
    const r = preciosCostos.migrarProduccionSinDepartamentos(costeo, crearTipoDePlu());
    if (!r) return;
    try {
      preciosCosteo.validarCurvaGanancia(preciosCosteo.curvasGananciaConDefault(r.costeo.curvaGanancia).produccion, 'produccion');
    } catch (err) {
      console.error('[precios/migracion] Producción sin departamentos no aplicada:', err.message);
      return;
    }
    guardarJSON(`${COSTEO_PATH}.bak-antes-prod-sin-deptos`, costeo);
    guardarJSON(COSTEO_PATH, r.costeo);
    console.log(`[precios/migracion] Producción sin departamentos: G ${r.gastosAntes} → ${r.gastosDespues} %, precios mantenidos`);
  })();

  router.get('/precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'precios.html')));

  router.get('/api/precios/config', apiRoute(async () => {
    const costeo = leerCosteo();
    const pb = configPackBultoSanitizada(costeo.packBulto);
    return {
      costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct,
      gastosVenta: Array.isArray(costeo.gastosVenta) ? costeo.gastosVenta : [],
      gastosVentaPct: preciosCosteo.totalGastosVenta(costeo.gastosVenta),
      ...datosCostos(costeo),
      ...datosGanancia(costeo),
      curvaGanancia: preciosCosteo.curvasGananciaConDefault(costeo.curvaGanancia),
      // % generales de pack/bulto (la UI los muestra al quitar un % propio).
      packBulto: { descPackPct: pb.descPackPct, descBultoPct: pb.descBultoPct },
    };
  }));

  // Tab Ganancia: { conceptos?, conceptosPrecioFinal? } (conceptos de ganancia y sobre precio final; la lista que no
  // viene se conserva, al menos una). No reescala nada (cambian los precios).
  router.put('/api/precios/config/ganancia', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    let cambios;
    try {
      const soloFinal = !('conceptos' in body) && 'conceptosPrecioFinal' in body;
      cambios = {
        ...(soloFinal ? {} : { conceptosGanancia: preciosCosteo.validarConceptosGanancia(body.conceptos) }),
        ...('conceptosPrecioFinal' in body ? { conceptosPrecioFinal: preciosCosteo.validarConceptosPrecioFinal(body.conceptosPrecioFinal) } : {}),
      };
    } catch (err) {
      return { error: err.message };
    }
    const nuevo = { ...leerCosteo(), ...cambios };
    guardarJSON(COSTEO_PATH, nuevo);
    return datosGanancia(nuevo);
  }));

  // IVA de venta (se edita en Costos; se aplica sobre el precio neto, no es costo). No reescala nada.
  router.put('/api/precios/config/iva-venta', apiRoute(async (req) => {
    let ivaVentaPct;
    try {
      ivaVentaPct = preciosCosteo.validarIvaVentaPct((req.body || {}).ivaVentaPct);
    } catch (err) {
      return { error: err.message };
    }
    const nuevo = { ...leerCosteo(), ivaVentaPct };
    guardarJSON(COSTEO_PATH, nuevo);
    return datosGanancia(nuevo);
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
    // El IVA de venta es el global de la config (ivaVentaPct), no la alícuota del producto.
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
    const costeo = leerCosteo();
    if (tipo === 'fraccionado') return gruposFraccionado(costeo);
    if (tipo !== 'almacen') return { error: 'tipo no soportado todavía' };
    const filas = await filasAlmacen(costeo);
    // Listado liviano: sin el desglose de componentes (eso es para detalle).
    return filas.map(f => ({
      plu: f.plu, nombre: f.nombre, costoBase: f.costoBase, costoTotal: f.costoTotal, markupPct: f.markupPct, banda: f.banda,
      markupBanda: f.markupBanda, markupOverride: f.markupOverride, gananciaBanda: f.gananciaBanda, gastosVentaPct: f.gastosVentaPct,
      gananciaCurva: f.gananciaCurva, gananciaOverride: f.gananciaOverride,
      costoOverride: f.costoOverride, costoFuente: f.costoFuente,
      costosExtra: f.costosExtra, costoExtraTotal: f.costoExtraTotal,
      precioNeto: f.precioNeto, precioConIva: f.precioConIva, precioVigente: f.precioVigente,
      costoReal: f.costoReal, gananciaPct: f.gananciaPct, markupFinalPct: f.markupFinalPct, ivaPct: f.ivaPct, finalPct: f.finalPct,
      deltaPct: f.deltaPct, semaforo: f.semaforo, faltantes: f.faltantes,
      costoSistema: f.costoSistema, costoSistemaConIva: f.costoSistemaConIva, ivaCompraPct: f.ivaCompraPct, precioUltimaCompra: f.precioUltimaCompra,
      tipoComprobanteUltimaCompra: f.tipoComprobanteUltimaCompra,
      proveedor: f.proveedor, fechaUltimaCompra: f.fechaUltimaCompra, ingresoHoy: f.ingresoHoy, compraHoy: f.compraHoy,
      marcado: f.marcado, packBulto: f.packBulto, fechaPrecio: f.fechaPrecio,
    }));
  }));

  router.get('/api/precios/detalle/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const costeo = leerCosteo();
    if (String(req.query.tipo || '') === 'fraccionado') {
      // ponytail: arma todos los grupos para devolver uno (mismo criterio que Almacén abajo).
      const grupo = (await gruposFraccionado(costeo)).find(g => g.granelPlu === plu);
      return grupo || { error: `Granel ${plu} no encontrado en Fraccionado` };
    }
    const filas = await filasAlmacen(costeo);
    const fila = filas.find(f => f.plu === plu);
    if (!fila) return { error: `PLU ${plu} no encontrado en el universo Reventa` };
    return fila;
  }));

  // Config general (cualquier subconjunto). Valida todo antes de escribir y sólo toca esas claves.
  const LIMITES_GENERAL = { toleranciaPct: 100, costoHora: 10000000 };
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
    const costeo = { ...leerCosteo(), ...cambios };
    guardarJSON(COSTEO_PATH, costeo);
    return { costoHora: costeo.costoHora, toleranciaPct: costeo.toleranciaPct };
  }));

  // Gastos sobre venta. body { items, conservarPrecios }: conservarPrecios (default true) reescala las
  // curvas de ganancia para que el markup total (y los precios) no cambien. Valida todo (gastos + curvas
  // reescaladas) antes de escribir; el total no se guarda, se calcula.
  router.put('/api/precios/config/gastos-venta', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const costeo = leerCosteo();
    let nuevo;
    try {
      nuevo = conCambiosDeGastos(costeo, { gastosVenta: preciosCosteo.validarGastosVenta(body.items) }, body.conservarPrecios, crearTipoDePlu());
    } catch (err) {
      return { error: err.message };
    }
    guardarJSON(COSTEO_PATH, nuevo);
    return respuestaGastos(nuevo);
  }));

  // Departamentos + venta base (tab Costos). body { items, ventaBase: { meses, manual }, conservarPrecios }:
  // mismo criterio que gastos-venta (reescala por tipo para no mover precios). El snapshot de SIGA no
  // viene del body: se conserva el guardado (lo escribe POST costos/venta-base/actualizar).
  router.put('/api/precios/config/departamentos', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const costeo = leerCosteo();
    let nuevo;
    try {
      const departamentos = preciosCostos.validarDepartamentos(body.items);
      const guardada = preciosCostos.ventaBaseConDefault(costeo.ventaBase);
      // El flag de Producción sin departamentos se conserva si el body no lo trae; cambiarlo con conservarPrecios reescala.
      const ventaBase = { produccionSinDepartamentos: guardada.produccionSinDepartamentos, ...preciosCostos.validarVentaBase(body.ventaBase),
        snapshot: guardada.snapshot };
      nuevo = conCambiosDeGastos(costeo, { departamentos, ventaBase }, body.conservarPrecios, crearTipoDePlu());
    } catch (err) {
      return { error: err.message };
    }
    guardarJSON(COSTEO_PATH, nuevo);
    return respuestaGastos(nuevo);
  }));

  // Venta mensual base por tipo desde SIGA (body opcional { meses }; default el guardado). Guarda el
  // snapshot en costeo.json; el cálculo de precios nunca consulta SIGA por esto. No reescala: la venta
  // nueva es el dato real. Si deja un tipo con costo imputado sin venta, guarda igual y avisa.
  router.post('/api/precios/costos/venta-base/actualizar', apiRoute(async (req) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const guardada = preciosCostos.ventaBaseConDefault(leerCosteo().ventaBase);
    let meses;
    try {
      meses = preciosCostos.validarVentaBase({ meses: body.meses ?? guardada.meses }).meses;
    } catch (err) {
      return { error: err.message };
    }
    const vinculos = await vinculosDe(leerCosteo());
    const rows = await query(preciosCostos.sqlVentaPorTipo({ ...preciosCostos.rangoVentaBase(meses), plusProduccion: plusProduccion(vinculos) }));
    const snapshot = preciosCostos.snapshotVentaBase(rows, meses, hoyISO());
    const actual = leerCosteo(); // releído: pudo cambiar durante la query
    const nuevo = { ...actual, ventaBase: { ...preciosCostos.ventaBaseConDefault(actual.ventaBase), meses, snapshot } };
    guardarJSON(COSTEO_PATH, nuevo);
    let aviso = null;
    try { preciosCostos.validarEstructuraCostos(nuevo); } catch (err) { aviso = err.message; }
    return { ...datosCostos(nuevo), aviso };
  }));

  // Curva de ganancia de un tipo (almacen | fraccionado | produccion): valida antes de escribir, sólo toca ese tipo.
  router.put('/api/precios/config/curva-ganancia/:tipo', apiRoute(async (req) => {
    let curva;
    try {
      curva = preciosCosteo.validarCurvaGanancia(req.body, String(req.params.tipo || ''));
    } catch (err) {
      return { error: err.message };
    }
    const costeo = leerCosteo();
    const curvaGanancia = { ...(costeo.curvaGanancia || {}), [req.params.tipo]: curva };
    guardarJSON(COSTEO_PATH, { ...costeo, curvaGanancia });
    return { curvaGanancia: preciosCosteo.curvasGananciaConDefault(curvaGanancia) };
  }));

  // Propuesta de curva ajustada a los precios vigentes de SIGA. NO guarda: la UI la muestra y el
  // usuario la acepta/corrige y guarda con el PUT de arriba.
  // Producción la atiende rutas_precios_produccion.js (mismo path, montado después): next().
  const ajustarCurva = apiRoute(async (req) => {
    const tipo = String(req.params.tipo || '');
    if (!preciosCosteo.TIPOS_CURVA.includes(tipo)) return { error: `tipo inválido (${preciosCosteo.TIPOS_CURVA.join(', ')})` };
    const costeo = leerCosteo();
    const gastosPct = preciosCostos.gastosVentaPctTipo(costeo, tipo);
    if (gastosPct == null) return { error: 'falta la venta mensual base de este tipo (tab Costos): sin ella no se conocen los gastos sobre venta' };
    const datos = tipo === 'almacen' ? await filasAlmacen(costeo) : await gruposFraccionado(costeo);
    try {
      return preciosCosteo.propuestaCurva(tipo, datos, {
        gastosPct, conceptosPct: preciosCosteo.totalConceptosGanancia(costeo.conceptosGanancia),
        tramosG: ((preciosCosteo.curvasGananciaConDefault(costeo.curvaGanancia).fraccionado.ajustesPeso || {}).tramosG)
          || preciosCosteo.TRAMOS_PESO_DEFAULT,
      });
    } catch (err) {
      return { error: err.message };
    }
  });
  router.post('/api/precios/curva-ganancia/ajustar/:tipo', (req, res, next) =>
    (req.params.tipo === 'produccion' ? next() : ajustarCurva(req, res, next)));

  // Valores manuales por producto en costeo.json (un mapa plu → número). valor null quita
  // la entrada (vuelve al automático). Sólo toca esa clave del archivo.
  function guardarValorProducto({ clave, plu, raw, min, max, excluirMin }) {
    if (!/^[\w-]{1,30}$/.test(plu)) return { error: 'PLU inválido' };
    const costeo = leerCosteo();
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

  // Ganancia propia (margenPorProducto[plu], % s/ costo real): reemplaza curva + conceptos de ganancia; el costo
  // real (gastos del tipo) sigue igual. { gananciaPct: null } la quita. Mínimo negativo: un precio de SIGA por
  // debajo del costo es dato real (ver alinear-siga).
  const MARKUP_MIN_PCT = -99;
  const MARKUP_MAX_PCT = 1000;
  router.put('/api/precios/margen-producto/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'margenPorProducto', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).gananciaPct, min: MARKUP_MIN_PCT, max: MARKUP_MAX_PCT,
  })));

  // Minutos de fraccionado propios de una presentación (minutosFraccionado[plu]); sin propios no suma MO.
  // { minutos: null } lo quita.
  router.put('/api/precios/minutos-fraccionado/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'minutosFraccionado', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).minutos, min: 0, max: MINUTOS_MO_MAX,
  })));

  // Insumos básicos propios de una presentación ($ por unidad, insumosFraccionado[plu]); sin propios no
  // suma insumos. { pesos: null } lo quita.
  router.put('/api/precios/insumos-fraccionado/:plu', apiRoute(async (req) => guardarValorProducto({
    clave: 'insumosFraccionado', plu: String(req.params.plu || '').trim(),
    raw: (req.body || {}).pesos, min: 0, max: INSUMOS_FRACC_MAX,
  })));

  // Alinear con SIGA: ganancia propia por producto que reproduce su precio vigente con el costo actual y los
  // gastos de su tipo. Pisa los margenPorProducto de esos productos; sólo toca esa clave de costeo.json.
  router.post('/api/precios/alinear-siga', apiRoute(async () => {
    const costeo = leerCosteo();
    const [filas, grupos] = await Promise.all([filasAlmacen(costeo), gruposFraccionado(costeo)]);
    // Fraccionado: cada presentación se alinea con su costo $/kg (granel base + costos extra + MO
    // de fraccionado de esa presentación).
    const gastosFracc = preciosCostos.gastosVentaPctTipo(costeo, 'fraccionado');
    const presentaciones = grupos.flatMap(g => g.presentaciones.map(p => ({
      plu: p.plu, costoTotal: p.costoKg, precioVigente: p.precioVigente, ivaPct: p.ivaPct, finalPct: p.finalPct, gastosVentaPct: gastosFracc,
    })));
    const { ganancias, alineados, sinDatos, negativos } = markupsAlineadosConSiga([...filas, ...presentaciones]);
    const actual = leerCosteo();
    guardarJSON(COSTEO_PATH, { ...actual, margenPorProducto: { ...(actual.margenPorProducto || {}), ...ganancias } });
    return { alineados, sinDatos, negativos };
  }));

  // ── Márgenes propios → curva, gradual (spec Parte E.1) ─────────────────────
  // Presentaciones de Producción costeadas con la config (mismo costearTodos que la tab Producción).
  async function presentacionesProduccion(costeo) {
    const datos = normalizarDatos(leerJSON(path.join(DATA_DIR, 'recetas_produccion.json'), {}));
    const costos = await costosPorPlu(plusUsados(datos.productos));
    const costeados = costearTodos({ productos: datos.productos, costos, costeo, datos });
    return Object.values(costeados).flatMap(c => Object.entries(c.presentaciones || {})
      .map(([plu, p]) => ({ plu, nombre: p.nombre || c.nombre, costoUnidad: p.costoUnidad })));
  }
  async function planMargenes(costeo, topePct) {
    const [filas, grupos, produccion] = await Promise.all([filasAlmacen(costeo), gruposFraccionado(costeo), presentacionesProduccion(costeo)]);
    return preciosMargenes.planMargenesPropios({ costeo, topePct, items: preciosMargenes.itemsDesdeListados({ filas, grupos, produccion }) });
  }
  const sinCambios = ({ cambios: _c, ...resumen }) => resumen;
  const topeDe = req => preciosMargenes.validarTopePct(((req.body && typeof req.body === 'object') ? req.body : {}).topePct);

  // Cantidad por tipo (sin SIGA: tipo del PLU por recetas/fórmulas, como la migración) y tope default.
  router.get('/api/precios/margenes-propios', apiRoute(async () => ({
    ...preciosMargenes.contarMargenesPropios(leerCosteo(), crearTipoDePlu()),
    topeDefaultPct: preciosMargenes.TOPE_DEFAULT_PCT, topeRangoPct: preciosMargenes.TOPE_RANGO_PCT,
  })));

  // { topePct } → resumen del paso (no escribe).
  router.post('/api/precios/margenes-propios/previsualizar', apiRoute(async (req) => {
    let topePct;
    try { topePct = topeDe(req); } catch (err) { return { error: err.message }; }
    return sinCambios(await planMargenes(leerCosteo(), topePct));
  }));

  // { topePct } → aplica el paso (backup data/costeo.json.bak-margenes-AAAAMMDD-HHMM) y devuelve el mismo resumen +
  // aplicados/omitidos (omitidos = editados entre el cálculo y la escritura). Sólo toca márgenes propios y temporales.
  router.post('/api/precios/margenes-propios/aplicar', apiRoute(async (req) => {
    let topePct;
    try { topePct = topeDe(req); } catch (err) { return { error: err.message }; }
    const plan = await planMargenes(leerCosteo(), topePct);
    const actual = leerCosteo(); // releído: pudo cambiar durante las queries
    const r = preciosMargenes.aplicarPlanMargenes(actual, plan.cambios);
    guardarJSON(`${COSTEO_PATH}.bak-margenes-${preciosMargenes.sufijoBackup()}`, leerJSON(COSTEO_PATH, COSTEO_DEFAULT));
    guardarJSON(COSTEO_PATH, r.costeo);
    return { ...sinCambios(plan), aplicados: r.aplicados, omitidos: r.omitidos };
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
    const costeo = leerCosteo();
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
    const costeo = leerCosteo();
    const r = aplicarTemporal(costeo.presentacionesTemporales, plu, { op, id, datos });
    if (r.error) return r;
    guardarJSON(COSTEO_PATH, { ...costeo, presentacionesTemporales: r.mapa });
    return { granelPlu: plu, temporal: r.item, temporales: r.mapa[plu] || [] };
  }
  router.post('/api/precios/presentaciones-temporales/:granelPlu', apiRoute(async (req) => guardarTemporal(req, 'crear')));
  router.put('/api/precios/presentaciones-temporales/:granelPlu/:id', apiRoute(async (req) => guardarTemporal(req, 'editar')));
  router.delete('/api/precios/presentaciones-temporales/:granelPlu/:id', apiRoute(async (req) => guardarTemporal(req, 'borrar')));

  // Fuente del costo base de un producto ('sistema' = PrecioCosto de SIGA neto, ver filaCostos
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
      const costeo = leerCosteo();
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
    const costeo = leerCosteo();
    const mapa = aplicarMarcados(costeo.marcadosExportar, plus, marcado, hoyISO());
    guardarJSON(COSTEO_PATH, { ...costeo, marcadosExportar: mapa });
    return { marcados: Object.keys(mapa) };
  }));

  router.delete('/api/precios/marcados', apiRoute(async () => {
    const costeo = leerCosteo();
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

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Datos de la tab Costos que acompañan a la config (GET config, PUT gastos/departamentos, venta base).
function datosCostos(costeo) {
  return {
    departamentos: Array.isArray(costeo.departamentos) ? costeo.departamentos : [],
    ventaBase: preciosCostos.ventaBaseConDefault(costeo.ventaBase),
    gastosVentaPctPorTipo: preciosCostos.gastosPorTipo(costeo),
    estructuraCostos: preciosCostos.estructuraCostos(costeo),
  };
}

// Datos de ganancia, conceptos sobre precio final e IVA de venta (GET config, PUT ganancia, PUT iva-venta).
function datosGanancia(costeo) {
  const conceptosGanancia = preciosCosteo.conceptosGananciaDe(costeo);
  const conceptosPrecioFinal = preciosCosteo.conceptosPrecioFinalDe(costeo);
  return {
    conceptosGanancia, conceptosGananciaPct: preciosCosteo.totalConceptosGanancia(conceptosGanancia),
    conceptosPrecioFinal, conceptosPrecioFinalPct: preciosCosteo.totalConceptosGanancia(conceptosPrecioFinal),
    ivaVentaPct: preciosCosteo.ivaVentaPctDe(costeo),
  };
}

// Aplica cambios a gastos variables / departamentos / venta base. conservarPrecios (default true) reescala
// las curvas de cada tipo (y las ganancias propias, con el tipo de cada PLU de tipoDePlu) con sus gastos
// viejo → nuevo para que el precio no cambie; los conceptos de ganancia no se tocan. Valida todo (estructura
// de costos + curvas reescaladas) y devuelve el costeo nuevo, o tira.
function conCambiosDeGastos(costeo, cambios, conservarPrecios, tipoDePlu) {
  const base = { ...costeo, ...cambios };
  preciosCostos.validarEstructuraCostos(base);
  const viejo = preciosCostos.gastosPorTipo(costeo), nuevoG = preciosCostos.gastosPorTipo(base);
  const nuevo = conservarPrecios === false ? base
    : preciosCosteo.reescalarGananciasPropias(preciosCosteo.reescalarGanancias(base, viejo, nuevoG), viejo, nuevoG, tipoDePlu);
  for (const [tipo, c] of Object.entries(nuevo.curvaGanancia || {})) preciosCosteo.validarCurvaGanancia(c, tipo);
  return nuevo;
}

function respuestaGastos(nuevo) {
  return {
    gastosVenta: nuevo.gastosVenta, gastosVentaPct: preciosCosteo.totalGastosVenta(nuevo.gastosVenta),
    ...datosCostos(nuevo),
    curvaGanancia: preciosCosteo.curvasGananciaConDefault(nuevo.curvaGanancia),
  };
}

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

// Markup de un producto Almacén. Ganancia standard (gananciaBanda) = curva de Reventa sobre el costo base neto
// (gananciaCurva) + conceptos de ganancia; la ganancia propia del producto (gananciaOverride) reemplaza a las
// dos. markup total = (1 + ganancia) ÷ (1 − gastos del tipo) − 1 (markupBanda: el de la standard, que el detalle
// muestra al lado del propio; markupOverride: el de la propia). Los nombres gananciaBanda/markupBanda/banda
// quedaron de las bandas (reemplazadas por la curva): banda es 'curva' u 'override'.
function markupAlmacen(cfg, plu, costoBase) {
  const gastosVentaPct = preciosCostos.gastosVentaPctTipo(cfg, 'almacen');
  const conceptos = preciosCosteo.conceptosGananciaDe(cfg);
  const gananciaCurva = preciosCosteo.gananciaPorCurva((cfg.curvaGanancia || {}).almacen, costoBase);
  const gananciaBanda = preciosCosteo.gananciaStandard(gananciaCurva, preciosCosteo.totalConceptosGanancia(conceptos));
  const markupBanda = gananciaBanda == null ? null : preciosCosteo.markupDesdeGanancia(gananciaBanda, gastosVentaPct);
  const gananciaOverride = numeroONull((cfg.margenPorProducto || {})[plu]);
  const markupOverride = gananciaOverride == null ? null : preciosCosteo.markupDesdeGanancia(gananciaOverride, gastosVentaPct);
  const propia = gananciaOverride != null;
  return {
    markupPct: propia ? markupOverride : markupBanda, banda: propia ? 'override' : gananciaBanda == null ? null : 'curva',
    markupBanda, markupOverride, gananciaBanda, gananciaCurva, gananciaOverride, gastosVentaPct,
    gastos: preciosCostos.gastosDesglosePct(cfg, 'almacen'), conceptos: propia ? [] : conceptos,
  };
}

// "Alineado exacto": si el precio final exacto reproduce el vigente de SIGA (±$0,50) se respeta ese precio en vez
// del múltiplo de $50 (un producto alineado da 0 %). Devuelve los campos de precio a pisar (markup final incluido).
function alinearConVigente(c, precioVigente, costo) {
  if (!(precioVigente > 0) || c.precioConIvaExacto == null || Math.abs(c.precioConIvaExacto - precioVigente) >= 0.5) return {};
  return { precioConIva: precioVigente, markupFinalPct: preciosCosteo.markupFinalPct(precioVigente, costo) };
}

// Fila calculada para un producto Almacén: costeo (curva + markup, redondeo a $50) contra el precio
// vigente de mostrador. Pura — sin SQL/fs — para poder testearla sin base de datos; la SQL
// vive en universoAlmacen/preciosVigentesAlmacen arriba, que son lo único que necesita `query`.
// precioConIva es el precio final con el IVA de venta de la config (ivaVentaPct): se compara con el vigente de
// SIGA. Costos netos.
function calcularFilaAlmacen({ plu, nombre, costoMercaderia, costoSistema = null, precioVigente, costeoConfig }) {
  const cfg = costeoConfig || {};
  // Costo base (manual → última compra si se eligió → sistema neto): preciosCosteo.elegirCosto,
  // el mismo criterio que el granel de Fraccionado. La curva se busca por el costo que efectivamente se usa.
  const { costoBase, costoFuente, costoOverride } = preciosCosteo.elegirCosto({
    plu, costoUltimaCompra: costoMercaderia, costoSistema, cfg,
  });
  const { markupPct, banda, markupBanda, markupOverride, gananciaBanda, gananciaCurva, gananciaOverride, gastosVentaPct, gastos, conceptos } = markupAlmacen(cfg, plu, costoBase);
  // Costos extra del producto: misma clave que los graneles de Fraccionado (ver COSTEO_DEFAULT).
  const costosExtra = costosExtraDe(cfg, plu);
  const calculado = preciosCosteo.costearAlmacen({
    costoMercaderia: costoBase, costosExtra, markupPct, banda, plu, nombre, gastos, ivaPct: preciosCosteo.ivaVentaPctDe(cfg), conceptos,
    conceptosFinal: preciosCosteo.conceptosPrecioFinalDe(cfg),
  });
  // Sólo los extras del producto, como en Fraccionado.
  const conExtras = preciosCosteo.aplicarCostosExtra(calculado.costoTotal == null ? null : costoBase, costosExtra, '$');
  const costoExtraTotal = conExtras.costoTotal == null ? null
    : Math.round((conExtras.costoTotal - costoBase) * 100) / 100;
  // El redondeo a $50 se aplica cuando el precio cambia; si costo y markup reproducen el precio
  // vigente de SIGA, se respeta ese precio (así un producto alineado da 0% aunque SIGA no
  // tenga el precio en múltiplo de 50).
  const costeado = { ...calculado, ...alinearConVigente(calculado, precioVigente, calculado.costoTotal) };
  // semaforo: 'ok' | 'subir' | 'bajar' | null (sin vigente o sin precio sugerido).
  const { deltaPct, estado: semaforo } = preciosCosteo.compararConVigente(costeado.precioConIva, precioVigente, cfg.toleranciaPct);
  return {
    ...costeado, markupBanda, markupOverride, gananciaBanda, gananciaCurva, gananciaOverride, gastosVentaPct, costosExtra, costoExtraTotal,
    costoBase: costoBase != null ? costoBase : null, costoOverride, costoFuente,
    costoSistema: costoSistema != null ? costoSistema : null,
    precioUltimaCompra: costoMercaderia != null ? costoMercaderia : null,
    precioVigente: precioVigente != null ? precioVigente : null, deltaPct, semaforo,
  };
}

// Tope de minutos de fraccionado propios por unidad.
const MINUTOS_MO_MAX = 600;
// Tope de insumos básicos de fraccionado propios, $ por unidad.
const INSUMOS_FRACC_MAX = 10000000;

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
      presentaciones: [],
      packBultoGranel: plu == null ? [] : packBultoDe(plu, null),
    };
  };
  for (const g of graneles || []) grupos.set(g.plu, nuevoGrupo(g.plu, g.nombre));
  const granelPorNombre = crearGranelPorNombre(graneles);
  const sinGranel = nuevoGrupo(null, SIN_GRANEL);
  const ctx = {
    overrides, vigentes, toleranciaPct: cfg.toleranciaPct, curva: (cfg.curvaGanancia || {}).fraccionado,
    gastosVentaPct: preciosCostos.gastosVentaPctTipo(cfg, 'fraccionado'),
    gastos: preciosCostos.gastosDesglosePct(cfg, 'fraccionado'),
    conceptos: preciosCosteo.conceptosGananciaDe(cfg), ivaPct: preciosCosteo.ivaVentaPctDe(cfg),
    conceptosFinal: preciosCosteo.conceptosPrecioFinalDe(cfg),
    mo: { costoHora: Number(cfg.costoHora) || 0, overrides: cfg.minutosFraccionado || {} },
    ins: { overrides: cfg.insumosFraccionado || {} },
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

// Mano de obra de fraccionado: minutos propios por unidad (por PLU) × costoHora/60, pasada a $/kg con el peso
// de la presentación. Sin minutos propios no suma MO (no hay standard). Minutos > 0 sin peso → costoMoKg null
// (faltante pesoMo).
function manoObraFraccionado({ minutosOverride = null, pesoKg, mo }) {
  const minutos = minutosOverride ?? 0;
  const costoMoKg = !(minutos > 0) ? 0 : pesoKg > 0 ? preciosCosteo.redondear2(mo.costoHora / 60 * minutos / pesoKg) : null;
  return { minutosOverride, minutos, costoMoKg };
}

// Insumos básicos de fraccionado (bolsa, etiqueta...): $ propios por unidad (por PLU) pasados a $/kg con el
// peso. Mismo criterio que la MO: sin propios no suma, $ > 0 sin peso → null.
function insumosFraccionado({ insumosOverride = null, pesoKg }) {
  const insumos = insumosOverride ?? 0;
  const costoInsumosKg = !(insumos > 0) ? 0 : pesoKg > 0 ? preciosCosteo.redondear2(insumos / pesoKg) : null;
  return { insumosOverride, insumos, costoInsumosKg };
}

// Costo $/kg de una presentación = costo total del granel + MO + insumos. plu null (temporal) = sin MO ni insumos.
function costosPresentacion({ plu = null, pesoKg, costoTotal, ctx }) {
  const propios = mapa => (plu == null ? null : numeroONull(mapa[plu]));
  const manoObra = manoObraFraccionado({ minutosOverride: propios(ctx.mo.overrides), pesoKg, mo: ctx.mo });
  const insumos = insumosFraccionado({ insumosOverride: propios(ctx.ins.overrides), pesoKg });
  const partes = [costoTotal, manoObra.costoMoKg, insumos.costoInsumosKg];
  const costoKg = partes.some(v => v == null) ? null : preciosCosteo.redondear2(partes.reduce((s, v) => s + v, 0));
  return { ...manoObra, ...insumos, costoKg };
}

// Margen standard: curva de Fraccionado (costo base neto del granel + ajuste por tramo de peso) + conceptos de
// ganancia = GANANCIA standard (gananciaStd); markupStd es el markup total con los gastos del tipo.
function stdFraccionado(costoBase, pesoG, ctx) {
  const gananciaStd = preciosCosteo.gananciaStandard(preciosCosteo.gananciaPorCurva(ctx.curva, costoBase, pesoG),
    preciosCosteo.totalConceptosGanancia(ctx.conceptos));
  return { gananciaStd, markupStd: gananciaStd == null ? null : preciosCosteo.markupDesdeGanancia(gananciaStd, ctx.gastosVentaPct) };
}

// Ganancia propia (reemplaza curva + conceptos) → markup total con los gastos del tipo, o el standard.
function margenFraccionado(gananciaOverride, std, ctx) {
  const markupOverride = gananciaOverride == null ? null : preciosCosteo.markupDesdeGanancia(gananciaOverride, ctx.gastosVentaPct);
  const propia = gananciaOverride != null;
  return { markupOverride, markupPct: propia ? markupOverride : std.markupStd, conceptos: propia ? [] : ctx.conceptos };
}

function filaPresentacion(p, grupo, ctx) {
  const pesoKg = pesoTokenKg(p.nombre);
  const pesoG = pesoKg > 0 ? Math.round(pesoKg * 1000) : null;
  // La curva del margen standard se busca con el costo SELECCIONADO (costoBase), no con
  // base + extras — igual que Almacén busca la curva por costoBase y suma los extras aparte.
  // El precio sí se calcula sobre costoKg (base + costos extra del granel + MO + insumos).
  const std = stdFraccionado(grupo.costoBase, pesoG, ctx);
  const { gananciaStd, markupStd } = std;
  const gananciaOverride = numeroONull(ctx.overrides[p.plu]);
  const m = margenFraccionado(gananciaOverride, std, ctx);
  const markupOverride = m.markupOverride;
  const costos = costosPresentacion({ plu: p.plu, pesoKg, costoTotal: grupo.costoTotal, ctx });
  const c = preciosCosteo.costearFraccionado({
    plu: p.plu, nombre: p.nombre, costoKg: costos.costoKg, markupPct: m.markupPct,
    gastos: ctx.gastos, ivaPct: ctx.ivaPct, conceptos: m.conceptos, conceptosFinal: ctx.conceptosFinal,
  });
  const precioVigente = ctx.vigentes.has(p.plu) ? ctx.vigentes.get(p.plu) : null;
  // Misma regla "alineado exacto" que Almacén: si reproduce el vigente, se respeta ese precio.
  const { precioConIva, markupFinalPct } = { ...c, ...alinearConVigente(c, precioVigente, c.costoTotal) };
  const { deltaPct, estado: semaforo } = preciosCosteo.compararConVigente(precioConIva, precioVigente, ctx.toleranciaPct);
  return {
    plu: p.plu, nombre: p.nombre, ventaDirecta: !!p.ventaDirecta,
    presentacion: etiquetaPeso(pesoG), pesoG,
    gananciaStd, markupStd, gananciaOverride, markupOverride, markupPct: c.markupPct, ...costos,
    ...camposDesglose(c), markupFinalPct,
    precioNeto: c.precioNeto, precioConIva, precioVigente, deltaPct, semaforo,
    // Sin costo el standard tampoco existe: el faltante real es el costo, no el margen.
    faltantes: grupo.granelPlu == null ? ['granel'] : grupo.costoBase == null ? ['costoGranel']
      : costos.costoMoKg == null || costos.costoInsumosKg == null ? ['pesoMo'] : c.faltantes,
  };
}

// Campos del desglose neto/IVA de un costeo Fraccionado que viajan en cada presentación.
const camposDesglose = c => ({
  costoReal: c.costoReal, gananciaPct: c.gananciaPct, ivaPct: c.ivaPct, finalPct: c.finalPct,
  markupFinalPct: c.markupFinalPct, desglose: c.desglose,
});

const etiquetaPeso = pesoG => (pesoG == null ? '' : pesoG >= 1000 ? `${pesoG / 1000}KG` : `${pesoG}G`);

// Presentación temporal (simulada): mismo costo del granel y margen (standard por pesoG o ganancia propia
// gananciaPct) que una real, pero sin PLU ni precio vigente → sin semáforo; nunca marcable.
// MO e insumos: sin PLU no hay valores propios → no suman.
function filaTemporal(t, grupo, ctx) {
  const std = stdFraccionado(grupo.costoBase, t.pesoG, ctx);
  const { gananciaStd, markupStd } = std;
  const gananciaOverride = numeroONull(t.gananciaPct);
  const m = margenFraccionado(gananciaOverride, std, ctx);
  const markupOverride = m.markupOverride;
  const costos = costosPresentacion({ pesoKg: t.pesoG / 1000, costoTotal: grupo.costoTotal, ctx });
  const c = preciosCosteo.costearFraccionado({
    plu: null, nombre: t.nombre || null, costoKg: costos.costoKg, markupPct: m.markupPct,
    gastos: ctx.gastos, ivaPct: ctx.ivaPct, conceptos: m.conceptos, conceptosFinal: ctx.conceptosFinal,
  });
  return {
    id: t.id, temporal: true, nombre: t.nombre || null,
    presentacion: etiquetaPeso(t.pesoG), pesoG: t.pesoG,
    gananciaStd, markupStd, gananciaOverride, markupOverride, markupPct: c.markupPct, ...camposDesglose(c),
    costoMoKg: costos.costoMoKg, costoInsumosKg: costos.costoInsumosKg, costoKg: costos.costoKg,
    precioNeto: c.precioNeto, precioConIva: c.precioConIva, precioVigente: null, deltaPct: null, semaforo: null,
    faltantes: grupo.costoBase == null ? ['costoGranel'] : c.faltantes,
    marcado: false,
  };
}

// Ganancia propia por producto que reproduce el precio vigente de SIGA (× (1 − F) ÷ (1 + IVA de venta), con ivaPct y
// finalPct de la fila) con el costo neto total actual y los gastos de su tipo (gastosVentaPct de la fila): g = (1 + m)(1 − G) − 1.
// Filas sin costoTotal, sin vigente o con gastos desconocidos cuentan en sinDatos; negativos = vigente bajo el
// costo neto (se incluyen igual).
function markupsAlineadosConSiga(filas) {
  const ganancias = {};
  let sinDatos = 0, negativos = 0;
  for (const f of filas || []) {
    const m = f.costoTotal > 0 && f.precioVigente > 0
      ? preciosCosteo.markupParaPrecio(f.costoTotal, f.precioVigente, f.ivaPct, f.finalPct) : null;
    const g = m == null ? null : preciosCosteo.gananciaDesdeMarkup(m, f.gastosVentaPct === undefined ? 0 : f.gastosVentaPct);
    if (g == null) { sinDatos++; continue; }
    ganancias[f.plu] = g;
    if (m < 0) negativos++;
  }
  return { ganancias, alineados: Object.keys(ganancias).length, sinDatos, negativos };
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
module.exports.aplicarTemporal = aplicarTemporal;
module.exports.TEMPORALES_MAX = TEMPORALES_MAX;
