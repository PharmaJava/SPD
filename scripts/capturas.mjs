// Capturas de pantalla de la aplicación REAL (Electron) para la documentación y la revisión visual.
//
//   node scripts/capturas.mjs            (lanza Electron bajo xvfb si no hay pantalla; usa dist/ ya construido)
//   npm run build && node scripts/capturas.mjs
//
// Requisitos: `npm run build` hecho (dist/principal, dist/interfaz, dist/recursos), `xvfb-run` en Linux y la
// librería `playwright` (global: `npm i -g playwright`, o local). Guarda PNG en capturas/ y, al final, imprime
// los errores de consola que haya visto (si hay alguno, sale con código 1).
//
// MODO DE PRUEBAS: se activa SOLO con SPD_CAPTURAS=1 + SPD_DATOS_PRUEBAS=<carpeta temporal> y NUNCA en la versión
// empaquetada (src/principal/modo-pruebas.ts). Usa datos en esa carpeta (no toca los reales), sin bloqueo por
// inactividad ni «un solo ejemplar». El recorrido hace el primer uso y el desbloqueo con la API real (window.spd)
// y navega por las pantallas por hash. Usuario/contraseña de pruebas: abajo.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync as _mk } from 'node:fs';
// Datos de pruebas siempre bajo /tmp/SPD/sp/datos (sin nombres de herramientas ni sesiones)
const baseDatos = () => { const b = join(tmpdir(), 'SPD', 'sp', 'datos'); _mk(b, { recursive: true }); return b; };
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SALIDA = join(RAIZ, 'capturas');
const CONTRASENA = 'prueba-capturas-1234', PIN = '1234';

// Sin pantalla (Linux): se relanza a sí mismo bajo xvfb.
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.SPD_SIN_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, SPD_SIN_XVFB: '1' } });
  process.exit(r.status ?? 1);
}

async function cargarPlaywright() {
  const req = createRequire(import.meta.url);
  const rutas = [undefined, ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(':') : []), '/opt/node22/lib/node_modules'];
  for (const base of rutas) {
    try { return req(base ? join(base, 'playwright') : 'playwright'); } catch { /* siguiente */ }
  }
  throw new Error('No se encuentra la librería «playwright» (npm i -g playwright).');
}

for (const f of ['dist/principal/main.cjs', 'dist/interfaz/index.html', 'dist/recursos/sql-wasm.wasm']) {
  if (!existsSync(join(RAIZ, f))) { console.error(`Falta ${f}: ejecuta antes «npm run build».`); process.exit(2); }
}
mkdirSync(SALIDA, { recursive: true });
const datos = mkdtempSync(join(baseDatos(), 'spd-capturas-'));
const { _electron } = await cargarPlaywright();
const electronBin = createRequire(import.meta.url)(join(RAIZ, 'node_modules/electron'));

const erroresConsola = [];
const app = await _electron.launch({
  executablePath: electronBin,
  args: [RAIZ, ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: { ...process.env, SPD_CAPTURAS: '1', SPD_DATOS_PRUEBAS: datos },
  timeout: 60_000,
});
let codigo = 0;
try {
  const ventana = await app.firstWindow();
  ventana.on('console', (m) => { if (m.type() === 'error') erroresConsola.push(m.text()); });
  ventana.on('pageerror', (e) => erroresConsola.push('pageerror: ' + e.message));
  await ventana.setViewportSize({ width: 1280, height: 800 });
  const foto = async (nombre) => { await ventana.waitForTimeout(500); await ventana.screenshot({ path: join(SALIDA, nombre + '.png') }); console.log('captura', nombre); };
  const api = (metodo, ...args) => ventana.evaluate(([m, a]) => window.spd[m](...a), [metodo, args]);

  await ventana.waitForLoadState('load');
  await foto('01-primer-uso');

  const r1 = await api('primerUso', {
    farmacia: { nombre: 'Farmacia de Pruebas', titular: 'Titular de Pruebas' },
    titular: { nombre: 'Titular de Pruebas', iniciales: 'TP', pin: PIN }, contrasena: CONTRASENA,
    momentos: [{ nombre: 'Desayuno', hora: '08:00' }, { nombre: 'Comida', hora: '14:00' }, { nombre: 'Cena', hora: '21:00' }, { nombre: 'Acostarse', hora: '23:00' }],
  });
  if (!r1.ok) throw new Error('primerUso: ' + r1.error);
  await api('bloquear');
  await ventana.reload(); await foto('02-bloqueo');
  const r2 = await api('desbloquear', CONTRASENA);
  if (!r2.ok) throw new Error('desbloquear: ' + r2.error);
  const us = await api('listarUsuarios');
  if (us.ok && us.datos[0]) { const s = await api('iniciarSesion', us.datos[0].id, PIN); if (!s.ok) throw new Error('iniciarSesion: ' + s.error); }
  await ventana.reload();   // la interfaz relee el estado (ya desbloqueado y con sesión)
  for (const [hash, nombre] of [['#/hoy', '03-hoy'], ['#/pacientes', '04-pacientes'], ['#/medicamentos', '05-medicamentos'], ['#/ajustes', '06-ajustes']]) {
    await ventana.evaluate((h) => { location.hash = h; }, hash);
    await foto(nombre);
  }
} catch (e) {
  console.error('ERROR en el recorrido:', e instanceof Error ? e.message : e);
  codigo = 1;
} finally {
  await app.close().catch(() => {});
  rmSync(datos, { recursive: true, force: true });
}
if (erroresConsola.length) { console.error('Errores de consola:\n' + erroresConsola.map(e => ' - ' + e).join('\n')); codigo = 1; }
process.exit(codigo);
