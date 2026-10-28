import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envasesAfectados, trazabilidadInversa, claveLote } from '../src/dominio/alertas-calidad.ts';
import type { AlertaCalidad } from '../src/dominio/alertas-calidad.ts';
import { repartirUnidades, repartirTomas } from '../src/dominio/consumo-envases.ts';
import type { Envase } from '../src/dominio/tipos.ts';

const caja = (id: number, lote: string, cn = '654321', extra: Partial<Envase> = {}): Envase => ({
  id, tratamientoId: 1, cn, lote, caducidad: '2028-01-31', unidadesRestantes: 30, estado: 'en_uso', ...extra,
});
const al = (referencia: string, extra: Partial<AlertaCalidad> = {}): AlertaCalidad => ({ referencia, ...extra });
const ids = (r: { afectados: { envase: Envase }[] }) => r.afectados.map((a) => a.envase.id);

// ── Coincidencias ───────────────────────────────────────────────────────────
test('cn+lote: casa sólo la caja con ambos', () => {
  const r = envasesAfectados([caja(1, 'A1'), caja(2, 'A1', '111111'), caja(3, 'B2')], [al('R1', { cn: '654321', lote: 'A1' })]);
  assert.deepEqual(ids(r), [1]);
});
test('lote sin distinguir mayúsculas', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, 'ab12')], [al('R1', { cn: '654321', lote: 'AB12' })])), [1]);
});
test('lote con espacios sobrantes en alerta y en caja', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, ' ab12 ')], [al('R1', { lote: '  AB12' })])), [1]);
});
test('sólo lote: casa en cualquier medicamento', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, 'X'), caja(2, 'X', '111111'), caja(3, 'Y')], [al('R1', { lote: 'x' })])), [1, 2]);
});
test('cn sin lote: todos los lotes de ese CN', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, 'X'), caja(2, 'Y'), caja(3, 'X', '111111')], [al('R1', { cn: '654321' })])), [1, 2]);
});
test('cn de la alerta con dígito de control o formato C.N. también casa', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, 'X')], [al('R1', { cn: 'C.N. 654321.7' })])), [1]);
});
test('lote parecido no casa (no hay coincidencia parcial)', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, 'AB12'), caja(2, 'AB123')], [al('R1', { lote: 'AB12' })])), [1]);
});
test('cn distinto con mismo lote no casa si la alerta trae cn', () => {
  assert.equal(envasesAfectados([caja(1, 'A', '111111')], [al('R1', { cn: '654321', lote: 'A' })]).afectados.length, 0);
});
test('ninguna alerta: nada afectado ni avisos', () => {
  const r = envasesAfectados([caja(1, 'A')], []);
  assert.deepEqual(r, { afectados: [], avisos: [] });
});
test('alerta sin cn ni lote: se ignora y se avisa (no bloquea todo)', () => {
  const r = envasesAfectados([caja(1, 'A')], [al('R9'), al('R8', { lote: '   ' })]);
  assert.equal(r.afectados.length, 0);
  assert.equal(r.avisos.length, 2);
  assert.match(r.avisos[0], /R9/);
});
test('cn ilegible: no casa y se avisa', () => {
  const r = envasesAfectados([caja(1, 'A')], [al('R7', { cn: 'abc' })]);
  assert.equal(r.afectados.length, 0);
  assert.match(r.avisos[0], /R7/);
});
test('cn ilegible + lote coincidente NO bloquea por lote (no se adivina)', () => {
  assert.equal(envasesAfectados([caja(1, 'A')], [al('R7', { cn: 'abc', lote: 'A' })]).afectados.length, 0);
});
test('una caja con dos alertas aparece una vez con las dos', () => {
  const r = envasesAfectados([caja(1, 'A')], [al('R1', { lote: 'A' }), al('R2', { cn: '654321' })]);
  assert.equal(r.afectados.length, 1);
  assert.deepEqual(r.afectados[0].alertas.map((a) => a.referencia), ['R1', 'R2']);
});
test('incluye cajas de cualquier estado', () => {
  assert.deepEqual(ids(envasesAfectados([caja(1, 'A', '654321', { estado: 'agotado' })], [al('R1', { lote: 'A' })])), [1]);
});
test('claveLote', () => {
  assert.equal(claveLote(' ab '), 'AB');
  assert.equal(claveLote(undefined), '');
});

// ── Trazabilidad inversa ────────────────────────────────────────────────────
const prep = (id: number, pacienteId: number, estado: string) => ({ id, pacienteId, estado, fechaInicio: '2026-11-02', fechaFin: '2026-11-15' });
const lin = (preparacionId: number, envaseId: number) => ({ preparacionId, envaseId, unidades: 1 });
const ctxBase = () => ({
  envases: [caja(1, 'MALO'), caja(2, 'MALO', '654321', { estado: 'agotado' }), caja(3, 'BUENO')],
  lineasPreparacion: [lin(10, 1), lin(10, 1), lin(11, 2), lin(12, 2), lin(13, 1), lin(14, 3)],
  preparaciones: [prep(10, 100, 'preparado'), prep(11, 101, 'entregado'), prep(12, 102, 'anulado'), prep(13, 103, 'validado'), prep(14, 104, 'entregado')],
  entregas: [{ preparacionId: 11, entregadoEn: '2026-11-03 10:00' }, { preparacionId: 14, entregadoEn: '2026-11-03 11:00' }],
});

test('traza: envase en custodia → retirar', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], ctxBase());
  assert.deepEqual(t.envases.map((e) => e.id), [1, 2]);
  assert.deepEqual(t.envasesARetirar, [1]);
});
test('traza: preparada/validada no entregada → rehacer', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], ctxBase());
  const p10 = t.preparaciones.find((p) => p.preparacionId === 10)!;
  const p13 = t.preparaciones.find((p) => p.preparacionId === 13)!;
  assert.equal(p10.actuacion, 'rehacer_blister_no_entregado');
  assert.equal(p13.actuacion, 'rehacer_blister_no_entregado');
  assert.equal(p10.entregado, false);
});
test('traza: entregada → avisar al paciente', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], ctxBase());
  const p11 = t.preparaciones.find((p) => p.preparacionId === 11)!;
  assert.equal(p11.actuacion, 'avisar_paciente_entregado');
  assert.equal(p11.entregado, true);
  assert.equal(p11.entregadoEn, '2026-11-03 10:00');
  assert.deepEqual(t.pacientesAAvisar, [101]);
});
test('traza: anulada sin entrega → sin actuación', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], ctxBase());
  assert.equal(t.preparaciones.find((p) => p.preparacionId === 12)!.actuacion, null);
});
test('traza: no incluye preparaciones de cajas no afectadas', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], ctxBase());
  assert.equal(t.preparaciones.some((p) => p.preparacionId === 14), false);
});
test('traza: una preparación con varias líneas del mismo envase sale una vez', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], ctxBase());
  assert.equal(t.preparaciones.filter((p) => p.preparacionId === 10).length, 1);
  assert.deepEqual(t.preparaciones.find((p) => p.preparacionId === 10)!.envaseIds, [1]);
});
test('traza: preparación con dos envases afectados lista ambos', () => {
  const c = ctxBase();
  c.lineasPreparacion.push(lin(10, 2));
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.deepEqual(t.preparaciones.find((p) => p.preparacionId === 10)!.envaseIds, [1, 2]);
});
test('traza: entrega registrada con estado no entregado → se trata como entregada y avisa', () => {
  const c = ctxBase();
  c.entregas.push({ preparacionId: 10, entregadoEn: '2026-11-04 09:00' });
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.equal(t.preparaciones.find((p) => p.preparacionId === 10)!.actuacion, 'avisar_paciente_entregado');
  assert.ok(t.avisos.some((a) => /preparación 10/.test(a)));
});
test('traza: anulada pero con entrega → avisar (lado seguro)', () => {
  const c = ctxBase();
  c.entregas.push({ preparacionId: 12, entregadoEn: '2026-11-04 09:00' });
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.equal(t.preparaciones.find((p) => p.preparacionId === 12)!.actuacion, 'avisar_paciente_entregado');
});
test('traza: estado entregado sin registro de entrega → entregada y avisa', () => {
  const c = ctxBase();
  c.entregas = [];
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  const p = t.preparaciones.find((x) => x.preparacionId === 11)!;
  assert.equal(p.entregado, true);
  assert.equal(p.entregadoEn, null);
  assert.ok(t.avisos.some((a) => /11/.test(a)));
});
test('traza: varias entregas → la más reciente', () => {
  const c = ctxBase();
  c.entregas.push({ preparacionId: 11, entregadoEn: '2026-11-05 10:00' });
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.equal(t.preparaciones.find((p) => p.preparacionId === 11)!.entregadoEn, '2026-11-05 10:00');
});
test('traza: línea de preparación inexistente → aviso, no revienta', () => {
  const c = ctxBase();
  c.lineasPreparacion.push(lin(99, 1));
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.ok(t.avisos.some((a) => /preparación 99/.test(a)));
});
test('traza: alerta sin datos → sin nada y con aviso', () => {
  const [t] = trazabilidadInversa([al('R0')], ctxBase());
  assert.deepEqual(t.envases, []);
  assert.deepEqual(t.preparaciones, []);
  assert.equal(t.avisos.length, 1);
});
test('traza: alerta que no casa → vacía sin avisos', () => {
  const [t] = trazabilidadInversa([al('R1', { lote: 'NOEXISTE' })], ctxBase());
  assert.deepEqual(t.envasesARetirar, []);
  assert.deepEqual(t.avisos, []);
});
test('traza: ninguna alerta → []', () => {
  assert.deepEqual(trazabilidadInversa([], ctxBase()), []);
});
test('traza: un resultado por alerta, en orden', () => {
  const r = trazabilidadInversa([al('R1', { lote: 'MALO' }), al('R2', { lote: 'BUENO' })], ctxBase());
  assert.deepEqual(r.map((t) => t.alerta.referencia), ['R1', 'R2']);
  assert.deepEqual(r[1].pacientesAAvisar, [104]);
});
test('traza: un paciente con dos blísteres entregados sale una vez', () => {
  const c = ctxBase();
  c.preparaciones.push(prep(15, 101, 'entregado'));
  c.lineasPreparacion.push(lin(15, 1));
  const [t] = trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.deepEqual(t.pacientesAAvisar, [101]);
});
test('traza: no muta la entrada', () => {
  const c = ctxBase();
  const copia = JSON.stringify(c);
  trazabilidadInversa([al('R1', { lote: 'MALO' })], c);
  assert.equal(JSON.stringify(c), copia);
});

// ── Rendimiento ─────────────────────────────────────────────────────────────
test('rendimiento: 10.000 envases y 5.000 alertas en < 200 ms', () => {
  const envases: Envase[] = [];
  const lineas = [];
  const preps = [];
  for (let i = 1; i <= 10000; i++) {
    envases.push(caja(i, `L${i % 3000}`, String(100000 + (i % 500))));
    lineas.push(lin(i, i));
    preps.push(prep(i, i % 700, i % 3 === 0 ? 'entregado' : 'preparado'));
  }
  const alertas = Array.from({ length: 5000 }, (_, i) => al(`R${i}`, i % 2 ? { lote: `l${i % 3000}` } : { cn: String(100000 + (i % 500)), lote: `L${i % 3000}` }));
  const t0 = performance.now();
  const r = trazabilidadInversa(alertas, { envases, lineasPreparacion: lineas, preparaciones: preps, entregas: [] });
  const a = envasesAfectados(envases, alertas);
  const ms = performance.now() - t0;
  assert.equal(r.length, 5000);
  assert.ok(a.afectados.length > 0);
  assert.ok(ms < 200, `tardó ${ms} ms`);
});

// ── Consumo con alertas ─────────────────────────────────────────────────────
const op = { fechaPreparacion: '2026-11-02', fechaFinPeriodo: '2026-11-15' };

test('consumo: sin la opción no cambia nada (retrocompatible)', () => {
  const r = repartirUnidades([caja(1, 'MALO'), caja(2, 'BUENO')], 10, op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 10 }]);
  assert.deepEqual(r.avisos, []);
});
test('consumo: alertas vacías = sin opción', () => {
  const r = repartirUnidades([caja(1, 'MALO')], 10, { ...op, alertas: [] });
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 10 }]);
});
test('consumo: excluye la caja con alerta y cita la referencia', () => {
  const r = repartirUnidades([caja(1, 'MALO'), caja(2, 'BUENO')], 10, { ...op, alertas: [al('R_21/2026', { lote: 'malo' })] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 10 }]);
  assert.ok(r.avisos.some((a) => a.includes('R_21/2026') && a.includes('caja 1')));
});
test('consumo: si por la alerta faltan unidades → ok:false', () => {
  const r = repartirUnidades([caja(1, 'MALO', '654321', { unidadesRestantes: 30 }), caja(2, 'BUENO', '654321', { unidadesRestantes: 4 })], 10, { ...op, alertas: [al('R1', { lote: 'MALO' })] });
  assert.equal(r.ok, false);
  assert.equal(r.faltan, 6);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 4 }]);
});
test('consumo: todas las cajas con alerta → nada asignado, faltan todas', () => {
  const r = repartirUnidades([caja(1, 'MALO')], 5, { ...op, alertas: [al('R1', { cn: '654321' })] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.asignaciones, []);
  assert.equal(r.faltan, 5);
});
test('consumo: alerta que no casa no cambia el reparto', () => {
  const r = repartirUnidades([caja(1, 'A')], 5, { ...op, alertas: [al('R1', { lote: 'Z' })] });
  assert.equal(r.ok, true);
});
test('consumo: alerta sin datos avisa y no excluye', () => {
  const r = repartirUnidades([caja(1, 'A')], 5, { ...op, alertas: [al('R5')] });
  assert.equal(r.ok, true);
  assert.ok(r.avisos.some((a) => a.includes('R5')));
});
test('consumo (tomas): excluye la caja con alerta', () => {
  const tomas = [{ fecha: '2026-11-02', momentoId: 1, unidades: 1 }, { fecha: '2026-11-03', momentoId: 1, unidades: 1 }];
  const r = repartirTomas([caja(1, 'MALO'), caja(2, 'BUENO')], tomas, { ...op, alertas: [al('R1', { lote: 'MALO' })] });
  assert.equal(r.ok, true);
  assert.ok(r.lineas.every((l) => l.envaseId === 2));
  assert.ok(r.avisos.some((a) => a.includes('R1')));
});
test('consumo (tomas): sin la opción usa la caja con alerta (retrocompatible)', () => {
  const tomas = [{ fecha: '2026-11-02', momentoId: 1, unidades: 1 }];
  const r = repartirTomas([caja(1, 'MALO'), caja(2, 'BUENO')], tomas, op);
  assert.equal(r.lineas[0].envaseId, 1);
});
test('consumo (tomas): faltan unidades por la alerta → ok:false', () => {
  const tomas = [{ fecha: '2026-11-02', momentoId: 1, unidades: 2 }];
  const r = repartirTomas([caja(1, 'MALO')], tomas, { ...op, alertas: [al('R1', { lote: 'MALO' })] });
  assert.equal(r.ok, false);
  assert.equal(r.faltan, 2);
});
