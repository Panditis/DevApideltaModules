'use strict';
const express = require('express');
const path = require('path');
const productividad = require('../lib/productividad');
const fraccionadoExterno = require('../lib/fraccionado_externo');

// Selector de productos para armar pedidos de fraccionado a tercerizar: usa los tiempos reales
// del historial de producción (paquetes = kilos / peso de la presentación, no el campo que carga
// el operario a mano — ver lib/productividad.js) y dos valores que el usuario ajusta por pedido:
// factor de complejidad por producto y valor hora del tercero.
module.exports = function crearRutasFraccionadoExterno(deps) {
  const {
    apiRoute, leerJSON, CATALOGO_PATH, FRAC_REG_PATH, HISTORIAL_PATH,
    leerPedidosFraccionadoExterno, guardarPedidosFraccionadoExterno,
  } = deps;
  const router = express.Router();

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

  // Peso de una presentación aislada tal cual la tiene el catálogo (ej. "50G") — el nombre
  // completo de una carga ("Oregano Premium 50G") no matchea ese regex anclado, por eso el
  // fallback de más abajo extrae primero el token de peso al final del nombre.
  const PESO_AL_FINAL_DEL_NOMBRE = /(\d+(?:[.,]\d+)?\s*(?:KG|GR?|ML|L))\s*$/i;

  router.get('/api/fraccionado-externo/productos', apiRoute(async req => {
    // esVariante son bultos/repackaging mayorista, no el paquete individual que fracciona el
    // tercero — se excluyen del selector.
    const catalogo = leerJSON(CATALOGO_PATH, []).filter(p => p && p.plu != null && !p.esVariante);
    const catalogoPorPlu = new Map(catalogo.map(p => [String(p.plu), p]));

    // Si el producto no está en el catálogo de ventas (se fraccionó pero nunca se dio de alta
    // como ítem propio — pasa con condimentos/hierbas que se venden a granel), el peso de la
    // presentación se saca del nombre con el que quedó cargada la tanda.
    const pesoDe = (plu, nombreCarga) => {
      const item = catalogoPorPlu.get(plu);
      if (item) return productividad.pesoPresentacionKg(item.presentacion);
      const m = PESO_AL_FINAL_DEL_NOMBRE.exec(String(nombreCarga || '').trim());
      return m ? productividad.pesoPresentacionKg(m[1]) : null;
    };
    const tiempos = productividad.paquetesRealesPorProducto(cargasFraccionadoCompletas(), pesoDe);
    const tiempoPorPlu = new Map(tiempos.map(t => [t.plu, t]));

    const desdeCatalogo = catalogo.map(p => {
      const t = tiempoPorPlu.get(String(p.plu));
      return {
        plu: String(p.plu), nombre: p.producto, presentacion: p.presentacion || '',
        minPorPaquete: t ? t.minPorPaquete : null,
        paquetesHistoricos: t ? t.paquetes : null,
        cargas: t ? t.cargas : 0,
        tieneHistorial: !!(t && t.minPorPaquete != null),
      };
    });
    // Productos que se fraccionaron alguna vez pero no están en el catálogo de ventas: sin
    // esto, algo como el orégano (se vende a granel, nunca tuvo alta propia) queda invisible
    // para siempre en el buscador aunque tenga historial real.
    const desdeHistorialSinCatalogo = tiempos
      .filter(t => !catalogoPorPlu.has(t.plu))
      .map(t => ({
        plu: t.plu, nombre: t.producto, presentacion: '',
        minPorPaquete: t.minPorPaquete, paquetesHistoricos: t.paquetes,
        cargas: t.cargas, tieneHistorial: t.minPorPaquete != null,
      }));

    const buscar = String(req.query.buscar || '').trim().toLowerCase();
    const productos = [...desdeCatalogo, ...desdeHistorialSinCatalogo]
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
      const usuario = (req.session && req.session.user && req.session.user.nombre) || null;
      const pedido = fraccionadoExterno.construirPedido({
        numero, fechaISO: new Date().toISOString().slice(0, 10),
        tercero: req.body.tercero, usuario, valorHora: req.body.valorHora,
        items: req.body.items, ts: new Date().toISOString(),
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
