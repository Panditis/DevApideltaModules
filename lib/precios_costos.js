'use strict';
// Módulo puro de la tab Costos de Precios (sin fs ni ejecución de SQL): departamentos imputados a cada tipo
// de producto, venta base mensual y gastos sobre venta POR TIPO. Spec: docs/superpowers/specs/2026-10-02-precios-tab-costos-design.md
//
// gastos%_T = variables% + Σ_d (costoMensual_d × imputacion_d,T / 100) ÷ ventaMensual_T × 100
// Con departamentos vacíos gastos%_T = variables% (totalGastosVenta) para los tres tipos: precios idénticos a antes.
const { totalGastosVenta, asignarIds, ID_GASTO, redondear2 } = require('./precios_costeo');
const { whereVentas, JOIN_CLAVE5, JOIN_CLIENTE_CAT, SUCURSAL_CENTRAL, SUCURSALES_ANALISIS } = require('./analisis_ventas');

const TIPOS_COSTO = ['almacen', 'fraccionado', 'produccion'];
const NOMBRE_TIPO = { almacen: 'Reventa', fraccionado: 'Fraccionado', produccion: 'Producción' };
const DEPTOS_MAX = 40;
const NOMBRE_MAX = 60;
const MONTO_MAX = 1e12;
const MESES_DEFAULT = 3;
const MESES_RANGO = [1, 24];
const DIAS_POR_MES = 30;
const redondear4 = n => Math.round(n * 1e4) / 1e4;
const esNumero = v => typeof v === 'number' && Number.isFinite(v);
const esObjeto = v => v != null && typeof v === 'object' && !Array.isArray(v);
const porTipo = fn => Object.fromEntries(TIPOS_COSTO.map(t => [t, fn(t)]));

// ── Departamentos ────────────────────────────────────────────────────────────

function validarDepartamento(it, i) {
  if (!esObjeto(it)) throw new Error(`items[${i}]: ítem inválido`);
  const nombre = typeof it.nombre === 'string' ? it.nombre.trim() : '';
  if (!nombre || nombre.length > NOMBRE_MAX) throw new Error(`items[${i}].nombre: texto de 1 a ${NOMBRE_MAX} caracteres`);
  if (!esNumero(it.costoMensual) || it.costoMensual < 0 || it.costoMensual > MONTO_MAX) {
    throw new Error(`items[${i}].costoMensual: debe ser un número entre 0 y ${MONTO_MAX}`);
  }
  if (it.imputacion != null && !esObjeto(it.imputacion)) throw new Error(`items[${i}].imputacion: debe ser { almacen, fraccionado, produccion }`);
  const imp = it.imputacion || {};
  const imputacion = porTipo(t => {
    const v = imp[t] == null ? 0 : imp[t];
    if (!esNumero(v) || v < 0 || v > 100) throw new Error(`items[${i}].imputacion.${t}: debe ser un número entre 0 y 100`);
    return v;
  });
  // ponytail: tolerancia de punto flotante para sumas tipo 33.33 + 33.33 + 33.34.
  if (Object.values(imputacion).reduce((s, v) => s + v, 0) > 100 + 1e-9) {
    throw new Error(`items[${i}].imputacion: la suma de los % no puede superar 100`);
  }
  if (it.id != null && (typeof it.id !== 'string' || !ID_GASTO.test(it.id))) {
    throw new Error(`items[${i}].id: minúsculas, números y guiones (1 a 40)`);
  }
  return { id: it.id == null ? null : it.id, nombre, costoMensual: it.costoMensual, imputacion };
}

// Body de PUT /api/precios/config/departamentos (items) → [{ id, nombre, costoMensual, imputacion }].
// Sin id se genera el slug del nombre (único), como en gastos sobre venta.
function validarDepartamentos(items) {
  if (!Array.isArray(items)) throw new Error('items: debe ser una lista');
  if (items.length > DEPTOS_MAX) throw new Error(`items: máximo ${DEPTOS_MAX} departamentos`);
  return asignarIds(items.map(validarDepartamento), d => d.nombre);
}

const costoImputado = (departamentos, tipo) => redondear2((Array.isArray(departamentos) ? departamentos : [])
  .reduce((s, d) => s + (Number(d && d.costoMensual) || 0) * (Number(((d && d.imputacion) || {})[tipo]) || 0) / 100, 0));

// ── Venta base ───────────────────────────────────────────────────────────────

// Body ventaBase de PUT departamentos: { meses, manual } → limpio. El snapshot no viene del body
// (sólo lo escribe POST venta-base/actualizar).
function validarVentaBase(vb) {
  const b = esObjeto(vb) ? vb : {};
  const meses = b.meses == null ? MESES_DEFAULT : b.meses;
  const [min, max] = MESES_RANGO;
  if (!Number.isInteger(meses) || meses < min || meses > max) throw new Error(`ventaBase.meses: entero de ${min} a ${max}`);
  if (b.manual != null && !esObjeto(b.manual)) throw new Error('ventaBase.manual: debe ser { almacen, fraccionado, produccion }');
  const m = b.manual || {};
  const manual = porTipo(t => {
    const v = m[t];
    if (v == null) return null;
    if (!esNumero(v) || v <= 0 || v > MONTO_MAX) throw new Error(`ventaBase.manual.${t}: número mayor a 0 (hasta ${MONTO_MAX}) o null`);
    return v;
  });
  return { meses, manual };
}

function ventaBaseConDefault(vb) {
  const b = esObjeto(vb) ? vb : {};
  const manual = esObjeto(b.manual) ? b.manual : {};
  return {
    meses: Number.isInteger(b.meses) ? b.meses : MESES_DEFAULT,
    manual: porTipo(t => (manual[t] == null ? null : manual[t])),
    snapshot: esObjeto(b.snapshot) ? b.snapshot : null,
  };
}

// manual ?? snapshot ?? null; un valor ≤ 0 o no numérico cuenta como faltante.
function ventaEfectiva(ventaBase, tipo) {
  const vb = ventaBaseConDefault(ventaBase);
  const positivo = v => (esNumero(v) && v > 0 ? v : null);
  return positivo(vb.manual[tipo]) ?? positivo(((vb.snapshot || {}).porTipo || {})[tipo]);
}

// ── Gastos por tipo ──────────────────────────────────────────────────────────

// % de departamentos sobre la venta del tipo: 0 sin costo imputado; null si hay costo y no hay venta.
function departamentosPct(cfg, tipo) {
  const costo = costoImputado(cfg.departamentos, tipo);
  if (costo === 0) return 0;
  const venta = ventaEfectiva(cfg.ventaBase, tipo);
  return venta == null ? null : redondear4(costo / venta * 100);
}

// Gastos sobre venta del tipo, o null si falta la venta base (markupDesdeGanancia(…, null) → null).
function gastosVentaPctTipo(config, tipo) {
  const cfg = config || {};
  const variables = totalGastosVenta(cfg.gastosVenta);
  const deptos = departamentosPct(cfg, tipo);
  if (deptos == null) return null;
  return deptos === 0 ? variables : redondear4(variables + deptos);
}

const gastosPorTipo = cfg => porTipo(t => gastosVentaPctTipo(cfg, t));

// Partes de los gastos del tipo para el desglose del precio: { variablesPct, departamentosPct } (deptos null =
// falta venta base). Suman gastosVentaPctTipo.
function gastosDesglosePct(config, tipo) {
  const cfg = config || {};
  return { variablesPct: totalGastosVenta(cfg.gastosVenta), departamentosPct: departamentosPct(cfg, tipo) };
}

function estructuraCostos(config) {
  const cfg = config || {};
  const variablesPct = totalGastosVenta(cfg.gastosVenta);
  const deptos = Array.isArray(cfg.departamentos) ? cfg.departamentos : [];
  return {
    porTipo: porTipo(t => ({
      variablesPct, departamentosPct: departamentosPct(cfg, t), totalPct: gastosVentaPctTipo(cfg, t),
      ventaMensual: ventaEfectiva(cfg.ventaBase, t), costoImputado: costoImputado(deptos, t),
    })),
    departamentos: deptos.map(d => {
      const imputadoPct = redondear4(TIPOS_COSTO.reduce((s, t) => s + (Number((d.imputacion || {})[t]) || 0), 0));
      return { id: d.id, nombre: d.nombre, costoMensual: d.costoMensual, imputadoPct,
        costoNoAbsorbido: redondear2((Number(d.costoMensual) || 0) * (100 - imputadoPct) / 100) };
    }),
  };
}

// Antes de guardar variables/departamentos/venta base: un tipo con costo imputado necesita venta, y
// el total de gastos de cada tipo tiene que quedar bajo 100 %.
function validarEstructuraCostos(config) {
  const cfg = config || {};
  for (const t of TIPOS_COSTO) {
    const total = gastosVentaPctTipo(cfg, t);
    if (total == null) {
      throw new Error(`${NOMBRE_TIPO[t]}: hay costo de departamentos imputado pero no hay venta mensual (actualizá desde SIGA o cargala a mano)`);
    }
    if (total >= 100) throw new Error(`${NOMBRE_TIPO[t]}: el total de gastos sobre venta (${total} %) debe ser menor a 100 %`);
  }
}

// ── Venta base desde SIGA ────────────────────────────────────────────────────

const fechaISO = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// meses × 30 días que terminan ayer (ambos extremos inclusive), en fecha local.
function rangoVentaBase(meses, hoy = new Date()) {
  const hasta = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 1);
  const desde = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate() - (meses * DIAS_POR_MES - 1));
  return { desde: fechaISO(desde), hasta: fechaISO(hasta) };
}

// Filas [{ Tipo, Importe }] de sqlVentaPorTipo → snapshot con la venta mensual promedio por tipo.
function snapshotVentaBase(rows, meses, fecha) {
  const total = new Map((rows || []).map(r => [String(r.Tipo), Number(r.Importe) || 0]));
  return { fecha, meses, porTipo: porTipo(t => redondear2((total.get(t) || 0) / meses)) };
}

// Rubros SIGA de cada tipo (constantes, nunca input). Producción = PLUs de las presentaciones del
// módulo (recetas_produccion.json), con prioridad: un PLU de producción no cuenta en su rubro.
const RUBROS_TIPO = {
  almacen: ['Almacen', 'Almacen Bultos/Cajas'],
  fraccionado: ['Pesables Fraccionado', 'Pesables Venta Directa'],
};
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const PLU = /^\d{1,12}$/;

// Importe NETO de impuestos por renglón (VentasProductos.ImporteTotalNeto: neto final, ya con el descuento/
// recargo, sin ImporteImpuesto/ImpuestoInterno — ver exprImporteRenglon en lib/analisis_ventas), porque los
// gastos se aplican sobre el precio neto. Mismos filtros de comprobante que el análisis de ventas (whereVentas:
// no anulados, ImporteTotal > 0, sin transferencias a sucursales), en casa central + sucursales.
function sqlVentaPorTipo({ desde, hasta, plusProduccion }) {
  if (!FECHA.test(String(desde)) || !FECHA.test(String(hasta))) throw new Error('sqlVentaPorTipo: fecha inválida');
  const plus = [...new Set((plusProduccion || []).map(String).filter(p => PLU.test(p)))];
  const esProduccion = plus.length ? `vp.IdProducto IN (${plus.map(p => `'${p}'`).join(',')})` : '1 = 0';
  const lista = rubros => rubros.map(r => `'${r}'`).join(', ');
  const sucIdsCsv = [SUCURSAL_CENTRAL, ...SUCURSALES_ANALISIS].join(',');
  return `SELECT t.Tipo, SUM(t.Importe) AS Importe FROM (
    SELECT CASE WHEN ${esProduccion} THEN 'produccion'
        WHEN r.NombreRubro IN (${lista(RUBROS_TIPO.almacen)}) THEN 'almacen'
        WHEN r.NombreRubro IN (${lista(RUBROS_TIPO.fraccionado)}) THEN 'fraccionado' END AS Tipo,
      vp.ImporteTotalNeto AS Importe
    FROM VentasProductos vp
    ${JOIN_CLAVE5}
    ${JOIN_CLIENTE_CAT}
    INNER JOIN Productos p ON p.IdProducto = vp.IdProducto
    LEFT JOIN Rubros r ON r.IdRubro = p.IdRubro
    WHERE ${whereVentas({ desde, hasta, sucIdsCsv })}
  ) t
  WHERE t.Tipo IS NOT NULL
  GROUP BY t.Tipo`;
}

module.exports = {
  TIPOS_COSTO, validarDepartamentos, validarVentaBase, ventaBaseConDefault, ventaEfectiva, costoImputado,
  gastosVentaPctTipo, gastosPorTipo, gastosDesglosePct, estructuraCostos, validarEstructuraCostos,
  rangoVentaBase, snapshotVentaBase, sqlVentaPorTipo,
};
