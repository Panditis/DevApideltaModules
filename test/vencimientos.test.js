const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { crearStore, semaforo, validarUmbrales, estadoSucursal, UMBRALES_DEFAULT } = require('../lib/vencimientos');

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
  assert.deepStrictEqual(await store.leerConfig(), { umbrales: { ...UMBRALES_DEFAULT } });
  await store.guardarUmbrales({ rojo: 7, amarillo: 30 });
  assert.deepStrictEqual(await store.leerConfig(), { umbrales: { rojo: 7, amarillo: 30 } });
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
