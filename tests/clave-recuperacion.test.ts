import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aBase32, deBase32, textoRecuperacion, claveDesdeTexto, uriAutenticador } from '../src/dominio/clave-recuperacion.ts';

const clave = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 255);

test('Base32: vector RFC 4648 («foobar»)', () => {
  assert.equal(aBase32(new TextEncoder().encode('foobar')), 'MZXW6YTBOI');
  assert.equal(new TextDecoder().decode(deBase32('MZXW6YTBOI')), 'foobar');
});

test('ida y vuelta de la clave de recuperación, con espacios y minúsculas', () => {
  const t = textoRecuperacion(clave);
  assert.match(t, /^([A-Z2-7]{4}-){13}[A-Z2-7]{2}$/);
  assert.deepEqual(claveDesdeTexto(t.toLowerCase().replaceAll('-', ' ')), clave);
});

test('una errata se detecta', () => {
  const t = textoRecuperacion(clave);
  const mala = (t[0] === 'A' ? 'B' : 'A') + t.slice(1);
  assert.throws(() => claveDesdeTexto(mala), /errata/);
});

test('longitud y carácter inválidos', () => {
  assert.throws(() => claveDesdeTexto('AAAA'), /longitud/);
  assert.throws(() => textoRecuperacion(new Uint8Array(16)), /32 bytes/);
  assert.throws(() => deBase32('1!'), /no válido/);
});

test('URI de autenticador lleva el secreto y escapa el nombre', () => {
  const u = uriAutenticador(clave, 'Farmacia López & Hnos');
  assert.ok(u.startsWith('otpauth://totp/SPD%20Farmacia%20L%C3%B3pez%20%26%20Hnos?'));
  assert.ok(u.includes('secret=' + aBase32(clave)));
});
