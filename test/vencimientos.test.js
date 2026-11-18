const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore, ofertaEstado, vencidoEstado, vistaLote, semaforo, validarUmbrales, estadoSucursal, pendiente, UMBRALES_DEFAULT } = require('../lib/vencimientos');

function nuevoStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venc-'));
  const rutaDatos = path.join(dir, 'vencimientos.json');
  const rutaConfig = path.join(dir, 'vencimientos_config.json');
  return { store: crearStore({ rutaDatos, rutaConfig }), rutaDatos, rutaConfig, dir };
}

const ALTA = { idProducto: 10, vencimiento: '2026-12-31', idSucursal: 1, unidades: 20, usuario: 'ana' };

test('alta de lote nuevo y suma de columna de otra sucursal sin duplicar fila', async () => {
  const { store } = nuevoStore();
  const l1 = await store.altaLote(ALTA);
  const l2 = await store.altaLote({ ...ALTA, idSucursal: 2, unidades: 5, usuario: 'beto' });
  assert.strictEqual(l1.id, l2.id);
  const lotes = await store.listarLotes();
  assert.strictEqual(lotes.length, 1);
  assert.deepStrictEqual(Object.keys(lotes[0].sucursales).sort(), ['1', '2']);
  assert.strictEqual(lotes[0].sucursales['2'].unidades, 5);
  assert.strictEqual(lotes[0].sucursales['2'].movimientos[0].usuario, 'beto');
});

test('misma sucursal mismo lote: 409', async () => {
  const { store } = nuevoStore();
  await store.altaLote(ALTA);
  await assert.rejects(store.altaLote(ALTA), e => e.status === 409);
});

test('validaciones de alta y sucursales no reales', async () => {
  const { store } = nuevoStore();
  await assert.rejects(store.altaLote({ ...ALTA, vencimiento: '2026-02-30' }), e => e.status === 400);
  await assert.rejects(store.altaLote({ ...ALTA, unidades: 0 }), e => e.status === 400);
  await assert.rejects(store.altaLote({ ...ALTA, usuario: ' ' }), e => e.status === 400);
  for (const s of [6, 8, 11]) await assert.rejects(store.altaLote({ ...ALTA, idSucursal: s }), /no es real/);
});

test('no muta la entrada', async () => {
  const { store } = nuevoStore();
  const entrada = { ...ALTA };
  const copia = JSON.stringify(entrada);
  await store.altaLote(entrada);
  assert.strictEqual(JSON.stringify(entrada), copia);
});

test('movimientos oferta/vendido separados, <= unidades, con fecha y usuario; estado cerrado', async () => {
  const { store } = nuevoStore();
  const { id } = await store.altaLote(ALTA);
  await store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'oferta', cantidad: 20, usuario: 'ana' });
  await store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'vendido', cantidad: 15, usuario: 'ana' });
  await assert.rejects(store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'oferta', cantidad: 1, usuario: 'ana' }), /supera/);
  await assert.rejects(store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'vendido', cantidad: 6, usuario: 'ana' }), /supera/);
  await assert.rejects(store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'otro', cantidad: 1, usuario: 'ana' }), e => e.status === 400);
  let col = (await store.listarLotes())[0].sucursales['1'];
  assert.strictEqual(estadoSucursal(col), 'cargado');
  const ult = col.movimientos.at(-1);
  assert.ok(ult.fecha && ult.usuario === 'ana');
  await store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'vendido', cantidad: 5, usuario: 'ana' });
  col = (await store.listarLotes())[0].sucursales['1'];
  assert.strictEqual(estadoSucursal(col), 'cerrado');
});

test('corrección de unidades con registro y baja de lote', async () => {
  const { store } = nuevoStore();
  const { id } = await store.altaLote(ALTA);
  await store.registrarMovimiento({ idLote: id, idSucursal: 1, tipo: 'vendido', cantidad: 8, usuario: 'ana' });
  await assert.rejects(store.corregirUnidades({ idLote: id, idSucursal: 1, unidades: 7, usuario: 'ana' }), e => e.status === 400);
  const l = await store.corregirUnidades({ idLote: id, idSucursal: 1, unidades: 12, usuario: 'ana' });
  assert.deepStrictEqual(
    { ...l.sucursales['1'].movimientos.at(-1), fecha: undefined },
    { tipo: 'correccion', anterior: 20, unidades: 12, usuario: 'ana', fecha: undefined });
  await assert.rejects(store.corregirUnidades({ idLote: id, idSucursal: 2, unidades: 1, usuario: 'x' }), e => e.status === 404);
  await store.bajaLote(id);
  assert.strictEqual((await store.listarLotes()).length, 0);
  await assert.rejects(store.bajaLote(id), e => e.status === 404);
});

test('semáforo en bordes con umbrales default', () => {
  const hoy = '2026-11-17';
  assert.strictEqual(semaforo('2026-11-16', hoy), 'rojo'); // vencido
  assert.strictEqual(semaforo('2026-12-02', hoy), 'rojo'); // 15
  assert.strictEqual(semaforo('2026-12-03', hoy), 'amarillo'); // 16
  assert.strictEqual(semaforo('2027-01-01', hoy), 'amarillo'); // 45
  assert.strictEqual(semaforo('2027-01-02', hoy), 'verde'); // 46
});

test('umbrales: inválidos rechazados, válidos persistidos', async () => {
  for (const u of [{ rojo: 45, amarillo: 15 }, { rojo: 10, amarillo: 10 }, { rojo: -1, amarillo: 5 }, { rojo: 1.5, amarillo: 5 }, null]) {
    assert.throws(() => validarUmbrales(u), e => e.status === 400);
  }
  const { store } = nuevoStore();
  assert.deepStrictEqual((await store.leerConfig()).umbrales, { ...UMBRALES_DEFAULT });
  await store.guardarConfig({ umbrales: { rojo: 7, amarillo: 30 } });
  assert.deepStrictEqual((await store.leerConfig()).umbrales, { rojo: 7, amarillo: 30 });
});

test('concurrencia: altas simultáneas no pierden datos', async () => {
  const { store, rutaDatos } = nuevoStore();
  const N = 30;
  await Promise.all(Array.from({ length: N }, (_, i) => store.altaLote({ ...ALTA, idProducto: i + 1 })));
  assert.strictEqual(JSON.parse(fs.readFileSync(rutaDatos, 'utf8')).lotes.length, N);
});

test('JSON válido tras falla: op que falla no toca el archivo, tmp huérfano no afecta', async () => {
  const { store, rutaDatos } = nuevoStore();
  await store.altaLote(ALTA);
  const antes = fs.readFileSync(rutaDatos, 'utf8');
  fs.writeFileSync(`${rutaDatos}.huerfano.tmp`, '{"lotes": [ {"id": ');
  await assert.rejects(store.altaLote(ALTA));
  assert.strictEqual(fs.readFileSync(rutaDatos, 'utf8'), antes);
  await store.altaLote({ ...ALTA, idSucursal: 3 });
  assert.strictEqual(JSON.parse(fs.readFileSync(rutaDatos, 'utf8')).lotes[0].sucursales['3'].unidades, 20);
});

test('alta guarda snapshot opcional de nombre/código y valida largo', async () => {
  const { store } = nuevoStore();
  const l = await store.altaLote({ ...ALTA, nombre: ' Yerba 1kg ', codigo: 'A10' });
  assert.strictEqual(l.nombre, 'Yerba 1kg');
  assert.strictEqual(l.codigo, 'A10');
  const sin = await store.altaLote({ ...ALTA, idProducto: 11 });
  assert.ok(!('nombre' in sin));
  await assert.rejects(store.altaLote({ ...ALTA, idProducto: 12, nombre: 'x'.repeat(201) }), e => e.status === 400);
});

test('vencido: suma con vendido <= unidades, pendiente y cierre', async () => {
  const { store } = nuevoStore();
  const l = await store.altaLote({ ...ALTA, unidades: 10 });
  const mov = tipo => cantidad => store.registrarMovimiento({ idLote: l.id, idSucursal: 1, tipo, cantidad, usuario: 'ana' });
  await mov('vendido')(6);
  await assert.rejects(mov('vencido')(5), e => e.status === 400);
  const r = await mov('vencido')(3);
  assert.strictEqual(r.sucursales['1'].vencido, 3);
  assert.strictEqual(pendiente(r.sucursales['1']), 1);
  assert.strictEqual(r.sucursales['1'].movimientos.at(-1).tipo, 'vencido');
  await assert.rejects(mov('vendido')(2), e => e.status === 400);
  const c = await mov('vendido')(1);
  assert.strictEqual(estadoSucursal(c.sucursales['1']), 'cerrado');
  await assert.rejects(store.corregirUnidades({ idLote: l.id, idSucursal: 1, unidades: 9, usuario: 'ana' }), e => e.status === 400);
});

test('lote viejo sin vencido: pendiente y registrar vencido funcionan', async () => {
  const { store, rutaDatos } = nuevoStore();
  const viejo = { id: '00000000-0000-0000-0000-000000000001', idProducto: 1, vencimiento: '2030-01-01', creado: 'x',
    sucursales: { 1: { unidades: 5, vendido: 2, oferta: 0, movimientos: [] } } };
  fs.writeFileSync(rutaDatos, JSON.stringify({ lotes: [viejo] }));
  assert.strictEqual(pendiente(viejo.sucursales[1]), 3);
  const r = await store.registrarMovimiento({ idLote: viejo.id, idSucursal: 1, tipo: 'vencido', cantidad: 3, usuario: 'ana' });
  assert.strictEqual(estadoSucursal(r.sucursales['1']), 'cerrado');
});

test('config diasMaxOferta: default 10, valida 1..365, parcial', async () => {
  const { store } = nuevoStore();
  assert.strictEqual((await store.leerConfig()).diasMaxOferta, 10);
  for (const v of [0, 366, 'x', 1.5]) assert.throws(() => store.guardarConfig({ diasMaxOferta: v }), e => e.status === 400);
  const c = await store.guardarConfig({ diasMaxOferta: 60 });
  assert.strictEqual(c.diasMaxOferta, 60);
  const c2 = await store.guardarConfig({ margenDias: 3 });
  assert.strictEqual(c2.diasMaxOferta, 60);
});

test('ofertasSistema: varios por registro, idempotente, 409 otro registro, quitar uno libera', async () => {
  const { store } = nuevoStore();
  const a = await store.altaLote(ALTA);
  const b = await store.altaLote({ ...ALTA, vencimiento: '2027-01-31' });
  const m77 = { numeroMovimiento: 77, fecha: '2026-11-10', cantidad: 4 };
  const m78 = { numeroMovimiento: 78, fecha: '2026-11-11', cantidad: 2 };
  const asignar = (idLote, m, confirmacion = 'ok') => store.asignarOfertaSistema({ idLote, idSucursal: 1, movimiento: m, confirmacion, usuario: 'ana' });
  const quitar = (idLote, numeroMovimiento) => store.quitarOfertaSistema({ idLote, idSucursal: 1, numeroMovimiento, usuario: 'ana' });
  await asignar(a.id, m77);
  const r = await asignar(a.id, m78);
  const col = r.sucursales['1'];
  assert.deepStrictEqual(col.ofertasSistema.map(o => o.numeroMovimiento), [77, 78]);
  assert.strictEqual(col.ofertasSistema[0].usuario, 'ana');
  assert.strictEqual(col.oferta, 0, 'no toca la oferta manual');
  const hist = col.movimientos.filter(m => m.tipo === 'oferta-sistema');
  assert.deepStrictEqual(hist.map(m => [m.numeroMovimiento, m.cantidad, m.usuario]), [[77, 4, 'ana'], [78, 2, 'ana']]);
  const again = await store.asignarOfertaSistema({ idLote: a.id, idSucursal: 1, movimiento: m77, usuario: 'ana' });
  assert.strictEqual(again.sucursales['1'].movimientos.length, col.movimientos.length);
  assert.strictEqual(again.sucursales['1'].ofertasSistema.length, 2);
  await assert.rejects(asignar(b.id, m77), e => e.status === 409);
  const q = await quitar(a.id, 77);
  assert.deepStrictEqual(q.sucursales['1'].ofertasSistema.map(o => o.numeroMovimiento), [78]);
  assert.deepStrictEqual(q.sucursales['1'].movimientos.at(-1), { ...q.sucursales['1'].movimientos.at(-1), tipo: 'oferta-sistema-quitada', numeroMovimiento: 77 });
  await assert.rejects(quitar(a.id, 77), e => e.status === 404);
  assert.deepStrictEqual((await asignar(b.id, m77)).sucursales['1'].ofertasSistema.map(o => o.numeroMovimiento), [77]);
  await asignar(a.id, { ...m77, numeroMovimiento: 79 });
  const todos = await quitar(a.id);
  assert.deepStrictEqual(todos.sucursales['1'].ofertasSistema, []);
  assert.strictEqual(todos.sucursales['1'].movimientos.filter(m => m.tipo === 'oferta-sistema-quitada').length, 3);
  await assert.rejects(quitar(a.id), e => e.status === 404);
});

test('migración: ofertaSistema objeto viejo se lee como array y se persiste sin la clave vieja', async () => {
  const { store, rutaDatos } = nuevoStore();
  const a = await store.altaLote(ALTA);
  const crudo = JSON.parse(fs.readFileSync(rutaDatos, 'utf8'));
  const vieja = { numeroMovimiento: 5, fecha: '2026-11-01', cantidad: 3, asignado: 'x', usuario: 'ana' };
  const col = crudo.lotes[0].sucursales['1'];
  delete col.ofertasSistema;
  col.ofertaSistema = vieja;
  fs.writeFileSync(rutaDatos, JSON.stringify(crudo));
  const [l] = await store.listarLotes();
  assert.deepStrictEqual(l.sucursales['1'].ofertasSistema, [vieja]);
  assert.ok(!('ofertaSistema' in l.sucursales['1']));
  await assert.rejects(store.altaLote({ ...ALTA, vencimiento: '2027-02-01' }).then(b => store.asignarOfertaSistema({ idLote: b.id, idSucursal: 1, movimiento: vieja, confirmacion: 'ok', usuario: 'ana' })), e => e.status === 409);
  await store.asignarOfertaSistema({ idLote: a.id, idSucursal: 1, movimiento: { numeroMovimiento: 6, fecha: '2026-11-02', cantidad: 1 }, confirmacion: 'ok', usuario: 'ana' });
  const persistido = JSON.parse(fs.readFileSync(rutaDatos, 'utf8')).lotes.find(x => x.id === a.id).sucursales['1'];
  assert.ok(!('ofertaSistema' in persistido));
  assert.deepStrictEqual(persistido.ofertasSistema.map(o => o.numeroMovimiento), [5, 6]);
});

test('ofertaEstado: derivación', () => {
  const m = c => ({ numeroMovimiento: c, cantidad: c });
  assert.strictEqual(ofertaEstado({ unidades: 5, ofertasSistema: [m(2), m(3)] }), 'ok');
  assert.strictEqual(ofertaEstado({ unidades: 5, ofertasSistema: [m(2), m(3)], ofertaDecision: 'corregir' }), 'ok', 'coincide manda');
  assert.strictEqual(ofertaEstado({ unidades: 6, ofertasSistema: [m(2)] }), null);
  assert.strictEqual(ofertaEstado({ unidades: 6, ofertasSistema: [m(2)], ofertaDecision: 'ok' }), 'ok');
  assert.strictEqual(ofertaEstado({ unidades: 6, ofertasSistema: [m(2)], ofertaDecision: 'corregir' }), 'corregir');
  assert.strictEqual(ofertaEstado({ unidades: 0, ofertasSistema: [], ofertaDecision: 'ok' }), null);
  assert.strictEqual(ofertaEstado({ unidades: 5 }), null, 'lote viejo');
  const v = vistaLote({ id: 'x', sucursales: { 1: { unidades: 6, ofertasSistema: [m(2)], ofertaDecision: 'ok' } } });
  assert.strictEqual(v.sucursales['1'].ofertaEstado, 'ok');
  assert.ok(!('ofertaDecision' in v.sucursales['1']));
});

test('asignar lote de movimientos: coincide, falta confirmar, ok/corregir, 409 atómico, mezcla, quitar limpia decisión', async () => {
  const { store, rutaDatos } = nuevoStore();
  const a = await store.altaLote(ALTA); // 20 unidades
  const b = await store.altaLote({ ...ALTA, vencimiento: '2027-01-31' });
  const mv = (n, cantidad) => ({ numeroMovimiento: n, fecha: '2026-11-10', cantidad });
  const asignar = (idLote, movimientos, confirmacion) => store.asignarOfertaSistema({ idLote, idSucursal: 1, movimientos, confirmacion, usuario: 'ana' });
  const crudo = () => JSON.parse(fs.readFileSync(rutaDatos, 'utf8'));
  // no coincide sin confirmación: 400 y nada guardado
  const antes = crudo();
  await assert.rejects(asignar(a.id, [mv(1, 5), mv(2, 5)]), e => e.status === 400 && e.message === 'Falta confirmar las cantidades');
  await assert.rejects(asignar(a.id, [mv(1, 5)], 'si'), e => e.status === 400);
  assert.deepStrictEqual(crudo(), antes);
  // con confirmación corregir
  let r = await asignar(a.id, [mv(1, 5), mv(2, 5)], 'corregir');
  let col = r.sucursales['1'];
  assert.strictEqual(col.ofertaDecision, 'corregir');
  assert.strictEqual(ofertaEstado(col), 'corregir');
  assert.deepStrictEqual(col.movimientos.filter(m => m.tipo === 'oferta-sistema').map(m => m.numeroMovimiento), [1, 2]);
  const conf = col.movimientos.at(-1);
  assert.deepStrictEqual({ ...conf, fecha: 'f' }, { tipo: 'oferta-confirmacion', estado: 'corregir', cantidadSistema: 10, unidades: 20, usuario: 'ana', fecha: 'f' });
  // 409 de uno aborta todo
  const antes2 = crudo();
  await assert.rejects(asignar(b.id, [mv(3, 1), mv(1, 5)], 'ok'), e => e.status === 409);
  assert.deepStrictEqual(crudo(), antes2);
  // mezcla: ya asignados ignorados, suma coincide => decisión limpia, confirmación ignorada
  r = await asignar(a.id, [mv(1, 5), mv(4, 10)], 'corregir');
  col = r.sucursales['1'];
  assert.deepStrictEqual(col.ofertasSistema.map(o => o.numeroMovimiento), [1, 2, 4]);
  assert.ok(!('ofertaDecision' in col));
  assert.strictEqual(ofertaEstado(col), 'ok');
  assert.strictEqual(col.movimientos.filter(m => m.tipo === 'oferta-sistema').length, 3);
  assert.strictEqual(col.movimientos.filter(m => m.tipo === 'oferta-confirmacion').length, 1);
  // confirmar: coinciden => 400
  const confirmar = (idLote, confirmacion) => store.confirmarOferta({ idLote, idSucursal: 1, confirmacion, usuario: 'ana' });
  await assert.rejects(confirmar(a.id, 'ok'), e => e.status === 400);
  await assert.rejects(confirmar(b.id, 'ok'), e => e.status === 400, 'sin movimientos');
  // quitar uno: ya no coincide, sin decisión
  r = await store.quitarOfertaSistema({ idLote: a.id, idSucursal: 1, numeroMovimiento: 4, usuario: 'ana' });
  assert.strictEqual(ofertaEstado(r.sucursales['1']), null);
  await assert.rejects(confirmar(a.id, 'quizas'), e => e.status === 400);
  r = await confirmar(a.id, 'ok');
  assert.strictEqual(ofertaEstado(r.sucursales['1']), 'ok');
  assert.deepStrictEqual({ ...r.sucursales['1'].movimientos.at(-1), fecha: 'f' }, { tipo: 'oferta-confirmacion', estado: 'ok', cantidadSistema: 10, unidades: 20, usuario: 'ana', fecha: 'f' });
  r = await store.quitarOfertaSistema({ idLote: a.id, idSucursal: 1, numeroMovimiento: 2, usuario: 'ana' });
  assert.ok(!('ofertaDecision' in r.sucursales['1']), 'quitar limpia la decisión');
  assert.strictEqual(ofertaEstado(r.sucursales['1']), null);
});

test('config vencidos: defaults, validación 1..365 y texto, parcial', async () => {
  const { store } = nuevoStore();
  const c0 = await store.leerConfig();
  assert.deepStrictEqual([c0.tipoOfertaVencida, c0.diasMaxVencido], ['OFERTA VENCIDO', 10]);
  for (const v of [0, 366, 'x', 1.5]) assert.throws(() => store.guardarConfig({ diasMaxVencido: v }), e => e.status === 400);
  for (const v of ['', '  ', 5, 'x'.repeat(51)]) assert.throws(() => store.guardarConfig({ tipoOfertaVencida: v }), e => e.status === 400);
  const c = await store.guardarConfig({ diasMaxVencido: 30, tipoOfertaVencida: ' oferta vencido ' });
  assert.deepStrictEqual([c.diasMaxVencido, c.tipoOfertaVencida, c.diasMaxOferta], [30, 'oferta vencido', 10]);
  assert.strictEqual((await store.guardarConfig({ margenDias: 3 })).diasMaxVencido, 30);
});

test('vencidoEstado: base = total oferta; lote viejo; vista sin decisión; pendiente', () => {
  const o = n => ({ numeroMovimiento: n, cantidad: 5 });
  assert.strictEqual(vencidoEstado({ unidades: 20 }), null, 'lote viejo');
  assert.strictEqual(vencidoEstado({ unidades: 20, ofertasSistema: [o(1)], vencidosSistema: [] }), null);
  assert.strictEqual(vencidoEstado({ unidades: 20, ofertasSistema: [o(1), o(2)], vencidosSistema: [{ cantidad: 10 }] }), 'ok');
  assert.strictEqual(vencidoEstado({ unidades: 20, ofertasSistema: [o(1), o(2)], vencidosSistema: [{ cantidad: 3 }] }), null);
  assert.strictEqual(vencidoEstado({ unidades: 20, ofertasSistema: [o(1), o(2)], vencidosSistema: [{ cantidad: 3 }], vencidoDecision: 'ok' }), 'ok');
  assert.strictEqual(vencidoEstado({ unidades: 20, ofertasSistema: [o(1), o(2)], vencidosSistema: [{ cantidad: 3 }], vencidoDecision: 'corregir' }), 'corregir');
  const v = vistaLote({ id: 'x', sucursales: { 1: { unidades: 6, vencidoDecision: 'ok' } } }).sucursales['1'];
  assert.deepStrictEqual([v.vencidosSistema, v.vencidoEstado, 'vencidoDecision' in v], [[], null, false]);
  assert.strictEqual(pendiente({ unidades: 20, vendido: 2, vencido: 1, vencidosSistema: [{ cantidad: 3 }] }), 14);
  assert.strictEqual(pendiente({ unidades: 20, vendido: 2 }), 18, 'lote viejo');
});

test('vencidos sin oferta: base = unidades; con oferta: total de oferta; cambios de base limpian la decisión', async () => {
  const { store, rutaDatos } = nuevoStore();
  const a = await store.altaLote(ALTA); // 20 unidades
  const mv = (n, cantidad) => ({ numeroMovimiento: n, fecha: '2026-11-10', cantidad });
  const venc = (movimientos, confirmacion) => store.asignarSistema('vencido', { idLote: a.id, idSucursal: 1, movimientos, confirmacion, usuario: 'ana' });
  const col = l => vistaLote(l).sucursales['1'];
  const crudo = () => JSON.parse(fs.readFileSync(rutaDatos, 'utf8'));
  // No coincide sin confirmación: 400 y nada guardado.
  const antes = crudo();
  await assert.rejects(venc([mv(50, 5)]), e => e.status === 400 && e.message === 'Falta confirmar las cantidades');
  assert.deepStrictEqual(crudo(), antes);
  // Con confirmación 'corregir': base = unidades (20), historial con base.
  let c = col(await venc([mv(50, 5)], 'corregir'));
  assert.deepStrictEqual([c.vencidoEstado, c.vencidoBase], ['corregir', 20]);
  const conf = c.movimientos.find(m => m.tipo === 'vencido-confirmacion');
  assert.deepStrictEqual([conf.cantidadSistema, conf.base], [5, 20]);
  // PUT confirmación 'ok' sigue funcionando sin oferta.
  c = col(await store.confirmarSistema('vencido', { idLote: a.id, idSucursal: 1, confirmacion: 'ok', usuario: 'ana' }));
  assert.strictEqual(c.vencidoEstado, 'ok');
  // Corregir unidades sin oferta cambia la base y limpia la decisión.
  c = col(await store.corregirUnidades({ idLote: a.id, idSucursal: 1, unidades: 15, usuario: 'ana' }));
  assert.deepStrictEqual([c.vencidoEstado, c.vencidoBase], [null, 15]);
  // Completar a 15 = unidades: 'ok' derivado; PUT confirmación 400 porque coinciden.
  c = col(await venc([mv(51, 10)]));
  assert.deepStrictEqual([c.vencidoEstado, c.vencidoBase], ['ok', 15]);
  await assert.rejects(store.confirmarSistema('vencido', { idLote: a.id, idSucursal: 1, confirmacion: 'ok', usuario: 'ana' }), e => e.status === 400);
  // Agregar oferta: la base pasa al total de oferta (8) y la decisión se limpia.
  c = col(await store.asignarSistema('oferta', { idLote: a.id, idSucursal: 1, movimientos: [mv(1, 8)], confirmacion: 'ok', usuario: 'ana' }));
  assert.deepStrictEqual([c.vencidoEstado, c.vencidoBase], [null, 8]);
  // Quitar la oferta: vuelve a unidades (15) y coincide.
  c = col(await store.quitarSistema('oferta', { idLote: a.id, idSucursal: 1, usuario: 'ana' }));
  assert.deepStrictEqual([c.vencidoEstado, c.vencidoBase], ['ok', 15]);
});

test('vencidos sin oferta: coincide con unidades → ok sin confirmar', async () => {
  const { store } = nuevoStore();
  const a = await store.altaLote(ALTA);
  const l = await store.asignarSistema('vencido', { idLote: a.id, idSucursal: 1, movimientos: [{ numeroMovimiento: 5, fecha: '2026-11-10', cantidad: 20 }], usuario: 'ana' });
  assert.deepStrictEqual([vencidoEstado(l.sucursales['1']), vistaLote(l).sucursales['1'].vencidoBase], ['ok', 20]);
});

test('vencidos en lote: falta confirmar atómico, ok/corregir, 409, idempotente, quitar, base cambia, historial', async () => {
  const { store, rutaDatos } = nuevoStore();
  const a = await store.altaLote(ALTA); // 20 unidades
  const b = await store.altaLote({ ...ALTA, vencimiento: '2027-01-31' });
  const mv = (n, cantidad) => ({ numeroMovimiento: n, fecha: '2026-11-10', cantidad });
  const venc = (idLote, movimientos, confirmacion) => store.asignarSistema('vencido', { idLote, idSucursal: 1, movimientos, confirmacion, usuario: 'ana' });
  const crudo = () => JSON.parse(fs.readFileSync(rutaDatos, 'utf8'));
  await store.asignarSistema('oferta', { idLote: a.id, idSucursal: 1, movimientos: [mv(1, 10)], confirmacion: 'ok', usuario: 'ana' });
  await store.asignarSistema('oferta', { idLote: b.id, idSucursal: 1, movimientos: [mv(2, 20)], usuario: 'ana' });
  const antes = crudo();
  await assert.rejects(venc(a.id, [mv(50, 3)]), e => e.status === 400 && e.message === 'Falta confirmar las cantidades');
  assert.deepStrictEqual(crudo(), antes);
  let col = (await venc(a.id, [mv(50, 3)], 'ok')).sucursales['1'];
  assert.strictEqual(vencidoEstado(col), 'ok');
  assert.strictEqual(pendiente(col), 17);
  assert.deepStrictEqual({ ...col.movimientos.at(-1), fecha: 'f' }, { tipo: 'vencido-confirmacion', estado: 'ok', cantidadSistema: 3, base: 10, usuario: 'ana', fecha: 'f' });
  assert.ok(col.movimientos.some(m => m.tipo === 'vencido-sistema' && m.numeroMovimiento === 50 && m.cantidad === 3));
  assert.strictEqual((await venc(a.id, [mv(50, 3)])).sucursales['1'].vencidosSistema.length, 1, 'idempotente');
  await assert.rejects(venc(b.id, [mv(51, 1), mv(50, 3)], 'ok'), e => e.status === 409);
  const conf = c => store.confirmarSistema('vencido', { idLote: a.id, idSucursal: 1, confirmacion: c, usuario: 'ana' });
  col = (await conf('corregir')).sucursales['1'];
  assert.strictEqual(vencidoEstado(col), 'corregir');
  // cambiar la base (agregar oferta) limpia la decisión de vencidos
  col = (await store.asignarSistema('oferta', { idLote: a.id, idSucursal: 1, movimientos: [mv(3, 2)], confirmacion: 'ok', usuario: 'ana' })).sucursales['1'];
  assert.ok(!('vencidoDecision' in col));
  assert.strictEqual(vencidoEstado(col), null);
  await conf('ok');
  col = (await store.quitarSistema('oferta', { idLote: a.id, idSucursal: 1, numeroMovimiento: 3, usuario: 'ana' })).sucursales['1'];
  assert.strictEqual(vencidoEstado(col), null, 'quitar oferta limpia');
  // coincide con la base => ok derivado, no hace falta confirmar
  col = (await venc(a.id, [mv(52, 7)])).sucursales['1'];
  assert.strictEqual(vencidoEstado(col), 'ok');
  await assert.rejects(conf('ok'), e => e.status === 400);
  col = (await store.quitarSistema('vencido', { idLote: a.id, idSucursal: 1, numeroMovimiento: 52, usuario: 'ana' })).sucursales['1'];
  assert.strictEqual(vencidoEstado(col), null);
  assert.ok(col.movimientos.some(m => m.tipo === 'vencido-sistema-quitada' && m.numeroMovimiento === 52));
  await assert.rejects(store.quitarSistema('vencido', { idLote: b.id, idSucursal: 1, usuario: 'ana' }), e => e.status === 404);
});

test('eliminarRegistro: quita solo esa sucursal; última sucursal borra el lote; 404', async () => {
  const { store } = nuevoStore();
  const l = await store.altaLote(ALTA);
  await store.altaLote({ ...ALTA, idSucursal: 2, usuario: 'beto' });
  const r = await store.eliminarRegistro({ idLote: l.id, idSucursal: 1 });
  assert.deepStrictEqual(r, { idLote: l.id, idProducto: 10, idSucursal: 1, loteEliminado: false, movimientos: 1 });
  assert.deepStrictEqual(Object.keys((await store.listarLotes())[0].sucursales), ['2']);
  await assert.rejects(store.eliminarRegistro({ idLote: l.id, idSucursal: 1 }), e => e.status === 404);
  assert.strictEqual((await store.eliminarRegistro({ idLote: l.id, idSucursal: 2 })).loteEliminado, true);
  assert.deepStrictEqual(await store.listarLotes(), []);
  await assert.rejects(store.eliminarRegistro({ idLote: l.id, idSucursal: 2 }), e => e.status === 404);
});
