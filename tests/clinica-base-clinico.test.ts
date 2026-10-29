/**
 * Servicios clínicos base (parte 2): tratamientos, pautas, cobertura, envases,
 * alertas de calidad y panel «Hoy».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaBase } from '../src/servicios/clinica-base.ts';
import { diasCobertura } from '../src/servicios/clinica/cobertura.ts';
import { digitoControlGS1, GS } from '../src/dominio/gs1.ts';
import type { Resultado, RolUsuario, PautaDto } from '../src/servicios/api.ts';
import type { Db } from '../src/servicios/db.ts';

async function montar(rol: RolUsuario | null = 'farmaceutico') {
  const t = await crearContextoPruebas(rol);
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
const pac = (api: Api, extra: Record<string, unknown> = {}) =>
  bien(api.guardarPaciente({ nombre: 'Ana', apellido1: 'López', apellido2: 'Ruiz', necesitaBraille: false, letraGrande: false, ...extra }));
const med = (api: Api, extra: Record<string, unknown> = {}) =>
  bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina Cinfa 850 mg', principiosActivos: 'metformina 850 mg', formaFarmaceutica: 'COMPRIMIDO RECUBIERTO CON PELICULA', unidadesEnvase: 50, ...extra }));
const trat = (api: Api, pacienteId: number, extra: Record<string, unknown> = {}) =>
  bien(api.guardarTratamiento({ pacienteId, principioActivo: 'metformina', emblistable: true, ...extra }));
const pauta = (momentos: number[] = [1, 3], extra: Partial<PautaDto> = {}): PautaDto =>
  ({ vigenteDesde: '2026-11-01', patron: 'diario', origen: 'receta', dosis: momentos.map((m) => ({ momentoId: m, unidades: 1 })), ...extra });
const caja = (api: Api, pacienteId: number, extra: Record<string, unknown> = {}) =>
  api.registrarEnvase({ pacienteId, cn: '712729', lote: 'L1', caducidad: '2027-12-31', unidades: 30, ...extra } as never);
function consentir(db: Db, pid: number) {
  let pl = db.get<{ id: number }>("SELECT id FROM plantilla_documento WHERE codigo = 'consentimiento_spd'");
  if (!pl) pl = { id: db.run("INSERT INTO plantilla_documento(codigo,version,titulo,cuerpo) VALUES ('consentimiento_spd',1,'C','t')").ultimoId };
  db.run('INSERT INTO documento_firmado(id_publico,paciente_id,plantilla_id,firmante,firmante_calidad,firmado_en,texto_impreso,hash_texto,registrado_por) VALUES (?,?,?,?,?,?,?,?,?)',
    [randomUUID(), pid, pl.id, 'Ana', 'paciente', '2026-10-01T10:00:00Z', 't', 'h', 1]);
}
const n = (db: Db, sql: string) => db.get<{ n: number }>(sql)!.n;

/** Paciente con consentimiento, tratamiento de metformina 1+1 diario y su pauta. */
async function escenario(rol: RolUsuario = 'farmaceutico') {
  const m = await montar(rol);
  const p = await pac(m.api);
  consentir(m.db, p.id);
  await med(m.api);
  const t = await trat(m.api, p.id);
  await bien(m.api.guardarPauta(t.id, pauta([1, 3])));
  return { ...m, p, t, tc: m.t };
}

// ───────────────────────────── Tratamientos ─────────────────────────────

test('tratamiento: alta, validaciones y paciente inexistente', async () => {
  const { api } = await montar();
  const p = await pac(api);
  const t = await trat(api, p.id, { dosisTexto: '850 mg', indicacion: 'Diabetes' });
  assert.equal(t.pautaVigenteTexto, 'Sin pauta');
  assert.equal(t.emblistable, true);
  await mal(api.guardarTratamiento({ pacienteId: p.id, principioActivo: ' ', emblistable: true }), 'VALIDACION', /principio activo/);
  await mal(api.guardarTratamiento({ pacienteId: 999, principioActivo: 'x', emblistable: true }), 'NO_ENCONTRADO');
  await mal(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'x', emblistable: false }), 'VALIDACION', /motivo/);
  const ne = await bien(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'insulina', emblistable: false, motivoNoEmblistable: 'Inyectable' }));
  assert.equal(ne.motivoNoEmblistable, 'Inyectable');
  await mal(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'x', emblistable: true, cnPreferente: '999999' }), 'VALIDACION', /catálogo/);
  await mal(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'x', emblistable: true, cnPreferente: 'zz' }), 'VALIDACION', /CN/);
});

test('tratamiento: un medicamento NO APTO no se marca emblistable; modificar y no cambiar de paciente', async () => {
  const { api, db } = await montar();
  const p = await pac(api);
  const q = await pac(api, { nombre: 'Luis' });
  await med(api, { cn: '654321', nombre: 'Sintrom 4 mg', principiosActivos: 'acenocumarol', formaFarmaceutica: 'COMPRIMIDO' });
  await mal(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'acenocumarol', cnPreferente: '654321', emblistable: true }), 'VALIDACION', /NO APTO/);
  const ok = await bien(api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'acenocumarol', cnPreferente: '654321', emblistable: false, motivoNoEmblistable: 'Dosis según INR' }));
  assert.equal(ok.medicamento?.cn, '654321');
  const t2 = await bien(api.guardarTratamiento({ id: ok.id, pacienteId: p.id, principioActivo: 'acenocumarol', emblistable: false, motivoNoEmblistable: 'INR', notaFarmaceutico: 'Aparte' }));
  assert.equal(t2.notaFarmaceutico, 'Aparte');
  await mal(api.guardarTratamiento({ id: ok.id, pacienteId: q.id, principioActivo: 'x', emblistable: false, motivoNoEmblistable: 'y' }), 'VALIDACION', /otro paciente/);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE entidad = 'tratamiento' AND accion = 'modificar'"));
  await bien(api.darDeBajaPaciente(q.id, 'baja', 'baja'));
  await mal(api.guardarTratamiento({ pacienteId: q.id, principioActivo: 'x', emblistable: true }), 'VALIDACION', /baja/);
});

test('pauta v1: versión 1, texto legible «1 desayuno + 1 cena, a diario» y auditoría', async () => {
  const { api, db, t } = await escenario();
  const [tr] = await bien(api.listarTratamientos(t.pacienteId));
  assert.equal(tr.pautaVigenteTexto, '1 desayuno + 1 cena, a diario');
  assert.equal(tr.pautas.length, 1);
  assert.equal(tr.pautas[0].version, 1);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE entidad = 'pauta_version' AND accion = 'crear'"));
});

test('pauta v2: versión +1, cierra la anterior el día anterior y el historial queda intacto', async () => {
  const { api, db, t } = await escenario();
  const antes = db.all<Record<string, unknown>>('SELECT * FROM pauta_version ORDER BY id');
  const dosisAntes = db.all<Record<string, unknown>>('SELECT * FROM pauta_dosis ORDER BY pauta_version_id, momento_id');
  const r = await bien(api.guardarPauta(t.id, pauta([1, 2, 3], { vigenteDesde: '2026-11-10', origen: 'informe_medico', origenDetalle: 'Cardiología' })));
  assert.equal(r.pautas.length, 2);
  assert.equal(r.pautas[1].version, 2);
  assert.equal(r.pautas[0].vigenteHasta, '2026-11-09');
  assert.equal(r.pautaVigenteTexto, '1 desayuno + 1 cena, a diario', 'v1 sigue vigente hasta el 10');
  const despues = db.all<Record<string, unknown>>('SELECT * FROM pauta_version ORDER BY id');
  assert.equal(despues.length, 2);
  // Nada del historial cambia salvo vigente_hasta de la anterior.
  const { vigente_hasta: _a, ...resto1 } = antes[0] as Record<string, unknown>;
  const { vigente_hasta: _b, ...resto2 } = despues[0] as Record<string, unknown>;
  assert.deepEqual(resto2, resto1);
  assert.deepEqual(db.all('SELECT * FROM pauta_dosis WHERE pauta_version_id = ? ORDER BY momento_id', [antes[0].id as number]), dosisAntes.filter((d) => d.pauta_version_id === antes[0].id));
  assert.equal(n(db, "SELECT count(*) AS n FROM auditoria WHERE entidad = 'pauta_version'"), 3);
});

test('pauta: una versión nueva no puede empezar antes o el mismo día que otra existente', async () => {
  const { api, t } = await escenario();
  await mal(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-11-01' })), 'VALIDACION', /Ya existe una versión/);
  await mal(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-10-01' })), 'VALIDACION', /Ya existe una versión/);
});

test('pauta semanal: «lunes: 1 desayuno» y aviso de PAUTA SEMANAL en el DTO', async () => {
  const { api, t } = await escenario();
  const r = await bien(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-11-02', patron: 'dias_semana', diasSemana: [1] }))) as unknown as { pautaVigenteTexto: string; avisos: string[] };
  assert.equal(r.pautaVigenteTexto, 'lunes: 1 desayuno');
  assert.ok(r.avisos.some((a) => /PAUTA SEMANAL/.test(a)));
});

test('pauta: textos de varios días, cada N días, ciclo y fracciones', async () => {
  const { api, t, tc } = await escenario();
  const txt = async (extra: Partial<PautaDto>, desde: string) => {
    tc.reloj.fecha = new Date(desde + 'T09:00:00Z');
    const r = await bien(api.guardarPauta(t.id, { ...pauta([3]), vigenteDesde: desde, ...extra }));
    return r.pautaVigenteTexto;
  };
  assert.equal(await txt({ patron: 'dias_semana', diasSemana: [1, 3, 5] }, '2026-11-02'), 'lunes, miércoles y viernes: 1 cena');
  assert.equal(await txt({ patron: 'cada_n_dias', cadaNDias: 3 }, '2026-11-03'), '1 cena, cada 3 días');
  assert.equal(await txt({ patron: 'ciclo', cicloOn: 21, cicloOff: 7 }, '2026-11-04'), '1 cena, 21 días con toma y 7 de descanso');
  assert.equal(await txt({ dosis: [{ momentoId: 1, unidades: 0.5 }] }, '2026-11-05'), '0,5 desayuno, a diario');
});

test('pauta: los errores del dominio se devuelven con su texto y no se guarda nada', async () => {
  const { api, db, t } = await escenario();
  const antes = n(db, 'SELECT count(*) AS n FROM pauta_version');
  await mal(api.guardarPauta(t.id, pauta([], { vigenteDesde: '2026-12-01' })), 'VALIDACION', /no tiene dosis/);
  await mal(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-12-01', patron: 'dias_semana' })), 'VALIDACION', /diasSemana/);
  await mal(api.guardarPauta(t.id, { ...pauta([1], { vigenteDesde: '2026-12-01' }), dosis: [{ momentoId: 1, unidades: 0.3 }] }), 'VALIDACION', /0,25/);
  await mal(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-12-01', origen: 'inventado' as never })), 'VALIDACION', /origen/);
  await mal(api.guardarPauta(t.id, pauta([1], { vigenteDesde: 'ayer' })), 'VALIDACION', /fecha/);
  await mal(api.guardarPauta(t.id, pauta([99], { vigenteDesde: '2026-12-01' })), 'VALIDACION', /no existe/);
  await mal(api.guardarPauta(999, pauta()), 'NO_ENCONTRADO');
  assert.equal(n(db, 'SELECT count(*) AS n FROM pauta_version'), antes);
});

test('pauta: un cambio avisa de los blísteres ya preparados que cubren esas fechas', async () => {
  const { api, db, t, p } = await escenario();
  const v1 = db.get<{ id: number }>('SELECT id FROM pauta_version')!.id;
  await bien(caja(api, p.id));
  const envase = db.get<{ id: number }>('SELECT id FROM envase')!.id;
  const prep = db.run("INSERT INTO preparacion(id_publico,paciente_id,fecha_inicio,fecha_fin,caducidad_spd,validez_dias,estado) VALUES (?,?,?,?,?,14,'entregado')", [randomUUID(), p.id, '2026-11-02', '2026-11-08', '2026-11-16']).ultimoId;
  db.run('INSERT INTO preparacion_linea(preparacion_id,tratamiento_id,pauta_version_id,envase_id,fecha,momento_id,unidades) VALUES (?,?,?,?,?,?,1)', [prep, t.id, v1, envase, '2026-11-05', 1]);
  const r = await bien(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-11-05' }))) as unknown as { avisos: string[] };
  assert.ok(r.avisos.some((a) => /blíster/.test(a) && /entregado/.test(a)), JSON.stringify(r.avisos));
});

test('finalizar tratamiento: motivo obligatorio, no se repite, no admite pautas y se oculta por defecto', async () => {
  const { api, t, p, db } = await escenario();
  await mal(api.finalizarTratamiento(t.id, ' '), 'VALIDACION', /motivo/);
  const f = await bien(api.finalizarTratamiento(t.id, 'Suspendido por el médico'));
  assert.equal(f.motivoFin, 'Suspendido por el médico');
  assert.equal(f.finalizadoEn, '2026-11-02T09:00:00Z');
  assert.equal(f.coberturaDias, null);
  await mal(api.finalizarTratamiento(t.id, 'otra vez'), 'VALIDACION', /ya está finalizado/);
  await mal(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-12-01' })), 'VALIDACION', /finalizado/);
  assert.equal((await bien(api.listarTratamientos(p.id))).length, 0);
  assert.equal((await bien(api.listarTratamientos(p.id, true))).length, 1);
  assert.equal(n(db, 'SELECT count(*) AS n FROM tratamiento'), 1);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE accion = 'finalizar'"));
});

// ───────────────────────────── Cobertura ─────────────────────────────

test('cobertura: 30 unidades a 2 al día son 15 días; sin cajas 0; tras registrar la caja SUBE', async () => {
  const { api, p } = await escenario();
  let [tr] = await bien(api.listarTratamientos(p.id));
  assert.equal(tr.coberturaDias, 0);
  assert.equal((await bien(api.listarPacientes()))[0].coberturaDias, null);
  await bien(caja(api, p.id));
  [tr] = await bien(api.listarTratamientos(p.id));
  assert.equal(tr.coberturaDias, 15);
  assert.equal((await bien(api.listarPacientes()))[0].coberturaDias, 15);
  await bien(caja(api, p.id, { lote: 'L2' }));
  assert.equal((await bien(api.listarPacientes()))[0].coberturaDias, 30);
});

test('cobertura: una caja que caduca pronto sólo cuenta hasta su caducidad', async () => {
  const { api, p } = await escenario();
  await bien(caja(api, p.id, { caducidad: '2026-11-12', unidades: 100 }));   // hoy 2-nov: vale hasta el 12 (11 días)
  const [tr] = await bien(api.listarTratamientos(p.id));
  assert.equal(tr.coberturaDias, 11);
});

test('cobertura de un paciente = mínimo de sus tratamientos emblistables CON cajas', async () => {
  const { api, p } = await escenario();
  await med(api, { cn: '111111', nombre: 'Enalapril 10 mg', principiosActivos: 'enalapril' });
  const t2 = await trat(api, p.id, { principioActivo: 'enalapril' });
  await bien(api.guardarPauta(t2.id, pauta([1])));
  await bien(caja(api, p.id));                                              // metformina: 15 días
  await bien(api.registrarEnvase({ pacienteId: p.id, cn: '111111', lote: 'E1', caducidad: '2027-12-31', unidades: 28 }));  // enalapril: 28 días
  assert.equal((await bien(api.listarPacientes()))[0].coberturaDias, 15);
});

test('cobertura: pauta de días de la semana se simula por calendario', async () => {
  const { api, p, t } = await escenario();
  await bien(api.guardarPauta(t.id, pauta([1], { vigenteDesde: '2026-11-02', patron: 'dias_semana', diasSemana: [1] })));
  await bien(caja(api, p.id, { unidades: 3 }));          // 3 lunes: 2, 9 y 16 de noviembre
  const [tr] = await bien(api.listarTratamientos(p.id));
  assert.equal(tr.coberturaDias, 21);                     // lunes 2, 9 y 16 cubiertos; el lunes 23 (día 21) falta
});

test('la simulación día a día coincide con diasDeCobertura en una pauta diaria', () => {
  const envases = [
    { id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2026-11-20', unidadesRestantes: 10, estado: 'en_uso' as const },
    { id: 2, tratamientoId: 1, cn: '712729', lote: 'B', caducidad: '2027-06-30', unidadesRestantes: 21, estado: 'en_uso' as const },
  ];
  const diaria = [{ vigenteDesde: '2026-11-01', patron: 'diario' as const, dosis: [{ momentoId: 1, unidades: 1 }, { momentoId: 3, unidades: 0.5 }] }];
  // «ciclo» con 0 días de descanso fuerza la simulación con el mismo resultado que una pauta diaria.
  const ciclo = [{ ...diaria[0], patron: 'ciclo' as const, cicloOn: 5, cicloOff: 0 }];
  assert.equal(diasCobertura(ciclo, envases, '2026-11-02'), diasCobertura(diaria, envases, '2026-11-02'));
  assert.ok(diasCobertura(diaria, envases, '2026-11-02')! > 10);
});

// ───────────────────────────── Envases ─────────────────────────────

test('comprobar una entrada NO guarda nada y enseña bloqueos y avisos', async () => {
  const { api, db, p } = await escenario();
  const r = await bien(api.comprobarEntradaEnvase({ pacienteId: p.id, cn: '712729', lote: 'L1', caducidad: '12/2027', unidades: 30 }));
  assert.equal(r.ok, true);
  assert.equal(r.normalizado?.caducidad, '2027-12-31');
  assert.equal(r.medicamentoNombre, 'Metformina Cinfa 850 mg');
  assert.ok(r.atencion.some((a) => a.codigo === 'DESCRIPCION_SIN_CONFIRMAR'));
  assert.equal(n(db, 'SELECT count(*) AS n FROM envase'), 0);
  assert.equal(n(db, "SELECT count(*) AS n FROM auditoria WHERE entidad = 'envase'"), 0);
});

test('bloqueos: falta lote, falta caducidad, caducada, CN inválido, CN fuera del catálogo y unidades', async () => {
  const { api, p } = await escenario();
  const cod = async (e: Record<string, unknown>) => (await bien(api.comprobarEntradaEnvase({ pacienteId: p.id, cn: '712729', lote: 'L1', caducidad: '2027-12-31', unidades: 30, ...e } as never))).bloqueos.map((b) => b.codigo);
  assert.deepEqual(await cod({ lote: '' }), ['FALTA_LOTE']);
  assert.deepEqual(await cod({ caducidad: '' }), ['FALTA_CADUCIDAD']);
  assert.deepEqual(await cod({ caducidad: '2026-10-01' }), ['CADUCADO']);
  assert.ok((await cod({ cn: '12' })).includes('CN_INVALIDO'));
  assert.deepEqual(await cod({ cn: '999999' }), ['CN_NO_EN_CATALOGO']);
  assert.deepEqual(await cod({ unidades: 0 }), ['UNIDADES_INVALIDAS']);
  assert.deepEqual(await cod({ unidades: 1.1 }), ['UNIDADES_NO_MULTIPLO']);
  const sin = (await bien(api.comprobarEntradaEnvase({ pacienteId: p.id, cn: '999999', lote: 'L', caducidad: '2027-12-31', unidades: 1 }))).atencion;
  assert.ok(!sin.some((a) => a.codigo === 'CN_DESCONOCIDO'), 'no se duplica el aviso con el bloqueo');
});

test('registrar: guarda la caja en uso, asociada a su tratamiento, auditada y con quién la recibió', async () => {
  const { api, db, p, t, t: _t } = await escenario();
  const r = await bien(caja(api, p.id));
  assert.equal(r.ok, true);
  assert.ok(r.envaseId);
  const e = db.get<Record<string, unknown>>('SELECT * FROM envase')!;
  assert.equal(e.estado, 'en_uso');
  assert.equal(e.tratamiento_id, t.id);
  assert.equal(e.unidades_inicio, 30);
  assert.equal(e.unidades_restantes, 30);
  assert.equal(e.origen_lectura, 'manual');
  assert.ok(e.recibido_por);
  assert.ok(r.info.some((i) => i.codigo === 'TRATAMIENTO_ASOCIADO'));
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE entidad = 'envase' AND accion = 'crear'"));
  void _t;
});

test('registrar con bloqueos no guarda nada y devuelve ok:false (no es un fallo del servicio)', async () => {
  const { api, db, p } = await escenario();
  const r = await bien(caja(api, p.id, { lote: '' }));
  assert.equal(r.ok, false);
  assert.equal(r.envaseId, undefined);
  assert.equal(n(db, 'SELECT count(*) AS n FROM envase'), 0);
});

test('unidades por defecto: si faltan se toman del catálogo y se dice; sin dato bloquea', async () => {
  const { api, db, p } = await escenario();
  const r = await bien(api.registrarEnvase({ pacienteId: p.id, cn: '712729', lote: 'L1', caducidad: '2027-12-31' } as never));
  assert.equal(r.ok, true);
  assert.equal(r.normalizado?.unidades, 50);
  assert.ok(r.info.some((i) => i.codigo === 'UNIDADES_POR_DEFECTO'));
  assert.equal(db.get<{ u: number }>('SELECT unidades_inicio AS u FROM envase')!.u, 50);
  await med(api, { cn: '222222', nombre: 'Sin unidades', principiosActivos: 'x', unidadesEnvase: null });
  const s = await bien(api.registrarEnvase({ pacienteId: p.id, cn: '222222', lote: 'L1', caducidad: '2027-12-31' } as never));
  assert.equal(s.ok, false);
  assert.equal(s.bloqueos[0].codigo, 'UNIDADES_INVALIDAS');
});

test('número de serie repetido: bloqueo; el UNIQUE de la base lo respalda', async () => {
  const { api, db, p } = await escenario();
  assert.equal((await bien(caja(api, p.id, { numeroSerie: 'S1' }))).ok, true);
  const r = await bien(caja(api, p.id, { numeroSerie: 'S1', lote: 'L2' }));
  assert.equal(r.ok, false);
  assert.equal(r.bloqueos[0].codigo, 'SERIE_REPETIDA');
  assert.equal(n(db, 'SELECT count(*) AS n FROM envase'), 1);
  assert.throws(() => db.run("INSERT INTO envase(paciente_id,cn,lote,caducidad,numero_serie,origen_lectura,unidades_inicio,unidades_restantes,recibido_por) VALUES (?,?,?,?,?,?,?,?,?)", [p.id, '712729', 'X', '2027-01-01', 'S1', 'manual', 1, 1, 1]), /UNIQUE/);
});

test('DataMatrix real: se lee CN, lote, caducidad y serie; la caja queda como «datamatrix»', async () => {
  const { api, db, p } = await escenario();
  const g13 = '847000712729' + digitoControlGS1('847000712729');
  const lectura = `010${g13}17270430` + `10LOT123${GS}21SER99`;
  const r = await bien(api.registrarEnvase({ pacienteId: p.id, cn: '', lecturaDatamatrix: lectura, unidades: 30 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.normalizado?.cn, r.normalizado?.lote, r.normalizado?.caducidad, r.normalizado?.numeroSerie, r.normalizado?.origenLectura], ['712729', 'LOT123', '2027-04-30', 'SER99', 'datamatrix']);
  const e = db.get<Record<string, unknown>>('SELECT * FROM envase')!;
  assert.equal(e.gtin, '0' + g13);
  assert.equal(e.datamatrix_crudo, lectura);
});

test('asociación: con dos tratamientos posibles NO adivina (queda sin asociar y lo dice)', async () => {
  const { api, db, p } = await escenario();
  await trat(api, p.id, { principioActivo: 'Metformina 500 mg' });
  const r = await bien(caja(api, p.id));
  assert.equal(r.ok, true);
  assert.ok(r.info.some((i) => i.codigo === 'TRATAMIENTO_AMBIGUO'));
  assert.equal(db.get<{ t: number | null }>('SELECT tratamiento_id AS t FROM envase')!.t, null);
});

test('asociación: sin coincidencia queda sin asociar; una combinación no se asocia a un componente', async () => {
  const { api, db, p } = await escenario();
  await med(api, { cn: '333333', nombre: 'Tramadol/Paracetamol', principiosActivos: JSON.stringify([{ nombre: 'tramadol' }, { nombre: 'paracetamol' }]) });
  const t2 = await trat(api, p.id, { principioActivo: 'paracetamol' });
  void t2;
  const r = await bien(api.registrarEnvase({ pacienteId: p.id, cn: '333333', lote: 'Z', caducidad: '2027-12-31', unidades: 20 }));
  assert.ok(r.info.some((i) => i.codigo === 'TRATAMIENTO_NO_ASOCIADO'));
  assert.equal(db.get<{ t: number | null }>("SELECT tratamiento_id AS t FROM envase WHERE cn = '333333'")!.t, null);
});

test('asociación explícita: valida que el tratamiento sea del paciente y esté activo', async () => {
  const { api, p, t } = await escenario();
  const otro = await pac(api, { nombre: 'Luis' });
  await mal(caja(api, otro.id, { tratamientoId: t.id }), 'VALIDACION', /otro paciente/);
  await mal(caja(api, p.id, { tratamientoId: 999 }), 'VALIDACION', /no existe/);
  await bien(api.finalizarTratamiento(t.id, 'Fin'));
  await mal(caja(api, p.id, { tratamientoId: t.id }), 'VALIDACION', /finalizado/);
});

test('no se registran cajas de un paciente de baja o inexistente', async () => {
  const { api, p } = await escenario();
  await mal(caja(api, 999), 'NO_ENCONTRADO');
  await bien(api.darDeBajaPaciente(p.id, 'baja', 'baja'));
  await mal(caja(api, p.id), 'VALIDACION', /baja/);
});

test('cerrar un envase: motivo y estado válidos, una sola vez, auditado y deja de contar en la cobertura', async () => {
  const { api, db, p } = await escenario();
  const r = await bien(caja(api, p.id));
  await mal(api.cerrarEnvase(r.envaseId!, 'retirado', ' '), 'VALIDACION', /motivo/);
  await mal(api.cerrarEnvase(r.envaseId!, 'agotado' as never, 'x'), 'VALIDACION');
  await mal(api.cerrarEnvase(999, 'retirado', 'x'), 'NO_ENCONTRADO');
  const c = await bien(api.cerrarEnvase(r.envaseId!, 'devuelto', 'Devuelto al paciente'));
  assert.equal(c.estado, 'devuelto');
  assert.equal(db.get<{ m: string }>('SELECT motivo_cierre AS m FROM envase')!.m, 'Devuelto al paciente');
  await mal(api.cerrarEnvase(r.envaseId!, 'retirado', 'otra'), 'VALIDACION', /ya está cerrado/);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE entidad = 'envase' AND accion = 'cerrar'"));
  assert.equal((await bien(api.listarPacientes()))[0].coberturaDias, null);
});

test('listar envases: sólo en uso por defecto; con cerrados, todos; con nombre del medicamento', async () => {
  const { api, p } = await escenario();
  const a = await bien(caja(api, p.id));
  await bien(caja(api, p.id, { lote: 'L2', caducidad: '2027-01-31' }));
  await bien(api.cerrarEnvase(a.envaseId!, 'desechado', 'Roto'));
  const vivos = await bien(api.listarEnvases(p.id));
  assert.equal(vivos.length, 1);
  assert.equal(vivos[0].medicamentoNombre, 'Metformina Cinfa 850 mg');
  assert.equal((await bien(api.listarEnvases(p.id, true))).length, 2);
  await mal(api.listarEnvases(999), 'NO_ENCONTRADO');
});

test('fichas incompletas: sólo las que están en uso y sin confirmar', async () => {
  const { api, p } = await escenario();
  await bien(caja(api, p.id));
  await med(api, { cn: '444444', nombre: 'Sin uso', principiosActivos: 'x' });
  assert.deepEqual((await bien(api.fichasIncompletas())).map((m) => m.cn), ['712729']);   // por el tratamiento
  await bien(api.guardarMedicamento({ cn: '712729', nombre: 'Metformina Cinfa 850 mg', color: 'blanco', forma: 'redondo' }, true));
  assert.deepEqual(await bien(api.fichasIncompletas()), []);
});

// ───────────────────────────── Alertas de calidad ─────────────────────────────

test('alerta de calidad: se guarda, no se duplica, valida sus datos y NO retira nada sola', async () => {
  const { api, db, p } = await escenario();
  const r = await bien(caja(api, p.id));
  const t1 = await bien(api.importarAlertaCalidad({ referencia: 'R_21/2026', cn: '712729.3', lote: ' l1 ', fecha: '2026-10-30', descripcion: 'Defecto', url: 'https://www.aemps.gob.es/x' }));
  assert.equal(n(db, 'SELECT count(*) AS n FROM alerta_calidad'), 1);
  assert.equal(db.get<{ cn: string }>('SELECT cn FROM alerta_calidad')!.cn, '712729');
  assert.deepEqual(t1.envasesARetirar, [r.envaseId]);
  assert.equal(db.get<{ e: string }>('SELECT estado AS e FROM envase')!.e, 'en_uso');
  await bien(api.importarAlertaCalidad({ referencia: 'R_21/2026', cn: '712729', lote: 'l1' }));
  assert.equal(n(db, 'SELECT count(*) AS n FROM alerta_calidad'), 1);
  await mal(api.importarAlertaCalidad({ referencia: '', cn: '712729' }), 'VALIDACION');
  await mal(api.importarAlertaCalidad({ referencia: 'R', cn: '12' }), 'VALIDACION', /no es válido/);
  await mal(api.importarAlertaCalidad({ referencia: 'R' }), 'VALIDACION', /CN o un lote/);
  await mal(api.importarAlertaCalidad({ referencia: 'R', lote: 'L', fecha: 'hoy' }), 'VALIDACION', /fecha/);
  await mal(api.importarAlertaCalidad({ referencia: 'R', lote: 'L', url: 'ftp://x' }), 'VALIDACION', /http/);
  assert.ok(db.get("SELECT 1 FROM auditoria WHERE entidad = 'alerta_calidad' AND accion = 'importar'"));
});

test('trazabilidad inversa con datos reales: envases, preparaciones, entregas y pacientes a avisar', async () => {
  const { api, db, p, t } = await escenario();
  const otro = await pac(api, { nombre: 'Luis' });
  const tl = await trat(api, otro.id);
  void tl;
  const e1 = (await bien(caja(api, p.id))).envaseId!;
  const e2 = (await bien(caja(api, otro.id, { lote: 'L9' }))).envaseId!;
  const v1 = db.get<{ id: number }>('SELECT id FROM pauta_version')!.id;
  const crear = (pid: number, estado: string, env: number) => {
    const id = db.run('INSERT INTO preparacion(id_publico,paciente_id,fecha_inicio,fecha_fin,caducidad_spd,validez_dias,estado) VALUES (?,?,?,?,?,14,?)', [randomUUID(), pid, '2026-11-02', '2026-11-08', '2026-11-16', estado]).ultimoId;
    db.run('INSERT INTO preparacion_linea(preparacion_id,tratamiento_id,pauta_version_id,envase_id,fecha,momento_id,unidades) VALUES (?,?,?,?,?,?,1)', [id, t.id, v1, env, '2026-11-03', 1]);
    return id;
  };
  const entregada = crear(p.id, 'entregado', e1);
  db.run("INSERT INTO entrega(preparacion_id,entregado_a,entregado_por,entregado_en) VALUES (?, 'Ana', 1, '2026-11-02T10:00:00Z')", [entregada]);
  const borrador = crear(otro.id, 'borrador', e2);
  const tz = await bien(api.importarAlertaCalidad({ referencia: 'R_9', cn: '712729' }));
  assert.equal(tz.envases.length, 2);
  const porId = new Map(tz.preparaciones.map((x) => [x.preparacionId, x]));
  assert.equal(porId.get(entregada)!.actuacion, 'avisar_paciente_entregado');
  assert.equal(porId.get(borrador)!.actuacion, 'rehacer_blister_no_entregado');
  assert.deepEqual(tz.pacientesAAvisar, [p.id]);
  assert.equal(tz.envasesARetirar.length, 2);
  // Sólo el lote L9
  const sl = await bien(api.importarAlertaCalidad({ referencia: 'R_10', cn: '712729', lote: 'L9' }));
  assert.deepEqual(sl.envases.map((e) => e.id), [e2]);
  // Sólo lote, sin CN
  const sc = await bien(api.importarAlertaCalidad({ referencia: 'R_11', lote: 'l1' }));
  assert.deepEqual(sc.envases.map((e) => e.id), [e1]);
});

test('una alerta importada bloquea después la entrada de ese lote', async () => {
  const { api, p } = await escenario();
  await bien(api.importarAlertaCalidad({ referencia: 'R_5/2026', cn: '712729', lote: 'LMALO' }));
  const r = await bien(caja(api, p.id, { lote: 'lmalo' }));
  assert.equal(r.ok, false);
  assert.ok(r.bloqueos.some((b) => b.codigo === 'LOTE_CON_ALERTA'));
});

// ───────────────────────────── Panel «Hoy» ─────────────────────────────

test('panel vacío: sin tareas y con cifras a cero', async () => {
  const { api } = await montar();
  const p = await bien(api.panelHoy());
  assert.equal(p.fecha, '2026-11-02');
  assert.deepEqual(p.tareas, []);
  assert.deepEqual(p.cifras, { pacientesActivos: 0, preparacionesPendientes: 0, cajasQueCaducan: 0, pacientesSinCobertura: 0, fichasIncompletas: 0 });
  assert.equal(p.copias.atrasada, false);
});

test('panel: paciente sin consentimiento = bloqueo; con consentimiento desaparece', async () => {
  const { api, db } = await montar();
  const a = await pac(api);
  let p = await bien(api.panelHoy());
  const tarea = p.tareas.find((x) => x.tipo === 'sin_consentimiento')!;
  assert.equal(tarea.gravedad, 'bloqueo');
  assert.equal(tarea.pacienteId, a.id);
  assert.match(tarea.texto, /Ana López Ruiz/);
  consentir(db, a.id);
  p = await bien(api.panelHoy());
  assert.equal(p.tareas.filter((x) => x.tipo === 'sin_consentimiento').length, 0);
  assert.equal(p.cifras.pacientesActivos, 1);
});

test('panel: cajas caducadas (bloqueo), que caducan en ≤60 días (atención) y lejanas (nada)', async () => {
  const { api, db, p } = await escenario();
  await bien(caja(api, p.id, { lote: 'LEJOS', caducidad: '2027-12-31' }));
  await bien(caja(api, p.id, { lote: 'PRONTO', caducidad: '2026-12-20' }));      // 48 días
  db.run("INSERT INTO envase(paciente_id,cn,lote,caducidad,origen_lectura,unidades_inicio,unidades_restantes,recibido_por) VALUES (?,'712729','VIEJO','2026-10-20','manual',10,10,1)", [p.id]);
  const panel = await bien(api.panelHoy());
  const cad = panel.tareas.find((x) => x.tipo === 'caja_caducada')!;
  const pro = panel.tareas.find((x) => x.tipo === 'caja_caduca')!;
  assert.equal(cad.gravedad, 'bloqueo');
  assert.match(cad.texto, /VIEJO/);
  assert.equal(pro.gravedad, 'atencion');
  assert.match(pro.texto, /PRONTO/);
  assert.doesNotMatch(JSON.stringify(panel.tareas), /LEJOS/);
  assert.equal(panel.cifras.cajasQueCaducan, 2);
});

test('panel: cobertura < 7 días = atención y cuenta en las cifras', async () => {
  const { api, p } = await escenario();
  await bien(caja(api, p.id, { unidades: 10 }));      // 5 días a 2 al día
  const panel = await bien(api.panelHoy());
  const t = panel.tareas.find((x) => x.tipo === 'cobertura_baja')!;
  assert.equal(t.gravedad, 'atencion');
  assert.match(t.texto, /5 días/);
  assert.equal(panel.cifras.pacientesSinCobertura, 1);
});

test('panel: preparaciones en borrador, preparadas y validadas sin entregar; las entregadas no', async () => {
  const { api, db, p } = await escenario();
  const mk = (estado: string, ini: string) => db.run('INSERT INTO preparacion(id_publico,paciente_id,fecha_inicio,fecha_fin,caducidad_spd,validez_dias,estado) VALUES (?,?,?,?,?,14,?)', [randomUUID(), p.id, ini, '2026-12-31', '2027-01-10', estado]);
  mk('borrador', '2026-11-03'); mk('validado', '2026-11-04'); mk('preparado', '2026-11-05'); mk('entregado', '2026-11-06'); mk('anulado', '2026-11-07');
  const panel = await bien(api.panelHoy());
  assert.deepEqual(panel.tareas.filter((x) => x.tipo.startsWith('preparacion')).map((x) => x.tipo).sort(), ['preparacion_borrador', 'preparacion_preparada', 'preparacion_validada']);
  assert.equal(panel.cifras.preparacionesPendientes, 3);
});

test('panel: ficha de medicamento en uso sin confirmar y revisión vencida', async () => {
  const { api, db, p } = await escenario();
  db.run("UPDATE paciente SET proxima_revision = '2026-10-01' WHERE id = ?", [p.id]);
  await bien(caja(api, p.id));
  const panel = await bien(api.panelHoy());
  const f = panel.tareas.find((x) => x.tipo === 'ficha_incompleta')!;
  assert.match(f.texto, /Metformina/);
  assert.equal(panel.cifras.fichasIncompletas, 1);
  const r = panel.tareas.find((x) => x.tipo === 'revision_vencida')!;
  assert.equal(r.gravedad, 'info');
  assert.equal(r.pacienteId, p.id);
  assert.match(r.texto, /01\/10\/2026/);
});

test('panel: copia atrasada sólo si consta una última copia de hace más de 7 días', async () => {
  const { api, db } = await montar();
  assert.equal((await bien(api.panelHoy())).copias.atrasada, false);
  db.run("INSERT INTO ajuste(clave,valor) VALUES ('ultima_copia','2026-10-30T08:00:00Z')");
  let p = await bien(api.panelHoy());
  assert.equal(p.copias.atrasada, false);
  assert.equal(p.tareas.length, 0);
  db.run("UPDATE ajuste SET valor = '2026-10-10T08:00:00Z' WHERE clave = 'ultima_copia'");
  p = await bien(api.panelHoy());
  assert.equal(p.copias.atrasada, true);
  assert.equal(p.tareas[0].tipo, 'copia_atrasada');
  assert.match(p.tareas[0].texto, /10\/10\/2026/);
});

test('panel: alerta de calidad que afecta a cajas en custodia = bloqueo con paciente', async () => {
  const { api, p } = await escenario();
  await bien(caja(api, p.id, { lote: 'LMALO' }));
  await bien(api.importarAlertaCalidad({ referencia: 'R_77/2026', cn: '712729', lote: 'LMALO' }));
  const panel = await bien(api.panelHoy());
  const t = panel.tareas.find((x) => x.tipo === 'alerta_calidad')!;
  assert.equal(t.gravedad, 'bloqueo');
  assert.equal(t.pacienteId, p.id);
  assert.match(t.texto, /R_77\/2026/);
});

test('panel: ordenado por gravedad (bloqueo > atención > info)', async () => {
  const { api, db, p } = await escenario();
  db.run("UPDATE paciente SET proxima_revision = '2026-10-01' WHERE id = ?", [p.id]);
  await bien(caja(api, p.id, { unidades: 4, lote: 'PRONTO', caducidad: '2026-12-01' }));
  db.run("INSERT INTO envase(paciente_id,cn,lote,caducidad,origen_lectura,unidades_inicio,unidades_restantes,recibido_por) VALUES (?,'712729','VIEJO','2026-10-20','manual',10,10,1)", [p.id]);
  const otro = await pac(api, { nombre: 'Luis' });
  void otro;                                                                      // sin consentimiento: bloqueo
  const g = (await bien(api.panelHoy())).tareas.map((x) => x.gravedad);
  const rango = { bloqueo: 0, atencion: 1, info: 2 };
  assert.ok(g.length >= 5);
  assert.deepEqual(g, [...g].sort((a, b) => rango[a] - rango[b]));
  assert.ok(g.includes('bloqueo') && g.includes('atencion') && g.includes('info'));
});

test('asignar una caja a un tratamiento que no corresponde BLOQUEA (TRATAMIENTO_NO_COINCIDE)', async () => {
  const { api, db, p } = await escenario();
  await med(api, { cn: '555555', nombre: 'Enalapril 10 mg', principiosActivos: 'enalapril' });
  const e = await trat(api, p.id, { principioActivo: 'enalapril' });
  const c = await bien(caja(api, p.id, { tratamientoId: e.id }));
  assert.equal(c.ok, false);
  assert.ok(c.bloqueos.some((b) => b.codigo === 'TRATAMIENTO_NO_COINCIDE'));
  const r = await bien(api.comprobarEntradaEnvase({ pacienteId: p.id, cn: '712729', lote: 'L', caducidad: '2027-12-31', unidades: 5, tratamientoId: e.id }));
  assert.ok(r.bloqueos.some((b) => b.codigo === 'TRATAMIENTO_NO_COINCIDE'));
  assert.equal(n(db, 'SELECT count(*) AS n FROM envase'), 0);
  const ok = await bien(caja(api, p.id, { cn: '555555', tratamientoId: e.id }));
  assert.equal(ok.ok, true);
});

test('EnvaseDto: caducada y caducaPronto según la fecha de hoy', async () => {
  const { api, db, p } = await escenario();
  await bien(caja(api, p.id, { lote: 'LEJOS' }));
  await bien(caja(api, p.id, { lote: 'PRONTO', caducidad: '2026-12-20' }));
  db.run("INSERT INTO envase(paciente_id,cn,lote,caducidad,origen_lectura,unidades_inicio,unidades_restantes,recibido_por) VALUES (?,'712729','VIEJO','2026-10-20','manual',10,10,1)", [p.id]);
  const l = await bien(api.listarEnvases(p.id));
  const f = (lote: string) => l.find((e) => e.lote === lote)!;
  assert.deepEqual([f('LEJOS').caducada, f('LEJOS').caducaPronto], [false, false]);
  assert.deepEqual([f('PRONTO').caducada, f('PRONTO').caducaPronto], [false, true]);
  assert.deepEqual([f('VIEJO').caducada, f('VIEJO').caducaPronto], [true, false]);
});
