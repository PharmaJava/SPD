import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CSP_INTERFAZ, CSP_IMPRESION, esUrlInterfaz, esRecursoDeInterfaz, decidirApertura, urlInterfaz } from '../src/principal/seguridad-ventana.ts';

const INDEX = '/app/dist/interfaz/index.html';
const CARPETA = '/app/dist/interfaz';

test('CSP de la interfaz: sólo self, sin scripts inline ni eval ni red', () => {
  assert.match(CSP_INTERFAZ, /default-src 'self'/);
  assert.match(CSP_INTERFAZ, /script-src 'self'(;|$)/);
  assert.ok(!/unsafe-eval|script-src[^;]*unsafe-inline/.test(CSP_INTERFAZ));
  assert.match(CSP_INTERFAZ, /img-src 'self' data:/);
  assert.match(CSP_INTERFAZ, /connect-src 'none'/);
  assert.match(CSP_INTERFAZ, /object-src 'none'/);
  assert.match(CSP_INTERFAZ, /frame-ancestors 'none'/);
  assert.ok(!/https?:\/\//.test(CSP_INTERFAZ), 'ningún origen remoto');
});

test('CSP de impresión: nada de scripts ni de red', () => {
  assert.match(CSP_IMPRESION, /default-src 'none'/);
  assert.ok(!/script/.test(CSP_IMPRESION) && !/https?:/.test(CSP_IMPRESION));
});

test('esUrlInterfaz: sólo la página propia (con hash o consulta)', () => {
  const u = urlInterfaz(INDEX);
  assert.equal(esUrlInterfaz(u, INDEX), true);
  assert.equal(esUrlInterfaz(u + '#/pacientes/3', INDEX), true);
  assert.equal(esUrlInterfaz(u + '?x=1', INDEX), true);
  for (const x of ['https://evil.com/', 'http://localhost:5173/', 'file:///etc/passwd', 'file:///app/dist/interfaz/otra.html', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'no es url', '']) {
    assert.equal(esUrlInterfaz(x, INDEX), false, x);
  }
});

test('esRecursoDeInterfaz: sólo ficheros dentro de la carpeta de la interfaz', () => {
  assert.equal(esRecursoDeInterfaz('file:///app/dist/interfaz/assets/a.js', CARPETA), true);
  for (const x of ['file:///app/dist/interfaz-otra/a.js', 'file:///app/dist/interfaz/../principal/main.cjs', 'file:///etc/passwd', 'https://cima.aemps.es/x.js', 'http://x/', 'ftp://x']) {
    assert.equal(esRecursoDeInterfaz(x, CARPETA), false, x);
  }
});

test('ventanas nuevas: se deniegan; sólo los enlaces https de la AEMPS se abren en el navegador', () => {
  assert.deepEqual(decidirApertura('https://cima.aemps.es/cima/pdfs/ft/1/FT_1.pdf'), { accion: 'abrirEnNavegador', url: 'https://cima.aemps.es/cima/pdfs/ft/1/FT_1.pdf' });
  for (const x of ['https://evil.com', 'http://cima.aemps.es/x', 'file:///etc/passwd', 'javascript:1', 'https://aemps.es.evil.com/', 'ms-msdt:/id', '']) {
    assert.deepEqual(decidirApertura(x), { accion: 'denegar' }, x);
  }
});

// ── Comprobaciones sobre main.ts: que la configuración de seguridad no se pierda en una edición ──
const main = readFileSync(new URL('../src/principal/main.ts', import.meta.url), 'utf8');

test('main.ts: webPreferences seguras y dimensiones pedidas', () => {
  for (const t of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true', 'allowRunningInsecureContent: false',
    'width: 1280', 'height: 800', 'minWidth: 1024', 'minHeight: 700', "title: 'SPD'"]) assert.ok(main.includes(t), t);
  assert.ok(!/nodeIntegration:\s*true|sandbox:\s*false|contextIsolation:\s*false|webSecurity:\s*false/.test(main));
});

test('main.ts: un solo ejemplar, navegación bloqueada, permisos denegados, CSP aplicada', () => {
  for (const t of ['requestSingleInstanceLock', 'setWindowOpenHandler', 'will-navigate', 'will-attach-webview', 'setPermissionRequestHandler',
    'CSP_INTERFAZ', 'onBeforeRequest']) assert.ok(main.includes(t), t);
  assert.match(main, /setPermissionRequestHandler\(\(_wc, _perm, cb\) => cb\(false\)\)/);
});

test('main.ts: la interfaz se carga con loadFile (file://), no con una URL remota', () => {
  assert.match(main, /loadFile\(rutaIndex\)/);
  assert.ok(!/loadURL\(/.test(main));
});

test('main.ts: sin devtools en la versión empaquetada', () => {
  assert.match(main, /devTools:\s*!app\.isPackaged/);
});

test('el preload no expone ipcRenderer ni nada fuera de spd', () => {
  const pre = readFileSync(new URL('../src/principal/preload.ts', import.meta.url), 'utf8');
  const expuestos = [...pre.matchAll(/exposeInMainWorld\('(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(expuestos, ['spd']);
  assert.ok(!/exposeInMainWorld\('\w+',\s*ipcRenderer/.test(pre));
  assert.ok(!/require\(/.test(pre));
});
