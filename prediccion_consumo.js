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

// Los meses recientes describen mejor lo que va a pasar que los viejos: un producto
// que arrancó a venderse hace dos meses no puede promediarse contra diez de ceros.
// Los cortes son por posición dentro de la ventana, contando desde el más nuevo.
const PESOS_RECIENCIA = { reciente: 3, medio: 2, viejo: 1 };

function pesoDeMes(indiceDesdeElFinal) {
  if (indiceDesdeElFinal < 3) return PESOS_RECIENCIA.reciente;
  if (indiceDesdeElFinal < 6) return PESOS_RECIENCIA.medio;
  return PESOS_RECIENCIA.viejo;
}

// Demanda diaria media y su desvío, ponderando por recencia.
// serie: { 'YYYY-MM': consumoTotalDelMes }  ·  meses: los de la ventana, ascendente.
// Un mes ausente cuenta como 0: no vender es información, no un hueco.
function demandaDiaria(serie, meses) {
  const s = serie || {};
  const lista = Array.isArray(meses) ? meses : [];
  if (!lista.length) return { mu: 0, sigma: 0 };
  const puntos = [];
  let sumaPesos = 0, sumaPond = 0;
  for (let i = 0; i < lista.length; i++) {
    const mes = lista[i];
    const dias = diasDelMes(mes);
    if (!dias) continue;
    const diaria = (Number(s[mes]) || 0) / dias;
    const peso = pesoDeMes(lista.length - 1 - i);
    puntos.push({ diaria, peso });
    sumaPesos += peso;
    sumaPond += diaria * peso;
  }
  if (!sumaPesos) return { mu: 0, sigma: 0 };
  const mu = sumaPond / sumaPesos;
  const varianza = puntos.reduce((acc, p) => acc + p.peso * Math.pow(p.diaria - mu, 2), 0) / sumaPesos;
  return { mu: redondear(mu), sigma: redondear(Math.sqrt(Math.max(varianza, 0))) };
}

module.exports = {
  diasDelMes, mesAnterior, mesesDeVentana, partesDeMes, redondear,
  demandaDiaria, PESOS_RECIENCIA,
};
