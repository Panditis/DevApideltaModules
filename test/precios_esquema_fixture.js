'use strict';
// Config de prueba del esquema por canal (forma de configEsquemaDe). Margen plano 30 %, gastos 10 % sobre costo,
// extras minoristas 5 %, IVA 21 %. Con costo 1000: costo + gastos 1100 → neto 1430 → minorista exacto 1816,82 → 1800;
// pack/bulto × 6 → 8580 sin IVA, 10400 con IVA; × 1 → 1430 / 1750. Fraccionado 500 g: +10 % de ajuste → 1950.
const TODOS = Object.freeze({ almacen: true, fraccionado: true, produccion: true });
const T = Object.freeze({ minPct: 30, maxPct: 30, escalones: 1, rango: { desde: 1, hasta: 2 } });
const CFG = {
  ivaVentaPct: 21, toleranciaPct: 5, modoGastos: 'costo',
  gastosVenta: [{ id: 'flete', concepto: 'Flete', pct: 10, tipos: TODOS }],
  extrasMinorista: [{ id: 'iibb', concepto: 'IIBB', pct: 5, tipos: TODOS }],
  margenes: { minorista: T, pack: T, bulto: T, ajustesPeso: { tramosG: [500, 1000], puntos: [10, 0] } },
  redondeo: { minorista: 50, packNeto: 0, packIva: 50, bultoNeto: 0, bultoIva: 50 },
};
module.exports = { TODOS, T, CFG };
