'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { PRIORIDADES, ESTADOS, AREAS, crearTicket, actualizarTicket } = require('../lib/tickets');

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
    destinatarios: ['beto'], estado: 'pendiente', creadoPor: 'ana', creadoEn: T0, actualizadoEn: T0,
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
  falla(() => crear([], { destinatarios: ['zoe'] }), 400, /zoe/);
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
  falla(() => actualizarTicket(l0, 1, { destinatarios: ['zoe'] }, 'ana', USUARIOS, T1), 400, /zoe/);
  falla(() => actualizarTicket(l0, 99, { estado: 'terminado' }, 'ana', USUARIOS, T1), 404);
});
