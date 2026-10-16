'use strict';
const express = require('express');
const fs = require('fs');
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
const RESULTADOS_VERIFICACION = ['cargado', 'no_cargado'];
const MENSAJE_A_VERIFICAR = 'El pedido tiene una grabación sin confirmar: verificá en SiGA si el comprobante quedó cargado antes de reintentar.';
const MENSAJE_SIN_SESION = 'Tenés que iniciar sesión para grabar en SIGA.';
const MENSAJE_DESHABILITADA = 'La grabación en SIGA está deshabilitada en este servidor (COMPRAS_SIGA_GRABAR).';
const MENSAJE_INTERNO = 'Error interno al procesar el comprobante para SIGA. Avisá a sistemas (el detalle quedó en el log del servidor).';

// Mismo criterio de sesión que el middleware de auth de server.js.
const conSesion = req => !!(req.session && req.session.user);

const esErrorSiga = err => !!err && (err.name === 'ErrorSiga' || err.code === 'SIGA_CONFIG' || err.code === SIN_CONFIRMAR);

// Los dos json de este router (vínculos y marcas) se leen ESTRICTO: ausente → {}; existe pero no parsea → error.
// leerJSON de server.js devolvería {} y la siguiente escritura borraría todos los vínculos o marcas.
const archivoIlegible = ruta => Object.assign(
  new Error(`${path.basename(ruta)} ilegible: no se graba para no perder vínculos.`), { code: 'ARCHIVO_ILEGIBLE' });

function leerMapa(ruta) {
  let texto;
  try {
    texto = fs.readFileSync(ruta, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw Object.assign(archivoIlegible(ruta), { causa: err.message });
  }
  let datos = null;
  try { datos = JSON.parse(texto.replace(/^﻿/, '')); } catch (_) { /* queda null → ilegible */ }
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw archivoIlegible(ruta);
  return datos;
}

// Escritura atómica: .tmp en el mismo directorio + rename; un corte a mitad nunca deja el json truncado.
function guardarMapa(ruta, datos) {
  const tmp = `${ruta}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(datos, null, 2), 'utf8');
    fs.renameSync(tmp, ruta);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* puede no existir */ }
    throw err;
  }
}

const comprobanteDe = clave => ({
  idSucursal: clave.IdSucursal, tipoComprobante: clave.IdTipoComprobante, letra: clave.Letra,
  centroEmisor: clave.CentroEmisor, numeroComprobante: clave.NumeroComprobante, idProveedor: clave.IdProveedor,
});

module.exports = function crearRutasComprasSiga(deps) {
  const { DATA_DIR, leerPedidosCompra, usuarioCompras, repo } = deps;
  const ahora = deps.ahora || (() => new Date());
  // Bandera por servidor (COMPRAS_SIGA_GRABAR, ver server.js): sin ella borrador y validar quedan como vista previa.
  const grabacionHabilitada = deps.grabacionHabilitada === true;
  const router = express.Router();

  // Mismo archivo que el Control de compras (routes/rutas_compras_control.js): pedido → claves de comprobante.
  const VINCULOS_PATH = path.join(DATA_DIR, 'pedidos_comprobantes.json');
  // Pedidos con una grabación que hizo COMMIT pero no se pudo confirmar: { [numeroPedido]: { estado: 'a_verificar', … } }.
  const ESTADO_PATH = path.join(DATA_DIR, 'compras_siga_estado.json');
  const leerVinculos = () => leerMapa(VINCULOS_PATH);
  const leerEstado = () => leerMapa(ESTADO_PATH);
  // ponytail: lock en memoria por pedido contra el doble clic; alcanza con un solo proceso Node.
  const grabando = new Set();

  function responderError(res, err, donde, numero) {
    if (esErrorSiga(err)) return res.status(err.code === SIN_CONFIRMAR ? 409 : 422).json({ ok: false, error: err.message });
    if (err && err.code === 'ARCHIVO_ILEGIBLE') {
      console.error(`[compras-siga] ${donde} pedido ${numero}: ${err.message}`, err.causa || '');
      return res.status(500).json({ ok: false, error: err.message });
    }
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
      pedido, aVerificar,
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
    discrimina: calculo.discrimina, incluyeIVA: calculo.incluyeIVA, errores,
  });

  function guardarVinculo(numero, clave) {
    const vinculos = leerVinculos();
    const previas = Array.isArray(vinculos[numero]) ? vinculos[numero] : [];
    guardarMapa(VINCULOS_PATH, { ...vinculos, [numero]: [...new Set([...previas, clave])] });
  }

  // Estado del pedido: campos actuales arriba y la traza completa en historial (nunca se borra).
  function registrarEstado(numero, cambios, evento) {
    const estado = leerEstado();
    const previa = estado[numero] || {};
    guardarMapa(ESTADO_PATH, {
      ...estado,
      [numero]: { ...previa, numeroPedido: numero, ...cambios, historial: [...(previa.historial || []), evento] },
    });
  }

  // Pedido "a verificar": bloquea borrador/validar/grabar hasta liberar-verificacion. Motivos: 'sin_confirmar'
  // (no se sabe si quedó en SIGA) y 'vinculo' (quedó, pero no se pudo vincular): en los dos un reintento duplicaría
  // el comprobante en numeración automática.
  function marcarAVerificar(numero, { motivo, clave, usuario }) {
    const ts = ahora().toISOString();
    try {
      registrarEstado(numero, { estado: 'a_verificar', motivo, clave, ts, usuario }, { evento: 'a_verificar', motivo, clave, usuario, ts });
    } catch (err) {
      console.error(`[compras-siga] no se pudo marcar a verificar el pedido ${numero} (comprobante ${clave}):`, err.message);
    }
  }

  // El comprobante ya está en SIGA: si falla el disco no se revierte nada; se avisa y el pedido queda a verificar.
  function vincular(numero, comprobante, usuario) {
    const clave = claveComprobante(comprobante);
    try {
      guardarVinculo(numero, clave);
      return { vinculado: true };
    } catch (err) {
      console.error(`[compras-siga] vincular pedido ${numero} (comprobante ${clave}):`, err.message);
      marcarAVerificar(numero, { motivo: 'vinculo', clave, usuario });
      return { vinculado: false, avisoVinculo: 'Se grabó en SIGA pero no se pudo vincular al pedido. Vinculalo desde Control de compras.' };
    }
  }

  router.get('/compras/siga', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'compras_siga.html')));

  router.get('/api/compras-siga/pedidos/:numero/borrador', async (req, res) => {
    try {
      const encontrado = pedidoYBorrador(req.params.numero);
      if (!encontrado) return res.status(404).json({ ok: false, error: 'No existe el pedido.' });
      const catalogos = await repo.catalogos({ idProveedor: encontrado.base.idProveedor });
      const cabecera = desdePedido.cabeceraSugerida({ catalogos, hoyISO: fechaLocalISO(ahora()), numeroPedido: encontrado.pedido.numero });
      // aVerificar: la pantalla muestra el panel de liberar-verificacion en vez de dejar reintentar.
      return res.json({ ok: true, borrador: { ...encontrado.base, ...cabecera }, catalogos, aVerificar: encontrado.aVerificar, grabacionHabilitada });
    } catch (err) {
      return responderError(res, err, 'borrador', req.params.numero);
    }
  });

  router.post('/api/compras-siga/validar', async (req, res) => {
    try {
      const r = await evaluar(req.body);
      if (!r) return res.status(404).json({ ok: false, error: 'No existe el pedido.' });
      return res.json({ ok: true, ...vista(r) });
    } catch (err) {
      return responderError(res, err, 'validar', req.body && req.body.pedido);
    }
  });

  router.post('/api/compras-siga/grabar', async (req, res) => {
    if (!conSesion(req)) return res.status(401).json({ ok: false, error: MENSAJE_SIN_SESION });
    if (!grabacionHabilitada) return res.status(403).json({ ok: false, error: MENSAJE_DESHABILITADA });
    const numero = String((req.body && req.body.pedido) || '');
    if (grabando.has(numero)) return res.status(409).json({ ok: false, error: 'Ya se está grabando este pedido.' });
    grabando.add(numero);
    let filas = null;
    const usuario = usuarioCompras(req);
    try {
      const r = await evaluar(req.body);
      if (!r) return res.status(404).json({ ok: false, error: 'No existe el pedido.' });
      if (r.errores.length) return res.status(400).json({ ok: false, error: 'El comprobante tiene errores.', ...vista(r) });
      // armarComprobante trunca el usuario a C.LARGO_USUARIO (10), como el grabador viejo.
      filas = armarComprobante(r.borrador, r.contexto, r.calculo, { ahora: r.momento, usuario });
      const { clave, numeroMovimiento } = await repo.grabar(filas);
      const comprobante = comprobanteDe(clave);
      return res.json({ ok: true, comprobante, numeroMovimiento, totales: r.calculo.totales, ...vincular(numero, comprobante, usuario) });
    } catch (err) {
      if (err && err.code === SIN_CONFIRMAR) {
        // grabar.js adjunta la clave definitiva; la de filas tiene número 0 en numeración automática.
        const clave = err.clave || (filas && filas.clave);
        marcarAVerificar(numero, { motivo: 'sin_confirmar', clave: clave ? claveComprobante(comprobanteDe(clave)) : null, usuario });
        return res.status(409).json({ ok: false, error: err.message, aVerificar: true });
      }
      return responderError(res, err, 'grabar', numero);
    } finally {
      grabando.delete(numero);
    }
  });

  // Después de mirar en SiGA: 'cargado' vincula la clave guardada en la marca; 'no_cargado' solo libera.
  router.post('/api/compras-siga/pedidos/:numero/liberar-verificacion', (req, res) => {
    if (!conSesion(req)) return res.status(401).json({ ok: false, error: MENSAJE_SIN_SESION });
    const numero = req.params.numero;
    const resultado = req.body && req.body.resultado;
    if (!RESULTADOS_VERIFICACION.includes(resultado)) {
      return res.status(400).json({ ok: false, error: "El resultado tiene que ser 'cargado' o 'no_cargado'." });
    }
    try {
      const marca = leerEstado()[numero];
      if (!marca || marca.estado !== 'a_verificar') {
        return res.status(404).json({ ok: false, error: 'El pedido no tiene una grabación a verificar.' });
      }
      if (resultado === 'cargado') {
        try {
          if (!marca.clave) throw new Error('la marca no tiene la clave del comprobante');
          guardarVinculo(numero, marca.clave);
        } catch (err) {
          console.error(`[compras-siga] liberar-verificacion pedido ${numero} (comprobante ${marca.clave}):`, err.message);
          return res.status(500).json({
            ok: false, error: `No se pudo vincular el comprobante ${marca.clave} al pedido ${numero}. La marca sigue: reintentá o vinculalo desde Control de compras.`,
          });
        }
      }
      const usuario = usuarioCompras(req);
      const ts = ahora().toISOString();
      registrarEstado(numero, { estado: 'liberado', resultado, usuario, ts }, { evento: 'liberado', resultado, usuario, ts });
      return res.json({ ok: true, numeroPedido: numero, resultado, vinculado: resultado === 'cargado' });
    } catch (err) {
      return responderError(res, err, 'liberar-verificacion', numero);
    }
  });

  return router;
};
