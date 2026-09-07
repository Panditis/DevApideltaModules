'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Importación de facturas de compra desde xlsx — parseo y validación pura.
//  Sin SQL ni I/O: recibe las matrices de las hojas y devuelve la compra armada
//  más la lista de errores. La resolución contra SIGA (productos, proveedor,
//  comprobante duplicado) la hace server.js con el resultado de acá.
//  Mapeo de tablas afectadas: docs/compras_siga_mapeo.md
// ─────────────────────────────────────────────────────────────────────────────

const ALICUOTAS_VALIDAS = [0, 10.5, 21, 27];
const DIAS_VENCIMIENTO_DEFAULT = 30;

// Tipos de comprobante de compra, con las letras que habilita cada uno en SIGA.
// `numeroDelProveedor` separa las dos familias:
//   true  → el comprobante lo emite el proveedor (factura, NC, ND). Letra, punto
//           de venta y número salen del papel: son obligatorios y no se generan.
//   false → comprobante interno (cotización de compra). Si no trae número, lo
//           asigna el sistema consultando el último usado.
const TIPOS_COMPRA = {
  FACTCOM:         { descripcion: 'Factura de compra',        letras: ['A', 'B', 'C', 'E', 'I', 'M'], numeroDelProveedor: true },
  FACTCOMLIQ:      { descripcion: 'Factura liquidación',      letras: ['A', 'B', 'C', 'E', 'I'],      numeroDelProveedor: true },
  NCREDCOM:        { descripcion: 'Nota de crédito de compra', letras: ['A', 'B', 'C', 'E', 'I'],     numeroDelProveedor: true },
  NDEBCOM:         { descripcion: 'Nota de débito de compra',  letras: ['A', 'B', 'C', 'E', 'I'],     numeroDelProveedor: true },
  COTIZACIONCOM:   { descripcion: 'Cotización de compra',     letras: ['X'], numeroDelProveedor: false },
  COTIZACIONNCCOM: { descripcion: 'NC de cotización',         letras: ['X'], numeroDelProveedor: false },
  COTIZACIONNDCOM: { descripcion: 'ND de cotización',         letras: ['X'], numeroDelProveedor: false },
};

const TIPOS_COMPROBANTE = Object.keys(TIPOS_COMPRA);
const LETRAS_VALIDAS    = [...new Set(Object.values(TIPOS_COMPRA).flatMap(t => t.letras))];

const CAMPOS_CABECERA = [
  { campo: 'IdProveedor',          tipo: 'entero',  obligatorio: true },
  { campo: 'TipoComprobante',      tipo: 'texto',   obligatorio: true },
  { campo: 'Letra',                tipo: 'texto',   obligatorio: true },
  { campo: 'PuntoVenta',           tipo: 'entero',  obligatorio: true },
  // Se puede dejar vacío: el servidor consulta SIGA y asigna el siguiente número
  // para esa sucursal + tipo + letra + punto de venta.
  { campo: 'NumeroComprobante',    tipo: 'entero',  obligatorio: false },
  { campo: 'FechaComprobante',     tipo: 'fecha',   obligatorio: true },
  { campo: 'IdSucursal',           tipo: 'entero',  obligatorio: true },
  { campo: 'IdDeposito',           tipo: 'entero',  obligatorio: true },
  { campo: 'IdUbicacion',          tipo: 'entero',  obligatorio: true },
  { campo: 'ImporteTotal',         tipo: 'decimal', obligatorio: false },
  { campo: 'FechaVencimiento',     tipo: 'fecha',   obligatorio: false },
  { campo: 'PercepcionIVA',        tipo: 'decimal', obligatorio: false, default: 0 },
  { campo: 'PercepcionIIBB',       tipo: 'decimal', obligatorio: false, default: 0 },
  { campo: 'PercepcionGanancias',  tipo: 'decimal', obligatorio: false, default: 0 },
  { campo: 'PercepcionVarias',     tipo: 'decimal', obligatorio: false, default: 0 },
  { campo: 'ImpuestosInternos',    tipo: 'decimal', obligatorio: false, default: 0 },
  { campo: 'Observacion',          tipo: 'texto',   obligatorio: false, default: '' },
];

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Compara nombres de campo/columna ignorando acentos, espacios y mayúsculas.
const norm = s => String(s == null ? '' : s)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[\s_.-]/g, '').toLowerCase();

const vacio = v => v == null || String(v).trim() === '';

// Acepta número de Excel o texto. Rechaza lo ambiguo en vez de adivinar:
// "1.234,56" y "1,234.56" tienen separador de miles y se descartan.
function aNumero(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (vacio(valor)) return null;
  let s = String(valor).trim().replace(/\s/g, '').replace(/^\$/, '');
  if (/[.,]\d{3}(?:[.,]|$)/.test(s) && /[.,].*[.,]/.test(s)) return null;
  if (s.includes(',')) {
    if (s.includes('.')) return null;
    s = s.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Serial de Excel (base 1899-12-30) o texto AAAA-MM-DD / DD-MM-AAAA.
function aFechaISO(valor) {
  if (vacio(valor)) return null;
  if (valor instanceof Date && !isNaN(valor)) return valor.toISOString().slice(0, 10);
  if (typeof valor === 'number' && valor > 0) {
    const ms = Math.round((valor - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(valor).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function sumarDiasISO(fechaISO, dias) {
  const d = new Date(fechaISO + 'T00:00:00Z');
  if (isNaN(d)) return null;
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ── Cabecera: matriz [Campo, Valor, ...] en vertical ─────────────────────────
function parsearCabecera(matriz) {
  const errores = [];
  const crudos = new Map();
  for (const fila of (matriz || [])) {
    if (!Array.isArray(fila) || vacio(fila[0])) continue;
    const clave = norm(fila[0]);
    if (clave === 'campo') continue;               // fila de títulos
    if (!crudos.has(clave)) crudos.set(clave, fila[1]);
  }

  const cabecera = {};
  for (const def of CAMPOS_CABECERA) {
    const bruto = crudos.get(norm(def.campo));
    if (vacio(bruto)) {
      if (def.obligatorio) errores.push(`Cabecera: falta "${def.campo}".`);
      cabecera[def.campo] = def.default !== undefined ? def.default : null;
      continue;
    }
    if (def.tipo === 'texto') {
      cabecera[def.campo] = String(bruto).trim();
    } else if (def.tipo === 'fecha') {
      const iso = aFechaISO(bruto);
      if (iso === null) errores.push(`Cabecera: "${def.campo}" no es una fecha válida (usar AAAA-MM-DD).`);
      cabecera[def.campo] = iso;
    } else {
      const n = aNumero(bruto);
      if (n === null) errores.push(`Cabecera: "${def.campo}" no es un número válido (sin $ ni separador de miles).`);
      else if (def.tipo === 'entero' && !Number.isInteger(n)) errores.push(`Cabecera: "${def.campo}" tiene que ser un número entero.`);
      cabecera[def.campo] = n;
    }
  }

  let tipo = null;
  if (cabecera.TipoComprobante) {
    cabecera.TipoComprobante = cabecera.TipoComprobante.toUpperCase();
    tipo = TIPOS_COMPRA[cabecera.TipoComprobante] || null;
    if (!tipo) errores.push(`Cabecera: TipoComprobante "${cabecera.TipoComprobante}" no es válido (${TIPOS_COMPROBANTE.join(', ')}).`);
  }

  if (cabecera.Letra) {
    cabecera.Letra = cabecera.Letra.toUpperCase();
    if (tipo && !tipo.letras.includes(cabecera.Letra)) {
      errores.push(`Cabecera: la letra "${cabecera.Letra}" no corresponde a ${cabecera.TipoComprobante} (habilitadas: ${tipo.letras.join(', ')}).`);
    } else if (!tipo && !LETRAS_VALIDAS.includes(cabecera.Letra)) {
      errores.push(`Cabecera: Letra "${cabecera.Letra}" no es válida (${LETRAS_VALIDAS.join(', ')}).`);
    }
  }

  // El número de una factura, NC o ND lo emite el proveedor: nunca se genera.
  if (tipo && tipo.numeroDelProveedor && cabecera.NumeroComprobante == null) {
    errores.push(`Cabecera: ${cabecera.TipoComprobante} es un comprobante del proveedor, así que "NumeroComprobante" es obligatorio (sale de la factura, no se genera).`);
  }
  if (tipo) cabecera.numeroDelProveedor = tipo.numeroDelProveedor;

  if (!cabecera.FechaVencimiento && cabecera.FechaComprobante) {
    cabecera.FechaVencimiento = sumarDiasISO(cabecera.FechaComprobante, DIAS_VENCIMIENTO_DEFAULT);
  }

  return { cabecera, errores };
}

// ── Detalle: matriz con fila de títulos + una fila por ítem ──────────────────
function parsearDetalle(matriz) {
  const errores = [];
  const filas = (matriz || []).filter(f => Array.isArray(f));
  if (!filas.length) return { lineas: [], errores: ['La hoja Detalle está vacía.'] };

  const titulos = filas[0].map(norm);
  const col = nombre => titulos.indexOf(norm(nombre));
  const idx = {
    plu:     col('PLU'),
    codProv: col('CodigoProveedor'),
    barras:  col('CodigoBarras'),
    cant:    col('Cantidad'),
    precio:  col('PrecioUnitario'),
    iva:     col('PorcentajeIVA'),
    desc:    col('Descripcion'),
  };

  for (const [clave, titulo] of [['cant', 'Cantidad'], ['precio', 'PrecioUnitario'], ['iva', 'PorcentajeIVA']]) {
    if (idx[clave] === -1) errores.push(`Detalle: falta la columna "${titulo}".`);
  }
  if (idx.plu === -1 && idx.codProv === -1 && idx.barras === -1) {
    errores.push('Detalle: hace falta al menos una columna de identificación (PLU, CodigoProveedor o CodigoBarras).');
  }
  if (errores.length) return { lineas: [], errores };

  const leer = (fila, i) => (i === -1 ? '' : fila[i]);
  const lineas = [];

  for (let f = 1; f < filas.length; f++) {
    const fila = filas[f];
    const nroFila = f + 1;                          // fila real de Excel
    const ident = {
      plu:     String(leer(fila, idx.plu) ?? '').trim(),
      codProv: String(leer(fila, idx.codProv) ?? '').trim(),
      barras:  String(leer(fila, idx.barras) ?? '').trim(),
    };
    // Corta en la primera fila sin ningún identificador: evita arrastrar
    // subtotales o filas sueltas del pie de la planilla.
    if (!ident.plu && !ident.codProv && !ident.barras) break;

    const cant   = aNumero(leer(fila, idx.cant));
    const precio = aNumero(leer(fila, idx.precio));
    const iva    = aNumero(leer(fila, idx.iva));

    if (cant === null)        errores.push(`Fila ${nroFila}: Cantidad no es un número válido.`);
    else if (cant <= 0)       errores.push(`Fila ${nroFila}: Cantidad tiene que ser mayor a 0.`);
    if (precio === null)      errores.push(`Fila ${nroFila}: PrecioUnitario no es un número válido.`);
    else if (precio < 0)      errores.push(`Fila ${nroFila}: PrecioUnitario no puede ser negativo.`);
    if (iva === null)         errores.push(`Fila ${nroFila}: PorcentajeIVA no es un número válido.`);
    else if (!ALICUOTAS_VALIDAS.includes(iva)) errores.push(`Fila ${nroFila}: PorcentajeIVA ${iva} no es una alícuota válida (${ALICUOTAS_VALIDAS.join(', ')}).`);

    lineas.push({
      fila: nroFila,
      orden: lineas.length + 1,
      plu: ident.plu || null,
      codigoProveedor: ident.codProv || null,
      codigoBarras: ident.barras || null,
      cantidad: cant,
      precioUnitario: precio,
      porcentajeIVA: iva,
      descripcion: String(leer(fila, idx.desc) ?? '').trim() || null,
      neto: cant !== null && precio !== null ? r2(cant * precio) : null,
    });
  }

  if (!lineas.length) errores.push('La hoja Detalle no tiene ítems.');
  return { lineas, errores };
}

// ── Totales: el IVA se agrupa por alícuota, igual que ComprasImpuestos ───────
function calcularTotales(cabecera, lineas) {
  const neto = r2(lineas.reduce((a, l) => a + (l.neto || 0), 0));

  const porAlicuota = new Map();
  for (const l of lineas) {
    if (l.porcentajeIVA == null || l.neto == null) continue;
    porAlicuota.set(l.porcentajeIVA, (porAlicuota.get(l.porcentajeIVA) || 0) + l.neto);
  }
  const impuestos = [...porAlicuota.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([alicuota, base]) => ({
      tipo: 'IVA', alicuota, baseImponible: r2(base), importe: r2(r2(base) * alicuota / 100),
    }));

  const percepciones = [
    { tipo: 'PIVA',  importe: r2(cabecera.PercepcionIVA || 0) },
    { tipo: 'PIIBB', importe: r2(cabecera.PercepcionIIBB || 0) },
    { tipo: 'PVAR',  importe: r2((cabecera.PercepcionVarias || 0) + (cabecera.PercepcionGanancias || 0)) },
    { tipo: 'IMINT', importe: r2(cabecera.ImpuestosInternos || 0) },
  ].filter(p => p.importe !== 0);

  for (const p of percepciones) impuestos.push({ tipo: p.tipo, alicuota: 0, baseImponible: 0, importe: p.importe });

  const totalIVA = r2(impuestos.filter(i => i.tipo === 'IVA').reduce((a, i) => a + i.importe, 0));
  const totalPercepciones = r2(percepciones.reduce((a, p) => a + p.importe, 0));
  const total = r2(neto + totalIVA + totalPercepciones);

  return { neto, totalIVA, totalPercepciones, total, impuestos };
}

// ── Formato plano: una sola hoja, cabecera y detalle en columnas ─────────────
// Cada fila es un ítem y repite los datos de la factura. Alcanza con completar
// la cabecera en la primera fila: las de abajo pueden ir vacías. Lo que no se
// tolera es que dos filas declaren valores distintos, porque sería mezclar
// dos comprobantes en un mismo archivo.
const COLUMNAS_DETALLE = ['PLU', 'CodigoProveedor', 'CodigoBarras', 'Cantidad', 'PrecioUnitario', 'PorcentajeIVA', 'Descripcion'];

function parsearPlano(matriz) {
  const filas = (matriz || []).filter(f => Array.isArray(f) && f.some(c => !vacio(c)));
  if (!filas.length) return { matrizCabecera: [], matrizDetalle: [], errores: ['El archivo está vacío.'] };

  const titulos = filas[0].map(norm);
  const errores = [];

  // Columnas de identificación: definen dónde termina el detalle.
  const idsDetalle = ['PLU', 'CodigoProveedor', 'CodigoBarras']
    .map(c => titulos.indexOf(norm(c))).filter(i => i !== -1);

  const filasItem = [];
  for (let f = 1; f < filas.length; f++) {
    const tieneIdent = idsDetalle.some(i => !vacio(filas[f][i]));
    if (!tieneIdent) break;                       // corta en la primera fila sin identificador
    filasItem.push(filas[f]);
  }

  // Cabecera: primer valor no vacío de cada columna, controlando contradicciones.
  const matrizCabecera = [['Campo', 'Valor']];
  for (const def of CAMPOS_CABECERA) {
    const col = titulos.indexOf(norm(def.campo));
    if (col === -1) continue;
    const valores = filasItem.map(f => f[col]).filter(v => !vacio(v));
    if (!valores.length) continue;
    const distintos = [...new Set(valores.map(v => String(v).trim()))];
    if (distintos.length > 1) {
      errores.push(`La columna "${def.campo}" tiene valores distintos entre filas (${distintos.slice(0, 3).join(', ')}): un archivo es una sola factura.`);
    }
    matrizCabecera.push([def.campo, valores[0]]);
  }

  // Detalle: la misma matriz recortada a las columnas de ítem.
  const colsDet = COLUMNAS_DETALLE.map(c => ({ nombre: c, i: titulos.indexOf(norm(c)) })).filter(c => c.i !== -1);
  const matrizDetalle = [colsDet.map(c => c.nombre)];
  for (const f of filasItem) matrizDetalle.push(colsDet.map(c => f[c.i]));

  return { matrizCabecera, matrizDetalle, errores };
}

// ── Entrada principal ────────────────────────────────────────────────────────
// Acepta el formato plano ({ matriz }) o el de dos hojas ({ matrizCabecera, matrizDetalle }).
function parsearCompra(entrada) {
  let { matrizCabecera, matrizDetalle } = entrada;
  let erroresFormato = [];
  if (entrada.matriz) {
    const plano = parsearPlano(entrada.matriz);
    matrizCabecera = plano.matrizCabecera;
    matrizDetalle = plano.matrizDetalle;
    erroresFormato = plano.errores;
  }

  const cab = parsearCabecera(matrizCabecera);
  const det = parsearDetalle(matrizDetalle);
  const errores = [...erroresFormato, ...cab.errores, ...det.errores];
  const avisos = [];

  const totales = calcularTotales(cab.cabecera, det.lineas);

  // El ImporteTotal de la planilla es un control: si no coincide, algo se cargó mal.
  const declarado = cab.cabecera.ImporteTotal;
  if (declarado != null && Math.abs(r2(declarado) - totales.total) >= 0.01) {
    errores.push(`El ImporteTotal declarado (${r2(declarado)}) no coincide con el calculado (${totales.total}).`);
  }
  if (declarado == null) avisos.push('La planilla no trae ImporteTotal: no se puede verificar contra el total de la factura.');

  // Sólo los comprobantes internos se autonumeran; en una factura la falta del
  // número ya quedó registrada como error en parsearCabecera.
  if (cab.cabecera.NumeroComprobante == null && cab.cabecera.numeroDelProveedor === false) {
    cab.cabecera.numeroAutomatico = true;
    avisos.push('Sin NumeroComprobante: lo asigna el sistema al momento de cargar.');
  }

  const conCodProv = det.lineas.filter(l => !l.plu && l.codigoProveedor).length;
  const conBarras  = det.lineas.filter(l => !l.plu && !l.codigoProveedor && l.codigoBarras).length;
  if (conCodProv) avisos.push(`${conCodProv} ítem(s) sin PLU: se resuelven por código de proveedor.`);
  if (conBarras)  avisos.push(`${conBarras} ítem(s) sin PLU ni código de proveedor: se resuelven por código de barras.`);

  return { cabecera: cab.cabecera, lineas: det.lineas, totales, errores, avisos, valido: errores.length === 0 };
}

module.exports = {
  parsearCompra, parsearPlano, parsearCabecera, parsearDetalle, calcularTotales,
  aNumero, aFechaISO, sumarDiasISO,
  ALICUOTAS_VALIDAS, TIPOS_COMPRA, TIPOS_COMPROBANTE, LETRAS_VALIDAS, CAMPOS_CABECERA, COLUMNAS_DETALLE, DIAS_VENCIMIENTO_DEFAULT,
};
