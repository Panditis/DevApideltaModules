// Prioridad de un grupo del catálogo según facturación de sus presentaciones: promedio ponderado
// por el propio valor (Σx²/Σx), así las presentaciones que más facturan dominan el puntaje.
function puntajePrioridad(valores) {
  const xs = (valores || []).map(Number).filter(x => Number.isFinite(x) && x > 0);
  const suma = xs.reduce((s, x) => s + x, 0);
  return suma ? Math.round((xs.reduce((s, x) => s + x * x, 0) / suma) * 100) / 100 : 0;
}

// Clase ABC (Pareto) de cada puntaje: A = los que cubren el primer 80% del total acumulado (de mayor a
// menor), B = hasta el 95%, C = el resto. Cuenta como A el que cruza el 80% (la clase la da el acumulado
// ANTES de sumarlo) y los empatados comparten la del primero del bloque. Puntaje <= 0 o inválido: C.
// Devuelve un arreglo alineado con la entrada.
const CORTE_A = 0.80, CORTE_B = 0.95, EPS = 1e-9;
function clasesABC(scores) {
  const xs = (scores || []).map(Number).map(x => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = xs.reduce((s, x) => s + x, 0);
  const clases = xs.map(() => 'C');
  if (!total) return clases;
  const orden = xs.map((x, i) => i).filter(i => xs[i] > 0).sort((a, b) => xs[b] - xs[a] || a - b);
  let acum = 0;
  for (let k = 0; k < orden.length;) {
    let fin = k;
    while (fin < orden.length && xs[orden[fin]] === xs[orden[k]]) fin++;
    const antes = acum / total;
    const clase = antes < CORTE_A - EPS ? 'A' : antes < CORTE_B - EPS ? 'B' : 'C';
    for (let j = k; j < fin; j++) { clases[orden[j]] = clase; acum += xs[orden[j]]; }
    k = fin;
  }
  return clases;
}

// Días de cobertura por debajo de los cuales una presentación es URGENTE (< umbral) o PRONTO (< 2×umbral),
// según la clase del grupo. config.json `urgenciaDias` pisa estos valores clave por clave.
const URGENCIA_DIAS_DEFAULT = Object.freeze({ A: 7, B: 5, C: 3 });
// Días de umbral de una clase (la desconocida cuenta como C); un valor de config inválido cae al default.
function umbralDeClase(clase, umbrales) {
  const k = URGENCIA_DIAS_DEFAULT[clase] ? clase : 'C';
  const pedido = Number((umbrales || {})[k]);
  return pedido > 0 ? pedido : URGENCIA_DIAS_DEFAULT[k];
}
function nivelUrgencia(cobertura, clase, umbrales) {
  if (typeof cobertura !== 'number' || !Number.isFinite(cobertura)) return 'OK'; // sin ventas: no hay urgencia
  const umbral = umbralDeClase(clase, umbrales);
  return cobertura < umbral ? 'URGENTE' : cobertura < 2 * umbral ? 'PRONTO' : 'OK';
}

// Orden del Resumen: URGENTE, PRONTO, OK; dentro de cada nivel por importancia (rankingPos ascendente).
// Las presentaciones no tienen rankingPos: ahí desempata la facturación mensual (mayor primero).
const RANGO_URGENCIA = { URGENTE: 0, PRONTO: 1, OK: 2 };
function compararUrgencia(a, b) {
  const d = (RANGO_URGENCIA[a.urgencia] ?? 2) - (RANGO_URGENCIA[b.urgencia] ?? 2);
  if (d) return d;
  const pos = x => (Number.isFinite(x.rankingPos) ? x.rankingPos : Infinity);
  if (pos(a) !== pos(b)) return pos(a) < pos(b) ? -1 : 1;
  return (b.facturacionMensual || 0) - (a.facturacionMensual || 0);
}

// Días de cobertura: stock ÷ venta diaria (misma unidad), sin redondear. Sin venta no hay cobertura (null);
// el stock negativo (SiGA) se toma como 0.
function calcularCobertura(stock, ventaDiaria) {
  if (typeof ventaDiaria !== 'number' || !Number.isFinite(ventaDiaria) || ventaDiaria <= 0) return null;
  return Math.max(0, (Number(stock) || 0) / ventaDiaria);
}

module.exports = { puntajePrioridad, clasesABC, umbralDeClase, nivelUrgencia, compararUrgencia, calcularCobertura, URGENCIA_DIAS_DEFAULT };
