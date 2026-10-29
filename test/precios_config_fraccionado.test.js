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

test('aplicarEnvasePeso: bolsaPlu (trim, número ok) y bobinaG por peso; ausente no toca; null/"" saca; los dos vacíos borran el peso', () => {
  const r = CF.aplicarEnvasePeso({}, '500', { bolsaPlu: ' 900 ', bobinaG: 8.5 });
  assert.deepStrictEqual(r, { 500: { bolsaPlu: '900', bobinaG: 8.5 } });
  assert.deepStrictEqual(CF.aplicarEnvasePeso(r, '500', { bolsaPlu: 901 }), { 500: { bolsaPlu: '901', bobinaG: 8.5 } });
  assert.deepStrictEqual(CF.aplicarEnvasePeso(r, '500', { bobinaG: null }), { 500: { bolsaPlu: '900' } });
  assert.deepStrictEqual(CF.aplicarEnvasePeso(r, '500', { bolsaPlu: '' }), { 500: { bobinaG: 8.5 } });
  assert.deepStrictEqual(CF.aplicarEnvasePeso(r, '500', { bolsaPlu: null, bobinaG: null }), {});
  assert.deepStrictEqual(CF.aplicarEnvasePeso(r, '250', { bolsaPlu: '900' }), { ...r, 250: { bolsaPlu: '900' } }); // mismo PLU en dos pesos vale
  assert.deepStrictEqual(CF.aplicarEnvasePeso({}, '500', {}), {});
});

test('aplicarEnvasePeso: rechaza sin escribir bobinaG 0, -1, "x", >1000, bolsaPlu "abc", peso inválido y el peso 201', () => {
  const previo = Object.freeze({ 500: Object.freeze({ bolsaPlu: '900' }) });
  for (const malo of [0, -1, 'x', 1000.5, 1001]) assert.throws(() => CF.aplicarEnvasePeso(previo, '500', { bobinaG: malo }), /bobinaG/, String(malo));
  for (const malo of ['abc', '12a', '1234567890123']) assert.throws(() => CF.aplicarEnvasePeso(previo, '500', { bolsaPlu: malo }), /bolsaPlu/, malo);
  assert.deepStrictEqual(CF.aplicarEnvasePeso(previo, '500', { bobinaG: 1000 })[500].bobinaG, 1000);
  for (const malo of ['0', 'x', '1234567', '0500', '-5']) assert.throws(() => CF.aplicarEnvasePeso({}, malo, {}), /peso/, malo);
  assert.throws(() => CF.aplicarEnvasePeso({}, '500', null), /objeto/);
  const lleno = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i + 1), { bolsaPlu: '9' }]));
  assert.throws(() => CF.aplicarEnvasePeso(lleno, '999', { bolsaPlu: '9' }), /200 pesos/);
  assert.deepStrictEqual(CF.aplicarEnvasePeso(lleno, '200', { bobinaG: 5 })[200], { bolsaPlu: '9', bobinaG: 5 }); // uno que ya está se puede cambiar
});

test('validarCostoBobina: número > 0 hasta 1e7; null/"" = sin cargar; 0, negativo, texto o más de 1e7 → error', () => {
  assert.deepStrictEqual([CF.validarCostoBobina({ costoBobinaKg: 6000 }), CF.validarCostoBobina({ costoBobinaKg: null }), CF.validarCostoBobina({ costoBobinaKg: '' }), CF.validarCostoBobina({})],
    [{ costoBobinaKg: 6000 }, { costoBobinaKg: null }, { costoBobinaKg: null }, { costoBobinaKg: null }]);
  for (const malo of [0, -1, '6000', 1e7 + 1, NaN]) assert.throws(() => CF.validarCostoBobina({ costoBobinaKg: malo }), /costoBobinaKg/, String(malo));
});

test('aplicarGranel: envase "bobina" se guarda; "bolsa" y null borran la clave; otro valor tira; ausente no toca', () => {
  const g = CF.aplicarGranel({}, '100', { envase: 'bobina', minKg: 2 }, MAQ);
  assert.deepStrictEqual(g, { 100: { minKg: 2, envase: 'bobina' } });
  assert.deepStrictEqual(CF.aplicarGranel(g, '100', { minKg: 3 }, MAQ), { 100: { minKg: 3, envase: 'bobina' } });
  assert.deepStrictEqual(CF.aplicarGranel(g, '100', { envase: 'bolsa' }, MAQ), { 100: { minKg: 2 } });
  assert.deepStrictEqual(CF.aplicarGranel({ 100: { envase: 'bobina' } }, '100', { envase: null }, MAQ), {});
  assert.throws(() => CF.aplicarGranel(g, '100', { envase: 'otra' }, MAQ), /envase/);
});

test('envaseConCosto: nombre y costo (en su tab) de la bolsa; sin fila, sin costo o costo 0 → null; bobina sin tocar', () => {
  const costoDe = plu => ({ 900: { costo: 20, fuente: 'sistema', nombre: 'Bolsa' }, 902: { costo: 0, nombre: 'Cero' } }[plu] || null);
  assert.deepStrictEqual(CF.envaseConCosto({ 500: { bolsaPlu: '900', bobinaG: 8 }, 250: { bolsaPlu: '901' }, 750: { bolsaPlu: '902' }, 1000: { bobinaG: 5 } }, costoDe), {
    500: { bolsaPlu: '900', bobinaG: 8, bolsaNombre: 'Bolsa', bolsaCosto: 20 }, 250: { bolsaPlu: '901', bolsaNombre: null, bolsaCosto: null },
    750: { bolsaPlu: '902', bolsaNombre: 'Cero', bolsaCosto: null }, 1000: { bobinaG: 5, bolsaNombre: null, bolsaCosto: null } });
});

test('fraccionadoConCambios: escribe la forma nueva (sin escalas ni facilidad/tramos/máquina de subrubro ni claves viejas) sin perder lo vigente', () => {
  const viejo = { costoHora: 6000, ivaVentaPct: 21, facilidades: { facil: 1, medio: 1.3, dificil: 2 }, tiempos: [{ hastaG: 500, minutos: 1 }],
    escalas: { facilidad: { facil: 1, normal: 1.25, dificil: 1.5 } }, factorFacilidad: 1,
    subrubros: { 7: { maquinaId: null, tramos: [], facilidad: 'facil', tiempo: 'lento' }, 8: { minKg: 2, facilidad: 'normal' } },
    insumosSubrubro: {}, insumosPresentacion: { 101: [{ plu: '900', cantidad: 1 }] }, presentaciones: { 101: { facilidad: 'facil' } },
    porGranel: { 100: { facilidad: 'medio', maquinaId: 'env' } }, maquinas: MAQ, insumosPorPeso: { 500: [{ plu: '900', cantidad: 1 }] } };
  const f = CF.fraccionadoConCambios(viejo, { maquinas: [] });
  assert.deepStrictEqual(Object.keys(f).sort(), ['costoBobinaKg', 'costoHora', 'envasePorPeso', 'ivaVentaPct', 'maquinas', 'porGranel', 'subrubros', 'tramosTiempo']);
  assert.deepStrictEqual([f.maquinas, f.tramosTiempo, f.subrubros, f.envasePorPeso, f.costoBobinaKg, f.porGranel, f.ivaVentaPct],
    [[], [], { 8: { minKg: 2 } }, {}, null, { 100: { maquinaId: 'env' } }, 21]); // insumosPorPeso viejo se ignora y no se reescribe
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
