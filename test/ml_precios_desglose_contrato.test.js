'use strict';
// Desglose del front (desgloseHtml) cierra contra el esperado del server, y los campos f.X que leen los
// scripts del front existen en la fila real de lib/ml_precios.js · armarFila (contrato de GET /control).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ml = require('../lib/ml_precios');

const js = n => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', `ml_precios_${n}.js`), 'utf8');
const src = js('detalle');
// filaDesglose, filaSec, lineasCostos y desgloseHtml van seguidos en el archivo.
const bloque = src.match(/const filaDesglose[\s\S]*?\nfunction desgloseHtml\([\s\S]*?\n}\n/)[0];
const desgloseHtml = new Function(`
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
  const fmtMoney2 = n => '$' + Number(n).toFixed(2), fmtMoney = fmtMoney2, fmtPct = n => n + ' %', fmtInt = n => String(n);
  const signo = n => (n < 0 ? '-' : '+');
  ${bloque}; return desgloseHtml;`)();

const filas = html => [...html.matchAll(/<tr[^>]*><td>(.*?)<\/td><td class="det">.*?<\/td><td>(.*?)<\/td><\/tr>/g)]
  .map(([, txt, monto]) => [txt, Number(monto.replace(/[^\d.-]/g, ''))]);
const cents = n => Math.round(n * 100);

const base = ml.normalizarConfig({});
const cfgs = {
  sinRedondeo: { ...base, comisionPct: 16.5, impuestosPct: 3.3, envioMonto: 6141, costoFijoMonto: 1100, extras: [{ nombre: '<img onerror=x>', tipo: '%', valor: 1.37 }, { nombre: 'pack', tipo: '$', valor: 250.5 }] },
  redondeo100: { ...base, comisionPct: 13, envioMonto: 7471, redondeoPaso: 100, envioBonificado: true, extras: [{ nombre: 'ads', tipo: '%', valor: 2.25 }] },
};

test('desglose: SIGA + Total gastos + Redondeo = esperado; total vs líneas con desfase máx de centavos', () => {
  let maxDesfase = 0;
  for (const [nombre, cfg] of Object.entries(cfgs)) {
    for (const [carta, un] of [[523.37, 1], [1999.99, 3], [12500, 2], [33333.33, 1]]) {
      const f = ml.precioEsperado(carta, un, 'gratis', null, cfg, 1, 1);
      const html = desgloseHtml({ ...f, carta, unidades: un, envio: 'gratis', cuotasQty: 1 }, cfg, true);
      const r = filas(html);
      const val = t => (r.find(([x]) => x.startsWith(t)) || [, 0])[1];
      const total = val('Total gastos'), redondeo = val('Redondeo'), siga = val('Carta SIGA');
      const caso = `${nombre} ${carta}x${un}`;
      assert.ok(Math.abs(cents(siga + total + redondeo) - cents(f.esperado)) <= 1, `cierre ${caso}`);
      const ini = r.findIndex(([x]) => x.startsWith('Carta SIGA')) + 1, fin = r.findIndex(([x]) => x === 'Total gastos');
      const suma = r.slice(ini, fin).reduce((s, [, v]) => s + v, 0);
      maxDesfase = Math.max(maxDesfase, Math.abs(cents(suma) - cents(total)));
      assert.ok(!/<img/.test(html), `XSS en nombre de extra ${caso}`);
    }
  }
  assert.ok(maxDesfase <= 2, `desfase de centavos entre líneas y Total gastos: ${maxDesfase}`);
});

test('desglose del simulador: envío que no aplica se muestra como +$0', () => {
  const f = ml.precioEsperado(1000, 1, 'no', null, base, null, 1);
  const html = desgloseHtml({ ...f, carta: 1000, unidades: 1, envio: 'no', cuotasQty: 1 }, base, true);
  assert.match(html, /Envío &mdash; no aplica.*?\+\$0\.00/);
  assert.doesNotMatch(desgloseHtml({ ...f, carta: 1000, unidades: 1, envio: 'no', cuotasQty: 1 }, base, false), /no aplica/);
});

test('contrato GET /control: todo f.X que lee el front existe en la fila de armarFila', () => {
  const cfg = { ...base, envioBonificado: true, envioMonto: 5000 };
  const fila = ml.armarFila({ id: 'MLA1', titulo: 't', activa: true, envio: 'gratis', precio: 9000 }, { codigo: 7, unidades: 1 }, new Map([['7', { precio: 1000, nombre: 'P7' }]]), cfg);
  assert.strictEqual(fila.envioBonificado, true);
  assert.strictEqual(fila.envioMontoLista, 5000);
  assert.strictEqual(fila.envioMonto, 2500);
  const locales = new Set(['i', 'k', 'v', 'vacioK', 'vacioV', 'cuotasTotalPct']); // variables locales / fallback viejo
  const leidos = new Set();
  for (const n of ['control', 'detalle', 'vinculos', 'costos']) for (const m of js(n).matchAll(/\bf\.(\w+)/g)) leidos.add(m[1]);
  const faltan = [...leidos].filter(k => !locales.has(k) && !(k in fila));
  assert.deepStrictEqual(faltan, []);
});
