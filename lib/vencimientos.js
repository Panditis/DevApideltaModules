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
const TIPOS_MOVIMIENTO = Object.freeze(['oferta', 'vendido']);

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
const CRUCE_DEFAULT = Object.freeze({ tipoOferta: 'PARA OFERTA', tipoNoVendido: 'VENCIDO', depositoMovimientos: 1, margenDias: 7 });

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

function pendiente(col) {
  return col.unidades - col.vendido;
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
  return { unidades, vendido: 0, oferta: 0, movimientos: [{ tipo: 'alta', unidades, usuario, fecha }] };
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
  if (unidades < col.oferta || unidades < col.vendido) throw errorValidacion('Las unidades no pueden quedar por debajo de lo ofertado o vendido');
  const mov = { tipo: 'correccion', anterior: col.unidades, unidades, usuario, fecha };
  const nuevo = conColumna(lote, suc, { ...col, unidades, movimientos: [...col.movimientos, mov] });
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

// Oferta y vendido son acumulados independientes: cada uno debe quedar <= unidades.
function opMovimiento(datos, entrada, fecha) {
  if (!TIPOS_MOVIMIENTO.includes(entrada.tipo)) throw errorValidacion("tipo debe ser 'oferta' o 'vendido'");
  const lote = buscarLote(datos, entrada.idLote);
  const suc = validarSucursal(entrada.idSucursal);
  const col = buscarColumna(lote, suc);
  const cantidad = validarEntero(entrada.cantidad, 'cantidad', 1);
  const usuario = validarUsuario(entrada.usuario);
  const total = col[entrada.tipo] + cantidad;
  if (total > col.unidades) throw errorValidacion(`El ${entrada.tipo} acumulado (${total}) supera las unidades del lote (${col.unidades})`);
  const mov = { tipo: entrada.tipo, cantidad, usuario, fecha };
  const nuevo = conColumna(lote, suc, { ...col, [entrada.tipo]: total, movimientos: [...col.movimientos, mov] });
  return { datos: reemplazarLote(datos, nuevo), lote: nuevo };
}

function opBaja(datos, idLote) {
  const lote = buscarLote(datos, idLote);
  return { datos: { ...datos, lotes: datos.lotes.filter(l => l.id !== idLote) }, lote };
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
  const leerDatos = () => leerJSON(rutaDatos, { lotes: [] });
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
    bajaLote: idLote => mutar(d => opBaja(d, idLote)),
    leerConfig: () => encolar(leerConfig),
    // Cambios parciales: { umbrales?, tipoOferta?, tipoNoVendido?, depositoMovimientos?, diasAviso?, margenDias? }.
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
  validarUmbrales,
  hoyLocal,
};
