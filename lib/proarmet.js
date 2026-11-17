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

// Devuelve { sentido, descripcion, lineas } o { error }. Las líneas con el mismo producto se suman.
function validarMovimiento(body) {
  const b = body || {};
  if (b.sentido !== 'ida' && b.sentido !== 'vuelta') return { error: "sentido inválido: debe ser 'ida' o 'vuelta'" };
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
  return { sentido: b.sentido, descripcion, lineas: [...suma].map(([idProducto, cantidad]) => ({ idProducto, cantidad })) };
}

// productos: Map idProducto -> { activo, stockDeposito }. Devuelve mensaje de error o null.
function chequearLineas(sentido, lineas, productos) {
  const errores = [];
  for (const l of lineas) {
    const p = productos.get(l.idProducto);
    if (!p) { errores.push(`El producto ${l.idProducto} no existe en SIGA`); continue; }
    if (sentido === 'ida' && !p.activo) errores.push(`El producto ${l.idProducto} está inactivo en SIGA`);
    if (sentido === 'vuelta' && l.cantidad > p.stockDeposito) {
      errores.push(`Producto ${l.idProducto}: se piden ${l.cantidad} pero en Proarmet hay ${p.stockDeposito}`);
    }
  }
  return errores.length ? errores.join('; ') : null;
}

module.exports = { DESCRIPCION_MAX, cfgProarmet, buscarDeposito, validarMovimiento, chequearLineas };
