'use strict';
// Ventas de SIGA para el control de vencimientos (solo lectura): unidades vendidas desde la carga
// del lote y promedio mensual de los últimos 12 meses, para el producto del lote en UNA sucursal.
// Mismo criterio de "venta" que lib/analisis_ventas.js (whereVentas): Ventas + VentasProductos por
// clave de 5 columnas, sin ANULADO, ImporteTotal > 0 y sin clientes categoría SUCURSAL
// (transferencias internas). Unidades = SUM(vp.Cantidad).
const { JOIN_CLAVE5, JOIN_CLIENTE_CAT, filtroClientes } = require('./analisis_ventas');
const { esSucursalReal, sqlExcluirSucursales } = require('./sucursales_no_reales');

const TANDA = 200;

// Primer día (inclusive) de la ventana de 12 meses móviles que termina `hoy`.
function desde12Meses(hoy) {
  const [y, m, d] = hoy.split('-').map(Number);
  return new Date(Date.UTC(y - 1, m - 1, d + 1)).toISOString().slice(0, 10);
}

function fechaLocal(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// mssql devuelve DATE como Date a medianoche UTC; un string ya viene 'YYYY-MM-DD...'.
const diaDe = v => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

const productosDe = lotes => [...new Set(lotes.map(l => Number(l.idProducto)).filter(Number.isSafeInteger))];

// Filas { IdSucursal, IdProducto, Dia, Cantidad } de los últimos 12 meses de `idSucursal`, en tandas de TANDA productos.
async function consultarVentas(getPool, lotes, hoy, idSucursal) {
  const ids = productosDe(lotes);
  const suc = Number(idSucursal);
  if (!ids.length || !Number.isSafeInteger(suc) || suc <= 0 || !esSucursalReal(suc)) return [];
  const pool = await getPool();
  const filas = [];
  for (let i = 0; i < ids.length; i += TANDA) {
    const tanda = ids.slice(i, i + TANDA);
    const request = pool.request();
    request.input('desde', desde12Meses(hoy));
    request.input('hasta', new Date(Date.parse(`${hoy}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    tanda.forEach((id, j) => request.input(`prod${j}`, String(id))); // msnodesqlv8 rompe el declare con nombres pN: prefijo largo
    request.input('suc', suc);
    const r = await request.query(`SELECT vp.IdSucursal, vp.IdProducto, CAST(v.Fecha AS DATE) AS Dia, SUM(vp.Cantidad) AS Cantidad
      FROM VentasProductos vp
      ${JOIN_CLAVE5}
      ${JOIN_CLIENTE_CAT}
      WHERE v.Fecha >= @desde AND v.Fecha < @hasta
        AND ISNULL(v.IdEstadoComprobante,'') != 'ANULADO'
        AND v.ImporteTotal > 0
        AND ${filtroClientes()}
        AND v.IdSucursal = @suc
        AND ${sqlExcluirSucursales('v.IdSucursal')}
        AND LTRIM(RTRIM(CAST(vp.IdProducto AS VARCHAR(50)))) IN (${tanda.map((_, j) => `@prod${j}`).join(',')})
      GROUP BY vp.IdSucursal, vp.IdProducto, CAST(v.Fecha AS DATE)`);
    filas.push(...(r.recordset || []));
  }
  return filas;
}

// PURA. Devuelve { idLote: { vendidoDesdeCarga, promMensual12 } } para TODO lote, con las ventas de
// `idSucursal` del producto del lote (aunque esa sucursal no tenga unidades cargadas). Sin ventas: 0 y 0.
function calcularVentas(lotes, filas, hoy, idSucursal) {
  const suc = Number(idSucursal);
  const desde = desde12Meses(hoy);
  const porClave = new Map(); // idProducto → [{ dia, cant }]
  for (const f of filas) {
    const dia = diaDe(f.Dia);
    if (dia > hoy || Number(f.IdSucursal) !== suc) continue;
    const clave = Number(f.IdProducto);
    porClave.set(clave, [...(porClave.get(clave) || []), { dia, cant: Number(f.Cantidad || 0) }]);
  }
  const suma = (lista, d) => lista.filter(x => x.dia >= d).reduce((t, x) => t + x.cant, 0);
  const ventas = {};
  for (const l of lotes) {
    const carga = l.creado ? fechaLocal(l.creado) : hoy;
    const lista = porClave.get(Number(l.idProducto)) || [];
    ventas[l.id] = { vendidoDesdeCarga: suma(lista, carga), promMensual12: Math.round(suma(lista, desde) / 12 * 10) / 10 };
  }
  return ventas;
}

module.exports = { consultarVentas, calcularVentas, desde12Meses };
