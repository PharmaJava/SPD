import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearAlmacen, COD_COPIA_DISPONIBLE } from '../src/servicios/almacen.ts';
import type { Temporizador } from '../src/servicios/almacen.ts';
import { abrirConContrasena } from '../src/servicios/seguridad.ts';
import { ErrorSpd } from '../src/servicios/contexto.ts';

const KDF = { n: 1 << 10, r: 8, p: 1 };
const PASS = 'contraseña-de-prueba';

function temp() { return mkdtempSync(join(tmpdir(), 'spd-almacen-')); }
const limpiar = (d: string) => rmSync(d, { recursive: true, force: true });
const codigo = async (f: () => Promise<unknown> | unknown) => { try { await f(); } catch (e) { return e instanceof ErrorSpd ? e.codigo : 'OTRO:' + (e as Error).message; } return 'SIN_ERROR'; };

/** Temporizador manual: nada se dispara solo. */
function manual() {
  const pendientes = new Map<number, () => void>(); let n = 0;
  const t: Temporizador = { programar(fn) { pendientes.set(++n, fn); return n; }, cancelar(h) { pendientes.delete(h as number); } };
  return { t, hay: () => pendientes.size, disparar: () => { const fs = [...pendientes.values()]; pendientes.clear(); fs.forEach(f => f()); } };
}
const nuevoAlmacen = (ruta: string, extra = {}) => crearAlmacen({ rutaDatos: ruta, kdf: KDF, ...extra });
const poblar = (nombre: string) => (db: import('../src/servicios/db.ts').Db) => { db.run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES (?,?,?,?)", [nombre, 'X', 'titular', 'h']); };
const nombres = (a: ReturnType<typeof crearAlmacen>) => a.db().all<{ nombre: string }>('SELECT nombre FROM usuario ORDER BY id').map(f => f.nombre);

test('crear: deja el fichero cifrado, desbloqueado, sin temporales', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d);
    assert.equal(a.existe(), false); assert.equal(a.estaDesbloqueado(), false);
    const { claveDatos } = await a.crear(PASS, poblar('Ana'));
    assert.equal(claveDatos.length, 32);
    assert.equal(a.existe(), true); assert.equal(a.estaDesbloqueado(), true);
    assert.deepEqual(readdirSync(d), ['spd.datos']);
    assert.equal(abrirConContrasena(readFileSync(join(d, 'spd.datos')), PASS).bytesDb.length > 1000, true);
  } finally { limpiar(d); }
});

test('crear dos veces → YA_INICIALIZADO y no pisa lo que hay', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    await a.bloquear();
    const antes = readFileSync(join(d, 'spd.datos'));
    assert.equal(await codigo(() => nuevoAlmacen(d).crear('otra-contraseña')), 'YA_INICIALIZADO');
    assert.deepEqual(readFileSync(join(d, 'spd.datos')), antes);
  } finally { limpiar(d); }
});

test('si «poblar» falla no se escribe nada y se puede reintentar', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d);
    assert.equal(await codigo(() => a.crear(PASS, () => { throw new Error('boom'); })), 'OTRO:boom');
    assert.equal(a.existe(), false); assert.equal(a.estaDesbloqueado(), false);
    await a.crear(PASS, poblar('Ana'));
    assert.equal(a.estaDesbloqueado(), true);
  } finally { limpiar(d); }
});

test('cerrar y reabrir: los datos están y la contraseña mala se rechaza sin desbloquear', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    await a.bloquear();
    const b = nuevoAlmacen(d);
    assert.equal(await codigo(() => b.desbloquear('mala-mala-mala')), 'CONTRASENA_INCORRECTA');
    assert.equal(b.estaDesbloqueado(), false);
    await b.desbloquear(PASS);
    assert.deepEqual(nombres(b), ['Ana']);
  } finally { limpiar(d); }
});

test('bloqueado: db() lanza «bloqueado» y la base queda descartada', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    assert.doesNotThrow(() => a.db());
    await a.bloquear();
    assert.throws(() => a.db(), /bloqueado/);
    assert.equal(a.estaDesbloqueado(), false);
    a.persistir();    // no hace nada y no lanza
  } finally { limpiar(d); }
});

test('guardado con debounce: varias llamadas = una sola escritura, al dispararse el temporizador', async () => {
  const d = temp(); const m = manual();
  try {
    const a = nuevoAlmacen(d, { temporizador: m.t, debounceMs: 400 });
    await a.crear(PASS, poblar('Ana'));
    const base = a.escrituras();
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir();
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Cris','C','tecnico','h')"); a.persistir();
    a.persistir();
    assert.equal(m.hay(), 1);
    assert.equal(a.escrituras(), base);            // aún nada en disco
    m.disparar();
    await a.flush();                               // espera a que termine la cola
    assert.equal(a.escrituras(), base + 1);
    await a.bloquear();
    const b = nuevoAlmacen(d); await b.desbloquear(PASS);
    assert.deepEqual(nombres(b), ['Ana', 'Beto', 'Cris']);
  } finally { limpiar(d); }
});

test('bloquear vacía lo pendiente aunque el temporizador no haya saltado', async () => {
  const d = temp(); const m = manual();
  try {
    const a = nuevoAlmacen(d, { temporizador: m.t });
    await a.crear(PASS, poblar('Ana'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir();
    assert.equal(m.hay(), 1);
    assert.deepEqual(await a.bloquear(), {});
    assert.equal(m.hay(), 0);
    const b = nuevoAlmacen(d); await b.desbloquear(PASS);
    assert.deepEqual(nombres(b), ['Ana', 'Beto']);
  } finally { limpiar(d); }
});

test('sin cambios no se reescribe el fichero', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    const n = a.escrituras();
    await a.flush(); await a.bloquear();
    assert.equal(a.escrituras(), n);
  } finally { limpiar(d); }
});

test('cada guardado conserva el estado anterior en spd.datos.bak', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    assert.equal(existsSync(join(d, 'spd.datos.bak')), false);        // el primer guardado no tiene anterior
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir();
    await a.flush();
    assert.equal(existsSync(join(d, 'spd.datos.bak')), true);
    const bak = abrirConContrasena(readFileSync(join(d, 'spd.datos.bak')), PASS);
    const actual = abrirConContrasena(readFileSync(join(d, 'spd.datos')), PASS);
    assert.notDeepEqual(Buffer.from(bak.bytesDb), Buffer.from(actual.bytesDb));
    assert.deepEqual(readdirSync(d).sort(), ['spd.datos', 'spd.datos.bak']);
    await a.bloquear();
  } finally { limpiar(d); }
});

test('principal truncado + copia buena: avisa, ofrece la copia y con «usarCopia» la restaura', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir(); await a.flush();
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Cris','C','tecnico','h')"); a.persistir(); await a.flush();
    await a.bloquear();
    const principal = readFileSync(join(d, 'spd.datos'));
    writeFileSync(join(d, 'spd.datos'), principal.subarray(0, principal.length - 40));    // truncado

    const b = nuevoAlmacen(d);
    assert.equal(await codigo(() => b.desbloquear(PASS)), COD_COPIA_DISPONIBLE);
    assert.equal(b.estaDesbloqueado(), false);                                           // no usa la copia sin permiso
    const r = await b.desbloquear(PASS, { usarCopia: true });
    assert.match(r.aviso ?? '', /copia anterior/);
    assert.deepEqual(nombres(b), ['Ana', 'Beto']);                                        // el estado de antes del último guardado
    assert.ok(readdirSync(d).some(f => f.startsWith('spd.datos.danado-')));              // lo dañado se conserva
    await b.bloquear();
    const c = nuevoAlmacen(d); await c.desbloquear(PASS);                                // y ahora el principal ya abre solo
    assert.deepEqual(nombres(c), ['Ana', 'Beto']);
  } finally { limpiar(d); }
});

test('principal con un byte cambiado + copia buena: lo mismo', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir(); await a.flush(); await a.bloquear();
    const p = readFileSync(join(d, 'spd.datos')); p[p.length - 100] ^= 0xff; writeFileSync(join(d, 'spd.datos'), p);
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS)), COD_COPIA_DISPONIBLE);
  } finally { limpiar(d); }
});

test('falta el principal pero hay copia → también la ofrece', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir(); await a.flush(); await a.bloquear();
    rmSync(join(d, 'spd.datos'));
    const b = nuevoAlmacen(d);
    assert.equal(b.existe(), true);
    assert.equal(await codigo(() => b.desbloquear(PASS)), COD_COPIA_DISPONIBLE);
    await b.desbloquear(PASS, { usarCopia: true });
    assert.deepEqual(nombres(b), ['Ana']);
  } finally { limpiar(d); }
});

test('principal dañado y SIN copia (o con copia también dañada): error claro, sin oferta', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana')); await a.bloquear();
    const p = readFileSync(join(d, 'spd.datos')); writeFileSync(join(d, 'spd.datos'), p.subarray(0, 50));
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS)), 'FICHERO_CORRUPTO');
    writeFileSync(join(d, 'spd.datos.bak'), Buffer.from('basura'));
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS)), 'FICHERO_CORRUPTO');
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS, { usarCopia: true })), 'FICHERO_CORRUPTO');
  } finally { limpiar(d); }
});

test('contraseña incorrecta NUNCA cae a la copia', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir(); await a.flush(); await a.bloquear();
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear('mala-mala-mala')), 'CONTRASENA_INCORRECTA');
  } finally { limpiar(d); }
});

test('sin datos creados: desbloquear → NO_INICIALIZADO', async () => {
  const d = temp();
  try { assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS)), 'NO_INICIALIZADO'); } finally { limpiar(d); }
});

test('cambiar contraseña: la nueva abre, la vieja no, y exige la actual', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana'));
    assert.equal(await codigo(() => a.cambiarContrasena('no-es-esta', 'nueva-contraseña')), 'CONTRASENA_INCORRECTA');
    await a.cambiarContrasena(PASS, 'nueva-contraseña');
    assert.equal(a.verificarContrasena('nueva-contraseña'), true);
    assert.equal(a.verificarContrasena(PASS), false);
    await a.bloquear();
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS)), 'CONTRASENA_INCORRECTA');
    const b = nuevoAlmacen(d); await b.desbloquear('nueva-contraseña');
    assert.deepEqual(nombres(b), ['Ana']);
  } finally { limpiar(d); }
});

test('cambiar contraseña con cambios sin guardar: no se pierden', async () => {
  const d = temp(); const m = manual();
  try {
    const a = nuevoAlmacen(d, { temporizador: m.t });
    await a.crear(PASS, poblar('Ana'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir();
    await a.cambiarContrasena(PASS, 'nueva-contraseña');
    await a.bloquear();
    const b = nuevoAlmacen(d); await b.desbloquear('nueva-contraseña');
    assert.deepEqual(nombres(b), ['Ana', 'Beto']);
  } finally { limpiar(d); }
});

test('recuperar con la clave de datos fija contraseña nueva', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); const { claveDatos } = await a.crear(PASS, poblar('Ana')); await a.bloquear();
    const b = nuevoAlmacen(d);
    assert.equal(await codigo(() => b.recuperar(new Uint8Array(32), 'otra-contraseña')), 'FICHERO_CORRUPTO');
    assert.equal(b.estaDesbloqueado(), false);
    await b.recuperar(claveDatos, 'otra-contraseña');
    assert.deepEqual(nombres(b), ['Ana']);
    await b.bloquear();
    assert.equal(await codigo(() => nuevoAlmacen(d).desbloquear(PASS)), 'CONTRASENA_INCORRECTA');
    await nuevoAlmacen(d).desbloquear('otra-contraseña');
  } finally { limpiar(d); }
});

test('fallo de escritura: se dice, no se pierde la memoria y se puede reintentar', async () => {
  const d = temp(); const errores: string[] = []; const m = manual();
  try {
    const dir = join(d, 'datos');
    const a = nuevoAlmacen(dir, { temporizador: m.t, alError: (e: Error) => errores.push(e.message) });
    await a.crear(PASS, poblar('Ana'));
    rmSync(dir, { recursive: true }); writeFileSync(dir, 'esto es un fichero, no una carpeta');
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir();
    m.disparar();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(errores.length, 1);
    assert.match(errores[0], /No se pudo guardar/);
    assert.ok(a.ultimoErrorGuardado());
    assert.deepEqual(nombres(a), ['Ana', 'Beto']);                                        // la memoria sigue intacta
    assert.equal(await codigo(() => a.flush()), 'ERROR_GUARDADO');
    rmSync(dir); 
    await a.flush();                                                                      // arreglado el disco, guarda
    assert.equal(a.ultimoErrorGuardado(), null);
    await a.bloquear();
    const b = nuevoAlmacen(dir); await b.desbloquear(PASS);
    assert.deepEqual(nombres(b), ['Ana', 'Beto']);
  } finally { limpiar(d); }
});

test('bloquear con el disco roto bloquea igualmente y devuelve el error', async () => {
  const d = temp();
  try {
    const dir = join(d, 'datos');
    const a = nuevoAlmacen(dir); await a.crear(PASS, poblar('Ana'));
    rmSync(dir, { recursive: true }); writeFileSync(dir, 'x');
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Beto','B','tecnico','h')"); a.persistir();
    const r = await a.bloquear();
    assert.match(r.errorGuardado ?? '', /No se pudo guardar/);
    assert.equal(a.estaDesbloqueado(), false);
  } finally { limpiar(d); }
});

test('restos .tmp de un guardado interrumpido se limpian al abrir y no estorban', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Ana')); await a.bloquear();
    writeFileSync(join(d, 'spd.datos.tmp'), 'a medias');
    const b = nuevoAlmacen(d); await b.desbloquear(PASS);
    assert.equal(existsSync(join(d, 'spd.datos.tmp')), false);
    assert.deepEqual(nombres(b), ['Ana']);
  } finally { limpiar(d); }
});

test('nada en claro en disco: el nombre guardado no aparece en el fichero ni en la copia', async () => {
  const d = temp();
  try {
    const a = nuevoAlmacen(d); await a.crear(PASS, poblar('Paciente-Secreta-Zubiri'));
    a.db().run("INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES ('Segunda-Secreta-Ibarra','B','tecnico','h')"); a.persistir(); await a.flush(); await a.bloquear();
    for (const f of readdirSync(d)) {
      const b = readFileSync(join(d, f));
      assert.equal(b.indexOf('Secreta'), -1, f);
      assert.equal(b.indexOf('SQLite format'), -1, f);
    }
  } finally { limpiar(d); }
});
