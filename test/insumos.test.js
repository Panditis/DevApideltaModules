const test = require('node:test');
const assert = require('node:assert');
const ins = require('../insumos');
const { mesAnterior } = require('../prediccion_consumo');

// Serie pareja de N meses cerrados hacia atrás desde hastaMes (que queda afuera:
// es el mes en curso). Con 30 por mes, μ diario ≈ 1.
function serieParEja(valor, hastaMes = '2026-08', meses = 24) {
  const s = {};
  for (let i = 1; i <= meses; i++) s[mesAnterior(hastaMes, i)] = valor;
  return s;
}

test('condicionSQL filtra sólo por nombre: el rubro no define un insumo', () => {
  const c = ins.condicionSQL();
  assert.strictEqual(c, `UPPER(LTRIM(p.NombreProducto)) LIKE 'INSUMO%'`);
  assert.ok(!c.includes('IdRubro'));
});

test('condicionSQL exige que el prefijo esté al principio del nombre', () => {
  // Sin comodín adelante: "Bolsa Insumo X" queda afuera, "Insumo Bolsa X" entra.
  assert.ok(!ins.condicionSQL().includes("LIKE '%INSUMO"));
});

test('condicionSQL acepta alias y respeta rubros y prefijo propios', () => {
  const c = ins.condicionSQL({ rubros: [30, 31], prefijoNombre: 'envase', alias: 'prod' });
  assert.strictEqual(c, `(prod.IdRubro IN (30,31) OR UPPER(LTRIM(prod.NombreProducto)) LIKE 'ENVASE%')`);
});

test('condicionSQL suma rubros por config sin perder el filtro de nombre', () => {
  const c = ins.condicionSQL({ rubros: [30] });
  assert.strictEqual(c, `(p.IdRubro IN (30) OR UPPER(LTRIM(p.NombreProducto)) LIKE 'INSUMO%')`);
});

test('condicionSQL con un solo criterio no envuelve de más', () => {
  assert.strictEqual(ins.condicionSQL({ rubros: [30], prefijoNombre: '' }), 'p.IdRubro IN (30)');
});

test('condicionSQL no deja pasar comillas, comodines ni alias inventados', () => {
  // La comilla se duplica (escape SQL), los comodines de LIKE se van y el alias
  // basura cae al default: el % que queda es el nuestro, el del final.
  const c = ins.condicionSQL({ prefijoNombre: "in'su%mo_[x]", alias: "p; DROP TABLE Productos--" });
  assert.strictEqual(c, `UPPER(LTRIM(p.NombreProducto)) LIKE 'IN''SUMOX%'`);
  assert.ok(!c.includes('DROP TABLE'));
});

test('condicionSQL descarta rubros que no son números', () => {
  const c = ins.condicionSQL({ rubros: [30, '31; DELETE FROM Productos', null, NaN] });
  assert.strictEqual(c, `(p.IdRubro IN (30) OR UPPER(LTRIM(p.NombreProducto)) LIKE 'INSUMO%')`);
});

test('condicionSQL sin criterios falla fuerte en vez de vaciar el módulo', () => {
  assert.throws(() => ins.condicionSQL({ prefijoNombre: '' }), /rubros o prefijoNombre/);
});

test('serieMensual agrupa salidas por plu y mes, y descarta los tipos que no son consumo', () => {
  const filas = [
    { plu: '10011', mes: '2026-07', tipo: 'BIENESUSO', salidas: 20, entradas: 0 },
    { plu: '10011', mes: '2026-07', tipo: 'REC-SUC',   salidas: 5,  entradas: 0 },
    { plu: '10011', mes: '2026-07', tipo: 'AJUSTE',    salidas: 1925, entradas: 0 },  // corrección de inventario
    { plu: '10011', mes: '2026-07', tipo: 'COMPRA',    salidas: 0,  entradas: 500 },
    { plu: '1809',  mes: '2026-06', tipo: 'BIENESUSO', salidas: 3,  entradas: 0 },
  ];
  const s = ins.serieMensual(filas);
  assert.deepStrictEqual(s['10011'], { '2026-07': 25 });
  assert.deepStrictEqual(s['1809'],  { '2026-06': 3 });
});

test('serieMensual ignora filas sin plu, con mes mal formado o sin salida', () => {
  const filas = [
    { plu: '', mes: '2026-07', tipo: 'BIENESUSO', salidas: 10 },
    { plu: '1', mes: '2026-7',  tipo: 'BIENESUSO', salidas: 10 },
    { plu: '1', mes: '2026-07', tipo: 'BIENESUSO', salidas: 0 },
    { plu: '1', mes: '2026-07', tipo: 'BIENESUSO', salidas: -4 },
  ];
  assert.deepStrictEqual(ins.serieMensual(filas), {});
});

test('desglosePorTipo suma entradas y salidas y marca cuáles cuentan como consumo', () => {
  const filas = [
    { plu: '10011', mes: '2026-07', tipo: 'BIENESUSO', salidas: 20, entradas: 2 },
    { plu: '10011', mes: '2026-06', tipo: 'BIENESUSO', salidas: 15, entradas: 0 },
    { plu: '10011', mes: '2026-06', tipo: 'COMPRA',    salidas: 0,  entradas: 500 },
  ];
  const d = ins.desglosePorTipo(filas);
  assert.deepStrictEqual(d, [
    { tipo: 'BIENESUSO', salidas: 35, entradas: 2,   esConsumo: true },
    { tipo: 'COMPRA',    salidas: 0,  entradas: 500, esConsumo: false },
  ]);
});

test('clasificar: sin consumo no se puede estimar duración', () => {
  assert.strictEqual(ins.clasificar({ stock: 100, muDiario: 0, diasCobertura: null }), ins.ESTADO.SIN_CONSUMO);
});

test('clasificar: se consume y no queda nada → SIN_STOCK, no CRITICO', () => {
  assert.strictEqual(ins.clasificar({ stock: 0, muDiario: 1, diasCobertura: 0 }), ins.ESTADO.SIN_STOCK);
});

test('clasificar corta por días de cobertura', () => {
  const caso = d => ins.clasificar({ stock: 10, muDiario: 1, diasCobertura: d });
  assert.strictEqual(caso(14),  ins.ESTADO.CRITICO);
  assert.strictEqual(caso(15),  ins.ESTADO.BAJO);     // 15 ya no es crítico
  assert.strictEqual(caso(29),  ins.ESTADO.BAJO);
  assert.strictEqual(caso(30),  ins.ESTADO.OK);
  assert.strictEqual(caso(180), ins.ESTADO.OK);       // el corte de exceso es estricto
  assert.strictEqual(caso(181), ins.ESTADO.EXCESO);
});

test('clasificar acepta umbrales propios', () => {
  const r = ins.clasificar({ stock: 10, muDiario: 1, diasCobertura: 20 }, { criticoDias: 25 });
  assert.strictEqual(r, ins.ESTADO.CRITICO);
});

test('resumenInsumo estima consumo mensual y duración con consumo parejo', () => {
  const r = ins.resumenInsumo({
    plu: 10011, nombre: 'Insumo Guantes', stock: 120,
    serie: serieParEja(30), mesActual: '2026-08',
  });
  // 30 por mes durante 24 meses → μ ≈ 1/día (los meses de 31 días bajan un poco el promedio)
  assert.ok(Math.abs(r.muDiario - 1) < 0.02, `muDiario=${r.muDiario}`);
  assert.ok(Math.abs(r.consumoMensual - 30) < 1, `consumoMensual=${r.consumoMensual}`);
  assert.strictEqual(r.promedioMensual, 30);
  assert.ok(Math.abs(r.diasCobertura - 120) < 3, `diasCobertura=${r.diasCobertura}`);
  assert.ok(Math.abs(r.mesesCobertura - 4) < 0.1, `mesesCobertura=${r.mesesCobertura}`);
  assert.strictEqual(r.estado, ins.ESTADO.OK);
  assert.strictEqual(r.mesesConConsumo, 24);
  assert.strictEqual(r.ultimoMesConConsumo, '2026-07');
});

test('resumenInsumo no cuenta el mes en curso: está incompleto', () => {
  const serie = { ...serieParEja(30), '2026-08': 1 };
  const r = ins.resumenInsumo({ plu: 1, stock: 0, serie, mesActual: '2026-08' });
  assert.strictEqual(r.totalVentana, 30 * 24);
  assert.strictEqual(r.ultimoMesConConsumo, '2026-07');
});

test('resumenInsumo sin movimientos: sin consumo y sin duración', () => {
  const r = ins.resumenInsumo({ plu: 5342, nombre: 'Bandeja Panal', stock: 6, serie: {}, mesActual: '2026-08' });
  assert.strictEqual(r.consumoMensual, 0);
  assert.strictEqual(r.diasCobertura, null);
  assert.strictEqual(r.mesesCobertura, null);
  assert.strictEqual(r.estado, ins.ESTADO.SIN_CONSUMO);
  assert.strictEqual(r.mesesConConsumo, 0);
});

test('resumenInsumo con stock cero y consumo activo queda SIN_STOCK', () => {
  const r = ins.resumenInsumo({ plu: 1, stock: 0, serie: serieParEja(30), mesActual: '2026-08' });
  assert.strictEqual(r.diasCobertura, 0);
  assert.strictEqual(r.estado, ins.ESTADO.SIN_STOCK);
});

test('resumenInsumo con stock negativo no inventa días de cobertura negativos', () => {
  // Siga deja stock en negativo cuando la entrega se carga antes que la compra.
  const r = ins.resumenInsumo({ plu: 505, stock: -1, serie: serieParEja(30), mesActual: '2026-08' });
  assert.strictEqual(r.stock, -1);
  assert.strictEqual(r.diasCobertura, 0);
  assert.strictEqual(r.estado, ins.ESTADO.SIN_STOCK);
});

test('ordenarPorUrgencia: con la misma cobertura manda el que más se consume', () => {
  const filas = [
    { plu: 'poco',  nombre: 'A poco',  estado: ins.ESTADO.SIN_STOCK, diasCobertura: 0, consumoMensual: 0.1 },
    { plu: 'mucho', nombre: 'Z mucho', estado: ins.ESTADO.SIN_STOCK, diasCobertura: 0, consumoMensual: 150 },
  ];
  assert.deepStrictEqual(ins.ordenarPorUrgencia(filas).map(f => f.plu), ['mucho', 'poco']);
});

test('calcularListado ordena por urgencia y deja los sin consumo al final', () => {
  const filasMov = [];
  const push = (plu, valor) => {
    const s = serieParEja(valor);
    for (const mes of Object.keys(s)) filasMov.push({ plu, mes, tipo: 'BIENESUSO', salidas: s[mes] });
  };
  push('critico', 300);   // 300/mes con stock 50 → ~5 días
  push('ok', 30);         // 30/mes con stock 120 → ~4 meses
  push('sinstock', 30);
  const productos = [
    { plu: 'ok',       nombre: 'OK',        stock: 120 },
    { plu: 'quieto',   nombre: 'Quieto',    stock: 9 },     // sin movimientos
    { plu: 'critico',  nombre: 'Critico',   stock: 50 },
    { plu: 'sinstock', nombre: 'Sin stock', stock: 0 },
  ];
  const filas = ins.calcularListado({ productos, filasMov, mesActual: '2026-08' });
  assert.deepStrictEqual(filas.map(f => f.plu), ['sinstock', 'critico', 'ok', 'quieto']);
  assert.strictEqual(filas[3].estado, ins.ESTADO.SIN_CONSUMO);
});

test('calcularListado no cuenta los ajustes como consumo', () => {
  const filasMov = [
    { plu: '10011', mes: '2026-07', tipo: 'AJUSTE', salidas: 1925 },
    { plu: '10011', mes: '2026-07', tipo: 'BIENESUSO', salidas: 30 },
  ];
  const [fila] = ins.calcularListado({
    productos: [{ plu: '10011', nombre: 'Guantes', stock: 117 }],
    filasMov, mesActual: '2026-08',
  });
  // Con el ajuste adentro la cobertura caería a ~44 días por un movimiento que no
  // se va a repetir; sin él, el único mes con consumo pesa poco y el stock alcanza.
  assert.ok(fila.diasCobertura > 365, `diasCobertura=${fila.diasCobertura}`);
  assert.strictEqual(fila.mesesConConsumo, 1);
});

test('normalizarNivel acepta un par válido y lo redondea', () => {
  assert.deepStrictEqual(ins.normalizarNivel({ min: '20', max: '100' }), { min: 20, max: 100 });
  assert.deepStrictEqual(ins.normalizarNivel({ min: 0, max: 0 }), { min: 0, max: 0 });
});

test('normalizarNivel sin ninguno de los dos devuelve null: se borra el nivel', () => {
  assert.strictEqual(ins.normalizarNivel({ min: '', max: '' }), null);
  assert.strictEqual(ins.normalizarNivel({}), null);
});

test('normalizarNivel rechaza pares incompletos, negativos, no numéricos e invertidos', () => {
  assert.throws(() => ins.normalizarNivel({ min: 10 }), /van juntos/);
  assert.throws(() => ins.normalizarNivel({ max: 10 }), /van juntos/);
  assert.throws(() => ins.normalizarNivel({ min: 'x', max: 10 }), /números/);
  assert.throws(() => ins.normalizarNivel({ min: -1, max: 10 }), /negativos/);
  assert.throws(() => ins.normalizarNivel({ min: 50, max: 10 }), /menor que el mínimo/);
});

test('sugerirCompra: nada hasta el mínimo, y ahí la diferencia contra el máximo', () => {
  const nivel = { min: 20, max: 100 };
  assert.strictEqual(ins.sugerirCompra({ stock: 21, nivel }), 0);    // arriba del mínimo
  assert.strictEqual(ins.sugerirCompra({ stock: 20, nivel }), 80);   // tocarlo ya dispara
  assert.strictEqual(ins.sugerirCompra({ stock: 5,  nivel }), 95);
  assert.strictEqual(ins.sugerirCompra({ stock: 0,  nivel }), 100);
});

test('sugerirCompra con stock negativo cubre también el rojo', () => {
  assert.strictEqual(ins.sugerirCompra({ stock: -5, nivel: { min: 20, max: 100 } }), 105);
});

test('sugerirCompra sin niveles cargados no pide nada', () => {
  assert.strictEqual(ins.sugerirCompra({ stock: 0, nivel: null }), 0);
  assert.strictEqual(ins.sugerirCompra({ stock: 0 }), 0);
});

test('aplicarNiveles pega min/max y marca quién pide compra', () => {
  const filas = [{ plu: '10011', stock: 5 }, { plu: '1809', stock: 500 }, { plu: 'sin', stock: 0 }];
  const r = ins.aplicarNiveles(filas, { '10011': { min: 20, max: 100 }, '1809': { min: 20, max: 100 } });
  assert.deepStrictEqual(r[0], { plu:'10011', stock:5, min:20, max:100, aComprar:95, pideCompra:true });
  assert.deepStrictEqual(r[1], { plu:'1809', stock:500, min:20, max:100, aComprar:0, pideCompra:false });
  assert.deepStrictEqual(r[2], { plu:'sin', stock:0, min:null, max:null, aComprar:0, pideCompra:false });
});

test('calcularListado incorpora los niveles guardados', () => {
  const filas = ins.calcularListado({
    productos: [{ plu: '10011', nombre: 'Guantes', stock: 5 }],
    filasMov: [], mesActual: '2026-08', niveles: { '10011': { min: 20, max: 100 } },
  });
  assert.strictEqual(filas[0].aComprar, 95);
  assert.strictEqual(filas[0].pideCompra, true);
});

test('totales cuenta lo que pide compra y cuánto hay que comprar', () => {
  const filas = ins.aplicarNiveles(
    [{ plu:'a', stock:5, estado:ins.ESTADO.CRITICO, consumoMensual:10 },
     { plu:'b', stock:900, estado:ins.ESTADO.EXCESO, consumoMensual:1 },
     { plu:'c', stock:0, estado:ins.ESTADO.SIN_STOCK, consumoMensual:2 }],
    { a: { min:20, max:100 }, b: { min:20, max:100 } });
  const t = ins.totales(filas);
  assert.strictEqual(t.conNiveles, 2);
  assert.strictEqual(t.pideCompra, 1);
  assert.strictEqual(t.aComprar, 95);
});

test('totales cuenta por estado y suma el consumo mensual', () => {
  const filas = [
    { estado: ins.ESTADO.CRITICO, consumoMensual: 10, stock: 5 },
    { estado: ins.ESTADO.CRITICO, consumoMensual: 5,  stock: 0 },
    { estado: ins.ESTADO.OK,      consumoMensual: 2,  stock: 90 },
  ];
  const t = ins.totales(filas);
  assert.strictEqual(t.total, 3);
  assert.strictEqual(t.CRITICO, 2);
  assert.strictEqual(t.OK, 1);
  assert.strictEqual(t.EXCESO, 0);
  assert.strictEqual(t.stockCero, 1);
  assert.strictEqual(t.consumoMensual, 17);
});
