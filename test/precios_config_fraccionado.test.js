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

test('validarMaquinas / usosMaquinas: no deja sacar una máquina que usa un granel (sólo cuentan los graneles)', () => {
  const prev = { maquinas: MAQ, porGranel: { 100: { maquinaId: 'env' }, 200: { maquinaId: 'env', minKg: 1 }, 300: { minKg: 2 } } };
  assert.deepStrictEqual(CF.usosMaquinas(prev), { env: { graneles: 2 } });
  assert.deepStrictEqual(CF.usosMaquinas({ porGranel: {}, subrubros: { 7: { maquinaId: 'env' } } }), {});
  assert.throws(() => CF.validarMaquinas({ maquinas: [] }, prev), /Envasadora la usan 2 graneles/);
  assert.deepStrictEqual(CF.validarMaquinas({ maquinas: [] }, { maquinas: MAQ, porGranel: { 300: { minKg: 2 } } }), { maquinas: [] });
});

test('validarTramosTiempo: hastaG ascendentes, minKg ± hasta 600, el tramo de 1 kg (base) vale 0; [] vale', () => {
  const tramos = [{ hastaG: 250, minKg: 3 }, { hastaG: 1000, minKg: 0 }, { hastaG: 5000, minKg: -2.5 }];
  assert.deepStrictEqual(CF.validarTramosTiempo({ tramos }), { tramosTiempo: tramos });
  assert.deepStrictEqual(CF.validarTramosTiempo({ tramos: [{ hastaG: 250, minKg: 2, otro: 1 }, { hastaG: 500, minKg: 0 }] }),
    { tramosTiempo: [{ hastaG: 250, minKg: 2 }, { hastaG: 500, minKg: 0 }] }); // arriba del último → el último es la base
  assert.deepStrictEqual(CF.validarTramosTiempo({ tramos: [] }), { tramosTiempo: [] });
});

test('validarTramosTiempo: rechaza hastaG no ascendente, base distinta de 0 y minKg fuera de rango', () => {
  assert.throws(() => CF.validarTramosTiempo({ tramos: [{ hastaG: 500, minKg: 1 }, { hastaG: 500, minKg: 0 }] }), /tramos\[1\]\.hastaG/);
  assert.throws(() => CF.validarTramosTiempo({ tramos: [{ hastaG: 1.5, minKg: 0 }] }), /hastaG/);
  assert.throws(() => CF.validarTramosTiempo({ tramos: [{ hastaG: 500, minKg: 1 }, { hastaG: 2000, minKg: 1 }] }), /base/);
  assert.throws(() => CF.validarTramosTiempo({ tramos: [{ hastaG: 1000, minKg: 601 }] }), /tramos\[0\]\.minKg: número de -600 a 600/);
  assert.throws(() => CF.validarTramosTiempo({ tramos: [{ hastaG: 1000, minKg: 'x' }] }), /minKg/);
  assert.throws(() => CF.validarTramosTiempo({}), /lista/);
  assert.throws(() => CF.validarTramosTiempo({ tramos: Array.from({ length: 21 }, (_, i) => ({ hastaG: i + 1, minKg: 0 })) }), /máximo 20/);
});

test('aplicarSubrubros: en lote, número de 0 a 600 o null (saca); no muta', () => {
  const previo = { 7: { minKg: 1 }, 8: { minKg: 2 } };
  assert.deepStrictEqual(CF.aplicarSubrubros(previo, { subrubros: { 7: 1.5, 8: null, 9: 0 } }), { 7: { minKg: 1.5 }, 9: { minKg: 0 } });
  assert.deepStrictEqual(previo, { 7: { minKg: 1 }, 8: { minKg: 2 } });
  assert.throws(() => CF.aplicarSubrubros({}, { subrubros: { 7: -1 } }), /subrubros\.7: número de 0 a 600/);
  assert.throws(() => CF.aplicarSubrubros({}, { subrubros: { 7: 601 } }), /0 a 600/);
  assert.throws(() => CF.aplicarSubrubros({}, { subrubros: { x: 1 } }), /id x inválido/);
  assert.throws(() => CF.aplicarSubrubros({}, { subrubros: [] }), /objeto/);
  assert.throws(() => CF.aplicarSubrubros({}, {}), /objeto/);
});

test('aplicarGranel: minKg y maquinaId (ausente = no tocar, null = sacar); vacío borra la entrada; máquina inexistente rechazada', () => {
  assert.deepStrictEqual(CF.aplicarGranel({}, '100', { maquinaId: 'env' }, MAQ), { 100: { maquinaId: 'env' } });
  const g = CF.aplicarGranel({ 100: { maquinaId: 'env' } }, '100', { minKg: 0 }, MAQ);
  assert.deepStrictEqual(g, { 100: { maquinaId: 'env', minKg: 0 } });
  assert.deepStrictEqual(CF.aplicarGranel(g, '100', { maquinaId: null }, MAQ), { 100: { minKg: 0 } });
  assert.deepStrictEqual(CF.aplicarGranel(g, '100', { maquinaId: null, minKg: null }, MAQ), {});
  assert.deepStrictEqual(CF.aplicarGranel(g, '100', {}, MAQ), g);
  assert.throws(() => CF.aplicarGranel({}, '100', { maquinaId: 'otra' }, MAQ), /maquinaId: otra no está/);
  assert.throws(() => CF.aplicarGranel({}, '100', { minKg: -1 }, MAQ), /minKg: número de 0 a 600/);
  assert.throws(() => CF.aplicarGranel({}, 'x', {}, MAQ), /PLU/);
  assert.throws(() => CF.aplicarGranel({}, '100', null, MAQ), /objeto/);
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

test('fraccionadoConCambios: escribe la forma nueva (sin escalas ni facilidad/tramos/máquina de subrubro ni claves viejas) sin perder lo vigente', () => {
  const viejo = { costoHora: 6000, ivaVentaPct: 21, facilidades: { facil: 1, medio: 1.3, dificil: 2 }, tiempos: [{ hastaG: 500, minutos: 1 }],
    escalas: { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } }, factorFacilidad: 1,
    subrubros: { 7: { maquinaId: null, tramos: [], facilidad: 'facil', tiempo: 'lento' }, 8: { minKg: 2, facilidad: 'normal' } },
    insumosSubrubro: {}, insumosPresentacion: { 101: [{ plu: '900', cantidad: 1 }] }, presentaciones: { 101: { facilidad: 'facil' } },
    porGranel: { 100: { facilidad: 'medio', maquinaId: 'env' } }, maquinas: MAQ, insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] } };
  const f = CF.fraccionadoConCambios(viejo, { maquinas: [] });
  assert.deepStrictEqual(Object.keys(f).sort(), ['costoHora', 'insumosPorPeso', 'ivaVentaPct', 'maquinas', 'porGranel', 'subrubros', 'tramosTiempo']);
  assert.deepStrictEqual([f.maquinas, f.tramosTiempo, f.subrubros, f.insumosPorPeso, f.porGranel, f.ivaVentaPct],
    [[], [], { 8: { minKg: 2 } }, { 500: [{ plu: '900', cantidad: 1 }] }, { 100: { maquinaId: 'env' } }, 21]);
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
