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

test('aplicarPresentaciones: lote de cambios; campo ausente no toca, null saca, insumos [] saca; validados; no muta', () => {
  const prev = { 101: { facilidad: 'facil', tiempo: 'normal', insumos: [{ plu: '900', cantidad: 1 }] } };
  const r = CF.aplicarPresentaciones(prev, { cambios: [{ plu: '101', tiempo: 'lento' }, { plu: '102', facilidad: 'dificil', insumos: [{ plu: '901', cantidad: 2 }] }] });
  assert.deepStrictEqual(r, { 101: { facilidad: 'facil', tiempo: 'lento', insumos: [{ plu: '900', cantidad: 1 }] }, 102: { facilidad: 'dificil', insumos: [{ plu: '901', cantidad: 2 }] } });
  assert.deepStrictEqual(CF.aplicarPresentaciones(r, { cambios: [{ plu: '101', facilidad: null, tiempo: null, insumos: [] }, { plu: '102', insumos: null }] }),
    { 102: { facilidad: 'dificil' } });
  assert.strictEqual(prev[101].tiempo, 'normal');
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: '1', facilidad: 'medio' }] }), /facilidad/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: '1', tiempo: 'x' }] }), /tiempo/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: '1' }, { plu: '1' }] }), /repetido/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: 'x' }] }), /PLU/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: '1', insumos: [{ plu: '9', cantidad: 0 }] }] }), /cantidad/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [] }), /vacío/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: Array.from({ length: 501 }, (_, i) => ({ plu: String(i + 1), tiempo: 'lento' })) }), /cambios: máximo 500/);
  assert.strictEqual(Object.keys(CF.aplicarPresentaciones({}, { cambios: Array.from({ length: 500 }, (_, i) => ({ plu: String(i + 1), tiempo: 'lento' })) })).length, 500);
  assert.throws(() => CF.aplicarPresentaciones({}, {}), /lista/);
});

test('aplicarPresentaciones: con permitidos, un PLU que no es del universo rechaza todo el lote y los nombra', () => {
  const permitidos = new Set(['101', '102']);
  assert.deepStrictEqual(CF.aplicarPresentaciones({}, { cambios: [{ plu: '101', tiempo: 'lento' }] }, permitidos), { 101: { tiempo: 'lento' } });
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: '101', tiempo: 'lento' }, { plu: '777' }, { plu: '888', tiempo: null }, { plu: '777' }] }, permitidos),
    /no es una presentación de Fraccionado: 777, 888$/);
  const muchos = Array.from({ length: 15 }, (_, i) => ({ plu: String(900 + i) }));
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: muchos }, permitidos), /900.*909 y 5 más$/);
  assert.throws(() => CF.aplicarPresentaciones({}, { cambios: [{ plu: 'x' }] }, permitidos), /PLU/); // el formato inválido sigue siendo su error
});

test('fraccionadoConCambios: escribe la forma nueva (sin claves viejas) sin perder los datos viejos', () => {
  const viejo = { costoHora: 6000, ivaVentaPct: 21, facilidades: { facil: 1, medio: 1.3, dificil: 2 }, tiempos: [{ hastaG: 500, minutos: 1 }],
    insumosSubrubro: {}, insumosPresentacion: { 101: [{ plu: '900', cantidad: 1 }] }, porGranel: { 100: { facilidad: 'medio', maquinaId: 'env' } }, maquinas: MAQ };
  const f = CF.fraccionadoConCambios(viejo, { maquinas: [] });
  assert.deepStrictEqual(Object.keys(f).sort(), ['costoHora', 'escalas', 'ivaVentaPct', 'maquinas', 'porGranel', 'presentaciones', 'subrubros']);
  assert.deepStrictEqual([f.maquinas, f.escalas.facilidad.normal, f.presentaciones, f.porGranel, f.ivaVentaPct],
    [[], 1.3, { 101: { insumos: [{ plu: '900', cantidad: 1 }] } }, { 100: { maquinaId: 'env' } }, 21]);
});

test('productosPorSubrubro: graneles con sus presentaciones por subrubro (A→Z) y los sin subrubro aparte', () => {
  const grupos = [
    { plu: '200', nombre: 'Sal', subrubroId: null, subrubro: null, presentaciones: [] },
    { plu: '100', nombre: 'Almendra', subrubroId: '7', subrubro: 'Frutos secos', presentaciones: [{ plu: '101', nombre: 'Almendra 500G', vigente: 1 }] },
    { plu: '300', nombre: 'Ají', subrubroId: '3', subrubro: 'Especias', presentaciones: [] },
    { plu: null, nombre: 'Sin granel', presentaciones: [{ plu: '9', nombre: 'X' }] },
  ];
  assert.deepStrictEqual(CF.productosPorSubrubro(grupos), {
    subrubrosSiga: [{ id: '3', nombre: 'Especias', graneles: [{ plu: '300', nombre: 'Ají', presentaciones: [] }] },
      { id: '7', nombre: 'Frutos secos', graneles: [{ plu: '100', nombre: 'Almendra', presentaciones: [{ plu: '101', nombre: 'Almendra 500G' }] }] }],
    sinSubrubro: [{ plu: '200', nombre: 'Sal', presentaciones: [] }],
  });
});
