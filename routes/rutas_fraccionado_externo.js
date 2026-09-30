'use strict';
const express = require('express');
const path = require('path');
const productividad = require('../lib/productividad');
const fraccionadoExterno = require('../lib/fraccionado_externo');

// Selector de productos para armar pedidos de fraccionado a tercerizar: usa los tiempos reales
// del historial de producción (paquetes = kilos / peso de la presentación — ver
// lib/productividad.js) sólo para sugerir el nivel de tiempo; el costo sale de los niveles
// configurados (tiempo y complejidad por producto) y del valor hora del tercero.
module.exports = function crearRutasFraccionadoExterno(deps) {
  const {
    apiRoute, leerJSON, guardarJSON, query, DATA_DIR, FRAC_REG_PATH, HISTORIAL_PATH,
    leerPedidosFraccionadoExterno, guardarPedidosFraccionadoExterno,
  } = deps;
  const router = express.Router();

  // Valores de cada nivel (fácil/medio/difícil, rápido/normal/lento). Archivo ausente o roto →
  // defaults, así el módulo funciona sin haber pasado nunca por la tab Configuración.
  const CONFIG_PATH = path.join(DATA_DIR, 'fraccionado_externo_config.json');
  function leerConfig() {
    try { return fraccionadoExterno.validarConfig(leerJSON(CONFIG_PATH, fraccionadoExterno.CONFIG_DEFAULT)); }
    catch (_) { return fraccionadoExterno.CONFIG_DEFAULT; }
  }

  router.get('/api/fraccionado-externo/config', apiRoute(async () => ({ config: leerConfig() })));

  router.put('/api/fraccionado-externo/config', (req, res) => {
    try {
      const config = fraccionadoExterno.validarConfig(req.body && req.body.config);
      guardarJSON(CONFIG_PATH, config);
      res.json({ config });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Tareas específicas: trabajos que no son productos, con un monto fijo por unidad. Archivo
  // ausente o roto → lista vacía, así el módulo funciona sin haber creado ninguna.
  const TAREAS_PATH = path.join(DATA_DIR, 'fraccionado_externo_tareas.json');
  function leerTareas() {
    const data = leerJSON(TAREAS_PATH, { tareas: [] });
    return Array.isArray(data && data.tareas) ? data.tareas : [];
  }
  const guardarTareas = tareas => guardarJSON(TAREAS_PATH, { tareas });

  router.get('/api/fraccionado-externo/tareas', apiRoute(async () => ({ tareas: leerTareas() })));

  router.post('/api/fraccionado-externo/tareas', (req, res) => {
    try {
      const tareas = leerTareas();
      const tarea = {
        id: fraccionadoExterno.siguienteIdTarea(tareas),
        ...fraccionadoExterno.validarTarea(req.body, tareas),
      };
      guardarTareas([...tareas, tarea]);
      res.json({ tarea });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/api/fraccionado-externo/tareas/:id', (req, res) => {
    const tareas = leerTareas();
    const idx = tareas.findIndex(t => t.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Tarea no encontrada' });
    try {
      const tarea = { id: req.params.id, ...fraccionadoExterno.validarTarea(req.body, tareas, req.params.id) };
      guardarTareas(tareas.map((t, i) => (i === idx ? tarea : t)));
      res.json({ tarea });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/fraccionado-externo/tareas/:id', (req, res) => {
    const tareas = leerTareas();
    if (!tareas.some(t => t.id === req.params.id)) return res.status(404).json({ error: 'Tarea no encontrada' });
    guardarTareas(tareas.filter(t => t.id !== req.params.id));
    res.json({ ok: true });
  });

  router.get('/fraccionado-externo', (_req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'fraccionado_externo.html')));

  // Todas las cargas de fraccionado, sin filtro de fecha: el ritmo de un producto se calcula
  // con todo el historial, no con una ventana — mismo criterio que /api/productividad sin
  // desde/hasta.
  function cargasFraccionadoCompletas() {
    const historial = leerJSON(HISTORIAL_PATH, []);
    return productividad.unirPorId(
      leerJSON(FRAC_REG_PATH, []),
      (historial || []).flatMap(h => (h && h.produccion) || []),
    );
  }

  // El peso de la presentación no viene de ningún campo limpio acá (a diferencia de
  // catalogo.json): se extrae del propio nombre del producto, que en SIGA y en las cargas
  // siempre termina con el token de peso ("Oregano Premium 50G" → "50G").
  const PESO_AL_FINAL_DEL_NOMBRE = /(\d+(?:[.,]\d+)?\s*(?:KG|GR?|ML|L))\s*$/i;
  function presentacionDe(nombre) {
    const m = PESO_AL_FINAL_DEL_NOMBRE.exec(String(nombre || '').trim());
    return m ? m[1].toUpperCase().replace(/\s+/g, '') : '';
  }
  function pesoDe(nombre) {
    const m = PESO_AL_FINAL_DEL_NOMBRE.exec(String(nombre || '').trim());
    return m ? productividad.pesoPresentacionKg(m[1]) : null;
  }

  // Universo completo de pesables/fraccionado del sistema: lo define SIGA por rubro, no el
  // catálogo de ventas de Apidelta (son dos listas casi sin superposición — un producto puede
  // fraccionarse sin nunca haberse dado de alta como ítem propio, ej. condimentos a granel).
  // Mismo filtro que usa el motor de distribución para la tab Pesables.
  async function productosPesablesFraccionado() {
    const rows = await query(`
      SELECT CAST(p.IdProducto AS VARCHAR) AS IdProducto, p.NombreProducto
      FROM Productos p JOIN Rubros r ON r.IdRubro = p.IdRubro
      WHERE p.Activo = 1 AND r.NombreRubro = 'Pesables Fraccionado'
    `);
    return rows
      .map(r => ({ plu: String(r.IdProducto || '').trim(), nombre: String(r.NombreProducto || '').trim() }))
      .filter(p => p.plu);
  }

  router.get('/api/fraccionado-externo/productos', apiRoute(async req => {
    const pesables = await productosPesablesFraccionado();
    const pesablesPorPlu = new Map(pesables.map(p => [p.plu, p]));

    const tiempos = productividad.paquetesRealesPorProducto(
      cargasFraccionadoCompletas(),
      (plu, nombreCarga) => pesoDe((pesablesPorPlu.get(plu) || {}).nombre || nombreCarga),
    );
    const tiempoPorPlu = new Map(tiempos.map(t => [t.plu, t]));
    const { tiempos: nivelesTiempo } = leerConfig();
    const sugerido = min => fraccionadoExterno.nivelTiempoMasCercano(min, nivelesTiempo);

    const desdePesables = pesables.map(p => {
      const t = tiempoPorPlu.get(p.plu);
      return {
        plu: p.plu, nombre: p.nombre, presentacion: presentacionDe(p.nombre),
        minPorPaquete: t ? t.minPorPaquete : null,
        paquetesHistoricos: t ? t.paquetes : null,
        cargas: t ? t.cargas : 0,
        tieneHistorial: !!(t && t.minPorPaquete != null),
        nivelTiempoSugerido: sugerido(t ? t.minPorPaquete : null),
      };
    });
    // Productos con historial de fraccionado que hoy no figuran en el rubro SIGA (ej. se dieron
    // de baja, o cambiaron de rubro) — igual hay que poder volver a pedirlos.
    const desdeHistorialSinRubro = tiempos
      .filter(t => !pesablesPorPlu.has(t.plu))
      .map(t => ({
        plu: t.plu, nombre: t.producto, presentacion: presentacionDe(t.producto),
        minPorPaquete: t.minPorPaquete, paquetesHistoricos: t.paquetes,
        cargas: t.cargas, tieneHistorial: t.minPorPaquete != null,
        nivelTiempoSugerido: sugerido(t.minPorPaquete),
      }));

    const buscar = String(req.query.buscar || '').trim().toLowerCase();
    const productos = [...desdePesables, ...desdeHistorialSinRubro]
      .filter(p => !buscar || String(p.nombre || '').toLowerCase().includes(buscar))
      .sort((a, b) => a.nombre.localeCompare(b.nombre));
    return { productos };
  }));

  router.get('/api/fraccionado-externo/pedidos', apiRoute(async () =>
    ({ pedidos: leerPedidosFraccionadoExterno() })));

  router.post('/api/fraccionado-externo/pedidos', (req, res) => {
    try {
      const pedidos = leerPedidosFraccionadoExterno();
      const numero = fraccionadoExterno.siguienteNumero(pedidos);
      // Minutos y factor (productos) y nombre y monto (tareas) se resuelven acá desde la config y
      // el archivo de tareas, no se confía en números del cliente.
      const config = leerConfig();
      const tareas = leerTareas();
      const items = (Array.isArray(req.body.items) ? req.body.items : [])
        .map(it => (it && it.tipo === 'tarea'
          ? fraccionadoExterno.resolverTarea(it, tareas)
          : fraccionadoExterno.resolverNiveles(it, config)));
      const usuario = (req.session && req.session.user && req.session.user.nombre) || null;
      const pedido = fraccionadoExterno.construirPedido({
        numero, fechaISO: new Date().toISOString().slice(0, 10),
        tercero: req.body.tercero, usuario, valorHora: req.body.valorHora,
        items, ts: new Date().toISOString(),
      });
      guardarPedidosFraccionadoExterno([...pedidos, pedido]);
      res.json({ pedido });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/fraccionado-externo/pedidos/:numero/anular', (req, res) => {
    const pedidos = leerPedidosFraccionadoExterno();
    const idx = pedidos.findIndex(p => p.numero === req.params.numero);
    if (idx < 0) return res.status(404).json({ error: 'Pedido no encontrado' });
    try {
      const usuario = (req.session && req.session.user && req.session.user.nombre) || null;
      const actualizado = fraccionadoExterno.anularPedido(pedidos[idx], { ts: new Date().toISOString(), usuario });
      const nuevos = pedidos.slice();
      nuevos[idx] = actualizado;
      guardarPedidosFraccionadoExterno(nuevos);
      res.json({ pedido: actualizado });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
