const test = require('node:test');
const assert = require('node:assert');
const {
  slugPrenda, siguienteIdEmpleado, normalizarEstado,
  normalizarPrenda, normalizarEmpleado, normalizarDocumento, resumen,
} = require('../lib/rrhh_ropa');

const PRENDAS = [
  { id: 'remera', nombre: 'Remera / Chomba' },
  { id: 'calzado', nombre: 'Calzado de Seguridad' },
];

test('normalizarEstado acepta las variantes que trae el relevamiento en planilla', () => {
  assert.equal(normalizarEstado('Sí'), 'si');
  assert.equal(normalizarEstado('SI'), 'si');
  assert.equal(normalizarEstado('No'), 'no');
  assert.equal(normalizarEstado('N/A'), 'na');
  assert.equal(normalizarEstado(null), '');
  assert.equal(normalizarEstado('cualquier cosa'), '');
});

test('slugPrenda saca acentos y espacios para armar el id', () => {
  assert.equal(slugPrenda('Pantalón térmico'), 'pantalon-termico');
  assert.equal(slugPrenda('  Cofia  '), 'cofia');
});

test('normalizarPrenda deriva un id único cuando el slug ya está usado', () => {
  assert.deepEqual(normalizarPrenda({ nombre: 'Guantes' }, []), { id: 'guantes', nombre: 'Guantes' });
  assert.deepEqual(normalizarPrenda({ nombre: 'Guantes' }, ['guantes']), { id: 'guantes-2', nombre: 'Guantes' });
});

test('normalizarPrenda rechaza una prenda sin nombre', () => {
  assert.throws(() => normalizarPrenda({ nombre: '  ' }, []), /nombre/);
});

test('normalizarEmpleado completa las prendas faltantes y descarta las que no están en el catálogo', () => {
  const e = normalizarEmpleado(
    { nombre: 'Perez Ana', area: 'Ventas', prendas: { remera: { talle: 'M', estado: 'Sí' }, borrada: { talle: 'X', estado: 'si' } } },
    PRENDAS
  );
  assert.deepEqual(Object.keys(e.prendas), ['remera', 'calzado']);
  assert.deepEqual(e.prendas.remera, { talle: 'M', estado: 'si' });
  assert.deepEqual(e.prendas.calzado, { talle: '', estado: '' });
});

test('normalizarEmpleado deduce calzado obligatorio por área y respeta el override explícito', () => {
  assert.equal(normalizarEmpleado({ nombre: 'A', area: 'Producción' }, PRENDAS).calzadoObligatorio, true);
  assert.equal(normalizarEmpleado({ nombre: 'B', area: 'Ventas' }, PRENDAS).calzadoObligatorio, false);
  assert.equal(normalizarEmpleado({ nombre: 'C', area: 'Ventas', calzadoObligatorio: true }, PRENDAS).calzadoObligatorio, true);
});

test('normalizarEmpleado usa "Sin área asignada" cuando el área viene vacía', () => {
  assert.equal(normalizarEmpleado({ nombre: 'D' }, PRENDAS).area, 'Sin área asignada');
});

test('normalizarEmpleado rechaza un empleado sin nombre', () => {
  assert.throws(() => normalizarEmpleado({ nombre: '', area: 'Ventas' }, PRENDAS), /nombre/);
});

test('siguienteIdEmpleado continúa el correlativo aunque la lista esté desordenada', () => {
  assert.equal(siguienteIdEmpleado([]), 'emp-001');
  assert.equal(siguienteIdEmpleado([{ id: 'emp-003' }, { id: 'emp-001' }]), 'emp-004');
  assert.equal(siguienteIdEmpleado([{ id: 'otra-cosa' }]), 'emp-001');
});

test('normalizarDocumento devuelve empleados alineados al catálogo de prendas', () => {
  const doc = normalizarDocumento({
    prendas: [{ nombre: 'Remera' }, { nombre: 'Remera' }],
    empleados: [{ nombre: 'Perez Ana', prendas: { remera: { estado: 'si' } } }],
  });
  assert.deepEqual(doc.prendas.map(p => p.id), ['remera', 'remera-2']);
  assert.deepEqual(Object.keys(doc.empleados[0].prendas), ['remera', 'remera-2']);
});

test('resumen cuenta faltantes por prenda y por área, sin contar los N/A', () => {
  const r = resumen({
    prendas: PRENDAS,
    empleados: [
      { nombre: 'A', area: 'Producción', prendas: { remera: { estado: 'no' }, calzado: { estado: 'si' } } },
      { nombre: 'B', area: 'Producción', prendas: { remera: { estado: 'no' }, calzado: { estado: 'no' } } },
      { nombre: 'C', area: 'Ventas', prendas: { remera: { estado: 'si' }, calzado: { estado: 'na' } } },
    ],
  });
  assert.equal(r.empleados, 3);
  assert.equal(r.faltantes, 3);
  assert.equal(r.sinRelevar, 0);
  assert.deepEqual(r.faltantesPorPrenda, { remera: 2, calzado: 1 });
  assert.deepEqual(r.porArea, [
    { area: 'Producción', empleados: 2, faltantes: 3 },
    { area: 'Ventas', empleados: 1, faltantes: 0 },
  ]);
});

test('resumen cuenta como sin relevar las prendas sin dato', () => {
  const r = resumen({ prendas: PRENDAS, empleados: [{ nombre: 'A', area: 'Ventas' }] });
  assert.equal(r.sinRelevar, 2);
  assert.equal(r.faltantes, 0);
});

test('el relevamiento real de data/ pasa la normalización sin perder empleados', () => {
  const doc = require('../data/relevamientoRopa/relevamiento_ropa.json');
  const norm = normalizarDocumento(doc);
  assert.equal(norm.empleados.length, doc.empleados.length);
  assert.ok(norm.empleados.length > 0);
  assert.ok(norm.prendas.length > 0);
  assert.ok(norm.empleados.every(e => e.id && e.nombre));
});

test('normalizarEmpleado conserva el resaltado sólo cuando viene en true', () => {
  const prendas = [{ id: 'campera', nombre: 'Campera' }];
  assert.equal(normalizarEmpleado({ nombre: 'Ana', destacado: true }, prendas).destacado, true);
  assert.equal(normalizarEmpleado({ nombre: 'Ana' }, prendas).destacado, false);
  assert.equal(normalizarEmpleado({ nombre: 'Ana', destacado: 'si' }, prendas).destacado, false);
});

// El stream vive en rutas_rrhh.js (no se puede importar sin cablearle las deps del
// server), así que se verifica el cableado sobre el fuente.
test('el server avisa por SSE en toda escritura y suelta al suscriptor que se va', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'rutas_rrhh.js'), 'utf8');
  const bloque = src.slice(src.indexOf('const RRHH_ROPA_PATH'), src.indexOf('RRHH · Ausencias'));

  // Único punto de escritura: si avisa desde acá, avisa siempre.
  const guardar = bloque.slice(bloque.indexOf('function guardarRopa'), bloque.indexOf('function avisarRopa'));
  assert.ok(guardar.includes('avisarRopa(limpio)'), 'guardarRopa tiene que avisar el documento ya normalizado');
  assert.ok(!/guardarJSON\(RRHH_ROPA_PATH/.test(bloque.replace(guardar, '')),
    'ninguna ruta puede escribir el JSON esquivando guardarRopa');

  const stream = bloque.slice(bloque.indexOf("router.get('/api/rrhh/ropa/stream'"));
  assert.ok(stream.includes("'Content-Type': 'text/event-stream'"), 'el stream tiene que declararse como SSE');
  assert.ok(stream.indexOf('ropaSuscriptores.add(res)') < stream.indexOf("req.on('close'"),
    'primero se suscribe y después se registra la baja');
  const cierre = stream.slice(stream.indexOf("req.on('close'"), stream.indexOf("req.on('close'") + 200);
  assert.ok(cierre.includes('clearInterval(latido)') && cierre.includes('ropaSuscriptores.delete(res)'),
    'al cerrarse la conexión hay que cortar el latido y sacar al suscriptor');
});
