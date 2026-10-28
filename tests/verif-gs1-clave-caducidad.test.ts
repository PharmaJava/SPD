import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GS, parsearGS1, fechaGS1, normalizarCN, cnDesdeGtin, gtinValido, digitoControlGS1,
} from '../src/dominio/gs1.ts';
import {
  aBase32, deBase32, textoRecuperacion, claveDesdeTexto, uriAutenticador,
} from '../src/dominio/clave-recuperacion.ts';
import {
  calcularCaducidadSpd, periodoCabe, puedeValidar, type EntradaCaducidad,
} from '../src/dominio/caducidad-spd.ts';

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
const HOY = new Date(Date.UTC(2026, 9, 28));
const pad = (n: number, l = 2) => String(n).padStart(l, '0');
const gtinDe = (cn: string) => {
  const sin = '0847000' + cn;
  return sin + digitoControlGS1(sin);
};
const ALF_LOTE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

// ===================== GS1 =====================

test('fechaGS1: todos los meses 2020-2060, día 00 = último día, bisiestos', () => {
  for (let y = 2020; y <= 2060; y++) {
    for (let m = 1; m <= 12; m++) {
      const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const aa = pad(y % 100);
      assert.equal(fechaGS1(`${aa}${pad(m)}00`, HOY), `${y}-${pad(m)}-${pad(ultimo)}`, `${y}-${m}`);
      assert.equal(fechaGS1(`${aa}${pad(m)}${pad(ultimo)}`, HOY), `${y}-${pad(m)}-${pad(ultimo)}`);
      assert.equal(fechaGS1(`${aa}${pad(m)}${pad(ultimo + 1)}`, HOY), null, `día ${ultimo + 1} de ${y}-${m}`);
    }
  }
  assert.equal(fechaGS1('280229', HOY), '2028-02-29');
  assert.equal(fechaGS1('270229', HOY), null);
  assert.equal(fechaGS1('260230', HOY), null);
  assert.equal(fechaGS1('260431', HOY), null);
  assert.equal(fechaGS1('260001', HOY), null);
  assert.equal(fechaGS1('261301', HOY), null);
});

test('fechaGS1: ventana de siglo (+50/-49) y formato', () => {
  assert.equal(fechaGS1('760101', HOY), '2076-01-01');   // +50
  assert.equal(fechaGS1('770101', HOY), '1977-01-01');   // +51 → siglo anterior
  assert.equal(fechaGS1('770101', new Date(Date.UTC(2027, 0, 1))), '2077-01-01');
  assert.equal(fechaGS1('000101', HOY), '2000-01-01');
  assert.equal(fechaGS1('000229', HOY), '2000-02-29');   // 2000 bisiesto
  assert.equal(fechaGS1('990101', HOY), '1999-01-01');
  for (const mala of ['', '12345', '1234567', 'abcdef', '26-01-01', '26010 ', ' 260101', '２６０１０１', '26010１', '260101\n']) {
    assert.equal(fechaGS1(mala, HOY), null, JSON.stringify(mala));
  }
});

test('GS1: campos en todos los órdenes, lotes 1-20 con GS y GS terminal opcional (500 casos aleatorios)', () => {
  const r = rng(20261028);
  let n = 0;
  for (let i = 0; i < 500; i++) {
    const cn = pad(Math.floor(r() * 1e6), 6);
    const gtin = gtinDe(cn);
    const len = 1 + Math.floor(r() * 20);
    let lote = '';
    for (let k = 0; k < len; k++) lote += ALF_LOTE[Math.floor(r() * ALF_LOTE.length)];
    const serieLen = 1 + Math.floor(r() * 20);
    let serie = '';
    for (let k = 0; k < serieLen; k++) serie += ALF_LOTE[Math.floor(r() * ALF_LOTE.length)];
    const y = 2026 + Math.floor(r() * 10), m = 1 + Math.floor(r() * 12);
    const exp = `${pad(y % 100)}${pad(m)}00`;
    // orden aleatorio de los 4 campos, con GS tras cada variable
    const campos: [string, string, boolean][] = [['01', gtin, false], ['17', exp, false], ['10', lote, true], ['21', serie, true]];
    for (let k = campos.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [campos[k], campos[j]] = [campos[j], campos[k]]; }
    let s = '';
    campos.forEach(([ai, v, vari], idx) => {
      s += ai + v;
      if (vari && (idx < campos.length - 1 || r() < 0.5)) s += GS;
    });
    const prefijos = ['', ']d2', GS, ']d2' + GS];
    const entrada = prefijos[Math.floor(r() * 4)] + s + (r() < 0.3 ? '\r\n' : '');
    const out = parsearGS1(entrada, { hoy: HOY });
    assert.deepEqual(out.errores, [], JSON.stringify(entrada));
    assert.equal(out.ambiguo, false, JSON.stringify(entrada));
    assert.equal(out.lote, lote, JSON.stringify(entrada));
    assert.equal(out.serie, serie, JSON.stringify(entrada));
    assert.equal(out.cn, cn);
    assert.equal(out.caducidad, fechaGS1(exp, HOY));
    n++;
  }
  assert.equal(n, 500);
});

test('GS1: lote con dígitos que parecen otro AI, CON GS, no se malinterpreta', () => {
  const gtin = gtinDe('712729');
  const casos = ['A17240131', '17240131', '1017', '21ABC', '011234567890123', '10', '1124010', '2121212121212121', 'X11240101Y', '712123456'];
  for (const lote of casos) {
    for (const orden of [0, 1, 2]) {
      const partes = [`01${gtin}`, `17280200`.replace('17280200', '17280200'), `10${lote}${GS}`, `21SER${GS}`];
      let s: string;
      if (orden === 0) s = partes.join('');
      else if (orden === 1) s = `${partes[2]}${partes[3]}${partes[0]}${partes[1]}`;
      else s = `${partes[3]}${partes[0]}${partes[2]}${partes[1]}`;
      const out = parsearGS1(s, { hoy: HOY });
      assert.equal(out.ambiguo, false, `${lote}/${orden}`);
      assert.equal(out.lote, lote, `${lote}/${orden}`);
      assert.equal(out.serie, 'SER');
      assert.equal(out.caducidad, '2028-02-29');
    }
  }
});

test('GS1: lote de 20 caracteres con un 17 dentro, sin GS, nunca se resuelve en silencio mal', () => {
  const gtin = gtinDe('712729');
  // lote de 20 con "17" (y fecha válida) dentro, al final de la cadena, SIN serie y sin GS
  const lote = 'ABCDEFGHIJKL17270131';
  assert.equal(lote.length, 20);
  const s = `01${gtin}17280200` + `10${lote}`;
  const out = parsearGS1(s, { hoy: HOY });
  assert.equal(out.lote, lote); // no hay otro 17 permitido (ya hay uno): único
  assert.equal(out.ambiguo, false);
  // Sin el 17 externo: el 17 interno podría ser la caducidad → NO puede salir unívoca con lote cortado
  const s2 = `01${gtin}10${lote}`;
  const o2 = parsearGS1(s2, { hoy: HOY });
  assert.equal(o2.ambiguo, true);
  assert.ok(o2.candidatas.some(c => c['10'] === lote));
  assert.ok(o2.candidatas.some(c => c['17'] === '270131'));
});

test('GS1: sin GS entre lote y serie → ambiguo y la verdad está entre las candidatas (propiedad)', () => {
  const r = rng(77);
  const gtin = gtinDe('654321');
  let ambiguos = 0;
  for (let i = 0; i < 300; i++) {
    const l = 1 + Math.floor(r() * 12), sl = 1 + Math.floor(r() * 12);
    let lote = '', serie = '';
    for (let k = 0; k < l; k++) lote += ALF_LOTE[Math.floor(r() * ALF_LOTE.length)];
    for (let k = 0; k < sl; k++) serie += ALF_LOTE[Math.floor(r() * ALF_LOTE.length)];
    const s = `01${gtin}17300600` + `10${lote}` + `21${serie}`;
    const out = parsearGS1(s, { hoy: HOY });
    assert.deepEqual(out.errores, []);
    const verdad = out.candidatas.length ? out.candidatas : [{ '10': out.lote!, '21': out.serie! }];
    assert.ok(verdad.some(c => c['10'] === lote && c['21'] === serie), `${lote}|${serie} no está entre candidatas`);
    if (!out.ambiguo) { assert.equal(out.lote, lote); assert.equal(out.serie, serie); }
    else ambiguos++;
    // Seguridad: la caducidad y el CN jamás dependen de la partición lote/serie
    if (out.candidatas.length) for (const c of out.candidatas) assert.equal(c['17'], '300600');
    assert.equal(out.caducidad, '2030-06-30');
  }
  assert.ok(ambiguos > 0);
});

test('GS1: separador alternativo configurado (~) equivale a GS', () => {
  const gtin = gtinDe('123456');
  const a = parsearGS1(`01${gtin}17270300~10L0T~21S1`, { hoy: HOY, separadores: ['~'] });
  const b = parsearGS1(`01${gtin}17270300${GS}10L0T${GS}21S1`, { hoy: HOY });
  assert.equal(a.ambiguo, false);
  assert.deepEqual({ ...a, candidatas: [] }, { ...b, candidatas: [] });
  assert.equal(a.lote, 'L0T');
});

test('GS1: GTIN con dígito de control incorrecto, no español, sin 17, sin 10', () => {
  const gtin = gtinDe('123456');
  const malo = gtin.slice(0, 13) + ((Number(gtin[13]) + 1) % 10);
  const o1 = parsearGS1(`01${malo}17270300${GS}10A`, { hoy: HOY });
  assert.ok(o1.errores.length > 0);
  assert.equal(o1.gtin, undefined);
  const extranjero = '0' + '5000000000017'.slice(0, 12);
  const sinD = '0' + '500000000001'; // 13 → completar a 14 con control
  const g14 = sinD + digitoControlGS1(sinD);
  assert.ok(gtinValido(g14));
  const o2 = parsearGS1(`01${g14}17270300${GS}10A`, { hoy: HOY });
  assert.equal(o2.cn, undefined);
  assert.ok(o2.avisos.length > 0);
  void extranjero;
  const o3 = parsearGS1(`01${gtin}10A`, { hoy: HOY });
  assert.ok(o3.errores.some(e => /caducidad/i.test(e)));
  assert.equal(o3.caducidad, undefined);
  const o4 = parsearGS1(`01${gtin}17270300`, { hoy: HOY });
  assert.ok(o4.errores.some(e => /lote/i.test(e)));
});

test('GS1: caducidad con fecha imposible nunca produce lectura válida', () => {
  const gtin = gtinDe('123456');
  for (const f of ['270230', '270431', '271301', '270001', '270132']) {
    const o = parsearGS1(`01${gtin}17${f}${GS}10A`, { hoy: HOY });
    assert.ok(o.errores.length > 0, f);
    assert.equal(o.caducidad, undefined);
  }
  assert.equal(parsearGS1(`01${gtin}17270200${GS}10A`, { hoy: HOY }).caducidad, '2027-02-28');
  assert.equal(parsearGS1(`01${gtin}17280200${GS}10A`, { hoy: HOY }).caducidad, '2028-02-29');
});

test('GS1: entradas hostiles no lanzan ni cuelgan', () => {
  const gtin = gtinDe('123456');
  const hostiles = [
    '', ' ', GS, GS + GS + GS, ']d2', ']d2' + GS, '\u0000'.repeat(100), '‮' + '01' + gtin,
    '😀'.repeat(1000), 'ñ'.repeat(5000), '0'.repeat(1024 * 1024), '1'.repeat(1024 * 1024),
    '10'.repeat(500000), ('21' + 'A'.repeat(18)).repeat(20000), `01${gtin}` + '10'.repeat(500000),
    `01${gtin}17270300` + '10' + '1'.repeat(1024 * 1024), `01${gtin}17270300${GS}`.repeat(10000),
    `01${gtin}17270300${GS}10${'A'.repeat(21)}`, `01${gtin}17270300${GS}10${GS}21X`,
    '01' + gtin + '17270300' + '10' + '\n\r\t \u0000\u001d',
  ];
  for (const h of hostiles) {
    const t0 = Date.now();
    const o = parsearGS1(h, { hoy: HOY });
    assert.ok(Date.now() - t0 < 3000, 'demasiado lento');
    assert.equal(typeof o.ambiguo, 'boolean');
    assert.ok(Array.isArray(o.errores));
  }
});

test('GS1: undefined / null / no string en la entrada no lanzan excepción y bloquean', () => {
  for (const v of [undefined, null, 123, {}, []] as unknown[]) {
    const o = parsearGS1(v as string, { hoy: HOY });
    assert.ok(o.errores.length > 0);
    assert.equal(o.lote, undefined);
    assert.equal(o.gtin, undefined);
  }
});

test('normalizarCN: formas válidas e inválidas', () => {
  assert.equal(normalizarCN('712729.3'), '712729');
  assert.equal(normalizarCN('712729-3'), '712729');
  assert.equal(normalizarCN('7127293'), '712729');
  assert.equal(normalizarCN('C.N. 712729.3'), '712729');
  assert.equal(normalizarCN('cn 712729'), '712729');
  assert.equal(normalizarCN('8470007127293'), '712729');
  assert.equal(normalizarCN('08470007127293'), '712729');
  assert.equal(normalizarCN('8470007127299'), '712729');     // dígito de control NO se valida
  assert.equal(normalizarCN('7127290'), '712729');
  assert.equal(normalizarCN('8410007127293'), null);         // EAN no español
  assert.equal(normalizarCN('18470007127293'), null);        // indicador ≠ 0
  assert.equal(normalizarCN(''), null);
  assert.equal(normalizarCN('12345'), null);
  assert.equal(normalizarCN('12345678'), null);
  assert.equal(normalizarCN('abc'), null);
  assert.equal(normalizarCN('9'.repeat(1024 * 1024)), null);
  assert.equal(cnDesdeGtin('8470007127293'), '712729');
  assert.equal(cnDesdeGtin('x'), null);
});

test('normalizarCN: undefined/null no lanzan', () => {
  for (const v of [undefined, null, 5] as unknown[]) {
    assert.doesNotThrow(() => normalizarCN(v as string));
    assert.equal(normalizarCN(v as string), null);
  }
});

// ===================== Clave de recuperación =====================

test('clave: ida y vuelta con 500 claves aleatorias + formato', () => {
  const r = rng(424242);
  for (let i = 0; i < 500; i++) {
    const k = Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256));
    const t = textoRecuperacion(k);
    assert.match(t, /^([A-Z2-7]{4}-){13}[A-Z2-7]{2}$/);
    assert.deepEqual([...claveDesdeTexto(t)], [...k]);
    assert.deepEqual([...claveDesdeTexto(t.toLowerCase())], [...k]);
    assert.deepEqual([...claveDesdeTexto(t.replaceAll('-', ' '))], [...k]);
    assert.deepEqual([...claveDesdeTexto(t.replaceAll('-', ''))], [...k]);
    assert.deepEqual([...claveDesdeTexto('  ' + t + '\n')], [...k]);
  }
});

test('clave: claves extremas (todo 0, todo FF) y longitud incorrecta', () => {
  for (const b of [0, 255, 1, 128]) {
    const k = new Uint8Array(32).fill(b);
    assert.deepEqual([...claveDesdeTexto(textoRecuperacion(k))], [...k]);
  }
  for (const n of [0, 1, 16, 31, 33, 64]) assert.throws(() => textoRecuperacion(new Uint8Array(n)));
});

test('clave: TODA errata de un carácter y TODA permutación de dos se detectan', () => {
  const r = rng(99);
  const alfa = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  for (let i = 0; i < 20; i++) {
    const k = Uint8Array.from({ length: 32 }, () => Math.floor(r() * 256));
    const plano = textoRecuperacion(k).replaceAll('-', '');
    // sustituciones: las 54 posiciones × los 31 caracteres distintos
    for (let p = 0; p < plano.length; p++) {
      for (const c of alfa) {
        if (c === plano[p]) continue;
        const t = plano.slice(0, p) + c + plano.slice(p + 1);
        assert.throws(() => claveDesdeTexto(t), `sust pos ${p} → ${c}`);
      }
    }
    // intercambio de dos caracteres distintos cualesquiera
    for (let p = 0; p < 52; p++) {
      for (let q = p + 1; q < 52; q++) {   // entre caracteres de datos (datos↔control colisiona 1/1024, inevitable)
        if (plano[p] === plano[q]) continue;
        const a = plano.split('');
        [a[p], a[q]] = [a[q], a[p]];
        assert.throws(() => claveDesdeTexto(a.join('')), `swap ${p},${q}`);
      }
    }
  }
});

test('clave: entradas hostiles', () => {
  const buena = textoRecuperacion(new Uint8Array(32).fill(7));
  for (const h of ['', '-', '0'.repeat(54), '1'.repeat(54), 'A'.repeat(54), buena + 'A', buena.slice(0, -1), buena.replace('-', '*'),
    '\u0000'.repeat(54), '😀'.repeat(27), 'A'.repeat(1024 * 1024), buena + '\u0000']) {
    assert.throws(() => claveDesdeTexto(h), () => true, JSON.stringify(h.slice(0, 30)));
  }
  for (const v of [undefined, null, 5] as unknown[]) assert.throws(() => claveDesdeTexto(v as string));
  assert.throws(() => deBase32('AB1'));
  assert.throws(() => deBase32('😀'));
});

test('clave: base32 coincide con RFC 4648 (vectores) y ida y vuelta de longitudes variadas', () => {
  const enc = (s: string) => aBase32(new TextEncoder().encode(s));
  assert.equal(enc(''), '');
  assert.equal(enc('f'), 'MY');
  assert.equal(enc('fo'), 'MZXQ');
  assert.equal(enc('foo'), 'MZXW6');
  assert.equal(enc('foob'), 'MZXW6YQ');
  assert.equal(enc('fooba'), 'MZXW6YTB');
  assert.equal(enc('foobar'), 'MZXW6YTBOI');
  const r = rng(5);
  for (let len = 0; len < 80; len++) {
    const k = Uint8Array.from({ length: len }, () => Math.floor(r() * 256));
    const d = deBase32(aBase32(k));
    assert.deepEqual([...d.slice(0, len)], [...k]);
  }
});

test('clave: separadores Unicode al copiar de un PDF/Word (guion largo, nbsp, espacio ancho, invisibles)', () => {
  const k = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 5) & 255);
  const t = textoRecuperacion(k);
  for (const sep of ['‐', '‑', '‒', '–', '—', '−', ' ', ' ']) {
    assert.deepEqual([...claveDesdeTexto(t.replaceAll('-', sep))], [...k], `separador U+${sep.charCodeAt(0).toString(16)}`);
  }
  assert.deepEqual([...claveDesdeTexto('​' + t.replace('-', '​-') + '﻿')], [...k]);
});

test('clave: URI del autenticador', () => {
  const k = new Uint8Array(32).fill(1);
  const u = uriAutenticador(k, 'Farmacia García & Hijos: 1/2');
  assert.ok(u.startsWith('otpauth://totp/'));
  const url = new URL(u);
  assert.equal(url.protocol, 'otpauth:');
  assert.equal(decodeURIComponent(url.pathname.slice(1)), 'SPD Farmacia García & Hijos: 1/2');
  assert.equal(url.searchParams.get('secret'), aBase32(k));
  assert.equal(url.searchParams.get('secret')!.length, 52);
  assert.equal(url.searchParams.get('digits'), '6');
  assert.equal(url.searchParams.get('period'), '30');
  assert.ok(!u.includes(' ') && !u.includes('&amp;'));
  assert.equal(uriAutenticador(k, '').includes('SPD%20'), false); // etiqueta sin espacio colgante
});

// ===================== Caducidad del SPD =====================

const base = (o: Partial<EntradaCaducidad> = {}): EntradaCaducidad => ({
  caducidadesLotes: ['2030-01-01'], fechaPreparacion: '2026-10-28', diasValidez: 14,
  validezExtendidaPermitida: false, ...o,
});

test('caducidad: 14 días, cruces de mes/año y bisiesto', () => {
  assert.equal(calcularCaducidadSpd(base()).caducidadSpd, '2026-11-11');
  assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: '2026-12-25' })).caducidadSpd, '2027-01-08');
  assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: '2028-02-20' })).caducidadSpd, '2028-03-05');
  assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: '2027-02-20' })).caducidadSpd, '2027-03-06');
  assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: '2026-03-28', diasValidez: 1 })).caducidadSpd, '2026-03-29');
  assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: '2026-03-28', diasValidez: 1 })).limitadaPor, 'validez');
});

test('caducidad: propiedad con 1000 casos aleatorios', () => {
  const r = rng(31337);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const d0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 1000; i++) {
    const prep = d0 + Math.floor(r() * 1500) * 86400000;
    const dias = 1 + Math.floor(r() * 30);
    const n = 1 + Math.floor(r() * 4);
    const lotes = Array.from({ length: n }, () => iso(prep + Math.floor(r() * 90 - 5) * 86400000));
    const res = calcularCaducidadSpd({
      caducidadesLotes: lotes, fechaPreparacion: iso(prep), diasValidez: dias,
      validezExtendidaPermitida: true, justificacion: 'paciente institucionalizado',
    });
    const porValidez = iso(prep + dias * 86400000);
    const menor = [...lotes].sort()[0];
    if (menor < iso(prep)) { assert.equal(res.ok, false); assert.equal(res.caducidadSpd, undefined); continue; }
    assert.equal(res.ok, true);
    assert.equal(res.caducidadSpd, menor < porValidez ? menor : porValidez);
    assert.ok(res.caducidadSpd! <= porValidez);
    for (const l of lotes) assert.ok(res.caducidadSpd! <= l, 'nunca más que un lote');
    assert.equal(res.fueraDeEstandar, dias > 14);
  }
});

test('caducidad: lote limita; lote que caduca el mismo día; lote ya caducado', () => {
  const a = calcularCaducidadSpd(base({ caducidadesLotes: ['2030-01-01', '2026-11-03', '2027-01-01'] }));
  assert.equal(a.caducidadSpd, '2026-11-03'); assert.equal(a.limitadaPor, 'lote');
  const b = calcularCaducidadSpd(base({ caducidadesLotes: ['2026-10-28'] }));
  assert.equal(b.ok, true); assert.equal(b.caducidadSpd, '2026-10-28');
  const c = calcularCaducidadSpd(base({ caducidadesLotes: ['2026-10-27', '2030-01-01'] }));
  assert.equal(c.ok, false); assert.equal(c.caducidadSpd, undefined);
  const d = calcularCaducidadSpd(base({ caducidadesLotes: ['2026-11-11'] }));
  assert.equal(d.limitadaPor, 'validez'); // empate: gana validez (mismo día)
});

test('caducidad: validez >14 exige ajuste, justificación y tope 30', () => {
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 15 })).ok, false);
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 15, validezExtendidaPermitida: true })).ok, false);
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 15, validezExtendidaPermitida: true, justificacion: '         ' })).ok, false);
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 15, validezExtendidaPermitida: true, justificacion: 'corta' })).ok, false);
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 15, validezExtendidaPermitida: true, justificacion: '  nueve chr  ' })).ok, false);
});

test('caducidad: justificación de exactamente 10 caracteres tras trim vale; 9 no', () => {
  const ok = calcularCaducidadSpd(base({ diasValidez: 30, validezExtendidaPermitida: true, justificacion: ' 0123456789 ' }));
  assert.equal(ok.ok, true); assert.equal(ok.fueraDeEstandar, true); assert.equal(ok.caducidadSpd, '2026-11-27');
  assert.ok(ok.avisos.length > 0);
  const ko = calcularCaducidadSpd(base({ diasValidez: 30, validezExtendidaPermitida: true, justificacion: ' 012345678 ' }));
  assert.equal(ko.ok, false);
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 31, validezExtendidaPermitida: true, justificacion: '0123456789' })).ok, false);
  assert.equal(calcularCaducidadSpd(base({ diasValidez: 14 })).fueraDeEstandar, false);
});

test('caducidad: validez no entera / no numérica / negativa / NaN / Infinity', () => {
  for (const d of [0, -1, 1.5, NaN, Infinity, -Infinity, '14' as unknown as number, null as unknown as number, undefined as unknown as number]) {
    const r = calcularCaducidadSpd(base({ diasValidez: d, validezExtendidaPermitida: true, justificacion: 'justificación larga' }));
    assert.equal(r.ok, false, String(d));
  }
});

test('caducidad: fechas imposibles de calendario se rechazan (30 feb, 31 abr...)', () => {
  for (const f of ['2026-02-30', '2026-02-31', '2027-02-29', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31']) {
    assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: f })).ok, false, 'preparación ' + f);
    assert.equal(calcularCaducidadSpd(base({ caducidadesLotes: [f] })).ok, false, 'lote ' + f);
    assert.equal(calcularCaducidadSpd(base({ caducidadesLotes: ['2030-01-01', f] })).ok, false, 'lote 2º ' + f);
  }
  assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: '2028-02-29' })).ok, true);
});

test('caducidad: formatos de fecha hostiles', () => {
  for (const f of ['', '2026-1-5', '2026/10/28', '28-10-2026', '2026-10-28T00:00:00Z', ' 2026-10-28', '2026-10-28\n', '２０２６-10-28', 'hoy', '0000-00-00', '2026-13-01', '2026-00-10', '2026-01-00']) {
    assert.equal(calcularCaducidadSpd(base({ fechaPreparacion: f })).ok, false, JSON.stringify(f));
    assert.equal(calcularCaducidadSpd(base({ caducidadesLotes: [f] })).ok, false, JSON.stringify(f));
  }
  assert.equal(calcularCaducidadSpd(base({ caducidadesLotes: [] })).ok, false);
});

test('caducidad: undefined/null en lugares inesperados no lanzan y bloquean', () => {
  for (const e of [
    base({ caducidadesLotes: undefined as unknown as string[] }),
    base({ caducidadesLotes: [null as unknown as string] }),
    base({ caducidadesLotes: [undefined as unknown as string] }),
    base({ caducidadesLotes: [20261111 as unknown as string] }),
    base({ fechaPreparacion: undefined as unknown as string }),
    base({ fechaPreparacion: null as unknown as string }),
    base({ fechaPreparacion: new Date() as unknown as string }),
  ]) {
    let r;
    assert.doesNotThrow(() => { r = calcularCaducidadSpd(e); });
    assert.equal(r!.ok, false);
  }
  const j = calcularCaducidadSpd(base({ diasValidez: 20, validezExtendidaPermitida: true, justificacion: null as unknown as string }));
  assert.equal(j.ok, false);
});

test('periodoCabe: sólo true si ambas fechas son válidas y fin <= caducidad', () => {
  assert.equal(periodoCabe('2026-11-11', '2026-11-11'), true);
  assert.equal(periodoCabe('2026-11-10', '2026-11-11'), true);
  assert.equal(periodoCabe('2026-11-12', '2026-11-11'), false);
  assert.equal(periodoCabe('2027-01-01', '2026-12-31'), false);
  // Entradas inválidas NUNCA pueden decir que cabe
  for (const f of ['', ' ', 'x', '2026-1-1', '2026-02-30', '2026-13-01']) {
    assert.equal(periodoCabe(f, '2026-11-11'), false, JSON.stringify(f));
    assert.equal(periodoCabe('2026-11-11', f), false, JSON.stringify(f));
  }
  for (const v of [undefined, null] as unknown[]) {
    assert.equal(periodoCabe(v as string, '2026-11-11'), false);
    assert.equal(periodoCabe('2026-11-11', v as string), false);
  }
});

test('puedeValidar: sólo titular y farmacéutico, nada que se le parezca', () => {
  assert.equal(puedeValidar('titular'), true);
  assert.equal(puedeValidar('farmaceutico'), true);
  assert.equal(puedeValidar('tecnico'), false);
  assert.equal(puedeValidar('administrativo'), false);
  for (const v of ['', 'Titular', 'FARMACEUTICO', 'farmacéutico', ' titular', 'admin', undefined, null, 0] as unknown[]) {
    assert.equal(puedeValidar(v as 'titular'), false, String(v));
  }
});

test('fechaGS1: fecha de referencia inválida no produce «NaN-06-NaN»', () => {
  assert.equal(fechaGS1('300600', new Date(NaN)), null);
});

test('GS1 (caracterización): lectura ambigua marca ambiguo y trae la lectura verdadera entre las candidatas', () => {
  const sin = '0847000123456';
  const g = sin + digitoControlGS1(sin);
  const o = parsearGS1(`01${g}17300600` + '10AB' + '21CD', { hoy: HOY });
  assert.equal(o.ambiguo, true);
  assert.ok(o.candidatas.some(c => c['10'] === 'AB' && c['21'] === 'CD'));
  assert.equal(o.caducidad, '2030-06-30');
});
