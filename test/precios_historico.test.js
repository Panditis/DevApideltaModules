const test = require('node:test');
const assert = require('node:assert');
const {
  validarPeriodo, primerDia, primerDiaSiguiente, diasDelMes,
  armarGrilla, slotsDelMes, hojaMatriz, anchosHoja, nombreArchivo, SLOTS_PRECIO,
} = require('../precios_historico');

const NOMBRES = new Map([['100', 'Miel 1Kg'], ['200', 'Avena 500g']]);

test('validarPeriodo rechaza lo que no sea un mes/año real', () => {
  assert.deepEqual(validarPeriodo('2026', '7'), { anio: 2026, mes: 7 });
  assert.throws(() => validarPeriodo(2026, 0), /Mes inválido/);
  assert.throws(() => validarPeriodo(2026, 13), /Mes inválido/);
  assert.throws(() => validarPeriodo(2019, 5), /Año inválido/);
  assert.throws(() => validarPeriodo("2026'; DROP TABLE", 5), /Año inválido/);
});

test('los límites del mes cierran bien en diciembre', () => {
  assert.equal(primerDia(2026, 7), '2026-07-01');
  assert.equal(primerDiaSiguiente(2026, 7), '2026-08-01');
  assert.equal(primerDiaSiguiente(2026, 12), '2027-01-01');
});

test('diasDelMes contempla febrero bisiesto y corta en hoy si el mes es el corriente', () => {
  assert.equal(diasDelMes(2024, 2).length, 29);
  assert.equal(diasDelMes(2026, 2).length, 28);
  assert.deepEqual(diasDelMes(2026, 8, '2026-08-03'), ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.equal(diasDelMes(2026, 7, '2026-08-24').length, 31);   // mes pasado: entero
});

test('el precio vigente de antes del mes se arrastra hasta el primer cambio', () => {
  const g = armarGrilla({
    anio: 2026, mes: 7, hoy: '2026-08-24',
    baseline: [{ plu: '100', precio: 1000 }],
    cambios: [{ plu: '100', dia: '2026-07-03', precio: 1200 }],
    nombres: NOMBRES,
  });
  const fila = g.filas.find(f => f.plu === '100');
  assert.equal(fila.nombre, 'Miel 1Kg');
  assert.equal(fila.precios[0], 1000);   // 01/07
  assert.equal(fila.precios[1], 1000);   // 02/07
  assert.equal(fila.precios[2], 1200);   // 03/07, día del cambio
  assert.equal(fila.precios[30], 1200);  // 31/07, sigue vigente
  assert.equal(fila.cambios, 1);
});

test('con varios cambios el mismo día vale el último: es el precio con el que cerró', () => {
  const g = armarGrilla({
    anio: 2026, mes: 7, hoy: '2026-08-24',
    baseline: [],
    cambios: [
      { plu: '200', dia: '2026-07-10', precio: 500 },
      { plu: '200', dia: '2026-07-10', precio: 560 },
    ],
    nombres: NOMBRES,
  });
  const fila = g.filas.find(f => f.plu === '200');
  assert.equal(fila.precios[8], 0);      // 09/07: sin precio asignado → 0
  assert.equal(fila.precios[9], 560);    // 10/07
  assert.equal(fila.precios[10], 560);
});

test('el día sin precio asignado sale como 0, igual que un precio 0 real', () => {
  const g = armarGrilla({
    anio: 2026, mes: 7, hoy: '2026-08-24',
    baseline: [],
    cambios: [
      { plu: '100', dia: '2026-07-02', precio: 0 },     // precio 0 cargado a mano
      { plu: '100', dia: '2026-07-03', precio: 1500 },
    ],
    nombres: NOMBRES,
  });
  const fila = g.filas.find(f => f.plu === '100');
  assert.equal(fila.precios[0], 0);      // 01/07: todavía sin precio asignado
  assert.equal(fila.precios[1], 0);      // 02/07: precio 0 real
  assert.equal(fila.precios[2], 1500);
  // Ni la grilla ni el xlsx dejan celdas vacías o nulas en el medio de la fila.
  assert.ok(fila.precios.every(p => typeof p === 'number'));
  assert.equal(hojaMatriz(g)[1][4], 0);  // E: relleno con el primer día, que es 0
});

test('un producto sin ningún precio dentro del mes no genera fila', () => {
  const g = armarGrilla({
    anio: 2026, mes: 7, hoy: '2026-08-24',
    baseline: [],
    cambios: [{ plu: '999', dia: '2026-08-05', precio: 700 }],   // fuera del mes pedido
    nombres: NOMBRES,
  });
  assert.equal(g.filas.length, 0);
});

test('los slots de precio son siempre 32 y el relleno va al principio', () => {
  // 31 días → 1 slot de relleno; 28 → 4. El relleno repite el índice del primer día.
  assert.deepEqual(slotsDelMes(new Array(31).fill(0).map((_, i) => i)).slice(0, 3), [0, 0, 1]);
  assert.equal(slotsDelMes(new Array(31).fill(0).map((_, i) => i)).length, SLOTS_PRECIO);
  const feb = slotsDelMes(new Array(28).fill(0).map((_, i) => i));
  assert.deepEqual(feb.slice(0, 6), [0, 0, 0, 0, 0, 1]);
  assert.equal(feb[feb.length - 1], 27);          // AJ = último día del mes
  assert.deepEqual(slotsDelMes([]), []);
});

test('la matriz del xlsx respeta el layout fijo A/B + C,D vacías + E..AJ', () => {
  const g = armarGrilla({
    anio: 2026, mes: 2, hoy: '2026-08-24',
    baseline: [{ plu: '100', precio: 1000 }],
    cambios: [{ plu: '100', dia: '2026-02-20', precio: 1300 }],
    nombres: NOMBRES,
  });
  const m = hojaMatriz(g);
  const ancho = 4 + SLOTS_PRECIO;                  // A,B,C,D + 32 precios = hasta AJ
  assert.equal(m.length, 2);                       // encabezado + 1 producto
  assert.equal(m[0].length, ancho);
  assert.equal(m[1].length, ancho);
  assert.deepEqual(m[0].slice(0, 4), ['PLU', 'Producto', '', '']);
  assert.equal(m[0][4], '01/02');                  // E: relleno con el primer día
  assert.equal(m[0][7], '01/02');                  // último slot de relleno (28 días → 4)
  assert.equal(m[0][8], '01/02');                  // primer día real
  assert.equal(m[0][ancho - 1], '28/02');          // AJ = último día del mes

  // Columna A numérica: el PLU sale como entero, no como texto.
  assert.deepEqual(m[1].slice(0, 4), [100, 'Miel 1Kg', '', '']);
  assert.equal(typeof m[1][0], 'number');
  assert.equal(m[1][4], 1000);                     // relleno: precio del primer día
  assert.equal(m[1][ancho - 1], 1300);             // AJ: precio del 28/02
  assert.equal(anchosHoja().length, ancho);
  assert.equal(nombreArchivo(g), 'precios_historico_2026-02.xlsx');
});

test('un PLU alfanumérico se escribe tal cual en vez de un NaN', () => {
  const g = armarGrilla({
    anio: 2026, mes: 7, hoy: '2026-08-24',
    baseline: [{ plu: 'A12', precio: 100 }],
    cambios: [],
    nombres: new Map([['A12', 'Producto raro']]),
  });
  assert.equal(hojaMatriz(g)[1][0], 'A12');
});

test('las filas salen ordenadas por nombre y el PLU sin nombre no rompe', () => {
  const g = armarGrilla({
    anio: 2026, mes: 7, hoy: '2026-08-24',
    baseline: [{ plu: '100', precio: 1 }, { plu: '200', precio: 2 }, { plu: '777', precio: 3 }],
    cambios: [],
    nombres: NOMBRES,
  });
  assert.deepEqual(g.filas.map(f => f.nombre), ['(sin nombre) 777', 'Avena 500g', 'Miel 1Kg']);
  assert.equal(g.periodo, 'Julio 2026');
});
