import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diaToca, tomasDelPeriodo, validarPauta, unidadesTotales, pautaVigenteEn,
} from '../src/dominio/calendario-pauta.ts';
import { construirMapas, buscarCelda, ordenLlenado, ubicarToma } from '../src/dominio/disposicion-blister.ts';
import type { Pauta } from '../src/dominio/tipos.ts';

// ---- PRNG determinista (mulberry32), semilla propia
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20261028);
const ri = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));

// ---- Referencia ingenua: Date UTC, día a día
const iso = (d: Date) => d.toISOString().slice(0, 10);
const D = (s: string) => new Date(s + 'T00:00:00Z');
const sumar = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
function difDias(a: string, b: string): number { // días de a a b, contando por bucle (ingenuo)
  let n = 0; let c = a;
  if (a <= b) { while (c < b) { c = sumar(c, 1); n++; } return n; }
  while (c > b) { c = sumar(c, -1); n--; } return n;
}
function dow(s: string) { const x = D(s).getUTCDay(); return x === 0 ? 7 : x; }
function mod(a: number, b: number) { let r = a % b; if (r < 0) r += b; return r; }

function refToca(p: Pauta, f: string): boolean {
  if (f < p.vigenteDesde) return false;
  if (p.vigenteHasta != null && f > p.vigenteHasta) return false;
  const anc = p.fechaAncla ?? p.vigenteDesde;
  switch (p.patron) {
    case 'diario': return true;
    case 'dias_semana': return p.diasSemana!.includes(dow(f));
    case 'cada_n_dias': return mod(difDias(anc, f), p.cadaNDias!) === 0;
    case 'ciclo': return mod(difDias(anc, f), p.cicloOn! + p.cicloOff!) < p.cicloOn!;
    default: return false;
  }
}
function refTomas(p: Pauta, a: string, b: string) {
  const out: { fecha: string; momentoId: number; unidades: number }[] = [];
  const dosis = [...p.dosis].sort((x, y) => x.momentoId - y.momentoId);
  for (let c = a; c <= b; c = sumar(c, 1)) {
    if (!refToca(p, c)) continue;
    for (const d of dosis) out.push({ fecha: c, momentoId: d.momentoId, unidades: d.unidades });
  }
  return out;
}

const BASES = ['2023-12-20', '2024-02-15', '2024-12-25', '2027-02-20', '2028-02-10', '2028-12-28', '2099-12-20', '2100-02-20', '2100-12-25', '2024-03-28', '2024-10-20'];
const UNI = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
function pautaAleatoria(): Pauta {
  const base = BASES[ri(0, BASES.length - 1)];
  const desde = sumar(base, ri(-40, 40));
  const p: Pauta = {
    vigenteDesde: desde, patron: 'diario',
    dosis: Array.from({ length: ri(1, 4) }, (_, i) => ({ momentoId: (ri(1, 20) * 10) + i, unidades: UNI[ri(0, UNI.length - 1)] })),
  };
  if (R() < 0.4) p.vigenteHasta = sumar(desde, ri(0, 200));
  const t = ri(0, 3);
  if (t === 1) { p.patron = 'dias_semana'; const s = new Set<number>(); const k = ri(1, 7); while (s.size < k) s.add(ri(1, 7)); p.diasSemana = [...s].sort(() => R() - 0.5); }
  if (t === 2) { p.patron = 'cada_n_dias'; p.cadaNDias = ri(1, 40); if (R() < 0.7) p.fechaAncla = sumar(desde, ri(-120, 120)); }
  if (t === 3) { p.patron = 'ciclo'; p.cicloOn = ri(1, 21); p.cicloOff = ri(0, 14); if (R() < 0.7) p.fechaAncla = sumar(desde, ri(-120, 120)); }
  return p;
}

test('contra referencia ingenua: 2500 pautas aleatorias', () => {
  let n = 0;
  for (let i = 0; i < 2500; i++) {
    const p = pautaAleatoria();
    const a = sumar(p.vigenteDesde, ri(-60, 60));
    const b = sumar(a, ri(0, 120));
    assert.deepEqual(tomasDelPeriodo(p, a, b), refTomas(p, a, b), JSON.stringify({ p, a, b }));
    n++;
  }
  assert.equal(n, 2500);
});

test('diaToca coincide con referencia (rangos largos que cruzan años y bisiestos)', () => {
  for (let i = 0; i < 1500; i++) {
    const p = pautaAleatoria();
    const f = sumar(p.vigenteDesde, ri(-100, 400));
    assert.equal(diaToca(p, f), refToca(p, f), JSON.stringify({ p, f }));
  }
});

test('aditividad: tomas(a,b) = tomas(a,m) + tomas(m+1,b); unidadesTotales = suma', () => {
  for (let i = 0; i < 1500; i++) {
    const p = pautaAleatoria();
    const a = sumar(p.vigenteDesde, ri(-30, 30));
    const b = sumar(a, ri(1, 150));
    const m = sumar(a, ri(0, difDias(a, b) - 1));
    const todo = tomasDelPeriodo(p, a, b);
    const partes = [...tomasDelPeriodo(p, a, m), ...tomasDelPeriodo(p, sumar(m, 1), b)];
    assert.deepEqual(todo, partes);
    const suma = todo.reduce((s, t) => s + t.unidades, 0);
    assert.ok(Math.abs(unidadesTotales(p, a, b) - suma) < 1e-9);
    assert.equal(unidadesTotales(p, a, b), unidadesTotales(p, a, m) + unidadesTotales(p, sumar(m, 1), b));
  }
});

test('cruce de años y bisiestos explícitos', () => {
  for (const [a, b] of [['2024-02-27', '2024-03-02'], ['2028-02-27', '2028-03-02'], ['2100-02-27', '2100-03-02'], ['2023-12-30', '2024-01-02'], ['2024-12-31', '2025-12-31'], ['2099-12-31', '2100-12-31']]) {
    for (const patron of ['diario', 'cada_n_dias', 'ciclo', 'dias_semana'] as const) {
      const p: Pauta = { vigenteDesde: sumar(a, -9), patron, diasSemana: [1, 7], cadaNDias: 3, cicloOn: 2, cicloOff: 3, dosis: [{ momentoId: 1, unidades: 1 }] };
      assert.deepEqual(tomasDelPeriodo(p, a, b), refTomas(p, a, b));
    }
  }
  // 2100 no es bisiesto
  const p: Pauta = { vigenteDesde: '2100-02-27', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  assert.deepEqual(tomasDelPeriodo(p, '2100-02-27', '2100-03-01').map(t => t.fecha), ['2100-02-27', '2100-02-28', '2100-03-01']);
  assert.throws(() => diaToca(p, '2100-02-29'));
  assert.throws(() => diaToca(p, '2024-02-30'));
});

test('hostiles: pautas inválidas lanzan, nunca adivinan', () => {
  const dosis = [{ momentoId: 1, unidades: 1 }];
  const base = { vigenteDesde: '2026-01-01', dosis };
  const malas: Pauta[] = [
    { ...base, vigenteDesde: '2026-02-30', patron: 'diario' },
    { ...base, vigenteDesde: '26-01-01', patron: 'diario' },
    { ...base, patron: 'diario', vigenteHasta: '2025-12-31' },
    { ...base, patron: 'diario', vigenteHasta: 'x' },
    { ...base, patron: 'dias_semana', diasSemana: [] },
    { ...base, patron: 'dias_semana', diasSemana: [0] },
    { ...base, patron: 'dias_semana', diasSemana: [8] },
    { ...base, patron: 'dias_semana', diasSemana: [1.5] },
    { ...base, patron: 'dias_semana', diasSemana: [1, 1] },
    { ...base, patron: 'dias_semana' },
    { ...base, patron: 'cada_n_dias', cadaNDias: 0 },
    { ...base, patron: 'cada_n_dias', cadaNDias: -3 },
    { ...base, patron: 'cada_n_dias', cadaNDias: 2.5 },
    { ...base, patron: 'cada_n_dias', cadaNDias: NaN },
    { ...base, patron: 'cada_n_dias', cadaNDias: 3, fechaAncla: '2026-13-01' },
    { ...base, patron: 'ciclo', cicloOn: 0, cicloOff: 1 },
    { ...base, patron: 'ciclo', cicloOn: 2, cicloOff: -1 },
    { ...base, patron: 'ciclo', cicloOn: 2.5, cicloOff: 1 },
    { ...base, patron: 'ciclo', cicloOn: 2 },
    { ...base, patron: 'diario', dosis: [{ momentoId: 1, unidades: 0.3 }] },
    { ...base, patron: 'diario', dosis: [{ momentoId: 1, unidades: 0 }] },
    { ...base, patron: 'diario', dosis: [{ momentoId: 1, unidades: -1 }] },
    { ...base, patron: 'diario', dosis: [{ momentoId: 1, unidades: Infinity }] },
    { ...base, patron: 'diario', dosis: [{ momentoId: 1, unidades: NaN }] },
    { ...base, patron: 'diario', dosis: [] },
    { ...base, patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }, { momentoId: 1, unidades: 1 }] },
    { ...base, patron: 'raro' as never },
  ];
  for (const p of malas) {
    assert.ok(validarPauta(p).length > 0, 'validarPauta debía rechazar ' + JSON.stringify(p));
    assert.throws(() => tomasDelPeriodo(p, '2026-01-01', '2026-01-10'), () => true, JSON.stringify(p));
    assert.throws(() => unidadesTotales(p, '2026-01-01', '2026-01-10'), () => true, JSON.stringify(p));
  }
  // si_precisa válido: nunca toca
  const sp: Pauta = { ...base, patron: 'si_precisa' };
  assert.deepEqual(tomasDelPeriodo(sp, '2026-01-01', '2026-03-01'), []);
  assert.equal(unidadesTotales(sp, '2026-01-01', '2026-03-01'), 0);
  // rangos
  const ok: Pauta = { ...base, patron: 'diario' };
  assert.throws(() => tomasDelPeriodo(ok, '2026-01-10', '2026-01-01'));
  assert.throws(() => tomasDelPeriodo(ok, '2026-01-01', '2027-01-02'));
  assert.equal(tomasDelPeriodo(ok, '2026-01-01', '2027-01-01').length, 366);
  assert.throws(() => tomasDelPeriodo(ok, '2026-1-1', '2026-01-02'));
  assert.throws(() => tomasDelPeriodo(ok, '', '2026-01-02'));
});

test('hostil: fechas con año < 100 o formato raro', () => {
  const p: Pauta = { vigenteDesde: '2026-01-01', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  for (const f of ['0099-01-01', '0000-01-01', '2026-01-01T00:00', ' 2026-01-01', '2026-01-01 ', '２０２６-01-01']) {
    // o devuelve resultado correcto o lanza; nunca resultado de otro año
    try { const r = tomasDelPeriodo(p, f, f); assert.ok(r.length === 0, 'año <2026 no debe tocar: ' + f); } catch { /* ok */ }
  }
});

test('hostil: 10.000 versiones y pautaVigenteEn', () => {
  const vs: Pauta[] = [];
  for (let i = 0; i < 10000; i++) {
    const d = sumar('2000-01-01', i * 2);
    vs.push({ vigenteDesde: d, vigenteHasta: sumar(d, 1), patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] });
  }
  for (let i = 0; i < 300; i++) {
    const f = sumar('2000-01-01', ri(-10, 20100));
    let esperado: Pauta | null = null;
    for (const v of vs) if (v.vigenteDesde <= f && (v.vigenteHasta == null || v.vigenteHasta >= f)) { if (!esperado || v.vigenteDesde >= esperado.vigenteDesde) esperado = v; }
    assert.equal(pautaVigenteEn(vs, f), esperado);
  }
  // más reciente gana con solapes; hasta anterior a desde nunca vigente
  const a: Pauta = { vigenteDesde: '2026-01-01', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  const b: Pauta = { ...a, vigenteDesde: '2026-03-01', vigenteHasta: '2026-03-10' };
  assert.equal(pautaVigenteEn([a, b], '2026-03-05'), b);
  assert.equal(pautaVigenteEn([b, a], '2026-03-05'), b);
  assert.equal(pautaVigenteEn([a, b], '2026-03-11'), a);
  const rara: Pauta = { ...a, vigenteDesde: '2026-05-01', vigenteHasta: '2026-04-01' };
  assert.equal(pautaVigenteEn([rara], '2026-05-01'), null);
  assert.equal(pautaVigenteEn([a, rara], '2026-05-01'), a);
  assert.equal(pautaVigenteEn([], '2026-05-01'), null);
});

// ================= disposición blíster =================
const MOMENTOS = [
  { id: 7, nombre: 'Noche', orden: 4 }, { id: 3, nombre: 'Desayuno', orden: 1 },
  { id: 9, nombre: 'Comida', orden: 2 }, { id: 5, nombre: 'Cena', orden: 3 },
];
test('blíster: cada fecha exactamente una vez en filas; celdas coherentes', () => {
  const sentidos = ['izquierda_derecha', 'derecha_izquierda'] as const;
  const inicios = ['convencional', 'cronologico'] as const;
  let casos = 0;
  for (const inicioDia of inicios) for (const rotar180 of [false, true]) for (const sentidoTomas of sentidos) for (const posicionInicial of ['izquierda', 'derecha'] as const) {
    for (let dias = 1; dias <= 60; dias++) {
      const desde = sumar(BASES[ri(0, BASES.length - 1)], ri(0, 400));
      const k = ri(1, 4);
      const moms = MOMENTOS.slice(0, k);
      const mapas = construirMapas(desde, dias, moms, { inicioDia, rotar180, sentidoTomas, posicionInicial });
      assert.equal(mapas.length, Math.ceil(dias / 7));
      const vistas: string[] = [];
      mapas.forEach((m, mi) => {
        assert.equal(m.indice, mi);
        assert.equal(m.filas.length, 7);
        assert.equal(m.celdas.length, 7 * k);
        for (const f of m.filas) if (f.fecha) { vistas.push(f.fecha); assert.equal(f.diaSemana, dow(f.fecha)); }
        if (inicioDia === 'convencional') {
          const orden = rotar180 ? [7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7];
          assert.deepEqual(m.filas.map(f => f.diaSemana), orden);
        }
        // desde/hasta del mapa
        const fs = m.filas.map(f => f.fecha).filter(Boolean) as string[];
        assert.equal(m.desde, [...fs].sort()[0]);
        assert.equal(m.hasta, [...fs].sort().at(-1));
        // celdas consistentes
        m.celdas.forEach(c => {
          assert.equal(c.fecha, m.filas[c.fila].fecha);
          assert.equal(c.momentoId, m.columnas[c.columna].id);
          assert.equal(c.usada, c.fecha !== null);
        });
        const llen = ordenLlenado(m, posicionInicial);
        assert.equal(llen.length, fs.length * k);
        assert.equal(new Set(llen.map(c => c.fila + ',' + c.columna)).size, llen.length);
        assert.ok(llen.every(c => c.usada));
        // orden: filas no decrecientes, y columnas monótonas dentro de fila
        for (let i = 1; i < llen.length; i++) {
          assert.ok(llen[i].fila >= llen[i - 1].fila);
          if (llen[i].fila === llen[i - 1].fila) assert.ok(posicionInicial === 'izquierda' ? llen[i].columna > llen[i - 1].columna : llen[i].columna < llen[i - 1].columna);
        }
      });
      const esperadas: string[] = []; for (let i = 0; i < dias; i++) esperadas.push(sumar(desde, i));
      assert.deepEqual([...vistas].sort(), esperadas);
      // buscarCelda/ubicarToma para cada toma
      for (const f of esperadas) for (const m of moms) {
        const u = ubicarToma(mapas, f, m.id)!;
        assert.ok(u, `${f} ${m.id}`);
        assert.equal(u.celda.fecha, f); assert.equal(u.celda.momentoId, m.id);
        assert.equal(u.mapa.filas[u.celda.fila].fecha, f);
        assert.equal(u.mapa.columnas[u.celda.columna].id, m.id);
        assert.equal(buscarCelda(u.mapa, f, m.id), u.celda);
      }
      assert.equal(ubicarToma(mapas, sumar(desde, dias), moms[0].id), null);
      assert.equal(ubicarToma(mapas, desde, 999), null);
      // orden de columnas
      const ids = [...moms].sort((a, b) => a.orden - b.orden).map(m => m.id);
      const esperadasCols = (sentidoTomas === 'derecha_izquierda' ? [...ids].reverse() : ids);
      assert.deepEqual(mapas[0].columnas.map(c => c.id), rotar180 ? [...esperadasCols].reverse() : esperadasCols);
      casos++;
    }
  }
  assert.equal(casos, 8 * 60 + 8 * 60);
});

test('blíster: convencional, fila del lunes = lunes siguiente', () => {
  // 2026-01-07 es miércoles
  const [m] = construirMapas('2026-01-07', 7, MOMENTOS.slice(0, 1));
  assert.equal(dow('2026-01-07'), 3);
  assert.equal(m.filas[0].fecha, '2026-01-12');
  assert.equal(m.filas[2].fecha, '2026-01-07');
  assert.equal(m.filas[6].fecha, '2026-01-11');
});

test('blíster: hostiles', () => {
  const m1 = MOMENTOS.slice(0, 1);
  for (const d of [0, -1, 1.5, NaN, 367, Infinity]) assert.throws(() => construirMapas('2026-01-01', d as number, m1), RangeError);
  for (const f of ['2026-02-30', '2026-1-1', '', 'hoy', '2026-01-01T00:00:00Z']) assert.throws(() => construirMapas(f, 7, m1), RangeError);
  assert.throws(() => construirMapas('2026-01-01', 7, []), RangeError);
  assert.throws(() => construirMapas('2026-01-01', 7, [MOMENTOS[0], MOMENTOS[0]]), RangeError);
  assert.equal(construirMapas('2026-01-01', 366, m1).length, 53);
  // el máximo no puede salirse del año 9999 con salida corrupta
  const r = construirMapas('9999-12-01', 7, m1);
  for (const f of r[0].filas) if (f.fecha) assert.match(f.fecha, /^\d{4}-\d{2}-\d{2}$/, 'fecha fuera de rango corrupta: ' + f.fecha);
});

test('coherencia entre módulos: toda toma del calendario tiene celda', () => {
  for (let i = 0; i < 200; i++) {
    const p = pautaAleatoria();
    const dias = ri(1, 60);
    const desde = sumar(p.vigenteDesde, ri(-5, 20));
    const hasta = sumar(desde, dias - 1);
    const moms = [...new Set(p.dosis.map(d => d.momentoId))].map((id, o) => ({ id, nombre: 'm' + id, orden: o }));
    const mapas = construirMapas(desde, dias, moms, { inicioDia: R() < 0.5 ? 'convencional' : 'cronologico', rotar180: R() < 0.5 });
    for (const t of tomasDelPeriodo(p, desde, hasta)) assert.ok(ubicarToma(mapas, t.fecha, t.momentoId));
  }
});

test('regresión: periodos que salen del año 9999 lanzan en vez de fechas corruptas', () => {
  const m1 = MOMENTOS.slice(0, 1);
  assert.throws(() => construirMapas('9999-12-30', 7, m1), RangeError);
  assert.equal(construirMapas('9999-12-25', 7, m1)[0].hasta, '9999-12-31');
  const p: Pauta = { vigenteDesde: '9999-12-30', patron: 'diario', dosis: [{ momentoId: 1, unidades: 1 }] };
  assert.throws(() => tomasDelPeriodo(p, '9999-12-30', '10000-01-02'));
  assert.equal(tomasDelPeriodo(p, '9999-12-30', '9999-12-31').length, 2);
});
