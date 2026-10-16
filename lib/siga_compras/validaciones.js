'use strict';
// validarComprobante: mensajes literales de SiGA (DOC Parte I §7, ValidarComprobante L22810-23299, y §4.3)
// más los bloqueos propios de la v1 (prefijo "v1:"). SiGA corta en el primer error; acá se devuelven todos los
// que apliquen en el orden de SiGA, salvo que falte proveedor o tipo (sin ellos no hay contra qué validar).
// Fuente: docs/siga_compras_carga_descompilado.md (DOC).
const C = require('./constantes');
const { validarLetra, redondearLejosDelCero } = require('./lineas');
const { fechaLocalISO, fechaHoraComprobante } = require('./fechas');

const N2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const error = (campo, mensaje) => [{ campo, mensaje }];
const vacio = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const MAX_CENTRO_EMISOR = 32767; // Compra.CentroEmisor es short (DOC Parte III §7.1).

// Número finito (o texto numérico). Number() deja pasar true, [] y '' como si fueran 0 y redondear() convierte
// NaN en 0 sin avisar: lo no numérico se ataja acá, antes de calcular.
function esNumero(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  return typeof v === 'string' && v.trim() !== '' && !C.MILES_ARGENTINO.test(v.trim()) && Number.isFinite(Number(v));
}

// Un 'YYYY-MM-DD' con formato válido pero fuera del calendario (2027-02-29, 2026-13-01) se corre al mes siguiente
// al armar el Date de la grabación: se verifica ida y vuelta con las funciones de fechas.js.
const existeEnCalendario = f => fechaLocalISO(fechaHoraComprobante(f, new Date(2000, 0, 1))) === f;

// SIGA-INFERIDO: Publicos.EsCuitValido = dígito verificador de AFIP (módulo 11); no está en los .cs.
function cuitValido(cuit) {
  const d = String(cuit || '').replace(/\D/g, '');
  if (d.length !== 11) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((s, p, i) => s + p * Number(d[i]), 0);
  const resto = 11 - (suma % 11);
  const verificador = resto === 11 ? 0 : resto === 10 ? 9 : resto;
  return verificador === Number(d[10]);
}

// DOC Parte I §3.2: NumeracionAutomatica → por proveedor (o VentasNumeros si hay fila relacionada); tipos sin
// stock, sin caja y sin cta. cte. → ComprasNumeros; el resto (FACTCOM) → manual.
function modoNumeracion(tipo, ventasNumerosRelacionado) {
  if (!tipo) return 'manual';
  if (tipo.numeracionAutomatica) return ventasNumerosRelacionado ? 'ventasNumeros' : 'proveedor';
  if (tipo.coeficienteStock === 0 && !tipo.afectaCaja && !tipo.actualizaCtaCte) return 'comprasNumeros';
  return 'manual';
}

// Bloqueos v1 del tipo de comprobante (spec "Fuera de alcance" y decisiones del plan).
function validarTipo(ctx) {
  const t = ctx.tipo;
  const modo = modoNumeracion(t, ctx.ventasNumerosRelacionado);
  if (t.tipo !== C.TIPO_COMPRAS) return error('idTipoComprobante', `v1: ${t.idTipoComprobante} no es un comprobante de compras.`);
  if (t.coeficienteValores !== 1 || t.coeficienteStock < 0) {
    return error('idTipoComprobante', 'v1: las notas de crédito y los tipos con coeficientes distintos de 1 no se importan; cargalos en SiGA.');
  }
  if (modo === 'comprasNumeros') return error('idTipoComprobante', `v1: ${t.idTipoComprobante} numera por ComprasNumeros; no se importa.`);
  if (modo === 'ventasNumeros') return error('idTipoComprobante', `v1: ${t.idTipoComprobante} numera por VentasNumeros; no se importa.`);
  // DOC Parte II §1.3 paso 14 (ME L441): sin caja la pantalla pone ImportePesos = total y SiGA genera un PAGO.
  if (!t.afectaCaja && t.actualizaCtaCte) {
    return error('idTipoComprobante', `v1: ${t.idTipoComprobante} no afecta caja y actualiza cuenta corriente: SiGA generaría un PAGO automático; no se importa.`);
  }
  return [];
}

function validarProveedorFiscal(ctx) {
  // DOC Parte III §6.2: sin IdCategoriaFiscal la compra no aparece en la pantalla de modificación de SiGA.
  if (!ctx.proveedor.categoriaFiscal) return error('idProveedor', 'v1: el proveedor no tiene categoría fiscal en SIGA.');
  // #8: ValidaCuitProveedor, solo si el tipo graba libro.
  if (ctx.tipo.grabaLibro && !cuitValido(ctx.proveedor.cuit)) {
    return error('idProveedor', 'El Comprobante seleccionado graba en libro, y el proveedor no posee CUIT Valido');
  }
  return [];
}

function validarDestino(ctx) {
  if (!ctx.destino.sucursal) return error('idSucursal', 'v1: la sucursal elegida no existe en SIGA.');
  if (!ctx.destino.ubicacion) return error('idUbicacion', 'v1: el depósito/ubicación elegido no existe en esa sucursal.');
  if (!ctx.empresa.categoriaFiscal) return error('idSucursal', 'v1: falta la categoría fiscal de la empresa (parámetro CATEGORIAFISCALEMPRESA).');
  // DOC Parte I §8.1: TiposMovimientos.GetUnoPorComprobanteAsociado.
  if (!ctx.tipoMovimiento) return error('idTipoComprobante', `v1: no hay tipo de movimiento de stock asociado a ${ctx.tipo.idTipoComprobante}.`);
  if (ctx.cotizacionDolar == null) return error('idSucursal', 'v1: falta la cotización del dólar (Monedas, IdMoneda 2).');
  return [];
}

// #9-#11. SiGA solo ofrece en el combo los períodos abiertos, y con GrabaLibro + proveedor que discrimina IVA
// PeriodosFiscales_UPosicion falla si el período no existe (DOC Anexo).
function validarPeriodo(ctx) {
  if (!ctx.tipo.grabaLibro && !ctx.tipo.generaContabilidad) return [];
  // SIGA-INFERIDO: extensión v1 — PeriodosFiscales_UPosicion fallaría al grabar (DOC Anexo); se valida antes con el texto de SiGA.
  if (!ctx.periodo) return error('periodoFiscal', 'El Período Fiscal del Comprobante NO esta habilitado.');
  if (ctx.periodo.fechaCierre) return error('periodoFiscal', 'El Período Fiscal del Comprobante se encuentra Cerrado.');
  return [];
}

function validarFechaEImporte(b, ctx, calculo) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || ''))) return error('fecha', 'v1: falta la fecha del comprobante.');
  if (!existeEnCalendario(b.fecha)) return error('fecha', `La fecha del comprobante (${b.fecha}) no existe en el calendario.`);
  // #12
  const minimo = Number(ctx.tipo.importeMinimo) || 0;
  if (calculo.totales.importeTotal < minimo) {
    return error('total', `El importe mínimo para el comprobante ${ctx.tipo.descripcion} es de ${N2.format(minimo)}.`);
  }
  // #13. SIGA-INFERIDO: ComprasPermiteFechaMayorHoy = false; sin stock SiGA pregunta, la v1 bloquea siempre.
  if (b.fecha > ctx.hoy) return error('fecha', 'La fecha del comprobante no puede ser mayor a hoy. Por favor reintente.');
  return [];
}

// #17-#20 (solo numeración manual). El duplicado acá es un aviso: el control que vale es el de repo.grabar, con lock.
function validarNumero(b, ctx) {
  if (modoNumeracion(ctx.tipo, ctx.ventasNumerosRelacionado) !== 'manual') return [];
  if (vacio(b.centroEmisor)) return error('centroEmisor', 'Debe cargar un el Número de Emisor.');
  if (!(Number(b.centroEmisor) > 0)) return error('centroEmisor', 'El Emisor no puede ser cero.');
  if (!Number.isInteger(Number(b.centroEmisor)) || Number(b.centroEmisor) > MAX_CENTRO_EMISOR) {
    return error('centroEmisor', `v1: el punto de venta tiene que ser un entero de hasta ${MAX_CENTRO_EMISOR}.`);
  }
  if (vacio(b.numeroComprobante)) return error('numeroComprobante', 'Debe cargar un el número del comprobante.');
  if (!(Number(b.numeroComprobante) > 0)) return error('numeroComprobante', 'El Número no puede ser cero.');
  if (!Number.isSafeInteger(Number(b.numeroComprobante))) return error('numeroComprobante', 'v1: el número del comprobante tiene que ser entero.');
  const duplicado = ctx.duplicado || {}; // sin dato de duplicado = no duplicado (el control que vale es el de grabar)
  if (duplicado.enCompras) return error('numeroComprobante', 'Este comprobante ya fue INGRESADO con ANTERIORIDAD');
  // Paso 2 de Reglas.Compras.Existe (L1643-1680) no replicado en v1: numeración compartida con ventas.
  if (ctx.numeracionCompartidaConVentas) {
    return error('centroEmisor', 'v1: el tipo, letra y punto de venta comparten numeración con ventas (VentasNumeros); cargalo desde SiGA.');
  }
  if (duplicado.enCtaCte) return error('numeroComprobante', 'Este comprobante ya EXISTE en Cuentas Corrientes de Proveedores');
  return [];
}

// #21-#22 + contado fuera de la v1 (spec).
function validarFormaPago(ctx) {
  const t = ctx.tipo;
  const fp = ctx.formaPago;
  if (!fp) return error('idFormasPago', 'Falta cargar la forma de pago del documento.');
  if (!t.actualizaCtaCte && fp.dias !== 0 && t.coeficienteStock === 0) {
    return error('idFormasPago', `No es posible registrar una ${t.descripcion} a cuenta corriente ya que la misma está configurada como que NO actualiza Cuenta Corriente.`);
  }
  if (fp.dias === 0) return error('idFormasPago', 'v1: las compras al contado no se importan (forma de pago con 0 días); cargala en SiGA.');
  return [];
}

// #23: el rubro sale del proveedor (DOC Parte I §2 punto 6).
function validarRubro(ctx) {
  return ctx.proveedor.idRubroCompra ? [] : error('idProveedor', 'Falta cargar el Rubro.');
}

// Precio y cantidad de una línea (§4.3). Lo no numérico se ataja primero: Number(null) y Number('') dan 0 y
// redondear() convierte NaN en 0, así que un dato roto terminaría grabado como 0 sin ningún aviso.
function validarPrecioYCantidad(l, campo) {
  // SIGA-INFERIDO: ComprasConProductosEnCero = false.
  if (vacio(l.precio)) return error(campo, 'No puede ingresar un producto con precio cero.');
  if (!esNumero(l.precio)) return error(campo, 'El precio no es un número válido.');
  if (!(Number(l.precio) > 0)) return error(campo, 'No puede ingresar un producto con precio cero.');
  // ValidarInsertaProducto L24298-24302: va después del precio y antes del "distinta de cero".
  if (vacio(l.cantidad)) return error(campo, 'No puede ingresar sin cantidad.');
  if (!esNumero(l.cantidad)) return error(campo, 'La cantidad no es un número válido.');
  if (Number(l.cantidad) === 0) return error(campo, 'La cantidad debe ser distinta de cero.');
  if (!(Number(l.cantidad) > 0)) return error(campo, 'La cantidad debe ser mayor a cero.');
  return [];
}

// DOC Parte I §4.3 (ValidarInsertaProducto L24274) + bloqueos v1 por línea.
function validarLinea(l, i, ctx) {
  const campo = `lineas[${i}]`;
  if (!l || typeof l !== 'object') return error(campo, 'v1: hay una línea vacía o inválida.');
  if (l.nuevo || /^NUEVO-/i.test(String(l.plu))) {
    return error(campo, `v1: el artículo ${l.nombre} todavía no existe en SIGA (${l.plu}); dalo de alta antes de importar.`);
  }
  const p = (ctx.productos || {})[l.plu];
  if (!p) return error(campo, `v1: el producto ${l.plu} no existe en SIGA.`);
  if (!p.activo) return error(campo, `v1: el producto ${l.plu} está inactivo en SIGA.`);
  if (String(p.idUnidadDeMedida || '').trim() !== String(p.idUnidadDeMedidaCompra || '').trim()) {
    return error(campo, `v1: el producto ${l.plu} tiene unidad de compra distinta de la de stock; cargalo en SiGA.`);
  }
  if (p.precioPorEmbalaje && !(Number(p.embalaje) > 0)) return error(campo, `v1: el producto ${l.plu} tiene PrecioPorEmbalaje sin embalaje cargado.`);
  return validarPrecioYCantidad(l, campo);
}

function validarLineas(b, ctx) {
  if (!Array.isArray(b.lineas)) return error('lineas', 'v1: el comprobante no tiene líneas.');
  if (!b.lineas.length) return error('lineas', 'Debe cargar como minimo un producto.'); // #25
  return b.lineas.flatMap((l, i) => validarLinea(l, i, ctx));
}

// Reglas.MovimientosStock L745-748 divide el último precio de los productos en dólares por Compra.CotizacionDolar
// (= FactorConversion en N2, Win L20046/L23459) sin control: con 0 SiGA rompe. La v1 lo bloquea antes.
function validarCotizacion(b, ctx) {
  const productos = ctx.productos || {};
  const hayEnDolares = Array.isArray(b.lineas)
    && b.lineas.some(l => l && productos[l.plu] && productos[l.plu].idMoneda === C.ID_MONEDA_DOLAR);
  if (!hayEnDolares || redondearLejosDelCero(ctx.cotizacionDolar, 2) > 0) return [];
  return error('cotizacionDolar', 'v1: la cotización del dólar es cero y hay productos en dólares.');
}

// #31.
const NEGATIVAS = {
  PIIBB: 'Las Percepciones de IIBB no pueden ser negativas.',
  PGANA: 'Las Percepciones de Ganancias no pueden ser negativas.',
  IMINT: 'Los Impuestos Internos no pueden ser negativos.',
};

// El importe es obligatorio; base imponible y alícuota son opcionales, pero si vienen tienen que ser números.
const CAMPOS_PERCEPCION = [
  { campo: 'importe', titulo: 'El importe', obligatorio: true },
  { campo: 'baseImponible', titulo: 'La base imponible', obligatorio: false },
  { campo: 'alicuota', titulo: 'La alícuota', obligatorio: false },
];

function percepcionNoNumerica(tipo, deTipo) {
  const mala = CAMPOS_PERCEPCION.find(({ campo, obligatorio }) => deTipo.some(p => (obligatorio || !vacio(p[campo])) && !esNumero(p[campo])));
  return mala ? error('percepciones', `${mala.titulo} de la percepción ${tipo} no es un número válido.`) : [];
}

const provinciaDe = p => String(p.idProvincia || '').trim();
const tieneMonto = p => Number(p.importe) !== 0 || Number(p.baseImponible || 0) !== 0;

function validarPercepcionesDeTipo(tipo, deTipo) {
  const noNumerica = percepcionNoNumerica(tipo, deTipo);
  if (noNumerica.length) return noNumerica;
  if (deTipo.some(p => Number(p.importe) < 0)) return error('percepciones', NEGATIVAS[tipo] || `v1: la percepción ${tipo} no puede ser negativa.`);
  if (tipo !== 'PIIBB') return deTipo.length > 1 ? error('percepciones', `v1: hay más de una percepción ${tipo}.`) : [];
  // Win L24187: una fila fija por provincia; no existe la provincia vacía. La fila toda en cero no se graba.
  if (deTipo.some(p => !provinciaDe(p) && tieneMonto(p))) return error('percepciones', 'v1: la percepción PIIBB necesita la provincia.');
  const provincias = deTipo.map(provinciaDe).filter(Boolean);
  const repetida = provincias.find((p, i) => provincias.indexOf(p) !== i);
  return repetida ? error('percepciones', `v1: hay dos percepciones PIIBB para la provincia ${repetida}.`) : [];
}

function validarPercepciones(b, ctx) {
  const lista = Array.isArray(b.percepciones) ? b.percepciones : [];
  if (lista.some(p => !p || typeof p !== 'object')) return error('percepciones', 'v1: hay una percepción vacía o inválida.');
  const desconocida = lista.find(p => !C.TIPOS_PERCEPCION.includes(p.tipo));
  if (desconocida) return error('percepciones', `v1: tipo de percepción desconocido: ${desconocida.tipo}.`);
  const cf = ctx.proveedor.categoriaFiscal;
  // DOC Parte I §2 punto 12: si el proveedor no discrimina IVA, la pantalla deja las percepciones en solo lectura.
  if (lista.some(tieneMonto) && !(cf && cf.ivaDiscriminado)) return error('percepciones', 'v1: el proveedor no discrimina IVA; SiGA no admite percepciones para él.');
  return C.TIPOS_PERCEPCION.flatMap(tipo => validarPercepcionesDeTipo(tipo, lista.filter(p => p.tipo === tipo)));
}

// calculo = calcularComprobante() de armar_comprobante.js (acá solo se usan totales.importeTotal y lineas[].porcentajeIVA).
function validarComprobante(borrador, ctx, calculo) {
  if (!ctx.proveedor) return error('idProveedor', 'Debe cargar un Proveedor.'); // #3
  if (!ctx.tipo) return error('idTipoComprobante', 'Falta cargar el tipo de Comprobante.'); // #6
  const delTipo = validarTipo(ctx);
  if (delTipo.length) return delTipo;
  const cf = ctx.proveedor.categoriaFiscal;
  return [
    ...validarProveedorFiscal(ctx),
    ...validarDestino(ctx),
    ...validarPeriodo(ctx),
    ...validarFechaEImporte(borrador, ctx, calculo),
    ...validarLetra({
      letra: borrador.letra, letrasHabilitadas: ctx.tipo.letrasHabilitadas,
      letraProveedor: cf ? cf.letraFiscalCompra : '', porcentajesIVA: calculo.lineas.map(l => l.porcentajeIVA),
    }),
    ...validarNumero(borrador, ctx),
    ...validarFormaPago(ctx),
    ...validarRubro(ctx),
    ...validarLineas(borrador, ctx),
    ...validarCotizacion(borrador, ctx),
    ...validarPercepciones(borrador, ctx),
  ];
}

module.exports = { validarComprobante, modoNumeracion, cuitValido };
