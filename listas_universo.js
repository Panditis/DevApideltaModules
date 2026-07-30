// ── Membresía de lista del módulo distribución ────────────────────────────────────────────────
// Decide QUÉ PLUs aparecen en cada tab (Almacén / Pesables) antes de calcular una sola fila.
// Vive en su propio módulo (y no dentro de server.js) porque server.js arranca el bootstrap
// completo al ser requerido (conexión SQL + listen), así que era imposible de testear.
//
// ORDEN DE PRECEDENCIA REAL DE LAS REGLAS (importa, es sutil):
//   1) basePlus  → universo base que viene de SQL (rubro "Almacen" o "Pesables Fraccionado").
//                  Se filtra con /^\d+$/: cualquier IdProducto no numérico se descarta.
//   2) siempre*  → se AGREGA al universo aunque el PLU no esté en el rubro base.
//   3) noEnvasa  → se resta del universo… PERO "siempre*" GANA: un PLU que está en ambas listas
//                  queda DENTRO. Es la excepción explícita ("aunque no se envase, quiero verlo").
//   4) ocultarPesable → se aplica AL FINAL, después de todo lo anterior, y sólo en Pesables.
//                  Por eso puede sacar un PLU que "siempre*" había forzado a entrar (caso 2891).
//
// Nota de tipos: las listas se leen de JSON y llegan como Number; basePlus llega de SQL como
// string (CAST(... AS VARCHAR)). Todas las comparaciones se hacen sobre String(p) para que no
// haya falsos negativos por tipo, y la salida es siempre un array de strings.

// Universo de PLUs: base ∪ siempre, menos los excluidos (noEnvasa) salvo que estén en "siempre".
// Los defaults [] son sólo defensivos: leerListasDistrib() ya normaliza las tres listas a arrays,
// así que para los llamadores reales el comportamiento es idéntico al de la versión inline.
function universoLista(basePlus = [], siempre = [], excluir = []) {
  const sSet = new Set(siempre.map(String)), exc = new Set(excluir.map(String));
  const set = new Set(basePlus.filter(p => /^\d+$/.test(p)));
  for (const p of siempre) set.add(String(p));
  return [...set].filter(p => !exc.has(p) || sSet.has(p));
}

// Universo de la tab Pesables: universoLista + el filtro de "ocultar códigos".
// Encapsula el patrón que antes estaba partido en dos líneas dentro de calcularDistribucionPesables.
// ocultarPesable se aplica DESPUÉS de siempre*/noEnvasa, así que gana sobre siemprePesable.
function universoPesables(basePlus, siemprePesable, noEnvasa, ocultarPesable) {
  const ocultos = new Set((ocultarPesable || []).map(String));
  return universoLista(basePlus, siemprePesable, noEnvasa).filter(p => !ocultos.has(String(p)));
}

module.exports = { universoLista, universoPesables };
