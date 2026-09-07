'use strict';
const test = require('node:test');
const assert = require('node:assert');
const H = require('../lib/historial_sala');

// Dos lotes del mismo día: uno con dos tareas cargadas y otro sólo con envasado, que es el
// caso más común en los resúmenes viejos.
const CARGAS = [
  {
    id: 'legacy:130126KAAR0-2375:2375', fecha: '2026-01-13', plu: '2375', nombre: 'Polen 100G',
    cantFraccionada: 80, granelConsumido: 8, lote: '130126KAAR0-2375',
    desde: '08:00', hasta: '09:00',
    roles: [
      { rol: 'Envasado', nombre: 'KAREN', desde: '08:00', hasta: '08:30' },
      { rol: 'Etiquetado', nombre: 'federico', desde: '08:30', hasta: '09:00' },
    ],
  },
  {
    id: 'legacy:130126KAAR0-2381:2381', fecha: '2026-01-13', plu: '2381', nombre: 'Polen 200G',
    cantFraccionada: 30, granelConsumido: 6, lote: '130126KAAR0-2381',
    desde: '09:00', hasta: '10:00',
    roles: [{ rol: 'Envasado', nombre: 'Karen', desde: '09:00', hasta: '10:00' }],
  },
];

test('resumenRoles suma los minutos de cada tarea de la línea', () => {
  const roles = H.resumenRoles(CARGAS);
  const env = roles.find(r => r.rol === 'Envasado');
  const etq = roles.find(r => r.rol === 'Etiquetado');
  assert.equal(env.cargas, 2);
  assert.equal(env.minutos, 90);            // 30 + 60
  assert.equal(env.minPromedio, 45);
  assert.equal(env.personas, 1);            // "KAREN" y "Karen" son la misma
  assert.equal(etq.minutos, 30);
  // El orden es el de la línea, no el alfabético.
  assert.deepEqual(roles.map(r => r.rol), ['Envasado', 'Etiquetado']);
});

test('resumenRoles cuenta aparte los roles sin horario usable', () => {
  const roles = H.resumenRoles([{ fecha: '2026-01-13', plu: '1', roles: [
    { rol: 'Envasado', nombre: 'ANA', desde: '', hasta: '' },
    { rol: 'Envasado', nombre: 'ANA', desde: '10:00', hasta: '09:00' },  // fin antes que inicio
  ] }]);
  assert.equal(roles[0].cargas, 2);
  assert.equal(roles[0].sinHorario, 2);
  assert.equal(roles[0].minPromedio, null);  // sin nada medible no hay promedio inventado
});

test('resumenPersonasPorRol reparte las cantidades entre las tareas del lote', () => {
  const filas = H.resumenPersonasPorRol(CARGAS);
  const karenEnv = filas.find(f => f.persona === 'Karen' && f.rol === 'Envasado');
  const fede = filas.find(f => f.persona === 'Federico');
  // Lote 1: 80 u repartidas entre envasado y etiquetado = 40. Lote 2: 30 u para envasado solo.
  assert.equal(karenEnv.unidades, 70);
  assert.equal(karenEnv.kilos, 10);          // 8/2 + 6
  assert.equal(fede.unidades, 40);
  assert.equal(fede.rol, 'Etiquetado');
  // La suma por tarea no puede pasarse del total producido.
  const total = filas.reduce((s, f) => s + f.unidades, 0);
  assert.equal(total, 110);
});

test('resumenPersonasPorRol fusiona los bloques horarios del mismo día', () => {
  const solapadas = [
    { fecha: '2026-01-13', plu: '1', cantFraccionada: 10,
      roles: [{ rol: 'Envasado', nombre: 'ANA', desde: '08:00', hasta: '09:00' }] },
    { fecha: '2026-01-13', plu: '2', cantFraccionada: 10,
      roles: [{ rol: 'Envasado', nombre: 'ANA', desde: '08:30', hasta: '09:00' }] },
  ];
  const [ana] = H.resumenPersonasPorRol(solapadas);
  assert.equal(ana.horas, 1);          // una hora trabajada, no una y media
  assert.equal(ana.minPromedio, 45);   // el promedio por lote sí usa los minutos crudos
});

test('resumenProductosPorRol abre una columna de minutos por tarea', () => {
  const [polen100] = H.resumenProductosPorRol(CARGAS).filter(p => p.plu === '2375');
  assert.equal(polen100.minEnvasado, 30);
  assert.equal(polen100.minEtiquetado, 30);
  assert.equal(polen100.minEmpaquetado, null);   // esa tarea no se hizo
  assert.equal(polen100.minTanda, 60);           // el bloque entero del lote
  assert.equal(polen100.minPorKilo, 7.5);        // 60 min / 8 kg
  assert.deepEqual(polen100.personas, ['Federico', 'Karen']);
});

test('registros deja una fila por lote con las tres tareas desplegadas', () => {
  const filas = H.registros(CARGAS);
  assert.equal(filas.length, 2);
  const f = filas.find(x => x.plu === '2375');
  assert.equal(f.Envasado, 'Karen');
  assert.equal(f.hsEnvasado, '08:00–08:30');
  assert.equal(f.minEnvasado, 30);
  assert.equal(f.Empaquetado, '');
  assert.equal(f.minEmpaquetado, null);
});

test('cobertura informa el rango y cuántos lotes se pueden medir', () => {
  const sinHora = { fecha: '2026-02-01', plu: '9', roles: [{ rol: 'Envasado', nombre: 'ANA' }] };
  const c = H.cobertura([...CARGAS, sinHora], [{ fecha: '2026-01-13' }]);
  assert.equal(c.jornadas, 2);
  assert.equal(c.desde, '2026-01-13');
  assert.equal(c.hasta, '2026-02-01');
  assert.equal(c.cargas, 3);
  assert.equal(c.medibles, 2);
  assert.equal(c.sinHorario, 1);
  assert.equal(c.tareas, 1);
});

// ── Tiempo sin doble conteo ───────────────────────────────────────────────────
test('minutosEfectivos no suma dos veces las tareas simultáneas del lote', () => {
  // Las tres tareas en el mismo bloque: es UNA hora de trabajo, no tres.
  const juntas = { roles: ['Envasado', 'Etiquetado', 'Empaquetado']
    .map(rol => ({ rol, nombre: 'ANA', desde: '08:00', hasta: '09:00' })) };
  assert.equal(H.minutosEfectivos(juntas), 60);

  // Dos de las tres comparten horario y la tercera va después: 60 + 30.
  const dosYUna = { roles: [
    { rol: 'Envasado', nombre: 'ANA', desde: '08:00', hasta: '09:00' },
    { rol: 'Etiquetado', nombre: 'BEA', desde: '08:00', hasta: '09:00' },
    { rol: 'Empaquetado', nombre: 'ANA', desde: '09:00', hasta: '09:30' },
  ] };
  assert.equal(H.minutosEfectivos(dosYUna), 90);

  // Solapadas a medias: 08:00-09:00 ∪ 08:30-10:00 = 08:00-10:00.
  const parcial = { roles: [
    { rol: 'Envasado', nombre: 'ANA', desde: '08:00', hasta: '09:00' },
    { rol: 'Etiquetado', nombre: 'BEA', desde: '08:30', hasta: '10:00' },
  ] };
  assert.equal(H.minutosEfectivos(parcial), 120);
});

test('horasSalaDe une los lotes del día y no cruza jornadas', () => {
  const cargas = [
    // Dos lotes en paralelo el mismo día: una sola hora de sala.
    { fecha: '2026-01-13', plu: '1', roles: [{ rol: 'Envasado', nombre: 'ANA', desde: '08:00', hasta: '09:00' }] },
    { fecha: '2026-01-13', plu: '2', roles: [{ rol: 'Envasado', nombre: 'BEA', desde: '08:00', hasta: '09:00' }] },
    // Otro día, mismo horario: no se fusiona con el anterior.
    { fecha: '2026-01-14', plu: '3', roles: [{ rol: 'Envasado', nombre: 'ANA', desde: '08:00', hasta: '09:00' }] },
  ];
  assert.equal(H.horasSalaDe(cargas), 2);
  assert.equal(H.minutosSalaPorDia(cargas).get('2026-01-13'), 60);
});

test('el tablero recibe los productos con su promedio por tarea', () => {
  // El lote sin hora de fin en etiquetado no puede bajar el promedio: se ignora ese registro
  // y el promedio sale de los que sí están cronometrados.
  const aMedias = { fecha: '2026-01-14', plu: '2375', nombre: 'Polen 100G', cantFraccionada: 40,
                    roles: [{ rol: 'Envasado', nombre: 'KAREN', desde: '08:00', hasta: '09:00' },
                            { rol: 'Etiquetado', nombre: 'KAREN', desde: '09:00', hasta: '' }] };
  const r = H.resumen({ cargas: [...CARGAS, aMedias], tareas: [] });
  const polen = r.productos.find(p => p.plu === '2375');
  assert.equal(polen.cargas, 2);
  assert.equal(polen.minEnvasado, 45);      // (30 + 60) / 2
  assert.equal(polen.minEtiquetado, 30);    // el sin hora de fin queda afuera del promedio
  assert.equal(polen.minEmpaquetado, null); // esa tarea nunca se registró
});

test('la referencia sale del archivo entero, no del rango filtrado', () => {
  // Una semana con los dos lotes de enero y otra, dos meses después, con uno solo: la referencia
  // promedia las dos semanas aunque el tablero esté mirando una sola.
  const marzo = { fecha: '2026-03-05', plu: '2375', nombre: 'Polen 100G', cantFraccionada: 40,
                  roles: [{ rol: 'Envasado', nombre: 'BEA', desde: '08:00', hasta: '09:00' }] };
  const precios = new Map([['2375', 100], ['2381', 200]]);
  const ref = H.referencia({ cargas: [...CARGAS, marzo] }, precios, '2026-08-14T12:00:00.000Z');
  assert.equal(ref.semanas, 2);
  assert.equal(ref.desde, '2026-01-13');
  assert.equal(ref.hasta, '2026-03-05');
  // Con el 40 % descontado — semana de enero: 80×60 + 30×120 = 8400. Marzo: 40×60 = 2400.
  // Promedio de las dos, 5400.
  assert.equal(ref.semanal.valor, 5400);
  assert.equal(ref.tareas.Envasado, 50);              // (30 + 60 + 60) / 3
  assert.equal(ref.productos['2375'].minEnvasado, 45); // (30 + 60) / 2
  assert.equal(ref.calculadoEl, '2026-08-14T12:00:00.000Z');
});

test('las horas de sala nunca superan a las horas-persona', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] });
  assert.ok(r.totales.horasSala <= r.totales.horas,
    `sala ${r.totales.horasSala} > persona ${r.totales.horas}`);
});

// ── Búsqueda ──────────────────────────────────────────────────────────────────
test('filtrar acota por producto y por persona', () => {
  assert.equal(H.filtrar(CARGAS, { plu: '2375' }).length, 1);
  assert.equal(H.filtrar(CARGAS, { persona: 'KAREN' }).length, 2);      // envasa los dos lotes
  assert.equal(H.filtrar(CARGAS, { persona: 'federico' }).length, 1);   // sin importar mayúsculas
  assert.equal(H.filtrar(CARGAS, { plu: '2375', persona: 'Federico' }).length, 1);
  assert.equal(H.filtrar(CARGAS, { plu: '2381', persona: 'Federico' }).length, 0);
  assert.equal(H.filtrar(CARGAS, {}).length, 2);                       // sin filtro, todo
});

test('filtrar acota por rango de fechas', () => {
  const otroMes = { fecha: '2026-03-05', plu: '9', nombre: 'Z', cantFraccionada: 5,
                    roles: [{ rol: 'Envasado', nombre: 'ANA', desde: '08:00', hasta: '09:00' }] };
  const todas = [...CARGAS, otroMes];
  assert.equal(H.filtrar(todas, { desde: '2026-01-01', hasta: '2026-01-31' }).length, 2);
  assert.equal(H.filtrar(todas, { desde: '2026-03-01', hasta: '2026-03-31' }).length, 1);
  assert.equal(H.filtrar(todas, { desde: '2026-01-13', hasta: '2026-01-13' }).length, 2);  // bordes inclusive
  assert.equal(H.filtrar(todas, { desde: '2026-05-01', hasta: '2026-05-31' }).length, 0);
  // El rango se combina con los otros filtros, no los reemplaza.
  assert.equal(H.filtrar(todas, { desde: '2026-01-01', hasta: '2026-01-31', persona: 'Federico' }).length, 1);
});

test('el rango recorta los totales pero no el catálogo ni el rango total', () => {
  const otroMes = { fecha: '2026-03-05', plu: '9', nombre: 'Z', cantFraccionada: 5,
                    roles: [{ rol: 'Envasado', nombre: 'BEA', desde: '08:00', hasta: '09:00' }] };
  const datos = { cargas: [...CARGAS, otroMes],
                  tareas: [{ fecha: '2026-01-13', persona: 'ANA', tarea: 'limpieza' },
                           { fecha: '2026-03-05', persona: 'ANA', tarea: 'limpieza' }] };
  const r = H.resumen(datos, { desde: '2026-01-01', hasta: '2026-01-31' });
  assert.equal(r.cobertura.cargas, 2);
  assert.equal(r.tareas.length, 1);                       // la tarea de marzo queda afuera
  assert.equal(r.totales.horasSala, 2);                   // sólo los dos lotes de enero
  // El catálogo y el rango del archivo siguen completos: son la salida del filtro.
  assert.equal(r.opciones.productos.length, 3);
  assert.deepEqual(r.rangoTotal, { desde: '2026-01-13', hasta: '2026-03-05' });
  assert.equal(r.filtro.desde, '2026-01-01');
});

test('un rango sin jornadas devuelve el tablero vacío, no un error', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] }, { desde: '2026-09-01', hasta: '2026-09-30' });
  assert.equal(r.cobertura.jornadas, 0);
  assert.equal(r.totales.horasSala, 0);
  assert.deepEqual(r.roles, []);
  assert.deepEqual(r.porSemana, []);
  assert.equal(r.opciones.productos.length, 2);   // se puede volver
  assert.equal(r.rangoTotal.desde, '2026-01-13');
});

test('las opciones salen del historial entero, no del filtrado', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] }, { persona: 'Federico' });
  assert.equal(r.cobertura.cargas, 1);                       // se midió un solo lote
  assert.equal(r.opciones.productos.length, 2);              // pero los dos siguen elegibles
  assert.deepEqual(r.opciones.personas, ['Federico', 'Karen']);
  assert.equal(r.filtro.persona, 'Federico');
});

test('un producto elegido deja fuera las tareas sin producto', () => {
  const datos = { cargas: CARGAS, tareas: [{ fecha: '2026-01-13', persona: 'KAREN', tarea: 'limpieza' }] };
  assert.equal(H.resumen(datos, { plu: '2375' }).tareas.length, 0);
  assert.equal(H.resumen(datos, { persona: 'Karen' }).tareas.length, 1);
  assert.equal(H.resumen(datos).tareas.length, 1);
});

// ── Semanal ───────────────────────────────────────────────────────────────────
test('resumenPeriodos agrega las horas de sala de cada semana', () => {
  const [semana] = H.resumenPeriodos(CARGAS, 'semana', []);
  // Los dos lotes van seguidos, 08:00-09:00 y 09:00-10:00: dos horas de sala.
  assert.equal(semana.horasSala, 2);
  assert.equal(semana.cargas, 2);
  assert.ok(semana.horas >= semana.horasSala);
});

// ── Valorización ──────────────────────────────────────────────────────────────
// Precio de lista de los dos productos del fixture: polen 100 g y polen 200 g.
const PRECIOS = new Map([['2375', 1000], ['2381', 1800]]);

test('valorDeCarga multiplica unidades por precio de lista neto de 40 %', () => {
  assert.equal(H.valorDeCarga(CARGAS[0], PRECIOS), 48000);    // 80 u × (1000 - 40 %)
  assert.equal(H.valorDeCarga(CARGAS[1], PRECIOS), 32400);    // 30 u × (1800 - 40 %)
  // Sin precio no se inventa nada: el lote vale 0 y se cuenta aparte.
  assert.equal(H.valorDeCarga(CARGAS[0], new Map()), 0);
  assert.equal(H.valorDeCarga(CARGAS[0], null), 0);
  // Acepta también una función, no sólo un Map.
  assert.equal(H.valorDeCarga(CARGAS[0], () => 1000), 48000);
});

test('el precio de lista se muestra y se valoriza con el 40 % descontado', () => {
  assert.equal(H.DESCUENTO_VENTA, 0.4);
  assert.equal(H.netoDeVenta(1000), 600);
  assert.equal(H.precioDe(PRECIOS, '2375'), 600);
  // El precio que viaja al tablero es el mismo neto con el que se calcula el valor.
  const prod = H.resumenProductosPorRol(CARGAS, PRECIOS).find(p => p.plu === '2375');
  assert.equal(prod.precio, 600);
  assert.equal(prod.valor, prod.precio * prod.unidades);
});

test('los períodos traen el total en plata y el ritmo por hora de sala', () => {
  const [semana] = H.resumenPeriodos(CARGAS, 'semana', [], PRECIOS);
  assert.equal(semana.valor, 80400);           // 48000 + 32400
  assert.equal(semana.sinPrecio, 0);
  assert.equal(semana.horasSala, 2);
  assert.equal(semana.valorPorHora, 40200);    // 80400 / 2 h
});

test('los lotes sin precio se cuentan aparte y no ensucian el total', () => {
  const soloUno = new Map([['2375', 1000]]);
  const r = H.resumen({ cargas: CARGAS, tareas: [] }, {}, soloUno);
  assert.equal(r.totales.valor, 48000);        // el de 2381 queda afuera
  assert.equal(r.totales.sinPrecio, 1);
  assert.equal(r.porSemana[0].sinPrecio, 1);
  // El producto sin precio igual se mide, con la plata en null en vez de en cero.
  const sinPrecio = H.resumenProductosPorRol(CARGAS, soloUno).find(p => p.plu === '2381');
  assert.equal(sinPrecio.valor, null);
  assert.equal(sinPrecio.precio, null);
});

test('cada lote del detalle trae su valor, para el desglose por día', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] }, {}, PRECIOS);
  const uno = r.registros.find(x => x.plu === '2375');
  assert.equal(uno.valor, 48000);
  // La suma de los lotes de la semana da el total del encabezado.
  assert.equal(r.registros.reduce((s, x) => s + (x.valor || 0), 0), r.porSemana[0].valor);
});

test('horasPorDia acompaña al detalle de cada jornada', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] }, {}, PRECIOS);
  assert.equal(r.horasPorDia['2026-01-13'], 2);
  assert.equal(Object.keys(r.horasPorDia).length, 1);
});

test('sin precios el tablero sigue midiendo todo lo demás', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] });
  assert.equal(r.totales.valor, 0);
  assert.equal(r.totales.sinPrecio, 2);
  assert.equal(r.totales.unidades, 110);       // lo no monetario no se toca
  assert.equal(r.porSemana.length, 1);
});

test('resumen ya no agrupa por familia', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] });
  assert.equal('familias' in r, false);
  assert.ok(Array.isArray(r.porSemana));
});

test('resumen tolera una carpeta vacía sin romper', () => {
  const r = H.resumen({ cargas: [], tareas: [] });
  assert.deepEqual(r.roles, []);
  assert.deepEqual(r.registros, []);
  assert.equal(r.cobertura.jornadas, 0);
  assert.equal(r.totales.cargas, 0);
});

test('una carga sin roles no aporta filas por tarea pero sí a los totales', () => {
  const cargas = [{ fecha: '2026-03-01', plu: '5', nombre: 'X',
                    cantFraccionada: 12, granelConsumido: 3 }];
  const r = H.resumen({ cargas, tareas: [] });
  assert.deepEqual(r.roles, []);
  assert.deepEqual(H.resumenPersonasPorRol(cargas), []);
  assert.equal(H.resumenProductosPorRol(cargas).length, 1);
  assert.equal(r.totales.unidades, 12);
});

test('el payload no lleva lo que el tablero ya no muestra', () => {
  const r = H.resumen({ cargas: CARGAS, tareas: [] }, {}, PRECIOS);
  for (const k of ['personasPorRol', 'personas', 'familias']) {
    assert.equal(k in r, false, `${k} sigue viajando en el payload`);
  }
  // Lo que el tablero sí usa tiene que seguir estando.
  for (const k of ['porSemana', 'registros', 'horasPorDia', 'roles', 'totales', 'tareas', 'productos']) {
    assert.ok(r[k], `falta ${k}`);
  }
});
