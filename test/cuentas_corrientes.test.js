const test = require('node:test');
const assert = require('node:assert');
const {
  CATEGORIAS_CTACTE, SUCURSALES_CTACTE, TIPO_EXCLUIDO, CLIENTE_EXCLUIDO, ESTADO_EXCLUIDO, VENCIDO_DIAS_MAX,
  catIdsSeguras, catIdsCsv, vencidoDiasSeguro,
  condMora, whereCtaCte, subClientesConSaldo, sqlClientesConSaldo, sqlComprobantes,
  totales, fechaISO,
} = require('../cuentas_corrientes');

// ── Constantes de negocio ────────────────────────────────────────────────────
test('las constantes de negocio son las acordadas', () => {
  assert.deepStrictEqual(CATEGORIAS_CTACTE, [1, 4, 8, 11]);
  assert.strictEqual(TIPO_EXCLUIDO, 'RECIBOPROV');
  assert.strictEqual(CLIENTE_EXCLUIDO, 'APIDELTA SRL');
  assert.strictEqual(ESTADO_EXCLUIDO, 'ANULADO');
});

// ── Sanitización ─────────────────────────────────────────────────────────────
test('catIdsSeguras filtra a la whitelist e ignora categorías ajenas', () => {
  assert.deepStrictEqual(catIdsSeguras('1,4,999,2'), [1, 4]);
});

test('catIdsSeguras sin input o con basura devuelve la whitelist completa', () => {
  assert.deepStrictEqual(catIdsSeguras(undefined), [1, 4, 8, 11]);
  assert.deepStrictEqual(catIdsSeguras(''), [1, 4, 8, 11]);
  assert.deepStrictEqual(catIdsSeguras('abc'), [1, 4, 8, 11]);
  assert.deepStrictEqual(catIdsSeguras('2,3,999'), [1, 4, 8, 11]);
});

test('catIdsCsv re-filtra contra la whitelist (no confía en el llamador)', () => {
  assert.strictEqual(catIdsCsv([1, 8]), '1,8');
  assert.strictEqual(catIdsCsv([1, 99]), '1');
  assert.strictEqual(catIdsCsv([]), '1,4,8,11');
  assert.strictEqual(catIdsCsv(null), '1,4,8,11');
});

test('catIdsCsv no deja pasar inyección en el csv', () => {
  const csv = catIdsCsv(["1; DROP TABLE Clientes--", 4]);
  assert.strictEqual(csv, '1,4'); // parseInt corta el resto de la cadena
  assert.doesNotMatch(csv, /DROP/i);
});

test('el SQL generado nunca contiene texto arbitrario del usuario', () => {
  const csv = catIdsCsv(catIdsSeguras("4' OR 1=1--"));
  const s = sqlClientesConSaldo({ csv });
  assert.doesNotMatch(s, /OR 1=1/);
  assert.match(s, /IdCategoria IN \(4\)/);
});

// ── Antigüedad de mora (vencidoDias) ─────────────────────────────────────────
test('vencidoDiasSeguro sin valor o con valor vacío devuelve null (sin filtro)', () => {
  assert.strictEqual(vencidoDiasSeguro(undefined), null);
  assert.strictEqual(vencidoDiasSeguro(null), null);
  assert.strictEqual(vencidoDiasSeguro(''), null);
  assert.strictEqual(vencidoDiasSeguro('   '), null);
});

test('vencidoDiasSeguro rechaza lo que no sea un entero puro', () => {
  assert.strictEqual(vencidoDiasSeguro('abc'), null);
  assert.strictEqual(vencidoDiasSeguro('30d'), null);
  assert.strictEqual(vencidoDiasSeguro('30.5'), null);
  assert.strictEqual(vencidoDiasSeguro(NaN), null);
  assert.strictEqual(vencidoDiasSeguro({}), null);
  assert.strictEqual(vencidoDiasSeguro([1, 2]), null);
});

test('vencidoDiasSeguro acepta enteros válidos (número o string)', () => {
  assert.strictEqual(vencidoDiasSeguro(30), 30);
  assert.strictEqual(vencidoDiasSeguro('30'), 30);
  assert.strictEqual(vencidoDiasSeguro(' 90 '), 90);
  assert.strictEqual(vencidoDiasSeguro(0), 0);
  assert.strictEqual(vencidoDiasSeguro('0'), 0);
});

test('vencidoDiasSeguro hace clamp a 0..3650', () => {
  assert.strictEqual(VENCIDO_DIAS_MAX, 3650);
  assert.strictEqual(vencidoDiasSeguro(-1), 0);
  assert.strictEqual(vencidoDiasSeguro('-500'), 0);
  assert.strictEqual(vencidoDiasSeguro(3650), 3650);
  assert.strictEqual(vencidoDiasSeguro(99999), 3650);
});

test('vencidoDiasSeguro no deja pasar inyección por el parámetro', () => {
  assert.strictEqual(vencidoDiasSeguro('30; DROP TABLE CuentasCorrientes'), null);
  assert.strictEqual(vencidoDiasSeguro("0 OR 1=1--"), null);
  assert.strictEqual(vencidoDiasSeguro("1); DELETE FROM Clientes--"), null);
});

// ── WHERE común ──────────────────────────────────────────────────────────────
const P = { csv: catIdsCsv(CATEGORIAS_CTACTE) };
const PV = { ...P, vencidoDias: 30 };

test('whereCtaCte agrega el DATEADD sólo cuando hay vencidoDias', () => {
  assert.doesNotMatch(whereCtaCte(P), /DATEADD/);
  assert.doesNotMatch(whereCtaCte({ ...P, vencidoDias: null }), /DATEADD/);
  assert.doesNotMatch(whereCtaCte({ ...P, vencidoDias: '' }), /DATEADD/);
  assert.doesNotMatch(whereCtaCte({ ...P, vencidoDias: 'abc' }), /DATEADD/);
  assert.match(whereCtaCte(PV),
    /AND cc.Fecha < DATEADD\(day, -30, CAST\(GETDATE\(\) AS date\)\)/);
});

test('whereCtaCte acepta vencidoDias = 0 (todo lo ya vencido)', () => {
  assert.match(whereCtaCte({ ...P, vencidoDias: 0 }),
    /Fecha < DATEADD\(day, -0, CAST\(GETDATE\(\) AS date\)\)/);
});

test('whereCtaCte usa el alias de comprobantes también en el filtro de mora', () => {
  const w = whereCtaCte({ ...PV, cc: 'cc2', c: 'c2' });
  assert.match(w, /cc2.Fecha < DATEADD/);
  assert.doesNotMatch(w, /\bcc\./);
});

test('whereCtaCte re-sanitiza vencidoDias aunque el llamador mande basura', () => {
  assert.doesNotMatch(whereCtaCte({ ...P, vencidoDias: '30; DROP TABLE Clientes--' }), /DROP|DATEADD/i);
  assert.match(whereCtaCte({ ...P, vencidoDias: 99999 }), /DATEADD\(day, -3650,/);
  assert.match(whereCtaCte({ ...P, vencidoDias: -5 }), /DATEADD\(day, -0,/);
});

test('el filtro de mora sólo parte el saldo en columnas: no elige qué clientes ni qué comprobantes se listan', () => {
  // En clientes entra únicamente como CASE dentro de los agregados.
  assert.match(sqlClientesConSaldo(PV), /cc.Fecha < DATEADD\(day, -30,/);
  // La selección de quién debe plata y el detalle no lo miran: un cliente que sólo
  // debe saldo sin vencer tiene que aparecer, y con su detalle completo.
  assert.doesNotMatch(subClientesConSaldo(PV), /DATEADD/);
  assert.doesNotMatch(sqlComprobantes(PV), /DATEADD/);
});

test('sin vencidoDias ninguna consulta menciona el DATEADD de mora', () => {
  [sqlClientesConSaldo(P), subClientesConSaldo(P), sqlComprobantes(P)]
    .forEach(s => assert.doesNotMatch(s, /DATEADD/));
});

test('el SQL nunca lleva el vencidoDias crudo del usuario', () => {
  const s = sqlComprobantes({ ...P, vencidoDias: '30; DROP TABLE CuentasCorrientes--' });
  assert.doesNotMatch(s, /DROP/i);
  assert.doesNotMatch(s, /DATEADD/);
});

test('whereCtaCte aplica los cuatro filtros obligatorios', () => {
  const w = whereCtaCte(P);
  assert.match(w, /c\.IdCategoria IN \(1,4,8,11\)/);
  assert.match(w, /<> 'APIDELTA SRL'/);
  assert.match(w, /ISNULL\(cc\.IdTipoComprobante,''\) <> 'RECIBOPROV'/);
  assert.match(w, /ISNULL\(cc\.IdEstadoComprobante,''\) <> 'ANULADO'/);
});

test('whereCtaCte acota a las sucursales 1 y 5 en las tres consultas', () => {
  assert.deepStrictEqual(SUCURSALES_CTACTE, [1, 5]);
  assert.match(whereCtaCte(P), /AND cc\.IdSucursal IN \(1,5\)/);
  assert.match(whereCtaCte({ ...P, cc: 'cc2' }), /AND cc2\.IdSucursal IN \(1,5\)/);
  [sqlClientesConSaldo(P), subClientesConSaldo(P)].forEach(s =>
    assert.match(s, /IdSucursal IN \(1,5\)/));
  // El detalle lo lleva dos veces: en el WHERE externo y en la subconsulta de clientes.
  assert.strictEqual((sqlComprobantes(P).match(/IdSucursal IN \(1,5\)/g) || []).length, 2);
});

test('el filtro de sucursales no depende de parámetros del request', () => {
  // Es constante de negocio: no hay forma de ampliarlo desde la query string.
  const s = sqlClientesConSaldo({ ...P, sucursales: '1,2,3', IdSucursal: 2 });
  assert.match(s, /IdSucursal IN \(1,5\)/);
  assert.doesNotMatch(s, /IdSucursal IN \(1,2,3\)/);
});

test('whereCtaCte sin csv cae a la whitelist completa', () => {
  assert.match(whereCtaCte(), /IdCategoria IN \(1,4,8,11\)/);
  assert.match(whereCtaCte({}), /IdCategoria IN \(1,4,8,11\)/);
});

test('whereCtaCte excluye ANULADO pero no el estado vacío', () => {
  const w = whereCtaCte(P);
  // El estado vacío ('') sí cuenta: sólo puede haber una desigualdad contra ANULADO.
  assert.doesNotMatch(w, /IdEstadoComprobante[^\n]*= *'NORMAL'/);
  assert.doesNotMatch(w, /IdEstadoComprobante,''\) <> ''/);
});

test('whereCtaCte permite reasignar los alias de las tablas', () => {
  const w = whereCtaCte({ ...P, cc: 'cc2', c: 'c2' });
  assert.match(w, /c2\.IdCategoria IN/);
  assert.match(w, /cc2\.IdTipoComprobante/);
  assert.doesNotMatch(w, /\bcc\./);
});

// ── Builders de SQL ──────────────────────────────────────────────────────────
test('sqlClientesConSaldo agrupa por cliente y deja sólo saldo > 0', () => {
  const s = sqlClientesConSaldo(P);
  assert.match(s, /FROM CuentasCorrientes cc/);
  assert.match(s, /INNER JOIN Clientes c ON c\.IdCliente = cc\.IdCliente/);
  assert.match(s, /LEFT JOIN Categorias cat ON cat\.IdCategoria = c\.IdCategoria/);
  assert.match(s, /SUM\(CASE WHEN 1=1 THEN cc\.Saldo ELSE 0 END\) AS Saldo/);
  assert.match(s, /SUM\(cc\.Saldo\) AS SaldoTotal/);
  assert.match(s, /COUNT\(\*\) AS Comprobantes/);
  assert.match(s, /MAX\(cc\.Fecha\) AS UltimaFecha/);
  assert.match(s, /HAVING SUM\(cc\.Saldo\) > 0/);
  assert.match(s, /ORDER BY SaldoTotal DESC/);
});

// ── Saldo total del cliente junto al saldo mostrado ──────────────────────────
test('condMora sin filtro es la constante verdadera', () => {
  assert.strictEqual(condMora(), '1=1');
  assert.strictEqual(condMora({}), '1=1');
  assert.strictEqual(condMora({ vencidoDias: null }), '1=1');
  assert.strictEqual(condMora({ vencidoDias: '' }), '1=1');
  assert.strictEqual(condMora({ vencidoDias: 'abc' }), '1=1');
});

test('condMora con filtro compara la fecha de emision y respeta el alias', () => {
  assert.strictEqual(condMora({ vencidoDias: 30 }),
    'cc.Fecha < DATEADD(day, -30, CAST(GETDATE() AS date))');
  assert.strictEqual(condMora({ cc: 'cc2', vencidoDias: 30 }),
    'cc2.Fecha < DATEADD(day, -30, CAST(GETDATE() AS date))');
});

test('condMora re-sanitiza y no deja inyectar por el parámetro', () => {
  assert.strictEqual(condMora({ vencidoDias: '30; DROP TABLE Clientes--' }), '1=1');
  assert.strictEqual(condMora({ vencidoDias: "0 OR 1=1--" }), '1=1');
  assert.match(condMora({ vencidoDias: 99999 }), /DATEADD\(day, -3650,/);
  assert.match(condMora({ vencidoDias: -5 }), /DATEADD\(day, -0,/);
});

test('sqlClientesConSaldo con mora mueve el filtro del WHERE a los CASE', () => {
  const s = sqlClientesConSaldo(PV);
  const cond = 'cc\\.Fecha < DATEADD\\(day, -30, CAST\\(GETDATE\\(\\) AS date\\)\\)';
  assert.match(s, new RegExp(`SUM\\(CASE WHEN ${cond} THEN cc\\.Saldo ELSE 0 END\\) AS Saldo`));
  assert.match(s, new RegExp(`SUM\\(CASE WHEN NOT \\(${cond}\\) THEN cc\\.Saldo ELSE 0 END\\) AS SaldoSinVencer`));
  // El saldo total del cliente es incondicional: es justamente lo que se pierde de vista.
  assert.match(s, /SUM\(cc\.Saldo\) AS SaldoTotal/);
  // Recuento y última fecha son de TODO el detalle: la mora no recorta el detalle.
  assert.match(s, /COUNT\(\*\) AS Comprobantes/);
  assert.match(s, /MAX\(cc\.Fecha\) AS UltimaFecha/);
  // Y el WHERE ya no filtra por mora: si lo hiciera, SaldoTotal sería el saldo vencido.
  assert.doesNotMatch(s, /AND cc.Fecha < DATEADD/);
});

test('sqlClientesConSaldo mantiene el resto de los filtros en el WHERE con mora activa', () => {
  const s = sqlClientesConSaldo(PV);
  assert.match(s, /WHERE c\.IdCategoria IN \(1,4,8,11\)/);
  assert.match(s, /<> 'APIDELTA SRL'/);
  assert.match(s, /<> 'RECIBOPROV'/);
  assert.match(s, /<> 'ANULADO'/);
});

test('el HAVING de clientes filtra por el saldo TOTAL, igual que subClientesConSaldo', () => {
  // Las dos consultas seleccionan por deuda viva total y ninguna mira la mora, así que
  // devuelven el mismo conjunto de clientes tanto con filtro como sin él.
  [P, PV].forEach(p => {
    assert.match(sqlClientesConSaldo(p), /HAVING SUM\(cc\.Saldo\) > 0/);
    assert.match(subClientesConSaldo(p), /HAVING SUM\(cc2\.Saldo\) > 0/);
    assert.doesNotMatch(subClientesConSaldo(p), /DATEADD/);
  });
});

test('un cliente con saldo sólo sin vencer sigue en el listado', () => {
  // Regresión: el HAVING sobre el saldo vencido lo dejaba afuera. Ahora la mora no
  // aparece en el HAVING, así que saldo vencido 0 y total > 0 sigue calificando.
  const s = sqlClientesConSaldo(PV);
  assert.doesNotMatch(s, /HAVING SUM\(CASE/);
});

test('sqlClientesConSaldo nunca lleva el vencidoDias crudo del usuario a los CASE', () => {
  const s = sqlClientesConSaldo({ ...P, vencidoDias: "30'; DROP TABLE CuentasCorrientes--" });
  assert.doesNotMatch(s, /DROP/i);
  assert.doesNotMatch(s, /DATEADD/);
  assert.match(s, /SUM\(CASE WHEN 1=1 THEN cc\.Saldo ELSE 0 END\) AS Saldo/);
});

test('sqlClientesConSaldo arrastra los filtros de negocio', () => {
  const s = sqlClientesConSaldo(P);
  assert.match(s, /IdCategoria IN \(1,4,8,11\)/);
  assert.match(s, /<> 'APIDELTA SRL'/);
  assert.match(s, /<> 'RECIBOPROV'/);
  assert.match(s, /<> 'ANULADO'/);
});

test('sqlClientesConSaldo no usa Clientes.SaldoPendiente (está en 0 en toda la base)', () => {
  assert.doesNotMatch(sqlClientesConSaldo(P), /SaldoPendiente/);
});

test('subClientesConSaldo usa alias propios para poder anidarse', () => {
  const s = subClientesConSaldo(P);
  assert.match(s, /FROM CuentasCorrientes cc2/);
  assert.match(s, /GROUP BY cc2\.IdCliente/);
  assert.match(s, /HAVING SUM\(cc2\.Saldo\) > 0/);
});

test('sqlComprobantes trae el detalle sólo de los clientes con deuda viva', () => {
  const s = sqlComprobantes(P);
  assert.match(s, /AND cc\.IdCliente IN \(SELECT cc2\.IdCliente/);
  assert.match(s, /HAVING SUM\(cc2\.Saldo\) > 0/);
});

test('sqlComprobantes proyecta todas las columnas del contrato', () => {
  const s = sqlComprobantes(P);
  ['IdCliente', 'NombreCliente', 'Categoria', 'IdSucursal', 'IdTipoComprobante',
   'Letra', 'CentroEmisor', 'NumeroComprobante', 'Fecha', 'FechaVencimiento',
   'ImporteTotal', 'Saldo', 'Observacion', 'IdEstadoComprobante']
    .forEach(col => assert.match(s, new RegExp(`AS ${col}\\b`), `falta ${col}`));
});

test('sqlComprobantes ordena por cliente y fecha descendente', () => {
  assert.match(sqlComprobantes(P), /ORDER BY NombreCliente, cc\.Fecha DESC$/);
});

test('sqlComprobantes arrastra los filtros de negocio y no filtra por saldo de la fila', () => {
  const s = sqlComprobantes(P);
  assert.match(s, /IdCategoria IN \(1,4,8,11\)/);
  assert.match(s, /<> 'APIDELTA SRL'/);
  assert.match(s, /<> 'RECIBOPROV'/);
  assert.match(s, /<> 'ANULADO'/);
  // El detalle incluye comprobantes saldados: no hay filtro cc.Saldo > 0 a nivel fila.
  assert.doesNotMatch(s, /AND cc\.Saldo > 0/);
});

// ── Derivaciones puras ───────────────────────────────────────────────────────
test('totales suma saldo y comprobantes del listado de clientes', () => {
  const clientes = [
    { IdCliente: 1, Saldo: 1000.5, SaldoSinVencer: 0, SaldoTotal: 1000.5, Comprobantes: 3 },
    { IdCliente: 2, Saldo: 500, SaldoSinVencer: 0, SaldoTotal: 500, Comprobantes: 7 },
  ];
  assert.deepStrictEqual(totales(clientes),
    { clientes: 2, saldoTotal: 1500.5, saldoTotalGeneral: 1500.5, saldoSinVencer: 0, comprobantes: 10 });
});

test('totales suma el saldo total aparte del saldo mostrado', () => {
  // Con el filtro de mora puesto, SaldoTotal es mayor que el saldo vencido mostrado.
  const clientes = [
    { IdCliente: 1, Saldo: 100, SaldoTotal: 400, Comprobantes: 1 },
    { IdCliente: 2, Saldo: 50.25, SaldoTotal: 75.75, Comprobantes: 2 },
  ];
  const t = totales(clientes);
  assert.strictEqual(t.saldoTotal, 150.25);
  assert.strictEqual(t.saldoTotalGeneral, 475.75);
  assert.ok(t.saldoTotalGeneral > t.saldoTotal);
});

// ── Saldo sin vencer: complemento del filtro de mora ─────────────────────────
test('sqlClientesConSaldo parte el saldo en vencido y sin vencer con el mismo umbral', () => {
  const s = sqlClientesConSaldo({ vencidoDias: 30 });
  const cond = /cc.Fecha < DATEADD\(day, -30, CAST\(GETDATE\(\) AS date\)\)/;
  assert.match(s, new RegExp(`SUM\\(CASE WHEN ${cond.source} THEN cc\\.Saldo ELSE 0 END\\) AS Saldo`));
  assert.match(s, new RegExp(`SUM\\(CASE WHEN NOT \\(${cond.source}\\) THEN cc\\.Saldo ELSE 0 END\\) AS SaldoSinVencer`));
  // El total sigue siendo la suma cruda: vencido + sin vencer tiene que dar el total.
  assert.match(s, /SUM\(cc\.Saldo\) AS SaldoTotal/);
});

test('sin filtro de mora el saldo sin vencer es cero: todo cae del lado vencido', () => {
  const s = sqlClientesConSaldo({});
  assert.match(s, /SUM\(CASE WHEN 1=1 THEN cc\.Saldo ELSE 0 END\) AS Saldo/);
  assert.match(s, /SUM\(CASE WHEN NOT \(1=1\) THEN cc\.Saldo ELSE 0 END\) AS SaldoSinVencer/);
});

test('totales suma saldoSinVencer y respeta vencido + sin vencer = total', () => {
  const clientes = [
    { IdCliente: 1, Saldo: 100, SaldoSinVencer: 300, SaldoTotal: 400, Comprobantes: 1 },
    { IdCliente: 2, Saldo: 50.25, SaldoSinVencer: 25.5, SaldoTotal: 75.75, Comprobantes: 2 },
  ];
  const t = totales(clientes);
  assert.strictEqual(t.saldoSinVencer, 325.5);
  assert.strictEqual(t.saldoTotal + t.saldoSinVencer, t.saldoTotalGeneral);
});

test('totales tolera entrada vacía, nula o con campos faltantes', () => {
  const cero = { clientes: 0, saldoTotal: 0, saldoTotalGeneral: 0, saldoSinVencer: 0, comprobantes: 0 };
  assert.deepStrictEqual(totales([]), cero);
  assert.deepStrictEqual(totales(null), cero);
  assert.deepStrictEqual(totales(undefined), cero);
  assert.deepStrictEqual(totales([{ IdCliente: 9 }]),
    { clientes: 1, saldoTotal: 0, saldoTotalGeneral: 0, saldoSinVencer: 0, comprobantes: 0 });
  // Si falta sólo SaldoTotal, el saldo mostrado se sigue sumando bien.
  assert.deepStrictEqual(totales([{ IdCliente: 9, Saldo: 10, Comprobantes: 1 }]),
    { clientes: 1, saldoTotal: 10, saldoTotalGeneral: 0, saldoSinVencer: 0, comprobantes: 1 });
});

test('totales convierte SaldoTotal que llega como string del driver', () => {
  assert.strictEqual(totales([{ Saldo: '10', SaldoTotal: '99.50' }]).saldoTotalGeneral, 99.5);
});

test('totales convierte saldos que llegan como string del driver', () => {
  assert.strictEqual(totales([{ Saldo: '250.25', Comprobantes: '2' }]).saldoTotal, 250.25);
  assert.strictEqual(totales([{ Saldo: '250.25', Comprobantes: '2' }]).comprobantes, 2);
});

test('fechaISO normaliza Date y string, y devuelve null si no hay fecha', () => {
  assert.strictEqual(fechaISO(new Date('2026-07-20T17:36:01.000Z')), '2026-07-20T17:36:01.000Z');
  assert.strictEqual(fechaISO('2026-07-20T17:36:01.000Z'), '2026-07-20T17:36:01.000Z');
  assert.strictEqual(fechaISO(null), null);
  assert.strictEqual(fechaISO(undefined), null);
  assert.strictEqual(fechaISO(''), null);
  assert.strictEqual(fechaISO('no-es-fecha'), null);
});
