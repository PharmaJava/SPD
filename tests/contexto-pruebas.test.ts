import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { verificarCadena } from '../src/dominio/auditoria.ts';

test('el contexto de pruebas audita con la cadena de hash válida', async () => {
  const { ctx, db } = await crearContextoPruebas('farmaceutico');
  ctx.auditar({ accion: 'crear', entidad: 'paciente', entidadId: 1, despues: { nombre: 'A' } });
  ctx.auditar({ accion: 'modificar', entidad: 'paciente', entidadId: 1, antes: { nombre: 'A' }, despues: { nombre: 'B' } });
  const filas = db.all<Record<string, string>>('SELECT * FROM auditoria ORDER BY id');
  assert.equal(filas.length, 2);
  const entradas = filas.map(f => ({ momento: f.momento, usuarioId: Number(f.usuario_id), accion: f.accion, entidad: f.entidad, entidadId: f.entidad_id, antes: JSON.parse(f.antes), despues: JSON.parse(f.despues), motivo: f.motivo, hashPrevio: f.hash_previo, hash: f.hash }));
  assert.equal(verificarCadena(entradas).ok, true);
});
