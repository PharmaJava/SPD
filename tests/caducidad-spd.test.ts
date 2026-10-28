import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularCaducidadSpd, periodoCabe, puedeValidar } from '../src/dominio/caducidad-spd.ts';

const base = { fechaPreparacion: '2026-11-02', caducidadesLotes: ['2028-05-31'], validezExtendidaPermitida: false };

test('estándar: 14 días desde la preparación', () => {
  const r = calcularCaducidadSpd({ ...base, diasValidez: 14 });
  assert.equal(r.ok, true);
  assert.equal(r.caducidadSpd, '2026-11-16');
  assert.equal(r.limitadaPor, 'validez');
  assert.equal(r.fueraDeEstandar, false);
});

test('el lote que antes caduca limita al SPD', () => {
  const r = calcularCaducidadSpd({ ...base, caducidadesLotes: ['2028-05-31', '2026-11-10'], diasValidez: 14 });
  assert.equal(r.caducidadSpd, '2026-11-10');
  assert.equal(r.limitadaPor, 'lote');
});

test('más de 14 días no se permite si el ajuste está apagado', () => {
  const r = calcularCaducidadSpd({ ...base, diasValidez: 30, justificacion: 'Paciente rural, recogida mensual' });
  assert.equal(r.ok, false);
  assert.match(r.errores.join(' '), /no activada/);
});

test('más de 14 días activado exige justificación', () => {
  const r = calcularCaducidadSpd({ ...base, validezExtendidaPermitida: true, diasValidez: 30, justificacion: 'corta' });
  assert.equal(r.ok, false);
  assert.match(r.errores.join(' '), /justificación/);
});

test('un mes con ajuste y justificación: vale, queda marcado como desviación', () => {
  const r = calcularCaducidadSpd({ ...base, validezExtendidaPermitida: true, diasValidez: 30, justificacion: 'Paciente rural, recogida mensual' });
  assert.equal(r.ok, true);
  assert.equal(r.caducidadSpd, '2026-12-02');
  assert.equal(r.fueraDeEstandar, true);
  assert.match(r.avisos.join(' '), /desviación/);
});

test('el tope absoluto es 30 días', () => {
  const r = calcularCaducidadSpd({ ...base, validezExtendidaPermitida: true, diasValidez: 31, justificacion: 'x'.repeat(20) });
  assert.equal(r.ok, false);
});

test('lote caducado antes de preparar, fechas y días inválidos', () => {
  assert.equal(calcularCaducidadSpd({ ...base, caducidadesLotes: ['2026-10-01'], diasValidez: 14 }).ok, false);
  assert.equal(calcularCaducidadSpd({ ...base, fechaPreparacion: '2026-13-40', diasValidez: 14 }).ok, false);
  assert.equal(calcularCaducidadSpd({ ...base, diasValidez: 0 }).ok, false);
  assert.equal(calcularCaducidadSpd({ ...base, caducidadesLotes: [], diasValidez: 14 }).ok, false);
});

test('cruce de año y bisiesto', () => {
  assert.equal(calcularCaducidadSpd({ ...base, fechaPreparacion: '2027-12-25', diasValidez: 14 }).caducidadSpd, '2028-01-08');
  assert.equal(calcularCaducidadSpd({ ...base, fechaPreparacion: '2028-02-20', diasValidez: 14 }).caducidadSpd, '2028-03-05');
});

test('el periodo debe caber en la caducidad', () => {
  assert.equal(periodoCabe('2026-11-16', '2026-11-16'), true);
  assert.equal(periodoCabe('2026-11-17', '2026-11-16'), false);
});

test('sólo un farmacéutico (o el titular) valida', () => {
  assert.equal(puedeValidar('farmaceutico'), true);
  assert.equal(puedeValidar('titular'), true);
  assert.equal(puedeValidar('tecnico'), false);
  assert.equal(puedeValidar('administrativo'), false);
});
