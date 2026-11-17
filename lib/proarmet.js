'use strict';
// Lógica pura del módulo Depósito Proarmet: config, resolución del depósito por nombre y
// validación del body de POST /api/proarmet/movimiento. Sin SQL ni Express (testeable).

const DESCRIPCION_MAX = 200;
const DEFAULTS = { idSucursal: 1, idDeposito: 'DepositoProarmet', idDepositoCentral: 1, idTipoMovimiento: 'REC-SUC' };

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

module.exports = { DESCRIPCION_MAX, cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas };
