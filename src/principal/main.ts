/**
 * Proceso principal de Electron. Orquesta; la lógica está en módulos probados aparte:
 *   seguridad-ventana.ts (CSP/navegación) · ipc-nucleo.ts/ipc.ts · externo.ts · inactividad.ts ·
 *   planificador-copias.ts · menu.ts · servicios.ts (ensamblado real) · modo-pruebas.ts.
 *
 * Seguridad (docs/10-seguridad.md §10.5): contextIsolation, sandbox, sin nodeIntegration, CSP estricta,
 * sin contenido remoto, navegación y ventanas nuevas bloqueadas, permisos denegados, un solo ejemplar.
 */
import { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } from 'electron';
import * as electron from 'electron';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { crearServiciosApp } from './servicios.ts';
import type { ServiciosApp } from './servicios.ts';
import { registrarIpc } from './ipc.ts';
import { depsElectron, crearExterno, fetchExterno, purgarTemporalesImpresion } from './externo.ts';
import { CSP_INTERFAZ, decidirApertura, esRecursoDeInterfaz, esUrlInterfaz } from './seguridad-ventana.ts';
import { crearVigilanteInactividad } from './inactividad.ts';
import type { Vigilante } from './inactividad.ts';
import { planificarCopias } from './planificador-copias.ts';
import { plantillaMenu, textoAcercaDe } from './menu.ts';
import { protectorDeSafeStorage } from './protector-clave.ts';
import { leerModoPruebas } from './modo-pruebas.ts';
import { crearActualizador } from './actualizaciones.ts';
import { notasParaDialogo } from './texto-actualizacion.ts';

const modoPruebas = leerModoPruebas(process.env, app.isPackaged);
const carpetaInterfaz = path.join(__dirname, '..', 'interfaz');
const rutaIndex = path.join(carpetaInterfaz, 'index.html');

let ventana: BrowserWindow | null = null;
let servicios: ServiciosApp | null = null;
let vigilante: Vigilante | null = null;
let cerrando = false;

const registrar = (m: string) => console.error('[spd]', m);   // sin datos de pacientes: sólo método y tipo de error

// Un solo ejemplar (en el modo de pruebas no: puede haber varios en paralelo).
if (!modoPruebas && !app.requestSingleInstanceLock()) { app.quit(); }
else {
  if (modoPruebas) { app.disableHardwareAcceleration(); app.setPath('userData', path.join(modoPruebas.rutaDatos, 'electron')); }
  app.on('second-instance', () => { if (ventana) { if (ventana.isMinimized()) ventana.restore(); ventana.focus(); } });
  app.whenReady().then(arrancar).catch((e) => { registrar('arranque: ' + (e instanceof Error ? e.name : String(e))); dialog.showErrorBox('SPD', 'El programa no ha podido arrancar.'); app.exit(1); });
}

/** Endurecimiento que vale para TODO webContents que cree Electron. */
app.on('web-contents-created', (_e, wc) => {
  wc.setWindowOpenHandler(({ url }) => {
    const d = decidirApertura(url);
    if (d.accion === 'abrirEnNavegador') void shell.openExternal(d.url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (ev, url) => { if (!esUrlInterfaz(url, rutaIndex)) ev.preventDefault(); });
  wc.on('will-redirect', (ev, url) => { if (!esUrlInterfaz(url, rutaIndex)) ev.preventDefault(); });
  wc.on('will-attach-webview', (ev) => ev.preventDefault());
});

function endurecerSesion(): void {
  const s = session.defaultSession;
  s.webRequest.onHeadersReceived((d, cb) => {
    const h = { ...d.responseHeaders };
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'content-security-policy') delete h[k];
    cb({ responseHeaders: { ...h, 'Content-Security-Policy': [CSP_INTERFAZ] } });
  });
  // Sólo se carga lo que está dentro de la carpeta de la interfaz (y data:/blob:/devtools). Nada de red.
  s.webRequest.onBeforeRequest((d, cb) => {
    const u = d.url;
    const permitida = u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('devtools:') || esRecursoDeInterfaz(u, carpetaInterfaz);
    cb({ cancel: !permitida });
  });
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  s.setDevicePermissionHandler(() => false);
}

function crearVentana(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 700, title: 'SPD', show: false, backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, spellcheck: false, devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { if (ventana === win) ventana = null; });
  void win.loadFile(rutaIndex);
  return win;
}

/** Avisa a la interfaz de que el estado del sistema ha cambiado (p. ej. se ha bloqueado). Evento DOM `spd:estado`. */
function avisarInterfaz(): void {
  const wc = ventana && !ventana.isDestroyed() ? ventana.webContents : null;
  if (wc) void wc.executeJavaScript("window.dispatchEvent(new CustomEvent('spd:estado'))").catch(() => {});
}

async function arrancar(): Promise<void> {
  if (!existsSync(rutaIndex)) {
    dialog.showErrorBox('SPD', 'Falta la interfaz del programa (dist/interfaz). Reinstala la aplicación.');
    app.exit(1); return;
  }
  endurecerSesion();
  // Documentos temporales de impresión: dentro de los datos del usuario (no en %TEMP%, que es compartido).
  const carpetaImpresion = path.join(app.getPath('userData'), 'impresion-tmp');
  await purgarTemporalesImpresion({ os, fs, path }, carpetaImpresion);

  const node = { os, fs, path };
  const externo = crearExterno(depsElectron(electron, node, () => ventana, { carpeta: carpetaImpresion, estaDesbloqueado: () => servicios?.estaDesbloqueado() ?? false }));
  const rutaDatos = modoPruebas ? path.join(modoPruebas.rutaDatos, 'datos') : path.join(app.getPath('userData'), 'datos');
  const wasmPath = app.isPackaged ? path.join(process.resourcesPath, 'recursos', 'sql-wasm.wasm') : path.join(__dirname, '..', 'recursos', 'sql-wasm.wasm');
  // Actualizaciones: nada se descarga ni instala sin aceptar el diálogo; ver actualizaciones.ts.
  const rutaPrefs = path.join(app.getPath('userData'), 'actualizaciones.json');
  const padre = () => (ventana && !ventana.isDestroyed() ? ventana : undefined);
  const caja = (o: Electron.MessageBoxOptions) => (padre() ? dialog.showMessageBox(padre()!, o) : dialog.showMessageBox(o));
  const actualizador = crearActualizador({
    fetch: fetchExterno(electron) as never,
    plataforma: process.platform, versionActual: app.getVersion(), registrar,
    prefs: {
      leer: async () => { try { return JSON.parse(await fs.readFile(rutaPrefs, 'utf8')); } catch { return null; } },
      guardar: (p) => fs.writeFile(rutaPrefs, JSON.stringify(p)),
    },
    preguntar: async (i) => {
      const r = await caja({
        type: 'question', title: 'Actualización de SPD', message: `Hay una versión nueva de SPD: ${i.versionNueva} (tienes la ${i.versionActual}).`,
        detail: `${notasParaDialogo(i.notas)}\n\nSi aceptas: se hará una copia de seguridad de tus datos, se descargará el instalador desde github.com/PharmaJava/SPD, se comprobará su suma SHA-256 y sólo entonces se te pedirá cerrar SPD para instalarlo.`,
        buttons: ['Instalar ahora', 'Más tarde', 'No volver a avisar de esta versión'], defaultId: 1, cancelId: 1, noLink: true,
      });
      return r.response === 0 ? 'instalar' : r.response === 2 ? 'ignorar' : 'luego';
    },
    confirmarCierre: async (v) => (await caja({
      type: 'question', title: 'Actualización de SPD', message: `Descarga de la versión ${v} verificada.`,
      detail: 'Para instalarla hay que cerrar SPD ahora. Guarda lo que estés haciendo. Antes de instalar se hará una copia de seguridad («antes de actualizar a v' + v + '»).',
      buttons: ['Cerrar SPD e instalar', 'Cancelar'], defaultId: 1, cancelId: 1, noLink: true,
    })).response === 0,
    copiaAntes: (v) => (servicios ? servicios.crearCopiaPreActualizacion(v) : Promise.resolve({ ok: false as const, error: 'El programa aún no ha arrancado.' })),
    fs: {
      crearCarpetaTemporal: async () => { const c = await fs.mkdtemp(path.join(os.tmpdir(), 'spd-actualizacion-')); await fs.chmod(c, 0o700).catch(() => {}); return c; },
      unir: (...p) => path.join(...p),
      abrirEscritura: async (ruta) => {
        const ws = createWriteStream(ruta, { mode: 0o600 });
        return {
          escribir: (b) => new Promise<void>((res, rej) => ws.write(b, (e) => (e ? rej(e) : res()))),
          cerrar: () => new Promise<void>((res) => ws.end(() => res())),
        };
      },
      borrarCarpeta: (r) => fs.rm(r, { recursive: true, force: true }),
    },
    cerrarYLanzar: async (ruta) => {
      cerrando = true; vigilante?.parar();
      await Promise.race([servicios ? servicios.cerrar() : Promise.resolve(), new Promise<void>(r => setTimeout(r, 8000))]);
      spawn(ruta, [], { detached: true, stdio: 'ignore' }).unref();
      app.exit(0);
    },
  });
  const externoCompleto = {
    ...externo,
    estadoActualizaciones: () => actualizador.estado(),
    guardarPreferenciasActualizaciones: (p: { comprobarAlArrancar?: boolean; versionIgnorada?: string | null }) => actualizador.guardarPreferencias(p),
    buscarActualizaciones: () => actualizador.buscar({ manual: true }),
    listarVersiones: () => actualizador.listarVersiones(),
  };
  servicios = crearServiciosApp({ rutaDatos, wasmPath, version: app.getVersion(), externo: externoCompleto, carpetaCopiasPorDefecto: path.join(app.getPath('userData'), 'copias'),
    protector: protectorDeSafeStorage(electron.safeStorage as never) });
  const sv = servicios;
  if (sv.faltan.length) registrar(`métodos sin implementar: ${sv.faltan.join(', ')}`);

  // Bloqueo por inactividad (en el modo de pruebas no: el guion tarda).
  let ultimoAjuste = 0;
  if (!modoPruebas) {
    vigilante = crearVigilanteInactividad({
      alBloquear: () => { void sv.bloquearPorInactividad().then(avisarInterfaz); },
    });
  }
  const alActividad = () => {
    vigilante?.actividad();
    const ahora = Date.now();
    if (vigilante && ahora - ultimoAjuste > 30_000) {          // el plazo es un ajuste: se relee de vez en cuando
      ultimoAjuste = ahora;
      void sv.api.obtenerAjustes().then(r => { if (r.ok) vigilante?.configurar(r.datos.bloqueoMinutos); });
    }
  };

  registrarIpc({
    ipcMain, api: sv.api, ventana: () => ventana, urlPropia: (u) => esUrlInterfaz(u, rutaIndex), alActividad, registrar,
  });

  // Copia automática diaria (sólo si hay carpeta de copias configurada).
  if (!modoPruebas) planificarCopias({ ejecutar: () => sv.crearCopiaAutomatica(), alFallar: (m) => registrar('copia automática: ' + m) });

  const acciones = {
    bloquear: () => { void sv.api.bloquear().then(avisarInterfaz); },
    copiaSeguridad: () => { void copiaManual(sv); },
    acercaDe: () => { void acercaDe(); },
    salir: () => app.quit(),
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(plantillaMenu(acciones, { desarrollo: !app.isPackaged })));

  ventana = crearVentana();
  // Comprobación al arrancar (si está activada): sólo instalada, con unos segundos de margen y sin molestar si falla.
  if (!modoPruebas && app.isPackaged) setTimeout(() => { void actualizador.comprobarAlArrancar(); }, 20_000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) ventana = crearVentana(); });
}

async function copiaManual(sv: ServiciosApp): Promise<void> {
  const padre = ventana && !ventana.isDestroyed() ? ventana : undefined;
  const mostrar = (o: Electron.MessageBoxOptions) => (padre ? dialog.showMessageBox(padre, o) : dialog.showMessageBox(o));
  let r = await sv.api.crearCopia();
  if (!r.ok && r.codigo === 'SIN_CARPETA_COPIAS') {
    const c = await sv.api.elegirCarpeta('Carpeta para las copias de seguridad');
    if (!c.ok || !c.datos) return;
    const g = await sv.api.guardarAjustes({ carpetaCopias: c.datos });   // la carpeta se guarda en los ajustes; crearCopia no acepta otra
    if (!g.ok) { await mostrar({ type: 'warning', title: 'Copia de seguridad', message: 'No se pudo guardar la carpeta.', detail: g.error }); return; }
    r = await sv.api.crearCopia();
  }
  if (r.ok) await mostrar({ type: 'info', title: 'Copia de seguridad', message: 'Copia de seguridad creada.', detail: r.datos.ruta });
  else await mostrar({ type: 'warning', title: 'Copia de seguridad', message: 'No se pudo crear la copia.', detail: r.error });
}

async function acercaDe(): Promise<void> {
  const t = textoAcercaDe(app.getVersion());
  const padre = ventana && !ventana.isDestroyed() ? ventana : undefined;
  const o: Electron.MessageBoxOptions = { type: 'info', title: t.titulo, message: t.mensaje, detail: t.detalle, buttons: ['Cerrar', 'Ver licencia'], defaultId: 0, cancelId: 0 };
  const r = padre ? await dialog.showMessageBox(padre, o) : await dialog.showMessageBox(o);
  if (r.response === 1) {
    let texto = 'No se encontró el fichero de licencia.';
    try { texto = (await fs.readFile(path.join(app.getAppPath(), 'LICENSE.txt'), 'utf8')).slice(0, 6000); } catch { /* se queda el aviso */ }
    const o2: Electron.MessageBoxOptions = { type: 'info', title: 'Licencia', message: 'Licencia de uso', detail: texto };
    if (padre) await dialog.showMessageBox(padre, o2); else await dialog.showMessageBox(o2);
  }
}

app.on('window-all-closed', () => { app.quit(); });

// Al salir se guarda lo pendiente (la base se escribe de forma diferida). Con tope de tiempo: no colgar el cierre.
app.on('before-quit', (e) => {
  if (cerrando || !servicios) return;
  e.preventDefault(); cerrando = true;
  vigilante?.parar();
  void Promise.race([servicios.cerrar(), new Promise<void>(r => setTimeout(r, 8000))]).finally(() => app.exit(0));
});

process.on('uncaughtException', (e) => registrar('excepción no controlada: ' + e.name));
process.on('unhandledRejection', (e) => registrar('promesa rechazada: ' + (e instanceof Error ? e.name : typeof e)));
