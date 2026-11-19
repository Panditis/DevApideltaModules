'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { armarCentroControl } = require('../lib/vencimientos_centro');

const HOY = '2026-11-19';
const CONFIG = { diasMaxOferta: 10, diasMaxVencido: 10, tipoOferta: 'PARA OFERTA', tipoOfertaVencida: 'OFERTA VENCIDO' };
const col = (extra = {}) => ({ unidades: 10, vendido: 0, vencido: 0, oferta: 0, movimientos: [{ tipo: 'alta', unidades: 10, fecha: '2026-11-18T10:00:00.000Z' }], ...extra });
const lote = (id, vencimiento, sucursales, idProducto = id) => ({ id: `l${id}`, idProducto, nombre: `Prod ${id}`, vencimiento, sucursales });

test('ventanas 7/15/30, 40 días fuera, vencido con pendiente 0 no cuenta, ficticias fuera', () => {
  const r = armarCentroControl([
    lote(1, '2026-11-25', { 1: col() }),           // 6 días
    lote(2, '2026-12-01', { 1: col() }),           // 12
    lote(3, '2026-12-14', { 1: col() }),           // 25
    lote(4, '2026-12-29', { 1: col() }),           // 40
    lote(5, '2026-11-01', { 1: col({ vendido: 10 }) }), // vencido cerrado
    lote(6, '2026-11-20', { 6: col(), 8: col(), 11: col() }),
  ], CONFIG, HOY, {}, { 1: 'Centro' });
  const p = r.proximos.porSucursal;
  assert.deepStrictEqual(p, [{ idSucursal: 1, nombre: 'Centro', v7: { lotes: 1, unidades: 10 }, v15: { lotes: 2, unidades: 20 }, v30: { lotes: 3, unidades: 30 } }]);
  assert.deepStrictEqual(r.proximos.urgentes.map(u => u.dias), [6, 12, 25]);
  assert.deepStrictEqual(r.proximos.urgentes[0], { idSucursal: 1, nombre: 'Centro', producto: 'Prod 1', plu: '1', fecha: '2026-11-25', dias: 6, unidades: 10 });
  assert.strictEqual(r.kpis.unidadesRiesgo, 10);
  assert.strictEqual(r.kpis.lotesActivos, 4);
  assert.strictEqual(r.vencidos.lotes.length, 0);
  assert.ok(!JSON.stringify(r).includes('"idSucursal":6'));
});

test('vencidos sin resolver, atrasados, unidades registradas y pendientes de decisión', () => {
  const r = armarCentroControl([
    lote(1, '2026-11-01', { 2: col({ vendido: 4 }) }), // 18 días atraso, pendiente 6 -> atrasado vencido
    lote(2, '2026-11-15', { 2: col() }),               // 4 días, no atrasado
    lote(3, '2026-12-30', { 1: col({ ofertasSistema: [{ numeroMovimiento: 9, fecha: '2026-11-01', cantidad: 3 }] }) }),
    lote(4, '2026-10-01', { 1: col({ vencido: 2, vendido: 8, vencidosSistema: [{ numeroMovimiento: 5, fecha: '2026-10-02', cantidad: 1 }], origenSistema: true }) }),
  ], CONFIG, HOY, null);
  assert.deepStrictEqual(r.vencidos.lotes.map(l => [l.plu, l.diasAtraso, l.unidades]), [['1', 18, 6], ['2', 4, 10]]);
  assert.deepStrictEqual(r.atrasados.map(a => [a.plu, a.tipo, a.dias, a.falta]), [['1', 'OFERTA VENCIDO', 18, 'Asignar'], ['3', 'PARA OFERTA', 18, 'Cerrar']]);
  assert.deepStrictEqual(r.vencidos.unidadesRegistradas.map(u => [u.idSucursal, u.unidades]), [[1, 3], [2, 0]]);
  assert.deepStrictEqual(r.pendientes.map(p => [p.plu, p.tipo, p.estado, p.origenSistema]), [['3', 'Oferta', null, false], ['4', 'Vencido', null, true]]);
  assert.strictEqual(r.vencidos.lotes[0].nombre, 'Sucursal 2');
  assert.deepStrictEqual(r.sinLote, { disponible: false, porSucursal: [] });
  assert.strictEqual(r.kpis.sinLote, null);
});

test('ranking 90 días desempata por lotes sin resolver; merma y top productos', () => {
  const venc = (cant, fecha) => ({ tipo: 'vencido', cantidad: cant, fecha: `${fecha}T12:00:00.000Z` });
  const r = armarCentroControl([
    lote(1, '2027-01-01', { 1: col({ vencido: 5, vendido: 5, movimientos: [venc(5, '2026-11-01')] }), 2: col({ vencido: 5, vendido: 15, unidades: 20, movimientos: [venc(5, '2026-10-01')] }) }),
    lote(2, '2026-11-10', { 2: col() }),
    lote(3, '2027-01-01', { 3: col({ vencido: 9, movimientos: [venc(9, '2026-01-01')] }) }), // fuera de 90 días
  ], CONFIG, HOY, {});
  assert.deepStrictEqual(r.ranking.map(x => [x.idSucursal, x.unidadesVencidas, x.lotesSinResolver]), [[2, 5, 1], [1, 5, 0], [3, 0, 0]]);
  assert.deepStrictEqual(r.merma.map(m => [m.idSucursal, m.pct]), [[1, 50], [2, 25], [3, 100]]);
  assert.deepStrictEqual(r.topProductos, [{ producto: 'Prod 1', plu: '1', unidades: 10 }, { producto: 'Prod 3', plu: '3', unidades: 9 }]);
});

test('cumplimiento: alerta a más de 7 días o sin actividad; sin lote por sucursal', () => {
  const r = armarCentroControl([
    lote(1, '2027-01-01', { 1: col() }),
    lote(2, '2027-01-01', { 2: col({ movimientos: [{ tipo: 'alta', fecha: '2026-11-01T10:00:00.000Z' }] }) }),
  ], CONFIG, HOY, { 1: [{ fecha: '2026-11-10' }, { fecha: '2026-11-17' }], 3: [], 11: [{ fecha: '2026-11-10' }] });
  assert.deepStrictEqual(r.cumplimiento.diasLimite, 7);
  assert.deepStrictEqual(r.cumplimiento.porSucursal.map(c => [c.idSucursal, c.ultimaActividad, c.diasSinActividad]), [[1, '2026-11-18', 1], [2, '2026-11-01', 18], [3, null, null]]);
  assert.strictEqual(r.kpis.sucursalesSinCarga, 2);
  assert.deepStrictEqual(r.sinLote.porSucursal.map(s => [s.idSucursal, s.cantidad, s.antiguedadMax]), [[1, 2, 9], [3, 0, 0]]);
  assert.strictEqual(r.kpis.sinLote, 2);
});

test('tendencia: 6 meses hasta el actual con vencidos manuales y de SIGA', () => {
  const r = armarCentroControl([
    lote(1, '2027-01-01', { 1: col({ vencido: 2, movimientos: [{ tipo: 'vencido', cantidad: 2, fecha: '2026-06-03T10:00:00.000Z' }], vencidosSistema: [{ fecha: '2026-11-02', cantidad: 3 }] }) }),
  ], CONFIG, HOY, {});
  assert.deepStrictEqual(r.tendencia, [['2026-06', 2], ['2026-07', 0], ['2026-08', 0], ['2026-09', 0], ['2026-10', 0], ['2026-11', 3]].map(([mes, unidades]) => ({ mes, unidades })));
});

test('sin datos: bloques vacíos', () => {
  const r = armarCentroControl([], CONFIG, HOY, {});
  assert.deepStrictEqual([r.ranking, r.vencidos.lotes, r.topProductos, r.pendientes, r.atrasados], [[], [], [], [], []]);
  assert.strictEqual(r.tendencia.length, 6);
  assert.strictEqual(r.kpis.lotesActivos, 0);
});

test('enOferta: en plazo, por vencer, atrasada; ficticia, pendiente 0 y vencido SIGA fuera', () => {
  const of = fecha => [{ numeroMovimiento: 1, fecha: `${fecha}T09:00:00`, cantidad: 4 }];
  const r = armarCentroControl([
    lote(1, '2026-12-30', { 1: col({ ofertasSistema: of('2026-11-17') }) }),
    lote(2, '2026-12-30', { 2: col({ ofertasSistema: of('2026-11-10') }) }),
    lote(3, '2026-12-30', { 3: col({ ofertasSistema: of('2026-11-01') }) }),
    lote(4, '2026-12-30', { 6: col({ ofertasSistema: of('2026-11-01') }) }),
    lote(5, '2026-12-30', { 1: col({ vendido: 10, ofertasSistema: of('2026-11-01') }) }),
    lote(6, '2026-12-30', { 1: col({ ofertasSistema: of('2026-11-01'), vencidosSistema: [{ fecha: '2026-11-15', cantidad: 2 }] }) }),
  ], CONFIG, HOY, null);
  assert.deepStrictEqual(r.enOferta.map(e => [e.plu, e.estado, e.diasEnOferta]), [['3', 'atrasada', 18], ['2', 'por-vencer-plazo', 9], ['1', 'en-plazo', 2]]);
  assert.deepStrictEqual(r.enOferta[2], { idSucursal: 1, nombre: 'Sucursal 1', producto: 'Prod 1', plu: '1', vence: '2026-12-30', diasVencido: null,
    fechaOferta: '2026-11-17', diasEnOferta: 2, diasMaxOferta: 10, unidadesOferta: 4, pendiente: 10, estado: 'en-plazo' });
  assert.ok(r.atrasados.some(a => a.plu === '3'));
});

test('enOferta: vencidas con oferta abierta entran primero; sin oferta, con OFERTA VENCIDO o pendiente 0 fuera', () => {
  const of = fecha => [{ numeroMovimiento: 1, fecha: `${fecha}T09:00:00`, cantidad: 4 }];
  const r = armarCentroControl([
    lote(1, '2026-12-30', { 1: col({ ofertasSistema: of('2026-11-01') }) }),           // atrasada
    lote(2, '2026-11-17', { 1: col({ ofertasSistema: of('2026-11-15') }) }),           // vencida hace 2
    lote(3, '2026-11-14', { 1: col({ ofertasSistema: of('2026-11-01') }) }),           // vencida hace 5 y > diasMaxOferta
    lote(4, '2026-11-14', { 1: col() }),                                               // sin oferta
    lote(5, '2026-11-14', { 1: col({ ofertasSistema: of('2026-11-01'), vencidosSistema: [{ fecha: '2026-11-15', cantidad: 2 }] }) }),
    lote(6, '2026-11-14', { 1: col({ vendido: 10, ofertasSistema: of('2026-11-01') }) }),
  ], CONFIG, HOY, null);
  assert.deepStrictEqual(r.enOferta.map(e => [e.plu, e.estado, e.diasVencido, e.vence]),
    [['3', 'vencida', 5, '2026-11-14'], ['2', 'vencida', 2, '2026-11-17'], ['1', 'atrasada', null, '2026-12-30']]);
});

test('enOferta sin datos: []', () => {
  assert.deepStrictEqual(armarCentroControl([], CONFIG, HOY, null).enOferta, []);
});

test('proximos.lotes: orden por fecha y producto; fuera ficticias, pendiente 0 y vencidos', () => {
  const r = armarCentroControl([
    lote(1, '2026-12-01', { 1: col({ vendido: 3 }) }),
    lote(2, '2026-11-25', { 2: col() }),
    { ...lote(3, '2026-12-01', { 1: col() }), nombre: 'Aaa' },
    lote(4, '2026-11-20', { 6: col(), 8: col(), 11: col() }),
    lote(5, '2026-11-22', { 1: col({ vendido: 10 }) }),
    lote(6, '2026-11-10', { 1: col() }),
    lote(7, '2026-11-19', { 1: col() }),
  ], CONFIG, HOY, {});
  assert.deepStrictEqual(r.proximos.lotes, [
    { idSucursal: 1, producto: 'Prod 7', plu: '7', fecha: '2026-11-19', dias: 0, unidadesCargadas: 10, pendiente: 10 },
    { idSucursal: 2, producto: 'Prod 2', plu: '2', fecha: '2026-11-25', dias: 6, unidadesCargadas: 10, pendiente: 10 },
    { idSucursal: 1, producto: 'Aaa', plu: '3', fecha: '2026-12-01', dias: 12, unidadesCargadas: 10, pendiente: 10 },
    { idSucursal: 1, producto: 'Prod 1', plu: '1', fecha: '2026-12-01', dias: 12, unidadesCargadas: 10, pendiente: 7 },
  ]);
});

test('proximos.lotes sin datos: []', () => {
  assert.deepStrictEqual(armarCentroControl([], CONFIG, HOY, {}).proximos.lotes, []);
});

test('cortes: proximos.lotes a 3000 por sucursal conservando los más próximos; topProductos y enOferta a 500', () => {
  const fechas = ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'];
  const proximos = [
    ...Array.from({ length: 3100 }, (_, i) => lote(i + 1, fechas[i % 4], { 1: col() })),
    ...Array.from({ length: 100 }, (_, i) => lote(5000 + i, '2026-12-15', { 2: col() })),
  ];
  const r1 = armarCentroControl(proximos, CONFIG, HOY, {});
  assert.strictEqual(r1.proximos.lotes.length, 3100);
  const s1 = r1.proximos.lotes.filter(l => l.idSucursal === 1);
  assert.strictEqual(s1.length, 3000);
  // 775 por fecha: entran las 3 primeras completas y 675 de la última.
  const cuenta = f => s1.filter(l => l.fecha === f).length;
  assert.deepStrictEqual(fechas.map(cuenta), [775, 775, 775, 675]);
  // La sucursal 2 (fechas lejanas) queda completa.
  assert.strictEqual(r1.proximos.lotes.filter(l => l.idSucursal === 2).length, 100);
  assert.deepStrictEqual(r1.proximos.lotes.map(l => l.fecha), [...r1.proximos.lotes.map(l => l.fecha)].sort());

  const vencidos = Array.from({ length: 600 }, (_, i) => lote(i + 1, '2026-10-01', { 1: col({ vencido: i + 1, vendido: 9 - Math.min(i, 9) }) }));
  const r2 = armarCentroControl(vencidos, CONFIG, HOY, {});
  assert.strictEqual(r2.topProductos.length, 500);
  assert.strictEqual(r2.topProductos[0].unidades, 600);
  assert.strictEqual(r2.topProductos[499].unidades, 101);

  const ofertas = Array.from({ length: 600 }, (_, i) => lote(i + 1, '2026-12-30', { 1: col({ ofertasSistema: [{ numeroMovimiento: i, fecha: '2026-11-01', cantidad: 1 }] }) }));
  const r3 = armarCentroControl(ofertas, CONFIG, HOY, {});
  assert.strictEqual(r3.enOferta.length, 500);
  assert.ok(r3.enOferta.every(o => o.estado === 'atrasada' && o.diasEnOferta === 18));
});
