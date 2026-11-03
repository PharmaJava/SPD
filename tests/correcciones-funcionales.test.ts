/**
 * Fallos reportados por el tester funcional en servicios / dominio / plantillas (cada prueba falla si se rompe la regla).
 * Número = punto de la lista del tester:
 *  1 descripción física confirmada · 2 doble registro de cajas · 3 corregir pauta del mismo día · 4 límites ·
 *  5 política de contraseña · 6 DPD opcional · 7 «faltan» con entidad · 9 solape · 10 duplicados · 11 plausibilidad ·
 *  14 carpeta de copias y bloqueo · 15 rotación de copias · 16 segunda firma · 17 alergias · 20 fecha futura.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import type { ContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { crearClinicaPreparacion } from '../src/servicios/clinica-preparacion.ts';
import { crearClinicaBase } from '../src/servicios/clinica-base.ts';
import { crearSistema } from '../src/servicios/sistema.ts';
import { crearCopiaFichero, listarCopias, rotarCopias } from '../src/servicios/copias.ts';
import { exigirContrasenaValida, fortalezaContrasena } from '../src/servicios/seguridad.ts';
import { cargarPautas, pautaADominio } from '../src/servicios/clinica/pautas.ts';
import { pautaVigenteEn, validarPauta, MAX_UNIDADES_POR_TOMA } from '../src/dominio/calendario-pauta.ts';
import { cruzarAlergias } from '../src/dominio/alergias-medicacion.ts';
import { evaluarPreparacion as evaluarDominio } from '../src/dominio/preparacion.ts';
import { validarEntradaEnvase, MAX_UNIDADES_ENVASE } from '../src/dominio/entrada-envase.ts';
import { detalleFaltan, renderizarDocumento, VARIABLES_OPCIONALES } from '../src/dominio/documentos.ts';
import type { PautaDto, PrimerUso, Resultado, RolUsuario } from '../src/servicios/api.ts';

const ok = <T>(r: Resultado<T>): T => { assert.equal(r.ok, true, r.ok ? '' : `${r.error} [${r.codigo}]`); return (r as { ok: true; datos: T }).datos; };
const ko = <T>(r: Resultado<T>, codigo?: string): { error: string; codigo?: string } => {
  assert.equal(r.ok, false, 'se esperaba un fallo');
  const f = r as { ok: false; error: string; codigo?: string };
  if (codigo) assert.equal(f.codigo, codigo, f.error);
  return f;
};

// ───────────────────────────── montaje clínico (preparaciones) ─────────────────────────────

const DESDE = '2026-11-03';            // hoy = 2026-11-02 en el reloj de pruebas
const PARAMS = { pacienteId: 1, desde: DESDE, dias: 7, fechaPreparacion: '2026-11-02' };
interface Montaje { t: ContextoPruebas; api: ReturnType<typeof crearClinicaPreparacion>; uid: (rol: RolUsuario) => number }

async function montar(rol: RolUsuario | null = 'farmaceutico'): Promise<Montaje> {
  const t = await crearContextoPruebas(rol);
  const api = crearClinicaPreparacion(t.ctx);
  const ids = new Map<string, number>(t.db.all<{ id: number; rol: string }>('SELECT id, rol FROM usuario').map((u) => [u.rol, u.id]));
  const m: Montaje = { t, api, uid: (r) => ids.get(r)! };
  const db = t.db;
  db.run("UPDATE farmacia SET telefono='955 000 000', direccion='Calle Sol 1', municipio='Sevilla', nif='B12345678', email='f@farmacia.test', rgpd_dpd='No designado' WHERE id=1");
  db.run("INSERT INTO paciente(id, id_publico, nombre, apellido1, apellido2, dni_nie, fecha_nacimiento, direccion, codigo_postal, municipio) VALUES (1,'aaaaaaaa-1111-4111-8111-111111111111','Ana','López','Pérez','12345678Z','1940-03-04','Calle Luna 5','41001','Sevilla')");
  for (const [cn, nombre, desc] of [['654321', 'Metformina Test 850 mg 28 comp', 'comprimido blanco, oblongo'], ['123456', 'Enalapril Test 10 mg 30 comp', 'comprimido blanco, redondo, ranurado']]) {
    db.run("INSERT INTO medicamento(cn,nombre,descripcion_fisica,descripcion_estado,descripcion_confirmada_por) VALUES (?,?,?,'confirmada',?)", [cn, nombre, desc, m.uid('farmaceutico')]);
  }
  db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, cn_preferente, emblistable) VALUES (1,1,'Metformina','850 mg','654321',1)");
  db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, cn_preferente, emblistable) VALUES (2,1,'Enalapril','10 mg','123456',1)");
  for (const [tid, dosis] of [[1, [[1, 1], [3, 1]]], [2, [[1, 1]]]] as const) {
    const v = db.run(`INSERT INTO pauta_version(tratamiento_id, version, vigente_desde, patron, origen, creado_por) VALUES (?,1,'2026-01-01','diario','receta',?)`, [tid, m.uid('farmaceutico')]).ultimoId;
    for (const [mo, u] of dosis) db.run('INSERT INTO pauta_dosis(pauta_version_id, momento_id, unidades) VALUES (?,?,?)', [v, mo, u]);
  }
  for (const [cn, tid, lote, cad, u] of [['654321', 1, 'MET1', '2028-05-31', 28], ['123456', 2, 'ENA1', '2027-12-31', 30]] as const) {
    db.run(`INSERT INTO envase(paciente_id, tratamiento_id, cn, lote, caducidad, origen_lectura, unidades_inicio, unidades_restantes, recibido_por) VALUES (1,?,?,?,?, 'manual', ?, ?, ?)`, [tid, cn, lote, cad, u, u, m.uid('farmaceutico')]);
  }
  ok(await api.listarPlantillasDocumento());
  for (const codigo of ['consentimiento_spd', 'info_rgpd']) {
    const p = db.get<{ id: number }>('SELECT id FROM plantilla_documento WHERE codigo = ? AND vigente = 1', [codigo])!;
    db.run(`INSERT INTO documento_firmado(id_publico, paciente_id, plantilla_id, firmante, firmante_calidad, firmado_en, texto_impreso, hash_texto, registrado_por)
            VALUES (?,1,?, 'Ana López Pérez','paciente','2026-10-01T10:00:00Z','x','h',?)`, [`doc-${codigo}`, p.id, m.uid('farmaceutico')]);
  }
  return m;
}
const codigos = (e: { bloqueos: { codigo: string }[] }) => e.bloqueos.map((b) => b.codigo);
const restantes = (m: Montaje) => m.t.db.all<{ unidades_restantes: number }>('SELECT unidades_restantes FROM envase ORDER BY id').map((x) => x.unidades_restantes);
const desconfirmar = (m: Montaje, cn = '654321') => m.t.db.run("UPDATE medicamento SET descripcion_estado='propuesta' WHERE cn = ?", [cn]);
const reconfirmar = (m: Montaje, cn = '654321') => m.t.db.run("UPDATE medicamento SET descripcion_estado='confirmada' WHERE cn = ?", [cn]);

// ───────── 1. descripción física confirmada (regla 2) ─────────

test('1: con la descripción sin confirmar la evaluación bloquea, y no se guarda, ni se prepara, ni se valida', async () => {
  const m = await montar();
  assert.deepEqual(ok(await m.api.evaluarPreparacion(PARAMS)).bloqueos, []);
  desconfirmar(m);
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.equal(e.validable, false);
  assert.ok(codigos(e).includes('DESCRIPCION_FISICA_SIN_CONFIRMAR'));
  assert.match(e.bloqueos.find((b) => b.codigo === 'DESCRIPCION_FISICA_SIN_CONFIRMAR')!.texto, /654321.*descripción física no está confirmada/);
  assert.equal(ko(await m.api.crearPreparacion(PARAMS), 'BLOQUEOS').error.includes('descripción física'), true);
  assert.equal(m.t.db.get<{ n: number }>('SELECT count(*) AS n FROM preparacion')!.n, 0);

  // borrador con todo confirmado; después se pierde la confirmación: no se puede marcar como preparada
  reconfirmar(m);
  const b = ok(await m.api.crearPreparacion(PARAMS));
  desconfirmar(m);
  assert.match(ko(await m.api.marcarPreparada(b.id), 'BLOQUEOS').error, /descripción física/);
  reconfirmar(m);
  const p = ok(await m.api.marcarPreparada(b.id));
  // ...y tampoco se valida si se pierde entre preparar y validar
  desconfirmar(m);
  assert.match(ko(await m.api.validarPreparacion(p.id), 'BLOQUEOS').error, /descripción física/);
  assert.deepEqual(restantes(m), [28, 30], 'no se descuenta nada');
  reconfirmar(m);
  assert.equal(ok(await m.api.validarPreparacion(p.id)).estado, 'validado');
});

test('1: «confirmada» con la descripción en blanco tampoco vale; sólo cuenta lo que se usa en el reparto', async () => {
  const m = await montar();
  m.t.db.run("UPDATE medicamento SET descripcion_fisica = '   ' WHERE cn = '123456'");
  assert.ok(codigos(ok(await m.api.evaluarPreparacion(PARAMS))).includes('DESCRIPCION_FISICA_SIN_CONFIRMAR'));
  // un tratamiento finalizado no se usa: su medicamento sin descripción no bloquea
  m.t.db.run("UPDATE tratamiento SET finalizado_en = '2026-11-01T00:00:00Z' WHERE id = 2");
  assert.ok(!codigos(ok(await m.api.evaluarPreparacion(PARAMS))).includes('DESCRIPCION_FISICA_SIN_CONFIRMAR'));
});

test('1 (dominio): todo CN usado tiene que constar como confirmado; un CN ausente de la lista bloquea', () => {
  const M = [{ id: 1, nombre: 'Desayuno', orden: 1 }];
  const entrada = (medicamentos?: { cn: string; nombre: string; descripcionConfirmada: boolean }[]) => ({
    desde: '2026-11-03', dias: 7, fechaPreparacion: '2026-11-02', momentos: M, rolValida: 'farmaceutico' as const, consentimiento: true, medicamentos,
    tratamientos: [{ tratamientoId: 1, nombre: 'Metformina', versiones: [{ vigenteDesde: '2026-01-01', patron: 'diario' as const, dosis: [{ momentoId: 1, unidades: 1 }] }],
      envases: [{ id: 1, tratamientoId: 1, cn: '654321', lote: 'L1', caducidad: '2028-01-31', unidadesRestantes: 28, estado: 'en_uso' as const }] }],
  });
  assert.deepEqual(evaluarDominio(entrada()).bloqueos, [], 'sin lista no se comprueba (sólo pruebas)');
  assert.deepEqual(evaluarDominio(entrada([{ cn: '654321', nombre: 'Metformina', descripcionConfirmada: true }])).bloqueos, []);
  assert.deepEqual(evaluarDominio(entrada([{ cn: '654321', nombre: 'Metformina', descripcionConfirmada: false }])).bloqueos.map((b) => b.codigo), ['DESCRIPCION_FISICA_SIN_CONFIRMAR']);
  assert.deepEqual(evaluarDominio(entrada([])).bloqueos.map((b) => b.codigo), ['DESCRIPCION_FISICA_SIN_CONFIRMAR'], 'ante la duda, bloquea');
});

// ───────── 9. solape · 20. fecha futura ─────────

test('9: evaluar avisa/bloquea si ya hay una preparación vigente del mismo periodo; un borrador sólo avisa; la propia no se solapa consigo misma', async () => {
  const m = await montar();
  const b = ok(await m.api.crearPreparacion(PARAMS));
  const conBorrador = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.ok(conBorrador.avisos.some((a) => a.codigo === 'BORRADOR_SOLAPADO'));
  assert.ok(!codigos(conBorrador).includes('PERIODO_SOLAPADO'));
  const p = ok(await m.api.marcarPreparada(b.id));
  const e = ok(await m.api.evaluarPreparacion({ ...PARAMS, desde: '2026-11-05', dias: 7 }));
  assert.equal(e.validable, false);
  assert.match(e.bloqueos.find((x) => x.codigo === 'PERIODO_SOLAPADO')!.texto, new RegExp(`nº ${p.id}.*03/11/2026 al 09/11/2026`));
  assert.equal(ko(await m.api.crearPreparacion({ ...PARAMS, desde: '2026-11-05' }), 'PERIODO_SOLAPADO').error.includes('solapa'), true);
  // otro periodo que no toca: sin bloqueo
  assert.ok(!codigos(ok(await m.api.evaluarPreparacion({ ...PARAMS, desde: '2026-11-10', dias: 3 }))).includes('PERIODO_SOLAPADO'));
  // la propia preparación, al reabrirla, no se bloquea a sí misma y se puede validar
  assert.ok(!codigos(ok(await m.api.obtenerPreparacion(p.id)).evaluacion).includes('PERIODO_SOLAPADO'));
  assert.equal(ok(await m.api.validarPreparacion(p.id)).estado, 'validado');
});

test('20: crearPreparacion rechaza una fecha de preparación futura (y la evaluación la bloquea)', async () => {
  const m = await montar();
  const futura = { ...PARAMS, fechaPreparacion: '2026-11-03' };
  assert.equal(ko(await m.api.crearPreparacion(futura), 'FECHA_PREPARACION_FUTURA').error.includes('futura'), true);
  assert.ok(codigos(ok(await m.api.evaluarPreparacion(futura))).includes('FECHA_PREPARACION_FUTURA'));
  assert.equal(m.t.db.get<{ n: number }>('SELECT count(*) AS n FROM preparacion')!.n, 0);
  assert.equal(ok(await m.api.crearPreparacion(PARAMS)).estado, 'borrador');   // hoy sí
});

// ───────── 17. alergias ─────────

const alergia = (m: Montaje, descripcion: string, vigente = 1) =>
  m.t.db.run("INSERT INTO salud_dato(paciente_id, tipo, descripcion, vigente, registrado_por) VALUES (1,'alergia',?,?,?)", [descripcion, vigente, m.uid('farmaceutico')]);

test('17: una alergia registrada que coincide con el principio activo avisa («posible alergia») y obliga a confirmación para validar', async () => {
  const m = await montar('tecnico');
  alergia(m, 'Alergia a la metformina');
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  const aviso = e.avisos.find((a) => a.codigo === 'POSIBLE_ALERGIA')!;
  assert.match(aviso.texto, /posible alergia/i);
  assert.match(aviso.texto, /Metformina 850 mg/);
  assert.ok(codigos(e).includes('ALERGIA_SIN_CONFIRMAR'));
  // un técnico puede guardar el borrador y prepararlo, pero no dar la alergia por revisada
  const b = ok(await m.api.crearPreparacion({ ...PARAMS, confirmarAlergias: true }));
  assert.ok(codigos(ok(await m.api.evaluarPreparacion({ ...PARAMS, confirmarAlergias: true }))).includes('ALERGIA_SIN_CONFIRMAR'), 'un técnico no confirma');
  const p = ok(await m.api.marcarPreparada(b.id));
  m.t.cambiarUsuario('farmaceutico');
  assert.match(ko(await m.api.validarPreparacion(p.id), 'BLOQUEOS').error, /posible alergia sin confirmar/);
  assert.deepEqual(restantes(m), [28, 30]);
  assert.equal(ok(await m.api.validarPreparacion(p.id, { confirmarAlergias: true })).estado, 'validado');
  const a = m.t.auditadas.find((x) => x.accion === 'validar')!;
  assert.match(a.motivo ?? '', /posible alergia revisada y confirmada por el farmacéutico/);
  assert.match(a.motivo ?? '', /Metformina 850 mg/);
});

test('17: sin coincidencia por nombre no hay aviso; una alergia no vigente no cuenta; el aviso permanece aunque se confirme', async () => {
  const m = await montar();
  alergia(m, 'Penicilinas');                 // no se inventan equivalencias clínicas
  alergia(m, 'Metformina', 0);               // dada de baja
  const e = ok(await m.api.evaluarPreparacion(PARAMS));
  assert.ok(!e.avisos.some((a) => a.codigo === 'POSIBLE_ALERGIA'));
  assert.ok(!codigos(e).includes('ALERGIA_SIN_CONFIRMAR'));
  alergia(m, 'alérgico al ENALAPRIL');
  const c = ok(await m.api.evaluarPreparacion({ ...PARAMS, confirmarAlergias: true }));
  assert.ok(c.avisos.some((a) => a.codigo === 'POSIBLE_ALERGIA' && /Enalapril/.test(a.texto)), 'el aviso se mantiene');
  assert.ok(!codigos(c).includes('ALERGIA_SIN_CONFIRMAR'), 'el farmacéutico la ha confirmado');
});

test('17 (dominio): cruce por nombre normalizado, sin familias ni marcas ni palabras genéricas', () => {
  const t = (id: number, principioActivo: string) => ({ tratamientoId: id, nombre: principioActivo, principioActivo });
  const casa = (alergia: string, pa: string) => cruzarAlergias([alergia], [t(1, pa)]).length === 1;
  assert.ok(casa('Penicilina', 'Penicilina V 1 MUI'));
  assert.ok(casa('alergia a la PENICILINA', 'penicilina'));
  assert.ok(casa('Penicilinas', 'Penicilina V'), 'plural/singular');
  assert.ok(casa('ácido acetilsalicílico', 'Acido acetilsalicilico 100 mg'));
  assert.ok(casa('clavulánico', 'Amoxicilina/ácido clavulánico'));
  assert.ok(casa('enalapril', 'Enalapril maleato 10 mg'));
  assert.ok(!casa('penicilinas', 'Amoxicilina'), 'familia: lo decide un farmacéutico');
  assert.ok(!casa('aspirina', 'Ácido acetilsalicílico'), 'marca: no se inventa');
  assert.ok(!casa('ácido', 'Ácido fólico'), 'palabra genérica');
  assert.ok(!casa('AINE', 'Ibuprofeno'));
  assert.ok(!casa('alergia', 'Metformina'), 'sólo relleno');
  assert.ok(!casa('met', 'Metformina'), 'nunca por trozos de palabra');
  assert.deepEqual(cruzarAlergias([], [t(1, 'x')]), []);
});

// ───────────────────────────── montaje base (pacientes, envases, pautas, documentos) ─────────────────────────────

async function base(rol: RolUsuario | null = 'farmaceutico') {
  const t = await crearContextoPruebas(rol);
  const api = crearClinicaBase(t.ctx);
  const prep = crearClinicaPreparacion(t.ctx);
  return { t, api, prep, db: t.db };
}
type Base = Awaited<ReturnType<typeof base>>;
const nuevoPac = (b: Base, extra: Record<string, unknown> = {}) =>
  b.api.guardarPaciente({ nombre: 'Ana', apellido1: 'López', apellido2: 'Ruiz', necesitaBraille: false, letraGrande: false, ...extra });

async function conEnvases() {
  const b = await base();
  const p = ok(await nuevoPac(b));
  ok(await b.api.guardarMedicamento({ cn: '712729', nombre: 'Metformina Cinfa 850 mg', principiosActivos: 'metformina 850 mg', formaFarmaceutica: 'COMPRIMIDO RECUBIERTO CON PELICULA', unidadesEnvase: 50 }));
  const tr = ok(await b.api.guardarTratamiento({ pacienteId: p.id, principioActivo: 'metformina', emblistable: true }));
  const caja = (extra: Record<string, unknown> = {}) => b.api.registrarEnvase({ pacienteId: p.id, cn: '712729', lote: 'L1', caducidad: '2027-12-31', unidades: 30, ...extra } as never);
  const cuenta = () => b.db.get<{ n: number }>('SELECT count(*) AS n FROM envase')!.n;
  return { ...b, p, tr, caja, cuenta };
}

// ───────── 2. doble registro de cajas ─────────

test('2: una caja idéntica (CN, lote, caducidad y unidades) se rechaza sin confirmación explícita; con ella se admite como otra caja', async () => {
  const e = await conEnvases();
  const primera = ok(await e.caja());
  assert.ok(primera.envaseId);
  assert.ok(!ok(await e.api.comprobarEntradaEnvase({ pacienteId: e.p.id, cn: '712729', lote: 'L9', caducidad: '2027-12-31', unidades: 30 })).atencion.some((a) => a.codigo === 'POSIBLE_DUPLICADO'));
  // comprobar (sin guardar) lo avisa como atención
  const c = ok(await e.api.comprobarEntradaEnvase({ pacienteId: e.p.id, cn: '712729', lote: 'L1', caducidad: '2027-12-31', unidades: 30 }));
  assert.equal(c.ok, true);
  assert.ok(c.atencion.some((a) => a.codigo === 'POSIBLE_DUPLICADO'));
  // registrar sin confirmar: se rechaza con aviso y no se guarda
  const dup = ok(await e.caja());
  assert.equal(dup.ok, false);
  assert.equal(dup.envaseId, undefined);
  assert.ok(dup.bloqueos.some((x) => x.codigo === 'POSIBLE_DUPLICADO' && /doble registro|OTRA caja/.test(x.texto)));
  assert.equal(e.cuenta(), 1);
  // dos cajas legítimas del mismo lote: con confirmación se registran
  const segunda = ok(await e.caja({ confirmarDuplicado: true }));
  assert.equal(segunda.ok, true);
  assert.ok(segunda.envaseId && segunda.envaseId !== primera.envaseId);
  assert.equal(e.cuenta(), 2);
  assert.match(e.t.auditadas.filter((a) => a.entidad === 'envase' && a.accion === 'crear').pop()!.motivo ?? '', /otra caja física/);
  // sólo cuenta si TODO coincide
  assert.equal(ok(await e.caja({ unidades: 28 })).ok, true);
  assert.equal(ok(await e.caja({ lote: 'L2' })).ok, true);
  assert.equal(ok(await e.caja({ caducidad: '2028-01-31' })).ok, true);
  assert.equal(e.cuenta(), 5);
});

test('2: con nºs de serie distintos son cajas distintas; una caja antigua ya cerrada no cuenta como duplicado', async () => {
  const e = await conEnvases();
  assert.equal(ok(await e.caja({ numeroSerie: 'S1' })).ok, true);
  assert.equal(ok(await e.caja({ numeroSerie: 'S2' })).ok, true, 'otro nº de serie: otra caja, sin duda');
  assert.equal(ok(await e.caja({ numeroSerie: 'S1' })).ok, false, 'mismo nº de serie: duplicado');
  // una caja idéntica agotada hace tiempo no frena un alta nueva
  e.db.run("UPDATE envase SET estado = 'agotado', recibido_en = '2026-09-01T10:00:00Z'");
  assert.equal(ok(await e.caja({ lote: 'L7' })).ok, true);
  assert.equal(ok(await e.caja({ lote: 'L7' })).ok, false);
  e.db.run("UPDATE envase SET estado = 'agotado', recibido_en = '2026-09-01T10:00:00Z' WHERE lote = 'L7'");
  assert.equal(ok(await e.caja({ lote: 'L7' })).ok, true);
});

// ───────── 4. límites de validación ─────────

test('4: unidades de una caja enteras, ≥ 1 y ≤ 9999; avisa si superan el formato del envase', async () => {
  const e = await conEnvases();
  for (const [unidades, codigo] of [[0, 'UNIDADES_INVALIDAS'], [-5, 'UNIDADES_INVALIDAS'], [0.5, 'UNIDADES_NO_ENTERAS'], [10.25, 'UNIDADES_NO_ENTERAS'], [0.3, 'UNIDADES_NO_MULTIPLO'], [10000, 'UNIDADES_EXCESIVAS'], [1_000_000, 'UNIDADES_EXCESIVAS']] as const) {
    const r = ok(await e.caja({ unidades, lote: `X${unidades}` }));
    assert.equal(r.ok, false, String(unidades));
    assert.ok(r.bloqueos.some((b) => b.codigo === codigo), `${unidades}: ${JSON.stringify(r.bloqueos)}`);
  }
  assert.equal(e.cuenta(), 0);
  const unaSola = ok(await e.caja({ unidades: 1, lote: 'U1' }));
  assert.equal(unaSola.ok, true);
  const grande = ok(await e.caja({ unidades: 60, lote: 'G60' }));          // el envase declarado es de 50
  assert.equal(grande.ok, true);
  assert.ok(grande.atencion.some((a) => a.codigo === 'UNIDADES_SUPERAN_FORMATO' && /50/.test(a.texto)));
  assert.ok(!ok(await e.caja({ unidades: 50, lote: 'G50' })).atencion.some((a) => a.codigo === 'UNIDADES_SUPERAN_FORMATO'));
  assert.equal(ok(await e.caja({ unidades: MAX_UNIDADES_ENVASE, lote: 'TOPE' })).ok, true);
});

test('4 (dominio): el tope de unidades por caja y por toma', () => {
  const entrada = (unidades: number) => validarEntradaEnvase({ cn: '712729', lote: 'L1', caducidad: '2027-12-31', unidades, hoy: '2026-11-02' }, { envasesExistentes: [], cnConocidos: new Set(['712729']), alertasCalidad: [] });
  assert.equal(entrada(MAX_UNIDADES_ENVASE).ok, true);
  assert.ok(entrada(MAX_UNIDADES_ENVASE + 1).bloqueos.some((b) => b.codigo === 'UNIDADES_EXCESIVAS'));
  const pauta = (unidades: number) => ({ vigenteDesde: '2026-01-01', patron: 'diario' as const, dosis: [{ momentoId: 1, unidades }] });
  assert.deepEqual(validarPauta(pauta(MAX_UNIDADES_POR_TOMA)), []);
  assert.ok(validarPauta(pauta(MAX_UNIDADES_POR_TOMA + 0.25)).some((x) => /máximo razonable/.test(x)));
  assert.ok(validarPauta(pauta(1000)).some((x) => /máximo razonable/.test(x)));
  assert.ok(validarPauta(pauta(0)).length > 0);
  assert.ok(validarPauta(pauta(0.3)).length > 0);
});

test('4: guardarPauta rechaza 1000 comprimidos por toma, 0, y no múltiplos de 0,25; acepta 10 y 0,25', async () => {
  const e = await conEnvases();
  const pauta = (unidades: number, extra: Partial<PautaDto> = {}): PautaDto => ({ vigenteDesde: '2026-11-01', patron: 'diario', origen: 'receta', dosis: [{ momentoId: 1, unidades }], ...extra });
  for (const u of [1000, 11, 10.25, 0, -1, 0.3]) assert.match(ko(await e.api.guardarPauta(e.tr.id, pauta(u)), 'VALIDACION').error, /Pauta no válida/, String(u));
  assert.equal(ok(await e.api.guardarPauta(e.tr.id, pauta(0.25))).pautas.length, 1);
  assert.equal(ok(await e.api.guardarPauta(e.tr.id, pauta(10, { vigenteDesde: '2026-11-05' }))).pautas.length, 2);
});

// ───────── 3. corregir una versión errónea del mismo día ─────────

test('3: una pauta errónea del mismo día se corrige con origen «corrección»: la sustituye, queda en el historial y auditada', async () => {
  const e = await conEnvases();
  const pauta = (unidades: number, extra: Partial<PautaDto> = {}): PautaDto => ({ vigenteDesde: '2026-11-01', patron: 'diario', origen: 'receta', dosis: [{ momentoId: 1, unidades }], ...extra });
  ok(await e.api.guardarPauta(e.tr.id, pauta(1, { vigenteDesde: '2026-10-01' })));
  ok(await e.api.guardarPauta(e.tr.id, pauta(8)));                                 // error: 8 en vez de 1
  // sin «corrección» sigue exigiéndose una fecha posterior
  assert.match(ko(await e.api.guardarPauta(e.tr.id, pauta(1)), 'VALIDACION').error, /Ya existe una versión.*corrección/);
  // la corrección exige el motivo
  ko(await e.api.guardarPauta(e.tr.id, pauta(1, { origen: 'correccion' })), 'VALIDACION');
  ko(await e.api.guardarPauta(e.tr.id, pauta(1, { origen: 'correccion', origenDetalle: 'ok' })), 'VALIDACION');
  const t = ok(await e.api.guardarPauta(e.tr.id, pauta(1, { origen: 'correccion', origenDetalle: 'Error al teclear: eran 1 comprimido, no 8' })));
  assert.equal(t.pautas.length, 3, 'el historial conserva las tres versiones');
  assert.match(t.pautaVigenteTexto, /^1 desayuno/);
  const [p1, erronea, corr] = t.pautas;
  assert.equal(erronea.vigenteHasta, '2026-11-01', 'la errónea deja de aplicarse (su único día lo tapa la corrección)');
  assert.equal(p1.vigenteHasta, '2026-10-31');
  assert.equal(corr.origen, 'correccion');
  assert.equal(corr.vigenteHasta ?? null, null);
  // con la corrección vigente cada día, desde el 1-nov, aplica la nueva; nunca la errónea
  const dominio = cargarPautas(e.db, [e.tr.id]).get(e.tr.id)!.map(pautaADominio);
  for (const dia of ['2026-11-01', '2026-11-02', '2026-12-30']) assert.equal(pautaVigenteEn(dominio, dia)!.dosis[0].unidades, 1, dia);
  assert.equal(pautaVigenteEn(dominio, '2026-10-15')!.dosis[0].unidades, 1);
  // rastro auditado: quién/cuándo/por qué
  const a = e.t.auditadas.find((x) => x.entidad === 'pauta_version' && /Corregida por la versión 3/.test(x.motivo ?? ''))!;
  assert.match(a.motivo ?? '', /Error al teclear/);
  assert.deepEqual((a.despues as { vigenteHasta: string }).vigenteHasta, '2026-11-01');
  assert.ok(e.t.auditadas.some((x) => x.entidad === 'pauta_version' && x.accion === 'crear' && (x.despues as { origen?: string }).origen === 'correccion'));
});

test('3: una corrección temporal no «resucita» la pauta errónea al terminar; y no se corrige hacia atrás una versión posterior', async () => {
  const e = await conEnvases();
  const pauta = (unidades: number, extra: Partial<PautaDto> = {}): PautaDto => ({ vigenteDesde: '2026-11-01', patron: 'diario', origen: 'receta', dosis: [{ momentoId: 1, unidades }], ...extra });
  ok(await e.api.guardarPauta(e.tr.id, pauta(8)));
  ok(await e.api.guardarPauta(e.tr.id, pauta(2, { origen: 'correccion', origenDetalle: 'Pauta corregida', vigenteHasta: '2026-11-10' })));
  const dominio = cargarPautas(e.db, [e.tr.id]).get(e.tr.id)!.map(pautaADominio);
  assert.equal(pautaVigenteEn(dominio, '2026-11-05')!.dosis[0].unidades, 2);
  assert.equal(pautaVigenteEn(dominio, '2026-11-12'), null, 'tras la temporal no vuelve la errónea');
  // una versión que empieza DESPUÉS impide corregir la anterior por esta vía
  const f = await conEnvases();
  ok(await f.api.guardarPauta(f.tr.id, pauta(1)));
  ok(await f.api.guardarPauta(f.tr.id, pauta(2, { vigenteDesde: '2026-11-10' })));
  assert.match(ko(await f.api.guardarPauta(f.tr.id, pauta(3, { vigenteDesde: '2026-11-05', origen: 'correccion', origenDetalle: 'motivo válido' })), 'VALIDACION').error, /Ya existe una versión/);
});

// ───────── 7. «faltan» con entidad · 6. DPD opcional · 16. segunda firma ─────────

const REP = { nombre: 'Pedro López', dniNie: '11111111H', calidad: 'representante_legal' as const };

test('7: lo que falta en un documento dice de qué entidad es (paciente, firmante, farmacia) y el error de registro también', async () => {
  const m = await montar();
  m.t.db.run("UPDATE paciente SET dni_nie = NULL, fecha_nacimiento = NULL WHERE id = 1");
  m.t.db.run("UPDATE farmacia SET nif = NULL WHERE id = 1");
  const v = ok(await m.api.vistaDocumento('consentimiento_spd', 1, { nombre: 'Pedro López', calidad: 'representante_legal' }));
  const de = (ruta: string) => v.faltanDetalle!.find((f) => f.ruta === ruta);
  assert.deepEqual(de('paciente.dni_nie'), { ruta: 'paciente.dni_nie', entidad: 'paciente', campo: 'dni_nie', etiqueta: 'DNI/NIE del paciente' });
  assert.equal(de('farmacia.nif')!.entidad, 'farmacia');
  assert.equal(de('firmante.dni_nie')!.entidad, 'firmante', 'el DNI del representante es del firmante, no del paciente');
  assert.deepEqual(v.faltanDetalle!.map((f) => f.ruta), v.faltan, 'mismo orden y mismas rutas que `faltan`');
  const f = ko(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, { nombre: 'Pedro López', calidad: 'representante_legal' }), 'DOCUMENTO_INCOMPLETO');
  assert.match(f.error, /paciente: DNI\/NIE del paciente/);
  assert.match(f.error, /farmacia: NIF de la farmacia/);
  assert.match(f.error, /firmante: DNI\/NIE del firmante/);
  // dominio
  assert.deepEqual(detalleFaltan(['autorizado.nombre', 'fecha.hoy', 'motivo.raro']).map((x) => [x.entidad, x.campo]), [['autorizado', 'nombre'], ['documento', 'hoy'], ['otro', 'raro']]);
});

test('6: el DPD es opcional: sin él la plantilla dice que no se ha designado y NO impide registrar; con él se imprime', async () => {
  const m = await montar();
  assert.ok(VARIABLES_OPCIONALES.includes('farmacia.rgpd_dpd'));
  m.t.db.run("UPDATE farmacia SET rgpd_dpd = NULL WHERE id = 1");
  const v = ok(await m.api.vistaDocumento('info_rgpd', 1, REP));
  assert.ok(!v.faltan.includes('farmacia.rgpd_dpd'));
  assert.ok(!v.texto.includes('⟦farmacia.rgpd_dpd⟧'));
  assert.match(v.texto, /Delegado\/a de protección de datos:\s*no designado \(la farmacia no ha designado delegado de protección de datos; para consultas y para ejercer sus derechos, utilice el contacto indicado\)/);
  assert.ok(ok(await m.api.registrarDocumentoFirmado('info_rgpd', 1, REP)).id > 0);
  m.t.db.run("UPDATE farmacia SET rgpd_dpd = 'Ana DPD' WHERE id = 1");
  assert.match(ok(await m.api.vistaDocumento('info_rgpd', 1, REP)).texto, /Delegado\/a de protección de datos:\s*Ana DPD\./);
  // el contacto de protección de datos SÍ sigue siendo necesario (a dónde dirigirse): sin él ni correo, falta
  m.t.db.run("UPDATE farmacia SET rgpd_dpd = NULL, rgpd_contacto = NULL, email = NULL WHERE id = 1");
  assert.ok(ok(await m.api.vistaDocumento('info_rgpd', 1, REP)).faltan.includes('farmacia.rgpd_contacto'));
  // dominio: un valor en blanco o invisible tampoco cuenta; y no es el texto de «motivo»
  const r = renderizarDocumento('DPD: {{farmacia.rgpd_dpd}} / {{motivo}}', { 'farmacia.rgpd_dpd': '​  ' });
  assert.deepEqual(r.faltan, []);
  assert.match(r.texto, /^DPD: no designado .* \/ no indicado$/);
});

test('16: una segunda firma vigente del mismo documento se rechaza; «sustituir» con motivo versiona (revoca la anterior, no borra)', async () => {
  const m = await montar();
  const primera = ok(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP)).id;
  const f = ko(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP), 'DOCUMENTO_YA_FIRMADO');
  assert.match(f.error, new RegExp(`nº ${primera}`));
  const n = () => m.t.db.get<{ n: number }>("SELECT count(*) AS n FROM documento_firmado d JOIN plantilla_documento p ON p.id = d.plantilla_id WHERE p.codigo = 'consentimiento_spd' AND d.paciente_id = 1 AND d.firmante <> 'Ana López Pérez'")!.n;
  assert.equal(n(), 1, 'no se duplicó');
  ko(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP, { sustituir: true }), 'VALIDACION');            // sin motivo
  ko(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP, { sustituir: true, motivo: 'no' }), 'VALIDACION');
  assert.equal(n(), 1);
  const segunda = ok(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, { ...REP, nombre: 'Marta López' }, { sustituir: true, motivo: 'Cambia el representante legal' })).id;
  const filas = m.t.db.all<{ id: number; revocado_en: string | null; motivo_revocacion: string | null }>('SELECT id, revocado_en, motivo_revocacion FROM documento_firmado WHERE id IN (?,?) ORDER BY id', [primera, segunda]);
  assert.equal(filas.length, 2, 'la anterior sigue en el historial');
  assert.ok(filas[0].revocado_en);
  assert.match(filas[0].motivo_revocacion ?? '', /Sustituida por una firma nueva: Cambia el representante legal/);
  assert.equal(filas[1].revocado_en, null);
  assert.ok(m.t.auditadas.some((a) => a.accion === 'revocar' && a.entidad === 'documento_firmado' && a.entidadId === primera));
  // un documento revocado deja de contar: se puede firmar otra vez sin «sustituir»
  ok(await m.api.revocarDocumento(segunda, 'Baja del servicio'));
  assert.ok(ok(await m.api.registrarDocumentoFirmado('consentimiento_spd', 1, REP)).id > segunda);
});

test('16: una versión nueva de la plantilla se firma sin sustituir; la autorización a terceros es una por persona; el recibí se repite', async () => {
  const m = await montar();
  ok(await m.api.registrarDocumentoFirmado('info_rgpd', 1, REP));
  m.t.db.run("INSERT INTO plantilla_documento(codigo,version,titulo,cuerpo,vigente) VALUES ('info_rgpd',2,'Nueva','Texto {{documento.version}}',1)");
  assert.ok(ok(await m.api.registrarDocumentoFirmado('info_rgpd', 1, REP)).id > 0, 'versión 2: otra firma, no es un duplicado');
  ko(await m.api.registrarDocumentoFirmado('info_rgpd', 1, REP), 'DOCUMENTO_YA_FIRMADO');
  m.t.db.run("INSERT INTO contacto(id, paciente_id, tipo, nombre, dni_nie, parentesco, autorizado_recoger) VALUES (1,1,'familiar','Luis Gil','87654321X','hijo',1)");
  m.t.db.run("INSERT INTO contacto(id, paciente_id, tipo, nombre, dni_nie, parentesco, autorizado_recoger) VALUES (2,1,'familiar','Eva Gil','12312312A','hija',1)");
  ok(await m.api.registrarDocumentoFirmado('autorizacion_terceros', 1, { ...REP, contactoId: 1 }));
  ok(await m.api.registrarDocumentoFirmado('autorizacion_terceros', 1, { ...REP, contactoId: 2 }));
  ko(await m.api.registrarDocumentoFirmado('autorizacion_terceros', 1, { ...REP, contactoId: 1 }), 'DOCUMENTO_YA_FIRMADO');
  ok(await m.api.registrarDocumentoFirmado('recibi_devolucion', 1, REP));
  ok(await m.api.registrarDocumentoFirmado('recibi_devolucion', 1, REP));
});

// ───────── 10. duplicados (pacientes, iniciales) · 11. plausibilidad ─────────

test('10: un paciente con el mismo nombre, apellidos y fecha de nacimiento avisa (sin tildes ni mayúsculas) y NO bloquea', async () => {
  const b = await base();
  const datos = { nombre: 'María', apellido1: 'García', apellido2: 'Ruiz', fechaNacimiento: '1950-05-05' };
  const a = ok(await nuevoPac(b, datos));
  assert.equal(a.avisos, undefined);
  const dup = ok(await nuevoPac(b, { ...datos, nombre: 'MARIA', apellido1: 'garcia' }));
  assert.ok(dup.id !== a.id);
  assert.match((dup.avisos ?? [])[0] ?? '', new RegExp(`Posible paciente duplicado.*nº ${a.id}`));
  assert.equal(ok(await nuevoPac(b, { ...datos, fechaNacimiento: '1950-05-06' })).avisos, undefined, 'otra fecha: otra persona');
  assert.equal(ok(await nuevoPac(b, { ...datos, apellido2: 'Pérez' })).avisos, undefined);
  assert.equal(ok(await nuevoPac(b, { nombre: 'Sin', apellido1: 'Fecha' })).avisos, undefined);
  assert.equal(ok(await nuevoPac(b, { nombre: 'Sin', apellido1: 'Fecha' })).avisos, undefined, 'sin fecha no hay base para avisar');
  // al editar también avisa
  assert.ok((ok(await b.api.guardarPaciente({ ...dup, necesitaBraille: false, letraGrande: false } as never)).avisos ?? []).length >= 1);
  assert.match(b.t.auditadas.filter((x) => x.entidad === 'paciente' && x.accion === 'crear')[1].motivo ?? '', /duplicado/);
});

test('11: nacimiento verosímil, DNI/NIE con formato (sin validar la letra), CP de 5 cifras', async () => {
  const b = await base();
  for (const f of ['1850-01-01', '1899-12-31', '2026-11-03', '0001-01-01']) ko(await nuevoPac(b, { fechaNacimiento: f }), 'VALIDACION');
  assert.equal(ok(await nuevoPac(b, { fechaNacimiento: '1900-01-01', nombre: 'A1' })).fechaNacimiento, '1900-01-01');
  for (const dni of ['ABC', '1234567', '123456789', '12345678', '1234567Z', 'X12345678', 'W1234567A', '12.345.678-ZZ']) assert.match(ko(await nuevoPac(b, { dniNie: dni }), 'VALIDACION').error, /DNI\/NIE/, dni);
  assert.equal(ok(await nuevoPac(b, { dniNie: '12.345.678-z', nombre: 'D1' })).dniNie, '12345678Z');
  assert.equal(ok(await nuevoPac(b, { dniNie: 'x1234567l', nombre: 'D2' })).dniNie, 'X1234567L');
  assert.equal(ok(await nuevoPac(b, { dniNie: '12345678A', nombre: 'D3' })).dniNie, '12345678A', 'la letra de control NO se valida');
  for (const cp of ['4100', '410011', 'abcde', '41 001']) ko(await nuevoPac(b, { codigoPostal: cp }), 'VALIDACION');
  assert.equal(ok(await nuevoPac(b, { codigoPostal: '41001', nombre: 'C1' })).codigoPostal, '41001');
  // los contactos usan el mismo formato de documento
  const p = ok(await nuevoPac(b, { nombre: 'P' }));
  ko(await b.api.guardarContacto({ pacienteId: p.id, tipo: 'familiar', nombre: 'Luis', dniNie: 'xx', autorizadoRecoger: false }), 'VALIDACION');
  ok(await b.api.guardarContacto({ pacienteId: p.id, tipo: 'familiar', nombre: 'Luis', dniNie: '87654321X', autorizadoRecoger: false }));
});

test('11: datos de salud con fecha no futura y valores creíbles (peso, función renal)', async () => {
  const b = await base();
  const p = ok(await nuevoPac(b));
  const salud = (extra: Record<string, unknown>) => b.api.guardarSalud({ pacienteId: p.id, tipo: 'peso', descripcion: 'Peso', vigente: true, ...extra } as never);
  ko(await salud({ fecha: '2026-11-03' }), 'VALIDACION');                      // mañana
  ko(await salud({ fecha: '1850-01-01' }), 'VALIDACION');
  assert.equal(ok(await salud({ fecha: '2026-11-02', valor: '70 kg' })).valor, '70 kg');
  for (const v of ['700', '0', '1000 kg', 'mucho']) ko(await salud({ valor: v }), 'VALIDACION');
  assert.equal(ok(await salud({ valor: '62,5' })).valor, '62,5');
  assert.equal(ok(await salud({ valor: '400' })).valor, '400');
  ko(await salud({ tipo: 'insuficiencia_renal', descripcion: 'FG', valor: '900 mL/min' }), 'VALIDACION');
  assert.equal(ok(await salud({ tipo: 'insuficiencia_renal', descripcion: 'FG', valor: '35 mL/min' })).valor, '35 mL/min');
  assert.equal(ok(await salud({ tipo: 'insuficiencia_renal', descripcion: 'FG', valor: 'estadio 3b' })).valor, 'estadio 3b');
  assert.equal(ok(await salud({ tipo: 'alergia', descripcion: 'Penicilina', valor: 'cualquier texto' })).valor, 'cualquier texto', 'otros tipos: valor libre');
});

// ───────────────────────────── servicio de sistema (contraseña, iniciales, ajustes) ─────────────────────────────

const KDF = { n: 1 << 10, r: 8, p: 1 };
const PASS = 'mi-Contraseña-segura-1';
const PRIMER_USO: PrimerUso = {
  farmacia: { nombre: 'Farmacia Luz del Sur', titular: 'Marta Etxeberria' },
  titular: { nombre: 'Marta Etxeberria', iniciales: 'ME', pin: '4821' },
  contrasena: PASS,
  momentos: [{ nombre: 'Desayuno' }, { nombre: 'Cena' }],
};

async function sistema() {
  const dir = mkdtempSync(join(tmpdir(), 'spd-corr-'));
  const reloj = { t: Date.parse('2026-11-02T09:00:00Z') };
  const s = crearSistema({ rutaDatos: join(dir, 'datos'), ahora: () => new Date(reloj.t), kdf: KDF, debounceMs: 60_000 });
  return { dir, s, reloj, fin: async () => { await s.cerrar(); rmSync(dir, { recursive: true, force: true }); } };
}
type Sis = Awaited<ReturnType<typeof sistema>>;
async function conPrimerUso(): Promise<Sis> { const e = await sistema(); ok(await e.s.api.primerUso(PRIMER_USO)); return e; }

test('5: política única de contraseña (≥ 10 caracteres y fortaleza «Aceptable»), la misma que el medidor de la interfaz', () => {
  const nivel = (p: string) => fortalezaContrasena(p).nivel;
  assert.equal(nivel('corta'), 1 - 1 || 0);
  assert.equal(nivel('abcdefghij'), 1);
  assert.equal(nivel('Abcdefghij'), 2);
  assert.equal(nivel('abcdefghijklmn'), 2);
  assert.equal(nivel('Abcdefghijklm1!'), 4);
  assert.equal(nivel('contraseña-larga-1'), 0, 'empieza por una palabra típica');
  assert.equal(nivel('aaaaaaaaaaaaaaaa'), 0);
  assert.equal(fortalezaContrasena('Abcdefghij').texto, 'Aceptable');
  for (const mala of ['', 'corta', '123456789', 'abcdefghi', 'abcdefghij', 'contraseña-larga-1', 'aaaaaaaaaaaaaaaa', 'password12345', 5, null, undefined]) {
    try { exigirContrasenaValida(mala); assert.fail(`debería rechazar ${String(mala)}`); } catch (e) { assert.equal((e as { codigo?: string }).codigo, 'CONTRASENA_DEBIL', String(mala)); }
  }
  assert.match((() => { try { exigirContrasenaValida('corta'); } catch (e) { return (e as Error).message; } return ''; })(), /al menos 10 caracteres/);
  assert.match((() => { try { exigirContrasenaValida('abcdefghij'); } catch (e) { return (e as Error).message; } return ''; })(), /demasiado fácil de adivinar/);
  for (const buena of ['Abcdefghij', 'abcdefghijklmn', 'mi-frase-de-paso', 'Farmacia#2026']) assert.equal(exigirContrasenaValida(buena), buena);
});

test('5: primer uso, cambio de contraseña y recuperación aplican la MISMA política (antes bastaban 8 caracteres)', async () => {
  const e = await sistema();
  try {
    for (const mala of ['12345678', 'abcdefgh', 'abcdefghij', 'contraseña-larga']) mal(await e.s.api.primerUso({ ...PRIMER_USO, contrasena: mala }));
    const { claveRecuperacion } = ok(await e.s.api.primerUso(PRIMER_USO));
    for (const mala of ['12345678', 'abcdefghij']) {
      mal(await e.s.api.cambiarContrasena(PASS, mala));
      e.reloj.t += 2000;
    }
    ok(await e.s.api.cambiarContrasena(PASS, 'Otra-Contraseña-9'));
    await e.s.api.bloquear();
    for (const mala of ['12345678', 'abcdefghij']) mal(await e.s.api.recuperar(claveRecuperacion, mala));
  } finally { await e.fin(); }
});
function mal(r: Resultado<unknown>) { assert.equal(r.ok, false, 'se esperaba un fallo'); assert.equal((r as { codigo?: string }).codigo, 'CONTRASENA_DEBIL', JSON.stringify(r)); }

test('10: un usuario nuevo con iniciales ya usadas avisa (sin bloquear)', async () => {
  const e = await conPrimerUso();
  try {
    const u1 = ok(await e.s.api.crearUsuario({ nombre: 'Marta Echevarría', iniciales: 'me', rol: 'tecnico', pin: '1357' }));
    assert.deepEqual({ ...u1, avisos: undefined }, { id: u1.id, nombre: 'Marta Echevarría', iniciales: 'ME', rol: 'tecnico', avisos: undefined });
    assert.match((u1.avisos ?? [])[0] ?? '', /iniciales «ME» ya las usa Marta Etxeberria/);
    const u2 = ok(await e.s.api.crearUsuario({ nombre: 'Pedro Gil', iniciales: 'PG', rol: 'tecnico', pin: '2468' }));
    assert.equal(u2.avisos, undefined);
    assert.equal(ok(await e.s.api.listarUsuarios()).length, 3);
  } finally { await e.fin(); }
});

test('14: la carpeta de copias tiene que ser absoluta, existir y poder escribirse; el bloqueo acepta 0 (no bloquear) a 240', async () => {
  const e = await conPrimerUso();
  try {
    writeFileSync(join(e.dir, 'fichero'), 'x');
    const carpeta = join(e.dir, 'copias'); mkdirSync(carpeta);
    for (const mala of [join(e.dir, 'no-existe'), join(e.dir, 'fichero'), 'relativa/copias', '..\\copias', join(e.dir, 'fichero', 'dentro')]) {
      const r = await e.s.api.guardarAjustes({ carpetaCopias: mala });
      assert.equal(r.ok, false, mala);
      assert.equal((r as { codigo?: string }).codigo, 'AJUSTE_INVALIDO', mala);
      assert.ok((r as { error: string }).error.includes('no sirve'));
    }
    assert.equal(ok(await e.s.api.obtenerAjustes()).carpetaCopias, null, 'no se guardó nada');
    assert.equal(ok(await e.s.api.guardarAjustes({ carpetaCopias: carpeta })).carpetaCopias, carpeta);
    assert.deepEqual(readdirSync(carpeta), [], 'la comprobación de escritura no deja rastro');
    assert.ok(existsSync(carpeta));
    // volver a guardar los mismos ajustes no exige nada más; vaciar la carpeta sí se permite
    assert.equal(ok(await e.s.api.guardarAjustes({ carpetaCopias: '' })).carpetaCopias, null);
    for (const bien of [0, 1, 240]) assert.equal(ok(await e.s.api.guardarAjustes({ bloqueoMinutos: bien })).bloqueoMinutos, bien);
    for (const mal of [-1, 241, 1.5, '5' as never]) assert.equal((await e.s.api.guardarAjustes({ bloqueoMinutos: mal })).ok, false, String(mal));
  } finally { await e.fin(); }
});

// ───────────────────────────── 15. copias ─────────────────────────────

const CAB = Buffer.concat([Buffer.from('SPDDATOS', 'latin1'), Buffer.from([1]), Buffer.alloc(40)]);
const meta = (origen: 'automatica' | 'manual' | 'antes_actualizar' | 'antes_restaurar') => ({ origen, motivo: origen, versionApp: '1.0.0', esquema: 2 });

test('15: varias copias manuales y previas el MISMO día no se pisan entre sí ni con la automática; sólo las automáticas son «una por día»', () => {
  const c = mkdtempSync(join(tmpdir(), 'spd-rot-')); const origen = join(c, 'spd.datos'); const carpeta = join(c, 'copias');
  try {
    writeFileSync(origen, CAB);
    const a = (h: string, o: 'automatica' | 'manual' | 'antes_actualizar' | 'antes_restaurar') => crearCopiaFichero(origen, carpeta, new Date(`2026-11-02T${h}Z`), meta(o));
    const auto1 = a('08:00:00', 'automatica');
    const man1 = a('09:00:00', 'manual');
    const man2 = a('09:00:30', 'manual');
    const pre = a('10:00:00', 'antes_restaurar');
    const act = a('10:30:00', 'antes_actualizar');
    const auto2 = a('11:00:00', 'automatica');         // otra automática el mismo día: sólo la última se queda
    const man3 = a('12:00:00', 'manual');
    const nombres = listarCopias(carpeta).map((x) => join(carpeta, x.nombre));
    for (const viva of [man1, man2, pre, act, auto2, man3]) assert.ok(nombres.includes(viva), `debe seguir ${viva}`);
    assert.ok(!nombres.includes(auto1), 'la automática anterior del mismo día sí se rota');
    // dos copias en el mismo segundo no se pisan: la segunda avanza un segundo
    const x = a('13:00:00', 'manual'); const y = a('13:00:00', 'manual');
    assert.notEqual(x, y);
    assert.ok(existsSync(x) && existsSync(y));
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('15: sólo se conservan las últimas 10 manuales; las copias sin ficha siguen la regla de siempre', () => {
  const c = mkdtempSync(join(tmpdir(), 'spd-rot-')); const carpeta = join(c, 'copias'); mkdirSync(carpeta);
  try {
    const nombre = (i: number) => `spd-202611${String(i + 1).padStart(2, '0')}-090000.datos`;
    for (let i = 0; i < 12; i++) { writeFileSync(join(carpeta, nombre(i)), CAB); writeFileSync(join(carpeta, nombre(i)) + '.json', JSON.stringify({ formato: 1, ...meta('manual') })); }
    const borradas = rotarCopias(carpeta, undefined, new Date('2026-11-20T10:00:00Z'));
    assert.deepEqual(borradas, [nombre(0), nombre(1)]);
    assert.equal(listarCopias(carpeta).length, 10);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('15: la copia que se está restaurando no se rota al crear la de «antes de restaurar», y sigue en la lista', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spd-rest-'));
  try {
    const s = crearSistema({ rutaDatos: join(dir, 'datos'), ahora: () => new Date(t), kdf: KDF, debounceMs: 60_000, version: '1.0.0', carpetaCopiasPorDefecto: join(dir, 'defecto') });
    let t = Date.parse('2026-11-02T08:00:00Z');
    ok(await s.api.primerUso(PRIMER_USO));
    const copias = join(dir, 'copias'); mkdirSync(copias);
    ok(await s.api.guardarAjustes({ carpetaCopias: copias }));
    const automatica = ok(await s.crearCopiaAutomatica()).ruta;            // a las 08:00
    t += 3600_000;
    const nombre = automatica.split(/[\\/]/).pop()!;
    ok(await s.api.restaurarCopia(nombre, PASS));                            // crea la «antes de restaurar» a las 09:00 del mismo día
    const lista = ok(await s.api.listarCopias());
    assert.ok(lista.some((c) => c.nombre === nombre), 'la restaurada sigue en la lista');
    assert.ok(lista.some((c) => c.origen === 'antes_restaurar'));
    await s.cerrar();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
