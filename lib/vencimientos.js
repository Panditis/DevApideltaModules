// Control de vencimientos (Sucursales), Etapa 1: lotes compartidos (IdProducto + vencimiento) con columnas
// por sucursal, movimientos manuales, semáforo configurable y persistencia JSON atómica con cola.
// La autorización (admin, sucursal propia) la resuelve la ruta; acá solo las operaciones.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { esSucursalReal } = require('./sucursales_no_reales');

const UMBRALES_DEFAULT = Object.freeze({ rojo: 15, amarillo: 45 });
const MS_POR_DIA = 24 * 60 * 60 * 1000;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS_MOVIMIENTO = Object.freeze(['oferta', 'vendido', 'vencido']);

function errorValidacion(mensaje) {
  const err = new Error(mensaje);
  err.status = 400;
  return err;
}

function validarFecha(fecha, campo) {
  if (typeof fecha !== 'string' || !FECHA_RE.test(fecha)) throw errorValidacion(`${campo} debe ser una fecha YYYY-MM-DD`);
  const d = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha) throw errorValidacion(`${campo} no es una fecha válida`);
  return fecha;
}

function validarEntero(valor, campo, minimo) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < minimo) throw errorValidacion(`${campo} debe ser un entero mayor o igual a ${minimo}`);
  return n;
}

function validarSucursal(idSucursal) {
  const id = validarEntero(idSucursal, 'idSucursal', 1);
  if (!esSucursalReal(id)) throw errorValidacion(`La sucursal ${id} no es real y no participa del control de vencimientos`);
  return String(id);
}

function validarUsuario(usuario) {
  if (typeof usuario !== 'string' || !usuario.trim()) throw errorValidacion('usuario es requerido');
  return usuario.trim();
}

// Snapshot opcional del producto (nombre/código de SIGA al momento del alta).
function textoOpcional(valor, campo, max) {
  if (valor === undefined || valor === null || valor === '') return undefined;
  if (typeof valor !== 'string' && typeof valor !== 'number') throw errorValidacion(`${campo} debe ser texto`);
  const t = String(valor).trim();
  if (t.length > max) throw errorValidacion(`${campo} supera ${max} caracteres`);
  return t || undefined;
}

function validarUmbrales(umbrales) {
  const rojo = validarEntero(umbrales && umbrales.rojo, 'Umbral rojo', 0);
  const amarillo = validarEntero(umbrales && umbrales.amarillo, 'Umbral amarillo', 0);
  if (rojo >= amarillo) throw errorValidacion('El umbral rojo debe ser menor que el amarillo');
  return { rojo, amarillo };
}

// Cruce SIGA (Etapa 2): tipos y depósito de los movimientos, días de aviso (default = umbral rojo)
// y margen de la ventana de fechas.
const CRUCE_DEFAULT = Object.freeze({ tipoOferta: 'PARA OFERTA', tipoNoVendido: 'VENCIDO', depositoMovimientos: 1, margenDias: 7, diasMaxOferta: 10, tipoOfertaVencida: 'OFERTA VENCIDO', diasMaxVencido: 10 });

function configCompleta(guardada) {
  const umbrales = { ...UMBRALES_DEFAULT, ...guardada.umbrales };
  const cruce = Object.fromEntries(Object.keys(CRUCE_DEFAULT).map(k => [k, guardada[k] ?? CRUCE_DEFAULT[k]]));
  return { umbrales, ...cruce, diasAviso: guardada.diasAviso ?? umbrales.rojo };
}

function validarTipo(valor, campo) {
  if (typeof valor !== 'string' || !valor.trim() || valor.trim().length > 50) throw errorValidacion(`${campo} debe ser texto no vacío de hasta 50 caracteres`);
  return valor.trim();
}

function validarConfig(c) {
  const v = {};
  if (c.umbrales !== undefined) v.umbrales = validarUmbrales(c.umbrales);
  if (c.tipoOferta !== undefined) v.tipoOferta = validarTipo(c.tipoOferta, 'tipoOferta');
  if (c.tipoNoVendido !== undefined) v.tipoNoVendido = validarTipo(c.tipoNoVendido, 'tipoNoVendido');
  if (c.depositoMovimientos !== undefined) v.depositoMovimientos = validarEntero(c.depositoMovimientos, 'depositoMovimientos', 1);
  if (c.diasAviso !== undefined) v.diasAviso = validarEntero(c.diasAviso, 'diasAviso', 0);
  if (c.margenDias !== undefined) v.margenDias = validarEntero(c.margenDias, 'margenDias', 0);
  if (c.tipoOfertaVencida !== undefined) v.tipoOfertaVencida = validarTipo(c.tipoOfertaVencida, 'tipoOfertaVencida');
  for (const campo of ['diasMaxOferta', 'diasMaxVencido']) {
    if (c[campo] === undefined) continue;
    v[campo] = validarEntero(c[campo], campo, 1);
    if (v[campo] > 365) throw errorValidacion(`${campo} no puede superar 365`);
  }
  if (!Object.keys(v).length) throw errorValidacion('No hay cambios de configuración');
  return v;
}

// Días enteros desde hoy (fecha local YYYY-MM-DD) hasta el vencimiento; negativo = vencido.
function diasParaVencer(vencimiento, hoy) {
  return Math.round((Date.parse(`${vencimiento}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / MS_POR_DIA);
}

function semaforo(vencimiento, hoy, umbrales = UMBRALES_DEFAULT) {
  const dias = diasParaVencer(vencimiento, hoy);
  if (dias <= umbrales.rojo) return 'rojo';
  if (dias <= umbrales.amarillo) return 'amarillo';
  return 'verde';
}

const sumaLista = lista => (lista || []).reduce((t, o) => t + (Number(o.cantidad) || 0), 0);
// Vencido efectivo = manual (lotes viejos sin `vencido`: 0) + movimientos OFERTA VENCIDO asignados.
const vencidoEfectivo = col => (col.vencido || 0) + sumaLista(col.vencidosSistema);

function pendiente(col) {
  return col.unidades - col.vendido - vencidoEfectivo(col);
}

function estadoSucursal(col) {
  return pendiente(col) <= 0 ? 'cerrado' : 'cargado';
}

function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// --- Persistencia ---------------------------------------------------------

async function leerJSON(ruta, vacio) {
  try {
    return JSON.parse(await fs.readFile(ruta, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return vacio;
    throw new Error(`No se pudo leer ${path.basename(ruta)}: ${err.message}`);
  }
}

async function escribirAtomico(ruta, datos) {
  const tmp = `${ruta}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(datos, null, 2), 'utf8');
  try {
    await fs.rename(tmp, ruta);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// --- Operaciones puras sobre el estado (devuelven estado nuevo) ------------

function colNueva(unidades, usuario, fecha) {
  return { unidades, vendido: 0, vencido: 0, oferta: 0, movimientos: [{ tipo: 'alta', unidades, usuario, fecha }] };
}

function reemplazarLote(datos, lote) {
  return { ...datos, lotes: datos.lotes.map(l => (l.id === lote.id ? lote : l)) };
}

function buscarLote(datos, idLote) {
  const lote = datos.lotes.find(l => l.id === idLote);
  if (!lote) throw Object.assign(new Error('Lote inexistente'), { status: 404 });
  return lote;
}

function buscarColumna(lote, suc) {
  const col = lote.sucursales[suc];
  if (!col) throw Object.assign(new Error(`La sucursal ${suc} no tiene unidades en este lote`), { status: 404 });
  return col;
}

function conColumna(lote, suc, col) {
  return { ...lote, sucursales: { ...lote.sucursales, [suc]: col } };
}

function opAlta(datos, entrada, fecha) {
  const idProducto = validarEntero(entrada.idProducto, 'idProducto', 1);
  const vencimiento = validarFecha(entrada.vencimiento, 'vencimiento');
  const suc = validarSucursal(entrada.idSucursal);
  const unidades = validarEntero(entrada.unidades, 'unidades', 1);
  const usuario = validarUsuario(entrada.usuario);
  const nombre = textoOpcional(entrada.nombre, 'nombre', 200);
  const codigo = textoOpcional(entrada.codigo, 'codigo', 50);
  const existente = datos.lotes.find(l => l.idProducto === idProducto && l.vencimiento === vencimiento);
  if (!existente) {
    const lote = { id: crypto.randomUUID(), idProducto, vencimiento, ...(nombre && { nombre }), ...(codigo && { codigo }), creado: fecha, sucursales: { [suc]: colNueva(unidades, usuario, fecha) } };
    return { datos: { ...datos, lotes: [...datos.lotes, lote] }, lote };
  }
  if (existente.sucursales[suc]) throw Object.assign(new Error('La sucursal ya cargó este lote; corregí sus unidades'), { status: 409 });
  const lote = conColumna(existente, suc, colNueva(unidades, usuario, fecha));
  return { datos: reemplazarLote(datos, lote), lote };
}

function opCorregir(datos, entrada, fecha) {
  const lote = buscarLote(datos, entrada.idLote);
  const suc = validarSucursal(entrada.idSucursal);
  const col = buscarColumna(lote, suc);
  const unidades = validarEntero(entrada.unidades, 'unidades', 0);
  const usuario = validarUsuario(entrada.usuario);
  if (unidades < col.oferta || unidades < col.vendido + vencidoEfectivo(col)) throw errorValidacion('Las unidades no pueden quedar por debajo de lo ofertado o de lo vendido + vencido');
  const mov = { tipo: 'correccion', anterior: col.unidades, unidades, usuario, fecha };
  // Sin oferta, las unidades son la base de vencidos: si cambian, la decisión de vencidos ya no vale.
  const base = unidades !== col.unidades && !(col.ofertasSistema || []).length ? sinClaves(col, ['vencidoDecision']) : col;
  const nuevo = conColumna(lote, suc, { ...base, unidades, movimientos: [...col.movimientos, mov] });
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

// Oferta es acumulado independiente (<= unidades); vendido + vencido juntos no superan unidades.
function opMovimiento(datos, entrada, fecha) {
  if (!TIPOS_MOVIMIENTO.includes(entrada.tipo)) throw errorValidacion("tipo debe ser 'oferta', 'vendido' o 'vencido'");
  const lote = buscarLote(datos, entrada.idLote);
  const suc = validarSucursal(entrada.idSucursal);
  const col = buscarColumna(lote, suc);
  const cantidad = validarEntero(entrada.cantidad, 'cantidad', 1);
  const usuario = validarUsuario(entrada.usuario);
  const total = (col[entrada.tipo] || 0) + cantidad;
  if (total > col.unidades) throw errorValidacion(`El ${entrada.tipo} acumulado (${total}) supera las unidades del lote (${col.unidades})`);
  if (entrada.tipo !== 'oferta' && cantidad > pendiente(col)) throw errorValidacion(`Vendido + vencido superaría las unidades del lote (${col.unidades}); pendiente ${pendiente(col)}`);
  const mov = { tipo: entrada.tipo, cantidad, usuario, fecha };
  const nuevo = conColumna(lote, suc, { ...col, [entrada.tipo]: total, movimientos: [...col.movimientos, mov] });
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

// Migración al leer: el viejo `ofertaSistema` (objeto) pasa a `ofertasSistema` (array) y se quita la clave.
function normalizarColumna(col) {
  if (!col || (Array.isArray(col.ofertasSistema) && !('ofertaSistema' in col))) return col;
  const { ofertaSistema, ...resto } = col;
  return { ...resto, ofertasSistema: Array.isArray(col.ofertasSistema) ? col.ofertasSistema : (ofertaSistema ? [ofertaSistema] : []) };
}

function normalizarDatos(datos) {
  return { ...datos, lotes: (datos.lotes || []).map(l => ({ ...l, sucursales: Object.fromEntries(Object.entries(l.sucursales || {}).map(([s, c]) => [s, normalizarColumna(c)])) })) };
}

const CONFIRMACIONES = ['ok', 'corregir'];
// Base de vencidos: total de oferta si el registro pasó por oferta; si no, las unidades cargadas.
const baseVencido = col => ((col.ofertasSistema || []).length ? sumaLista(col.ofertasSistema) : col.unidades);

// Movimientos de SIGA asignados al registro, por clase. Oferta se compara contra las unidades; vencido
// contra baseVencido. Cambiar la lista de oferta invalida también la decisión de vencidos.
const CLASES = Object.freeze({
  oferta: { lista: 'ofertasSistema', decision: 'ofertaDecision', base: col => col.unidades, campoBase: 'unidades', limpiar: ['ofertaDecision', 'vencidoDecision'] },
  vencido: { lista: 'vencidosSistema', decision: 'vencidoDecision', base: baseVencido, campoBase: 'base', limpiar: ['vencidoDecision'] },
});

function sinClaves(col, claves) {
  return Object.fromEntries(Object.entries(col).filter(([k]) => !claves.includes(k)));
}

// 'ok' derivado si la suma de movimientos coincide con la base; si no, la decisión manual guardada (o null).
function estadoClase(col, clase) {
  const c = CLASES[clase];
  if (!col || !(col[c.lista] || []).length) return null;
  if (sumaLista(col[c.lista]) === c.base(col)) return 'ok';
  return CONFIRMACIONES.includes(col[c.decision]) ? col[c.decision] : null;
}
const ofertaEstado = col => estadoClase(col, 'oferta');
const vencidoEstado = col => estadoClase(col, 'vencido');

// Vista para respuestas: expone los estados derivados y oculta las decisiones.
function vistaColumna(col) {
  return { ...sinClaves(col, ['ofertaDecision', 'vencidoDecision']), ofertasSistema: col.ofertasSistema || [], ofertaEstado: ofertaEstado(col),
    vencidosSistema: col.vencidosSistema || [], vencidoEstado: vencidoEstado(col), vencidoBase: baseVencido(col) };
}
function vistaLote(lote) {
  return { ...lote, sucursales: Object.fromEntries(Object.entries(lote.sucursales || {}).map(([s, c]) => [s, vistaColumna(c)])) };
}

const movConfirmacion = (clase, col, estado, usuario, fecha) =>
  ({ tipo: `${clase}-confirmacion`, estado, cantidadSistema: sumaLista(col[CLASES[clase].lista]), [CLASES[clase].campoBase]: CLASES[clase].base(col), usuario, fecha });

function registro(datos, entrada) {
  const lote = buscarLote(datos, entrada.idLote);
  const suc = validarSucursal(entrada.idSucursal);
  return { lote, suc, col: buscarColumna(lote, suc), usuario: validarUsuario(entrada.usuario) };
}

// Agrega movimientos de SIGA (ya revalidados por la ruta) a la lista de la clase, todo o nada.
// Cada movimiento (sucursal + producto + número) va a un solo registro; los ya asignados acá se ignoran.
// Si la suma resultante no coincide con la base, `confirmacion` ('ok'|'corregir') es obligatoria.
function opAsignarSistema(clase, datos, entrada, fecha) {
  const c = CLASES[clase];
  const { lote, suc, col, usuario } = registro(datos, entrada);
  const lista = entrada.movimientos || [entrada.movimiento];
  const actuales = col[c.lista] || [];
  const nuevos = lista.filter(m => !actuales.some(o => o.numeroMovimiento === m.numeroMovimiento));
  if (!nuevos.length && entrada.confirmacion === undefined) return { datos, lote }; // repetir es idempotente
  for (const { numeroMovimiento } of nuevos) {
    const otro = datos.lotes.find(l => l.id !== lote.id && l.idProducto === lote.idProducto && (l.sucursales[suc]?.[c.lista] || []).some(o => o.numeroMovimiento === numeroMovimiento));
    if (otro) throw Object.assign(new Error(`El movimiento ${numeroMovimiento} ya está asignado a otro registro (vence ${otro.vencimiento})`), { status: 409 });
  }
  const agregados = nuevos.map(m => ({ numeroMovimiento: m.numeroMovimiento, fecha: m.fecha, cantidad: m.cantidad, asignado: fecha, usuario }));
  const movs = nuevos.map(m => ({ tipo: `${clase}-sistema`, numeroMovimiento: m.numeroMovimiento, cantidad: m.cantidad, usuario, fecha }));
  // Si la lista cambia se limpia lo que dependía de ella (en oferta, también la decisión de vencidos).
  const tentativa = { ...sinClaves(col, nuevos.length ? c.limpiar : [c.decision]), [c.lista]: [...actuales, ...agregados] };
  let final;
  if (sumaLista(tentativa[c.lista]) === c.base(tentativa)) {
    final = { ...tentativa, movimientos: [...col.movimientos, ...movs] };
  } else if (entrada.sinConfirmar) {
    final = { ...tentativa, movimientos: [...col.movimientos, ...movs] }; // decisión pendiente: la UI muestra "Confirmar"
  } else {
    if (!CONFIRMACIONES.includes(entrada.confirmacion)) throw errorValidacion('Falta confirmar las cantidades');
    final = { ...tentativa, [c.decision]: entrada.confirmacion,
      movimientos: [...col.movimientos, ...movs, movConfirmacion(clase, tentativa, entrada.confirmacion, usuario, fecha)] };
  }
  const nuevo = conColumna(lote, suc, final);
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

// Decide o cambia la decisión de un registro cuyos movimientos no suman la base.
function opConfirmar(clase, datos, entrada, fecha) {
  const c = CLASES[clase];
  const { lote, suc, col, usuario } = registro(datos, entrada);
  if (!CONFIRMACIONES.includes(entrada.confirmacion)) throw errorValidacion("confirmacion debe ser 'ok' o 'corregir'");
  if (!(col[c.lista] || []).length) throw errorValidacion(`El registro no tiene movimientos de ${clase} asignados`);
  if (sumaLista(col[c.lista]) === c.base(col)) throw errorValidacion('Las cantidades coinciden: no hace falta confirmar');
  const nuevo = conColumna(lote, suc, { ...col, [c.decision]: entrada.confirmacion,
    movimientos: [...col.movimientos, movConfirmacion(clase, col, entrada.confirmacion, usuario, fecha)] });
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

// Con numeroMovimiento quita solo ese; sin él, todos. La suma cambió: hay que volver a decidir.
function opQuitarSistema(clase, datos, entrada, fecha) {
  const c = CLASES[clase];
  const { lote, suc, col, usuario } = registro(datos, entrada);
  const actuales = col[c.lista] || [];
  const n = entrada.numeroMovimiento;
  const quitar = n === undefined ? actuales : actuales.filter(o => o.numeroMovimiento === n);
  if (!quitar.length) {
    throw Object.assign(new Error(n === undefined ? `El registro no tiene movimientos de ${clase} asignados` : `El movimiento ${n} no está asignado a este registro`), { status: 404 });
  }
  const movs = quitar.map(o => ({ tipo: `${clase}-sistema-quitada`, numeroMovimiento: o.numeroMovimiento, usuario, fecha }));
  const nuevo = conColumna(lote, suc, { ...sinClaves(col, c.limpiar), [c.lista]: actuales.filter(o => !quitar.includes(o)), movimientos: [...col.movimientos, ...movs] });
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

// Alta de un registro a partir de un movimiento de SIGA sin asignar (ya revalidado por la ruta):
// unidades = entrada.unidades (oferta) o cantidad del movimiento (vencido) y se le asigna en la misma operación (todo o nada).
function opAltaDesdeMovimiento(datos, entrada, fecha) {
  const c = CLASES[entrada.clase];
  if (!c) throw errorValidacion("clase debe ser 'oferta' o 'vencido'");
  const idProducto = validarEntero(entrada.idProducto, 'idProducto', 1);
  const suc = validarSucursal(entrada.idSucursal);
  const vencimiento = validarFecha(entrada.vencimiento, 'vencimiento');
  const m = entrada.movimiento;
  const delProducto = datos.lotes.filter(l => l.idProducto === idProducto && l.sucursales[suc]);
  const asignado = delProducto.find(l => Object.values(CLASES).some(k => (l.sucursales[suc][k.lista] || []).some(o => o.numeroMovimiento === m.numeroMovimiento)));
  if (asignado) throw Object.assign(new Error(`El movimiento ${m.numeroMovimiento} ya está asignado a otro registro (vence ${asignado.vencimiento})`), { status: 409 });
  if (delProducto.some(l => l.vencimiento === vencimiento)) throw Object.assign(new Error('Ya hay un registro de este producto con ese vencimiento en tu sucursal'), { status: 409 });
  // Oferta: unidades declaradas por el usuario; si no suman, queda sin decidir (flujo normal de confirmación).
  const unidades = entrada.unidades !== undefined ? entrada.unidades : m.cantidad;
  const alta = opAlta(datos, { ...entrada, unidades }, fecha);
  const marcado = conColumna(alta.lote, suc, { ...alta.lote.sucursales[suc], origenSistema: true });
  return opAsignarSistema(entrada.clase, reemplazarLote(alta.datos, marcado), { idLote: marcado.id, idSucursal: suc, movimientos: [m], usuario: entrada.usuario, sinConfirmar: true }, fecha);
}

function opBaja(datos, idLote) {
  const lote = buscarLote(datos, idLote);
  return { datos: { ...datos, lotes: datos.lotes.filter(l => l.id !== idLote) }, lote };
}

// Quita el registro de una sucursal (con su historial y movimientos de SIGA asignados, que quedan libres).
// Si el lote queda sin sucursales se borra entero, liberando producto+vencimiento.
function opEliminarRegistro(datos, entrada) {
  const lote = buscarLote(datos, entrada.idLote);
  const suc = validarSucursal(entrada.idSucursal);
  const col = buscarColumna(lote, suc);
  const sucursales = Object.fromEntries(Object.entries(lote.sucursales).filter(([s]) => s !== suc));
  const loteEliminado = !Object.keys(sucursales).length;
  const lotes = loteEliminado ? datos.lotes.filter(l => l.id !== lote.id) : datos.lotes.map(l => (l.id === lote.id ? { ...lote, sucursales } : l));
  return { datos: { ...datos, lotes }, lote: { idLote: lote.id, idProducto: lote.idProducto, idSucursal: Number(suc), loteEliminado, movimientos: (col.movimientos || []).length } };
}

// --- Store con cola -------------------------------------------------------

// ponytail: un JSON único y una cola global por store; pasar a SQL si crece a miles de lotes.
function crearStore({ rutaDatos, rutaConfig }) {
  if (!rutaDatos || !rutaConfig) throw new Error('crearStore: rutaDatos y rutaConfig son requeridas');
  let cola = Promise.resolve();
  const encolar = tarea => {
    const r = cola.then(tarea);
    cola = r.catch(() => {});
    return r;
  };
  const leerDatos = async () => normalizarDatos(await leerJSON(rutaDatos, { lotes: [] }));
  const mutar = op => encolar(async () => {
    const { datos, lote } = op(await leerDatos(), new Date().toISOString());
    await escribirAtomico(rutaDatos, datos);
    return lote;
  });
  const leerConfig = async () => configCompleta(await leerJSON(rutaConfig, {}));

  return {
    listarLotes: () => encolar(leerDatos).then(d => d.lotes),
    altaLote: entrada => mutar((d, f) => opAlta(d, entrada, f)),
    corregirUnidades: entrada => mutar((d, f) => opCorregir(d, entrada, f)),
    registrarMovimiento: entrada => mutar((d, f) => opMovimiento(d, entrada, f)),
    // clase: 'oferta' | 'vencido'
    asignarSistema: (clase, entrada) => mutar((d, f) => opAsignarSistema(clase, d, entrada, f)),
    quitarSistema: (clase, entrada) => mutar((d, f) => opQuitarSistema(clase, d, entrada, f)),
    confirmarSistema: (clase, entrada) => mutar((d, f) => opConfirmar(clase, d, entrada, f)),
    // ponytail: alias de oferta que usan los tests existentes
    asignarOfertaSistema: entrada => mutar((d, f) => opAsignarSistema('oferta', d, entrada, f)),
    quitarOfertaSistema: entrada => mutar((d, f) => opQuitarSistema('oferta', d, entrada, f)),
    confirmarOferta: entrada => mutar((d, f) => opConfirmar('oferta', d, entrada, f)),
    // { clase, idProducto, vencimiento, idSucursal, usuario, nombre?, codigo?, movimiento: { numeroMovimiento, fecha, cantidad } }
    altaDesdeMovimiento: entrada => mutar((d, f) => opAltaDesdeMovimiento(d, entrada, f)),
    bajaLote: idLote => mutar(d => opBaja(d, idLote)),
    // Devuelve { idLote, idProducto, idSucursal, loteEliminado, movimientos } (no el lote).
    eliminarRegistro: entrada => mutar(d => opEliminarRegistro(d, entrada)),
    leerConfig: () => encolar(leerConfig),
    // Cambios parciales: { umbrales?, tipoOferta?, tipoNoVendido?, depositoMovimientos?, diasAviso?, margenDias?, diasMaxOferta?, tipoOfertaVencida?, diasMaxVencido? }.
    guardarConfig: cambios => {
      const validos = validarConfig(cambios || {});
      return encolar(async () => {
        const nueva = { ...(await leerJSON(rutaConfig, {})), ...validos };
        await escribirAtomico(rutaConfig, nueva);
        return configCompleta(nueva);
      });
    },
  };
}

module.exports = {
  UMBRALES_DEFAULT,
  crearStore,
  semaforo,
  diasParaVencer,
  pendiente,
  estadoSucursal,
  ofertaEstado,
  vencidoEstado,
  baseVencido,
  vencidoEfectivo,
  vistaLote,
  validarUmbrales,
  validarFecha,
  hoyLocal,
};
