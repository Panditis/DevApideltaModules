'use strict';
// Lógica pura del módulo Depósito Proarmet: config, resolución del depósito por nombre y
// validación del body de POST /api/proarmet/movimiento. Sin SQL ni Express (testeable).

const DESCRIPCION_MAX = 200;
const DEFAULTS = { idSucursal: 1, idDeposito: 'DepositoProarmet', idDepositoCentral: 1, idTipoMovimiento: 'BIENESUSO' };

// raw = config.proarmet; depPrincipal = reserva.depositoPrincipal (depósito de casa central).
function cfgProarmet(raw, depPrincipal) {
  const c = { ...DEFAULTS, ...(depPrincipal ? { idDepositoCentral: depPrincipal } : {}), ...(raw || {}) };
  return {
    idSucursal: Number(c.idSucursal) || DEFAULTS.idSucursal,
    idDeposito: c.idDeposito, // número o nombre; el nombre se resuelve contra SucursalesDepositos
    idDepositoCentral: Number(c.idDepositoCentral) || DEFAULTS.idDepositoCentral,
    idTipoMovimiento: String(c.idTipoMovimiento || DEFAULTS.idTipoMovimiento).trim().toUpperCase(),
  };
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Busca el depósito en la lista de depositosActivos(): por id si es número, si no por nombre
// ignorando espacios/mayúsculas ("DepositoProarmet" == " Deposito Proarmet").
function buscarDeposito(depositos, idONombre) {
  const id = Number(idONombre);
  if (Number.isInteger(id) && id > 0) return depositos.find(d => Number(d.IdDeposito) === id) || null;
  const n = norm(idONombre);
  if (!n) return null;
  return depositos.find(d => norm(d.NombreDeposito) === n)
      || depositos.find(d => norm(d.NombreDeposito).includes(n))
      || null;
}

// Devuelve { depOrigen, depDestino, descripcion, lineas } o { error }. idsValidos = ids de
// depositosActivos(sucursal). Las líneas con el mismo producto se suman.
function validarMovimiento(body, idsValidos) {
  const b = body || {};
  const depOrigen = Number(b.depOrigen), depDestino = Number(b.depDestino);
  if (!Number.isInteger(depOrigen) || !Number.isInteger(depDestino)) return { error: 'depOrigen y depDestino deben ser ids de depósito enteros' };
  if (depOrigen === depDestino) return { error: 'El depósito de origen y el de destino no pueden ser el mismo' };
  const validos = new Set((idsValidos || []).map(Number));
  if (!validos.has(depOrigen)) return { error: `El depósito de origen ${depOrigen} no está activo en la sucursal` };
  if (!validos.has(depDestino)) return { error: `El depósito de destino ${depDestino} no está activo en la sucursal` };
  const descripcion = typeof b.descripcion === 'string' ? b.descripcion.trim() : '';
  if (!descripcion) return { error: 'Falta la descripción del movimiento' };
  if (descripcion.length > DESCRIPCION_MAX) return { error: `La descripción no puede superar ${DESCRIPCION_MAX} caracteres` };
  if (!Array.isArray(b.lineas) || !b.lineas.length) return { error: 'Falta lineas (al menos un producto)' };
  const suma = new Map();
  for (const l of b.lineas) {
    const idProducto = String((l && l.idProducto) ?? '').trim();
    const cantidad = Number(l && l.cantidad);
    if (!idProducto) return { error: 'Cada línea debe tener idProducto' };
    if (!Number.isFinite(cantidad) || cantidad <= 0) return { error: `Cantidad inválida para el producto ${idProducto}: debe ser un número mayor a 0` };
    suma.set(idProducto, (suma.get(idProducto) || 0) + cantidad);
  }
  return { depOrigen, depDestino, descripcion, lineas: [...suma].map(([idProducto, cantidad]) => ({ idProducto, cantidad })) };
}

// productos: Map idProducto -> { activo, stockOrigen }. Devuelve mensaje de error o null.
function chequearLineas(lineas, productos) {
  const errores = [];
  for (const l of lineas) {
    const p = productos.get(l.idProducto);
    if (!p) { errores.push(`El producto ${l.idProducto} no existe en SIGA`); continue; }
    if (!p.activo) errores.push(`El producto ${l.idProducto} está inactivo en SIGA`);
    if (l.cantidad > p.stockOrigen) {
      errores.push(`Producto ${l.idProducto}: se piden ${l.cantidad} pero en origen hay ${p.stockOrigen}`);
    }
  }
  return errores.length ? errores.join('; ') : null;
}

// Historial: registros 'traslado' de la sucursal que tocan el depósito, más nuevos primero (el log
// se escribe con el más nuevo al final). nombres = Map IdDeposito -> nombre. Devuelve objetos nuevos.
// usuarios = Map Id -> nombre completo; lo grabado que no matchea (movimientos viejos con nombre) va tal cual.
function historialMovimientos(log, { idSucursal, idDeposito, limit, nombres, usuarios = new Map() }) {
  return (log || [])
    .filter(r => r && r.origen === 'traslado' && Number(r.idSucursal) === idSucursal
              && (Number(r.depOrigen) === idDeposito || Number(r.depDestino) === idDeposito))
    .reverse()
    .slice(0, limit)
    .map(r => ({
      id: r.id, fecha: r.fechaHora || null, numeroMovimiento: r.numeroMovimiento ?? null, estado: r.estado,
      tipo: Number(r.depDestino) === idDeposito ? 'ingreso' : 'salida',
      depOrigen: r.depOrigen, depDestino: r.depDestino,
      depOrigenNombre: nombres.get(Number(r.depOrigen)) ?? null,
      depDestinoNombre: nombres.get(Number(r.depDestino)) ?? null,
      usuario: r.usuario ? (usuarios.get(String(r.usuario).trim()) ?? r.usuario) : null, descripcion: r.observacion || null,
      lineas: (r.lineas || []).map(l => ({ idProducto: String(l.plu), descripcion: l.nombre ?? null, cantidad: Number(l.cantidad) })),
      revertidoPor: r.revertidoPor || null,
    }));
}

// Usuario del movimiento = Id (trim) del activo elegido. { usuario } o { error }; nunca trunca:
// un Id más largo que la columna (max) se rechaza.
function usuarioMovimiento(usuarios, idUsuario, max) {
  const id = String(idUsuario ?? '').trim();
  if (!id || !(usuarios || []).some(x => x.id === id)) return { error: 'Elegí el usuario responsable' };
  if (id.length > max) return { error: `El id de usuario "${id}" supera los ${max} caracteres que admite el movimiento en SIGA` };
  return { usuario: id };
}

module.exports = { DESCRIPCION_MAX, usuarioMovimiento, cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas, historialMovimientos };
