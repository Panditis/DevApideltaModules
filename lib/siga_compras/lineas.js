'use strict';
// Reglas de línea de SiGA (MovimientosDeComprasV2 + Reglas.MovimientosStock). Puro: sin SQL ni fs.
// Fuente: docs/siga_compras_carga_descompilado.md (DOC).
const C = require('./constantes');

// DOC Parte I §4.2 y Parte II §3.2-§3.3: los Round de SiGA son decimal.Round / Math.Round sobre decimal, que en
// .NET redondean al par (MidpointRounding.ToEven); Math.round de JS redondea el .5 para arriba. El float no
// representa exacto 0,125: el punto medio se detecta con una tolerancia relativa.
function redondear(valor, decimales) {
  const n = Number(valor) || 0;
  const factor = 10 ** decimales;
  const escalado = n * factor;
  const piso = Math.floor(escalado);
  const tolerancia = 1e-9 * Math.max(1, Math.abs(escalado));
  const esMedio = Math.abs(escalado - piso - 0.5) <= tolerancia;
  const entero = esMedio ? (piso % 2 === 0 ? piso : piso + 1) : Math.round(escalado);
  return entero / factor + 0; // + 0 convierte -0 en 0
}

// Limpia el error de punto flotante de sumas y productos de importes con pocos decimales.
const sinRuido = valor => redondear(valor, 6);

// SIGA-INFERIDO: TiposComprobantes.LetrasHabilitadas es un string de letras ("ABCEIM"); SiGA solo mira su
// largo (DOC Parte I §3.1). Acepta también un array (lo que devuelve mapeos.js) o letras con separadores.
function letrasDe(letrasHabilitadas) {
  const crudo = Array.isArray(letrasHabilitadas) ? letrasHabilitadas.join('') : String(letrasHabilitadas || '');
  return [...new Set(crudo.toUpperCase().replace(/[^A-Z]/g, '').split('').filter(Boolean))];
}

// DOC Parte I §4.1 (L24486, L24532) y Parte II §3.2 (CreaCompraProducto C L261, L313).
// proveedor y empresa son categorías fiscales { ivaDiscriminado, utilizaImpuestos }; tipo es el comprobante.
function usanImpuestos({ proveedor, empresa, tipo }) {
  return !!(proveedor.utilizaImpuestos && empresa.utilizaImpuestos && tipo.utilizaImpuestos);
}

// IVA de línea habilitado (letra A): todos usan impuestos y proveedor y empresa discriminan IVA.
function discriminaIVA(ctx) {
  return usanImpuestos(ctx) && !!(ctx.proveedor.ivaDiscriminado && ctx.empresa.ivaDiscriminado);
}

// El precio de línea lleva IVA (B/C) cuando alguno no discrimina pero todos usan impuestos.
function precioIncluyeIVA(ctx) {
  return usanImpuestos(ctx) && !(ctx.proveedor.ivaDiscriminado && ctx.empresa.ivaDiscriminado);
}

// DOC Parte I §3.1: una sola letra habilitada → esa; si no, la LetraFiscalCompra de la categoría del proveedor.
function letraSugerida({ letrasHabilitadas, letraProveedor }) {
  const letras = letrasDe(letrasHabilitadas);
  if (letras.length === 1) return letras[0];
  return String(letraProveedor || '').trim().toUpperCase() || null;
}

// DOC Parte I §3.3 y §7 #14-#16 (Win L22917-22980). Con letra vacía SiGA muestra primero el #14; acá se
// muestra el #16, que dice qué falta. Proveedor A con letra B: SiGA pide confirmación y exige IVA 0 en todas
// las líneas; la v1 lo acepta solo si ya están todas en 0.
function validarLetra({ letra, letrasHabilitadas, letraProveedor, porcentajesIVA = [] }) {
  const l = String(letra || '').trim().toUpperCase();
  const letras = letrasDe(letrasHabilitadas);
  if (!l) return [{ campo: 'letra', mensaje: 'Falta cargar el tipo de letra del comprobante.' }];
  if (!letras.includes(l)) return [{ campo: 'letra', mensaje: 'Este comprobante no esta habilitado para esta Letra Fiscal' }];
  const prov = String(letraProveedor || '').trim().toUpperCase();
  if (letras.length > 1 && prov !== l) {
    if (prov === 'A' && l === 'B') {
      return porcentajesIVA.some(p => Number(p) !== 0)
        ? [{ campo: 'letra', mensaje: 'El porcentaje de IVA no puede ser distinto 0% ' }]
        : [];
    }
    return [{ campo: 'letra', mensaje: `La Letra '${l}' NO coincide con la del Proveedor '${prov}'` }];
  }
  return [];
}

// DOC Parte I §4.2 (InsertarProducto L24783-24979) + Parte II §3.2 (CargarMovimientoStock ME L295-309).
// v1 sin descuento/recargo por línea (DescuentoRecargo = 0); el descuento/recargo general es un % (negativo = descuento).
function calcularLinea({ cantidad, precio, porcentajeIVA, porcDescRecGeneral = 0, discrimina, decimalesPrecio = C.DEFAULTS_PARAMETROS.decimalesPrecio }) {
  const cant = Number(cantidad);
  const pu = Number(precio);
  const descuentoRecargo = 0;
  // ME L301: ImporteTotal = Round(Precio * Cantidad, 2) + DescuentoRecargo.
  // SIGA-INFERIDO: la pantalla además formatea a ComprasDecimalesEnTotalXProducto; se asume 2, igual que ME.
  const importeTotal = redondear(pu * cant, C.DECIMALES_FIJOS) + descuentoRecargo;
  // L24824: DescRecGeneral = Round(ImporteTotal * %Gral / 100, decRedPrecio).
  const descRecGeneral = redondear(importeTotal * (Number(porcDescRecGeneral) || 0) / 100, decimalesPrecio);
  // L24486-24550: sin discriminación el IVA de la línea se fuerza a 0.
  const pIVA = discrimina ? Number(porcentajeIVA) || 0 : 0;
  // L24826: IVA = (ImporteTotal + DescRecGeneral) * %IVA / 100, sin redondear.
  const iva = (importeTotal + descRecGeneral) * pIVA / 100;
  // ME L295-303: solo si Precio != 0. "Neto" = neto de descuentos, no "sin IVA".
  const descRecGeneralProducto = pu !== 0 ? redondear(descRecGeneral / cant, 2) : 0;
  const precioNeto = pu !== 0 ? redondear(pu + 0 + descRecGeneralProducto, 2) : 0;
  // ME L302.
  const importeTotalNeto = redondear(importeTotal + descRecGeneral, 2);
  return {
    cantidad: cant, precio: pu, descuentoRecargo, descuentoRecargoProducto: 0, descuentoRecargoPorc: 0,
    descRecGeneral, descRecGeneralProducto, precioNeto, importeTotal, importeTotalNeto, porcentajeIVA: pIVA, iva,
  };
}

module.exports = {
  redondear, sinRuido, letrasDe, discriminaIVA, precioIncluyeIVA, letraSugerida, validarLetra, calcularLinea,
};
