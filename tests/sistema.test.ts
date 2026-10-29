import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearSistema } from '../src/servicios/sistema.ts';
import type { Sistema } from '../src/servicios/sistema.ts';
import type { Ajustes, PrimerUso, Resultado } from '../src/servicios/api.ts';
import { abrirConContrasena } from '../src/servicios/seguridad.ts';

const KDF = { n: 1 << 10, r: 8, p: 1 };
const PASS = 'contraseña-farmacia';
const PIN = '4821';

const PRIMER_USO: PrimerUso = {
  farmacia: { nombre: 'Farmacia Luz del Sur', titular: 'Marta Etxeberria', municipio: 'Vitoria-Gasteiz', provincia: 'Álava' },
  titular: { nombre: 'Marta Etxeberria', iniciales: 'ME', pin: PIN },
  contrasena: PASS,
  momentos: [{ nombre: 'Desayuno', hora: '08:00' }, { nombre: 'Comida', hora: '14:00' }, { nombre: 'Cena', hora: '21:00' }, { nombre: 'Acostarse' }],
};

interface Entorno { dir: string; reloj: { t: number }; s: Sistema; reabrir(): Sistema; fin(): Promise<void> }

function entorno(): Entorno {
  const dir = mkdtempSync(join(tmpdir(), 'spd-sistema-'));
  const reloj = { t: Date.parse('2026-11-02T09:00:00Z') };
  const abiertos: Sistema[] = [];
  const crear = () => { const s = crearSistema({ rutaDatos: dir, ahora: () => new Date(reloj.t), kdf: KDF, debounceMs: 60_000 }); abiertos.push(s); return s; };
  const e: Entorno = {
    dir, reloj, s: crear(), reabrir() { e.s = crear(); return e.s; },
    async fin() { for (const s of abiertos) await s.cerrar(); rmSync(dir, { recursive: true, force: true }); },
  };
  return e;
}

async function conPrimerUso(): Promise<Entorno> {
  const e = entorno();
  const r = await e.s.api.primerUso(PRIMER_USO);
  assert.equal(r.ok, true, JSON.stringify(r));
  return e;
}

const ok = <T,>(r: Resultado<T>): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; datos: T }).datos; };
const mal = (r: Resultado<unknown>, codigo?: string) => {
  assert.equal(r.ok, false, 'se esperaba un fallo');
  if (codigo) assert.equal((r as { codigo?: string }).codigo, codigo, JSON.stringify(r));
  return r as { ok: false; error: string; codigo?: string };
};

/** Crea un usuario con el rol dado y entra con él. */
async function entrarComo(e: Entorno, rol: 'titular' | 'farmaceutico' | 'tecnico' | 'administrativo') {
  if (rol === 'titular') return;
  const u = ok(await e.s.api.crearUsuario({ nombre: `Pruebas ${rol}`, iniciales: 'PR', rol, pin: '9999' }));
  ok(await e.s.api.iniciarSesion(u.id, '9999'));
}

// ───────────────────────────── estado y primer uso ─────────────────────────────

test('estado antes del primer uso: no inicializado, bloqueado, sin sesión', async () => {
  const e = entorno();
  try {
    const s = ok(await e.s.api.estado());
    assert.deepEqual({ ...s, rutaDatos: undefined }, { inicializado: false, desbloqueado: false, sesion: null, version: '0.1.0', rutaDatos: undefined, esperaIntento: 0 });
    assert.equal(s.rutaDatos, e.dir);
  } finally { await e.fin(); }
});

test('estado() nunca lanza, ni con una carpeta imposible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spd-sistema-'));
  try {
    writeFileSync(join(dir, 'fichero'), 'x');
    const s = crearSistema({ rutaDatos: join(dir, 'fichero', 'dentro'), kdf: KDF });
    const r = await s.api.estado();
    assert.equal(r.ok, true);
    assert.equal(ok(r).inicializado, false);
    await s.cerrar();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('primer uso completo: clave de recuperación, URI, base desbloqueada y titular con sesión', async () => {
  const e = entorno();
  try {
    const r = ok(await e.s.api.primerUso(PRIMER_USO));
    assert.match(r.claveRecuperacion, /^([A-Z2-7]{4}-){13}[A-Z2-7]{2}$/);
    assert.match(r.uriAutenticador, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]{52}&issuer=SPD/);
    const s = ok(await e.s.api.estado());
    assert.equal(s.inicializado, true); assert.equal(s.desbloqueado, true);
    assert.equal(s.sesion?.rol, 'titular'); assert.equal(s.sesion?.iniciales, 'ME');
    assert.equal(ok(await e.s.api.obtenerFarmacia()).nombre, 'Farmacia Luz del Sur');
    assert.deepEqual(ok(await e.s.api.listarMomentos()).map(m => [m.nombre, m.hora, m.orden, m.activo]),
      [['Desayuno', '08:00', 1, true], ['Comida', '14:00', 2, true], ['Cena', '21:00', 3, true], ['Acostarse', null, 4, true]]);
    assert.equal(existsSync(join(e.dir, 'spd.datos')), true);
  } finally { await e.fin(); }
});

test('primer uso: validaciones, y si falla no deja nada creado', async () => {
  const e = entorno();
  try {
    const casos: [Partial<PrimerUso> | ((p: PrimerUso) => PrimerUso), string][] = [
      [{ contrasena: 'corta' }, 'CONTRASENA_DEBIL'],
      [{ titular: { ...PRIMER_USO.titular, pin: '12' } }, 'PIN_INVALIDO'],
      [{ titular: { ...PRIMER_USO.titular, pin: 'abcd' } }, 'PIN_INVALIDO'],
      [{ titular: { ...PRIMER_USO.titular, nombre: ' ' } }, 'TITULAR_INVALIDO'],
      [{ titular: { ...PRIMER_USO.titular, iniciales: 'ABCDEF' } }, 'TITULAR_INVALIDO'],
      [{ momentos: [] }, 'MOMENTOS_INVALIDOS'],
      [{ momentos: [{ nombre: 'Desayuno' }, { nombre: 'desayuno' }] }, 'MOMENTOS_INVALIDOS'],
      [{ momentos: [{ nombre: 'Desayuno', hora: '25:00' }] }, 'MOMENTOS_INVALIDOS'],
      [{ farmacia: { ...PRIMER_USO.farmacia, nombre: '' } }, 'FARMACIA_INVALIDA'],
      [{ farmacia: { ...PRIMER_USO.farmacia, email: 'sin-arroba' } }, 'FARMACIA_INVALIDA'],
    ];
    for (const [parche, codigo] of casos) {
      mal(await e.s.api.primerUso({ ...PRIMER_USO, ...(parche as object) } as PrimerUso), codigo);
      assert.equal(existsSync(join(e.dir, 'spd.datos')), false, codigo);
    }
    assert.equal(ok(await e.s.api.estado()).inicializado, false);
    mal(await e.s.api.primerUso(undefined as unknown as PrimerUso));
  } finally { await e.fin(); }
});

test('primer uso dos veces → YA_INICIALIZADO', async () => {
  const e = await conPrimerUso();
  try { mal(await e.s.api.primerUso(PRIMER_USO), 'YA_INICIALIZADO'); } finally { await e.fin(); }
});

test('primer uso deja la auditoría encadenada y válida (alta de farmacia, usuario, momentos, login)', async () => {
  const e = await conPrimerUso();
  try {
    const v = ok(await e.s.api.verificarAuditoria());
    assert.equal(v.ok, true); assert.equal(v.entradas, 4);
    const l = ok(await e.s.api.listarAuditoria({}));
    assert.deepEqual(l.map(x => `${x.accion}:${x.entidad}`).reverse(), ['crear:farmacia', 'crear:usuario', 'crear:momentos_toma', 'login:usuario']);
  } finally { await e.fin(); }
});

test('NADA en claro: ni el nombre de la farmacia, ni el titular, ni los momentos, ni el PIN, ni la contraseña salen en el fichero', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.crearUsuario({ nombre: 'Paciente-Falso-Urrutia', iniciales: 'PF', rol: 'tecnico', pin: '7777' }));
    await e.s.guardarAhora();
    await e.s.cerrar();
    for (const f of readdirSync(e.dir)) {
      const b = readFileSync(join(e.dir, f));
      for (const secreto of ['Luz del Sur', 'Etxeberria', 'Vitoria', 'Desayuno', 'Urrutia', PASS, 'SQLite format', 'farmacia']) {
        assert.equal(b.indexOf(secreto, 0, 'utf8'), -1, `${f} contiene «${secreto}»`);
        assert.equal(b.indexOf(secreto, 0, 'latin1'), -1, `${f} contiene «${secreto}» (latin1)`);
      }
    }
  } finally { await e.fin(); }
});

// ───────────────────────────── desbloqueo ─────────────────────────────

test('cerrar, reabrir y desbloquear: están los datos; sin sesión hasta poner el PIN', async () => {
  const e = await conPrimerUso();
  try {
    await e.s.cerrar();
    const s2 = e.reabrir();
    const antes = ok(await s2.api.estado());
    assert.equal(antes.inicializado, true); assert.equal(antes.desbloqueado, false); assert.equal(antes.sesion, null);
    mal(await s2.api.obtenerFarmacia(), 'BLOQUEADO');
    mal(await s2.api.listarUsuarios(), 'BLOQUEADO');
    const d = ok(await s2.api.desbloquear(PASS));
    assert.equal(d.desbloqueado, true); assert.equal(d.sesion, null);
    assert.equal(ok(await s2.api.obtenerFarmacia()).titular, 'Marta Etxeberria');
    assert.deepEqual(ok(await s2.api.listarUsuarios()).map(u => u.iniciales), ['ME']);
    assert.equal(ok(await s2.api.listarMomentos()).length, 4);
  } finally { await e.fin(); }
});

test('contraseña incorrecta: CONTRASENA_INCORRECTA y espera creciente 1, 2, 4… hasta 60 s en estado()', async () => {
  const e = await conPrimerUso();
  try {
    await e.s.api.bloquear();
    const esperados = [1, 2, 4, 8, 16, 32, 60, 60];
    for (const esperada of esperados) {
      mal(await e.s.api.desbloquear('equivocada'), 'CONTRASENA_INCORRECTA');
      assert.equal(ok(await e.s.api.estado()).esperaIntento, esperada);
      e.reloj.t += esperada * 1000;                        // pasa la espera
      assert.equal(ok(await e.s.api.estado()).esperaIntento, 0);
    }
  } finally { await e.fin(); }
});

test('durante la espera NI la contraseña buena entra; pasada la espera sí, y el contador se reinicia', async () => {
  const e = await conPrimerUso();
  try {
    await e.s.api.bloquear();
    mal(await e.s.api.desbloquear('mala-mala-mala'), 'CONTRASENA_INCORRECTA');
    mal(await e.s.api.desbloquear(PASS), 'ESPERA_ACTIVA');
    assert.equal(ok(await e.s.api.estado()).desbloqueado, false);
    e.reloj.t += 1000;
    mal(await e.s.api.desbloquear('mala-mala-mala'), 'CONTRASENA_INCORRECTA');   // 2.º fallo → 2 s
    e.reloj.t += 2000;
    ok(await e.s.api.desbloquear(PASS));
    await e.s.api.bloquear();
    mal(await e.s.api.desbloquear('mala-mala-mala'), 'CONTRASENA_INCORRECTA');
    assert.equal(ok(await e.s.api.estado()).esperaIntento, 1);                    // vuelve a empezar en 1
  } finally { await e.fin(); }
});

test('desbloquear sin datos creados y con argumentos absurdos: fallos, no excepciones', async () => {
  const e = entorno();
  try {
    mal(await e.s.api.desbloquear(PASS), 'NO_INICIALIZADO');
    mal(await e.s.api.recuperar('x', PASS), 'NO_INICIALIZADO');
  } finally { await e.fin(); }
  const f = await conPrimerUso();
  try {
    await f.s.api.bloquear();
    mal(await f.s.api.desbloquear(undefined as unknown as string));
    mal(await f.s.api.desbloquear(42 as unknown as string));
  } finally { await f.fin(); }
});

test('bloquear: descarta la base (ctx.db lanza), cierra la sesión y guarda lo pendiente', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 9 }));
    assert.doesNotThrow(() => e.s.ctx.db());
    const b = ok(await e.s.api.bloquear());
    assert.equal(b.desbloqueado, false); assert.equal(b.sesion, null);
    assert.throws(() => e.s.ctx.db(), /bloqueado/);
    assert.equal(e.s.ctx.sesion(), null);
    mal(await e.s.api.guardarAjustes({ bloqueoMinutos: 3 }), 'BLOQUEADO');
    ok(await e.s.api.bloquear());                                                  // bloquear dos veces no es un error
    ok(await e.s.api.desbloquear(PASS));
    assert.equal(ok(await e.s.api.obtenerAjustes()).bloqueoMinutos, 9);
  } finally { await e.fin(); }
});

test('bloquearPorInactividad equivale a bloquear (y lo deja en la auditoría)', async () => {
  const e = await conPrimerUso();
  try {
    const b = ok(await e.s.bloquearPorInactividad());
    assert.equal(b.desbloqueado, false); assert.equal(b.sesion, null);
    ok(await e.s.api.desbloquear(PASS));
    ok(await e.s.api.iniciarSesion(1, PIN));
    const l = ok(await e.s.api.listarAuditoria({ entidad: 'sistema' }));
    assert.ok(l.some(x => x.accion === 'bloquear' && x.motivo === 'inactividad'));
  } finally { await e.fin(); }
});

// ───────────────────────────── recuperación y contraseña ─────────────────────────────

test('recuperar con la clave de recuperación: contraseña nueva, la vieja deja de valer, datos intactos', async () => {
  const e = entorno();
  try {
    const { claveRecuperacion } = ok(await e.s.api.primerUso(PRIMER_USO));
    await e.s.api.bloquear();
    const r = ok(await e.s.api.recuperar(claveRecuperacion.toLowerCase().replaceAll('-', ' '), 'contraseña-nueva-1'));
    assert.equal(r.desbloqueado, true);
    assert.equal(ok(await e.s.api.obtenerFarmacia()).nombre, 'Farmacia Luz del Sur');
    await e.s.api.bloquear();
    mal(await e.s.api.desbloquear(PASS), 'CONTRASENA_INCORRECTA');
    e.reloj.t += 5000;
    ok(await e.s.api.desbloquear('contraseña-nueva-1'));
    ok(await e.s.api.iniciarSesion(1, PIN));
    assert.ok(ok(await e.s.api.listarAuditoria({ entidad: 'sistema' })).some(x => x.accion === 'recuperar'));
  } finally { await e.fin(); }
});

test('recuperar con UNA errata en la clave: CLAVE_RECUPERACION_INVALIDA y sigue bloqueado', async () => {
  const e = entorno();
  try {
    const { claveRecuperacion } = ok(await e.s.api.primerUso(PRIMER_USO));
    await e.s.api.bloquear();
    const c = claveRecuperacion.split('');
    const i = c.findIndex(x => /[A-Z]/.test(x));
    c[i] = c[i] === 'A' ? 'B' : 'A';
    mal(await e.s.api.recuperar(c.join(''), 'contraseña-nueva-1'), 'CLAVE_RECUPERACION_INVALIDA');
    mal(await e.s.api.recuperar(claveRecuperacion.slice(0, 20), 'contraseña-nueva-1'), 'CLAVE_RECUPERACION_INVALIDA');
    assert.equal(ok(await e.s.api.estado()).desbloqueado, false);
    ok(await e.s.api.desbloquear(PASS));                                           // la contraseña de siempre sigue valiendo
  } finally { await e.fin(); }
});

test('recuperar con la clave de OTRA farmacia: CLAVE_RECUPERACION_INCORRECTA (cuenta como fallo)', async () => {
  const a = await conPrimerUso();
  const otra = entorno();
  try {
    const { claveRecuperacion: ajena } = ok(await otra.s.api.primerUso(PRIMER_USO));
    await a.s.api.bloquear();
    mal(await a.s.api.recuperar(ajena, 'contraseña-nueva-1'), 'CLAVE_RECUPERACION_INCORRECTA');
    assert.equal(ok(await a.s.api.estado()).esperaIntento, 1);
    assert.equal(ok(await a.s.api.estado()).desbloqueado, false);
  } finally { await a.fin(); await otra.fin(); }
});

test('recuperar con contraseña nueva débil: CONTRASENA_DEBIL', async () => {
  const e = entorno();
  try {
    const { claveRecuperacion } = ok(await e.s.api.primerUso(PRIMER_USO));
    await e.s.api.bloquear();
    mal(await e.s.api.recuperar(claveRecuperacion, '123'), 'CONTRASENA_DEBIL');
  } finally { await e.fin(); }
});

test('cambiar contraseña: sólo el titular, con la actual, y vale tras reabrir', async () => {
  const e = await conPrimerUso();
  try {
    mal(await e.s.api.cambiarContrasena('no-es-esta-1', 'nueva-contraseña-2'), 'CONTRASENA_INCORRECTA');
    e.reloj.t += 2000;
    mal(await e.s.api.cambiarContrasena(PASS, 'corta'), 'CONTRASENA_DEBIL');
    ok(await e.s.api.cambiarContrasena(PASS, 'nueva-contraseña-2'));
    await e.s.cerrar();
    const s2 = e.reabrir();
    mal(await s2.api.desbloquear(PASS), 'CONTRASENA_INCORRECTA');
    e.reloj.t += 2000;
    ok(await s2.api.desbloquear('nueva-contraseña-2'));
    assert.equal(ok(await s2.api.obtenerFarmacia()).nombre, 'Farmacia Luz del Sur');
  } finally { await e.fin(); }
});

test('cambiar contraseña sin sesión o sin ser titular → SIN_SESION / SIN_PERMISO', async () => {
  const e = await conPrimerUso();
  try {
    await entrarComo(e, 'farmaceutico');
    mal(await e.s.api.cambiarContrasena(PASS, 'nueva-contraseña-2'), 'SIN_PERMISO');
    ok(await e.s.api.cerrarSesion());
    mal(await e.s.api.cambiarContrasena(PASS, 'nueva-contraseña-2'), 'SIN_SESION');
    await e.s.api.bloquear();
    mal(await e.s.api.cambiarContrasena(PASS, 'nueva-contraseña-2'), 'BLOQUEADO');
  } finally { await e.fin(); }
});

// ───────────────────────────── usuarios y PIN ─────────────────────────────

test('listarUsuarios: sólo activos y SIN hashes', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.crearUsuario({ nombre: 'Luis', iniciales: 'lu', rol: 'tecnico', pin: '1111' }));
    const l = ok(await e.s.api.listarUsuarios());
    assert.deepEqual(l.map(u => [u.nombre, u.iniciales, u.rol]), [['Marta Etxeberria', 'ME', 'titular'], ['Luis', 'LU', 'tecnico']]);
    assert.ok(l.every(u => Object.keys(u).sort().join() === 'id,iniciales,nombre,rol'));
    e.s.ctx.db().run('UPDATE usuario SET activo = 0 WHERE id = 2');
    assert.equal(ok(await e.s.api.listarUsuarios()).length, 1);
  } finally { await e.fin(); }
});

test('iniciar sesión con PIN: bueno entra y queda en la auditoría; malo no', async () => {
  const e = await conPrimerUso();
  try {
    const u = ok(await e.s.api.crearUsuario({ nombre: 'Luis', iniciales: 'LU', rol: 'tecnico', pin: '1111' }));
    mal(await e.s.api.iniciarSesion(u.id, '0000'), 'PIN_INCORRECTO');
    assert.equal(e.s.ctx.sesion()?.iniciales, 'ME');                              // sigue el titular
    const s = ok(await e.s.api.iniciarSesion(u.id, '1111'));
    assert.deepEqual(s, u);
    assert.equal(ok(await e.s.api.estado()).sesion?.id, u.id);
    mal(await e.s.api.iniciarSesion(999, '1111'), 'USUARIO_NO_ENCONTRADO');
    mal(await e.s.api.iniciarSesion(u.id, undefined as unknown as string), 'PIN_INCORRECTO');
    ok(await e.s.api.iniciarSesion(1, PIN));
    const acc = ok(await e.s.api.listarAuditoria({ entidad: 'usuario' }));
    assert.ok(acc.some(x => x.accion === 'login_fallido'));
    assert.ok(acc.some(x => x.accion === 'login' && x.entidadId === String(u.id)));
    ok(await e.s.api.cerrarSesion());
    ok(await e.s.api.iniciarSesion(1, PIN));
    assert.ok(ok(await e.s.api.listarAuditoria({ entidad: 'usuario' })).some(x => x.accion === 'logout'));
    assert.ok(acc.length > 0);
  } finally { await e.fin(); }
});

test('5 fallos de PIN seguidos bloquean al usuario 30 s; el reloj lo libera; otro usuario no se ve afectado', async () => {
  const e = await conPrimerUso();
  try {
    const u = ok(await e.s.api.crearUsuario({ nombre: 'Luis', iniciales: 'LU', rol: 'tecnico', pin: '1111' }));
    for (let i = 0; i < 4; i++) mal(await e.s.api.iniciarSesion(u.id, '0000'), 'PIN_INCORRECTO');
    mal(await e.s.api.iniciarSesion(u.id, '0000'), 'USUARIO_BLOQUEADO');          // el 5.º
    mal(await e.s.api.iniciarSesion(u.id, '1111'), 'USUARIO_BLOQUEADO');          // aunque sea el bueno
    ok(await e.s.api.iniciarSesion(1, PIN));                                       // el titular entra
    e.reloj.t += 29_000;
    mal(await e.s.api.iniciarSesion(u.id, '1111'), 'USUARIO_BLOQUEADO');
    e.reloj.t += 1_000;
    ok(await e.s.api.iniciarSesion(u.id, '1111'));
  } finally { await e.fin(); }
});

test('un acierto de PIN pone a cero los fallos', async () => {
  const e = await conPrimerUso();
  try {
    for (let i = 0; i < 4; i++) mal(await e.s.api.iniciarSesion(1, '0000'), 'PIN_INCORRECTO');
    ok(await e.s.api.iniciarSesion(1, PIN));
    for (let i = 0; i < 4; i++) mal(await e.s.api.iniciarSesion(1, '0000'), 'PIN_INCORRECTO');   // otra vez 4 libres
    ok(await e.s.api.iniciarSesion(1, PIN));
  } finally { await e.fin(); }
});

test('el bloqueo de PIN sobrevive a bloquear/desbloquear el programa', async () => {
  const e = await conPrimerUso();
  try {
    for (let i = 0; i < 5; i++) await e.s.api.iniciarSesion(1, '0000');
    await e.s.api.bloquear(); ok(await e.s.api.desbloquear(PASS));
    mal(await e.s.api.iniciarSesion(1, PIN), 'USUARIO_BLOQUEADO');
  } finally { await e.fin(); }
});

test('crearUsuario: el titular puede; los demás roles y sin sesión, no', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.crearUsuario({ nombre: 'Rosa', iniciales: 'ro', rol: 'farmaceutico', numColegiado: '12345', pin: '2222' }));
    for (const rol of ['farmaceutico', 'tecnico', 'administrativo'] as const) {
      ok(await e.s.api.cerrarSesion());
      const u = ok(await e.s.api.listarUsuarios()).find(x => x.rol === rol) ?? ok(await (async () => { ok(await e.s.api.iniciarSesion(1, PIN)); return e.s.api.crearUsuario({ nombre: rol, iniciales: 'XX', rol, pin: '3333' }); })());
      ok(await e.s.api.iniciarSesion(u.id, rol === 'farmaceutico' ? '2222' : '3333'));
      mal(await e.s.api.crearUsuario({ nombre: 'Intruso', iniciales: 'IN', rol: 'titular', pin: '5555' }), 'SIN_PERMISO');
    }
    ok(await e.s.api.cerrarSesion());
    mal(await e.s.api.crearUsuario({ nombre: 'Intruso', iniciales: 'IN', rol: 'titular', pin: '5555' }), 'SIN_SESION');
    assert.ok(!ok(await e.s.api.listarUsuarios()).some(u => u.nombre === 'Intruso'));
  } finally { await e.fin(); }
});

test('crearUsuario valida datos y no deja el PIN en ningún sitio (ni base ni auditoría)', async () => {
  const e = await conPrimerUso();
  try {
    mal(await e.s.api.crearUsuario({ nombre: '', iniciales: 'XX', rol: 'tecnico', pin: '1234' }), 'USUARIO_INVALIDO');
    mal(await e.s.api.crearUsuario({ nombre: 'A', iniciales: 'ABCDE', rol: 'tecnico', pin: '1234' }), 'USUARIO_INVALIDO');
    mal(await e.s.api.crearUsuario({ nombre: 'A', iniciales: 'A', rol: 'jefe' as never, pin: '1234' }), 'USUARIO_INVALIDO');
    mal(await e.s.api.crearUsuario({ nombre: 'A', iniciales: 'A', rol: 'tecnico', pin: '12' }), 'PIN_INVALIDO');
    ok(await e.s.api.crearUsuario({ nombre: 'Luis', iniciales: 'LU', rol: 'tecnico', pin: '6543' }));
    const h = e.s.ctx.db().get<{ hash_clave: string }>("SELECT hash_clave FROM usuario WHERE nombre = 'Luis'")!.hash_clave;
    assert.match(h, /^scrypt\$/); assert.equal(h.includes('6543'), false);
    const crudas = JSON.stringify(e.s.ctx.db().all('SELECT antes, despues, motivo FROM auditoria'));
    assert.equal(crudas.includes('6543'), false); assert.equal(crudas.includes('scrypt'), false);
    assert.equal(JSON.stringify(ok(await e.s.api.listarAuditoria({}))).includes('scrypt'), false);
  } finally { await e.fin(); }
});

// ───────────────────────────── farmacia y ajustes ─────────────────────────────

test('farmacia: ida y vuelta, sólo titular, con validación y auditoría de antes/después', async () => {
  const e = await conPrimerUso();
  try {
    const nueva = { ...PRIMER_USO.farmacia, nif: 'B12345678', telefono: '945 000 000', email: 'info@luz.example' };
    const g = ok(await e.s.api.guardarFarmacia(nueva));
    assert.equal(g.nif, 'B12345678'); assert.equal(g.direccion, null);
    assert.equal(ok(await e.s.api.obtenerFarmacia()).email, 'info@luz.example');
    mal(await e.s.api.guardarFarmacia({ ...nueva, nombre: ' ' }), 'FARMACIA_INVALIDA');
    mal(await e.s.api.guardarFarmacia({ ...nueva, email: 'no-es-un-correo' }), 'FARMACIA_INVALIDA');
    const l = ok(await e.s.api.listarAuditoria({ entidad: 'farmacia' }));
    assert.match(l[0].resumen, /modificar farmacia #1: .*nif: null → B12345678/);
    await entrarComo(e, 'tecnico');
    mal(await e.s.api.guardarFarmacia(nueva), 'SIN_PERMISO');
  } finally { await e.fin(); }
});

test('ajustes por defecto', async () => {
  const e = await conPrimerUso();
  try {
    const a = ok(await e.s.api.obtenerAjustes());
    assert.deepEqual(a, {
      diasValidezSpd: 14, validezExtendidaPermitida: false, conservacionAniosTrasBaja: 2, bloqueoMinutos: 5, inicioDia: 'convencional', rotar180: false,
      sentidoTomas: 'izquierda_derecha', posicionInicial: 'izquierda', lector: { modo: 'teclado', separadorGs: '' },
      impresoraEtiquetas: null, impresoraDocumentos: null, carpetaCopias: null,
    });
  } finally { await e.fin(); }
});

test('ajustes: rangos y tipos (validez 1-30, bloqueo, enteros, enums, lector)', async () => {
  const e = await conPrimerUso();
  try {
    const invalidos: Partial<Ajustes>[] = [
      { diasValidezSpd: 0 }, { diasValidezSpd: 31 }, { diasValidezSpd: 7.5 }, { diasValidezSpd: '14' as never },
      { bloqueoMinutos: 0 }, { bloqueoMinutos: 121 }, { conservacionAniosTrasBaja: 0 }, { conservacionAniosTrasBaja: 51 },
      { inicioDia: 'otro' as never }, { sentidoTomas: 'arriba' as never }, { posicionInicial: 'centro' as never },
      { rotar180: 'si' as never }, { lector: { modo: 'usb' as never, separadorGs: '' } }, { lector: { modo: 'serie', separadorGs: '', baudios: 5 } },
      { lector: { modo: 'serie', separadorGs: 'demasiado-largo' } }, { lector: null as never },
    ];
    for (const a of invalidos) mal(await e.s.api.guardarAjustes(a), /AJUSTE_INVALIDO/.test('') ? undefined : 'AJUSTE_INVALIDO');
    const antes = ok(await e.s.api.obtenerAjustes());
    const ok1 = ok(await e.s.api.guardarAjustes({
      diasValidezSpd: 7, bloqueoMinutos: 10, conservacionAniosTrasBaja: 5, inicioDia: 'cronologico', rotar180: true,
      sentidoTomas: 'derecha_izquierda', posicionInicial: 'derecha', lector: { modo: 'serie', separadorGs: '|', puerto: 'COM3', baudios: 9600 },
      impresoraEtiquetas: 'Zebra ZD', carpetaCopias: 'D:\\Copias',
    }));
    assert.equal(ok1.diasValidezSpd, 7); assert.equal(ok1.rotar180, true); assert.deepEqual(ok1.lector, { modo: 'serie', separadorGs: '|', puerto: 'COM3', baudios: 9600 });
    assert.deepEqual({ ...ok1, diasValidezSpd: 0 }, { ...ok1, diasValidezSpd: 0 });
    assert.notDeepEqual(ok1, antes);
    // Un ajuste parcial no toca los demás
    const parcial = ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 15 }));
    assert.equal(parcial.bloqueoMinutos, 15); assert.equal(parcial.impresoraEtiquetas, 'Zebra ZD'); assert.equal(parcial.diasValidezSpd, 7);
    // y se puede vaciar una impresora
    assert.equal(ok(await e.s.api.guardarAjustes({ impresoraEtiquetas: null })).impresoraEtiquetas, null);
    assert.equal(ok(await e.s.api.guardarAjustes({ carpetaCopias: '' })).carpetaCopias, null);
  } finally { await e.fin(); }
});

test('ajustes: los valores persisten tras cerrar y reabrir', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ diasValidezSpd: 10, bloqueoMinutos: 20, lector: { modo: 'serie', separadorGs: '#' } }));
    await e.s.cerrar();
    const s2 = e.reabrir(); ok(await s2.api.desbloquear(PASS));
    const a = ok(await s2.api.obtenerAjustes());
    assert.equal(a.diasValidezSpd, 10); assert.equal(a.bloqueoMinutos, 20); assert.deepEqual(a.lector, { modo: 'serie', separadorGs: '#' });
  } finally { await e.fin(); }
});

test('validez extendida: sólo el titular, con motivo, y >14 días exige tenerla activada', async () => {
  const e = await conPrimerUso();
  try {
    mal(await e.s.api.guardarAjustes({ diasValidezSpd: 21 }), 'VALIDEZ_NO_PERMITIDA');
    mal(await e.s.api.guardarAjustes({ validezExtendidaPermitida: true }), 'MOTIVO_OBLIGATORIO');
    mal(await e.s.api.guardarAjustes({ validezExtendidaPermitida: true, motivo: 'sí' } as never), 'MOTIVO_OBLIGATORIO');
    assert.equal(ok(await e.s.api.obtenerAjustes()).validezExtendidaPermitida, false);
    const a = ok(await e.s.api.guardarAjustes({ validezExtendidaPermitida: true, diasValidezSpd: 21, motivo: 'Residencia con dos entregas al mes' } as never));
    assert.equal(a.validezExtendidaPermitida, true); assert.equal(a.diasValidezSpd, 21);
    const fila = e.s.ctx.db().get<{ dias_validez_spd: number; validez_extendida_permitida: number }>('SELECT dias_validez_spd, validez_extendida_permitida FROM farmacia WHERE id = 1')!;
    assert.deepEqual({ ...fila }, { dias_validez_spd: 21, validez_extendida_permitida: 1 });
    const l = ok(await e.s.api.listarAuditoria({ entidad: 'ajustes' }));
    assert.equal(l[0].motivo, 'Residencia con dos entregas al mes');
    assert.match(l[0].resumen, /validezExtendidaPermitida: false → true/);
    // Quitarla estando a 21 días no vale; bajando antes los días, sí
    mal(await e.s.api.guardarAjustes({ validezExtendidaPermitida: false }), 'VALIDEZ_NO_PERMITIDA');
    ok(await e.s.api.guardarAjustes({ validezExtendidaPermitida: false, diasValidezSpd: 14 }));
  } finally { await e.fin(); }
});

test('validez extendida: farmacéutico y técnico NO pueden cambiarla; el farmacéutico sí cambia otros ajustes', async () => {
  const e = await conPrimerUso();
  try {
    await entrarComo(e, 'farmaceutico');
    mal(await e.s.api.guardarAjustes({ validezExtendidaPermitida: true, motivo: 'porque sí, lo digo yo' } as never), 'SIN_PERMISO');
    assert.equal(ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 8 })).bloqueoMinutos, 8);
    ok(await e.s.api.iniciarSesion(1, PIN));
    await entrarComo(e, 'tecnico');
    mal(await e.s.api.guardarAjustes({ bloqueoMinutos: 9 }), 'SIN_PERMISO');
    assert.equal(ok(await e.s.api.obtenerAjustes()).bloqueoMinutos, 8);                // ver sí puede
    ok(await e.s.api.cerrarSesion());
    mal(await e.s.api.guardarAjustes({ bloqueoMinutos: 9 }), 'SIN_SESION');
  } finally { await e.fin(); }
});

test('guardar ajustes sin cambios reales no ensucia la auditoría', async () => {
  const e = await conPrimerUso();
  try {
    const n = ok(await e.s.api.verificarAuditoria()).entradas;
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 5 }));
    assert.equal(ok(await e.s.api.verificarAuditoria()).entradas, n);
  } finally { await e.fin(); }
});

// ───────────────────────────── momentos de toma ─────────────────────────────

test('momentos: editar, añadir y reordenar; los que faltan y no se usan se borran', async () => {
  const e = await conPrimerUso();
  try {
    const m = ok(await e.s.api.listarMomentos());
    const r = ok(await e.s.api.guardarMomentos([
      { id: m[0].id, nombre: 'Desayuno', hora: '07:30', orden: 2 },
      { id: m[1].id, nombre: 'Comida', hora: '14:00', orden: 3 },
      { nombre: 'Media mañana', hora: '11:00', orden: 1 },
    ]));
    assert.deepEqual(r.map(x => [x.nombre, x.hora, x.orden, x.activo]), [['Media mañana', '11:00', 1, true], ['Desayuno', '07:30', 2, true], ['Comida', '14:00', 3, true]]);
    assert.equal(r.some(x => x.nombre === 'Cena'), false);                             // sin uso → borrada
  } finally { await e.fin(); }
});

test('momentos: uno USADO por una pauta no se borra, se desactiva', async () => {
  const e = await conPrimerUso();
  try {
    const db = e.s.ctx.db();
    db.run("INSERT INTO paciente(id_publico,nombre,apellido1) VALUES ('uuid-1','Pac','Iente')");
    db.run("INSERT INTO tratamiento(paciente_id,principio_activo) VALUES (1,'metformina')");
    db.run("INSERT INTO pauta_version(tratamiento_id,version,vigente_desde,patron,origen,creado_por) VALUES (1,1,'2026-11-01','diario','receta',1)");
    const m = ok(await e.s.api.listarMomentos());
    const cena = m.find(x => x.nombre === 'Cena')!;
    db.run('INSERT INTO pauta_dosis(pauta_version_id,momento_id,unidades) VALUES (1,?,1)', [cena.id]);
    const r = ok(await e.s.api.guardarMomentos(m.filter(x => x.nombre !== 'Cena' && x.nombre !== 'Acostarse').map(x => ({ id: x.id, nombre: x.nombre, hora: x.hora ?? undefined, orden: x.orden }))));
    const c = r.find(x => x.id === cena.id)!;
    assert.equal(c.activo, false);                                                     // desactivada, conservada
    assert.equal(r.some(x => x.nombre === 'Acostarse'), false);                        // la no usada, borrada
    assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM pauta_dosis WHERE momento_id = ?', [cena.id])!.n, 1);   // la pauta sigue intacta
  } finally { await e.fin(); }
});

test('momentos: validaciones (activos, duplicados, hora, ids, permisos)', async () => {
  const e = await conPrimerUso();
  try {
    const m = ok(await e.s.api.listarMomentos());
    mal(await e.s.api.guardarMomentos([]), 'MOMENTOS_INVALIDOS');
    mal(await e.s.api.guardarMomentos([{ nombre: 'Único', orden: 1, activo: false }]), 'MOMENTOS_INVALIDOS');
    mal(await e.s.api.guardarMomentos([{ nombre: 'A', orden: 1 }, { nombre: ' a ', orden: 2 }]), 'MOMENTOS_INVALIDOS');
    mal(await e.s.api.guardarMomentos([{ nombre: 'A', orden: 1, hora: '8:00' }]), 'MOMENTOS_INVALIDOS');
    mal(await e.s.api.guardarMomentos([{ nombre: 'A', orden: 1.5 }]), 'MOMENTOS_INVALIDOS');
    mal(await e.s.api.guardarMomentos([{ id: 999, nombre: 'A', orden: 1 }]), 'MOMENTOS_INVALIDOS');
    assert.equal(ok(await e.s.api.listarMomentos()).length, m.length);                 // nada cambió
    await entrarComo(e, 'tecnico');
    mal(await e.s.api.guardarMomentos([{ nombre: 'A', orden: 1 }]), 'SIN_PERMISO');
  } finally { await e.fin(); }
});

// ───────────────────────────── auditoría ─────────────────────────────

test('auditoría: resumen legible, filtros, orden descendente y límite', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 7 }));
    const l = ok(await e.s.api.listarAuditoria({ entidad: 'ajustes' }));
    assert.equal(l.length, 1);
    assert.equal(l[0].usuario, 'Marta Etxeberria'); assert.equal(l[0].accion, 'modificar');
    assert.equal(l[0].resumen, 'modificar ajustes: bloqueoMinutos: 5 → 7');
    const todas = ok(await e.s.api.listarAuditoria({}));
    assert.ok(todas.length >= 5);
    assert.ok(todas.every((x, i) => i === 0 || x.id < todas[i - 1].id));
    assert.equal(ok(await e.s.api.listarAuditoria({ limite: 2 })).length, 2);
    assert.equal(ok(await e.s.api.listarAuditoria({ entidad: 'usuario', entidadId: '1' })).every(x => x.entidadId === '1'), true);
    assert.equal(ok(await e.s.api.listarAuditoria({ entidad: 'no-existe' })).length, 0);
  } finally { await e.fin(); }
});

test('auditoría: solo titular y farmacéutico la ven', async () => {
  const e = await conPrimerUso();
  try {
    await entrarComo(e, 'tecnico');
    mal(await e.s.api.listarAuditoria({}), 'SIN_PERMISO');
    mal(await e.s.api.verificarAuditoria(), 'SIN_PERMISO');
    ok(await e.s.api.cerrarSesion());
    mal(await e.s.api.listarAuditoria({}), 'SIN_SESION');
  } finally { await e.fin(); }
});

function sinTriggers(e: Entorno) { const db = e.s.ctx.db(); db.exec('DROP TRIGGER auditoria_sin_update; DROP TRIGGER auditoria_sin_delete;'); return db; }

test('auditoría: la cadena sana verifica', async () => {
  const e = await conPrimerUso();
  try {
    for (let i = 0; i < 4; i++) ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 10 + i }));
    const v = ok(await e.s.api.verificarAuditoria());
    assert.equal(v.ok, true); assert.ok(v.entradas >= 8); assert.equal(v.primerError, undefined);
  } finally { await e.fin(); }
});

test('auditoría: modificar una entrada se detecta', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 12 }));
    sinTriggers(e).run("UPDATE auditoria SET motivo = 'cambiado a mano' WHERE id = 2");
    const v = ok(await e.s.api.verificarAuditoria());
    assert.equal(v.ok, false); assert.match(v.primerError!, /Entrada nº 2.*hash_incorrecto/);
  } finally { await e.fin(); }
});

test('auditoría: borrar una entrada del medio se detecta', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 12 }));
    sinTriggers(e).run('DELETE FROM auditoria WHERE id = 2');
    const v = ok(await e.s.api.verificarAuditoria());
    assert.equal(v.ok, false); assert.match(v.primerError!, /cadena_rota/);
  } finally { await e.fin(); }
});

test('auditoría: borrar la PRIMERA entrada se detecta', async () => {
  const e = await conPrimerUso();
  try {
    sinTriggers(e).run('DELETE FROM auditoria WHERE id = 1');
    assert.equal(ok(await e.s.api.verificarAuditoria()).ok, false);
  } finally { await e.fin(); }
});

test('auditoría: borrar la ÚLTIMA entrada se detecta con el sello guardado aparte', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 12 }));
    const db = sinTriggers(e);
    const ultima = db.get<{ id: number }>('SELECT max(id) id FROM auditoria')!.id;
    db.run('DELETE FROM auditoria WHERE id = ?', [ultima]);
    // La cadena que queda es internamente coherente, pero el sello no cuadra
    const v = ok(await e.s.api.verificarAuditoria());
    assert.equal(v.ok, false); assert.match(v.primerError!, /sello/);
  } finally { await e.fin(); }
});

test('auditoría: vaciarla entera o quitar el sello se detecta', async () => {
  const e = await conPrimerUso();
  try {
    const db = sinTriggers(e);
    db.run('DELETE FROM auditoria');
    assert.equal(ok(await e.s.api.verificarAuditoria()).ok, false);
  } finally { await e.fin(); }
  const f = await conPrimerUso();
  try {
    f.s.ctx.db().run("DELETE FROM ajuste WHERE clave = 'auditoria_ultimo_hash'");
    const v = ok(await f.s.api.verificarAuditoria());
    assert.equal(v.ok, false); assert.match(v.primerError!, /sello/);
  } finally { await f.fin(); }
});

test('auditoría: la manipulación sobrevive al guardado y se detecta tras reabrir', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 12 }));
    const db = sinTriggers(e);
    db.run("UPDATE auditoria SET accion = 'otra' WHERE id = 1");
    e.s.ctx.persistir();
    await e.s.cerrar();
    const s2 = e.reabrir(); ok(await s2.api.desbloquear(PASS)); ok(await s2.api.iniciarSesion(1, PIN));
    assert.equal(ok(await s2.api.verificarAuditoria()).ok, false);
  } finally { await e.fin(); }
});

test('ctx.auditar escribe la cadena con el usuario de la sesión, enmascara secretos y respeta el rollback', async () => {
  const e = await conPrimerUso();
  try {
    const { ctx } = e.s;
    const db = ctx.db();
    db.transaccion(() => ctx.auditar({ accion: 'modificar', entidad: 'paciente', entidadId: 7, antes: { dosis: 1, hash_clave: 'secreto-1' }, despues: { dosis: 2, pin: '1234' }, motivo: 'ajuste' }));
    const u = db.get<{ usuario_id: number; antes: string; despues: string; entidad_id: string }>('SELECT * FROM auditoria ORDER BY id DESC LIMIT 1')!;
    assert.equal(u.usuario_id, 1); assert.equal(u.entidad_id, '7');
    assert.equal(u.antes.includes('secreto-1'), false); assert.equal(u.despues.includes('1234'), false);
    const n = db.get<{ n: number }>('SELECT count(*) n FROM auditoria')!.n;
    assert.throws(() => db.transaccion(() => { ctx.auditar({ accion: 'x', entidad: 'y' }); throw new Error('revertir'); }));
    assert.equal(db.get<{ n: number }>('SELECT count(*) n FROM auditoria')!.n, n);        // la auditoría se deshizo con el cambio
    assert.equal(ok(await e.s.api.verificarAuditoria()).ok, true);                         // y el sello también
  } finally { await e.fin(); }
});

test('ctx: ahora() usa el reloj inyectado, persistir() guarda y auditar sin base lanza', async () => {
  const e = await conPrimerUso();
  try {
    assert.equal(e.s.ctx.ahora().toISOString(), '2026-11-02T09:00:00.000Z');
    e.s.ctx.db().run("INSERT INTO ajuste(clave,valor) VALUES ('prueba','1')");
    e.s.ctx.persistir();
    await e.s.guardarAhora();
    await e.s.api.bloquear();
    assert.throws(() => e.s.ctx.auditar({ accion: 'x', entidad: 'y' }), /bloqueado/);
    const base = abrirConContrasena(readFileSync(join(e.dir, 'spd.datos')), PASS);
    assert.ok(Buffer.from(base.bytesDb).length > 1000);
    ok(await e.s.api.desbloquear(PASS));
    assert.equal(e.s.ctx.db().get<{ valor: string }>("SELECT valor FROM ajuste WHERE clave = 'prueba'")!.valor, '1');
  } finally { await e.fin(); }
});

// ───────────────────────────── copias ─────────────────────────────

test('copias: sin carpeta configurada está atrasada y crearCopia lo explica', async () => {
  const e = await conPrimerUso();
  try {
    assert.deepEqual(ok(await e.s.api.estadoCopias()), { ultima: null, atrasada: true, carpeta: null, total: 0 });
    mal(await e.s.api.crearCopia(), 'SIN_CARPETA_COPIAS');
  } finally { await e.fin(); }
});

test('copias: crearCopia con carpeta; el fichero abre con la contraseña y trae los datos', async () => {
  const e = await conPrimerUso();
  try {
    const carpeta = join(e.dir, 'mis-copias');
    ok(await e.s.api.guardarAjustes({ carpetaCopias: carpeta }));
    const { ruta } = ok(await e.s.api.crearCopia());
    assert.equal(ruta, join(carpeta, 'spd-20261102-090000.datos'));
    const est = ok(await e.s.api.estadoCopias());
    assert.equal(est.total, 1); assert.equal(est.atrasada, false); assert.equal(est.ultima, '2026-11-02T09:00:00.000Z'); assert.equal(est.carpeta, carpeta);
    // La copia es una base completa y está al día (incluye lo último guardado)
    const copia = abrirConContrasena(readFileSync(ruta), PASS);
    const { abrirDb } = await import('../src/servicios/db.ts');
    const d = await abrirDb(copia.bytesDb);
    assert.equal(d.get<{ nombre: string }>('SELECT nombre FROM farmacia WHERE id = 1')!.nombre, 'Farmacia Luz del Sur');
    assert.equal(d.get<{ valor: string }>("SELECT valor FROM ajuste WHERE clave = 'carpeta_copias'")!.valor, carpeta);
    assert.ok(ok(await e.s.api.listarAuditoria({ entidad: 'copia' })).length === 1);
    // y no hay nada en claro en ella
    assert.equal(readFileSync(ruta).indexOf('Luz del Sur'), -1);
  } finally { await e.fin(); }
});

test('copias: carpeta indicada en la llamada, aviso de atrasada pasados 2 días y rotación', async () => {
  const e = await conPrimerUso();
  try {
    const carpeta = join(e.dir, 'otra');
    for (let i = 0; i < 20; i++) { ok(await e.s.api.crearCopia(carpeta)); e.reloj.t += 24 * 3600 * 1000; }
    const l = readdirSync(carpeta).filter(f => f.endsWith('.datos'));
    assert.ok(l.length < 20 && l.length >= 7, `quedan ${l.length}`);
    ok(await e.s.api.guardarAjustes({ carpetaCopias: carpeta }));
    assert.equal(ok(await e.s.api.estadoCopias()).atrasada, false);                    // la última fue ayer (+1 día)
    e.reloj.t += 3 * 24 * 3600 * 1000;
    assert.equal(ok(await e.s.api.estadoCopias()).atrasada, true);
  } finally { await e.fin(); }
});

test('copias: el técnico no puede; la automática no pide sesión', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ carpetaCopias: join(e.dir, 'copias') }));
    await entrarComo(e, 'tecnico');
    mal(await e.s.api.crearCopia(), 'SIN_PERMISO');
    ok(await e.s.api.cerrarSesion());
    mal(await e.s.api.crearCopia(), 'SIN_SESION');
    const r = ok(await e.s.crearCopiaAutomatica());
    assert.equal(existsSync(r.ruta), true);
    await e.s.api.bloquear();
    mal(await e.s.crearCopiaAutomatica(), 'BLOQUEADO');
    mal(await e.s.api.estadoCopias(), 'BLOQUEADO');
  } finally { await e.fin(); }
});

test('copias: carpeta imposible → fallo claro, sin excepción', async () => {
  const e = await conPrimerUso();
  try {
    writeFileSync(join(e.dir, 'archivo'), 'x');
    mal(await e.s.api.crearCopia(join(e.dir, 'archivo', 'dentro')), 'CARPETA_COPIAS');
  } finally { await e.fin(); }
});

// ───────────────────────────── fichero dañado y robustez ─────────────────────────────

test('fichero principal dañado con copia buena: error con código propio y desbloquearConCopia con aviso', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 33 }));
    await e.s.guardarAhora();
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 44 }));
    await e.s.cerrar();
    const p = readFileSync(join(e.dir, 'spd.datos')); writeFileSync(join(e.dir, 'spd.datos'), p.subarray(0, p.length - 30));
    const s2 = e.reabrir();
    mal(await s2.api.desbloquear(PASS), 'FICHERO_DANADO_COPIA_DISPONIBLE');
    mal(await s2.api.desbloquearConCopia('contraseña-equivocada'), 'CONTRASENA_INCORRECTA');
    e.reloj.t += 5000;
    assert.equal(ok(await s2.api.estado()).desbloqueado, false);
    assert.equal(ok(await s2.api.estado()).esperaIntento, 0);                           // no es un fallo de contraseña
    const r = ok(await s2.api.desbloquearConCopia(PASS));
    assert.match(r.aviso, /copia anterior/); assert.equal(r.desbloqueado, true);
    assert.equal(ok(await s2.api.obtenerFarmacia()).nombre, 'Farmacia Luz del Sur');
  } finally { await e.fin(); }
});

test('fichero ajeno o basura en la carpeta: error claro, nunca excepción', async () => {
  const e = entorno();
  try {
    writeFileSync(join(e.dir, 'spd.datos'), Buffer.from('esto no es un fichero de SPD'));
    const s = ok(await e.s.api.estado());
    assert.equal(s.inicializado, true);
    mal(await e.s.api.desbloquear(PASS), 'FICHERO_CORRUPTO');
    mal(await e.s.api.primerUso(PRIMER_USO), 'YA_INICIALIZADO');
  } finally { await e.fin(); }
});

test('ningún método lanza: todos devuelven Resultado con argumentos basura, bloqueado y desbloqueado', async () => {
  const e = await conPrimerUso();
  try {
    const basura: unknown[][] = [[], [undefined], [null], [42], ['x'], [{}], [[]], [{ nombre: 5 }], ['x', 'y'], [NaN, {}]];
    const metodos = Object.keys(e.s.api) as (keyof typeof e.s.api)[];
    const barrer = async () => {
      for (const m of metodos) {
        if (m === 'primerUso' || m === 'bloquear' || m === 'cerrarSesion') continue;
        for (const args of basura) {
          const r = await (e.s.api[m] as (...a: unknown[]) => Promise<Resultado<unknown>>)(...args);
          assert.equal(typeof r?.ok, 'boolean', `${m}(${JSON.stringify(args)})`);
          if (!r.ok) assert.equal(typeof r.error, 'string');
        }
      }
    };
    await barrer();                         // desbloqueado, con sesión
    ok(await e.s.api.cerrarSesion());
    await barrer();                         // sin sesión
    ok(await e.s.api.bloquear());
    e.reloj.t += 3_600_000;
    await barrer();                         // bloqueado
    for (const args of basura) assert.equal(typeof (await e.s.api.primerUso(args[0] as PrimerUso)).ok, 'boolean');
    assert.equal((await e.s.api.estado()).ok, true);
  } finally { await e.fin(); }
});

test('la versión de estado es la indicada y los datos de estado no incluyen secretos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spd-sistema-'));
  try {
    const s = crearSistema({ rutaDatos: dir, version: '9.9.9', kdf: KDF });
    const est = ok(await s.api.estado());
    assert.equal(est.version, '9.9.9');
    assert.deepEqual(Object.keys(est).sort(), ['desbloqueado', 'esperaIntento', 'inicializado', 'rutaDatos', 'sesion', 'version']);
    await s.cerrar();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cerrar() deja todo guardado y es repetible', async () => {
  const e = await conPrimerUso();
  try {
    ok(await e.s.api.guardarAjustes({ bloqueoMinutos: 77 }));
    await e.s.cerrar(); await e.s.cerrar();
    const s2 = e.reabrir(); ok(await s2.api.desbloquear(PASS));
    assert.equal(ok(await s2.api.obtenerAjustes()).bloqueoMinutos, 77);
  } finally { await e.fin(); }
});
