import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tomasDelPeriodo, tomasDelPeriodoVersiones } from '../src/dominio/calendario-pauta.ts';
import { evaluarPreparacion } from '../src/dominio/preparacion.ts';
import type { EntradaPreparacion, TratamientoPreparacion } from '../src/dominio/preparacion.ts';
import { estadoConsentimientos } from '../src/dominio/documentos.ts';
import { ubicarToma } from '../src/dominio/disposicion-blister.ts';
import type { Envase, MomentoToma, Pauta, TomaDia } from '../src/dominio/tipos.ts';

// ───────────────────────── datos comunes (mismos que tests/integracion.test.ts) ─────────────────────────
const INICIO = '2026-11-04';              // miércoles
const FIN_14 = '2026-11-17';
const PREPARACION = '2026-11-03';
const MOMENTOS: MomentoToma[] = [
  { id: 1, nombre: 'Desayuno', orden: 1 },
  { id: 2, nombre: 'Comida', orden: 2 },
  { id: 3, nombre: 'Cena', orden: 3 },
];
const MS = 86_400_000;
const sumar = (f: string, n: number) => new Date(Date.parse(f + 'T00:00:00Z') + n * MS).toISOString().slice(0, 10);
const cuartos = (xs: { unidades: number }[]) => xs.reduce((s, x) => s + Math.round(x.unidades * 4), 0) / 4;
const codigos = (r: { bloqueos: { codigo: string }[] }) => r.bloqueos.map(b => b.codigo);

const caja = (id: number, trat: number, lote: string, cad: string, u: number, extra: Partial<Envase> = {}): Envase =>
  ({ id, tratamientoId: trat, cn: '712729', lote, caducidad: cad, unidadesRestantes: u, estado: 'en_uso', ...extra });

const PAUTA_METFORMINA: Pauta = { vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1.5 }, { momentoId: 3, unidades: 1 }] };
const PAUTA_ALENDRONATO: Pauta = { vigenteDesde: INICIO, patron: 'dias_semana', diasSemana: [1], dosis: [{ momentoId: 1, unidades: 1 }] };
const PAUTA_CICLO: Pauta = { vigenteDesde: INICIO, patron: 'ciclo', cicloOn: 5, cicloOff: 2, fechaAncla: INICIO, dosis: [{ momentoId: 3, unidades: 1 }] };

function medicamentosA(): TratamientoPreparacion[] {
  return [
    { tratamientoId: 1, nombre: 'Metformina 850 mg', versiones: [PAUTA_METFORMINA],
      envases: [caja(11, 1, 'M-A', '2027-02-28', 12), caja(12, 1, 'M-B', '2026-12-31', 8.5), caja(13, 1, 'M-C', '2028-01-31', 20)] },
    { tratamientoId: 2, nombre: 'Alendronato 70 mg', versiones: [PAUTA_ALENDRONATO], envases: [caja(21, 2, 'AL1', '2027-11-30', 4)] },
    { tratamientoId: 3, nombre: 'Ciclo 5+2', versiones: [PAUTA_CICLO], envases: [caja(31, 3, 'CI1', '2027-09-30', 30)] },
  ];
}

/** Entrada completa y válida; `o` la modifica. */
function entrada(o: Partial<EntradaPreparacion> = {}): EntradaPreparacion {
  return {
    desde: INICIO, dias: 14, fechaPreparacion: PREPARACION, momentos: MOMENTOS,
    tratamientos: medicamentosA(), rolValida: 'farmaceutico', consentimiento: true, ...o,
  };
}
const solo = (t: TratamientoPreparacion, o: Partial<EntradaPreparacion> = {}) => entrada({ tratamientos: [t], ...o });

const V1: Pauta = { vigenteDesde: INICIO, vigenteHasta: '2026-11-10', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
const V2: Pauta = { vigenteDesde: '2026-11-11', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }, { momentoId: 3, unidades: 0.5 }] };

// ═════════════════════════ tomasDelPeriodoVersiones ═════════════════════════

test('versiones: una sola versión equivale a tomasDelPeriodo', () => {
  assert.deepEqual(tomasDelPeriodoVersiones([PAUTA_METFORMINA], INICIO, FIN_14), tomasDelPeriodo(PAUTA_METFORMINA, INICIO, FIN_14));
});

test('versiones: cambio a mitad de periodo, una sola pauta por día (21 y no 28)', () => {
  const v1: Pauta = { vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };     // sin vigenteHasta
  const v2: Pauta = { vigenteDesde: '2026-11-11', patron: 'diario', dosis: [{ momentoId: 1, unidades: 2 }] };
  const t = tomasDelPeriodoVersiones([v1, v2], INICIO, FIN_14);
  assert.equal(cuartos(t), 21);
  assert.equal(t.length, 14);                                  // sin duplicar días
  assert.equal(new Set(t.map(x => x.fecha)).size, 14);
  assert.ok(t.filter(x => x.fecha < '2026-11-11').every(x => x.unidades === 1));
  assert.ok(t.filter(x => x.fecha >= '2026-11-11').every(x => x.unidades === 2));
});

test('versiones: el orden de la lista no importa (manda la vigenteDesde más reciente)', () => {
  const v1: Pauta = { vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  const v2: Pauta = { vigenteDesde: '2026-11-11', patron: 'diario', dosis: [{ momentoId: 1, unidades: 2 }] };
  assert.deepEqual(tomasDelPeriodoVersiones([v2, v1], INICIO, FIN_14), tomasDelPeriodoVersiones([v1, v2], INICIO, FIN_14));
});

test('versiones: hueco entre versiones = sin tomas esos días', () => {
  const a: Pauta = { vigenteDesde: INICIO, vigenteHasta: '2026-11-06', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  const b: Pauta = { vigenteDesde: '2026-11-09', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  const f = tomasDelPeriodoVersiones([a, b], INICIO, '2026-11-10').map(x => x.fecha);
  assert.deepEqual(f, ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10']);
});

test('versiones: sin versiones, o ninguna vigente, devuelve []', () => {
  assert.deepEqual(tomasDelPeriodoVersiones([], INICIO, FIN_14), []);
  const futura: Pauta = { vigenteDesde: '2027-01-01', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  assert.deepEqual(tomasDelPeriodoVersiones([futura], INICIO, FIN_14), []);
});

test('versiones: respeta los errores existentes (rango invertido, >366 días, fechas, pauta mala)', () => {
  assert.throws(() => tomasDelPeriodoVersiones([V1], '2026-11-10', '2026-11-04'), /invertido/);
  assert.throws(() => tomasDelPeriodoVersiones([V1], '2026-01-01', '2027-01-02'), /máximo/);
  assert.doesNotThrow(() => tomasDelPeriodoVersiones([], '2026-01-01', '2026-12-31'));       // 365 días
  assert.throws(() => tomasDelPeriodoVersiones([V1], '2026-02-30', '2026-03-05'), /fecha/);
  const mala: Pauta = { vigenteDesde: INICIO, patron: 'dias_semana', dosis: [{ momentoId: 1, unidades: 1 }] };
  assert.throws(() => tomasDelPeriodoVersiones([mala], INICIO, FIN_14), /Pauta no válida/);
  assert.throws(() => tomasDelPeriodoVersiones('x' as unknown as Pauta[], INICIO, FIN_14));
});

test('versiones: si_precisa nunca toca y una versión cambia el patrón a mitad', () => {
  const a: Pauta = { vigenteDesde: INICIO, vigenteHasta: '2026-11-10', patron: 'si_precisa', dosis: [{ momentoId: 1, unidades: 1 }] };
  const b: Pauta = { vigenteDesde: '2026-11-11', patron: 'dias_semana', diasSemana: [1], dosis: [{ momentoId: 1, unidades: 1 }] };
  assert.deepEqual(tomasDelPeriodoVersiones([a, b], INICIO, FIN_14).map(x => x.fecha), ['2026-11-16']);
});

// ═════════════════════════ (a) escenario completo ═════════════════════════

test('(a) preparación completa: validable, 47 unidades, mapas, caducidad 14 días', () => {
  const r = evaluarPreparacion(entrada());
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.deepEqual(r.bloqueos, []);
  assert.equal(r.unidadesEsperadas, 47);
  assert.equal(r.unidadesAsignadas, 47);
  assert.equal(r.mapas.length, 2);
  assert.equal(r.finPeriodo, FIN_14);
  assert.equal(r.caducidadSpd?.ok, true);
  assert.equal(r.caducidadSpd?.caducidadSpd, '2026-11-17');
  assert.equal(r.caducidadSpd?.limitadaPor, 'validez');
  assert.equal(r.caducidadSpd?.fueraDeEstandar, false);
  assert.deepEqual(r.aparte, []);
  assert.deepEqual(r.faltantes, []);
});

test('(a) tomas por medicamento: 35, 2 y 10 unidades', () => {
  const r = evaluarPreparacion(entrada());
  const por = (id: number) => cuartos(r.tomas.filter(t => t.tratamientoId === id));
  assert.deepEqual([por(1), por(2), por(3)], [35, 2, 10]);
  assert.deepEqual(r.tomas.filter(t => t.tratamientoId === 2).map(t => t.fecha), ['2026-11-09', '2026-11-16']);
  const porLinea = (id: number) => cuartos(r.lineasReparto.filter(l => l.tratamientoId === id));
  assert.deepEqual([porLinea(1), porLinea(2), porLinea(3)], [35, 2, 10]);
});

test('(a) invariante: cada toma tiene celda en el mapa, en los dos modos de inicio', () => {
  for (const inicioDia of ['convencional', 'cronologico'] as const) {
    const r = evaluarPreparacion(entrada({ disposicion: { inicioDia } }));
    assert.equal(r.validable, true, `${inicioDia}: ${JSON.stringify(r.bloqueos)}`);
    for (const t of r.tomas) assert.ok(ubicarToma(r.mapas, t.fecha, t.momentoId), `${inicioDia}: ${t.fecha} m${t.momentoId}`);
    assert.equal(r.mapas.flatMap(m => m.celdas.filter(c => c.usada)).length, 14 * MOMENTOS.length);
  }
});

test('(a) FEFO entre tres lotes y dos tomas con dos lotes (avisadas)', () => {
  const r = evaluarPreparacion(solo(medicamentosA()[0]));
  const porCaja = new Map<number, number>();
  for (const l of r.lineasReparto) porCaja.set(l.envaseId, (porCaja.get(l.envaseId) ?? 0) + l.unidades);
  assert.equal(porCaja.get(12), 8.5);
  assert.equal(porCaja.get(11), 12);
  assert.equal(porCaja.get(13), 14.5);
  assert.equal(r.avisos.filter(a => a.codigo === 'TOMA_DOS_LOTES').length, 2);
  assert.equal(r.validable, true);
});

test('(a) cada línea del reparto lleva lote y caducidad de su caja', () => {
  const r = evaluarPreparacion(entrada());
  const cajas = new Map(medicamentosA().flatMap(t => t.envases).map(e => [e.id, e]));
  assert.ok(r.lineasReparto.length > 0);
  for (const l of r.lineasReparto) {
    const c = cajas.get(l.envaseId)!;
    assert.equal(l.lote, c.lote);
    assert.equal(l.caducidad, c.caducidad);
  }
});

test('(a) avisos de pauta: semanal y fracciones, sin repetirse', () => {
  const r = evaluarPreparacion(entrada());
  const textos = r.avisos.filter(a => a.codigo === 'PAUTA_AVISO').map(a => a.texto);
  assert.ok(textos.some(t => t.includes('Alendronato') && t.includes('PAUTA SEMANAL')));
  assert.ok(textos.some(t => t.includes('Metformina') && t.includes('fracciones')));
  assert.ok(textos.some(t => t.includes('Ciclo') && t.includes('ciclos')));
  assert.equal(new Set(textos).size, textos.length);
});

// ═════════════════════════ (b) cambio de pauta ═════════════════════════

test('(b) cambio de pauta a mitad de periodo: 17,5 unidades, validable', () => {
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'Cambio', versiones: [V1, V2], envases: [caja(1, 1, 'X1', '2027-06-30', 20)] };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.unidadesEsperadas, 17.5);
  assert.equal(r.unidadesAsignadas, 17.5);
  assert.equal(r.tomas.filter(x => x.momentoId === 3).length, 7);
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
});

test('(b) versión antigua sin vigenteHasta: la suma por días cuadra (21, no 28)', () => {
  const v1: Pauta = { vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  const v2: Pauta = { vigenteDesde: '2026-11-11', patron: 'diario', dosis: [{ momentoId: 1, unidades: 2 }] };
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'Mínimo', versiones: [v1, v2], envases: [caja(1, 1, 'X', '2027-06-30', 21)] };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.unidadesEsperadas, 21);
  assert.equal(r.unidadesAsignadas, 21);
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  // con 21 unidades justas; si se contara 28 faltarían 7
  const corta = evaluarPreparacion(solo({ ...t, envases: [caja(1, 1, 'X', '2027-06-30', 20)] }));
  assert.deepEqual(corta.faltantes, [{ tratamientoId: 1, nombre: 'Mínimo', faltan: 1 }]);
});

test('(b) una pauta inválida en una versión que se usa bloquea sin lanzar', () => {
  const mala: Pauta = { vigenteDesde: '2026-11-11', patron: 'cada_n_dias', dosis: [{ momentoId: 1, unidades: 1 }] };
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'Mala', versiones: [V1, mala], envases: [caja(1, 1, 'X', '2027-06-30', 50)] };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('PAUTA_INVALIDA'));
  assert.match(r.bloqueos.find(b => b.codigo === 'PAUTA_INVALIDA')!.texto, /Mala/);
});

// ═════════════════════════ (c) caducidad de cajas ═════════════════════════

test('(c) caja que caduca a mitad del periodo: se excluye, avisa y faltan 3', () => {
  const m = medicamentosA()[0];
  const envases = m.envases.map(e => e.id === 12 ? { ...e, caducidad: '2026-11-10' } : e);
  const r = evaluarPreparacion(solo({ ...m, envases }));
  assert.ok(!r.lineasReparto.some(l => l.envaseId === 12));
  assert.ok(r.avisos.some(a => a.codigo === 'CAJA_EXCLUIDA_POR_CADUCIDAD' && a.texto.includes('M-B')));
  assert.equal(r.validable, false);
  assert.deepEqual(r.faltantes, [{ tratamientoId: 1, nombre: 'Metformina 850 mg', faltan: 3 }]);
  assert.ok(codigos(r).includes('UNIDADES_INSUFICIENTES'));
});

test('(c) con una caja más, vuelve a ser validable y el lote excluido no se usa', () => {
  const m = medicamentosA()[0];
  const envases = [...m.envases.map(e => e.id === 12 ? { ...e, caducidad: '2026-11-10' } : e), caja(14, 1, 'M-D', '2027-05-31', 10)];
  const r = evaluarPreparacion(solo({ ...m, envases }));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.ok(!r.lineasReparto.some(l => l.lote === 'M-B'));
  assert.ok(r.avisos.some(a => a.codigo === 'CAJA_EXCLUIDA_POR_CADUCIDAD'));
});

test('(c) caja que caduca el último día: se usa y limita la caducidad del SPD', () => {
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'Límite', versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] }], envases: [caja(1, 1, 'LIM', FIN_14, 14)] };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.equal(r.caducidadSpd?.caducidadSpd, FIN_14);
  // un día antes: la caja se excluye
  const r2 = evaluarPreparacion(solo({ ...t, envases: [caja(1, 1, 'LIM', '2026-11-16', 14)] }));
  assert.equal(r2.validable, false);
  assert.ok(codigos(r2).includes('UNIDADES_INSUFICIENTES'));
});

test('(c) la caducidad del SPD la limita el lote que antes caduca (y siempre cabe el periodo)', () => {
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'Lote corto', versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] }],
    envases: [caja(1, 1, 'CORTO', '2026-11-15', 10)] };
  // periodo de 10 días (4–13 nov): el lote (15-nov) caduca antes que preparación+14 (17-nov)
  const r = evaluarPreparacion(solo(t, { dias: 10 }));
  assert.equal(r.caducidadSpd?.limitadaPor, 'lote');
  assert.equal(r.caducidadSpd?.caducidadSpd, '2026-11-15');
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  // con lote lejano manda la validez
  const lejos = { ...t, envases: [caja(1, 1, 'LEJOS', '2027-11-15', 10)] };
  assert.equal(evaluarPreparacion(solo(lejos, { dias: 10 })).caducidadSpd?.limitadaPor, 'validez');
});

test('(c) un lote ya caducado antes de preparar no se usa (queda sin unidades)', () => {
  const t = { ...medicamentosA()[1], envases: [caja(21, 2, 'VIEJO', '2026-10-01', 4)] };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('UNIDADES_INSUFICIENTES'));
});

// ═════════════════════════ (d) unidades, rol, consentimiento ═════════════════════════

test('(d) falta de unidades: bloquea y dice cuántas', () => {
  const [m, a, c] = medicamentosA();
  const corta = { ...m, envases: m.envases.map(e => e.id === 13 ? { ...e, unidadesRestantes: 10 } : e) };
  const r = evaluarPreparacion(entrada({ tratamientos: [corta, a, c] }));
  assert.equal(r.validable, false);
  assert.deepEqual(r.faltantes, [{ tratamientoId: 1, nombre: 'Metformina 850 mg', faltan: 4.5 }]);
  const b = r.bloqueos.find(x => x.codigo === 'UNIDADES_INSUFICIENTES')!;
  assert.match(b.texto, /Metformina 850 mg/);
  assert.match(b.texto, /faltan 4\.5/);
  assert.equal(r.unidadesEsperadas, 47);
  assert.equal(r.unidadesAsignadas, 42.5);
  assert.ok(codigos(r).includes('UNIDADES_NO_CUADRAN'));
});

test('(d) unidades justas (0,25 de margen en cuartos) siguen cuadrando', () => {
  const t: TratamientoPreparacion = {
    tratamientoId: 1, nombre: 'Fraccionable',
    versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 1, unidades: 0.25 }, { momentoId: 3, unidades: 0.75 }] }],
    envases: [caja(1, 1, 'Q1', '2027-06-30', 3.25), caja(2, 1, 'Q2', '2027-09-30', 10.75)],
  };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.unidadesEsperadas, 14);
  assert.equal(r.unidadesAsignadas, 14);
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  const corta = evaluarPreparacion(solo({ ...t, envases: [caja(1, 1, 'Q1', '2027-06-30', 3.25), caja(2, 1, 'Q2', '2027-09-30', 10.5)] }));
  assert.equal(corta.faltantes[0].faltan, 0.25);
  assert.equal(corta.validable, false);
});

test('(d) un técnico no puede validar aunque todo cuadre', () => {
  const r = evaluarPreparacion(entrada({ rolValida: 'tecnico' }));
  assert.equal(r.validable, false);
  assert.deepEqual(codigos(r), ['ROL_NO_PUEDE_VALIDAR']);
});

test('(d) titular y farmacéutico sí; administrativo y rol desconocido no', () => {
  assert.equal(evaluarPreparacion(entrada({ rolValida: 'titular' })).validable, true);
  assert.equal(evaluarPreparacion(entrada({ rolValida: 'farmaceutico' })).validable, true);
  assert.deepEqual(codigos(evaluarPreparacion(entrada({ rolValida: 'administrativo' }))), ['ROL_NO_PUEDE_VALIDAR']);
  assert.deepEqual(codigos(evaluarPreparacion(entrada({ rolValida: undefined as never }))), ['ROL_NO_PUEDE_VALIDAR']);
});

test('(d) sin consentimiento vigente bloquea (booleano)', () => {
  const r = evaluarPreparacion(entrada({ consentimiento: false }));
  assert.equal(r.validable, false);
  assert.deepEqual(codigos(r), ['CONSENTIMIENTO_NO_VIGENTE']);
});

test('(d) consentimiento ausente o raro cuenta como no vigente', () => {
  for (const c of [undefined, null, 'si', 1, {}, { completo: 'si' }]) {
    const r = evaluarPreparacion(entrada({ consentimiento: c as never }));
    assert.deepEqual(codigos(r), ['CONSENTIMIENTO_NO_VIGENTE'], String(JSON.stringify(c)));
  }
});

test('(d) consentimiento como resultado de estadoConsentimientos: completo, faltan, revocado, desactualizado', () => {
  const vig = [{ codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1 }];
  const req = ['consentimiento_spd', 'info_rgpd'];
  const ok = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 2 }, { codigo: 'info_rgpd', version: 1 }], vig, req);
  assert.equal(evaluarPreparacion(entrada({ consentimiento: ok })).validable, true);

  const falta = estadoConsentimientos([{ codigo: 'info_rgpd', version: 1 }], vig, req);
  const rf = evaluarPreparacion(entrada({ consentimiento: falta }));
  assert.deepEqual(codigos(rf), ['CONSENTIMIENTO_NO_VIGENTE']);
  assert.match(rf.bloqueos[0].texto, /consentimiento_spd/);

  const revocado = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 2, revocadoEn: '2026-10-01' }, { codigo: 'info_rgpd', version: 1 }], vig, req);
  assert.match(evaluarPreparacion(entrada({ consentimiento: revocado })).bloqueos[0].texto, /revocados/);

  const viejo = estadoConsentimientos([{ codigo: 'consentimiento_spd', version: 1 }, { codigo: 'info_rgpd', version: 1 }], vig, req);
  assert.match(evaluarPreparacion(entrada({ consentimiento: viejo })).bloqueos[0].texto, /desactualizados/);
});

test('(d) varios fallos a la vez se acumulan (no se queda en el primero)', () => {
  const r = evaluarPreparacion(entrada({ rolValida: 'tecnico', consentimiento: false }));
  assert.deepEqual(codigos(r).sort(), ['CONSENTIMIENTO_NO_VIGENTE', 'ROL_NO_PUEDE_VALIDAR']);
});

// ═════════════════════════ momentos y celdas ═════════════════════════

test('momento inexistente en los momentos del blíster: bloquea (y el reparto por sí solo no lo vería)', () => {
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'Fantasma', versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 99, unidades: 1 }] }], envases: [caja(1, 1, 'Z1', '2027-06-30', 30)] };
  const r = evaluarPreparacion(solo(t));
  assert.equal(r.validable, false);
  assert.deepEqual(codigos(r), ['MOMENTO_INEXISTENTE']);
  assert.match(r.bloqueos[0].texto, /momento 99/);
  assert.equal(r.unidadesAsignadas, 14);                // reparto y caducidad estaban «bien»
});

test('momento inexistente: se dice una vez por momento, no una por día', () => {
  const t: TratamientoPreparacion = { tratamientoId: 1, nombre: 'F', versiones: [{ vigenteDesde: INICIO, patron: 'diario', dosis: [{ momentoId: 98, unidades: 1 }, { momentoId: 99, unidades: 1 }] }], envases: [caja(1, 1, 'Z', '2027-06-30', 40)] };
  assert.equal(codigos(evaluarPreparacion(solo(t))).filter(c => c === 'MOMENTO_INEXISTENTE').length, 2);
});

test('momentos vacíos, repetidos o mal formados bloquean sin lanzar', () => {
  assert.ok(codigos(evaluarPreparacion(entrada({ momentos: [] }))).includes('MOMENTOS_INVALIDOS'));
  assert.ok(codigos(evaluarPreparacion(entrada({ momentos: [MOMENTOS[0], MOMENTOS[0]] }))).includes('MOMENTOS_INVALIDOS'));
  assert.ok(codigos(evaluarPreparacion(entrada({ momentos: null as never }))).includes('MOMENTOS_INVALIDOS'));
  assert.equal(evaluarPreparacion(entrada({ momentos: [] })).validable, false);
});

// ═════════════════════════ modo 30 días y periodo ═════════════════════════

function larga(o: Partial<EntradaPreparacion> = {}): EntradaPreparacion {
  const tratamientos = medicamentosA().map(m => ({ ...m, envases: m.envases.map(e => ({ ...e, unidadesRestantes: e.unidadesRestantes * 2 + 4 })) }));
  return entrada({ dias: 28, tratamientos, ...o });
}

test('periodo de 28 días con validez de 14: no cabe', () => {
  const r = evaluarPreparacion(larga());
  assert.equal(r.validable, false);
  assert.deepEqual(codigos(r), ['PERIODO_NO_CABE']);
});

test('modo 30 días sin activar el ajuste: bloquea', () => {
  const r = evaluarPreparacion(larga({ diasValidez: 30 }));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('VALIDEZ_EXTENDIDA_NO_ACTIVADA'));
});

test('modo 30 días activado pero sin justificación (o en blanco): bloquea', () => {
  for (const justificacion of [undefined, '', '   ', 'corta']) {
    const r = evaluarPreparacion(larga({ diasValidez: 30, validezExtendidaPermitida: true, justificacion }));
    assert.equal(r.validable, false, String(justificacion));
    assert.ok(codigos(r).includes('JUSTIFICACION_FALTA'), String(justificacion));
  }
});

test('modo 30 días activado y justificado: validable, fuera de estándar, 4 blísteres', () => {
  const r = evaluarPreparacion(larga({ diasValidez: 30, validezExtendidaPermitida: true, justificacion: 'Paciente en residencia, reposición mensual coordinada.' }));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.equal(r.caducidadSpd?.fueraDeEstandar, true);
  assert.equal(r.caducidadSpd?.caducidadSpd, sumar(PREPARACION, 30));
  assert.equal(r.finPeriodo, sumar(INICIO, 27));
  assert.equal(r.mapas.length, 4);
  assert.ok(r.avisos.some(a => a.codigo === 'VALIDEZ_FUERA_DE_ESTANDAR'));
  assert.equal(r.unidadesAsignadas, r.unidadesEsperadas);
});

test('validez de más de 30 días: bloquea aunque haya justificación', () => {
  const r = evaluarPreparacion(larga({ diasValidez: 31, validezExtendidaPermitida: true, justificacion: 'Justificación suficientemente larga.' }));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('CADUCIDAD_INVALIDA'));
});

test('(g) periodo de 10 días desde un miércoles: dos mapas y validable', () => {
  const r = evaluarPreparacion(entrada({ dias: 10 }));
  assert.equal(r.mapas.length, 2);
  assert.equal(r.finPeriodo, '2026-11-13');
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.deepEqual(r.tomas.filter(t => t.tratamientoId === 2).map(t => t.fecha), ['2026-11-09']);
});

test('preparación posterior al primer día de administración: bloquea; el mismo día vale', () => {
  assert.ok(codigos(evaluarPreparacion(entrada({ fechaPreparacion: '2026-11-05' }))).includes('PREPARACION_POSTERIOR_AL_INICIO'));
  const r = evaluarPreparacion(entrada({ fechaPreparacion: INICIO, dias: 14 }));
  assert.equal(r.caducidadSpd?.caducidadSpd, sumar(INICIO, 14));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
});

// ═════════════════════════ medicación aparte, sin cajas, otros tratamientos ═════════════════════════

test('medicación no emblistable: no entra en el reparto, se lista aparte y avisa', () => {
  const aparte: TratamientoPreparacion = { tratamientoId: 9, nombre: 'Jarabe X', emblistable: false, versiones: [PAUTA_METFORMINA], envases: [] };
  const base = evaluarPreparacion(entrada());
  const r = evaluarPreparacion(entrada({ tratamientos: [...medicamentosA(), aparte] }));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.deepEqual(r.aparte, [{ tratamientoId: 9, nombre: 'Jarabe X' }]);
  assert.equal(r.unidadesEsperadas, base.unidadesEsperadas);
  assert.ok(!r.tomas.some(t => t.tratamientoId === 9));
  assert.ok(!r.lineasReparto.some(l => l.tratamientoId === 9));
  assert.ok(r.avisos.some(a => a.codigo === 'APARTE_NO_EMBLISTABLE' && a.texto.includes('Jarabe X')));
});

test('medicación aparte con pauta inválida o sin cajas no bloquea (no se calcula)', () => {
  const aparte: TratamientoPreparacion = { tratamientoId: 9, nombre: 'Gotas', emblistable: false, versiones: [{ vigenteDesde: 'mal', patron: 'diario', dosis: [] }], envases: [] };
  assert.equal(evaluarPreparacion(entrada({ tratamientos: [...medicamentosA(), aparte] })).validable, true);
});

test('sólo medicación aparte: no hay nada que emblistar, no es validable', () => {
  const aparte: TratamientoPreparacion = { tratamientoId: 9, nombre: 'Gotas', emblistable: false, versiones: [], envases: [] };
  const r = evaluarPreparacion(entrada({ tratamientos: [aparte] }));
  assert.equal(r.validable, false);
  assert.deepEqual(codigos(r), ['NADA_QUE_PREPARAR']);
});

test('lista de tratamientos vacía: no es validable', () => {
  const r = evaluarPreparacion(entrada({ tratamientos: [] }));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('NADA_QUE_PREPARAR'));
});

test('tratamiento sin cajas: bloquea y dice cuánto falta', () => {
  const m = { ...medicamentosA()[0], envases: [] };
  const r = evaluarPreparacion(solo(m));
  assert.equal(r.validable, false);
  assert.deepEqual(r.faltantes, [{ tratamientoId: 1, nombre: 'Metformina 850 mg', faltan: 35 }]);
  assert.ok(codigos(r).includes('UNIDADES_INSUFICIENTES'));
  assert.ok(codigos(r).includes('SIN_LOTES_USADOS'));
  assert.equal(r.caducidadSpd, undefined);
});

test('cajas agotadas, devueltas o retiradas no cuentan', () => {
  const m = medicamentosA()[1];
  for (const estado of ['agotado', 'devuelto', 'retirado', 'desechado'] as const) {
    const r = evaluarPreparacion(solo({ ...m, envases: [{ ...m.envases[0], estado }] }));
    assert.equal(r.validable, false, estado);
    assert.ok(codigos(r).includes('UNIDADES_INSUFICIENTES'), estado);
  }
});

test('una caja de OTRO tratamiento nunca se usa: bloquea', () => {
  const m = medicamentosA()[1];
  const ajena = caja(77, 5, 'AJENA', '2027-11-30', 50);
  const r = evaluarPreparacion(solo({ ...m, envases: [m.envases[0], ajena] }));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('ENVASE_DE_OTRO_TRATAMIENTO'));
  assert.ok(!r.lineasReparto.some(l => l.envaseId === 77));
  // y si ella fuera la única, tampoco se usa
  const r2 = evaluarPreparacion(solo({ ...m, envases: [ajena] }));
  assert.ok(!r2.lineasReparto.some(l => l.envaseId === 77));
  assert.equal(r2.validable, false);
});

test('tratamiento repetido: bloquea', () => {
  const m = medicamentosA()[1];
  const r = evaluarPreparacion(entrada({ tratamientos: [m, m] }));
  assert.ok(codigos(r).includes('TRATAMIENTO_REPETIDO'));
  assert.equal(r.validable, false);
});

test('pauta si_precisa: sin tomas, avisa; con otras tomas no bloquea', () => {
  const sp: TratamientoPreparacion = { tratamientoId: 8, nombre: 'Rescate', versiones: [{ vigenteDesde: INICIO, patron: 'si_precisa', dosis: [{ momentoId: 1, unidades: 1 }] }], envases: [] };
  const r = evaluarPreparacion(entrada({ tratamientos: [...medicamentosA(), sp] }));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.ok(r.avisos.some(a => a.codigo === 'SIN_TOMAS_EN_PERIODO' && a.texto.includes('Rescate')));
});

test('caja con unidades inválidas: bloquea con REPARTO_ERROR y las unidades no cuadran', () => {
  const m = medicamentosA()[1];
  const r = evaluarPreparacion(solo({ ...m, envases: [caja(21, 2, 'AL1', '2027-11-30', 4.3)] }));
  assert.equal(r.validable, false);
  assert.ok(codigos(r).includes('REPARTO_ERROR'));
  assert.ok(codigos(r).includes('UNIDADES_NO_CUADRAN'));
  assert.equal(r.unidadesAsignadas, 0);
});

test('caja en uso sin unidades: se ignora con aviso', () => {
  const m = medicamentosA()[1];
  const r = evaluarPreparacion(solo({ ...m, envases: [caja(20, 2, 'VACIA', '2027-11-30', 0), m.envases[0]] }));
  assert.equal(r.validable, true, JSON.stringify(r.bloqueos));
  assert.ok(r.avisos.some(a => a.codigo === 'CAJA_SIN_UNIDADES'));
});

// ═════════════════════════ robustez: nunca lanza ═════════════════════════

test('datos inválidos NUNCA lanzan: devuelven bloqueo', () => {
  const malos: unknown[] = [
    null, undefined, 5, 'x', {}, [],
    entrada({ desde: '2026-02-30' }),
    entrada({ desde: undefined as never }),
    entrada({ dias: 0 }),
    entrada({ dias: 367 }),
    entrada({ dias: 1.5 }),
    entrada({ dias: NaN }),
    entrada({ fechaPreparacion: 'ayer' }),
    entrada({ tratamientos: undefined as never }),
    entrada({ tratamientos: [null as never] }),
    entrada({ tratamientos: [{ tratamientoId: 1, nombre: 'x', versiones: undefined as never, envases: [] }] }),
    entrada({ tratamientos: [{ tratamientoId: 1, nombre: 'x', versiones: [PAUTA_METFORMINA], envases: undefined as never }] }),
    entrada({ diasValidez: NaN }),
    entrada({ disposicion: { inicioDia: 'raro' as never } }),
  ];
  for (const m of malos) {
    let r!: ReturnType<typeof evaluarPreparacion>;
    assert.doesNotThrow(() => { r = evaluarPreparacion(m as EntradaPreparacion); }, JSON.stringify(m)?.slice(0, 80));
    assert.equal(r.validable, false, JSON.stringify(m)?.slice(0, 80));
    assert.ok(r.bloqueos.length > 0);
  }
});

test('periodo inválido: PERIODO_INVALIDO y sin fin de periodo', () => {
  const r = evaluarPreparacion(entrada({ dias: 0 }));
  assert.ok(codigos(r).includes('PERIODO_INVALIDO'));
  assert.equal(r.finPeriodo, undefined);
  assert.deepEqual(r.mapas, []);
});

test('fecha de preparación inválida: bloquea y no calcula caducidad', () => {
  const r = evaluarPreparacion(entrada({ fechaPreparacion: '2026-13-01' }));
  assert.ok(codigos(r).includes('FECHA_PREPARACION_INVALIDA'));
  assert.equal(r.caducidadSpd, undefined);
  assert.equal(r.validable, false);
});

// ═════════════════════════ contrato de la salida ═════════════════════════

test('validable es exactamente «sin bloqueos»', () => {
  for (const e of [entrada(), entrada({ rolValida: 'tecnico' }), entrada({ consentimiento: false }), entrada({ dias: 0 }), entrada({ tratamientos: [] })]) {
    const r = evaluarPreparacion(e);
    assert.equal(r.validable, r.bloqueos.length === 0);
  }
});

test('los bloqueos y avisos tienen código y texto en español no vacíos', () => {
  const r = evaluarPreparacion(entrada({ rolValida: 'tecnico', consentimiento: false, tratamientos: [...medicamentosA(), { tratamientoId: 9, nombre: 'Aparte', emblistable: false, versiones: [], envases: [] }] }));
  for (const x of [...r.bloqueos, ...r.avisos]) {
    assert.match(x.codigo, /^[A-Z_]+$/);
    assert.ok(x.texto.trim().length > 10);
  }
  assert.ok(r.avisos.length > 0);
});

test('pura: no muta la entrada y es determinista', () => {
  const e = entrada();
  const copia = structuredClone(e);
  const r1 = evaluarPreparacion(e);
  assert.deepEqual(e, copia);
  assert.deepEqual(evaluarPreparacion(e), r1);
});

test('las tomas devueltas coinciden con las de la pauta (TomaDia) y llevan su tratamiento', () => {
  const r = evaluarPreparacion(entrada());
  const m: TomaDia[] = r.tomas.filter(t => t.tratamientoId === 1).map(({ fecha, momentoId, unidades }) => ({ fecha, momentoId, unidades }));
  assert.deepEqual(m, tomasDelPeriodo(PAUTA_METFORMINA, INICIO, FIN_14));
});

// ── Alertas de calidad sobre cajas ya custodiadas ──
test('una alerta de calidad sobre una caja en uso la excluye del reparto y bloquea si faltan unidades', () => {
  const base = {
    desde: '2026-11-03', dias: 7, fechaPreparacion: '2026-11-02',
    momentos: [{ id: 1, nombre: 'Desayuno', orden: 1 }],
    rolValida: 'farmaceutico' as const, consentimiento: true,
    tratamientos: [{
      tratamientoId: 1, nombre: 'Metformina',
      versiones: [{ vigenteDesde: '2026-01-01', patron: 'diario' as const, dosis: [{ momentoId: 1, unidades: 1 }] }],
      envases: [{ id: 10, tratamientoId: 1, cn: '712729', lote: 'L1', caducidad: '2028-01-31', unidadesRestantes: 30, estado: 'en_uso' as const }],
    }],
  };
  assert.equal(evaluarPreparacion(base).validable, true);
  const r = evaluarPreparacion({ ...base, alertas: [{ referencia: 'R_99/2026', cn: '712729', lote: 'L1' }] });
  assert.equal(r.validable, false);
  assert.ok(r.bloqueos.some(b => b.codigo === 'UNIDADES_INSUFICIENTES'));
  assert.ok(r.avisos.concat(r.bloqueos as never[]).some((a: { texto: string }) => /R_99\/2026/.test(a.texto)));
});
