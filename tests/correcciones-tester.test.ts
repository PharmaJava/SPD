/**
 * Fallos reportados por el tester clínico (cada prueba falla si se rompe la regla):
 * 1 fase de cada_n_dias/ciclo · 2 medicación «aparte» · 3 cruce de alertas normalizado ·
 * 4 huecos de pauta · 7 PRN emblistable · 9 criterio estricto de 14 días.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comprobarContinuidadPauta, tomasDelPeriodoVersiones, validarPauta } from '../src/dominio/calendario-pauta.ts';
import { evaluarPreparacion } from '../src/dominio/preparacion.ts';
import { envasesAfectados, trazabilidadInversa, claveCn, claveLote } from '../src/dominio/alertas-calidad.ts';
import type { Envase, Pauta } from '../src/dominio/tipos.ts';

const M = [{ id: 1, nombre: 'Desayuno', orden: 1 }, { id: 2, nombre: 'Cena', orden: 2 }];
const env = (id: number, cad: string, u: number, extra: Partial<Envase> = {}): Envase =>
  ({ id, tratamientoId: 1, cn: '123456', lote: 'L' + id, caducidad: cad, unidadesRestantes: u, estado: 'en_uso', ...extra });
const base = (o: object) => ({ desde: '2026-11-02', dias: 14, fechaPreparacion: '2026-11-02', momentos: M, rolValida: 'farmaceutico' as const, consentimiento: true, ...o }) as never;
const dia: Pauta = { vigenteDesde: '2026-01-01', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
const cods = (r: { bloqueos: { codigo: string }[] }) => r.bloqueos.map((b) => b.codigo);

// ───────── 1. fase de cada_n_dias / ciclo ─────────
test('1: cada_n_dias y ciclo EXIGEN fechaAncla', () => {
  const c: Pauta = { vigenteDesde: '2026-11-05', patron: 'cada_n_dias', cadaNDias: 7, dosis: [{ momentoId: 1, unidades: 2 }] };
  assert.ok(validarPauta(c).some((e) => /fechaAncla/.test(e)));
  assert.ok(validarPauta({ vigenteDesde: '2026-11-05', patron: 'ciclo', cicloOn: 5, cicloOff: 2, dosis: c.dosis }).some((e) => /fechaAncla/.test(e)));
  assert.deepEqual(validarPauta({ ...c, fechaAncla: '2026-10-26' }), []);
});

test('1: metotrexato semanal — una versión nueva con otra fase (dos dosis en 3 días) se detecta; con la ancla heredada no', () => {
  const A: Pauta = { vigenteDesde: '2026-10-26', vigenteHasta: '2026-11-04', patron: 'cada_n_dias', cadaNDias: 7, fechaAncla: '2026-10-26', dosis: [{ momentoId: 1, unidades: 1 }] };
  const malB: Pauta = { vigenteDesde: '2026-11-05', patron: 'cada_n_dias', cadaNDias: 7, fechaAncla: '2026-11-05', dosis: [{ momentoId: 1, unidades: 2 }] };
  const errores = comprobarContinuidadPauta([A], malB);
  assert.equal(errores.length, 1);
  assert.match(errores[0], /2026-11-02.*2026-11-05.*7 días/);
  const buenaB: Pauta = { ...malB, fechaAncla: '2026-10-26' };
  assert.deepEqual(comprobarContinuidadPauta([A], buenaB), []);
  assert.deepEqual(tomasDelPeriodoVersiones([A, buenaB], '2026-10-26', '2026-11-19').map((t) => t.fecha + 'x' + t.unidades),
    ['2026-10-26x1', '2026-11-02x1', '2026-11-09x2', '2026-11-16x2']);
});

test('1: pasar de diaria a semanal no es una rotura; un ciclo que no respeta su descanso sí', () => {
  const diaria: Pauta = { vigenteDesde: '2026-10-01', vigenteHasta: '2026-11-01', patron: 'diario', dosis: dia.dosis };
  const sem: Pauta = { vigenteDesde: '2026-11-02', patron: 'cada_n_dias', cadaNDias: 7, fechaAncla: '2026-11-02', dosis: dia.dosis };
  assert.deepEqual(comprobarContinuidadPauta([diaria], sem), []);
  const ciclo: Pauta = { vigenteDesde: '2026-10-01', vigenteHasta: '2026-10-05', patron: 'ciclo', cicloOn: 5, cicloOff: 3, fechaAncla: '2026-10-01', dosis: dia.dosis };
  // última toma 5-oct; el nuevo ciclo (ancla 7-oct) tocaría ya el 7-oct: solo 1 día libre de los 3 de descanso
  const nuevo: Pauta = { ...ciclo, vigenteDesde: '2026-10-06', vigenteHasta: undefined, fechaAncla: '2026-10-07' };
  assert.ok(comprobarContinuidadPauta([ciclo], nuevo).some((e) => /descanso/.test(e)));
  const seguido: Pauta = { ...nuevo, fechaAncla: '2026-10-01' };           // misma fase: descansa 6,7,8 y vuelve el 9
  assert.deepEqual(comprobarContinuidadPauta([ciclo], seguido), []);
});

// ───────── 2. medicación «aparte» ─────────
const aparte = (envases: Envase[], extra: object = {}) =>
  ({ tratamientoId: 2, nombre: 'Insulina', emblistable: false, versiones: [{ ...dia }], envases: envases.map((e) => ({ ...e, tratamientoId: 2 })), ...extra });
const emb = { tratamientoId: 1, nombre: 'Crónico', versiones: [dia], envases: [env(1, '2029-12-31', 100)] };

test('2: «aparte» con caja caducada antes del fin del periodo bloquea', () => {
  const r = evaluarPreparacion(base({ tratamientos: [emb, aparte([env(9, '2026-10-01', 3)])] }));
  assert.ok(cods(r).includes('APARTE_CAJA_CADUCADA'), JSON.stringify(r.bloqueos));
  assert.equal(r.validable, false);
  assert.equal(evaluarPreparacion(base({ tratamientos: [emb, aparte([env(9, '2027-12-31', 3)])] })).validable, true);
});

test('2: «aparte» con alerta de calidad en su caja bloquea (CN y lote normalizados)', () => {
  const r = evaluarPreparacion(base({ tratamientos: [emb, aparte([env(9, '2027-12-31', 3, { lote: 'INS-01' })])], alertas: [{ referencia: 'R_I', lote: 'ins 1' }] }));
  assert.ok(cods(r).includes('APARTE_ALERTA_CALIDAD'), JSON.stringify(r.bloqueos));
  assert.match(r.bloqueos.find((b) => b.codigo === 'APARTE_ALERTA_CALIDAD')!.texto, /R_I/);
});

test('2: la caducidad de la medicación aparte acota la caducidad del SPD', () => {
  const r = evaluarPreparacion(base({ tratamientos: [emb, aparte([env(9, '2026-11-20', 3)])] }));
  assert.equal(r.caducidadSpd?.caducidadSpd, '2026-11-15');   // 14 días: la caja (20-nov) no acota
  const r2 = evaluarPreparacion(base({ desde: '2026-11-02', dias: 10, tratamientos: [emb, aparte([env(9, '2026-11-12', 3)])] }));
  assert.equal(r2.caducidadSpd?.caducidadSpd, '2026-11-12');
  assert.equal(r2.caducidadSpd?.limitadaPor, 'lote');
  assert.equal(r2.validable, true, JSON.stringify(r2.bloqueos));
});

test('2: trazabilidad inversa incluye las cajas «aparte» sin depender de preparacion_linea', () => {
  const ctx = { envases: [env(9, '2027-12-31', 3, { lote: 'INS1', cn: '999999', pacienteId: 7, aparte: true })], lineasPreparacion: [], preparaciones: [], entregas: [] };
  const t = trazabilidadInversa([{ referencia: 'R_I', lote: 'INS1' }], ctx)[0];
  assert.deepEqual(t.pacientesAAvisar, [7]);
  assert.deepEqual(t.envasesAparte.map((x) => x.envaseId), [9]);
  assert.deepEqual(t.envasesARetirar, [9]);
  // una caja emblistable sin líneas NO avisa a nadie
  const t2 = trazabilidadInversa([{ referencia: 'R', lote: 'INS1' }], { ...ctx, envases: [{ ...ctx.envases[0], aparte: undefined }] })[0];
  assert.deepEqual(t2.pacientesAAvisar, []);
});

// ───────── 3. cruce de alertas normalizado ─────────
test('3: lote — separadores, espacios, ceros iniciales y mayúsculas casan; L1 y L10 NO', () => {
  for (const l of ['L1', ' l1 ', 'L-1', 'L01', 'L 1', 'l.001', 'L/1']) {
    assert.equal(envasesAfectados([env(1, '2027-12-31', 10, { lote: 'L1' })], [{ referencia: 'R', lote: l }]).afectados.length, 1, l);
    assert.equal(envasesAfectados([env(1, '2027-12-31', 10, { lote: l })], [{ referencia: 'R', lote: 'L1' }]).afectados.length, 1, 'caja ' + l);
  }
  for (const l of ['L10', 'L11', 'L100', 'LO1', 'LI']) {
    assert.equal(envasesAfectados([env(1, '2027-12-31', 10, { lote: 'L1' })], [{ referencia: 'R', lote: l }]).afectados.length, 0, l);
  }
  assert.equal(claveLote('AB-00-12'), 'AB12');
});

test('3: CN con/sin ceros iniciales, con control o dentro de un EAN casan; otro CN no', () => {
  const e = [env(1, '2027-12-31', 10, { cn: '012345' })];
  for (const c of ['12345', '012345', '0123456', 'C.N. 012345']) {
    assert.equal(envasesAfectados(e, [{ referencia: 'R', cn: c }]).afectados.length, 1, c);
  }
  assert.equal(envasesAfectados([env(1, '2027-12-31', 10, { cn: '12345' })], [{ referencia: 'R', cn: '012345' }]).afectados.length, 1);
  assert.equal(envasesAfectados(e, [{ referencia: 'R', cn: '123456' }]).afectados.length, 0);
  assert.equal(claveCn('654321'), '654321');
});

test('3: alerta por CN sin ninguna caja en el sistema → aviso informativo; con cajas, no', () => {
  const ctx = (envases: Envase[]) => ({ envases, lineasPreparacion: [], preparaciones: [], entregas: [] });
  const sin = trazabilidadInversa([{ referencia: 'R9', cn: '777777' }], ctx([env(1, '2027-12-31', 10)]))[0];
  assert.equal(sin.sinCajasEnSistema, true);
  assert.ok(sin.avisos.some((a) => /Informativo.*R9.*ninguna caja/.test(a)));
  assert.equal(trazabilidadInversa([{ referencia: 'R9', cn: '123456' }], ctx([env(1, '2027-12-31', 10)]))[0].sinCajasEnSistema, false);
  assert.equal(trazabilidadInversa([{ referencia: 'R9', lote: 'NOEXISTE' }], ctx([env(1, '2027-12-31', 10)]))[0].sinCajasEnSistema, false);
});

// ───────── 4. huecos de pauta ─────────
test('4: pauta temporal que corta la crónica: hueco interior BLOQUEA, hueco al final AVISA', () => {
  const cro: Pauta = { ...dia, vigenteHasta: '2026-11-03' };
  const tmp: Pauta = { vigenteDesde: '2026-11-04', vigenteHasta: '2026-11-08', patron: 'diario', dosis: [{ momentoId: 1, unidades: 2 }] };
  const fin = evaluarPreparacion(base({ tratamientos: [{ ...emb, versiones: [cro, tmp] }] }));
  assert.equal(fin.validable, true, JSON.stringify(fin.bloqueos));
  const av = fin.avisos.find((a) => a.codigo === 'PAUTA_SIN_COBERTURA');
  assert.ok(av, 'debe avisar'); assert.match(av!.texto, /2026-11-09 a 2026-11-15/);
  // hueco entre dos versiones
  const hueco = evaluarPreparacion(base({ tratamientos: [{ ...emb, versiones: [{ ...dia, vigenteHasta: '2026-11-05' }, { ...dia, vigenteDesde: '2026-11-09' }] }] }));
  assert.ok(cods(hueco).includes('PAUTA_CON_HUECOS'), JSON.stringify(hueco.bloqueos));
  assert.match(hueco.bloqueos.find((b) => b.codigo === 'PAUTA_CON_HUECOS')!.texto, /2026-11-06 a 2026-11-08/);
  // sin huecos: nada
  const ok = evaluarPreparacion(base({ tratamientos: [{ ...emb, versiones: [{ ...dia, vigenteHasta: '2026-11-05' }, { ...dia, vigenteDesde: '2026-11-06' }] }] }));
  assert.equal(ok.avisos.some((a) => a.codigo === 'PAUTA_SIN_COBERTURA'), false);
  assert.equal(cods(ok).includes('PAUTA_CON_HUECOS'), false);
});

// ───────── 7. PRN emblistable ─────────
test('7: «si precisa» marcado emblistable sale SIEMPRE como «a demanda» (con sus cajas comprobadas)', () => {
  const prn = { tratamientoId: 2, nombre: 'PRN', versiones: [{ ...dia, patron: 'si_precisa' as const }], envases: [env(5, '2027-12-31', 10, { tratamientoId: 2 })] };
  const r = evaluarPreparacion(base({ tratamientos: [emb, prn] }));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.deepEqual(r.aparte, [{ tratamientoId: 2, nombre: 'PRN', ademanda: true }]);
  assert.ok(r.avisos.some((a) => a.codigo === 'A_DEMANDA'));
  assert.equal(r.tomas.filter((t) => t.tratamientoId === 2).length, 0);
  const cad = evaluarPreparacion(base({ tratamientos: [emb, { ...prn, envases: [env(5, '2026-10-01', 10, { tratamientoId: 2 })] }] }));
  assert.ok(cods(cad).includes('APARTE_CAJA_CADUCADA'));
  assert.equal(evaluarPreparacion(base({ tratamientos: [emb] })).aparte.length, 0);
});

// ───────── 9. criterio estricto de 14 días ─────────
test('9: validez 14 = 14 días naturales contando el de la preparación; 15 de periodo bloquea', () => {
  const t = [{ ...emb, envases: [env(1, '2029-12-31', 100)] }];
  const ok = evaluarPreparacion(base({ tratamientos: t, dias: 14 }));
  assert.equal(ok.caducidadSpd?.caducidadSpd, '2026-11-15');
  assert.equal(ok.validable, true, JSON.stringify(ok.bloqueos));
  const ko = evaluarPreparacion(base({ tratamientos: t, dias: 15 }));
  assert.ok(cods(ko).includes('PERIODO_NO_CABE'));
  assert.match(ko.bloqueos.find((b) => b.codigo === 'PERIODO_NO_CABE')!.texto, /14 días naturales contando el de la preparación/);
});
