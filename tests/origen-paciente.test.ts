import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIPOS_CENTRO, ETIQUETA_TIPO_CENTRO, esTipoCentro, origenDe, normalizarNombreCentro, buscarCentroIgual, sugerirCentros, resumirOrigen } from '../src/dominio/origen-paciente.ts';

test('tipos de centro: lista cerrada y etiqueta para cada uno', () => {
  assert.equal(TIPOS_CENTRO.length, 8);
  for (const t of TIPOS_CENTRO) { assert.ok(ETIQUETA_TIPO_CENTRO[t]); assert.equal(esTipoCentro(t), true); }
  for (const v of ['', 'residencia', null, undefined, 3, 'Hospital']) assert.equal(esTipoCentro(v), false);
});

test('origen: sin centro = individual', () => {
  assert.equal(origenDe(null), 'individual');
  assert.equal(origenDe(undefined), 'individual');
  assert.equal(origenDe(7), 'centro');
  assert.equal(origenDe(0), 'centro');   // el id 0 no es «sin centro»
});

test('normalizar nombre de centro: mayúsculas, tildes, espacios y signos no crean duplicados', () => {
  const k = normalizarNombreCentro('Residencia San José');
  for (const v of ['  residencia   san jose ', 'RESIDENCIA SAN JOSÉ.', 'Residencia "San José"', 'residencia-san-jose']) assert.equal(normalizarNombreCentro(v), k);
  assert.notEqual(normalizarNombreCentro('Residencia San José II'), k);
  assert.equal(normalizarNombreCentro('  . '), '');
  assert.equal(normalizarNombreCentro(null), '');
  assert.equal(normalizarNombreCentro(12), '');
});

test('buscarCentroIgual: encuentra por clave normalizada y respeta excluirId', () => {
  const cs = [{ id: 1, nombre: 'Residencia Sol' }, { id: 2, nombre: 'Hospital Norte' }];
  assert.equal(buscarCentroIgual(cs, ' residencia  SOL')?.id, 1);
  assert.equal(buscarCentroIgual(cs, 'Residencia Sol', 1), undefined);
  assert.equal(buscarCentroIgual(cs, '   '), undefined);
  assert.equal(buscarCentroIgual(cs, 'Residencia Luna'), undefined);
});

test('sugerirCentros: contiene lo escrito; los que empiezan, primero; tope', () => {
  const cs = [{ nombre: 'Casa Residencia Sol' }, { nombre: 'Residencia Sol' }, { nombre: 'Hospital' }];
  assert.deepEqual(sugerirCentros(cs, 'resid').map((c) => c.nombre), ['Residencia Sol', 'Casa Residencia Sol']);
  assert.equal(sugerirCentros(cs, '').length, 3);
  assert.equal(sugerirCentros(cs, '', 2).length, 2);
  assert.equal(sugerirCentros(cs, 'zzz').length, 0);
});

test('resumirOrigen: individuales, por tipo y por centro (con centros sin pacientes)', () => {
  const centros = [
    { id: 1, nombre: 'Sol', tipo: 'residencia_mayores' as const },
    { id: 2, nombre: 'Luna', tipo: 'residencia_mayores' as const },
    { id: 3, nombre: 'Mente', tipo: 'salud_mental' as const },
  ];
  const r = resumirOrigen([
    { centroId: null }, { centroId: null }, { centroId: 1 }, { centroId: 1 }, { centroId: 3 },
  ], centros);
  assert.equal(r.total, 5);
  assert.equal(r.individuales, 2);
  assert.equal(r.porTipo.length, TIPOS_CENTRO.length);
  const t = (x: string) => r.porTipo.find((p) => p.tipo === x)!;
  assert.deepEqual([t('residencia_mayores').pacientes, t('residencia_mayores').centros], [2, 2]);
  assert.deepEqual([t('salud_mental').pacientes, t('salud_mental').centros], [1, 1]);
  assert.deepEqual([t('hospital').pacientes, t('hospital').centros], [0, 0]);
  assert.deepEqual(r.porCentro.map((c) => [c.nombre, c.pacientes]), [['Sol', 2], ['Mente', 1], ['Luna', 0]]);
  // Suma coherente: individuales + pacientes en centros = total
  assert.equal(r.individuales + r.porTipo.reduce((s, x) => s + x.pacientes, 0), r.total);
});

test('resumirOrigen: un centro no listado se cuenta con los datos del paciente (y como «otro» si no hay tipo)', () => {
  const r = resumirOrigen([{ centroId: 9, centroNombre: 'X' }]);
  assert.deepEqual(r.porCentro, [{ centroId: 9, nombre: 'X', tipo: 'otro', pacientes: 1 }]);
  assert.equal(r.porTipo.find((p) => p.tipo === 'otro')!.pacientes, 1);
});
