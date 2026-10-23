'use strict';

// ── Catálogo de planificación (data/catalogo.json) por presentaciones ─────────────────────────
// Un grupo (refId/productoRef) tiene presentaciones y cada presentación junta códigos de SIGA:
//   · minoristas: sus ventas (sucursales reales) y su stock cuentan para la presentación;
//   · mayoristas: solo sus ventas de Casa Central a clientes MAYORISTA, 1 a 1; su stock no suma.

// Antes el flag era esVariante (packs/bultos/vid). Sin esMayorista escrito, una variante es mayorista:
// así el catálogo viejo se lee igual sin migrarlo.
function esMayorista(item) {
  return !!item && (item.esMayorista === true || (item.esMayorista === undefined && item.esVariante === true));
}

// Clave `${refId}|${presentacion}`: una presentación armada a mano junta códigos de nombres distintos
// (con la clave por nombre los mayoristas quedaban sueltos y se perdían sus ventas).
// pluBase/baseNombre = el primer minorista; plusBase = todos los minoristas; plusVariantes = los mayoristas.
function buildCatalogoMaps(catalogo) {
  const pluToBase = new Map(), baseMap = new Map(), refMap = new Map();
  for (const item of catalogo) {
    const plu = String(item.plu), refId = String(item.refId), key = `${refId}|${item.presentacion}`;
    pluToBase.set(plu, key);
    if (!baseMap.has(key)) baseMap.set(key, { refId, productoRef: item.productoRef, presentacion: item.presentacion, baseNombre: null, pluBase: null, plusBase: [], plusVariantes: [] });
    const b = baseMap.get(key);
    if (esMayorista(item)) b.plusVariantes.push(plu);
    else { if (!b.pluBase) { b.pluBase = plu; b.baseNombre = item.baseNombre; } b.plusBase.push(plu); }
    if (!refMap.has(refId)) refMap.set(refId, { productoRef: item.productoRef, bases: new Map() });
    refMap.get(refId).bases.set(key, b);
  }
  return { pluToBase, baseMap, refMap };
}

module.exports = { esMayorista, buildCatalogoMaps };
