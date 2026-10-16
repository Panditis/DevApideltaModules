'use strict';
// Pedido de compra (data/pedidos_compra.json, ver lib/compras.js) → borrador de comprobante. Puro.
// Spec docs/superpowers/specs/2026-10-15-compras-siga-importacion-design.md, "desde_pedido.js".
const C = require('./constantes');
const { letraSugerida } = require('./lineas');
const { periodoDeFecha } = require('./fechas');

const clavePlu = v => String(v == null ? '' : v).trim();
const esNuevo = it => it.nuevo === true || /^NUEVO-/i.test(clavePlu(it.plu));
const aNumero = v => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const aTexto = v => String(v == null ? '' : v).trim();

// Spec "Cantidades": lo entregado según el seguimiento. 'entregado' usa cantidadEntregada (ya en unidades:
// con bultos lib/compras.js la guarda multiplicada) y 'extra' su cantidadEntregada. Los quiebres
// (faltante/sin_stock/no_envia) y 'pedido' no se importan.
function cantidadAImportar(it) {
  if (it.estado !== 'entregado' && it.estado !== 'extra') return 0;
  const n = Number(it.cantidadEntregada);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 'estado': el pedido no se puede importar todavía (deshabilita el botón de compras.html).
// 'dato': se arregla en SIGA o en la pantalla de importación; validarComprobante lo vuelve a bloquear al grabar.
function bloqueosDe(pedido, items, lineas, vinculado) {
  const estado = mensaje => ({ tipo: 'estado', mensaje });
  const dato = mensaje => ({ tipo: 'dato', mensaje });
  return [
    ...(pedido.estado === 'ANULADO' ? [estado('El pedido está anulado.')] : []),
    ...(vinculado ? [estado('El pedido ya está vinculado a un comprobante de SIGA.')] : []),
    ...(pedido.idProveedor == null ? [estado('El pedido no tiene el proveedor de SIGA (IdProveedor).')] : []),
    ...(items.some(it => it.estado === 'pedido') ? [estado('El pedido tiene líneas sin resolver en el seguimiento.')] : []),
    ...(lineas.length === 0 ? [estado('El pedido no tiene líneas entregadas para importar.')] : []),
    ...lineas.filter(l => l.nuevo).map(l => dato(`El artículo ${l.nombre} todavía no existe en SIGA (${l.plu}).`)),
    ...lineas.filter(l => l.precio == null).map(l => dato(`${l.nombre} no tiene precio: cargalo antes de grabar.`)),
  ];
}

function borradorDesdePedido(pedido, { vinculado = false } = {}) {
  const items = Array.isArray(pedido && pedido.items) ? pedido.items : [];
  const lineas = items.filter(it => cantidadAImportar(it) > 0).map((it, i) => ({
    orden: i + 1,
    plu: clavePlu(it.plu),
    nombre: it.nombre || clavePlu(it.plu),
    cantidad: cantidadAImportar(it),
    precio: Number(it.precioUnitario) > 0 ? Number(it.precioUnitario) : null,
    ...(esNuevo(it) ? { nuevo: true } : {}),
  }));
  const descartadas = items.filter(it => cantidadAImportar(it) === 0)
    .map(it => ({ plu: clavePlu(it.plu), nombre: it.nombre || clavePlu(it.plu), estado: it.estado }));
  return {
    numeroPedido: pedido.numero,
    idProveedor: pedido.idProveedor != null ? Number(pedido.idProveedor) : null,
    proveedor: pedido.proveedor || '',
    lineas, descartadas,
    bloqueos: bloqueosDe(pedido, items, lineas, vinculado),
  };
}

// Spec "Editable al importar": precios por línea, percepciones, forma de pago, desc./rec. general y cabecera.
// El navegador nunca define líneas, cantidades ni proveedor: salen siempre del pedido.
const NORMALIZADORES = {
  idTipoComprobante: v => aTexto(v).toUpperCase() || null,
  letra: v => aTexto(v).toUpperCase() || null,
  centroEmisor: aNumero,
  numeroComprobante: aNumero,
  fecha: v => aTexto(v) || null,
  periodoFiscal: aNumero,
  idSucursal: aNumero,
  idDeposito: aNumero,
  idUbicacion: aNumero,
  idFormasPago: aNumero,
  porcDescRecGeneral: v => aNumero(v) || 0,
  observacion: v => aTexto(v).slice(0, C.LARGO_OBSERVACION),
};

function aplicarEdicion(borrador, edicion) {
  const e = edicion || {};
  const cab = e.cabecera || {};
  const precios = e.precios && typeof e.precios === 'object' ? e.precios : {};
  const cabecera = Object.fromEntries(Object.entries(NORMALIZADORES).map(([campo, f]) => [campo, f(cab[campo])]));
  const lineas = borrador.lineas.map(l => (
    Object.prototype.hasOwnProperty.call(precios, l.plu) ? { ...l, precio: aNumero(precios[l.plu]) } : l));
  const percepciones = (Array.isArray(e.percepciones) ? e.percepciones : []).map(p => ({
    tipo: aTexto(p && p.tipo).toUpperCase(),
    importe: aNumero(p && p.importe) ?? 0,
    baseImponible: aNumero(p && p.baseImponible) ?? 0,
    alicuota: aNumero(p && p.alicuota) ?? 0,
    idProvincia: aTexto(p && p.idProvincia) || null,
  }));
  return { ...borrador, ...cabecera, lineas, percepciones };
}

// DOC Parte I §2 (CargarDatosProveedor): tipo, forma de pago y desc./rec. general por defecto del proveedor;
// §1.3 (Nuevo): fecha de hoy; §3.5: el período de la fecha si está abierto, si no el primero del combo.
// Spec: destino por defecto sucursal 1. SIGA-INFERIDO: su depósito/ubicación por defecto = la primera.
function cabeceraSugerida({ catalogos, hoyISO, numeroPedido }) {
  const prov = catalogos.proveedor || {};
  const tipos = catalogos.tipos || [];
  const tipo = tipos.find(t => t.idTipoComprobante === prov.idTipoComprobante)
    || tipos.find(t => t.idTipoComprobante === 'FACTCOM') || tipos[0] || null;
  const ubicacion = (catalogos.ubicaciones || []).find(u => u.idSucursal === C.SUCURSAL_DEFAULT) || null;
  const periodos = catalogos.periodos || [];
  const periodoHoy = periodoDeFecha(hoyISO);
  return {
    idTipoComprobante: tipo ? tipo.idTipoComprobante : null,
    letra: tipo ? letraSugerida({ letrasHabilitadas: tipo.letrasHabilitadas, letraProveedor: prov.letraFiscalCompra }) : null,
    centroEmisor: null,
    numeroComprobante: null,
    fecha: hoyISO,
    periodoFiscal: periodos.includes(periodoHoy) || !periodos.length ? periodoHoy : periodos[0],
    idSucursal: C.SUCURSAL_DEFAULT,
    idDeposito: ubicacion ? ubicacion.idDeposito : null,
    idUbicacion: ubicacion ? ubicacion.idUbicacion : null,
    idFormasPago: prov.idFormasPago || null,
    porcDescRecGeneral: Number(prov.descuentoRecargoPorc) || 0,
    observacion: `Pedido ${numeroPedido}`,
  };
}

module.exports = { borradorDesdePedido, aplicarEdicion, cabeceraSugerida };
