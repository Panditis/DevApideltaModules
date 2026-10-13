'use strict';
// Lógica pura del módulo de Compras: armar pedido → seguimiento → dashboard OTIF.
// Sin fs, sin SQL y sin require: server.js inyecta reloj, usuario, disco y datos.

const DIAS_POR_MES = 30.44;

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

function normalizarPorPlu(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[clavePlu(k)] = v;
  return out;
}

// ── Pesables ─────────────────────────────────────────────────────────────────
// Se compra el granel, se vende fraccionado. cantFormula = kg de granel por
// unidad de esa presentación; sin multiplicador válido se asume 1.
function fraccionadosDe(formulas, plu) {
  const granel = clavePlu(plu);
  const out = [];
  for (const [pluFrac, f] of Object.entries(formulas || {})) {
    if (!f || clavePlu(f.granel) !== granel) continue;
    const mult = Number(f.cantFormula);
    out.push({ plu: clavePlu(pluFrac), cantFormula: Number.isFinite(mult) && mult > 0 ? mult : 1 });
  }
  return out;
}

// Las partes de un producto: el propio PLU (×1) más sus fraccionados (×cantFormula).
function partesEquivalentes(plu, fraccionados) {
  const frac = (Array.isArray(fraccionados) ? fraccionados : []).map(f => ({
    plu: clavePlu(f && f.plu),
    cantFormula: Number(f && f.cantFormula) > 0 ? Number(f.cantFormula) : 1,
  }));
  return [{ plu: clavePlu(plu), cantFormula: 1 }, ...frac];
}

function stockSucursalesEq(plu, fraccionados, stockPorSuc) {
  const stock = normalizarPorPlu(stockPorSuc);
  const porSucursal = {};
  for (const parte of partesEquivalentes(plu, fraccionados)) {
    for (const [suc, cant] of Object.entries(stock[parte.plu] || {})) {
      porSucursal[suc] = (porSucursal[suc] || 0) + num(cant) * parte.cantFormula;
    }
  }
  let total = 0;
  for (const suc of Object.keys(porSucursal)) {
    total += porSucursal[suc];
    porSucursal[suc] = redondear(porSucursal[suc], 3);
  }
  return { total: redondear(total, 3), porSucursal };
}

// El desglose detrás de stockSucursalesEq: qué PLU aporta cada parte del total.
// stockSucursales es el stock crudo del PLU (sin convertir) y aporteSucursales lo
// que ese PLU suma a la fila; la suma de los aportes es el total de stockSucursalesEq.
function componentesStockEq(plu, fraccionados, stockPorSuc) {
  const stock = normalizarPorPlu(stockPorSuc);
  return partesEquivalentes(plu, fraccionados).map((parte, i) => {
    const porSucursal = {};
    let crudo = 0;
    for (const [suc, cant] of Object.entries(stock[parte.plu] || {})) {
      porSucursal[suc] = redondear(num(cant), 3);
      crudo += num(cant);
    }
    return {
      plu: parte.plu,
      cantFormula: parte.cantFormula,
      esPropio: i === 0,
      stockSucursales: redondear(crudo, 3),
      porSucursal,
      aporteSucursales: redondear(crudo * parte.cantFormula, 3),
    };
  });
}

function ventasEq(plu, fraccionados, ventasPorPlu) {
  const ventas = normalizarPorPlu(ventasPorPlu);
  const total = partesEquivalentes(plu, fraccionados)
    .reduce((s, parte) => s + num(ventas[parte.plu]) * parte.cantFormula, 0);
  return redondear(total, 3);
}

// ── Métricas de fila ─────────────────────────────────────────────────────────
// Promedio diario sobre los `meses` meses CERRADOS previos a hoyISO: el mes en
// curso está parcial y hundiría el promedio. Un mes sin dato cuenta 0, no se
// saltea, así el divisor siempre es `meses`.
function demandaDiaria(serieMensual, { hoyISO, meses = 3 } = {}) {
  const m = /^(\d{4})-(\d{2})/.exec(String(hoyISO || ''));
  if (!m) return null;
  const cantMeses = Number(meses) > 0 ? Math.floor(Number(meses)) : 3;
  const indiceHoy = Number(m[1]) * 12 + (Number(m[2]) - 1);
  const porMes = new Map();
  for (const fila of (Array.isArray(serieMensual) ? serieMensual : [])) {
    if (fila && fila.mes) porMes.set(String(fila.mes), num(fila.total));
  }
  let suma = 0;
  for (let i = 1; i <= cantMeses; i++) {
    const idx = indiceHoy - i;
    const etiqueta = `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
    suma += porMes.get(etiqueta) || 0;
  }
  if (suma <= 0) return null;
  return redondear(suma / (cantMeses * DIAS_POR_MES), 4);
}

// null = cobertura infinita (sin demanda), la UI lo muestra como "∞".
function coberturaDias(stock, demandaDiaria) {
  const d = Number(demandaDiaria);
  if (!Number.isFinite(d) || d <= 0) return null;
  return redondear(num(stock) / d, 1);
}

// ── Fechas ───────────────────────────────────────────────────────────────────
// Fechas 'YYYY-MM-DD' y aritmética en UTC: con hora local, un huso al oeste de
// Greenwich corre la fecha un día para atrás al serializarla.
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

function diasEntre(aISO, bISO) {
  const a = aFechaUTC(aISO);
  const b = aFechaUTC(bISO);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// ── Pedidos ──────────────────────────────────────────────────────────────────
const ESTADOS_PEDIDO = ['PENDIENTE', 'CERRADO', 'ANULADO'];
// Estados que declaran que el proveedor no entregó: la entrega vale 0. 'faltante'
// es el actual; sin_stock/no_envia siguen siendo válidos por los pedidos viejos.
const ESTADOS_QUIEBRE = ['sin_stock', 'no_envia', 'faltante'];
// 'extra' no es un estado que el usuario elija a mano (no está en el <select> del
// front): lo pone aplicarLineas cuando la factura trae un producto que no estaba
// en el pedido. Cuenta 0 para lo pedido — ver lineasDe() para el resto del OTIF.
const ESTADOS_LINEA = ['pedido', 'entregado', 'sin_stock', 'no_envia', 'faltante', 'extra'];

// Correlativo global: un pedido anulado no libera su número.
function siguienteNumero(pedidos) {
  let max = 0;
  for (const p of (Array.isArray(pedidos) ? pedidos : [])) {
    const m = /^P-(\d+)$/.exec(String((p && p.numero) == null ? '' : p.numero).trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(4, '0')}`;
}

// Cómo viene empaquetado un producto para el proveedor (caja de 12, bolsa de 25…).
// Se guarda por PLU y habilita pedir por bultos: el pedido sigue midiendo la
// cantidad en la unidad del producto, los bultos son sólo cómo se lo pide.
function normalizarPresentacion(p) {
  const unidadesPorBulto = Number(p && p.unidadesPorBulto);
  if (p == null || p.unidadesPorBulto == null || !Number.isFinite(unidadesPorBulto) || unidadesPorBulto <= 0) {
    throw new Error('Las unidades por bulto tienen que ser un número mayor a cero');
  }
  return { nombre: String((p && p.nombre) || '').trim() || 'Caja', unidadesPorBulto };
}

// Una línea pedida por bultos: la cantidad se recalcula acá desde los bultos,
// así no puede quedar desalineada con lo que dice la hoja del proveedor.
function lineaEnBultos(it) {
  const bultos = Number(it.bultos);
  if (!Number.isFinite(bultos) || bultos <= 0) throw new Error(`Bultos inválidos en el PLU ${clavePlu(it.plu)}`);
  const presentacion = normalizarPresentacion(it.presentacion);
  return { cantidad: redondear(bultos * presentacion.unidadesPorBulto, 3), bultos, presentacion };
}

function construirPedido({ numero, fechaISO, proveedor, idProveedor = null, usuario = null, items, ts = null } = {}) {
  const lista = Array.isArray(items) ? items : [];
  if (!lista.length) throw new Error('El pedido no tiene items');
  if (!String(proveedor || '').trim()) throw new Error('Falta el proveedor');
  const detalle = lista.map(it => {
    const enBultos = it && it.bultos != null ? lineaEnBultos(it) : null;
    const cantidad = enBultos ? enBultos.cantidad : Number(it && it.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      throw new Error(`Cantidad inválida en el PLU ${clavePlu(it && it.plu)}`);
    }
    // Precio del momento de armar el pedido (último precio de compra): es sólo un
    // estimado para reconocer la orden en el listado, no lo que termina pactado
    // con el proveedor — por eso "Sin precios ni total" en la hoja que él ve.
    const precioNum = Number(it && it.precio);
    const precioUnitario = Number.isFinite(precioNum) && precioNum > 0 ? precioNum : null;
    return {
      plu: clavePlu(it.plu),
      nombre: it.nombre || clavePlu(it.plu),
      unidad: it.unidad || '',
      cantidad,
      precioUnitario,
      cantidadEntregada: null,
      estado: 'pedido',
      obs: '',
      // Sólo las líneas pedidas por bultos llevan estos campos: los pedidos viejos no cambian de forma.
      ...(enBultos ? { bultos: enBultos.bultos, presentacion: enBultos.presentacion } : {}),
      // Artículo que todavía no existe en SIGA: su plu es sintético (NUEVO-…) y no
      // hay que mandarlo a SQL ni esperar que matchee un PLU de factura.
      ...(it.nuevo === true ? { nuevo: true } : {}),
    };
  });
  return {
    numero, idProveedor, proveedor, fecha: fechaISO, usuario, estado: 'PENDIENTE',
    fechaEstimada: null, fechaRetiro: null, observacion: '', items: detalle, total: totalPedido(detalle),
    historial: [{ ts, usuario, accion: 'creado' }],
  };
}

// Total estimado del pedido: null si ninguna línea tiene precio. Los extras
// suman 0 (su cantidad pedida es 0).
function totalPedido(items) {
  if (!items.some(d => d.precioUnitario != null)) return null;
  return redondear(items.reduce((s, d) => s + d.cantidad * (d.precioUnitario || 0), 0), 2);
}

// Mismas reglas que construirPedido: la cantidad pedida tiene que ser > 0 y el
// precio vacío o 0 queda como "sin precio" (null).
function cantidadEditada(valor, plu) {
  const cantidad = Number(valor);
  if (!Number.isFinite(cantidad) || cantidad <= 0) throw new Error(`Cantidad inválida en el PLU ${clavePlu(plu)}`);
  return cantidad;
}

function precioEditado(valor, plu) {
  if (valor == null || valor === '') return null;
  const precio = Number(valor);
  if (!Number.isFinite(precio) || precio < 0) throw new Error(`Precio inválido en el PLU ${clavePlu(plu)}`);
  return precio > 0 ? precio : null;
}

// Con el pedido PENDIENTE todavía se puede corregir lo pedido y el precio. Si la
// línea iba por bultos y la cantidad nueva no da bultos enteros, deja de ir por
// bultos. Lo ya entregado se acota a lo pedido nuevo (bajar lo pedido por debajo
// de lo entregado no puede dejar la línea entregada de más).
function editarLinea(linea, parche) {
  const precio = parche.precioUnitario !== undefined
    ? { precioUnitario: precioEditado(parche.precioUnitario, linea.plu) } : {};
  if (parche.cantidad === undefined || linea.estado === 'extra') return { ...linea, ...precio };
  const cantidad = cantidadEditada(parche.cantidad, linea.plu);
  const { bultos, presentacion, ...resto } = linea;
  const porBulto = presentacion ? Number(presentacion.unidadesPorBulto) : NaN;
  const nuevosBultos = bultos != null && porBulto > 0 ? redondear(cantidad / porBulto, 3) : NaN;
  const enBultos = Number.isInteger(nuevosBultos) && nuevosBultos > 0 ? { bultos: nuevosBultos, presentacion } : {};
  const cantidadEntregada = linea.cantidadEntregada == null
    ? linea.cantidadEntregada : Math.min(num(linea.cantidadEntregada), cantidad);
  return { ...resto, ...precio, cantidad, cantidadEntregada, ...enBultos };
}

// La cantidad entregada la dicta el estado de la línea: entregado sin cantidad
// se asume completo, un quiebre es cero y volver a 'pedido' la borra. Pero eso
// vale al marcar el estado, no en cada toque: un parche que sólo corrige la obs
// no puede convertir una entrega parcial ya cargada en completa.
// null y '' cuentan como cantidad no declarada — es el valor con el que la línea
// nace, y el front reenvía el objeto entero.
function entregadaSegunEstado(estado, parche, linea) {
  if (parche.estado == null && parche.cantidadEntregada === undefined) {
    return linea.cantidadEntregada == null ? null : linea.cantidadEntregada;
  }
  if (estado === 'pedido') return null;
  if (ESTADOS_QUIEBRE.includes(estado)) return 0;
  const cruda = parche.cantidadEntregada;
  const declarada = cruda == null || cruda === '' ? NaN : Number(cruda);
  // Un extra no tiene "lo pedido" (cantidad siempre 0) contra qué acotar: acotarla
  // ahí la dejaría siempre en 0. Sin cantidad declarada, se mantiene la que tenía.
  if (estado === 'extra') return Number.isFinite(declarada) ? Math.max(0, declarada) : num(linea.cantidadEntregada);
  if (!Number.isFinite(declarada)) return num(linea.cantidad);
  // Acotada al rango de la línea: el front ya lo hace, pero un PUT directo con
  // una cantidad negativa restaría del acumulado y ensuciaría el OTIF.
  return Math.max(0, Math.min(declarada, num(linea.cantidad)));
}

// Línea nueva para un producto que vino en la factura sin estar en el pedido
// original: lo pedido es 0 por definición (nunca se pidió), lo entregado es lo
// que trajo la factura. Ver aplicarComparacionAPedido en el front, que arma el
// patch con estado 'extra' para estos casos.
function nuevaLineaExtra(parche) {
  const cantidadEntregada = Number(parche.cantidadEntregada);
  const precioNum = Number(parche.precioUnitario);
  return {
    plu: clavePlu(parche.plu),
    nombre: parche.nombre || clavePlu(parche.plu),
    unidad: parche.unidad || '',
    cantidad: 0,
    precioUnitario: Number.isFinite(precioNum) && precioNum > 0 ? precioNum : null,
    cantidadEntregada: Number.isFinite(cantidadEntregada) ? Math.max(0, cantidadEntregada) : 0,
    estado: 'extra',
    obs: parche.obs || '',
  };
}

// Línea pedida agregada en el seguimiento (pedido PENDIENTE): un producto que
// se suma al pedido después de armarlo, con las mismas reglas de cantidad y precio.
function nuevaLineaPedida(parche) {
  const estado = parche.estado != null ? String(parche.estado) : 'pedido';
  const linea = {
    plu: clavePlu(parche.plu),
    nombre: parche.nombre || clavePlu(parche.plu),
    unidad: parche.unidad || '',
    cantidad: cantidadEditada(parche.cantidad, parche.plu),
    precioUnitario: precioEditado(parche.precioUnitario, parche.plu),
    cantidadEntregada: null,
    estado,
    obs: parche.obs || '',
  };
  return {
    ...linea,
    cantidadEntregada: entregadaSegunEstado(estado, parche, linea),
    ...(parche.nuevo === true ? { nuevo: true } : {}),
  };
}

// editable: el pedido está PENDIENTE. Recién ahí se puede tocar lo pedido
// (cantidad, precio, agregar y quitar líneas); cerrado o anulado sólo se
// registra la entrega.
function aplicarLineas(items, parcheItems, { editable = false } = {}) {
  const parches = new Map();
  // Los estados se validan sobre el patch entero: un plu que no matchea ninguna
  // línea no puede colar un estado inventado en silencio.
  for (const it of (Array.isArray(parcheItems) ? parcheItems : [])) {
    if (!it) continue;
    if (it.estado != null && !ESTADOS_LINEA.includes(String(it.estado))) {
      throw new Error(`Estado de línea inválido: ${it.estado}`);
    }
    if (it.plu != null) parches.set(clavePlu(it.plu), it);
  }
  const existentes = new Set(items.map(l => clavePlu(l.plu)));
  // quitar: con el pedido PENDIENTE borra cualquier línea (todavía se está
  // armando el compromiso). Cerrado o anulado sólo borra extras (lo entregado
  // sin pedir): las líneas pedidas ya son el compromiso y ahí el flag se ignora.
  const quitada = linea => (editable || linea.estado === 'extra') && parches.get(clavePlu(linea.plu))?.quitar === true;
  const actualizadas = items.filter(linea => !quitada(linea)).map(linea => {
    const parche = parches.get(clavePlu(linea.plu));
    if (!parche) return { ...linea };
    // La entrega se calcula sobre la línea ya editada: entregadaSegunEstado
    // acota contra la cantidad pedida nueva.
    const base = editable ? editarLinea(linea, parche) : linea;
    const estado = parche.estado != null ? String(parche.estado) : base.estado;
    return {
      ...base,
      estado,
      cantidadEntregada: entregadaSegunEstado(estado, parche, base),
      obs: parche.obs != null ? String(parche.obs) : (base.obs || ''),
    };
  });
  const nuevos = [...parches.values()]
    .filter(p => p.quitar !== true && p.plu != null && !existentes.has(clavePlu(p.plu)));
  // Extras: productos de la factura que no estaban pedidos. Se agregan como
  // líneas nuevas en vez de descartarse (antes el .map de arriba los ignoraba
  // en silencio porque no matcheaban ningún plu existente).
  const nuevasExtra = nuevos.filter(p => p.estado === 'extra').map(nuevaLineaExtra);
  // Pedidas nuevas: sólo con el pedido PENDIENTE; si no, el plu desconocido se ignora como siempre.
  const nuevasPedidas = editable ? nuevos.filter(p => p.estado !== 'extra').map(nuevaLineaPedida) : [];
  return [...actualizadas, ...nuevasPedidas, ...nuevasExtra];
}

function accionDe(estado) {
  if (estado === 'CERRADO') return 'cerrado';
  if (estado === 'ANULADO') return 'anulado';
  return 'seguimiento';
}

// Devuelve un pedido NUEVO. Nunca muta el recibido ni sus items ni su historial.
function aplicarSeguimiento(pedido, patch, { ts = null, usuario = null } = {}) {
  const p = pedido || {};
  const q = patch || {};
  // Lo editable se decide por el estado guardado, no por el que trae el patch:
  // cerrar desde PENDIENTE guarda las correcciones del mismo PUT, pero un pedido
  // ya cerrado o anulado no puede reabrir lo pedido.
  const editable = (p.estado || 'PENDIENTE') === 'PENDIENTE';
  const items = aplicarLineas(Array.isArray(p.items) ? p.items : [], q.items, { editable });
  if (!items.some(l => l.estado !== 'extra')) throw new Error('El pedido no tiene items');
  const fechaEstimada = q.fechaEstimada !== undefined ? (q.fechaEstimada || null) : (p.fechaEstimada || null);
  const fechaRetiro = q.fechaRetiro !== undefined ? (q.fechaRetiro || null) : (p.fechaRetiro || null);
  const observacion = q.observacion !== undefined ? String(q.observacion) : (p.observacion || '');
  const estado = q.estado != null ? String(q.estado) : (p.estado || 'PENDIENTE');
  if (!ESTADOS_PEDIDO.includes(estado)) throw new Error(`Estado de pedido inválido: ${estado}`);
  if (estado === 'CERRADO') {
    if (!fechaRetiro) throw new Error('No se puede cerrar el pedido sin fecha de retiro');
    if (items.some(l => l.estado === 'pedido')) {
      throw new Error('No se puede cerrar el pedido: hay líneas sin resolver');
    }
  }
  return {
    ...p, fechaEstimada, fechaRetiro, observacion, estado, items, total: totalPedido(items),
    historial: [...(Array.isArray(p.historial) ? p.historial : []), { ts, usuario, accion: accionDe(estado) }],
  };
}

// ── Dashboard OTIF ───────────────────────────────────────────────────────────
function porcentaje(numerador, denominador) {
  if (!denominador) return null;
  return redondear((100 * numerador) / denominador, 1);
}

// Excluye las líneas 'extra': no eran un compromiso del proveedor, así que no
// pueden contar como incumplimiento ni sumar al total de líneas del OTIF.
function lineasDe(pedido) {
  return (Array.isArray(pedido.items) ? pedido.items : []).filter(l => l.estado !== 'extra');
}

function lineaCompleta(linea) {
  return linea.estado === 'entregado' && num(linea.cantidadEntregada) >= num(linea.cantidad);
}

// null = el pedido no entra al denominador de onTime: sin fecha estimada no hay
// compromiso que medir, y no es un incumplimiento.
function esOnTime(pedido) {
  if (!pedido.fechaEstimada || !pedido.fechaRetiro) return null;
  return pedido.fechaRetiro <= pedido.fechaEstimada;
}

function leadTimeDe(pedidos) {
  const dias = pedidos
    .map(p => diasEntre(p.fecha, p.fechaRetiro))
    .filter(d => d != null)
    .sort((a, b) => a - b);
  const n = dias.length;
  if (!n) return { medio: null, mediana: null, min: null, max: null, n: 0 };
  const medio = redondear(dias.reduce((s, d) => s + d, 0) / n, 1);
  const centro = Math.floor(n / 2);
  const mediana = n % 2 ? dias[centro] : redondear((dias[centro - 1] + dias[centro]) / 2, 1);
  return { medio, mediana, min: dias[0], max: dias[n - 1], n };
}

function quiebresDe(pedidos) {
  const acc = new Map();
  for (const p of pedidos) {
    for (const l of lineasDe(p)) {
      if (!ESTADOS_QUIEBRE.includes(l.estado)) continue;
      const plu = clavePlu(l.plu);
      if (!acc.has(plu)) {
        acc.set(plu, { plu, nombre: l.nombre || plu, veces: 0, pedidos: new Set(),
          cantidadNoEntregada: 0, sinStock: 0, noEnvia: 0, faltante: 0 });
      }
      const q = acc.get(plu);
      q.veces += 1;
      q.pedidos.add(p.numero);
      q.cantidadNoEntregada += Math.max(num(l.cantidad) - num(l.cantidadEntregada), 0);
      if (l.estado === 'sin_stock') q.sinStock += 1;
      else if (l.estado === 'no_envia') q.noEnvia += 1;
      else q.faltante += 1;
    }
  }
  return [...acc.values()]
    .map(q => ({ plu: q.plu, nombre: q.nombre, veces: q.veces, pedidosDistintos: q.pedidos.size,
      cantidadNoEntregada: redondear(q.cantidadNoEntregada, 3), sinStock: q.sinStock, noEnvia: q.noEnvia, faltante: q.faltante }))
    .sort((a, b) => b.veces - a.veces || b.cantidadNoEntregada - a.cantidadNoEntregada);
}

function bloqueMetricas(pedidos) {
  let conFechas = 0, aTiempo = 0, lineas = 0, lineasFull = 0;
  let cantPedida = 0, cantEntregada = 0, otifOk = 0;
  for (const p of pedidos) {
    const onTime = esOnTime(p);
    if (onTime !== null) { conFechas += 1; if (onTime) aTiempo += 1; }
    let todasFull = true;
    for (const l of lineasDe(p)) {
      lineas += 1;
      if (lineaCompleta(l)) lineasFull += 1; else todasFull = false;
      cantPedida += num(l.cantidad);
      cantEntregada += Math.min(num(l.cantidadEntregada), num(l.cantidad));
    }
    if (onTime === true && todasFull) otifOk += 1;
  }
  return {
    pedidos: pedidos.length,
    onTime: porcentaje(aTiempo, conFechas),
    inFullLineas: porcentaje(lineasFull, lineas),
    inFullCantidad: porcentaje(cantEntregada, cantPedida),
    otif: porcentaje(otifOk, pedidos.length),
    leadTime: leadTimeDe(pedidos),
    quiebres: quiebresDe(pedidos),
  };
}

function agruparPorProveedor(pedidos) {
  const porProv = new Map();
  for (const p of pedidos) {
    const prov = p.proveedor || '';
    if (!porProv.has(prov)) porProv.set(prov, []);
    porProv.get(prov).push(p);
  }
  return [...porProv.entries()]
    .map(([proveedor, lista]) => {
      const m = bloqueMetricas(lista);
      return { proveedor, pedidos: m.pedidos, onTime: m.onTime, inFullLineas: m.inFullLineas,
        inFullCantidad: m.inFullCantidad, leadTimeMediana: m.leadTime.mediana };
    })
    .sort((a, b) => b.pedidos - a.pedidos);
}

// Universo: sólo pedidos CERRADOS. Las fechas 'YYYY-MM-DD' se comparan como
// strings, que ordenan cronológicamente.
function otif(pedidos, { proveedor, desde, hasta } = {}) {
  const cerrados = (Array.isArray(pedidos) ? pedidos : []).filter(p => {
    if (!p || p.estado !== 'CERRADO') return false;
    if (proveedor && p.proveedor !== proveedor) return false;
    if (desde && !(p.fecha >= desde)) return false;
    if (hasta && !(p.fecha <= hasta)) return false;
    return true;
  });
  return { ...bloqueMetricas(cerrados), porProveedor: agruparPorProveedor(cerrados) };
}

module.exports = {
  fraccionadosDe, stockSucursalesEq, componentesStockEq, ventasEq,
  demandaDiaria, coberturaDias,
  sumarDias, diasEntre,
  ESTADOS_PEDIDO, ESTADOS_LINEA, siguienteNumero, construirPedido, aplicarSeguimiento,
  normalizarPresentacion,
  otif,
};
