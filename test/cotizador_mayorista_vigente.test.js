'use strict';
// Precio del catálogo: decidido → vigente de SIGA (lista 0) → respaldo. El sugerido nunca es precio.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../lib/cotizador_mayorista');

const listados = (decision, vigentePack = 4850.4) => ({
  almacen: [{ plu: '609', decision, mayoristas: [{ plu: '3676', tipo: 'pack', vigente: vigentePack }, { plu: '3677', tipo: 'bulto', vigente: null }],
    sugeridos: { sistema: { mayoristas: [{ plu: '3676', neto: 6000 }, { plu: '3677', neto: 5500 }] } } }],
});
const tabla = { filas: [{ cod: '609', seccion: 'S', nombre: 'Miel', packQty: '8u', bultoQty: '32u' }] };
const respaldos = new Map([['609', { cod: '609', pack_price: '4000', bulto_price: '3800' }]]);

test('indicePrecios: vigente entero por PLU; null si no hay', () => {
  const i = C.indicePrecios(listados(null));
  assert.strictEqual(i.get('3676').vigente, 4850);
  assert.strictEqual(i.get('3677').vigente, null);
});

test('sin decisión: pack sale del vigente (no del sugerido), bulto sin vigente → respaldo', () => {
  const { filas, revisar } = C.armarCatalogo({ tabla, indice: C.indicePrecios(listados(null)), respaldos });
  assert.deepStrictEqual([filas[0].pack_price, filas[0].origen.pack, filas[0].bulto_price, filas[0].origen.bulto], [4850, 'vigente', 3800, 'respaldo']);
  assert.deepStrictEqual(revisar[0].motivos, ['bulto: sin decisión ni precio vigente']);
});

test('decidido gana sobre vigente', () => {
  const { filas } = C.armarCatalogo({ tabla, indice: C.indicePrecios(listados({ fuente: 'sistema' })), respaldos });
  assert.deepStrictEqual([filas[0].pack_price, filas[0].origen.pack], [6000, 'decision']);
});

test('presentación de fraccionado: vigente sólo si lo hay', () => {
  const pres = (plu, vigente) => ({ plu, nombre: plu, mayorista: true, mayoristaTipo: 'bulto', vigente });
  const i = C.indicePrecios({ fraccionado: [{ plu: '500', presentaciones: [pres('501', 7200.6), pres('502', null)] }] });
  assert.strictEqual(i.get('501').vigente, 7201);
  assert.strictEqual(i.get('502').vigente, null);
});

test('compararConPublicado: cambio del vigente → cambió con pct y conVigente', () => {
  const { filas } = C.armarCatalogo({ tabla, indice: C.indicePrecios(listados(null)), respaldos });
  const r = C.compararConPublicado([{ cod: '609', nombre: 'Miel', pack_price: '4000', bulto_price: '3800' }], filas);
  const pack = r.detalle.find(d => d.tipo === 'pack');
  assert.deepStrictEqual([pack.estado, pack.pct, pack.origen, pack.sistema], ['cambió', 21.3, 'vigente', 4850]);
  assert.deepStrictEqual([r.cambiaron, r.iguales, r.conVigente, r.conDecision], [1, 1, 1, 0]);
});
