import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializarCanonico, crearEntrada, verificarCadena, enmascarar, diferencias,
  HASH_GENESIS, calcularHash, MASCARA,
} from '../src/dominio/auditoria.ts';
import type { EntradaAuditoria } from '../src/dominio/auditoria.ts';
import {
  clasificarMedicamento, clasificarPorForma, normalizar, evaluarIdoneidad,
} from '../src/dominio/aptitud-spd.ts';

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
const R = rng(987654321);
const ri = (n: number) => Math.floor(R() * n);
const pick = <T>(a: readonly T[]): T => a[ri(a.length)];

const ALFABETO = ['a', 'b', 'Z', '0', '9', ' ', '"', '\\', '/', '\n', '\t', 'ñ', 'é', 'ß', '€', '😀', '\u0000', ' ', '{', '}', '[', ']', ',', ':', '.'];
function str(): string { let s = ''; for (let i = ri(6); i > 0; i--) s += pick(ALFABETO); return s; }
const NUMS = [0, 1, -1, 2, 0.5, 0.1 + 0.2, 1e21, 1e-7, 123456789012, -3.14, 255, 1e300, Number.MAX_SAFE_INTEGER];
function valor(prof = 0): unknown {
  const t = ri(prof > 3 ? 5 : 8);
  switch (t) {
    case 0: return str();
    case 1: return pick(NUMS);
    case 2: return R() < 0.5;
    case 3: return null;
    case 4: return ri(1000);
    case 5: { const n = ri(4); return Array.from({ length: n }, () => valor(prof + 1)); }
    default: {
      const o: Record<string, unknown> = {};
      for (let i = ri(4); i > 0; i--) o[R() < 0.2 ? String(ri(20)) : str()] = valor(prof + 1);
      return o;
    }
  }
}

/** Identidad estructural con tipos etiquetados (independiente del serializador). */
function ident(v: unknown): string {
  if (v === null) return 'N';
  if (typeof v === 'string') return 'S' + JSON.stringify(v);
  if (typeof v === 'number') return 'D' + (Object.is(v, -0) ? '0' : String(v));
  if (typeof v === 'boolean') return 'B' + v;
  if (Array.isArray(v)) return 'A[' + v.map(ident).join('|') + ']';
  const o = v as Record<string, unknown>;
  return 'O{' + Object.keys(o).sort().map(k => JSON.stringify(k) + '=' + ident(o[k])).join('|') + '}';
}

// ─────────────────────────────── AUDITORÍA ──────────────────────────────────

function cadena(n: number): EntradaAuditoria[] {
  const out: EntradaAuditoria[] = [];
  let prev = HASH_GENESIS;
  let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    t += ri(5000);
    const e = crearEntrada({
      momento: new Date(t).toISOString(),
      usuarioId: R() < 0.2 ? null : ri(5),
      accion: pick(['crear', 'modificar', 'ver', 'imprimir']),
      entidad: pick(['paciente', 'pauta', 'envase']),
      entidadId: R() < 0.2 ? null : String(ri(100)),
      antes: valor(), despues: valor(),
      motivo: R() < 0.5 ? null : str(),
    }, prev);
    out.push(e); prev = e.hash;
  }
  return out;
}
const clon = (c: EntradaAuditoria[]): EntradaAuditoria[] => structuredClone(c);

test('fuzz: cadenas intactas verifican; cualquier mutación se detecta (salvo borrar la última)', () => {
  let casos = 0;
  for (let it = 0; it < 600; it++) {
    const n = 5 + ri(46);
    const c = cadena(n);
    assert.equal(verificarCadena(c).ok, true);
    const m = clon(c);
    const tipo = ri(7);
    let descripcion = '';
    switch (tipo) {
      case 0: { // cambiar un campo cualquiera por otro valor distinto
        const i = ri(n);
        const campo = pick(['momento', 'usuarioId', 'accion', 'entidad', 'entidadId', 'antes', 'despues', 'motivo', 'hashPrevio', 'hash'] as const);
        const orig = (m[i] as any)[campo];
        let nuevo: unknown;
        let k = 0;
        do {
          nuevo = campo === 'momento' ? new Date(Date.UTC(2026, 0, 1) + ri(1e9)).toISOString()
            : campo === 'hash' || campo === 'hashPrevio' ? [...Array(64)].map(() => '0123456789abcdef'[ri(16)]).join('')
            : campo === 'usuarioId' ? pick([null, ri(9), '1', 1.5])
            : campo === 'antes' || campo === 'despues' ? valor()
            : pick([null, str(), 'x']);
          k++;
        } while (ident(nuevo) === ident(orig) && k < 50);
        if (ident(nuevo) === ident(orig)) continue;
        (m[i] as any)[campo] = nuevo;
        descripcion = `campo ${campo}@${i}`;
        break;
      }
      case 1: { // borrar una intermedia
        const i = ri(n - 1);
        m.splice(i, 1); descripcion = `borrar ${i}`; break;
      }
      case 2: { // intercambiar dos
        const i = ri(n); let j = ri(n); if (i === j) j = (j + 1) % n;
        if (c[i].hash === c[j].hash) continue;
        [m[i], m[j]] = [m[j], m[i]]; descripcion = `swap ${i},${j}`; break;
      }
      case 3: { // insertar copia de otra entrada en posición arbitraria
        const i = ri(n); const p = ri(n + 1);
        m.splice(p, 0, structuredClone(c[i])); descripcion = `copia ${i}@${p}`; break;
      }
      case 4: { // truncar el medio (borrar un tramo que NO llega al final)
        const i = ri(n - 2); const len = 1 + ri(n - 1 - i - 1 || 1);
        if (i + len >= n) continue;
        m.splice(i, len); descripcion = `truncar ${i}+${len}`; break;
      }
      case 5: { // borrar la primera
        m.shift(); descripcion = 'borrar primera'; break;
      }
      default: { // añadir un campo de más a nivel profundo en antes (si es objeto) o cambiar leaf
        const i = ri(n);
        m[i].antes = { x: m[i].antes, extra: 1 }; descripcion = `envolver antes@${i}`; break;
      }
    }
    casos++;
    const r = verificarCadena(m);
    assert.equal(r.ok, false, `mutación no detectada: ${descripcion}`);
  }
  assert.ok(casos > 500);
});

test('borrar la última NO es detectable (limitación documentada)', () => {
  const c = cadena(10); c.pop();
  assert.equal(verificarCadena(c).ok, true);
});

test('cadena vacía ok; basura estructural no lanza, devuelve ok:false', () => {
  assert.equal(verificarCadena([]).ok, true);
  for (const malo of [[null], [undefined], [{}], [42], ['x'], [{ hash: 'a' }]]) {
    let r;
    assert.doesNotThrow(() => { r = verificarCadena(malo as any); });
    assert.equal((r as any).ok, false);
  }
  // segunda posición corrupta
  const c = cadena(3);
  assert.doesNotThrow(() => verificarCadena([c[0], null as any]));
  assert.equal(verificarCadena([c[0], null as any]).ok, false);
});

test('serializarCanónico: no colisiona entre valores distintos (5000 pares)', () => {
  let distintos = 0;
  for (let i = 0; i < 5000; i++) {
    const a = valor(), b = i % 3 === 0 ? structuredClone(a) : valor();
    const sa = serializarCanonico(a), sb = serializarCanonico(b);
    if (ident(a) === ident(b)) assert.equal(sa, sb, 'iguales deben serializar igual');
    else { distintos++; assert.notEqual(sa, sb, `colisión: ${ident(a)} vs ${ident(b)}`); }
  }
  assert.ok(distintos > 3000);
});

test('serializarCanónico: orden de claves irrelevante; casos de borde', () => {
  assert.equal(serializarCanonico({ b: 1, a: 2 }), serializarCanonico({ a: 2, b: 1 }));
  assert.equal(serializarCanonico({ '10': 1, '9': 2, a: 3 }), serializarCanonico({ a: 3, '9': 2, '10': 1 }));
  assert.equal(serializarCanonico(-0), serializarCanonico(0));
  assert.equal(serializarCanonico(1e21), '1e+21');
  assert.equal(serializarCanonico(0.1 + 0.2), '0.30000000000000004');
  assert.notEqual(serializarCanonico('1'), serializarCanonico(1));
  assert.notEqual(serializarCanonico(null), serializarCanonico('null'));
  assert.notEqual(serializarCanonico({ a: null }), serializarCanonico({}));
  assert.notEqual(serializarCanonico([]), serializarCanonico({}));
  assert.notEqual(serializarCanonico(['a,b']), serializarCanonico(['a', 'b']));
  assert.notEqual(serializarCanonico('a"b'), serializarCanonico('a\\"b'));
  assert.notEqual(serializarCanonico({ 'a":1,"b': 2 }), serializarCanonico({ a: 1, b: 2 }));
  // surrogates sueltos distintos
  assert.notEqual(serializarCanonico('\ud800'), serializarCanonico('\ud801'));
  assert.notEqual(serializarCanonico('\ud800'), serializarCanonico('�'));
  // orden unicode: astral vs BMP alto — determinista aunque no sea «punto de código»
  const o1 = { '\u{1F600}': 1, '￿': 2 };
  const o2 = { '￿': 2, '\u{1F600}': 1 };
  assert.equal(serializarCanonico(o1), serializarCanonico(o2));
  // fechas límite en el momento
  assert.throws(() => crearEntrada({ momento: '2026-13-01T00:00:00.000Z', usuarioId: 1, accion: 'a', entidad: 'e', entidadId: null, antes: null, despues: null, motivo: null }, HASH_GENESIS), /Momento/);
  assert.doesNotThrow(() => crearEntrada({ momento: '9999-12-31T23:59:59.999Z', usuarioId: 1, accion: 'a', entidad: 'e', entidadId: null, antes: null, despues: null, motivo: null }, HASH_GENESIS));
});

test('serializarCanónico rechaza lo no inequívoco', () => {
  for (const v of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), new Date(), new Map(), [1, undefined], { a: undefined }, new (class A { x = 1; })()]) {
    assert.throws(() => serializarCanonico(v), undefined, String(v));
  }
});

test('arrays dispersos (huecos) no producen JSON inválido silencioso', () => {
  // eslint-disable-next-line no-sparse-arrays
  const dispersoA = [1, , 3];
  assert.throws(() => serializarCanonico(dispersoA));
});

test('clave __proto__ propia (JSON.parse) sobrevive a enmascarar y al hash', () => {
  const v = JSON.parse('{"__proto__":{"a":1},"b":2}');
  assert.equal(serializarCanonico(v), '{"__proto__":{"a":1},"b":2}');
  const m = enmascarar(v, ['zzz']) as any;     // sin ocultos devuelve el mismo
  assert.equal(serializarCanonico(m), '{"__proto__":{"a":1},"b":2}');
  const m2 = enmascarar(v, ['b']);
  assert.equal(serializarCanonico(m2), '{"__proto__":{"a":1},"b":"***"}');
  const m3 = enmascarar(v, ['a']);          // enmascara a profundidad dentro de __proto__
  assert.equal(serializarCanonico(m3), '{"__proto__":{"a":"***"},"b":2}');
});

test('enmascarar: profundidad, arrays, no muta, claves ocultas con valor objeto', () => {
  const orig = { a: { clave: 'x', l: [{ clave: 1 }, [{ hash_clave: { z: 1 } }]] }, hash_clave: 'sec' };
  const copia = structuredClone(orig);
  const m = enmascarar(orig, ['clave', 'hash_clave']) as any;
  assert.deepEqual(orig, copia);
  assert.equal(m.hash_clave, MASCARA);
  assert.equal(m.a.clave, MASCARA);
  assert.equal(m.a.l[0].clave, MASCARA);
  assert.equal(m.a.l[1][0].hash_clave, MASCARA);
  // la entrada creada nunca contiene el secreto
  const e = crearEntrada({ momento: '2026-01-01T00:00:00.000Z', usuarioId: 1, accion: 'm', entidad: 'u', entidadId: '1',
    antes: orig, despues: { hash_clave: 'nuevo' }, motivo: null, camposOcultos: ['hash_clave'] }, HASH_GENESIS);
  assert.ok(!JSON.stringify(e).includes('sec') && !JSON.stringify(e).includes('nuevo'));
  // un secreto de otro tipo distinto no cambia el hash (enmascarado antes)
  const e2 = crearEntrada({ momento: '2026-01-01T00:00:00.000Z', usuarioId: 1, accion: 'm', entidad: 'u', entidadId: '1',
    antes: orig, despues: { hash_clave: 12345 }, motivo: null, camposOcultos: ['hash_clave'] }, HASH_GENESIS);
  assert.equal(e.hash, e2.hash);
});

test('enmascarar no deja pasar claves ocultas dentro de objetos no planos (fallan, no se filtran)', () => {
  assert.throws(() => crearEntrada({ momento: '2026-01-01T00:00:00.000Z', usuarioId: 1, accion: 'm', entidad: 'u', entidadId: null,
    antes: { f: new Date(), hash_clave: 'x' }, despues: null, motivo: null, camposOcultos: ['hash_clave'] }, HASH_GENESIS));
});

test('diferencias: sin filtrar secretos y sin perder cambios con puntos en claves', () => {
  const d = diferencias({ hash_clave: 'a', x: 1 }, { hash_clave: 'b', x: 2 }, ['hash_clave']);
  assert.deepEqual(d.map(x => x.campo), ['x']);
  // clave con punto vs anidado: ambos cambian y los dos deben aparecer
  const antes = { a: { b: 1 }, 'a.b': 10 };
  const despues = { a: { b: 2 }, 'a.b': 20 };
  const r = diferencias(antes, despues);
  assert.ok(r.length >= 2, `se perdió un cambio por colisión de ruta: ${JSON.stringify(r)}`);
});

// ─────────────────────────────── APTITUD ────────────────────────────────────

type E = 'apto' | 'precaucion' | 'no_apto' | null;
function est(nombre: string, forma?: string, pa?: string): E {
  const r = clasificarMedicamento({ nombre, formaFarmaceutica: forma, principioActivo: pa });
  return r ? r.estado : null;
}

test('aptitud: 100+ casos con estado esperado claro', () => {
  const casos: Array<[string, string | undefined, string | undefined, E]> = [
    // [nombre, forma, principioActivo, esperado]
    ['Sintrom 4 mg', 'COMPRIMIDO', 'acenocumarol', 'no_apto'],
    ['Aldocumar 5 mg', 'COMPRIMIDO', 'warfarina', 'no_apto'],
    ['Methotrexate', 'COMPRIMIDO', 'metotrexato', 'no_apto'],
    ['Xeloda', 'COMPRIMIDO RECUBIERTO CON PELICULA', 'capecitabina', 'no_apto'],
    ['Hydrea', 'CAPSULA DURA', 'hidroxiurea', 'no_apto'],
    ['Cafinitrina', 'COMPRIMIDO', undefined, 'no_apto'],
    ['Vernies', 'COMPRIMIDO SUBLINGUAL', undefined, 'no_apto'],
    ['Efferalgan 1 g', 'COMPRIMIDO EFERVESCENTE', 'paracetamol', 'no_apto'],
    ['Paracetamol 1 g efervescente', undefined, 'paracetamol', 'no_apto'],
    ['Adiro efervescente', undefined, undefined, 'no_apto'],
    ['Zolmitriptan Flas', 'COMPRIMIDO BUCODISPERSABLE', undefined, 'no_apto'],
    ['Mirtazapina Flas', undefined, undefined, 'no_apto'],
    ['Lamotrigina dispersable', 'COMPRIMIDO DISPERSABLE', undefined, 'no_apto'],
    ['Zomig Rapimelt', 'COMPRIMIDO ORODISPERSABLE', undefined, 'no_apto'],
    ['Olanzapina Velotab', 'LIOFILIZADO ORAL', undefined, 'no_apto'],
    ['Almax', 'GRANULADO', undefined, 'no_apto'],
    ['Paracetamol 1 g', 'SOBRE', 'paracetamol', 'no_apto'],
    ['Gaviscon', 'SUSPENSION ORAL', undefined, 'no_apto'],
    ['Dolalgial', 'SOLUCION ORAL', undefined, 'no_apto'],
    ['Apiretal gotas', 'GOTAS ORALES', undefined, 'no_apto'],
    ['Tobradex', 'COLIRIO EN SUSPENSION', undefined, 'no_apto'],
    ['Otix', 'GOTAS OTICAS', undefined, 'no_apto'],
    ['Rhinocort', 'SUSPENSION PARA PULVERIZACION NASAL', undefined, 'no_apto'],
    ['Ventolin', 'SUSPENSION PARA INHALACION EN ENVASE A PRESION', undefined, 'no_apto'],
    ['Symbicort', 'POLVO PARA INHALACION', undefined, 'no_apto'],
    ['Fentanilo Matrix', 'PARCHE TRANSDERMICO', undefined, 'no_apto'],
    ['Voltaren', 'EMULGEL', undefined, 'no_apto'],
    ['Fucidine', 'CREMA', undefined, 'no_apto'],
    ['Diazepam', 'SUPOSITORIO', undefined, 'no_apto'],
    ['Gine Canesten', 'COMPRIMIDO VAGINAL', undefined, 'no_apto'],
    ['Lantus', 'SOLUCION INYECTABLE EN PLUMA PRECARGADA', 'insulina glargina', 'no_apto'],
    ['Enoxaparina', 'JERINGA PRECARGADA', undefined, 'no_apto'],
    ['Eutirox 50 mcg', 'COMPRIMIDO', undefined, 'precaucion'],
    ['Levothroid', undefined, undefined, 'precaucion'],
    ['Digoxina Kern', 'COMPRIMIDO', 'digoxina', 'precaucion'],
    ['Plenur 400', 'COMPRIMIDO DE LIBERACION PROLONGADA', undefined, 'precaucion'],
    ['Carbonato de litio', 'COMPRIMIDO', undefined, 'precaucion'],
    ['Fosamax 70', 'COMPRIMIDO', 'alendronato', 'precaucion'],
    ['Omeprazol Normon', 'CAPSULA DURA GASTRORRESISTENTE', 'omeprazol', 'precaucion'],
    ['Pantoprazol', 'COMPRIMIDO GASTRORRESISTENTE', 'pantoprazol', 'precaucion'],
    ['Adiro 100', 'COMPRIMIDO GASTRORRESISTENTE', undefined, 'precaucion'],
    ['Metformina 850', 'COMPRIMIDO RECUBIERTO', 'metformina', 'apto'],
    ['Dianben 850', 'COMPRIMIDO', undefined, 'apto'],
    ['Enalapril Cinfa 20', 'COMPRIMIDO', 'enalapril', 'apto'],
    ['Amlodipino', 'COMPRIMIDO', 'amlodipino', 'apto'],
    ['Atorvastatina', 'COMPRIMIDO RECUBIERTO CON PELICULA', 'atorvastatina', 'apto'],
    ['Orfidal 1 mg', 'COMPRIMIDO', undefined, 'apto'],
    ['Nolotil', 'CAPSULA DURA', 'metamizol', 'apto'],
    ['Sertralina', 'COMPRIMIDO', 'sertralina', 'apto'],
    ['Furosemida', 'COMPRIMIDO', 'furosemida', 'apto'],
    ['Losartan', 'COMPRIMIDO', 'losartan', 'apto'],
    ['Gliclazida', 'COMPRIMIDO', 'gliclazida', 'apto'],
    // liberación modificada
    ['Tramadol retard', 'COMPRIMIDO', undefined, 'precaucion'],
    ['Quetiapina XR', 'COMPRIMIDO', undefined, 'precaucion'],
    ['Quetiapina XL', 'COMPRIMIDO', undefined, 'precaucion'],
    ['Metformina SR', undefined, 'metformina', 'precaucion'],
    ['Paroxetina MR', undefined, undefined, 'precaucion'],
    ['Concerta', 'COMPRIMIDO DE LIBERACION PROLONGADA', undefined, 'precaucion'],
    ['Nifedipino OROS', undefined, undefined, 'precaucion'],
    ['Diltiazem', 'COMPRIMIDO DE LIBERACION MODIFICADA', undefined, 'precaucion'],
    ['Venlafaxina', 'CAPSULA DE LIBERACION PROLONGADA', undefined, 'precaucion'],
    ['Metformina', 'COMPRIMIDO DE LIBERACION RETARDADA', 'metformina', 'precaucion'],
    ['Masticable', 'COMPRIMIDO MASTICABLE', undefined, 'precaucion'],
    // sin información → null
    ['Fármaco desconocido 5 mg', 'COMPRIMIDO', undefined, null],
    ['', undefined, undefined, null],
  ];
  assert.ok(casos.length >= 60);
  const fallos: string[] = [];
  for (const [n, f, pa, esp] of casos) {
    const got = est(n, f, pa);
    if (got !== esp) fallos.push(`${n} | ${f} | ${pa}: esperado ${esp}, obtenido ${got}`);
  }
  assert.deepEqual(fallos, []);
});

test('aptitud: falsos positivos por subcadena en la FORMA', () => {
  // ninguna de estas formas/nombres contiene la palabra de la regla como palabra
  const inocuos = [
    'COMPRIMIDO RECUBIERTO', 'COMPRIMIDO', 'CAPSULA DURA', 'CAPSULA BLANDA', 'COMPRIMIDO CON LA COMIDA',
    'COMPRIMIDO DE CROMO', 'COMPRIMIDO CR', 'COMPRIMIDO LA', 'ALMA', 'Salazopyrina', 'Carvedilol', 'Melatonina',
    'Gelocatil', 'Mesalazina', 'Doxazosina', 'Bromazepam', 'Diazepam', 'Cresemba', 'Xarelto', 'Gotas',
  ];
  const esperadoNull = ['COMPRIMIDO RECUBIERTO', 'COMPRIMIDO', 'CAPSULA DURA', 'CAPSULA BLANDA', 'COMPRIMIDO CON LA COMIDA',
    'COMPRIMIDO DE CROMO', 'COMPRIMIDO CR', 'COMPRIMIDO LA', 'ALMA', 'Salazopyrina', 'Carvedilol', 'Melatonina', 'Gelocatil',
    'Mesalazina', 'Doxazosina', 'Bromazepam', 'Diazepam', 'Cresemba', 'Xarelto'];
  for (const t of esperadoNull) assert.equal(clasificarPorForma(t), null, `falso positivo con «${t}»`);
  assert.ok(clasificarPorForma('Gotas') !== null && inocuos.length > 0);
});

test('aptitud: falsos positivos reales por subcadena (otic, soluble…)', () => {
  // «antibiótico/probiótico/osmótico/hipnótico» contienen «otic» pero NO son vía ótica
  for (const t of ['Probiotico en capsulas', 'Laxante osmotico comprimido', 'Antibiotico oral comprimido', 'Hipnotico comprimido']) {
    const r = clasificarPorForma(t);
    assert.ok(!r || !/ótica|otica/i.test(r.motivo), `motivo ótico falso con «${t}»: ${r?.motivo}`);
  }
});

test('aptitud: esomeprazol se resuelve a su ficha, no a la de omeprazol', () => {
  const r = clasificarMedicamento({ principioActivo: 'esomeprazol magnesio trihidrato' });
  assert.ok(r);
  assert.match(r!.motivo, /Granulado gastrorresistente: no partir/);
});

test('aptitud: nombres que coinciden con propiedades de Object nunca devuelven basura', () => {
  for (const x of ['constructor', '__proto__', 'CONSTRUCTOR', 'hasOwnProperty', 'toString', 'valueOf', '__defineGetter__', 'prototype']) {
    for (const campo of ['nombre', 'principioActivo', 'formaFarmaceutica'] as const) {
      const r = clasificarMedicamento({ [campo]: x });
      assert.ok(r === null || ['apto', 'precaucion', 'no_apto'].includes(r.estado), `${campo}=${x} -> ${JSON.stringify(r)}`);
    }
  }
});

test('aptitud: normalización, tildes, mayúsculas, espacios, entradas raras', () => {
  assert.equal(normalizar('  ÁCIDO   Acetilsalicílico \n'), 'acido acetilsalicilico');
  assert.equal(normalizar('ñandú'), 'nandu');
  assert.equal(normalizar(undefined), '');
  assert.equal(normalizar(123 as any), '');
  assert.equal(normalizar(null), '');
  assert.equal(est('ADIRO 100', undefined, 'ÁCIDO ACETILSALICÍLICO'), 'precaucion');
  assert.equal(est('x', 'Comprimido   EFERVESCENTE'), 'no_apto');
  assert.equal(est('x', 'Liberación   Prolongada'), 'precaucion');
  assert.equal(est('x', 'LIBERACIÓN MODIFICADA'), 'precaucion');
  // descompuesto NFD vs compuesto NFC
  assert.equal(est('x', 'liberación prolongada'), 'precaucion');
  // entradas inválidas
  for (const bad of [undefined, null, {}, { nombre: 5 }, { nombre: null }, { formaFarmaceutica: {} }, { principioActivo: [] }] as any[]) {
    assert.doesNotThrow(() => clasificarMedicamento(bad));
    assert.equal(clasificarMedicamento(bad), null);
  }
});

test('aptitud: «aas» sólo exacto; alias cortos no disparan por subcadena', () => {
  assert.equal(est('AAS'), 'precaucion');
  assert.equal(est('Paraasol comprimidos'), null);
  assert.equal(est('Baasen'), null);
});

test('aptitud: rendimiento y sin regex catastróficas (1 MB)', () => {
  const casos = [
    'a'.repeat(1_000_000),
    ' '.repeat(1_000_000),
    'comprimido '.repeat(100_000),
    'sobre'.repeat(200_000),
    'x'.repeat(500_000) + ' sobre',
    'é'.repeat(500_000),
    'sr '.repeat(300_000),
    '́'.repeat(1_000_000),
  ];
  for (const t of casos) {
    const t0 = performance.now();
    clasificarMedicamento({ nombre: t, formaFarmaceutica: t, principioActivo: t });
    const dt = performance.now() - t0;
    // Umbral holgado a propósito: una regex catastrófica tarda segundos o más; 200 ms daba falsos rojos con la máquina ocupada.
    assert.ok(dt < 1000, `lento (${dt.toFixed(0)} ms) con entrada de ${t.length} chars`);
  }
});

test('aptitud: siempre decidePor motor y campos completos', () => {
  const nombres = ['Sintrom', 'Eutirox', 'Dianben', 'Efferalgan efervescente', 'Tramadol retard', 'zzz'];
  for (const n of nombres) {
    const r = clasificarMedicamento({ nombre: n });
    if (r) {
      assert.equal(r.decidePor, 'motor');
      assert.ok(r.motivo && r.fuente && r.categoria);
    }
  }
});

test('aptitud: ordenación coherente — la forma manda sobre el principio activo apto', () => {
  assert.equal(est('Metformina 850 sobres', undefined, 'metformina'), 'no_apto');
  assert.equal(est('Metformina', 'COMPRIMIDO EFERVESCENTE', 'metformina'), 'no_apto');
  assert.equal(est('Sintrom', 'SOBRE', 'acenocumarol'), 'no_apto');
});

test('idoneidad: robustez de entradas', () => {
  for (const p of [undefined, null, {}, { numFarmacos: 'abc' }, { numFarmacos: '-5' }, { numFarmacos: NaN }, { tomasDia: Infinity }, { numFarmacos: '12 fármacos' }] as any[]) {
    const r = evaluarIdoneidad(p);
    assert.ok(Number.isFinite(r.puntuacion) && r.puntuacion >= 0);
    assert.ok(['alta', 'media', 'baja'].includes(r.nivel));
  }
  assert.equal(evaluarIdoneidad({ numFarmacos: '12 fármacos' }).puntuacion, 3);
  assert.equal(evaluarIdoneidad({ numFarmacos: 10 }).nivel, 'media');
  assert.equal(evaluarIdoneidad({ numFarmacos: 10, tomasDia: 4, olvidos: 'frecuente' }).nivel, 'alta');
});

// Informe (no aserciones): casos discutibles clínicamente.
test('informe de casos discutibles (no falla)', () => {
  const discutibles: Array<[string, string | undefined, string | undefined]> = [
    ['Metformina LP', undefined, 'metformina'],
    ['Diltiazem LP', undefined, undefined],
    ['Alprazolam CR', undefined, undefined],
    ['Comprimido de acción prolongada', 'prolongada', undefined],
    ['Diclofenaco', 'COMPRIMIDO GASTRORRESISTENTE', undefined],
    ['Metformina/Sitagliptina', undefined, 'sitagliptina/metformina'],
    ['Tramadol/Paracetamol', undefined, 'paracetamol'],
    ['Paracetamol', 'COMPRIMIDO BUCODISPERSABLE', 'paracetamol'],
    ['Fosamax Plus D', undefined, undefined],
    ['Levotiroxina', 'CAPSULA BLANDA', 'levotiroxina'],
    ['Alendronato semanal', undefined, 'alendronato'],
    ['Metotrexato', 'SOLUCION INYECTABLE', 'metotrexato'],
  ];
  const lineas = discutibles.map(([n, f, p]) => `${n} | ${f} | ${p} -> ${est(n, f, p)}`);
  console.log('DISCUTIBLES:\n' + lineas.join('\n'));
});
