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
  const MAX_FILAS_IMPORTAR = 2000;
  const MAX_UNIDADES_IMPORTAR = 9999;
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

  // Filas del control; null si SIGA falla (ya respondió 502).
  async function filasControl(publicaciones, res) {
    const vinculos = leerVinculos();
    const cfg = leerConfig();
    let cartas;
    try {
      cartas = await cartasDe(publicaciones.map(p => vinculos[p.id] && vinculos[p.id].codigo));
    } catch (e) {
      console.error('[ml-precios] carta de SIGA:', e.message);
      res.status(502).json({ error: 'No se pudo leer la lista de precios de SIGA. Probá de nuevo en unos minutos.' });
      return null;
    }
    return publicaciones.map(p => ml.armarFila(p, vinculos[p.id] || null, cartas, cfg));
  }

  router.get('/api/ml-precios/control', async (_req, res) => {
    const { importadoEn = null, publicaciones = [] } = leerJSON(PUBLICACIONES_PATH, {});
    const filas = await filasControl(publicaciones, res);
    if (!filas) return;
    return res.json({ importadoEn, kpis: ml.kpis(filas), filas });
  });

  // La bajada que sube el usuario, devuelta con PRICE = esperado del módulo y el resto del archivo intacto.
  router.post('/api/ml-precios/exportar', (req, res) => {
    upload.single('archivo')(req, res, async err => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera los 10 MB.' : 'No se pudo recibir el archivo.' });
      if (!req.file) return res.status(400).json({ error: 'Falta el archivo (campo "archivo").' });
      let publicaciones;
      try {
        publicaciones = ml.parsearBajada(req.file.buffer).publicaciones;
      } catch (e) {
        if (e instanceof ml.ErrorBajada) return res.status(400).json({ error: e.message });
        console.error('[ml-precios] exportar, leyendo bajada:', e);
        return res.status(500).json({ error: 'No se pudo generar el Excel.' });
      }
      let filas;
      try { // dentro del callback de multer Express 5 no atrapa el rechazo
        filas = await filasControl(publicaciones, res);
      } catch (e) {
        console.error('[ml-precios] exportar, armando filas:', e);
        return res.status(500).json({ error: 'No se pudo generar el Excel.' });
      }
      if (!filas) return;
      const esperadoPorId = Object.create(null);
      for (const f of filas) if (typeof f.esperado === 'number' && f.esperado > 0) esperadoPorId[f.id] = f.esperado;
      let r;
      try {
        r = ml.aplicarPreciosEnBajada(req.file.buffer, esperadoPorId);
      } catch (e) {
        if (e instanceof ml.ErrorBajada) return res.status(400).json({ error: e.message });
        console.error('[ml-precios] exportando bajada:', e);
        return res.status(500).json({ error: 'No se pudo generar el Excel.' });
      }
      const base = String(req.file.originalname || '').replace(/\.xlsx$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'bajada_ml';
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${base}_precios_modulo.xlsx"`,
        'X-Ml-Exportadas': String(r.exportadas),
        'X-Ml-Sin-Cambio': String(r.sinCambio),
      });
      return res.send(r.buffer);
    });
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
        return { id, codigo: v.codigo, unidades: v.unidades, pesoKg: typeof v.pesoKg === 'number' ? v.pesoKg : null, pesoEstimado: v.pesoEstimado === true, cuotasQty: Number.isInteger(v.cuotasQty) ? v.cuotasQty : null, precioPorKg: v.precioPorKg === true, titulo: pub ? pub.titulo : null, enBajada: !!pub, nombreProducto: info ? info.nombre : null };
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
    return res.json({ codigo, nombre: info.nombre, carta: info.precio, pesoUnitarioEstimadoKg: ml.estimarPesoKg(info.nombre) });
  });

  router.put('/api/ml-precios/vinculos/:id', async (req, res) => {
    const id = String(req.params.id || '').trim();
    const body = req.body || {};
    const { codigo, unidades, pesoKg = null, cuotasQty = null } = body;
    if (!/^MLA\d+$/.test(id)) return res.status(400).json({ error: 'ID de publicación inválido.' });
    if (codigo === null) {
      const { [id]: _quitado, ...resto } = leerVinculos();
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
    if ('precioPorKg' in body && typeof body.precioPorKg !== 'boolean') return res.status(400).json({ error: 'precioPorKg debe ser true o false' });
    try {
      const existe = await query(`SELECT TOP 1 IdProducto FROM Productos WHERE IdProducto = '${codigo}'`);
      if (!existe.length) return res.status(400).json({ error: `El código ${codigo} no existe en SIGA.` });
    } catch (e) {
      console.error('[ml-precios] validando código:', e.message);
      return res.status(502).json({ error: 'No se pudo consultar SIGA para validar el código.' });
    }
    const vinculos = leerVinculos(); // después del await: no pisa un import que haya escrito mientras tanto
    const previo = vinculos[id];
    // Sin la clave pesoKg se conservan peso y pesoEstimado; con pesoKg explícito (número o null) es manual.
    const peso = 'pesoKg' in body ? { pesoKg, pesoEstimado: false }
      : { pesoKg: previo && typeof previo.pesoKg === 'number' ? previo.pesoKg : null, pesoEstimado: !!previo && previo.pesoEstimado === true };
    // precioPorKg: sin la clave se conserva el previo; se guarda solo `true` (false = key ausente).
    const porKg = 'precioPorKg' in body ? body.precioPorKg : !!previo && previo.precioPorKg === true;
    const vinculo = { codigo, unidades, ...peso, cuotasQty, ...(porKg ? { precioPorKg: true } : {}), actualizado: new Date().toISOString() };
    guardarJSON(VINCULOS_PATH, { ...vinculos, [id]: vinculo });
    return res.json({ id, vinculo });
  });

  // Carga masiva del cruce PLU SIGA ↔ MLA. Una sola consulta a SIGA y una sola escritura (si hay cambios).
  router.post('/api/ml-precios/vinculos/importar', async (req, res) => {
    const { filas, pisar = false, soloValidar = false, estimarPeso = true } = req.body || {};
    if (!Array.isArray(filas)) return res.status(400).json({ error: 'filas debe ser una lista.' });
    if (filas.length > MAX_FILAS_IMPORTAR) return res.status(400).json({ error: `No se pueden importar más de ${MAX_FILAS_IMPORTAR} filas por vez.` });
    for (const [k, v] of Object.entries({ pisar, soloValidar, estimarPeso })) {
      if (typeof v !== 'boolean') return res.status(400).json({ error: `${k} debe ser true o false.` });
    }
    const entero = v => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v);
    const invalidas = [];
    const porId = new Map(); // id → [{ codigo, unidades }] (unidades null = la fila no la trae)
    for (const f of filas) {
      const id = String((f && f.id) ?? '').trim().toUpperCase();
      const crudo = f ? f.codigo : undefined;
      const codigo = entero(crudo);
      const uCrudo = f ? f.unidades : undefined;
      const unidades = uCrudo == null || uCrudo === '' ? null : entero(uCrudo);
      const fila = { id: f ? f.id ?? null : null, codigo: crudo ?? null };
      if (!/^MLA\d+$/.test(id)) { invalidas.push({ ...fila, motivo: 'ID de publicación inválido' }); continue; }
      if (!esCodigo(codigo)) { invalidas.push({ ...fila, id, motivo: 'El código debe ser un entero mayor a 0' }); continue; }
      if (unidades !== null && (!Number.isInteger(unidades) || unidades < 1 || unidades > MAX_UNIDADES_IMPORTAR)) {
        invalidas.push({ ...fila, id, motivo: `La cantidad debe ser un entero de 1 a ${MAX_UNIDADES_IMPORTAR}` }); continue;
      }
      const lista = porId.get(id) || [];
      if (!lista.some(x => x.codigo === codigo && x.unidades === unidades)) lista.push({ codigo, unidades }); // duplicado exacto: se ignora
      porId.set(id, lista);
    }
    const unicos = xs => [...new Set(xs)];
    const conflictos = [...porId].filter(([, l]) => l.length > 1)
      .map(([id, l]) => ({ id, codigos: unicos(l.map(x => x.codigo)), unidades: unicos(l.map(x => x.unidades)) }));
    const candidatos = [...porId].filter(([, l]) => l.length === 1).map(([id, [x]]) => ({ id, ...x }));
    let existentes;
    try {
      existentes = await cartasDe(candidatos.map(x => x.codigo));
    } catch (e) {
      console.error('[ml-precios] importando vínculos, SIGA:', e.message);
      return res.status(502).json({ error: 'No se pudo consultar SIGA para validar los códigos.' });
    }
    const codigosInexistentes = candidatos.filter(x => !existentes.has(String(x.codigo))).map(({ id, codigo }) => ({ id, codigo }));
    const vinculos = leerVinculos();
    const enBajadaIds = new Set((leerJSON(PUBLICACIONES_PATH, {}).publicaciones || []).map(p => p.id));
    const cambios = {};
    const omitidosExistentes = [];
    const sinPesoEstimado = [];
    let nuevos = 0, actualizados = 0, pesosEstimados = 0;
    const ahora = new Date().toISOString();
    // Peso estimado por nombre × unidades; un peso manual (pesoKg no null y pesoEstimado no true) nunca se pisa.
    const conPeso = (id, v) => {
      if (!estimarPeso || (typeof v.pesoKg === 'number' && v.pesoEstimado !== true)) return v;
      const nombre = existentes.get(String(v.codigo)).nombre;
      const unitario = ml.estimarPesoKg(nombre);
      const total = unitario == null ? null : Math.round(unitario * v.unidades * 1000) / 1000;
      if (total == null || total > ml.PESO_MAX_ESTIMADO_KG) {
        sinPesoEstimado.push({ id, codigo: v.codigo, nombre, ...(total == null ? {} : { motivo: `peso mayor a ${ml.PESO_MAX_ESTIMADO_KG} kg` }) });
        return { ...v, pesoKg: null, pesoEstimado: false };
      }
      pesosEstimados++;
      return { ...v, pesoKg: total, pesoEstimado: true };
    };
    for (const { id, codigo, unidades } of candidatos) {
      if (!existentes.has(String(codigo))) continue;
      const previo = vinculos[id];
      if (!previo) {
        cambios[id] = conPeso(id, { codigo, unidades: unidades ?? 1, pesoKg: null, pesoEstimado: false, cuotasQty: null, actualizado: ahora });
        nuevos++;
        continue;
      }
      if (!pisar) { omitidosExistentes.push(id); continue; }
      // Mismo código y unidades: igual se evalúa el peso si es estimable (null o estimado); solo se escribe si cambia.
      const mismo = previo.codigo === codigo && (unidades === null || previo.unidades === unidades);
      if (mismo && !(estimarPeso && (typeof previo.pesoKg !== 'number' || previo.pesoEstimado === true))) continue;
      const nuevo = conPeso(id, { ...previo, codigo, unidades: unidades ?? previo.unidades, actualizado: ahora });
      if (mismo && nuevo.pesoKg === (previo.pesoKg ?? null) && nuevo.pesoEstimado === (previo.pesoEstimado === true)) continue;
      cambios[id] = nuevo;
      actualizados++;
    }
    const importadas = Object.keys(cambios);
    if (!soloValidar && importadas.length) guardarJSON(VINCULOS_PATH, { ...vinculos, ...cambios });
    return res.json({
      soloValidar, total: filas.length, nuevos, actualizados, omitidosExistentes, invalidas, conflictos, codigosInexistentes, pesosEstimados, sinPesoEstimado,
      enBajada: importadas.filter(id => enBajadaIds.has(id)).length, fueraDeBajada: importadas.filter(id => !enBajadaIds.has(id)),
    });
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
