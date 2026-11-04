'use strict';
const express = require('express');
const path = require('path');
const cfgEsq = require('../lib/precios_config_esquema');
const { rangoDesdeCostos } = require('../lib/precios_esquema');
const L = require('../lib/precios_listado_esquema');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const { normalizarCosteoFraccionado, plusInsumos } = require('../lib/precios_fraccionado_costo');
const { formulasPesables } = require('../lib/formulas_pesables');
const { plusVentaProduccion, validarMargenProducto, validarPrecioFijo } = require('../lib/precios_produccion');
// Costeo de Producción (sin el router): costo por unidad de cada presentación.
const { costearTodos, plusUsados, normalizarDatos } = require('./rutas_precios_produccion');

// ── Precios · esquema por canal (spec 2026-10-07-precios-esquema-canales-design) ────────────────────────────
// Configuración nueva (Costos, Márgenes, Precio, rango desde SIGA); en la fase 3 también listados, detalle, decisión
// y export. Router propio: rutas_precios.js ya pasa las 800 líneas (se achica en la fase 5). /api/precios/config/esquema/*
// queda detrás del permiso precios-config por RUTAS_CONFIG (lib/precios_permisos), sin tocar el guard.
module.exports = function crearRutasPreciosEsquema(deps) {
  const { apiRoute, leerJSON, guardarJSON, DATA_DIR } = deps;
  const router = express.Router();
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const RECETAS_PATH = path.join(DATA_DIR, 'recetas_produccion.json');
  const consultas = crearConsultasPrecios(deps);
  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  const cuerpo = req => (req.body && typeof req.body === 'object' ? req.body : {});
  const formulasVigentes = () => formulasPesables({ query: deps.query, FORMULA_ACTIVA_SQL: deps.FORMULA_ACTIVA_SQL,
    respaldo: (leerJSON(path.join(DATA_DIR, 'pesables_listas.json'), {}) || {}).formulas });
  // Costeo sin las decisiones vencidas (SIGA cambió el precio decidido, spec §3); las poda del archivo una vez por carga.
  // ponytail: repite la consulta de vigentes que después hace contexto(); compartirla si pesa.
  const costeoVigente = () => L.leerCosteoVigente({ leerCosteo, guardarCosteo: c => guardarJSON(COSTEO_PATH, c), preciosVigentes: consultas.preciosVigentesAlmacen });
  const usuarioDe = req => (req.session && req.session.user && req.session.user.usuario) || null;

  // Presentaciones de Producción con su costo por unidad y "a revisar" (el mismo costearTodos que la tab Producción).
  // Cada PLU de una variedad envasada es una presentación más, marcada tipoProduccion 'envasado', con granel + insumos y su
  // familia › variedad (grupo del listado). Las de receta llevan sus materias primas por unidad + sus insumos + la mano de obra
  // ("Ver detalle" del modal; el envasado ya trae granel + insumos + MO en componentes). filaPublica lo saca sin el permiso.
  async function presentacionesProduccion(costeo) {
    const datos = normalizarDatos(leerJSON(RECETAS_PATH, {}));
    const costos = await consultas.costosPorPlu(plusUsados(datos.productos));
    const costeados = costearTodos({ productos: datos.productos, costos, costeo, familias: datos.familias });
    return Object.entries(costeados).flatMap(([productoId, c]) => Object.entries(c.presentaciones || {})
      .map(([plu, p]) => ({ productoId, plu, nombre: p.nombre || c.nombre, costoUnidad: p.costoUnidad, aRevisar: p.revisar,
        margenExtra: datos.productos[productoId].margenEspecial || null,
        ...(c.tipo === 'envasado' ? { tipoProduccion: 'envasado', componentesCosto: p.componentes, familia: datos.productos[productoId].familia || '', variedad: c.nombre }
          : { componentesCosto: [...p.materiasPrimas, ...p.componentes.filter(l => l.rol === 'insumo' || l.rol === 'mo')] }) })));
  }

  // ?tipo= de Configuración (switch Reventa | Fraccionado, spec 2026-10-21 §2.3): vacío/almacen = la raíz (Reventa y
  // Producción); fraccionado = costeo.fraccionado. Inválido → throw (los handlers lo devuelven como { error }).
  const tipoDe = req => {
    const t = cfgEsq.tipoConfig(req.query.tipo);
    if (!t) throw new Error(`tipo inválido (${cfgEsq.TIPOS_CONFIG.join(', ')})`);
    return t;
  };

  // Valida con validar(req, tipo) → cambios y guarda { ...costeo, ...cambios } releído (sin await entre leer y escribir); en
  // Fraccionado dentro de costeo.fraccionado (sin migrar → error, no escribe). Devuelve la vista nueva para que la UI
  // redibuje con lo guardado.
  const guardarCon = validar => apiRoute(async (req) => {
    let cambios, tipo;
    const costeo = leerCosteo();
    try { tipo = tipoDe(req); cambios = validar(req, tipo, costeo); } catch (err) { return { error: err.message }; }
    if (tipo === 'fraccionado' && !cfgEsq.fraccionadoMigrado(costeo)) return { error: cfgEsq.SIN_MIGRAR_FRACCIONADO };
    const nuevo = tipo === 'fraccionado' ? { ...costeo, fraccionado: { ...costeo.fraccionado, ...cambios } } : { ...costeo, ...cambios };
    guardarJSON(COSTEO_PATH, nuevo);
    return cfgEsq.configEsquemaDe(nuevo, tipo);
  });

  router.get('/api/precios/config/esquema', apiRoute(async (req) => {
    try { return cfgEsq.configEsquemaDe(leerCosteo(), tipoDe(req)); } catch (err) { return { error: err.message }; }
  }));
  router.put('/api/precios/config/esquema/costos', guardarCon((req, tipo) => cfgEsq.validarCostos(cuerpo(req), tipo)));
  router.put('/api/precios/config/esquema/precio', guardarCon(req => cfgEsq.validarPrecio(cuerpo(req))));
  // Costo hora de mano de obra ($/h): Producción (raíz) y Fraccionado (su bloque); minutos × costo hora ÷ 60.
  router.put('/api/precios/config/esquema/costo-hora', guardarCon(req => cfgEsq.validarCostoHora(cuerpo(req))));
  // Las 3 tablas por canal reemplazan a margenes del tipo; el ajuste por peso guardado queda (lo edita Costeo Fraccionado:
  // PUT .../fraccionado/ajustes-peso) y el del body se ignora.
  router.put('/api/precios/config/esquema/margenes', guardarCon((req, tipo, costeo) =>
    ({ margenes: cfgEsq.validarMargenes(cuerpo(req), cfgEsq.configEsquemaDe(costeo, tipo).margenes, tipo) })));

  const TIPOS_LISTADO = cfgEsq.TIPOS;
  const sinConfig = req => !!(req && req.preciosSinConfig === true); // lo marca guardPrecios (server.js)

  // Lo común a los tres listados: config del motor del tipo (Fraccionado la suya; Reventa y Producción la raíz), vigentes
  // (lista 0) y vínculos pack/bulto con sus unidades.
  async function contexto(costeo, tipo) {
    const pb = costeo.packBulto || {};
    const [vigentes, { vinculos }] = await Promise.all([consultas.preciosVigentesAlmacen(), consultas.vinculosPackBulto(pb.vinculosManuales || {})]);
    return { cfg: cfgEsq.configEsquemaDe(costeo, tipo), vigentes, mayoristasDe: L.crearMayoristasDe({ vinculos, vigentes, ventaPesable: pb.ventaPesable || {} }) };
  }

  // Filas completas (con desglose) de un tipo. ponytail: el export arma los tres y cada uno repite vigentes y vínculos
  // (dos consultas de más por tipo); compartir el contexto si el export se pone lento.
  // conActividad: sólo GET listado y detalle de Fraccionado consultan los movimientos (≈2 s en SIGA); el resto (decisión,
  // margen, export, rango) arma la fila con actividad null y no mira activo.
  async function listado(tipo, costeo, { conActividad = false } = {}) {
    if (tipo === 'almacen') {
      const [ctx, universo] = await Promise.all([contexto(costeo, tipo), consultas.universoAlmacen()]);
      const excluir = plusVentaProduccion(normalizarDatos(leerJSON(RECETAS_PATH, {})).productos);
      return L.listadoReventa({ universo, costeo, excluir, ...ctx });
    }
    if (tipo === 'fraccionado') {
      // costeo.fraccionado (Configuración › Costeo Fraccionado): sin migrar → null y el listado queda como antes.
      const costeoF = cfgEsq.fraccionadoMigrado(costeo) ? normalizarCosteoFraccionado(costeo.fraccionado) : null;
      const formulas = await formulasVigentes();
      const [ctx, { graneles, presentaciones, costos }] = await Promise.all([contexto(costeo, tipo),
        consultas.universoFraccionado(formulas, costeoF ? plusInsumos(costeoF) : [])]);
      const grupos = L.agruparPorGranel({ graneles, presentaciones, formulas, costos });
      return L.listadoFraccionado({ grupos, costos, costeo, costeoF, movimientos: conActividad ? await movimientosFraccionado(grupos) : null, ...ctx });
    }
    const [ctx, presentaciones] = await Promise.all([contexto(costeo, tipo), presentacionesProduccion(costeo)]);
    return L.listadoProduccion({ presentaciones, costeo, ...ctx });
  }

  // Movimientos de los últimos 6 meses de graneles y presentaciones (actividad, spec 2026-10-26). Si la consulta falla →
  // null: el listado sale igual, sin actividad (nadie inactivo salvo a mano) y GET listado avisa con AVISO_ACTIVIDAD.
  async function movimientosFraccionado(grupos) {
    const plus = grupos.flatMap(g => [g.plu, ...g.presentaciones.map(p => p.plu)]).filter(p => p != null);
    try {
      return await consultas.movimientosRecientes(plus, isoDe(restarMeses(new Date(), MESES_ACTIVIDAD)));
    } catch (err) {
      console.error('[precios] movimientos de Fraccionado (actividad de graneles):', err.message);
      return null;
    }
  }

  // Propuesta de rango (percentiles 5–95, rangoDesdeCostos) sobre los costos de sistema (+ costos extra) de los tipos que
  // usan las tablas: Reventa (por producto) + Producción (por presentación) con la config de la raíz, más Fraccionado
  // (por granel) mientras no esté migrado y comparta esas tablas; ?tipo=fraccionado = $/kg de mercadería por granel.
  // NO guarda: la UI la carga en las tres tablas y se guarda con Márgenes.
  router.post('/api/precios/config/esquema/rango', apiRoute(async (req) => {
    let tipo;
    try { tipo = tipoDe(req); } catch (err) { return { error: err.message }; }
    const costeo = await costeoVigente();
    const tipos = tipo === 'fraccionado' ? ['fraccionado'] : cfgEsq.fraccionadoMigrado(costeo) ? ['almacen', 'produccion'] : TIPOS_LISTADO;
    const listados = await Promise.all(tipos.map(t => listado(t, costeo)));
    const costos = listados.flat().map(f => f.costos.sistema).filter(c => c > 0);
    const rango = rangoDesdeCostos(costos);
    return rango ? { rango, n: costos.length } : { error: 'No hay suficientes costos de sistema para calcular el rango' };
  }));

  router.get('/api/precios/esquema/listado', apiRoute(async (req) => {
    const tipo = String(req.query.tipo || '');
    if (!TIPOS_LISTADO.includes(tipo)) return { error: `tipo inválido (${TIPOS_LISTADO.join(', ')})` };
    const costeo = await costeoVigente();
    const filas = await listado(tipo, costeo, { conActividad: true });
    const { migrado, toleranciaPct } = cfgEsq.configEsquemaDe(costeo, tipo);
    const sinActividad = tipo === 'fraccionado' && filas.some(f => f.plu != null && f.actividad === null);
    return { migrado, toleranciaPct, filas: filas.map(f => L.filaPublica(f)), ...(sinActividad ? { avisoActividad: AVISO_ACTIVIDAD } : {}) };
  }));

  // Una fila (Fraccionado: un granel con sus presentaciones). Desglose y costos extra sólo con el permiso.
  // ponytail: arma el listado entero para devolver una fila, como el detalle viejo.
  router.get('/api/precios/esquema/detalle/:plu', apiRoute(async (req) => {
    const tipo = String(req.query.tipo || '');
    if (!TIPOS_LISTADO.includes(tipo)) return { error: `tipo inválido (${TIPOS_LISTADO.join(', ')})` };
    const plu = String(req.params.plu || '').trim();
    const fila = (await listado(tipo, await costeoVigente(), { conActividad: true })).find(f => f.plu === plu);
    return fila ? L.filaPublica(fila, !sinConfig(req)) : { error: `PLU ${plu} no encontrado en ${tipo}` };
  }));

  // body { fuente: 'sistema' | 'ultimaCompra' | 'manual' | 'precio' | null } (null quita). Cualquier usuario del módulo. La decisión
  // guarda quién la tomó (se borra cuando ese usuario recarga /precios) y la foto de los vigentes de la fila (vence si
  // SIGA los cambia), spec §3.
  router.put('/api/precios/decision/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const body = cuerpo(req);
    if (!('fuente' in body)) return { error: 'falta fuente (sistema, ultimaCompra, manual, precio o null)' };
    let error = L.validarDecision(plu, body.fuente, leerCosteo());
    let vigente = null;
    if (!error && body.fuente != null) { // ponytail: arma los tres listados; si pesa, buscar sólo en el tipo del PLU
      const costeo = await costeoVigente();
      const [almacen, fraccionado, produccion] = await Promise.all(TIPOS_LISTADO.map(t => listado(t, costeo)));
      error = L.validarDecisionContraFilas({ almacen, fraccionado, produccion }, plu, body.fuente);
      if (!error) vigente = L.vigentesDeFila([...almacen, ...produccion, ...fraccionado].find(f => f.plu === plu));
    }
    if (error) return { error };
    const costeo = leerCosteo(); // releído tras los await: sin await entre leer y escribir
    const decisiones = L.aplicarDecision(costeo.decisiones, plu, body.fuente, hoyISO(), { usuario: usuarioDe(req), vigente });
    guardarJSON(COSTEO_PATH, { ...costeo, decisiones });
    return { plu, decision: decisiones[plu] || null };
  }));

  // Margen de un producto: body { modo, minorista?, pack?, bulto? } (validarMargenProducto). modo 'fijo' = el valor es el margen del
  // canal; 'ajuste' (o sin modo) = puntos % que se suman al margen del canal (y en Producción al especial). Clave: PLU de Reventa, granel
  // de Fraccionado (alcanza a sus presentaciones) o presentación de Producción, como la decisión. Sin valores → se borra (pasa siempre:
  // limpia PLUs que ya no están). Es configuración: va bajo /config/ (RUTAS_CONFIG) y margenProducto está en CLAVES_OCULTAS.
  // (El precio fijo de Reventa es otra cosa: PUT /api/precios/precio-fijo/:plu.)
  router.put('/api/precios/config/esquema/margen-producto/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    let margen;
    try { margen = validarMargenProducto(cuerpo(req)); } catch (err) { return { error: err.message }; }
    if (margen) {
      const costeo = await costeoVigente();
      const [almacen, fraccionado, produccion] = await Promise.all(TIPOS_LISTADO.map(t => listado(t, costeo)));
      const { error } = L.filaDecidible({ almacen, fraccionado, produccion }, plu);
      if (error) return { error };
    }
    const costeo = leerCosteo(); // releído tras los await: sin await entre leer y escribir
    const { [plu]: _viejo, ...resto } = costeo.margenProducto || {};
    const margenProducto = margen ? { ...resto, [plu]: margen } : resto;
    guardarJSON(COSTEO_PATH, { ...costeo, margenProducto });
    return { plu, margenProducto: margen };
  }));

  // Tipo de proveedor de un producto de Reventa: body { tipo: 'directo' | 'distribuidor' | null } (null quita). Cualquier
  // usuario del módulo (como el costo manual): no es configuración. Sólo PLUs del listado de Reventa; quitar pasa siempre.
  router.put('/api/precios/tipo-proveedor/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const tipo = cuerpo(req).tipo;
    const error = L.validarTipoProveedor(plu, tipo);
    if (error) return { error };
    if (tipo != null && !(await listado('almacen', leerCosteo())).some(f => f.plu === plu)) return { error: `El PLU ${plu} no es un producto de Reventa` };
    const costeo = leerCosteo(); // releído tras los await: sin await entre leer y escribir
    guardarJSON(COSTEO_PATH, { ...costeo, tipoProveedor: L.aplicarPorPlu(costeo.tipoProveedor, plu, tipo) });
    return { plu, tipoProveedor: tipo };
  }));

  // Precio fijo de un producto de Reventa (costeo.precioFijo[plu]): body { minorista?, pack?, bulto? } (validarPrecioFijo: > 0 con 2
  // decimales; null/ausente = sin precio en ese canal). Sin ningún canal se borra, y con él la decisión 'precio' del PLU (sin precio fijo
  // nunca exportaría; L.aplicarPrecioFijo). Cualquier usuario del módulo, como el costo manual: no es configuración (no va bajo /config/ y
  // precioFijo no está en CLAVES_OCULTAS: la card lo muestra). Sólo PLUs de Reventa; quitar pasa siempre (limpia PLUs que ya no están).
  router.put('/api/precios/precio-fijo/:plu', apiRoute(async (req) => {
    const plu = String(req.params.plu || '').trim();
    const errorPlu = L.validarPluSiga(plu);
    if (errorPlu) return { error: errorPlu };
    let precios;
    try { precios = validarPrecioFijo(cuerpo(req)); } catch (err) { return { error: err.message }; }
    if (precios && !(await listado('almacen', leerCosteo())).some(f => f.plu === plu)) return { error: `El PLU ${plu} no es un producto de Reventa` };
    const costeo = leerCosteo(); // releído tras los await: sin await entre leer y escribir
    guardarJSON(COSTEO_PATH, { ...costeo, ...L.aplicarPrecioFijo(costeo, plu, precios) });
    return { plu, precioFijo: precios };
  }));

  router.delete('/api/precios/decisiones', apiRoute(async () => {
    guardarJSON(COSTEO_PATH, { ...leerCosteo(), decisiones: {} });
    return { decisiones: {} };
  }));

  // Al cargar /precios el front borra las decisiones del usuario de la sesión (las de otros usuarios quedan), spec §3.
  router.delete('/api/precios/decisiones/mias', apiRoute(async (req) => {
    const usuario = usuarioDe(req);
    const costeo = leerCosteo();
    const decisiones = Object.fromEntries(Object.entries(costeo.decisiones || {}).filter(([, d]) => ((d && d.usuario) || null) !== usuario));
    const borradas = Object.keys(costeo.decisiones || {}).length - Object.keys(decisiones).length;
    if (borradas) guardarJSON(COSTEO_PATH, { ...costeo, decisiones });
    return { borradas };
  }));

  // Las 5 listas (minorista, pack/bulto sin y con IVA) de los productos decididos; el front escribe un archivo por lista.
  router.get('/api/precios/esquema/export', apiRoute(async () => {
    const costeo = await costeoVigente();
    const [almacen, fraccionado, produccion] = await Promise.all(TIPOS_LISTADO.map(t => listado(t, costeo)));
    const { items, omitidos, omitidosMayorista, omitidosDetalle } = L.itemsDecididos({ almacen, fraccionado, produccion });
    return { listas: L.listasExport(items), omitidos, omitidosMayorista, omitidosDetalle };
  }));

  // "Importar planilla" (Reventa): body { filas: [{ codigo, costo, precio, nombre? }] } (el front lee el Excel que se subió a
  // SIGA). Marca cada producto con la fuente que coincide (L.cruzarPlanilla), como PUT /decision: usuario de la sesión y foto
  // de los vigentes; todas en UNA escritura. Cualquier usuario del módulo.
  router.post('/api/precios/esquema/importar-decisiones', apiRoute(async (req) => {
    const { filas, error } = L.validarFilasPlanilla(cuerpo(req).filas);
    if (error) return { error };
    const almacen = await listado('almacen', await costeoVigente());
    const { decisiones: nuevas, ...resultado } = L.cruzarPlanilla(almacen, filas, plusVentaProduccion(normalizarDatos(leerJSON(RECETAS_PATH, {})).productos));
    const costeo = leerCosteo(); // releído tras los await: sin await entre leer y escribir
    const fecha = hoyISO(), usuario = usuarioDe(req);
    // misma forma que L.aplicarDecision, de una vez (reduce con aplicarDecision copia el mapa por fila: cuadrático)
    const decisiones = { ...costeo.decisiones, ...Object.fromEntries(nuevas.map(n => [n.plu, { fuente: n.fuente, fecha, usuario, vigente: L.vigentesDeFila(n.fila) }])) };
    if (nuevas.length) guardarJSON(COSTEO_PATH, { ...costeo, decisiones });
    return resultado;
  }));

  // Para el cotizador mayorista (routes/rutas_cotizador_mayorista): los tres listados completos con el costeo vigente.
  router.listadosVigentes = async () => {
    const costeo = await costeoVigente();
    const [almacen, fraccionado, produccion] = await Promise.all(TIPOS_LISTADO.map(t => listado(t, costeo)));
    return { almacen, fraccionado, produccion };
  };

  return router;
};

const MESES_ACTIVIDAD = 6;
const AVISO_ACTIVIDAD = 'No se pudieron consultar los movimientos de stock: no se ocultan graneles inactivos (sólo los fijados a mano).';

// Fecha nueva meses atrás; si el día no existe en ese mes, el último (31/08 − 6 → 28/02, no el 03/03 de setMonth).
function restarMeses(d, meses) {
  const ultimo = new Date(d.getFullYear(), d.getMonth() - meses + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() - meses, Math.min(d.getDate(), ultimo));
}
module.exports.restarMeses = restarMeses;

const hoyISO = () => isoDe(new Date());
function isoDe(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
