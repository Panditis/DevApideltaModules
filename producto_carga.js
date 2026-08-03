'use strict';
// Resolución del producto contra el cual se carga la producción de una línea de fraccionado
// mayorista. Módulo puro a propósito: sin SQL ni lectura de archivos, así se puede testear con
// node:test. Lo llama el endpoint /api/mayoristas/producto-carga de server.js.
//
// Regla del negocio (la dicta la encargada de producción, no el BOM):
//   presentación <= 1 kg  → se carga contra el minorista de LA MISMA presentación
//                           (Mani 200G Bulto → Mani 200G)
//   presentación  > 1 kg  → se carga contra el producto " PEDIDOS" del rubro Produccion
//                           (Mani 20Kg → Mani PEDIDOS)
// El componente del BOM NO sirve para esto: para "Mix Europeo 200G Unidad Bulto" devuelve
// "Mix Europeo 10Kg (Precio por kilo)", que es el granel y no el destino de carga. Por eso la
// derivación es por nombre.

// Token de peso del nombre. Es la MISMA regex que usaba pesoPresentacionKg() en server.js: se
// extrajo acá para que server.js la consuma desde este módulo y no queden dos criterios
// divergiendo. Global porque se recorren todos los matches y se toma el último.
const PESO_RE = /(\d+(?:[.,]\d+)?)\s*(kgs?|gramos|grs?|gr|g)\b/gi;

// Sufijos de empaque que van DESPUÉS del nombre comercial y no forman parte del nombre base.
// Salieron de los nombres reales que devuelve /api/mayoristas/fraccionado-faltantes:
//   "Unidad Bulto", "Bulto", "Unidad Pack", "Pack X 40 Unidades", "Caja Cerrada",
//   "(Precio Por Unid)", "(Precio por kilo)", "(Por Kilo)", "x Pallet (PrecioxUnidad)".
// Se aplican en bucle porque se encadenan ("2Kg Pack X 40 Unidades (Precio Por Unid)").
const SUFIJOS_RE = [
  /\s*\([^()]*\)\s*$/,                                   // cualquier paréntesis final
  /\s+x\s*\d+(?:\s*(?:unidades?|unid|un))?\s*$/i,        // "X 40 Unidades", "X 160", "x 5 Unid"
  /\s+(bulto|pack|packs|unidad|unidades|unid|caja|cerrada|pallet|vid|suelto)\s*$/i,
];

// minúsculas, sin tildes y con espacios colapsados. Comparación "estricta": conserva los
// símbolos, así "Mix F.S N&P" y "Mix F.S. N&P" siguen siendo nombres distintos.
function normalizarComparacion(s) {
  return String(s == null ? '' : s)
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

// Comparación "laxa": además saca los símbolos. Es la que decide el match, porque en Siga el
// mismo producto aparece escrito con y sin puntos ("Mix F.S N&P PEDIDOS" vs "Mix F.S. N&P
// PEDIDOS"). Cuando hay empate por esta clave, gana el que también coincide en la estricta.
function normalizarClave(s) {
  return normalizarComparacion(s).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function quitarSufijos(s) {
  let n = String(s || '').trim();
  for (let i = 0; i < 6; i++) {   // tope duro: los nombres reales encadenan como mucho 3 sufijos
    const antes = n;
    for (const re of SUFIJOS_RE) n = n.replace(re, '').trim();
    if (n === antes) break;
  }
  return n;
}

// Último token de peso del nombre convertido a kg, o null si el nombre no tiene ninguno.
// A diferencia de pesoPresentacionKg(), acá NO se aplica el atajo "por kilo → 1kg": ese marcador
// dice cómo se factura, no qué tamaño tiene el envase, y para elegir el destino de carga importa
// el envase. "Mix Cervecero 10Kg (Precio por kilo)" son 10 kg → va por PEDIDOS, no por minorista.
function pesoTokenKg(nombre) {
  const t = tokenPeso(nombre);
  return t ? t.kg : null;
}

function tokenPeso(nombre) {
  const n = String(nombre == null ? '' : nombre);
  PESO_RE.lastIndex = 0;
  let m, ultimo = null;
  while ((m = PESO_RE.exec(n)) !== null) ultimo = m;
  if (!ultimo) return null;
  const val = parseFloat(ultimo[1].replace(',', '.'));
  if (!(val > 0)) return null;
  const u = ultimo[2].toLowerCase();
  const kg = (u === 'kg' || u === 'kgs') ? val : val / 1000;   // g/gr/grs/gramos → kg
  if (!(kg > 0)) return null;
  return { kg: Math.round(kg * 1000) / 1000, inicio: ultimo.index, fin: ultimo.index + ultimo[0].length };
}

/**
 * Parte un nombre de producto en nombre base + presentación + resto de empaque.
 * "Mix Europeo 200G Unidad Bulto" → { base:'Mix Europeo', presentacionKg:0.2, resto:'Unidad Bulto' }
 * "Mix Europeo 200G"              → { base:'Mix Europeo', presentacionKg:0.2, resto:'' }
 * "Adobo Para Pizza Bulto"        → { base:'Adobo Para Pizza', presentacionKg:null, resto:'' }
 * @param {string} nombre
 * @returns {{base:string, presentacionKg:number|null, resto:string}}
 */
function analizarNombreCarga(nombre) {
  const n = String(nombre == null ? '' : nombre).replace(/\s+/g, ' ').trim();
  const t = tokenPeso(n);
  if (!t) return { base: quitarSufijos(n), presentacionKg: null, resto: '' };
  return {
    base: quitarSufijos(n.slice(0, t.inicio)),
    presentacionKg: t.kg,
    resto: n.slice(t.fin).trim(),
  };
}

// Entre varios candidatos válidos gana el que coincide también en la normalización estricta
// (misma puntuación), después el nombre más corto y por último el PLU más chico. El desempate
// tiene que ser determinista: si no, la UI muestra un destino distinto en cada request.
function elegirMejor(candidatos, claveEstricta) {
  return candidatos.slice().sort((a, b) =>
    (b.estricta === claveEstricta) - (a.estricta === claveEstricta) ||
    a.nombre.length - b.nombre.length ||
    String(a.plu).localeCompare(String(b.plu), undefined, { numeric: true })
  )[0];
}

/**
 * Devuelve el producto contra el cual hay que cargar la producción de un mayorista.
 * @param {string} nombreMayorista  nombre del producto de la línea de la orden
 * @param {Array}  catalogo         [{ plu, nombre }] candidatos activos
 * @returns {{plu:string, nombre:string, via:'minorista'|'pedidos', presentacionKg:number|null}|null}
 */
function resolverProductoCarga(nombreMayorista, catalogo) {
  const info = analizarNombreCarga(nombreMayorista);
  if (!info.base) return null;

  const baseClave = normalizarClave(info.base);
  if (!baseClave) return null;
  const kg = info.presentacionKg;
  // Sin presentación legible en el nombre no hay forma de saber el tamaño → se asume pedido.
  const via = (kg != null && kg <= 1) ? 'minorista' : 'pedidos';

  const items = (catalogo || [])
    .map(p => ({ plu: String(p.plu == null ? '' : p.plu).trim(), nombre: String(p.nombre || '').trim() }))
    .filter(p => p.plu && p.nombre);

  let candidatos;
  let claveEstricta;
  if (via === 'minorista') {
    // El destino es el minorista "puro": mismo base, misma presentación y SIN cola de empaque.
    // El filtro por `resto` vacío es lo que descarta al propio bulto de origen y a sus hermanos
    // ("Mix Europeo 200G Unidad Pack"), que si no matchearían igual de bien.
    claveEstricta = normalizarComparacion(info.base);
    candidatos = items
      .map(p => ({ ...p, info: analizarNombreCarga(p.nombre) }))
      .filter(p => p.info.resto === '' &&
                   p.info.presentacionKg != null &&
                   Math.abs(p.info.presentacionKg - kg) < 1e-6 &&
                   normalizarClave(p.info.base) === baseClave)
      .map(p => ({ plu: p.plu, nombre: p.nombre, estricta: normalizarComparacion(p.info.base) }));
  } else {
    const claveDestino = `${baseClave} pedidos`;
    claveEstricta = `${normalizarComparacion(info.base)} pedidos`;
    candidatos = items
      .filter(p => normalizarClave(p.nombre) === claveDestino)
      .map(p => ({ plu: p.plu, nombre: p.nombre, estricta: normalizarComparacion(p.nombre) }));
  }

  if (!candidatos.length) return null;   // nunca se inventa un producto: la UI avisa y sigue
  const mejor = elegirMejor(candidatos, claveEstricta);
  return { plu: mejor.plu, nombre: mejor.nombre, via, presentacionKg: kg };
}

module.exports = {
  resolverProductoCarga,
  analizarNombreCarga,
  pesoTokenKg,
  normalizarClave,
  normalizarComparacion,
};
