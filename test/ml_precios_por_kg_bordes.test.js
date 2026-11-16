'use strict';
// Bordes de precioPorKg: paridad servidor/cliente con peso inválido, umbral de envío y tramos de cargo fijo,
// y regresión (sin flag = mismo resultado que antes del cambio).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PreciosEsquema = require('../lib/precios_esquema');
const ml = require('../lib/ml_precios');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ml_precios_detalle.js'), 'utf8');
const fn = nombre => src.match(new RegExp(`function ${nombre}\\([\\s\\S]*?\\n}\\n`))[0];
const tramo = ['tramoEnvio', 'recargoCuotas', 'tramoCostoFijo'].map(fn).join('');
const cuerpo = fn('calcularEsperado');
const calcularEsperado = new Function('PreciosEsquema', `const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));${tramo}${cuerpo}; return calcularEsperado;`)(PreciosEsquema);

const base = ml.normalizarConfig({});
const cfg = { ...base, envioGratisDesde: 30000, envioMonto: 4200, tablaCostoFijo: [{ precioMax: 2000, valor: 150 }, { precioMax: 30000, valor: 900.5 }], costoFijoMonto: 4000, redondeoPaso: 10 };

test('precioPorKg con peso 0/null/NaN/negativo/undefined → null en servidor y cliente', () => {
  for (const p of [0, null, NaN, -1, undefined]) {
    assert.strictEqual(ml.precioEsperado(1000, 2, 'gratis', 'no', cfg, p, null, true), null, String(p));
    assert.strictEqual(calcularEsperado(1000, 2, 'gratis', 'no', cfg, p, null, true), null, String(p));
  }
});

test('precioPorKg: paridad cruzando umbral de envío gratis y tramos de cargo fijo; redondeo', () => {
  let porUmbral = 0, tramos = new Set();
  for (const carta of [333.33, 1499.99, 8000, 12345.67]) for (const pesoKg of [0.001, 0.1, 0.333, 1, 2.5, 7.75]) for (const envio of ['gratis', 'comprador', 'sin']) {
    const s = ml.precioEsperado(carta, 99, envio, 'no', cfg, pesoKg, 3, true);
    const c = calcularEsperado(carta, 99, envio, 'no', cfg, pesoKg, 3, true);
    const caso = JSON.stringify({ carta, pesoKg, envio });
    for (const k of ['base', 'esperado', 'gastosPct', 'gastosFijos', 'envioMonto', 'envioPorUmbral', 'costoFijoTabla']) assert.strictEqual(c[k], s[k], `${k} ${caso}`);
    assert.strictEqual(s.base, PreciosEsquema.r2(carta * pesoKg), caso); // unidades (99) se ignora
    assert.strictEqual(s.baseKg, s.base);
    if (s.envioPorUmbral) porUmbral++;
    tramos.add(s.costoFijoTabla);
  }
  assert.ok(porUmbral > 0, 'algún caso cruza el umbral');
  assert.ok(tramos.size >= 2, 'se recorren varios tramos de cargo fijo');
});

test('regresión: sin flag, flag false y flag omitido dan exactamente lo mismo', () => {
  for (const pesoKg of [null, 0, 1.5]) for (const envio of ['gratis', 'comprador']) {
    const omitido = ml.precioEsperado(1999.99, 3, envio, 'no', cfg, pesoKg, 6);
    const falso = ml.precioEsperado(1999.99, 3, envio, 'no', cfg, pesoKg, 6, false);
    assert.deepStrictEqual(falso, omitido);
    assert.strictEqual(omitido.baseKg, null);
    assert.strictEqual(omitido.base, PreciosEsquema.r2(1999.99 * 3));
  }
  const pub = { id: 'MLA1', titulo: 't', activa: true, envio: 'gratis', cuotas: 'no', stock: 1, precio: 9000, precioPromo: null };
  const cartas = new Map([['7', { nombre: 'P', precio: 1999.99 }]]);
  const a = ml.armarFila(pub, { codigo: 7, unidades: 3, pesoKg: 1.5 }, cartas, cfg);
  const b = ml.armarFila(pub, { codigo: 7, unidades: 3, pesoKg: 1.5, precioPorKg: false }, cartas, cfg);
  const c = ml.armarFila(pub, { codigo: 7, unidades: 3, pesoKg: 1.5, precioPorKg: 'true' }, cartas, cfg); // solo === true activa
  assert.deepStrictEqual(b, a);
  assert.deepStrictEqual(c, a);
});

test('kpis: sin_peso cuenta en sinPeso y el total de estados cuadra con activas+inactivas', () => {
  const filas = ['ok', 'desviada', 'sin_vincular', 'sin_carta', 'sin_precio', 'sin_peso', 'sin_peso'].map((estado, i) => ({ estado, activa: i % 2 === 0 }));
  const k = ml.kpis(filas);
  assert.strictEqual(k.sinPeso, 2);
  assert.strictEqual(k.ok + k.desviadas + k.sinVincular + k.sinCarta + k.sinPrecio + k.sinPeso, k.activas + k.inactivas);
  assert.ok(!Object.keys(k).includes('undefined'));
});

test('estadoDe: sin_carta y sin_precio ganan sobre sin_peso', () => {
  assert.strictEqual(ml.estadoDe({ vinculado: true, carta: null, precioMl: 100, esperado: null, toleranciaPct: 1, sinPeso: true }).estado, 'sin_carta');
  assert.strictEqual(ml.estadoDe({ vinculado: true, carta: 10, precioMl: null, esperado: null, toleranciaPct: 1, sinPeso: true }).estado, 'sin_precio');
});
