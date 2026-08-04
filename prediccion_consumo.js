'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  prediccion_consumo.js — proyección de consumo para decidir compras.
//
//  Toda la matemática es pura: no lee disco, no consulta SQL y no mira el reloj.
//  El mes de referencia se inyecta, para que los tests sean deterministas.
//  Spec: docs/superpowers/specs/2026-08-04-compras-prediccion-seguimiento-design.md
// ─────────────────────────────────────────────────────────────────────────────

const RE_MES = /^(\d{4})-(\d{2})$/;

function partesDeMes(mes) {
  const m = RE_MES.exec(String(mes || ''));
  if (!m) return null;
  const anio = Number(m[1]), num = Number(m[2]);
  if (num < 1 || num > 12) return null;
  return { anio, num };
}

const fmtMes = (anio, num) => `${anio}-${String(num).padStart(2, '0')}`;
const redondear = (x) => Math.round((Number(x) || 0) * 10000) / 10000;

// Días reales del mes: el promedio diario divide por esto, y febrero no son 30.
function diasDelMes(mes) {
  const p = partesDeMes(mes);
  if (!p) return null;
  return new Date(Date.UTC(p.anio, p.num, 0)).getUTCDate();
}

function mesAnterior(mes, cuantos) {
  const p = partesDeMes(mes);
  if (!p) return null;
  const total = p.anio * 12 + (p.num - 1) - (Number(cuantos) || 0);
  return fmtMes(Math.floor(total / 12), (total % 12 + 12) % 12 + 1);
}

// Los N meses CERRADOS anteriores a mesActual, en orden cronológico. El mes en
// curso queda afuera: está incompleto y dividirlo por los días del mes entero
// hunde el promedio justo en el dato más reciente, que es el que más pesa.
function mesesDeVentana(mesActual, cantidad) {
  const n = Math.max(0, Number(cantidad) || 0);
  const out = [];
  for (let i = n; i >= 1; i--) {
    const m = mesAnterior(mesActual, i);
    if (m) out.push(m);
  }
  return out;
}

module.exports = { diasDelMes, mesAnterior, mesesDeVentana, partesDeMes, redondear };
