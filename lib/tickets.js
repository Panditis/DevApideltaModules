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

function validarDestinatarios(valor, usuariosValidos) {
  if (!Array.isArray(valor) || valor.length === 0) throw errorHttp(400, 'Elegí al menos un destinatario.');
  if (valor.some(d => typeof d !== 'string')) throw errorHttp(400, 'Los destinatarios tienen que ser usuarios.');
  if (new Set(valor).size !== valor.length) throw errorHttp(400, 'Hay destinatarios repetidos.');
  const invalidos = valor.filter(d => !usuariosValidos.includes(d));
  if (invalidos.length) throw errorHttp(400, `Destinatario inexistente o inactivo: ${invalidos.join(', ')}.`);
  return [...valor];
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
    historial: [{ fecha: ahora, usuario, tipo: 'creado' }],
  };
  return { lista: [...lista, ticket], ticket };
}

function mismosDestinatarios(a, b) {
  return a.length === b.length && a.every(x => b.includes(x));
}

// Traduce `cambios` a entradas de historial; sólo cuenta lo que cambia algo de verdad.
function eventosDeCambios(actual, cambios, base, usuariosValidos) {
  const eventos = [];
  if (cambios.estado !== undefined) {
    const estado = validarEnum(cambios.estado, ESTADOS, 'estado');
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

module.exports = { PRIORIDADES, ESTADOS, AREAS, crearTicket, actualizarTicket };
