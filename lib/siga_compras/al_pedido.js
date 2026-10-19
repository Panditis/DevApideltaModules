'use strict';
// Parte C: al grabar en SIGA, las cantidades y precios grabados se vuelcan al seguimiento del pedido
// (data/pedidos_compra.json, estructura en lib/compras.js). Puro: devuelve un pedido NUEVO, nunca muta el recibido.
//
// Criterios:
// - Lo grabado se agrupa por PLU (en SIGA un PLU repetido es otra línea): cantidad = suma; precio = el de las líneas
//   si todas tienen el mismo, si no el promedio ponderado por cantidad redondeado a 2.
// - Excedente: lib/compras.js acota la entrega a lo pedido (entregadaSegunEstado; aplicarComparacionAPedido en
//   compras.html hace lo mismo con la factura), así que acá también: lo grabado de más no se registra como entrega
//   y queda anotado en el historial. Un 'extra' no tiene tope (no tiene "lo pedido").
// - PLU repetido en el pedido: lo grabado se reparte en orden entre sus líneas no extra, cada una hasta lo pedido;
//   lo que sobra va a la primera 'extra' de ese PLU. Una línea que se queda sin nada pasa a 'faltante' (un quiebre
//   ya declarado conserva el suyo). Todas reciben el precio grabado.
// - Quitado al importar: 'entregado' → 'faltante' con 0. Un 'extra' se borra, como el quitar de lib/compras.js:
//   como 'faltante' (lo pedido 0) contaría como incumplimiento en el OTIF. Los quiebres y 'pedido' no cambian.
// - PLU grabado que no estaba en el pedido: línea 'extra' nueva (pedido 0) con el nombre de SIGA y unidad 'UN'.
// - No toca el estado del pedido (PENDIENTE/CERRADO/ANULADO) ni fechaRetiro; el total se recalcula con totalPedido.
const { totalPedido } = require('../compras');

const ESTADOS_QUIEBRE = ['faltante', 'sin_stock', 'no_envia'];
const clavePlu = v => String(v == null ? '' : v).trim();
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const redondear = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

function agruparPorPlu(lineas) {
  const acc = new Map();
  for (const l of Array.isArray(lineas) ? lineas : []) {
    const plu = clavePlu(l && l.plu);
    const g = acc.get(plu) || { cantidad: 0, importe: 0, precios: [] };
    acc.set(plu, { cantidad: g.cantidad + num(l.cantidad), importe: g.importe + num(l.cantidad) * num(l.precio), precios: [...g.precios, num(l.precio)] });
  }
  return new Map([...acc].map(([plu, g]) => {
    const unico = g.precios.every(p => p === g.precios[0]) || g.cantidad === 0;
    const precio = unico ? g.precios[0] : redondear(g.importe / g.cantidad, 2);
    return [plu, { cantidad: redondear(g.cantidad, 3), precio: precio > 0 ? precio : null }];
  }));
}

// asignado: índice de la línea del pedido → lo grabado que le toca. restante: lo que no entró en ninguna línea.
function repartir(items, grabado) {
  const restante = new Map([...grabado].map(([plu, g]) => [plu, g.cantidad]));
  const asignado = new Map();
  const pasada = esExtra => items.forEach((it, i) => {
    const plu = clavePlu(it.plu);
    if (!restante.has(plu) || (it.estado === 'extra') !== esExtra) return;
    const queda = restante.get(plu);
    const toma = esExtra ? queda : Math.min(queda, num(it.cantidad));
    asignado.set(i, toma);
    restante.set(plu, redondear(queda - toma, 3));
  });
  pasada(false);
  pasada(true);
  return { asignado, restante };
}

// null = la línea se borra.
function lineaActualizada(it, toma, g) {
  if (!g) {
    if (it.estado === 'extra') return null;
    return it.estado === 'entregado' ? { ...it, estado: 'faltante', cantidadEntregada: 0 } : { ...it };
  }
  const precio = { precioUnitario: g.precio };
  if (it.estado === 'extra') return toma > 0 ? { ...it, ...precio, cantidadEntregada: toma } : null;
  if (toma > 0) return { ...it, ...precio, estado: 'entregado', cantidadEntregada: toma };
  return { ...it, ...precio, estado: ESTADOS_QUIEBRE.includes(it.estado) ? it.estado : 'faltante', cantidadEntregada: 0 };
}

const lineaExtraNueva = (plu, g, nombres) => ({
  plu, nombre: (nombres && nombres[plu]) || plu, unidad: 'UN', cantidad: 0,
  precioUnitario: g.precio, cantidadEntregada: g.cantidad, estado: 'extra', obs: '',
});

// "8 a $95", el estado si no hay nada entregado, o `sinLinea` si el PLU no tiene líneas.
function resumen(items, plu, sinLinea) {
  const delPlu = items.filter(it => clavePlu(it.plu) === plu);
  if (!delPlu.length) return sinLinea;
  const entregada = redondear(delPlu.filter(it => it.estado === 'entregado' || it.estado === 'extra')
    .reduce((s, it) => s + num(it.cantidadEntregada), 0), 3);
  if (entregada === 0) return delPlu[0].estado;
  const precio = delPlu[0].precioUnitario;
  return `${entregada} a ${precio == null ? 'sin precio' : `$${precio}`}`;
}

function cambiosDe(antes, despues, excedentes) {
  const plus = [...new Set([...antes, ...despues].map(it => clavePlu(it.plu)))];
  const cambios = plus.map(plu => [plu, resumen(antes, plu, 'no estaba'), resumen(despues, plu, 'quitado')])
    .filter(([, a, d]) => a !== d).map(([plu, a, d]) => `${plu}: ${a} → ${d}`);
  const notas = [...excedentes].map(([plu, q]) => `${plu}: se grabaron ${q} más de lo pedido (no se registran como entrega)`);
  return [...cambios, ...notas];
}

function aplicarGrabadoAPedido(pedido, lineasGrabadas, { clave = null, usuario = null, ts = null, nombres = {} } = {}) {
  const p = pedido || {};
  const items = Array.isArray(p.items) ? p.items : [];
  const grabado = agruparPorPlu(lineasGrabadas);
  const { asignado, restante } = repartir(items, grabado);
  const enPedido = new Set(items.map(it => clavePlu(it.plu)));
  const nuevosItems = [
    ...items.map((it, i) => lineaActualizada(it, asignado.get(i) || 0, grabado.get(clavePlu(it.plu)))).filter(Boolean),
    ...[...grabado].filter(([plu]) => !enPedido.has(plu)).map(([plu, g]) => lineaExtraNueva(plu, g, nombres)),
  ];
  const excedentes = [...restante].filter(([plu, q]) => q > 0 && enPedido.has(plu));
  return {
    ...p,
    items: nuevosItems,
    total: totalPedido(nuevosItems),
    historial: [...(Array.isArray(p.historial) ? p.historial : []), {
      ts, usuario, accion: 'importado a SIGA', comprobante: clave, cambios: cambiosDe(items, nuevosItems, excedentes),
    }],
  };
}

module.exports = { aplicarGrabadoAPedido };
