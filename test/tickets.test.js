'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  PRIORIDADES, ESTADOS, ESTADOS_ETAPA, AREAS, crearTicket, actualizarTicket,
  agregarEtapa, actualizarEtapa, eliminarEtapa, recalcularEstado,
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
    destinatarios: ['beto'], estado: 'pendiente', creadoPor: 'ana', creadoEn: T0, actualizadoEn: T0, etapas: [],
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
