import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diaToca, tomasDelPeriodo, validarPauta, avisosPauta, unidadesTotales, pautaVigenteEn,
} from '../src/dominio/calendario-pauta.ts';
import type { Pauta } from '../src/dominio/tipos.ts';

const base = (o: Partial<Pauta> = {}): Pauta => ({
  vigenteDesde: '2026-01-01', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }], ...o,
});
const dias = (p: Pauta, d: string, h: string) => tomasDelPeriodo(p, d, h).map((t) => t.fecha);

// ---- diario / vigencia
test('diario toca todos los días vigentes', () => {
  const p = base();
  assert.equal(diaToca(p, '2026-01-01'), true);
  assert.equal(diaToca(p, '2026-06-15'), true);
});
test('antes de vigenteDesde no toca', () => assert.equal(diaToca(base(), '2025-12-31'), false));
test('vigenteHasta es inclusive', () => {
  const p = base({ vigenteHasta: '2026-03-10' });
  assert.equal(diaToca(p, '2026-03-10'), true);
  assert.equal(diaToca(p, '2026-03-11'), false);
});
test('vigenteHasta null = indefinida', () => assert.equal(diaToca(base({ vigenteHasta: null }), '2040-01-01'), true));
test('fecha inválida lanza', () => {
  assert.throws(() => diaToca(base(), '2026-02-30'));
  assert.throws(() => diaToca(base(), '26-1-1'));
});

// ---- dias_semana
test('lunes=1 y domingo=7 (2026-01-05 es lunes, 2026-01-11 domingo)', () => {
  const lun = base({ patron: 'dias_semana', diasSemana: [1] });
  assert.equal(diaToca(lun, '2026-01-05'), true);
  assert.equal(diaToca(lun, '2026-01-11'), false);
  const dom = base({ patron: 'dias_semana', diasSemana: [7] });
  assert.equal(diaToca(dom, '2026-01-11'), true);
  assert.equal(diaToca(dom, '2026-01-05'), false);
});
test('dias_semana varios días', () => {
  const p = base({ patron: 'dias_semana', diasSemana: [1, 3, 5] });
  assert.deepEqual(dias(p, '2026-01-05', '2026-01-11'), ['2026-01-05', '2026-01-07', '2026-01-09']);
});
test('dias_semana vacío lanza y valida', () => {
  const p = base({ patron: 'dias_semana', diasSemana: [] });
  assert.throws(() => diaToca(p, '2026-01-05'));
  assert.ok(validarPauta(p).length > 0);
});
test('dias_semana con 0 u 8 es inválido (0-based no vale)', () => {
  assert.ok(validarPauta(base({ patron: 'dias_semana', diasSemana: [0] })).length > 0);
  assert.ok(validarPauta(base({ patron: 'dias_semana', diasSemana: [8] })).length > 0);
});

// ---- cada_n_dias
test('cada 3 días: el día ancla toca', () => {
  const p = base({ patron: 'cada_n_dias', cadaNDias: 3, fechaAncla: '2026-01-10', vigenteDesde: '2026-01-01' });
  assert.equal(diaToca(p, '2026-01-10'), true);
  assert.equal(diaToca(p, '2026-01-11'), false);
  assert.equal(diaToca(p, '2026-01-13'), true);
});
test('cada 3 días con ancla en el pasado', () => {
  const p = base({ patron: 'cada_n_dias', cadaNDias: 3, fechaAncla: '2025-12-30' });
  assert.deepEqual(dias(p, '2026-01-01', '2026-01-10'), ['2026-01-02', '2026-01-05', '2026-01-08']);
});
test('cada 3 días con ancla en el futuro se extiende hacia atrás', () => {
  const p = base({ patron: 'cada_n_dias', cadaNDias: 3, fechaAncla: '2026-01-10' });
  assert.deepEqual(dias(p, '2026-01-01', '2026-01-10'), ['2026-01-01', '2026-01-04', '2026-01-07', '2026-01-10']);
});
test('cada_n_dias sin ancla usa vigenteDesde', () => {
  const p = base({ patron: 'cada_n_dias', cadaNDias: 2, vigenteDesde: '2026-02-01' });
  assert.deepEqual(dias(p, '2026-02-01', '2026-02-06'), ['2026-02-01', '2026-02-03', '2026-02-05']);
});
test('cada_n_dias 0 o sin valor es inválido', () => {
  assert.ok(validarPauta(base({ patron: 'cada_n_dias', cadaNDias: 0 })).length > 0);
  assert.ok(validarPauta(base({ patron: 'cada_n_dias' })).length > 0);
  assert.throws(() => diaToca(base({ patron: 'cada_n_dias' }), '2026-01-01'));
});
test('cada 1 día equivale a diario', () => {
  assert.equal(dias(base({ patron: 'cada_n_dias', cadaNDias: 1 }), '2026-01-01', '2026-01-05').length, 5);
});

// ---- ciclo
test('ciclo 21/7 durante 60 días', () => {
  const p = base({ patron: 'ciclo', cicloOn: 21, cicloOff: 7 });
  const t = dias(p, '2026-01-01', '2026-03-01'); // 60 días
  assert.equal(t.length, 21 + 21 + 4); // 1-21 on, 22-28 off, 29-49 on, 50-56 off, 57-60 on
  assert.equal(diaToca(p, '2026-01-21'), true);
  assert.equal(diaToca(p, '2026-01-22'), false);
  assert.equal(diaToca(p, '2026-01-28'), false);
  assert.equal(diaToca(p, '2026-01-29'), true);
  assert.equal(diaToca(p, '2026-02-18'), true);
  assert.equal(diaToca(p, '2026-02-19'), false);
});
test('ciclo con ancla distinta de vigenteDesde', () => {
  const p = base({ patron: 'ciclo', cicloOn: 2, cicloOff: 1, fechaAncla: '2026-01-03' });
  assert.deepEqual(dias(p, '2026-01-01', '2026-01-08'), ['2026-01-01', '2026-01-03', '2026-01-04', '2026-01-06', '2026-01-07']);
});
test('ciclo con cicloOff 0 es diario; cicloOn 0 inválido', () => {
  assert.equal(dias(base({ patron: 'ciclo', cicloOn: 3, cicloOff: 0 }), '2026-01-01', '2026-01-09').length, 9);
  assert.ok(validarPauta(base({ patron: 'ciclo', cicloOn: 0, cicloOff: 7 })).length > 0);
  assert.ok(validarPauta(base({ patron: 'ciclo', cicloOn: 3 })).length > 0);
});

// ---- si_precisa
test('si_precisa nunca toca', () => {
  const p = base({ patron: 'si_precisa' });
  assert.equal(diaToca(p, '2026-05-05'), false);
  assert.deepEqual(tomasDelPeriodo(p, '2026-05-01', '2026-05-10'), []);
  assert.deepEqual(validarPauta(p), []);
});

// ---- calendario: año, bisiesto, cambio de hora
test('cruce de año', () => {
  assert.deepEqual(dias(base(), '2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
});
test('bisiesto: 29-feb-2028 existe, 29-feb-2027 no', () => {
  assert.deepEqual(dias(base({ vigenteDesde: '2028-01-01' }), '2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.throws(() => diaToca(base(), '2027-02-29'));
});
test('cada 7 días a través del 29-feb-2028', () => {
  const p = base({ vigenteDesde: '2028-02-01', patron: 'cada_n_dias', cadaNDias: 7 });
  assert.deepEqual(dias(p, '2028-02-01', '2028-03-14'), ['2028-02-01', '2028-02-08', '2028-02-15', '2028-02-22', '2028-02-29', '2028-03-07', '2028-03-14']);
});
test('cambio de hora (29-mar-2026 y 25-oct-2026) no altera el conteo', () => {
  const p = base();
  assert.equal(dias(p, '2026-03-28', '2026-03-30').length, 3);
  assert.equal(dias(p, '2026-10-24', '2026-10-26').length, 3);
  const c = base({ patron: 'cada_n_dias', cadaNDias: 2, vigenteDesde: '2026-03-27' });
  assert.deepEqual(dias(c, '2026-03-27', '2026-04-02'), ['2026-03-27', '2026-03-29', '2026-03-31', '2026-04-02']);
});
test('semana de un año a otro conserva lunes=1', () => {
  const p = base({ patron: 'dias_semana', diasSemana: [1] }); // 2026-12-28 es lunes
  assert.deepEqual(dias(p, '2026-12-28', '2027-01-04'), ['2026-12-28', '2027-01-04']);
});

// ---- tomasDelPeriodo
test('tomas ordenadas por fecha y momentoId', () => {
  const p = base({ dosis: [{ momentoId: 3, unidades: 1 }, { momentoId: 1, unidades: 0.5 }] });
  assert.deepEqual(tomasDelPeriodo(p, '2026-01-01', '2026-01-02'), [
    { fecha: '2026-01-01', momentoId: 1, unidades: 0.5 }, { fecha: '2026-01-01', momentoId: 3, unidades: 1 },
    { fecha: '2026-01-02', momentoId: 1, unidades: 0.5 }, { fecha: '2026-01-02', momentoId: 3, unidades: 1 },
  ]);
});
test('rango invertido lanza', () => assert.throws(() => tomasDelPeriodo(base(), '2026-01-10', '2026-01-01'), /invertido/));
test('rango invertido por un solo día también lanza', () => assert.throws(() => tomasDelPeriodo(base(), '2026-01-10', '2026-01-09')));
test('un solo día es válido', () => assert.equal(tomasDelPeriodo(base(), '2026-01-10', '2026-01-10').length, 1));
test('tope de 366 días', () => {
  assert.equal(tomasDelPeriodo(base(), '2026-01-01', '2026-12-31').length, 365);
  assert.equal(tomasDelPeriodo(base({ vigenteDesde: '2028-01-01' }), '2028-01-01', '2028-12-31').length, 366);
  assert.throws(() => tomasDelPeriodo(base(), '2026-01-01', '2027-01-02'), /366/);
});
test('periodo parcialmente fuera de vigencia', () => {
  const p = base({ vigenteDesde: '2026-01-03', vigenteHasta: '2026-01-05' });
  assert.deepEqual(dias(p, '2026-01-01', '2026-01-10'), ['2026-01-03', '2026-01-04', '2026-01-05']);
});
test('pauta inválida lanza en tomasDelPeriodo', () => {
  assert.throws(() => tomasDelPeriodo(base({ dosis: [] }), '2026-01-01', '2026-01-02'), /no válida/);
});

// ---- validarPauta
test('pauta válida → sin errores', () => assert.deepEqual(validarPauta(base()), []));
test('dosis vacía', () => assert.ok(validarPauta(base({ dosis: [] })).some((x) => /dosis/.test(x))));
test('unidades 0 y negativas', () => {
  assert.ok(validarPauta(base({ dosis: [{ momentoId: 1, unidades: 0 }] })).length > 0);
  assert.ok(validarPauta(base({ dosis: [{ momentoId: 1, unidades: -1 }] })).length > 0);
});
test('unidades no múltiplo de 0,25', () => {
  assert.ok(validarPauta(base({ dosis: [{ momentoId: 1, unidades: 0.3 }] })).length > 0);
  assert.deepEqual(validarPauta(base({ dosis: [{ momentoId: 1, unidades: 0.25 }, { momentoId: 2, unidades: 1.75 }] })), []);
});
test('momentoId repetido', () => {
  assert.ok(validarPauta(base({ dosis: [{ momentoId: 1, unidades: 1 }, { momentoId: 1, unidades: 1 }] })).some((x) => /repetido/.test(x)));
});
test('fechas inválidas y vigenteHasta anterior', () => {
  assert.ok(validarPauta(base({ vigenteDesde: '2026-13-01' })).length > 0);
  assert.ok(validarPauta(base({ vigenteHasta: 'mañana' })).length > 0);
  assert.ok(validarPauta(base({ fechaAncla: '2026-02-30' })).length > 0);
  assert.ok(validarPauta(base({ vigenteDesde: '2026-05-02', vigenteHasta: '2026-05-01' })).some((x) => /anterior/.test(x)));
  assert.deepEqual(validarPauta(base({ vigenteDesde: '2026-05-01', vigenteHasta: '2026-05-01' })), []);
});

// ---- avisos
test('aviso semanal con un solo día', () => {
  const a = avisosPauta(base({ patron: 'dias_semana', diasSemana: [3] }), 'metotrexato');
  assert.ok(a.some((x) => /SEMANAL/.test(x) && /no se prepara a diario/.test(x) && /metotrexato/.test(x)));
});
test('aviso semanal con cada 7 días, no con cada 6', () => {
  assert.ok(avisosPauta(base({ patron: 'cada_n_dias', cadaNDias: 7 })).some((x) => /SEMANAL/.test(x)));
  assert.ok(avisosPauta(base({ patron: 'cada_n_dias', cadaNDias: 14 })).some((x) => /SEMANAL/.test(x)));
  assert.equal(avisosPauta(base({ patron: 'cada_n_dias', cadaNDias: 6 })).length, 0);
});
test('sin aviso semanal con 2 días a la semana o diario', () => {
  assert.equal(avisosPauta(base({ patron: 'dias_semana', diasSemana: [1, 4] })).length, 0);
  assert.equal(avisosPauta(base()).length, 0);
});
test('aviso de fracciones', () => {
  assert.ok(avisosPauta(base({ dosis: [{ momentoId: 1, unidades: 0.5 }] })).some((x) => /divisible/.test(x)));
  assert.equal(avisosPauta(base({ dosis: [{ momentoId: 1, unidades: 2 }] })).length, 0);
});
test('aviso de ciclo', () => {
  assert.ok(avisosPauta(base({ patron: 'ciclo', cicloOn: 21, cicloOff: 7 })).some((x) => /ciclos/.test(x)));
});

// ---- unidadesTotales
test('unidades totales enteras', () => {
  const p = base({ dosis: [{ momentoId: 1, unidades: 1 }, { momentoId: 2, unidades: 2 }] });
  assert.equal(unidadesTotales(p, '2026-01-01', '2026-01-14'), 42);
});
test('fracciones 0,5 y 0,25 sin error de coma flotante', () => {
  const p = base({ dosis: [{ momentoId: 1, unidades: 0.25 }, { momentoId: 2, unidades: 0.5 }, { momentoId: 3, unidades: 1.75 }] });
  assert.equal(unidadesTotales(p, '2026-01-01', '2026-01-30'), 30 * 2.5);
  assert.equal(unidadesTotales(base({ dosis: [{ momentoId: 1, unidades: 0.25 }] }), '2026-01-01', '2026-01-03'), 0.75);
});
test('unidades totales con cada 3 días y si_precisa', () => {
  assert.equal(unidadesTotales(base({ patron: 'cada_n_dias', cadaNDias: 3 }), '2026-01-01', '2026-01-10'), 4);
  assert.equal(unidadesTotales(base({ patron: 'si_precisa' }), '2026-01-01', '2026-01-10'), 0);
});

// ---- pautaVigenteEn
test('pautaVigenteEn elige la versión más reciente', () => {
  const v1 = base({ vigenteDesde: '2026-01-01', vigenteHasta: '2026-03-31' });
  const v2 = base({ vigenteDesde: '2026-04-01' });
  assert.equal(pautaVigenteEn([v1, v2], '2026-03-31'), v1);
  assert.equal(pautaVigenteEn([v2, v1], '2026-04-01'), v2);
});
test('pautaVigenteEn: ninguna → null', () => {
  const v1 = base({ vigenteDesde: '2026-02-01', vigenteHasta: '2026-02-10' });
  assert.equal(pautaVigenteEn([v1], '2026-01-31'), null);
  assert.equal(pautaVigenteEn([v1], '2026-02-11'), null);
  assert.equal(pautaVigenteEn([], '2026-02-05'), null);
});
test('pautaVigenteEn con versiones solapadas gana la de vigenteDesde más reciente', () => {
  const vieja = base({ vigenteDesde: '2026-01-01' }); // indefinida, olvidó cerrarse
  const nueva = base({ vigenteDesde: '2026-03-01', vigenteHasta: '2026-03-31' });
  assert.equal(pautaVigenteEn([vieja, nueva], '2026-03-15'), nueva);
  assert.equal(pautaVigenteEn([vieja, nueva], '2026-04-15'), vieja);
});
