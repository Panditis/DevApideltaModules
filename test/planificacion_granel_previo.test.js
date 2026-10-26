const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// ── Granel previo: órdenes de granel generadas desde planificación ────────────
// Un grupo marcado "granel previo" en el catálogo se planifica por presentaciones, pero antes
// hay que fabricar el granel (pepas → masa). Al agregar las presentaciones al plan se suman
// las órdenes de granel como órdenes aparte, con la cantidad sacada de la fórmula. Esto
// reemplazó a la carga "solo granel" que vivía en Producción (commit 194bf24).
//
// Las funciones viven en public/js/planificacion_*.js (scripts del navegador, no hay módulo que
// requerir): se extraen por nombre y se evalúan inyectando los bordes (API, carrito, toast) como
// stubs. La config de grupos y la resolución del ref son las reales.
// Ya no hay confirmación: los graneles entran al carrito como líneas editables.

const JS_DIR = path.join(__dirname, '..', 'public', 'js');
const HTML = fs.readdirSync(JS_DIR).filter(f => /^planificacion_.*\.js$/.test(f))
  .map(f => fs.readFileSync(path.join(JS_DIR, f), 'utf8')).join('\n');

// Corta el fuente de una función balanceando llaves desde `function nombre(`, para que sirva
// tanto con las de una línea (cfgGetReqGranel) como con las de varias (itemGranelPrevio).
function fuenteDe(nombre) {
  const ini = HTML.search(new RegExp(`(?:async )?function ${nombre}\\(`));
  assert.notStrictEqual(ini, -1, `no se encontró function ${nombre}(`);
  let nivel = 0, visto = false;
  for (let i = ini; i < HTML.length; i++) {
    if (HTML[i] === '{') { nivel++; visto = true; }
    else if (HTML[i] === '}') { nivel--; if (visto && nivel === 0) return HTML.slice(ini, i + 1); }
  }
  assert.fail(`no se pudo cerrar function ${nombre}(`);
}

// La declaración completa de una const de una línea, tal cual está en el archivo.
function constDe(nombre) {
  const ini = HTML.indexOf(`const ${nombre} =`);
  assert.notStrictEqual(ini, -1, `no se encontró const ${nombre}`);
  return HTML.slice(ini, HTML.indexOf('\n', ini));
}

// Devuelve { resolverRefGrupo, itemGranelPrevio } sobre la config y los stubs dados.
// `mp` es lo que devolvería calcularMPParaItems: [{plu, nombre, total}].
function entorno({ cfg = {}, mp = [], nombres = {} } = {}) {
  const toasts = [];
  const src = [
    constDe('PRES_RE_JS'),
    fuenteDe('normalizarNombreJS'),
    fuenteDe('cfgGetGranelPlus'),
    fuenteDe('cfgGetReqGranel'),
    fuenteDe('resolverRefGrupo'),
    fuenteDe('itemGranelPrevio'),
    'return { resolverRefGrupo, itemGranelPrevio };',
  ].join('\n');
  const api = new Function(
    'gruposCfgLocal', 'cargarGruposCfgSiVacio', 'calcularMPParaItems', 'nombreDePlu', 'toast', src
  )(
    cfg,
    async () => {},
    async () => mp,
    async plu => nombres[String(plu)] || '',
    (msg, err) => toasts.push({ msg, err: !!err }),
  );
  return { ...api, toasts };
}

// Yogur batido: dos graneles elaborados (base + mermelada). Pepas: uno solo.
const CFG = {
  'Yogurt Batido': { activo: true, reqGranel: true, granelPlu: '9610', granelPlus: ['9610', '90739'] },
  'Pepas Apidelta Integrales Membrillo y Batata': { activo: true, reqGranel: true, granelPlu: '8104' },
  'Miel Acacia': true,                                    // grupo común, sin granel previo
  'Apimani Clasico': { activo: true, reqGranel: true },    // marcado pero sin graneles cargados
};

const presentacion = (extra = {}) => ({
  idProducto: '1968', producto: 'Yogurt Batido Frutilla 190G', rubro: 'yogurt batido',
  cantConfirmada: 500, granelNecesario: 95, ...extra,
});

// ── resolución del ref del grupo ──────────────────────────────────────────────

test('resuelve el grupo desde el nombre del artículo con presentación', () => {
  const { resolverRefGrupo } = entorno({ cfg: CFG });
  const ref = resolverRefGrupo('FRUTOS SECOS', [{ rubro: 'FRUTOS SECOS', producto: 'Apimani Clasico 150G' }]);
  assert.strictEqual(ref, 'Apimani Clasico');
});

test('resuelve el grupo desde el rubro normalizado que arma sugToItem', () => {
  const { resolverRefGrupo } = entorno({ cfg: CFG });
  assert.strictEqual(resolverRefGrupo('', [{ rubro: 'apimani clasico', producto: 'X' }]), 'Apimani Clasico');
});

test('la clave exacta del catálogo se devuelve tal cual', () => {
  const { resolverRefGrupo } = entorno({ cfg: CFG });
  assert.strictEqual(resolverRefGrupo('Miel Acacia', []), 'Miel Acacia');
});

test('sin match devuelve el ref recibido', () => {
  const { resolverRefGrupo } = entorno({ cfg: CFG });
  assert.strictEqual(
    resolverRefGrupo('Producto Suelto', [{ rubro: 'OTROS', producto: 'Producto Suelto 1Kg' }]),
    'Producto Suelto');
});

// ── órdenes de granel previo ──────────────────────────────────────────────────

test('un grupo sin granel previo no agrega órdenes ni marca las presentaciones', async () => {
  const { itemGranelPrevio } = entorno({ cfg: CFG });
  const items = [presentacion({ producto: 'Miel Acacia 500G', rubro: 'miel acacia' })];

  assert.deepStrictEqual(await itemGranelPrevio('Miel Acacia', items), []);
  assert.strictEqual(items[0].granelAparte, undefined);
});

test('si lo que se agrega ya es la orden de granel no se genera otra', async () => {
  const { itemGranelPrevio } = entorno({ cfg: CFG });
  const items = [presentacion({ esGranel: true })];

  assert.deepStrictEqual(await itemGranelPrevio('Yogurt Batido', items), []);
});

test('un granel: la cantidad sale de la fórmula', async () => {
  const { itemGranelPrevio } = entorno({
    cfg: CFG,
    mp: [{ plu: '8104', nombre: 'Masa Pepas DEPOSITO GRANEL x Kg', total: 128.456 }],
  });
  const items = [presentacion({ idProducto: '8110', producto: 'Pepas Membrillo 300G' })];

  const graneles = await itemGranelPrevio('Pepas Apidelta Integrales Membrillo y Batata', items);

  assert.strictEqual(graneles.length, 1);
  const g = graneles[0];
  assert.strictEqual(g.idProducto, '8104');
  assert.strictEqual(g.producto, 'Masa Pepas');          // se le corta el " DEPOSITO GRANEL…"
  assert.strictEqual(g.rubro, 'Granel');
  assert.strictEqual(g.esGranel, true);
  assert.strictEqual(g.cantSugerida, 0);
  assert.strictEqual(g.cantConfirmada, 128.46);          // redondeado a 2 decimales
  assert.strictEqual(g.unidadGranel, 'kg');
  assert.strictEqual(g.granelPrevioDe, 'Pepas Apidelta Integrales Membrillo y Batata');
  // El marcado granelAparte lo hace agregarGrupoItems sin mutar: itemGranelPrevio no toca los ítems.
  assert.strictEqual(items[0].granelAparte, undefined);
});

test('un grupo con dos graneles genera una orden por cada uno, con su propio total', async () => {
  const { itemGranelPrevio } = entorno({
    cfg: CFG,
    mp: [{ plu: '9610',  nombre: 'Yogur Base DEPOSITO GRANEL', total: 344 },
         { plu: '90739', nombre: 'Mermelada Frutillas Produccion Yogur', total: 12.5 }],
  });
  const items = [presentacion()];

  const graneles = await itemGranelPrevio('Yogurt Batido', items);

  assert.deepStrictEqual(graneles.map(g => [g.idProducto, g.producto, g.cantConfirmada]), [
    ['9610',  'Yogur Base', 344],
    ['90739', 'Mermelada Frutillas Produccion Yogur', 12.5],
  ]);
});

test('el granel sin fórmula cae al granelNecesario que traen las presentaciones', async () => {
  const { itemGranelPrevio } = entorno({
    cfg: CFG, mp: [],                                  // ninguna presentación tiene fórmula
    nombres: { 8104: 'Masa Pepas DEPOSITO GRANEL' },   // el nombre se busca por PLU en Siga
  });
  const items = [presentacion({ idGranel: '8104', granelNecesario: 60 }),
                 presentacion({ idGranel: '8104', granelNecesario: 45.5 })];

  const graneles = await itemGranelPrevio('Pepas Apidelta Integrales Membrillo y Batata', items);

  assert.strictEqual(graneles.length, 1);
  assert.strictEqual(graneles[0].cantConfirmada, 105.5);
  assert.strictEqual(graneles[0].producto, 'Masa Pepas DEPOSITO GRANEL');
});

test('marcado como granel previo pero sin graneles cargados: avisa y corta', async () => {
  const env = entorno({ cfg: CFG });
  const items = [presentacion({ producto: 'Apimani Clasico 150G', rubro: 'apimani clasico' })];

  assert.strictEqual(await env.itemGranelPrevio('Apimani Clasico', items), false);
  assert.strictEqual(env.toasts.length, 1);
  assert.strictEqual(env.toasts[0].err, true);
  assert.match(env.toasts[0].msg, /granel previo/);
});

test('el alta desde "Agregar producto" dispara el granel aunque llegue el rubro de Siga', async () => {
  const { itemGranelPrevio } = entorno({
    cfg: CFG,
    mp: [{ plu: '8104', nombre: 'Masa Pepas DEPOSITO GRANEL', total: 128 }],
  });
  // sug.rubro es el rubro de Siga, no la clave del catálogo: sin resolverRefGrupo esto daba [].
  const items = [{ idProducto: '8110', rubro: 'PANIFICADOS',
                   producto: 'Pepas Apidelta Integrales Membrillo y Batata 300G', cantConfirmada: 200 }];

  const graneles = await itemGranelPrevio('PANIFICADOS', items);

  assert.deepStrictEqual(graneles.map(g => g.idProducto), ['8104']);
  assert.strictEqual(graneles[0].granelPrevioDe, 'Pepas Apidelta Integrales Membrillo y Batata');
});

// ── agregarGrupoItems: del granel previo al carrito ───────────────────────────

// Arma agregarGrupoItems con itemGranelPrevio y agregarAlCarrito stubbeados; `llamadas` junta lo
// que llegó al carrito.
function carritoEntorno(granelPrevio) {
  const llamadas = [];
  const { agregarGrupoItems } = new Function('itemGranelPrevio', 'agregarAlCarrito',
    `${fuenteDe('agregarGrupoItems')}\nreturn { agregarGrupoItems };`
  )(async () => granelPrevio, items => llamadas.push(items));
  return { agregarGrupoItems, llamadas };
}

test('con granel previo: al carrito van los graneles y las presentaciones marcadas, sin mutar las originales', async () => {
  const granel = { idProducto: '8104', esGranel: true, cantConfirmada: 128 };
  const { agregarGrupoItems, llamadas } = carritoEntorno([granel]);
  const items = [presentacion()];

  await agregarGrupoItems('Yogurt Batido', items);

  assert.strictEqual(llamadas.length, 1);
  assert.deepStrictEqual(llamadas[0].map(it => [it.idProducto, !!it.granelAparte]), [['8104', false], ['1968', true]]);
  assert.strictEqual(items[0].granelAparte, undefined);
});

test('sin granel previo: al carrito van las presentaciones tal cual', async () => {
  const { agregarGrupoItems, llamadas } = carritoEntorno([]);
  const items = [presentacion()];

  await agregarGrupoItems('Miel Acacia', items);

  assert.deepStrictEqual(llamadas, [items]);
  assert.strictEqual(llamadas[0][0].granelAparte, undefined);
});

test('grupo marcado sin graneles cargados: no agrega nada al carrito', async () => {
  const { agregarGrupoItems, llamadas } = carritoEntorno(false);

  await agregarGrupoItems('Apimani Clasico', [presentacion()]);

  assert.deepStrictEqual(llamadas, []);
});

// ── carrito: orden por rankingPos y payload del envío ─────────────────────────

// Arma lineasOrdenadas y enviarCarrito sobre `lineas`, con los bordes (API, MP, toast, picker)
// stubbeados. `carrito` es un parámetro porque el fuente lo reasigna (let en el navegador).
function carritoEnvioEntorno(lineas) {
  const posts = [];
  const src = [
    constDe('nombreLinea'),
    constDe('_posLinea'),
    constDe('lineasOrdenadas'),
    fuenteDe('enviarCarrito'),
    'return { lineasOrdenadas, enviarCarrito };',
  ].join('\n');
  const api = new Function(
    'carrito', 'CARRITO_VACIO', 'cargarGruposCfgSiVacio', 'mostrarMPResumen', 'avisosCarrito',
    'api', 'guardarCarrito', 'document', 'formatFecha', 'toast', 'irAlDia', 'mensajeApiError', src
  )(
    { fecha: '2026-10-22', lineas, notas: '' }, { fecha: null, lineas: [], notas: '' },
    async () => {}, async () => true, async () => '',
    async (metodo, url, body) => { posts.push({ metodo, url, body }); return { nuevas: 1, actualizadas: 0, omitidos: [] }; },
    () => {}, { getElementById: () => ({}) }, f => f, () => {}, () => {}, e => String(e),
  );
  return { ...api, posts };
}

test('el carrito se ordena por rankingPos: sin rankingPos al final, empates en orden de alta', () => {
  const { lineasOrdenadas } = carritoEnvioEntorno([
    { _id: 1 }, { _id: 2, rankingPos: 3 }, { _id: 3, rankingPos: 1 }, { _id: 4 }, { _id: 5, rankingPos: 3 },
  ]);

  assert.deepStrictEqual(lineasOrdenadas().map(l => l._id), [3, 2, 5, 1, 4]);
});

test('el envío manda las líneas en ese orden con prioridad = lugar + 1 y sin campos de UI', async () => {
  const { enviarCarrito, posts } = carritoEnvioEntorno([
    { _id: 11, _pkOk: true, producto: 'Manual', cantConfirmada: 2 },
    { _id: 12, _pkOk: true, rankingPos: 5, producto: 'Zeta', cantConfirmada: 1 },
    { _id: 13, _pkOk: true, rankingPos: 2, producto: 'Apimani', cantConfirmada: 4 },
  ]);

  await enviarCarrito();

  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].url, '/api/plan/2026-10-22/envio');
  assert.deepStrictEqual(posts[0].body.items, [
    { producto: 'Apimani', cantConfirmada: 4, prioridad: 1 },
    { producto: 'Zeta', cantConfirmada: 1, prioridad: 2 },
    { producto: 'Manual', cantConfirmada: 2, prioridad: 3 },
  ]);
});

// ── Graneles en unidades (solo visual) ────────────────────────────────────────
// grupos_config.granelesUnidad: el stock de esos graneles está en unidades, no en kg. No cambia
// ningún cálculo: solo la unidad con que se muestran (modal de stock central, urgencia, Resumen).

// Evalúa las funciones nombradas con los bordes dados como [nombre, valor]. cfgEntry desestructura
// en los parámetros (fuenteDe cortaría ahí): es de una línea, se toma la línea entera.
const lineaDe = nombre => { const ini = HTML.indexOf(`function ${nombre}(`); return HTML.slice(ini, HTML.indexOf('\n', ini)); };
function fn(nombres, ...deps) {
  const src = [...nombres.map(n => (n === 'cfgEntry' ? lineaDe(n) : fuenteDe(n))), `return { ${nombres.join(', ')} };`].join('\n');
  return new Function(...deps.map(d => d[0]), src)(...deps.map(d => d[1]));
}

test('stock central: cada granel con su unidad y, si se mezclan, el total por unidad', () => {
  const { renderStockCentral } = fn(['escHtml', 'renderStockCentral']);
  const html = renderStockCentral({ esGranel: true, desglose: [], graneles: [
    { id: '901', nombre: 'Masa <A>', stock: 12, enUnidades: false }, { id: '902', nombre: 'Tapas', stock: 30, enUnidades: true }] });
  assert.ok(html.includes('Masa &lt;A&gt;'), 'el nombre de SIGA va escapado');
  assert.match(html, /Masa &lt;A&gt;<\/td><td[^>]*>12 kg<\/td>/);
  assert.match(html, /Tapas<\/td><td[^>]*>30 u<\/td>/);
  assert.match(html, />12 kg \+ 30 u<\/td>/);
});

test('stock central: graneles todos en la misma unidad suman un solo total', () => {
  const { renderStockCentral } = fn(['escHtml', 'renderStockCentral']);
  const html = renderStockCentral({ esGranel: false, presentaciones: [], graneles: [
    { id: '901', nombre: 'A', stock: 12, enUnidades: true }, { id: '902', nombre: 'B', stock: 30, enUnidades: true }] });
  assert.match(html, />42 u<\/td>/);
  assert.ok(!html.includes(' kg'), html);
});

test('unidad del grupo: kg en granel, u si su granel está en unidades o si no es granel', () => {
  const { unidadGrupo } = new Function(`${constDe('unidadGrupo')}\nreturn { unidadGrupo };`)();
  assert.strictEqual(unidadGrupo({ esGranel: true }), 'kg');
  assert.strictEqual(unidadGrupo({ esGranel: true, granelEnUnidades: true }), 'u');
  assert.strictEqual(unidadGrupo({ esGranel: false }), 'u');
});

test('catálogo: granelesUnidad se guarda con el grupo y quitar el granel lo saca', () => {
  const cfg = { Mix: { activo: true, granelPlu: '901', granelPlus: ['901', '902'] } };
  const { cfgSet, cfgGetGranelesUnidad } = fn(
    ['cfgGetActivo', 'cfgGetGranelPlus', 'cfgGetMpManual', 'cfgRawGranelDirecto', 'cfgRawEsMiel', 'cfgGetReqGranel',
      'cfgGetVentaPorUnidad', 'cfgGetGranelesUnidad', 'cfgEntry', 'cfgSet'],
    ['gruposCfgLocal', cfg]);
  cfgSet('Mix', { granelesUnidad: ['902'] });
  assert.deepStrictEqual(cfg.Mix, { activo: true, granelPlu: '901', granelPlus: ['901', '902'], granelesUnidad: ['902'] });
  cfgSet('Mix', { activo: false });                       // otro cambio no lo pierde
  assert.deepStrictEqual(cfgGetGranelesUnidad('Mix'), ['902']);
  cfgSet('Mix', { granelPlus: ['901'] });                 // se quitó el 902
  assert.deepStrictEqual(cfg.Mix, { activo: false, granelPlu: '901' });
});

test('modal del grupo: cada granel lleva el check "en unidades" con su estado', () => {
  const lista = { innerHTML: '' };
  const { renderGraneles } = fn(['escHtml', 'renderGraneles'],
    ['document', { getElementById: id => (id === 'listaGraneles' ? lista : null) }],
    ['granelesData', [{ plu: '901', nombre: 'Masa', enUnidades: false }, { plu: '902', nombre: 'Tapas', enUnidades: true }]]);
  renderGraneles();
  const checks = lista.innerHTML.match(/<input type="checkbox"[^>]*>/g);
  assert.strictEqual(checks.length, 2);
  assert.ok(!/\schecked\s/.test(checks[0]) && /\schecked\s/.test(checks[1]), checks.join('\n'));
  assert.ok(lista.innerHTML.includes('toggleGranelUnidades(1, this.checked)'));
  assert.ok(lista.innerHTML.includes('Solo cambia cómo se muestra.'));
});

// ── Presentación mayorista y venta mayorista (Resumen) ────────────────────────
// Presentación mayorista (todos sus códigos mayoristas): su stock de sucursal no cuenta, así que no va
// en el modal 🔍 de sucursales; en el modal de urgencia el stock es solo el de Casa Central. Venta
// mayorista: la parte de las ventas que vino de Casa Central a clientes MAYORISTA (solo se muestra).

test('stock en sucursales: las presentaciones mayoristas no van como columna', () => {
  const { renderStockDetalle } = fn(['escHtml', 'columnasStock', 'renderStockDetalle']);
  const g = { productoRef: 'Miel', presentaciones: [
    { presentacion: '1Kg', plu: '501', plus: ['501'] },
    { presentacion: '28Kg', plu: '502', plus: ['502', '503'], esMayorista: true }] };
  const data = { sucursales: [{ id: 1, nombre: 'Suc A' }, { id: 0, nombre: 'Central', central: true }],
    presentaciones: [{ plu: '501', porSuc: { 1: 3 } }, { plu: '502', porSuc: { 1: 9 } }, { plu: '503', porSuc: { 1: 4 } }] };
  const html = renderStockDetalle(data, g);
  assert.ok(html.includes('>1Kg</th>'), html);
  assert.ok(!html.includes('28Kg'), html);
  assert.ok(!/>(9|13|16)</.test(html), 'el stock de sucursal de la presentación mayorista no suma');
  assert.match(html, /Suc A<\/td><td[^>]*>3<\/td><td[^>]*>3<\/td>/);
});

// Funciones del modal de urgencia, con sus constantes de una línea.
function urgenciaFns() {
  const src = [
    ...['URGENCIA_CHIP', 'nfAR', 'listaY', 'chipUrgencia', 'minimoDe', 'unidadGrupo'].map(constDe),
    ...['escHtml', 'fmtDias', 'datosUrgencia', 'textoResultado', 'textoExclusiones', 'lineaImportancia', 'lineaUmbral',
      'textoMinimo', 'htmlCalculoPresentacion', 'htmlCalculoGrupo', 'htmlDesgloseGranel'].map(fuenteDe),
    'return { htmlCalculoPresentacion, htmlCalculoGrupo };',
  ].join('\n');
  return new Function(src)();
}
const grupoUrg = extra => ({ productoRef: 'Miel', esGranel: false, ventanaDias: 30, diasObjetivo: 10, umbralUrgencia: 7,
  claseABC: 'A', rankingPos: 1, excluyeCentral: true, sucursalesExcluidas: [6, 8, 11], ...extra });

test('urgencia de una presentación: separa la venta minorista de la mayorista', () => {
  const { htmlCalculoPresentacion } = urgenciaFns();
  const p = { presentacion: '500G', ventasVentana: 90, ventaDiariaUrg: 3, ventasMayoristaVentana: 30, ventaDiariaMayorista: 1,
    stockActual: 20, stockSucursales: 10, urgencia: 'URGENTE' };
  const html = htmlCalculoPresentacion(grupoUrg(), p);
  assert.match(html, /Venta minorista \(sucursales\)<\/td><td>60 u en la ventana · 2 u\/día/);
  assert.match(html, /Venta mayorista \(Casa Central a mayoristas\)<\/td><td>30 u en la ventana · 1 u\/día/);
  assert.ok(html.indexOf('Ventas en la ventana') < html.indexOf('Venta minorista'), 'debajo de "Ventas en la ventana"');
  assert.match(html, /central 20 \+ sucursales 10/);
});

test('urgencia de una presentación mayorista: el stock es solo el de Casa Central', () => {
  const { htmlCalculoPresentacion } = urgenciaFns();
  const p = { presentacion: '28Kg', esMayorista: true, ventasVentana: 30, ventaDiariaUrg: 1, ventasMayoristaVentana: 30,
    ventaDiariaMayorista: 1, stockActual: 6, stockSucursales: 0, urgencia: 'URGENTE' };
  const html = htmlCalculoPresentacion(grupoUrg(), p);
  assert.match(html, /<td>Stock<\/td><td>solo Casa Central \(presentación mayorista\): <strong>6 u<\/strong>/);
  assert.ok(!html.includes('+ sucursales'), html);
  assert.match(html, /Venta minorista \(sucursales\)<\/td><td>0 u en la ventana · 0 u\/día/);
});

test('urgencia del grupo: columna "Venta mayorista" en la tabla y en el consumo por presentación de granel', () => {
  const { htmlCalculoGrupo } = urgenciaFns();
  const conPres = htmlCalculoGrupo(grupoUrg({ urgencia: 'OK', presentaciones: [
    { presentacion: '500G', ventasVentana: 90, ventaDiariaUrg: 3, ventasMayoristaVentana: 30, stockActual: 20, stockSucursales: 10, urgencia: 'OK' }] }));
  assert.match(conPres, /<th class="num">Ventas ventana<\/th><th class="num">Venta mayorista<\/th>/);
  assert.match(conPres, /<td class="num">90 u<\/td><td class="num">30 u<\/td>/);
  const granel = htmlCalculoGrupo(grupoUrg({ esGranel: true, urgencia: 'OK', granelStockGrupo: 100, stockSucGrupo: 0,
    ventasVentana: 60, ventaDiariaUrg: 2, ventasMayoristaVentana: 30, presentaciones: [], desglose: [
      { presentacion: '1Kg', ventasVentana: 30, ventaDiariaUrg: 1, ventasMayoristaVentana: 0, unidadesVentana: null },
      { presentacion: '28Kg', esMayorista: true, ventasVentana: 30, ventaDiariaUrg: 1, ventasMayoristaVentana: 30, unidadesVentana: null }] }));
  assert.match(granel, /<td class="num">60 kg<\/td><td class="num">30 kg<\/td>/);       // fila del grupo
  const desglose = granel.slice(granel.indexOf('Consumo por presentación'));
  assert.match(desglose, /<th class="num">Ventas ventana<\/th><th class="num">Venta mayorista<\/th>/);
  assert.match(desglose, /28Kg <span class="badge-mayorista">Mayorista<\/span><\/td>/);
  assert.match(desglose, /<td class="num">30 kg<\/td>\s*<td class="num">30 kg<\/td>/);
});
