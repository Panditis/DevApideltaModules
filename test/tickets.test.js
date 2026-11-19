'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  PRIORIDADES, ESTADOS, ESTADOS_ETAPA, AREAS, crearTicket, actualizarTicket, reordenarTicket, destacarTicket, asignarFecha, AREAS_MANTENIMIENTO,
  agregarEtapa, actualizarEtapa, eliminarEtapa, recalcularEstado,
  validarArchivos, agregarAdjuntos, quitarAdjunto, ubicarAdjunto, ocultarRutas, verificarDestino,
} = require('../lib/tickets');

const USUARIOS = ['ana', 'beto', 'caro'];
const T0 = '2026-10-19T10:00:00.000Z';
const T1 = '2026-10-19T11:00:00.000Z';
const BASE = { tarea: 'Arreglar export', prioridad: 'alta', area: 'Compras', descripcion: 'Detalle', destinatarios: ['beto'] };

function crear(lista = [], datos = {}) {
  return crearTicket(lista, { ...BASE, ...datos }, 'ana', USUARIOS, T0);
}
function falla(fn, status, re) {
  assert.throws(fn, e => e.status === status && (!re || re.test(e.message)));
}

test('constantes: prioridades, estados y áreas', () => {
  assert.deepStrictEqual(PRIORIDADES.map(p => p.valor), ['baja', 'media', 'alta', 'urgente']);
  assert.deepStrictEqual(ESTADOS.map(e => e.valor), ['pendiente', 'en_proceso', 'falta_aprobacion', 'stand_by', 'terminado', 'cancelado']);
  assert.ok(AREAS.includes('SIGA') && AREAS.length === 12);
});

test('crearTicket arma el ticket con estado pendiente e historial de creación', () => {
  const { lista, ticket } = crear([], { tarea: '  Arreglar export  ', area: ' Compras ' });
  assert.deepStrictEqual(ticket, {
    id: 1, tarea: 'Arreglar export', prioridad: 'alta', area: 'Compras', descripcion: 'Detalle',
    destinatarios: ['beto'], estado: 'pendiente', orden: 1, destacado: false, fecha: null, creadoPor: 'ana', creadoEn: T0, actualizadoEn: T0, etapas: [], adjuntos: [],
    historial: [{ fecha: T0, usuario: 'ana', tipo: 'creado' }],
  });
  assert.deepStrictEqual(lista, [ticket]);
});

test('crearTicket: ids incrementales sobre el máximo y lista de entrada intacta', () => {
  const entrada = [{ id: 3 }, { id: 7 }];
  const copia = JSON.parse(JSON.stringify(entrada));
  const { lista, ticket } = crear(entrada);
  assert.strictEqual(ticket.id, 8);
  assert.strictEqual(lista.length, 3);
  assert.deepStrictEqual(entrada, copia);
  assert.notStrictEqual(lista, entrada);
});

test('crearTicket: descripción opcional y área libre', () => {
  const { ticket } = crear([], { descripcion: undefined, area: 'Otra cosa' });
  assert.strictEqual(ticket.descripcion, '');
  assert.strictEqual(ticket.area, 'Otra cosa');
});

test('crearTicket valida cada campo con 400', () => {
  falla(() => crear([], { tarea: '   ' }), 400, /tarea/i);
  falla(() => crear([], { tarea: 'x'.repeat(151) }), 400, /tarea/i);
  falla(() => crear([], { tarea: 5 }), 400, /tarea/i);
  falla(() => crear([], { prioridad: 'altísima' }), 400, /prioridad/i);
  falla(() => crear([], { area: '' }), 400, /área/i);
  falla(() => crear([], { area: 'x'.repeat(81) }), 400, /área/i);
  falla(() => crear([], { descripcion: 'x'.repeat(5001) }), 400, /descripción/i);
  falla(() => crear([], { destinatarios: [] }), 400, /destinatario/i);
  falla(() => crear([], { destinatarios: 'beto' }), 400, /destinatario/i);
  falla(() => crear([], { destinatarios: ['beto', 'beto'] }), 400, /repetido/i);
});

test('actualizarTicket: cambio de estado, nota y destinatarios generan historial por tipo', () => {
  const { lista: l0 } = crear();
  const copia = JSON.parse(JSON.stringify(l0));
  const { lista, ticket } = actualizarTicket(l0, 1, { estado: 'en_proceso', nota: ' Arranco ', destinatarios: ['beto', 'caro'] }, 'beto', USUARIOS, T1);
  assert.strictEqual(ticket.estado, 'en_proceso');
  assert.deepStrictEqual(ticket.destinatarios, ['beto', 'caro']);
  assert.strictEqual(ticket.actualizadoEn, T1);
  assert.deepStrictEqual(ticket.historial.slice(1), [
    { fecha: T1, usuario: 'beto', tipo: 'estado', de: 'pendiente', a: 'en_proceso' },
    { fecha: T1, usuario: 'beto', tipo: 'destinatarios', de: ['beto'], a: ['beto', 'caro'] },
    { fecha: T1, usuario: 'beto', tipo: 'nota', nota: 'Arranco' },
  ]);
  assert.deepStrictEqual(lista, [ticket]);
  assert.deepStrictEqual(l0, copia, 'la lista de entrada no se muta');
});

test('actualizarTicket: mismo estado es no-op; sin cambios reales es 400', () => {
  const { lista: l0 } = crear();
  falla(() => actualizarTicket(l0, 1, { estado: 'pendiente' }, 'ana', USUARIOS, T1), 400, /cambio/i);
  falla(() => actualizarTicket(l0, 1, {}, 'ana', USUARIOS, T1), 400, /cambio/i);
  falla(() => actualizarTicket(l0, 1, { destinatarios: ['beto'] }, 'ana', USUARIOS, T1), 400, /cambio/i);
  const { ticket } = actualizarTicket(l0, 1, { estado: 'pendiente', nota: 'sigue' }, 'ana', USUARIOS, T1);
  assert.deepStrictEqual(ticket.historial.map(h => h.tipo), ['creado', 'nota']);
  assert.strictEqual(ticket.estado, 'pendiente');
});

test('actualizarTicket valida estado, nota y destinatarios; 404 si no existe', () => {
  const { lista: l0 } = crear();
  falla(() => actualizarTicket(l0, 1, { estado: 'hecho' }, 'ana', USUARIOS, T1), 400, /estado/i);
  falla(() => actualizarTicket(l0, 1, { nota: '  ' }, 'ana', USUARIOS, T1), 400, /nota/i);
  falla(() => actualizarTicket(l0, 1, { nota: 'x'.repeat(2001) }, 'ana', USUARIOS, T1), 400, /nota/i);
  falla(() => actualizarTicket(l0, 1, { destinatarios: ['  '] }, 'ana', USUARIOS, T1), 400, /destinatario/i);
  falla(() => actualizarTicket(l0, 99, { estado: 'terminado' }, 'ana', USUARIOS, T1), 404);
});

// ── Destinatarios: usuarios SIGA (normalizados al Id) o nombres libres ──────
test('destinatarios: Id SIGA case-insensitive se normaliza; lo demás queda como nombre libre recortado', () => {
  const { ticket } = crear([], { destinatarios: [' BETO ', '  Pepe Gómez ', 'Caro'] });
  assert.deepStrictEqual(ticket.destinatarios, ['beto', 'Pepe Gómez', 'caro']);
});

test('destinatarios: repetidos tras normalizar (sin distinguir mayúsculas), largo 1..60, tope 20, al menos 1', () => {
  falla(() => crear([], { destinatarios: ['beto', 'BETO'] }), 400, /repetido/i);
  falla(() => crear([], { destinatarios: ['Pepe', ' pepe '] }), 400, /repetido/i);
  falla(() => crear([], { destinatarios: ['x'.repeat(61)] }), 400, /60/);
  falla(() => crear([], { destinatarios: ['   '] }), 400, /destinatario/i);
  falla(() => crear([], { destinatarios: [5] }), 400, /destinatario/i);
  falla(() => crear([], { destinatarios: Array.from({ length: 21 }, (_, i) => `p${i}`) }), 400, /20/);
  assert.strictEqual(crear([], { destinatarios: Array.from({ length: 20 }, (_, i) => `p${i}`) }).ticket.destinatarios.length, 20);
  assert.strictEqual(crear([], { destinatarios: ['x'.repeat(60)] }).ticket.destinatarios[0].length, 60);
});

test('actualizarTicket: destinatarios externos; normalizar al mismo valor no es cambio', () => {
  const { lista: l0 } = crear();
  falla(() => actualizarTicket(l0, 1, { destinatarios: ['BETO'] }, 'ana', USUARIOS, T1), 400, /cambio/i);
  const { ticket } = actualizarTicket(l0, 1, { destinatarios: ['BETO', 'Proveedor X'] }, 'ana', USUARIOS, T1);
  assert.deepStrictEqual(ticket.destinatarios, ['beto', 'Proveedor X']);
});

// ── Etapas ──────────────────────────────────────────────────────────────────
const T2 = '2026-10-19T12:00:00.000Z';
// Ticket 1 con las etapas dadas (nombres), todas pendientes, armado a mano.
function conEtapas(nombres, estadoTicket = 'en_proceso') {
  const { lista } = crear();
  const etapas = nombres.map((n, i) => ({ id: i + 1, nombre: n, estado: 'pendiente', creadaEn: T0, actualizadaEn: T0 }));
  return [{ ...lista[0], estado: estadoTicket, etapas }];
}
const ultimo = t => t.historial[t.historial.length - 1];

test('ESTADOS_ETAPA: pendiente, en proceso, terminado', () => {
  assert.deepStrictEqual(ESTADOS_ETAPA, [
    { valor: 'pendiente', etiqueta: 'Pendiente' },
    { valor: 'en_proceso', etiqueta: 'En proceso' },
    { valor: 'terminado', etiqueta: 'Terminado' },
  ]);
});

test('agregarEtapa: nace pendiente con id incremental, historial y lista intacta (ticket viejo sin etapas)', () => {
  const { lista: l0 } = crear();
  const { etapas: _sacar, ...sinEtapas } = l0[0];
  const viejo = [sinEtapas];
  const copia = JSON.parse(JSON.stringify(viejo));
  const { lista: l1, ticket: t1 } = agregarEtapa(viejo, 1, { nombre: '  Relevar  ' }, 'beto', T1);
  assert.deepStrictEqual(t1.etapas, [{ id: 1, nombre: 'Relevar', estado: 'pendiente', creadaEn: T1, actualizadaEn: T1 }]);
  assert.deepStrictEqual(ultimo(t1), { fecha: T1, usuario: 'beto', tipo: 'etapa', accion: 'agregada', etapa: 'Relevar' });
  assert.strictEqual(t1.actualizadoEn, T1);
  assert.strictEqual(t1.estado, 'pendiente');
  assert.deepStrictEqual(viejo, copia, 'no muta la entrada');
  const { ticket: t2 } = agregarEtapa(l1, 1, { nombre: 'Programar' }, 'beto', T2);
  assert.deepStrictEqual(t2.etapas.map(e => e.id), [1, 2]);
});

test('agregarEtapa valida nombre, 404 y bloqueo en ticket terminado o cancelado', () => {
  const { lista: l0 } = crear();
  falla(() => agregarEtapa(l0, 1, { nombre: '  ' }, 'beto', T1), 400, /nombre/i);
  falla(() => agregarEtapa(l0, 1, { nombre: 'x'.repeat(121) }, 'beto', T1), 400, /nombre/i);
  falla(() => agregarEtapa(l0, 1, {}, 'beto', T1), 400, /nombre/i);
  falla(() => agregarEtapa(l0, 9, { nombre: 'A' }, 'beto', T1), 404);
  falla(() => agregarEtapa(conEtapas([], 'terminado'), 1, { nombre: 'A' }, 'beto', T1), 400, /terminado/i);
  falla(() => agregarEtapa(conEtapas([], 'cancelado'), 1, { nombre: 'A' }, 'beto', T1), 400, /cancelado/i);
});

test('actualizarEtapa: cambia estado y nombre con historial; sin cambio real 400; valida y 404', () => {
  const l0 = conEtapas(['A', 'B']);
  const copia = JSON.parse(JSON.stringify(l0));
  const { ticket } = actualizarEtapa(l0, 1, 1, { nombre: ' A1 ', estado: 'en_proceso' }, 'beto', T1);
  assert.deepStrictEqual(ticket.etapas[0], { id: 1, nombre: 'A1', estado: 'en_proceso', creadaEn: T0, actualizadaEn: T1 });
  assert.deepStrictEqual(ticket.historial.slice(-2), [
    { fecha: T1, usuario: 'beto', tipo: 'etapa', accion: 'renombrada', etapa: 'A1', de: 'A', a: 'A1' },
    { fecha: T1, usuario: 'beto', tipo: 'etapa', accion: 'estado', etapa: 'A1', de: 'pendiente', a: 'en_proceso' },
  ]);
  assert.deepStrictEqual(l0, copia, 'no muta la entrada');
  falla(() => actualizarEtapa(l0, 1, 1, { nombre: 'A', estado: 'pendiente' }, 'beto', T1), 400, /cambio/i);
  falla(() => actualizarEtapa(l0, 1, 1, {}, 'beto', T1), 400, /cambio/i);
  falla(() => actualizarEtapa(l0, 1, 1, { estado: 'hecho' }, 'beto', T1), 400, /estado/i);
  falla(() => actualizarEtapa(l0, 1, 1, { nombre: '' }, 'beto', T1), 400, /nombre/i);
  falla(() => actualizarEtapa(l0, 1, 7, { estado: 'terminado' }, 'beto', T1), 404, /etapa/i);
  falla(() => actualizarEtapa(l0, 5, 1, { estado: 'terminado' }, 'beto', T1), 404, /ticket/i);
  falla(() => actualizarEtapa(conEtapas(['A'], 'terminado'), 1, 1, { estado: 'terminado' }, 'beto', T1), 400, /terminado/i);
  falla(() => eliminarEtapa(conEtapas(['A'], 'cancelado'), 1, 1, 'beto', T1), 400, /cancelado/i);
});

test('regla 2: al terminar la última etapa abierta el ticket pasa solo a falta_aprobacion (también desde stand_by o pendiente)', () => {
  for (const inicial of ['en_proceso', 'stand_by', 'pendiente']) {
    const l0 = conEtapas(['A', 'B'], inicial);
    const { lista: l1, ticket: t1 } = actualizarEtapa(l0, 1, 1, { estado: 'terminado' }, 'beto', T1);
    assert.strictEqual(t1.estado, inicial, 'con una etapa abierta no cambia');
    const { ticket: t2 } = actualizarEtapa(l1, 1, 2, { estado: 'terminado' }, 'beto', T2);
    assert.strictEqual(t2.estado, 'falta_aprobacion');
    assert.deepStrictEqual(ultimo(t2), { fecha: T2, usuario: 'beto', tipo: 'estado', de: inicial, a: 'falta_aprobacion', auto: true });
  }
});

test('regla 3: reabrir una etapa con el ticket en falta_aprobacion lo vuelve a en_proceso', () => {
  const l0 = conEtapas(['A']);
  const { lista: l1, ticket: t1 } = actualizarEtapa(l0, 1, 1, { estado: 'terminado' }, 'beto', T1);
  assert.strictEqual(t1.estado, 'falta_aprobacion');
  const { lista: l2, ticket: t2 } = actualizarEtapa(l1, 1, 1, { estado: 'en_proceso' }, 'caro', T2);
  assert.strictEqual(t2.estado, 'en_proceso');
  assert.deepStrictEqual(ultimo(t2), { fecha: T2, usuario: 'caro', tipo: 'estado', de: 'falta_aprobacion', a: 'en_proceso', auto: true });
  // Agregar una etapa nueva (pendiente) también reabre.
  const { lista: l3 } = actualizarEtapa(l2, 1, 1, { estado: 'terminado' }, 'beto', T2);
  const { ticket: t4 } = agregarEtapa(l3, 1, { nombre: 'Otra' }, 'beto', T2);
  assert.strictEqual(t4.estado, 'en_proceso');
});

test('eliminarEtapa: borrar la última abierta → falta_aprobacion; borrar todas → sin cambio de estado', () => {
  const l0 = conEtapas(['A', 'B']);
  const { lista: l1 } = actualizarEtapa(l0, 1, 1, { estado: 'terminado' }, 'beto', T1);
  const copia = JSON.parse(JSON.stringify(l1));
  const { lista: l2, ticket: t2 } = eliminarEtapa(l1, 1, 2, 'beto', T2);
  assert.deepStrictEqual(l1, copia, 'no muta la entrada');
  assert.deepStrictEqual(t2.etapas.map(e => e.id), [1]);
  assert.strictEqual(t2.estado, 'falta_aprobacion');
  assert.deepStrictEqual(t2.historial.slice(-2), [
    { fecha: T2, usuario: 'beto', tipo: 'etapa', accion: 'eliminada', etapa: 'B' },
    { fecha: T2, usuario: 'beto', tipo: 'estado', de: 'en_proceso', a: 'falta_aprobacion', auto: true },
  ]);
  const { ticket: t3 } = eliminarEtapa(l2, 1, 1, 'beto', T2);
  assert.deepStrictEqual(t3.etapas, []);
  assert.strictEqual(t3.estado, 'falta_aprobacion', 'sin etapas no se recalcula');
  const { ticket: t4 } = eliminarEtapa(conEtapas(['A']), 1, 1, 'beto', T2);
  assert.strictEqual(t4.estado, 'en_proceso');
  falla(() => eliminarEtapa(l0, 1, 9, 'beto', T2), 404, /etapa/i);
});

test('regla 1: con etapas abiertas no se pasa a falta_aprobacion ni terminado a mano; el resto sí', () => {
  const l0 = conEtapas(['A', 'B']);
  falla(() => actualizarTicket(l0, 1, { estado: 'terminado' }, 'beto', USUARIOS, T1), 400, /^Faltan 2 etapas por terminar\.$/);
  falla(() => actualizarTicket(l0, 1, { estado: 'falta_aprobacion' }, 'beto', USUARIOS, T1), 400, /Faltan 2 etapas/);
  const { lista: l1 } = actualizarEtapa(l0, 1, 1, { estado: 'terminado' }, 'beto', T1);
  falla(() => actualizarTicket(l1, 1, { estado: 'terminado' }, 'beto', USUARIOS, T1), 400, /^Falta 1 etapa por terminar\.$/);
  for (const e of ['pendiente', 'stand_by', 'cancelado']) {
    assert.strictEqual(actualizarTicket(l0, 1, { estado: e }, 'beto', USUARIOS, T1).ticket.estado, e);
  }
  // Todas terminadas (auto falta_aprobacion): ahí sí se puede cerrar a mano.
  const { lista: l2 } = actualizarEtapa(l1, 1, 2, { estado: 'terminado' }, 'beto', T1);
  assert.strictEqual(actualizarTicket(l2, 1, { estado: 'terminado' }, 'beto', USUARIOS, T2).ticket.estado, 'terminado');
});

test('regla 4 y recalcularEstado puro: sin etapas nada cambia; no toca terminado/cancelado; no muta', () => {
  const { lista: l0 } = crear();
  assert.strictEqual(actualizarTicket(l0, 1, { estado: 'terminado' }, 'beto', USUARIOS, T1).ticket.estado, 'terminado');
  const t = conEtapas(['A'])[0];
  const terminadas = { ...t, etapas: t.etapas.map(e => ({ ...e, estado: 'terminado' })) };
  const copia = JSON.parse(JSON.stringify(terminadas));
  assert.strictEqual(recalcularEstado(terminadas, 'beto', T1).estado, 'falta_aprobacion');
  assert.deepStrictEqual(terminadas, copia);
  assert.strictEqual(recalcularEstado(t, 'beto', T1), t, 'sin cambio devuelve el mismo ticket');
  assert.strictEqual(recalcularEstado({ ...terminadas, estado: 'terminado' }, 'beto', T1).estado, 'terminado');
  assert.strictEqual(recalcularEstado({ ...t, estado: 'cancelado' }, 'beto', T1).estado, 'cancelado');
  assert.strictEqual(recalcularEstado({ ...t, estado: 'falta_aprobacion' }, 'beto', T1).estado, 'en_proceso');
  const sinEtapas = { ...t, etapas: [], estado: 'falta_aprobacion' };
  assert.strictEqual(recalcularEstado(sinEtapas, 'beto', T1), sinEtapas);
});

// El front detecta cambios por actualizadoEn y describe el aviso con la última entrada del historial:
// toda operación tiene que mover ambos.
test('toda operación actualiza actualizadoEn y deja entrada en el historial con esa fecha', () => {
  const pasos = [
    ['estado', l => actualizarTicket(l, 1, { estado: 'en_proceso' }, 'beto', USUARIOS, T1)],
    ['nota', l => actualizarTicket(l, 1, { nota: 'hola' }, 'beto', USUARIOS, T1)],
    ['prioridad', l => actualizarTicket(l, 1, { prioridad: 'baja' }, 'beto', USUARIOS, T1)],
    ['destinatarios', l => actualizarTicket(l, 1, { destinatarios: ['caro'] }, 'beto', USUARIOS, T1)],
    ['etapa agregada', l => agregarEtapa(l, 1, { nombre: 'A' }, 'beto', T1)],
    ['etapa renombrada', l => actualizarEtapa(agregarEtapa(l, 1, { nombre: 'A' }, 'beto', T0).lista, 1, 1, { nombre: 'B' }, 'beto', T1)],
    ['etapa terminada (auto)', l => actualizarEtapa(agregarEtapa(l, 1, { nombre: 'A' }, 'beto', T0).lista, 1, 1, { estado: 'terminado' }, 'beto', T1)],
    ['etapa eliminada', l => eliminarEtapa(agregarEtapa(l, 1, { nombre: 'A' }, 'beto', T0).lista, 1, 1, 'beto', T1)],
  ];
  for (const [nombre, fn] of pasos) {
    const { ticket } = fn(crear().lista);
    const ultima = ticket.historial[ticket.historial.length - 1];
    assert.strictEqual(ticket.actualizadoEn, T1, nombre);
    assert.deepStrictEqual([ultima.fecha, ultima.usuario], [T1, 'beto'], nombre);
  }
  const { ticket } = crear();
  assert.strictEqual(ticket.historial[ticket.historial.length - 1].fecha, ticket.actualizadoEn);
});

// ── Prioridad editable ──────────────────────────────────────────────────────
test('actualizarTicket: prioridad cambia con historial; misma es no-op; inválida 400; ticket cerrado se puede', () => {
  const { lista: l0 } = crear(); // nace en 'alta'
  const copia = JSON.parse(JSON.stringify(l0));
  const { lista, ticket } = actualizarTicket(l0, 1, { prioridad: 'urgente' }, 'beto', USUARIOS, T1);
  assert.strictEqual(ticket.prioridad, 'urgente');
  assert.strictEqual(ticket.actualizadoEn, T1);
  assert.deepStrictEqual(ultimo(ticket), { fecha: T1, usuario: 'beto', tipo: 'prioridad', de: 'alta', a: 'urgente' });
  assert.deepStrictEqual(lista, [ticket]);
  assert.deepStrictEqual(l0, copia, 'no muta la entrada');
  falla(() => actualizarTicket(l0, 1, { prioridad: 'alta' }, 'beto', USUARIOS, T1), 400, /cambio/i);
  falla(() => actualizarTicket(l0, 1, { prioridad: 'altísima' }, 'beto', USUARIOS, T1), 400, /prioridad/i);
  falla(() => actualizarTicket(l0, 1, { prioridad: null }, 'beto', USUARIOS, T1), 400, /prioridad/i);
  const { ticket: t2 } = actualizarTicket(l0, 1, { prioridad: 'alta', nota: 'igual' }, 'beto', USUARIOS, T1);
  assert.deepStrictEqual(t2.historial.map(h => h.tipo), ['creado', 'nota'], 'misma prioridad no deja historial');
  for (const e of ['terminado', 'cancelado']) {
    const { ticket: t3 } = actualizarTicket([{ ...l0[0], estado: e }], 1, { prioridad: 'baja' }, 'beto', USUARIOS, T1);
    assert.deepStrictEqual([t3.prioridad, t3.estado], ['baja', e]);
  }
});

// ── Adjuntos ────────────────────────────────────────────────────────────────
const ARCHIVO = (nombre = 'captura.png') => ({
  nombre, mime: 'image/png', tamano: 1234, subidoPor: 'ana', subidoEn: T1, archivo: `u-${nombre}`,
});

test('validarArchivos: acepta la lista blanca y arma nombre, mime, tamaño y extensión', () => {
  const r = validarArchivos([{ originalname: 'C:\\fotos\\Captura 1.PNG', size: 500 }, { originalname: 'planilla.xlsx', size: 10 }]);
  assert.deepStrictEqual(r, [
    { nombre: 'Captura 1.PNG', mime: 'image/png', tamano: 500, ext: 'png' },
    { nombre: 'planilla.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', tamano: 10, ext: 'xlsx' },
  ]);
});

test('validarArchivos rechaza con 400: sin archivos, demasiados, extensión, vacío, pesado, sin nombre', () => {
  const f = (n, size = 10) => ({ originalname: n, size });
  falla(() => validarArchivos([]), 400, /archivo/i);
  falla(() => validarArchivos(undefined), 400, /archivo/i);
  falla(() => validarArchivos(Array.from({ length: 6 }, (_, i) => f(`a${i}.png`))), 400, /5 archivos/);
  falla(() => validarArchivos([f('virus.exe')]), 400, /virus\.exe/);
  falla(() => validarArchivos([f('sin_extension')]), 400, /sin_extension/);
  falla(() => validarArchivos([f('constructor')]), 400, /constructor/);
  falla(() => validarArchivos([f('a.png', 0)]), 400, /vacío/);
  falla(() => validarArchivos([f('a.png', 10 * 1024 * 1024 + 1)]), 400, /10 MB/);
  falla(() => validarArchivos([f('   ')]), 400, /nombre/);
});

test('validarArchivos recorta nombres largos conservando la extensión', () => {
  const [a] = validarArchivos([{ originalname: `${'x'.repeat(200)}.pdf`, size: 1 }]);
  assert.strictEqual(a.nombre.length, 120);
  assert.ok(a.nombre.endsWith('.pdf'));
});

test('agregarAdjuntos a la descripción: ids, evento y lista de entrada intacta', () => {
  const { lista } = crear();
  const copia = JSON.parse(JSON.stringify(lista));
  const r = agregarAdjuntos(lista, 1, {}, [ARCHIVO('a.png'), ARCHIVO('b.pdf')], 'ana', T1);
  assert.deepStrictEqual(r.ticket.adjuntos.map(a => [a.id, a.nombre]), [[1, 'a.png'], [2, 'b.pdf']]);
  assert.deepStrictEqual(r.adjuntos.map(a => a.id), [1, 2]);
  assert.strictEqual(r.ticket.actualizadoEn, T1);
  assert.deepStrictEqual(r.ticket.historial.slice(1), [
    { fecha: T1, usuario: 'ana', tipo: 'adjunto', accion: 'agregado', nombre: 'a.png' },
    { fecha: T1, usuario: 'ana', tipo: 'adjunto', accion: 'agregado', nombre: 'b.pdf' },
  ]);
  assert.deepStrictEqual(lista, copia);
});

test('actualizarTicket: una nota con archivos (con o sin texto) guarda los adjuntos en el evento', () => {
  const { lista } = crear();
  const conTexto = actualizarTicket(lista, 1, { nota: 'mirá', adjuntos: [ARCHIVO('a.png')] }, 'beto', USUARIOS, T1);
  const evento = conTexto.ticket.historial[1];
  assert.strictEqual(evento.tipo, 'nota');
  assert.strictEqual(evento.nota, 'mirá');
  assert.deepStrictEqual(evento.adjuntos.map(a => a.id), [1]);
  const soloArchivo = actualizarTicket(conTexto.lista, 1, { adjuntos: [ARCHIVO('b.png')] }, 'beto', USUARIOS, T1);
  const e2 = soloArchivo.ticket.historial[2];
  assert.strictEqual(e2.nota, '');
  assert.deepStrictEqual(e2.adjuntos.map(a => a.id), [2]); // el id sigue contando los de la nota anterior
  falla(() => actualizarTicket(lista, 1, { nota: '   ' }, 'beto', USUARIOS, T1), 400, /nota/i);
});

test('agregarAdjuntos a una nota existente: usa el índice del historial y deja el evento', () => {
  const { lista } = crear();
  const conNota = actualizarTicket(lista, 1, { nota: 'hola' }, 'beto', USUARIOS, T1).lista;
  const r = agregarAdjuntos(conNota, 1, { nota: 1 }, [ARCHIVO('a.png')], 'caro', T1);
  assert.deepStrictEqual(r.ticket.historial[1].adjuntos.map(a => a.nombre), ['a.png']);
  assert.deepStrictEqual(r.ticket.adjuntos, []);
  assert.deepStrictEqual(r.ticket.historial[2], { fecha: T1, usuario: 'caro', tipo: 'adjunto', accion: 'agregado', nombre: 'a.png', nota: 1 });
  falla(() => agregarAdjuntos(conNota, 1, { nota: 0 }, [ARCHIVO()], 'ana', T1), 404, /nota/i); // 0 es el evento "creado"
  falla(() => agregarAdjuntos(conNota, 1, { nota: 9 }, [ARCHIVO()], 'ana', T1), 404, /nota/i);
  falla(() => agregarAdjuntos(conNota, 99, {}, [ARCHIVO()], 'ana', T1), 404, /ticket/i);
  falla(() => agregarAdjuntos(conNota, 1, {}, [], 'ana', T1), 400, /archivo/i);
});

test('ubicarAdjunto y quitarAdjunto: de la descripción y de una nota, con evento y el adjunto quitado en la respuesta', () => {
  const { lista } = crear();
  const a = agregarAdjuntos(lista, 1, {}, [ARCHIVO('a.png')], 'ana', T0).lista; // historial: [creado, adjunto]
  const b = actualizarTicket(a, 1, { nota: 'x', adjuntos: [ARCHIVO('b.png')] }, 'beto', USUARIOS, T0).lista; // nota en índice 2
  assert.strictEqual(ubicarAdjunto(b[0], 1).nota, undefined);
  assert.strictEqual(ubicarAdjunto(b[0], 2).nota, 2);
  falla(() => ubicarAdjunto(b[0], 99), 404, /adjunto/i);

  const r1 = quitarAdjunto(b, 1, 1, 'ana', T1);
  assert.strictEqual(r1.adjunto.nombre, 'a.png');
  assert.strictEqual(r1.adjunto.archivo, 'u-a.png');
  assert.deepStrictEqual(r1.ticket.adjuntos, []);
  assert.deepStrictEqual(r1.ticket.historial.at(-1), { fecha: T1, usuario: 'ana', tipo: 'adjunto', accion: 'quitado', nombre: 'a.png' });

  const r2 = quitarAdjunto(b, 1, 2, 'beto', T1);
  assert.deepStrictEqual(r2.ticket.historial[2].adjuntos, []);
  assert.deepStrictEqual(r2.ticket.historial.at(-1), { fecha: T1, usuario: 'beto', tipo: 'adjunto', accion: 'quitado', nombre: 'b.png', nota: 2 });
  assert.strictEqual(r2.ticket.adjuntos.length, 1); // el de la descripción sigue
  falla(() => quitarAdjunto(b, 1, 99, 'ana', T1), 404, /adjunto/i);
  falla(() => quitarAdjunto(b, 99, 1, 'ana', T1), 404, /ticket/i);
});

test('ocultarRutas saca el nombre en disco de los adjuntos (ticket suelto, lista, descripción y notas) sin mutar', () => {
  const { lista } = crear();
  const a = agregarAdjuntos(lista, 1, {}, [ARCHIVO('a.png')], 'ana', T0).lista;
  const b = actualizarTicket(a, 1, { nota: 'x', adjuntos: [ARCHIVO('b.png')] }, 'beto', USUARIOS, T0).lista;
  const [pub] = ocultarRutas(b);
  assert.ok(!('archivo' in pub.adjuntos[0]));
  assert.ok(!('archivo' in pub.historial[2].adjuntos[0]));
  assert.strictEqual(pub.adjuntos[0].nombre, 'a.png');
  assert.ok('archivo' in b[0].adjuntos[0]);
  assert.ok(!('archivo' in ocultarRutas(b[0]).adjuntos[0]));
  assert.deepStrictEqual(ocultarRutas({ prioridades: [] }), { prioridades: [] });
});

test('validarArchivos saca de los nombres los caracteres de control y de formato (RTLO, ancho cero, separadores de línea)', () => {
  const nombre = n => validarArchivos([{ originalname: n, size: 1 }])[0].nombre;
  assert.strictEqual(nombre('factura‮gnp.png'), 'facturagnp.png'); // RTLO invierte lo que sigue: disfraza la extensión
  assert.strictEqual(nombre('a​b﻿c d e.pdf'), 'abcde.pdf');
  assert.strictEqual(nombre('tab\there.png'), 'tabhere.png');
  falla(() => nombre('‮​'), 400, /nombre/);
});

test('verificarDestino: 404 si no existe el ticket o la nota de destino; devuelve el índice del ticket', () => {
  const { lista } = crear();
  const conNota = actualizarTicket(lista, 1, { nota: 'hola' }, 'beto', USUARIOS, T1).lista;
  assert.strictEqual(verificarDestino(conNota, 1, {}), 0);
  assert.strictEqual(verificarDestino(conNota, 1, { nota: 1 }), 0);
  falla(() => verificarDestino(conNota, 99, {}), 404, /ticket/i);
  falla(() => verificarDestino(conNota, 1, { nota: 0 }), 404, /nota/i); // 0 es el evento "creado"
  falla(() => verificarDestino(conNota, 1, { nota: 9 }), 404, /nota/i);
  falla(() => verificarDestino(conNota, 1, { nota: 1.5 }), 404, /nota/i);
});

// ── Orden manual y destacado ────────────────────────────────────────────────
const tk = (id, prioridad, extra = {}) => ({ id, prioridad, creadoEn: T0, historial: [], actualizadoEn: T0, ...extra });
const ids = (lista, pri) => lista.filter(t => t.prioridad === pri)
  .sort((a, b) => a.orden - b.orden).map(t => t.id);

test('crearTicket: orden = máximo de toda la lista + 1', () => {
  assert.strictEqual(crear([{ id: 1, orden: 4 }, { id: 2, orden: 2 }]).ticket.orden, 5);
  assert.strictEqual(crear([{ id: 1, orden: 4 }, { id: 2 }]).ticket.orden, 6); // el viejo sin orden recibe 5
  assert.strictEqual(crear([]).ticket.orden, 1);
});

test('actualizarTicket: cambiar la prioridad manda al final del grupo nuevo; sin cambio no toca orden', () => {
  const lista = [tk(1, 'alta', { orden: 1, estado: 'pendiente', destinatarios: ['beto'] }), tk(2, 'baja', { orden: 7 })];
  assert.strictEqual(actualizarTicket(lista, 1, { prioridad: 'baja' }, 'ana', USUARIOS, T1).ticket.orden, 8);
  assert.strictEqual(actualizarTicket(lista, 1, { prioridad: 'alta', nota: 'x' }, 'ana', USUARIOS, T1).ticket.orden, 1);
});

test('reordenarTicket: antes de otro, renumera el grupo y deja las otras prioridades', () => {
  const lista = [tk(1, 'alta', { orden: 1 }), tk(2, 'alta', { orden: 2 }), tk(3, 'alta', { orden: 3 }), tk(4, 'baja', { orden: 9 })];
  const copia = JSON.parse(JSON.stringify(lista));
  const { lista: nueva } = reordenarTicket(lista, 3, 1);
  assert.deepStrictEqual(ids(nueva, 'alta'), [3, 1, 2]);
  assert.deepStrictEqual(nueva.filter(t => t.prioridad === 'alta').map(t => t.orden).sort(), [1, 2, 3]);
  assert.strictEqual(nueva[3], lista[3]);
  assert.deepStrictEqual(lista, copia); // sin mutar
  nueva.forEach((t, i) => { // sin historial ni actualizadoEn
    assert.strictEqual(t.actualizadoEn, T0);
    assert.deepStrictEqual(t.historial, lista[i].historial);
  });
});

test('reordenarTicket: al final, sin movimiento y mismo id devuelven igual', () => {
  const lista = [tk(1, 'alta', { orden: 1 }), tk(2, 'alta', { orden: 2 })];
  assert.deepStrictEqual(ids(reordenarTicket(lista, 1, null).lista, 'alta'), [2, 1]);
  assert.strictEqual(reordenarTicket(lista, 2, null).lista, lista);
  assert.strictEqual(reordenarTicket(lista, 1, 2).lista, lista);
  assert.strictEqual(reordenarTicket(lista, 1, 1).lista, lista);
});

test('reordenarTicket: tickets sin orden van al final por creadoEn e id', () => {
  const lista = [tk(1, 'alta', { creadoEn: T1 }), tk(2, 'alta'), tk(3, 'alta', { orden: 5 })];
  assert.deepStrictEqual(ids(reordenarTicket(lista, 1, 2).lista, 'alta'), [3, 1, 2]);
});

test('reordenarTicket: 404 inexistente y 400 otra prioridad', () => {
  const lista = [tk(1, 'alta'), tk(2, 'baja')];
  falla(() => reordenarTicket(lista, 9, null), 404);
  falla(() => reordenarTicket(lista, 1, 9), 404);
  falla(() => reordenarTicket(lista, 1, 2), 400, /misma prioridad/);
});

test('destacarTicket: cambia solo destacado, valida booleano y 404', () => {
  const lista = [tk(1, 'alta', { orden: 3 })];
  const copia = JSON.parse(JSON.stringify(lista));
  const { lista: nueva, ticket } = destacarTicket(lista, 1, true);
  assert.deepStrictEqual(ticket, { ...lista[0], destacado: true });
  assert.deepStrictEqual(nueva, [ticket]);
  assert.deepStrictEqual(lista, copia);
  falla(() => destacarTicket(lista, 1, 'si'), 400, /verdadero o falso/);
  falla(() => destacarTicket(lista, 9, false), 404);
});

test('lista vieja sin orden: el nuevo y el que cambia de prioridad quedan últimos; los viejos conservan su orden', () => {
  const viejos = [tk(2, 'alta', { creadoEn: T1 }), tk(1, 'alta'), tk(3, 'baja', { estado: 'pendiente', destinatarios: ['beto'] })];
  const copia = JSON.parse(JSON.stringify(viejos));
  const { lista } = crear(viejos, { prioridad: 'alta' });
  assert.deepStrictEqual(ids(lista, 'alta'), [1, 2, 4]);
  lista.slice(0, 3).forEach((t, i) => assert.deepStrictEqual(t.historial, viejos[i].historial));
  const { lista: l2 } = actualizarTicket(viejos, 3, { prioridad: 'alta' }, 'ana', USUARIOS, T1);
  assert.deepStrictEqual(ids(l2, 'alta'), [1, 2, 3]);
  assert.strictEqual(l2[0].actualizadoEn, T0);
  assert.deepStrictEqual(viejos, copia);
});

test('asignarFecha: válida, null, formato inválido, fecha imposible, 404 y no muta', () => {
  const lista = [tk(1, 'alta', { orden: 3 })];
  const copia = JSON.parse(JSON.stringify(lista));
  const { lista: nueva, ticket } = asignarFecha(lista, 1, '2026-12-01');
  assert.deepStrictEqual(ticket, { ...lista[0], fecha: '2026-12-01' });
  assert.deepStrictEqual(nueva, [ticket]);
  assert.deepStrictEqual(lista, copia);
  assert.strictEqual(asignarFecha(nueva, 1, null).ticket.fecha, null);
  for (const mala of ['2026-2-1', '01/12/2026', '2026-12-01T00:00', '', 20261201, undefined]) falla(() => asignarFecha(lista, 1, mala), 400);
  falla(() => asignarFecha(lista, 1, '2026-02-30'), 400);
  falla(() => asignarFecha(lista, 1, '2026-13-01'), 400);
  falla(() => asignarFecha(lista, 9, '2026-12-01'), 404);
});

test('crearTicket: nace con fecha null; areasCerradas rechaza fuera de lista', () => {
  assert.deepStrictEqual(AREAS_MANTENIMIENTO, ['Mantenimiento', 'Sistemas']);
  assert.strictEqual(crear().ticket.fecha, null);
  const op = { areasCerradas: AREAS_MANTENIMIENTO };
  falla(() => crearTicket([], { ...BASE, area: 'Plomería' }, 'ana', USUARIOS, T0, op), 400, /área/);
  for (const area of AREAS_MANTENIMIENTO) assert.strictEqual(crearTicket([], { ...BASE, area }, 'ana', USUARIOS, T0, op).ticket.area, area);
  assert.strictEqual(crear([], { area: 'Libre' }).ticket.area, 'Libre');
});

test('validarResponsables: normaliza login y área, usuario inexistente, área vacía/larga, repetidos, etiqueta repetida, vacío, >30 y no muta', () => {
  const { validarResponsables } = require('../lib/tickets');
  const validos = ['Adriel', 'beto'];
  const entrada = [{ usuario: 'ADRIEL', area: ' Sistema (Soporte) ' }, { usuario: 'beto', area: 'Plomería' }];
  const copia = JSON.parse(JSON.stringify(entrada));
  assert.deepStrictEqual(validarResponsables(entrada, validos),
    [{ usuario: 'Adriel', area: 'Sistema (Soporte)', etiqueta: 'Adriel / Sistema (Soporte)' }, { usuario: 'beto', area: 'Plomería', etiqueta: 'beto / Plomería' }]);
  assert.deepStrictEqual(entrada, copia);
  falla(() => validarResponsables([{ usuario: 'nadie', area: 'A' }], validos), 400, /usuario/);
  falla(() => validarResponsables([{ area: 'A' }], validos), 400, /usuario/);
  falla(() => validarResponsables([{ usuario: 'beto', area: '  ' }], validos), 400, /área/);
  falla(() => validarResponsables([{ usuario: 'beto', area: 'x'.repeat(81) }], validos), 400, /80/);
  falla(() => validarResponsables([{ usuario: 'beto', area: 'A' }, { usuario: 'BETO', area: 'a ' }], validos), 400, /repetidos/);
  const mismos = [{ usuario: 'Adriel', nombre: 'Ana' }, { usuario: 'beto', nombre: 'Ana' }];
  falla(() => validarResponsables([{ usuario: 'Adriel', area: 'A' }, { usuario: 'beto', area: 'A' }], validos, mismos), 400, /etiqueta/);
  // previos: mismo usuario+área (sin mayúsculas) conserva la etiqueta guardada; el resto se calcula; repetidas sobre las finales.
  const previos = [{ usuario: 'Adriel', area: 'A', etiqueta: 'Viejo / A' }, { usuario: null, area: 'B', etiqueta: 'B' }];
  assert.deepStrictEqual(validarResponsables([{ usuario: 'adriel', area: 'a' }, { usuario: 'beto', area: 'B' }], validos, [], previos)
    .map(p => p.etiqueta), ['Viejo / A', 'beto / B']);
  falla(() => validarResponsables([{ usuario: 'Adriel', area: 'A' }, { usuario: 'beto', area: 'A' }], validos,
    [{ usuario: 'beto', nombre: 'Viejo' }], previos), 400, /etiqueta/);
  falla(() => validarResponsables(['Sistemas'], validos), 400);
  falla(() => validarResponsables([], validos), 400);
  falla(() => validarResponsables(undefined, validos), 400);
  const muchos = n => Array.from({ length: n }, (_, i) => ({ usuario: 'beto', area: `A${i}` }));
  falla(() => validarResponsables(muchos(31), validos), 400, /30/);
  assert.strictEqual(validarResponsables(muchos(30), validos).length, 30);
});

test('etiquetaResponsable y normalizarResponsables: con cuenta, sin cuenta y legados', () => {
  const { etiquetaResponsable, normalizarResponsables } = require('../lib/tickets');
  const usuarios = [{ usuario: 'Adriel', nombre: 'Adriel' }];
  assert.strictEqual(etiquetaResponsable({ usuario: 'adriel', area: 'Sistema (Soporte)' }, usuarios), 'Adriel / Sistema (Soporte)');
  assert.strictEqual(etiquetaResponsable({ usuario: 'gone', area: 'Gas' }, usuarios), 'gone / Gas');
  assert.strictEqual(etiquetaResponsable('Sistemas', usuarios), 'Sistemas');
  assert.deepStrictEqual(normalizarResponsables(['Sistemas', { usuario: 'Adriel', area: 'X' }], usuarios), [
    { usuario: null, area: 'Sistemas', etiqueta: 'Sistemas' },
    { usuario: 'Adriel', area: 'X', etiqueta: 'Adriel / X' },
  ]);
  assert.deepStrictEqual(normalizarResponsables([{ usuario: 'Adriel', area: 'X', etiqueta: 'Vieja / X' }, { usuario: 'Adriel', area: 'Y', etiqueta: '' }], usuarios)
    .map(r => r.etiqueta), ['Vieja / X', 'Adriel / Y']);
  falla(() => normalizarResponsables({}, usuarios), 400);
  falla(() => normalizarResponsables([1], usuarios), 400);
});
