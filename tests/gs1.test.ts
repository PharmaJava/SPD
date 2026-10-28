import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsearGS1, normalizarCN, fechaGS1, gtinValido, digitoControlGS1, cnDesdeGtin, GS } from '../src/dominio/gs1.ts';

const HOY = new Date(Date.UTC(2026, 9, 28));
// GTIN-14 español con CN 712729: 0 + 847000 + 712729 + control
const base = '0847000712729';
const GTIN = base + digitoControlGS1(base);

test('dígito de control GS1 con un GTIN-13 conocido (EAN 4006381333931)', () => {
  assert.equal(digitoControlGS1('400638133393'), 1);
  assert.ok(gtinValido('4006381333931'));
  assert.ok(!gtinValido('4006381333932'));
});

test('CN desde GTIN-14 y GTIN-13 españoles', () => {
  assert.equal(cnDesdeGtin(GTIN), '712729');
  assert.equal(cnDesdeGtin(GTIN.slice(1)), '712729');
  assert.equal(cnDesdeGtin('04006381333931'), null);
});

test('lectura completa con separadores GS', () => {
  const r = parsearGS1(`]d201${GTIN}17280531` + `10AB12C${GS}21SERIE0001`, { hoy: HOY });
  assert.equal(r.cn, '712729');
  assert.equal(r.caducidad, '2028-05-31');
  assert.equal(r.lote, 'AB12C');
  assert.equal(r.serie, 'SERIE0001');
  assert.equal(r.ambiguo, false);
  assert.deepEqual(r.errores, []);
});

test('el orden de los campos no importa', () => {
  const r = parsearGS1(`01${GTIN}21XYZ987${GS}17271100` + `10L-55`, { hoy: HOY });
  assert.equal(r.serie, 'XYZ987');
  assert.equal(r.caducidad, '2027-11-30');   // día 00 = último del mes
  assert.equal(r.lote, 'L-55');
});

test('sin separador entre lote y serie → ambiguo, no adivina', () => {
  const r = parsearGS1(`01${GTIN}1728053110AB1221SER9`, { hoy: HOY });
  assert.equal(r.ambiguo, true);
  assert.ok(r.candidatas.length > 1);
  assert.match(r.avisos.join(' '), /Confirma el lote/);
});

test('separador sustituto configurado (lector en modo teclado)', () => {
  const r = parsearGS1(`01${GTIN}1728053110AB12~21SER9`, { hoy: HOY, separadores: ['~'] });
  assert.equal(r.ambiguo, false);
  assert.equal(r.lote, 'AB12');
  assert.equal(r.serie, 'SER9');
});

test('GTIN con dígito de control mal → error, no lectura', () => {
  const malo = GTIN.slice(0, -1) + ((Number(GTIN.at(-1)) + 1) % 10);
  const r = parsearGS1(`01${malo}1728053110AB${GS}21S`, { hoy: HOY });
  assert.ok(r.errores.length > 0);
  assert.equal(r.cn, undefined);
});

test('falta lote → se dice', () => {
  const r = parsearGS1(`01${GTIN}17280531`, { hoy: HOY });
  assert.match(r.errores.join(' '), /lote/);
});

test('fecha GS1: siglo por ventana, día 00 y fechas imposibles', () => {
  assert.equal(fechaGS1('290200', HOY), '2029-02-28');
  assert.equal(fechaGS1('280200', HOY), '2028-02-29');
  assert.equal(fechaGS1('991231', HOY), '1999-12-31');
  assert.equal(fechaGS1('281301', HOY), null);
  assert.equal(fechaGS1('280231', HOY), null);
});

test('normalizarCN acepta las formas habituales y NO valida el dígito del CN', () => {
  assert.equal(normalizarCN('712729.3'), '712729');
  assert.equal(normalizarCN('C.N. 712729.9'), '712729');   // control "malo" igualmente aceptado
  assert.equal(normalizarCN('712729'), '712729');
  assert.equal(normalizarCN(GTIN), '712729');
  assert.equal(normalizarCN('12345'), null);
});

test('lectura ambigua: NO se adivina el lote ni la serie (regla 1)', () => {
  const r = parsearGS1(`01${GTIN}1728053110AB1221SER9`, { hoy: HOY });
  assert.equal(r.ambiguo, true);
  assert.equal(r.lote, undefined);
  assert.equal(r.serie, undefined);
  assert.equal(r.caducidad, '2028-05-31');   // lo que es igual en todas las candidatas sí se rellena
  assert.equal(r.cn, '712729');
});
