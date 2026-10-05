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

  // Un solo camino de costeo para selector, detalle, alertas y validar.
  async function costearProductos(datos, ids) {
    const productos = Object.fromEntries(ids.map(id => [id, datos.productos[id]]));
    const costeo = costeoConCurva(leerJSON(COSTEO_PATH, {}) || {});
    const costos = await costosPorPlu(plusUsados(productos));
    const costeados = costearTodos({ productos, costos, costeo, datos });
    return { costeados, costos, costeo };
  }

  // Detalle costeado + vigentes SIGA + sub-filas pack/bulto de cada presentación (una query de vínculos).
  async function detalleConPrecios(datos, id) {
    const manuales = ((costeoConCurva(leerJSON(COSTEO_PATH, {}) || {})).packBulto || {}).vinculosManuales || {};
    const [{ costeados, costos, costeo }, vigentes, fechas, { vinculos }] = await Promise.all([
      costearProductos(datos, [id]), preciosVigentesAlmacen(), fechasPrecioAlmacen(), vinculosPackBulto(manuales),
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

  router.get('/api/precios/produccion/productos', ruta(async () => {
    const datos = leer();
    const [{ costeados, costeo }, fechas] = await Promise.all([costearProductos(datos, Object.keys(datos.productos)), fechasPrecioAlmacen()]);
    return Object.entries(costeados)
      .map(([id, c]) => filaSelector(id, datos.productos[id], c, costeo.marcadosExportar, fechas))
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

  router.get('/api/precios/produccion/productos/:id', ruta(async (req) => {
    const id = idProducto(req);
    const datos = leer();
    productoDe(datos, id);
    return detalleConPrecios(datos, id);
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
  router.put('/api/precios/produccion/productos/:id/recetas/:recetaId', ruta(async (req) => {
    const id = idProducto(req);
    const recetaId = validarId(req.params.recetaId, ID_RECETA, 'recetaId');
    const escalar = esObjeto(req.body) && req.body.escalarVariantes === true;
    const producto = mutarProducto(id, p => {
      const limpia = entrada(() => produccion.validarReceta(req.body, p, recetaId));
      const previa = (p.recetas || {})[recetaId];
      const receta = previa && previa.validado ? { ...limpia, validado: previa.validado } : limpia;
      const recetas = { ...(p.recetas || {}), [recetaId]: receta };
      const factor = escalar && previa && !limpia.varianteDe && previa.rendimientoKg > 0 ? limpia.rendimientoKg / previa.rendimientoKg : 1;
      return { ...p, recetas: produccion.escalarVariantes(recetas, recetaId, factor) };
    });
    return { id, recetaId, receta: producto.recetas[recetaId] };
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
    const det = await detalleConPrecios(enMemoria, id);
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
  router.get('/api/precios/produccion/formula-siga/:plu', ruta(async (req) => {
    const plu = validarId(req.params.plu, PLU, 'plu');
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
    return { plu, nombre: prod ? prod.nombre : null, componentes, mensaje };
  }));

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

// Receta base del producto: la de id 'base' o, si no, la primera que no es variante.
function recetaBaseId(recetas) {
  const ids = Object.keys(recetas || {});
  if (ids.includes('base') && !recetas.base.varianteDe) return 'base';
  return ids.find(id => !recetas[id].varianteDe) || null;
}

// marcados = costeo.marcadosExportar ({ plu: fecha }). exportables = presentaciones con PLU de SIGA
// (las provisorias n-… no se pueden importar) para marcar y exportar: Costo = costo total por unidad.
// fechas: Map plu → 'YYYY-MM-DD' del último cambio de precio en SIGA (la UI muestra la más antigua).
function filaSelector(id, producto, costeado, marcados = {}, fechas = new Map()) {
  const recetas = producto.recetas || {};
  const baseId = recetaBaseId(recetas);
  return {
    id, nombre: producto.nombre,
    variantes: Object.values(recetas).filter(r => r.varianteDe).length,
    presentaciones: Object.keys(producto.presentaciones || {}).length,
    costoKgBase: baseId ? costeado.recetas[baseId].costoKg : null,
    alertas: costeado.resumen.alertas, faltantes: costeado.resumen.faltantes,
    exportables: Object.entries(costeado.presentaciones).filter(([plu]) => esPlu(plu)).map(([plu, p]) => ({
      plu, nombre: p.nombre, costoTotal: p.costoUnidad, precioConIva: p.precioConIva, faltantes: p.faltantes, ivaPct: p.ivaPct,
      marcado: Object.hasOwn(marcados || {}, plu), fechaPrecio: fechas.get(plu) || null,
    })),
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
