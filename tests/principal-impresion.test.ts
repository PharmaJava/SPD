import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mmAMicras, mmAPulgadas, motivoHtmlInvalido, normalizarOpciones, argumentosPrint, argumentosPdf, nombreFicheroSeguro, impresoraInstalada, MAX_HTML_BYTES } from '../src/principal/impresion.ts';

test('mm → micras y pulgadas', () => {
  assert.equal(mmAMicras(100), 100000);
  assert.equal(mmAMicras(99.1), 99100);
  assert.equal(mmAMicras(38.1), 38100);
  assert.ok(Math.abs(mmAPulgadas(25.4) - 1) < 1e-12);
});

test('HTML: sólo texto no vacío y de tamaño razonable', () => {
  assert.equal(motivoHtmlInvalido('<p>x</p>'), null);
  for (const h of [undefined, null, 5, {}, '', '   \n']) assert.ok(motivoHtmlInvalido(h));
  assert.ok(motivoHtmlInvalido('a'.repeat(MAX_HTML_BYTES + 1)));
});

test('opciones: válidas y por defecto', () => {
  assert.deepEqual(normalizarOpciones(undefined), { ok: true, opciones: {} });
  assert.deepEqual(normalizarOpciones({}), { ok: true, opciones: {} });
  const r = normalizarOpciones({ impresora: 'Zebra ZD220', anchoMm: 100, altoMm: 150, silenciosa: true });
  assert.deepEqual(r, { ok: true, opciones: { impresora: 'Zebra ZD220', anchoMm: 100, altoMm: 150, silenciosa: true } });
});

test('opciones inválidas: rechazadas', () => {
  const malas: unknown[] = [
    'texto', [], { anchoMm: 100 }, { altoMm: 100 }, { anchoMm: 5, altoMm: 100 }, { anchoMm: 100, altoMm: 5000 },
    { anchoMm: NaN, altoMm: 10 }, { anchoMm: '100', altoMm: '150' }, { anchoMm: -100, altoMm: 100 },
    { impresora: 5 }, { impresora: 'x'.repeat(300) }, { silenciosa: 'sí' },
  ];
  for (const m of malas) assert.equal(normalizarOpciones(m).ok, false, JSON.stringify(m));
});

test('print: micras, silencioso, sin márgenes y con impresora', () => {
  const a = argumentosPrint({ impresora: 'Zebra', anchoMm: 100, altoMm: 150, silenciosa: true });
  assert.deepEqual(a, { silent: true, printBackground: true, margins: { marginType: 'none' }, deviceName: 'Zebra', pageSize: { width: 100000, height: 150000 } });
  const b = argumentosPrint({});
  assert.equal(b.silent, false); assert.ok(!('deviceName' in b)); assert.ok(!('pageSize' in b));
});

test('pdf: CSS manda; tamaño en pulgadas si se indica; A4 si no', () => {
  const a = argumentosPdf({ anchoMm: 100, altoMm: 150 }) as any;
  assert.equal(a.preferCSSPageSize, true); assert.ok(Math.abs(a.pageSize.width - 100 / 25.4) < 1e-9);
  assert.equal((argumentosPdf(undefined) as any).pageSize, 'A4');
  assert.equal((argumentosPdf({ anchoMm: 1, altoMm: 1 }) as any).pageSize, 'A4');
});

test('nombre de fichero: sin rutas ni trucos, con extensión única', () => {
  assert.equal(nombreFicheroSeguro('Hoja Ana.pdf', 'pdf'), 'Hoja Ana.pdf');
  assert.equal(nombreFicheroSeguro('../../etc/passwd', 'pdf'), '._._etc_passwd.pdf'.replace(/^\.+/, ''));
  assert.ok(!nombreFicheroSeguro('..\\..\\Windows\\x', 'pdf').includes('\\'));
  assert.equal(nombreFicheroSeguro('', 'pdf'), 'documento.pdf');
  assert.equal(nombreFicheroSeguro(null, 'pdf'), 'documento.pdf');
  assert.equal(nombreFicheroSeguro('....', 'pdf'), 'documento.pdf');
  assert.ok(nombreFicheroSeguro('a'.repeat(500), 'pdf').length <= 104);
  assert.ok(!/[<>:"|?*\u0000]/.test(nombreFicheroSeguro('a<b>:"c|d?*\u0000', 'pdf')));
});

test('impresoraInstalada: comparación exacta', () => {
  const l = [{ name: 'Zebra ZD220' }, { name: 'HP LaserJet' }];
  assert.equal(impresoraInstalada('Zebra ZD220', l), true);
  assert.equal(impresoraInstalada('zebra zd220', l), false);
  assert.equal(impresoraInstalada('Zebra', l), false);
});
