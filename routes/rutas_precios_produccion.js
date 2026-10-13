'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const produccion = require('../lib/precios_produccion');
const L = require('../lib/precios_listado_esquema');
const { configEsquemaDe } = require('../lib/precios_config_esquema');
const { crearConsultasPrecios } = require('../lib/precios_consultas');

// ── Precios, Fase 3: tab Producción ──────────────────────────────────────────
// Productos con recetas (base + variantes) y presentaciones en data/recetas_produccion.json (se crea con la primera
// escritura). El costo es lib/precios_produccion.js (sólo materias primas, cada una con el costo de su tab); los precios
// salen del motor del esquema (lib/precios_listado_esquema), igual que el listado.
// Selector, detalle y alertas pasan por costearProductos → costearProducto: nunca muestran cosas distintas.
// ponytail: recalcula todo en cada listado/alerta (decenas de productos); cachear costoDe si crece a miles.

const RECETAS_VACIO = { productos: {} };
const ID_PRODUCTO = /^p-[a-z0-9-]{1,48}$/;
const ID_RECETA = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PLU = /^\d{1,12}$/;
// Clave de presentación: PLU de SIGA o provisoria n-<slug> (todavía no dada de alta en SIGA; decisión 13).
const CLAVE_PRES = /^(\d{1,12}|n-[a-z0-9-]{1,40})$/;
const TIPOS_INSUMO = ['envase', 'tapa', 'etiqueta', 'precinto', 'otro'];
const TIPOS_EMPAQUE = ['envase', 'tapa', 'etiqueta', 'precinto']; // en una fórmula SIGA, el resto son ingredientes
const TEXTO_MAX = 60;
const COSTO_MAX = 1e9;
const INSUMOS_MAX = 100;
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

  const leerCosteo = () => leerJSON(COSTEO_PATH, {}) || {};
  // Costeo sin las decisiones vencidas (SIGA cambió el precio decidido, spec esquema §3): el costo de las materias primas
  // (costoEnSuTab) no usa una decisión que ya se importó.
  const costeoVigente = () => L.leerCosteoVigente({ leerCosteo, guardarCosteo: c => guardarJSON(COSTEO_PATH, c), preciosVigentes: preciosVigentesAlmacen });

  // Un solo camino de costeo para selector, detalle, alertas, validar y el listado del esquema.
  async function costearProductos(datos, ids) {
    const productos = Object.fromEntries(ids.map(id => [id, datos.productos[id]]));
    const [costeo, costos] = await Promise.all([costeoVigente(), costosPorPlu(plusUsados(productos))]);
    return { costeados: costearTodos({ productos, costos, costeo }) };
  }

  // Detalle costeado + vigente, fecha de precio y precios del motor por presentación (desglose sólo con el permiso de
  // Configuración: req.preciosSinConfig lo marca guardPrecios en server.js).
  async function detalleConPrecios(datos, id, req) {
    const costeo = leerCosteo();
    const pb = costeo.packBulto || {};
    const [{ costeados }, vigentes, fechas, { vinculos }] = await Promise.all([
      costearProductos(datos, [id]), preciosVigentesAlmacen(), fechasPrecioAlmacen(), vinculosPackBulto(pb.vinculosManuales || {}),
    ]);
    const cfg = configEsquemaDe(costeo);
    const mayoristasDe = L.crearMayoristasDe({ vinculos, vigentes, ventaPesable: pb.ventaPesable || {} });
    const conDesglose = !(req && req.preciosSinConfig === true);
    const margenExtra = datos.productos[id].margenEspecial || null;
    const esquemaDe = (plu, costoUnidad, nombre) => L.filaPublica(L.filaProducto({
      plu, nombre, tipo: 'produccion', costos: { sistema: costoUnidad > 0 ? costoUnidad : null, ultimaCompra: null, manual: null },
      vigente: vigentes.has(plu) ? vigentes.get(plu) : null, mayoristas: mayoristasDe(plu), cfg, margenExtra,
    }), conDesglose);
    return armarDetalle({ id, datos, costeado: costeados[id], vigentes, fechas, esquemaDe });
  }

  router.get('/api/precios/produccion/productos', ruta(async (req) => {
    const datos = leer();
    const [{ costeados }, fechas] = await Promise.all([costearProductos(datos, Object.keys(datos.productos)), fechasPrecioAlmacen()]);
    // "Recetas" (Con receta): los envasados tienen su propio sub-tab.
    return Object.entries(costeados).filter(([id]) => datos.productos[id].tipo !== 'envasado')
      .map(([id, c]) => filaSelector(id, datos.productos[id], c, fechas))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }));

  router.post('/api/precios/produccion/productos', ruta(async (req) => {
    const { nombre } = entrada(() => produccion.validarProducto(req.body));
    const datos = leer();
    const id = idUnico(`p-${slug(nombre)}`, datos.productos);
    const producto = { nombre, creado: hoy(), recetas: {}, presentaciones: {} };
    guardar({ ...datos, productos: { ...datos.productos, [id]: producto } });
    return { id, producto };
  }));

  // Alta de un producto completo desde la fórmula activa de SIGA de un PLU: receta base (ingredientes × kg por
  // tanda), la variedad automática y las presentaciones de SIGA que usan ese PLU (todas o el subconjunto
  // `presentaciones: [plu…]`), en una sola escritura. El empaque ya no se costea (fase 4): no se guarda.
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
    const inicial = productoDesdeFormula({ nombre, rendimientoKg, componentes: formula.componentes, creado: hoy() });
    const { producto, presentacionesCreadas, omitidas } = conPresentacionesSiga(inicial.producto, formula.presentaciones, {
      rendimientoKg, autoId: inicial.variedadCreada, productos: datos.productos, elegidas,
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

  // Margen especial del producto (puntos % por canal sobre el margen general). Es configuración: la ruta va en RUTAS_CONFIG
  // (lib/precios_permisos) y margenEspecial en CLAVES_OCULTAS. Body vacío / todo en 0 → se borra.
  router.put('/api/precios/produccion/productos/:id/margen-especial', ruta(async (req) => {
    const id = idProducto(req);
    const margenEspecial = entrada(() => produccion.validarMargenEspecial(req.body));
    mutarProducto(id, p => {
      const { margenEspecial: _viejo, ...resto } = p;
      return margenEspecial ? { ...resto, margenEspecial } : resto;
    });
    return { id, margenEspecial };
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
    const costoDe = armarCostoDe({ costos, costeo: await costeoVigente() });
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

  // ── Envasado Apidelta (granel × kg por unidad + empaque, lib/precios_produccion costearEnvasado) ──
  // El PLU de venta tiene que existir en SIGA (se consulta antes de leer el archivo: escritura sin await en el medio).
  async function pluVentaEnSiga(body) {
    const plu = validarId(esObjeto(body) ? body.plu : null, PLU, 'plu');
    if (!(await costosPorPlu([plu])).has(plu)) fallar(`plu: el PLU ${plu} no existe en SIGA`);
  }

  // Precarga del editor desde la fórmula activa de SIGA del PLU de venta (sin fórmula: vacío, se carga a mano).
  router.get('/api/precios/produccion/envasado/precarga/:plu', ruta(async (req) => envasadoDesdeFormula(await formulaSiga(validarId(req.params.plu, PLU, 'plu')))));

  router.post('/api/precios/produccion/envasado', ruta(async (req) => {
    await pluVentaEnSiga(req.body);
    const datos = leer();
    const limpio = entrada(() => produccion.validarEnvasado(req.body, datos.productos));
    const id = idUnico(`p-${slug(limpio.nombre)}`, datos.productos);
    const producto = { ...limpio, creado: hoy() };
    guardar({ ...datos, productos: { ...datos.productos, [id]: producto } });
    return { id, producto };
  }));

  // Edición: NO re-valida (conserva validado), ni toca creado ni el margen especial.
  router.put('/api/precios/produccion/productos/:id/envasado', ruta(async (req) => {
    const id = idProducto(req);
    await pluVentaEnSiga(req.body);
    const producto = mutarProducto(id, (p, datos) => {
      if (p.tipo !== 'envasado') fallar('el producto no es de envasado');
      const limpio = entrada(() => produccion.validarEnvasado(req.body, datos.productos, { productoId: id }));
      const conservar = Object.fromEntries(['creado', 'validado', 'margenEspecial'].filter(k => p[k] != null).map(k => [k, p[k]]));
      return { ...limpio, ...conservar };
    });
    return { id, producto };
  }));

  // Vista previa del editor (costo en vivo): valida igual que el alta/edición y costea en memoria con el mismo
  // detalleConPrecios que el GET. NO escribe. body.id = producto que se edita (conserva su validado y margen especial).
  // ponytail: el alta se costea bajo la clave '_nuevo' (no matchea ID_PRODUCTO: nunca pisa uno real).
  router.post('/api/precios/produccion/envasado/preview', ruta(async (req) => {
    const b = esObjeto(req.body) ? req.body : {};
    const id = b.id == null ? '_nuevo' : validarId(b.id, ID_PRODUCTO, 'id de producto');
    const datos = leer();
    const previo = id === '_nuevo' ? {} : productoDe(datos, id);
    const limpio = entrada(() => produccion.validarEnvasado(b, datos.productos, { productoId: id }));
    const conservar = Object.fromEntries(['validado', 'margenEspecial'].filter(k => previo[k] != null).map(k => [k, previo[k]]));
    const enMemoria = { ...datos, productos: { ...datos.productos, [id]: { ...limpio, ...conservar } } };
    const det = await detalleConPrecios(enMemoria, id, req);
    return det.presentaciones[limpio.plu];
  }));

  router.get('/api/precios/produccion/alertas', ruta(async () => {
    const datos = leer();
    const { costeados } = await costearProductos(datos, Object.keys(datos.productos));
    return produccion.resumenAlertas(costeados);
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
  return { ...o, productos: esObjeto(o.productos) ? o.productos : {} };
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

const esPlu = clave => PLU.test(String(clave));

// PLUs SIGA que hay que consultar: materias primas, extras y PLUs de presentación; de un envasado, granel y empaque.
function plusUsados(productos) {
  const plus = new Set();
  for (const p of Object.values(productos || {})) {
    for (const r of Object.values(p.recetas || {})) {
      for (const it of [...(r.materiasPrimas || []), ...(r.extras || [])]) plus.add(String(it.plu));
    }
    for (const plu of Object.keys(p.presentaciones || {})) plus.add(plu);
    if (p.tipo === 'envasado') [p.granelPlu, ...(p.componentes || []).map(c => c.plu)].forEach(plu => plus.add(String(plu)));
  }
  return [...plus].filter(esPlu);
}

// costoDe(plu) para lib/precios_produccion: el costo de la materia prima en su tab (decisión › manual › sistema, + costos
// extra; lib/precios_listado_esquema costoEnSuTab). Sin fila en SIGA → null (la lib lo convierte en faltante, nunca 0).
function armarCostoDe({ costos, costeo }) {
  return clave => {
    const row = esPlu(clave) ? costos.get(String(clave)) : null;
    if (!row) return null;
    const { costo, fuente } = L.costoEnSuTab(row, costeo, String(clave));
    return { costo, fuente, nombre: row.nombre };
  };
}

// Costea cada producto. Las presentaciones sin nombre propio toman el de SIGA.
function costearTodos({ productos, costos, costeo }) {
  const cfg = costeo || {};
  const costoDe = armarCostoDe({ costos, costeo: cfg });
  return Object.fromEntries(Object.entries(productos).map(([id, p]) => {
    const presentaciones = Object.fromEntries(Object.entries(p.presentaciones || {}).map(([plu, pr]) =>
      [plu, pr.nombre ? pr : { ...pr, nombre: (costos.get(plu) || {}).nombre || null }]));
    return [id, produccion.costearProducto({ producto: { ...p, presentaciones }, costoDe, toleranciaPct: cfg.toleranciaPct })];
  }));
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
// tanda, 4 decimales, sumando repetidos: mismo criterio que componentesAIngredientes del front). El empaque ya no se
// costea (fase 4): no se guarda.
function productoDesdeFormula({ nombre, rendimientoKg, componentes, creado }) {
  const ingredientes = componentes.filter(c => !TIPOS_EMPAQUE.includes(c.tipo));
  if (!ingredientes.length) fallar('la fórmula de SIGA sólo tiene empaque (envase, tapa, etiqueta o precinto): no hay ingredientes para la receta base');
  const cantidades = new Map();
  for (const c of ingredientes) {
    cantidades.set(c.plu, redondear4((cantidades.get(c.plu) || 0) + redondear4(Number(c.cantPorUnidad) * rendimientoKg)));
  }
  const materiasPrimas = [...cantidades].map(([plu, cantidad]) => ({ plu, cantidad, unidad: 'kg' }));
  const vacio = { nombre, creado, recetas: {}, presentaciones: {} };
  const base = entrada(() => produccion.validarReceta({ nombre, rendimientoKg, materiasPrimas }, vacio, 'base'));
  return conVariedadAutomatica({ ...vacio, recetas: { base } }, 'base');
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
// Variedad + presentación entran juntas: una omitida no deja una variedad huérfana.
function conPresentacionesSiga(producto, detectadas, { rendimientoKg, autoId, productos, elegidas = null }) {
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
      const pres = produccion.validarPresentacion({ recetaId: conVariedad.recetaId, kgPorUnidad: d.kgPorUnidad }, p, productos, { plu: d.plu });
      actual = { ...p, presentaciones: { ...p.presentaciones, [d.plu]: pres } };
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

// exportables = presentaciones con PLU de SIGA (las provisorias n-… no se pueden importar): Costo = costo total por unidad (sin precios: salen del esquema).
// fechas: Map plu → 'YYYY-MM-DD' del último cambio de precio en SIGA (la UI muestra la más antigua).
// variedad = nombre de la receta de la que sale la presentación.
function filaSelector(id, producto, costeado, fechas = new Map()) {
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
    exportables: Object.entries(costeado.presentaciones).filter(([plu]) => esPlu(plu)).map(([plu, p]) => ({
      plu, nombre: p.nombre, costoTotal: p.costoUnidad, faltantes: p.faltantes,
      fechaPrecio: fechas.get(plu) || null, variedad: variedadDe(plu),
    })),
  };
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

// Detalle: producto costeado + vigente SIGA, fecha del último cambio de precio y la fila del motor del esquema de cada
// presentación (esquemaDe(plu, costoUnidad, nombre), ya filtrada por permiso). `definicion` = el producto guardado (la UI
// precarga los editores; los costos salen siempre del costeo).
function armarDetalle({ id, datos, costeado, vigentes, fechas = new Map(), esquemaDe = () => null }) {
  const presentaciones = Object.fromEntries(Object.entries(costeado.presentaciones).map(([plu, p]) => [plu, {
    ...p, precioVigente: vigentes.has(plu) ? vigentes.get(plu) : null, fechaPrecio: fechas.get(plu) || null,
    esquema: esquemaDe(plu, p.costoUnidad, p.nombre),
  }]));
  return { id, ...costeado, creado: datos.productos[id].creado || null, presentaciones, definicion: datos.productos[id] };
}

function numeroEn(v, campo, { min, excluirMin }) {
  const ok = typeof v === 'number' && Number.isFinite(v) && (excluirMin ? v > min : v >= min) && v <= COSTO_MAX;
  if (!ok) fallar(`${campo}: debe ser un número ${excluirMin ? 'mayor a' : 'desde'} ${min} y hasta ${COSTO_MAX}`);
  return v;
}

// { tipo: 'receta'|'presentacion'|'todo', id? }
function validarPedidoValidar(body) {
  const b = esObjeto(body) ? body : {};
  if (b.tipo === 'todo') return { tipo: 'todo' };
  if (b.tipo === 'receta') return { tipo: 'receta', id: validarId(b.id, ID_RECETA, 'id') };
  if (b.tipo === 'presentacion') return { tipo: 'presentacion', id: validarId(b.id, CLAVE_PRES, 'id') };
  return fallar("tipo: debe ser 'receta', 'presentacion' o 'todo'");
}

// Aplica los snapshots (snapshotDe) al producto sin mutarlo. Validar una receta también valida las presentaciones que salen
// de ella ("a revisar" se limpia validando la receta, spec §2.1). Con faltantes no se valida: el pedido puntual es error;
// el resto (todo, o las presentaciones arrastradas) se omite y se informa en `omitidos`.
function aplicarValidacion(producto, costeado, { tipo, id }, fecha) {
  if (producto.tipo === 'envasado') return validarEnvasadoCosteado(producto, costeado, fecha);
  const grupos = [['receta', 'recetas'], ['presentacion', 'presentaciones']];
  const puntual = (t, k) => tipo !== 'todo' && t === tipo && k === id;
  const incluye = (t, k) => tipo === 'todo' || puntual(t, k)
    || (tipo === 'receta' && t === 'presentacion' && costeado.presentaciones[k].recetaId === id);
  const pedidos = grupos.flatMap(([t, clave]) => Object.keys(costeado[clave]).filter(k => incluye(t, k)).map(k => ({ t, clave, k })));
  if (tipo !== 'todo' && !pedidos.some(p => puntual(p.t, p.k))) fallar(`${tipo} ${id} no encontrada`);
  const validados = [], omitidos = [];
  let nuevo = producto;
  for (const { t, clave, k } of pedidos) {
    const c = costeado[clave][k];
    if (c.faltantes.length) {
      if (puntual(t, k)) fallar(`no se puede validar con faltantes: ${c.faltantes.join(', ')}`);
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

// Envasado: una sola "presentación" (su PLU de venta); el snapshot va en el producto. Con faltantes no se valida.
function validarEnvasadoCosteado(producto, costeado, fecha) {
  const c = costeado.presentaciones[producto.plu];
  if (!c) fallar(`presentacion ${producto.plu} no encontrada`);
  if (c.faltantes.length) fallar(`no se puede validar con faltantes: ${c.faltantes.join(', ')}`);
  return { producto: { ...producto, validado: produccion.snapshotDe(c, fecha) }, validados: [{ tipo: 'presentacion', id: producto.plu }], omitidos: [] };
}

// formulaSiga del PLU de venta → editor de envasado. Granel = el componente que no es empaque con "granel" en el nombre o,
// si no hay, el de más cantidad (kg por unidad = su cantidad); el resto (envase, tapa, etiqueta, otros) = empaque con
// su cantidad por unidad. Sin no-empaque: granel vacío y aviso (se elige a mano).
function envasadoDesdeFormula(formula) {
  const f = formula || {};
  if (!f.nombre) fallar('El PLU no existe en SIGA');
  const comps = f.componentes || [];
  const candidatos = comps.filter(c => !esEmpaqueSiga(c));
  const granel = candidatos.find(c => /granel/i.test(c.nombre || ''))
    || candidatos.reduce((max, c) => (!max || Number(c.cantPorUnidad) > Number(max.cantPorUnidad) ? c : max), null);
  const componentes = sumarPorPlu(comps.filter(c => c !== granel).map(c => ({ plu: c.plu, nombre: c.nombre, cantidad: Number(c.cantPorUnidad), costo: c.costo ?? null, tipo: c.tipo })));
  const mensaje = f.mensaje || (granel ? null : 'La fórmula de SIGA no tiene granel (sólo empaque): elegilo a mano.');
  return {
    plu: f.plu, nombre: f.nombre, granelPlu: granel ? granel.plu : null, granelNombre: granel ? granel.nombre : null,
    granelCosto: granel ? granel.costo ?? null : null, kgPorUnidad: granel ? Number(granel.cantPorUnidad) : null, componentes, mensaje,
  };
}

module.exports.slug = slug;
module.exports.envasadoDesdeFormula = envasadoDesdeFormula;
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
module.exports.validarPedidoValidar = validarPedidoValidar;
module.exports.aplicarValidacion = aplicarValidacion;
module.exports.normalizarDatos = normalizarDatos;
module.exports.ErrorEntrada = ErrorEntrada;
