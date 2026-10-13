// ── rrhh_cv.js ───────────────────────────────────────────────────────────────
// Módulo puro del Analizador de CV (RRHH). Sin I/O ni express: filtros tipo ATS
// por reglas locales (palabras clave, años de experiencia, nivel de estudios).
// Nada de IA ni servicios externos: el CV nunca sale del servidor. El server sólo
// extrae el texto del archivo, lee/escribe los perfiles y llama a esto.
'use strict';

const NIVELES_ESTUDIO = ['', 'secundario', 'terciario', 'universitario'];
const UMBRAL_DEFAULT = 60;
const ANIO_MIN = 1960;
const MIN_CARACTERES = 50;
// Pesos del puntaje. Si un criterio no aplica al perfil, su peso se reparte entre los demás.
const PESOS = { requeridas: 60, deseables: 25, experiencia: 15 };

// Palabras que delatan cada nivel (sobre texto normalizado, sin acentos). Son
// raíces: "licenciatur" cubre licenciatura/licenciaturas, "ingenier" ingeniero/a/ía.
const PALABRAS_ESTUDIO = {
  universitario: ['universidad', 'universitari', 'licenciatur', 'licenciad', 'ingenier', 'contador publico', 'grado universitario'],
  terciario: ['terciario', 'tecnicatura', 'tecnico superior', 'profesorado'],
  secundario: ['secundario', 'secundaria', 'bachiller', 'polimodal', 'perito mercantil'],
};

function texto(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function normalizarTexto(s) {
  return texto(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escaparRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Perfiles ──────────────────────────────────────────────────────────────────
function slug(nombre) {
  return normalizarTexto(nombre).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function idUnico(base, usados) {
  const raiz = base || 'perfil';
  if (!usados.includes(raiz)) return raiz;
  let n = 2;
  while (usados.includes(`${raiz}-${n}`)) n++;
  return `${raiz}-${n}`;
}

// Trim, sin vacíos y sin duplicados (comparando normalizado: "Excel" = "excel").
function normalizarLista(lista) {
  const vistos = new Set();
  return (Array.isArray(lista) ? lista : [])
    .map(k => texto(k).replace(/\s+/g, ' '))
    .filter(k => {
      const n = normalizarTexto(k);
      if (!n || vistos.has(n)) return false;
      vistos.add(n);
      return true;
    });
}

function numeroEntre(v, min, max, porDefecto) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return porDefecto;
  return Math.min(max, Math.max(min, n));
}

function normalizarPerfil(p, idsUsados = []) {
  const e = p || {};
  const nombre = texto(e.nombre);
  if (!nombre) throw new Error('El perfil necesita un nombre.');
  const id = idUnico(slug(texto(e.id)) || slug(nombre), idsUsados);
  const estudios = normalizarTexto(e.estudiosMin);
  return {
    id,
    nombre,
    descripcion: texto(e.descripcion),
    requeridas: normalizarLista(e.requeridas),
    deseables: normalizarLista(e.deseables),
    aniosMin: numeroEntre(e.aniosMin, 0, 50, 0),
    estudiosMin: NIVELES_ESTUDIO.includes(estudios) ? estudios : '',
    umbral: Math.round(numeroEntre(e.umbral, 0, 100, UMBRAL_DEFAULT)),
  };
}

function normalizarPerfiles(lista) {
  if (!Array.isArray(lista)) throw new Error('Los perfiles tienen que venir en una lista.');
  return lista.reduce((acc, p) => [...acc, normalizarPerfil(p, acc.map(x => x.id))], []);
}

const PERFILES_SEMILLA = normalizarPerfiles([
  {
    nombre: 'Repositor/a',
    descripcion: 'Reposición de góndolas y depósito en sucursal.',
    requeridas: ['reposicion|repositor|repositora|gondola', 'stock|deposito|mercaderia|vencimientos'],
    deseables: ['gondola', 'deposito', 'control de stock|stock', 'vencimientos|fifo', 'supermercado|autoservicio|almacen', 'recepcion de mercaderia', 'inventario', 'orden y limpieza'],
    aniosMin: 0.5, estudiosMin: 'secundario', umbral: 55,
  },
  {
    nombre: 'Cajero/a – Vendedor/a',
    descripcion: 'Caja y atención al público en sucursal.',
    requeridas: ['caja|cajero|cajera|posnet', 'atencion al cliente|atencion al publico|ventas|vendedor|vendedora'],
    deseables: ['ventas|vendedor|vendedora', 'arqueo de caja|arqueo', 'cobranza|cobro', 'tarjetas de credito|posnet|mercado pago', 'facturacion', 'dietetica|almacen natural', 'manejo de efectivo', 'comercio'],
    aniosMin: 1, estudiosMin: 'secundario', umbral: 60,
  },
  {
    nombre: 'Operario/a de producción / fraccionado',
    descripcion: 'Producción, fraccionado y envasado de alimentos.',
    requeridas: ['manipulacion de alimentos|manipulador de alimentos|carnet de manipulador', 'fraccionado|fraccionamiento|envasado|produccion'],
    deseables: ['balanza', 'bpm|buenas practicas de manufactura', 'envasadora|selladora', 'industria alimenticia|planta elaboradora', 'rotulado|etiquetado', 'higiene y seguridad', 'limpieza|sanitizacion', 'trabajo en equipo', 'turnos rotativos'],
    aniosMin: 0.5, estudiosMin: '', umbral: 55,
  },
  {
    nombre: 'Administrativo/a',
    descripcion: 'Administración, facturación y cuentas corrientes.',
    requeridas: ['excel|planilla de calculo|hojas de calculo', 'facturacion', 'administrativo|administrativa|administracion'],
    deseables: ['cuentas corrientes', 'afip|arca', 'conciliacion bancaria|conciliaciones', 'liquidacion de sueldos', 'pago a proveedores|proveedores', 'tablas dinamicas', 'sistema de gestion|erp', 'contable|contabilidad'],
    aniosMin: 2, estudiosMin: 'terciario', umbral: 60,
  },
  {
    nombre: 'Chofer / Repartidor',
    descripcion: 'Reparto a sucursales y clientes mayoristas.',
    requeridas: ['licencia de conducir|registro de conducir|carnet de conducir', 'chofer|conductor|repartidor', 'reparto|distribucion'],
    deseables: ['profesional', 'logistica', 'carga y descarga', 'hoja de ruta', 'utilitario|camioneta|camion', 'conocimiento de caba|gba|zona', 'cobranza'],
    aniosMin: 2, estudiosMin: '', umbral: 60,
  },
  {
    nombre: 'Encargado/a de sucursal',
    descripcion: 'Conducción de la sucursal: equipo, caja, stock y clientes.',
    requeridas: ['encargado|encargada|responsable de sucursal|supervisor|supervisora', 'manejo de personal|personal a cargo', 'stock|inventario', 'caja'],
    deseables: ['atencion al cliente', 'liderazgo', 'cierre de caja|arqueo', 'pedidos a proveedores|compras', 'indicadores|objetivos de venta', 'visual merchandising|exhibicion', 'dietetica|almacen', 'capacitacion'],
    aniosMin: 3, estudiosMin: 'secundario', umbral: 65,
  },
]);

// ── Matching ──────────────────────────────────────────────────────────────────
// Una palabra clave matchea por frontera de palabra (con plural simple s/es) sobre
// el texto normalizado. Las alternativas van separadas por "|".
function regexTermino(termino) {
  return new RegExp(`(?<![a-z0-9])${escaparRegex(termino)}(?:s|es)?(?![a-z0-9])`);
}

function contieneClave(textoNormalizado, clave) {
  return texto(clave).split('|')
    .map(normalizarTexto)
    .filter(Boolean)
    .some(alt => regexTermino(alt).test(textoNormalizado));
}

// ── Extracción de datos ───────────────────────────────────────────────────────
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// Teléfono flexible: +54 9 11 1234-5678, (011) 4567-8901, 351 15 555 1234…
const RE_TELEFONO = /(?:\+?\d[\d\s().-]{6,}\d)/g;

function extraerTelefono(crudo) {
  const candidatos = String(crudo).match(RE_TELEFONO) || [];
  const tel = candidatos.find(c => {
    const digitos = c.replace(/\D/g, '');
    const limpio = c.trim();
    // Rangos de años ("2018 - 2022"), DNI (30.123.456) y CUIL (20-30123456-7)
    // parecen números largos: se descartan.
    return digitos.length >= 8 && digitos.length <= 15
      && !/(?:19|20)\d{2}\s*-\s*(?:19|20)\d{2}/.test(limpio)
      && !/^\d{1,2}\.\d{3}\.\d{3}$/.test(limpio)
      && !/^\d{2}-\d{8}-\d$/.test(limpio);
  });
  return tel ? tel.trim() : '';
}

const FIN_ACTUAL = 'actualidad|actualmente|presente|hoy|la fecha|actual';
const RE_RANGO = new RegExp(
  `(?:(\\d{1,2})[/.-])?((?:19|20)\\d{2})\\s*(?:-|–|—|a|al|hasta)\\s*(?:(\\d{1,2})[/.-])?((?:19|20)\\d{2}|${FIN_ACTUAL})(?![a-z0-9])`,
  'g'
);
const RE_ANIOS_EXPLICITOS = /(\d+(?:[.,]\d+)?)\s*\+?\s*anos? de experiencia|experiencia de (\d+(?:[.,]\d+)?)\s*anos?/g;

// Año fraccionario: el mes (si viene) suma la fracción. Inicio = arranque del mes,
// fin = cierre del mes; sin mes, el rango se toma de año a año ("2018 - 2022" = 4).
function aFraccion(anio, mes, esFin) {
  const m = Number(mes);
  if (!m || m < 1 || m > 12) return anio;
  return anio + (esFin ? m : m - 1) / 12;
}

function intervalosDeRangos(t, hoy) {
  const anioActual = hoy.getFullYear();
  const ahora = anioActual + hoy.getMonth() / 12;
  return [...t.matchAll(RE_RANGO)].map(m => {
    const ini = Number(m[2]);
    const finEsActual = !/^\d/.test(m[4]);
    const finAnio = finEsActual ? anioActual : Number(m[4]);
    if (ini < ANIO_MIN || ini > anioActual || finAnio < ANIO_MIN || finAnio > anioActual) return null;
    const desde = aFraccion(ini, m[1], false);
    const hasta = finEsActual ? ahora : aFraccion(finAnio, m[3], true);
    return hasta > desde ? [desde, hasta] : null;
  }).filter(Boolean);
}

// Une los intervalos solapados y suma su largo (dos trabajos en paralelo no son el doble).
function sumarIntervalos(intervalos) {
  const ordenados = [...intervalos].sort((a, b) => a[0] - b[0]);
  const unidos = ordenados.reduce((acc, [d, h]) => {
    const ultimo = acc[acc.length - 1];
    if (ultimo && d <= ultimo[1]) return [...acc.slice(0, -1), [ultimo[0], Math.max(ultimo[1], h)]];
    return [...acc, [d, h]];
  }, []);
  return unidos.reduce((s, [d, h]) => s + (h - d), 0);
}

function aniosExplicitos(t) {
  return [...t.matchAll(RE_ANIOS_EXPLICITOS)]
    .map(m => Number(String(m[1] || m[2]).replace(',', '.')))
    .filter(n => Number.isFinite(n) && n <= 60)
    .reduce((max, n) => Math.max(max, n), 0);
}

function detectarEstudios(t) {
  const nivel = ['universitario', 'terciario', 'secundario'].find(n =>
    PALABRAS_ESTUDIO[n].some(raiz => new RegExp(`(?<![a-z0-9])${escaparRegex(raiz)}`).test(t))
  );
  return nivel || '';
}

function extraerDatos(textoCv, hoy = new Date()) {
  const crudo = String(textoCv || '');
  const t = normalizarTexto(crudo);
  const email = (crudo.match(RE_EMAIL) || [''])[0];
  const porRangos = sumarIntervalos(intervalosDeRangos(t, hoy));
  const anios = Math.max(porRangos, aniosExplicitos(t));
  return {
    email,
    telefono: extraerTelefono(crudo.replace(RE_EMAIL, ' ')),
    aniosExperiencia: Math.round(anios * 10) / 10,
    estudios: detectarEstudios(t),
  };
}

// ── Análisis ──────────────────────────────────────────────────────────────────
function separarClaves(t, claves) {
  return {
    encontradas: claves.filter(k => contieneClave(t, k)),
    faltantes: claves.filter(k => !contieneClave(t, k)),
  };
}

// Puntaje 0..100: cada criterio aporta su fracción cumplida por su peso. Los que no
// aplican (lista vacía o aniosMin 0) salen del cálculo y el resto se reescala.
function calcularPuntaje(perfil, req, des, anios) {
  const criterios = [
    { peso: PESOS.requeridas, aplica: perfil.requeridas.length > 0, valor: req.encontradas.length / (perfil.requeridas.length || 1) },
    { peso: PESOS.deseables, aplica: perfil.deseables.length > 0, valor: des.encontradas.length / (perfil.deseables.length || 1) },
    { peso: PESOS.experiencia, aplica: perfil.aniosMin > 0, valor: Math.min(1, anios / (perfil.aniosMin || 1)) },
  ].filter(c => c.aplica);
  const total = criterios.reduce((s, c) => s + c.peso, 0);
  if (!total) return 100;
  return Math.round(criterios.reduce((s, c) => s + c.peso * c.valor, 0) / total * 100);
}

function evaluarPerfil(t, datos, perfil) {
  const requeridas = separarClaves(t, perfil.requeridas);
  const deseables = separarClaves(t, perfil.deseables);
  const anios = datos.aniosExperiencia;
  const puntaje = calcularPuntaje(perfil, requeridas, deseables, anios);
  const motivos = [];
  if (requeridas.faltantes.length) motivos.push(`Faltan requisitos: ${requeridas.faltantes.join(', ')}`);
  if (anios < perfil.aniosMin) motivos.push(`Experiencia ${anios} años (pide ${perfil.aniosMin})`);
  if (NIVELES_ESTUDIO.indexOf(datos.estudios) < NIVELES_ESTUDIO.indexOf(perfil.estudiosMin)) {
    motivos.push(`Estudios: ${datos.estudios || 'no detectados'} (pide ${perfil.estudiosMin})`);
  }
  if (puntaje < perfil.umbral) motivos.push(`Puntaje ${puntaje} por debajo del umbral ${perfil.umbral}`);
  return {
    perfilId: perfil.id,
    nombre: perfil.nombre,
    puntaje,
    cumple: motivos.length === 0,
    motivos,
    requeridas,
    deseables,
  };
}

function analizarCV(textoCv, perfiles, { hoy } = {}) {
  const t = normalizarTexto(textoCv);
  if (t.length < MIN_CARACTERES) throw new Error('No se pudo extraer texto del CV (¿es un PDF escaneado o una imagen?).');
  const datos = extraerDatos(textoCv, hoy || new Date());
  const resultados = normalizarPerfiles(perfiles)
    .map(p => evaluarPerfil(t, datos, p))
    .sort((a, b) => (Number(b.cumple) - Number(a.cumple)) || (b.puntaje - a.puntaje));
  const primero = resultados.find(r => r.cumple);
  return { caracteres: t.length, datos, resultados, mejor: primero ? primero.perfilId : null };
}

// ── DOCX ──────────────────────────────────────────────────────────────────────
// Un .docx es un zip; el cuerpo vive en word/document.xml. xlsx ya trae CFB, que
// lee zips: no hace falta otra dependencia.
const ENTIDADES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

function extraerTextoDocx(buffer) {
  const { CFB } = require('xlsx');
  let doc = null;
  try {
    doc = CFB.find(CFB.read(buffer, { type: 'buffer' }), '/word/document.xml');
  } catch {
    doc = null;
  }
  if (!doc || !doc.content) throw new Error('El archivo no es un .docx válido (no se encontró el documento de Word).');
  return Buffer.from(doc.content).toString('utf8')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\s*\/>|<w:cr\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:lt|gt|quot|apos|amp);/g, e => ENTIDADES[e])
    .replace(/&#(x?)([0-9a-f]+);/gi, (_e, hex, n) => String.fromCodePoint(parseInt(n, hex ? 16 : 10)))
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

module.exports = {
  NIVELES_ESTUDIO,
  PERFILES_SEMILLA,
  normalizarTexto,
  normalizarPerfil,
  normalizarPerfiles,
  contieneClave,
  extraerDatos,
  analizarCV,
  extraerTextoDocx,
};
