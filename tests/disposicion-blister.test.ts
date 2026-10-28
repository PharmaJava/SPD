import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirMapas, buscarCelda, ordenLlenado, ubicarToma, DISPOSICION_POR_DEFECTO } from '../src/dominio/disposicion-blister.ts';

const M = [
  { id: 1, nombre: 'Desayuno', orden: 1 }, { id: 2, nombre: 'Comida', orden: 2 },
  { id: 3, nombre: 'Cena', orden: 3 }, { id: 4, nombre: 'Noche', orden: 4 },
];
// 2026-11-04 es miércoles; 2026-11-02 es lunes
const MIE = '2026-11-04', LUN = '2026-11-02';

test('convencional: filas = lunes…domingo; periodo que empieza en miércoles', () => {
  const [m] = construirMapas(MIE, 7, M);
  assert.deepEqual(m.filas.map(f => f.diaSemana), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(m.filas.map(f => f.fecha),
    ['2026-11-09', '2026-11-10', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(m.celdas.length, 28);
});

test('cronológico: la primera fila es el primer día', () => {
  const [m] = construirMapas(MIE, 7, M, { inicioDia: 'cronologico' });
  assert.deepEqual(m.filas.map(f => f.fecha),
    ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
  assert.equal(m.filas[0].diaSemana, 3);
});

test('semana que empieza en lunes: ambos modos coinciden', () => {
  const a = construirMapas(LUN, 7, M)[0].filas.map(f => f.fecha);
  const b = construirMapas(LUN, 7, M, { inicioDia: 'cronologico' })[0].filas.map(f => f.fecha);
  assert.deepEqual(a, b);
});

test('sentido de las tomas: derecha a izquierda invierte columnas', () => {
  const [m] = construirMapas(LUN, 7, M, { sentidoTomas: 'derecha_izquierda' });
  assert.deepEqual(m.columnas.map(c => c.nombre), ['Noche', 'Cena', 'Comida', 'Desayuno']);
});

test('rotar 180°: invierte filas y columnas, no pierde ninguna toma', () => {
  const normal = construirMapas(LUN, 7, M)[0];
  const rot = construirMapas(LUN, 7, M, { rotar180: true })[0];
  assert.deepEqual(rot.filas.map(f => f.fecha), [...normal.filas.map(f => f.fecha)].reverse());
  assert.deepEqual(rot.columnas.map(c => c.id), [...normal.columnas.map(c => c.id)].reverse());
  assert.equal(rot.celdas.length, normal.celdas.length);
});

test('rotar + derecha-izquierda se anulan en las columnas', () => {
  const [m] = construirMapas(LUN, 7, M, { rotar180: true, sentidoTomas: 'derecha_izquierda' });
  assert.deepEqual(m.columnas.map(c => c.id), [1, 2, 3, 4]);
});

test('periodo de 14 días = dos blísteres; cada fecha aparece una sola vez', () => {
  for (const modo of ['convencional', 'cronologico'] as const) {
    const mapas = construirMapas(MIE, 14, M, { inicioDia: modo });
    assert.equal(mapas.length, 2);
    const fechas = mapas.flatMap(m => m.filas.map(f => f.fecha)).filter(Boolean);
    assert.equal(fechas.length, 14);
    assert.equal(new Set(fechas).size, 14);
    assert.equal(mapas[1].desde, '2026-11-11');
    assert.equal(mapas[1].hasta, '2026-11-17');
  }
});

test('periodo parcial: filas sin usar quedan marcadas', () => {
  const [m] = construirMapas(LUN, 3, M, { inicioDia: 'cronologico' });
  assert.equal(m.celdas.filter(c => c.usada).length, 12);
  assert.equal(m.celdas.filter(c => !c.usada).length, 16);
  const [c] = construirMapas(LUN, 3, M);
  assert.equal(c.filas.filter(f => f.fecha === null).length, 4);   // jue-dom sin usar
});

test('buscarCelda y ubicarToma encuentran la celda correcta', () => {
  const mapas = construirMapas(MIE, 14, M);
  const u = ubicarToma(mapas, '2026-11-12', 3)!;
  assert.equal(u.mapa.indice, 1);
  assert.equal(u.celda.fecha, '2026-11-12');
  assert.equal(u.celda.momentoId, 3);
  assert.equal(ubicarToma(mapas, '2026-12-25', 3), null);
  assert.equal(buscarCelda(mapas[0], '2026-11-04', 99), null);
});

test('ordenLlenado empieza por el lado elegido', () => {
  const [m] = construirMapas(LUN, 7, M);
  const izq = ordenLlenado(m, 'izquierda');
  const der = ordenLlenado(m, 'derecha');
  assert.equal(izq[0].columna, 0);
  assert.equal(der[0].columna, 3);
  assert.equal(izq.length, 28);
  assert.equal(izq[0].fila, der[0].fila);
});

test('momentos desordenados se ordenan por «orden»', () => {
  const [m] = construirMapas(LUN, 7, [M[2], M[0], M[3], M[1]]);
  assert.deepEqual(m.columnas.map(c => c.id), [1, 2, 3, 4]);
});

test('un solo momento de toma', () => {
  const [m] = construirMapas(LUN, 7, [M[0]]);
  assert.equal(m.celdas.length, 7);
});

test('cruce de año y bisiesto', () => {
  const [m] = construirMapas('2027-12-27', 7, M, { inicioDia: 'cronologico' });
  assert.equal(m.hasta, '2028-01-02');
  const [b] = construirMapas('2028-02-26', 7, M, { inicioDia: 'cronologico' });
  assert.ok(b.filas.some(f => f.fecha === '2028-02-29'));
});

test('entradas inválidas lanzan error', () => {
  assert.throws(() => construirMapas('2026-02-30', 7, M), /Fecha/);
  assert.throws(() => construirMapas(LUN, 0, M), /días/);
  assert.throws(() => construirMapas(LUN, 7.5, M), /días/);
  assert.throws(() => construirMapas(LUN, 400, M), /días/);
  assert.throws(() => construirMapas(LUN, 7, []), /momento/);
  assert.throws(() => construirMapas(LUN, 7, [M[0], M[0]]), /repetidos/);
});

test('la disposición por defecto es convencional, sin rotar', () => {
  assert.equal(DISPOSICION_POR_DEFECTO.inicioDia, 'convencional');
  assert.equal(DISPOSICION_POR_DEFECTO.rotar180, false);
});
