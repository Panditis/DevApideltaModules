'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const produccion = require('../lib/precios_produccion');
const { elegirCosto, compararConVigente, propuestaCurva, ivaVentaPctDe, conceptosGananciaDe, totalConceptosGanancia,
  conceptosPrecioFinalDe } = require('../lib/precios_costeo');
const { costeoConCurva } = require('../lib/precios_migracion_curva');
const { gastosVentaPctTipo, gastosDesglosePct } = require('../lib/precios_costos');
const { crearConsultasPrecios } = require('../lib/precios_consultas');
const { crearPackBultoDe } = require('../lib/precios_pack_bulto');
const { proyectarCosteo } = require('../lib/precios_permisos');

// ── Precios, Fase 3: tab Producción ──────────────────────────────────────────
// Productos con recetas (base + variantes), su lista de insumos y presentaciones (que eligen de esa lista), en data/recetas_produccion.json
// (se crea con la primera escritura). El cálculo es lib/precios_produccion.js; acá sólo se arma
// costoDe (SIGA + elegirCosto con costeo.json + insumos manuales) y se persiste.
// Selector, detalle y alertas pasan por costearProductos → costearProducto: nunca muestran cosas distintas.
// ponytail: recalcula todo en cada listado/alerta (decenas de productos); cachear costoDe si crece a miles.

const RECETAS_VACIO = { productos: {}, insumosManuales: {}, categoriasMaquina: [] };
const ID_PRODUCTO = /^p-[a-z0-9-]{1,48}$/;
const ID_RECETA = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_MANUAL = /^m-[a-z0-9-]{1,40}$/;
const ID_CATEGORIA = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PLU = /^\d{1,12}$/;
// Clave de presentación: PLU de SIGA o provisoria n-<slug> (todavía no dada de alta en SIGA; decisión 13).
const CLAVE_PRES = /^(\d{1,12}|n-[a-z0-9-]{1,40})$/;
const TIPOS_INSUMO = ['envase', 'tapa', 'etiqueta', 'precinto', 'otro'];
const TIPOS_EMPAQUE = ['envase', 'tapa', 'etiqueta', 'precinto']; // en una fórmula SIGA, el resto son ingredientes
const TEXTO_MAX = 60;
const COSTO_MAX = 1e9;
const INSUMOS_MAX = 100;
const CATEGORIAS_MAX = 50;
const SLUG_MAX = 40;

// Error de input: la ruta lo devuelve como { error } (convención del módulo); el resto va a apiRoute (500).
class ErrorEntrada extends Error {}
function entrada(fn) {
  try { return fn(); } catch (err) { throw new ErrorEntrada(err.message); }
}
const fallar = msg => { throw new ErrorEntrada(msg); };

module.exports = function crearRutasPreciosProduccion(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR, LISTA_PRECIOS_VENTA, tiposPackaging } = deps;
  // Filtros de fórmula activa / sin "Formula generico": una sola definición en server.js (la misma que /api/bom).
  const { FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL } = deps;
  const router = express.Router();
  const RECETAS_PATH = path.join(DATA_DIR, 'recetas_produccion.json');
  const COSTEO_PATH = path.join(DATA_DIR, 'costeo.json');
  const { costosPorPlu, preciosVigentesAlmacen, fechasPrecioAlmacen, vinculosPackBulto } = crearConsultasPrecios({ query, LISTA_PRECIOS_VENTA, FORMULA_ACTIVA_SQL, SIN_FORMULA_GENERICO_SQL });

  const ruta = fn => apiRoute(async (req) => {
    try { return await fn(req); } catch (err) {
      if (err instanceof ErrorEntrada) return { error: err.message };
      throw err;
    }
  });
  const leer = () => normalizarDatos(leerJSON(RECETAS_PATH, RECETAS_VACIO));
  // Escritura atómica: tmp + rename, así un corte a mitad nunca deja el JSON truncado.
  const guardar = datos => { const tmp = `${RECETAS_PATH}.tmp`; guardarJSON(tmp, datos); fs.renameSync(tmp, RECETAS_PATH); };

  // Lee, aplica fn(producto, datos) → producto nuevo (o null = borrar) y guarda. Sincrónico:
  // entre la lectura y la escritura no hay await, no se pisa con otra escritura.
  function mutarProducto(id, fn) {
    const datos = leer();
    const actual = productoDe(datos, id);
    const nuevo = fn(actual, datos);
    const { [id]: _borrado, ...resto } = datos.productos;
    guardar({ ...datos, productos: nuevo ? { ...datos.productos, [id]: nuevo } : resto });
    return nuevo;
  }

  // Un solo camino de costeo para selector, detalle, alertas y validar. req con preciosSinConfig (lo marca guardPrecios
  // en server.js) = usuario sin el permiso de Configuración: se costea con la vista sin estructura (lib/precios_permisos);
  // validar y alertas no pasan req (guardan/comparan con la config real).
  async function costearProductos(datos, ids, req = null) {
    const productos = Object.fromEntries(ids.map(id => [id, datos.productos[id]]));
    const real = costeoConCurva(leerJSON(COSTEO_PATH, {}) || {});
    const costeo = req && req.preciosSinConfig === true ? proyectarCosteo(real, 'produccion') : real;
    const costos = await costosPorPlu(plusUsados(productos));
    const costeados = costearTodos({ productos, costos, costeo, datos });
    return { costeados, costos, costeo };
  }

  // Detalle costeado + vigentes SIGA + sub-filas pack/bulto de cada presentación (una query de vínculos).
  async function detalleConPrecios(datos, id, req) {
    const manuales = ((costeoConCurva(leerJSON(COSTEO_PATH, {}) || {})).packBulto || {}).vinculosManuales || {};
    const [{ costeados, costos, costeo }, vigentes, fechas, { vinculos }] = await Promise.all([
      costearProductos(datos, [id], req), preciosVigentesAlmacen(), fechasPrecioAlmacen(), vinculosPackBulto(manuales),
    ]);
    const packBultoDe = crearPackBultoDe({ vinculos, vigentes, fechas, costeo });
    return armarDetalle({ id, datos, costeado: costeados[id], costos, vigentes, fechas, toleranciaPct: costeo.toleranciaPct, tiposPackaging, packBultoDe,
      marcados: costeo.marcadosExportar });
  }

  // Propuesta de curva de Producción desde los precios vigentes de SIGA (no guarda; mismo path que Reventa y
  // Fraccionado en rutas_precios.js, que le cede 'produccion'). Puntos: cada presentación con PLU de SIGA,
  // costo por unidad y vigente. Con pocos datos ajustarCurva tira y la UI lo avisa.
  router.post('/api/precios/curva-ganancia/ajustar/produccion', ruta(async () => {
    const datos = leer();
    const [{ costeados, costos, costeo }, vigentes] = await Promise.all([
      costearProductos(datos, Object.keys(datos.productos)), preciosVigentesAlmacen(),
    ]);
    const gastosPct = gastosVentaPctTipo(costeo, 'produccion');
    if (gastosPct == null) return { error: 'falta la venta mensual base de Producción (tab Costos): sin ella no se conocen los gastos sobre venta' };
    const filas = filasCurvaProduccion(costeados, vigentes, costos);
    try {
      return propuestaCurva('produccion', filas, { gastosPct, conceptosPct: totalConceptosGanancia(costeo.conceptosGanancia) });
    } catch (err) {
      return { error: `Producción: ${err.message}. Hacen falta más presentaciones con costo y precio vigente en SIGA.` };
    }
  }));

  router.get('/api/precios/produccion/productos', ruta(async (req) => {
    const datos = leer();
    const [{ costeados, costeo }, fechas, vigentes] = await Promise.all([
      costearProductos(datos, Object.keys(datos.productos), req), fechasPrecioAlmacen(), preciosVigentesAlmacen(),
    ]);
    return Object.entries(costeados)
      .map(([id, c]) => filaSelector(id, datos.productos[id], c, costeo.marcadosExportar, fechas, vigentes, costeo.toleranciaPct))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }));

  router.post('/api/precios/produccion/productos', ruta(async (req) => {
    const { nombre } = entrada(() => produccion.validarProducto(req.body));
    const datos = leer();
    const id = idUnico(`p-${slug(nombre)}`, datos.productos);
    const producto = { nombre, creado: hoy(), recetas: {}, insumos: [], presentaciones: {} };
    guardar({ ...datos, productos: { ...datos.productos, [id]: producto } });
    return { id, producto };
  }));

  // Alta de un producto completo desde la fórmula activa de SIGA de un PLU: receta base (ingredientes × kg por
  // tanda), insumos del producto (el empaque), la variedad automática y las presentaciones de SIGA que usan ese
  // PLU (todas o el subconjunto `presentaciones: [plu…]`), en una sola escritura.
  router.post('/api/precios/produccion/productos/desde-siga', ruta(async (req) => {
    const b = esObjeto(req.body) ? req.body : {};
    const { nombre } = entrada(() => produccion.validarProducto(b));
    const plu = validarId(b.plu, PLU, 'plu');
    const rendimientoKg = numeroEn(b.rendimientoKg, 'rendimientoKg', { min: 0, excluirMin: true });
    const elegidas = b.presentaciones == null ? null : validarPlusElegidos(b.presentaciones);
    const formula = await formulaSiga(plu);
    if (!formula.componentes.length) fallar(formula.mensaje);
    const datos = leer();
    const id = idUnico(`p-${slug(nombre)}`, datos.productos);
    const inicial = productoDesdeFormula({
      nombre, rendimientoKg, componentes: formula.componentes, insumosManuales: datos.insumosManuales, creado: hoy(),
    });
    const { producto, presentacionesCreadas, omitidas } = conPresentacionesSiga(inicial.producto, formula.presentaciones, {
      rendimientoKg, autoId: inicial.variedadCreada, productos: datos.productos, insumosManuales: datos.insumosManuales, elegidas,
    });
    guardar({ ...datos, productos: { ...datos.productos, [id]: producto } });
    return { id, producto, variedadCreada: inicial.variedadCreada, presentacionesCreadas, omitidas };
  }));

  router.get('/api/precios/produccion/productos/:id', ruta(async (req) => {
    const id = idProducto(req);
    const datos = leer();
    productoDe(datos, id);
    return detalleConPrecios(datos, id, req);
  }));

  router.put('/api/precios/produccion/productos/:id', ruta(async (req) => {
    const id = idProducto(req);
    const { nombre } = entrada(() => produccion.validarProducto(req.body));
    return { id, producto: mutarProducto(id, p => ({ ...p, nombre })) };
  }));

  router.delete('/api/precios/produccion/productos/:id', ruta(async (req) => {
    const id = idProducto(req);
    mutarProducto(id, () => null);
    return { id, borrado: true };
  }));

  // Alta/edición de receta o variante. Editar NO re-valida: se conserva el `validado` que tenía.
  // Base con `escalarVariantes: true` (decisión 12): si cambió el kg por tanda, sus variedades escalan
  // extras por nuevo/anterior en la MISMA escritura (factor calculado acá, contra lo guardado).
  // Base NUEVA en un producto sin variedades: también se crea la variedad automática (una presentación sale de una variedad).
  router.put('/api/precios/produccion/productos/:id/recetas/:recetaId', ruta(async (req) => {
    const id = idProducto(req);
    const recetaId = validarId(req.params.recetaId, ID_RECETA, 'recetaId');
    const escalar = esObjeto(req.body) && req.body.escalarVariantes === true;
    let variedadCreada = null;
    const producto = mutarProducto(id, p => {
      const limpia = entrada(() => produccion.validarReceta(req.body, p, recetaId));
      const previa = (p.recetas || {})[recetaId];
      const receta = previa && previa.validado ? { ...limpia, validado: previa.validado } : limpia;
      const recetas = { ...(p.recetas || {}), [recetaId]: receta };
      const factor = escalar && previa && !limpia.varianteDe && previa.rendimientoKg > 0 ? limpia.rendimientoKg / previa.rendimientoKg : 1;
      const nuevo = { ...p, recetas: produccion.escalarVariantes(recetas, recetaId, factor) };
      if (previa || limpia.varianteDe) return nuevo;
      const r = conVariedadAutomatica(nuevo, recetaId);
      variedadCreada = r.variedadCreada;
      return r.producto;
    });
    return { id, recetaId, receta: producto.recetas[recetaId], variedadCreada };
  }));

  router.delete('/api/precios/produccion/productos/:id/recetas/:recetaId', ruta(async (req) => {
    const id = idProducto(req);
    const recetaId = validarId(req.params.recetaId, ID_RECETA, 'recetaId');
    mutarProducto(id, p => {
      if (!Object.hasOwn(p.recetas || {}, recetaId)) fallar(`receta ${recetaId} no encontrada`);
      entrada(() => produccion.validarBorrarReceta(p, recetaId));
      return { ...p, recetas: sinClave(p.recetas, recetaId) };
    });
    return { id, recetaId, borrado: true };
  }));

  // Lista de insumos del producto (decisión 11): las presentaciones eligen de acá.
  router.put('/api/precios/produccion/productos/:id/insumos', ruta(async (req) => {
    const id = idProducto(req);
    const producto = mutarProducto(id, (p, datos) =>
      ({ ...p, insumos: validarInsumosProducto(req.body, p, datos.insumosManuales) }));
    return { id, insumos: producto.insumos };
  }));

  // Alta/edición de presentación. Un PLU tiene que existir en SIGA (se consulta antes de leer el
  // archivo, así la escritura queda sin await en el medio); una clave provisoria n-… no se consulta.
  // Editar NO re-valida. El módulo nunca escribe en SIGA (decisión 13).
  router.put('/api/precios/produccion/productos/:id/presentaciones/:plu', ruta(async (req) => {
    const id = idProducto(req);
    const plu = validarId(req.params.plu, CLAVE_PRES, 'plu');
    const esSiga = PLU.test(plu);
    const siga = esSiga ? await costosPorPlu([plu]) : new Map();
    if (esSiga && !siga.has(plu)) fallar(`plu: el PLU ${plu} no existe en SIGA`);
    const producto = mutarProducto(id, (p, datos) => {
      const limpia = entrada(() => produccion.validarPresentacion(req.body, p, datos.productos, { plu, productoId: id }));
      const previa = (p.presentaciones || {})[plu];
      const pres = previa && previa.validado ? { ...limpia, validado: previa.validado } : limpia;
      return { ...p, presentaciones: { ...(p.presentaciones || {}), [plu]: pres } };
    });
    return { id, plu, presentacion: producto.presentaciones[plu], nombreSiga: esSiga ? siga.get(plu).nombre : null };
  }));

  // Vincular una presentación provisoria n-… al PLU con el que el usuario la dio de alta en SIGA:
  // re-clave en una sola escritura, conservando todo (validado incluido) menos el nombre provisorio.
  router.post('/api/precios/produccion/productos/:id/presentaciones/:clave/vincular', ruta(async (req) => {
    const id = idProducto(req);
    const clave = validarId(req.params.clave, CLAVE_PRES, 'clave');
    if (PLU.test(clave)) fallar('sólo se vincula una presentación provisoria (sin PLU de SIGA)');
    const plu = validarId(esObjeto(req.body) ? req.body.plu : null, PLU, 'plu');
    const siga = await costosPorPlu([plu]);
    if (!siga.has(plu)) fallar(`plu: el PLU ${plu} no existe en SIGA`);
    const producto = mutarProducto(id, (p, datos) => {
      if (!Object.hasOwn(p.presentaciones || {}, clave)) fallar(`presentación ${clave} no encontrada`);
      const usado = Object.entries(datos.productos).find(([, q]) => q && Object.hasOwn(q.presentaciones || {}, plu));
      if (usado) fallar(`plu: el PLU ${plu} ya es la presentación de "${usado[1].nombre}"`);
      const { nombre: _provisorio, ...pres } = p.presentaciones[clave];
      const resto = Object.fromEntries(Object.entries(p.presentaciones).map(([k, v]) => (k === clave ? [plu, pres] : [k, v])));
      return { ...p, presentaciones: resto };
    });
    return { id, plu, presentacion: producto.presentaciones[plu], nombreSiga: siga.get(plu).nombre };
  }));

  // Vista previa del modal: valida igual que el PUT y costea la presentación con el cambio en memoria
  // (mismo costearProductos + armarDetalle que el GET). NO escribe el archivo. Sin :plu = alta sin PLU elegido.
  // ponytail: sin PLU se costea bajo la clave '0' (no hay PLU 0 en SIGA); si algún día existe, usar otra clave.
  async function previewPresentacion(req) {
    const id = idProducto(req);
    const plu = req.params.plu != null ? validarId(req.params.plu, CLAVE_PRES, 'plu') : null;
    const clave = plu || '0';
    const datos = leer();
    const producto = productoDe(datos, id);
    const limpia = entrada(() => produccion.validarPresentacion(req.body, producto, datos.productos, { plu: clave, productoId: id }));
    const previa = (producto.presentaciones || {})[clave];
    const pres = previa && previa.validado ? { ...limpia, validado: previa.validado } : limpia;
    const enMemoria = { ...datos, productos: { ...datos.productos, [id]: { ...producto, presentaciones: { ...(producto.presentaciones || {}), [clave]: pres } } } };
    const det = await detalleConPrecios(enMemoria, id, req);
    return { ...det.presentaciones[clave], plu };
  }
  router.post('/api/precios/produccion/productos/:id/presentaciones/preview', ruta(previewPresentacion));
  router.post('/api/precios/produccion/productos/:id/presentaciones/:plu/preview', ruta(previewPresentacion));

  router.delete('/api/precios/produccion/productos/:id/presentaciones/:plu', ruta(async (req) => {
    const id = idProducto(req);
    const plu = validarId(req.params.plu, CLAVE_PRES, 'plu');
    mutarProducto(id, p => {
      if (!Object.hasOwn(p.presentaciones || {}, plu)) fallar(`presentación ${plu} no encontrada`);
      return { ...p, presentaciones: sinClave(p.presentaciones, plu) };
    });
    return { id, plu, borrado: true };
  }));

  // Validar = guardar el snapshot del costo actual. Se costea (await) y después se relee el archivo
  // para escribir sobre lo último guardado.
  router.post('/api/precios/produccion/productos/:id/validar', ruta(async (req) => {
    const id = idProducto(req);
    const pedido = validarPedidoValidar(req.body);
    const datos = leer();
    productoDe(datos, id);
    const { costeados } = await costearProductos(datos, [id]);
    let resultado;
    mutarProducto(id, p => {
      resultado = aplicarValidacion(p, costeados[id], pedido, hoy());
      return resultado.producto;
    });
    return { id, validados: resultado.validados, omitidos: resultado.omitidos };
  }));

  // Fórmula de un producto en SIGA (ProductosComponentes, fórmula activa) para importarla a una receta.
  // Mismos filtros que /api/bom/producto/:plu; costo con el mismo costoDe que el resto del módulo.
  // plu ya validado. Sin componentes → `mensaje` para la UI (el alta desde SIGA lo devuelve como error).
  async function formulaSiga(plu) {
    const [prod] = await query(`SELECT TOP 1 NombreProducto AS nombre FROM Productos WHERE IdProducto = ${plu}`);
    const rows = await query(`
      SELECT CAST(pc.IdProductoComponente AS VARCHAR) AS plu, p.NombreProducto AS nombre,
             pc.Cantidad AS cantPorUnidad, COALESCE(r.NombreRubro, '') AS rubro
      FROM ProductosComponentes pc
      INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
      LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE pc.IdProducto = ${plu} AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
      ORDER BY p.NombreProducto`);
    const datos = leer();
    const costos = await costosPorPlu(rows.map(r => String(r.plu)).filter(esPlu));
    const costoDe = armarCostoDe({ costos, costeo: costeoConCurva(leerJSON(COSTEO_PATH, {}) || {}), insumosManuales: datos.insumosManuales });
    const componentes = rows.map(r => {
      const c = costoDe(String(r.plu)) || {};
      return { plu: String(r.plu), nombre: r.nombre, cantPorUnidad: Number(r.cantPorUnidad), costo: c.costo ?? null,
        fuente: c.fuente || null, tipo: tipoInsumo({ nombre: r.nombre, rubro: r.rubro }, tiposPackaging) };
    });
    const mensaje = componentes.length ? null : prod ? 'Este producto no tiene fórmula cargada en SIGA.' : 'El PLU no existe en SIGA (o no tiene fórmula).';
    const presentaciones = await presentacionesSiga(plu, datos.productos);
    return { plu, nombre: prod ? prod.nombre : null, componentes, mensaje, presentaciones };
  }

  // Presentaciones del PLU (un granel/intermedio): productos cuya fórmula ACTIVA lo tiene como componente, con sus
  // fórmulas activas completas. Dos consultas, sin N+1; los PLUs del IN vienen de SIGA y se filtran numéricos.
  async function presentacionesSiga(plu, productos) {
    const usos = await query(`
      SELECT CAST(pc.IdProducto AS VARCHAR) AS plu, p.NombreProducto AS nombre, pc.Cantidad AS cantidad
      FROM ProductosComponentes pc
      INNER JOIN Productos p ON p.IdProducto = pc.IdProducto
      WHERE pc.IdProductoComponente = ${plu} AND ${FORMULA_ACTIVA_SQL}
      ORDER BY p.NombreProducto`);
    const plus = [...new Set(usos.map(u => String(u.plu)))].filter(esPlu);
    const filas = plus.length ? await query(`
      SELECT CAST(pc.IdProducto AS VARCHAR) AS padre, CAST(pc.IdProductoComponente AS VARCHAR) AS plu, p.NombreProducto AS nombre,
             pc.Cantidad AS cantidad, COALESCE(r.NombreRubro, '') AS rubro
      FROM ProductosComponentes pc
      INNER JOIN Productos p ON p.IdProducto = pc.IdProductoComponente
      LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE pc.IdProducto IN (${plus.map(x => `'${x}'`).join(',')}) AND ${FORMULA_ACTIVA_SQL} AND ${SIN_FORMULA_GENERICO_SQL}
      ORDER BY p.NombreProducto`) : [];
    const componentes = filas.map(r => ({ padre: String(r.padre), plu: String(r.plu), nombre: r.nombre, cantidad: Number(r.cantidad),
      tipo: tipoInsumo({ nombre: r.nombre, rubro: r.rubro }, tiposPackaging) }));
    return presentacionesDetectadas({ granelPlu: plu, usos: usos.filter(u => esPlu(u.plu)), componentes, productos });
  }
  router.get('/api/precios/produccion/formula-siga/:plu', ruta(async (req) => formulaSiga(validarId(req.params.plu, PLU, 'plu'))));

  router.get('/api/precios/produccion/alertas', ruta(async () => {
    const datos = leer();
    const { costeados } = await costearProductos(datos, Object.keys(datos.productos));
    return produccion.resumenAlertas(costeados);
  }));

  router.put('/api/precios/produccion/insumos-manuales/:manualId', ruta(async (req) => {
    const manualId = validarId(req.params.manualId, ID_MANUAL, 'id de insumo manual');
    const insumo = validarInsumoManual(req.body);
    const datos = leer();
    guardar({ ...datos, insumosManuales: { ...datos.insumosManuales, [manualId]: insumo } });
    return { id: manualId, insumo };
  }));

  router.delete('/api/precios/produccion/insumos-manuales/:manualId', ruta(async (req) => {
    const manualId = validarId(req.params.manualId, ID_MANUAL, 'id de insumo manual');
    const datos = leer();
    if (!Object.hasOwn(datos.insumosManuales, manualId)) fallar(`insumo manual ${manualId} no encontrado`);
    const usos = productosQueUsan(datos.productos, manualId).map(u => u.nombre);
    if (usos.length) fallar(`no se puede borrar: lo usan ${usos.join(', ')}`);
    guardar({ ...datos, insumosManuales: sinClave(datos.insumosManuales, manualId) });
    return { id: manualId, borrado: true };
  }));

  // Tab Máquinas: categorías con qué productos/recetas las usan (para mostrar y para bloquear la baja).
  router.get('/api/precios/produccion/categorias-maquina', ruta(async () => ({ categoriasMaquina: categoriasConUsos(leer()) })));

  // Lista completa (alta, edición y baja). Quitar una categoría que usa alguna receta es error.
  router.put('/api/precios/produccion/categorias-maquina', ruta(async (req) => {
    const categoriasMaquina = validarCategoriasMaquina(req.body);
    const datos = leer();
    validarBajaCategorias(datos, categoriasMaquina);
    const nuevos = { ...datos, categoriasMaquina };
    guardar(nuevos);
    return { categoriasMaquina: categoriasConUsos(nuevos) };
  }));

  return router;
};

// ── Helpers puros (exportados para tests) ────────────────────────────────────

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const esObjeto = v => v != null && typeof v === 'object' && !Array.isArray(v);

function normalizarDatos(d) {
  const o = esObjeto(d) ? d : {};
  return {
    ...o,
    productos: esObjeto(o.productos) ? o.productos : {},
    insumosManuales: esObjeto(o.insumosManuales) ? o.insumosManuales : {},
    categoriasMaquina: Array.isArray(o.categoriasMaquina) ? o.categoriasMaquina : [],
  };
}

function sinClave(obj, clave) {
  const { [clave]: _fuera, ...resto } = obj || {};
  return resto;
}

function validarId(v, re, campo) {
  const s = String(v == null ? '' : v).trim();
  if (!re.test(s)) fallar(`${campo} inválido`);
  return s;
}
const idProducto = req => validarId(req.params.id, ID_PRODUCTO, 'id de producto');

function productoDe(datos, id) {
  if (!Object.hasOwn(datos.productos, id)) fallar(`producto ${id} no encontrado`);
  return datos.productos[id];
}

// "Pepas de Membrillo" → "pepas-de-membrillo" (sin acentos, sólo [a-z0-9-]).
function slug(nombre) {
  const s = String(nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, SLUG_MAX).replace(/-+$/, '');
  return s || 'producto';
}

// base, base-2, base-3… el primero libre en `existentes` (objeto por id).
function idUnico(base, existentes) {
  if (!Object.hasOwn(existentes || {}, base)) return base;
  let n = 2;
  while (Object.hasOwn(existentes, `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const claveDe = it => (it.plu != null ? String(it.plu) : it.manualId);
const esPlu = clave => PLU.test(String(clave));

// PLUs SIGA que hay que consultar: materias primas, extras, insumos (lista del producto y de presentaciones) y PLUs de presentación.
function plusUsados(productos) {
  const plus = new Set();
  for (const p of Object.values(productos || {})) {
    for (const r of Object.values(p.recetas || {})) {
      for (const it of [...(r.materiasPrimas || []), ...(r.extras || [])]) plus.add(String(it.plu));
    }
    for (const it of produccion.insumosDelProducto(p)) if (it.plu != null) plus.add(String(it.plu));
    for (const [plu, pr] of Object.entries(p.presentaciones || {})) {
      plus.add(plu);
      for (const it of pr.insumos || []) if (it.plu != null) plus.add(String(it.plu));
    }
  }
  return [...plus].filter(esPlu);
}

// costoDe(clave) para lib/precios_produccion: PLU SIGA → elegirCosto (override manual de
// costo-producto → última compra si se eligió → sistema neto; todos netos); id manual → insumosManuales.
// Sin fila en SIGA / sin insumo manual → null (la lib lo convierte en faltante, nunca 0).
function armarCostoDe({ costos, costeo, insumosManuales }) {
  return clave => {
    if (!esPlu(clave)) {
      const m = Object.hasOwn(insumosManuales || {}, clave) ? insumosManuales[clave] : null;
      return m ? { costo: m.costo, fuente: 'insumoManual', nombre: m.nombre } : null;
    }
    const row = costos.get(String(clave));
    if (!row) return null;
    const { costoBase, costoFuente } = elegirCosto({
      plu: String(clave), costoUltimaCompra: row.costoMercaderia, costoSistema: row.costoSistema, cfg: costeo,
    });
    return { costo: costoBase, fuente: costoFuente, nombre: row.nombre };
  };
}

// Costea cada producto con la config de costeo.json. Las presentaciones sin nombre propio toman el de SIGA.
function costearTodos({ productos, costos, costeo, datos }) {
  const cfg = costeo || {};
  const costoDe = armarCostoDe({ costos, costeo: cfg, insumosManuales: datos.insumosManuales });
  const opciones = {
    costoDe, costoHora: cfg.costoHora, categoriasMaquina: datos.categoriasMaquina,
    curva: (cfg.curvaGanancia || {}).produccion, margenPorProducto: cfg.margenPorProducto,
    toleranciaPct: cfg.toleranciaPct,
    // La curva de Producción es ganancia: el lib la convierte a markup total con los gastos de Producción
    // (null = falta venta base → markup null, faltante).
    gastosVentaPct: gastosVentaPctTipo(cfg, 'produccion'),
    gastos: gastosDesglosePct(cfg, 'produccion'),
    // IVA de venta global, conceptos de ganancia y conceptos sobre precio final.
    ivaPct: ivaVentaPctDe(cfg), conceptos: conceptosGananciaDe(cfg), conceptosFinal: conceptosPrecioFinalDe(cfg),
  };
  return Object.fromEntries(Object.entries(productos).map(([id, p]) => {
    const presentaciones = Object.fromEntries(Object.entries(p.presentaciones || {}).map(([plu, pr]) =>
      [plu, pr.nombre ? pr : { ...pr, nombre: (costos.get(plu) || {}).nombre || null }]));
    return [id, produccion.costearProducto({ producto: { ...p, presentaciones }, ...opciones })];
  }));
}

// Filas { costoBase, costoTotal, precioVigente, ivaPct, finalPct } para propuestaCurva: una por presentación con PLU de SIGA.
function filasCurvaProduccion(costeados, vigentes, costos) {
  return Object.values(costeados).flatMap(c => Object.entries(c.presentaciones || {}))
    .filter(([plu, p]) => esPlu(plu) && p.costoUnidad > 0 && vigentes.has(plu))
    .map(([plu, p]) => ({ costoBase: p.costoUnidad, costoTotal: p.costoUnidad, precioVigente: vigentes.get(plu),
      ivaPct: p.ivaPct, finalPct: p.finalPct }));
}

// Variedad automática { nombre del producto, varianteDe: baseId, extras: [] } si el producto no tiene ninguna.
// Id = slug del nombre sin pisar recetas (recortado para que con -N siga entrando en ID_RECETA).
function conVariedadAutomatica(producto, baseId) {
  const recetas = producto.recetas || {};
  if (Object.values(recetas).some(r => r && r.varianteDe)) return { producto, variedadCreada: null };
  const id = idReceta(producto.nombre, recetas);
  const variedad = entrada(() => produccion.validarReceta({ nombre: producto.nombre, varianteDe: baseId, extras: [] }, producto, id));
  return { producto: { ...producto, recetas: { ...recetas, [id]: variedad } }, variedadCreada: id };
}

// Producto nuevo desde los componentes de formulaSiga: los que no son empaque → receta 'base' (cantPorUnidad × kg por
// tanda, 4 decimales, sumando repetidos: mismo criterio que componentesAIngredientes del front); el empaque → insumos.
function productoDesdeFormula({ nombre, rendimientoKg, componentes, insumosManuales, creado }) {
  const esEmpaque = c => TIPOS_EMPAQUE.includes(c.tipo);
  const ingredientes = componentes.filter(c => !esEmpaque(c));
  if (!ingredientes.length) fallar('la fórmula de SIGA sólo tiene empaque (envase, tapa, etiqueta o precinto): no hay ingredientes para la receta base');
  const cantidades = new Map();
  for (const c of ingredientes) {
    cantidades.set(c.plu, redondear4((cantidades.get(c.plu) || 0) + redondear4(Number(c.cantPorUnidad) * rendimientoKg)));
  }
  const materiasPrimas = [...cantidades].map(([plu, cantidad]) => ({ plu, cantidad, unidad: 'kg' }));
  const vacio = { nombre, creado, recetas: {}, insumos: [], presentaciones: {} };
  const base = entrada(() => produccion.validarReceta({ nombre, rendimientoKg, materiasPrimas }, vacio, 'base'));
  const empaque = [...new Set(componentes.filter(esEmpaque).map(c => c.plu))];
  const insumos = validarInsumosProducto({ insumos: empaque.map(plu => ({ plu })) }, vacio, insumosManuales);
  return conVariedadAutomatica({ ...vacio, recetas: { base }, insumos }, 'base');
}
const redondear4 = n => Math.round(n * 1e4) / 1e4;
// Id de receta = slug del nombre sin pisar recetas (recortado para que con -N siga entrando en ID_RECETA).
const idReceta = (nombre, recetas) => idUnico(slug(nombre).slice(0, SLUG_MAX - 4).replace(/-+$/, ''), recetas || {});

// ── Presentaciones desde SIGA (consulta inversa del granel) ──
const esEmpaqueSiga = c => TIPOS_EMPAQUE.includes(c.tipo);
const nombreVariedad = extras => `Con ${extras.map(e => e.nombre || e.plu).join(' + ')}`.slice(0, TEXTO_MAX).trim();
const claveExtras = d => d.extras.map(e => e.plu).sort().join(',');
const duenioPresentacion = (productos, plu) => {
  const p = Object.values(productos || {}).find(q => q && Object.hasOwn(q.presentaciones || {}, plu));
  return p ? p.nombre : null;
};
// Filas con el mismo PLU → una sola, sumando cantidad (4 decimales); conserva el orden de aparición.
function sumarPorPlu(filas) {
  const m = new Map();
  for (const f of filas) m.set(f.plu, { ...f, cantidad: redondear4(((m.get(f.plu) || {}).cantidad || 0) + Number(f.cantidad)) });
  return [...m.values()];
}

// usos = [{ plu, nombre, cantidad }] (consulta inversa: cantidad = kg de granel por unidad); componentes = [{ padre, plu,
// nombre, cantidad, tipo }] (fórmulas activas de esos PLUs). Extras = lo no-empaque distinto del granel. kgPorUnidad =
// granel + extras (la variedad se costea por kg de base + extras). yaEn = producto que ya la tiene como presentación.
function presentacionesDetectadas({ granelPlu, usos, componentes, productos }) {
  return sumarPorPlu(usos.map(u => ({ plu: String(u.plu), nombre: u.nombre, cantidad: u.cantidad }))).map(u => {
    const propios = componentes.filter(c => c.padre === u.plu && c.plu !== String(granelPlu));
    const extras = sumarPorPlu(propios.filter(c => !esEmpaqueSiga(c))).map(({ plu, nombre, cantidad }) => ({ plu, nombre, cantidad }));
    const empaque = sumarPorPlu(propios.filter(esEmpaqueSiga)).map(({ plu, nombre, cantidad, tipo }) => ({ plu, nombre, cantidad, tipo }));
    return {
      plu: u.plu, nombre: u.nombre, kgGranel: u.cantidad, kgPorUnidad: redondear4(u.cantidad + extras.reduce((s, e) => s + e.cantidad, 0)),
      variedad: extras.length ? nombreVariedad(extras) : null, extras, empaque, yaEn: duenioPresentacion(productos, u.plu),
    };
  });
}

// Suma al producto nuevo las presentaciones detectadas (todas o `elegidas`). Variedades: una por conjunto de extras
// (sin extras → la automática `autoId`); cada extra = promedio en el grupo de (extra / kg granel) × kg por tanda.
// Cada presentación se valida sola: si falla (o ya es de otro producto) va a `omitidas` y el resto sigue.
// Variedad + insumos + presentación entran juntos: una omitida no deja una variedad huérfana.
function conPresentacionesSiga(producto, detectadas, { rendimientoKg, autoId, productos, insumosManuales, elegidas = null }) {
  const pedidas = elegidas ? new Set(elegidas) : null;
  const motivoPrevio = d => {
    const yaEn = duenioPresentacion(productos, d.plu);
    if (yaEn) return `ya es presentación de "${yaEn}"`;
    return d.kgGranel > 0 ? null : 'la cantidad del granel en su fórmula no es positiva';
  };
  const usables = detectadas.filter(d => (!pedidas || pedidas.has(d.plu)) && !motivoPrevio(d));
  const variedadDe = new Map([['', autoId]]);
  const omitidas = [], presentacionesCreadas = [];
  let actual = producto;
  for (const d of detectadas) {
    if (pedidas && !pedidas.has(d.plu)) continue;
    const previo = motivoPrevio(d);
    if (previo) { omitidas.push({ plu: d.plu, nombre: d.nombre, motivo: previo }); continue; }
    try {
      const clave = claveExtras(d);
      const conVariedad = variedadDe.has(clave) ? { producto: actual, recetaId: variedadDe.get(clave) }
        : variedadSiga(actual, d, usables.filter(u => claveExtras(u) === clave), rendimientoKg);
      const p = conVariedad.producto;
      const nuevos = d.empaque.filter(e => !p.insumos.some(it => claveDe(it) === e.plu)).map(e => ({ plu: e.plu }));
      const conInsumos = { ...p, insumos: validarInsumosProducto({ insumos: [...p.insumos, ...nuevos] }, p, insumosManuales) };
      const pres = produccion.validarPresentacion({
        recetaId: conVariedad.recetaId, kgPorUnidad: d.kgPorUnidad, insumos: d.empaque.map(e => ({ plu: e.plu, cantidad: e.cantidad })),
      }, conInsumos, productos, { plu: d.plu });
      actual = { ...conInsumos, presentaciones: { ...conInsumos.presentaciones, [d.plu]: pres } };
      variedadDe.set(clave, conVariedad.recetaId);
      presentacionesCreadas.push(d.plu);
    } catch (err) {
      omitidas.push({ plu: d.plu, nombre: d.nombre, motivo: err.message });
    }
  }
  const sinUso = [...(pedidas || [])].filter(plu => !detectadas.some(d => d.plu === plu));
  sinUso.forEach(plu => omitidas.push({ plu, nombre: null, motivo: 'su fórmula activa de SIGA no usa este PLU' }));
  return { producto: actual, presentacionesCreadas, omitidas };
}

// Variedad 'Con <extras>' (variante de 'base') para el grupo de presentaciones con esos mismos extras.
function variedadSiga(producto, d, grupo, rendimientoKg) {
  const extras = d.extras.map(e => {
    const ratios = grupo.map(g => g.extras.find(x => x.plu === e.plu).cantidad / g.kgGranel);
    return { plu: e.plu, cantidad: redondear4(ratios.reduce((s, r) => s + r, 0) / ratios.length * rendimientoKg), unidad: 'kg' };
  });
  const nombre = nombreVariedad(d.extras);
  const recetaId = idReceta(nombre, producto.recetas);
  const variedad = entrada(() => produccion.validarReceta({ nombre, varianteDe: 'base', extras }, producto, recetaId));
  return { producto: { ...producto, recetas: { ...producto.recetas, [recetaId]: variedad } }, recetaId };
}

// `presentaciones` del alta desde SIGA: lista de PLUs (sin repetidos).
function validarPlusElegidos(lista) {
  if (!Array.isArray(lista) || lista.length > INSUMOS_MAX) fallar(`presentaciones: debe ser una lista de hasta ${INSUMOS_MAX} PLUs`);
  return [...new Set(lista.map((v, i) => validarId(v, PLU, `presentaciones[${i}]`)))];
}

// Receta base del producto: la de id 'base' o, si no, la primera que no es variante.
function recetaBaseId(recetas) {
  const ids = Object.keys(recetas || {});
  if (ids.includes('base') && !recetas.base.varianteDe) return 'base';
  return ids.find(id => !recetas[id].varianteDe) || null;
}

// marcados = costeo.marcadosExportar ({ plu: fecha }). exportables = presentaciones con PLU de SIGA
// (las provisorias n-… no se pueden importar) para marcar y exportar: Costo = costo total por unidad.
// fechas: Map plu → 'YYYY-MM-DD' del último cambio de precio en SIGA (la UI muestra la más antigua).
// vigentes + toleranciaPct: precio vigente SIGA y Δ%/semáforo (compararConVigente, igual que armarDetalle).
// variedad = nombre de la receta de la que sale la presentación.
function filaSelector(id, producto, costeado, marcados = {}, fechas = new Map(), vigentes = new Map(), toleranciaPct = 0) {
  const recetas = producto.recetas || {};
  const variedadDe = plu => {
    const rid = ((producto.presentaciones || {})[plu] || {}).recetaId;
    return rid != null && Object.hasOwn(recetas, rid) ? recetas[rid].nombre || null : null;
  };
  const baseId = recetaBaseId(recetas);
  return {
    id, nombre: producto.nombre,
    variantes: Object.values(recetas).filter(r => r.varianteDe).length,
    presentaciones: Object.keys(producto.presentaciones || {}).length,
    costoKgBase: baseId ? costeado.recetas[baseId].costoKg : null,
    alertas: costeado.resumen.alertas, faltantes: costeado.resumen.faltantes,
    exportables: Object.entries(costeado.presentaciones).filter(([plu]) => esPlu(plu)).map(([plu, p]) => {
      const precioVigente = vigentes.has(plu) ? vigentes.get(plu) : null;
      const { deltaPct, estado: semaforo } = compararConVigente(p.precioConIva, precioVigente, toleranciaPct);
      return {
        plu, nombre: p.nombre, costoTotal: p.costoUnidad, precioConIva: p.precioConIva, faltantes: p.faltantes, ivaPct: p.ivaPct,
        marcado: Object.hasOwn(marcados || {}, plu), fechaPrecio: fechas.get(plu) || null,
        precioVigente, deltaPct, semaforo, variedad: variedadDe(plu),
      };
    }),
  };
}

// Productos cuyas recetas eligen la categoría (una variedad sin categoría propia hereda la de su base).
function usosCategoria(productos, categoriaId) {
  return Object.entries(productos || {}).map(([id, p]) => ({
    id, nombre: p.nombre,
    recetas: Object.values(p.recetas || {}).filter(r => r && r.categoriaMaquinaId === categoriaId).map(r => r.nombre),
  })).filter(u => u.recetas.length);
}
const categoriasConUsos = datos => datos.categoriasMaquina.map(c => ({ ...c, usos: usosCategoria(datos.productos, c.id) }));

// Lanza si la lista nueva deja afuera una categoría que alguna receta usa (dice quién la usa).
function validarBajaCategorias(datos, nuevas) {
  const ids = new Set(nuevas.map(c => c.id));
  for (const c of datos.categoriasMaquina) {
    const usos = ids.has(c.id) ? [] : usosCategoria(datos.productos, c.id);
    if (usos.length) fallar(`no se puede borrar "${c.nombre}": la usan ${usos.map(u => `${u.nombre} (${u.recetas.join(', ')})`).join('; ')}`);
  }
}

// Productos que tienen el insumo `clave` en su lista (la derivada, si es un dato viejo sin lista).
function productosQueUsan(productos, clave, exceptoId = null) {
  return Object.entries(productos || {})
    .filter(([id, p]) => id !== exceptoId && produccion.insumosDelProducto(p).some(it => claveDe(it) === clave))
    .map(([id, p]) => ({ id, nombre: p.nombre }));
}

// Tipo de un insumo: el elegido a mano → el del insumo manual → envase/tapa por nombre+rubro
// (tiposPackaging de server.js, la regla única de /api/plan/packaging) → 'etiqueta'/'precinto' por nombre → 'otro'.
function tipoInsumo({ tipo, nombre, rubro }, tiposPackaging) {
  if (TIPOS_INSUMO.includes(tipo)) return tipo;
  const t = typeof tiposPackaging === 'function' ? tiposPackaging(nombre, rubro) : {};
  if (t.esTapa) return 'tapa';
  if (t.esEnvase) return 'envase';
  if (/etiq/i.test(nombre || '')) return 'etiqueta';
  if (/precint/i.test(nombre || '')) return 'precinto';
  return 'otro';
}

// Detalle: producto costeado + "también en" y tipo por insumo + precio vigente SIGA por presentación.
// `insumosManuales` = catálogo global [{ id, nombre, costo, tipo }] para elegirlos en una presentación.
// `definicion` = el producto tal como está guardado (rendimiento, merma, cantidades, unidades…): la UI
// lo usa para precargar los editores; los costos siempre salen del costeo, nunca de ahí.
// packBultoDe(plu, precioConIva) → sub-filas pack/bulto de la presentación (crearPackBultoDe); sin él, [].
// marcados = costeo.marcadosExportar: cada presentación trae `marcado` (para exportar a SIGA).
function armarDetalle({ id, datos, costeado, costos, vigentes, fechas = new Map(), toleranciaPct, tiposPackaging, packBultoDe = () => [], marcados = {} }) {
  const insumos = costeado.insumos.map(it => {
    const row = costos.get(it.clave) || {};
    const manual = Object.hasOwn(datos.insumosManuales, it.clave) ? datos.insumosManuales[it.clave] : {};
    return {
      ...it,
      tipo: tipoInsumo({ tipo: it.tipo || manual.tipo, nombre: it.nombre, rubro: row.rubro }, tiposPackaging),
      fechaUltimaCompra: row.fechaUltimaCompra || null,
      tambienEn: productosQueUsan(datos.productos, it.clave, id),
    };
  });
  const presentaciones = Object.fromEntries(Object.entries(costeado.presentaciones).map(([plu, p]) => {
    const precioVigente = vigentes.has(plu) ? vigentes.get(plu) : null;
    const { deltaPct, estado: semaforo } = compararConVigente(p.precioConIva, precioVigente, toleranciaPct);
    return [plu, { ...p, precioVigente, deltaPct, semaforo, packBulto: packBultoDe(plu, p.precioConIva), marcado: Object.hasOwn(marcados || {}, plu),
      fechaPrecio: fechas.get(plu) || null }];
  }));
  return {
    id, ...costeado, creado: datos.productos[id].creado || null, insumos, presentaciones,
    categoriasMaquina: datos.categoriasMaquina, definicion: datos.productos[id],
    insumosManuales: Object.entries(datos.insumosManuales).map(([mid, m]) => ({ id: mid, ...m })),
  };
}

// Lista de insumos del producto: { insumos: [{ plu } | { manualId }, tipo?] }. El manual tiene que
// existir; no se puede quitar uno que usa una presentación; sin repetidos.
function validarInsumosProducto(body, producto, insumosManuales) {
  const lista = esObjeto(body) ? body.insumos : null;
  if (!Array.isArray(lista) || lista.length > INSUMOS_MAX) fallar(`insumos: debe ser una lista de hasta ${INSUMOS_MAX}`);
  const insumos = lista.map((it, i) => {
    if (!esObjeto(it)) fallar(`insumos[${i}]: ítem inválido`);
    const ref = it.plu != null ? { plu: validarId(it.plu, PLU, `insumos[${i}].plu`) }
      : { manualId: validarId(it.manualId, ID_MANUAL, `insumos[${i}].manualId`) };
    if (ref.manualId && !Object.hasOwn(insumosManuales || {}, ref.manualId)) fallar(`insumos[${i}]: el insumo manual ${ref.manualId} no existe`);
    if (it.tipo != null && !TIPOS_INSUMO.includes(it.tipo)) fallar(`insumos[${i}].tipo: debe ser ${TIPOS_INSUMO.join(', ')}`);
    return it.tipo != null ? { ...ref, tipo: it.tipo } : ref;
  });
  const claves = insumos.map(claveDe);
  const repetido = claves.find((c, i) => claves.indexOf(c) !== i);
  if (repetido) fallar(`insumos: "${repetido}" está repetido`);
  const enUso = Object.entries(producto.presentaciones || {}).flatMap(([plu, pr]) =>
    ((pr && pr.insumos) || []).map(claveDe).filter(c => !claves.includes(c)).map(c => `${c} (presentación ${plu})`));
  if (enUso.length) fallar(`no se puede quitar: está en uso en ${enUso.join(', ')}. Sacalo primero de esa presentación.`);
  return insumos;
}

function textoValido(v, campo) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > TEXTO_MAX) fallar(`${campo}: texto de 1 a ${TEXTO_MAX} caracteres`);
  return s;
}

function numeroEn(v, campo, { min, excluirMin }) {
  const ok = typeof v === 'number' && Number.isFinite(v) && (excluirMin ? v > min : v >= min) && v <= COSTO_MAX;
  if (!ok) fallar(`${campo}: debe ser un número ${excluirMin ? 'mayor a' : 'desde'} ${min} y hasta ${COSTO_MAX}`);
  return v;
}

function validarInsumoManual(body) {
  const b = esObjeto(body) ? body : {};
  if (b.tipo != null && !TIPOS_INSUMO.includes(b.tipo)) fallar(`tipo: debe ser ${TIPOS_INSUMO.join(', ')}`);
  return {
    nombre: textoValido(b.nombre, 'nombre'), costo: numeroEn(b.costo, 'costo', { min: 0, excluirMin: true }),
    ...(b.tipo != null ? { tipo: b.tipo } : {}),
  };
}

// Lista completa de categorías: { categorias: [{ id, nombre, costoHora }] }. Ids únicos.
function validarCategoriasMaquina(body) {
  const lista = esObjeto(body) ? body.categorias : null;
  if (!Array.isArray(lista) || lista.length > CATEGORIAS_MAX) fallar(`categorias: debe ser una lista de hasta ${CATEGORIAS_MAX}`);
  const cats = lista.map((c, i) => {
    if (!esObjeto(c)) fallar(`categorias[${i}]: ítem inválido`);
    return {
      id: validarId(c.id, ID_CATEGORIA, `categorias[${i}].id`), nombre: textoValido(c.nombre, `categorias[${i}].nombre`),
      costoHora: numeroEn(c.costoHora, `categorias[${i}].costoHora`, { min: 0 }),
    };
  });
  const ids = cats.map(c => c.id);
  const rep = ids.find((c, i) => ids.indexOf(c) !== i);
  if (rep) fallar(`categorias: id "${rep}" repetido`);
  return cats;
}

// { tipo: 'receta'|'presentacion'|'todo', id? }
function validarPedidoValidar(body) {
  const b = esObjeto(body) ? body : {};
  if (b.tipo === 'todo') return { tipo: 'todo' };
  if (b.tipo === 'receta') return { tipo: 'receta', id: validarId(b.id, ID_RECETA, 'id') };
  if (b.tipo === 'presentacion') return { tipo: 'presentacion', id: validarId(b.id, CLAVE_PRES, 'id') };
  return fallar("tipo: debe ser 'receta', 'presentacion' o 'todo'");
}

// Aplica los snapshots (snapshotDe) al producto sin mutarlo. Con faltantes no se valida: un pedido
// puntual es error; en 'todo' se omite y se informa en `omitidos`.
function aplicarValidacion(producto, costeado, { tipo, id }, fecha) {
  const grupos = [['receta', 'recetas'], ['presentacion', 'presentaciones']];
  const pedidos = grupos.flatMap(([t, clave]) => Object.keys(costeado[clave])
    .filter(k => tipo === 'todo' || (tipo === t && k === id)).map(k => ({ t, clave, k })));
  if (tipo !== 'todo' && !pedidos.length) fallar(`${tipo} ${id} no encontrada`);
  const validados = [], omitidos = [];
  let nuevo = producto;
  for (const { t, clave, k } of pedidos) {
    const c = costeado[clave][k];
    if (c.faltantes.length) {
      if (tipo !== 'todo') fallar(`no se puede validar con faltantes: ${c.faltantes.join(', ')}`);
      omitidos.push({ tipo: t, id: k, faltantes: c.faltantes });
      continue;
    }
    const actual = (nuevo[clave] || {})[k];
    if (!actual) continue; // borrado entre el costeo y la escritura
    nuevo = { ...nuevo, [clave]: { ...nuevo[clave], [k]: { ...actual, validado: produccion.snapshotDe(c, fecha) } } };
    validados.push({ tipo: t, id: k });
  }
  return { producto: nuevo, validados, omitidos };
}

module.exports.filasCurvaProduccion = filasCurvaProduccion;
module.exports.slug = slug;
module.exports.idUnico = idUnico;
module.exports.plusUsados = plusUsados;
module.exports.armarCostoDe = armarCostoDe;
module.exports.costearTodos = costearTodos;
module.exports.filaSelector = filaSelector;
module.exports.productoDesdeFormula = productoDesdeFormula;
module.exports.presentacionesDetectadas = presentacionesDetectadas;
module.exports.conPresentacionesSiga = conPresentacionesSiga;
module.exports.armarDetalle = armarDetalle;
module.exports.tipoInsumo = tipoInsumo;
module.exports.validarInsumosProducto = validarInsumosProducto;
module.exports.validarInsumoManual = validarInsumoManual;
module.exports.validarCategoriasMaquina = validarCategoriasMaquina;
module.exports.categoriasConUsos = categoriasConUsos;
module.exports.validarBajaCategorias = validarBajaCategorias;
module.exports.validarPedidoValidar = validarPedidoValidar;
module.exports.aplicarValidacion = aplicarValidacion;
module.exports.normalizarDatos = normalizarDatos;
module.exports.ErrorEntrada = ErrorEntrada;
