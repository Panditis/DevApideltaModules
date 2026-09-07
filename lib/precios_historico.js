'use strict';
// ── Consulta de precios históricos ────────────────────────────────────────────
// Para un mes, qué precio de venta tenía cada producto cada día.
//
// SIGA.HistorialPrecios guarda un registro por CAMBIO de precio, no uno por día:
// el precio de un día es el del último cambio con FechaHora <= ese día. Por eso
// el cálculo necesita dos entradas: los cambios de adentro del mes y el precio
// que venía vigente de antes (baseline), que es el que se arrastra hasta el
// primer cambio. Sin el baseline, todo producto que no tocó precio en el mes
// saldría vacío.
//
// Este archivo es sólo cálculo: las queries viven en server.js.

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
               'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const ANIO_MIN = 2021;   // HistorialPrecios arranca en marzo de 2021: antes no hay nada que mostrar.

const dosDig = n => String(n).padStart(2, '0');
const texto = v => String(v == null ? '' : v).trim();

// Trust boundary: el período llega del querystring y termina interpolado en SQL.
// Sólo dígitos: parseInt('2026; DROP TABLE') devolvería 2026 y dejaría pasar la cola.
const soloEntero = v => (/^\d{1,4}$/.test(texto(v)) ? Number(texto(v)) : NaN);
function validarPeriodo(anio, mes) {
  const a = soloEntero(anio);
  const m = soloEntero(mes);
  if (!Number.isInteger(a) || a < ANIO_MIN || a > 2100) {
    throw new Error(`Año inválido: tiene que ser un número entre ${ANIO_MIN} y 2100.`);
  }
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error('Mes inválido: tiene que ser un número entre 1 y 12.');
  }
  return { anio: a, mes: m };
}

const primerDia = (anio, mes) => `${anio}-${dosDig(mes)}-01`;
// Límite superior exclusivo del mes (enero del año siguiente cuando mes = 12).
const primerDiaSiguiente = (anio, mes) => (mes === 12 ? `${anio + 1}-01-01` : `${anio}-${dosDig(mes + 1)}-01`);

// Días del mes en ISO. Si el mes es el corriente se corta en `hoy`: los días que
// todavía no pasaron no tienen precio, y una columna vacía se lee como error.
function diasDelMes(anio, mes, hoy) {
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const dias = [];
  for (let d = 1; d <= ultimo; d++) dias.push(`${anio}-${dosDig(mes)}-${dosDig(d)}`);
  const corte = texto(hoy).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(corte) ? dias.filter(d => d <= corte) : dias;
}

// cambios: [{ plu, dia:'YYYY-MM-DD', precio }] del mes, en orden cronológico.
// Varios cambios el mismo día → vale el último: es el precio con el que cerró el día.
function precioPorDia(cambios) {
  const porPlu = new Map();
  for (const c of cambios || []) {
    const plu = texto(c.plu);
    const dia = texto(c.dia).slice(0, 10);
    const precio = Number(c.precio);
    if (!plu || !/^\d{4}-\d{2}-\d{2}$/.test(dia) || !Number.isFinite(precio)) continue;
    if (!porPlu.has(plu)) porPlu.set(plu, new Map());
    porPlu.get(plu).set(dia, precio);
  }
  return porPlu;
}

// baseline: [{ plu, precio }] con el último precio anterior al mes.
// vigentes: [{ plu, precio }] precio de lista de TODOS los productos. Es el último
//   valor conocido y se usa para los que no tienen ningún cambio registrado antes del
//   mes: sin cambios, ese precio rige todos los días.
// nombres:  Map o {} de plu → nombre de producto.
// Devuelve { dias, filas:[{ plu, nombre, precios:[n], cambios }] }.
// Entran todos los códigos, haya habido cambios de precio o no. El día sin precio
// conocido sale como 0, igual que un precio 0 real: para quien lee la planilla las dos
// cosas son "no vale nada ese día", y una celda vacía se lee como error de exportación.
function armarGrilla({ anio, mes, baseline = [], cambios = [], vigentes = [],
                       nombres = new Map(), hoy = null } = {}) {
  const dias = diasDelMes(anio, mes, hoy);
  const buscarNombre = plu => {
    const n = nombres instanceof Map ? nombres.get(plu) : nombres[plu];
    return texto(n);
  };

  const base = new Map();
  for (const b of baseline) {
    const plu = texto(b.plu);
    const precio = Number(b.precio);
    if (plu && Number.isFinite(precio)) base.set(plu, precio);
  }

  const porDia = precioPorDia(cambios);

  // Último valor conocido de cada producto: cuando no hay ningún cambio anterior al
  // mes, arranca con este precio y se arrastra. Un producto sin cambios queda con el
  // mismo precio todos los días, que es lo que efectivamente pasó.
  const fijos = new Map();
  for (const v of vigentes) {
    const plu = texto(v.plu);
    const precio = Number(v.precio);
    if (plu && Number.isFinite(precio)) fijos.set(plu, precio);
  }

  const plus = new Set([...base.keys(), ...porDia.keys(), ...fijos.keys()]);

  const filas = [];
  for (const plu of plus) {
    const delMes = porDia.get(plu) || new Map();
    // Prioridad: el historial manda. El precio de lista sólo cubre al producto que no
    // tiene ningún cambio registrado antes del mes.
    let vigente = base.has(plu) ? base.get(plu)
                : (!delMes.size && fijos.has(plu) ? fijos.get(plu) : null);
    const precios = dias.map(d => {
      if (delMes.has(d)) vigente = delMes.get(d);
      return vigente;
    });
    filas.push({
      plu, nombre: buscarNombre(plu) || `(sin nombre) ${plu}`,
      precios: precios.map(p => (p == null ? 0 : p)),
      cambios: delMes.size,
    });
  }

  // Por nombre, que es como se busca el producto; el PLU desempata.
  filas.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es') || a.plu.localeCompare(b.plu, 'es'));
  return { anio, mes, periodo: `${MESES[mes - 1]} ${anio}`, dias, filas };
}

const etiquetaDia = iso => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// ── Layout fijo del xlsx ──────────────────────────────────────────────────────
// La planilla la consume algo que espera SIEMPRE las mismas columnas: A = PLU,
// B = producto, C y D vacías, y los precios de E a AJ (32 columnas). Como ningún
// mes tiene 32 días, sobran slots: se rellenan AL PRINCIPIO repitiendo el precio
// del primer día, así AJ queda siempre en el último día del mes y E siempre es la
// primera columna de precio.
const COL_PRIMER_PRECIO = 5;    // E
const COL_ULTIMO_PRECIO = 36;   // AJ
const SLOTS_PRECIO = COL_ULTIMO_PRECIO - COL_PRIMER_PRECIO + 1;   // 32
const COLS_VACIAS = 2;          // C y D

// Índice de día que va en cada uno de los 32 slots: primero el relleno (día 0
// repetido), después los días reales. Si algún día el mes tuviera más días que
// slots, se recortan los primeros y AJ sigue siendo el último día.
function slotsDelMes(dias) {
  const total = (dias || []).length;
  if (!total) return [];
  const faltan = Math.max(0, SLOTS_PRECIO - total);
  const relleno = new Array(faltan).fill(0);
  const reales = dias.map((_, i) => i);
  return [...relleno, ...reales].slice(-SLOTS_PRECIO);
}

// Columna A del xlsx: el PLU va como número entero, no como texto (IdProducto es
// varchar en SIGA). Si alguna vez aparece uno alfanumérico se deja tal cual antes
// que escribir un NaN en la planilla.
const pluNumerico = plu => (/^\d+$/.test(texto(plu)) ? Number(texto(plu)) : texto(plu));

// Matriz para XLSX.utils.aoa_to_sheet. No sirve json_to_sheet acá: las columnas de
// relleno repiten la etiqueta del primer día y las claves duplicadas de un objeto
// se pisarían entre sí.
function hojaMatriz(grilla) {
  const dias = grilla.dias || [];
  const slots = slotsDelMes(dias);
  const vacias = new Array(COLS_VACIAS).fill('');
  const encabezado = ['PLU', 'Producto', ...vacias, ...slots.map(i => etiquetaDia(dias[i]))];
  const filas = (grilla.filas || []).map(f => [
    pluNumerico(f.plu), f.nombre, ...vacias,
    ...slots.map(i => (f.precios[i] == null ? 0 : f.precios[i])),
  ]);
  return [encabezado, ...filas];
}

// Anchos de columna del xlsx: sin esto el nombre del producto sale cortado y hay
// que ensanchar 30 columnas a mano en cada descarga.
function anchosHoja() {
  return [{ wch: 8 }, { wch: 46 }, ...new Array(COLS_VACIAS).fill({ wch: 4 }),
          ...new Array(SLOTS_PRECIO).fill({ wch: 10 })];
}

const nombreArchivo = grilla => `precios_historico_${grilla.anio}-${dosDig(grilla.mes)}.xlsx`;

module.exports = {
  MESES, ANIO_MIN, SLOTS_PRECIO, COL_PRIMER_PRECIO, COL_ULTIMO_PRECIO,
  validarPeriodo, primerDia, primerDiaSiguiente,
  diasDelMes, armarGrilla, slotsDelMes, hojaMatriz, anchosHoja, etiquetaDia, nombreArchivo,
};
