/**
 * Servicios clínicos base (parte 1): sesión, seguridad, pacientes, centros, contactos,
 * datos de salud y medicamentos. Base en memoria con auditoría real encadenada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaBase } from '../src/servicios/clinica-base.ts';
import { verificarCadena } from '../src/dominio/auditoria.ts';
import type { Resultado, RolUsuario, PautaDto } from '../src/servicios/api.ts';
import type { Db } from '../src/servicios/db.ts';

async function montar(rol: RolUsuario | null = 'farmaceutico', fecha?: string) {
  const t = await crearContextoPruebas(rol, fecha);
  return { t, api: crearClinicaBase(t.ctx), db: t.db };
}
type Api = ReturnType<typeof crearClinicaBase>;

async function bien<T>(p: Promise<Resultado<T>>): Promise<T> {
  const r = await p;
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; datos: T }).datos;
}
async function mal(p: Promise<Resultado<unknown>>, codigo?: string, texto?: RegExp): Promise<string> {
  const r = await p;
  assert.equal(r.ok, false, 'se esperaba un fallo: ' + JSON.stringify(r));
  const f = r as { ok: false; error: string; codigo?: string };
  if (codigo) assert.equal(f.codigo, codigo, f.error);
  if (texto) assert.match(f.error, texto);
  return f.error;
}
const crearPaciente = (api: Api, extra: Record<string, unknown> = {}) =>
  bien(api.guardarPaciente({ nombre: 'Ana', apellido1: 'López', apellido2: 'Ruiz', necesitaBraille: false, letraGrande: false, ...extra }));
const crearMed = (api: Api, extra: Record<string, unknown> = {}) =>
  bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina Cinfa 850 mg', principiosActivos: 'metformina 850 mg', formaFarmaceutica: 'COMPRIMIDO RECUBIERTO CON PELICULA', unidadesEnvase: 50, ...extra }));
function consentir(db: Db, pid: number) {
  let pl = db.get<{ id: number }>("SELECT id FROM plantilla_documento WHERE codigo = 'consentimiento_spd'");
  if (!pl) pl = { id: db.run("INSERT INTO plantilla_documento(codigo,version,titulo,cuerpo) VALUES ('consentimiento_spd',1,'Consentimiento SPD','texto')").ultimoId };
  return db.run('INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomUUID(), pid, pl.id, 'Ana', 'paciente', '2026-10-01T10:00:00Z', 'texto', 'hash', 1]).ultimoId;
}
const pauta = (momentos: number[] = [1, 3], extra: Partial<PautaDto> = {}): PautaDto =>
  ({ vigenteDesde: '2026-11-01', patron: 'diario', origen: 'receta', dosis: momentos.map((m) => ({ momentoId: m, unidades: 1 })), ...extra });

// ───────────────────────────── Sesión y permisos ─────────────────────────────

test('sin sesión TODOS los métodos fallan con «Inicia sesión» (SIN_SESION) y no tocan la base', async () => {
  const { api, db } = await montar(null);
  const llamadas: Record<string, () => Promise<Resultado<unknown>>> = {
    panelHoy: () => api.panelHoy(), listarPacientes: () => api.listarPacientes(), obtenerPaciente: () => api.obtenerPaciente(1),
    guardarPaciente: () => api.guardarPaciente({ nombre: 'A', apellido1: 'B', necesitaBraille: false, letraGrande: false }),
    darDeBajaPaciente: () => api.darDeBajaPaciente(1, 'x', 'baja'), listarCentros: () => api.listarCentros(),
    guardarCentro: () => api.guardarCentro({ nombre: 'C' }), listarContactos: () => api.listarContactos(1),
    guardarContacto: () => api.guardarContacto({ pacienteId: 1, tipo: 'otro', nombre: 'X', autorizadoRecoger: false }),
    listarSalud: () => api.listarSalud(1), guardarSalud: () => api.guardarSalud({ pacienteId: 1, tipo: 'otro', descripcion: 'x', vigente: true }),
    buscarMedicamentos: () => api.buscarMedicamentos('a'), obtenerMedicamento: () => api.obtenerMedicamento('712729'),
    guardarMedicamento: () => api.guardarMedicamento({ cn: '712729', nombre: 'X' }), analizarFichaTecnica: () => api.analizarFichaTecnica('blanco'),
    fichasIncompletas: () => api.fichasIncompletas(), listarTratamientos: () => api.listarTratamientos(1),
    guardarTratamiento: () => api.guardarTratamiento({ pacienteId: 1, principioActivo: 'x', emblistable: true }),
    guardarPauta: () => api.guardarPauta(1, pauta()), finalizarTratamiento: () => api.finalizarTratamiento(1, 'x'),
    listarEnvases: () => api.listarEnvases(1), comprobarEntradaEnvase: () => api.comprobarEntradaEnvase({ pacienteId: 1, cn: '712729', unidades: 1 }),
    registrarEnvase: () => api.registrarEnvase({ pacienteId: 1, cn: '712729', unidades: 1 }), cerrarEnvase: () => api.cerrarEnvase(1, 'retirado', 'x'),
    importarAlertaCalidad: () => api.importarAlertaCalidad({ referencia: 'R_1', cn: '712729' }),
  };
  assert.equal(Object.keys(llamadas).length, 25);
  for (const [nombre, f] of Object.entries(llamadas)) {
    const r = await f();
    assert.equal(r.ok, false, nombre);
    assert.equal((r as { codigo?: string }).codigo, 'SIN_SESION', nombre);
    assert.match((r as { error: string }).error, /Inicia sesión/, nombre);
  }
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM paciente')!.n, 0);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM auditoria')!.n, 0);
});

test('si el programa está bloqueado (la base lanza) el fallo es legible y no se propaga la excepción', async () => {
  const { t } = await montar();
  const bloqueada = { ...t.ctx, db: () => { throw new Error('bloqueado'); } };
  const r = await crearClinicaBase(bloqueada).listarCentros();
  assert.equal(r.ok, false);
  assert.equal((r as { codigo?: string }).codigo, 'BLOQUEADO');
});

test('una escritura es atómica: si la auditoría falla, no queda nada guardado (transacción)', async () => {
  const { t, db } = await montar();
  const rota = { ...t.ctx, auditar: () => { throw new Error('auditoría caída'); } };
  const r = await crearClinicaBase(rota).guardarPaciente({ nombre: 'Ana', apellido1: 'López', necesitaBraille: false, letraGrande: false });
  assert.equal(r.ok, false);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM paciente')!.n, 0);
  const rc = await crearClinicaBase(rota).guardarCentro({ nombre: 'Residencia' });
  assert.equal(rc.ok, false);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM centro')!.n, 0);
});

test('persistir se pide tras cada escritura correcta y no tras un fallo', async () => {
  const { t, api } = await montar();
  const antes = t.persistencias();
  await crearPaciente(api);
  assert.ok(t.persistencias() > antes);
  const p2 = t.persistencias();
  await mal(api.guardarPaciente({ nombre: '', apellido1: 'X', necesitaBraille: false, letraGrande: false }));
  assert.equal(t.persistencias(), p2);
});

test('los DTO no sacan contraseñas ni PIN (hash_clave) en ningún caso', async () => {
  const { api } = await montar();
  const p = await crearPaciente(api);
  const todo = JSON.stringify([await api.obtenerPaciente(p.id), await api.listarPacientes({ estado: 'todos' }), await api.panelHoy()]);
  assert.doesNotMatch(todo, /hash_clave|hashClave|contrase|"pin"/i);
});

test('la cadena de auditoría sigue siendo válida tras muchas escrituras', async () => {
  const { api, db } = await montar();
  const p = await crearPaciente(api);
  await crearMed(api);
  const tr = await bien(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'metformina', emblistable: true }));
  await bien(api.guardarPauta(tr.id, pauta()));
  await bien(api.registrarEnvase({ pacienteId: p.id, cn: '712729', lote: 'L1', caducidad: '2027-12-31', unidades: 50 }));
  const filas = db.all<Record<string, string>>('SELECT * FROM auditoria ORDER BY id');
  assert.ok(filas.length >= 5);
  const entradas = filas.map((f) => ({ momento: f.momento, usuarioId: Number(f.usuario_id), accion: f.accion, entidad: f.entidad, entidadId: f.entidad_id, antes: JSON.parse(f.antes), despues: JSON.parse(f.despues), motivo: f.motivo, hashPrevio: f.hash_previo, hash: f.hash }));
  assert.equal(verificarCadena(entradas).ok, true);
});

// ───────────────────────────── Pacientes ─────────────────────────────

test('crear paciente: UUID público, alta de hoy, estado activo y revisión semestral por defecto', async () => {
  const { api, db } = await montar();
  const p = await crearPaciente(api, { dniNie: ' 12.345.678-z ', sexo: 'M', fechaNacimiento: '1940-05-17' });
  assert.match(p.idPublico, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(p.altaEn, '2026-11-02');
  assert.equal(p.estado, 'activo');
  assert.equal(p.proximaRevision, '2027-05-02');
  assert.equal(p.dniNie, '12345678Z');
  const a = db.all<{ accion: string; entidad: string }>("SELECT accion, entidad FROM auditoria WHERE entidad = 'paciente'");
  assert.deepEqual(a.map((x) => x.accion), ['crear']);
});

test('nombre y primer apellido son obligatorios', async () => {
  const { api, db } = await montar();
  await mal(api.guardarPaciente({ nombre: '  ', apellido1: 'López', necesitaBraille: false, letraGrande: false }), 'VALIDACION', /nombre/);
  await mal(api.guardarPaciente({ nombre: 'Ana', apellido1: '', necesitaBraille: false, letraGrande: false }), 'VALIDACION', /primer apellido/);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM paciente')!.n, 0);
});

test('el DNI/NIE sólo se normaliza: la letra de control NO se valida', async () => {
  const { api } = await montar();
  const p = await crearPaciente(api, { dniNie: '00000000-a' });
  assert.equal(p.dniNie, '00000000A');
  const q = await crearPaciente(api, { nombre: 'Luis', dniNie: 'x-1234567-l' });
  assert.equal(q.dniNie, 'X1234567L');
});

test('no se permite repetir un DNI/NIE (ni al editar), pero sí editar al mismo paciente', async () => {
  const { api } = await montar();
  const a = await crearPaciente(api, { dniNie: '11111111H' });
  await mal(api.guardarPaciente({ nombre: 'Otra', apellido1: 'X', dniNie: '11111111h', necesitaBraille: false, letraGrande: false }), 'VALIDACION', /Ya existe/);
  const b = await crearPaciente(api, { nombre: 'Luis', dniNie: '22222222J' });
  await mal(api.guardarPaciente({ id: b.id, nombre: 'Luis', apellido1: 'López', dniNie: '11111111H', necesitaBraille: false, letraGrande: false }), 'VALIDACION', /otro paciente/);
  const a2 = await bien(api.guardarPaciente({ id: a.id, nombre: 'Ana', apellido1: 'López', dniNie: '11111111H', telefono: '600', necesitaBraille: false, letraGrande: false }));
  assert.equal(a2.telefono, '600');
});

test('validaciones: fecha de nacimiento, sexo, correo, centro y revisión', async () => {
  const { api } = await montar();
  const base = { nombre: 'Ana', apellido1: 'López', necesitaBraille: false, letraGrande: false };
  await mal(api.guardarPaciente({ ...base, fechaNacimiento: '2027-01-01' }), 'VALIDACION', /futura/);
  await mal(api.guardarPaciente({ ...base, fechaNacimiento: '1940-02-31' }), 'VALIDACION', /no es válida/);
  await mal(api.guardarPaciente({ ...base, sexo: 'Z' as never }), 'VALIDACION', /Sexo/);
  await mal(api.guardarPaciente({ ...base, email: 'sin-arroba' }), 'VALIDACION', /correo/);
  await mal(api.guardarPaciente({ ...base, centroId: 999 }), 'VALIDACION', /centro/);
  await mal(api.guardarPaciente({ ...base, proximaRevision: 'mañana' }), 'VALIDACION', /revisión/);
});

test('editar un paciente audita antes y después; un id inexistente falla', async () => {
  const { api, db } = await montar();
  const p = await crearPaciente(api);
  await bien(api.guardarPaciente({ id: p.id, nombre: 'Ana María', apellido1: 'López', necesitaBraille: true, letraGrande: true }));
  const e = db.get<{ antes: string; despues: string; accion: string }>("SELECT * FROM auditoria WHERE accion = 'modificar' AND entidad = 'paciente'")!;
  assert.equal(JSON.parse(e.antes).nombre, 'Ana');
  assert.equal(JSON.parse(e.despues).nombre, 'Ana María');
  assert.equal(JSON.parse(e.despues).necesitaBraille, true);
  await mal(api.guardarPaciente({ id: 777, nombre: 'X', apellido1: 'Y', necesitaBraille: false, letraGrande: false }), 'NO_ENCONTRADO');
});

test('abrir la ficha (obtenerPaciente) audita «ver»; un id inexistente no deja rastro', async () => {
  const { api, db } = await montar();
  const p = await crearPaciente(api);
  const antes = db.get<{ n: number }>("SELECT count(*) AS n FROM auditoria WHERE accion = 'ver'")!.n;
  const dto = await bien(api.obtenerPaciente(p.id));
  assert.equal(dto.id, p.id);
  const e = db.get<{ entidad: string; entidad_id: string; usuario_id: number }>("SELECT * FROM auditoria WHERE accion = 'ver' ORDER BY id DESC")!;
  assert.equal(e.entidad, 'paciente');
  assert.equal(e.entidad_id, String(p.id));
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM auditoria WHERE accion = 'ver'")!.n, antes + 1);
  await mal(api.obtenerPaciente(999), 'NO_ENCONTRADO');
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM auditoria WHERE accion = 'ver'")!.n, antes + 1);
});

test('baja: guarda estado, motivo y fecha; NO borra nada; el motivo es obligatorio', async () => {
  const { api, db } = await montar();
  const p = await crearPaciente(api);
  await bien(api.guardarSalud({ pacienteId: p.id, tipo: 'alergia', descripcion: 'Penicilina', vigente: true }));
  await mal(api.darDeBajaPaciente(p.id, '  ', 'baja'), 'VALIDACION', /motivo/);
  const b = await bien(api.darDeBajaPaciente(p.id, 'Ingreso en residencia', 'baja'));
  assert.equal(b.estado, 'baja');
  assert.equal(b.motivoEstado, 'Ingreso en residencia');
  assert.equal(b.bajaEn, '2026-11-02');
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM paciente')!.n, 1);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM salud_dato')!.n, 1);
  await mal(api.darDeBajaPaciente(p.id, 'otra vez', 'baja'), 'VALIDACION', /ya está/);
  await mal(api.darDeBajaPaciente(p.id, 'x', 'activo' as never), 'VALIDACION');
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE accion = 'baja' AND motivo = 'Ingreso en residencia'"));
});

test('«pausado» no pone fecha de baja; reactivar devuelve al servicio y queda auditado', async () => {
  const { api, db } = await montar();
  const p = await crearPaciente(api);
  const pa = await bien(api.darDeBajaPaciente(p.id, 'Vacaciones', 'pausado'));
  assert.equal(pa.estado, 'pausado');
  assert.equal(pa.bajaEn, null);
  await bien(api.darDeBajaPaciente(p.id, 'Fin del servicio', 'baja'));
  const re = await bien(api.guardarPaciente({ id: p.id, nombre: 'Ana', apellido1: 'López', estado: 'activo', necesitaBraille: false, letraGrande: false } as never));
  assert.equal(re.estado, 'activo');
  assert.equal(re.bajaEn, null);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE accion = 'reactivar'"));
});

test('inyección SQL: el texto del usuario se guarda literal y nunca se ejecuta', async () => {
  const { api, db } = await montar();
  const veneno = "Robert'); DROP TABLE paciente;-- ";
  const p = await crearPaciente(api, { nombre: veneno, notas: "' OR 1=1 --" });
  assert.equal(p.nombre, veneno.trim());
  assert.equal(p.notas, "' OR 1=1 --");
  await crearPaciente(api, { nombre: 'Luis', apellido1: 'Pérez' });
  const lista = await bien(api.listarPacientes({ texto: "' OR 1=1 --" }));
  assert.equal(lista.length, 0);
  const lista2 = await bien(api.listarPacientes({ texto: "x'; DELETE FROM paciente; --" }));
  assert.equal(lista2.length, 0);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM paciente')!.n, 2);
  const m = await crearMed(api, { nombre: "Nolotil' OR '1'='1", cn: '654321' });
  assert.equal(m.nombre, "Nolotil' OR '1'='1");
  const b = await bien(api.buscarMedicamentos("' OR 1=1 --"));
  assert.equal(b.length, 0);
  const c = await bien(api.guardarCentro({ nombre: "Centro'); DROP TABLE centro;--" }));
  assert.match(c.nombre, /DROP TABLE/);
  assert.equal((await bien(api.listarCentros())).length, 1);
});

test('lista: resumen con alergias vigentes, consentimiento SPD vigente y nombre completo', async () => {
  const { api, db } = await montar();
  const a = await crearPaciente(api);
  const b = await crearPaciente(api, { nombre: 'Luis', apellido1: 'Pérez', apellido2: null });
  await bien(api.guardarSalud({ pacienteId: a.id, tipo: 'alergia', descripcion: 'Penicilina', vigente: true }));
  await bien(api.guardarSalud({ pacienteId: a.id, tipo: 'alergia', descripcion: 'Látex', vigente: false }));
  await bien(api.guardarSalud({ pacienteId: a.id, tipo: 'diagnostico', descripcion: 'Diabetes', vigente: true }));
  consentir(db, a.id);
  const lista = await bien(api.listarPacientes());
  const ra = lista.find((x) => x.id === a.id)!;
  const rb = lista.find((x) => x.id === b.id)!;
  assert.deepEqual(ra.alergias, ['Penicilina']);
  assert.equal(ra.consentimientoSpd, true);
  assert.equal(rb.consentimientoSpd, false);
  assert.deepEqual(rb.alergias, []);
  assert.equal(ra.nombreCompleto, 'Ana López Ruiz');
  assert.equal(rb.nombreCompleto, 'Luis Pérez');
  assert.equal(ra.coberturaDias, null);
});

test('el consentimiento revocado o de otra plantilla NO cuenta', async () => {
  const { api, db } = await montar();
  const a = await crearPaciente(api);
  const id = consentir(db, a.id);
  assert.equal((await bien(api.listarPacientes()))[0].consentimientoSpd, true);
  db.run("UPDATE documento_firmado SET revocado_en = '2026-10-20T10:00:00Z' WHERE id = ?", [id]);
  assert.equal((await bien(api.listarPacientes()))[0].consentimientoSpd, false);
  const pl = db.run("INSERT INTO plantilla_documento(codigo,version,titulo,cuerpo) VALUES ('info_rgpd',1,'RGPD','x')").ultimoId;
  db.run('INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomUUID(), a.id, pl, 'Ana', 'paciente', '2026-10-01T10:00:00Z', 't', 'h', 1]);
  assert.equal((await bien(api.listarPacientes()))[0].consentimientoSpd, false);
});

test('búsqueda sin tildes ni mayúsculas por nombre, apellidos, DNI y CIP', async () => {
  const { api } = await montar();
  await crearPaciente(api, { nombre: 'José Ángel', apellido1: 'Muñoz', apellido2: 'Gómez', dniNie: '33333333P', cipAutonomico: 'ABCD1234567890' });
  await crearPaciente(api, { nombre: 'Marta', apellido1: 'Sanz', dniNie: '44444444A' });
  const q = async (texto: string) => (await bien(api.listarPacientes({ texto }))).map((x) => x.nombreCompleto);
  assert.deepEqual(await q('jose angel'), ['José Ángel Muñoz Gómez']);
  assert.deepEqual(await q('MUNOZ'), ['José Ángel Muñoz Gómez']);
  assert.deepEqual(await q('gomez munoz'), ['José Ángel Muñoz Gómez']);
  assert.deepEqual(await q('33.333.333-p'), ['José Ángel Muñoz Gómez']);
  assert.deepEqual(await q('abcd1234'), ['José Ángel Muñoz Gómez']);
  assert.deepEqual(await q('sanz'), ['Marta Sanz Ruiz']);
  assert.deepEqual(await q('inexistente'), []);
  assert.equal((await q('')).length, 2);
});

test('filtros de la lista: por defecto sólo en servicio; «todos», estado y centro', async () => {
  const { api } = await montar();
  const c = await bien(api.guardarCentro({ nombre: 'Residencia Sol' }));
  const a = await crearPaciente(api, { nombre: 'Ana', centroId: c.id, habitacion: '12' });
  const b = await crearPaciente(api, { nombre: 'Bea', apellido1: 'Zapata' });
  const d = await crearPaciente(api, { nombre: 'Dani', apellido1: 'Yuste' });
  await bien(api.darDeBajaPaciente(b.id, 'Fallece', 'fallecido'));
  await bien(api.darDeBajaPaciente(d.id, 'Pausa', 'pausado'));
  assert.deepEqual((await bien(api.listarPacientes())).map((x) => x.id).sort(), [a.id, d.id].sort());
  assert.equal((await bien(api.listarPacientes({ estado: 'todos' }))).length, 3);
  assert.deepEqual((await bien(api.listarPacientes({ estado: 'fallecido' }))).map((x) => x.id), [b.id]);
  const porCentro = await bien(api.listarPacientes({ centroId: c.id }));
  assert.deepEqual(porCentro.map((x) => [x.id, x.centro, x.habitacion]), [[a.id, 'Residencia Sol', '12']]);
  await mal(api.listarPacientes({ estado: 'otro' as never }), 'VALIDACION');
});

test('la lista sale ordenada por apellidos y nombre', async () => {
  const { api } = await montar();
  await crearPaciente(api, { nombre: 'Zoe', apellido1: 'Alonso', apellido2: null });
  await crearPaciente(api, { nombre: 'Ana', apellido1: 'Alonso', apellido2: null });
  await crearPaciente(api, { nombre: 'Luis', apellido1: 'Bravo', apellido2: null });
  assert.deepEqual((await bien(api.listarPacientes())).map((x) => x.nombreCompleto), ['Ana Alonso', 'Zoe Alonso', 'Luis Bravo']);
});

// ───────────────────────────── Centros, contactos y salud ─────────────────────────────

test('centros: crear, modificar, listar ordenado y validar el nombre', async () => {
  const { api, db } = await montar();
  await mal(api.guardarCentro({ nombre: ' ' }), 'VALIDACION');
  const b = await bien(api.guardarCentro({ nombre: 'Beta', telefono: '911' }));
  await bien(api.guardarCentro({ nombre: 'Alfa' }));
  const b2 = await bien(api.guardarCentro({ id: b.id, nombre: 'Beta II', telefono: '922', contacto: 'Marta' }));
  assert.equal(b2.nombre, 'Beta II');
  assert.deepEqual((await bien(api.listarCentros())).map((c) => c.nombre), ['Alfa', 'Beta II']);
  await mal(api.guardarCentro({ id: 99, nombre: 'X' }), 'NO_ENCONTRADO');
  assert.equal(db.get<{ n: number }>("SELECT count(*) AS n FROM auditoria WHERE entidad = 'centro'")!.n, 3);
});

test('contactos: alta, edición, tipo y paciente válidos, y no se edita el de otro paciente', async () => {
  const { api, db } = await montar();
  const a = await crearPaciente(api);
  const b = await crearPaciente(api, { nombre: 'Luis' });
  const c = await bien(api.guardarContacto({ pacienteId: a.id, tipo: 'cuidador', nombre: 'Rosa', dniNie: '55.555.555-b', telefono: '600', autorizadoRecoger: true }));
  assert.equal(c.dniNie, '55555555B');
  assert.equal(c.autorizadoRecoger, true);
  await mal(api.guardarContacto({ pacienteId: a.id, tipo: 'vecino' as never, nombre: 'X', autorizadoRecoger: false }), 'VALIDACION', /Tipo/);
  await mal(api.guardarContacto({ pacienteId: 999, tipo: 'otro', nombre: 'X', autorizadoRecoger: false }), 'NO_ENCONTRADO');
  await mal(api.guardarContacto({ pacienteId: a.id, tipo: 'otro', nombre: '', autorizadoRecoger: false }), 'VALIDACION');
  await mal(api.guardarContacto({ pacienteId: a.id, tipo: 'otro', nombre: 'X', email: 'no', autorizadoRecoger: false }), 'VALIDACION', /correo/);
  await mal(api.guardarContacto({ id: c.id, pacienteId: b.id, tipo: 'cuidador', nombre: 'Rosa', autorizadoRecoger: false }), 'VALIDACION', /otro paciente/);
  const c2 = await bien(api.guardarContacto({ id: c.id, pacienteId: a.id, tipo: 'familiar', nombre: 'Rosa M.', autorizadoRecoger: false }));
  assert.equal(c2.tipo, 'familiar');
  assert.equal((await bien(api.listarContactos(a.id))).length, 1);
  assert.equal((await bien(api.listarContactos(b.id))).length, 0);
  db.run("UPDATE contacto SET baja_en = '2026-11-01' WHERE id = ?", [c.id]);
  assert.equal((await bien(api.listarContactos(a.id))).length, 0);
});

test('datos de salud: alta con quién y cuándo, validación, edición y la lectura queda auditada', async () => {
  const { api, db, t } = await montar('tecnico');
  const a = await crearPaciente(api);
  const s = await bien(api.guardarSalud({ pacienteId: a.id, tipo: 'peso', descripcion: 'Peso', valor: '68 kg', fecha: '2026-10-30', vigente: true }));
  const fila = db.get<{ registrado_por: number; registrado_en: string }>('SELECT * FROM salud_dato WHERE id = ?', [s.id])!;
  assert.equal(fila.registrado_en, '2026-11-02T09:00:00Z');
  assert.equal(fila.registrado_por, t.ctx.sesion()!.id);
  await mal(api.guardarSalud({ pacienteId: a.id, tipo: 'raro' as never, descripcion: 'x', vigente: true }), 'VALIDACION', /Tipo/);
  await mal(api.guardarSalud({ pacienteId: a.id, tipo: 'otro', descripcion: ' ', vigente: true }), 'VALIDACION');
  await mal(api.guardarSalud({ pacienteId: a.id, tipo: 'otro', descripcion: 'x', fecha: '30/10/2026', vigente: true }), 'VALIDACION', /fecha/);
  const s2 = await bien(api.guardarSalud({ id: s.id, pacienteId: a.id, tipo: 'peso', descripcion: 'Peso', valor: '66 kg', vigente: false }));
  assert.equal(s2.vigente, false);
  const lista = await bien(api.listarSalud(a.id));
  assert.equal(lista.length, 1);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE accion = 'ver' AND entidad = 'salud_dato'"));
  await mal(api.guardarSalud({ id: 999, pacienteId: a.id, tipo: 'otro', descripcion: 'x', vigente: true }), 'NO_ENCONTRADO');
});

// ───────────────────────────── Medicamentos ─────────────────────────────

test('medicamento: el CN se normaliza a 6 dígitos y NO se valida el dígito de control', async () => {
  const { api } = await montar();
  const m = await crearMed(api, { cn: '712729.9' });   // dígito de control inventado
  assert.equal(m.cn, '712729');
  const e = await bien(api.obtenerMedicamento('C.N. 712729-3'));
  assert.equal(e!.nombre, 'Metformina Cinfa 850 mg');
  await mal(api.guardarMedicamento({ cn: '12345', nombre: 'X' }), 'VALIDACION', /código nacional/);
  await mal(api.guardarMedicamento({ cn: 'abcdef', nombre: 'X' }), 'VALIDACION');
  await mal(api.obtenerMedicamento('xx'), 'VALIDACION');
  assert.equal(await bien(api.obtenerMedicamento('999999')), null);
});

test('medicamento: el nombre es obligatorio y se validan unidades y direcciones', async () => {
  const { api } = await montar();
  await mal(api.guardarMedicamento({ cn: '712729', nombre: ' ' }), 'VALIDACION');
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', unidadesEnvase: 0 }), 'VALIDACION', /unidades/);
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', unidadesEnvase: 10.3 }), 'VALIDACION', /unidades/);
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', urlFichaTecnica: 'javascript:alert(1)' }), 'VALIDACION', /http/);
  const ok = await crearMed(api, { urlFichaTecnica: 'https://cima.aemps.es/cima/dochtml/ft/12345/FT_12345.html', receta: true });
  assert.equal(ok.receta, true);
  assert.equal(ok.creadoManual, true);
});

test('aptitud para SPD: el motor la PROPONE (apto, no apto por principio activo y por forma)', async () => {
  const { api } = await montar();
  const m = await crearMed(api);
  assert.equal(m.spdAptitud, 'apto');
  const s = await crearMed(api, { cn: '654321', nombre: 'Sintrom 4 mg', principiosActivos: 'acenocumarol 4 mg', formaFarmaceutica: 'COMPRIMIDO' });
  assert.equal(s.spdAptitud, 'no_apto');
  assert.match(s.spdMotivo!, /INR/);
  const e = await crearMed(api, { cn: '111111', nombre: 'Algo efervescente', formaFarmaceutica: 'COMPRIMIDO EFERVESCENTE', principiosActivos: 'paracetamol' });
  assert.equal(e.spdAptitud, 'no_apto');
  const d = await crearMed(api, { cn: '222222', nombre: 'Medicamento nuevo', principiosActivos: 'principiofantasia', formaFarmaceutica: 'COMPRIMIDO' });
  assert.equal(d.spdAptitud, null);   // ante la duda NO adivina
});

test('principios activos: se guardan estructurados y se devuelven como texto', async () => {
  const { api, db } = await montar();
  await crearMed(api);
  const raw = db.get<{ principios_activos: string }>("SELECT principios_activos FROM medicamento WHERE cn = '712729'")!.principios_activos;
  assert.deepEqual(JSON.parse(raw), [{ nombre: 'metformina 850 mg' }]);
  assert.equal((await bien(api.obtenerMedicamento('712729')))!.principiosActivos, 'metformina 850 mg');
  db.run("UPDATE medicamento SET principios_activos = ? WHERE cn = '712729'", [JSON.stringify([{ nombre: 'metformina', cantidad: 850, unidad: 'mg' }, { nombre: 'sitagliptina', cantidad: 50, unidad: 'mg' }])]);
  assert.equal((await bien(api.obtenerMedicamento('712729')))!.principiosActivos, 'metformina 850 mg + sitagliptina 50 mg');
});

test('confirmar la descripción: el técnico NO puede (SIN_PERMISO y no se escribe nada)', async () => {
  const { api, db } = await montar('tecnico');
  const r = await api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco', forma: 'redondo' }, true);
  assert.equal(r.ok, false);
  assert.equal((r as { codigo?: string }).codigo, 'SIN_PERMISO');
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM medicamento')!.n, 0);
  const admin = await montar('administrativo');
  const r2 = await admin.api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco' }, true);
  assert.equal((r2 as { codigo?: string }).codigo, 'SIN_PERMISO');
});

test('confirmar la descripción: farmacéutico y titular sí; queda quién y cuándo', async () => {
  for (const rol of ['farmaceutico', 'titular'] as RolUsuario[]) {
    const { api, db, t } = await montar(rol);
    const m = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'Blanco', forma: 'Redondo' }, true));
    assert.equal(m.descripcionEstado, 'confirmada');
    const f = db.get<{ descripcion_confirmada_por: number; descripcion_confirmada_en: string }>('SELECT * FROM medicamento')!;
    assert.equal(f.descripcion_confirmada_por, t.ctx.sesion()!.id, rol);
    assert.equal(f.descripcion_confirmada_en, '2026-11-02T09:00:00Z');
    assert.ok(db.get("SELECT 1 FROM auditoria WHERE accion = 'confirmar_descripcion' AND entidad = 'medicamento'"));
  }
});

test('la ficha pasa sin_datos → propuesta → confirmada y vuelve a propuesta si se cambia', async () => {
  const { api } = await montar();
  const a = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina' }));
  assert.equal(a.descripcionEstado, 'sin_datos');
  const b = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco' }));
  assert.equal(b.descripcionEstado, 'propuesta');
  const c = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco', forma: 'redondo' }, true));
  assert.equal(c.descripcionEstado, 'confirmada');
  // Guardar de nuevo sin tocar la descripción NO la desconfirma (aunque lo haga un técnico).
  const tec = await montar('tecnico');
  const d0 = await bien(tec.api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco' }));
  assert.equal(d0.descripcionEstado, 'propuesta', 'sin datos previos de ese técnico: ficha nueva');
  const d = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina Cinfa', laboratorio: 'Cinfa' }));
  assert.equal(d.descripcionEstado, 'confirmada');
  const e = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina Cinfa', color: 'azul' }));
  assert.equal(e.descripcionEstado, 'propuesta', 'cambiar el color obliga a confirmar otra vez');
  assert.equal(e.forma, 'redondo', 'el resto de campos se conserva (edición parcial)');
});

test('un técnico puede editar una ficha confirmada, pero al cambiar el aspecto deja de estar confirmada', async () => {
  const f = await montar('farmaceutico');
  await bien(f.api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco', forma: 'redondo' }, true));
  const api2 = crearClinicaBase({ ...f.t.ctx, sesion: () => ({ id: 3, nombre: 'T', iniciales: 'TE', rol: 'tecnico' }) });
  const m = await bien(api2.guardarMedicamento({ cn: '712729', nombre: 'Metformina', forma: 'ovalado' }));
  assert.equal(m.descripcionEstado, 'propuesta');
  const fila = f.db.get<{ descripcion_confirmada_por: number | null }>('SELECT descripcion_confirmada_por FROM medicamento')!;
  assert.equal(fila.descripcion_confirmada_por, null);
});

test('confirmar sin descripción que confirmar es un error', async () => {
  const { api } = await montar();
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina' }, true), 'VALIDACION', /No hay descripción/);
});

test('vocabulario cerrado: colores y formas fuera de la lista se rechazan; se guarda en canónico', async () => {
  const { api } = await montar();
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', color: 'brillante mágico' }), 'VALIDACION', /Color no reconocido/);
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', color: 'rojo extraño' }), 'VALIDACION', /Color/);
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', color: '<script>' }), 'VALIDACION');
  await mal(api.guardarMedicamento({ cn: '712729', nombre: 'X', forma: 'estrellado' }), 'VALIDACION', /Forma no reconocida/);
  const m = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'X', color: 'MARRON', forma: 'Redondo' }));
  assert.equal(m.color, 'marrón');
  assert.equal(m.forma, 'redondo');
  const n = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'X', color: 'Blanco y Azul', forma: 'Redondo, Biconvexo' }));
  assert.equal(n.color, 'blanco, azul');
  assert.equal(n.forma, 'redondo, biconvexo');
  const v = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'X', color: null, forma: null }));
  assert.equal(v.color, null);
});

test('el texto libre de la descripción propone color, forma y marcas (sin confirmar)', async () => {
  const { api } = await montar();
  const m = await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina', descripcionFisica: 'Comprimidos recubiertos blancos, redondos, biconvexos, marcados con "M 500"' }));
  assert.equal(m.color, 'blanco');
  assert.match(m.forma!, /redondo/);
  assert.equal(m.descripcionEstado, 'propuesta');
  assert.match(m.marcasGrabado ?? '', /M 500/);
});

test('aptitud: sólo un farmacéutico/titular la fija, con motivo, y el motor ya no la pisa', async () => {
  const { api, db } = await montar();
  await crearMed(api, { cn: '654321', nombre: 'Sintrom 4 mg', principiosActivos: 'acenocumarol', formaFarmaceutica: 'COMPRIMIDO' });
  const tec = crearClinicaBase({ ...(await montar()).t.ctx, sesion: () => ({ id: 3, nombre: 'T', iniciales: 'TE', rol: 'tecnico' }), db: () => db });
  await mal(tec.guardarMedicamento({ cn: '654321', nombre: 'Sintrom 4 mg', spdAptitud: 'apto', spdMotivo: 'estable' }), 'SIN_PERMISO');
  await mal(api.guardarMedicamento({ cn: '654321', nombre: 'Sintrom 4 mg', spdAptitud: 'apto' }), 'VALIDACION', /motivo/);
  const m = await bien(api.guardarMedicamento({ cn: '654321', nombre: 'Sintrom 4 mg', spdAptitud: 'precaucion', spdMotivo: 'INR estable 2 años, valorado por el médico' }));
  assert.equal(m.spdAptitud, 'precaucion');
  const otra = await bien(api.guardarMedicamento({ cn: '654321', nombre: 'Sintrom 4 mg (cambio de nombre)' }));
  assert.equal(otra.spdAptitud, 'precaucion', 'la decisión del farmacéutico manda sobre el motor');
  assert.ok(db.get('SELECT 1 FROM medicamento WHERE cn = ? AND spd_decidido_por IS NOT NULL', ['654321']));
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE accion = 'fijar_aptitud'"));
  await mal(api.guardarMedicamento({ cn: '654321', nombre: 'X', spdAptitud: 'genial' as never, spdMotivo: 'x' }), 'VALIDACION', /Aptitud/);
});

test('reenviar el DTO completo (ida y vuelta) NO cuenta como decisión del farmacéutico', async () => {
  const { api, db } = await montar('tecnico');
  const m = await crearMed(api);
  const otra = await bien(api.guardarMedicamento({ ...m, nombre: 'Metformina Cinfa 850 mg EFG' }));
  assert.equal(otra.spdAptitud, 'apto');
  assert.equal(db.get<{ spd_decidido_por: number | null }>('SELECT spd_decidido_por FROM medicamento')!.spd_decidido_por, null);
});

test('buscar medicamentos: por nombre sin tildes, por CN en cualquier formato y por principio activo', async () => {
  const { api } = await montar();
  await crearMed(api);
  await crearMed(api, { cn: '654321', nombre: 'Nolotil 575 mg', principiosActivos: 'metamizol', laboratorio: 'Boehringer' });
  assert.deepEqual((await bien(api.buscarMedicamentos('METFORMINA'))).map((x) => x.cn), ['712729']);
  assert.deepEqual((await bien(api.buscarMedicamentos('nolotil'))).map((x) => x.cn), ['654321']);
  assert.deepEqual((await bien(api.buscarMedicamentos('metamizol'))).map((x) => x.cn), ['654321']);
  assert.deepEqual((await bien(api.buscarMedicamentos('boehringer'))).map((x) => x.cn), ['654321']);
  assert.deepEqual((await bien(api.buscarMedicamentos('654321'))).map((x) => x.cn), ['654321']);
  assert.deepEqual((await bien(api.buscarMedicamentos('C.N. 654321.8'))).map((x) => x.cn), ['654321']);
  assert.deepEqual((await bien(api.buscarMedicamentos('zzz'))).map((x) => x.cn), []);
  assert.equal((await bien(api.buscarMedicamentos(''))).length, 2);
});

test('analizar ficha técnica: propone descripción y aptitud sin guardar nada', async () => {
  const { api, db } = await montar();
  const r = await bien(api.analizarFichaTecnica('Comprimidos redondos, blancos, ranurados', 'Metformina Cinfa 850 mg', 'COMPRIMIDO'));
  assert.deepEqual(r.descripcion.colores, ['blanco']);
  assert.equal(r.descripcion.forma, 'redondo');
  assert.equal(r.descripcion.ranuraDivisible, 'desconocido');
  assert.equal(r.aptitud?.decidePor, 'motor');
  const e = await bien(api.analizarFichaTecnica('', 'Algo', 'COMPRIMIDO EFERVESCENTE'));
  assert.ok(e.descripcion.avisos.some((x) => /sin descripción/.test(x)));
  assert.equal(e.aptitud?.estado, 'no_apto');
  await mal(api.analizarFichaTecnica(123 as never), 'VALIDACION');
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM medicamento')!.n, 0);
});

test('guardarMedicamento es atómico: si la auditoría falla no queda la ficha', async () => {
  const { t, db } = await montar();
  const rota = { ...t.ctx, auditar: () => { throw new Error('caída'); } };
  const r = await crearClinicaBase(rota).guardarMedicamento({ cn: '712729', nombre: 'Metformina', color: 'blanco', forma: 'redondo' }, true);
  assert.equal(r.ok, false);
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM medicamento')!.n, 0);
});
