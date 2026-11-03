/**
 * Consentimientos opcionales y «gestionado sin firma individual».
 *  - El ajuste `exigir_consentimientos` (por defecto SÍ) decide si faltar un consentimiento impide validar.
 *  - «Gestionado sin firma individual» (por paciente y masivo por centro) deja en cada paciente un registro con
 *    origen `gestionado_sin_firma`: NO es una firma, lleva motivo/usuario/fecha, es revocable y queda auditado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import type { ContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaPreparacion } from '../src/servicios/clinica-preparacion.ts';
import { panelHoy } from '../src/servicios/clinica/panel.ts';
import { listarPacientes } from '../src/servicios/clinica/pacientes.ts';
import { abrirDb, VERSION_ESQUEMA } from '../src/servicios/db.ts';
import { ESQUEMA_V1 } from '../src/servicios/esquema-sql.ts';
import type { Resultado, RolUsuario } from '../src/servicios/api.ts';

const ok = <T>(r: Resultado<T>): T => { assert.equal(r.ok, true, r.ok ? '' : `${r.error} [${r.codigo}]`); return (r as { ok: true; datos: T }).datos; };
const ko = <T>(r: Resultado<T>, codigo?: string) => {
  assert.equal(r.ok, false, 'se esperaba un fallo');
  if (codigo) assert.equal((r as { codigo?: string }).codigo, codigo, JSON.stringify(r));
  return r as { ok: false; error: string; codigo?: string };
};
const MOTIVO = 'Consentimiento recogido por el centro';

interface M { t: ContextoPruebas; api: ReturnType<typeof crearClinicaPreparacion>; uid: (r: RolUsuario) => number }

/** Centro 1 (Residencia Sol) con tres pacientes activos y uno de baja; paciente 10 individual. Paciente 1 con tratamiento validable. */
async function montar(rol: RolUsuario | null = 'farmaceutico'): Promise<M> {
  const t = await crearContextoPruebas(rol);
  const api = crearClinicaPreparacion(t.ctx);
  const ids = new Map<string, number>(t.db.all<{ id: number; rol: string }>('SELECT id, rol FROM usuario').map((u) => [u.rol, u.id]));
  const m: M = { t, api, uid: (r) => ids.get(r)! };
  const db = t.db;
  db.run("UPDATE farmacia SET telefono='955 000 000', direccion='Calle Sol 1', municipio='Sevilla', nif='B12345678', email='f@farmacia.test', rgpd_dpd='No designado' WHERE id=1");
  db.run("INSERT INTO centro(id,nombre,nombre_norm,tipo) VALUES (1,'Residencia Sol','residencia sol','residencia_mayores'), (2,'Otra residencia','otra residencia','residencia_mayores')");
  const pac = (id: number, nombre: string, centro: number | null, estado = 'activo') => db.run(
    `INSERT INTO paciente(id,id_publico,nombre,apellido1,dni_nie,fecha_nacimiento,direccion,municipio,centro_id,estado) VALUES (?,?,?,?,?,'1940-01-01','Calle Luna 2','Sevilla',?,?)`,
    [id, `aaaaaaaa-0000-4000-8000-0000000000${String(id).padStart(2, '0')}`, nombre, 'Prueba', `1234567${id}Z`, centro, estado]);
  pac(1, 'Ana', 1); pac(2, 'Beatriz', 1); pac(3, 'Carlos', 1); pac(4, 'Daniel', 1, 'baja'); pac(10, 'Elena', null); pac(20, 'Fermín', 2);
  db.run("INSERT INTO medicamento(cn,nombre,descripcion_fisica,descripcion_estado,descripcion_confirmada_por) VALUES ('654321','Metformina Test 850 mg 28 comp','comprimido blanco, oblongo','confirmada',?)", [m.uid('farmaceutico')]);
  db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, cn_preferente, emblistable) VALUES (1,1,'Metformina','850 mg','654321',1)");
  const pv = db.run("INSERT INTO pauta_version(tratamiento_id, version, vigente_desde, vigente_hasta, patron, origen, creado_por) VALUES (1,1,'2026-01-01',NULL,'diario','receta',?)", [m.uid('farmaceutico')]).ultimoId;
  db.run('INSERT INTO pauta_dosis(pauta_version_id, momento_id, unidades) VALUES (?,1,1)', [pv]);
  db.run("INSERT INTO envase(paciente_id, tratamiento_id, cn, lote, caducidad, origen_lectura, unidades_inicio, unidades_restantes, recibido_por) VALUES (1,1,'654321','MET1','2028-05-31','manual',28,28,?)", [m.uid('farmaceutico')]);
  ok(await api.listarPlantillasDocumento());   // siembra las plantillas
  return m;
}
const ajustar = (m: M, v: string) => m.t.db.run("INSERT INTO ajuste(clave,valor) VALUES ('exigir_consentimientos',?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor", [v]);
const PARAMS = { pacienteId: 1, desde: '2026-11-03', dias: 7, fechaPreparacion: '2026-11-02' };
const filas = (m: M, sql: string, p: (string | number)[] = []) => m.t.db.all<Record<string, any>>(sql, p);
const gestionados = (m: M) => filas(m, "SELECT * FROM documento_firmado WHERE origen = 'gestionado_sin_firma' ORDER BY id");

// ───────────────────────── ajuste: exigir consentimientos para validar ─────────────────────────

test('validar: con el ajuste por defecto (exigir) y sin consentimientos, BLOQUEA', async () => {
  const m = await montar();
  const b = ok(await m.api.crearPreparacion(PARAMS));
  const p = ok(await m.api.marcarPreparada(b.id));
  const r = ko(await m.api.validarPreparacion(p.id));
  assert.match(r.error, /consentimientos/i);
  assert.equal(ok(await m.api.obtenerPreparacion(b.id)).preparacion.estado, 'preparado');
});

test('validar: con el ajuste DESACTIVADO se puede validar sin consentimientos, y lo pendiente sale como aviso', async () => {
  const m = await montar();
  ajustar(m, '0');
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.ok(!e.bloqueos.some((x) => x.codigo === 'CONSENTIMIENTO_NO_VIGENTE'));
  assert.ok(e.avisos.some((x) => x.codigo === 'CONSENTIMIENTO_NO_EXIGIDO'));
  const p = ok(await m.api.marcarPreparada(ok(await m.api.crearPreparacion(PARAMS)).id));
  assert.equal(ok(await m.api.validarPreparacion(p.id)).estado, 'validado');
});

test('el ajuste sólo relaja los consentimientos: el rol y la alergia siguen bloqueando', async () => {
  const m = await montar('tecnico');
  ajustar(m, '0');
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.ok(e.bloqueos.some((x) => x.codigo === 'ROL_NO_PUEDE_VALIDAR'), 'un técnico sigue sin poder validar');
  m.t.db.run(`INSERT INTO salud_dato(paciente_id,tipo,descripcion,vigente,registrado_por) VALUES (1,'alergia','metformina',1,${m.uid('farmaceutico')})`);
  m.t.cambiarUsuario('farmaceutico');
  const e2 = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.ok(e2.bloqueos.some((x) => x.codigo === 'ALERGIA_SIN_CONFIRMAR'), 'la alergia sin confirmar sigue bloqueando');
});

test('valores raros del ajuste exigen (sólo un valor negativo explícito lo relaja)', async () => {
  const m = await montar();
  for (const v of ['', 'quizá', '2', 'SI', '1', 'true']) {
    ajustar(m, v);
    assert.equal(ok(await m.api.estadoConsentimientos(1)).exigido, true, `«${v}»`);
  }
  for (const v of ['0', 'false', 'no', ' NO ']) {
    ajustar(m, v);
    assert.equal(ok(await m.api.estadoConsentimientos(1)).exigido, false, `«${v}»`);
  }
});

test('estadoConsentimientos: con la exigencia apagada lo pendiente se sigue enseñando (completo=false), pero no se exige', async () => {
  const m = await montar();
  ajustar(m, '0');
  const e = ok(await m.api.estadoConsentimientos(1));
  assert.equal(e.exigido, false);
  assert.equal(e.completo, false);
  assert.deepEqual(e.faltan.sort(), ['consentimiento_spd', 'info_rgpd']);
});

test('panel Hoy: sin consentimiento es BLOQUEO si se exige; INFORMACIÓN (no rojo) si no; con gestionado no sale', async () => {
  const m = await montar();
  let tareas = ok(await panelHoy(m.t.ctx)).tareas.filter((x) => x.tipo === 'sin_consentimiento');
  assert.ok(tareas.length >= 4 && tareas.every((x) => x.gravedad === 'bloqueo'));
  ajustar(m, '0');
  tareas = ok(await panelHoy(m.t.ctx)).tareas.filter((x) => x.tipo === 'sin_consentimiento');
  assert.ok(tareas.length >= 4 && tareas.every((x) => x.gravedad === 'info'), 'informativo, no bloqueo');
  assert.match(tareas[0].texto, /no lo exige/);
  ajustar(m, '1');
  ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd'], motivo: MOTIVO }));
  assert.ok(!ok(await panelHoy(m.t.ctx)).tareas.some((x) => x.tipo === 'sin_consentimiento' && x.pacienteId === 1));
});

// ───────────────────────── gestionado sin firma individual ─────────────────────────

test('un paciente: registra el documento como gestionado, sin firma, con motivo, usuario y hash', async () => {
  const m = await montar();
  const r = ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd', 'info_rgpd'], motivo: `  ${MOTIVO}  ` }));
  assert.equal(r.simulado, false);
  assert.equal(r.totalPacientes, 1); assert.equal(r.totalRegistrados, 2); assert.equal(r.totalSaltados, 0);
  const g = gestionados(m);
  assert.equal(g.length, 2);
  for (const f of g) {
    assert.equal(f.paciente_id, 1);
    assert.equal(f.firmante_calidad, 'sin_firma');
    assert.equal(f.firmante, 'Sin firma individual');
    assert.equal(f.motivo_gestion, MOTIVO);
    assert.equal(f.registrado_por, m.uid('farmaceutico'));
    assert.equal(f.revocado_en, null);
    assert.match(f.texto_impreso, /^GESTIONADO SIN FIRMA INDIVIDUAL/);
    assert.match(f.texto_impreso, new RegExp(MOTIVO));
    assert.match(f.texto_impreso, /No consta firma del paciente/);
    assert.equal(f.hash_texto, createHash('sha256').update(f.texto_impreso, 'utf8').digest('hex'));
  }
  // para el programa el consentimiento está vigente, y se ve como gestionado (no como firmado)
  const e = ok(await m.api.estadoConsentimientos(1));
  assert.equal(e.completo, true);
  assert.deepEqual(e.gestionados.sort(), ['consentimiento_spd', 'info_rgpd']);
  assert.ok(e.firmados.every((f) => f.origen === 'gestionado_sin_firma' && f.motivoGestion === MOTIVO && f.registradoPor === 'Farma Prueba'));
  assert.ok(!e.firmados.some((f) => f.origen === 'firma'), 'ninguna firma inventada');
  // y desbloquea la validación con el ajuste en su valor por defecto (exigir)
  const p = ok(await m.api.marcarPreparada(ok(await m.api.crearPreparacion(PARAMS)).id));
  assert.equal(ok(await m.api.validarPreparacion(p.id)).estado, 'validado');
});

test('auditoría: cada registro queda auditado con el motivo, y el masivo deja además un resumen', async () => {
  const m = await montar();
  ok(await m.api.gestionarDocumentosSinFirma({ centroId: 1, codigos: ['consentimiento_spd'], motivo: MOTIVO }));
  const aud = m.t.auditadas.filter((a) => a.entidad === 'documento_firmado');
  assert.equal(aud.length, 3, 'uno por paciente activo del centro');
  for (const a of aud) {
    assert.equal(a.accion, 'crear');
    assert.match(a.motivo ?? '', /Gestionado sin firma individual: Consentimiento recogido por el centro/);
    const d = a.despues as { origen: string; centro: string; hash: string };
    assert.equal(d.origen, 'gestionado_sin_firma'); assert.equal(d.centro, 'Residencia Sol'); assert.match(d.hash, /^[0-9a-f]{64}$/);
  }
  const resumen = m.t.auditadas.filter((a) => a.entidad === 'consentimiento');
  assert.equal(resumen.length, 1);
  assert.deepEqual(resumen[0].despues, { origen: 'gestionado_sin_firma', centro: 'Residencia Sol', pacientes: 3, documentos: ['consentimiento_spd'], registrados: 3, saltados: 0 });
  // y la auditoría real encadenada está en la base
  assert.equal(filas(m, "SELECT count(*) AS n FROM auditoria WHERE entidad IN ('documento_firmado','consentimiento')")[0].n, 4);
});

test('masivo por centro: sólo pacientes ACTIVOS de ese centro; no toca individuales, de baja ni de otro centro', async () => {
  const m = await montar();
  const r = ok(await m.api.gestionarDocumentosSinFirma({ centroId: 1, codigos: ['consentimiento_spd', 'info_rgpd'], motivo: MOTIVO }));
  assert.equal(r.totalPacientes, 3);
  assert.deepEqual(r.pacientes.map((p) => p.id), [1, 2, 3]);
  assert.equal(r.totalRegistrados, 6);
  assert.deepEqual([...new Set(gestionados(m).map((f) => f.paciente_id))].sort(), [1, 2, 3]);
  for (const id of [4, 10, 20]) assert.equal(ok(await m.api.estadoConsentimientos(id)).completo, false, `paciente ${id} no se toca`);
});

test('masivo: quien ya tiene el documento vigente (firma real o gestionado) se salta; no se pisa ni se duplica', async () => {
  const m = await montar();
  const pl = filas(m, "SELECT id FROM plantilla_documento WHERE codigo = 'consentimiento_spd'")[0].id;
  m.t.db.run(`INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por)
              VALUES ('firmado-real',2,?,'Beatriz Prueba','paciente','2026-10-01T10:00:00Z','texto firmado','h',?)`, [pl, m.uid('farmaceutico')]);
  const r = ok(await m.api.gestionarDocumentosSinFirma({ centroId: 1, codigos: ['consentimiento_spd'], motivo: MOTIVO }));
  assert.equal(r.totalRegistrados, 2); assert.equal(r.totalSaltados, 1);
  assert.deepEqual(r.pacientes.find((p) => p.id === 2)!.saltados, ['consentimiento_spd']);
  assert.equal(filas(m, 'SELECT count(*) AS n FROM documento_firmado WHERE paciente_id = 2')[0].n, 1, 'no se añade nada a quien ya firmó');
  // repetir: ya todos lo tienen → nada que registrar, y no se escribe ni se audita de más
  const antes = m.t.auditadas.length;
  const otra = ok(await m.api.gestionarDocumentosSinFirma({ centroId: 1, codigos: ['consentimiento_spd'], motivo: MOTIVO }));
  assert.equal(otra.totalRegistrados, 0); assert.equal(otra.totalSaltados, 3);
  assert.equal(m.t.auditadas.length, antes);
  assert.equal(gestionados(m).length, 2);
});

test('simular: cuenta lo que haría SIN escribir ni auditar ni exigir motivo', async () => {
  const m = await montar();
  const antes = m.t.auditadas.length;
  const r = ok(await m.api.gestionarDocumentosSinFirma({ centroId: 1, codigos: ['consentimiento_spd', 'info_rgpd'], motivo: '', simular: true }));
  assert.equal(r.simulado, true); assert.equal(r.totalPacientes, 3); assert.equal(r.totalRegistrados, 6);
  assert.deepEqual(r.documentos.map((d) => d.codigo), ['consentimiento_spd', 'info_rgpd']);
  assert.ok(r.documentos.every((d) => d.titulo.length > 5 && d.version === 1));
  assert.equal(gestionados(m).length, 0);
  assert.equal(m.t.auditadas.length, antes);
});

test('permisos: sólo titular o farmacéutico; técnico y administrativo no', async () => {
  const m = await montar('tecnico');
  for (const rol of ['tecnico', 'administrativo'] as const) {
    m.t.cambiarUsuario(rol);
    ko(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd'], motivo: MOTIVO }), 'SIN_PERMISO');
    ko(await m.api.gestionarDocumentosSinFirma({ centroId: 1, codigos: ['consentimiento_spd'], motivo: MOTIVO, simular: true }), 'SIN_PERMISO');
  }
  assert.equal(gestionados(m).length, 0);
  for (const rol of ['titular', 'farmaceutico'] as const) {
    m.t.cambiarUsuario(rol);
    assert.equal(ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [rol === 'titular' ? 2 : 3], codigos: ['info_rgpd'], motivo: MOTIVO })).totalRegistrados, 1);
  }
  m.t.cambiarUsuario(null);
  ko(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['info_rgpd'], motivo: MOTIVO }), 'SIN_SESION');
});

test('validación: motivo obligatorio (≥5), sólo documentos gestionables, destino claro y existente', async () => {
  const m = await montar();
  const base = { pacienteIds: [1], codigos: ['consentimiento_spd'], motivo: MOTIVO };
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, motivo: '' }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, motivo: '   ok  ' }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, motivo: 'x'.repeat(301) }), 'VALIDACION');
  for (const c of ['recibi_devolucion', 'revocacion', 'autorizacion_terceros', 'inventado']) ko(await m.api.gestionarDocumentosSinFirma({ ...base, codigos: [c] }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, codigos: [] }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, pacienteIds: [] }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, pacienteIds: [1.5] }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, pacienteIds: [999] }), 'NO_ENCONTRADO');
  ko(await m.api.gestionarDocumentosSinFirma({ codigos: ['consentimiento_spd'], motivo: MOTIVO }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ ...base, centroId: 1 }), 'VALIDACION');
  ko(await m.api.gestionarDocumentosSinFirma({ codigos: ['consentimiento_spd'], motivo: MOTIVO, centroId: 77 }), 'NO_ENCONTRADO');
  m.t.db.run("INSERT INTO centro(id,nombre,nombre_norm) VALUES (3,'Vacío','vacio')");
  ko(await m.api.gestionarDocumentosSinFirma({ codigos: ['consentimiento_spd'], motivo: MOTIVO, centroId: 3 }), 'VALIDACION');
  assert.equal(gestionados(m).length, 0, 'ningún intento inválido escribe nada');
});

test('revocable: revocar un gestionado lo deja sin efecto (se vuelve a exigir) y queda auditado', async () => {
  const m = await montar();
  ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd', 'info_rgpd'], motivo: MOTIVO }));
  const e = ok(await m.api.estadoConsentimientos(1));
  const id = e.firmados.find((f) => f.codigo === 'consentimiento_spd')!.id;
  ko(await m.api.revocarDocumento(id, ''), 'VALIDACION');
  ok(await m.api.revocarDocumento(id, 'El centro ya no lo recoge'));
  const despues = ok(await m.api.estadoConsentimientos(1));
  assert.equal(despues.completo, false);
  assert.deepEqual(despues.revocados, ['consentimiento_spd']);
  assert.ok(m.t.auditadas.some((a) => a.accion === 'revocar' && a.entidad === 'documento_firmado' && a.motivo === 'El centro ya no lo recoge'));
  // y entonces se puede volver a dar por gestionado (es un registro nuevo, no se reescribe el antiguo)
  const otra = ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd'], motivo: 'Lo recoge de nuevo el centro' }));
  assert.equal(otra.totalRegistrados, 1);
  assert.equal(filas(m, "SELECT count(*) AS n FROM documento_firmado WHERE paciente_id = 1 AND origen = 'gestionado_sin_firma'")[0].n, 3, 'el historial conserva el revocado');
});

test('de gestionado a firma real: registrar la firma exige sustituir con motivo, y deja el gestionado revocado en el historial', async () => {
  const m = await montar();
  ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd'], motivo: MOTIVO }));
  const REP = { nombre: 'Ana Prueba', calidad: 'paciente' as const };
  const e = ko(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP), 'DOCUMENTO_YA_FIRMADO');
  assert.match(e.error, /gestionado sin firma individual/);
  ok(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP, { sustituir: true, motivo: 'Ha firmado el propio paciente' }));
  const d = ok(await m.api.estadoConsentimientos(1));
  assert.deepEqual(d.gestionados, [], 'ahora hay firma real');
  assert.equal(d.firmados.find((f) => f.codigo === 'consentimiento_spd' && !f.revocado)!.origen, 'firma');
  assert.equal(d.firmados.filter((f) => f.codigo === 'consentimiento_spd').length, 2);
});

test('lista de pacientes: se distingue «firmado» de «gestionado sin firma»', async () => {
  const m = await montar();
  const pl = filas(m, "SELECT id FROM plantilla_documento WHERE codigo = 'consentimiento_spd'")[0].id;
  m.t.db.run(`INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por)
              VALUES ('firmado-real',2,?,'Beatriz','paciente','2026-10-01T10:00:00Z','t','h',?)`, [pl, m.uid('farmaceutico')]);
  ok(await m.api.gestionarDocumentosSinFirma({ pacienteIds: [1], codigos: ['consentimiento_spd'], motivo: MOTIVO }));
  const lista = ok(await listarPacientes(m.t.ctx, { estado: 'todos' }));
  const de = (id: number) => lista.find((p) => p.id === id)!;
  assert.deepEqual([de(1).consentimientoSpd, de(1).consentimientoGestionado], [true, true]);
  assert.deepEqual([de(2).consentimientoSpd, de(2).consentimientoGestionado], [true, false]);
  assert.deepEqual([de(3).consentimientoSpd, de(3).consentimientoGestionado], [false, false]);
});

test('restricciones de la base: un gestionado exige motivo y su calidad; una firma real no puede decir «sin_firma»', async () => {
  const m = await montar();
  const pl = filas(m, "SELECT id FROM plantilla_documento WHERE codigo = 'info_rgpd'")[0].id;
  const ins = (calidad: string, origen: string, motivo: string | null) => m.t.db.run(
    `INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por,origen,motivo_gestion)
     VALUES (?,1,?,'x',?,'2026-11-02T10:00:00Z','t','h',?,?,?)`, [`u-${Math.random()}`, pl, calidad, m.uid('farmaceutico'), origen, motivo]);
  assert.throws(() => ins('paciente', 'gestionado_sin_firma', 'motivo largo'), /CHECK/);     // gestionado haciéndose pasar por paciente
  assert.throws(() => ins('sin_firma', 'gestionado_sin_firma', null), /CHECK/);              // sin motivo
  assert.throws(() => ins('sin_firma', 'gestionado_sin_firma', '  no '), /CHECK/);           // motivo vacío de hecho
  assert.throws(() => ins('sin_firma', 'firma', null), /CHECK/);                              // una «firma» sin firmante real
  assert.throws(() => ins('paciente', 'otro', null), /CHECK/);
  ins('sin_firma', 'gestionado_sin_firma', 'motivo largo');
  ins('paciente', 'firma', null);
});

// ───────────────────────── migración v2 → v3 ─────────────────────────

const TABLA_V2 = `CREATE TABLE documento_firmado (
  id INTEGER PRIMARY KEY, id_publico TEXT NOT NULL UNIQUE, paciente_id INTEGER NOT NULL REFERENCES paciente(id),
  plantilla_id INTEGER NOT NULL REFERENCES plantilla_documento(id), firmante TEXT NOT NULL,
  firmante_calidad TEXT NOT NULL CHECK (firmante_calidad IN ('paciente','representante_legal','guardador_de_hecho')),
  contacto_id INTEGER REFERENCES contacto(id), firmado_en TEXT NOT NULL, texto_impreso TEXT NOT NULL, hash_texto TEXT NOT NULL,
  escaneo BLOB, revocado_en TEXT, motivo_revocacion TEXT, registrado_por INTEGER NOT NULL REFERENCES usuario(id)
);
`;

async function baseV2() {
  const v2 = ESQUEMA_V1.replace(/CREATE TABLE documento_firmado \([\s\S]*?\n\);\n/, TABLA_V2).replace(/PRAGMA journal_mode = WAL;/i, '');
  assert.ok(!/origen\s+TEXT NOT NULL DEFAULT 'firma'/.test(v2) && /TABLA|CREATE TABLE documento_firmado/.test(v2));
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const raw = new SQL.Database();
  raw.exec(v2);
  raw.exec("INSERT INTO usuario(id,nombre,iniciales,rol,hash_clave) VALUES (1,'Titular','TI','titular','x')");
  raw.exec("INSERT INTO paciente(id,id_publico,nombre,apellido1) VALUES (1,'u1','Ana','López')");
  raw.exec("INSERT INTO plantilla_documento(id,codigo,version,titulo,cuerpo) VALUES (1,'info_rgpd',1,'Info','texto')");
  raw.exec(`INSERT INTO documento_firmado(id,id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por,revocado_en,motivo_revocacion)
            VALUES (7,'d1',1,1,'Ana López','paciente','2026-10-01T10:00:00Z','texto exacto firmado','hash1',1,NULL,NULL),
                   (9,'d2',1,1,'Luis López','representante_legal','2026-10-02T10:00:00Z','otro texto','hash2',1,'2026-10-05T00:00:00Z','Cambio de representante')`);
  raw.exec('PRAGMA user_version = 2;');
  return raw.export();
}

test('migración v2→v3: no se pierde ni se reescribe ningún documento firmado, y el esquema queda igual que el de una base nueva', async () => {
  assert.equal(VERSION_ESQUEMA, 3);
  const db = await abrirDb(await baseV2());
  assert.equal(db.version(), 3);
  const f = db.all<Record<string, any>>('SELECT * FROM documento_firmado ORDER BY id');
  assert.deepEqual(f.map((x) => [x.id, x.id_publico, x.firmante, x.firmante_calidad, x.texto_impreso, x.hash_texto, x.revocado_en, x.motivo_revocacion, x.origen, x.motivo_gestion]), [
    [7, 'd1', 'Ana López', 'paciente', 'texto exacto firmado', 'hash1', null, null, 'firma', null],
    [9, 'd2', 'Luis López', 'representante_legal', 'otro texto', 'hash2', '2026-10-05T00:00:00Z', 'Cambio de representante', 'firma', null],
  ]);
  const nueva = await abrirDb();
  const forma = (d: typeof db) => d.all<Record<string, any>>('PRAGMA table_info(documento_firmado)').map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
  assert.deepEqual(forma(db), forma(nueva));
  // las restricciones nuevas ya rigen en la migrada
  assert.throws(() => db.run("INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por,origen) VALUES ('x',1,1,'a','paciente','2026','t','h',1,'gestionado_sin_firma')"), /CHECK/);
  db.run("INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por,origen,motivo_gestion) VALUES ('y',1,1,'a','sin_firma','2026','t','h',1,'gestionado_sin_firma','motivo largo')");
  assert.equal(db.get<{ n: number }>('SELECT count(*) AS n FROM documento_firmado')!.n, 3);
  // reabrir una base ya migrada no repite nada; el id UNIQUE sigue protegiendo
  const otra = await abrirDb(db.exportar());
  assert.equal(otra.version(), 3);
  assert.equal(otra.get<{ n: number }>('SELECT count(*) AS n FROM documento_firmado')!.n, 3);
  assert.throws(() => otra.run("INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por) VALUES ('d1',1,1,'a','paciente','2026','t','h',1)"), /UNIQUE/);
});

// ───────────────────────── interfaz: lo pendiente, como información cuando no se exige ─────────────────────────
import { readFileSync } from 'node:fs';

test('interfaz: sin exigencia lo pendiente sale como información y no en rojo; con gestionados se ofrece el botón sólo a quien puede', () => {
  const quitar = (t: string) => t.replace(/<!--[\s\S]*?-->/g, '');
  const resumen = quitar(readFileSync('src/interfaz/pantallas/paciente/Resumen.svelte', 'utf8'));
  assert.match(resumen, /tipo=\{consent\.exigido \? 'atencion' : 'info'\}/);
  assert.match(resumen, /consent\?\.exigido === false/);
  const ficha = quitar(readFileSync('src/interfaz/pantallas/FichaPaciente.svelte', 'utf8'));
  assert.match(ficha, /!consent\.exigido[\s\S]*?Pendientes \(no exigidos\)/);
  const docs = quitar(readFileSync('src/interfaz/pantallas/FichaDocumentos.svelte', 'utf8'));
  assert.match(docs, /estado && !estado\.exigido[\s\S]*?docs-no-exigidos/);
  assert.match(docs, /Gestionado por el centro, sin firma individual/);
  assert.match(docs, /\{#if puedeGestionar && GESTIONABLES_SIN_FIRMA\.includes\(f\.p\.codigo\)/);
  const pac = quitar(readFileSync('src/interfaz/pantallas/Pacientes.svelte', 'utf8'));
  assert.match(pac, /\{#if centroElegido && puedeGestionar\}[\s\S]*?<AceptarTodoCentro/);
  const todo = quitar(readFileSync('src/interfaz/pantallas/paciente/AceptarTodoCentro.svelte', 'utf8'));
  assert.match(todo, /simular: true/);
  assert.match(todo, /motivoValido/);
  assert.match(todo, /disabled=\{!puedeConfirmar\}/);
  const aj = quitar(readFileSync('src/interfaz/pantallas/Ajustes.svelte', 'utf8'));
  assert.match(aj, /la farmacia asume la responsabilidad de gestionarlos fuera del programa/);
  assert.match(aj, /exigirConsentimientos: valor, motivo/);
});
