'use strict';
// El desglose del cliente (public/js/ml_precios_detalle.js · calcularEsperado) tiene que dar lo mismo que
// precioEsperado de lib/ml_precios.js, que es el esperado oficial.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PreciosEsquema = require('../lib/precios_esquema');
const ml = require('../lib/ml_precios');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ml_precios_detalle.js'), 'utf8');
// calcularEsperado usa tramoEnvio, recargoCuotas y tramoCostoFijo (mismo archivo) y num (public/js/ml_precios.js).
const fn = nombre => src.match(new RegExp(`function ${nombre}\\([\\s\\S]*?\\n}\\n`))[0];
const tramo = ['tramoEnvio', 'recargoCuotas', 'tramoCostoFijo'].map(fn).join('');
const cuerpo = src.match(/function calcularEsperado\([\s\S]*?\n}\n/)[0];
const calcularEsperado = new Function('PreciosEsquema', `const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));${tramo}${cuerpo}; return calcularEsperado;`)(PreciosEsquema);

const base = ml.normalizarConfig({});
const configs = {
  default: base,
  envioHeredadoYCuotas: { ...base, envioGratisPct: 6.5, cuotasBasePct: 2.5, tablaCuotas: [{ cuotas: 1, recargoPct: 0 }, { cuotas: 3, recargoPct: 9.3 }, { cuotas: 6, recargoPct: 4.1 }] },
  montosEImpuestos: { ...base, envioMonto: 3500, costoFijoMonto: 900, impuestosPct: 3.5, redondeoPaso: 100 },
  extras: { ...base, extras: [{ nombre: 'pack', tipo: '$', valor: 250.5 }, { nombre: 'ads', tipo: '%', valor: 2.25 }, { nombre: 'x', tipo: '%', valor: 0 }] },
  redondeo50: { ...base, redondeoPaso: 50 },
  todo: { ...base, comisionPct: 16, envioGratisPct: 2, envioMonto: 4200, costoFijoMonto: 1100, impuestosPct: 4, redondeoPaso: 10,
    cuotasBasePct: 3, tablaCuotas: [{ cuotas: 3, recargoPct: 12 }, { cuotas: 6, recargoPct: 6 }], extras: [{ nombre: 'a', tipo: '$', valor: 100 }, { nombre: 'b', tipo: '%', valor: 1.5 }] },
  sinTablas: { ...base, tablaCuotas: [], tablaCostoFijo: [], cuotasBasePct: 0, costoFijoMonto: 700 },
  costoFijoTramos: { ...base, tablaCostoFijo: [{ precioMax: 2000, valor: 150 }, { precioMax: 30000, valor: 900.5 }], costoFijoMonto: 4000, redondeoPaso: 10 },
  sinPrecioPosible: { ...base, comisionPct: 60, impuestosPct: 30, extras: [{ nombre: 'b', tipo: '%', valor: 15 }] },
};
const casos = [[0.01, 1], [523.37, 1], [1999.99, 3], [12500, 2], [99999, 1], [250000, 4]];

for (const [nombre, cfg] of Object.entries(configs)) {
  test(`calcularEsperado del cliente == precioEsperado del server (${nombre})`, () => {
    for (const [carta, unidades] of casos) {
      for (const envio of ['gratis', 'comprador', 'sin', 'nd']) {
        for (const cuotasQty of [null, 1, 3, 6, 7]) {
          const s = ml.precioEsperado(carta, unidades, envio, 'no', cfg, null, cuotasQty);
          const c = calcularEsperado(carta, unidades, envio, 'no', cfg, null, cuotasQty);
          const caso = JSON.stringify({ carta, unidades, envio, cuotasQty });
          for (const k of ['base', 'gastosPct', 'gastosFijos', 'esperado', 'cuotasPct', 'costoFijoTabla', 'costoFijoPrecioMax', 'costoFijoOrigen']) assert.strictEqual(c[k], s[k], `${k} difiere en ${caso}`);
        }
      }
    }
  });
}

test('con gastos % >= 100 ambos devuelven esperado null', () => {
  assert.strictEqual(ml.precioEsperado(1000, 1, 'gratis', 'no', configs.sinPrecioPosible).esperado, null);
  assert.strictEqual(calcularEsperado(1000, 1, 'gratis', 'no', configs.sinPrecioPosible).esperado, null);
});

test('paridad con envío por tramo de peso y por umbral de envío gratis', () => {
  const cfg = { ...base, tablaEnvio: [{ topeKg: 0.5, valor: 1000 }, { topeKg: 3, valor: 4500.5 }], envioMonto: 7000, envioGratisDesde: 20000, redondeoPaso: 10 };
  for (const [carta, unidades] of casos) {
    for (const pesoKg of [null, 0.5, 0.51, 3, 3.5]) {
      for (const envio of ['gratis', 'comprador']) {
        const s = ml.precioEsperado(carta, unidades, envio, 'no', cfg, pesoKg);
        const c = calcularEsperado(carta, unidades, envio, 'no', cfg, pesoKg);
        const caso = JSON.stringify({ carta, unidades, envio, pesoKg });
        for (const k of ['gastosFijos', 'esperado', 'envioMonto', 'envioTopeKg', 'envioOrigen', 'envioPorUmbral']) assert.strictEqual(c[k], s[k], `${k} difiere en ${caso}`);
      }
    }
  }
});

test('paridad en bordes: tabla vacía, umbral 0, umbral exacto con redondeo, tope exacto, peso sobre último tope', () => {
  const tabla = [{ topeKg: 1, valor: 2000 }];
  const cfgs = [
    { ...base, tablaEnvio: [], envioMonto: 3000, envioGratisDesde: 15000, redondeoPaso: 100 },
    { ...base, tablaEnvio: tabla, envioMonto: 3000, envioGratisDesde: 0, redondeoPaso: 100 },
    { ...base, tablaEnvio: tabla, envioMonto: 3000, redondeoPaso: 100 },
  ];
  for (const cfg of cfgs) {
    for (let carta = 5000; carta <= 30000; carta += 37) {
      for (const pesoKg of [null, 1, 1.001, 0]) {
        const s = ml.precioEsperado(carta, 1, 'comprador', 'no', cfg, pesoKg);
        const c = calcularEsperado(carta, 1, 'comprador', 'no', cfg, pesoKg);
        for (const k of ['esperado', 'envioMonto', 'envioTopeKg', 'envioOrigen', 'envioPorUmbral']) assert.strictEqual(c[k], s[k], `${k} ${carta} ${pesoKg}`);
      }
    }
  }
  // umbral exacto: esperado sin envío redondeado == umbral → aplica en ambos
  const cfg = { ...base, tablaEnvio: tabla, tablaCostoFijo: [], envioMonto: 3000, redondeoPaso: 100, envioGratisDesde: 0 }; // sin cargo fijo: esperado sin envío = precio de referencia
  const sin = ml.precioEsperado(20000, 1, 'comprador', 'no', cfg, 1).esperado;
  const cu = { ...cfg, envioGratisDesde: sin };
  assert.strictEqual(ml.precioEsperado(20000, 1, 'comprador', 'no', cu, 1).envioPorUmbral, true);
  assert.strictEqual(calcularEsperado(20000, 1, 'comprador', 'no', cu, 1).envioPorUmbral, true);
  const cu2 = { ...cfg, envioGratisDesde: sin + 1 };
  assert.strictEqual(ml.precioEsperado(20000, 1, 'comprador', 'no', cu2, 1).envioPorUmbral, false);
  assert.strictEqual(calcularEsperado(20000, 1, 'comprador', 'no', cu2, 1).envioPorUmbral, false);
});

test('paridad en el borde del precio de referencia contra el tramo de cargo fijo', () => {
  const cfg = { ...base, tablaCostoFijo: [{ precioMax: 15000, valor: 1115 }, { precioMax: 25000, valor: 2300 }], costoFijoMonto: 2810, redondeoPaso: 100 };
  for (let carta = 7000; carta <= 16000; carta += 23) {
    for (const cuotasQty of [null, 6]) {
      const sv = ml.precioEsperado(carta, 1, 'comprador', 'no', cfg, null, cuotasQty);
      const c = calcularEsperado(carta, 1, 'comprador', 'no', cfg, null, cuotasQty);
      for (const k of ['esperado', 'gastosFijos', 'cuotasPct', 'costoFijoTabla', 'costoFijoPrecioMax', 'costoFijoOrigen', 'envioPorUmbral']) assert.strictEqual(c[k], sv[k], `${k} ${carta} ${cuotasQty}`);
    }
  }
});

test('paridad en bordes: precioMax exacto (con y sin redondeo), sobre el último tramo, tabla vacía, cuotasQty 5/12, umbral 33000 + tramo', () => {
  const tablaCuotas = [{ cuotas: 1, recargoPct: 0 }, { cuotas: 3, recargoPct: 8 }, { cuotas: 12, recargoPct: 30 }];
  const cfgs = [0, 1000].flatMap(redondeoPaso => [
    { ...base, redondeoPaso, tablaCuotas, envioGratisDesde: 33000, envioMonto: 5000, costoFijoMonto: 2500,
      tablaCostoFijo: [{ precioMax: 15000, valor: 1000 }, { precioMax: 33000, valor: 1800 }], extras: [{ nombre: 'x', tipo: '$', valor: 50 }, { nombre: 'y', tipo: '%', valor: 1 }] },
    { ...base, redondeoPaso, tablaCuotas: [], tablaCostoFijo: [], costoFijoMonto: 0 },
  ]);
  let bordeExacto = 0; let sobreUltimo = 0;
  for (const cfg of cfgs) {
    for (let carta = 5000; carta <= 30000; carta += 7) {
      for (const cuotasQty of [null, 1, 3, 5, 12]) {
        for (const envio of ['gratis', 'comprador']) {
          const s = ml.precioEsperado(carta, 1, envio, 'no', cfg, 2, cuotasQty);
          const c = calcularEsperado(carta, 1, envio, 'no', cfg, 2, cuotasQty);
          for (const k of ['esperado', 'gastosPct', 'gastosFijos', 'cuotasPct', 'envioMonto', 'envioPorUmbral', 'costoFijoTabla', 'costoFijoPrecioMax', 'costoFijoOrigen']) assert.strictEqual(c[k], s[k], `${k} ${carta} ${cuotasQty} ${envio} paso=${cfg.redondeoPaso}`);
          const ref = ml.precioEsperado(carta, 1, 'comprador', 'no', { ...cfg, envioGratisDesde: 0, tablaCostoFijo: [], costoFijoMonto: 0 }, 2, cuotasQty).esperado;
          if (cfg.tablaCostoFijo.length && ref === 33000) { bordeExacto++; assert.strictEqual(s.costoFijoPrecioMax, 33000); assert.strictEqual(s.envioPorUmbral, envio !== 'gratis'); }
          if (cfg.tablaCostoFijo.length && ref > 33000) { sobreUltimo++; assert.strictEqual(s.costoFijoOrigen, 'defecto'); assert.strictEqual(s.costoFijoTabla, 2500); }
          if (cuotasQty === 5 || cuotasQty === null) assert.strictEqual(s.cuotasPct, cfg.cuotasBasePct + (cuotasQty === null && cfg.tablaCuotas.length ? 0 : 0));
        }
      }
    }
  }
  assert.ok(bordeExacto > 0, 'ningún caso cayó en 33000 exacto');
  assert.ok(sobreUltimo > 0);
});

test('paridad con bonificación de envío on/off', () => {
  for (const envioBonificado of [false, true]) {
    const cfg = { ...base, envioBonificado, tablaEnvio: [{ topeKg: 0.5, valor: 6141 }, { topeKg: 2, valor: 7470 }], envioMonto: 9001, envioGratisDesde: 20000, redondeoPaso: 10 };
    for (const [carta, unidades] of casos) for (const pesoKg of [null, 0.5, 2, 3]) for (const envio of ['gratis', 'comprador']) {
      const sv = ml.precioEsperado(carta, unidades, envio, 'no', cfg, pesoKg, 3);
      const c = calcularEsperado(carta, unidades, envio, 'no', cfg, pesoKg, 3);
      for (const k of ['esperado', 'gastosFijos', 'envioMonto', 'envioMontoLista', 'envioBonificado', 'envioPorUmbral', 'envioOrigen']) {
        assert.strictEqual(c[k], sv[k], `${k} ${JSON.stringify({ envioBonificado, carta, unidades, pesoKg, envio })}`);
      }
    }
  }
});
