import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { abrirDb, VERSION_ESQUEMA } from '../src/servicios/db.ts';
import { ESQUEMA_V1 } from '../src/servicios/esquema-sql.ts';

test('el esquema generado coincide con db/schema.sql (ejecuta npm run gen:esquema si falla)', () => {
  assert.equal(ESQUEMA_V1, readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
});

test('base nueva: esquema aplicado, versión y claves foráneas', async () => {
  const db = await abrirDb();
  assert.equal(db.version(), VERSION_ESQUEMA);
  assert.ok(db.get<{ n: number }>("SELECT count(*) n FROM sqlite_master WHERE type='table'")!.n >= 28);
  assert.throws(() => db.run('INSERT INTO contacto(paciente_id,tipo,nombre) VALUES (999,\'cuidador\',\'x\')'));
});

test('run/get/all y últimoId', async () => {
  const db = await abrirDb();
  const a = db.run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES (?,?,?,?)", ['Ana', 'A', 'titular', 'x']);
  assert.equal(a.cambios, 1);
  assert.equal(a.ultimoId, 1);
  assert.equal(db.get<{ nombre: string }>('SELECT nombre FROM usuario WHERE id=?', [1])!.nombre, 'Ana');
  assert.equal(db.all('SELECT * FROM usuario').length, 1);
  assert.equal(db.get('SELECT * FROM usuario WHERE id=99'), undefined);
});

test('transacción: confirma y revierte; anidada con savepoint', async () => {
  const db = await abrirDb();
  const ins = (n: string) => db.run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES (?,?,?,?)", [n, 'X', 'tecnico', 'x']);
  db.transaccion(() => { ins('a'); });
  assert.throws(() => db.transaccion(() => { ins('b'); throw new Error('falla'); }), /falla/);
  assert.equal(db.all('SELECT * FROM usuario').length, 1);
  db.transaccion(() => {
    ins('c');
    assert.throws(() => db.transaccion(() => { ins('d'); throw new Error('interna'); }));
    ins('e');
  });
  assert.deepEqual(db.all<{ nombre: string }>('SELECT nombre FROM usuario ORDER BY id').map(r => r.nombre), ['a', 'c', 'e']);
});

test('exportar y reabrir conserva los datos y no vuelve a aplicar el esquema', async () => {
  const db = await abrirDb();
  db.run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Z','Z','titular','x')");
  const bytes = db.exportar();
  const db2 = await abrirDb(bytes);
  assert.equal(db2.get<{ nombre: string }>('SELECT nombre FROM usuario')!.nombre, 'Z');
  assert.equal(db2.version(), VERSION_ESQUEMA);
});

test('la auditoría de la base no se puede modificar ni borrar (disparadores)', async () => {
  const db = await abrirDb();
  db.run("INSERT INTO auditoria(accion,entidad,hash_previo,hash) VALUES ('x','y','0','1')");
  assert.throws(() => db.run('DELETE FROM auditoria'), /no se borra/);
  assert.throws(() => db.run("UPDATE auditoria SET accion='z'"), /no se modifica/);
});

test('una base de versión futura se rechaza', async () => {
  const db = await abrirDb();
  db.exec('PRAGMA user_version = 99;');
  await assert.rejects(() => abrirDb(db.exportar()), /más nueva/);
});
