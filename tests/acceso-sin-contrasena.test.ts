/**
 * Contraseña de arranque y PIN OPCIONALES (docs/10 §10.1 y §10.2).
 *  - Modo «sin contraseña de arranque»: la base sigue cifrada; la clave de datos se envuelve con el sistema operativo
 *    (`ProtectorClave`, aquí un doble). Ida y vuelta contraseña ↔ sistema sin perder datos, con copia previa y auditoría.
 *  - Ajustes «pedir PIN» y «pedir elegir usuario al arrancar»; validar sin PIN exige identificar a un farmacéutico/titular.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crearSistema } from '../src/servicios/sistema.ts';
import type { Sistema } from '../src/servicios/sistema.ts';
import { crearClinicaPreparacion } from '../src/servicios/clinica-preparacion.ts';
import { crearAlmacen } from '../src/servicios/almacen.ts';
import {
  abrirConClaveDeDatos, abrirConContrasena, abrirConProtector, crearAlmacenNuevo, crearAlmacenNuevoSistema, kdfPorMigrar,
  pareceFicheroSpd, tipoDeEnvoltura,
} from '../src/servicios/seguridad.ts';
import type { ProtectorClave } from '../src/servicios/seguridad.ts';
import { ErrorSpd } from '../src/servicios/contexto.ts';
import { claveDesdeTexto } from '../src/dominio/clave-recuperacion.ts';
import { protectorDeSafeStorage } from '../src/principal/protector-clave.ts';
import type { PrimerUso, Resultado } from '../src/servicios/api.ts';

const KDF = { n: 1 << 10, r: 8, p: 1 };
const PASS = 'mi-contraseña-farmacia';
const PIN = '4821';
const MOTIVO = 'El equipo del mostrador es de uso exclusivo';

const ok = <T,>(r: Resultado<T>): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; datos: T }).datos; };
const mal = (r: Resultado<unknown>, codigo?: string) => {
  assert.equal(r.ok, false, 'se esperaba un fallo');
  if (codigo) assert.equal((r as { codigo?: string }).codigo, codigo, JSON.stringify(r));
  return r as { ok: false; error: string; codigo?: string };
};
const codigo = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof ErrorSpd ? e.codigo : 'OTRO:' + (e as Error).message; } return 'SIN_ERROR'; };

/** Doble del almacén de claves de Windows: la clave sólo se descifra con el mismo «usuario de Windows». */
function doble(usuario = 'ana', opc: { disponible?: boolean; rompeAlDescifrar?: boolean; noCifra?: boolean } = {}): ProtectorClave & { llamadas: { cifrar: number; descifrar: number } } {
  const llamadas = { cifrar: 0, descifrar: 0 };
  const k = createHash('sha256').update('usuario:' + usuario).digest();
  const xor = (b: Uint8Array) => Uint8Array.from(b, (x, i) => x ^ k[i % k.length]!);
  return {
    llamadas,
    disponible: () => opc.disponible !== false,
    motivoNoDisponible: () => 'Windows no ofrece su almacén de claves para este usuario',
    cifrar(c) { llamadas.cifrar++; if (opc.noCifra) throw new Error('no puedo'); return Uint8Array.from([...xor(c), ...Buffer.from('|' + usuario)]); },
    descifrar(c) {
      llamadas.descifrar++;
      if (opc.rompeAlDescifrar) return new Uint8Array(32);   // devuelve basura
      const marca = '|' + usuario;
      const fin = Buffer.from(c.subarray(c.length - marca.length)).toString();
      if (fin !== marca) throw new Error('otro usuario de Windows');
      return xor(c.subarray(0, c.length - marca.length));
    },
  };
}

const PRIMER_USO: PrimerUso = {
  farmacia: { nombre: 'Farmacia Luz del Sur', titular: 'Marta Etxeberria', municipio: 'Vitoria-Gasteiz', provincia: 'Álava' },
  titular: { nombre: 'Marta Etxeberria', iniciales: 'ME', pin: PIN },
  contrasena: PASS,
  momentos: [{ nombre: 'Desayuno', hora: '08:00' }, { nombre: 'Comida', hora: '14:00' }, { nombre: 'Cena', hora: '21:00' }, { nombre: 'Acostarse' }],
};
const SIN: PrimerUso = { ...PRIMER_USO, contrasena: undefined, sinContrasena: true, reconoceRiesgoSinContrasena: true };

interface Entorno { dir: string; copias: string; reloj: { t: number }; s: Sistema; abrir(p?: ProtectorClave): Sistema; fin(): Promise<void> }
/** `null` = sin almacén de claves de Windows. */
function entorno(prot: ProtectorClave | null = doble()): Entorno {
  const protector = prot ?? undefined;
  const dir = mkdtempSync(join(tmpdir(), 'spd-acceso-'));
  const copias = join(dir, 'copias-fuera'); mkdirSync(copias);
  const abiertos: Sistema[] = [];
  const reloj = { t: Date.parse('2026-11-02T09:00:00Z') };
  const crear = (p?: ProtectorClave) => {
    const s = crearSistema({ rutaDatos: join(dir, 'datos'), ahora: () => new Date(reloj.t), kdf: KDF, debounceMs: 60_000, protector: p, carpetaCopiasPorDefecto: copias });
    abiertos.push(s); return s;
  };
  const e: Entorno = { dir, copias, reloj, s: crear(protector), abrir: (p = protector) => (e.s = crear(p)), async fin() { for (const s of abiertos) await s.cerrar(); rmSync(dir, { recursive: true, force: true }); } };
  return e;
}
const fichero = (e: Entorno) => readFileSync(join(e.dir, 'datos', 'spd.datos'));
const auditoria = async (e: Entorno) => e.s.ctx.db().all<{ accion: string; entidad: string; motivo: string | null }>('SELECT accion, entidad, motivo FROM auditoria ORDER BY id');

// ───────────────────────────── fichero: seguridad.ts ─────────────────────────────

test('fichero sin contraseña: versión 2, tipo explícito, cifrado, y abre con el protector y con la clave de recuperación', () => {
  const p = doble();
  const db = new Uint8Array(Buffer.from('contenido-secreto-de-pacientes'.repeat(20)));
  const { fichero: f, claveDatos } = crearAlmacenNuevoSistema(p, db);
  assert.equal(f[8], 2); assert.equal(pareceFicheroSpd(f), true);
  assert.equal(tipoDeEnvoltura(f), 'sistema');
  assert.equal(Buffer.from(f).includes(Buffer.from('contenido-secreto')), false, 'la base no está en claro');
  assert.deepEqual(abrirConProtector(f, p).bytesDb, db);
  assert.deepEqual(abrirConClaveDeDatos(f, claveDatos).bytesDb, db, 'la clave de recuperación (= clave de datos) sigue valiendo');
  assert.equal(kdfPorMigrar(f), false);
  // y un fichero con contraseña sigue siendo versión 1 con tipo explícito
  const c = crearAlmacenNuevo(PASS, db, KDF);
  assert.equal(c.fichero[8], 1); assert.equal(tipoDeEnvoltura(c.fichero), 'contrasena');
});

test('fichero sin contraseña: otro usuario de Windows → CLAVE_SISTEMA_ILEGIBLE; contraseña sobre él → SIN_CONTRASENA; protector sobre uno con contraseña → CON_CONTRASENA', () => {
  const { fichero: f } = crearAlmacenNuevoSistema(doble('ana'), new Uint8Array(100));
  assert.equal(codigo(() => abrirConProtector(f, doble('luis'))), 'CLAVE_SISTEMA_ILEGIBLE');
  assert.equal(codigo(() => abrirConProtector(f, undefined)), 'PROTECTOR_NO_DISPONIBLE');
  assert.equal(codigo(() => abrirConProtector(f, doble('ana', { rompeAlDescifrar: true }))), 'FICHERO_CORRUPTO', 'una clave que no autentica nunca abre');
  assert.equal(codigo(() => abrirConContrasena(f, PASS)), 'SIN_CONTRASENA');
  const c = crearAlmacenNuevo(PASS, new Uint8Array(100), KDF).fichero;
  assert.equal(codigo(() => abrirConProtector(c, doble())), 'CON_CONTRASENA');
});

test('fichero sin contraseña: cualquier byte tocado (cabecera, versión, carga) hace fallar la autenticación', () => {
  const p = doble();
  const { fichero: f } = crearAlmacenNuevoSistema(p, new Uint8Array(200));
  for (const i of [9, 20, f.length - 1, 60]) {
    const x = Uint8Array.from(f); x[i] = x[i]! ^ 1;
    assert.match(codigo(() => abrirConProtector(x, p)), /^(FICHERO_CORRUPTO|VERSION_FICHERO|CLAVE_SISTEMA_ILEGIBLE)$/, `byte ${i}`);
  }
  const v1 = Uint8Array.from(f); v1[8] = 1;   // versión de contraseña con tipo «sistema»: incoherente
  assert.equal(codigo(() => abrirConProtector(v1, p)), 'FICHERO_CORRUPTO');
});

test('crear sin contraseña con un protector que falla NO escribe nada (no disponible, no cifra, descifra basura)', async () => {
  for (const [p, cod] of [[undefined, 'PROTECTOR_NO_DISPONIBLE'], [doble('a', { disponible: false }), 'PROTECTOR_NO_DISPONIBLE'], [doble('a', { noCifra: true }), 'PROTECTOR_NO_DISPONIBLE'], [doble('a', { rompeAlDescifrar: true }), 'PROTECTOR_NO_DISPONIBLE']] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'spd-acceso-'));
    try {
      const a = crearAlmacen({ rutaDatos: dir, kdf: KDF, protector: p });
      await assert.rejects(a.crear(null), (e: unknown) => e instanceof ErrorSpd && e.codigo === cod);
      assert.equal(a.existe(), false); assert.deepEqual(readdirSync(dir), []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('protectorDeSafeStorage: round trip, no disponible, Linux sin almacén real', () => {
  const ss = { isEncryptionAvailable: () => true, encryptString: (t: string) => Buffer.from('X' + t), decryptString: (b: Uint8Array) => Buffer.from(b).toString().slice(1) };
  const p = protectorDeSafeStorage(ss, 'win32');
  const clave = new Uint8Array(32).map((_, i) => i * 7);
  assert.equal(p.disponible(), true);
  assert.deepEqual(p.descifrar(p.cifrar(clave)), clave);
  assert.equal(protectorDeSafeStorage({ ...ss, isEncryptionAvailable: () => false }, 'win32').disponible(), false);
  assert.throws(() => protectorDeSafeStorage({ ...ss, isEncryptionAvailable: () => false }, 'win32').cifrar(clave));
  assert.equal(protectorDeSafeStorage({ ...ss, getSelectedStorageBackend: () => 'basic_text' }, 'linux').disponible(), false);
  assert.equal(protectorDeSafeStorage({ ...ss, getSelectedStorageBackend: () => 'gnome_libsecret' }, 'linux').disponible(), true);
  assert.equal(protectorDeSafeStorage(null).disponible(), false);
  assert.match(protectorDeSafeStorage(null).motivoNoDisponible(), /almacén de claves/);
});

// ───────────────────────────── primer uso sin contraseña ─────────────────────────────

test('primer uso sin contraseña: exige reconocer el riesgo y un protector; clave de recuperación igual; reabre sin pedir nada', async () => {
  const e = entorno();
  try {
    mal(await e.s.api.primerUso({ ...SIN, reconoceRiesgoSinContrasena: false }), 'RIESGO_NO_RECONOCIDO');
    mal(await e.s.api.primerUso({ ...SIN, contrasena: PASS }), 'PRIMER_USO_INVALIDO');
    assert.equal(existsSync(join(e.dir, 'datos', 'spd.datos')), false);
    const r = ok(await e.s.api.primerUso(SIN));
    assert.match(r.claveRecuperacion, /^[A-Z2-7]{4}(-[A-Z2-7]{4})+/);
    assert.equal(fichero(e)[8], 2);
    const st = ok(await e.s.api.estado());
    assert.equal(st.modoAcceso, 'sistema'); assert.equal(st.accesoSistemaDisponible, true);
    // la clave de recuperación abre el fichero
    abrirConClaveDeDatos(fichero(e), claveDesdeTexto(r.claveRecuperacion));
    await e.s.cerrar();
    const s2 = e.abrir();
    const antes = ok(await s2.api.estado());
    assert.deepEqual([antes.inicializado, antes.desbloqueado, antes.modoAcceso, antes.esperaIntento], [true, false, 'sistema', 0]);
    const d = ok(await s2.api.desbloquearConSistema());
    assert.equal(d.desbloqueado, true);
    assert.equal(ok(await s2.api.obtenerFarmacia()).nombre, 'Farmacia Luz del Sur');
    assert.ok((await auditoria(e)).some(a => a.entidad === 'acceso' && /SIN contraseña/.test(a.motivo ?? '')));
  } finally { await e.fin(); }
});

test('primer uso sin contraseña sin protector: se rechaza con el motivo y no se crea nada', async () => {
  const e = entorno(null);
  try {
    const m = mal(await e.s.api.primerUso(SIN), 'PROTECTOR_NO_DISPONIBLE');
    assert.match(m.error, /almacén de claves/);
    const st = ok(await e.s.api.estado());
    assert.equal(st.accesoSistemaDisponible, false); assert.match(st.motivoSistemaNoDisponible ?? '', /almacén de claves/);
    assert.equal(st.inicializado, false);
    ok(await e.s.api.primerUso(PRIMER_USO));   // con contraseña sigue funcionando sin protector
  } finally { await e.fin(); }
});

// ───────────────────────────── ida y vuelta ─────────────────────────────

async function conContrasenaYDatos() {
  const e = entorno();
  const r = ok(await e.s.api.primerUso(PRIMER_USO));
  ok(await e.s.api.guardarAjustes({ carpetaCopias: e.copias }));
  ok(await e.s.api.crearUsuario({ nombre: 'Lucía Pérez', iniciales: 'LP', rol: 'farmaceutico', pin: '7777' }));
  return { e, claveInicial: r.claveRecuperacion };
}

test('contraseña → sin contraseña: pide la contraseña, motivo y confirmación; copia previa; no rota la clave; datos intactos; auditado', async () => {
  const { e, claveInicial } = await conContrasenaYDatos();
  try {
    mal(await e.s.api.quitarContrasenaArranque('contraseña-equivocada', MOTIVO, true), 'CONTRASENA_INCORRECTA');
    assert.ok(ok(await e.s.api.estado()).esperaIntento > 0, 'en modo contraseña un fallo cuenta');
    mal(await e.s.api.quitarContrasenaArranque(PASS, MOTIVO, true), 'ESPERA_ACTIVA');
    e.reloj.t += 120_000;
    mal(await e.s.api.quitarContrasenaArranque(PASS, 'ya', true), 'MOTIVO_OBLIGATORIO');
    mal(await e.s.api.quitarContrasenaArranque(PASS, MOTIVO, false), 'RIESGO_NO_RECONOCIDO');
    assert.equal(fichero(e)[8], 1, 'nada cambió con los intentos rechazados');
    const st = ok(await e.s.api.quitarContrasenaArranque(PASS, MOTIVO, true));
    assert.equal(st.modoAcceso, 'sistema'); assert.equal(st.esperaIntento, 0);
    assert.equal(fichero(e)[8], 2); assert.equal(tipoDeEnvoltura(readFileSync(join(e.dir, 'datos', 'spd.datos.bak'))), 'sistema', 'la .bak también');
    // copia previa EN MODO CONTRASEÑA, auditada
    const copia = readdirSync(e.copias).find(n => n.endsWith('.datos'))!;
    assert.ok(copia); assert.equal(tipoDeEnvoltura(readFileSync(join(e.copias, copia))), 'contrasena');
    assert.equal(abrirConContrasena(readFileSync(join(e.copias, copia)), PASS).bytesDb.length > 1000, true);
    const au = await auditoria(e);
    assert.ok(au.some(a => a.entidad === 'acceso' && a.motivo?.includes(MOTIVO) && a.motivo.includes('Copia previa')));
    // la clave de recuperación de siempre sigue abriendo
    abrirConClaveDeDatos(fichero(e), claveDesdeTexto(claveInicial));
    // reabrir: sin contraseña, mismos datos, sin aviso de marcha atrás
    await e.s.cerrar();
    const s2 = e.abrir();
    const d = ok(await s2.api.desbloquearConSistema());
    assert.equal(d.avisoSeguridad, undefined);
    assert.deepEqual(ok(await s2.api.listarUsuarios()).map(u => u.nombre), ['Marta Etxeberria', 'Lucía Pérez']);
    // una contraseña ya no abre nada, pero desbloquear() abre igualmente por el sistema (no hay contraseña)
    await s2.cerrar();
    assert.equal(ok(await e.abrir().api.desbloquear('lo-que-sea')).desbloqueado, true);
  } finally { await e.fin(); }
});

test('quitar la contraseña: sin carpeta de copias, sin protector o sin ser titular NO cambia nada', async () => {
  const e = entorno();
  try {
    ok(await e.s.api.primerUso(PRIMER_USO));
    // (carpetaCopiasPorDefecto del entorno sirve para «seguridad», así que se quita para este caso)
    const sin = crearSistema({ rutaDatos: join(e.dir, 'datos'), kdf: KDF, protector: doble() });
    await e.s.cerrar();
    ok(await sin.api.desbloquear(PASS)); ok(await sin.api.iniciarSesion(1, PIN));
    mal(await sin.api.quitarContrasenaArranque(PASS, MOTIVO, true), 'SIN_CARPETA_COPIAS');
    assert.equal(fichero(e)[8], 1);
    await sin.cerrar();
    // sin protector
    const np = crearSistema({ rutaDatos: join(e.dir, 'datos'), kdf: KDF, carpetaCopiasPorDefecto: e.copias });
    ok(await np.api.desbloquear(PASS)); ok(await np.api.iniciarSesion(1, PIN));
    mal(await np.api.quitarContrasenaArranque(PASS, MOTIVO, true), 'PROTECTOR_NO_DISPONIBLE');
    // protector que cifra pero no recupera: se detecta ANTES de escribir
    await np.cerrar();
    const roto = crearSistema({ rutaDatos: join(e.dir, 'datos'), kdf: KDF, carpetaCopiasPorDefecto: e.copias, protector: doble('a', { rompeAlDescifrar: true }) });
    ok(await roto.api.desbloquear(PASS)); ok(await roto.api.iniciarSesion(1, PIN));
    mal(await roto.api.quitarContrasenaArranque(PASS, MOTIVO, true), 'PROTECTOR_NO_DISPONIBLE');
    assert.equal(fichero(e)[8], 1); assert.equal(abrirConContrasena(fichero(e), PASS).bytesDb.length > 100, true);
    // sin ser titular
    ok(await roto.api.crearUsuario({ nombre: 'Farma', iniciales: 'FA', rol: 'farmaceutico', pin: '1357' }));
    ok(await roto.api.cerrarSesion()); ok(await roto.api.iniciarSesion(2, '1357'));
    mal(await roto.api.quitarContrasenaArranque(PASS, MOTIVO, true), 'SIN_PERMISO');
    await roto.cerrar();
  } finally { await e.fin(); }
});

test('sin contraseña → contraseña: ROTA la clave de datos, exige contraseña válida y motivo, y los datos se conservan', async () => {
  const { e, claveInicial } = await conContrasenaYDatos();
  try {
    ok(await e.s.api.quitarContrasenaArranque(PASS, MOTIVO, true));
    mal(await e.s.api.cambiarContrasena(PASS, 'otra-contraseña-77'), 'SIN_CONTRASENA');
    mal(await e.s.api.ponerContrasenaArranque('corta', MOTIVO), 'CONTRASENA_DEBIL');
    mal(await e.s.api.ponerContrasenaArranque('otra-contraseña-77', 'x'), 'MOTIVO_OBLIGATORIO');
    assert.equal(fichero(e)[8], 2);
    const antesFichero = fichero(e);
    const r = ok(await e.s.api.ponerContrasenaArranque('otra-contraseña-77', 'Se comparte el equipo'));
    assert.notEqual(r.claveRecuperacion, claveInicial, 'clave de recuperación nueva');
    assert.equal(fichero(e)[8], 1);
    assert.equal(codigo(() => abrirConClaveDeDatos(fichero(e), claveDesdeTexto(claveInicial))), 'FICHERO_CORRUPTO', 'la clave anterior ya no abre el fichero actual');
    abrirConClaveDeDatos(fichero(e), claveDesdeTexto(r.claveRecuperacion));
    assert.notDeepEqual(antesFichero, fichero(e));
    // la copia previa (modo sistema) existe y abre con la clave de recuperación de entonces
    assert.ok(readdirSync(e.copias).filter(n => n.endsWith('.datos')).length >= 2);
    await e.s.cerrar();
    const s2 = e.abrir();
    mal(await s2.api.desbloquear(PASS), 'CONTRASENA_INCORRECTA');
    assert.ok(ok(await s2.api.estado()).esperaIntento > 0, 'los intentos vuelven a limitarse');
    assert.equal(ok(await s2.api.estado()).modoAcceso, 'contrasena');
  } finally { await e.fin(); }
});

test('ida y vuelta completa conserva los datos y el fichero de estado (sin aviso de marcha atrás) en los dos modos', async () => {
  const { e } = await conContrasenaYDatos();
  try {
    ok(await e.s.api.quitarContrasenaArranque(PASS, MOTIVO, true));
    ok(await e.s.api.ponerContrasenaArranque('otra-contraseña-77', 'Se comparte el equipo'));
    ok(await e.s.api.crearUsuario({ nombre: 'Después', iniciales: 'DE', rol: 'tecnico', pin: '2468' }));
    await e.s.cerrar();
    const s2 = e.abrir();
    const d = ok(await s2.api.desbloquear('otra-contraseña-77'));
    assert.equal(d.avisoSeguridad, undefined);
    assert.deepEqual(ok(await s2.api.listarUsuarios()).map(u => u.nombre), ['Marta Etxeberria', 'Lucía Pérez', 'Después']);
    const modos = (await auditoria(e)).filter(a => a.entidad === 'acceso').length;
    assert.equal(modos, 2);
  } finally { await e.fin(); }
});

// ───────────────────────────── límites, rollback, protector que falla ─────────────────────────────

test('límite de intentos: sólo existe en modo contraseña; el fallo del sistema no espera ni acumula', async () => {
  const e = entorno();
  try {
    ok(await e.s.api.primerUso(SIN));
    await e.s.cerrar();
    const otro = e.abrir(doble('luis'));
    for (let i = 0; i < 4; i++) {
      mal(await otro.api.desbloquearConSistema(), 'CLAVE_SISTEMA_ILEGIBLE');
      assert.equal(ok(await otro.api.estado()).esperaIntento, 0);
    }
    assert.equal(ok(await otro.api.estado()).desbloqueado, false);
  } finally { await e.fin(); }
  const c = entorno();
  try {
    ok(await c.s.api.primerUso(PRIMER_USO)); await c.s.cerrar();
    const s = c.abrir();
    mal(await s.api.desbloquear('mala-contraseña-1'), 'CONTRASENA_INCORRECTA');
    mal(await s.api.desbloquear(PASS), 'ESPERA_ACTIVA');
  } finally { await c.fin(); }
});

test('otro usuario de Windows: se explica y la clave de recuperación vuelve a ligar los datos SIN contraseña (sin perder nada)', async () => {
  const e = entorno();
  try {
    const r = ok(await e.s.api.primerUso(SIN));
    ok(await e.s.api.guardarAjustes({ carpetaCopias: e.copias }));
    ok(await e.s.api.crearUsuario({ nombre: 'Lucía Pérez', iniciales: 'LP', rol: 'farmaceutico', pin: '7777' }));
    await e.s.cerrar();
    const luis = e.abrir(doble('luis'));
    const m = mal(await luis.api.desbloquearConSistema(), 'CLAVE_SISTEMA_ILEGIBLE');
    assert.match(m.error, /clave de recuperación/);
    mal(await luis.api.recuperar('AAAA-AAAA-AAAA', undefined), 'CLAVE_RECUPERACION_INVALIDA');
    ok(await luis.api.recuperar(r.claveRecuperacion));   // sin contraseña nueva
    assert.equal(ok(await luis.api.estado()).modoAcceso, 'sistema');
    assert.equal(ok(await luis.api.listarUsuarios()).length, 2);
    await luis.cerrar();
    // ahora lo abre luis y ya no ana
    mal(await e.abrir(doble('ana')).api.desbloquearConSistema(), 'CLAVE_SISTEMA_ILEGIBLE');
    ok(await e.abrir(doble('luis')).api.desbloquearConSistema());
    // en modo sistema, recuperar con contraseña nueva pasa a modo contraseña
    await e.s.cerrar();
    const l2 = e.abrir(doble('maria'));
    mal(await l2.api.recuperar(r.claveRecuperacion, 'corta'), 'CONTRASENA_DEBIL');
    ok(await l2.api.recuperar(r.claveRecuperacion, 'una-contraseña-larga-88'));
    assert.equal(ok(await l2.api.estado()).modoAcceso, 'contrasena');
  } finally { await e.fin(); }
});

test('copia hecha sin contraseña: en OTRO usuario de Windows sólo se restaura con la clave de recuperación, y se dice', async () => {
  const e = entorno();
  try {
    const r = ok(await e.s.api.primerUso(SIN));
    ok(await e.s.api.guardarAjustes({ carpetaCopias: e.copias }));
    const nombre = ok(await e.s.api.crearCopia()).ruta.split(/[\\/]/).pop()!;
    ok(await e.s.api.crearUsuario({ nombre: 'Posterior', iniciales: 'PO', rol: 'tecnico', pin: '2468' }));
    await e.s.cerrar();
    const luis = e.abrir(doble('luis'));
    ok(await luis.api.recuperar(r.claveRecuperacion));
    ok(await luis.api.iniciarSesion(1, PIN));
    const sinClave = mal(await luis.api.restaurarCopia(nombre, '', undefined), 'COPIA_SISTEMA_AJENA');
    assert.match(sinClave.error, /clave de recuperación/);
    mal(await luis.api.restaurarCopia(nombre, '', 'AAAA-AAAA'), 'COPIA_SISTEMA_AJENA');
    const rr = ok(await luis.api.restaurarCopia(nombre, '', r.claveRecuperacion));
    assert.match(rr.aviso, /restaurada/i);
    assert.equal(tipoDeEnvoltura(fichero(e)), 'sistema', 'el fichero actual sigue en modo sistema, ligado a luis');
    assert.deepEqual(ok(await luis.api.listarUsuarios()).map(u => u.nombre), ['Marta Etxeberria']);
    // y en el mismo usuario de Windows basta con el sistema (sin teclear nada)
    ok(await luis.api.iniciarSesion(1, PIN));
    const n2 = ok(await luis.api.crearCopia()).ruta.split(/[\\/]/).pop()!;
    ok(await luis.api.restaurarCopia(n2, '', undefined));
  } finally { await e.fin(); }
});

test('marcha atrás: restaurar a mano un fichero antiguo en modo sistema se detecta (fichero de estado firmado con la clave de datos)', async () => {
  const e = entorno();
  try {
    ok(await e.s.api.primerUso(SIN));
    await e.s.cerrar();
    const viejo = fichero(e);
    const s2 = e.abrir(); ok(await s2.api.desbloquearConSistema());
    for (let i = 0; i < 3; i++) { ok(await s2.api.iniciarSesion(1, PIN)); ok(await s2.api.cerrarSesion()); }
    await s2.cerrar();
    writeFileSync(join(e.dir, 'datos', 'spd.datos'), viejo);
    const s3 = e.abrir();
    const d = ok(await s3.api.desbloquearConSistema());
    assert.match(d.avisoSeguridad ?? '', /MÁS ANTIGUOS|no coincide/);
    assert.ok((await auditoria(e)).some(a => a.accion === 'alerta_seguridad'));
  } finally { await e.fin(); }
});

test('bloquear: con contraseña cierra los datos; sin contraseña sólo cierra la sesión (y por inactividad igual)', async () => {
  const e = entorno();
  try {
    ok(await e.s.api.primerUso(SIN));
    const b = ok(await e.s.api.bloquear());
    assert.deepEqual([b.desbloqueado, b.sesion], [true, null]);
    ok(await e.s.api.iniciarSesion(1, PIN));
    const bi = ok(await e.s.bloquearPorInactividad());
    assert.deepEqual([bi.desbloqueado, bi.sesion], [true, null]);
    assert.ok((await auditoria(e)).some(a => a.accion === 'bloquear'));
    await e.s.cerrar();   // cerrar el programa SÍ lo cierra todo
    assert.equal(e.s.estaDesbloqueado(), false);
  } finally { await e.fin(); }
  const c = entorno();
  try {
    ok(await c.s.api.primerUso(PRIMER_USO));
    assert.equal(ok(await c.s.api.bloquear()).desbloqueado, false);
  } finally { await c.fin(); }
});

// ───────────────────────────── PIN y elegir usuario ─────────────────────────────

test('pedir PIN: sólo el titular y con motivo; sin PIN se entra eligiendo usuario y queda auditado; con PIN el PIN sigue siendo obligatorio', async () => {
  const { e } = await conContrasenaYDatos();
  try {
    mal(await e.s.api.iniciarSesion(2), 'PIN_INCORRECTO');
    ok(await e.s.api.cerrarSesion()); ok(await e.s.api.iniciarSesion(2, '7777'));
    mal(await e.s.api.guardarAjustes({ pedirPin: false, motivo: MOTIVO }), 'SIN_PERMISO');
    ok(await e.s.api.cerrarSesion()); ok(await e.s.api.iniciarSesion(1, PIN));
    mal(await e.s.api.guardarAjustes({ pedirPin: false }), 'MOTIVO_OBLIGATORIO');
    assert.equal(ok(await e.s.api.guardarAjustes({ pedirPin: false, motivo: MOTIVO })).pedirPin, false);
    ok(await e.s.api.cerrarSesion());
    assert.equal(ok(await e.s.api.iniciarSesion(2)).nombre, 'Lucía Pérez');
    assert.ok((await auditoria(e)).some(a => a.accion === 'login' && /sin PIN/.test(a.motivo ?? '')));
    mal(await e.s.api.iniciarSesion(99), 'USUARIO_NO_ENCONTRADO');
    // reactivar
    ok(await e.s.api.cerrarSesion()); ok(await e.s.api.iniciarSesion(1));
    ok(await e.s.api.guardarAjustes({ pedirPin: true, motivo: 'Vuelve a haber más gente' }));
    ok(await e.s.api.cerrarSesion());
    mal(await e.s.api.iniciarSesion(2, 'mal'), 'PIN_INCORRECTO');
    mal(await e.s.api.iniciarSesion(2), 'PIN_INCORRECTO');
  } finally { await e.fin(); }
});

test('no pedir usuario al arrancar: exige PIN desactivado y un usuario predeterminado; entra solo al ABRIR, no tras bloquear', async () => {
  const e = entorno();
  try {
    ok(await e.s.api.primerUso(SIN));
    ok(await e.s.api.crearUsuario({ nombre: 'Lucía Pérez', iniciales: 'LP', rol: 'farmaceutico', pin: '7777' }));
    mal(await e.s.api.guardarAjustes({ pedirUsuarioAlArrancar: false, motivo: MOTIVO }), 'AJUSTE_INCOHERENTE');   // el PIN sigue activo
    mal(await e.s.api.guardarAjustes({ pedirPin: false, pedirUsuarioAlArrancar: false, motivo: MOTIVO }), 'AJUSTE_INVALIDO');   // falta usuario
    mal(await e.s.api.guardarAjustes({ pedirPin: false, pedirUsuarioAlArrancar: false, usuarioPredeterminadoId: 77, motivo: MOTIVO }), 'AJUSTE_INVALIDO');
    mal(await e.s.api.guardarAjustes({ pedirPin: true, pedirUsuarioAlArrancar: false, usuarioPredeterminadoId: 2, motivo: MOTIVO }), 'AJUSTE_INCOHERENTE');
    const a = ok(await e.s.api.guardarAjustes({ pedirPin: false, pedirUsuarioAlArrancar: false, usuarioPredeterminadoId: 2, motivo: MOTIVO }));
    assert.deepEqual([a.pedirPin, a.pedirUsuarioAlArrancar, a.usuarioPredeterminadoId], [false, false, 2]);
    // activar el PIN con el arranque automático puesto es incoherente
    mal(await e.s.api.guardarAjustes({ pedirPin: true, motivo: MOTIVO }), 'AJUSTE_INCOHERENTE');
    await e.s.cerrar();
    const s2 = e.abrir();
    const d = ok(await s2.api.desbloquearConSistema());
    assert.equal(d.sesion?.nombre, 'Lucía Pérez', 'entra el usuario predeterminado');
    assert.ok((await auditoria(e)).some(x => x.accion === 'login' && /Inicio automático/.test(x.motivo ?? '')));
    const b = ok(await s2.api.bloquear());
    assert.equal(b.sesion, null, 'tras bloquear se vuelve a elegir usuario');
  } finally { await e.fin(); }
});

// ───────────────────────────── validar sin PIN ─────────────────────────────

async function conPreparacion() {
  const e = entorno();
  ok(await e.s.api.primerUso(PRIMER_USO));
  ok(await e.s.api.guardarAjustes({ exigirConsentimientos: false, motivo: 'Consentimientos gestionados fuera del programa' }));
  const farma = ok(await e.s.api.crearUsuario({ nombre: 'Lucía Pérez', iniciales: 'LP', rol: 'farmaceutico', pin: '7777' }));
  const tec = ok(await e.s.api.crearUsuario({ nombre: 'Tomás Técnico', iniciales: 'TT', rol: 'tecnico', pin: '8888' }));
  const db = e.s.ctx.db();
  db.run("INSERT INTO paciente(id,id_publico,nombre,apellido1,dni_nie,fecha_nacimiento,direccion,municipio,estado) VALUES (1,'aaaaaaaa-0000-4000-8000-000000000001','Ana','Prueba','12345671Z','1940-01-01','Calle Luna 2','Sevilla','activo')");
  db.run("INSERT INTO medicamento(cn,nombre,descripcion_fisica,descripcion_estado,descripcion_confirmada_por) VALUES ('654321','Metformina Test 850 mg 28 comp','comprimido blanco, oblongo','confirmada',?)", [farma.id]);
  db.run("INSERT INTO tratamiento(id, paciente_id, principio_activo, dosis_texto, cn_preferente, emblistable) VALUES (1,1,'Metformina','850 mg','654321',1)");
  const pv = db.run("INSERT INTO pauta_version(tratamiento_id, version, vigente_desde, vigente_hasta, patron, origen, creado_por) VALUES (1,1,'2026-01-01',NULL,'diario','receta',?)", [farma.id]).ultimoId;
  db.run('INSERT INTO pauta_dosis(pauta_version_id, momento_id, unidades) VALUES (?,1,1)', [pv]);
  db.run("INSERT INTO envase(paciente_id, tratamiento_id, cn, lote, caducidad, origen_lectura, unidades_inicio, unidades_restantes, recibido_por) VALUES (1,1,'654321','MET1','2028-05-31','manual',28,28,?)", [farma.id]);
  const prep = crearClinicaPreparacion(e.s.ctx);
  ok(await prep.listarPlantillasDocumento());
  const p = ok(await prep.marcarPreparada(ok(await prep.crearPreparacion({ pacienteId: 1, desde: '2026-11-03', dias: 7, fechaPreparacion: '2026-11-02' })).id));
  return { e, prep, farma, tec, p };
}

test('validar sin PIN: hay que elegir a un farmacéutico/titular; no vale «nadie», un técnico ni un usuario inexistente; la validación y la auditoría quedan a su nombre', async () => {
  const { e, prep, farma, tec, p } = await conPreparacion();
  try {
    // entra el técnico (sin PIN no hay forma de saber quién es: se elige) y quiere validar
    ok(await e.s.api.guardarAjustes({ pedirPin: false, motivo: MOTIVO }));
    ok(await e.s.api.cerrarSesion()); ok(await e.s.api.iniciarSesion(tec.id));
    mal(await prep.validarPreparacion(p.id), 'VALIDADOR_REQUERIDO');
    mal(await prep.validarPreparacion(p.id, { validadorId: tec.id }), 'ROL_NO_PUEDE_VALIDAR');
    mal(await prep.validarPreparacion(p.id, { validadorId: 999 }), 'USUARIO_NO_ENCONTRADO');
    assert.equal(ok(await prep.obtenerPreparacion(p.id)).preparacion.estado, 'preparado');
    const v = ok(await prep.validarPreparacion(p.id, { validadorId: farma.id }));
    assert.equal(v.estado, 'validado'); assert.equal(v.validadoPor, 'Lucía Pérez');
    const fila = e.s.ctx.db().get<{ usuario_id: number; motivo: string }>("SELECT usuario_id, motivo FROM auditoria WHERE accion = 'validar' ORDER BY id DESC LIMIT 1")!;
    assert.equal(fila.usuario_id, farma.id, 'la auditoría guarda al validador, no al de la sesión');
    assert.match(fila.motivo, /sin PIN.*Tomás Técnico/);
    const consumo = e.s.ctx.db().get<{ usuario_id: number }>("SELECT usuario_id FROM auditoria WHERE accion = 'modificar' AND entidad = 'envase' ORDER BY id DESC LIMIT 1")!;
    assert.equal(consumo.usuario_id, farma.id);
  } finally { await e.fin(); }
});

test('validar con PIN: valida la sesión abierta y un validadorId que se cuele se ignora', async () => {
  const { e, prep, farma, tec, p } = await conPreparacion();
  try {
    ok(await e.s.api.cerrarSesion()); ok(await e.s.api.iniciarSesion(tec.id, '8888'));
    mal(await prep.validarPreparacion(p.id, { validadorId: farma.id }), 'ROL_NO_PUEDE_VALIDAR');   // el técnico no puede hacerse pasar por la farmacéutica
    ok(await e.s.api.cerrarSesion()); ok(await e.s.api.iniciarSesion(farma.id, '7777'));
    const v = ok(await prep.validarPreparacion(p.id, { validadorId: 1 }));
    assert.equal(v.validadoPor, 'Lucía Pérez');
  } finally { await e.fin(); }
});
