'use strict';
// Valida el motor distribucion.js contra el fixture golden del .xlsm.
//   Modo paridad  (corregirBugs:false) → replica la planilla; debe coincidir 100%
//     (requiere golden fresco: si se recalculó a8020.json, regenerar almacen_golden.json).
//   Modo corregido (corregirBugs:true) → producción: ignora el flag estático
//     ProductosAlmacen (no fija min=0 ni 'Fact'), así que difiere de la planilla en
//     todas las sucursales con flag — esperado. El 'Fact' real lo aplica server.js (vivo).
// Uso: node test/validar_almacen.js
const fs = require('fs');
const path = require('path');
const { calcularAlmacen } = require('../lib/distribucion');

const D = path.join(__dirname, '..', 'data');
const a8020  = JSON.parse(fs.readFileSync(path.join(D, 'a8020.json'), 'utf8'));
const listas = JSON.parse(fs.readFileSync(path.join(D, 'distribucion_listas.json'), 'utf8'));
const golden = JSON.parse(fs.readFileSync(path.join(D, 'almacen_golden.json'), 'utf8'));

const productos = golden.map(g => ({ plu: g.plu, stocks: g.stocks }));
// 'logia' excluido: en la planilla la col AW es un contador, no Enviar (Logia no se despacha).
const ENV = ['riv','urq','nacion','chaca','pergamino','sanPedro','sucursal9','sucursal11'];
const MINS = ['riv','urq','nacion','chaca','pergamino','sanpedro','sucu8','sucu9','sucu11'];

const cerca = (a, b, eps = 1e-6) => Math.abs((a||0) - (b||0)) <= eps * Math.max(1, Math.abs(a||0), Math.abs(b||0));

function correr(modo, corregirBugs) {
  const filas = calcularAlmacen(productos, a8020, listas, { corregirBugs });
  const mis = { enviar: {}, mins: {}, importancia: 0, pideTotal: 0 };
  ENV.forEach(b => mis.enviar[b] = 0);
  MINS.forEach(b => mis.mins[b] = 0);
  const ejemplos = [];

  for (let i = 0; i < golden.length; i++) {
    const g = golden[i], f = filas[i];
    let filaMal = null;
    for (const b of ENV) if (!cerca(f.enviar[b], g.enviar[b])) {
      mis.enviar[b]++; filaMal = filaMal || { plu: g.plu, difs: [] };
      filaMal.difs.push(`enviar.${b}: motor=${f.enviar[b]} golden=${g.enviar[b]}`);
    }
    for (const b of MINS) if (!cerca(f.mins[b], g.mins[b])) {
      mis.mins[b]++; filaMal = filaMal || { plu: g.plu, difs: [] };
      filaMal.difs.push(`min.${b}: motor=${f.mins[b]} golden=${g.mins[b]}`);
    }
    if (!cerca(f.importancia, g.importancia, 1e-4)) { mis.importancia++; filaMal = filaMal || { plu: g.plu, difs: [] };
      filaMal.difs.push(`importancia: motor=${f.importancia.toFixed(5)} golden=${(g.importancia||0).toFixed(5)}`); }
    if (!cerca(f.pideTotal, g.pideTotal)) { mis.pideTotal++; filaMal = filaMal || { plu: g.plu, difs: [] };
      filaMal.difs.push(`pideTotal: motor=${f.pideTotal} golden=${g.pideTotal}`); }
    if (filaMal && ejemplos.length < 12) ejemplos.push(filaMal);
  }

  const totalEnv = Object.values(mis.enviar).reduce((a, b) => a + b, 0);
  const totalMin = Object.values(mis.mins).reduce((a, b) => a + b, 0);
  console.log(`\n===== MODO ${modo} (${golden.length} filas) =====`);
  console.log('Enviar mismatches por sucursal:', JSON.stringify(mis.enviar));
  console.log('Min    mismatches por sucursal:', JSON.stringify(mis.mins));
  console.log(`Importancia mismatches: ${mis.importancia}   pideTotal mismatches: ${mis.pideTotal}`);
  console.log(`TOTAL enviar=${totalEnv}  min=${totalMin}`);
  if (ejemplos.length) {
    console.log('Ejemplos:');
    for (const e of ejemplos) console.log(`  PLU ${e.plu}: ${e.difs.join(' | ')}`);
  }
  return { totalEnv, totalMin, mis };
}

const paridad = correr('PARIDAD (corregirBugs=false)', false);
const corregido = correr('CORREGIDO (corregirBugs=true)', true);

console.log('\n===== VEREDICTO =====');
console.log(paridad.totalEnv === 0 && paridad.totalMin === 0 && paridad.mis.importancia === 0
  ? '✓ PARIDAD 100% — el motor replica la planilla exacto.'
  : '✗ PARIDAD FALLA — revisar diffs arriba.');
// CORREGIDO ignora el flag estático ProductosAlmacen (Opción 2): los productos que
// antes tenían min=0/'Fact' por planilla ahora se recalculan, así que difieren del
// golden en todas las sucursales con flag. Es divergencia intencional, no un fallo.
console.log(`ℹ CORREGIDO — divergencias vs planilla esperadas (flag estático ignorado): ` +
  `enviar=${corregido.totalEnv} min=${corregido.totalMin}. 'Fact' en producción sale de facturación viva (server.js).`);
