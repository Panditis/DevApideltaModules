'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CF = require('../lib/precios_config_fraccionado');

const MAQ = [{ id: 'env', nombre: 'Envasadora', costoHora: 3000 }];

test('validarMaquinas: id del nombre (sin acentos, repetidos -2), datos validados', () => {
  const { maquinas } = CF.validarMaquinas({ maquinas: [{ nombre: 'Selladora Única', costoHora: 100 }, { nombre: 'Selladora unica', costoHora: 0 },
    { id: 'env', nombre: 'Envasadora', costoHora: 3000 }] });
  assert.deepStrictEqual(maquinas.map(m => m.id), ['selladora-unica', 'selladora-unica-2', 'env']);
  assert.throws(() => CF.validarMaquinas({ maquinas: [{ nombre: '', costoHora: 1 }] }), /nombre/);
  assert.throws(() => CF.validarMaquinas({ maquinas: [{ nombre: 'A', costoHora: -1 }] }), /costoHora/);
  assert.throws(() => CF.validarMaquinas({ maquinas: [{ id: 'X Y', nombre: 'A', costoHora: 1 }] }), /id/);
  assert.throws(() => CF.validarMaquinas({ maquinas: null }), /lista/);
});

test('validarMaquinas / usosMaquinas: no deja sacar una máquina que usa un subrubro o un granel', () => {
  const prev = { maquinas: MAQ, porGranel: { 100: { maquinaId: 'env' } }, subrubros: { 7: { maquinaId: 'env', tramos: [] }, 8: { maquinaId: 'env', tramos: [] } } };
  assert.deepStrictEqual(CF.usosMaquinas(prev), { env: { graneles: 1, subrubros: 2 } });
  assert.throws(() => CF.validarMaquinas({ maquinas: [] }, prev), /Envasadora la usan 2 subrubros y 1 granel/);
});

test('validarEscalas: 3 factores de facilidad y 3 de tiempo, > 0 y hasta 10', () => {
  const escalas = { facilidad: { facil: 1, normal: 1.2, dificil: 2 }, tiempo: { rapido: 0.5, normal: 1, lento: 2 } };
  assert.deepStrictEqual(CF.validarEscalas({ escalas }), { escalas });
  assert.throws(() => CF.validarEscalas({ escalas: { ...escalas, tiempo: { rapido: 0, normal: 1, lento: 1 } } }), /escalas\.tiempo\.rapido/);
  assert.throws(() => CF.validarEscalas({ escalas: { ...escalas, facilidad: { facil: 1, normal: 'x', dificil: 1 } } }), /escalas\.facilidad\.normal/);
  assert.throws(() => CF.validarEscalas({}), /escalas\.facilidad\.facil/);
});

test('aplicarSubrubro: máquina del catálogo y tramos ascendentes; vacío borra la entrada', () => {
  const tramos = [{ hastaG: 250, minutos: 0.5 }, { hastaG: 1000, minutos: 1 }];
  const s = CF.aplicarSubrubro({}, '7', { maquinaId: 'env', tramos }, MAQ);
  assert.deepStrictEqual(s, { 7: { maquinaId: 'env', tramos } });
  assert.deepStrictEqual(CF.aplicarSubrubro(s, '7', { maquinaId: null, tramos: [] }, MAQ), {});
  assert.throws(() => CF.aplicarSubrubro({}, '7', { maquinaId: 'otra', tramos: [] }, MAQ), /maquinaId/);
  assert.throws(() => CF.aplicarSubrubro({}, '7', { tramos: [{ hastaG: 500, minutos: 1 }, { hastaG: 500, minutos: 2 }] }, MAQ), /hastaG/);
  assert.throws(() => CF.aplicarSubrubro({}, '7', { tramos: [{ hastaG: 500, minutos: -1 }] }, MAQ), /minutos/);
  assert.throws(() => CF.aplicarSubrubro({}, 'x', {}, MAQ), /subrubro/);
  assert.throws(() => CF.aplicarSubrubro({}, '7', null, MAQ), /objeto/);
});

test('aplicarGranel: excepción de máquina del granel; null la saca', () => {
  assert.deepStrictEqual(CF.aplicarGranel({}, '100', { maquinaId: 'env' }, MAQ), { 100: { maquinaId: 'env' } });
  assert.deepStrictEqual(CF.aplicarGranel({ 100: { maquinaId: 'env' } }, '100', { maquinaId: null }, MAQ), {});
  assert.throws(() => CF.aplicarGranel({}, '100', { maquinaId: 'otra' }, MAQ), /maquinaId/);
  assert.throws(() => CF.aplicarGranel({}, 'x', {}, MAQ), /PLU/);
  assert.throws(() => CF.aplicarGranel({}, '100', null, MAQ), /objeto/);
});

test('aplicarSubrubro: facilidad y tiempo del subrubro (válidos o null); sólo facilidad / tiempo también es una entrada', () => {
  const s = CF.aplicarSubrubro({}, '7', { maquinaId: 'env', tramos: [], facilidad: 'dificil', tiempo: 'lento' }, MAQ);
  assert.deepStrictEqual(s, { 7: { maquinaId: 'env', tramos: [], facilidad: 'dificil', tiempo: 'lento' } });
  assert.deepStrictEqual(CF.aplicarSubrubro(s, '7', { maquinaId: null, tramos: [], facilidad: 'facil', tiempo: null }, MAQ),
    { 7: { maquinaId: null, tramos: [], facilidad: 'facil' } });
  assert.deepStrictEqual(CF.aplicarSubrubro(s, '7', { maquinaId: null, tramos: [], facilidad: null }, MAQ), {});
  assert.throws(() => CF.aplicarSubrubro({}, '7', { facilidad: 'medio' }, MAQ), /facilidad/);
  assert.throws(() => CF.aplicarSubrubro({}, '7', { tiempo: 'x' }, MAQ), /tiempo/);
  assert.strictEqual(s[7].facilidad, 'dificil'); // no muta
});

test('aplicarInsumosPeso: lista validada por peso en gramos; [] o null saca el peso; máximo 200 pesos', () => {
  const r = CF.aplicarInsumosPeso({}, '500', { insumos: [{ plu: '900', cantidad: 1 }] });
  assert.deepStrictEqual(r, { 500: [{ plu: '900', cantidad: 1 }] });
  assert.deepStrictEqual(CF.aplicarInsumosPeso(r, '500', { insumos: [] }), {});
  assert.deepStrictEqual(CF.aplicarInsumosPeso(r, '500', { insumos: null }), {});
  assert.deepStrictEqual(CF.aplicarInsumosPeso(r, '250', { insumos: [{ plu: 901, cantidad: 2 }] }), { 500: r[500], 250: [{ plu: '901', cantidad: 2 }] });
  for (const malo of ['0', 'x', '1234567', '0500', '-5']) assert.throws(() => CF.aplicarInsumosPeso({}, malo, { insumos: [] }), /peso/, malo);
  assert.throws(() => CF.aplicarInsumosPeso({}, '500', null), /objeto/);
  assert.throws(() => CF.aplicarInsumosPeso({}, '500', { insumos: [{ plu: '9', cantidad: 0 }] }), /insumos\[0\]\.cantidad/);
  assert.throws(() => CF.aplicarInsumosPeso({}, '500', { insumos: [{ plu: '9', cantidad: 1 }, { plu: '9', cantidad: 1 }] }), /repetido/);
  const lleno = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i + 1), [{ plu: '9', cantidad: 1 }]]));
  assert.throws(() => CF.aplicarInsumosPeso(lleno, '999', { insumos: [{ plu: '9', cantidad: 1 }] }), /200 pesos/);
  assert.deepStrictEqual(CF.aplicarInsumosPeso(lleno, '200', { insumos: [{ plu: '8', cantidad: 1 }] })[200], [{ plu: '8', cantidad: 1 }]); // uno que ya está se puede cambiar
});

test('insumosConCosto: nombre y costo (en su tab) de cada insumo; sin fila en SIGA → null', () => {
  const costoDe = plu => ({ 900: { costo: 20, fuente: 'sistema', nombre: 'Bolsa' } }[plu] || null);
  assert.deepStrictEqual(CF.insumosConCosto({ 500: [{ plu: '900', cantidad: 1 }, { plu: '901', cantidad: 2 }] }, costoDe),
    { 500: [{ plu: '900', cantidad: 1, nombre: 'Bolsa', costo: 20 }, { plu: '901', cantidad: 2, nombre: null, costo: null }] });
});

test('fraccionadoConCambios: escribe la forma nueva (sin claves viejas) sin perder los datos viejos', () => {
  const viejo = { costoHora: 6000, ivaVentaPct: 21, facilidades: { facil: 1, medio: 1.3, dificil: 2 }, tiempos: [{ hastaG: 500, minutos: 1 }],
    insumosSubrubro: {}, insumosPresentacion: { 101: [{ plu: '900', cantidad: 1 }] }, presentaciones: { 101: { facilidad: 'facil' } },
    porGranel: { 100: { facilidad: 'medio', maquinaId: 'env' } }, maquinas: MAQ, insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] } };
  const f = CF.fraccionadoConCambios(viejo, { maquinas: [] });
  assert.deepStrictEqual(Object.keys(f).sort(), ['costoHora', 'escalas', 'insumosPorPeso', 'ivaVentaPct', 'maquinas', 'porGranel', 'subrubros']);
  assert.deepStrictEqual([f.maquinas, f.escalas.facilidad.normal, f.insumosPorPeso, f.porGranel, f.ivaVentaPct],
    [[], 1.3, { 500: [{ plu: '900', cantidad: 1 }] }, { 100: { maquinaId: 'env' } }, 21]);
});

test('productosPorSubrubro: graneles con sus presentaciones (y su peso) por subrubro (A→Z), los sin subrubro aparte y los pesos', () => {
  const grupos = [
    { plu: '200', nombre: 'Sal', subrubroId: null, subrubro: null, presentaciones: [] },
    { plu: '100', nombre: 'Almendra', subrubroId: '7', subrubro: 'Frutos secos', presentaciones: [{ plu: '101', nombre: 'Almendra 500G', vigente: 1 },
      { plu: '102', nombre: 'Almendra 1Kg' }, { plu: '103', nombre: 'Almendra suelta' }] },
    { plu: '300', nombre: 'Ají', subrubroId: '3', subrubro: 'Especias', presentaciones: [{ plu: '301', nombre: 'Ají 500 G' }] },
    { plu: null, nombre: 'Sin granel', presentaciones: [{ plu: '9', nombre: 'X' }] },
  ];
  assert.deepStrictEqual(CF.productosPorSubrubro(grupos), {
    subrubrosSiga: [{ id: '3', nombre: 'Especias', graneles: [{ plu: '300', nombre: 'Ají', presentaciones: [{ plu: '301', nombre: 'Ají 500 G', pesoG: 500 }] }] },
      { id: '7', nombre: 'Frutos secos', graneles: [{ plu: '100', nombre: 'Almendra', presentaciones: [{ plu: '101', nombre: 'Almendra 500G', pesoG: 500 },
        { plu: '102', nombre: 'Almendra 1Kg', pesoG: 1000 }, { plu: '103', nombre: 'Almendra suelta', pesoG: null }] }] }],
    sinSubrubro: [{ plu: '200', nombre: 'Sal', presentaciones: [] }],
    // sin peso no entra; el "sin granel" (plu null) tampoco: no se costea
    pesos: [{ pesoG: 500, presentaciones: 2 }, { pesoG: 1000, presentaciones: 1 }],
  });
});
