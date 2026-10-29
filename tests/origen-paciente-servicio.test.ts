/**
 * Origen del paciente (individual / centro): migración v1→v2, servicios y auditoría.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaBase } from '../src/servicios/clinica-base.ts';
import { abrirDb } from '../src/servicios/db.ts';
import { ESQUEMA_V1 } from '../src/servicios/esquema-sql.ts';
import { TIPOS_CENTRO } from '../src/dominio/origen-paciente.ts';
import type { Resultado } from '../src/servicios/api.ts';

async function bien<T>(p: Promise<Resultado<T>>): Promise<T> {
  const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; datos: T }).datos;
}
async function mal(p: Promise<Resultado<unknown>>, codigo = 'VALIDACION', texto?: RegExp) {
  const r = await p; assert.equal(r.ok, false, 'se esperaba un fallo');
  const f = r as { ok: false; error: string; codigo?: string }; assert.equal(f.codigo, codigo, f.error);
  if (texto) assert.match(f.error, texto);
}
async function montar() { const t = await crearContextoPruebas('farmaceutico'); return { t, api: crearClinicaBase(t.ctx), db: t.db }; }
const pac = (api: ReturnType<typeof crearClinicaBase>, extra: Record<string, unknown> = {}) =>
  api.guardarPaciente({ nombre: 'Ana', apellido1: 'López', necesitaBraille: false, letraGrande: false, ...extra } as never);

// ─── Esquema y migración ───

test('el CHECK de tipo del esquema coincide con los tipos del dominio', () => {
  const m = ESQUEMA_V1.match(/tipo\s+TEXT NOT NULL DEFAULT 'otro' CHECK \(tipo IN\s*\(([^)]*)\)\)/);
  assert.ok(m);
  assert.deepEqual([...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]), [...TIPOS_CENTRO]);
});

test('base nueva: la base rechaza un tipo de centro inventado', async () => {
  const db = await abrirDb();
  assert.throws(() => db.run("INSERT INTO centro(nombre,tipo) VALUES ('X','casa')"), /CHECK/);
  assert.equal(db.run("INSERT INTO centro(nombre) VALUES ('Y')").cambios, 1);
  assert.equal(db.get<{ tipo: string; activo: number }>("SELECT tipo, activo FROM centro WHERE nombre='Y'")!.tipo, 'otro');
});

test('migración v1→v2: conserva centros y pacientes, calcula la clave y todo paciente sigue como estaba', async () => {
  // Una base de la versión 1: el esquema actual con la tabla centro de antes.
  const v1 = ESQUEMA_V1
    .replace(/CREATE TABLE centro \([\s\S]*?\n\);\nCREATE INDEX centro_nombre_norm[^\n]*\nCREATE INDEX paciente_centro[^\n]*\n/,
      'CREATE TABLE centro (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, direccion TEXT, telefono TEXT, contacto TEXT, notas TEXT);\n')
    .replace(/PRAGMA journal_mode = WAL;/i, '');
  assert.ok(!/nombre_norm/.test(v1));
  const antigua = await abrirDb();                       // sólo para disponer del motor
  antigua.cerrar();
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(v1);
  raw.exec("INSERT INTO centro(nombre) VALUES ('Residencia San José'), ('residencia  san jose.')");
  raw.exec("INSERT INTO paciente(id_publico,nombre,apellido1,centro_id) VALUES ('u1','Ana','López',1), ('u2','Luis','Pérez',NULL)");
  raw.exec('PRAGMA user_version = 1;');
  const db = await abrirDb(raw.export());
  assert.equal(db.version(), 2);
  const cs = db.all<{ nombre: string; tipo: string; activo: number; nombre_norm: string }>('SELECT nombre, tipo, activo, nombre_norm FROM centro ORDER BY id');
  assert.equal(cs.length, 2);                            // no se fusiona ni se borra nada
  assert.deepEqual(cs.map((c) => [c.tipo, c.activo]), [['otro', 1], ['otro', 1]]);
  assert.deepEqual(cs.map((c) => c.nombre_norm), ['residencia san jose', 'residencia san jose']);
  assert.deepEqual(db.all<{ centro_id: number | null }>('SELECT centro_id FROM paciente ORDER BY id').map((p) => p.centro_id), [1, null]);
  assert.throws(() => db.run("UPDATE centro SET tipo='casa' WHERE id=1"), /CHECK/);
  // Reabrir una base ya migrada no repite nada
  assert.equal((await abrirDb(db.exportar())).version(), 2);
});

// ─── Servicios ───

test('centros: tipo por defecto «otro», tipo inválido rechazado, duplicados por mayúsculas/tildes/espacios rechazados', async () => {
  const { api } = await montar();
  const c = await bien(api.guardarCentro({ nombre: 'Residencia San José', tipo: 'residencia_mayores' }));
  assert.equal(c.tipo, 'residencia_mayores'); assert.equal(c.activo, true);
  assert.equal((await bien(api.guardarCentro({ nombre: 'Hospital' }))).tipo, 'otro');
  await mal(api.guardarCentro({ nombre: 'Casa', tipo: 'casa' as never }), 'VALIDACION', /Tipo de centro/);
  await mal(api.guardarCentro({ nombre: '  RESIDENCIA  san jose. ' }), 'VALIDACION', /Ya existe/);
  await mal(api.guardarCentro({ nombre: '...' }), 'VALIDACION');
  // Editar sin cambiar el nombre no choca consigo mismo; cambiar a uno existente sí choca
  const e = await bien(api.guardarCentro({ id: c.id, nombre: 'Residencia San José', telefono: '911' }));
  assert.equal(e.telefono, '911');
  const h = (await bien(api.listarCentros())).find((x) => x.nombre === 'Hospital')!;
  await mal(api.guardarCentro({ id: h.id, nombre: 'residencia san jose' }), 'VALIDACION', /Ya existe/);
});

test('obtenerOCrearCentro: reutiliza el existente (el tipo registrado manda) y sólo crea el nuevo; auditado', async () => {
  const { api, db, t } = await montar();
  const a = await bien(api.obtenerOCrearCentro({ nombre: 'Residencia Sol', tipo: 'residencia_mayores' }));
  assert.equal(a.creado, true);
  const b = await bien(api.obtenerOCrearCentro({ nombre: ' residencia   SOL ', tipo: 'hospital' }));
  assert.equal(b.creado, false); assert.equal(b.centro.id, a.centro.id); assert.equal(b.centro.tipo, 'residencia_mayores');
  assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM centro')!.n, 1);
  assert.equal(t.auditadas.filter((x) => x.entidad === 'centro' && x.accion === 'crear').length, 1);
  await mal(api.obtenerOCrearCentro({ nombre: 'X', tipo: 'nada' as never }), 'VALIDACION');
  await mal(api.obtenerOCrearCentro({ nombre: '  ', tipo: 'otro' }), 'VALIDACION');
});

test('paciente: sin centro es individual; con centro sale origen, tipo y centro en la lista; la habitación sólo vale con centro', async () => {
  const { api } = await montar();
  const c = (await bien(api.obtenerOCrearCentro({ nombre: 'Mente Sana', tipo: 'salud_mental' }))).centro;
  const a = await bien(pac(api, { habitacion: '12' }));            // individual con habitación escrita: se descarta
  assert.equal(a.centroId ?? null, null); assert.equal(a.habitacion ?? null, null);
  const b = await bien(pac(api, { nombre: 'Luis', centroId: c.id, habitacion: '3B' }));
  assert.equal(b.habitacion, '3B');
  const lista = await bien(api.listarPacientes());
  const ra = lista.find((x) => x.id === a.id)!; const rb = lista.find((x) => x.id === b.id)!;
  assert.deepEqual([ra.origen, ra.centroTipo, ra.centro], ['individual', null, null]);
  assert.deepEqual([rb.origen, rb.centroTipo, rb.centro, rb.centroId], ['centro', 'salud_mental', 'Mente Sana', c.id]);
});

test('filtros por origen y por tipo de centro; valores no válidos se rechazan', async () => {
  const { api } = await montar();
  const r = (await bien(api.obtenerOCrearCentro({ nombre: 'Sol', tipo: 'residencia_mayores' }))).centro;
  const m = (await bien(api.obtenerOCrearCentro({ nombre: 'Mente', tipo: 'salud_mental' }))).centro;
  await bien(pac(api, { nombre: 'A' })); await bien(pac(api, { nombre: 'B', centroId: r.id })); await bien(pac(api, { nombre: 'C', centroId: m.id }));
  const n = async (f: object) => (await bien(api.listarPacientes(f as never))).map((x) => x.nombreCompleto.split(' ')[0]).sort();
  assert.deepEqual(await n({ origen: 'individual' }), ['A']);
  assert.deepEqual(await n({ origen: 'centro' }), ['B', 'C']);
  assert.deepEqual(await n({ centroTipo: 'residencia_mayores' }), ['B']);
  assert.deepEqual(await n({ centroId: m.id }), ['C']);
  assert.deepEqual(await n({ origen: 'individual', centroTipo: 'hospital' }), []);
  await mal(api.listarPacientes({ origen: 'otro' } as never));
  await mal(api.listarPacientes({ centroTipo: 'casa' } as never));
});

test('centro dado de baja: no admite pacientes nuevos, pero quien ya estaba puede seguir editándose', async () => {
  const { api } = await montar();
  const c = (await bien(api.obtenerOCrearCentro({ nombre: 'Cerrada', tipo: 'otro' }))).centro;
  const p = await bien(pac(api, { centroId: c.id }));
  await bien(api.guardarCentro({ id: c.id, nombre: 'Cerrada', activo: false }));
  await bien(pac(api, { id: p.id, centroId: c.id, notas: 'edición' }));              // sigue en el mismo centro: permitido
  await mal(pac(api, { nombre: 'Otro', centroId: c.id }), 'VALIDACION', /dado de baja/);
  await bien(pac(api, { id: p.id, centroId: null }));                                // salir del centro siempre se puede
  await mal(pac(api, { id: p.id, centroId: c.id }), 'VALIDACION', /dado de baja/);   // volver ya no
  await mal(pac(api, { nombre: 'Z', centroId: 999 }), 'VALIDACION', /no existe/);
});

test('cambiar el origen de un paciente queda auditado (antes y después)', async () => {
  const { api, t } = await montar();
  const c = (await bien(api.obtenerOCrearCentro({ nombre: 'Sol', tipo: 'residencia_mayores' }))).centro;
  const p = await bien(pac(api));
  await bien(pac(api, { id: p.id, centroId: c.id, habitacion: '4' }));
  const a = t.auditadas.filter((x) => x.entidad === 'paciente' && x.accion === 'modificar').at(-1)!;
  assert.equal((a.antes as { centroId: number | null }).centroId, null);
  assert.equal((a.despues as { centroId: number }).centroId, c.id);
});

test('resumen de origen: sólo pacientes activos; individuales, por tipo y por centro', async () => {
  const { api } = await montar();
  const r = (await bien(api.obtenerOCrearCentro({ nombre: 'Sol', tipo: 'residencia_mayores' }))).centro;
  const m = (await bien(api.obtenerOCrearCentro({ nombre: 'Mente', tipo: 'salud_mental' }))).centro;
  await bien(api.obtenerOCrearCentro({ nombre: 'Vacía', tipo: 'hospital' }));
  await bien(pac(api, { nombre: 'A' })); await bien(pac(api, { nombre: 'A2' }));
  await bien(pac(api, { nombre: 'B', centroId: r.id })); await bien(pac(api, { nombre: 'B2', centroId: r.id }));
  const c = await bien(pac(api, { nombre: 'C', centroId: m.id }));
  const baja = await bien(pac(api, { nombre: 'D', centroId: r.id }));
  await bien(api.darDeBajaPaciente(baja.id, 'Traslado', 'baja'));
  const res = await bien(api.resumenOrigen());
  assert.equal(res.total, 5); assert.equal(res.individuales, 2);
  const t = (x: string) => res.porTipo.find((p) => p.tipo === x)!;
  assert.deepEqual([t('residencia_mayores').pacientes, t('residencia_mayores').centros], [2, 1]);
  assert.equal(t('salud_mental').pacientes, 1); assert.equal(t('hospital').pacientes, 0); assert.equal(t('hospital').centros, 1);
  assert.deepEqual(res.porCentro.map((x) => [x.nombre, x.pacientes]), [['Sol', 2], ['Mente', 1], ['Vacía', 0]]);
  assert.ok(c.id > 0);
});

test('sin sesión los métodos nuevos fallan', async () => {
  const t = await crearContextoPruebas(null); const api = crearClinicaBase(t.ctx);
  await mal(api.resumenOrigen(), 'SIN_SESION');
  await mal(api.obtenerOCrearCentro({ nombre: 'X', tipo: 'otro' }), 'SIN_SESION');
});
