'use strict';
// Validación, normalización y totales de las órdenes de fraccionado mayorista.
// Módulo puro a propósito: sin SQL ni lectura de archivos, así se puede testear con node:test.
// Lo consume el CRUD /api/mayoristas/ordenes-fraccionado de server.js.
//
// El granel es OPCIONAL. Cuando las líneas salían del endpoint automático de faltantes siempre
// había granel resuelto, pero ahora el armado es manual (el operador elige productos desde la tab
// "Resumen por cliente") y hay productos cuyo granel no se puede resolver: por ejemplo
// "Yerba Apidelta 2Kg Pack X 40", cuyo producto de carga "Yerba Apidelta PEDIDOS" no existe en
// Siga. Rechazar esas líneas hacía fallar el POST entero con 400 y bloqueaba toda la orden, así
// que se aceptan con granel vacío y aportan 0 kg a los totales.

// El granel se mide en kg con decimales; multiplicar en punto flotante deja colas
// (3 × 0.1 da 0.30000000000000004). Se recorta a 6 decimales, la misma precisión que el
// DECIMAL(18,6) de sqlBOMGranel. Mismo criterio que fraccionado_faltantes.js.
function redondear(n) { return Math.round(n * 1e6) / 1e6; }

// Número finito y positivo, o 0. Se usa para cantPorUnidad: un valor inválido (0, negativo,
// texto, ausente) no invalida la línea, simplemente significa "sin granel imputado".
function numeroPositivoOCero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Totales de la orden. Los recalcula siempre el server: lo que manda el cliente es solo la
 * selección, nunca los totales. Las líneas sin granel suman 0 kg pero sí cuentan sus unidades.
 * @param {Array} lineas líneas ya normalizadas
 * @returns {{lineas:number, unidades:number, kgGranel:number}}
 */
// Estados posibles de UNA línea (la orden tiene los suyos: pendiente/aplicada/anulada).
// 'cargado' no distingue parciales a propósito: la regla de negocio es que cualquier carga cierra
// la línea, aunque se hayan producido menos unidades de las pedidas (la cantidad real igual se
// guarda en cargadoCant como dato). 'sin_stock' lo marca la encargada cuando no la va a hacer.
// 'preparado' es la línea que quedó lista SIN fraccionar: el producto ya estaba armado, así que no
// hay registro de producción ni cantidad cargada. Cierra la línea igual que 'cargado' y para
// Pedidos mayoristas cuenta como cargada, pero se lleva aparte para no inventar un registro de
// producción que nunca existió.
const ESTADOS_LINEA = ['pendiente', 'cargado', 'preparado', 'sin_stock'];

// Estados que cierran la línea dejando sello de fecha/hora. La cantidad sólo la tiene 'cargado'.
const ESTADOS_CON_SELLO = ['cargado', 'preparado'];

// Cantidad realmente cargada: 0 es un valor legítimo, así que no sirve numeroPositivoOCero.
function cantidadCargadaValida(v) {
  // null y '' pasan por Number() como 0; se descartan antes para no confundir "no mandó cantidad"
  // con "cargó cero unidades", que sí es un valor legítimo.
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

// Nota u observación libre de la línea: la escribe quien arma la orden en Pedidos mayoristas y la
// lee la encargada en la tab Pedidos de Distribución. Se recorta para que un pegado accidental de
// media planilla no infle el archivo ni rompa la fila; 300 caracteres alcanzan de sobra para una
// indicación puntual ("va sin etiqueta", "el cliente lo quiere en bolsa chica").
const NOTA_LINEA_MAX = 300;
function normalizarNota(v) {
  return String(v == null ? '' : v).trim().slice(0, NOTA_LINEA_MAX);
}

function normalizarFecha(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Hora de la carga, HH:MM en 24h. Las órdenes guardadas antes de este campo no la tienen y
// quedan en '': la UI muestra sólo la fecha en ese caso, y no un "00:00" inventado.
function normalizarHora(v) {
  const s = String(v || '').trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

/**
 * Avance de la orden, para que la tab Pedidos de distribucion.html y el módulo de Pedidos
 * mayoristas muestren lo mismo sin recalcular cada una por su lado.
 * Se calcula al vuelo (nunca se persiste) para que no pueda quedar desincronizado de `lineas`.
 * @param {Array} lineas líneas ya normalizadas
 * @returns {{total:number, cargadas:number, preparadas:number, sinStock:number, pendientes:number}}
 */
function progresoOrdenFraccionado(lineas) {
  const arr = Array.isArray(lineas) ? lineas : [];
  const cuenta = estado => arr.filter(l => (l && l.estado) === estado).length;
  const cargadas = cuenta('cargado');
  const preparadas = cuenta('preparado');
  const sinStock = cuenta('sin_stock');
  return {
    total: arr.length,
    cargadas,
    // Aparte de `cargadas` a propósito: la barra de avance de distribucion.html las suma, pero
    // Pedidos mayoristas necesita poder decir "listas sin fraccionar" si alguna vez hace falta.
    preparadas,
    sinStock,
    // Por diferencia: una línea vieja sin `estado` cuenta como pendiente aunque no se haya
    // normalizado, que es lo que corresponde para las órdenes guardadas antes de este campo.
    pendientes: arr.length - cargadas - preparadas - sinStock,
  };
}

/**
 * Aplica el cambio de estado de UNA línea. Pura: no toca la orden recibida, devuelve una nueva.
 * Volver a 'pendiente' está permitido (la encargada se puede equivocar) y limpia cantidad y fecha.
 * @param {object} orden orden completa tal cual está persistida
 * @param {string|number} plu PLU de la línea a marcar
 * @param {{estado:string, cargadoCant?:*, fecha?:string, hora?:string}} cambio
 * @returns {{orden:object|null, error:string|null}}
 */
function marcarLineaOrden(orden, plu, cambio) {
  const c = cambio || {};
  if (!orden || !Array.isArray(orden.lineas)) return { orden: null, error: 'Orden inválida' };
  if (!ESTADOS_LINEA.includes(c.estado)) {
    return { orden: null, error: `Estado de línea inválido: ${c.estado}` };
  }
  const buscado = String(plu == null ? '' : plu).trim();
  const i = orden.lineas.findIndex(l => l && String(l.plu) === buscado);
  if (i < 0) return { orden: null, error: `La orden no tiene una línea con el PLU ${buscado}` };
  // La cantidad sólo se exige (y se guarda) cuando se está cargando producción: en 'preparado',
  // 'sin_stock' y 'pendiente' no hay nada cargado, así que lo que venga en el body se ignora.
  if (c.estado === 'cargado' && !cantidadCargadaValida(c.cargadoCant)) {
    return { orden: null, error: `Cantidad cargada inválida en el PLU ${buscado}` };
  }
  // 'preparado' también deja sello: sirve para saber cuándo se resolvió la línea, aunque no haya
  // producción detrás.
  const conSello = ESTADOS_CON_SELLO.includes(c.estado);
  const linea = {
    ...orden.lineas[i],
    estado: c.estado,
    cargadoCant: c.estado === 'cargado' ? Number(c.cargadoCant) : 0,
    cargadoFecha: conSello ? normalizarFecha(c.fecha) : '',
    cargadoHora: conSello ? normalizarHora(c.hora) : '',
  };
  const lineas = orden.lineas.map((l, idx) => (idx === i ? linea : l));
  return { orden: { ...orden, lineas }, error: null };
}

/**
 * Cambia la cantidad (y opcionalmente la nota) de UNA línea ya pedida. Pura: devuelve una orden
 * nueva, no toca la recibida.
 * Sólo se puede editar una línea 'pendiente'. Si la sala ya la trabajó ('cargado', 'preparado' o
 * 'sin_stock') cambiar la cantidad desfasaría la producción ya registrada contra lo pedido, así
 * que la regla de negocio es no tocarla: para pedir más se genera una orden nueva.
 * @param {object} orden orden completa tal cual está persistida
 * @param {string|number} plu PLU de la línea a editar
 * @param {{cantidad:*, nota?:string, fecha?:string, hora?:string}} cambio
 * @returns {{orden:object|null, error:string|null}}
 */
function editarLineaOrden(orden, plu, cambio) {
  const c = cambio || {};
  if (!orden || !Array.isArray(orden.lineas)) return { orden: null, error: 'Orden inválida' };
  const buscado = String(plu == null ? '' : plu).trim();
  const i = orden.lineas.findIndex(l => l && String(l.plu) === buscado);
  if (i < 0) return { orden: null, error: `La orden no tiene una línea con el PLU ${buscado}` };
  const previa = orden.lineas[i];
  if (previa.estado && previa.estado !== 'pendiente') {
    return { orden: null, error: `La línea del PLU ${buscado} ya está resuelta y no se puede editar` };
  }
  // Mismo criterio que validarLineasFraccionado: la cantidad es lo que define cuánto se fracciona.
  const cantidad = Number(c.cantidad);
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return { orden: null, error: `Cantidad inválida en el PLU ${buscado}` };
  }
  const cantPorUnidad = numeroPositivoOCero(previa.cantPorUnidad);
  const linea = {
    ...previa,
    cantidad,
    granelNecesario: redondear(cantidad * cantPorUnidad),
    // `nota` ausente significa "no la toques"; un string (incluso '') la reemplaza, así se puede
    // borrar una observación que ya no aplica sin tener que reenviar la orden entera.
    nota: c.nota === undefined ? normalizarNota(previa.nota) : normalizarNota(c.nota),
    // La cantidad con la que se creó la orden, para que Distribución vea "pedía 10, ahora 15".
    // Se sella una sola vez: en la segunda edición el original sigue siendo el de la orden.
    cantidadOriginal: numeroPositivoOCero(previa.cantidadOriginal) || Number(previa.cantidad) || 0,
    editadoFecha: normalizarFecha(c.fecha),
    editadoHora: normalizarHora(c.hora),
  };
  const lineas = orden.lineas.map((l, idx) => (idx === i ? linea : l));
  return { orden: { ...orden, lineas }, error: null };
}

function totalesOrdenFraccionado(lineas) {
  return {
    lineas: lineas.length,
    unidades: lineas.reduce((s, l) => s + (Number(l.cantidad) || 0), 0),
    kgGranel: redondear(lineas.reduce((s, l) => s + (Number(l.granelNecesario) || 0), 0)),
  };
}

/**
 * Devuelve un string con el error, o null si está todo bien.
 * Sólo `plu` y `cantidad` son obligatorios: son los que definen qué y cuánto se fracciona.
 * `granelPlu` y `cantPorUnidad` son informativos y pueden faltar (ver cabecera del módulo).
 * @param {*} lineas lo que llegó en el body, sin validar
 * @returns {string|null}
 */
function validarLineasFraccionado(lineas) {
  if (!Array.isArray(lineas) || !lineas.length) return 'La orden tiene que tener al menos una línea';
  for (const l of lineas) {
    if (!l || typeof l !== 'object')                  return 'Hay una línea inválida';
    if (!String(l.plu || '').trim())                  return 'Hay una línea sin PLU';
    const cant = Number(l.cantidad);
    if (!Number.isFinite(cant) || cant <= 0)          return `Cantidad inválida en el PLU ${l.plu}`;
  }
  return null;
}

/**
 * Deja las líneas con la forma exacta que se persiste. Asume que ya pasaron por
 * validarLineasFraccionado (plu y cantidad válidos).
 * Sin granel resuelto la línea se guarda igual, con los campos de granel en vacío/0: así la orden
 * conserva el producto elegido y la encargada puede cargar la producción a mano.
 * @param {Array} lineas
 * @returns {Array}
 */
function normalizarLineasFraccionado(lineas) {
  return lineas.map(l => {
    const cantidad = Number(l.cantidad);
    const granelPlu = String(l.granelPlu || '').trim();
    // Sin granelPlu no hay contra qué imputar kg, así que cantPorUnidad se fuerza a 0 aunque
    // el cliente haya mandado un número: evita guardar un granelNecesario huérfano.
    const cantPorUnidad = granelPlu ? numeroPositivoOCero(l.cantPorUnidad) : 0;
    return {
      plu: String(l.plu).trim(),
      nombre: String(l.nombre || ''),
      cantidad,
      granelPlu,
      granelNombre: granelPlu ? String(l.granelNombre || '') : '',
      cantPorUnidad,
      granelNecesario: redondear(cantidad * cantPorUnidad),
      // Producto contra el cual se imputa la producción, resuelto por /api/mayoristas/producto-carga.
      // Se guarda tal cual lo manda el frontend: acá no se valida ni se deriva nada.
      pluCarga: String(l.pluCarga || ''),
      nombreCarga: String(l.nombreCarga || ''),
      manual: l.manual === true,
      // Observación de la línea. Editar una orden puede cambiarla o borrarla: es un dato del
      // pedido, no del avance, así que no se preserva a la fuerza como `estado`.
      nota: normalizarNota(l.nota),
      // Avance de la línea. Se preserva si ya viene (editar una orden no puede borrar lo que la
      // encargada ya cargó) y cae a los defaults si no: las órdenes guardadas antes de este campo
      // se leen y se editan igual, quedando como 'pendiente'.
      estado: ESTADOS_LINEA.includes(l.estado) ? l.estado : 'pendiente',
      cargadoCant: l.estado === 'cargado' && cantidadCargadaValida(l.cargadoCant)
        ? Number(l.cargadoCant) : 0,
      cargadoFecha: ESTADOS_CON_SELLO.includes(l.estado) ? normalizarFecha(l.cargadoFecha) : '',
      cargadoHora: ESTADOS_CON_SELLO.includes(l.estado) ? normalizarHora(l.cargadoHora) : '',
      // Rastro de la edición de cantidad (ver editarLineaOrden). Se preserva igual que `estado`:
      // reenviar o editar la orden entera no puede borrar el "pedía 10, ahora 15" que lee
      // Distribución. Ausente en las líneas nunca editadas y en las órdenes viejas.
      cantidadOriginal: numeroPositivoOCero(l.cantidadOriginal),
      editadoFecha: normalizarFecha(l.editadoFecha),
      editadoHora: normalizarHora(l.editadoHora),
      clientes: Array.isArray(l.clientes) ? l.clientes.map(c => ({
        idCliente: c.idCliente, nombre: String(c.nombre || ''), pendiente: Number(c.pendiente) || 0,
      })) : [],
    };
  });
}

/**
 * PLU que ya están comprometidos en órdenes existentes. Una orden 'anulada' no compromete nada:
 * su producto se puede volver a mandar a fraccionar. Cualquier otro estado (pendiente, aplicada)
 * sí bloquea, incluso si la línea ya se cargó: la regla es "un artículo, una orden viva".
 * Tolera órdenes corruptas o sin líneas: el archivo tiene datos viejos y no puede tirar el POST.
 * @param {Array} ordenes órdenes tal cual están persistidas
 * @returns {Set<string>} PLU normalizados a string sin espacios
 */
function plusEnOrdenesActivas(ordenes) {
  const plus = new Set();
  for (const orden of Array.isArray(ordenes) ? ordenes : []) {
    if (!orden || orden.estado === 'anulada' || !Array.isArray(orden.lineas)) continue;
    for (const linea of orden.lineas) {
      const plu = String((linea && linea.plu) || '').trim();
      if (plu) plus.add(plu);
    }
  }
  return plus;
}

/**
 * Devuelve un string con el error, o null si está todo bien. Es el guard real de la regla
 * "un artículo se manda a fraccionar una sola vez": el bloqueo del frontend es sólo UX y no
 * alcanza (un carrito viejo en otra pestaña podría reenviar un producto ya pedido).
 * @param {Array} lineas líneas del body, ya validadas por validarLineasFraccionado
 * @param {Array} ordenes órdenes ya persistidas
 * @returns {string|null}
 */
function validarLineasNoRepetidas(lineas, ordenes) {
  const yaPedidos = plusEnOrdenesActivas(ordenes);
  const vistos = new Set();
  for (const l of Array.isArray(lineas) ? lineas : []) {
    const plu = String((l && l.plu) || '').trim();
    if (!plu) continue;                 // línea sin PLU: la rechaza validarLineasFraccionado
    if (vistos.has(plu)) return `El PLU ${plu} está repetido en la orden`;
    vistos.add(plu);
    if (yaPedidos.has(plu)) {
      return `El PLU ${plu} ya está en una orden de fraccionado que no está anulada`;
    }
  }
  return null;
}

module.exports = {
  ESTADOS_LINEA,
  plusEnOrdenesActivas,
  validarLineasNoRepetidas,
  validarLineasFraccionado,
  normalizarLineasFraccionado,
  totalesOrdenFraccionado,
  progresoOrdenFraccionado,
  marcarLineaOrden,
  editarLineaOrden,
};
