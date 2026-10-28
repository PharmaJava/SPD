// Pruebas mínimas (humo). El agente escritor las ampliará a ≥40 casos con mutaciones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analizarDescripcion, resumenDescripcion } from '../src/dominio/descripcion-fisica.ts';

test('comprimido con ranura y grabado', () => {
  const r = analizarDescripcion('Comprimidos recubiertos con película, blancos, oblongos, biconvexos, con ranura en una cara y grabados con "M 850" en la otra.');
  assert.deepEqual(r.colores, ['blanco']);
  assert.equal(r.ranura, 'una_cara');
  assert.deepEqual(r.marcas, ['M 850']);
  assert.equal(r.ranuraDivisible, 'desconocido');
  assert.ok(r.avisos.some(a => /ranura/i.test(a)));
});

test('«sin ranura» no cuenta como ranura', () => {
  assert.equal(analizarDescripcion('Comprimido redondo, de color amarillo claro, sin ranura').ranura, 'ninguna');
});

test('cápsula bicolor', () => {
  const r = analizarDescripcion('Cápsulas duras, cuerpo blanco y cabeza azul opaca');
  assert.equal(r.tipo, 'capsula');
  assert.equal(r.colores.length, 2);
});

test('texto vacío: nada inventado y aviso', () => {
  const r = analizarDescripcion('');
  assert.deepEqual(r.colores, []);
  assert.equal(r.forma, null);
  assert.equal(r.avisos.length, 1);
  assert.equal(resumenDescripcion(r), '');
});
