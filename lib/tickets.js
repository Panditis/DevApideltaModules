// ── tickets.js ──────────────────────────────────────────────────────────────
// Tickets de Desarrollo: pedidos de cambios al sistema que cualquier usuario con el
// módulo carga y comenta (quién cambia estados lo decide routes/rutas_tickets.js). Lógica pura sin I/O: recibe la lista, devuelve una nueva
// (nunca muta la de entrada) y el `ahora` llega inyectado para poder testear.
// Los errores llevan e.status (400 validación, 404 inexistente) para que el router
// los pase tal cual a la respuesta.
// Adjuntos: la lógica de metadatos vive acá; el router escribe y borra los archivos en disco.
'use strict';

const PRIORIDADES = [
  { valor: 'baja', etiqueta: 'Baja' },
  { valor: 'media', etiqueta: 'Media' },
  { valor: 'alta', etiqueta: 'Alta' },
  { valor: 'urgente', etiqueta: 'Urgente' },
];

const ESTADOS = [
  { valor: 'pendiente', etiqueta: 'Pendiente' },
  { valor: 'en_proceso', etiqueta: 'En proceso' },
  { valor: 'falta_aprobacion', etiqueta: 'Falta aprobación' },
  { valor: 'stand_by', etiqueta: 'Stand by' },
  { valor: 'terminado', etiqueta: 'Terminado' },
  { valor: 'cancelado', etiqueta: 'Cancelado' },
];

// Estados de una etapa dentro del ticket.
const ESTADOS_ETAPA = [
  { valor: 'pendiente', etiqueta: 'Pendiente' },
  { valor: 'en_proceso', etiqueta: 'En proceso' },
  { valor: 'terminado', etiqueta: 'Terminado' },
];
// Estados del ticket que exigen todas las etapas terminadas; y los cerrados (etapas de solo lectura).
const ESTADOS_CON_ETAPAS_TERMINADAS = ['falta_aprobacion', 'terminado'];
const CERRADOS = ['terminado', 'cancelado'];
const MAX_DESTINATARIOS = 20;
const MAX_ADJUNTO_BYTES = 10 * 1024 * 1024;
const MAX_ADJUNTOS_PEDIDO = 5;
const MAX_NOMBRE_ARCHIVO = 120;
// Lista blanca: el mime sale de la extensión, nunca de lo que declara el cliente.
const MIME_POR_EXT = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain',
}));
const EXTENSIONES_ADJUNTOS = [...MIME_POR_EXT.keys()];

// Sugerencias para el selector: el front suma "Otra" con texto libre, así que el
// server acepta cualquier área (sólo valida largo).
const AREAS = ['Compras', 'Precios', 'Producción', 'Planificación', 'Distribución', 'Pedidos', 'Insumos',
  'Análisis de ventas', 'Finanzas', 'RRHH', 'SIGA', 'Sistema / Infraestructura'];
// Las mismas sugerencias para la instancia de Mantenimiento de sucursales (/sucursales/mantenimiento).
const AREAS_MANTENIMIENTO = ['Electricidad', 'Plomería', 'Gas', 'Refrigeración / Heladeras', 'Climatización', 'Balanzas',
  'Equipos / Máquinas', 'Edificio / Pintura', 'Carpintería / Mobiliario', 'Cerrajería', 'Seguridad / Alarmas',
  'Informática / Caja', 'Limpieza'];

function errorHttp(status, mensaje) {
  const e = new Error(mensaje);
  e.status = status;
  return e;
}

// String recortado con largo entre min y max; si no, 400 con el nombre del campo.
function texto(valor, campo, min, max) {
  if (typeof valor !== 'string') throw errorHttp(400, `El campo ${campo} tiene que ser texto.`);
  const t = valor.trim();
  if (t.length < min || t.length > max) {
    throw errorHttp(400, min > 0
      ? `El campo ${campo} tiene que tener entre ${min} y ${max} caracteres.`
      : `El campo ${campo} no puede pasar de ${max} caracteres.`);
  }
  return t;
}

function validarEnum(valor, opciones, campo) {
  if (!opciones.some(o => o.valor === valor)) throw errorHttp(400, `El campo ${campo} no es válido: ${valor}.`);
  return valor;
}

// Cada destinatario es un Id de SIGA (si coincide sin distinguir mayúsculas se guarda con el Id tal cual
// está en SIGA) o un nombre libre de alguien externo. Repetidos se comparan ya normalizados y sin mayúsculas.
function validarDestinatarios(valor, usuariosValidos) {
  if (!Array.isArray(valor) || valor.length === 0) throw errorHttp(400, 'Elegí al menos un destinatario.');
  if (valor.length > MAX_DESTINATARIOS) throw errorHttp(400, `No puede haber más de ${MAX_DESTINATARIOS} destinatarios.`);
  const dest = valor.map(d => {
    const t = texto(d, 'destinatario', 1, 60);
    return usuariosValidos.find(u => u.toLowerCase() === t.toLowerCase()) || t;
  });
  if (new Set(dest.map(d => d.toLowerCase())).size !== dest.length) throw errorHttp(400, 'Hay destinatarios repetidos.');
  return dest;
}

// Orden manual dentro de una prioridad: `orden` asc (sin `orden` = al final), desempate creadoEn y id.
const ordenDe = t => (Number.isFinite(t.orden) ? t.orden : Infinity);
const maxOrden = lista => lista.reduce((max, t) => (Number.isFinite(t.orden) ? Math.max(max, t.orden) : max), 0);
const compararOrden = (a, b) => (ordenDe(a) - ordenDe(b)) // Infinity - Infinity = NaN → pasa al desempate
  || String(a.creadoEn || '').localeCompare(String(b.creadoEn || '')) || Number(a.id) - Number(b.id);

// Numera los tickets viejos sin `orden` a partir del máximo, por creadoEn e id: conservan su lugar
// relativo (ya estaban al final de su grupo) y un `máximo+1` posterior queda detrás de ellos.
function conOrden(lista) {
  const faltan = lista.filter(t => !Number.isFinite(t.orden)).sort(compararOrden);
  if (!faltan.length) return lista;
  const base = maxOrden(lista);
  const orden = new Map(faltan.map((t, i) => [t, base + i + 1]));
  return lista.map(t => (orden.has(t) ? { ...t, orden: orden.get(t) } : t));
}

function crearTicket(entrada, datos, usuario, usuariosValidos, ahora) {
  const lista = conOrden(entrada);
  const d = datos || {};
  const ticket = {
    id: lista.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1,
    tarea: texto(d.tarea, 'tarea', 1, 150),
    prioridad: validarEnum(d.prioridad, PRIORIDADES, 'prioridad'),
    area: texto(d.area, 'área', 1, 80),
    descripcion: d.descripcion == null ? '' : texto(d.descripcion, 'descripción', 0, 5000),
    destinatarios: validarDestinatarios(d.destinatarios, usuariosValidos),
    estado: 'pendiente',
    orden: maxOrden(lista) + 1,
    destacado: false,
    creadoPor: usuario,
    creadoEn: ahora,
    actualizadoEn: ahora,
    etapas: [],
    adjuntos: [],
    historial: [{ fecha: ahora, usuario, tipo: 'creado' }],
  };
  return { lista: [...lista, ticket], ticket };
}

const etapasDe = t => (Array.isArray(t.etapas) ? t.etapas : []);
const abiertas = t => etapasDe(t).filter(e => e.estado !== 'terminado').length;

function mismosDestinatarios(a, b) {
  return a.length === b.length && a.every(x => b.includes(x));
}

// Traduce `cambios` a entradas de historial; sólo cuenta lo que cambia algo de verdad.
function eventosDeCambios(actual, cambios, base, usuariosValidos) {
  const eventos = [];
  if (cambios.estado !== undefined) {
    const estado = validarEnum(cambios.estado, ESTADOS, 'estado');
    const faltan = abiertas(actual);
    if (estado !== actual.estado && faltan && ESTADOS_CON_ETAPAS_TERMINADAS.includes(estado)) {
      throw errorHttp(400, faltan === 1 ? 'Falta 1 etapa por terminar.' : `Faltan ${faltan} etapas por terminar.`);
    }
    if (estado !== actual.estado) eventos.push({ ...base, tipo: 'estado', de: actual.estado, a: estado });
  }
  if (cambios.prioridad !== undefined) {
    const prioridad = validarEnum(cambios.prioridad, PRIORIDADES, 'prioridad');
    if (prioridad !== actual.prioridad) eventos.push({ ...base, tipo: 'prioridad', de: actual.prioridad, a: prioridad });
  }
  if (cambios.destinatarios !== undefined) {
    const dest = validarDestinatarios(cambios.destinatarios, usuariosValidos);
    if (!mismosDestinatarios(dest, actual.destinatarios)) {
      eventos.push({ ...base, tipo: 'destinatarios', de: [...actual.destinatarios], a: dest });
    }
  }
  // `adjuntos` = metadatos de archivos que el router ya guardó en disco; con archivos la nota puede ir sin texto.
  const archivos = Array.isArray(cambios.adjuntos) ? cambios.adjuntos : [];
  if (cambios.nota !== undefined || archivos.length) {
    const nota = cambios.nota === undefined ? '' : texto(cambios.nota, 'nota', archivos.length ? 0 : 1, 2000);
    eventos.push({ ...base, tipo: 'nota', nota, ...(archivos.length ? { adjuntos: conIds(actual, archivos) } : {}) });
  }
  return eventos;
}

function actualizarTicket(lista, id, cambios, usuario, usuariosValidos, ahora) {
  const idx = lista.findIndex(t => Number(t.id) === Number(id));
  if (idx === -1) throw errorHttp(404, `No existe el ticket ${id}.`);
  const actual = lista[idx];
  const eventos = eventosDeCambios(actual, cambios || {}, { fecha: ahora, usuario }, usuariosValidos);
  if (!eventos.length) throw errorHttp(400, 'No hay ningún cambio para guardar.');
  const est = eventos.find(e => e.tipo === 'estado');
  const dst = eventos.find(e => e.tipo === 'destinatarios');
  const pri = eventos.find(e => e.tipo === 'prioridad');
  const base = pri ? conOrden(lista) : lista; // con cambio de prioridad, los viejos sin `orden` quedan antes del movido
  const ticket = {
    ...actual,
    ...(est ? { estado: est.a } : {}),
    ...(pri ? { prioridad: pri.a, orden: maxOrden(base) + 1 } : {}), // último del grupo nuevo
    ...(dst ? { destinatarios: [...dst.a] } : {}),
    actualizadoEn: ahora,
    historial: [...(actual.historial || []), ...eventos],
  };
  return { lista: base.map((t, i) => (i === idx ? ticket : t)), ticket };
}

// Mueve `id` justo antes de `antesDe` (null = al final) dentro de su prioridad y renumera el grupo 1..n.
// Sin historial ni actualizadoEn: no es una novedad. Sin movimiento real devuelve la misma lista.
function reordenarTicket(lista, id, antesDe) {
  const buscar = x => lista.find(t => Number(t.id) === Number(x));
  const mov = buscar(id);
  if (!mov) throw errorHttp(404, `No existe el ticket ${id}.`);
  const ref = antesDe == null ? null : buscar(antesDe);
  if (antesDe != null && !ref) throw errorHttp(404, `No existe el ticket ${antesDe}.`);
  if (ref && ref.prioridad !== mov.prioridad) throw errorHttp(400, 'Solo se puede reordenar dentro de la misma prioridad.');
  if (ref === mov) return { lista };
  const grupo = lista.filter(t => t.prioridad === mov.prioridad).sort(compararOrden);
  const resto = grupo.filter(t => t !== mov);
  const pos = ref ? resto.indexOf(ref) : resto.length;
  const nuevo = [...resto.slice(0, pos), mov, ...resto.slice(pos)];
  if (nuevo.every((t, i) => t === grupo[i])) return { lista };
  const orden = new Map(nuevo.map((t, i) => [t, i + 1]));
  return { lista: lista.map(t => (orden.has(t) ? { ...t, orden: orden.get(t) } : t)) };
}

// Estrella: solo cambia `destacado` (sin historial, actualizadoEn ni orden).
function destacarTicket(lista, id, valor) {
  if (typeof valor !== 'boolean') throw errorHttp(400, 'El campo destacado tiene que ser verdadero o falso.');
  const idx = lista.findIndex(t => Number(t.id) === Number(id));
  if (idx === -1) throw errorHttp(404, `No existe el ticket ${id}.`);
  const ticket = { ...lista[idx], destacado: valor };
  return { lista: lista.map((t, i) => (i === idx ? ticket : t)), ticket };
}

// Estado general según las etapas (después de cada operación de etapa). Con ≥1 etapa:
// todas terminadas → falta_aprobacion; alguna abierta estando en falta_aprobacion → en_proceso.
// Sin etapas, o ticket terminado/cancelado, no toca nada. Sin cambio devuelve el mismo objeto.
function recalcularEstado(ticket, usuario, ahora) {
  if (!etapasDe(ticket).length || CERRADOS.includes(ticket.estado)) return ticket;
  const todas = abiertas(ticket) === 0;
  const a = todas && ticket.estado !== 'falta_aprobacion' ? 'falta_aprobacion'
    : (!todas && ticket.estado === 'falta_aprobacion' ? 'en_proceso' : null);
  if (!a) return ticket;
  const evento = { fecha: ahora, usuario, tipo: 'estado', de: ticket.estado, a, auto: true };
  return { ...ticket, estado: a, historial: [...(ticket.historial || []), evento] };
}

// Aplica `fn(etapas) → { etapas, eventos }` al ticket `id`, recalcula el estado y devuelve { lista, ticket }.
function operarEtapas(lista, id, usuario, ahora, fn) {
  const idx = lista.findIndex(t => Number(t.id) === Number(id));
  if (idx === -1) throw errorHttp(404, `No existe el ticket ${id}.`);
  const actual = lista[idx];
  if (CERRADOS.includes(actual.estado)) {
    throw errorHttp(400, `El ticket está ${actual.estado === 'terminado' ? 'terminado' : 'cancelado'}: sus etapas no se pueden modificar.`);
  }
  const { etapas, eventos } = fn(etapasDe(actual));
  const base = { fecha: ahora, usuario, tipo: 'etapa' };
  const ticket = recalcularEstado({
    ...actual,
    etapas,
    actualizadoEn: ahora,
    historial: [...(actual.historial || []), ...eventos.map(e => ({ ...base, ...e }))],
  }, usuario, ahora);
  return { lista: lista.map((t, i) => (i === idx ? ticket : t)), ticket };
}

function buscarEtapa(etapas, etapaId) {
  const etapa = etapas.find(e => Number(e.id) === Number(etapaId));
  if (!etapa) throw errorHttp(404, `No existe la etapa ${etapaId}.`);
  return etapa;
}

// ponytail: id = máximo actual + 1; borrar la última y agregar otra reusa su id. Si molesta, guardar un contador en el ticket.
function agregarEtapa(lista, id, datos, usuario, ahora) {
  const nombre = texto((datos || {}).nombre, 'nombre', 1, 120);
  return operarEtapas(lista, id, usuario, ahora, etapas => ({
    etapas: [...etapas, {
      id: etapas.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0) + 1,
      nombre, estado: 'pendiente', creadaEn: ahora, actualizadaEn: ahora,
    }],
    eventos: [{ accion: 'agregada', etapa: nombre }],
  }));
}

function actualizarEtapa(lista, id, etapaId, cambios, usuario, ahora) {
  const c = cambios || {};
  return operarEtapas(lista, id, usuario, ahora, etapas => {
    const etapa = buscarEtapa(etapas, etapaId);
    const nombre = c.nombre === undefined ? etapa.nombre : texto(c.nombre, 'nombre', 1, 120);
    const estado = c.estado === undefined ? etapa.estado : validarEnum(c.estado, ESTADOS_ETAPA, 'estado');
    const eventos = [
      ...(nombre !== etapa.nombre ? [{ accion: 'renombrada', etapa: nombre, de: etapa.nombre, a: nombre }] : []),
      ...(estado !== etapa.estado ? [{ accion: 'estado', etapa: nombre, de: etapa.estado, a: estado }] : []),
    ];
    if (!eventos.length) throw errorHttp(400, 'No hay ningún cambio para guardar.');
    const nueva = { ...etapa, nombre, estado, actualizadaEn: ahora };
    return { etapas: etapas.map(e => (e === etapa ? nueva : e)), eventos };
  });
}

function eliminarEtapa(lista, id, etapaId, usuario, ahora) {
  return operarEtapas(lista, id, usuario, ahora, etapas => {
    const etapa = buscarEtapa(etapas, etapaId);
    return { etapas: etapas.filter(e => e !== etapa), eventos: [{ accion: 'eliminada', etapa: etapa.nombre }] };
  });
}

// ── Adjuntos ────────────────────────────────────────────────────────────────
const adjuntosDe = t => (Array.isArray(t.adjuntos) ? t.adjuntos : []);
const adjuntosDeNota = h => (h && Array.isArray(h.adjuntos) ? h.adjuntos : []);
const todosLosAdjuntos = t => [...adjuntosDe(t), ...(t.historial || []).flatMap(adjuntosDeNota)];

// ponytail: id = máximo actual + 1 (descripción y notas juntas); quitar el último y agregar otro reusa su id,
// sin chocar porque el archivo en disco tiene nombre propio.
function conIds(ticket, metas) {
  const base = todosLosAdjuntos(ticket).reduce((max, a) => Math.max(max, Number(a.id) || 0), 0);
  return metas.map((m, i) => ({ ...m, id: base + i + 1 }));
}

// Sin ruta, sin caracteres de control ni de formato (RTLO U+202E y similares disfrazan la extensión; ancho cero, BOM) ni
// separadores de línea/párrafo (U+2028/2029), máx. MAX_NOMBRE_ARCHIVO conservando la extensión.
function limpiarNombre(original) {
  const base = String(original == null ? '' : original).split(/[\\/]/).pop().replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  if (!base) throw errorHttp(400, 'El archivo no tiene nombre.');
  if (base.length <= MAX_NOMBRE_ARCHIVO) return base;
  const punto = base.lastIndexOf('.');
  const ext = punto > 0 ? base.slice(punto) : '';
  return base.slice(0, MAX_NOMBRE_ARCHIVO - ext.length) + ext;
}

// [{ originalname, size }] (lo que entrega multer) → [{ nombre, mime, tamano, ext }]; 400 si algo no sirve.
function validarArchivos(archivos) {
  const lista = Array.isArray(archivos) ? archivos : [];
  if (!lista.length) throw errorHttp(400, 'No hay archivos para adjuntar.');
  if (lista.length > MAX_ADJUNTOS_PEDIDO) throw errorHttp(400, `Se pueden adjuntar hasta ${MAX_ADJUNTOS_PEDIDO} archivos por vez.`);
  return lista.map(a => {
    const nombre = limpiarNombre(a.originalname);
    const ext = nombre.includes('.') ? nombre.split('.').pop().toLowerCase() : '';
    if (!MIME_POR_EXT.has(ext)) {
      throw errorHttp(400, `El tipo de archivo de «${nombre}» no está permitido. Se aceptan: ${EXTENSIONES_ADJUNTOS.join(', ')}.`);
    }
    if (!a.size) throw errorHttp(400, `«${nombre}» está vacío.`);
    if (a.size > MAX_ADJUNTO_BYTES) throw errorHttp(400, `«${nombre}» pesa más de ${MAX_ADJUNTO_BYTES / (1024 * 1024)} MB.`);
    return { nombre, mime: MIME_POR_EXT.get(ext), tamano: a.size, ext };
  });
}

// destino: {} = descripción · { nota: n } = el evento nota en historial[n] (el historial solo crece: el índice es estable).
// 404 si no existe el ticket o la nota; devuelve el índice del ticket en `lista`. El router lo llama antes de escribir archivos.
function verificarDestino(lista, id, destino) {
  const idx = lista.findIndex(t => Number(t.id) === Number(id));
  if (idx === -1) throw errorHttp(404, `No existe el ticket ${id}.`);
  const n = destino && destino.nota;
  const historial = lista[idx].historial || [];
  if (n !== undefined && !(Number.isInteger(n) && historial[n] && historial[n].tipo === 'nota')) {
    throw errorHttp(404, `No existe la nota ${n}.`);
  }
  return idx;
}

// `metas` ya tienen el archivo guardado en disco (campo `archivo`), todavía sin `id`.
function agregarAdjuntos(lista, id, destino, metas, usuario, ahora) {
  const idx = verificarDestino(lista, id, destino);
  if (!metas.length) throw errorHttp(400, 'No hay archivos para adjuntar.');
  const actual = lista[idx];
  const historial = actual.historial || [];
  const n = destino && destino.nota;
  const nuevos = conIds(actual, metas);
  const eventos = nuevos.map(a => ({
    fecha: ahora, usuario, tipo: 'adjunto', accion: 'agregado', nombre: a.nombre, ...(n === undefined ? {} : { nota: n }),
  }));
  const ticket = {
    ...actual,
    ...(n === undefined ? { adjuntos: [...adjuntosDe(actual), ...nuevos] } : {}),
    actualizadoEn: ahora,
    historial: [...historial.map((h, i) => (i === n ? { ...h, adjuntos: [...adjuntosDeNota(h), ...nuevos] } : h)), ...eventos],
  };
  return { lista: lista.map((t, i) => (i === idx ? ticket : t)), ticket, adjuntos: nuevos };
}

// Dueño del adjunto: { adjunto, nota } con nota = índice del evento nota en historial (undefined = descripción). 404 si no existe.
function ubicarAdjunto(ticket, adjId) {
  const esElPedido = a => Number(a.id) === Number(adjId);
  const enDescripcion = adjuntosDe(ticket).find(esElPedido);
  if (enDescripcion) return { adjunto: enDescripcion, nota: undefined };
  const historial = ticket.historial || [];
  const nota = historial.findIndex(h => adjuntosDeNota(h).some(esElPedido));
  if (nota === -1) throw errorHttp(404, `No existe el adjunto ${adjId}.`);
  return { adjunto: adjuntosDeNota(historial[nota]).find(esElPedido), nota };
}

// Devuelve también el `adjunto` quitado (con su `archivo`) para que el router borre el archivo del disco.
function quitarAdjunto(lista, id, adjId, usuario, ahora) {
  const idx = lista.findIndex(t => Number(t.id) === Number(id));
  if (idx === -1) throw errorHttp(404, `No existe el ticket ${id}.`);
  const actual = lista[idx];
  const { adjunto, nota } = ubicarAdjunto(actual, adjId);
  const otro = a => a !== adjunto;
  const evento = {
    fecha: ahora, usuario, tipo: 'adjunto', accion: 'quitado', nombre: adjunto.nombre, ...(nota === undefined ? {} : { nota }),
  };
  const ticket = {
    ...actual,
    ...(nota === undefined ? { adjuntos: adjuntosDe(actual).filter(otro) } : {}),
    actualizadoEn: ahora,
    historial: [...(actual.historial || []).map((h, i) => (i === nota ? { ...h, adjuntos: adjuntosDeNota(h).filter(otro) } : h)), evento],
  };
  return { lista: lista.map((t, i) => (i === idx ? ticket : t)), ticket, adjunto };
}

// El nombre del archivo en disco no sale al cliente. Acepta un ticket, una lista de tickets o cualquier otro valor (pasa igual).
function sinArchivo(a) {
  const { archivo: _enDisco, ...resto } = a;
  return resto;
}
function ocultarRutas(valor) {
  if (Array.isArray(valor)) return valor.map(ocultarRutas);
  if (!valor || typeof valor !== 'object' || !('historial' in valor || 'adjuntos' in valor)) return valor;
  return {
    ...valor,
    ...(Array.isArray(valor.adjuntos) ? { adjuntos: valor.adjuntos.map(sinArchivo) } : {}),
    ...(Array.isArray(valor.historial)
      ? { historial: valor.historial.map(h => (Array.isArray(h.adjuntos) ? { ...h, adjuntos: h.adjuntos.map(sinArchivo) } : h)) }
      : {}),
  };
}

module.exports = {
  PRIORIDADES, ESTADOS, ESTADOS_ETAPA, AREAS, AREAS_MANTENIMIENTO, crearTicket, actualizarTicket,
  reordenarTicket, destacarTicket,
  recalcularEstado, agregarEtapa, actualizarEtapa, eliminarEtapa,
  MAX_ADJUNTO_BYTES, MAX_ADJUNTOS_PEDIDO,
  validarArchivos, verificarDestino, agregarAdjuntos, ubicarAdjunto, quitarAdjunto, ocultarRutas,
};
