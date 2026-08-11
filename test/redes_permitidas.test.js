// Filtro perimetral de IPs: define quién puede llegar al servidor. Un error acá abre el
// sistema a internet o deja afuera a la oficina, así que el rango se prueba en los bordes.
//
// El regex se lee del propio server.js en vez de copiarse: si alguien lo afloja a "100."
// para "arreglar" Tailscale, este test lo frena.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function cargarRegex() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/const REDES_PERMITIDAS = (\/.+\/i?);/);
  assert.ok(m, 'no se encontró REDES_PERMITIDAS en server.js');
  return new Function('return ' + m[1])();
}

const REDES = cargarRegex();
// Misma condición que aplica el middleware: el loopback IPv6 se contempla aparte del regex.
const permite = ip => {
  const limpia = String(ip).replace(/^::ffff:/, '');
  return REDES.test(limpia) || limpia === '::1';
};

test('deja entrar loopback y LAN privada', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1',
                    '10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.254']) {
    assert.ok(permite(ip), `debería permitir ${ip}`);
  }
});

test('deja entrar el rango CGNAT de Tailscale (100.64.0.0/10)', () => {
  for (const ip of ['100.64.0.1', '100.70.1.1', '100.100.50.3', '100.119.0.9', '100.127.255.254']) {
    assert.ok(permite(ip), `debería permitir ${ip}`);
  }
});

test('deja entrar el prefijo IPv6 de Tailscale', () => {
  assert.ok(permite('fd7a:115c:a1e0::1'));
  assert.ok(permite('fd7a:115c:a1e0:ab12:3456:7890:abcd:ef01'));
});

test('bloquea lo que está justo afuera del rango de Tailscale', () => {
  // 100.63.x y 100.128.x son los vecinos inmediatos del /10 y son direcciones públicas.
  for (const ip of ['100.63.255.255', '100.128.0.1', '100.20.30.40', '100.0.0.1']) {
    assert.equal(permite(ip), false, `NO debería permitir ${ip}`);
  }
});

test('bloquea lo que está justo afuera de los rangos privados', () => {
  for (const ip of ['172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '126.0.0.1']) {
    assert.equal(permite(ip), false, `NO debería permitir ${ip}`);
  }
});

test('bloquea direcciones públicas', () => {
  for (const ip of ['8.8.8.8', '190.55.10.3', '52.14.7.9', '2800:340:a::1', '']) {
    assert.equal(permite(ip), false, `NO debería permitir ${ip}`);
  }
});

test('los rangos tienen que estar anclados al principio de la dirección', () => {
  // Sin ancla, una IP pública que contenga "10." o "100.64." en el medio pasaría.
  assert.equal(permite('200.10.0.1'), false);
  assert.equal(permite('5.100.64.1'), false);
});
