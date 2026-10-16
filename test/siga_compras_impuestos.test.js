'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { calcularLinea } = require('../lib/siga_compras/lineas');
const {
  filasImpuestos, filasImpuestosTodas, totalesCabecera, importeTotal, percepcionesCabecera, proporcionalImp, montoSaldo,
} = require('../lib/siga_compras/impuestos');

const lineaA = (precio, porcentajeIVA) => calcularLinea({ cantidad: 1, precio, porcentajeIVA, discrimina: true, decimalesPrecio: 2 });
// Parámetros explícitos (decimalesPrecio 2, los de la base del DOC; el default de SiGA es 4).
// DOC: FACTCOM A 5007-1071364 — IVA 21 base 31.839,64 + IVA 0 base 3.184,01 + PIVA 955,19 = 42.665,16.
const LINEAS_1071364 = [lineaA(31839.64, 21), lineaA(3184.01, 0)];
const PIVA = [{ tipo: 'PIVA', importe: 955.19 }];

test('FACTCOM A 1071364: filas de ComprasImpuestos del DOC', () => {
  assert.deepStrictEqual(filasImpuestos({ lineas: LINEAS_1071364, percepciones: PIVA, decimalesPrecio: 2 }), [
    { idTipoImpuesto: 'IVA', tipoTipoImpuesto: 'IVA', idProvincia: null, alicuota: 21, bruto: 31839.64, baseImponible: 31839.64, importe: 6686.32, orden: 1 },
    { idTipoImpuesto: 'IVA', tipoTipoImpuesto: 'IVA', idProvincia: null, alicuota: 0, bruto: 3184.01, baseImponible: 3184.01, importe: 0, orden: 2 },
    { idTipoImpuesto: 'PIVA', tipoTipoImpuesto: 'PERCEPCION', idProvincia: null, alicuota: 0, bruto: 0, baseImponible: 0, importe: 955.19, orden: 3 },
  ]);
});

test('FACTCOM A 1071364: totales de cabecera = 42.665,16', () => {
  const totales = totalesCabecera(filasImpuestos({ lineas: LINEAS_1071364, percepciones: PIVA, decimalesPrecio: 2 }));
  assert.deepStrictEqual(totales, {
    totalBruto: 35023.65, totalNeto: 35023.65, totalIVA: 6686.32, totalPercepciones: 955.19, impuestosInternos: 0,
  });
  assert.strictEqual(importeTotal(totales, 2), 42665.16);
});

test('ProporcionalImp: 955,19 → 878,7748 / 76,4152 (nadie absorbe la diferencia)', () => {
  assert.deepStrictEqual(proporcionalImp(LINEAS_1071364, 42665.16), [878.7748, 76.4152]);
});

test('MontoSaldo según PasajeComprasIncluyeImpuestos', () => {
  const [l1] = LINEAS_1071364;
  assert.strictEqual(montoSaldo(l1, 878.7748, false), 31839.64);
  assert.strictEqual(montoSaldo(l1, 878.7748, true), 39404.7392);
});

test('se omiten las filas con base + importe = 0 y el Orden es correlativo entre las grabadas', () => {
  const lineas = [lineaA(0, 10.5), lineaA(100, 21)];
  const percepciones = [
    { tipo: 'PIIBB', idProvincia: 'SF', baseImponible: 0, alicuota: 0, importe: 0 },
    { tipo: 'PVAR', importe: 5 },
  ];
  const filas = filasImpuestos({ lineas, percepciones });
  assert.deepStrictEqual(filas.map(f => [f.idTipoImpuesto, f.alicuota, f.orden]), [['IVA', 21, 1], ['PVAR', 0, 2]]);
});

test('TotalBruto es el neto ANTES del descuento general (no neto + IVA)', () => {
  const linea = calcularLinea({ cantidad: 3, precio: 100, porcentajeIVA: 21, porcDescRecGeneral: -10, discrimina: true });
  const filas = filasImpuestos({ lineas: [linea], percepciones: [] });
  assert.deepStrictEqual(filas, [
    { idTipoImpuesto: 'IVA', tipoTipoImpuesto: 'IVA', idProvincia: null, alicuota: 21, bruto: 300, baseImponible: 270, importe: 56.7, orden: 1 },
  ]);
  const t = totalesCabecera(filas);
  assert.strictEqual(t.totalBruto, 300);
  assert.strictEqual(t.totalNeto, 270);
  // Sin descuento general, TotalBruto = TotalNeto aunque haya IVA.
  const sinDesc = totalesCabecera(filasImpuestos({ lineas: [lineaA(100, 21)], percepciones: [] }));
  assert.strictEqual(sinDesc.totalBruto, sinDesc.totalNeto);
});

test('orden IVA, PIIBB, PGANA, PIVA, PVAR, IMINT; IMINT es INTERNO y no suma a TotalPercepciones', () => {
  const percepciones = [
    { tipo: 'IMINT', importe: 50 },
    { tipo: 'PIVA', importe: 10 },
    { tipo: 'PIIBB', idProvincia: 'SF', baseImponible: 1000, alicuota: 2.5, importe: 25 },
    { tipo: 'PGANA', importe: 7 },
  ];
  const filas = filasImpuestos({ lineas: [lineaA(1000, 21)], percepciones });
  assert.deepStrictEqual(filas.map(f => f.idTipoImpuesto), ['IVA', 'PIIBB', 'PGANA', 'PIVA', 'IMINT']);
  assert.deepStrictEqual(filas[1], {
    idTipoImpuesto: 'PIIBB', tipoTipoImpuesto: 'PERCEPCION', idProvincia: 'SF', alicuota: 2.5, bruto: 0, baseImponible: 1000, importe: 25, orden: 2,
  });
  assert.strictEqual(filas[4].tipoTipoImpuesto, 'INTERNO');
  const t = totalesCabecera(filas);
  assert.strictEqual(t.totalPercepciones, 42);
  assert.strictEqual(t.impuestosInternos, 50);
  assert.strictEqual(importeTotal(t, 2), 1302);
  assert.deepStrictEqual(percepcionesCabecera(percepciones), {
    percepcionIVA: 10, percepcionIB: 25, percepcionGanancias: 7, percepcionVarias: 0, impuestosInternos: 50,
  });
});

test('importeTotal redondea LEJOS DEL CERO como el formato "#,##0.00" de SiGA (no al par)', () => {
  const t = (totalNeto) => ({ totalNeto, totalIVA: 0, totalPercepciones: 0, impuestosInternos: 0 });
  assert.strictEqual(importeTotal(t(100.005), 2), 100.01);
  assert.strictEqual(importeTotal(t(100.015), 2), 100.02);
  assert.strictEqual(importeTotal(t(-100.005), 2), -100.01);
  assert.strictEqual(importeTotal(t(-100.015), 2), -100.02);
});

test('los totales se calculan sobre todas las filas: la fila en 0 suma al TotalBruto pero no se graba', () => {
  // Descuento general -100%: base 0, IVA 0, bruto 100.
  const linea = calcularLinea({ cantidad: 1, precio: 100, porcentajeIVA: 21, porcDescRecGeneral: -100, discrimina: true });
  const todas = filasImpuestosTodas({ lineas: [linea], percepciones: [] });
  assert.strictEqual(todas.length, 1);
  assert.strictEqual(totalesCabecera(todas).totalBruto, 100);
  assert.deepStrictEqual(filasImpuestos({ lineas: [linea], percepciones: [] }), []);
});

test('PGANA, PIVA, PVAR e IMINT son una fila por tipo (se suman); PIIBB una por provincia', () => {
  const percepciones = [
    { tipo: 'PIVA', importe: 10 },
    { tipo: 'PIVA', importe: 5 },
    { tipo: 'PIIBB', idProvincia: 'SF', baseImponible: 1000, alicuota: 2.5, importe: 25 },
    { tipo: 'PIIBB', idProvincia: 'BA', baseImponible: 500, alicuota: 3, importe: 15 },
    { tipo: 'PIIBB', idProvincia: 'SF', baseImponible: 200, alicuota: 2.5, importe: 5 },
    { tipo: 'PVAR', importe: 1 },
    { tipo: 'PVAR', importe: 2 },
  ];
  const filas = filasImpuestos({ lineas: [], percepciones });
  assert.deepStrictEqual(filas.map(f => [f.idTipoImpuesto, f.idProvincia, f.baseImponible, f.importe]), [
    ['PIIBB', 'SF', 1200, 30], ['PIIBB', 'BA', 500, 15], ['PIVA', null, 0, 15], ['PVAR', null, 0, 3],
  ]);
});
