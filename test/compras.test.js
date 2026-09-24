const test = require('node:test');
const assert = require('node:assert');

const { siguienteNumero } = require('../lib/compras');

test('siguienteNumero arranca en P-0001 con lista vacía', () => {
  assert.strictEqual(siguienteNumero([]), 'P-0001');
});
test('siguienteNumero toma el máximo y suma uno', () => {
  assert.strictEqual(siguienteNumero([{ numero: 'P-0009' }]), 'P-0010');
});
test('siguienteNumero toma el máximo aunque el array esté desordenado', () => {
  assert.strictEqual(siguienteNumero([{ numero: 'P-0012' }, { numero: 'P-0003' }, { numero: 'P-0007' }]), 'P-0013');
});
test('siguienteNumero: un anulado no libera su número', () => {
  const pedidos = [{ numero: 'P-0001', estado: 'CERRADO' }, { numero: 'P-0002', estado: 'ANULADO' }];
  assert.strictEqual(siguienteNumero(pedidos), 'P-0003');
});
test('siguienteNumero ignora números con formato raro o ausentes', () => {
  const pedidos = [{ numero: 'P-0004' }, { numero: 'OC-99' }, { numero: null }, {}, { numero: 'P-XX' }];
  assert.strictEqual(siguienteNumero(pedidos), 'P-0005');
});

const { fraccionadosDe } = require('../lib/compras');

const FORMULAS = {
  '5001': { granel: '4409', cantFormula: 0.25 },
  '5002': { granel: '4409', cantFormula: 1 },
  '5003': { granel: '4409' },                    // sin cantFormula → 1
  '5004': { granel: '4409', cantFormula: 0 },    // no positivo → 1
  '5100': { granel: '9999', cantFormula: 0.5 },  // otro granel
};

test('fraccionadosDe encuentra los fraccionados de un granel', () => {
  const r = fraccionadosDe(FORMULAS, '4409');
  assert.strictEqual(r.length, 4);
  assert.deepStrictEqual(r.map(f => f.plu).sort(), ['5001', '5002', '5003', '5004']);
});
test('fraccionadosDe devuelve [] para un producto de almacén', () => {
  assert.deepStrictEqual(fraccionadosDe(FORMULAS, '1234'), []);
  assert.deepStrictEqual(fraccionadosDe(null, '1234'), []);
});
test('fraccionadosDe usa 1 cuando cantFormula falta o no es positiva', () => {
  const r = fraccionadosDe(FORMULAS, '4409');
  assert.strictEqual(r.find(f => f.plu === '5003').cantFormula, 1);
  assert.strictEqual(r.find(f => f.plu === '5004').cantFormula, 1);
});
test('fraccionadosDe tolera PLUs con espacios de SIGA', () => {
  const formulas = { ' 5001 ': { granel: '4409 ', cantFormula: 0.25 } };
  const r = fraccionadosDe(formulas, ' 4409');
  assert.deepStrictEqual(r, [{ plu: '5001', cantFormula: 0.25 }]);
});

const { stockSucursalesEq } = require('../lib/compras');

test('stockSucursalesEq convierte las presentaciones a kg de granel', () => {
  const frac = [{ plu: '5001', cantFormula: 0.25 }, { plu: '5002', cantFormula: 1 }];
  const stock = { '5001': { riv: 4 }, '5002': { riv: 2 } };
  // 4 × 0.25 + 2 × 1 = 3
  assert.strictEqual(stockSucursalesEq('4409', frac, stock).total, 3);
});
test('stockSucursalesEq suma también el stock del granel en sucursal', () => {
  const frac = [{ plu: '5001', cantFormula: 0.25 }];
  const stock = { '4409': { riv: 10 }, '5001': { riv: 4 } };
  assert.strictEqual(stockSucursalesEq('4409', frac, stock).total, 11);
});
test('stockSucursalesEq abre el equivalente por sucursal', () => {
  const frac = [{ plu: '5001', cantFormula: 0.25 }];
  const stock = { '4409': { riv: 2, urq: 1 }, '5001': { riv: 4, urq: 8 } };
  const r = stockSucursalesEq('4409', frac, stock);
  assert.deepStrictEqual(r.porSucursal, { riv: 3, urq: 3 });
  assert.strictEqual(r.total, 6);
});
test('stockSucursalesEq de almacén suma directo sin multiplicar', () => {
  const stock = { '1234': { riv: 5, urq: 7 } };
  const r = stockSucursalesEq('1234', [], stock);
  assert.strictEqual(r.total, 12);
  assert.deepStrictEqual(r.porSucursal, { riv: 5, urq: 7 });
});
test('stockSucursalesEq de un PLU sin stock devuelve 0, no undefined', () => {
  const r = stockSucursalesEq('7777', [], { '1234': { riv: 5 } });
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.porSucursal, {});
});
test('stockSucursalesEq tolera PLUs con espacios en el mapa de stock', () => {
  const stock = { '4409 ': { riv: 3 } };
  assert.strictEqual(stockSucursalesEq('4409', [], stock).total, 3);
});

const { componentesStockEq } = require('../lib/compras');

test('componentesStockEq abre el granel y sus presentaciones, y la suma cierra con stockSucursalesEq', () => {
  const frac = [{ plu: '5001', cantFormula: 0.25 }, { plu: '5002', cantFormula: 1 }];
  const stock = { '4409': { riv: 2 }, '5001': { riv: 4, urq: 8 }, '5002': { riv: 3 } };
  const comps = componentesStockEq('4409', frac, stock);
  assert.deepStrictEqual(comps.map(c => c.plu), ['4409', '5001', '5002']);
  assert.deepStrictEqual(comps.map(c => c.esPropio), [true, false, false]);
  assert.deepStrictEqual(comps.map(c => c.stockSucursales), [2, 12, 3]);
  assert.deepStrictEqual(comps.map(c => c.aporteSucursales), [2, 3, 3]);
  const suma = comps.reduce((s, c) => s + c.aporteSucursales, 0);
  assert.strictEqual(suma, stockSucursalesEq('4409', frac, stock).total);
});
test('componentesStockEq abre el stock crudo por sucursal, sin convertir', () => {
  const comps = componentesStockEq('4409', [{ plu: '5001', cantFormula: 0.25 }],
    { '4409': { riv: 2 }, '5001': { riv: 4, urq: 8 } });
  assert.deepStrictEqual(comps[0].porSucursal, { riv: 2 });
  assert.deepStrictEqual(comps[1].porSucursal, { riv: 4, urq: 8 });
});
test('componentesStockEq de un producto de almacén devuelve una sola entrada', () => {
  const comps = componentesStockEq('1234', [], { '1234': { riv: 5, urq: 7 } });
  assert.strictEqual(comps.length, 1);
  assert.deepStrictEqual(comps[0], { plu: '1234', cantFormula: 1, esPropio: true,
    stockSucursales: 12, porSucursal: { riv: 5, urq: 7 }, aporteSucursales: 12 });
});
test('componentesStockEq de un PLU sin stock devuelve 0, no undefined', () => {
  const comps = componentesStockEq('7777', [{ plu: '8888', cantFormula: 0.5 }], { '1234': { riv: 5 } });
  assert.deepStrictEqual(comps.map(c => c.stockSucursales), [0, 0]);
  assert.deepStrictEqual(comps.map(c => c.aporteSucursales), [0, 0]);
  assert.deepStrictEqual(comps.map(c => c.porSucursal), [{}, {}]);
});
test('componentesStockEq normaliza los PLUs con espacios de SIGA', () => {
  const comps = componentesStockEq(' 4409', [{ plu: '5001 ', cantFormula: 0.25 }],
    { '4409 ': { riv: 2 }, ' 5001': { riv: 4 } });
  assert.deepStrictEqual(comps.map(c => c.plu), ['4409', '5001']);
  assert.deepStrictEqual(comps.map(c => c.aporteSucursales), [2, 1]);
});

const { ventasEq } = require('../lib/compras');

test('ventasEq convierte las ventas fraccionadas a kg de granel', () => {
  const frac = [{ plu: '5001', cantFormula: 0.25 }, { plu: '5002', cantFormula: 1 }];
  const ventas = { '4409': 5, '5001': 8, '5002': 3 };
  // 5 + 8×0.25 + 3×1 = 10
  assert.strictEqual(ventasEq('4409', frac, ventas), 10);
});
test('ventasEq de almacén no convierte nada', () => {
  assert.strictEqual(ventasEq('1234', [], { '1234': 42 }), 42);
});
test('ventasEq de un PLU sin ventas devuelve 0', () => {
  assert.strictEqual(ventasEq('7777', [], { '1234': 42 }), 0);
});

const { demandaDiaria } = require('../lib/compras');

test('demandaDiaria promedia los 3 meses cerrados', () => {
  const serie = [
    { mes: '2026-05', total: 30 },
    { mes: '2026-06', total: 30 },
    { mes: '2026-07', total: 30 },
  ];
  const esperado = Math.round((90 / (3 * 30.44)) * 10000) / 10000;
  assert.strictEqual(demandaDiaria(serie, { hoyISO: '2026-08-15' }), esperado);
});
test('demandaDiaria excluye el mes en curso porque está parcial', () => {
  const serie = [
    { mes: '2026-08', total: 900 }, // mes de hoy: no debe entrar
    { mes: '2026-05', total: 30 },
    { mes: '2026-06', total: 30 },
    { mes: '2026-07', total: 30 },
  ];
  const esperado = Math.round((90 / (3 * 30.44)) * 10000) / 10000;
  assert.strictEqual(demandaDiaria(serie, { hoyISO: '2026-08-15' }), esperado);
});
test('demandaDiaria cuenta como 0 el mes faltante sin cambiar el divisor', () => {
  const serie = [{ mes: '2026-07', total: 30 }, { mes: '2026-05', total: 30 }]; // falta 2026-06
  const esperado = Math.round((60 / (3 * 30.44)) * 10000) / 10000;
  assert.strictEqual(demandaDiaria(serie, { hoyISO: '2026-08-15' }), esperado);
});
test('demandaDiaria con serie vacía o suma 0 devuelve null', () => {
  assert.strictEqual(demandaDiaria([], { hoyISO: '2026-08-15' }), null);
  assert.strictEqual(demandaDiaria([{ mes: '2026-07', total: 0 }], { hoyISO: '2026-08-15' }), null);
});
test('demandaDiaria en enero mira oct/nov/dic del año anterior', () => {
  const serie = [
    { mes: '2025-10', total: 10 },
    { mes: '2025-11', total: 20 },
    { mes: '2025-12', total: 30 },
    { mes: '2025-09', total: 999 }, // fuera de la ventana
  ];
  const esperado = Math.round((60 / (3 * 30.44)) * 10000) / 10000;
  assert.strictEqual(demandaDiaria(serie, { hoyISO: '2026-01-05' }), esperado);
});
test('demandaDiaria respeta el parámetro meses', () => {
  const serie = [{ mes: '2026-07', total: 60 }, { mes: '2026-06', total: 60 }];
  const esperado = Math.round((60 / (1 * 30.44)) * 10000) / 10000;
  assert.strictEqual(demandaDiaria(serie, { hoyISO: '2026-08-15', meses: 1 }), esperado);
});

const { coberturaDias } = require('../lib/compras');

test('coberturaDias sin demanda devuelve null', () => {
  assert.strictEqual(coberturaDias(100, 0), null);
  assert.strictEqual(coberturaDias(100, null), null);
  assert.strictEqual(coberturaDias(100, -3), null);
});
test('coberturaDias con stock 0 devuelve 0', () => {
  assert.strictEqual(coberturaDias(0, 5), 0);
});
test('coberturaDias redondea a 1 decimal', () => {
  assert.strictEqual(coberturaDias(10, 3), 3.3);
  assert.strictEqual(coberturaDias(100, 7), 14.3);
});

const { diasEntre, sumarDias } = require('../lib/compras');

test('diasEntre cruza mes y año', () => {
  assert.strictEqual(diasEntre('2026-01-28', '2026-02-03'), 6);
  assert.strictEqual(diasEntre('2025-12-30', '2026-01-02'), 3);
});
test('diasEntre de la misma fecha es 0 y admite negativos', () => {
  assert.strictEqual(diasEntre('2026-03-10', '2026-03-10'), 0);
  assert.strictEqual(diasEntre('2026-03-10', '2026-03-08'), -2);
});
test('diasEntre con fecha inválida devuelve null', () => {
  assert.strictEqual(diasEntre('10/03/2026', '2026-03-11'), null);
  assert.strictEqual(diasEntre('2026-03-10', null), null);
  assert.strictEqual(diasEntre(undefined, undefined), null);
});
test('diasEntre no corre un día por huso horario', () => {
  // En zona -03 la aritmética local desplaza estas fechas; en UTC son exactas.
  assert.strictEqual(diasEntre('2026-01-01', '2026-01-02'), 1);
  assert.strictEqual(diasEntre('2026-11-01', '2026-11-02'), 1); // cambio de hora en el hemisferio norte
  assert.strictEqual(diasEntre('2026-03-01', '2026-04-01'), 31);
});

test('sumarDias suma y resta cruzando mes y año', () => {
  assert.strictEqual(sumarDias('2026-01-28', 5), '2026-02-02');
  assert.strictEqual(sumarDias('2026-01-02', -3), '2025-12-30');
  assert.strictEqual(sumarDias('2025-12-31', 1), '2026-01-01');
});
test('sumarDias con 0 devuelve la misma fecha (sin corrimiento de huso)', () => {
  assert.strictEqual(sumarDias('2026-06-15', 0), '2026-06-15');
  assert.strictEqual(sumarDias('2026-01-01', 0), '2026-01-01');
});
test('sumarDias con entrada inválida devuelve null', () => {
  assert.strictEqual(sumarDias('ayer', 1), null);
  assert.strictEqual(sumarDias(null, 1), null);
});

const { construirPedido } = require('../lib/compras');

const ITEMS_OK = [
  { plu: '4409 ', nombre: 'Nuez granel', unidad: 'kg', cantidad: 10 },
  { plu: '1234', nombre: 'Aceite', unidad: 'un', cantidad: 6 },
];

test('construirPedido normaliza las líneas y arranca PENDIENTE', () => {
  const p = construirPedido({
    numero: 'P-0001', fechaISO: '2026-08-01', proveedor: 'ACME', idProveedor: 77,
    usuario: 'adriel', items: ITEMS_OK, ts: '2026-08-01T10:00:00.000Z',
  });
  assert.strictEqual(p.numero, 'P-0001');
  assert.strictEqual(p.fecha, '2026-08-01');
  assert.strictEqual(p.proveedor, 'ACME');
  assert.strictEqual(p.idProveedor, 77);
  assert.strictEqual(p.estado, 'PENDIENTE');
  assert.strictEqual(p.fechaEstimada, null);
  assert.strictEqual(p.fechaRetiro, null);
  assert.strictEqual(p.observacion, '');
  assert.deepStrictEqual(p.items[0], {
    plu: '4409', nombre: 'Nuez granel', unidad: 'kg', cantidad: 10, precioUnitario: null,
    cantidadEntregada: null, estado: 'pedido', obs: '',
  });
  assert.strictEqual(p.total, null);
});
test('construirPedido calcula el total estimado cuando los items traen precio', () => {
  const p = construirPedido({
    numero: 'P-0001', fechaISO: '2026-08-01', proveedor: 'ACME',
    items: [
      { plu: '4409', nombre: 'Nuez granel', unidad: 'kg', cantidad: 10, precio: 500 },
      { plu: '1234', nombre: 'Aceite', unidad: 'un', cantidad: 6 },
    ],
  });
  assert.strictEqual(p.items[0].precioUnitario, 500);
  assert.strictEqual(p.items[1].precioUnitario, null);
  // El item sin precio no suma: el total es sólo lo que sí se pudo estimar.
  assert.strictEqual(p.total, 5000);
});
test('construirPedido registra el ts inyectado en el historial', () => {
  const p = construirPedido({
    numero: 'P-0001', fechaISO: '2026-08-01', proveedor: 'ACME',
    usuario: 'adriel', items: ITEMS_OK, ts: '2026-08-01T10:00:00.000Z',
  });
  assert.deepStrictEqual(p.historial, [
    { ts: '2026-08-01T10:00:00.000Z', usuario: 'adriel', accion: 'creado' },
  ]);
});
test('construirPedido rechaza items vacíos o ausentes', () => {
  assert.throws(() => construirPedido({ numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME', items: [] }), /items/i);
  assert.throws(() => construirPedido({ numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME' }), /items/i);
});
test('construirPedido rechaza pedido sin proveedor', () => {
  assert.throws(() => construirPedido({ numero: 'P-1', fechaISO: '2026-08-01', proveedor: '', items: ITEMS_OK }), /proveedor/i);
});
test('construirPedido rechaza cantidades no positivas', () => {
  const base = { numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME' };
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1', cantidad: 0 }] }), /cantidad/i);
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1', cantidad: -5 }] }), /cantidad/i);
});
test('construirPedido rechaza cantidades no numéricas o ausentes', () => {
  const base = { numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME' };
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1', cantidad: 'mucho' }] }), /cantidad/i);
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1' }] }), /cantidad/i);
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1', cantidad: null }] }), /cantidad/i);
});

const { aplicarSeguimiento } = require('../lib/compras');

function pedidoBase() {
  return {
    numero: 'P-0001', idProveedor: 7, proveedor: 'ACME', fecha: '2026-08-01', usuario: 'adriel',
    estado: 'PENDIENTE', fechaEstimada: null, fechaRetiro: null, observacion: '',
    items: [
      { plu: '4409', nombre: 'Nuez', unidad: 'kg', cantidad: 10, cantidadEntregada: null, estado: 'pedido', obs: '' },
      { plu: '1234', nombre: 'Aceite', unidad: 'un', cantidad: 6, cantidadEntregada: null, estado: 'pedido', obs: '' },
    ],
    historial: [{ ts: '2026-08-01T10:00:00.000Z', usuario: 'adriel', accion: 'creado' }],
  };
}
const CTX = { ts: '2026-08-05T12:00:00.000Z', usuario: 'flor' };

test('aplicarSeguimiento no muta el pedido original', () => {
  const p = pedidoBase();
  const copia = JSON.parse(JSON.stringify(p));
  aplicarSeguimiento(p, {
    fechaEstimada: '2026-08-10', observacion: 'llega el lunes',
    items: [{ plu: '4409', estado: 'entregado' }],
  }, CTX);
  assert.deepStrictEqual(p, copia);
});
test('aplicarSeguimiento mergea por plu sin perder las líneas no mencionadas', () => {
  const r = aplicarSeguimiento(pedidoBase(), { items: [{ plu: '1234', estado: 'entregado', cantidadEntregada: 4 }] }, CTX);
  assert.strictEqual(r.items.length, 2);
  assert.strictEqual(r.items[0].estado, 'pedido');
  assert.strictEqual(r.items[0].cantidadEntregada, null);
  assert.strictEqual(r.items[1].estado, 'entregado');
  assert.strictEqual(r.items[1].cantidadEntregada, 4);
});
test('aplicarSeguimiento: entregado sin cantidad asume la cantidad pedida', () => {
  const r = aplicarSeguimiento(pedidoBase(), { items: [{ plu: '4409', estado: 'entregado' }] }, CTX);
  assert.strictEqual(r.items[0].cantidadEntregada, 10);
});
test('aplicarSeguimiento: sin_stock y no_envia dejan la entrega en 0', () => {
  const r = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'sin_stock', cantidadEntregada: 9 }, { plu: '1234', estado: 'no_envia' }],
  }, CTX);
  assert.strictEqual(r.items[0].cantidadEntregada, 0);
  assert.strictEqual(r.items[1].cantidadEntregada, 0);
});
test('aplicarSeguimiento: volver a pedido borra la cantidad entregada', () => {
  const entregado = aplicarSeguimiento(pedidoBase(), { items: [{ plu: '4409', estado: 'entregado' }] }, CTX);
  const r = aplicarSeguimiento(entregado, { items: [{ plu: '4409', estado: 'pedido' }] }, CTX);
  assert.strictEqual(r.items[0].cantidadEntregada, null);
});
test('aplicarSeguimiento agrega exactamente una entrada de historial por llamada', () => {
  const r = aplicarSeguimiento(pedidoBase(), { fechaEstimada: '2026-08-10' }, CTX);
  assert.strictEqual(r.historial.length, 2);
  assert.deepStrictEqual(r.historial[1], { ts: CTX.ts, usuario: 'flor', accion: 'seguimiento' });
  assert.strictEqual(r.estado, 'PENDIENTE');
  assert.strictEqual(r.fechaEstimada, '2026-08-10');
});
test('aplicarSeguimiento rechaza cerrar sin fecha de retiro', () => {
  const listo = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'entregado' }, { plu: '1234', estado: 'entregado' }],
  }, CTX);
  assert.throws(() => aplicarSeguimiento(listo, { estado: 'CERRADO' }, CTX), /retiro/i);
});
test('aplicarSeguimiento rechaza cerrar con líneas todavía en pedido', () => {
  const p = pedidoBase();
  assert.throws(() => aplicarSeguimiento(p, { estado: 'CERRADO', fechaRetiro: '2026-08-09' }, CTX), /cerrar/i);
});
test('aplicarSeguimiento cierra bien y deja accion cerrado', () => {
  const r = aplicarSeguimiento(pedidoBase(), {
    estado: 'CERRADO', fechaRetiro: '2026-08-09',
    items: [{ plu: '4409', estado: 'entregado' }, { plu: '1234', estado: 'sin_stock' }],
  }, CTX);
  assert.strictEqual(r.estado, 'CERRADO');
  assert.strictEqual(r.fechaRetiro, '2026-08-09');
  assert.strictEqual(r.historial.at(-1).accion, 'cerrado');
});
test('aplicarSeguimiento anula sin exigir nada', () => {
  const r = aplicarSeguimiento(pedidoBase(), { estado: 'ANULADO' }, CTX);
  assert.strictEqual(r.estado, 'ANULADO');
  assert.strictEqual(r.historial.at(-1).accion, 'anulado');
});
test('aplicarSeguimiento rechaza estados desconocidos', () => {
  assert.throws(() => aplicarSeguimiento(pedidoBase(), { estado: 'RECIBIDO' }, CTX), /estado de pedido/i);
  assert.throws(() => aplicarSeguimiento(pedidoBase(), { items: [{ plu: '4409', estado: 'llegando' }] }, CTX), /estado de línea/i);
});
test('aplicarSeguimiento rechaza un estado de línea inválido aunque el plu no exista', () => {
  assert.throws(() => aplicarSeguimiento(pedidoBase(), { items: [{ plu: '999', estado: 'zzz' }] }, CTX), /estado de línea/i);
});
test('aplicarSeguimiento: corregir sólo la obs no pisa la cantidad entregada', () => {
  const parcial = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'entregado', cantidadEntregada: 5 }],
  }, CTX);
  assert.strictEqual(parcial.items[0].cantidadEntregada, 5);
  const r = aplicarSeguimiento(parcial, { items: [{ plu: '4409', obs: 'llegó roto' }] }, CTX);
  assert.strictEqual(r.items[0].cantidadEntregada, 5); // sigue siendo entrega parcial
  assert.strictEqual(r.items[0].estado, 'entregado');
  assert.strictEqual(r.items[0].obs, 'llegó roto');
});
test('aplicarSeguimiento: cantidadEntregada null o vacía cuenta como no declarada', () => {
  const conNull = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'entregado', cantidadEntregada: null }],
  }, CTX);
  assert.strictEqual(conNull.items[0].cantidadEntregada, 10);
  const conVacio = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'entregado', cantidadEntregada: '' }],
  }, CTX);
  assert.strictEqual(conVacio.items[0].cantidadEntregada, 10);
});
test('aplicarSeguimiento: cambiar la cantidad sin repetir el estado respeta el estado de la línea', () => {
  const entregado = aplicarSeguimiento(pedidoBase(), { items: [{ plu: '4409', estado: 'entregado' }] }, CTX);
  const r = aplicarSeguimiento(entregado, { items: [{ plu: '4409', cantidadEntregada: 7 }] }, CTX);
  assert.strictEqual(r.items[0].estado, 'entregado');
  assert.strictEqual(r.items[0].cantidadEntregada, 7);
});
test('aplicarSeguimiento: un plu no pedido con estado extra se agrega como línea nueva', () => {
  const r = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '5555', estado: 'extra', nombre: 'Regalo del proveedor', unidad: 'kg',
      cantidadEntregada: 3, precioUnitario: 120, obs: 'vino de yapa' }],
  }, CTX);
  assert.strictEqual(r.items.length, 3);
  const extra = r.items.find(it => it.plu === '5555');
  assert.strictEqual(extra.estado, 'extra');
  assert.strictEqual(extra.cantidad, 0);
  assert.strictEqual(extra.cantidadEntregada, 3);
  assert.strictEqual(extra.precioUnitario, 120);
  assert.strictEqual(extra.nombre, 'Regalo del proveedor');
  assert.strictEqual(extra.obs, 'vino de yapa');
  // Las líneas pedidas originales siguen intactas.
  assert.strictEqual(r.items[0].plu, '4409');
  assert.strictEqual(r.items[1].plu, '1234');
});
test('aplicarSeguimiento: reaplicar un extra ya agregado actualiza en vez de duplicar', () => {
  const primera = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '5555', estado: 'extra', nombre: 'Yapa', cantidadEntregada: 2 }],
  }, CTX);
  const segunda = aplicarSeguimiento(primera, {
    items: [{ plu: '5555', estado: 'extra', cantidadEntregada: 5 }],
  }, CTX);
  assert.strictEqual(segunda.items.length, 3);
  assert.strictEqual(segunda.items.filter(it => it.plu === '5555').length, 1);
  assert.strictEqual(segunda.items.find(it => it.plu === '5555').cantidadEntregada, 5);
});
test('aplicarSeguimiento: una línea extra no bloquea el cierre ni pide fecha por sí sola', () => {
  const r = aplicarSeguimiento(pedidoBase(), {
    estado: 'CERRADO', fechaRetiro: '2026-08-09',
    items: [
      { plu: '4409', estado: 'entregado' }, { plu: '1234', estado: 'entregado' },
      { plu: '5555', estado: 'extra', cantidadEntregada: 1 },
    ],
  }, CTX);
  assert.strictEqual(r.estado, 'CERRADO');
});
test('otif: una línea extra no cuenta como incumplimiento del pedido', () => {
  const pedidos = [{
    numero: 'P-1', proveedor: 'ACME', fecha: '2026-08-01', fechaEstimada: '2026-08-05',
    fechaRetiro: '2026-08-05', estado: 'CERRADO',
    items: [
      { plu: '1', nombre: 'A', cantidad: 10, cantidadEntregada: 10, estado: 'entregado' },
      { plu: '2', nombre: 'Yapa', cantidad: 0, cantidadEntregada: 4, estado: 'extra' },
    ],
  }];
  const r = otif(pedidos);
  assert.strictEqual(r.inFullLineas, 100);
  assert.strictEqual(r.onTime, 100);
});
test('aplicarSeguimiento: undefined no toca las fechas, "" y null las borran', () => {
  const conFechas = aplicarSeguimiento(pedidoBase(), { fechaEstimada: '2026-08-10', fechaRetiro: '2026-08-09' }, CTX);
  assert.strictEqual(conFechas.fechaEstimada, '2026-08-10');
  assert.strictEqual(conFechas.fechaRetiro, '2026-08-09');

  const intacto = aplicarSeguimiento(conFechas, { observacion: 'sin novedad' }, CTX);
  assert.strictEqual(intacto.fechaEstimada, '2026-08-10');
  assert.strictEqual(intacto.fechaRetiro, '2026-08-09');

  const borrado = aplicarSeguimiento(conFechas, { fechaEstimada: '', fechaRetiro: null }, CTX);
  assert.strictEqual(borrado.fechaEstimada, null);
  assert.strictEqual(borrado.fechaRetiro, null);
});

const { otif } = require('../lib/compras');

function pedidoCerrado(over = {}) {
  return {
    numero: 'P-0001', proveedor: 'ACME', fecha: '2026-08-01', estado: 'CERRADO',
    fechaEstimada: '2026-08-10', fechaRetiro: '2026-08-08',
    items: [{ plu: '4409', nombre: 'Nuez', cantidad: 10, cantidadEntregada: 10, estado: 'entregado' }],
    ...over,
  };
}

test('otif de un pedido a tiempo y completo da 100 en todo', () => {
  const r = otif([pedidoCerrado()]);
  assert.strictEqual(r.pedidos, 1);
  assert.strictEqual(r.onTime, 100);
  assert.strictEqual(r.inFullLineas, 100);
  assert.strictEqual(r.inFullCantidad, 100);
  assert.strictEqual(r.otif, 100);
});
test('otif con 1 de 2 líneas sin stock baja inFull', () => {
  const r = otif([pedidoCerrado({
    items: [
      { plu: '4409', nombre: 'Nuez', cantidad: 10, cantidadEntregada: 10, estado: 'entregado' },
      { plu: '1234', nombre: 'Aceite', cantidad: 6, cantidadEntregada: 0, estado: 'sin_stock' },
    ],
  })]);
  assert.strictEqual(r.inFullLineas, 50);
  assert.strictEqual(r.inFullCantidad, 62.5); // 10 de 16
  assert.strictEqual(r.onTime, 100);
  assert.strictEqual(r.otif, 0); // a tiempo pero incompleto
});
test('otif con retiro un día tarde da onTime 0', () => {
  const r = otif([pedidoCerrado({ fechaRetiro: '2026-08-11' })]);
  assert.strictEqual(r.onTime, 0);
  assert.strictEqual(r.inFullLineas, 100);
  assert.strictEqual(r.otif, 0);
});
test('otif excluye pedidos PENDIENTE y ANULADO', () => {
  const r = otif([
    pedidoCerrado(),
    pedidoCerrado({ numero: 'P-0002', estado: 'PENDIENTE', fechaRetiro: null }),
    pedidoCerrado({ numero: 'P-0003', estado: 'ANULADO', fechaRetiro: '2026-08-30' }),
  ]);
  assert.strictEqual(r.pedidos, 1);
  assert.strictEqual(r.leadTime.n, 1);
});
test('otif deja fuera del denominador de onTime al pedido sin fechaEstimada', () => {
  const r = otif([
    pedidoCerrado({ numero: 'P-0001', fechaRetiro: '2026-08-11' }),          // tarde
    pedidoCerrado({ numero: 'P-0002', fechaEstimada: null }),                // sin compromiso
  ]);
  assert.strictEqual(r.pedidos, 2);
  assert.strictEqual(r.onTime, 0);          // denominador 1, ninguno a tiempo
  assert.strictEqual(r.inFullLineas, 100);  // ambos entran a inFull
  assert.strictEqual(r.inFullCantidad, 100);
});
test('otif sin pedidos devuelve métricas en null sin romper', () => {
  const r = otif([]);
  assert.strictEqual(r.pedidos, 0);
  assert.strictEqual(r.onTime, null);
  assert.strictEqual(r.inFullLineas, null);
  assert.strictEqual(r.inFullCantidad, null);
  assert.strictEqual(r.otif, null);
  assert.deepStrictEqual(r.leadTime, { medio: null, mediana: null, min: null, max: null, n: 0 });
  assert.deepStrictEqual(r.quiebres, []);
  assert.deepStrictEqual(r.porProveedor, []);
});
test('otif filtra por proveedor y por rango de fechas inclusive', () => {
  const pedidos = [
    pedidoCerrado({ numero: 'P-0001', proveedor: 'ACME', fecha: '2026-08-01' }),
    pedidoCerrado({ numero: 'P-0002', proveedor: 'BETA', fecha: '2026-08-05' }),
    pedidoCerrado({ numero: 'P-0003', proveedor: 'ACME', fecha: '2026-09-15' }),
  ];
  assert.strictEqual(otif(pedidos, { proveedor: 'ACME' }).pedidos, 2);
  assert.strictEqual(otif(pedidos, { desde: '2026-08-05' }).pedidos, 2);
  assert.strictEqual(otif(pedidos, { hasta: '2026-08-05' }).pedidos, 2); // inclusive
  assert.strictEqual(otif(pedidos, { desde: '2026-08-01', hasta: '2026-08-01' }).pedidos, 1);
  assert.strictEqual(otif(pedidos, { proveedor: 'BETA', desde: '2026-09-01' }).pedidos, 0);
});
test('otif ordena los quiebres por veces desc y suma lo no entregado', () => {
  const pedidos = [
    pedidoCerrado({ numero: 'P-0001', items: [
      { plu: '1234', nombre: 'Aceite', cantidad: 6, cantidadEntregada: 0, estado: 'sin_stock' },
      { plu: '5555', nombre: 'Sal', cantidad: 4, cantidadEntregada: 0, estado: 'no_envia' },
    ] }),
    pedidoCerrado({ numero: 'P-0002', items: [
      { plu: '1234', nombre: 'Aceite', cantidad: 10, cantidadEntregada: 0, estado: 'sin_stock' },
    ] }),
  ];
  const q = otif(pedidos).quiebres;
  assert.strictEqual(q.length, 2);
  assert.strictEqual(q[0].plu, '1234');
  assert.strictEqual(q[0].veces, 2);
  assert.strictEqual(q[0].pedidosDistintos, 2);
  assert.strictEqual(q[0].cantidadNoEntregada, 16);
  assert.strictEqual(q[0].sinStock, 2);
  assert.strictEqual(q[0].noEnvia, 0);
  assert.strictEqual(q[1].plu, '5555');
  assert.strictEqual(q[1].noEnvia, 1);
  assert.strictEqual(q[1].cantidadNoEntregada, 4);
});
test('otif calcula la mediana de lead time con n par', () => {
  const r = otif([
    pedidoCerrado({ numero: 'P-0001', fecha: '2026-08-01', fechaRetiro: '2026-08-03' }), // 2
    pedidoCerrado({ numero: 'P-0002', fecha: '2026-08-01', fechaRetiro: '2026-08-05' }), // 4
  ]);
  assert.deepStrictEqual(r.leadTime, { medio: 3, mediana: 3, min: 2, max: 4, n: 2 });
});
test('otif calcula la mediana de lead time con n impar', () => {
  const r = otif([
    pedidoCerrado({ numero: 'P-0001', fecha: '2026-08-01', fechaRetiro: '2026-08-10' }), // 9
    pedidoCerrado({ numero: 'P-0002', fecha: '2026-08-01', fechaRetiro: '2026-08-03' }), // 2
    pedidoCerrado({ numero: 'P-0003', fecha: '2026-08-01', fechaRetiro: '2026-08-05' }), // 4
  ]);
  assert.strictEqual(r.leadTime.mediana, 4);
  assert.strictEqual(r.leadTime.min, 2);
  assert.strictEqual(r.leadTime.max, 9);
  assert.strictEqual(r.leadTime.n, 3);
});
test('otif agrupa por proveedor ordenado por cantidad de pedidos', () => {
  const pedidos = [
    pedidoCerrado({ numero: 'P-0001', proveedor: 'ACME' }),
    pedidoCerrado({ numero: 'P-0002', proveedor: 'ACME', fechaRetiro: '2026-08-11' }),
    pedidoCerrado({ numero: 'P-0003', proveedor: 'BETA' }),
  ];
  const pp = otif(pedidos).porProveedor;
  assert.strictEqual(pp.length, 2);
  assert.strictEqual(pp[0].proveedor, 'ACME');
  assert.strictEqual(pp[0].pedidos, 2);
  assert.strictEqual(pp[0].onTime, 50);
  assert.strictEqual(pp[0].inFullLineas, 100);
  assert.strictEqual(pp[1].proveedor, 'BETA');
  assert.strictEqual(pp[1].leadTimeMediana, 7);
});

test('la cantidad entregada se acota al rango de la línea', () => {
  const negativo = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'entregado', cantidadEntregada: -5 }],
  }, CTX);
  assert.strictEqual(negativo.items[0].cantidadEntregada, 0);

  const excedido = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '4409', estado: 'entregado', cantidadEntregada: 99 }],
  }, CTX);
  assert.strictEqual(excedido.items[0].cantidadEntregada, 10);

  // Sin repetir el estado: el mismo clamp aplica sobre una línea ya entregada.
  const yaEntregada = aplicarSeguimiento(pedidoBase(), {
    items: [{ plu: '1234', estado: 'entregado' }],
  }, CTX);
  const corregida = aplicarSeguimiento(yaEntregada, {
    items: [{ plu: '1234', cantidadEntregada: -3 }],
  }, CTX);
  assert.strictEqual(corregida.items[1].cantidadEntregada, 0);
});

// ── Compra por bultos ────────────────────────────────────────────────────────
const { normalizarPresentacion } = require('../lib/compras');

test('normalizarPresentacion acepta nombre y unidades por bulto', () => {
  assert.deepStrictEqual(normalizarPresentacion({ nombre: ' Caja ', unidadesPorBulto: '12' }),
    { nombre: 'Caja', unidadesPorBulto: 12 });
  // Sin nombre, se asume caja: es el caso que motivó la opción.
  assert.deepStrictEqual(normalizarPresentacion({ unidadesPorBulto: 6 }), { nombre: 'Caja', unidadesPorBulto: 6 });
});
test('normalizarPresentacion rechaza unidades por bulto inválidas', () => {
  for (const u of [0, -3, 'abc', null, undefined, Infinity]) {
    assert.throws(() => normalizarPresentacion({ nombre: 'Caja', unidadesPorBulto: u }), /unidades por bulto/i);
  }
});
test('construirPedido con bultos: la cantidad sale de bultos × unidades por bulto', () => {
  const p = construirPedido({
    numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME',
    items: [{ plu: '1234', nombre: 'Aceite', unidad: 'UN', cantidad: 999, bultos: 5,
      presentacion: { nombre: 'Caja', unidadesPorBulto: 12 } }],
  });
  assert.strictEqual(p.items[0].cantidad, 60);
  assert.strictEqual(p.items[0].bultos, 5);
  assert.deepStrictEqual(p.items[0].presentacion, { nombre: 'Caja', unidadesPorBulto: 12 });
});
test('construirPedido con bultos rechaza bultos inválidos o presentación faltante', () => {
  const base = { numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME' };
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1', cantidad: 1, bultos: 0,
    presentacion: { unidadesPorBulto: 12 } }] }), /bultos/i);
  assert.throws(() => construirPedido({ ...base, items: [{ plu: '1', cantidad: 1, bultos: 2 }] }), /unidades por bulto/i);
});
test('construirPedido conserva nuevo:true sólo en la línea de un artículo que no está en SIGA', () => {
  const p = construirPedido({
    numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME',
    items: [
      { plu: '1234', nombre: 'Aceite', unidad: 'UN', cantidad: 6 },
      { plu: 'NUEVO-abc123', nombre: 'Harina de almendra', unidad: 'KG', cantidad: 5, nuevo: true },
    ],
  });
  assert.strictEqual('nuevo' in p.items[0], false);
  assert.strictEqual(p.items[1].nuevo, true);
  assert.strictEqual(p.items[1].plu, 'NUEVO-abc123');
  assert.strictEqual(p.items[1].nombre, 'Harina de almendra');
  assert.strictEqual(p.items[1].unidad, 'KG');
});
test('aplicarSeguimiento mantiene nuevo:true en la línea al actualizar su estado', () => {
  const p = construirPedido({
    numero: 'P-1', fechaISO: '2026-08-01', proveedor: 'ACME',
    items: [{ plu: 'NUEVO-abc123', nombre: 'Harina de almendra', unidad: 'KG', cantidad: 5, nuevo: true }],
  });
  const r = aplicarSeguimiento(p, { items: [{ plu: 'NUEVO-abc123', estado: 'entregado' }] });
  assert.strictEqual(r.items[0].nuevo, true);
  assert.strictEqual(r.items[0].estado, 'entregado');
});
