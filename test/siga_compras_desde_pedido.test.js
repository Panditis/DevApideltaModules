'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { borradorDesdePedido, aplicarEdicion, cabeceraSugerida } = require('../lib/siga_compras/desde_pedido');
const { validarComprobante } = require('../lib/siga_compras/validaciones');
const { filasImpuestosTodas } = require('../lib/siga_compras/impuestos');
const { borradorFactcom, contextoFactcom } = require('./siga_compras_fixture');

const PEDIDO = {
  numero: 'P-0007', idProveedor: 328, proveedor: 'PROVEEDOR RI', fecha: '2026-10-01', estado: 'CERRADO',
  items: [
    { plu: ' 1001 ', nombre: 'Harina', cantidad: 2, precioUnitario: 31839.64, cantidadEntregada: 1, estado: 'entregado', obs: '' },
    { plu: '1002', nombre: 'Huevos', cantidad: 24, bultos: 2, presentacion: { nombre: 'Caja', unidadesPorBulto: 12 }, precioUnitario: null, cantidadEntregada: 24, estado: 'entregado', obs: '' },
    { plu: '1003', nombre: 'Azúcar', cantidad: 5, precioUnitario: 900, cantidadEntregada: 0, estado: 'faltante', obs: '' },
    { plu: '1004', nombre: 'Sal', cantidad: 5, precioUnitario: 300, cantidadEntregada: 0, estado: 'sin_stock', obs: '' },
    { plu: '1005', nombre: 'Aceite', cantidad: 5, precioUnitario: 300, cantidadEntregada: 0, estado: 'no_envia', obs: '' },
    { plu: '1006', nombre: 'Yerba', cantidad: 0, precioUnitario: 1500, cantidadEntregada: 3, estado: 'extra', obs: '' },
    { plu: 'NUEVO-ab12', nombre: 'Té nuevo', cantidad: 2, precioUnitario: 100, cantidadEntregada: 2, estado: 'entregado', obs: '', nuevo: true },
  ],
};
const con = cambios => ({ ...PEDIDO, ...cambios });

const CATALOGOS = {
  proveedor: { idProveedor: 328, nombre: 'PROVEEDOR RI', idTipoComprobante: 'FACTCOM', idFormasPago: 3, descuentoRecargoPorc: -5, letraFiscalCompra: 'A', ivaDiscriminado: true },
  tipos: [
    { idTipoComprobante: 'COTIZACIONCOM', descripcion: 'Cotización de compra', letrasHabilitadas: ['X'], numeracionAutomatica: true, grabaLibro: false },
    { idTipoComprobante: 'FACTCOM', descripcion: 'Factura de compra', letrasHabilitadas: ['A', 'B', 'C', 'E', 'I', 'M'], numeracionAutomatica: false, grabaLibro: true },
  ],
  ubicaciones: [
    { idSucursal: 1, idDeposito: 2, idUbicacion: 5, nombre: 'Depósito 2 · Ubicación 5' },
    { idSucursal: 11, idDeposito: 1, idUbicacion: 1, nombre: 'Depósito 1 · Ubicación 1' },
  ],
  periodos: [202610, 202609],
};

test('borradorDesdePedido: entregado con cantidadEntregada + extra; quiebres descartados', () => {
  const b = borradorDesdePedido(PEDIDO);
  assert.strictEqual(b.numeroPedido, 'P-0007');
  assert.strictEqual(b.idProveedor, 328);
  assert.deepStrictEqual(b.lineas, [
    { orden: 1, plu: '1001', nombre: 'Harina', cantidad: 1, precio: 31839.64 },
    { orden: 2, plu: '1002', nombre: 'Huevos', cantidad: 24, precio: null },
    { orden: 3, plu: '1006', nombre: 'Yerba', cantidad: 3, precio: 1500 },
    { orden: 4, plu: 'NUEVO-ab12', nombre: 'Té nuevo', cantidad: 2, precio: 100, nuevo: true },
  ]);
  assert.deepStrictEqual(b.descartadas, [
    { plu: '1003', nombre: 'Azúcar', estado: 'faltante' },
    { plu: '1004', nombre: 'Sal', estado: 'sin_stock' },
    { plu: '1005', nombre: 'Aceite', estado: 'no_envia' },
  ]);
  assert.deepStrictEqual(b.bloqueos, [
    { tipo: 'dato', mensaje: 'El artículo Té nuevo todavía no existe en SIGA (NUEVO-ab12).' },
    { tipo: 'dato', mensaje: 'Huevos no tiene precio: cargalo antes de grabar.' },
  ]);
});

test('bloqueos de estado: líneas sin resolver, vinculado, anulado, sin proveedor, nada entregado', () => {
  const estados = b => b.bloqueos.filter(x => x.tipo === 'estado').map(x => x.mensaje);
  const conPendiente = con({ items: [...PEDIDO.items, { plu: '1007', nombre: 'Arroz', cantidad: 1, precioUnitario: 10, cantidadEntregada: null, estado: 'pedido', obs: '' }] });
  assert.deepStrictEqual(estados(borradorDesdePedido(conPendiente)), ['El pedido tiene líneas sin resolver en el seguimiento.']);
  assert.deepStrictEqual(estados(borradorDesdePedido(PEDIDO, { vinculado: true })), ['El pedido ya está vinculado a un comprobante de SIGA.']);
  assert.deepStrictEqual(estados(borradorDesdePedido(con({ estado: 'ANULADO' }))), ['El pedido está anulado.']);
  assert.deepStrictEqual(estados(borradorDesdePedido(con({ idProveedor: null }))), ['El pedido no tiene el proveedor de SIGA (IdProveedor).']);
  const nadaEntregado = con({ items: PEDIDO.items.filter(it => ['faltante', 'sin_stock', 'no_envia'].includes(it.estado)) });
  assert.deepStrictEqual(estados(borradorDesdePedido(nadaEntregado)), ['El pedido no tiene líneas entregadas para importar.']);
});

test('una línea entregado con cantidad 0 se descarta', () => {
  const b = borradorDesdePedido(con({ items: [{ plu: '1001', nombre: 'Harina', cantidad: 2, precioUnitario: 10, cantidadEntregada: 0, estado: 'entregado', obs: '' }] }));
  assert.deepStrictEqual(b.lineas, []);
  assert.deepStrictEqual(b.descartadas, [{ plu: '1001', nombre: 'Harina', estado: 'entregado' }]);
});

test('aplicarEdicion: solo toma lo editable; líneas, cantidades y proveedor salen del pedido', () => {
  const base = borradorDesdePedido(PEDIDO);
  const ed = aplicarEdicion(base, {
    cabecera: {
      idTipoComprobante: ' factcom ', letra: 'a', centroEmisor: '5007', numeroComprobante: '1071364', fecha: '2026-10-10',
      periodoFiscal: '202610', idSucursal: '1', idDeposito: '1', idUbicacion: '1', idFormasPago: '3',
      porcDescRecGeneral: '', observacion: 'x'.repeat(150), idProveedor: 999,
    },
    precios: { 1002: '250.5', 9999: 1 },
    percepciones: [{ tipo: 'piva', importe: '955.19' }],
    lineas: [{ plu: '1001', cantidad: 999 }],
  });
  assert.strictEqual(ed.idTipoComprobante, 'FACTCOM');
  assert.strictEqual(ed.letra, 'A');
  assert.strictEqual(ed.centroEmisor, 5007);
  assert.strictEqual(ed.numeroComprobante, 1071364);
  assert.strictEqual(ed.periodoFiscal, 202610);
  assert.strictEqual(ed.idSucursal, 1);
  assert.strictEqual(ed.porcDescRecGeneral, 0);
  assert.strictEqual(ed.observacion.length, 100);
  assert.strictEqual(ed.idProveedor, 328);
  assert.strictEqual(ed.lineas.length, 4);
  assert.strictEqual(ed.lineas[0].cantidad, 1);
  assert.strictEqual(ed.lineas[1].precio, 250.5);
  assert.deepStrictEqual(ed.percepciones, [{ tipo: 'PIVA', importe: 955.19, baseImponible: 0, alicuota: 0, idProvincia: null }]);
  assert.strictEqual(base.lineas[1].precio, null); // no muta el borrador base
});

test('cabeceraSugerida: datos del proveedor, hoy, sucursal 1 y su primera ubicación', () => {
  assert.deepStrictEqual(cabeceraSugerida({ catalogos: CATALOGOS, hoyISO: '2026-10-16', numeroPedido: 'P-0007' }), {
    idTipoComprobante: 'FACTCOM', letra: 'A', centroEmisor: null, numeroComprobante: null, fecha: '2026-10-16',
    periodoFiscal: 202610, idSucursal: 1, idDeposito: 2, idUbicacion: 5, idFormasPago: 3, porcDescRecGeneral: -5,
    observacion: 'Pedido P-0007',
  });
});

test('cabeceraSugerida: sin tipo del proveedor usa FACTCOM; período de hoy no abierto → el primero', () => {
  const c = cabeceraSugerida({
    catalogos: { ...CATALOGOS, proveedor: { ...CATALOGOS.proveedor, idTipoComprobante: null }, periodos: [202609, 202608], ubicaciones: [] },
    hoyISO: '2026-10-16', numeroPedido: 'P-0007',
  });
  assert.strictEqual(c.idTipoComprobante, 'FACTCOM');
  assert.strictEqual(c.periodoFiscal, 202609);
  assert.strictEqual(c.idDeposito, null);
  assert.strictEqual(c.idUbicacion, null);
});

const percepcion = (tipo, importe, extra = {}) => ({ tipo, importe, ...extra });
const percepcionesDe = ps => aplicarEdicion(borradorDesdePedido(PEDIDO), { percepciones: ps }).percepciones;

test('aplicarEdicion: coma decimal inequívoca se convierte; lo inválido pasa crudo; vacío es null', () => {
  const lista = percepcionesDe([
    percepcion('PIVA', '955,19'), percepcion('PIVA', '1.234,56'), percepcion('PIVA', 'abc'),
    percepcion('PIVA', ''), percepcion('PIVA', ' 12.5 '), percepcion('PIIBB', '10', { baseImponible: '1,5', alicuota: 'x' }),
  ]);
  assert.strictEqual(lista.length, 5); // la percepción sin ningún monto se ignora
  const [coma, miles, basura, num, base] = lista;
  assert.strictEqual(coma.importe, 955.19);
  assert.strictEqual(miles.importe, '1.234,56');
  assert.strictEqual(basura.importe, 'abc');
  assert.strictEqual(num.importe, 12.5);
  assert.strictEqual(base.baseImponible, 1.5);
  assert.strictEqual(base.alicuota, 'x');
});

test('aplicarEdicion: percepción con base pero sin importe conserva importe null (la validación lo reclama)', () => {
  const [p] = percepcionesDe([percepcion('PIIBB', '', { baseImponible: '100', idProvincia: 'B' })]);
  assert.strictEqual(p.importe, null);
  assert.strictEqual(p.baseImponible, 100);
});

test('aplicarEdicion: el precio también acepta coma decimal y deja pasar lo inválido crudo', () => {
  const ed = aplicarEdicion(borradorDesdePedido(PEDIDO), { precios: { 1001: '250,5', 1002: 'abc', 1006: '' } });
  assert.strictEqual(ed.lineas[0].precio, 250.5);
  assert.strictEqual(ed.lineas[1].precio, 'abc');
  assert.strictEqual(ed.lineas[2].precio, null);
});

test('borradorDesdePedido(null/undefined) devuelve un bloqueo claro, no tira TypeError', () => {
  for (const vacio of [null, undefined]) {
    const b = borradorDesdePedido(vacio);
    assert.deepStrictEqual(b.lineas, []);
    assert.deepStrictEqual(b.bloqueos, [{ tipo: 'estado', mensaje: 'No se encontró el pedido.' }]);
  }
});

test('aplicarEdicion: no aplica totales, bloqueos, IVA ni cantidades del navegador, ni líneas ajenas al pedido', () => {
  const base = borradorDesdePedido(PEDIDO);
  const ed = aplicarEdicion(base, {
    cabecera: { importeTotal: 1, totalNeto: 1, bloqueos: [], descartadas: [] },
    bloqueos: [], descartadas: [], importeTotal: 1, idProveedor: 1,
    precios: { 9999: 5, 1001: 10 },
    lineas: [{ plu: '1001', cantidad: 999, iva: 0, porcentajeIVA: 0, precio: 1 }, { plu: '9999', cantidad: 1, precio: 1 }],
  });
  assert.strictEqual(ed.importeTotal, undefined);
  assert.strictEqual(ed.totalNeto, undefined);
  assert.deepStrictEqual(ed.bloqueos, base.bloqueos);
  assert.deepStrictEqual(ed.descartadas, base.descartadas);
  assert.deepStrictEqual(ed.lineas.map(l => l.plu), base.lineas.map(l => l.plu));
  assert.deepStrictEqual(ed.lineas.map(l => l.cantidad), base.lineas.map(l => l.cantidad));
  assert.ok(ed.lineas.every(l => l.iva === undefined && l.porcentajeIVA === undefined));
  assert.strictEqual(ed.lineas[0].precio, 10);
});

// Integración liviana con validaciones e impuestos: la percepción tipeada con coma llega a la fila PIVA.
const editarFactcom = percepciones => aplicarEdicion(
  { ...borradorFactcom(), percepciones: undefined },
  { cabecera: { ...borradorFactcom(), porcDescRecGeneral: 0 }, percepciones },
);
const CALCULO = { totales: { importeTotal: 42665.16 }, lineas: [{ porcentajeIVA: 21 }, { porcentajeIVA: 0 }] };

test('integración: percepción "955,19" valida sin error de importe y llega a la fila PIVA con 955.19', () => {
  const b = editarFactcom([{ tipo: 'piva', importe: '955,19' }]);
  const msgs = validarComprobante(b, contextoFactcom(), CALCULO).map(e => e.mensaje);
  assert.deepStrictEqual(msgs, []);
  const piva = filasImpuestosTodas({ lineas: [], percepciones: b.percepciones }).find(f => f.idTipoImpuesto === 'PIVA');
  assert.strictEqual(piva.importe, 955.19);
});

test('integración: percepción "abc" y "1.234,56" dan el mensaje de número inválido', () => {
  for (const malo of ['abc', '1.234,56']) {
    const msgs = validarComprobante(editarFactcom([{ tipo: 'PIVA', importe: malo }]), contextoFactcom(), CALCULO).map(e => e.mensaje);
    assert.ok(msgs.includes('El importe de la percepción PIVA no es un número válido.'), `${malo}: ${msgs}`);
  }
});

test('el separador de miles argentino ("1.500") no se lee como decimal: pasa crudo; "1.5" y "0.25" siguen numéricos', () => {
  const ed = aplicarEdicion(borradorDesdePedido(PEDIDO), { precios: { 1001: '1.500', 1002: '1.5', 1006: '12.345.678' } });
  assert.strictEqual(ed.lineas[0].precio, '1.500');
  assert.strictEqual(ed.lineas[1].precio, 1.5);
  assert.strictEqual(ed.lineas[2].precio, '12.345.678');
  const [miles, decimal, cuarto, entero] = percepcionesDe(['1.500', '1.5', '0.25', '1500'].map(i => percepcion('PIVA', i)));
  assert.strictEqual(miles.importe, '1.500');
  assert.deepStrictEqual([decimal.importe, cuarto.importe, entero.importe], [1.5, 0.25, 1500]);
});

test('integración: precio y percepción "1.500" dan el mensaje de número inválido', () => {
  const b = aplicarEdicion(borradorFactcom(), {
    cabecera: borradorFactcom(), precios: { 1001: '1.500' }, percepciones: [{ tipo: 'PIVA', importe: '1.500' }],
  });
  const msgs = validarComprobante(b, contextoFactcom(), CALCULO).map(e => e.mensaje);
  assert.ok(msgs.includes('El importe de la percepción PIVA no es un número válido.'), String(msgs));
  assert.ok(msgs.includes('El precio no es un número válido.'), String(msgs));
});

test('cabeceraSugerida: con numeración automática el emisor arranca en 1 (Win L22755) y el número vacío', () => {
  const c = cabeceraSugerida({
    catalogos: { ...CATALOGOS, proveedor: { ...CATALOGOS.proveedor, idTipoComprobante: 'COTIZACIONCOM' } },
    hoyISO: '2026-10-16', numeroPedido: 'P-0007',
  });
  assert.deepStrictEqual([c.idTipoComprobante, c.letra, c.centroEmisor, c.numeroComprobante], ['COTIZACIONCOM', 'X', 1, null]);
});
