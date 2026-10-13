const test = require('node:test');
const assert = require('node:assert');
const { CFB } = require('xlsx');
const {
  PERFILES_SEMILLA, normalizarTexto, normalizarPerfil, normalizarPerfiles,
  contieneClave, extraerDatos, analizarCV, extraerTextoDocx,
} = require('../lib/rrhh_cv');

const HOY = new Date(2026, 9, 8); // 8/10/2026
const RELLENO = ' Persona proactiva, responsable y con muchas ganas de aprender y crecer.';

test('normalizarTexto saca acentos, pasa a minúsculas y colapsa espacios', () => {
  assert.equal(normalizarTexto('  Atención   al\nCLIENTE  '), 'atencion al cliente');
  assert.equal(normalizarTexto(null), '');
});

test('normalizarPerfil arma el id con el slug del nombre y lo hace único', () => {
  assert.equal(normalizarPerfil({ nombre: 'Cajero/a – Vendedor/a' }).id, 'cajero-a-vendedor-a');
  assert.equal(normalizarPerfil({ nombre: 'Repositor' }, ['repositor']).id, 'repositor-2');
});

test('normalizarPerfil exige nombre', () => {
  assert.throws(() => normalizarPerfil({ nombre: '  ' }), /nombre/);
});

test('normalizarPerfil limpia listas y acota números sin mutar el input', () => {
  const entrada = { nombre: 'X', requeridas: [' Excel ', '', 'excel', 'Éxcel'], aniosMin: -3, umbral: 150, estudiosMin: 'doctorado' };
  const copia = JSON.parse(JSON.stringify(entrada));
  const p = normalizarPerfil(entrada);
  assert.deepEqual(p.requeridas, ['Excel']);
  assert.deepEqual(p.deseables, []);
  assert.equal(p.aniosMin, 0);
  assert.equal(p.umbral, 100);
  assert.equal(p.estudiosMin, '');
  assert.equal(normalizarPerfil({ nombre: 'Y' }).umbral, 60);
  assert.deepEqual(entrada, copia);
});

test('normalizarPerfiles exige una lista y deduplica ids', () => {
  assert.throws(() => normalizarPerfiles('nada'), /lista/);
  const ids = normalizarPerfiles([{ nombre: 'Chofer' }, { nombre: 'Chofer' }, { id: 'chofer', nombre: 'Otro' }]).map(p => p.id);
  assert.deepEqual(ids, ['chofer', 'chofer-2', 'chofer-3']);
});

test('PERFILES_SEMILLA trae 6 perfiles válidos', () => {
  assert.equal(PERFILES_SEMILLA.length, 6);
  for (const p of PERFILES_SEMILLA) {
    assert.ok(p.requeridas.length >= 2, p.nombre);
    assert.ok(p.deseables.length >= 4, p.nombre);
  }
});

test('contieneClave ignora acentos/mayúsculas, acepta alternativas y plural simple', () => {
  const t = normalizarTexto('Manejo de PLANILLA DE CÁLCULO, atención de góndolas y facturación');
  assert.ok(contieneClave(t, 'excel|planilla de calculo'));
  assert.ok(contieneClave(t, 'gondola'));
  assert.ok(contieneClave(t, 'Facturación'));
  assert.ok(!contieneClave(t, 'caja'));
  // Frontera de palabra: "factura" no matchea dentro de "facturacion".
  assert.ok(!contieneClave(t, 'factura'));
});

test('extraerDatos une rangos solapados y toma "actualidad" como hoy', () => {
  const d = extraerDatos('Empresa A 2015 - 2018. Empresa B 2017 - 2020. Empresa C 03/2024 – actualidad', HOY);
  // 2015..2020 = 5 años + 03/2024..10/2026 ≈ 2.6
  assert.equal(d.aniosExperiencia, 7.6);
});

test('extraerDatos toma "N años de experiencia" si es mayor, e ignora años fuera de rango', () => {
  assert.equal(extraerDatos('Cuento con 10 años de experiencia. Trabajo 2020 - 2022', HOY).aniosExperiencia, 10);
  assert.equal(extraerDatos('Trabajo 1950 - 1955 y 2027 - 2030', HOY).aniosExperiencia, 0);
});

test('extraerDatos saca email, teléfono y no confunde DNI ni rangos con teléfono', () => {
  const d = extraerDatos('DNI 30.123.456 · 2018 - 2022 · Mail: Juan.Perez@gmail.com · Cel: +54 9 11 4567-8901', HOY);
  assert.equal(d.email, 'Juan.Perez@gmail.com');
  assert.equal(d.telefono, '+54 9 11 4567-8901');
  assert.equal(extraerDatos('sin datos', HOY).telefono, '');
  assert.equal(extraerDatos('sin datos', HOY).email, '');
});

test('extraerDatos detecta el mayor nivel de estudios', () => {
  assert.equal(extraerDatos('Secundario completo. Tecnicatura en Gastronomía', HOY).estudios, 'terciario');
  assert.equal(extraerDatos('Licenciatura en Administración (UBA). Bachiller', HOY).estudios, 'universitario');
  assert.equal(extraerDatos('Perito Mercantil', HOY).estudios, 'secundario');
  assert.equal(extraerDatos('Nada', HOY).estudios, '');
});

test('analizarCV redistribuye pesos cuando un criterio no aplica', () => {
  const perfil = { nombre: 'Sin deseables', requeridas: ['caja', 'stock'], deseables: [], aniosMin: 0, umbral: 0 };
  const r = analizarCV('Experiencia en caja de supermercado.' + RELLENO, [perfil], { hoy: HOY });
  // Sólo aplican requeridas: 1 de 2 → 50.
  assert.equal(r.resultados[0].puntaje, 50);
  // Requeridas 2/2, deseables 0/2, experiencia 1/2 años → (60 + 0 + 7.5) / 100.
  const r2 = analizarCV('Caja y stock, 2024 - 2025.' + RELLENO,
    [{ nombre: 'Completo', requeridas: ['caja', 'stock'], deseables: ['liderazgo', 'excel'], aniosMin: 2, umbral: 0 }], { hoy: HOY });
  assert.equal(r2.resultados[0].puntaje, 68);
});

test('analizarCV descarta por requerida faltante aunque el puntaje alcance', () => {
  const perfil = { nombre: 'Cajero', requeridas: ['caja', 'atencion al cliente', 'ventas'], deseables: [], aniosMin: 0, umbral: 10 };
  const r = analizarCV('Trabajé en caja y en ventas de mostrador.' + RELLENO, [perfil], { hoy: HOY });
  const res = r.resultados[0];
  assert.equal(res.cumple, false);
  assert.deepEqual(res.requeridas.faltantes, ['atencion al cliente']);
  assert.deepEqual(res.motivos, ['Faltan requisitos: atencion al cliente']);
  assert.equal(r.mejor, null);
});

test('analizarCV explica experiencia, estudios y umbral', () => {
  const perfil = { nombre: 'Admin', requeridas: ['excel'], deseables: ['afip'], aniosMin: 2, estudiosMin: 'terciario', umbral: 90 };
  const r = analizarCV('Manejo de Excel. Secundario completo. 2025 - 2026' + RELLENO, [perfil], { hoy: HOY });
  assert.deepEqual(r.resultados[0].motivos, [
    'Experiencia 1 años (pide 2)',
    'Estudios: secundario (pide terciario)',
    'Puntaje 68 por debajo del umbral 90',
  ]);
});

test('analizarCV ordena primero los que cumplen y elige el mejor', () => {
  const perfiles = [
    { nombre: 'Alto sin cumplir', requeridas: ['caja', 'stock', 'liderazgo'], deseables: [], umbral: 0 },
    { nombre: 'Bajo cumple', requeridas: ['caja'], deseables: ['excel', 'afip', 'reparto'], umbral: 0 },
    { nombre: 'Medio cumple', requeridas: ['caja'], deseables: ['stock'], umbral: 0 },
  ];
  const r = analizarCV('Manejo de caja y stock en sucursal.' + RELLENO, perfiles, { hoy: HOY });
  assert.deepEqual(r.resultados.map(x => x.perfilId), ['medio-cumple', 'bajo-cumple', 'alto-sin-cumplir']);
  assert.equal(r.mejor, 'medio-cumple');
  assert.ok(r.caracteres > 50);
});

test('analizarCV rechaza un texto demasiado corto', () => {
  assert.throws(() => analizarCV('   hola   ', PERFILES_SEMILLA), /PDF escaneado/);
});

test('extraerTextoDocx saca el texto de word/document.xml', () => {
  const cfb = CFB.utils.cfb_new();
  const xml = '<w:document><w:body><w:p><w:r><w:t>Juan &amp; Pérez</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Caja</w:t><w:tab/><w:t>Stock</w:t><w:br/><w:t>Fin</w:t></w:r></w:p></w:body></w:document>';
  CFB.utils.cfb_add(cfb, 'word/document.xml', Buffer.from(xml, 'utf8'));
  const buffer = CFB.write(cfb, { type: 'buffer', fileType: 'zip' });
  assert.equal(extraerTextoDocx(buffer), 'Juan & Pérez\nCaja Stock\nFin');
});

test('extraerTextoDocx tira error si no es un docx', () => {
  assert.throws(() => extraerTextoDocx(Buffer.from('esto no es un zip')), /docx/);
});
