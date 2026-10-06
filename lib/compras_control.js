'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Control de compras: cruza el pedido a proveedor (compras.js) contra lo que
//  realmente se cargó en SIGA (Compras + ComprasProductos).
//  Lógica pura: sin fs, sin SQL. server.js le pasa el pedido ya leído del disco
//  y los comprobantes ya consultados; acá sólo vive la matemática del cruce.
//  Contrato del pedido: data/pedidos_compra.json → { pedidos: [...] }
// ─────────────────────────────────────────────────────────────────────────────

// Tolerancia absoluta del cruce: por debajo de esto la diferencia es redondeo de
// balanza o de decimales, no un faltante real.
const TOLERANCIA_ABS = 0.001;
const DIAS_ANTES_DEFAULT = 0;
const DIAS_DESPUES_DEFAULT = 15;

// Las notas de crédito de compra devuelven mercadería: restan de lo cargado.
const TIPOS_QUE_RESTAN = ['NCREDCOM', 'COTIZACIONNCCOM'];

function redondear(valor, decimales) {
  const factor = 10 ** decimales;
  return Math.round(valor * factor) / factor;
}

function num(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

// En SIGA los IdProducto son char con espacios: todo PLU se compara normalizado.
function clavePlu(valor) {
  return String(valor == null ? '' : valor).trim();
}

function signoDe(tipoComprobante) {
  return TIPOS_QUE_RESTAN.includes(String(tipoComprobante || '').trim().toUpperCase()) ? -1 : 1;
}

// Identidad del comprobante en SIGA: la PK de Compras, en una sola cadena.
function claveComprobante(c) {
  const p = c || {};
  return [p.idSucursal, p.tipoComprobante, p.letra, p.centroEmisor, p.numeroComprobante]
    .map(v => String(v == null ? '' : v).trim()).join('|');
}

function etiquetaComprobante(c) {
  const p = c || {};
  return `${p.tipoComprobante || ''} ${p.letra || ''} ${p.centroEmisor || ''}-${p.numeroComprobante || ''}`.trim();
}

// ── Ventana de búsqueda ──────────────────────────────────────────────────────
// Fechas 'YYYY-MM-DD' en UTC: con hora local, un huso al oeste de Greenwich corre
// la fecha un día para atrás al serializarla.
function aFechaUTC(fechaISO) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fechaISO || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function sumarDias(fechaISO, dias) {
  const d = aFechaUTC(fechaISO);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + (Number(dias) || 0));
  return d.toISOString().slice(0, 10);
}

// La factura puede entrar el día del retiro o bastante después. El piso es la
// fecha del pedido; el techo, el retiro (o el pedido si todavía no hay retiro)
// más un margen.
function ventanaDe(pedido, { diasAntes = DIAS_ANTES_DEFAULT, diasDespues = DIAS_DESPUES_DEFAULT } = {}) {
  const p = pedido || {};
  const base = p.fecha || null;
  if (!base) return { desde: null, hasta: null };
  return {
    desde: sumarDias(base, -Math.abs(Number(diasAntes) || 0)),
    hasta: sumarDias(p.fechaRetiro || base, Math.abs(Number(diasDespues) || 0)),
  };
}

// ── Candidatos ───────────────────────────────────────────────────────────────
function plusDe(pedido) {
  return new Set((Array.isArray(pedido && pedido.items) ? pedido.items : []).map(l => clavePlu(l.plu)));
}

function mismoProveedor(pedido, comprobante) {
  const idPedido = pedido && pedido.idProveedor;
  const idComp = comprobante && comprobante.idProveedor;
  // El id manda; el nombre es el respaldo para pedidos cargados sin idProveedor.
  if (idPedido != null && idComp != null) return Number(idPedido) === Number(idComp);
  return String((pedido && pedido.proveedor) || '').trim().toUpperCase()
      === String((comprobante && comprobante.proveedor) || '').trim().toUpperCase();
}

// Ordena los comprobantes del proveedor dentro de la ventana por cuántos PLUs del
// pedido traen. `sugerido` marca los que comparten al menos un PLU: son los que la
// pantalla propone tildar. El usuario confirma — nunca se vincula solo.
function candidatosDeCompra(pedido, comprobantes, opciones = {}) {
  const { desde, hasta } = ventanaDe(pedido, opciones);
  const plusPedido = plusDe(pedido);
  return (Array.isArray(comprobantes) ? comprobantes : [])
    .filter(c => c && mismoProveedor(pedido, c))
    .filter(c => (!desde || String(c.fecha || '') >= desde) && (!hasta || String(c.fecha || '') <= hasta))
    .map(c => {
      const plusComp = new Set((Array.isArray(c.items) ? c.items : []).map(l => clavePlu(l.plu)));
      let coincidentes = 0;
      for (const plu of plusComp) if (plusPedido.has(plu)) coincidentes += 1;
      return {
        idSucursal: c.idSucursal, tipoComprobante: c.tipoComprobante, letra: c.letra,
        centroEmisor: c.centroEmisor, numeroComprobante: c.numeroComprobante,
        clave: claveComprobante(c), etiqueta: etiquetaComprobante(c),
        fecha: c.fecha || null,
        proveedor: c.proveedor || null,
        idProveedor: c.idProveedor != null ? c.idProveedor : null,
        importeTotal: c.importeTotal != null ? num(c.importeTotal) : null,
        lineas: Array.isArray(c.items) ? c.items.length : 0,
        // Para la vista previa de la pantalla: el detalle línea a línea de este
        // comprobante puntual, tal cual vino de SIGA (plu/nombre/cantidad/importe).
        items: Array.isArray(c.items) ? c.items : [],
        pluCoincidentes: coincidentes,
        pluPedido: plusPedido.size,
        sugerido: coincidentes > 0,
      };
    })
    .sort((a, b) => b.pluCoincidentes - a.pluCoincidentes || String(a.fecha).localeCompare(String(b.fecha)));
}

// ── Cruce ────────────────────────────────────────────────────────────────────
// Suma las líneas de todos los comprobantes por PLU: un mismo producto puede venir
// en varias líneas de la misma factura (distinto precio) y en varias facturas.
function agruparCargado(comprobantes) {
  const acc = new Map();
  for (const c of (Array.isArray(comprobantes) ? comprobantes : [])) {
    const signo = signoDe(c && c.tipoComprobante);
    for (const l of (Array.isArray(c && c.items) ? c.items : [])) {
      const plu = clavePlu(l && l.plu);
      if (!plu) continue;
      if (!acc.has(plu)) {
        acc.set(plu, { plu, nombre: (l && l.nombre) || plu, cantidad: 0, importe: 0, lineas: 0, comprobantes: new Set() });
      }
      const a = acc.get(plu);
      a.cantidad += signo * num(l.cantidad);
      a.importe += signo * num(l.importe);
      a.lineas += 1;
      a.comprobantes.add(claveComprobante(c));
    }
  }
  return acc;
}

// La cantidad contra la que se compara lo cargado. cantidadEntregada null es "no
// declarada" (compras.js la deja así hasta que alguien toca la línea): ahí la
// referencia es lo pedido. Un quiebre declarado (faltante, o sin_stock/no_envia
// en pedidos viejos) vale 0, así que si no se cargó nada la línea cierra bien.
function referenciaDe(linea) {
  return linea.cantidadEntregada == null ? num(linea.cantidad) : num(linea.cantidadEntregada);
}

function estadoFila({ enPedido, referencia, cargado, tolerancia }) {
  const dif = cargado - referencia;
  if (!enPedido) return cargado === 0 ? 'ok' : 'no_pedido';
  if (Math.abs(dif) <= tolerancia) return 'ok';
  if (cargado === 0) return 'sin_cargar';
  return dif < 0 ? 'faltante' : 'excedente';
}

function toleranciaDe(referencia, toleranciaPct) {
  const pct = Number(toleranciaPct);
  const relativa = Number.isFinite(pct) && pct > 0 ? Math.abs(referencia) * pct / 100 : 0;
  return Math.max(TOLERANCIA_ABS, relativa);
}

function filaDePedido(linea, cargadoPorPlu, toleranciaPct) {
  const plu = clavePlu(linea.plu);
  const cargado = cargadoPorPlu.get(plu);
  const cantCargada = cargado ? redondear(cargado.cantidad, 3) : 0;
  const importe = cargado ? redondear(cargado.importe, 2) : 0;
  const referencia = referenciaDe(linea);
  return {
    plu,
    nombre: linea.nombre || (cargado && cargado.nombre) || plu,
    unidad: linea.unidad || '',
    enPedido: true,
    estadoLinea: linea.estado || 'pedido',
    obs: linea.obs || '',
    pedido: redondear(num(linea.cantidad), 3),
    entregado: linea.cantidadEntregada == null ? null : redondear(num(linea.cantidadEntregada), 3),
    cargado: cantCargada,
    referencia: redondear(referencia, 3),
    difCargadoPedido: redondear(cantCargada - num(linea.cantidad), 3),
    difCargadoEntregado: linea.cantidadEntregada == null ? null : redondear(cantCargada - num(linea.cantidadEntregada), 3),
    importe,
    precioUnitario: cantCargada ? redondear(importe / cantCargada, 4) : null,
    // Lo pedido que no llegó, valuado al precio de esta compra. Sin precio no se
    // estima: un faltante sin referencia de precio vale null, no 0.
    importeFaltante: null,
    comprobantes: cargado ? [...cargado.comprobantes] : [],
    estado: estadoFila({ enPedido: true, referencia, cargado: cantCargada, tolerancia: toleranciaDe(referencia, toleranciaPct) }),
  };
}

// Producto que vino en la factura y no estaba en el pedido.
function filaExtra(cargado) {
  const cantidad = redondear(cargado.cantidad, 3);
  const importe = redondear(cargado.importe, 2);
  return {
    plu: cargado.plu, nombre: cargado.nombre, unidad: '',
    enPedido: false, estadoLinea: null, obs: '',
    pedido: 0, entregado: null, cargado: cantidad, referencia: 0,
    difCargadoPedido: cantidad, difCargadoEntregado: null,
    importe, precioUnitario: cantidad ? redondear(importe / cantidad, 4) : null,
    importeFaltante: null,
    comprobantes: [...cargado.comprobantes],
    estado: estadoFila({ enPedido: false, referencia: 0, cargado: cantidad, tolerancia: TOLERANCIA_ABS }),
  };
}

const ESTADOS_DIFERENCIA = ['faltante', 'excedente', 'sin_cargar', 'no_pedido'];

function resumenDe(filas) {
  let pedidoTotal = 0, entregadoTotal = 0, cargadoTotal = 0, importeTotal = 0, importeFaltante = 0;
  const conteo = { ok: 0, faltante: 0, excedente: 0, sin_cargar: 0, no_pedido: 0 };
  for (const f of filas) {
    pedidoTotal += f.pedido;
    if (f.entregado != null) entregadoTotal += f.entregado;
    cargadoTotal += f.cargado;
    importeTotal += f.importe;
    if (f.importeFaltante != null) importeFaltante += f.importeFaltante;
    conteo[f.estado] = (conteo[f.estado] || 0) + 1;
  }
  // Cumplimiento por cantidad: un excedente de un producto no compensa el faltante
  // de otro, así que cada línea aporta como mucho lo que se pidió.
  const cumplido = filas.reduce((s, f) => s + Math.min(f.cargado, f.pedido), 0);
  return {
    lineas: filas.length,
    lineasOk: conteo.ok,
    lineasConDiferencia: ESTADOS_DIFERENCIA.reduce((s, e) => s + (conteo[e] || 0), 0),
    ...conteo,
    cantidadPedida: redondear(pedidoTotal, 3),
    cantidadEntregada: redondear(entregadoTotal, 3),
    cantidadCargada: redondear(cargadoTotal, 3),
    cumplimientoPct: pedidoTotal > 0 ? redondear(100 * cumplido / pedidoTotal, 1) : null,
    importeCargado: redondear(importeTotal, 2),
    importeFaltante: redondear(importeFaltante, 2),
  };
}

// Cruce completo de un pedido contra los comprobantes vinculados. Devuelve
// estructuras nuevas: nunca muta el pedido ni los comprobantes recibidos.
function compararPedido(pedido, comprobantes, { toleranciaPct = 0 } = {}) {
  const p = pedido || {};
  const cargadoPorPlu = agruparCargado(comprobantes);
  const items = Array.isArray(p.items) ? p.items : [];
  const filas = items.map(l => filaDePedido(l, cargadoPorPlu, toleranciaPct));

  const enPedido = new Set(filas.map(f => f.plu));
  for (const [plu, cargado] of cargadoPorPlu) {
    if (!enPedido.has(plu)) filas.push(filaExtra(cargado));
  }

  for (const f of filas) {
    if (f.estado === 'faltante' && f.precioUnitario != null) {
      f.importeFaltante = redondear((f.referencia - f.cargado) * f.precioUnitario, 2);
    }
  }

  // Las diferencias primero: la pantalla es para revisarlas, no para leer los OK.
  filas.sort((a, b) => Number(b.estado !== 'ok') - Number(a.estado !== 'ok')
    || String(a.nombre).localeCompare(String(b.nombre)));

  return {
    numero: p.numero || null,
    proveedor: p.proveedor || null,
    idProveedor: p.idProveedor != null ? p.idProveedor : null,
    fecha: p.fecha || null,
    fechaRetiro: p.fechaRetiro || null,
    estado: p.estado || null,
    comprobantes: (Array.isArray(comprobantes) ? comprobantes : []).map(c => ({
      clave: claveComprobante(c), etiqueta: etiquetaComprobante(c), fecha: (c && c.fecha) || null,
      importeTotal: c && c.importeTotal != null ? num(c.importeTotal) : null,
      signo: signoDe(c && c.tipoComprobante),
    })),
    filas,
    resumen: resumenDe(filas),
  };
}

module.exports = {
  TOLERANCIA_ABS, DIAS_ANTES_DEFAULT, DIAS_DESPUES_DEFAULT, TIPOS_QUE_RESTAN,
  claveComprobante, etiquetaComprobante, signoDe,
  ventanaDe, candidatosDeCompra, compararPedido,
};
