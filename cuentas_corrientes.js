'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Cuentas Corrientes de Clientes — módulo puro (sin I/O ni SQL exec)
//  Sanitización de params, builders de SQL y derivaciones de totales.
//
//  Reglas de negocio (fijas, definidas por el negocio):
//   • Clientes en alcance: IdCategoria IN (1,4,8,11) y distinto de APIDELTA SRL.
//   • Saldo del cliente: SUM(Saldo) de sus comprobantes, excluyendo los recibos a
//     proveedor ('RECIBOPROV') y los anulados ('ANULADO'). Ojo: IdEstadoComprobante
//     también viene vacío ('') en muchas filas y esas SÍ cuentan.
//   • Se listan sólo los clientes con saldo > 0 (deuda viva).
//   • Clientes.SaldoPendiente está en 0 para todos: no se usa, se recalcula acá.
// ─────────────────────────────────────────────────────────────────────────────

// 1=MAYORISTA, 4=CONSUMIDOR FINAL, 8=MINORISTA, 11=Desactivado (mantiene deuda histórica).
const CATEGORIAS_CTACTE = [1, 4, 8, 11];
// Comprobante de pago a proveedor: convive en la misma tabla y no es deuda del cliente.
const TIPO_EXCLUIDO = 'RECIBOPROV';
// La propia empresa se factura a sí misma: no es un deudor.
const CLIENTE_EXCLUIDO = 'APIDELTA SRL';
const ESTADO_EXCLUIDO = 'ANULADO';
// Sólo la cuenta corriente de estas sucursales entra al módulo. Es una constante de
// negocio, no un parámetro: filtra las tres consultas por igual (saldos y detalle),
// para que el detalle siempre explique el saldo que se muestra.
const SUCURSALES_CTACTE = [1, 5];

// Intersección de los ids pedidos con la whitelist. Vacío/inválido -> whitelist completa.
function catIdsSeguras(raw) {
  if (!raw) return [...CATEGORIAS_CTACTE];
  const pedidos = String(raw).split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isInteger(n));
  const filtradas = pedidos.filter(n => CATEGORIAS_CTACTE.includes(n));
  return filtradas.length ? filtradas : [...CATEGORIAS_CTACTE];
}

// Ninguna categoría fuera de la whitelist puede entrar al SQL, aun si el llamador
// arma el csv a mano: se vuelve a filtrar contra la lista canónica.
function catIdsCsv(ids) {
  const limpias = (Array.isArray(ids) ? ids : [])
    .map(n => parseInt(n, 10))
    .filter(n => CATEGORIAS_CTACTE.includes(n));
  return (limpias.length ? limpias : CATEGORIAS_CTACTE).join(',');
}

// Tope de la antigüedad de mora: 10 años. Más que eso no discrimina nada útil y
// mantiene acotado el número que termina interpolado al SQL.
const VENCIDO_DIAS_MAX = 3650;

// Antigüedad de mora pedida. Ausente, vacía o no numérica -> null (sin filtro, que
// es el comportamiento histórico). Cualquier valor válido se recorta a 0..3650.
// Es la única puerta por la que el número entra al SQL: mismo criterio que catIdsCsv.
function vencidoDiasSeguro(raw) {
  if (raw === null || raw === undefined) return null;
  const txt = String(raw).trim();
  if (txt === '') return null;
  // parseInt aceptaría "30; DROP TABLE": se exige que el texto entero sea un entero.
  if (!/^[+-]?\d+$/.test(txt)) return null;
  const n = parseInt(txt, 10);
  if (!Number.isInteger(n)) return null;
  return Math.min(Math.max(n, 0), VENCIDO_DIAS_MAX);
}

// ── SQL ──────────────────────────────────────────────────────────────────────
// Condición de mora reutilizable. Sirve en dos lugares distintos:
//  • como filtro del WHERE (comprobantes y subconsulta de clientes),
//  • como CASE dentro de los agregados de la consulta de clientes, que necesita
//    mostrar el saldo vencido y el saldo total del cliente lado a lado.
// Sin filtro activo devuelve la constante verdadera: el CASE deja pasar todo y la
// consulta queda equivalente a la de siempre.
// Se re-sanitiza acá aunque el llamador ya lo haya hecho: nada crudo llega al SQL.
// Se mide sobre la FECHA DE EMISIÓN, no sobre FechaVencimiento: SIGA graba el
// vencimiento igual a la emisión en el 94% de los comprobantes, y donde difiere no
// refleja el plazo real acordado. El plazo lo aporta el umbral (vencidoDias).
function condMora({ cc = 'cc', vencidoDias } = {}) {
  const dias = vencidoDiasSeguro(vencidoDias);
  return dias === null ? '1=1'
    : `${cc}.Fecha < DATEADD(day, -${dias}, CAST(GETDATE() AS date))`;
}

// Filtros comunes a las dos consultas. Los alias se parametrizan para poder
// reusar el mismo WHERE dentro de la subconsulta de clientes con saldo.
// vencidoDias recorta a los comprobantes vencidos hace más de X días: como este
// WHERE también lo usa subClientesConSaldo, el saldo del cliente pasa a ser el
// saldo vencido y el HAVING SUM(Saldo) > 0 filtra sobre eso.
function whereCtaCte({ csv, cc = 'cc', c = 'c', vencidoDias } = {}) {
  const cats = csv || CATEGORIAS_CTACTE.join(',');
  const dias = vencidoDiasSeguro(vencidoDias);
  const mora = dias === null ? '' : `\n      AND ${condMora({ cc, vencidoDias })}`;
  return `${c}.IdCategoria IN (${cats})
      AND UPPER(LTRIM(RTRIM(ISNULL(${c}.NombreCliente,'')))) <> '${CLIENTE_EXCLUIDO}'
      AND ISNULL(${cc}.IdTipoComprobante,'') <> '${TIPO_EXCLUIDO}'
      AND ISNULL(${cc}.IdEstadoComprobante,'') <> '${ESTADO_EXCLUIDO}'
      AND ${cc}.IdSucursal IN (${SUCURSALES_CTACTE.join(',')})${mora}`;
}

// Subconsulta con los IdCliente que tienen deuda viva. Se usa para que el listado
// de comprobantes muestre sólo los de esos clientes (incluidos los ya saldados,
// que son el contexto de cómo se llegó al saldo actual).
// El filtro de mora NO entra acá: un cliente puede deber sólo saldo sin vencer y
// tiene que aparecer igual. La mora sólo parte el saldo en columnas, no elige quién
// se lista (ver sqlClientesConSaldo).
function subClientesConSaldo(p) {
  return `SELECT cc2.IdCliente
      FROM CuentasCorrientes cc2
      INNER JOIN Clientes c2 ON c2.IdCliente = cc2.IdCliente
      WHERE ${whereCtaCte({ ...p, cc: 'cc2', c: 'c2', vencidoDias: null })}
      GROUP BY cc2.IdCliente
      HAVING SUM(cc2.Saldo) > 0`;
}

// Se listan TODOS los clientes con deuda viva (HAVING sobre el saldo total): un cliente
// que sólo debe saldo sin vencer también es deudor y tiene que aparecer.
// El filtro de mora no elige quién se lista ni va al WHERE: entra como CASE dentro de
// los agregados y sólo parte el saldo en vencido / sin vencer, que son columnas.
// Así el conjunto de clientes es siempre el mismo que devuelve subClientesConSaldo.
function sqlClientesConSaldo(p) {
  const mora = condMora(p);
  return `SELECT c.IdCliente AS IdCliente,
      LTRIM(RTRIM(ISNULL(c.NombreCliente,''))) AS NombreCliente,
      ISNULL(cat.NombreCategoria,'') AS Categoria,
      SUM(CASE WHEN ${mora} THEN cc.Saldo ELSE 0 END) AS Saldo,
      SUM(CASE WHEN NOT (${mora}) THEN cc.Saldo ELSE 0 END) AS SaldoSinVencer,
      SUM(cc.Saldo) AS SaldoTotal,
      COUNT(*) AS Comprobantes,
      MAX(cc.Fecha) AS UltimaFecha
    FROM CuentasCorrientes cc
    INNER JOIN Clientes c ON c.IdCliente = cc.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria = c.IdCategoria
    WHERE ${whereCtaCte({ ...p, vencidoDias: null })}
    GROUP BY c.IdCliente, LTRIM(RTRIM(ISNULL(c.NombreCliente,''))), ISNULL(cat.NombreCategoria,'')
    HAVING SUM(cc.Saldo) > 0
    ORDER BY SaldoTotal DESC`;
}

// Detalle de los clientes listados. Tampoco filtra por mora: si lo hiciera, un cliente
// que sólo debe saldo sin vencer aparecería en el listado con el detalle vacío.
function sqlComprobantes(p) {
  return `SELECT c.IdCliente AS IdCliente,
      LTRIM(RTRIM(ISNULL(c.NombreCliente,''))) AS NombreCliente,
      ISNULL(cat.NombreCategoria,'') AS Categoria,
      cc.IdSucursal AS IdSucursal, cc.IdTipoComprobante AS IdTipoComprobante,
      cc.Letra AS Letra, cc.CentroEmisor AS CentroEmisor,
      cc.NumeroComprobante AS NumeroComprobante,
      cc.Fecha AS Fecha, cc.FechaVencimiento AS FechaVencimiento,
      cc.ImporteTotal AS ImporteTotal, cc.Saldo AS Saldo,
      ISNULL(cc.Observacion,'') AS Observacion,
      ISNULL(cc.IdEstadoComprobante,'') AS IdEstadoComprobante
    FROM CuentasCorrientes cc
    INNER JOIN Clientes c ON c.IdCliente = cc.IdCliente
    LEFT JOIN Categorias cat ON cat.IdCategoria = c.IdCategoria
    WHERE ${whereCtaCte({ ...p, vencidoDias: null })}
      AND cc.IdCliente IN (${subClientesConSaldo(p)})
    ORDER BY NombreCliente, cc.Fecha DESC`;
}

// ── Derivaciones puras ───────────────────────────────────────────────────────
// Los totales salen del listado de clientes: cada fila ya trae su recuento de
// comprobantes, así que no hace falta recorrer el detalle completo.
function totales(clientes) {
  const filas = Array.isArray(clientes) ? clientes : [];
  return {
    clientes: filas.length,
    saldoTotal: filas.reduce((a, r) => a + Number(r.Saldo || 0), 0),
    // Saldo completo de esos mismos clientes: con el filtro de mora puesto es mayor
    // que saldoTotal, y sin filtro coincide.
    saldoTotalGeneral: filas.reduce((a, r) => a + Number(r.SaldoTotal || 0), 0),
    // Complemento del filtro: lo que NO alcanzó el umbral de mora. Sin filtro es 0,
    // porque ahí todo el saldo cae del lado "vencido".
    saldoSinVencer: filas.reduce((a, r) => a + Number(r.SaldoSinVencer || 0), 0),
    comprobantes: filas.reduce((a, r) => a + Number(r.Comprobantes || 0), 0),
  };
}

// Fechas de SIGA: vienen como Date o string. El contrato pide ISO o null.
function fechaISO(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = {
  CATEGORIAS_CTACTE, SUCURSALES_CTACTE, TIPO_EXCLUIDO, CLIENTE_EXCLUIDO, ESTADO_EXCLUIDO, VENCIDO_DIAS_MAX,
  catIdsSeguras, catIdsCsv, vencidoDiasSeguro,
  condMora, whereCtaCte, subClientesConSaldo, sqlClientesConSaldo, sqlComprobantes,
  totales, fechaISO,
};
