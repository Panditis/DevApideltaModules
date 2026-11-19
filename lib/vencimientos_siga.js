// Control de vencimientos, Etapa 2: cruce de SOLO LECTURA contra los movimientos de SIGA
// 'PARA OFERTA' (sale a oferta) y 'VENCIDO' (lo no vendido), ambos al depósito configurado.
//
// Signo: en SIGA MovimientosStockProductos.Cantidad ya viene firmada (ver lib/analisis_ventas.js,
// sqlNetoDiarioStock); estos tipos son salidas, así que se esperan negativas. No se multiplica por
// TiposMovimientos.CoeficienteStock (duplicaba el signo en analisis_ventas). Para no depender de
// cuál de los dos lleva el signo, el cruce usa ABS(SUM(Cantidad)) por (sucursal, producto, tipo):
// da lo mismo si Cantidad viene negativa o positiva con el signo puesto por el coeficiente.
const { esSucursalReal, sqlExcluirSucursales } = require('./sucursales_no_reales');
const { diasParaVencer, pendiente, esSucursalSinOferta } = require('./vencimientos');

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
  ids.forEach((id, i) => request.input(`prod${i}`, String(id))); // msnodesqlv8 rompe el declare con nombres pN: prefijo largo
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
      AND LTRIM(RTRIM(CAST(mp.IdProducto AS VARCHAR(50)))) IN (${ids.map((_, i) => `@prod${i}`).join(',')})
    GROUP BY m.IdSucursal, mp.IdProducto, m.IdTipoMovimiento, mp.IdDeposito`);
  return r.recordset || [];
}

const sqlSi = (si, texto) => (si ? texto : '');

function fechaTexto(v) {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').slice(0, 10);
}

// Por clase: tipo de movimiento, ventana y lista donde se asigna en cada registro.
const CLASES_SIGA = Object.freeze({
  oferta: { tipo: 'tipoOferta', dias: 'diasMaxOferta', lista: 'ofertasSistema', magnitud: 'neta' },
  // OFERTA VENCIDO se registra x2 (+N/-N por producto, neta 0): solo cuentan las líneas negativas
  // (Sale); las positivas se ignoran a propósito. Sin líneas negativas -> 0 -> no se devuelve.
  vencido: { tipo: 'tipoOfertaVencida', dias: 'diasMaxVencido', lista: 'vencidosSistema', magnitud: 'negativa' },
});

// Movimientos de la clase ('oferta' PARA OFERTA | 'vencido' OFERTA VENCIDO) en UNA sucursal desde
// hoy - días máximos, uno por número. Solo lectura. [{ numeroMovimiento, fecha, cantidad }] por fecha desc.
// Con idProducto: solo ese producto. Sin idProducto (o con `rubros`): agrupa también por producto, une
// Productos/Rubros y agrega { idProducto, nombre, codigo }; `rubros` filtra por NombreRubro y sin producto
// se corta en TOP `tope` (los más recientes).
async function consultarMovimientosClase(getPool, { clase = 'oferta', idProducto, idSucursal, config, hoy, rubros, tope = 500 }) {
  // Sucursales sin oferta: no hay PARA OFERTA, y el vencido es 'VENCIDO' (un solo signo, magnitud neta).
  const sinOferta = esSucursalSinOferta(idSucursal);
  if (sinOferta && clase === 'oferta') return [];
  const c = sinOferta && clase === 'vencido' ? { ...CLASES_SIGA.vencido, tipo: 'tipoNoVendido', magnitud: 'neta' } : CLASES_SIGA[clase];
  const conProducto = idProducto !== undefined && idProducto !== null;
  const detalle = !conProducto || Array.isArray(rubros);
  const request = (await getPool()).request();
  request.input('desde', sumarDias(hoy, -config[c.dias]));
  request.input('deposito', config.depositoMovimientos);
  request.input('sucursal', idSucursal);
  if (conProducto) request.input('producto', String(idProducto));
  request.input('tipoMovimientoSql', normalizarTipo(config[c.tipo]).replace(/ /g, ''));
  (rubros || []).forEach((rubro, i) => request.input(`rubro${i}`, rubro)); // msnodesqlv8: nada de pN
  const idSql = 'LTRIM(RTRIM(CAST(mp.IdProducto AS VARCHAR(50))))';
  const r = await request.query(`SELECT ${conProducto ? '' : `TOP ${Number(tope)} `}m.NumeroMovimiento, CAST(m.FechaMovimiento AS DATE) AS Fecha, m.IdTipoMovimiento AS Tipo, ABS(SUM(mp.Cantidad)) AS Cantidad,
      SUM(CASE WHEN mp.Cantidad < 0 THEN -mp.Cantidad ELSE 0 END) AS Sale,
      SUM(CASE WHEN mp.Cantidad > 0 THEN mp.Cantidad ELSE 0 END) AS Entra${sqlSi(detalle, `, ${idSql} AS IdProducto, p.NombreProducto, p.CodigoDeBarras`)}
    FROM MovimientosStock m
    INNER JOIN MovimientosStockProductos mp ON mp.IdSucursal = m.IdSucursal
      AND mp.IdTipoMovimiento = m.IdTipoMovimiento AND mp.NumeroMovimiento = m.NumeroMovimiento${sqlSi(detalle, `
    INNER JOIN Productos p ON LTRIM(RTRIM(CAST(p.IdProducto AS VARCHAR(50)))) = ${idSql}`)}${sqlSi(rubros && rubros.length, `
    INNER JOIN Rubros r ON r.IdRubro = p.IdRubro`)}
    WHERE m.FechaMovimiento >= @desde AND m.IdSucursal = @sucursal
      AND UPPER(REPLACE(m.IdTipoMovimiento, ' ', '')) = @tipoMovimientoSql
      AND mp.IdDeposito = @deposito${sqlSi(conProducto, `
      AND ${idSql} = @producto`)}${sqlSi(rubros && rubros.length, `
      AND r.NombreRubro IN (${(rubros || []).map((_, i) => `@rubro${i}`).join(', ')})`)}
    GROUP BY m.NumeroMovimiento, CAST(m.FechaMovimiento AS DATE), m.IdTipoMovimiento${sqlSi(detalle, `, ${idSql}, p.NombreProducto, p.CodigoDeBarras`)}${sqlSi(!conProducto && c.magnitud === 'negativa', `
    HAVING SUM(CASE WHEN mp.Cantidad < 0 THEN 1 ELSE 0 END) > 0`)}${sqlSi(!conProducto, `
    ORDER BY CAST(m.FechaMovimiento AS DATE) DESC, m.NumeroMovimiento DESC`)}`);
  const tipo = normalizarTipo(config[c.tipo]);
  return (r.recordset || []).filter(f => normalizarTipo(f.Tipo) === tipo)
    .map(f => {
      const base = { numeroMovimiento: Number(f.NumeroMovimiento), fecha: fechaTexto(f.Fecha),
        ...(detalle && { idProducto: Number(String(f.IdProducto).trim()), nombre: f.NombreProducto ? String(f.NombreProducto).trim() : null, codigo: f.CodigoDeBarras ? String(f.CodigoDeBarras).trim() : null }) };
      if (c.magnitud !== 'negativa') return { ...base, cantidad: Number(f.Cantidad || 0), entra: 0, asimetrico: false };
      // Asimétrico: las +N y -N del producto en el comprobante no coinciden (lectura, no se guarda).
      const cantidad = Number(f.Sale || 0), entra = Number(f.Entra || 0);
      return { ...base, cantidad, entra, asimetrico: entra !== cantidad };
    })
    .filter(m => c.magnitud !== 'negativa' || m.cantidad !== 0)
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.numeroMovimiento - a.numeroMovimiento);
}

// PURA. Marca a qué registro (lote + sucursal) está asignado cada movimiento, mismo producto.
function marcarAsignados(movimientos, lotes, idProducto, idSucursal, clase = 'oferta') {
  const suc = String(idSucursal);
  const lista = CLASES_SIGA[clase].lista;
  return movimientos.map(m => {
    const l = lotes.find(x => Number(x.idProducto) === Number(idProducto) && (x.sucursales?.[suc]?.[lista] || []).some(o => o.numeroMovimiento === m.numeroMovimiento));
    return { ...m, asignadoA: l ? { idLote: l.id, idSucursal: Number(suc) } : null };
  });
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
  const estadoLote = vencido > 0 || pendiente(col) <= 0 ? 'cerrado' : hayOferta ? 'en oferta' : 'cargado';
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

const consultarMovimientosOferta = (getPool, opciones) => consultarMovimientosClase(getPool, { ...opciones, clase: 'oferta' });

module.exports = { normalizarTipo, cruzarLote, consultarMovimientos, consultarMovimientosClase, consultarMovimientosOferta, marcarAsignados };
