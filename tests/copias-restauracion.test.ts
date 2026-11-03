import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { crearSistema } from '../src/servicios/sistema.ts';
import type { Sistema } from '../src/servicios/sistema.ts';
import type { PrimerUso, Resultado } from '../src/servicios/api.ts';
import { guardarCarga, abrirConContrasena } from '../src/servicios/seguridad.ts';
import { rutaDeCopia, rotarCopias, nombreCopia, listarCopias } from '../src/servicios/copias.ts';
import { VERSION_ESQUEMA } from '../src/servicios/db.ts';

const KDF = { n: 1 << 10, r: 8, p: 1 };
const PASS = 'contraseña-farmacia', PIN = '4821';
const PRIMER_USO: PrimerUso = {
  farmacia: { nombre: 'Farmacia Luz del Sur', titular: 'Marta', provincia: 'Álava' },
  titular: { nombre: 'Marta', iniciales: 'M', pin: PIN }, contrasena: PASS, momentos: [{ nombre: 'Desayuno', hora: '08:00' }],
};
const ok = <T,>(r: Resultado<T>): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; datos: T }).datos; };
const mal = (r: Resultado<unknown>, codigo: string) => { assert.equal(r.ok, false, 'se esperaba un fallo'); assert.equal((r as { codigo?: string }).codigo, codigo, JSON.stringify(r)); };

async function entorno() {
  const dir = mkdtempSync(join(tmpdir(), 'spd-rest-'));
  const copias = join(dir, 'copias');
  let t = Date.parse('2026-11-02T09:00:00Z');
  const s = crearSistema({ rutaDatos: join(dir, 'datos'), ahora: () => new Date(t), kdf: KDF, debounceMs: 60_000, version: '1.0.0', carpetaCopiasPorDefecto: join(dir, 'defecto') });
  ok(await s.api.primerUso(PRIMER_USO));
  ok(await s.api.guardarAjustes({ carpetaCopias: copias }));
  const usuarios = ok(await s.api.listarUsuarios());
  ok(await s.api.iniciarSesion(usuarios[0].id, PIN));
  return { dir, copias, s, avanzar: (ms = 60_000) => { t += ms; }, fin: async () => { await s.cerrar(); rmSync(dir, { recursive: true, force: true }); } };
}
const nombresUsuarios = async (s: Sistema) => ok(await s.api.listarUsuarios()).map(u => u.nombre);
async function nuevoUsuario(s: Sistema, nombre: string) { ok(await s.api.crearUsuario({ nombre, iniciales: 'XX', rol: 'tecnico', pin: '1111' })); }

test('copia manual: ficha con fecha, versión del programa, esquema y motivo; se lista', async () => {
  const e = await entorno();
  try {
    ok(await e.s.api.crearCopia());
    const l = ok(await e.s.api.listarCopias());
    assert.equal(l.length, 1);
    assert.deepEqual([l[0].origen, l[0].versionApp, l[0].esquema, l[0].restaurable], ['manual', '1.0.0', VERSION_ESQUEMA, true]);
    assert.ok(l[0].tamano > 1000 && l[0].motivo);
  } finally { await e.fin(); }
});

test('restaurar: vuelve al estado de la copia, hace antes copia del estado actual, audita y exige PIN de nuevo', async () => {
  const e = await entorno();
  try {
    await nuevoUsuario(e.s, 'Ana');
    ok(await e.s.api.crearCopia());
    const nombre = ok(await e.s.api.listarCopias())[0].nombre;
    e.avanzar(); await nuevoUsuario(e.s, 'Berta');
    e.avanzar();
    const r = ok(await e.s.api.restaurarCopia(nombre, PASS));
    assert.match(r.aviso, /perdido/);
    assert.equal(r.entradasAuditoriaPerdidas > 0, true);
    mal(await e.s.api.crearCopia(), 'SIN_SESION');                       // la sesión se cerró
    assert.deepEqual((await nombresUsuarios(e.s)).sort(), ['Ana', 'Marta']);
    // La copia previa tiene a Berta: restaurarla DESHACE.
    const us = ok(await e.s.api.listarUsuarios()); ok(await e.s.api.iniciarSesion(us.find(u => u.nombre === 'Marta')!.id, PIN));
    const previa = ok(await e.s.api.listarCopias()).find(c => c.nombre === r.copiaPrevia)!;
    assert.equal(previa.origen, 'antes_restaurar');
    e.avanzar(); ok(await e.s.api.restaurarCopia(previa.nombre, PASS));
    assert.deepEqual((await nombresUsuarios(e.s)).sort(), ['Ana', 'Berta', 'Marta']);
    const us2 = ok(await e.s.api.listarUsuarios()); ok(await e.s.api.iniciarSesion(us2.find(u => u.nombre === 'Marta')!.id, PIN));
    const aud = ok(await e.s.api.listarAuditoria({ entidad: 'copia', limite: 20 }));
    assert.ok(aud.some(a => a.accion === 'restaurar'));
    assert.equal(ok(await e.s.api.verificarAuditoria()).ok, true);
    assert.ok(existsSync(join(e.dir, 'datos', 'spd.datos.bak')));
  } finally { await e.fin(); }
});

test('restaurar: sólo el titular y reconfirmando la contraseña (errónea → nada cambia)', async () => {
  const e = await entorno();
  try {
    await nuevoUsuario(e.s, 'Ana');
    ok(await e.s.api.crearCopia());
    const nombre = ok(await e.s.api.listarCopias())[0].nombre;
    await nuevoUsuario(e.s, 'Berta');
    mal(await e.s.api.restaurarCopia(nombre, 'otra-contraseña'), 'CONTRASENA_INCORRECTA');
    assert.ok((await nombresUsuarios(e.s)).includes('Berta'));
    ok(await e.s.api.cerrarSesion());
    const us = ok(await e.s.api.listarUsuarios());
    ok(await e.s.api.iniciarSesion(us.find(u => u.nombre === 'Ana')!.id, '1111'));
    mal(await e.s.api.restaurarCopia(nombre, PASS), 'SIN_PERMISO');
    assert.ok((await nombresUsuarios(e.s)).includes('Berta'));
  } finally { await e.fin(); }
});

test('restaurar: nombres con ruta, inexistentes, enlaces y copia vacía o corrupta se rechazan sin tocar los datos', async () => {
  const e = await entorno();
  try {
    ok(await e.s.api.crearCopia());
    for (const n of ['../datos/spd.datos', '/etc/passwd', 'spd-20261102-090000.datos/../../x', 'spd.datos', '']) mal(await e.s.api.restaurarCopia(n, PASS), 'COPIA_NO_ENCONTRADA');
    assert.throws(() => rutaDeCopia(e.copias, '..\\x.datos'));
    // Vacía
    writeFileSync(join(e.copias, 'spd-20250101-000000.datos'), '');
    mal(await e.s.api.restaurarCopia('spd-20250101-000000.datos', PASS), 'COPIA_VACIA');
    // Basura
    writeFileSync(join(e.copias, 'spd-20250102-000000.datos'), 'esto no es una copia de SPD, ni de lejos, nada de nada');
    mal(await e.s.api.restaurarCopia('spd-20250102-000000.datos', PASS), 'COPIA_INVALIDA');
    // Corrupta (un bit cambiado en el contenido cifrado)
    const buena = ok(await e.s.api.listarCopias()).find(c => c.origen === 'manual')!.nombre;
    const bytes = new Uint8Array(readFileSync(join(e.copias, buena))); bytes[bytes.length - 5] ^= 0xff;
    writeFileSync(join(e.copias, 'spd-20250103-000000.datos'), bytes);
    mal(await e.s.api.restaurarCopia('spd-20250103-000000.datos', PASS), 'FICHERO_CORRUPTO');
    assert.equal(ok(await e.s.api.verificarAuditoria()).ok, true);
    assert.equal(ok(await e.s.api.listarUsuarios()).length, 1);
  } finally { await e.fin(); }
});

test('restaurar: contraseña de la copia distinta (copia de antes de cambiarla) → se pide, y con ella funciona', async () => {
  const e = await entorno();
  try {
    await nuevoUsuario(e.s, 'Ana');
    ok(await e.s.api.crearCopia());
    const nombre = ok(await e.s.api.listarCopias())[0].nombre;
    ok(await e.s.api.cambiarContrasena(PASS, 'contraseña-NUEVA-9'));
    e.avanzar();
    mal(await e.s.api.restaurarCopia(nombre, 'contraseña-NUEVA-9'), 'CONTRASENA_COPIA');
    mal(await e.s.api.restaurarCopia(nombre, 'contraseña-NUEVA-9', 'tampoco'), 'CONTRASENA_COPIA');
    ok(await e.s.api.restaurarCopia(nombre, 'contraseña-NUEVA-9', PASS));
    // Tras restaurar manda la contraseña ACTUAL.
    ok(await e.s.api.bloquear());
    mal(await e.s.api.desbloquear(PASS), 'CONTRASENA_INCORRECTA');
    e.avanzar(600_000);
    ok(await e.s.api.desbloquear('contraseña-NUEVA-9'));
  } finally { await e.fin(); }
});

/** Fichero SPD con la MISMA clave de datos pero una base con el `user_version` dado (sin tablas si es 0). */
async function copiaConEsquema(e: Awaited<ReturnType<typeof entorno>>, version: number, nombre: string, vacia = false) {
  const SQL = await initSqlJs();
  const fichero = new Uint8Array(readFileSync(join(e.dir, 'datos', 'spd.datos')));
  const claveDatos = abrirConContrasena(fichero, PASS).claveDatos;
  let bytes: Uint8Array;
  if (vacia) { const d = new SQL.Database(); d.run(`PRAGMA user_version = ${version}`); bytes = d.export(); }
  else { const abierto = abrirConContrasena(fichero, PASS); const d = new SQL.Database(abierto.bytesDb); d.run(`PRAGMA user_version = ${version}`); bytes = d.export(); }
  writeFileSync(join(e.copias, nombre), guardarCarga(fichero, claveDatos, bytes));
  writeFileSync(join(e.copias, nombre + '.json'), JSON.stringify({ origen: 'manual', motivo: 'prueba', versionApp: '9.9.9', esquema: version }));
}

test('compatibilidad: copia de un esquema POSTERIOR se rechaza con aviso; una de esquema anterior (v0) se restaura y se migra', async () => {
  const e = await entorno();
  try {
    ok(await e.s.api.crearCopia());
    await copiaConEsquema(e, VERSION_ESQUEMA + 5, 'spd-20260101-000000.datos');
    const l = ok(await e.s.api.listarCopias());
    const futura = l.find(c => c.nombre === 'spd-20260101-000000.datos')!;
    assert.equal(futura.restaurable, false); assert.match(futura.avisoRestauracion!, /más nueva/);
    mal(await e.s.api.restaurarCopia(futura.nombre, PASS), 'COPIA_MAS_NUEVA');
    // Ficha que miente (dice esquema 1) pero la base es de la 99: lo caza el descifrado.
    await copiaConEsquema(e, 99, 'spd-20260102-000000.datos');
    writeFileSync(join(e.copias, 'spd-20260102-000000.datos.json'), JSON.stringify({ origen: 'manual', motivo: 'x', versionApp: '1', esquema: 1 }));
    mal(await e.s.api.restaurarCopia('spd-20260102-000000.datos', PASS), 'COPIA_MAS_NUEVA');
    assert.equal(ok(await e.s.api.listarUsuarios()).length, 1);       // nada cambió
    // Anterior: base vacía con user_version 0 → se migra al esquema vigente y queda usable.
    await copiaConEsquema(e, 0, 'spd-20260103-000000.datos', true);
    ok(await e.s.api.restaurarCopia('spd-20260103-000000.datos', PASS));
    assert.deepEqual(ok(await e.s.api.listarUsuarios()), []);
    ok(await e.s.api.bloquear()); ok(await e.s.api.desbloquear(PASS));   // se guardó con el esquema vigente
  } finally { await e.fin(); }
});

test('retención: la rotación no borra las últimas copias previas a actualizar/restaurar y borra la ficha de las que quita', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spd-rot-'));
  try {
    const mk = (f: Date, origen: string) => { const n = nombreCopia(f); writeFileSync(join(dir, n), Buffer.concat([Buffer.from('SPDDATOS', 'latin1'), Buffer.from([1]), Buffer.alloc(40)])); writeFileSync(join(dir, n + '.json'), JSON.stringify({ origen, motivo: '', versionApp: '1', esquema: 1 })); return n; };
    const pre: string[] = [];
    for (let i = 0; i < 5; i++) pre.push(mk(new Date(Date.UTC(2026, 0, 10 + i, 10)), 'antes_actualizar'));
    const manuales: string[] = [];
    for (let m = 0; m < 14; m++) manuales.push(mk(new Date(Date.UTC(2025, m % 12, 5, 8)), 'manual'));
    const borradas = rotarCopias(dir, undefined, new Date('2026-11-03T10:00:00Z'));
    const quedan = listarCopias(dir).map(c => c.nombre);
    for (const n of pre.slice(-3)) assert.ok(quedan.includes(n), 'pre-actualización reciente conservada ' + n);
    assert.ok(borradas.length > 0);
    for (const b of borradas) assert.equal(existsSync(join(dir, b + '.json')), false);
    assert.ok(readdirSync(dir).filter(f => f.endsWith('.json')).length === quedan.length);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('copia previa a actualizar: etiquetada, funciona con el programa bloqueado y sin datos devuelve ruta null', async () => {
  const e = await entorno();
  try {
    const r = ok(await e.s.crearCopiaPreActualizacion('1.1.0'));
    assert.ok(r.ruta);
    const c = ok(await e.s.api.listarCopias()).find(x => x.origen === 'antes_actualizar')!;
    assert.equal(c.motivo, 'Antes de actualizar a v1.1.0');
    ok(await e.s.api.bloquear()); e.avanzar();
    const r2 = ok(await e.s.crearCopiaPreActualizacion('1.1.0'));
    assert.ok(r2.ruta && r2.ruta.startsWith(join(e.dir, 'defecto')));       // bloqueado: carpeta del programa
    mal(await e.s.crearCopiaPreActualizacion('1.1.0; rm -rf'), 'VERSION_INVALIDA');
  } finally { await e.fin(); }
  const vacio = mkdtempSync(join(tmpdir(), 'spd-vacio-'));
  try {
    const s = crearSistema({ rutaDatos: join(vacio, 'datos'), kdf: KDF, carpetaCopiasPorDefecto: join(vacio, 'c') });
    assert.equal(ok(await s.crearCopiaPreActualizacion('1.1.0')).ruta, null);
  } finally { rmSync(vacio, { recursive: true, force: true }); }
});
