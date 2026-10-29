import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generarCodigoSvg, codigoSvg, MAX_TEXTO_CODIGO } from '../src/servicios/codigos.ts';

test('QR: devuelve un SVG', () => {
  const r = generarCodigoSvg('SPD-ABC123', 'qrcode');
  assert.ok(r.ok);
  if (r.ok) { assert.ok(r.datos.startsWith('<svg')); assert.ok(r.datos.includes('</svg>')); }
});

test('DataMatrix: devuelve un SVG', () => {
  const r = generarCodigoSvg('01084700000000011721010110ABC', 'datamatrix');
  assert.ok(r.ok);
  if (r.ok) assert.ok(r.datos.startsWith('<svg'));
});

test('es determinista: mismo texto, mismo SVG', () => {
  const a = generarCodigoSvg('hola', 'qrcode'), b = generarCodigoSvg('hola', 'qrcode');
  assert.deepEqual(a, b);
});

test('textos distintos dan SVG distintos', () => {
  const a = generarCodigoSvg('hola', 'qrcode'), b = generarCodigoSvg('adios', 'qrcode');
  assert.ok(a.ok && b.ok && a.datos !== b.datos);
});

test('texto vacío o no texto: fallo', () => {
  for (const t of ['', null, undefined, 12, {}]) {
    const r = generarCodigoSvg(t, 'qrcode');
    assert.equal(r.ok, false);
  }
});

test('texto demasiado largo: fallo', () => {
  const r = generarCodigoSvg('a'.repeat(MAX_TEXTO_CODIGO + 1), 'qrcode');
  assert.equal(r.ok, false);
  assert.equal(generarCodigoSvg('a'.repeat(MAX_TEXTO_CODIGO), 'qrcode').ok, true);
});

test('caracteres de control: fallo, salvo GS', () => {
  assert.equal(generarCodigoSvg('a\u0000b', 'qrcode').ok, false);
  assert.equal(generarCodigoSvg('a\nb', 'datamatrix').ok, false);
  assert.equal(generarCodigoSvg('01084700000000011721010110ABC\u001d2100123', 'datamatrix').ok, true);
});

test('simbología no admitida: fallo', () => {
  for (const s of ['code128', '', null, 3, 'QRCODE']) assert.equal(generarCodigoSvg('x', s).ok, false);
});

test('nunca lanza: devuelve Resultado', async () => {
  const r = await codigoSvg('x', 'qrcode');
  assert.equal(r.ok, true);
});
