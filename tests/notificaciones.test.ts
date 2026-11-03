/**
 * Notificaciones: tostadas (cerrar con un clic, 10 s si no se tocan, agrupar idénticas, «Cerrar todas»), avisos de «Hoy»
 * que se marcan como vistos o se quitan (nunca los de seguridad; nunca nombres guardados) y bloqueos no repetidos.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';
import {
  avisar, cerrarTodasTostadas, cerrarTostada, duracionTostada, pausarTostada, reanudarTostada, tostadas,
  guardarTiposAvisosQuitados, leerTiposAvisosQuitados,
} from '../src/interfaz/componentes/util.ts';
import {
  aplicarEstado, claveAviso, ESTADO_AVISOS_VACIO, esAvisoProtegido, marcarVisto, quitarAviso, quitarVistos, restaurarAvisos,
  tiposGuardadosValidos, TIPOS_DE_SEGURIDAD,
} from '../src/dominio/avisos.ts';
import type { AvisoBasico } from '../src/dominio/avisos.ts';

const lista = () => get(tostadas);

// ───────────────────────── tostadas ─────────────────────────

test('tostadas: error y atención se cierran solos a los 10 s; ok e info, a los 4 s', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    cerrarTodasTostadas();
    assert.deepEqual([duracionTostada('bloqueo'), duracionTostada('atencion'), duracionTostada('ok'), duracionTostada('info')], [10_000, 10_000, 4000, 4000]);
    avisar('Guardado', 'ok'); avisar('Mira esto', 'atencion'); avisar('Fallo', 'bloqueo');
    mock.timers.tick(3999); assert.equal(lista().length, 3);
    mock.timers.tick(1); assert.deepEqual(lista().map((t) => t.texto), ['Mira esto', 'Fallo'], 'el ok se fue a los 4 s');
    mock.timers.tick(5999); assert.equal(lista().length, 2, 'a los 9,999 s el error sigue');
    mock.timers.tick(1); assert.equal(lista().length, 0, 'a los 10 s se cierran solos');
  } finally { cerrarTodasTostadas(); mock.timers.reset(); }
});

test('tostadas: con el ratón encima NO se cierra sola; al apartarse, cuenta de nuevo', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    cerrarTodasTostadas();
    avisar('Error importante', 'bloqueo');
    const id = lista()[0].id;
    mock.timers.tick(5000);
    pausarTostada(id);
    mock.timers.tick(60_000); assert.equal(lista().length, 1, 'sigue mientras el ratón esté encima');
    reanudarTostada(id);
    mock.timers.tick(9999); assert.equal(lista().length, 1);
    mock.timers.tick(1); assert.equal(lista().length, 0);
    // pausar una que ya no existe no rompe nada ni deja un temporizador huérfano
    pausarTostada(9999); reanudarTostada(9999);
  } finally { cerrarTodasTostadas(); mock.timers.reset(); }
});

test('tostadas: un mensaje idéntico no se apila: suma «×N» y reinicia la cuenta atrás', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    cerrarTodasTostadas();
    avisar('Sin conexión', 'bloqueo'); avisar('Sin conexión', 'bloqueo'); avisar('Sin conexión', 'bloqueo');
    assert.equal(lista().length, 1);
    assert.equal(lista()[0].veces, 3);
    avisar('Sin conexión', 'atencion');                       // otro tipo = otro aviso
    avisar('Otro mensaje', 'bloqueo');
    assert.equal(lista().length, 3);
    mock.timers.tick(9000);
    avisar('Sin conexión', 'bloqueo');                         // reinicia SU cuenta
    mock.timers.tick(1000);
    assert.deepEqual(lista().map((t) => t.texto + ':' + t.tipo), ['Sin conexión:bloqueo']);
    assert.equal(lista()[0].veces, 4);
  } finally { cerrarTodasTostadas(); mock.timers.reset(); }
});

test('tostadas: una duplicada que llega con el ratón encima no reprograma el cierre', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    cerrarTodasTostadas();
    avisar('Aviso', 'atencion');
    const id = lista()[0].id;
    pausarTostada(id);
    avisar('Aviso', 'atencion');
    mock.timers.tick(30_000);
    assert.equal(lista().length, 1);
    assert.equal(lista()[0].veces, 2);
  } finally { cerrarTodasTostadas(); mock.timers.reset(); }
});

test('tostadas: cerrar una (clic) y cerrar todas; máximo cuatro a la vez', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    cerrarTodasTostadas();
    for (const n of ['a', 'b', 'c', 'd', 'e']) avisar(n, 'info');
    assert.deepEqual(lista().map((t) => t.texto), ['b', 'c', 'd', 'e']);
    cerrarTostada(lista()[0].id);
    assert.deepEqual(lista().map((t) => t.texto), ['c', 'd', 'e']);
    cerrarTodasTostadas();
    assert.equal(lista().length, 0);
    mock.timers.tick(20_000);                                   // y no queda ningún temporizador que dispare sobre nada
    assert.equal(lista().length, 0);
  } finally { cerrarTodasTostadas(); mock.timers.reset(); }
});

test('Tostadas.svelte: clic para cerrar, pausa con ratón/foco, ×N y «Cerrar todas» sólo con más de una', () => {
  const s = readFileSync('src/interfaz/componentes/Tostadas.svelte', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(s, /onclick=\{\(\) => cerrarTostada\(t\.id\)\}/);
  assert.match(s, /onmouseenter=\{\(\) => pausarTostada\(t\.id\)\}/);
  assert.match(s, /onmouseleave=\{\(\) => reanudarTostada\(t\.id\)\}/);
  assert.match(s, /onfocusin=\{\(\) => pausarTostada\(t\.id\)\}/);
  assert.match(s, /\{#if \$tostadas\.length > 1\}[\s\S]*?cerrarTodasTostadas/);
  assert.match(s, /\{#if t\.veces > 1\}/);
});

// ───────────────────────── avisos de «Hoy» ─────────────────────────

const aviso = (tipo: string, gravedad: AvisoBasico['gravedad'], pacienteId?: number): AvisoBasico => ({ tipo, gravedad, ...(pacienteId !== undefined ? { pacienteId } : {}) });
const copia = aviso('copia_atrasada', 'atencion');
const cobertura5 = aviso('cobertura_baja', 'atencion', 5);
const cobertura6 = aviso('cobertura_baja', 'atencion', 6);

test('avisos: los de seguridad NUNCA se pueden marcar ni quitar (bloqueos, caducidad, alerta de calidad, alergia)', () => {
  const protegidos = [
    aviso('sin_consentimiento', 'bloqueo', 1), aviso('caja_caducada', 'bloqueo', 1), aviso('alerta_calidad', 'bloqueo', 1),
    aviso('caja_caduca', 'atencion', 1), aviso('alerta_calidad', 'atencion', 1), aviso('alergia_sin_confirmar', 'info', 1), aviso('cualquier_cosa', 'bloqueo'),
  ];
  for (const a of protegidos) {
    assert.equal(esAvisoProtegido(a), true, a.tipo + a.gravedad);
    assert.equal(marcarVisto(ESTADO_AVISOS_VACIO, a), ESTADO_AVISOS_VACIO);
    assert.equal(quitarAviso(ESTADO_AVISOS_VACIO, a), ESTADO_AVISOS_VACIO);
  }
  // aunque el estado ya los traiga marcados (p. ej. un almacenamiento manipulado), SIEMPRE salen y sin atenuar
  const manipulado = { vistos: protegidos.map(claveAviso), quitados: protegidos.map(claveAviso), tiposQuitados: protegidos.map((a) => a.tipo) };
  const r = aplicarEstado(protegidos, manipulado);
  assert.equal(r.visibles.length, protegidos.length);
  assert.equal(r.ocultos, 0);
  assert.ok(r.visibles.every((a) => a.protegido && !a.visto));
  for (const t of TIPOS_DE_SEGURIDAD) assert.equal(esAvisoProtegido(aviso(t, 'info')), true, t);
});

test('avisos: los que no son de seguridad sí se marcan como vistos (siguen, atenuados) y se quitan (se ocultan)', () => {
  let e = marcarVisto(ESTADO_AVISOS_VACIO, cobertura5);
  let r = aplicarEstado([cobertura5, cobertura6, copia], e);
  assert.deepEqual(r.visibles.map((a) => [a.pacienteId ?? null, a.visto]), [[5, true], [6, false], [null, false]], 'sólo el 5 está visto');
  assert.equal(r.ocultos, 0);
  e = quitarAviso(e, cobertura5);
  r = aplicarEstado([cobertura5, cobertura6, copia], e);
  assert.deepEqual(r.visibles.map((a) => a.pacienteId ?? null), [6, null]);
  assert.equal(r.ocultos, 1);
  assert.equal(marcarVisto(e, cobertura6).vistos.length, 1);
  assert.equal(marcarVisto(marcarVisto(e, cobertura6), cobertura6).vistos.length, 1, 'idempotente');
});

test('«Quitar todos los vistos»: quita lo visto y sólo eso; lo protegido no', () => {
  const bloqueo = aviso('sin_consentimiento', 'bloqueo', 1);
  let e = marcarVisto(ESTADO_AVISOS_VACIO, cobertura5);
  e = marcarVisto(e, copia);
  const todos = [cobertura5, cobertura6, copia, bloqueo];
  e = quitarVistos(e, todos);
  const r = aplicarEstado(todos, e);
  assert.deepEqual(r.visibles.map((a) => a.tipo + ':' + (a.pacienteId ?? '-')), ['cobertura_baja:6', 'sin_consentimiento:1']);
  assert.equal(r.ocultos, 2);
  assert.deepEqual(quitarVistos(ESTADO_AVISOS_VACIO, todos), ESTADO_AVISOS_VACIO, 'sin vistos no quita nada');
});

test('avisos: sólo los GENERALES (sin paciente) se recuerdan por tipo; uno de un paciente concreto no afecta a los demás', () => {
  const e = quitarAviso(quitarAviso(ESTADO_AVISOS_VACIO, copia), cobertura5);
  assert.deepEqual(e.tiposQuitados, ['copia_atrasada'], 'la cobertura de un paciente no se recuerda por tipo');
  const r = aplicarEstado([cobertura5, cobertura6, copia], e);
  assert.deepEqual(r.visibles.map((a) => a.pacienteId ?? null), [6], 'el paciente 6 sigue avisando');
  // desde otra sesión (sólo queda el tipo guardado) la copia sigue quitada y la cobertura vuelve
  const nueva = { ...ESTADO_AVISOS_VACIO, tiposQuitados: e.tiposQuitados };
  assert.deepEqual(aplicarEstado([cobertura5, copia], nueva).visibles.map((a) => a.tipo), ['cobertura_baja']);
  // «Mostrar de nuevo»
  assert.equal(aplicarEstado([cobertura5, cobertura6, copia], restaurarAvisos()).visibles.length, 3);
});

test('avisos: el estado guarda sólo identificadores — jamás nombres ni texto', () => {
  const conTexto = { ...cobertura5, texto: 'Ana Pérez: las cajas sólo cubren 2 días' } as AvisoBasico;
  const e = quitarAviso(marcarVisto(ESTADO_AVISOS_VACIO, conTexto), conTexto);
  assert.ok(!JSON.stringify(e).includes('Ana') && !JSON.stringify(e).includes('Pérez'));
  assert.equal(claveAviso(conTexto), 'cobertura_baja:5');
  assert.match(claveAviso(copia), /^copia_atrasada:-$/);
});

test('avisos: lo que llega del almacenamiento del equipo no se da por bueno (sólo tipos válidos y nunca los de seguridad)', () => {
  assert.deepEqual(tiposGuardadosValidos(['copia_atrasada', 'ficha_incompleta', 'copia_atrasada']), ['copia_atrasada', 'ficha_incompleta']);
  assert.deepEqual(tiposGuardadosValidos(['alerta_calidad', 'caja_caduca', 'Ana Pérez', '<script>', 7, null, 'x'.repeat(80)]), []);
  assert.deepEqual(tiposGuardadosValidos('copia_atrasada'), []);
  assert.deepEqual(tiposGuardadosValidos(undefined), []);
});

test('preferencia local: se guarda y lee sólo la lista de tipos, y un valor corrupto se ignora', () => {
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
  };
  try {
    guardarTiposAvisosQuitados(['copia_atrasada', 'Ana Pérez', 'alerta_calidad']);
    assert.equal(mem.get('spd.avisos.quitados'), '["copia_atrasada"]');
    assert.deepEqual(leerTiposAvisosQuitados(), ['copia_atrasada']);
    guardarTiposAvisosQuitados([]);
    assert.equal(mem.has('spd.avisos.quitados'), false);
    mem.set('spd.avisos.quitados', '{no es json');
    assert.deepEqual(leerTiposAvisosQuitados(), []);
    mem.set('spd.avisos.quitados', '["alerta_calidad","caja_caduca"]');
    assert.deepEqual(leerTiposAvisosQuitados(), [], 'ni forzado a mano se oculta un aviso de seguridad');
  } finally { delete (globalThis as unknown as { localStorage?: unknown }).localStorage; }
});

test('Hoy.svelte: los protegidos no llevan botones; los demás, «Marcar como visto» y «Quitar»; hay «Quitar todos los vistos»', () => {
  const s = readFileSync('src/interfaz/pantallas/Hoy.svelte', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(s, /\{#if !t\.protegido\}[\s\S]*?Marcar como visto[\s\S]*?Quitar/);
  assert.match(s, /Quitar todos los vistos/);
  assert.match(s, /aplicarEstado\(panel\.tareas, \$estadoAvisos\)/);
  assert.doesNotMatch(s, /panel\.copias\.atrasada/, 'la copia atrasada es un aviso más de la lista, sin tarjeta duplicada');
});

// ───────────────────────── sin repetir el mismo problema ─────────────────────────

test('PasoRevisar/PasoValidar: usan bloqueosParaMostrar y ya no repiten «qué falta exactamente»', () => {
  const r = readFileSync('src/interfaz/pantallas/preparacion/PasoRevisar.svelte', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const v = readFileSync('src/interfaz/pantallas/preparacion/PasoValidar.svelte', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(r, /bloqueosParaMostrar\(evaluacion\.bloqueos, evaluacion\)/);
  assert.doesNotMatch(r, /Qué falta exactamente/);
  assert.match(v, /bloqueosParaMostrar\(ev\.bloqueos, ev\)/);
});
