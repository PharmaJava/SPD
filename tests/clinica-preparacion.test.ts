/**
 * Servicios de preparación (clinica-preparacion.ts) contra una base real en memoria.
 * Los datos clínicos se insertan con SQL directo: no dependen de los demás servicios.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import type { ContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaPreparacion } from '../src/servicios/clinica-preparacion.ts';
import type { RolUsuario, Resultado } from '../src/servicios/api.ts';

const DESDE = '2026-11-03';            // martes; hoy = 2026-11-02 (reloj de pruebas)
const PARAMS = { pacienteId: 1, desde: DESDE, dias: 7, fechaPreparacion: '2026-11-02' };

interface Montaje { t: ContextoPruebas; api: ReturnType<typeof crearClinicaPreparacion>; uid: (rol: RolUsuario) => number }

const ok = <T>(r: Resultado<T>): T => { assert.equal(r.ok, true, r.ok ? '' : `${r.error} [${r.codigo}]`); return (r as { ok: true; datos: T }).datos; };
const ko = <T>(r: Resultado<T>): { error: string; codigo?: string } => { assert.equal(r.ok, false, 'se esperaba un fallo'); return r as { ok: false; error: string; codigo?: string }; };

function pauta(m: Montaje, tratamientoId: number, dosis: [number, number][], o: { version?: number; desde?: string; hasta?: string | null; patron?: string; diasSemana?: string | null } = {}): number {
  const id = m.t.db.run(
    `INSERT INTO pauta_version(tratamiento_id, version, vigente_desde, vigente_hasta, patron, dias_semana, origen, creado_por) VALUES (?,?,?,?,?,?, 'receta', ?)`,
    [tratamientoId, o.version ?? 1, o.desde ?? '2026-01-01', o.hasta ?? null, o.patron ?? 'diario', o.diasSemana ?? null, m.uid('farmaceutico')]).ultimoId;
  for (const [momento, unidades] of dosis) m.t.db.run('INSERT INTO pauta_dosis(pauta_version_id, momento_id, unidades) VALUES (?,?,?)', [id, momento, unidades]);
  return id;
}

function envase(m: Montaje, o: { cn: string; tratamientoId: number | null; lote?: string; caducidad?: string; unidades?: number }): number {
  const u = o.unidades ?? 28;
  return m.t.db.run(
    `INSERT INTO envase(paciente_id, tratamiento_id, cn, lote, caducidad, origen_lectura, unidades_inicio, unidades_restantes, recibido_por) VALUES (1,?,?,?,?, 'manual', ?, ?, ?)`,
    [o.tratamientoId, o.cn, o.lote ?? 'L1', o.caducidad ?? '2028-05-31', u, u, m.uid('farmaceutico')]).ultimoId;
}

async function firmar(m: Montaje): Promise<void> {
  ok(await m.api.listarPlantillasDocumento());
  for (const codigo of ['consentimiento_spd', 'info_rgpd']) {
    const p = m.t.db.get<{ id: number }>('SELECT id FROM plantilla_documento WHERE codigo = ? AND vigente = 1', [codigo])!;
    m.t.db.run(`INSERT INTO documento_firmado(id_publico, paciente_id, plantilla_id, firmante, firmante_calidad, firmado_en, texto_impreso, hash_texto, registrado_por)
                VALUES (?,1,?, 'Ana López Pérez','paciente','2026-10-01T10:00:00Z','x','h',?)`, [`doc-${codigo}`, p.id, m.uid('farmaceutico')]);
  }
}

/** Paciente 1; metformina (trat. 1: desayuno+cena, caja de 28) y enalapril (trat. 2: desayuno, caja de 30, descripción CONFIRMADA). */
async function montar(rol: RolUsuario | null = 'farmaceutico', o: { consentimientos?: boolean } = {}): Promise<Montaje> {
  const t = await crearContextoPruebas(rol);
  const api = crearClinicaPreparacion(t.ctx);
  const ids = new Map<string, number>(t.db.all<{ id: number; rol: string }>('SELECT id, rol FROM usuario').map((u) => [u.rol, u.id]));
  const m: Montaje = { t, api, uid: (r) => ids.get(r)! };
  const db = t.db;
  db.run("UPDATE farmacia SET telefono='955 000 000', direccion='Calle Sol 1', municipio='Sevilla', nif='B12345678', email='f@farmacia.test', rgpd_dpd='No designado' WHERE id=1");
  db.run("INSERT INTO paciente(id, id_publico, nombre, apellido1, apellido2, dni_nie, fecha_nacimiento, direccion, codigo_postal, municipio) VALUES (1,'aaaaaaaa-1111-4111-8111-111111111111','Ana','López','Pérez','12345678Z','1940-03-04','Calle Luna 5','41001','Sevilla')");
  db.run("INSERT INTO medicamento(cn,nombre,descripcion_estado) VALUES ('654321','Metformina Test 850 mg 28 comp','sin_datos')");
  db.run("INSERT INTO medicamento(cn,nombre,descripcion_fisica,marcas_grabado,descripcion_estado,descripcion_confirmada_por) VALUES ('123456','Enalapril Test 10 mg 30 comp','comprimido blanco, redondo, ranurado','E10','confirmada',?)", [m.uid('farmaceutico')]);
  db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, cn_preferente, emblistable) VALUES (1,1,'Metformina','850 mg','654321',1)");
  db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, cn_preferente, emblistable) VALUES (2,1,'Enalapril','10 mg','123456',1)");
  pauta(m, 1, [[1, 1], [3, 1]]);
  pauta(m, 2, [[1, 1]]);
  envase(m, { cn: '654321', tratamientoId: 1, lote: 'MET1', unidades: 28 });
  envase(m, { cn: '123456', tratamientoId: 2, lote: 'ENA1', caducidad: '2027-12-31', unidades: 30 });
  if (o.consentimientos !== false) await firmar(m);
  return m;
}

const usar = (m: Montaje, rol: RolUsuario) => { m.t.cambiarUsuario(rol); };
const prep = async (m: Montaje, extra: Record<string, unknown> = {}) => ok(await m.api.crearPreparacion({ ...PARAMS, ...extra }));
async function preparada(m: Montaje, extra: Record<string, unknown> = {}) { const b = await prep(m, extra); return ok(await m.api.marcarPreparada(b.id)); }
async function validada(m: Montaje) { const p = await preparada(m); return ok(await m.api.validarPreparacion(p.id)); }
const restantes = (m: Montaje, id: number) => m.t.db.get<{ unidades_restantes: number; estado: string }>('SELECT unidades_restantes, estado FROM envase WHERE id = ?', [id])!;
const cuenta = (m: Montaje, tabla: string) => m.t.db.get<{ n: number }>(`SELECT count(*) AS n FROM ${tabla}`)!.n;

// ───────────────────────── evaluación ─────────────────────────

test('evaluar: sin bloqueos, unidades y nombre del paciente', async () => {
  const m = await montar();
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.deepEqual(e.bloqueos, []);
  assert.equal(e.validable, true);
  assert.equal(e.unidadesEsperadas, 21);
  assert.equal(e.unidadesAsignadas, 21);
  assert.equal(e.paciente.nombreCompleto, 'Ana López Pérez');
  assert.equal(e.caducidadSpd?.caducidadSpd, '2026-11-16');
});

test('evaluar: leyenda con letra, color de la paleta y abreviatura distintos', async () => {
  const m = await montar();
  const l = ok(await m.api.evaluarPreparacion(PARAMS)).leyenda;
  assert.deepEqual(l.map((x) => x.letra), ['A', 'B']);
  assert.deepEqual(l.map((x) => x.color), ['var(--med-1)', 'var(--med-2)']);
  assert.deepEqual(l.map((x) => x.abreviatura), ['METF', 'ENAL']);
  assert.equal(l[0].nombre, 'Metformina 850 mg');
});

test('evaluar: la descripción física sólo sale si está CONFIRMADA', async () => {
  const m = await montar();
  const l = ok(await m.api.evaluarPreparacion(PARAMS)).leyenda;
  assert.equal(l[0].descripcion, undefined);
  assert.match(l[1].descripcion ?? '', /Comprimido blanco/);
  assert.match(l[1].descripcion ?? '', /E10/);
  m.t.db.run("UPDATE medicamento SET descripcion_estado='propuesta' WHERE cn='123456'");
  assert.equal(ok(await m.api.evaluarPreparacion(PARAMS)).leyenda[1].descripcion, undefined);
});

test('evaluar: alvéolos resueltos con caja y lote', async () => {
  const m = await montar();
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.equal(e.alveolos.length, e.mapas.length * 7 * 4);
  const celdas = e.alveolos.filter((a) => a.fecha === DESDE && a.momentoId === 1);
  assert.equal(celdas.length, 1);
  assert.deepEqual(celdas[0].contenido.map((c) => [c.tratamientoId, c.unidades, c.lote]), [[1, 1, 'MET1'], [2, 1, 'ENA1']]);
  assert.ok(celdas[0].contenido.every((c) => typeof c.envaseId === 'number'));
});

test('evaluar: con unidades insuficientes la toma sale SIN caja y bloquea', async () => {
  const m = await montar();
  m.t.db.run('UPDATE envase SET unidades_restantes = 10 WHERE id = 1');
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.equal(e.validable, false);
  assert.ok(e.bloqueos.some((b) => b.codigo === 'UNIDADES_INSUFICIENTES'));
  const sinCaja = e.alveolos.flatMap((a) => a.contenido).filter((c) => c.envaseId === undefined);
  assert.equal(sinCaja.length, 4);
});

test('evaluar no escribe nada (ni auditoría)', async () => {
  const m = await montar();
  const antes = [cuenta(m, 'preparacion'), cuenta(m, 'auditoria'), m.t.persistencias()];
  await m.api.evaluarPreparacion(PARAMS);
  assert.deepEqual([cuenta(m, 'preparacion'), cuenta(m, 'auditoria'), m.t.persistencias()], antes);
});

test('evaluar: sin sesión falla; paciente inexistente falla; nunca lanza', async () => {
  const m = await montar();
  m.t.cambiarUsuario(null);
  assert.equal(ko(await m.api.evaluarPreparacion(PARAMS)).codigo, 'SIN_SESION');
  usar(m, 'farmaceutico');
  assert.equal(ko(await m.api.evaluarPreparacion({ ...PARAMS, pacienteId: 99 })).codigo, 'NO_ENCONTRADO');
  ko(await m.api.evaluarPreparacion(undefined as never));
  const raro = ok(await m.api.evaluarPreparacion({ ...PARAMS, desde: 'ayer', dias: -3 }));
  assert.equal(raro.validable, false);
});

test('evaluar: un técnico ve el bloqueo de rol; sin consentimiento, el de consentimiento', async () => {
  const m = await montar('tecnico', { consentimientos: false });
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  const codigos = e.bloqueos.map((b) => b.codigo);
  assert.ok(codigos.includes('ROL_NO_PUEDE_VALIDAR'));
  assert.ok(codigos.includes('CONSENTIMIENTO_NO_VIGENTE'));
});

test('evaluar: una caja sin tratamiento no se usa y se avisa', async () => {
  const m = await montar();
  envase(m, { cn: '654321', tratamientoId: null, lote: 'HUERFANA', caducidad: '2026-11-04' });
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.ok(e.avisos.some((a) => /no está asignada a ningún tratamiento/.test(a.texto)));
  assert.ok(e.lineasReparto.every((l) => l.lote !== 'HUERFANA'));
});

test('evaluar: medicación no emblistable va «aparte» con el texto del farmacéutico', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, emblistable, nota_farmaceutico, motivo_no_emblistable) VALUES (3,1,'Warfarina','5 mg',0,'Tomar siempre a la misma hora','sensible a la luz')");
  pauta(m, 3, [[3, 1]]);
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.deepEqual(e.aparte.map((a) => a.nombre), ['Warfarina 5 mg']);
  assert.equal(e.unidadesEsperadas, 21);
  const b = await prep(m);
  const txt = m.t.db.get<{ texto: string }>('SELECT texto FROM preparacion_aparte WHERE preparacion_id = ?', [b.id])!.texto;
  assert.match(txt, /Warfarina 5 mg: 1 cena, a diario/);
  assert.match(txt, /misma hora/);
});

test('evaluar: tratamiento finalizado no entra; paciente de baja bloquea; sin pauta bloquea', async () => {
  const m = await montar();
  m.t.db.run("UPDATE tratamiento SET finalizado_en='2026-10-30' WHERE id=2");
  assert.equal(ok(await m.api.evaluarPreparacion(PARAMS)).unidadesEsperadas, 14);
  m.t.db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, emblistable) VALUES (4,1,'Sinpauta',1)");
  assert.ok(ok(await m.api.evaluarPreparacion(PARAMS)).bloqueos.some((b) => b.codigo === 'PAUTA_INVALIDA' && /Sinpauta/.test(b.texto)));
  m.t.db.run("UPDATE paciente SET estado='baja' WHERE id=1");
  assert.ok(ok(await m.api.evaluarPreparacion(PARAMS)).bloqueos.some((b) => /baja/.test(b.texto)));
});

test('evaluar: pauta mal configurada bloquea (días de la semana vacíos)', async () => {
  const m = await montar();
  m.t.db.run('DELETE FROM pauta_dosis WHERE pauta_version_id IN (SELECT id FROM pauta_version WHERE tratamiento_id = 2)');
  m.t.db.run('DELETE FROM pauta_version WHERE tratamiento_id = 2');
  pauta(m, 2, [[1, 1]], { patron: 'dias_semana', diasSemana: '' });
  assert.ok(ok(await m.api.evaluarPreparacion(PARAMS)).bloqueos.some((b) => b.codigo === 'PAUTA_INVALIDA'));
});

test('evaluar: una caja que caduca antes del fin del periodo no se usa', async () => {
  const m = await montar();
  m.t.db.run("UPDATE envase SET caducidad='2026-11-05' WHERE id=1");
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.equal(e.validable, false);
  assert.ok(e.avisos.some((a) => a.codigo === 'CAJA_EXCLUIDA_POR_CADUCIDAD'));
});

test('evaluar: ajustes de validez y de disposición', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO ajuste(clave,valor) VALUES ('dias_validez_spd','10')");
  assert.equal(ok(await m.api.evaluarPreparacion(PARAMS)).caducidadSpd?.caducidadSpd, '2026-11-12');
  const e20 = ok(await m.api.evaluarPreparacion({ ...PARAMS, diasValidez: 20, justificacion: 'Residencia lejana, entrega quincenal' }));
  assert.ok(e20.bloqueos.some((b) => b.codigo === 'VALIDEZ_EXTENDIDA_NO_ACTIVADA'));
  m.t.db.run("INSERT INTO ajuste(clave,valor) VALUES ('validez_extendida_permitida','true')");
  const ok20 = ok(await m.api.evaluarPreparacion({ ...PARAMS, diasValidez: 20, justificacion: 'Residencia lejana, entrega quincenal' }));
  assert.equal(ok20.validable, true);
  assert.equal(ok20.caducidadSpd?.fueraDeEstandar, true);
  m.t.db.run("INSERT INTO ajuste(clave,valor) VALUES ('inicioDia','cronologico')");
  assert.equal(ok(await m.api.evaluarPreparacion(PARAMS)).mapas[0].filas[0].fecha, DESDE);
});

test('evaluar: una alerta de calidad excluye la caja afectada', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO alerta_calidad(referencia, cn, lote) VALUES ('R_21/2026','654321','MET1')");
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.equal(e.validable, false);
  assert.ok(e.avisos.some((a) => /alerta de calidad/.test(a.texto)));
});

// ───────────────────────── borrador ─────────────────────────

test('crear: guarda un borrador con líneas y SIN descontar unidades', async () => {
  const m = await montar();
  const b = await prep(m);
  assert.equal(b.estado, 'borrador');
  assert.match(b.idPublico, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(b.pacienteNombre, 'Ana López Pérez');
  assert.equal(b.fechaFin, '2026-11-09');
  assert.equal(b.caducidadSpd, '2026-11-16');
  assert.equal(cuenta(m, 'preparacion_linea'), 21);
  assert.equal(restantes(m, 1).unidades_restantes, 28);
  assert.equal(restantes(m, 2).unidades_restantes, 30);
  assert.ok(m.t.auditadas.some((a) => a.accion === 'crear' && a.entidad === 'preparacion'));
  assert.ok(m.t.persistencias() > 0);
});

test('crear: con bloqueos de datos no guarda nada', async () => {
  const m = await montar();
  m.t.db.run('UPDATE envase SET unidades_restantes = 3 WHERE id = 1');
  const f = ko(await m.api.crearPreparacion(PARAMS));
  assert.equal(f.codigo, 'BLOQUEOS');
  assert.match(f.error, /faltan/);
  assert.equal(cuenta(m, 'preparacion'), 0);
});

test('crear: el rol y el consentimiento no impiden el borrador (se exigen al validar)', async () => {
  const m = await montar('tecnico', { consentimientos: false });
  assert.equal((await prep(m)).estado, 'borrador');
});

test('crear: un administrativo no prepara', async () => {
  const m = await montar('administrativo');
  assert.equal(ko(await m.api.crearPreparacion(PARAMS)).codigo, 'PERMISO');
  assert.equal(ko(await m.api.marcarPreparada(1)).codigo, 'PERMISO');
  assert.equal(ko(await m.api.anularPreparacion(1, 'por probar')).codigo, 'PERMISO');
});

test('crear: temperatura y humedad fuera de rango dejan nota; valores absurdos fallan', async () => {
  const m = await montar();
  const b = await prep(m, { temperatura: 28, humedad: 70, observaciones: 'Sala B' });
  assert.match(b.observaciones ?? '', /Sala B/);
  assert.match(b.observaciones ?? '', /temperatura de la sala fuera de 15-25/);
  assert.match(b.observaciones ?? '', /humedad de la sala fuera de 40-60/);
  assert.equal(b.temperatura, 28);
  ko(await m.api.crearPreparacion({ ...PARAMS, humedad: 500 }));
  ko(await m.api.crearPreparacion({ ...PARAMS, temperatura: '20' as never }));
});

test('crear: validez extendida queda marcada con su justificación', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO ajuste(clave,valor) VALUES ('validez_extendida_permitida','1')");
  const b = await prep(m, { diasValidez: 20, justificacion: 'Entrega quincenal a residencia' });
  assert.equal(b.fueraDeEstandar, true);
  assert.equal(b.validezDias, 20);
  assert.match(b.justificacionValidez ?? '', /quincenal/);
});

test('solape: no se prepara dos veces el mismo periodo; dos borradores sí', async () => {
  const m = await montar();
  const a = await prep(m);
  await prep(m);                                 // dos borradores no se pisan
  ok(await m.api.marcarPreparada(a.id));
  assert.equal(ko(await m.api.crearPreparacion(PARAMS)).codigo, 'PERIODO_SOLAPADO');
  const siguiente = ok(await m.api.crearPreparacion({ ...PARAMS, desde: '2026-11-10' }));
  assert.equal(siguiente.estado, 'borrador');
});

// ───────────────────────── preparada ─────────────────────────

test('marcarPreparada: pone quién y cuándo; sólo desde borrador', async () => {
  const m = await montar('tecnico');
  const p = await preparada(m);
  assert.equal(p.estado, 'preparado');
  assert.equal(p.preparadoPor, 'Técnico Prueba');
  assert.equal(p.preparadoEn, '2026-11-02T09:00:00Z');
  assert.equal(ko(await m.api.marcarPreparada(p.id)).codigo, 'ESTADO');
  assert.equal(cuenta(m, 'preparacion_linea'), 21);
});

test('marcarPreparada: recalcula la caducidad con la fecha real de preparación', async () => {
  const m = await montar();
  const b = await prep(m);                       // se crea el 2-nov
  m.t.reloj.fecha = new Date('2026-11-03T09:00:00Z');
  const p = ok(await m.api.marcarPreparada(b.id));
  assert.equal(p.caducidadSpd, '2026-11-17');
});

test('marcarPreparada: pasado el primer día de administración no se puede', async () => {
  const m = await montar();
  const b = await prep(m);
  m.t.reloj.fecha = new Date('2026-11-05T09:00:00Z');
  assert.match(ko(await m.api.marcarPreparada(b.id)).error, /posterior al primer día/);
});

test('marcarPreparada: si desde el borrador cambió el stock, no avanza', async () => {
  const m = await montar();
  const b = await prep(m);
  m.t.db.run("UPDATE envase SET estado='retirado' WHERE id=1");
  assert.equal(ko(await m.api.marcarPreparada(b.id)).codigo, 'BLOQUEOS');
  assert.equal(ok(await m.api.obtenerPreparacion(b.id)).preparacion.estado, 'borrador');
});

// ───────────────────────── validar ─────────────────────────

test('ciclo completo: borrador → preparado → validado → entregado', async () => {
  const m = await montar();
  const b = await prep(m);
  const p = ok(await m.api.marcarPreparada(b.id));
  const v = ok(await m.api.validarPreparacion(p.id));
  assert.equal(v.estado, 'validado');
  assert.equal(v.validadoPor, 'Farma Prueba');
  assert.equal(v.validadoEn, '2026-11-02T09:00:00Z');
  const e = ok(await m.api.registrarEntrega(v.id, { entregadoA: 'Ana López Pérez', observaciones: 'Con prospectos' }));
  assert.equal(e.estado, 'entregado');
  const fila = m.t.db.get<{ entregado_a: string; entregado_por: number; observaciones: string }>('SELECT * FROM entrega WHERE preparacion_id = ?', [b.id])!;
  assert.equal(fila.entregado_a, 'Ana López Pérez');
  assert.equal(fila.entregado_por, m.uid('farmaceutico'));
});

test('validar: descuenta las unidades de las cajas', async () => {
  const m = await montar();
  await validada(m);
  assert.equal(restantes(m, 1).unidades_restantes, 14);
  assert.equal(restantes(m, 2).unidades_restantes, 23);
  assert.equal(restantes(m, 1).estado, 'en_uso');
});

test('validar: la caja que llega a 0 queda agotada y cerrada', async () => {
  const m = await montar();
  m.t.db.run('UPDATE envase SET unidades_inicio = 14, unidades_restantes = 14 WHERE id = 1');
  await validada(m);
  const c = m.t.db.get<{ unidades_restantes: number; estado: string; cerrado_en: string; motivo_cierre: string }>('SELECT * FROM envase WHERE id = 1')!;
  assert.equal(c.unidades_restantes, 0);
  assert.equal(c.estado, 'agotado');
  assert.equal(c.cerrado_en, '2026-11-02T09:00:00Z');
  assert.match(c.motivo_cierre, /Agotado/);
});

test('validar: un técnico y un administrativo no validan; nada cambia', async () => {
  const m = await montar('tecnico');
  const p = await preparada(m);
  assert.equal(ko(await m.api.validarPreparacion(p.id)).codigo, 'ROL_NO_PUEDE_VALIDAR');
  usar(m, 'administrativo');
  assert.equal(ko(await m.api.validarPreparacion(p.id)).codigo, 'ROL_NO_PUEDE_VALIDAR');
  assert.equal(restantes(m, 1).unidades_restantes, 28);
  assert.equal(ok(await m.api.obtenerPreparacion(p.id)).preparacion.estado, 'preparado');
});

test('validar: el titular también puede, y otra persona no deja nota de «mismo usuario»', async () => {
  const m = await montar('tecnico');
  const p = await preparada(m);
  usar(m, 'titular');
  ok(await m.api.validarPreparacion(p.id));
  const val = m.t.auditadas.find((a) => a.accion === 'validar')!;
  assert.equal(val.motivo ?? null, null);
});

test('validar: sin consentimiento no se valida', async () => {
  const m = await montar('farmaceutico', { consentimientos: false });
  const p = await preparada(m);
  const f = ko(await m.api.validarPreparacion(p.id));
  assert.equal(f.codigo, 'BLOQUEOS');
  assert.match(f.error, /consentimientos/i);
  assert.equal(restantes(m, 1).unidades_restantes, 28);
});

test('validar: un consentimiento revocado después de preparar frena la validación', async () => {
  const m = await montar();
  const p = await preparada(m);
  const doc = ok(await m.api.estadoConsentimientos(1)).firmados[0];
  m.t.db.run("UPDATE documento_firmado SET revocado_en='2026-11-02T09:30:00Z', motivo_revocacion='baja' WHERE firmante='Ana López Pérez' AND plantilla_id = (SELECT id FROM plantilla_documento WHERE codigo = ?)", [doc.codigo]);
  assert.match(ko(await m.api.validarPreparacion(p.id)).error, /revocados/);
});

test('validar: un consentimiento desactualizado (plantilla nueva) frena la validación', async () => {
  const m = await montar();
  const p = await preparada(m);
  m.t.db.run("INSERT INTO plantilla_documento(codigo, version, titulo, cuerpo, vigente) VALUES ('consentimiento_spd', 2, 'Nuevo', 'texto', 1)");
  assert.match(ko(await m.api.validarPreparacion(p.id)).error, /desactualizados/);
  assert.deepEqual(ok(await m.api.estadoConsentimientos(1)).desactualizados, ['consentimiento_spd']);
});

test('validar: el farmacéutico que preparó puede validar, y queda anotado', async () => {
  const m = await montar();
  const p = await preparada(m);
  ok(await m.api.validarPreparacion(p.id));
  const val = m.t.auditadas.find((a) => a.accion === 'validar')!;
  assert.match(val.motivo ?? '', /mismo usuario/);
  assert.ok(m.t.auditadas.some((a) => a.accion === 'modificar' && a.entidad === 'envase'));
});

test('validar: sólo se valida lo «preparado»', async () => {
  const m = await montar();
  const b = await prep(m);
  assert.equal(ko(await m.api.validarPreparacion(b.id)).codigo, 'ESTADO');
  ko(await m.api.validarPreparacion(999));
  ko(await m.api.validarPreparacion('x' as never));
});

test('validar: dos validaciones a la vez → la segunda falla y se descuenta una sola vez', async () => {
  const m = await montar();
  const p = await preparada(m);
  const [a, b] = await Promise.all([m.api.validarPreparacion(p.id), m.api.validarPreparacion(p.id)]);
  assert.equal([a, b].filter((r) => r.ok).length, 1);
  assert.equal(restantes(m, 1).unidades_restantes, 14);
  assert.equal(restantes(m, 2).unidades_restantes, 23);
});

test('validar: si la pauta cambió después de preparar, el blíster ya no vale', async () => {
  const m = await montar();
  const p = await preparada(m);
  pauta(m, 1, [[1, 1], [2, 1], [3, 1]], { version: 2, desde: '2026-11-01' });
  const f = ko(await m.api.validarPreparacion(p.id));
  assert.ok(['PREPARACION_DESACTUALIZADA', 'BLOQUEOS'].includes(f.codigo!), String(f.codigo));
  assert.equal(restantes(m, 1).unidades_restantes, 28);
  assert.equal(ok(await m.api.obtenerPreparacion(p.id)).preparacion.estado, 'preparado');
});

test('validar: una pauta nueva que no cambia el reparto sí se valida', async () => {
  const m = await montar();
  const p = await preparada(m);
  pauta(m, 1, [[1, 1], [3, 1]], { version: 2, desde: '2026-11-01' });
  assert.equal(ok(await m.api.validarPreparacion(p.id)).estado, 'validado');
});

test('validar: un cambio de pauta que deja el reparto con menos tomas se detecta como desactualizado', async () => {
  const m = await montar();
  const p = await preparada(m);
  pauta(m, 1, [[1, 1]], { version: 2, desde: '2026-11-01' });
  assert.equal(ko(await m.api.validarPreparacion(p.id)).codigo, 'PREPARACION_DESACTUALIZADA');
});

test('validar: una alerta de calidad posterior bloquea la validación', async () => {
  const m = await montar();
  const p = await preparada(m);
  m.t.db.run("INSERT INTO alerta_calidad(referencia, cn, lote) VALUES ('R_30/2026','654321','MET1')");
  const f = ko(await m.api.validarPreparacion(p.id));
  assert.equal(f.codigo, 'BLOQUEOS');
  assert.equal(restantes(m, 1).unidades_restantes, 28);
});

test('validar: una medicación nueva sin cajas bloquea', async () => {
  const m = await montar();
  const p = await preparada(m);
  m.t.db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, emblistable) VALUES (5,1,'Nuevo',1)");
  pauta(m, 5, [[2, 1]]);
  assert.equal(ko(await m.api.validarPreparacion(p.id)).codigo, 'BLOQUEOS');
});

test('validar: si la caja ya la consumió otra preparación, falla', async () => {
  const m = await montar();
  const p = await preparada(m);
  m.t.db.run('UPDATE envase SET unidades_restantes = 5 WHERE id = 1');
  assert.equal(ko(await m.api.validarPreparacion(p.id)).codigo, 'BLOQUEOS');
});

test('validar: paciente dado de baja tras preparar no se valida', async () => {
  const m = await montar();
  const p = await preparada(m);
  m.t.db.run("UPDATE paciente SET estado='fallecido' WHERE id=1");
  assert.match(ko(await m.api.validarPreparacion(p.id)).error, /fallecido/);
});

test('validar: es una transacción — si falla a mitad, no queda nada a medias', async () => {
  const m = await montar();
  const p = await preparada(m);
  m.t.db.exec("CREATE TRIGGER fallo_forzado BEFORE UPDATE ON envase WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'fallo forzado'); END;");
  ko(await m.api.validarPreparacion(p.id));
  assert.equal(restantes(m, 1).unidades_restantes, 28);
  assert.equal(restantes(m, 2).unidades_restantes, 30);
  assert.equal(ok(await m.api.obtenerPreparacion(p.id)).preparacion.estado, 'preparado');
  assert.equal(m.t.db.get<{ validado_por: number | null }>('SELECT validado_por FROM preparacion WHERE id = ?', [p.id])!.validado_por, null);
  m.t.db.exec('DROP TRIGGER fallo_forzado');
  assert.equal(ok(await m.api.validarPreparacion(p.id)).estado, 'validado');
});

test('validar: dos lotes en la misma toma se reparten y se descuentan por caja', async () => {
  const m = await montar();
  m.t.db.run('UPDATE envase SET unidades_restantes = 10, unidades_inicio = 10 WHERE id = 1');
  envase(m, { cn: '654321', tratamientoId: 1, lote: 'MET2', caducidad: '2029-01-31', unidades: 28 });
  await validada(m);
  assert.deepEqual([restantes(m, 1).unidades_restantes, restantes(m, 3).unidades_restantes], [0, 24]);
  assert.equal(restantes(m, 1).estado, 'agotado');
});

test('la auditoría registra crear, preparar, validar, entregar y queda encadenada', async () => {
  const m = await montar();
  const v = await validada(m);
  ok(await m.api.registrarEntrega(v.id, { entregadoA: 'Ana' }));
  const acciones = m.t.auditadas.filter((a) => a.entidad === 'preparacion').map((a) => a.accion);
  assert.deepEqual(acciones, ['crear', 'preparar', 'validar', 'entregar']);
  const filas = m.t.db.all<{ hash: string; hash_previo: string }>('SELECT hash, hash_previo FROM auditoria ORDER BY id');
  for (let i = 1; i < filas.length; i++) assert.equal(filas[i].hash_previo, filas[i - 1].hash);
});

// ───────────────────────── entrega ─────────────────────────

test('entrega: sólo si está validada, con destinatario, una sola vez', async () => {
  const m = await montar();
  const p = await preparada(m);
  assert.equal(ko(await m.api.registrarEntrega(p.id, { entregadoA: 'Ana' })).codigo, 'ESTADO');
  ok(await m.api.validarPreparacion(p.id));
  ko(await m.api.registrarEntrega(p.id, { entregadoA: '  ' }));
  ko(await m.api.registrarEntrega(p.id, undefined as never));
  ok(await m.api.registrarEntrega(p.id, { entregadoA: 'Ana' }));
  assert.equal(ko(await m.api.registrarEntrega(p.id, { entregadoA: 'Ana' })).codigo, 'ESTADO');
  assert.equal(cuenta(m, 'entrega'), 1);
});

test('entrega a un contacto: debe ser del paciente y estar autorizado', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO paciente(id,id_publico,nombre,apellido1) VALUES (2,'bbbbbbbb-2222-4222-8222-222222222222','Otro','Paciente')");
  m.t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre,autorizado_recoger) VALUES (1,1,'cuidador','Luis',0)");
  m.t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre,autorizado_recoger) VALUES (2,1,'cuidador','Marta',1)");
  m.t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre) VALUES (3,2,'cuidador','Ajeno')");
  m.t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre) VALUES (4,1,'representante_legal','Rep')");
  const v = await validada(m);
  assert.equal(ko(await m.api.registrarEntrega(v.id, { entregadoA: 'Luis', contactoId: 1 })).codigo, 'NO_AUTORIZADO');
  ko(await m.api.registrarEntrega(v.id, { entregadoA: 'Ajeno', contactoId: 3 }));
  ok(await m.api.registrarEntrega(v.id, { entregadoA: 'Marta', contactoId: 2 }));
  assert.equal(m.t.db.get<{ contacto_id: number }>('SELECT contacto_id FROM entrega')!.contacto_id, 2);
  const w = await (async () => { const b = await prep(m, { desde: '2026-11-10' }); return b; })();
  assert.ok(w.id);
});

test('entrega: un representante legal puede recoger aunque no tenga el marcador', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO contacto(id,paciente_id,tipo,nombre) VALUES (4,1,'representante_legal','Rep')");
  const v = await validada(m);
  assert.equal(ok(await m.api.registrarEntrega(v.id, { entregadoA: 'Rep', contactoId: 4 })).estado, 'entregado');
});

test('entrega: una alerta de calidad llegada tras validar la frena', async () => {
  const m = await montar();
  const v = await validada(m);
  m.t.db.run("INSERT INTO alerta_calidad(referencia, cn, lote) VALUES ('R_77/2026','123456','ENA1')");
  assert.equal(ko(await m.api.registrarEntrega(v.id, { entregadoA: 'Ana' })).codigo, 'ALERTA_CALIDAD');
  assert.equal(ok(await m.api.obtenerPreparacion(v.id)).preparacion.estado, 'validado');
});

// ───────────────────────── anulación ─────────────────────────

test('anular: exige motivo; un borrador no devuelve nada', async () => {
  const m = await montar();
  const b = await prep(m);
  ko(await m.api.anularPreparacion(b.id, 'x'));
  const a = ok(await m.api.anularPreparacion(b.id, 'Cambio de tratamiento'));
  assert.equal(a.estado, 'anulado');
  assert.equal(restantes(m, 1).unidades_restantes, 28);
  assert.equal(m.t.db.get<{ motivo_anulacion: string }>('SELECT motivo_anulacion FROM preparacion')!.motivo_anulacion, 'Cambio de tratamiento');
  assert.equal(ko(await m.api.anularPreparacion(b.id, 'otra vez más')).codigo, 'ESTADO');
});

test('anular una validada devuelve las unidades y reabre la caja agotada', async () => {
  const m = await montar();
  m.t.db.run('UPDATE envase SET unidades_inicio = 14, unidades_restantes = 14 WHERE id = 1');
  const v = await validada(m);
  assert.equal(restantes(m, 1).estado, 'agotado');
  const a = ok(await m.api.anularPreparacion(v.id, 'Error al preparar'));
  assert.equal(restantes(m, 1).unidades_restantes, 14);
  assert.equal(restantes(m, 1).estado, 'en_uso');
  assert.equal(restantes(m, 2).unidades_restantes, 30);
  assert.match(a.observaciones ?? '', /unidades devueltas/);
  assert.equal(m.t.db.get<{ cerrado_en: string | null }>('SELECT cerrado_en FROM envase WHERE id = 1')!.cerrado_en, null);
});

test('anular una entregada NO devuelve unidades y lo dice', async () => {
  const m = await montar();
  const v = await validada(m);
  ok(await m.api.registrarEntrega(v.id, { entregadoA: 'Ana' }));
  const a = ok(await m.api.anularPreparacion(v.id, 'Retirada por alerta'));
  assert.equal(restantes(m, 1).unidades_restantes, 14);
  assert.match(a.observaciones ?? '', /NO se devuelven/);
  assert.match(m.t.auditadas.find((x) => x.accion === 'anular')!.motivo ?? '', /NO devueltas/);
});

test('anular una validada: sólo farmacéutico o titular', async () => {
  const m = await montar();
  const v = await validada(m);
  usar(m, 'tecnico');
  assert.equal(ko(await m.api.anularPreparacion(v.id, 'Lo anulo yo')).codigo, 'PERMISO');
  assert.equal(restantes(m, 1).unidades_restantes, 14);
  const b = (usar(m, 'farmaceutico'), await prep(m, { desde: '2026-11-10' }));
  usar(m, 'tecnico');
  assert.equal(ok(await m.api.anularPreparacion(b.id, 'Un borrador sí')).estado, 'anulado');
});

test('anular: no devuelve más de lo que entró (datos incoherentes)', async () => {
  const m = await montar();
  const v = await validada(m);
  m.t.db.run('UPDATE envase SET unidades_restantes = 28 WHERE id = 1');
  assert.equal(ko(await m.api.anularPreparacion(v.id, 'Datos raros')).codigo, 'INCONSISTENCIA');
  assert.equal(ok(await m.api.obtenerPreparacion(v.id)).preparacion.estado, 'validado');
});

// ───────────────────────── consultas ─────────────────────────

test('listar: filtra por paciente y estado, más reciente primero', async () => {
  const m = await montar();
  const a = await prep(m);
  const b = await prep(m, { desde: '2026-11-10' });
  ok(await m.api.anularPreparacion(a.id, 'No hacía falta'));
  assert.deepEqual(ok(await m.api.listarPreparaciones()).map((p) => p.id), [b.id, a.id]);
  assert.deepEqual(ok(await m.api.listarPreparaciones({ estado: 'anulado' })).map((p) => p.id), [a.id]);
  assert.deepEqual(ok(await m.api.listarPreparaciones({ pacienteId: 99 })), []);
  assert.equal(ok(await m.api.listarPreparaciones({ estado: 'todas' })).length, 2);
  ko(await m.api.listarPreparaciones({ estado: 'raro' as never }));
});

test('obtener: en vivo mientras es borrador/preparado; instantánea cuando está validada', async () => {
  const m = await montar();
  const b = await prep(m);
  const vivo = ok(await m.api.obtenerPreparacion(b.id));
  assert.equal(vivo.evaluacion.validable, true);
  const p = ok(await m.api.marcarPreparada(b.id));
  ok(await m.api.validarPreparacion(p.id));
  const snap = ok(await m.api.obtenerPreparacion(b.id));
  assert.equal(snap.evaluacion.bloqueos.length, 0);          // aunque las cajas ya se descontaron
  assert.equal(snap.evaluacion.unidadesAsignadas, 21);
  assert.equal(snap.evaluacion.caducidadSpd?.caducidadSpd, snap.preparacion.caducidadSpd);
  assert.deepEqual(snap.evaluacion.leyenda.map((l) => l.letra), ['A', 'B']);
  assert.ok(snap.evaluacion.alveolos.some((a) => a.contenido.length > 0));
});

test('obtener: deja rastro de lectura; inexistente falla; sin sesión falla', async () => {
  const m = await montar();
  const b = await prep(m);
  ok(await m.api.obtenerPreparacion(b.id));
  assert.ok(m.t.auditadas.some((a) => a.accion === 'ver' && a.entidad === 'preparacion'));
  assert.equal(ko(await m.api.obtenerPreparacion(999)).codigo, 'NO_ENCONTRADO');
  m.t.cambiarUsuario(null);
  assert.equal(ko(await m.api.obtenerPreparacion(b.id)).codigo, 'SIN_SESION');
  assert.equal(ko(await m.api.listarPreparaciones()).codigo, 'SIN_SESION');
  assert.equal(ko(await m.api.crearPreparacion(PARAMS)).codigo, 'SIN_SESION');
});

// ───────────────────────── etiqueta y hoja ─────────────────────────

test('etiqueta: un borrador lleva marca «SIN VALIDAR» y no es imprimible', async () => {
  const m = await montar();
  const b = await prep(m);
  const v = ok(await m.api.vistaEtiqueta(b.id));
  assert.equal(v.imprimible, false);
  assert.match(v.html, /marca-agua">SIN VALIDAR/);
  assert.ok(v.problemas.some((p) => /SIN VALIDAR/.test(p)));
});

test('etiqueta validada: imprimible, con QR del id público y trazabilidad', async () => {
  const m = await montar();
  const val = await validada(m);
  const v = ok(await m.api.vistaEtiqueta(val.id));
  assert.equal(v.imprimible, true, v.problemas.join('; '));
  assert.deepEqual(v.faltan, []);
  assert.ok(v.html.includes(`data-codigo="${val.idPublico}"`));
  assert.ok(v.html.includes('data-simbologia="qrcode"'));
  assert.ok(!v.html.includes('marca-agua">'));
  assert.ok(v.html.includes('MET1') && v.html.includes('ENA1'));
  assert.ok(!/12345678Z/.test(v.html), 'el DNI no sale en la etiqueta ni en el QR');
  assert.match(v.html, /Prep\. FA \/ Val\. FA/);
});

test('etiqueta: sin lote en una caja, no es imprimible y lo dice', async () => {
  const m = await montar();
  const val = await validada(m);
  m.t.db.exec('PRAGMA ignore_check_constraints = ON');
  m.t.db.run("UPDATE envase SET lote = '' WHERE id = 1");
  m.t.db.exec('PRAGMA ignore_check_constraints = OFF');
  const v = ok(await m.api.vistaEtiqueta(val.id));
  assert.equal(v.imprimible, false);
  assert.ok(v.faltan.some((f) => /lote_caducidad/.test(f)));
  const h = ok(await m.api.vistaHojaPaciente(val.id));
  assert.equal(h.imprimible, false);
  assert.ok(h.faltan.some((f) => /lote/.test(f)));
});

test('etiqueta y hoja escapan el HTML de los datos', async () => {
  const m = await montar();
  m.t.db.run(`UPDATE paciente SET nombre = '<img src=x onerror=alert(1)>', apellido1 = 'O"Brien' WHERE id = 1`);
  m.t.db.run(`UPDATE tratamiento SET principio_activo = 'Metformina <b>', dosis_texto = '"850"' WHERE id = 1`);
  const val = await validada(m);
  for (const v of [ok(await m.api.vistaEtiqueta(val.id)), ok(await m.api.vistaHojaPaciente(val.id))]) {
    assert.ok(!v.html.includes('<img src=x'));
    assert.ok(!v.html.includes('Metformina <b>'));
    assert.ok(v.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(v.html.includes('O&quot;Brien'));
  }
});

test('etiqueta: sin teléfono de la farmacia no se bloquea; lleva la medicación aparte', async () => {
  const m = await montar();
  m.t.db.run("UPDATE farmacia SET telefono = NULL");
  m.t.db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, emblistable, nota_farmaceutico) VALUES (3,1,'Warfarina','5 mg',0,'Misma hora')");
  pauta(m, 3, [[3, 1]]);
  const val = await validada(m);
  const v = ok(await m.api.vistaEtiqueta(val.id));
  assert.equal(v.imprimible, true, v.problemas.join('; '));
  assert.match(v.html, /ADMINISTRAR APARTE: Warfarina 5 mg/);
});

test('etiqueta anulada: marca «ANULADA» y no se imprime', async () => {
  const m = await montar();
  const val = await validada(m);
  ok(await m.api.anularPreparacion(val.id, 'Error de lote'));
  const v = ok(await m.api.vistaEtiqueta(val.id));
  assert.equal(v.imprimible, false);
  assert.match(v.html, /marca-agua">ANULADA/);
});

test('etiqueta y hoja: una alerta posterior sobre una caja usada las hace no imprimibles', async () => {
  const m = await montar();
  const val = await validada(m);
  m.t.db.run("INSERT INTO alerta_calidad(referencia, lote) VALUES ('R_5/2026','ENA1')");
  const e = ok(await m.api.vistaEtiqueta(val.id));
  const h = ok(await m.api.vistaHojaPaciente(val.id));
  for (const v of [e, h]) { assert.equal(v.imprimible, false); assert.ok(v.problemas.some((p) => /R_5\/2026/.test(p))); }
});

test('etiqueta de 14 días: pasa a resumen por medicamento y sigue siendo imprimible', async () => {
  const m = await montar();
  m.t.db.run('UPDATE envase SET unidades_restantes = 60, unidades_inicio = 60 WHERE id IN (1,2)');
  const b = ok(await m.api.crearPreparacion({ ...PARAMS, dias: 14 }));
  const p = ok(await m.api.marcarPreparada(b.id));
  const val = ok(await m.api.validarPreparacion(p.id));
  const v = ok(await m.api.vistaEtiqueta(val.id));
  assert.match(v.html, /RESUMEN DEL PERIODO/);
  assert.equal(v.imprimible, true, v.problemas.join('; '));
});

test('hoja del paciente: mapa día × toma, descripción, lotes, caducidad y quién preparó/validó', async () => {
  const m = await montar('tecnico');
  const p = await preparada(m);
  usar(m, 'farmaceutico');
  const val = ok(await m.api.validarPreparacion(p.id));
  const h = ok(await m.api.vistaHojaPaciente(val.id));
  assert.equal(h.imprimible, true, h.problemas.join('; '));
  assert.match(h.html, /Plan de administración/);
  assert.match(h.html, /Martes 03\/11/);
  assert.match(h.html, /<b>A<\/b> ×1/);
  assert.match(h.html, /Comprimido blanco/);
  assert.match(h.html, /sin descripción física/);        // la metformina no tiene descripción confirmada
  assert.match(h.html, /Lote MET1 · cad\. 31\/05\/2028 · CN 654321/);
  assert.match(h.html, /Caduca el SPD:<\/b> 16\/11\/2026/);
  assert.match(h.html, /Preparado por:<\/b> Técnico Prueba \(TE\)/);
  assert.match(h.html, /Validado por:<\/b> Farma Prueba \(FA\)/);
  assert.ok(h.html.includes(`data-codigo="${val.idPublico}"`));
});

test('hoja del paciente: borrador con marca de agua; validez extendida con su aviso', async () => {
  const m = await montar();
  m.t.db.run("INSERT INTO ajuste(clave,valor) VALUES ('validez_extendida_permitida','1')");
  const b = await prep(m, { diasValidez: 20, justificacion: 'Entrega quincenal' });
  const h = ok(await m.api.vistaHojaPaciente(b.id));
  assert.equal(h.imprimible, false);
  assert.match(h.html, /marca-agua">SIN VALIDAR/);
  assert.match(h.html, /Validez de 20 días/);
});

test('cn: la leyenda lleva el CN preferente y cada línea el CN de la caja (vivo y guardado)', async () => {
  const m = await montar();
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.deepEqual(e.leyenda.map((l) => l.cn), ['654321', '123456']);
  assert.ok(e.lineasReparto.every((l) => (l as { cn?: string }).cn === (l.tratamientoId === 1 ? '654321' : '123456')));
  const v = await validada(m);
  const snap = ok(await m.api.obtenerPreparacion(v.id)).evaluacion;
  assert.deepEqual(snap.leyenda.map((l) => l.cn), ['654321', '123456']);
  assert.ok(snap.lineasReparto.every((l) => typeof (l as { cn?: string }).cn === 'string'));
});
