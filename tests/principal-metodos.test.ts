import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METODOS, GRUPO_DE_METODO, esMetodo } from '../src/servicios/metodos.ts';

/** Saca los métodos de una interfaz de api.ts leyendo el TEXTO del contrato. */
function metodosDe(fuente: string, interfaz: string): string[] {
  const m = new RegExp(`export interface ${interfaz} \\{\\n([\\s\\S]*?)\\n\\}\\n`).exec(fuente);
  assert.ok(m, `no se encuentra la interfaz ${interfaz} en api.ts`);
  return m![1].split('\n').map(l => /^  (\w+)\(/.exec(l)?.[1]).filter((x): x is string => !!x);
}

const api = readFileSync(new URL('../src/servicios/api.ts', import.meta.url), 'utf8');

for (const [interfaz, grupo] of [['ApiSistema', 'sistema'], ['ApiClinica', 'clinica'], ['ApiExterna', 'externa']] as const) {
  test(`metodos.ts coincide con ${interfaz} de api.ts`, () => {
    const esperados = metodosDe(api, interfaz);
    assert.ok(esperados.length > 3);
    for (const n of esperados) assert.equal(GRUPO_DE_METODO[n as keyof typeof GRUPO_DE_METODO], grupo, `${n} debería ser «${grupo}»`);
    const sobran = METODOS.filter(n => GRUPO_DE_METODO[n] === grupo && !esperados.includes(n));
    assert.deepEqual(sobran, [], `sobran en ${grupo}`);
  });
}

test('no hay métodos repetidos ni de más', () => {
  assert.equal(new Set(METODOS).size, METODOS.length);
  const total = ['ApiSistema', 'ApiClinica', 'ApiExterna'].flatMap(i => metodosDe(api, i)).length;
  assert.equal(METODOS.length, total);
});

test('esMetodo: lista blanca estricta', () => {
  assert.equal(esMetodo('estado'), true);
  for (const n of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'Estado', 'estado ', null, undefined, 3, {}]) assert.equal(esMetodo(n), false);
});
