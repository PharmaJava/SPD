/**
 * El modo de pruebas (capturas) no debe cambiar NADA de la aplicación normal: todo desvío del comportamiento
 * pasa por `modoPruebas` (que es null sin la variable) y ninguna otra parte del código lee SPD_CAPTURAS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/principal/', import.meta.url);
const fuentes = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => ({ f, t: readFileSync(new URL(f, dir), 'utf8') }));
const sinComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('sólo modo-pruebas.ts lee SPD_CAPTURAS / SPD_DATOS_PRUEBAS', () => {
  for (const { f, t } of fuentes) {
    if (f === 'modo-pruebas.ts') continue;
    assert.ok(!/SPD_CAPTURAS|SPD_DATOS_PRUEBAS/.test(sinComentarios(t)), `${f} no debe leer las variables del modo de pruebas`);
  }
});

test('main.ts: el modo se calcula con leerModoPruebas(process.env, app.isPackaged)', () => {
  const main = fuentes.find(x => x.f === 'main.ts')!.t;
  assert.match(main, /leerModoPruebas\(process\.env, app\.isPackaged\)/);
});

test('main.ts: todo uso del modo es condicional (modoPruebas && … / modoPruebas ? … / !modoPruebas)', () => {
  const main = sinComentarios(fuentes.find(x => x.f === 'main.ts')!.t);
  const usos = [...main.matchAll(/modoPruebas/g)].map(m => main.slice(Math.max(0, m.index! - 12), m.index! + 40));
  assert.ok(usos.length >= 5);
  const lineas = main.split('\n').filter(l => l.includes('modoPruebas'));
  for (const l of lineas) {
    assert.ok(/const modoPruebas = |!modoPruebas|modoPruebas \?|modoPruebas\)|if \(modoPruebas|modoPruebas\.rutaDatos/.test(l), `uso no condicional: ${l.trim()}`);
  }
});

test('sin la variable, el modo es null y la ruta de datos es la normal', () => {
  const main = fuentes.find(x => x.f === 'main.ts')!.t;
  assert.match(main, /modoPruebas \? path\.join\(modoPruebas\.rutaDatos, 'datos'\) : path\.join\(app\.getPath\('userData'\), 'datos'\)/);
  assert.match(main, /if \(!modoPruebas && !app\.requestSingleInstanceLock\(\)\)/);
});
