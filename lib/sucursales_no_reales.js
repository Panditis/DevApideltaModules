// Sucursales de SiGA que NO son reales (cargadas en el sistema pero sin operación): no cuentan para ningún
// cálculo de planificación (stock en sucursales, ventas, facturación, pedidos). Cualquier módulo que quiera
// ignorarlas reutiliza esta lista; no hay otro lugar donde se escriban los números.
const SUCURSALES_NO_REALES = Object.freeze([6, 8, 11]);

// ¿Es una sucursal real? Acepta el id como número o texto.
function esSucursalReal(idSucursal) {
  return !SUCURSALES_NO_REALES.includes(Number(idSucursal));
}

// Filtra una lista de sucursales ({ id, ... }) dejando solo las reales, en el mismo orden.
function filtrarSucursalesReales(sucursales) {
  return (sucursales || []).filter(s => esSucursalReal(s.id));
}

// La columna de los fragmentos SQL es código propio (alias.columna), nunca un dato de usuario: se rechaza
// lo que no sea un identificador.
function columnaSegura(columna, quien) {
  if (typeof columna !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(columna)) {
    throw new Error(`${quien}: columna inválida`);
  }
  return columna;
}

// Fragmento SQL para un WHERE/AND: `<columna> NOT IN (6,8,11)`. Solo números de la constante.
function sqlExcluirSucursales(columna) {
  return `${columnaSegura(columna, 'sqlExcluirSucursales')} NOT IN (${SUCURSALES_NO_REALES.join(',')})`;
}

// Fragmento SQL para un WHERE/AND que deja afuera lo hecho por la sucursal central (Sucursales.SoyLaCentral=1):
// el análisis de ventas de planificación mira solo lo que venden las sucursales.
function sqlExcluirCentral(columna) {
  return `${columnaSegura(columna, 'sqlExcluirCentral')} NOT IN (SELECT IdSucursal FROM Sucursales WHERE SoyLaCentral=1)`;
}

module.exports = { SUCURSALES_NO_REALES, esSucursalReal, filtrarSucursalesReales, sqlExcluirSucursales, sqlExcluirCentral };
