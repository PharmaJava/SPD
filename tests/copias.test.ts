import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crearCopiaFichero, estadoDeCopias, fechaDeNombre, listarCopias, nombreCopia, rotarCopias, seleccionarConservar,
} from '../src/servicios/copias.ts';
import { ErrorSpd } from '../src/servicios/contexto.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'spd-copias-'));
const dia = (iso: string) => new Date(iso + 'T10:00:00Z');
const codigo = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof ErrorSpd ? e.codigo : 'OTRO'; } return 'SIN_ERROR'; };

test('nombre con fecha y vuelta a fecha', () => {
  const f = new Date('2026-11-02T09:05:07Z');
  assert.equal(nombreCopia(f), 'spd-20261102-090507.datos');
  assert.equal(fechaDeNombre('spd-20261102-090507.datos')!.toISOString(), f.toISOString());
});

test('nombres que no son copias (o con fecha imposible) se ignoran', () => {
  for (const n of ['spd.datos', 'spd-20261302-090507.datos', 'spd-20260231-090507.datos', 'spd-20261102-250507.datos', 'spd-20261102-090507.datos.tmp', 'otra.datos', 'x-spd-20261102-090507.datos']) {
    assert.equal(fechaDeNombre(n), null, n);
  }
});

test('listarCopias ordena por fecha y deja en paz los demás ficheros; carpeta inexistente → vacío', () => {
  const c = temp();
  try {
    writeFileSync(join(c, 'spd-20261103-100000.datos'), 'b');
    writeFileSync(join(c, 'spd-20261101-100000.datos'), 'a');
    writeFileSync(join(c, 'notas.txt'), 'x');
    assert.deepEqual(listarCopias(c).map(x => x.nombre), ['spd-20261101-100000.datos', 'spd-20261103-100000.datos']);
    assert.deepEqual(listarCopias(join(c, 'no-existe')), []);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

function serie(dias: number, hasta = '2026-11-02') {
  const fin = dia(hasta).getTime();
  return Array.from({ length: dias }, (_, i) => { const fecha = new Date(fin - i * 86400000); return { nombre: nombreCopia(fecha), fecha }; });
}

test('rotación: una copia al día durante 60 días conserva 7 diarias + semanales + mensuales (10 en total)', () => {
  const conservar = seleccionarConservar(serie(60));
  const fechas = [...conservar].map(n => fechaDeNombre(n)!.toISOString().slice(0, 10)).sort();
  assert.deepEqual(fechas, [
    '2026-09-30',                                                                 // mensual (septiembre)
    '2026-10-18', '2026-10-25',                                                   // semanales (domingos)
    '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',   // 7 diarias
  ]);
});

test('rotación: de varias copias el mismo día sólo queda la más reciente', () => {
  const copias = ['2026-11-02T08:00:00Z', '2026-11-02T20:00:00Z', '2026-11-02T12:00:00Z'].map(f => ({ nombre: nombreCopia(new Date(f)), fecha: new Date(f) }));
  const c = seleccionarConservar(copias);
  assert.deepEqual([...c], [nombreCopia(new Date('2026-11-02T20:00:00Z'))]);
});

test('rotación: nunca más de 7 + 4 + 12 y siempre la más reciente', () => {
  const copias = serie(800);
  const c = seleccionarConservar(copias);
  assert.ok(c.size <= 7 + 4 + 12);
  assert.ok(c.has(copias[0].nombre));
  assert.equal(seleccionarConservar([]).size, 0);
});

test('rotarCopias borra sólo lo que sobra y sólo ficheros con el patrón de copia', () => {
  const c = temp();
  try {
    for (const k of serie(30)) writeFileSync(join(c, k.nombre), 'x');
    writeFileSync(join(c, 'importante.txt'), 'no tocar');
    const borradas = rotarCopias(c);
    assert.ok(borradas.length > 0);
    assert.ok(existsSync(join(c, 'importante.txt')));
    const quedan = listarCopias(c);
    assert.equal(quedan.length, 30 - borradas.length);
    assert.ok(quedan.length < 30);
    assert.deepEqual(borradas.filter(n => quedan.some(q => q.nombre === n)), []);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('crearCopiaFichero copia byte a byte, sin dejar temporales, y no toca el original', () => {
  const c = temp(); const origen = join(c, 'spd.datos'); const carpeta = join(c, 'copias', 'sub');
  try {
    const bytes = Buffer.from([1, 2, 3, 250, 251, 0, 9]);
    writeFileSync(origen, bytes);
    const ruta = crearCopiaFichero(origen, carpeta, new Date('2026-11-02T09:00:00Z'));
    assert.equal(ruta, join(carpeta, 'spd-20261102-090000.datos'));
    assert.deepEqual(readFileSync(ruta), bytes);
    assert.deepEqual(readFileSync(origen), bytes);
    assert.deepEqual(readdirSync(carpeta), ['spd-20261102-090000.datos']);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('crearCopiaFichero rota y no borra la copia recién hecha', () => {
  const c = temp(); const origen = join(c, 'spd.datos'); const carpeta = join(c, 'copias');
  try {
    writeFileSync(origen, 'datos'); mkdirSync(carpeta);
    for (const k of serie(40, '2026-10-20')) writeFileSync(join(carpeta, k.nombre), 'viejo');
    const ruta = crearCopiaFichero(origen, carpeta, new Date('2026-11-02T09:00:00Z'));
    assert.ok(existsSync(ruta));
    assert.ok(listarCopias(carpeta).length <= 23);
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('crearCopiaFichero: errores claros (sin carpeta, original inexistente)', () => {
  const c = temp();
  try {
    assert.equal(codigo(() => crearCopiaFichero(join(c, 'a'), '  ', new Date())), 'SIN_CARPETA_COPIAS');
    assert.equal(codigo(() => crearCopiaFichero(join(c, 'no-existe'), join(c, 'copias'), new Date())), 'COPIA_FALLIDA');
    assert.deepEqual(readdirSync(join(c, 'copias')), []);     // no deja restos
    writeFileSync(join(c, 'fichero'), 'x');
    assert.equal(codigo(() => crearCopiaFichero(join(c, 'fichero'), join(c, 'fichero', 'dentro'), new Date())), 'CARPETA_COPIAS');
  } finally { rmSync(c, { recursive: true, force: true }); }
});

test('estado: sin carpeta o sin copias está atrasada; con copia reciente no; pasados 2 días sí', () => {
  const c = temp();
  try {
    assert.deepEqual(estadoDeCopias(null, new Date()), { ultima: null, atrasada: true, carpeta: null, total: 0 });
    assert.deepEqual(estadoDeCopias(c, new Date()), { ultima: null, atrasada: true, carpeta: c, total: 0 });
    writeFileSync(join(c, 'spd-20261102-100000.datos'), 'x');
    writeFileSync(join(c, 'spd-20261031-100000.datos'), 'x');
    const e = estadoDeCopias(c, new Date('2026-11-03T10:00:00Z'));
    assert.equal(e.ultima, '2026-11-02T10:00:00.000Z'); assert.equal(e.total, 2); assert.equal(e.atrasada, false);
    assert.equal(estadoDeCopias(c, new Date('2026-11-04T10:00:00Z')).atrasada, false);          // justo 2 días
    assert.equal(estadoDeCopias(c, new Date('2026-11-04T10:00:01Z')).atrasada, true);           // más de 2 días
  } finally { rmSync(c, { recursive: true, force: true }); }
});
