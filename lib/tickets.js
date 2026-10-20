// ── tickets.js ──────────────────────────────────────────────────────────────
// Tickets de Desarrollo: pedidos de cambios al sistema que cualquier usuario con el
// módulo carga y comenta (quién cambia estados lo decide routes/rutas_tickets.js). Lógica pura sin I/O: recibe la lista, devuelve una nueva
// (nunca muta la de entrada) y el `ahora` llega inyectado para poder testear.
// Los errores llevan e.status (400 validación, 404 inexistente) para que el router
// los pase tal cual a la respuesta.
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

// Sugerencias para el selector: el front suma "Otra" con texto libre, así que el
// server acepta cualquier área (sólo valida largo).
const AREAS = ['Compras', 'Precios', 'Producción', 'Planificación', 'Distribución', 'Pedidos', 'Insumos',
  'Análisis de ventas', 'Finanzas', 'RRHH', 'SIGA', 'Sistema / Infraestructura'];

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

function crearTicket(lista, datos, usuario, usuariosValidos, ahora) {
  const d = datos || {};
  const ticket = {
    id: lista.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1,
    tarea: texto(d.tarea, 'tarea', 1, 150),
    prioridad: validarEnum(d.prioridad, PRIORIDADES, 'prioridad'),
    area: texto(d.area, 'área', 1, 80),
    descripcion: d.descripcion == null ? '' : texto(d.descripcion, 'descripción', 0, 5000),
    destinatarios: validarDestinatarios(d.destinatarios, usuariosValidos),
    estado: 'pendiente',
    creadoPor: usuario,
    creadoEn: ahora,
    actualizadoEn: ahora,
    etapas: [],
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
  if (cambios.destinatarios !== undefined) {
    const dest = validarDestinatarios(cambios.destinatarios, usuariosValidos);
    if (!mismosDestinatarios(dest, actual.destinatarios)) {
      eventos.push({ ...base, tipo: 'destinatarios', de: [...actual.destinatarios], a: dest });
    }
  }
  if (cambios.nota !== undefined) eventos.push({ ...base, tipo: 'nota', nota: texto(cambios.nota, 'nota', 1, 2000) });
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
  const ticket = {
    ...actual,
    ...(est ? { estado: est.a } : {}),
    ...(dst ? { destinatarios: [...dst.a] } : {}),
    actualizadoEn: ahora,
    historial: [...(actual.historial || []), ...eventos],
  };
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

module.exports = {
  PRIORIDADES, ESTADOS, ESTADOS_ETAPA, AREAS, crearTicket, actualizarTicket,
  recalcularEstado, agregarEtapa, actualizarEtapa, eliminarEtapa,
};
