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

test('aplicarTiempos subrubros: en lote, número de 0 a 600 o null (saca); no muta; sin graneles no toca porGranel', () => {
  const cf = Object.freeze({ subrubros: Object.freeze({ 7: { minKg: 1 }, 8: { minKg: 2 } }), porGranel: { 100: { minKg: 3 } }, maquinas: MAQ });
  assert.deepStrictEqual(CF.aplicarTiempos(cf, { subrubros: { 7: 1.5, 8: null, 9: 0 } }), { subrubros: { 7: { minKg: 1.5 }, 9: { minKg: 0 } } });
  assert.deepStrictEqual(cf.subrubros, { 7: { minKg: 1 }, 8: { minKg: 2 } });
  assert.throws(() => CF.aplicarTiempos(cf, { subrubros: { 7: -1 } }), /subrubros\.7: número de 0 a 600/);
  assert.throws(() => CF.aplicarTiempos(cf, { subrubros: { 7: 601 } }), /0 a 600/);
  assert.throws(() => CF.aplicarTiempos(cf, { subrubros: { x: 1 } }), /id x inválido/);
  assert.throws(() => CF.aplicarTiempos(cf, { subrubros: [] }), /objeto/);
  for (const vacio of [{}, null, { subrubros: {} }, { graneles: {} }, { subrubros: {}, graneles: {} }])
    assert.throws(() => CF.aplicarTiempos(cf, vacio), /mandá al menos un cambio/, JSON.stringify(vacio));
});

test('aplicarTiempos graneles: minKg propio (0 vale, null saca y conserva envase/maquinaId); atómico; 0..600; tope 1000; no muta', () => {
  const cf = { subrubros: { 7: { minKg: 1 } }, maquinas: MAQ,
    porGranel: Object.freeze({ 100: Object.freeze({ minKg: 3, maquinaId: 'env' }), 200: Object.freeze({ minKg: 4, envase: 'bobina' }), 300: { minKg: 5 } }) };
  assert.deepStrictEqual(CF.aplicarTiempos(cf, { graneles: { 100: null, 200: null, 300: null, 400: 0 } }),
    { porGranel: { 100: { maquinaId: 'env' }, 200: { envase: 'bobina' }, 400: { minKg: 0 } } });
  assert.deepStrictEqual(CF.aplicarTiempos(cf, { subrubros: { 7: 2 }, graneles: { 300: 6 } }),
    { subrubros: { 7: { minKg: 2 } }, porGranel: { ...cf.porGranel, 300: { minKg: 6 } } });
  assert.throws(() => CF.aplicarTiempos(cf, { graneles: { 300: 1, x: 1 } }), /graneles\.x: PLU/);
  assert.throws(() => CF.aplicarTiempos(cf, { graneles: { 300: 601 } }), /graneles\.300: minKg: número de 0 a 600/);
  assert.throws(() => CF.aplicarTiempos(cf, { graneles: { 300: -1 } }), /0 a 600/);
  assert.throws(() => CF.aplicarTiempos(cf, { graneles: [] }), /graneles: debe ser un objeto/);
  const mil = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i + 1), 1]));
  assert.strictEqual(Object.keys(CF.aplicarTiempos({ ...cf, porGranel: {} }, { graneles: mil }).porGranel).length, 1000);
  assert.throws(() => CF.aplicarTiempos(cf, { graneles: { ...mil, 1001: 1 } }), /graneles: máximo 1000/);
  assert.deepStrictEqual(cf.porGranel[300], { minKg: 5 });
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

const envPeso = (prev, g, e) => CF.aplicarEnvase({ envasePorPeso: prev }, { pesos: { [g]: e } }).envasePorPeso;

test('aplicarEnvase pesos: bolsaPlu (trim, número ok) y bobinaG por peso; ausente no toca; null/"" saca; los dos vacíos borran el peso', () => {
  const r = envPeso({}, '500', { bolsaPlu: ' 900 ', bobinaG: 8.5 });
  assert.deepStrictEqual(r, { 500: { bolsaPlu: '900', bobinaG: 8.5 } });
  assert.deepStrictEqual(envPeso(r, '500', { bolsaPlu: 901 }), { 500: { bolsaPlu: '901', bobinaG: 8.5 } });
  assert.deepStrictEqual(envPeso(r, '500', { bobinaG: null }), { 500: { bolsaPlu: '900' } });
  assert.deepStrictEqual(envPeso(r, '500', { bolsaPlu: '' }), { 500: { bobinaG: 8.5 } });
  assert.deepStrictEqual(envPeso(r, '500', { bolsaPlu: null, bobinaG: null }), {});
  assert.deepStrictEqual(envPeso(r, '250', { bolsaPlu: '900' }), { ...r, 250: { bolsaPlu: '900' } }); // mismo PLU en dos pesos vale
  assert.deepStrictEqual(envPeso({}, '500', {}), {});
  assert.deepStrictEqual(r, { 500: { bolsaPlu: '900', bobinaG: 8.5 } }); // no muta
});

test('aplicarEnvase sinEnvase: marca borrando envase, false/null des-marca, envase des-marca, conflicto/tipo error, atómico, MAX_PESOS', () => {
  const r = Object.freeze({ 500: Object.freeze({ bolsaPlu: '900', bobinaG: 8 }) });
  const s = envPeso(r, '500', { sinEnvase: true });
  assert.deepStrictEqual(s, { 500: { sinEnvase: true } });
  assert.deepStrictEqual(envPeso(s, '500', { sinEnvase: false }), {});
  assert.deepStrictEqual(envPeso(s, '500', { sinEnvase: null }), {});
  assert.deepStrictEqual(envPeso(s, '500', { bolsaPlu: '7' }), { 500: { bolsaPlu: '7' } });
  assert.deepStrictEqual(envPeso(s, '500', { bolsaPlu: null, bobinaG: null }), {});
  assert.deepStrictEqual(envPeso(s, '500', {}), s); // body vacío no toca
  assert.deepStrictEqual(envPeso(r, '500', { sinEnvase: true, bolsaPlu: null }), { 500: { sinEnvase: true } });
  assert.throws(() => envPeso(r, '500', { sinEnvase: true, bobinaG: 5 }), /peso 500: sinEnvase no puede ir junto con bolsaPlu ni bobinaG/);
  for (const malo of ['true', 1, {}]) assert.throws(() => envPeso(r, '500', { sinEnvase: malo }), /peso 500: sinEnvase debe ser true, false o null/);
  assert.throws(() => CF.aplicarEnvase({ envasePorPeso: r }, { pesos: { 250: { sinEnvase: true }, 0: {} } }), /peso/);
  const lleno = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i + 1), { sinEnvase: true }]));
  assert.throws(() => envPeso(lleno, '999', { sinEnvase: true }), /200 pesos/);
  assert.deepStrictEqual(envPeso(lleno, '5', { bolsaPlu: '9' })[5], { bolsaPlu: '9' });
  const c = CF.envaseConCosto(s, () => null);
  assert.deepStrictEqual(c, { 500: { sinEnvase: true, bolsaNombre: null, bolsaCosto: null } });
});

test('aplicarEnvase pesos: rechaza nombrando el peso bobinaG 0, -1, "x", >1000, bolsaPlu "abc", peso inválido y el peso 201; atómico', () => {
  const previo = Object.freeze({ 500: Object.freeze({ bolsaPlu: '900' }) });
  for (const malo of [0, -1, 'x', 1000.5, 1001]) assert.throws(() => envPeso(previo, '500', { bobinaG: malo }), /peso 500: bobinaG/, String(malo));
  for (const malo of ['abc', '12a', '1234567890123']) assert.throws(() => envPeso(previo, '500', { bolsaPlu: malo }), /peso 500: bolsaPlu/, malo);
  assert.deepStrictEqual(envPeso(previo, '500', { bobinaG: 1000 })[500].bobinaG, 1000);
  for (const malo of ['0', 'x', '1234567', '0500', '-5']) assert.throws(() => envPeso({}, malo, {}), /peso/, malo);
  assert.throws(() => envPeso({}, '500', null), /objeto/);
  assert.throws(() => CF.aplicarEnvase({}, { pesos: [] }), /pesos: debe ser un objeto/);
  const lleno = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i + 1), { bolsaPlu: '9' }]));
  assert.throws(() => envPeso(lleno, '999', { bolsaPlu: '9' }), /200 pesos/);
  assert.deepStrictEqual(envPeso(lleno, '200', { bobinaG: 5 })[200], { bolsaPlu: '9', bobinaG: 5 }); // uno que ya está se puede cambiar
  assert.throws(() => CF.aplicarEnvase({ envasePorPeso: previo }, { costoBobinaKg: 5, pesos: { 250: { bobinaG: 3 }, 500: { bobinaG: 0 } } }), /peso 500/);
});

test('aplicarEnvase costoBobinaKg: ausente no toca; > 0 hasta 1e7; null/"" = sin cargar; 0, negativo, texto o más de 1e7 → error', () => {
  const cf = { envasePorPeso: { 500: { bobinaG: 8 } } };
  assert.deepStrictEqual(CF.aplicarEnvase(cf, {}), {});
  assert.deepStrictEqual(CF.aplicarEnvase(cf, null), {});
  assert.deepStrictEqual([6000, null, ''].map(v => CF.aplicarEnvase(cf, { costoBobinaKg: v })),
    [{ costoBobinaKg: 6000 }, { costoBobinaKg: null }, { costoBobinaKg: null }]);
  assert.deepStrictEqual(CF.aplicarEnvase(cf, { costoBobinaKg: 10, pesos: { 500: { bobinaG: null } } }), { costoBobinaKg: 10, envasePorPeso: {} });
  for (const malo of [0, -1, '6000', 1e7 + 1, NaN]) assert.throws(() => CF.aplicarEnvase(cf, { costoBobinaKg: malo }), /costoBobinaKg/, String(malo));
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

// ── activos (estado en el listado de Fraccionado, costeo.activoGranel) en el PUT subrubros ──
test('aplicarActivos: true/false se guardan, null saca la clave; sin activos devuelve el mismo mapa; no muta', () => {
  // Arrange
  const ag = { 7: true, 8: false };
  // Act
  const nuevo = CF.aplicarActivos(ag, { activos: { 8: null, 9: true, 10: false } });
  // Assert
  assert.deepStrictEqual(nuevo, { 7: true, 9: true, 10: false });
  assert.deepStrictEqual(ag, { 7: true, 8: false });
  assert.strictEqual(CF.aplicarActivos(ag, { subrubros: { 1: 2 } }), ag);
  assert.strictEqual(CF.aplicarActivos(undefined, {}), undefined); // sin la clave y sin activos: no se crea
  assert.deepStrictEqual(CF.aplicarActivos(undefined, { activos: { 5: true } }), { 5: true });
});

test('aplicarActivos: PLU inválido, valor no booleano (incl. "true" y 1), no objeto y más de 1000 → error, todo o nada', () => {
  assert.throws(() => CF.aplicarActivos({}, { activos: { '5x': true } }), /^Error: activos\.5x: PLU inválido$/);
  for (const v of ['true', 1, 0, {}, []]) {
    assert.throws(() => CF.aplicarActivos({}, { activos: { 5: v } }), /activos\.5: activo inválido: true, false o null \(automático\)/, JSON.stringify(v));
  }
  for (const v of [[], 'x', 3]) assert.throws(() => CF.aplicarActivos({}, { activos: v }), /activos: debe ser un objeto/, JSON.stringify(v));
  const mil = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [String(i + 1), true]));
  assert.strictEqual(Object.keys(CF.aplicarActivos({}, { activos: mil })).length, 1000);
  assert.throws(() => CF.aplicarActivos({}, { activos: { ...mil, 1001: true } }), /activos: máximo 1000/);
});

test('aplicarTiempos con activos: solos cuentan como cambio (no tocan fraccionado); con los tres mapas; no objeto da error; vacío da el mensaje nuevo', () => {
  const cf = { subrubros: { 7: { minKg: 8 } }, porGranel: { 100: { minKg: 4 } } };
  assert.deepStrictEqual(CF.aplicarTiempos(cf, { activos: { 100: false } }), {});
  assert.deepStrictEqual(CF.aplicarTiempos(cf, { subrubros: { 7: 2 }, graneles: { 100: null }, activos: { 100: true } }),
    { subrubros: { 7: { minKg: 2 } }, porGranel: {} });
  assert.throws(() => CF.aplicarTiempos(cf, { activos: [] }), /activos: debe ser un objeto/);
  for (const vacio of [{}, { activos: {} }, { subrubros: {}, graneles: {}, activos: {} }]) {
    assert.throws(() => CF.aplicarTiempos(cf, vacio), /^Error: subrubros, graneles o activos: mandá al menos un cambio$/, JSON.stringify(vacio));
  }
});
