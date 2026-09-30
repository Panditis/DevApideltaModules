const test = require('node:test');
const assert = require('node:assert');
const {
  calcularCostoItem, construirItemPedido, siguienteNumero, construirPedido, anularPedido,
} = require('../lib/fraccionado_externo');

test('calcularCostoItem calcula costo unitario y total', () => {
  const r = calcularCostoItem({ minPorPaquete: 1, paquetes: 10, factorComplejidad: 1, valorHora: 6000 });
  assert.strictEqual(r.costoUnitario, 100); // 6000/60 * 1 * 1
  assert.strictEqual(r.costoTotal, 1000);
});

test('calcularCostoItem aplica el factor de complejidad como multiplicador', () => {
  const r = calcularCostoItem({ minPorPaquete: 1, paquetes: 10, factorComplejidad: 1.2, valorHora: 6000 });
  assert.strictEqual(r.costoUnitario, 120);
  assert.strictEqual(r.costoTotal, 1200);
});

test('calcularCostoItem deriva costoTotal del costoUnitario ya redondeado (no del valor exacto)', () => {
  // costoUnitarioExacto=1.666.. → costoUnitario 1.67; total = 1.67*7 = 11.69 (no round(1.666*7)).
  const r = calcularCostoItem({ minPorPaquete: 1, paquetes: 7, factorComplejidad: 1, valorHora: 100 });
  assert.strictEqual(r.costoUnitario, 1.67);
  assert.strictEqual(r.costoTotal, 11.69);
});

test('calcularCostoItem redondea paquetes fraccionarios a 2 decimales antes del total', () => {
  // 2.5kg en bolsas de 0.3kg = 8.333.. paquetes → 8.33; unitario 100 → total 833
  const r = calcularCostoItem({ minPorPaquete: 1, paquetes: 2.5 / 0.3, factorComplejidad: 1, valorHora: 6000 });
  assert.strictEqual(r.costoTotal, 833);
});

test('calcularCostoItem rechaza valores no positivos o no numéricos', () => {
  const base = { minPorPaquete: 1, paquetes: 10, factorComplejidad: 1, valorHora: 6000 };
  assert.throws(() => calcularCostoItem({ ...base, minPorPaquete: 0 }), /minPorPaquete/);
  assert.throws(() => calcularCostoItem({ ...base, paquetes: -1 }), /paquetes/);
  assert.throws(() => calcularCostoItem({ ...base, factorComplejidad: 0 }), /factorComplejidad/);
  assert.throws(() => calcularCostoItem({ ...base, valorHora: NaN }), /valorHora/);
});

test('construirItemPedido arma el item con el costo calculado', () => {
  const item = construirItemPedido({
    plu: '1101', nombre: 'Oregano Premium 50G', presentacion: '50G',
    minPorPaquete: 0.31, origenTiempo: 'historial', paquetes: 400, factorComplejidad: 1.15, valorHora: 8100,
  });
  assert.strictEqual(item.plu, '1101');
  assert.strictEqual(item.origenTiempo, 'historial');
  assert.strictEqual(item.costoUnitario, 48.13); // 8100/60 * 0.31 * 1.15 = 48.1275
});

test('construirItemPedido rechaza origenTiempo inválido', () => {
  assert.throws(() => construirItemPedido({
    plu: '1', nombre: 'X', minPorPaquete: 1, origenTiempo: 'lo_que_sea', paquetes: 1, factorComplejidad: 1, valorHora: 8100,
  }), /origenTiempo/);
});

test('construirItemPedido rechaza PLU faltante', () => {
  assert.throws(() => construirItemPedido({
    plu: '', nombre: 'X', minPorPaquete: 1, origenTiempo: 'historial', paquetes: 1, factorComplejidad: 1, valorHora: 8100,
  }), /PLU/);
});

test('construirItemPedido rechaza nombre faltante', () => {
  assert.throws(() => construirItemPedido({
    plu: '1', nombre: '', minPorPaquete: 1, origenTiempo: 'historial', paquetes: 1, factorComplejidad: 1, valorHora: 8100,
  }), /nombre/);
});

test('siguienteNumero arranca en FE-0001 con lista vacía', () => {
  assert.strictEqual(siguienteNumero([]), 'FE-0001');
});

test('siguienteNumero toma el máximo y suma uno, ignorando formatos raros', () => {
  const pedidos = [{ numero: 'FE-0003' }, { numero: 'FE-0001', estado: 'ANULADO' }, { numero: 'raro' }];
  assert.strictEqual(siguienteNumero(pedidos), 'FE-0004');
});

test('construirPedido arma el pedido con total y rechaza items vacíos o tercero ausente', () => {
  const items = [{
    plu: '1101', nombre: 'Oregano Premium 50G', presentacion: '50G',
    minPorPaquete: 0.31, origenTiempo: 'historial', paquetes: 400, factorComplejidad: 1.15,
  }];
  const pedido = construirPedido({
    numero: 'FE-0001', fechaISO: '2026-09-14', tercero: 'Fraccionadora Sur',
    valorHora: 8100, items, ts: '2026-09-14T10:00:00.000Z',
  });
  assert.strictEqual(pedido.estado, 'PENDIENTE');
  assert.strictEqual(pedido.items.length, 1);
  assert.strictEqual(pedido.total, pedido.items[0].costoTotal);
  assert.throws(() => construirPedido({ numero: 'FE-0002', fechaISO: '2026-09-14', tercero: 'X', valorHora: 8100, items: [] }), /no tiene items/);
  assert.throws(() => construirPedido({ numero: 'FE-0002', fechaISO: '2026-09-14', tercero: '', valorHora: 8100, items }), /tercero/);
});

test('construirPedido rechaza valorHora inválido', () => {
  const items = [{
    plu: '1101', nombre: 'Oregano Premium 50G', presentacion: '50G',
    minPorPaquete: 0.31, origenTiempo: 'historial', paquetes: 400, factorComplejidad: 1.15,
  }];
  assert.throws(() => construirPedido({
    numero: 'FE-0001', fechaISO: '2026-09-14', tercero: 'Fraccionadora Sur', valorHora: 0, items,
  }), /valorHora/);
  assert.throws(() => construirPedido({
    numero: 'FE-0001', fechaISO: '2026-09-14', tercero: 'Fraccionadora Sur', valorHora: NaN, items,
  }), /valorHora/);
});

test('anularPedido cambia el estado y agrega al historial, sin mutar el original', () => {
  const pedido = { numero: 'FE-0001', estado: 'PENDIENTE', historial: [{ ts: 't0', accion: 'creado' }] };
  const anulado = anularPedido(pedido, { ts: 't1', usuario: 'ana' });
  assert.strictEqual(anulado.estado, 'ANULADO');
  assert.strictEqual(anulado.historial.length, 2);
  assert.strictEqual(pedido.estado, 'PENDIENTE'); // original sin mutar
  assert.throws(() => anularPedido(anulado, { ts: 't2' }), /ya está anulado/);
});

test('anularPedido rechaza pedido ausente', () => {
  assert.throws(() => anularPedido(null, { ts: 't1' }), /pedido/);
  assert.throws(() => anularPedido(undefined, { ts: 't1' }), /pedido/);
});

const { CONFIG_DEFAULT, validarConfig, resolverNiveles, nivelTiempoMasCercano } = require('../lib/fraccionado_externo');

const valorDe = (lista, id) => lista.find(n => n.id === id).valor;

test('validarConfig normaliza listas de niveles y conserva ids existentes', () => {
  const cfg = validarConfig({
    tiempos: [{ id: 'rapido', nombre: ' Rápido ', valor: '0.2' }, { nombre: 'Normal', valor: 0.4 }],
    factores: [{ id: 'facil', nombre: 'Fácil', valor: 1 }],
  });
  assert.deepStrictEqual(cfg.tiempos, [
    { id: 'rapido', nombre: 'Rápido', valor: 0.2 },
    { id: 'normal', nombre: 'Normal', valor: 0.4 },
  ]);
  assert.deepStrictEqual(cfg.factores, [{ id: 'facil', nombre: 'Fácil', valor: 1 }]);
});

test('validarConfig genera id desde el nombre para opciones nuevas, sin pisar ids existentes', () => {
  const cfg = validarConfig({
    tiempos: [{ id: 'muy-lento', nombre: 'Muy lento', valor: 2 }, { nombre: 'Muy lento!', valor: 3 }],
    factores: [{ nombre: 'Extra difícil', valor: 2 }],
  });
  assert.deepStrictEqual(cfg.tiempos.map(n => n.id), ['muy-lento', 'muy-lento-2']);
  assert.strictEqual(cfg.factores[0].id, 'extra-dificil');
});

test('validarConfig acepta el formato viejo (objeto por nivel) y lo convierte a lista', () => {
  const cfg = validarConfig({ factores: { facil: 1, medio: 1.2, dificil: 1.5 }, tiempos: { rapido: 0.2, normal: 0.4, lento: 0.8 } });
  assert.deepStrictEqual(cfg.tiempos.map(n => n.nombre), ['Rápido', 'Normal', 'Lento']);
  assert.strictEqual(valorDe(cfg.tiempos, 'normal'), 0.4);
  assert.strictEqual(valorDe(cfg.factores, 'dificil'), 1.5);
});

test('validarConfig rechaza grupos vacíos, nombres vacíos, repetidos o valores no positivos', () => {
  const t = CONFIG_DEFAULT.tiempos;
  assert.throws(() => validarConfig(null), /tiempos/);
  assert.throws(() => validarConfig({ tiempos: t, factores: [] }), /al menos una/);
  assert.throws(() => validarConfig({ tiempos: [{ nombre: '', valor: 1 }], factores: t }), /nombre/);
  assert.throws(() => validarConfig({ tiempos: [{ nombre: 'X', valor: 0 }], factores: t }), /X/);
  assert.throws(() => validarConfig({ tiempos: [{ nombre: 'Lento', valor: 1 }, { nombre: 'lento', valor: 2 }], factores: t }), /repetid/);
});

test('resolverNiveles traduce niveles a minutos y factor según la config', () => {
  const it = resolverNiveles({ plu: '1', nivelTiempo: 'lento', nivelComplejidad: 'dificil' }, CONFIG_DEFAULT);
  assert.strictEqual(it.minPorPaquete, valorDe(CONFIG_DEFAULT.tiempos, 'lento'));
  assert.strictEqual(it.factorComplejidad, valorDe(CONFIG_DEFAULT.factores, 'dificil'));
  assert.strictEqual(it.origenTiempo, 'nivel');
  assert.strictEqual(it.plu, '1');
});

test('resolverNiveles usa opciones agregadas por el usuario', () => {
  const cfg = validarConfig({ tiempos: [{ nombre: 'Turbo', valor: 0.1 }], factores: [{ nombre: 'Extremo', valor: 3 }] });
  const it = resolverNiveles({ nivelTiempo: 'turbo', nivelComplejidad: 'extremo' }, cfg);
  assert.strictEqual(it.minPorPaquete, 0.1);
  assert.strictEqual(it.factorComplejidad, 3);
});

test('resolverNiveles rechaza niveles desconocidos', () => {
  assert.throws(() => resolverNiveles({ nivelTiempo: 'turbo', nivelComplejidad: 'facil' }, CONFIG_DEFAULT), /nivelTiempo/);
  assert.throws(() => resolverNiveles({ nivelTiempo: 'normal', nivelComplejidad: 'imposible' }, CONFIG_DEFAULT), /nivelComplejidad/);
});

test('construirItemPedido acepta origenTiempo nivel y guarda los niveles', () => {
  const item = construirItemPedido({
    ...resolverNiveles({ plu: '1', nombre: 'X 50G', presentacion: '50G', nivelTiempo: 'normal', nivelComplejidad: 'medio' }, CONFIG_DEFAULT),
    paquetes: 10, valorHora: 6000,
  });
  assert.strictEqual(item.nivelTiempo, 'normal');
  assert.strictEqual(item.nivelComplejidad, 'medio');
});

test('nivelTiempoMasCercano elige el nivel más próximo al historial; sin dato, normal o el primero', () => {
  const t = [{ id: 'rapido', valor: 0.2 }, { id: 'normal', valor: 0.5 }, { id: 'lento', valor: 1 }];
  assert.strictEqual(nivelTiempoMasCercano(0.25, t), 'rapido');
  assert.strictEqual(nivelTiempoMasCercano(0.9, t), 'lento');
  assert.strictEqual(nivelTiempoMasCercano(null, t), 'normal');
  assert.strictEqual(nivelTiempoMasCercano(null, [{ id: 'a', valor: 1 }, { id: 'b', valor: 2 }]), 'a');
});

const { validarTarea, siguienteIdTarea, resolverTarea, construirItemTarea } = require('../lib/fraccionado_externo');

test('validarTarea normaliza nombre y monto', () => {
  assert.deepStrictEqual(validarTarea({ nombre: '  Etiquetado ', monto: '25.5' }, []), { nombre: 'Etiquetado', monto: 25.5 });
});

test('validarTarea rechaza nombre vacío y monto no positivo o no numérico', () => {
  assert.throws(() => validarTarea({ nombre: '  ', monto: 10 }, []), /nombre/);
  assert.throws(() => validarTarea(null, []), /nombre/);
  assert.throws(() => validarTarea({ nombre: 'X', monto: 0 }, []), /Monto/);
  assert.throws(() => validarTarea({ nombre: 'X', monto: -5 }, []), /Monto/);
  assert.throws(() => validarTarea({ nombre: 'X', monto: 'abc' }, []), /Monto/);
  assert.throws(() => validarTarea({ nombre: 'X', monto: 0.004 }, []), /Monto/); // redondea a 0
});

test('validarTarea rechaza nombre repetido ignorando mayúsculas, salvo contra sí misma', () => {
  const existentes = [{ id: 'T1', nombre: 'Etiquetado', monto: 25 }];
  assert.throws(() => validarTarea({ nombre: 'etiquetado', monto: 30 }, existentes), /Ya existe/);
  assert.deepStrictEqual(validarTarea({ nombre: 'ETIQUETADO', monto: 30 }, existentes, 'T1'), { nombre: 'ETIQUETADO', monto: 30 });
});

test('siguienteIdTarea arranca en T1 y suma uno al máximo, ignorando formatos raros', () => {
  assert.strictEqual(siguienteIdTarea([]), 'T1');
  assert.strictEqual(siguienteIdTarea(undefined), 'T1');
  assert.strictEqual(siguienteIdTarea([{ id: 'T1' }, { id: 'T7' }, { id: 'raro' }]), 'T8');
});

test('resolverTarea toma nombre y monto de la lista, no del cliente', () => {
  const tareas = [{ id: 'T1', nombre: 'Etiquetado', monto: 25 }];
  assert.deepStrictEqual(
    resolverTarea({ tipo: 'tarea', tareaId: 'T1', cantidad: 40, nombre: 'hack', montoUnitario: 1 }, tareas),
    { tipo: 'tarea', tareaId: 'T1', nombre: 'Etiquetado', montoUnitario: 25, cantidad: 40 },
  );
  assert.throws(() => resolverTarea({ tareaId: 'T9', cantidad: 1 }, tareas), /tareaId/);
});

test('construirItemTarea calcula el total como monto × cantidad', () => {
  const it = construirItemTarea({ tareaId: 'T1', nombre: 'Etiquetado', montoUnitario: 25, cantidad: 40 });
  assert.deepStrictEqual(it, {
    tipo: 'tarea', tareaId: 'T1', nombre: 'Etiquetado', montoUnitario: 25, cantidad: 40, costoUnitario: 25, costoTotal: 1000,
  });
  assert.strictEqual(construirItemTarea({ tareaId: 'T1', nombre: 'X', montoUnitario: 10.5, cantidad: 2.5 }).costoTotal, 26.25);
});

test('construirItemTarea rechaza cantidad, monto, tarea o nombre inválidos', () => {
  const base = { tareaId: 'T1', nombre: 'X', montoUnitario: 10, cantidad: 1 };
  assert.throws(() => construirItemTarea({ ...base, cantidad: 0 }), /cantidad/);
  assert.throws(() => construirItemTarea({ ...base, cantidad: 0.004 }), /cantidad/);
  assert.throws(() => construirItemTarea({ ...base, cantidad: 'x' }), /cantidad/);
  assert.throws(() => construirItemTarea({ ...base, cantidad: undefined }), /cantidad/);
  assert.throws(() => construirItemTarea({ ...base, montoUnitario: 0 }), /montoUnitario/);
  assert.throws(() => construirItemTarea({ ...base, montoUnitario: 0.004 }), /montoUnitario/);
  assert.throws(() => construirItemTarea({ ...base, tareaId: '' }), /tarea/);
  assert.throws(() => construirItemTarea({ ...base, nombre: '' }), /nombre/);
});

test('construirPedido mezcla productos y tareas y suma ambos en el total', () => {
  const producto = {
    plu: '1101', nombre: 'Oregano 50G', presentacion: '50G', minPorPaquete: 0.5, origenTiempo: 'nivel', paquetes: 20, factorComplejidad: 1,
  };
  const tarea = { tipo: 'tarea', tareaId: 'T1', nombre: 'Etiquetado', montoUnitario: 25, cantidad: 40 };
  const pedido = construirPedido({
    numero: 'FE-0001', fechaISO: '2026-09-30', tercero: 'Sur', valorHora: 6000, items: [producto, tarea], ts: 't0',
  });
  assert.strictEqual(pedido.items.length, 2);
  assert.strictEqual(pedido.items[0].tipo, undefined); // el producto sigue sin tipo
  assert.strictEqual(pedido.items[0].costoTotal, 1000); // 6000/60 × 0.5 × 1 = 50 por paquete × 20
  assert.strictEqual(pedido.items[1].costoTotal, 1000);
  assert.strictEqual(pedido.total, 2000);
});

test('construirPedido acepta un pedido sólo de tareas', () => {
  const pedido = construirPedido({
    numero: 'FE-0002', fechaISO: '2026-09-30', tercero: 'Sur', valorHora: 6000,
    items: [{ tipo: 'tarea', tareaId: 'T1', nombre: 'Etiquetado', montoUnitario: 25, cantidad: 4 }],
  });
  assert.strictEqual(pedido.total, 100);
});

test('construirPedido rechaza una tarea sin cantidad', () => {
  assert.throws(() => construirPedido({
    numero: 'FE-0003', fechaISO: '2026-09-30', tercero: 'Sur', valorHora: 6000,
    items: [{ tipo: 'tarea', tareaId: 'T1', nombre: 'X', montoUnitario: 10 }],
  }), /cantidad/);
});
