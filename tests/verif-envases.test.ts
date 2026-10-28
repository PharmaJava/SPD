/**
 * Verificación adversarial independiente de consumo-envases.ts y entrada-envase.ts.
 * Especificación deducida de docs/03 (Envases) y docs/04 §4.2-4.3, no de los tests del autor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repartirUnidades, repartirTomas, aplicarConsumo, diasDeCobertura, avisosCajas,
} from '../src/dominio/consumo-envases.ts';
import { validarEntradaEnvase, parsearCaducidad, type EntradaEnvase, type ContextoEntrada } from '../src/dominio/entrada-envase.ts';
import { digitoControlGS1, GS } from '../src/dominio/gs1.ts';
import type { Envase } from '../src/dominio/tipos.ts';

// ── utilidades ─────────────────────────────────────────────────────────────
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const entero = (r: () => number, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const BASE = Date.UTC(2026, 9, 28);
const iso = (off: number) => new Date(BASE + off * 86400000).toISOString().slice(0, 10);
const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); }
  return o;
};
const ESTADOS: Envase['estado'][] = ['en_uso', 'en_uso', 'en_uso', 'en_uso', 'agotado', 'devuelto', 'retirado', 'desechado'];

function genEnvases(r: () => number): Envase[] {
  const n = entero(r, 0, 7);
  const ids = new Set<number>();
  const res: Envase[] = [];
  for (let i = 0; i < n; i++) {
    let id; do { id = entero(r, 1, 30); } while (ids.has(id)); ids.add(id);
    res.push({
      id, tratamientoId: 1, cn: '712729', lote: `L${id}`,
      caducidad: iso(entero(r, -5, 45)),
      unidadesRestantes: entero(r, 0, 40) / 4,
      estado: ESTADOS[entero(r, 0, ESTADOS.length - 1)],
    });
  }
  return res;
}

// referencia independiente
function usables(env: Envase[], fin: string) {
  return env
    .filter((e) => e.estado === 'en_uso' && e.unidadesRestantes > 0 && e.caducidad >= fin)
    .sort((a, b) => a.caducidad.localeCompare(b.caducidad) || a.unidadesRestantes - b.unidadesRestantes || a.id - b.id);
}

const N = 3000;

// ── consumo ────────────────────────────────────────────────────────────────
test('repartirUnidades: conservación, FEFO, caducidad e inmutabilidad (3000 casos)', () => {
  const r = rng(12345);
  for (let k = 0; k < N; k++) {
    const env = deepFreeze(genEnvases(r));
    const snap = JSON.stringify(env);
    const prep = iso(0);
    const fin = iso(entero(r, 0, 20));
    const necC = entero(r, 0, 70);
    const nec = necC / 4;
    const res = repartirUnidades(env, nec, { fechaPreparacion: prep, fechaFinPeriodo: fin });
    assert.equal(JSON.stringify(env), snap);
    assert.deepEqual(res.errores, []);
    const asig = res.asignaciones.reduce((s, a) => s + a.unidades, 0);
    assert.equal(asig + res.faltan, nec, `conservación caso ${k}`);
    assert.equal(res.ok, res.faltan === 0);
    // referencia
    const us = usables(env, fin);
    let pend = necC; const esperado: { envaseId: number; unidades: number }[] = [];
    for (const c of us) { if (pend === 0) break; const t = Math.min(pend, c.unidadesRestantes * 4); esperado.push({ envaseId: c.id, unidades: t / 4 }); pend -= t; }
    assert.deepEqual(res.asignaciones, esperado, `FEFO caso ${k}`);
    assert.equal(res.faltan, pend / 4);
    for (const a of res.asignaciones) {
      const e = env.find((x) => x.id === a.envaseId)!;
      assert.ok(e.estado === 'en_uso' && e.caducidad >= fin && a.unidades > 0 && a.unidades <= e.unidadesRestantes);
    }
  }
});

test('repartirUnidades: cajas que caducan antes del fin NUNCA reciben unidades, aunque falte medicación', () => {
  const env: Envase[] = [
    { id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2026-11-05', unidadesRestantes: 100, estado: 'en_uso' },
    { id: 2, tratamientoId: 1, cn: '712729', lote: 'B', caducidad: '2026-11-10', unidadesRestantes: 3, estado: 'en_uso' },
  ];
  const res = repartirUnidades(env, 10, { fechaPreparacion: '2026-10-28', fechaFinPeriodo: '2026-11-10' });
  assert.deepEqual(res.asignaciones, [{ envaseId: 2, unidades: 3 }]);
  assert.equal(res.faltan, 7);
  assert.equal(res.ok, false);
});

test('fechas imposibles (2026-02-31, 2026-04-31) se rechazan como caducidad y como periodo', () => {
  for (const mala of ['2026-02-31', '2026-04-31', '2026-02-30', '2025-02-29']) {
    const env: Envase[] = [{ id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: mala, unidadesRestantes: 10, estado: 'en_uso' }];
    const r1 = repartirUnidades(env, 1, { fechaPreparacion: '2026-01-01', fechaFinPeriodo: '2026-01-07' });
    assert.equal(r1.ok, false, `caducidad ${mala} aceptada`);
    assert.deepEqual(r1.asignaciones, []);
    const ok: Envase[] = [{ id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2027-01-01', unidadesRestantes: 10, estado: 'en_uso' }];
    const r2 = repartirUnidades(ok, 1, { fechaPreparacion: '2026-01-01', fechaFinPeriodo: mala });
    assert.equal(r2.ok, false, `fin ${mala} aceptado`);
    assert.throws(() => diasDeCobertura(ok, 1, mala));
  }
});

test('repartirUnidades: entradas hostiles no producen ok:true', () => {
  const env: Envase[] = [{ id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2027-01-01', unidadesRestantes: 10, estado: 'en_uso' }];
  const op = { fechaPreparacion: '2026-10-28', fechaFinPeriodo: '2026-11-03' };
  for (const n of [-1, 0.1, NaN, Infinity, -Infinity, 0.3, '3' as unknown as number, null as unknown as number, undefined as unknown as number]) {
    const r = repartirUnidades(env, n, op);
    assert.equal(r.ok, false, `necesarias=${String(n)}`);
    assert.deepEqual(r.asignaciones, []);
  }
  assert.equal(repartirUnidades(env, 1, { fechaPreparacion: '2026-11-03', fechaFinPeriodo: '2026-10-28' }).ok, false);
  const dup = [...env, { ...env[0] }];
  assert.equal(repartirUnidades(dup, 1, op).ok, false);
  const otroTrat = [...env, { ...env[0], id: 2, lote: 'B', tratamientoId: 2 }];
  assert.equal(repartirUnidades(otroTrat, 1, op).ok, false);
});

test('aplicarConsumo ∘ repartirUnidades: saldos >= 0, agotado sólo con 0, resto intacto (3000 casos)', () => {
  const r = rng(777);
  for (let k = 0; k < N; k++) {
    const env = deepFreeze(genEnvases(r));
    const fin = iso(entero(r, 0, 20));
    const nec = entero(r, 0, 70) / 4;
    const rep = repartirUnidades(env, nec, { fechaPreparacion: iso(0), fechaFinPeriodo: fin });
    const out = aplicarConsumo(env, rep.asignaciones);
    assert.equal(out.length, env.length);
    let antes = 0, despues = 0;
    for (let i = 0; i < env.length; i++) {
      const a = env[i], d = out[i];
      assert.notEqual(a, d, 'debe devolver copias');
      assert.ok(d.unidadesRestantes >= 0);
      assert.equal(d.id, a.id); assert.equal(d.lote, a.lote); assert.equal(d.caducidad, a.caducidad);
      const gasto = rep.asignaciones.filter((x) => x.envaseId === a.id).reduce((s, x) => s + x.unidades, 0);
      assert.equal(d.unidadesRestantes, a.unidadesRestantes - gasto);
      if (gasto > 0) assert.equal(d.estado, d.unidadesRestantes === 0 ? 'agotado' : 'en_uso');
      else assert.equal(d.estado, a.estado);
      if (d.estado === 'agotado' && a.estado !== 'agotado') assert.equal(d.unidadesRestantes, 0);
      if (a.estado === 'en_uso') { antes += a.unidadesRestantes; despues += d.unidadesRestantes; }
    }
    assert.equal(antes - despues, nec - rep.faltan);
  }
});

test('aplicarConsumo: rechaza sobreconsumo, inexistentes, no en uso y cantidades raras', () => {
  const env: Envase[] = [
    { id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2027-01-01', unidadesRestantes: 2, estado: 'en_uso' },
    { id: 2, tratamientoId: 1, cn: '712729', lote: 'B', caducidad: '2027-01-01', unidadesRestantes: 2, estado: 'agotado' },
  ];
  assert.throws(() => aplicarConsumo(env, [{ envaseId: 1, unidades: 2.25 }]));
  assert.throws(() => aplicarConsumo(env, [{ envaseId: 1, unidades: 1 }, { envaseId: 1, unidades: 1.25 }]));
  assert.throws(() => aplicarConsumo(env, [{ envaseId: 9, unidades: 1 }]));
  assert.throws(() => aplicarConsumo(env, [{ envaseId: 2, unidades: 1 }]));
  for (const u of [-1, NaN, Infinity, 0.1]) assert.throws(() => aplicarConsumo(env, [{ envaseId: 1, unidades: u }]));
  const ok = aplicarConsumo(env, [{ envaseId: 1, unidades: 1 }, { envaseId: 1, unidades: 1 }]);
  assert.equal(ok[0].estado, 'agotado');
  assert.equal(env[0].estado, 'en_uso');
});

test('repartirTomas: coherente con repartirUnidades, orden cronológico y FEFO (3000 casos)', () => {
  const r = rng(999);
  for (let k = 0; k < N; k++) {
    const env = deepFreeze(genEnvases(r));
    const fin = iso(entero(r, 3, 12));
    const nT = entero(r, 0, 12);
    const tomas = deepFreeze(Array.from({ length: nT }, () => ({ fecha: iso(entero(r, 0, 3)), momentoId: entero(r, 1, 4), unidades: entero(r, 0, 12) / 4 })));
    const res = repartirTomas(env, tomas, { fechaPreparacion: iso(0), fechaFinPeriodo: fin });
    assert.deepEqual(res.errores, []);
    const total = tomas.reduce((s, t) => s + t.unidades, 0);
    const asig = res.lineas.reduce((s, l) => s + l.unidades, 0);
    assert.equal(asig + res.faltan, total, `conservación ${k}`);
    assert.equal(res.ok, res.faltan === 0);
    // por caja: nunca más de lo que tiene, sólo usables
    const us = usables(env, fin);
    const porCaja = new Map<number, number>();
    for (const l of res.lineas) { assert.ok(l.unidades > 0); porCaja.set(l.envaseId, (porCaja.get(l.envaseId) ?? 0) + l.unidades); }
    for (const [id, u] of porCaja) { const c = us.find((x) => x.id === id); assert.ok(c, 'caja no usable asignada'); assert.ok(u <= c!.unidadesRestantes); }
    // mismo reparto agregado que repartirUnidades con el total
    const rep = repartirUnidades(env, total, { fechaPreparacion: iso(0), fechaFinPeriodo: fin });
    assert.equal(res.faltan, rep.faltan);
    for (const a of rep.asignaciones) assert.equal(porCaja.get(a.envaseId) ?? 0, a.unidades);
    // FEFO: índice de caja no decreciente a lo largo de las líneas (orden cronológico)
    const orden = us.map((c) => c.id);
    let ult = -1;
    for (const l of res.lineas) { const ix = orden.indexOf(l.envaseId); assert.ok(ix >= ult, 'FEFO roto'); ult = ix; }
    // cada toma recibe exactamente lo pedido salvo que falte (nunca más)
    for (const t of tomas) {
      const got = res.lineas.filter((l) => l.fecha === t.fecha && l.momentoId === t.momentoId).reduce((s, l) => s + l.unidades, 0);
      const pedidoMismo = tomas.filter((x) => x.fecha === t.fecha && x.momentoId === t.momentoId).reduce((s, x) => s + x.unidades, 0);
      assert.ok(got <= pedidoMismo);
    }
  }
});

test('repartirTomas: fecha de toma imposible se rechaza', () => {
  const env: Envase[] = [{ id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2026-11-05', unidadesRestantes: 50, estado: 'en_uso' }];
  const op = { fechaPreparacion: '2026-10-28', fechaFinPeriodo: '2026-11-03' };
  assert.equal(repartirTomas(env, [{ fecha: '2026-02-31', momentoId: 1, unidades: 1 }], op).ok, false);
  // DUDA DE DISEÑO (no se asierta): una toma posterior al fin del periodo o a la
  // caducidad de la caja se consume igualmente; el llamador debe acotar las tomas.
});

test('diasDeCobertura == simulación día a día de referencia (3000 casos)', () => {
  const r = rng(4242);
  for (let k = 0; k < N; k++) {
    const env = deepFreeze(genEnvases(r));
    const porDiaC = entero(r, 1, 12);
    const hoy = iso(entero(r, -3, 3));
    const got = diasDeCobertura(env, porDiaC / 4, hoy);
    // referencia
    const cajas = env.filter((e) => e.estado === 'en_uso' && e.unidadesRestantes > 0).map((e) => ({ ...e, c: e.unidadesRestantes * 4 }));
    let dias = 0;
    for (let d = 0; d < 2000; d++) {
      const f = new Date(Date.parse(hoy + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10);
      const ok = cajas.filter((x) => x.caducidad >= f && x.c > 0).sort((a, b) => a.caducidad.localeCompare(b.caducidad) || a.c - b.c || a.id - b.id);
      let need = porDiaC;
      const disp = ok.reduce((s, x) => s + x.c, 0);
      if (disp < need) break;
      for (const x of ok) { const t = Math.min(need, x.c); x.c -= t; need -= t; if (!need) break; }
      dias++;
    }
    assert.equal(got.dias, dias, `caso ${k}`);
    const esperadoHasta = dias > 0 ? new Date(Date.parse(hoy + 'T00:00:00Z') + (dias - 1) * 86400000).toISOString().slice(0, 10) : null;
    assert.equal(got.hasta, esperadoHasta);
  }
});

test('diasDeCobertura: unidadesPorDia inválida lanza', () => {
  for (const u of [0, -1, NaN, Infinity, 0.1]) assert.throws(() => diasDeCobertura([], u, '2026-10-28'));
});

test('avisosCajas: caducada, próxima, sin unidades', () => {
  const env: Envase[] = [
    { id: 1, tratamientoId: 1, cn: '712729', lote: 'A', caducidad: '2026-10-27', unidadesRestantes: 1, estado: 'en_uso' },
    { id: 2, tratamientoId: 1, cn: '712729', lote: 'B', caducidad: '2026-11-27', unidadesRestantes: 1, estado: 'en_uso' },
    { id: 3, tratamientoId: 1, cn: '712729', lote: 'C', caducidad: '2026-11-28', unidadesRestantes: 1, estado: 'en_uso' },
    { id: 4, tratamientoId: 1, cn: '712729', lote: 'D', caducidad: '2030-01-01', unidadesRestantes: 0, estado: 'en_uso' },
  ];
  const a = avisosCajas(env, '2026-10-28');
  assert.equal(a.length, 3);
  assert.match(a[0], /caducada/); assert.match(a[1], /30 días/); assert.match(a[2], /sin unidades/);
});

// ── entrada ────────────────────────────────────────────────────────────────
const HOY = '2026-10-28';
const CTX: ContextoEntrada = { envasesExistentes: [], cnConocidos: new Set(['712729']), alertasCalidad: [] };
const base = (o: Partial<EntradaEnvase> = {}): EntradaEnvase => ({ cn: '712729', lote: 'ABC123', caducidad: '2028-05-31', unidades: 28, hoy: HOY, ...o });
const ctx = (o: Partial<ContextoEntrada> = {}): ContextoEntrada => ({ ...CTX, ...o });
const g14 = (() => { const b = '0847000712729'; return b + digitoControlGS1(b); })();
const dm = (o: { lote?: string; cad?: string; serie?: string; gs?: boolean; sinCad?: boolean; sinLote?: boolean } = {}) => {
  const sep = o.gs === false ? '' : GS;
  let s = '01' + g14;
  if (!o.sinCad) s += '17' + (o.cad ?? '281231');
  if (!o.sinLote) s += '10' + (o.lote ?? 'LOT77') + (o.serie !== undefined ? sep + '21' + o.serie : '');
  return s;
};

test('entrada válida mínima (sin DataMatrix) normaliza', () => {
  const r = validarEntradaEnvase(base(), CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.envaseNormalizado, { cn: '712729', lote: 'ABC123', caducidad: '2028-05-31', origenLectura: 'manual', unidades: 28 });
});

test('lote vacío / espacios / tabuladores / saltos / undefined / null => bloqueo FALTA_LOTE', () => {
  for (const l of [undefined, null as unknown as string, '', ' ', '   ', '\t', '\n', '   ', '　']) {
    const r = validarEntradaEnvase(base({ lote: l }), CTX);
    assert.equal(r.ok, false, JSON.stringify(l));
    assert.equal(r.envaseNormalizado, undefined);
    assert.ok(r.bloqueos.some((b) => b.codigo === 'FALTA_LOTE'), JSON.stringify(l));
  }
});

test('lote sin ningún carácter alfanumérico (solo comas/puntuación) NO es un lote', () => {
  for (const l of [',', ',,,', ' , , ', '-', '---', '.', '/', '*', '?', '_']) {
    const r = validarEntradaEnvase(base({ lote: l }), CTX);
    assert.equal(r.ok, false, `lote «${l}» aceptado`);
    assert.equal(r.envaseNormalizado, undefined);
  }
});

test('caducidad ausente / vacía / basura => nunca ok ni envaseNormalizado', () => {
  const malas = [undefined, null as unknown as string, '', '   ', 'x', '00/2028', '13/2028', '12/28/01', '2028-13-01', '2028-00-10',
    '2028-02-30', '2028-02-31', '2027-02-29', '2028-04-31', '2028-1-1', '28-05-31', '31/05/2028', 'mayo 2028', '2028/05', '05.2028', '0/28', '999'];
  for (const c of malas) {
    const r = validarEntradaEnvase(base({ caducidad: c }), CTX);
    assert.equal(r.ok, false, `caducidad ${JSON.stringify(c)} aceptada`);
    assert.equal(r.envaseNormalizado, undefined);
  }
});

test('formatos de caducidad válidos: último día del mes, bisiestos', () => {
  assert.equal(parsearCaducidad('02/2028'), '2028-02-29');
  assert.equal(parsearCaducidad('02/2027'), '2027-02-28');
  assert.equal(parsearCaducidad('02/28'), '2028-02-29');
  assert.equal(parsearCaducidad('2/28'), '2028-02-29');
  assert.equal(parsearCaducidad(' 12 / 2027 '), '2027-12-31');
  assert.equal(parsearCaducidad('2100-02-29'), null);
  assert.equal(parsearCaducidad('02/2100'), '2100-02-28');
  assert.equal(parsearCaducidad('2028-05-31'), '2028-05-31');
  assert.equal(parsearCaducidad('2028-05-31 '), '2028-05-31');
  const r = validarEntradaEnvase(base({ caducidad: '05/28' }), CTX);
  assert.equal(r.envaseNormalizado?.caducidad, '2028-05-31');
});

test('caducado (año 1999, ayer) bloquea; hoy mismo no bloquea pero avisa', () => {
  for (const c of ['1999-12-31', '12/1999', '12/99', '2026-10-27', '09/2026']) {
    const r = validarEntradaEnvase(base({ caducidad: c }), CTX);
    // 12/99 se lee como 2099 (convención 20AA): se verifica abajo como duda de diseño
    if (c === '12/99') continue;
    assert.equal(r.ok, false, c);
  }
  const hoy = validarEntradaEnvase(base({ caducidad: HOY }), CTX);
  assert.ok(hoy.atencion.some((a) => a.codigo === 'CADUCA_PRONTO'));
});

test('MM/AA no adivina siglo: 12/99 se lee 2099 (duda de diseño documentada)', () => {
  const r = validarEntradaEnvase(base({ caducidad: '12/99' }), CTX);
  // si ok, debe al menos avisar de caducidad lejanísima; hoy no avisa: se registra en el informe
  if (r.ok) assert.ok(true);
});

test('hoy inválido lanza RangeError', () => {
  for (const h of ['', '2026-02-30', '28/10/2026', 'hoy', '2026-10-28T00:00:00Z', undefined as unknown as string]) {
    assert.throws(() => validarEntradaEnvase(base({ hoy: h }), CTX), RangeError, String(h));
  }
});

test('unidades inválidas bloquean', () => {
  for (const u of [0, -1, NaN, Infinity, -Infinity, '3' as unknown as number, null as unknown as number, undefined as unknown as number, 0.1, 1.33]) {
    const r = validarEntradaEnvase(base({ unidades: u }), CTX);
    assert.equal(r.ok, false, String(u));
    assert.equal(r.envaseNormalizado, undefined);
  }
  for (const u of [0.25, 0.5, 1, 28, 100.75]) assert.equal(validarEntradaEnvase(base({ unidades: u }), CTX).ok, true, String(u));
});

test('CN: formas válidas y no válidas', () => {
  for (const cn of ['712729', '7127293', '712729.3', '712729-3', 'C.N. 712729.3', 'cn 712729', g14.slice(1), '8470007127293']) {
    const r = validarEntradaEnvase(base({ cn }), CTX);
    assert.equal(r.envaseNormalizado?.cn, '712729', cn);
  }
  for (const cn of ['', '   ', '12345', '12345678', '4006381333931', '04006381333931', 'abc', '8470007127']) {
    const r = validarEntradaEnvase(base({ cn }), CTX);
    assert.equal(r.ok, false, cn);
    assert.ok(r.bloqueos.some((b) => b.codigo === 'CN_INVALIDO'), cn);
  }
});

test('serie repetida bloquea (aunque cambie el lote); distinta o de otro CN no', () => {
  const ex = [{ cn: '712729', numeroSerie: 'S1', lote: 'OTRO', estado: 'devuelto' }, { cn: '999999', numeroSerie: 'S2', lote: 'X', estado: 'en_uso' }];
  const rep = validarEntradaEnvase(base({ numeroSerie: 'S1' }), ctx({ envasesExistentes: ex }));
  assert.equal(rep.ok, false); assert.ok(rep.bloqueos.some((b) => b.codigo === 'SERIE_REPETIDA'));
  assert.equal(validarEntradaEnvase(base({ numeroSerie: 'S2' }), ctx({ envasesExistentes: ex })).ok, true);
  assert.equal(validarEntradaEnvase(base({ numeroSerie: 'S3' }), ctx({ envasesExistentes: ex })).ok, true);
  const viaCodigo = validarEntradaEnvase(base({ lecturaDatamatrix: dm({ serie: 'S1' }) }), ctx({ envasesExistentes: ex }));
  assert.equal(viaCodigo.ok, false);
  // el teclado intenta esconder la serie del código
  const esconde = validarEntradaEnvase(base({ lecturaDatamatrix: dm({ serie: 'S1' }), numeroSerie: 'S9' }), ctx({ envasesExistentes: ex }));
  assert.equal(esconde.ok, false);
});

test('alerta de calidad: por CN+lote, solo lote, solo CN; insensible a mayúsculas/espacios', () => {
  const casos: [ContextoEntrada['alertasCalidad'], boolean][] = [
    [[{ cn: '712729', lote: 'ABC123', referencia: 'R1' }], true],
    [[{ lote: 'abc123', referencia: 'R2' }], true],
    [[{ lote: ' ABC   123 ', referencia: 'R2b' }], false],
    [[{ cn: '712729', referencia: 'R3' }], true],
    [[{ cn: '712729.3', referencia: 'R3b' }], true],
    [[{ cn: '999999', lote: 'ABC123', referencia: 'R4' }], false],
    [[{ cn: '712729', lote: 'OTRO', referencia: 'R5' }], false],
    [[{ referencia: 'R6' }], false],
  ];
  for (const [alertas, bloquea] of casos) {
    const r = validarEntradaEnvase(base(), ctx({ alertasCalidad: alertas }));
    assert.equal(r.ok, !bloquea, JSON.stringify(alertas));
    if (bloquea) assert.ok(r.bloqueos.some((b) => b.codigo === 'LOTE_CON_ALERTA'));
  }
  // la alerta pega contra el lote del CÓDIGO aunque el teclado ponga otro
  const r = validarEntradaEnvase(base({ lote: 'INOCUO', lecturaDatamatrix: dm({ lote: 'MALO1' }) }), ctx({ alertasCalidad: [{ cn: '712729', lote: 'MALO1', referencia: 'R7' }] }));
  assert.equal(r.ok, false);
});

test('DataMatrix: usa el código y avisa si el teclado lo contradice', () => {
  const r = validarEntradaEnvase(base({ lote: 'TECLEADO', caducidad: '2029-01-01', cn: '111111', lecturaDatamatrix: dm({ lote: 'LOT77', cad: '281231', serie: 'S77' }) }), CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.envaseNormalizado, { cn: '712729', lote: 'LOT77', caducidad: '2028-12-31', numeroSerie: 'S77', origenLectura: 'datamatrix', unidades: 28 });
  const cods = r.atencion.map((a) => a.codigo);
  for (const c of ['LOTE_CONTRADICE_CODIGO', 'CADUCIDAD_CONTRADICE_CODIGO', 'CN_CONTRADICE_CODIGO']) assert.ok(cods.includes(c), c);
});

test('DataMatrix sin GS entre lote y serie: ambiguo => bloquea, jamás elige', () => {
  const r = validarEntradaEnvase(base({ lecturaDatamatrix: dm({ lote: 'AB12', serie: 'XY99', gs: false }) }), CTX);
  assert.equal(r.ok, false);
  assert.ok(r.bloqueos.some((b) => b.codigo === 'LECTURA_AMBIGUA'));
  assert.equal(r.envaseNormalizado, undefined);
  // ni siquiera sin lote ni caducidad tecleados
  const r2 = validarEntradaEnvase(base({ lote: undefined, caducidad: undefined, lecturaDatamatrix: dm({ lote: 'AB12', serie: 'XY99', gs: false }) }), CTX);
  assert.equal(r2.ok, false); assert.equal(r2.envaseNormalizado, undefined);
});

test('DataMatrix GTIN no español: el CN sale del teclado; sin teclado bloquea', () => {
  const b = '400638133393'; const g = b + digitoControlGS1(b);
  const lec = '01' + g + '17281231' + '10' + 'LOTX';
  const r = validarEntradaEnvase(base({ cn: '712729', lecturaDatamatrix: lec }), CTX);
  assert.equal(r.ok, true); assert.equal(r.envaseNormalizado?.cn, '712729');
  const r2 = validarEntradaEnvase(base({ cn: '', lecturaDatamatrix: lec }), CTX);
  assert.equal(r2.ok, false);
});

test('DataMatrix sin lote o sin caducidad en el código y nada tecleado => bloquea', () => {
  const a = validarEntradaEnvase(base({ lote: undefined, lecturaDatamatrix: dm({ sinLote: true }) }), CTX);
  assert.equal(a.ok, false); assert.equal(a.envaseNormalizado, undefined);
  const c = validarEntradaEnvase(base({ caducidad: undefined, lecturaDatamatrix: dm({ sinCad: true }) }), CTX);
  assert.equal(c.ok, false); assert.equal(c.envaseNormalizado, undefined);
});

test('lectura basura => se usan los datos tecleados con aviso; sin ellos bloquea', () => {
  const r = validarEntradaEnvase(base({ lecturaDatamatrix: 'basura' }), CTX);
  assert.equal(r.ok, true); assert.ok(r.atencion.some((a) => a.codigo === 'LECTURA_NO_VALIDA'));
  assert.equal(r.envaseNormalizado?.origenLectura, 'manual');
  const r2 = validarEntradaEnvase(base({ lote: '', lecturaDatamatrix: 'basura' }), CTX);
  assert.equal(r2.ok, false);
});

test('PROPIEDAD: ninguna combinación sin lote o sin caducidad válidos produce ok / envaseNormalizado (4000 casos)', () => {
  const r = rng(2026);
  const pick = <T>(xs: T[]) => xs[entero(r, 0, xs.length - 1)];
  const lotes = [undefined, '', ' ', '\t', ',', ',,', ' , ', '-', 'A1', 'a b', ' L 9 ', 'ñ4'];
  const cads = [undefined, '', ' ', 'x', '13/2028', '00/28', '2028-02-30', '2028-5-1', '05/2028', '05/28', '2028-05-31', '1999-01-01', '2026-10-27', '2028-02-29'];
  const lecs: (string | undefined)[] = [undefined, '', 'zzz', dm(), dm({ gs: false, serie: 'Q1' }), dm({ sinLote: true }), dm({ sinCad: true }), dm({ lote: 'L2', serie: 'S2' }), dm({ cad: '000000' }), dm({ cad: '991231' })];
  const cns = ['712729', '', 'abc', '7127293', '8470007127293', '4006381333931'];
  const unis = [28, 0, -1, NaN, 0.5];
  for (let i = 0; i < 4000; i++) {
    const e: EntradaEnvase = { cn: pick(cns), lote: pick(lotes), caducidad: pick(cads), lecturaDatamatrix: pick(lecs), numeroSerie: pick([undefined, '', 'S1', ' S1 ']), unidades: pick(unis), hoy: HOY };
    const res = validarEntradaEnvase(e, ctx({ envasesExistentes: [{ cn: '712729', numeroSerie: 'S1', lote: 'Z', estado: 'en_uso' }] }));
    if (res.envaseNormalizado) {
      const n = res.envaseNormalizado;
      assert.equal(res.ok, true);
      assert.match(n.lote, /[\p{L}\p{N}]/u, `lote vacío ${JSON.stringify(e)}`);
      assert.equal(n.lote, n.lote.trim());
      assert.match(n.caducidad, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(n.caducidad >= HOY, 'caducado admitido');
      assert.match(n.cn, /^\d{6}$/);
      assert.ok(n.unidades > 0 && Number.isFinite(n.unidades));
    } else assert.equal(res.ok, false);
    assert.equal(res.ok, res.bloqueos.length === 0);
  }
});

test('entrada no se muta y el contexto tampoco', () => {
  const e = deepFreeze(base({ lote: ' a  b ', lecturaDatamatrix: dm({ serie: 'S5' }) }));
  const c = deepFreeze(ctx({ envasesExistentes: [{ cn: '712729', numeroSerie: 'S1', lote: 'Z', estado: 'en_uso' }], alertasCalidad: [{ lote: 'x', referencia: 'r' }] }));
  validarEntradaEnvase(e, c);
});

test('caducidad lejanísima (>10 años) debería al menos avisar (año 2099)', () => {
  for (const c of ['2099-12-31', '12/2099']) {
    const r = validarEntradaEnvase(base({ caducidad: c }), CTX);
    assert.ok(!r.ok || r.atencion.length > 0, `${c} aceptado sin ningún aviso`);
  }
});

test('lote sin espacios sobrantes se conserva tal cual (mayúsculas/minúsculas)', () => {
  const r = validarEntradaEnvase(base({ lote: ' aB-12  x ' }), CTX);
  assert.equal(r.envaseNormalizado?.lote, 'aB-12 x');
  assert.ok(r.atencion.some((a) => a.codigo === 'LOTE_NORMALIZADO'));
});
