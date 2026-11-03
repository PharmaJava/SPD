import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearSistema } from '../src/servicios/sistema.ts';
import type { PrimerUso, Resultado } from '../src/servicios/api.ts';
import { ErrorSpd } from '../src/servicios/contexto.ts';
import { abrirConClaveDeDatos, abrirConContrasena, crearAlmacenNuevo, kdfPorMigrar, KDF_POR_DEFECTO, hashPin, verificarPin } from '../src/servicios/seguridad.ts';
import { claveDesdeTexto } from '../src/dominio/clave-recuperacion.ts';
import { estadoDeCopias, listarCopias, rotarCopias, nombreCopia } from '../src/servicios/copias.ts';
import { esPeticionImpresionPermitida } from '../src/principal/seguridad-ventana.ts';
import { crearExterno } from '../src/principal/externo.ts';
import type { DepsExterno } from '../src/principal/externo.ts';
import { crearContextoPruebas } from './ayudas/contexto-pruebas.ts';
import { listarPacientes } from '../src/servicios/clinica/pacientes.ts';
import { leerEfimero, guardarEfimero, limpiarEfimero } from '../src/interfaz/lib/efimero.ts';

const KDF = { n: 1 << 10, r: 8, p: 1 };
const PASS = 'contraseña-farmacia', PIN = '4821';
const PRIMER_USO: PrimerUso = {
  farmacia: { nombre: 'Farmacia Luz', titular: 'Marta' }, titular: { nombre: 'Marta', iniciales: 'M', pin: PIN }, contrasena: PASS, momentos: [{ nombre: 'Desayuno', hora: '08:00' }],
};
const ok = <T,>(r: Resultado<T>): T => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { ok: true; datos: T }).datos; };
const cod = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof ErrorSpd ? e.codigo : 'OTRO:' + e; } return 'SIN_ERROR'; };

async function entorno() {
  const dir = mkdtempSync(join(tmpdir(), 'spd-end-'));
  const copias = join(dir, 'copias');
  let t = Date.parse('2026-11-02T09:00:00Z');
  const crear = () => crearSistema({ rutaDatos: join(dir, 'datos'), ahora: () => new Date(t), kdf: KDF, debounceMs: 60_000, carpetaCopiasPorDefecto: join(dir, 'defecto') });
  const s = crear();
  const uso = ok(await s.api.primerUso(PRIMER_USO));
  ok(await s.api.guardarAjustes({ carpetaCopias: copias }));
  ok(await s.api.iniciarSesion(ok(await s.api.listarUsuarios())[0].id, PIN));
  return { dir, copias, s, crear, uso, avanzar: (ms = 60_000) => { t += ms; }, fin: async () => { await s.cerrar(); rmSync(dir, { recursive: true, force: true }); } };
}

// ───── 2: cambiar la contraseña rota la clave de datos ─────
test('cambiar la contraseña ROTA la clave de datos: la clave de recuperación de antes ya no abre el fichero ni la .bak', async () => {
  const e = await entorno();
  try {
    const claveVieja = claveDesdeTexto(e.uso.claveRecuperacion);
    const r = ok(await e.s.api.cambiarContrasena(PASS, 'contraseña-NUEVA-9'));
    assert.notEqual(r.claveRecuperacion, e.uso.claveRecuperacion);
    const claveNueva = claveDesdeTexto(r.claveRecuperacion);
    await e.s.guardarAhora();
    for (const f of ['spd.datos', 'spd.datos.bak']) {
      const bytes = new Uint8Array(readFileSync(join(e.dir, 'datos', f)));
      assert.equal(cod(() => abrirConClaveDeDatos(bytes, claveVieja)), 'FICHERO_CORRUPTO', f + ' no debe abrir con la clave vieja');
      assert.equal(cod(() => abrirConContrasena(bytes, PASS)), 'CONTRASENA_INCORRECTA', f + ' no debe abrir con la contraseña vieja');
      abrirConClaveDeDatos(bytes, claveNueva); abrirConContrasena(bytes, 'contraseña-NUEVA-9');
    }
    // La clave nueva recupera de verdad.
    ok(await e.s.api.bloquear());
    ok(await e.s.api.recuperar(r.claveRecuperacion, 'otra-contraseña-77'));
    ok(await e.s.api.bloquear()); e.avanzar(600_000);
    ok(await e.s.api.desbloquear('otra-contraseña-77'));
  } finally { await e.fin(); }
});

test('copia anterior al cambio: se restaura con SU contraseña (o su clave de recuperación) y queda recifrada con la clave actual', async () => {
  const e = await entorno();
  try {
    ok(await e.s.api.crearUsuario({ nombre: 'Ana', iniciales: 'A', rol: 'tecnico', pin: '1111' }));
    ok(await e.s.api.crearCopia());
    const nombre = ok(await e.s.api.listarCopias())[0].nombre;
    const r = ok(await e.s.api.cambiarContrasena(PASS, 'contraseña-NUEVA-9'));
    e.avanzar();
    // con la clave de recuperación de entonces
    const res = ok(await e.s.api.restaurarCopia(nombre, 'contraseña-NUEVA-9', e.uso.claveRecuperacion));
    assert.match(res.aviso, /restaurada/i);
    ok(await e.s.api.iniciarSesion(ok(await e.s.api.listarUsuarios())[0].id, PIN));
    assert.ok(ok(await e.s.api.listarAuditoria({ entidad: 'copia' })).some(a => /otra clave de datos/.test(a.motivo ?? '')));
    await e.s.guardarAhora();
    // tras restaurar manda la contraseña y la clave de recuperación ACTUALES
    const bytes = new Uint8Array(readFileSync(join(e.dir, 'datos', 'spd.datos')));
    abrirConContrasena(bytes, 'contraseña-NUEVA-9'); abrirConClaveDeDatos(bytes, claveDesdeTexto(r.claveRecuperacion));
    assert.equal(cod(() => abrirConClaveDeDatos(bytes, claveDesdeTexto(e.uso.claveRecuperacion))), 'FICHERO_CORRUPTO');
  } finally { await e.fin(); }
});

// ───── 3: marcha atrás ─────
test('marcha atrás: poner un fichero de datos antiguo avisa al desbloquear y queda auditado; una restauración legítima no avisa', async () => {
  const e = await entorno();
  try {
    const datos = join(e.dir, 'datos');
    await e.s.guardarAhora();
    const viejo = readFileSync(join(datos, 'spd.datos'));
    ok(await e.s.api.crearUsuario({ nombre: 'Ana', iniciales: 'A', rol: 'tecnico', pin: '1111' }));
    ok(await e.s.api.bloquear()); e.avanzar(600_000);
    assert.ok(existsSync(join(datos, 'spd.estado')));
    // sin manipular: sin aviso
    let est = ok(await e.s.api.desbloquear(PASS));
    assert.equal(est.avisoSeguridad, undefined);
    ok(await e.s.api.bloquear());
    // alguien pone el fichero viejo (y borra la .bak)
    writeFileSync(join(datos, 'spd.datos'), viejo); rmSync(join(datos, 'spd.datos.bak'), { force: true });
    e.avanzar(600_000);
    est = ok(await e.s.api.desbloquear(PASS));
    assert.match(est.avisoSeguridad ?? '', /más antiguos/i);
    ok(await e.s.api.iniciarSesion(ok(await e.s.api.listarUsuarios())[0].id, PIN));
    assert.ok(ok(await e.s.api.listarAuditoria({ entidad: 'sistema' })).some(a => a.accion === 'alerta_seguridad'));
    // se avisa una vez: el siguiente desbloqueo ya no
    ok(await e.s.api.bloquear()); e.avanzar(600_000);
    assert.equal(ok(await e.s.api.desbloquear(PASS)).avisoSeguridad, undefined);
  } finally { await e.fin(); }
});

test('marcha atrás: el fichero de estado manipulado se detecta (firma HMAC) y una restauración desde Ajustes no dispara el aviso', async () => {
  const e = await entorno();
  try {
    ok(await e.s.api.crearUsuario({ nombre: 'Ana', iniciales: 'A', rol: 'tecnico', pin: '1111' }));
    ok(await e.s.api.crearCopia());
    const nombre = ok(await e.s.api.listarCopias())[0].nombre;
    e.avanzar(); ok(await e.s.api.crearUsuario({ nombre: 'Berta', iniciales: 'B', rol: 'tecnico', pin: '2222' }));
    e.avanzar(); ok(await e.s.api.restaurarCopia(nombre, PASS));
    ok(await e.s.api.bloquear()); e.avanzar(600_000);
    assert.equal(ok(await e.s.api.desbloquear(PASS)).avisoSeguridad, undefined);   // restauración legítima: sin falsa alarma
    ok(await e.s.api.bloquear());
    const ruta = join(e.dir, 'datos', 'spd.estado');
    const j = JSON.parse(readFileSync(ruta, 'utf8')); j.contador = 1;               // intenta «rebajar» el contador sin la clave
    writeFileSync(ruta, JSON.stringify(j));
    e.avanzar(600_000);
    assert.match(ok(await e.s.api.desbloquear(PASS)).avisoSeguridad ?? '', /fichero de estado/);
  } finally { await e.fin(); }
});

// ───── 4 y 13: scrypt ─────
test('scrypt: por defecto N=2^17; se leen los de N=2^15 y se migran al desbloquear; hash de PIN sigue funcionando', async () => {
  assert.equal(KDF_POR_DEFECTO.n, 1 << 17);
  const viejo = crearAlmacenNuevo('clave-vieja-1', new Uint8Array([1, 2, 3]), { n: 1 << 15, r: 8, p: 1 });
  assert.equal(abrirConContrasena(viejo.fichero, 'clave-vieja-1').bytesDb.length, 3);
  assert.equal(kdfPorMigrar(viejo.fichero), true);
  assert.equal(kdfPorMigrar(crearAlmacenNuevo('x', new Uint8Array([1]), KDF_POR_DEFECTO).fichero), false);
  assert.equal(verificarPin('1234', hashPin('1234')), true);
});

test('scrypt: al desbloquear con un fichero de N más bajo se rehace la envoltura (misma clave de datos)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spd-mig-'));
  try {
    const mk = (kdf: { n: number; r: number; p: number }) => crearSistema({ rutaDatos: join(dir, 'd'), kdf, debounceMs: 60_000 });
    const a = mk(KDF); ok(await a.api.primerUso(PRIMER_USO)); await a.cerrar();
    assert.equal(kdfPorMigrar(new Uint8Array(readFileSync(join(dir, 'd', 'spd.datos'))), { n: 1 << 11, r: 8, p: 1 }), true);
    const b = mk({ n: 1 << 11, r: 8, p: 1 }); ok(await b.api.desbloquear(PASS)); await b.cerrar();
    for (const f of ['spd.datos', 'spd.datos.bak']) assert.equal(kdfPorMigrar(new Uint8Array(readFileSync(join(dir, 'd', f))), { n: 1 << 11, r: 8, p: 1 }), false, f);
    const c = mk({ n: 1 << 11, r: 8, p: 1 }); ok(await c.api.desbloquear(PASS)); await c.cerrar();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function conCabecera(fichero: Uint8Array, cambiar: (k: Record<string, unknown>) => void): Uint8Array {
  const f = Buffer.from(fichero); const lon = f.readUInt32BE(9);
  const cab = JSON.parse(f.subarray(13, 13 + lon).toString('utf8')); cambiar(cab.kdf);
  const json = Buffer.from(JSON.stringify(cab)); const pre = Buffer.from(f.subarray(0, 13)); pre.writeUInt32BE(json.length, 9);
  return Buffer.concat([pre, json, f.subarray(13 + lon)]);
}

test('scrypt: parámetros hostiles (N>2^18, p>4, memoria fuera de tope) dan ErrorSpd claro, no un error interno', () => {
  const base = crearAlmacenNuevo('pw-larga-1', new Uint8Array([1]), KDF).fichero;
  for (const k of [{ n: 1 << 19 }, { n: 1 << 20 }, { p: 5 }, { n: 1 << 18, r: 32 }, { n: 1 << 18, r: 20 }, { r: 33 }, { n: 1000 }]) {
    const malo = conCabecera(base, kdf => Object.assign(kdf, k));
    assert.equal(cod(() => abrirConContrasena(malo, 'pw-larga-1')), 'FICHERO_CORRUPTO', JSON.stringify(k));
  }
  assert.equal(cod(() => abrirConContrasena(conCabecera(base, kdf => Object.assign(kdf, { n: 1 << 18, r: 8, p: 4 })), 'pw-larga-1')), 'CONTRASENA_INCORRECTA');  // dentro del techo: llega a descifrar
});

// ───── 6: copias ─────
test('copias: un nombre plantado con fecha futura o sin cabecera de SPD ni cuenta como «al día» ni desplaza a las buenas', () => {
  const c = mkdtempSync(join(tmpdir(), 'spd-pl-'));
  const CAB = Buffer.concat([Buffer.from('SPDDATOS', 'latin1'), Buffer.from([1]), Buffer.alloc(40)]);
  const hoy = new Date('2026-11-10T10:00:00Z');
  try {
    writeFileSync(join(c, 'spd-20990101-000000.datos'), CAB);                // futura
    writeFileSync(join(c, 'spd-20261109-120000.datos'), 'basura sin cabecera mágica de ningún tipo');   // reciente pero ajena
    writeFileSync(join(c, 'spd-20261101-100000.datos'), CAB);                // la única buena
    const e = estadoDeCopias(c, hoy);
    assert.equal(e.ultima, '2026-11-01T10:00:00.000Z'); assert.equal(e.total, 1);
    assert.equal(estadoDeCopias(c, new Date('2026-11-20T10:00:00Z')).atrasada, true);
    assert.equal(listarCopias(c, hoy).some(x => x.nombre.includes('2099')), false);
    // la rotación no borra la buena por culpa de la plantada del mismo día
    writeFileSync(join(c, 'spd-20261101-230000.datos'), 'plantada el mismo día, sin cabecera');
    assert.deepEqual(rotarCopias(c, undefined, hoy), []);
    assert.ok(existsSync(join(c, 'spd-20261101-100000.datos')) && existsSync(join(c, 'spd-20261101-230000.datos')));
    assert.equal(nombreCopia(new Date('2026-11-01T10:00:00Z')), 'spd-20261101-100000.datos');
  } finally { rmSync(c, { recursive: true, force: true }); }
});

// ───── 9/10: impresión ─────
test('impresión: la sesión de impresión sólo deja leer ficheros de SU carpeta (userData) y data:', () => {
  const base = process.platform === 'win32' ? 'C:\\Users\\u\\AppData\\Roaming\\SPD\\impresion-tmp' : '/home/u/.config/SPD/impresion-tmp';
  const url = (p: string) => new URL(p, 'file:///').href;
  const dentro = process.platform === 'win32' ? 'file:///C:/Users/u/AppData/Roaming/SPD/impresion-tmp/spd-impresion-a/documento.html' : 'file:///home/u/.config/SPD/impresion-tmp/spd-impresion-a/documento.html';
  assert.equal(esPeticionImpresionPermitida(dentro, base), true);
  assert.equal(esPeticionImpresionPermitida('data:image/svg+xml;base64,AAA', base), true);
  for (const mal of ['https://ejemplo.com/x', 'http://127.0.0.1/x', url('/etc/passwd'), url('/tmp/spd-impresion-a/documento.html'), dentro.replace('/spd-impresion-a/', '/../otra/'), 'ftp://x/y', 'blob:null/1']) {
    assert.equal(esPeticionImpresionPermitida(mal, base), false, mal);
  }
});

test('impresión: bloqueado, imprimirHtml y exportarPdf se rechazan sin tocar disco ni ventanas', async () => {
  let toques = 0;
  const deps: DepsExterno = {
    estaDesbloqueado: () => false,
    crearVentanaImpresion: () => { toques++; throw new Error('no debería'); },
    impresoras: async () => [], mostrarGuardar: async () => { toques++; return { cancelado: true }; }, mostrarCarpeta: async () => ({ cancelado: true }),
    carpetaDocumentos: () => '/d', fs: { crearCarpetaTemporal: async () => { toques++; return '/x'; }, escribir: async () => { toques++; }, borrarCarpeta: async () => {} }, unir: (...p) => p.join('/'),
  };
  const api = crearExterno(deps);
  for (const r of [await api.imprimirHtml('<p>x</p>', {}), await api.exportarPdf('<p>x</p>', 'a', {})]) { assert.equal(r.ok, false); assert.equal((r as { codigo?: string }).codigo, 'BLOQUEADO'); }
  assert.equal(toques, 0);
});

// ───── 7: auditoría de listados ─────
test('listarPacientes audita la consulta de listado una vez por sesión y minuto, sin el texto buscado', async () => {
  const c = await crearContextoPruebas('farmaceutico');
  const n = () => c.db.all("SELECT * FROM auditoria WHERE entidad = 'listado_pacientes'").length;
  await listarPacientes(c.ctx, {}); await listarPacientes(c.ctx, {}); await listarPacientes(c.ctx, { estado: 'todos' });
  assert.equal(n(), 1);
  await listarPacientes(c.ctx, { texto: 'García López' }); await listarPacientes(c.ctx, { texto: 'otra' });
  assert.equal(n(), 2);                                                    // la búsqueda es otro tipo
  assert.equal(c.db.all("SELECT * FROM auditoria WHERE entidad = 'listado_pacientes'").some(f => /Garc/.test(JSON.stringify(f))), false);
  c.reloj.fecha = new Date(c.reloj.fecha.getTime() + 61_000);
  await listarPacientes(c.ctx, {}); assert.equal(n(), 3);
  c.cambiarUsuario('titular'); await listarPacientes(c.ctx, {}); assert.equal(n(), 4);   // otra sesión
});

// ───── 1: nada de pacientes en localStorage ─────
test('la interfaz no guarda datos de pacientes en localStorage: sólo el aspecto, y todo lo demás se limpia al bloquear', () => {
  const leer = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(x => x.isDirectory() ? leer(join(d, x.name)) : /\.(ts|svelte)$/.test(x.name) ? [join(d, x.name)] : []);
  for (const f of leer('src/interfaz')) {
    const t = readFileSync(f, 'utf8');
    if (/localStorage/.test(t) && !/efimero\.ts$|componentes[\\/]util\.ts$|preparacion[\\/]util\.ts$|App\.svelte$/.test(f)) assert.fail('localStorage en ' + f);
  }
  const util = readFileSync('src/interfaz/componentes/util.ts', 'utf8');
  assert.match(util, /CLAVE_ASPECTO = 'spd\.aspecto'/);
  assert.doesNotMatch(readFileSync('src/interfaz/pantallas/preparacion/util.ts', 'utf8').replace(/\/\/.*$/gm, ''), /localStorage/);
  const app = readFileSync('src/interfaz/App.svelte', 'utf8');
  assert.match(app, /async function bloquear\(\) \{ limpiarEfimero\(\)/);
  assert.match(app, /if \(estado && !enSesion\) limpiarEfimero\(\)/);
  assert.match(app, /addEventListener\('spd:estado'/);
});

test('efimero: guarda en memoria, se vacía y borra restos heredados de localStorage/sessionStorage', () => {
  const mk = () => { const m = new Map<string, string>(); return Object.assign(m, { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }); };
  const ls = mk(), ss = mk();
  const proxy = (m: Map<string, string>) => new Proxy(m, { ownKeys: () => [...m.keys()], getOwnPropertyDescriptor: (_t, k) => (m.has(String(k)) ? { enumerable: true, configurable: true, value: 1 } : undefined), get: (t, k) => (k in t ? (t as never)[k] : m.get(String(k))) });
  (globalThis as unknown as { window: unknown }).window = { localStorage: proxy(ls), sessionStorage: proxy(ss) };
  try {
    ls.set('spd.cajas.hoy', '[{"paciente":"Ana"}]'); ls.set('spd.aspecto', '{}'); ss.set('spd.abrirPreparacion', '3'); ss.set('otra', 'x');
    guardarEfimero('k', { a: 1 }); assert.deepEqual(leerEfimero('k', null), { a: 1 });
    limpiarEfimero();
    assert.equal(leerEfimero('k', 'defecto'), 'defecto');
    assert.equal(ls.has('spd.cajas.hoy'), false); assert.equal(ls.has('spd.aspecto'), true);
    assert.equal(ss.has('spd.abrirPreparacion'), false); assert.equal(ss.has('otra'), true);
  } finally { delete (globalThis as unknown as { window?: unknown }).window; }
});
