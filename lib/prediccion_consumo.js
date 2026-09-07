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

// Cuánto se despega el mes objetivo del promedio de su año, medido un año atrás.
// Se acota: un mes homólogo atípico (una promoción, un faltante largo, una carga
// mal hecha) dispara el factor y arrastra la compra entera detrás suyo.
const ESTACIONAL_MIN = 0.5;
const ESTACIONAL_MAX = 2.0;
const MESES_PARA_ESTACIONALIDAD = 12;

function factorEstacional(serie, mesObjetivo) {
  const s = serie || {};
  const homologo = mesAnterior(mesObjetivo, MESES_PARA_ESTACIONALIDAD);
  if (!homologo) return 1;
  // Los 12 meses del año homólogo, terminando en él.
  const meses = [];
  for (let i = MESES_PARA_ESTACIONALIDAD - 1; i >= 0; i--) meses.push(mesAnterior(homologo, i));
  // Sin el año completo cargado no hay con qué comparar: mejor no ajustar que ajustar mal.
  if (!meses.every(m => m in s)) return 1;
  // Se compara consumo POR DÍA, no total del mes. Con totales, un producto de
  // venta perfectamente pareja daría 1,02 en los meses de 31 días y 0,92 en
  // febrero: estacionalidad inventada por el calendario, que después multiplica
  // la compra. Además μ ya viene en unidades/día, así que las unidades cierran.
  const diarias = meses.map(m => (Number(s[m]) || 0) / diasDelMes(m));
  const total = diarias.reduce((acc, d) => acc + d, 0);
  if (total <= 0) return 1;
  const promedio = total / MESES_PARA_ESTACIONALIDAD;
  const factor = ((Number(s[homologo]) || 0) / diasDelMes(homologo)) / promedio;
  return redondear(Math.min(Math.max(factor, ESTACIONAL_MIN), ESTACIONAL_MAX));
}

// Ventana de análisis: 24 meses permiten comparar contra el mes homólogo del año
// anterior. Con menos, factorEstacional devuelve 1 y la proyección sigue andando.
const VENTANA_MESES = 24;

// proyeccion = μ diario × horizonte × estacionalidad
// seguridad  = z × σ diario × √horizonte
// El colchón no es opcional: μ es el centro de la distribución, no el techo.
// Comprar exactamente el promedio deja quiebre la mitad de las veces.
function proyectar(serie, { mesActual, dias, z = 1.28, ventanaMeses = VENTANA_MESES } = {}) {
  const horizonte = Math.max(0, Number(dias) || 0);
  const meses = mesesDeVentana(mesActual, ventanaMeses);
  const { mu, sigma } = demandaDiaria(serie, meses);
  const estacional = factorEstacional(serie, mesActual);
  if (horizonte <= 0) {
    return { muDiario: mu, sigmaDiario: sigma, estacional, proyeccion: 0, seguridad: 0, dias: 0 };
  }
  return {
    muDiario: mu,
    sigmaDiario: sigma,
    estacional,
    proyeccion: redondear(mu * horizonte * estacional),
    seguridad: redondear((Number(z) || 0) * sigma * Math.sqrt(horizonte)),
    dias: horizonte,
  };
}

const SEMAFORO = { CRITICO: 'CRITICO', COMPRAR: 'COMPRAR', OK: 'OK', EXCESO: 'EXCESO' };

// necesidad = proyección + colchón − stock − pendiente de recibir
// El pendiente se resta porque ya está pedido: sin eso, dos corridas seguidas
// compran lo mismo dos veces.
function recomendar({ proyeccion = 0, seguridad = 0, stock = 0, pendiente = 0,
                      muDiario = 0, leadTimeDias = 0 } = {}) {
  const disponible = (Number(stock) || 0) + (Number(pendiente) || 0);
  const necesidad = Math.max(redondear((Number(proyeccion) || 0) + (Number(seguridad) || 0) - disponible), 0);
  // CRÍTICO: no aguanta ni lo que tarda el proveedor en entregar. Es una rotura
  // anunciada, no un "conviene reponer".
  const consumoLeadTime = (Number(muDiario) || 0) * (Number(leadTimeDias) || 0);
  if (consumoLeadTime > 0 && disponible < consumoLeadTime) {
    return { necesidad, estado: SEMAFORO.CRITICO, disponible };
  }
  if (necesidad > 0) return { necesidad, estado: SEMAFORO.COMPRAR, disponible };
  // EXCESO: cubre más de dos horizontes completos, o sea capital dormido.
  const cobertura = (Number(proyeccion) || 0) * 2;
  if (cobertura > 0 && disponible > cobertura) {
    return { necesidad: 0, estado: SEMAFORO.EXCESO, disponible };
  }
  return { necesidad: 0, estado: SEMAFORO.OK, disponible };
}

module.exports = {
  diasDelMes, mesAnterior, mesesDeVentana, partesDeMes, redondear,
  demandaDiaria, PESOS_RECIENCIA,
  factorEstacional, ESTACIONAL_MIN, ESTACIONAL_MAX,
  proyectar, recomendar, SEMAFORO, VENTANA_MESES,
};
