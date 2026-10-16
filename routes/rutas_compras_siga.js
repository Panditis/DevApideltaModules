'use strict';
const express = require('express');
const path = require('path');
const { claveComprobante } = require('../lib/compras_control');
const desdePedido = require('../lib/siga_compras/desde_pedido');
const { calcularComprobante, armarComprobante } = require('../lib/siga_compras/armar_comprobante');
const { validarComprobante } = require('../lib/siga_compras/validaciones');
const { fechaLocalISO } = require('../lib/siga_compras/fechas');

// ── Importación de pedidos de compra como comprobantes en SIGA ──────────────────
// Spec: docs/superpowers/specs/2026-10-15-compras-siga-importacion-design.md. Reglas en lib/siga_compras/.
// El servidor NUNCA usa importes del navegador: recibe solo lo editable (desde_pedido.aplicarEdicion), rearma las
// líneas desde el pedido y recalcula todo. repo llega inyectado (lib/siga_compras/repo.js en server.js; uno falso
// en los tests).
const SIN_CONFIRMAR = 'SIGA_SIN_CONFIRMAR';
const MENSAJE_A_VERIFICAR = 'El pedido tiene una grabación sin confirmar: verificá en SiGA si el comprobante quedó cargado antes de reintentar.';
const MENSAJE_INTERNO = 'Error interno al procesar el comprobante para SIGA. Avisá a sistemas (el detalle quedó en el log del servidor).';

const esErrorSiga = err => !!err && (err.name === 'ErrorSiga' || err.code === 'SIGA_CONFIG' || err.code === SIN_CONFIRMAR);

const comprobanteDe = clave => ({
  idSucursal: clave.IdSucursal, tipoComprobante: clave.IdTipoComprobante, letra: clave.Letra,
  centroEmisor: clave.CentroEmisor, numeroComprobante: clave.NumeroComprobante, idProveedor: clave.IdProveedor,
});

module.exports = function crearRutasComprasSiga(deps) {
  const { leerJSON, guardarJSON, DATA_DIR, leerPedidosCompra, usuarioCompras, repo } = deps;
  const ahora = deps.ahora || (() => new Date());
  const router = express.Router();

  // Mismo archivo que el Control de compras (routes/rutas_compras_control.js): pedido → claves de comprobante.
  const VINCULOS_PATH = path.join(DATA_DIR, 'pedidos_comprobantes.json');
  // Pedidos con una grabación que hizo COMMIT pero no se pudo confirmar: { [numeroPedido]: { estado: 'a_verificar', … } }.
  const ESTADO_PATH = path.join(DATA_DIR, 'compras_siga_estado.json');
  const leerVinculos = () => leerJSON(VINCULOS_PATH, {}) || {};
  const leerEstado = () => leerJSON(ESTADO_PATH, {}) || {};
  // ponytail: lock en memoria por pedido contra el doble clic; alcanza con un solo proceso Node.
  const grabando = new Set();

  function responderError(res, err, donde, numero) {
    if (esErrorSiga(err)) return res.status(err.code === SIN_CONFIRMAR ? 409 : 422).json({ ok: false, error: err.message });
    console.error(`[compras-siga] ${donde} pedido ${numero}:`, (err && err.stack) || err);
    return res.status(500).json({ ok: false, error: MENSAJE_INTERNO });
  }

  function pedidoYBorrador(numero) {
    const pedido = leerPedidosCompra().find(p => String(p.numero) === String(numero));
    if (!pedido) return null;
    const vinculos = leerVinculos()[pedido.numero];
    const vinculado = Array.isArray(vinculos) && vinculos.length > 0;
    const base = desdePedido.borradorDesdePedido(pedido, { vinculado });
    const aVerificar = (leerEstado()[pedido.numero] || {}).estado === 'a_verificar';
    return {
      pedido,
      base: aVerificar ? { ...base, bloqueos: [...base.bloqueos, { tipo: 'estado', mensaje: MENSAJE_A_VERIFICAR }] } : base,
    };
  }

  async function evaluar(body) {
    const encontrado = pedidoYBorrador(body && body.pedido);
    if (!encontrado) return null;
    const borrador = desdePedido.aplicarEdicion(encontrado.base, body);
    const momento = ahora();
    const contexto = await repo.contexto(borrador, { hoy: fechaLocalISO(momento) });
    const calculo = calcularComprobante(borrador, contexto);
    const errores = [
      ...encontrado.base.bloqueos.filter(b => b.tipo === 'estado').map(b => ({ campo: 'pedido', mensaje: b.mensaje })),
      ...validarComprobante(borrador, contexto, calculo),
    ];
    return { borrador, contexto, calculo, errores, momento };
  }

  const vista = ({ calculo, errores }) => ({
    lineas: calculo.lineas, filasImpuestos: calculo.filasImpuestos, totales: calculo.totales,
    discrimina: calculo.discrimina, errores,
  });

  // El comprobante ya está en SIGA: si falla el disco no se revierte nada, se avisa para vincularlo a mano.
  function vincular(numero, comprobante) {
    try {
      const vinculos = leerVinculos();
      const previas = Array.isArray(vinculos[numero]) ? vinculos[numero] : [];
      guardarJSON(VINCULOS_PATH, { ...vinculos, [numero]: [...new Set([...previas, claveComprobante(comprobante)])] });
      return { vinculado: true };
    } catch (err) {
      console.error(`[compras-siga] vincular pedido ${numero}:`, err.message);
      return { vinculado: false, avisoVinculo: `Se grabó en SIGA pero no se pudo vincular al pedido (${err.message}). Vinculalo desde Control de compras.` };
    }
  }

  // Grabación sin confirmar: no se vincula (no se sabe si quedó) y se bloquea el reintento, que en numeración
  // automática duplicaría el comprobante.
  function marcarAVerificar(numero, clave, usuario) {
    try {
      const entrada = { numeroPedido: numero, estado: 'a_verificar', clave: clave ? claveComprobante(comprobanteDe(clave)) : null, ts: ahora().toISOString(), usuario };
      guardarJSON(ESTADO_PATH, { ...leerEstado(), [numero]: entrada });
    } catch (err) {
      console.error(`[compras-siga] marcar a verificar pedido ${numero}:`, err.message);
    }
  }

  router.get('/compras/siga', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'compras_siga.html')));

  router.get('/api/compras-siga/pedidos/:numero/borrador', async (req, res) => {
    try {
      const encontrado = pedidoYBorrador(req.params.numero);
      if (!encontrado) return res.status(404).json({ ok: false, error: `No existe el pedido ${req.params.numero}` });
      const catalogos = await repo.catalogos({ idProveedor: encontrado.base.idProveedor });
      const cabecera = desdePedido.cabeceraSugerida({ catalogos, hoyISO: fechaLocalISO(ahora()), numeroPedido: encontrado.pedido.numero });
      return res.json({ ok: true, borrador: { ...encontrado.base, ...cabecera }, catalogos });
    } catch (err) {
      return responderError(res, err, 'borrador', req.params.numero);
    }
  });

  router.post('/api/compras-siga/validar', async (req, res) => {
    try {
      const r = await evaluar(req.body);
      if (!r) return res.status(404).json({ ok: false, error: 'No existe el pedido' });
      return res.json({ ok: true, ...vista(r) });
    } catch (err) {
      return responderError(res, err, 'validar', req.body && req.body.pedido);
    }
  });

  router.post('/api/compras-siga/grabar', async (req, res) => {
    const numero = String((req.body && req.body.pedido) || '');
    if (grabando.has(numero)) return res.status(409).json({ ok: false, error: 'Ya se está grabando este pedido.' });
    grabando.add(numero);
    let filas = null;
    const usuario = usuarioCompras(req);
    try {
      const r = await evaluar(req.body);
      if (!r) return res.status(404).json({ ok: false, error: `No existe el pedido ${numero}` });
      if (r.errores.length) return res.status(400).json({ ok: false, error: 'El comprobante tiene errores.', ...vista(r) });
      // armarComprobante trunca el usuario a C.LARGO_USUARIO (10), como el grabador viejo.
      filas = armarComprobante(r.borrador, r.contexto, r.calculo, { ahora: r.momento, usuario });
      const { clave, numeroMovimiento } = await repo.grabar(filas);
      const comprobante = comprobanteDe(clave);
      return res.json({ ok: true, comprobante, numeroMovimiento, totales: r.calculo.totales, ...vincular(numero, comprobante) });
    } catch (err) {
      if (err && err.code === SIN_CONFIRMAR) {
        marcarAVerificar(numero, filas && filas.clave, usuario);
        return res.status(409).json({ ok: false, error: err.message, aVerificar: true });
      }
      return responderError(res, err, 'grabar', numero);
    } finally {
      grabando.delete(numero);
    }
  });

  return router;
};
