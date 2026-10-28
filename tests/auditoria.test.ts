import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HASH_GENESIS, serializarCanonico, calcularHash, crearEntrada, verificarCadena,
  diferencias, enmascarar, sha256Hex, type EntradaAuditoria, type DatosEntrada,
} from '../src/dominio/auditoria.ts';

const T0 = Date.UTC(2026, 9, 28, 10, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function datos(i: number, extra: Partial<DatosEntrada> = {}): DatosEntrada {
  return {
    momento: iso(T0 + i * 1000), usuarioId: 1, accion: 'modificar', entidad: 'paciente',
    entidadId: String(i), antes: { dosis: i }, despues: { dosis: i + 1 }, motivo: 'ajuste', ...extra,
  };
}
function cadena(n: number): EntradaAuditoria[] {
  const r: EntradaAuditoria[] = [];
  let prev = HASH_GENESIS;
  for (let i = 0; i < n; i++) { const e = crearEntrada(datos(i), prev); r.push(e); prev = e.hash; }
  return r;
}
const clon = <T,>(x: T): T => structuredClone(x);

// ── SHA-256 ──
test('sha256 de «abc» coincide con el vector conocido', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
test('sha256 de cadena vacía', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
test('HASH_GENESIS son 64 ceros', () => { assert.equal(HASH_GENESIS, '0'.repeat(64)); });

// ── canónico ──
test('canónico: el orden de claves no importa', () => {
  assert.equal(serializarCanonico({ b: 1, a: 2 }), serializarCanonico({ a: 2, b: 1 }));
  assert.equal(serializarCanonico({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
test('canónico: anidados ordenados recursivamente', () => {
  assert.equal(serializarCanonico({ z: { y: 1, x: [{ b: 1, a: 2 }] }, a: null }), '{"a":null,"z":{"x":[{"a":2,"b":1}],"y":1}}');
});
test('canónico: el orden de un array SÍ importa', () => {
  assert.notEqual(serializarCanonico([1, 2]), serializarCanonico([2, 1]));
});
test('canónico: unicode y escapes', () => {
  assert.equal(serializarCanonico('ñ€😀'), '"ñ€😀"');
  assert.equal(serializarCanonico('a"b\n'), '"a\\"b\\n"');
  assert.notEqual(serializarCanonico({ 'ñ': 1 }), serializarCanonico({ 'n': 1 }));
});
test('canónico: null distinto de ausente', () => {
  assert.notEqual(serializarCanonico({ a: null }), serializarCanonico({}));
  assert.notEqual(serializarCanonico({ a: null, b: 1 }), serializarCanonico({ b: 1 }));
});
test('canónico: cadena «null» distinta de null; «1» distinto de 1', () => {
  assert.notEqual(serializarCanonico('null'), serializarCanonico(null));
  assert.notEqual(serializarCanonico('1'), serializarCanonico(1));
  assert.notEqual(serializarCanonico(true), serializarCanonico('true'));
});
test('canónico: -0 y 0 dan lo mismo; decimales estables', () => {
  assert.equal(serializarCanonico(-0), '0');
  assert.equal(serializarCanonico(0.5), '0.5');
});
test('canónico rechaza NaN, Infinity, undefined, función, BigInt, symbol', () => {
  assert.throws(() => serializarCanonico(NaN), /no finito/);
  assert.throws(() => serializarCanonico(Infinity), /no finito/);
  assert.throws(() => serializarCanonico(-Infinity), /no finito/);
  assert.throws(() => serializarCanonico(undefined), /undefined/);
  assert.throws(() => serializarCanonico([1, undefined]), /\[1\]/);
  // Una clave con undefined se omite (como JSON.stringify): los rechazos del dominio la producen y hay que poder auditarlos.
  assert.equal(serializarCanonico({ a: { b: undefined, c: 1 } }), '{"a":{"c":1}}');
  assert.throws(() => serializarCanonico(() => 1), /Función/);
  assert.throws(() => serializarCanonico(10n), /BigInt/);
  assert.throws(() => serializarCanonico(Symbol('x')), /Symbol/);
});
test('canónico rechaza objetos no planos (Date, Map)', () => {
  assert.throws(() => serializarCanonico(new Date()), /no plano/);
  assert.throws(() => serializarCanonico(new Map()), /no plano/);
});

// ── hash sin ambigüedad ──
test('sin ambigüedad: mover texto entre campos contiguos cambia el hash', () => {
  const base = { ...datos(0), antes: null, despues: null, motivo: null };
  const a = crearEntrada({ ...base, accion: 'ab', entidad: 'c' }, HASH_GENESIS);
  const b = crearEntrada({ ...base, accion: 'a', entidad: 'bc' }, HASH_GENESIS);
  const c = crearEntrada({ ...base, accion: 'a|b', entidad: 'c' }, HASH_GENESIS);
  const d = crearEntrada({ ...base, accion: 'a', entidad: 'b|c' }, HASH_GENESIS);
  assert.equal(new Set([a.hash, b.hash, c.hash, d.hash]).size, 4);
});
test('sin ambigüedad: null vs cadena vacía vs «null» en motivo', () => {
  const h = (motivo: string | null) => crearEntrada({ ...datos(0), motivo }, HASH_GENESIS).hash;
  assert.equal(new Set([h(null), h(''), h('null')]).size, 3);
});
test('sin ambigüedad: usuarioId null vs 0, entidadId null vs «»', () => {
  const h = (u: number | null, e: string | null) => crearEntrada({ ...datos(0), usuarioId: u, entidadId: e }, HASH_GENESIS).hash;
  assert.notEqual(h(null, 'x'), h(0, 'x'));
  assert.notEqual(h(1, null), h(1, ''));
});
test('calcularHash es determinista y de 64 hex', () => {
  const e = cadena(1)[0];
  const { hash, ...resto } = e;
  assert.equal(calcularHash(resto), hash);
  assert.match(hash, /^[0-9a-f]{64}$/);
});
test('el orden de claves de antes/despues no cambia el hash', () => {
  const a = crearEntrada({ ...datos(0), antes: { x: 1, y: 2 } }, HASH_GENESIS);
  const b = crearEntrada({ ...datos(0), antes: { y: 2, x: 1 } }, HASH_GENESIS);
  assert.equal(a.hash, b.hash);
});

// ── crearEntrada ──
test('crearEntrada exige momento ISO con ms', () => {
  assert.throws(() => crearEntrada({ ...datos(0), momento: '2026-10-28' }, HASH_GENESIS), /Momento inválido/);
  assert.throws(() => crearEntrada({ ...datos(0), momento: '2026-10-28T10:00:00Z' }, HASH_GENESIS), /Momento inválido/);
});
test('crearEntrada exige hashPrevio de 64 hex', () => {
  assert.throws(() => crearEntrada(datos(0), 'abc'), /hashPrevio/);
});
test('crearEntrada no guarda camposOcultos y enmascara antes de hashear', () => {
  const e = crearEntrada(datos(0, { antes: { hash_clave: 'secreto1', n: 1 }, despues: { hash_clave: 'secreto2', n: 2 }, camposOcultos: ['hash_clave'] }), HASH_GENESIS);
  assert.deepEqual(e.antes, { hash_clave: '***', n: 1 });
  assert.ok(!JSON.stringify(e).includes('secreto'));
  assert.ok(!('camposOcultos' in e));
  assert.equal(verificarCadena([e]).ok, true);
});
test('el secreto distinto con misma máscara da el mismo hash (no se filtra por el hash)', () => {
  const h = (s: string) => crearEntrada(datos(0, { despues: { hash_clave: s }, camposOcultos: ['hash_clave'] }), HASH_GENESIS).hash;
  assert.equal(h('a'), h('b'));
});

// ── verificarCadena ──
test('cadena vacía = ok', () => { assert.deepEqual(verificarCadena([]), { ok: true }); });
test('cadena válida de 5 entradas', () => { assert.deepEqual(verificarCadena(cadena(5)), { ok: true }); });
test('una sola entrada válida', () => { assert.equal(verificarCadena(cadena(1)).ok, true); });
test('primera que no enlaza con génesis', () => {
  const c = cadena(3);
  const e = crearEntrada(datos(0), 'a'.repeat(64));
  assert.deepEqual(verificarCadena([e, ...c.slice(1)]).primerError, { indice: 0, motivo: 'genesis' });
});
test('modificar un campo de una entrada intermedia: hash_incorrecto', () => {
  const c = cadena(5); c[2] = { ...c[2], despues: { dosis: 999 } };
  assert.deepEqual(verificarCadena(c), { ok: false, primerError: { indice: 2, motivo: 'hash_incorrecto' } });
});
test('modificar cada campo individualmente se detecta', () => {
  const cambios: Partial<EntradaAuditoria>[] = [
    { momento: iso(T0 + 2500) }, { usuarioId: 99 }, { accion: 'borrar' }, { entidad: 'x' },
    { entidadId: 'zz' }, { antes: { dosis: 5 } }, { despues: null }, { motivo: 'otro' },
  ];
  for (const cambio of cambios) {
    const c = cadena(4); c[2] = { ...c[2], ...cambio };
    const r = verificarCadena(c);
    assert.equal(r.ok, false, JSON.stringify(cambio));
    assert.equal(r.primerError?.indice, 2);
  }
});
test('modificar la primera entrada', () => {
  const c = cadena(3); c[0] = { ...c[0], accion: 'x' };
  assert.deepEqual(verificarCadena(c).primerError, { indice: 0, motivo: 'hash_incorrecto' });
});
test('modificar y recalcular su hash: rompe la siguiente (cadena_rota)', () => {
  const c = cadena(4);
  const { hash: _h, ...resto } = { ...c[1], motivo: 'falsificado' };
  c[1] = { ...resto, hash: calcularHash(resto) };
  assert.deepEqual(verificarCadena(c).primerError, { indice: 2, motivo: 'cadena_rota' });
});
test('borrar una entrada intermedia: cadena_rota', () => {
  const c = cadena(5); c.splice(2, 1);
  assert.deepEqual(verificarCadena(c).primerError, { indice: 2, motivo: 'cadena_rota' });
});
test('borrar la primera: genesis', () => {
  const c = cadena(4); c.shift();
  assert.deepEqual(verificarCadena(c).primerError, { indice: 0, motivo: 'genesis' });
});
test('borrar la última NO se detecta (limitación conocida: hace falta anclar el último hash)', () => {
  const c = cadena(4); c.pop();
  assert.equal(verificarCadena(c).ok, true);
});
test('reordenar dos entradas: cadena_rota', () => {
  const c = cadena(5); [c[1], c[2]] = [c[2], c[1]];
  assert.equal(verificarCadena(c).ok, false);
  assert.equal(verificarCadena(c).primerError?.indice, 1);
});
test('insertar una entrada ajena en medio', () => {
  const c = cadena(4);
  const intrusa = crearEntrada(datos(50), c[1].hash);   // enlaza bien con la 1…
  c.splice(2, 0, intrusa);                              // …pero la 2 ya no la sigue
  assert.deepEqual(verificarCadena(c).primerError, { indice: 3, motivo: 'cadena_rota' });
});
test('duplicar una entrada', () => {
  const c = cadena(3); c.splice(1, 0, c[1]);
  assert.equal(verificarCadena(c).ok, false);
});
test('momentos decrecientes con hashes consistentes: orden_temporal', () => {
  const a = crearEntrada({ ...datos(0), momento: iso(T0 + 5000) }, HASH_GENESIS);
  const b = crearEntrada({ ...datos(1), momento: iso(T0 + 1000) }, a.hash);
  assert.deepEqual(verificarCadena([a, b]), { ok: false, primerError: { indice: 1, motivo: 'orden_temporal' } });
});
test('mismo momento en entradas consecutivas es válido', () => {
  const a = crearEntrada(datos(0), HASH_GENESIS);
  const b = crearEntrada({ ...datos(1), momento: a.momento }, a.hash);
  assert.equal(verificarCadena([a, b]).ok, true);
});
test('entrada con valor no serializable no lanza: hash_incorrecto', () => {
  const c = cadena(2); c[1] = { ...c[1], antes: NaN };
  assert.deepEqual(verificarCadena(c).primerError, { indice: 1, motivo: 'hash_incorrecto' });
});
test('cadena larga de 1000 entradas se verifica en < 1 s', () => {
  const c = cadena(1000);
  const t = performance.now();
  const r = verificarCadena(c);
  assert.equal(r.ok, true);
  assert.ok(performance.now() - t < 1000);
});
test('en una cadena de 1000, una alteración en la 777 se localiza', () => {
  const c = cadena(1000); c[777] = { ...c[777], motivo: 'x' };
  assert.equal(verificarCadena(c).primerError?.indice, 777);
});

// ── enmascarar y diferencias ──
test('enmascarar: a cualquier profundidad, en arrays, sin mutar', () => {
  const orig = { a: { hash_clave: 'x', b: [{ hash_clave: 'y', c: 1 }] }, hash_clave: 'z' };
  const copia = clon(orig);
  assert.deepEqual(enmascarar(orig, ['hash_clave']), { a: { hash_clave: '***', b: [{ hash_clave: '***', c: 1 }] }, hash_clave: '***' });
  assert.deepEqual(orig, copia);
});
test('enmascarar sin campos devuelve el valor tal cual; primitivos intactos', () => {
  assert.equal(enmascarar(5, ['a']), 5);
  assert.equal(enmascarar(null, ['a']), null);
  const o = { a: 1 };
  assert.equal(enmascarar(o), o);
});
test('diferencias: sin cambios = vacío', () => {
  assert.deepEqual(diferencias({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), []);
});
test('diferencias: campo cambiado, añadido y quitado con rutas anidadas', () => {
  const d = diferencias({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 5, e: 4 } });
  assert.deepEqual(d, [
    { campo: 'b.c', antes: 2, despues: 5 },
    { campo: 'b.d', antes: 3, despues: undefined },
    { campo: 'b.e', antes: undefined, despues: 4 },
  ]);
});
test('diferencias: arrays por índice', () => {
  const d = diferencias({ pauta: [1, 2, 3] }, { pauta: [1, 9, 3, 4] });
  assert.deepEqual(d, [
    { campo: 'pauta.1', antes: 2, despues: 9 },
    { campo: 'pauta.3', antes: undefined, despues: 4 },
  ]);
});
test('diferencias: null distinto de ausente', () => {
  assert.deepEqual(diferencias({ a: null }, {}), [{ campo: 'a', antes: null, despues: undefined }]);
  assert.deepEqual(diferencias({ a: null }, { a: null }), []);
});
test('diferencias: antes null (alta) y despues null (baja)', () => {
  assert.deepEqual(diferencias(null, { a: 1 }), [{ campo: 'a', antes: undefined, despues: 1 }]);
  assert.deepEqual(diferencias({ a: 1 }, null), [{ campo: 'a', antes: 1, despues: undefined }]);
  assert.deepEqual(diferencias(null, null), []);
});
test('diferencias: raíz vacía no genera campos', () => {
  assert.deepEqual(diferencias({}, {}), []);
  assert.deepEqual(diferencias({}, { a: 1 }), [{ campo: 'a', antes: undefined, despues: 1 }]);
});
test('diferencias: objeto/array vacío anidado es hoja', () => {
  assert.deepEqual(diferencias({ a: [] }, { a: [1] }), [
    { campo: 'a', antes: [], despues: undefined },
    { campo: 'a.0', antes: undefined, despues: 1 },
  ]);
});
test('diferencias: camposOcultos enmascara y no filtra el secreto', () => {
  const d = diferencias({ hash_clave: 'viejo', nombre: 'A' }, { hash_clave: 'nuevo', nombre: 'B' }, ['hash_clave']);
  assert.deepEqual(d, [{ campo: 'nombre', antes: 'A', despues: 'B' }]);
  const d2 = diferencias({ x: { hash_clave: 'v' } }, null, ['hash_clave']);
  assert.deepEqual(d2, [{ campo: 'x.hash_clave', antes: '***', despues: undefined }]);
  assert.ok(!JSON.stringify(d2).includes('"v"'));
});
