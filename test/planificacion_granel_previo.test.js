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
// Las funciones viven inline en planificacion.html (no hay módulo que requerir): se extraen por
// nombre y se evalúan inyectando los bordes (API, modal de confirmación, toast) como stubs.
// La config de grupos y la resolución del ref son las reales.

const HTML = fs.readFileSync(path.join(__dirname, '..', 'planificacion.html'), 'utf8');

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
function entorno({ cfg = {}, mp = [], confirma = true, nombres = {} } = {}) {
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
    'gruposCfgLocal', 'cargarGruposCfgSiVacio', 'calcularMPParaItems', 'nombreDePlu',
    'confirmarModalAsync', 'escHtml', 'toast', src
  )(
    cfg,
    async () => {},
    async () => mp,
    async plu => nombres[String(plu)] || '',
    async () => confirma,
    s => String(s),
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

test('un granel: la cantidad sale de la fórmula y la presentación queda marcada', async () => {
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
  // Las presentaciones consumen el granel, no lo dan de alta: Producción no vuelve a pedirlo.
  assert.strictEqual(items[0].granelAparte, true);
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

test('cancelar el aviso devuelve false y no marca las presentaciones', async () => {
  const { itemGranelPrevio } = entorno({
    cfg: CFG, confirma: false,
    mp: [{ plu: '9610', nombre: 'Yogur Base', total: 344 }],
  });
  const items = [presentacion()];

  assert.strictEqual(await itemGranelPrevio('Yogurt Batido', items), false);
  assert.strictEqual(items[0].granelAparte, undefined);
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
