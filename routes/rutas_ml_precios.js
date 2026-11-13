'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const ml = require('../lib/ml_precios');

// ── Control de precios Mercado Libre (spec 2026-11-10-control-precios-ml) ─────
// Compara cada publicación de la bajada de ML con el esperado desde la carta de SIGA (lista 0, sucursal 1)
// y la config propia. SIGA solo lectura; lo único que se escribe son los 3 JSON de data/ (del módulo).
module.exports = function crearRutasMlPrecios(deps) {
  const { apiRoute, query, leerJSON, guardarJSON, DATA_DIR, LISTA_PRECIOS_VENTA } = deps;
  const router = express.Router();

  const PUBLICACIONES_PATH = path.join(DATA_DIR, 'ml_publicaciones.json');
  const VINCULOS_PATH = path.join(DATA_DIR, 'ml_vinculos.json');
  const CONFIG_PATH = path.join(DATA_DIR, 'ml_config.json');
  const SUCURSAL_CARTA = 1; // misma carta que precios-historico y el facturador
  const MAX_ARCHIVO_BYTES = 10 * 1024 * 1024;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ARCHIVO_BYTES, files: 1, fields: 4, parts: 6 } });

  class ErrorEntrada extends Error {}
  const esCodigo = v => Number.isInteger(v) && v > 0;

  // Si falta, se crea con defaults; lo existente no se pisa.
  function leerConfig() {
    const cfg = leerJSON(CONFIG_PATH, null);
    if (cfg) return ml.normalizarConfig(cfg); // campos nuevos en 0 / []; el archivo se reescribe recién al guardar
    guardarJSON(CONFIG_PATH, ml.CONFIG_DEFAULT);
    return ml.CONFIG_DEFAULT;
  }
  const leerVinculos = () => leerJSON(VINCULOS_PATH, {});

  // Códigos ya validados como enteros > 0: se interpolan como literal ('123'), sin texto del usuario.
  async function cartasDe(codigos) {
    const lista = [...new Set(codigos.filter(esCodigo))];
    if (!lista.length) return new Map();
    const inList = lista.map(c => `'${c}'`).join(',');
    const filas = await query(`
      SELECT p.IdProducto, p.NombreProducto, CAST(psp.PrecioVenta AS FLOAT) AS Precio
      FROM Productos p
      LEFT JOIN ProductosSucursalesPrecios psp
        ON psp.IdProducto = p.IdProducto AND psp.IdSucursal = ${SUCURSAL_CARTA} AND psp.IdListaPrecios = ${LISTA_PRECIOS_VENTA}
      WHERE p.IdProducto IN (${inList})`);
    return new Map(filas.map(f => [String(f.IdProducto).trim(), { precio: f.Precio, nombre: String(f.NombreProducto || '').trim() }]));
  }

  router.get('/ml-precios', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'ml_precios.html')));

  router.post('/api/ml-precios/importar', (req, res) => {
    upload.single('archivo')(req, res, err => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera los 10 MB.' : 'No se pudo recibir el archivo.' });
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo (campo "archivo").' });
      try {
        const r = ml.parsearBajada(req.file.buffer);
        const previas = new Set((leerJSON(PUBLICACIONES_PATH, { publicaciones: [] }).publicaciones || []).map(p => p.id));
        const vinculos = leerVinculos();
        guardarJSON(PUBLICACIONES_PATH, { importadoEn: new Date().toISOString(), archivo: req.file.originalname, publicaciones: r.publicaciones });
        return res.json({
          total: r.total,
          importadas: r.publicaciones.length,
          variantesIgnoradas: r.variantesIgnoradas,
          nuevasSinVincular: r.publicaciones.filter(p => !previas.has(p.id) && !vinculos[p.id]).length,
        });
      } catch (e) {
        if (e instanceof ml.ErrorBajada) return res.status(400).json({ error: e.message });
        console.error('[ml-precios] importando bajada:', e.message);
        return res.status(500).json({ error: 'No se pudo importar el archivo.' });
      }
    });
  });

  router.get('/api/ml-precios/control', async (_req, res) => {
    const { importadoEn = null, publicaciones = [] } = leerJSON(PUBLICACIONES_PATH, {});
    const vinculos = leerVinculos();
    const cfg = leerConfig();
    let cartas;
    try {
      cartas = await cartasDe(publicaciones.map(p => vinculos[p.id] && vinculos[p.id].codigo));
    } catch (e) {
      console.error('[ml-precios] carta de SIGA:', e.message);
      return res.status(502).json({ error: 'No se pudo leer la lista de precios de SIGA. Probá de nuevo en unos minutos.' });
    }
    const filas = publicaciones.map(p => ml.armarFila(p, vinculos[p.id] || null, cartas, cfg));
    return res.json({ importadoEn, kpis: ml.kpis(filas), filas });
  });

  // Todos los vínculos (de la bajada o cargados a mano). Si SIGA falla, nombreProducto va en null y la lista igual sale.
  router.get('/api/ml-precios/vinculos', async (_req, res) => {
    const vinculos = leerVinculos();
    const pubs = new Map((leerJSON(PUBLICACIONES_PATH, {}).publicaciones || []).map(p => [p.id, p]));
    let cartas = new Map();
    try {
      cartas = await cartasDe(Object.values(vinculos).map(v => v.codigo));
    } catch (e) {
      console.error('[ml-precios] nombres de SIGA para vínculos:', e.message);
    }
    return res.json({
      vinculos: Object.entries(vinculos).map(([id, v]) => {
        const pub = pubs.get(id);
        const info = cartas.get(String(v.codigo));
        return { id, codigo: v.codigo, unidades: v.unidades, pesoKg: typeof v.pesoKg === 'number' ? v.pesoKg : null, cuotasQty: Number.isInteger(v.cuotasQty) ? v.cuotasQty : null, titulo: pub ? pub.titulo : null, enBajada: !!pub, nombreProducto: info ? info.nombre : null };
      }),
    });
  });

  router.get('/api/ml-precios/producto/:codigo', async (req, res) => {
    const codigo = Number(req.params.codigo);
    if (!esCodigo(codigo)) return res.status(400).json({ error: 'El código debe ser un entero mayor a 0.' });
    let info;
    try {
      info = (await cartasDe([codigo])).get(String(codigo));
    } catch (e) {
      console.error('[ml-precios] producto de SIGA:', e.message);
      return res.status(502).json({ error: 'No se pudo consultar SIGA. Probá de nuevo en unos minutos.' });
    }
    if (!info) return res.status(404).json({ error: `El código ${codigo} no existe en SIGA.` });
    return res.json({ codigo, nombre: info.nombre, carta: info.precio });
  });

  router.put('/api/ml-precios/vinculos/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const { codigo, unidades, pesoKg = null, cuotasQty = null } = req.body || {};
    if (!/^MLA\d+$/.test(id)) return res.status(400).json({ error: 'ID de publicación inválido.' });
    const vinculos = leerVinculos();
    if (codigo === null) {
      const { [id]: _quitado, ...resto } = vinculos;
      guardarJSON(VINCULOS_PATH, resto);
      return res.json({ id, vinculo: null });
    }
    if (!esCodigo(codigo)) return res.status(400).json({ error: 'El código debe ser un entero mayor a 0.' });
    if (!Number.isInteger(unidades) || unidades < 1) return res.status(400).json({ error: 'Las unidades deben ser un entero ≥ 1.' });
    if (pesoKg !== null && (typeof pesoKg !== 'number' || !Number.isFinite(pesoKg) || pesoKg <= 0 || !(Math.abs(Math.round(pesoKg * 1000) - pesoKg * 1000) < 1e-6))) { // tolerancia: 1.005 * 1000 no da exacto en float
      return res.status(400).json({ error: 'El peso debe ser un número en kg mayor a 0, con hasta 3 decimales.' });
    }
    if (cuotasQty !== null && (!Number.isInteger(cuotasQty) || cuotasQty < 1 || cuotasQty > 24)) {
      return res.status(400).json({ error: 'Las cuotas deben ser un entero de 1 a 24.' });
    }
    try {
      const existe = await query(`SELECT TOP 1 IdProducto FROM Productos WHERE IdProducto = '${codigo}'`);
      if (!existe.length) return res.status(400).json({ error: `El código ${codigo} no existe en SIGA.` });
    } catch (e) {
      console.error('[ml-precios] validando código:', e.message);
      return res.status(502).json({ error: 'No se pudo consultar SIGA para validar el código.' });
    }
    const vinculo = { codigo, unidades, pesoKg, cuotasQty, actualizado: new Date().toISOString() };
    guardarJSON(VINCULOS_PATH, { ...vinculos, [id]: vinculo });
    return res.json({ id, vinculo });
  });

  router.get('/api/ml-precios/config', apiRoute(async () => leerConfig()));

  router.put('/api/ml-precios/config', (req, res) => {
    // Tablas ordenadas ascendente por su clave antes de validar (lo inválido lo rechaza validarConfig).
    const ordenar = (lista, k) => (Array.isArray(lista) ? [...lista].sort((x, y) => ((x && x[k]) ?? 0) - ((y && y[k]) ?? 0)) : lista);
    const body = req.body || {};
    const b = { ...body, tablaEnvio: ordenar(body.tablaEnvio, 'topeKg'), tablaCuotas: ordenar(body.tablaCuotas, 'cuotas'), tablaCostoFijo: ordenar(body.tablaCostoFijo, 'precioMax') };
    const error = ml.validarConfig(b);
    if (error) return res.status(400).json({ error });
    const cfg = {
      comisionPct: b.comisionPct, envioGratisPct: b.envioGratisPct,
      cuotasBasePct: b.cuotasBasePct ?? ml.CONFIG_DEFAULT.cuotasBasePct,
      tablaCuotas: (b.tablaCuotas ?? ml.CONFIG_DEFAULT.tablaCuotas).map(t => ({ cuotas: t.cuotas, recargoPct: t.recargoPct })),
      tablaCostoFijo: (b.tablaCostoFijo ?? ml.CONFIG_DEFAULT.tablaCostoFijo).map(t => ({ precioMax: t.precioMax, valor: t.valor })),
      toleranciaPct: b.toleranciaPct, redondeoPaso: b.redondeoPaso,
      envioMonto: b.envioMonto ?? 0, costoFijoMonto: b.costoFijoMonto ?? 0, impuestosPct: b.impuestosPct ?? 0,
      extras: (b.extras || []).map(e => ({ nombre: e.nombre.trim(), tipo: e.tipo, valor: e.valor })),
      envioGratisDesde: b.envioGratisDesde ?? ml.CONFIG_DEFAULT.envioGratisDesde,
      envioBonificado: b.envioBonificado ?? false,
      tablaEnvio: (b.tablaEnvio ?? ml.CONFIG_DEFAULT.tablaEnvio).map(t => ({ topeKg: t.topeKg, valor: t.valor })),
    };
    guardarJSON(CONFIG_PATH, cfg);
    return res.json(cfg);
  });

  return router;
};
