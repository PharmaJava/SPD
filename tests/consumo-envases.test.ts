import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repartirUnidades, repartirTomas, diasDeCobertura, avisosCajas, aplicarConsumo } from '../src/dominio/consumo-envases.ts';
import type { Envase } from '../src/dominio/tipos.ts';

const caja = (id: number, lote: string, caducidad: string, unidadesRestantes: number, extra: Partial<Envase> = {}): Envase => ({
  id, tratamientoId: 1, cn: '654321', lote, caducidad, unidadesRestantes, estado: 'en_uso', ...extra,
});
const op = { fechaPreparacion: '2026-11-02', fechaFinPeriodo: '2026-11-15' };

test('FEFO: primero la que caduca antes', () => {
  const r = repartirUnidades([caja(1, 'A', '2028-01-31', 30), caja(2, 'B', '2027-06-30', 30)], 10, op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 10 }]);
});

test('FEFO con dos lotes: agota la primera y sigue con la segunda', () => {
  const r = repartirUnidades([caja(1, 'A', '2028-01-31', 30), caja(2, 'B', '2027-06-30', 6)], 10, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 6 }, { envaseId: 1, unidades: 4 }]);
});

test('desempate: misma caducidad, menos unidades restantes primero', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-06-30', 20), caja(2, 'B', '2027-06-30', 5)], 3, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 3 }]);
});

test('desempate final: mismas caducidad y unidades, id menor', () => {
  const r = repartirUnidades([caja(7, 'A', '2027-06-30', 5), caja(3, 'B', '2027-06-30', 5)], 2, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 3, unidades: 2 }]);
});

test('caja que caduca a mitad del periodo se excluye y se explica', () => {
  const r = repartirUnidades([caja(1, 'A', '2026-11-10', 30), caja(2, 'B', '2027-06-30', 30)], 10, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 10 }]);
  assert.match(r.avisos.join(' '), /caduca el 2026-11-10.*no se usa/);
});

test('caja que caduca exactamente el fin del periodo sí se usa', () => {
  const r = repartirUnidades([caja(1, 'A', '2026-11-15', 30)], 5, op);
  assert.equal(r.ok, true);
});

test('blíster con dos lotes: 14 unidades = 3 en A y 11 en B', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 3), caja(2, 'B', '2027-09-30', 40)], 14, op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 3 }, { envaseId: 2, unidades: 11 }]);
  assert.equal(r.faltan, 0);
});

test('fracciones: 0.5 sin error de coma flotante', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 0.5), caja(2, 'B', '2027-09-30', 10)], 0.1 + 0.4 + 0.5 - 0.5 + 0.5 - 0.4, op);
  // 0.1+0.4+0.5-0.5+0.5-0.4 = 0.2 en flotante → no es múltiplo de 0.25
  assert.equal(r.ok, false);
  assert.match(r.errores.join(' '), /no válidas/);
});

test('fracciones: 0.25 + 0.5 + 0.25 suman exactamente 1', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 0.75), caja(2, 'B', '2027-09-30', 10)], 1, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 0.75 }, { envaseId: 2, unidades: 0.25 }]);
  assert.ok(r.asignaciones.every((a) => Number.isInteger(a.unidades * 4)));
});

test('fracciones: 14 días de 0.5 = 7 sin 0.1+0.2', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 7.5)], 0.5 * 14, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 7 }]);
});

test('una cantidad entrada como 0.1+0.2 se rechaza, no se redondea', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 5)], 0.1 + 0.2, op);
  assert.equal(r.ok, false);
  assert.equal(r.asignaciones.length, 0);
});

test('faltan unidades: ok false, devuelve lo asignable y cuánto falta', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 4), caja(2, 'B', '2027-09-30', 3)], 10, op);
  assert.equal(r.ok, false);
  assert.equal(r.faltan, 3);
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 4 }, { envaseId: 2, unidades: 3 }]);
  assert.match(r.avisos.join(' '), /faltan 3/);
});

test('sin cajas utilizables: faltan todas', () => {
  const r = repartirUnidades([], 5, op);
  assert.equal(r.ok, false);
  assert.equal(r.faltan, 5);
  assert.deepEqual(r.asignaciones, []);
});

test('necesidad cero: ok y sin asignaciones', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 5)], 0, op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, []);
});

test('agotadas, devueltas, retiradas y desechadas se ignoran', () => {
  const envs = [
    caja(1, 'A', '2027-01-31', 9, { estado: 'agotado' }),
    caja(2, 'B', '2027-01-31', 9, { estado: 'devuelto' }),
    caja(3, 'C', '2027-01-31', 9, { estado: 'retirado' }),
    caja(4, 'D', '2027-01-31', 9, { estado: 'desechado' }),
    caja(5, 'E', '2028-01-31', 9),
  ];
  const r = repartirUnidades(envs, 4, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 5, unidades: 4 }]);
});

test('retirada con lote igual a una en uso no provoca error de lote repetido', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 9, { estado: 'retirado' }), caja(2, 'A', '2028-01-31', 9)], 2, op);
  assert.equal(r.ok, true);
});

test('lote repetido entre cajas en uso es error', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 9), caja(2, 'A', '2028-01-31', 9)], 2, op);
  assert.equal(r.ok, false);
  assert.match(r.errores.join(' '), /Lote repetido/);
  assert.deepEqual(r.asignaciones, []);
});

test('ids duplicados es error', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 9), caja(1, 'B', '2028-01-31', 9)], 2, op);
  assert.equal(r.ok, false);
  assert.match(r.errores.join(' '), /id repetido/);
});

test('tratamientos distintos es error', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 9), caja(2, 'B', '2028-01-31', 9, { tratamientoId: 2 })], 2, op);
  assert.equal(r.ok, false);
  assert.match(r.errores.join(' '), /tratamientos distintos/);
});

test('necesidad negativa o NaN es error', () => {
  assert.equal(repartirUnidades([caja(1, 'A', '2027-01-31', 9)], -1, op).ok, false);
  assert.equal(repartirUnidades([caja(1, 'A', '2027-01-31', 9)], NaN, op).ok, false);
});

test('fechas no válidas o periodo invertido es error', () => {
  assert.equal(repartirUnidades([], 1, { fechaPreparacion: 'x', fechaFinPeriodo: op.fechaFinPeriodo }).ok, false);
  assert.equal(repartirUnidades([], 1, { fechaPreparacion: '2026-11-10', fechaFinPeriodo: '2026-11-01' }).ok, false);
});

test('caja en uso sin unidades se ignora con aviso', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 0), caja(2, 'B', '2028-01-31', 5)], 2, op);
  assert.deepEqual(r.asignaciones, [{ envaseId: 2, unidades: 2 }]);
  assert.match(r.avisos.join(' '), /sin unidades/);
});

test('inmutabilidad: repartirUnidades no cambia la entrada', () => {
  const envs = [caja(2, 'B', '2028-01-31', 9), caja(1, 'A', '2027-01-31', 3)];
  const copia = structuredClone(envs);
  repartirUnidades(envs, 5, op);
  assert.deepEqual(envs, copia);
});

// --- repartirTomas ---
const tomas = (n: number, unidades = 1) =>
  Array.from({ length: n }, (_, i) => ({ fecha: `2026-11-${String(2 + i).padStart(2, '0')}`, momentoId: 1, unidades }));

test('tomas: cada alvéolo sabe de qué caja sale (FEFO)', () => {
  const r = repartirTomas([caja(1, 'A', '2027-01-31', 3), caja(2, 'B', '2027-09-30', 40)], tomas(5), op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineas.map((l) => l.envaseId), [1, 1, 1, 2, 2]);
  assert.equal(r.avisos.length, 0);
});

test('tomas: una toma partida entre dos cajas avisa «toma con dos lotes»', () => {
  const r = repartirTomas([caja(1, 'A', '2027-01-31', 1.5), caja(2, 'B', '2027-09-30', 40)], tomas(2, 1), op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.lineas.map((l) => [l.fecha, l.envaseId, l.unidades]), [
    ['2026-11-02', 1, 1], ['2026-11-03', 1, 0.5], ['2026-11-03', 2, 0.5],
  ]);
  assert.match(r.avisos.join(' '), /Toma con dos lotes: 2026-11-03/i);
});

test('tomas: se ordenan cronológicamente aunque lleguen desordenadas', () => {
  const t = [
    { fecha: '2026-11-04', momentoId: 1, unidades: 1 },
    { fecha: '2026-11-02', momentoId: 1, unidades: 1 },
  ];
  const r = repartirTomas([caja(1, 'A', '2027-01-31', 1), caja(2, 'B', '2027-09-30', 5)], t, op);
  assert.deepEqual(r.lineas.map((l) => [l.fecha, l.envaseId]), [['2026-11-02', 1], ['2026-11-04', 2]]);
});

test('tomas: faltan unidades', () => {
  const r = repartirTomas([caja(1, 'A', '2027-01-31', 2)], tomas(5), op);
  assert.equal(r.ok, false);
  assert.equal(r.faltan, 3);
  assert.equal(r.lineas.length, 2);
});

test('tomas: caja que caduca en el periodo no se usa', () => {
  const r = repartirTomas([caja(1, 'A', '2026-11-05', 50), caja(2, 'B', '2027-09-30', 50)], tomas(3), op);
  assert.ok(r.lineas.every((l) => l.envaseId === 2));
  assert.match(r.avisos.join(' '), /no se usa/);
});

test('tomas: fracciones 0.5 exactas', () => {
  const r = repartirTomas([caja(1, 'A', '2027-01-31', 1.5), caja(2, 'B', '2027-09-30', 10)], tomas(4, 0.5), op);
  const suma = r.lineas.reduce((s, l) => s + l.unidades * 4, 0) / 4;
  assert.equal(suma, 2);
  assert.ok(r.lineas.every((l) => Number.isInteger(l.unidades * 4)));
});

test('tomas: unidad inválida o lote repetido es error sin líneas', () => {
  const a = repartirTomas([caja(1, 'A', '2027-01-31', 9)], [{ fecha: '2026-11-02', momentoId: 1, unidades: 0.3 }], op);
  assert.equal(a.ok, false);
  assert.deepEqual(a.lineas, []);
  const b = repartirTomas([caja(1, 'A', '2027-01-31', 9), caja(2, 'A', '2028-01-31', 9)], tomas(1), op);
  assert.equal(b.ok, false);
});

test('tomas: inmutabilidad de envases y tomas', () => {
  const envs = [caja(1, 'A', '2027-01-31', 3)];
  const t = tomas(2);
  const [ce, ct] = [structuredClone(envs), structuredClone(t)];
  repartirTomas(envs, t, op);
  assert.deepEqual(envs, ce);
  assert.deepEqual(t, ct);
});

// --- diasDeCobertura ---
test('cobertura: 14 unidades a 1/día = 14 días', () => {
  const r = diasDeCobertura([caja(1, 'A', '2028-01-31', 14)], 1, '2026-11-02');
  assert.deepEqual(r, { dias: 14, hasta: '2026-11-15' });
});

test('cobertura: una caja deja de contar el día después de caducar', () => {
  const r = diasDeCobertura([caja(1, 'A', '2026-11-04', 10)], 1, '2026-11-02');
  assert.deepEqual(r, { dias: 3, hasta: '2026-11-04' });
});

test('cobertura: pasa a la siguiente caja', () => {
  const r = diasDeCobertura([caja(1, 'A', '2026-11-04', 10), caja(2, 'B', '2027-01-01', 4)], 2, '2026-11-02');
  // días 2,3,4 con A (6 u); A caduca el 4 → el día 5 y 6 con B (4 u)
  assert.equal(r.dias, 5);
  assert.equal(r.hasta, '2026-11-06');
});

test('cobertura: sin cajas utilizables → 0 días y hasta null', () => {
  assert.deepEqual(diasDeCobertura([], 1, '2026-11-02'), { dias: 0, hasta: null });
  assert.deepEqual(diasDeCobertura([caja(1, 'A', '2026-11-01', 9)], 1, '2026-11-02'), { dias: 0, hasta: null });
});

test('cobertura: fracciones 0.5/día', () => {
  assert.equal(diasDeCobertura([caja(1, 'A', '2028-01-31', 3.5)], 0.5, '2026-11-02').dias, 7);
});

test('cobertura: unidadesPorDia <= 0 lanza error', () => {
  assert.throws(() => diasDeCobertura([], 0, '2026-11-02'));
  assert.throws(() => diasDeCobertura([], -1, '2026-11-02'));
  assert.throws(() => diasDeCobertura([], 0.1, '2026-11-02'));
});

test('cobertura: ignora no en_uso y no muta la entrada', () => {
  const envs = [caja(1, 'A', '2028-01-31', 10, { estado: 'retirado' }), caja(2, 'B', '2028-01-31', 3)];
  const copia = structuredClone(envs);
  assert.equal(diasDeCobertura(envs, 1, '2026-11-02').dias, 3);
  assert.deepEqual(envs, copia);
});

// --- avisosCajas ---
test('avisos: caducada, próxima y lejana', () => {
  const a = avisosCajas([
    caja(1, 'A', '2026-10-01', 5),
    caja(2, 'B', '2026-11-20', 5),
    caja(3, 'C', '2027-12-31', 5),
  ], '2026-11-02');
  assert.equal(a.length, 2);
  assert.match(a[0], /caducada/);
  assert.match(a[1], /en 18 días/);
});

test('avisos: umbral configurable y límite inclusivo', () => {
  assert.equal(avisosCajas([caja(1, 'A', '2026-11-12', 5)], '2026-11-02', 10).length, 1);
  assert.equal(avisosCajas([caja(1, 'A', '2026-11-13', 5)], '2026-11-02', 10).length, 0);
});

test('avisos: en_uso sin unidades es inconsistencia; no en_uso no avisa', () => {
  const a = avisosCajas([caja(1, 'A', '2028-01-31', 0), caja(2, 'B', '2020-01-01', 5, { estado: 'retirado' })], '2026-11-02');
  assert.equal(a.length, 1);
  assert.match(a[0], /inconsistencia/);
});

// --- aplicarConsumo ---
test('consumo: descuenta y devuelve copias', () => {
  const envs = [caja(1, 'A', '2027-01-31', 10), caja(2, 'B', '2028-01-31', 10)];
  const copia = structuredClone(envs);
  const r = aplicarConsumo(envs, [{ envaseId: 1, unidades: 4 }]);
  assert.equal(r[0].unidadesRestantes, 6);
  assert.equal(r[1].unidadesRestantes, 10);
  assert.deepEqual(envs, copia);
  assert.notEqual(r[0], envs[0]);
  assert.notEqual(r[1], envs[1]);
});

test('consumo: llega a 0 → agotado', () => {
  const r = aplicarConsumo([caja(1, 'A', '2027-01-31', 3)], [{ envaseId: 1, unidades: 1.5 }, { envaseId: 1, unidades: 1.5 }]);
  assert.equal(r[0].unidadesRestantes, 0);
  assert.equal(r[0].estado, 'agotado');
});

test('consumo: más de lo que hay, negativo, inexistente o no en uso lanza error', () => {
  const envs = [caja(1, 'A', '2027-01-31', 3), caja(2, 'B', '2027-01-31', 3, { estado: 'retirado' })];
  assert.throws(() => aplicarConsumo(envs, [{ envaseId: 1, unidades: 3.25 }]));
  assert.throws(() => aplicarConsumo(envs, [{ envaseId: 1, unidades: -1 }]));
  assert.throws(() => aplicarConsumo(envs, [{ envaseId: 9, unidades: 1 }]));
  assert.throws(() => aplicarConsumo(envs, [{ envaseId: 2, unidades: 1 }]));
  assert.throws(() => aplicarConsumo(envs, [{ envaseId: 1, unidades: 2 }, { envaseId: 1, unidades: 2 }]));
});

test('consumo: fracciones exactas sin 0.1+0.2', () => {
  const r = aplicarConsumo([caja(1, 'A', '2027-01-31', 1)], [{ envaseId: 1, unidades: 0.25 }, { envaseId: 1, unidades: 0.5 }]);
  assert.equal(r[0].unidadesRestantes, 0.25);
});

test('integración: repartir y aplicar deja el stock coherente', () => {
  const envs = [caja(1, 'A', '2027-01-31', 3), caja(2, 'B', '2027-09-30', 40)];
  const r = repartirUnidades(envs, 14, op);
  const despues = aplicarConsumo(envs, r.asignaciones);
  assert.deepEqual(despues.map((e) => [e.unidadesRestantes, e.estado]), [[0, 'agotado'], [29, 'en_uso']]);
});

// --- propiedad aleatoria determinista ---
function generador(semilla: number) {
  let s = semilla >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('propiedad (200 casos): nunca más de lo restante y la suma cuadra', () => {
  const rnd = generador(20261028);
  for (let caso = 0; caso < 200; caso++) {
    const n = 1 + Math.floor(rnd() * 5);
    const envs: Envase[] = [];
    for (let i = 0; i < n; i++) {
      const mes = 1 + Math.floor(rnd() * 12);
      envs.push(caja(i + 1, `L${i}`, `${2026 + Math.floor(rnd() * 3)}-${String(mes).padStart(2, '0')}-28`, Math.floor(rnd() * 80) / 4));
    }
    const necesarias = Math.floor(rnd() * 120) / 4;
    const r = repartirUnidades(envs, necesarias, op);
    assert.equal(r.errores.length, 0);
    let sumaC = 0;
    for (const a of r.asignaciones) {
      const e = envs.find((x) => x.id === a.envaseId)!;
      assert.ok(a.unidades > 0);
      assert.ok(a.unidades <= e.unidadesRestantes, 'no asigna más de lo restante');
      assert.ok(e.caducidad >= op.fechaFinPeriodo, 'no usa cajas que caducan antes');
      assert.equal(a.unidades * 4, Math.round(a.unidades * 4));
      sumaC += Math.round(a.unidades * 4);
    }
    assert.equal(sumaC + Math.round(r.faltan * 4), Math.round(necesarias * 4), 'conservación');
    assert.equal(r.ok, r.faltan === 0);
    // FEFO: las asignadas salen en orden de caducidad
    const cads = r.asignaciones.map((a) => envs.find((x) => x.id === a.envaseId)!.caducidad);
    assert.deepEqual([...cads].sort(), cads);
    // y por tomas lo mismo
    const t = Array.from({ length: Math.ceil(necesarias) }, (_, i) => ({
      fecha: `2026-11-${String(2 + (i % 13)).padStart(2, '0')}`, momentoId: i, unidades: Math.min(1, necesarias - i),
    })).filter((x) => x.unidades > 0);
    const rt = repartirTomas(envs, t, op);
    const total = t.reduce((s, x) => s + Math.round(x.unidades * 4), 0);
    assert.equal(rt.lineas.reduce((s, l) => s + Math.round(l.unidades * 4), 0) + Math.round(rt.faltan * 4), total);
    const porCaja = new Map<number, number>();
    for (const l of rt.lineas) porCaja.set(l.envaseId, (porCaja.get(l.envaseId) ?? 0) + Math.round(l.unidades * 4));
    for (const [id, c] of porCaja) assert.ok(c <= Math.round(envs.find((x) => x.id === id)!.unidadesRestantes * 4));
  }
});

test('ruido de coma flotante insignificante se absorbe en cuartos (1.9999999999999 = 2)', () => {
  const r = repartirUnidades([caja(1, 'A', '2027-01-31', 5)], 1.99999999999999, op);
  assert.equal(r.ok, true);
  assert.deepEqual(r.asignaciones, [{ envaseId: 1, unidades: 2 }]);
});
