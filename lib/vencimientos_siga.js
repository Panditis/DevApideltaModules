// Control de vencimientos, Etapa 2: cruce de SOLO LECTURA contra los movimientos de SIGA
// 'PARA OFERTA' (sale a oferta) y 'VENCIDO' (lo no vendido), ambos al depósito configurado.
//
// Signo: en SIGA MovimientosStockProductos.Cantidad ya viene firmada (ver lib/analisis_ventas.js,
// sqlNetoDiarioStock); estos tipos son salidas, así que se esperan negativas. No se multiplica por
// TiposMovimientos.CoeficienteStock (duplicaba el signo en analisis_ventas). Para no depender de
// cuál de los dos lleva el signo, el cruce usa ABS(SUM(Cantidad)) por (sucursal, producto, tipo):
// da lo mismo si Cantidad viene negativa o positiva con el signo puesto por el coeficiente.
const { esSucursalReal, sqlExcluirSucursales } = require('./sucursales_no_reales');
const { diasParaVencer } = require('./vencimientos');

const MS_POR_DIA = 24 * 60 * 60 * 1000;

function normalizarTipo(tipo) {
  return String(tipo ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function sumarDias(fecha, dias) {
  return new Date(Date.parse(`${fecha}T00:00:00Z`) + dias * MS_POR_DIA).toISOString().slice(0, 10);
}

// Ventana: desde el alta más antigua (menos el margen, por si el movimiento se hizo antes de cargar
// el lote) hasta hoy + margen. Solo productos con lote y sucursales reales; tipo + depósito + sucursal.
async function consultarMovimientos(getPool, lotes, config, hoy) {
  const ids = [...new Set(lotes.map(l => Number(l.idProducto)).filter(Number.isSafeInteger))];
  if (!ids.length) return [];
  const altas = lotes.map(l => String(l.creado || hoy).slice(0, 10)).sort();
  const request = (await getPool()).request();
  request.input('desde', sumarDias(altas[0], -config.margenDias));
  request.input('hasta', sumarDias(hoy, config.margenDias + 1));
  request.input('deposito', config.depositoMovimientos);
  // IdProducto puede ser char en SIGA: ids como texto y la columna trimeada, sin convertirla a int
  // (una fila no numérica rompería toda la consulta). cruzarLote vuelve a Number (tolera '123 ').
  ids.forEach((id, i) => request.input(`p${i}`, String(id)));
  // Filtro en SQL sin espacios ni mayúsculas (tolera cualquier cantidad de espacios); se trae el tipo
  // crudo y cruzarLote normaliza exacto en JS (descarta p. ej. 'PARAOFERTA').
  const tipoSql = "UPPER(REPLACE(m.IdTipoMovimiento, ' ', ''))";
  request.input('tipoOfertaSql', normalizarTipo(config.tipoOferta).replace(/ /g, ''));
  request.input('tipoNoVendidoSql', normalizarTipo(config.tipoNoVendido).replace(/ /g, ''));
  const r = await request.query(`SELECT m.IdSucursal, mp.IdProducto, m.IdTipoMovimiento AS Tipo, mp.IdDeposito, SUM(mp.Cantidad) AS Cantidad
    FROM MovimientosStock m
    INNER JOIN MovimientosStockProductos mp ON mp.IdSucursal = m.IdSucursal
      AND mp.IdTipoMovimiento = m.IdTipoMovimiento AND mp.NumeroMovimiento = m.NumeroMovimiento
    WHERE m.FechaMovimiento >= @desde AND m.FechaMovimiento < @hasta
      AND ${tipoSql} IN (@tipoOfertaSql, @tipoNoVendidoSql)
      AND mp.IdDeposito = @deposito
      AND ${sqlExcluirSucursales('m.IdSucursal')}
      AND LTRIM(RTRIM(CAST(mp.IdProducto AS VARCHAR(50)))) IN (${ids.map((_, i) => `@p${i}`).join(',')})
    GROUP BY m.IdSucursal, mp.IdProducto, m.IdTipoMovimiento, mp.IdDeposito`);
  return r.recordset || [];
}

// Reparte `total` entre lotes ordenados por vencimiento (más cercano primero), con tope por lote;
// el sobrante queda en el último para que aparezca como diferencia.
function repartir(total, topes) {
  let resto = total;
  return topes.map((tope, i) => {
    const parte = i === topes.length - 1 ? resto : Math.min(resto, tope);
    resto -= parte;
    return parte;
  });
}

function resultado(lote, suc, col, oferta, vencido, config, hoy) {
  const unidades = col.unidades;
  const hayOferta = oferta > 0;
  const estadoCruce = !hayOferta && !vencido ? 'sin movimiento'
    : oferta > unidades || vencido > oferta ? 'diferencia' : 'ok';
  const vendidoSiga = hayOferta ? oferta - vencido : null;
  const vendido = hayOferta ? vendidoSiga : col.vendido;
  // Sin VENCIDO el vendido de SIGA no es final: el cierre por pendiente 0 usa el manual (como Etapa 1).
  const estadoLote = vencido > 0 || unidades - col.vendido <= 0 ? 'cerrado' : hayOferta ? 'en oferta' : 'cargado';
  const dias = diasParaVencer(lote.vencimiento, hoy);
  return {
    idSucursal: Number(suc), unidades, movidoOferta: oferta, movidoVencido: vencido, estadoCruce,
    diferencia: oferta - unidades, // positivo = se movió de más; negativo = oferta parcial
    estadoLote, vendidoSiga, vendido, origenVendido: hayOferta ? 'siga' : 'manual', vendidoManual: col.vendido,
    aviso: estadoLote === 'cargado' && !hayOferta && dias <= config.diasAviso ? 'falta movimiento' : null,
  };
}

// PURA. lotes: los de lib/vencimientos; filas: { IdSucursal, IdProducto, Tipo, IdDeposito, Cantidad }.
// Devuelve { porLote: { idLote: { idSucursal: resultado } }, huerfanos: [...] }.
function cruzarLote(lotes, filas, config, hoy) {
  const tipoOferta = normalizarTipo(config.tipoOferta);
  const tipoVencido = normalizarTipo(config.tipoNoVendido);
  const sumas = new Map(); // "suc|prod" → { oferta, vencido } con suma firmada
  for (const f of filas) {
    if (Number(f.IdDeposito) !== Number(config.depositoMovimientos) || !esSucursalReal(f.IdSucursal)) continue;
    const tipo = normalizarTipo(f.Tipo ?? f.IdTipoMovimiento);
    const campo = tipo === tipoOferta ? 'oferta' : tipo === tipoVencido ? 'vencido' : null;
    if (!campo) continue;
    const clave = `${Number(f.IdSucursal)}|${Number(f.IdProducto)}`;
    const s = sumas.get(clave) || { oferta: 0, vencido: 0 };
    sumas.set(clave, { ...s, [campo]: s[campo] + Number(f.Cantidad || 0) });
  }

  const porLote = {};
  const huerfanos = [];
  const claves = new Set(sumas.keys());
  for (const l of lotes) for (const suc of Object.keys(l.sucursales || {})) if (esSucursalReal(suc)) claves.add(`${Number(suc)}|${Number(l.idProducto)}`);

  for (const clave of claves) {
    const [suc, prod] = clave.split('|').map(Number);
    const s = sumas.get(clave) || { oferta: 0, vencido: 0 };
    const oferta = Math.abs(s.oferta);
    const vencido = Math.abs(s.vencido);
    const delGrupo = lotes.filter(l => Number(l.idProducto) === prod && l.sucursales && l.sucursales[suc])
      .sort((a, b) => a.vencimiento.localeCompare(b.vencimiento));
    if (!delGrupo.length) {
      huerfanos.push({ idSucursal: suc, idProducto: prod, movidoOferta: oferta, movidoVencido: vencido, estadoCruce: 'diferencia' });
      continue;
    }
    const ofertas = repartir(oferta, delGrupo.map(l => l.sucursales[suc].unidades));
    const vencidos = repartir(vencido, ofertas);
    delGrupo.forEach((l, i) => {
      porLote[l.id] = { ...porLote[l.id], [suc]: resultado(l, suc, l.sucursales[suc], ofertas[i], vencidos[i], config, hoy) };
    });
  }
  return { porLote, huerfanos };
}

module.exports = { normalizarTipo, cruzarLote, consultarMovimientos };
