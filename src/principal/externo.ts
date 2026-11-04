/**
 * `ApiExterna` con Electron: impresoras, impresión, PDF, carpetas, CIMA y códigos.
 *
 * Todo lo que toca Electron entra por `DepsExterno` (inyección): así la lógica se prueba con dobles y los
 * adaptadores reales (`depsElectron`) son finos. Detalles de seguridad:
 *  - El HTML se carga en una ventana OCULTA, con JavaScript desactivado, sandbox, partición propia y CSP que
 *    impide cualquier petición; se escribe en un fichero temporal de uso exclusivo (0700) DENTRO de los datos del
 *    usuario (userData/impresion-tmp, no en la carpeta temporal compartida del sistema) que se BORRA siempre,
 *    porque contiene datos de pacientes. La sesión de impresión sólo deja leer ficheros de esa carpeta.
 *  - Imprimir y exportar a PDF se rechazan si el programa está bloqueado.
 *  - Si piden una impresora concreta, se comprueba que existe; no se imprime «en otra».
 *  - Ningún método lanza: todos devuelven `Resultado`.
 */
import type { BrowserWindow } from 'electron';
import type { ApiExterna, ImpresoraDto, Resultado } from '../servicios/api.ts';
import { ok, fallo } from '../servicios/contexto.ts';
import { consultarCima } from '../servicios/cima.ts';
import type { FetchLike } from '../servicios/cima.ts';
import { generarCodigoSvg } from '../servicios/codigos.ts';
import {
  argumentosPdf, argumentosPrint, impresoraInstalada, motivoHtmlInvalido, nombreFicheroSeguro, normalizarOpciones,
} from './impresion.ts';
import { CSP_IMPRESION, esPeticionImpresionPermitida } from './seguridad-ventana.ts';

/** Lo que implementa este módulo; las actualizaciones las añade actualizaciones.ts. */
export type ApiExternaBase = Omit<ApiExterna, 'estadoActualizaciones' | 'guardarPreferenciasActualizaciones' | 'buscarActualizaciones' | 'listarVersiones'>;

export const TIEMPO_IMPRESION_MS = 60_000;

/** Ventana oculta de impresión (envuelve un BrowserWindow). */
export interface VentanaImpresion {
  cargarArchivo(ruta: string): Promise<void>;
  imprimir(opciones: Record<string, unknown>): Promise<{ ok: boolean; motivo?: string }>;
  aPdf(opciones: Record<string, unknown>): Promise<Uint8Array>;
  destruir(): void;
}

export interface DepsExterno {
  crearVentanaImpresion(): VentanaImpresion;
  /** ¿Está el programa desbloqueado? Bloqueado, no se imprime ni se exporta (los documentos llevan datos de pacientes). */
  estaDesbloqueado(): boolean;
  /** Impresoras instaladas (no necesita ventana propia). */
  impresoras(): Promise<{ name: string; isDefault?: boolean }[]>;
  mostrarGuardar(o: { titulo: string; rutaSugerida: string; filtros: { name: string; extensions: string[] }[] }): Promise<{ cancelado: boolean; ruta?: string }>;
  mostrarCarpeta(titulo: string): Promise<{ cancelado: boolean; ruta?: string }>;
  carpetaDocumentos(): string;
  /** Escribe en el portapapeles del sistema. */
  copiar?(texto: string): void;
  fetch?: FetchLike;
  fs: {
    crearCarpetaTemporal(): Promise<string>;
    escribir(ruta: string, datos: string | Uint8Array): Promise<void>;
    borrarCarpeta(ruta: string): Promise<void>;
  };
  unir(...partes: string[]): string;
  esperar?: (ms: number) => Promise<void>;
}

const MENSAJE_BLOQUEADO = 'El programa está bloqueado: introduce la contraseña de la farmacia para imprimir o exportar.';
const mensaje = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function crearExterno(deps: DepsExterno): ApiExternaBase {
  const conTiempo = <T>(p: Promise<T>, ms: number, texto: string): Promise<T> =>
    new Promise<T>((res, rej) => {
      const t = setTimeout(() => rej(new Error(texto)), ms);
      p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
    });

  /** Carga el HTML en la ventana oculta, ejecuta `fn` y limpia SIEMPRE (ventana y fichero temporal). */
  async function conDocumento<T>(html: string, fn: (v: VentanaImpresion) => Promise<T>): Promise<T> {
    const carpeta = await deps.fs.crearCarpetaTemporal();
    let ventana: VentanaImpresion | null = null;
    try {
      const fichero = deps.unir(carpeta, 'documento.html');
      await deps.fs.escribir(fichero, html);
      ventana = deps.crearVentanaImpresion();
      await conTiempo(ventana.cargarArchivo(fichero), 20_000, 'El documento tardó demasiado en cargarse.');
      return await fn(ventana);
    } finally {
      try { ventana?.destruir(); } catch { /* ya destruida */ }
      try { await deps.fs.borrarCarpeta(carpeta); } catch { /* se purgará al arrancar */ }
    }
  }

  return {
    async copiarAlPortapapeles(texto) {
      if (typeof texto !== 'string' || texto.length === 0 || texto.length > 5000) return fallo('Texto no válido para copiar.', 'TEXTO_NO_VALIDO');
      if (!deps.copiar) return fallo('Este equipo no permite copiar desde el programa.', 'NO_DISPONIBLE');
      try { deps.copiar(texto); return ok(null); } catch (e) { return fallo('No se pudo copiar: ' + mensaje(e), 'COPIAR'); }
    },

    async consultarCima(cn) {
      try { return await consultarCima(cn, deps.fetch ? { fetch: deps.fetch } : {}); }
      catch (e) { return ok({ disponible: false, aviso: 'No se pudo consultar CIMA: ' + mensaje(e) }); }
    },

    async listarImpresoras(): Promise<Resultado<ImpresoraDto[]>> {
      try {
        const lista = await deps.impresoras();
        return ok(lista.map(i => ({ nombre: String(i.name), predeterminada: i.isDefault === true })));
      } catch (e) { return fallo('No se pudo obtener la lista de impresoras: ' + mensaje(e), 'IMPRESORAS'); }
    },

    async imprimirHtml(html, opciones) {
      if (!deps.estaDesbloqueado()) return fallo(MENSAJE_BLOQUEADO, 'BLOQUEADO');
      const malo = motivoHtmlInvalido(html);
      if (malo) return fallo(malo, 'IMPRESION_ENTRADA');
      const n = normalizarOpciones(opciones);
      if (!n.ok) return fallo(n.error, 'IMPRESION_ENTRADA');
      const o = n.opciones;
      try {
        if (o.impresora) {
          const lista = await deps.impresoras();
          if (!impresoraInstalada(o.impresora, lista)) return fallo(`La impresora «${o.impresora}» no está instalada en este equipo.`, 'IMPRESORA_NO_ENCONTRADA');
        }
        const r = await conDocumento(html, v => conTiempo(v.imprimir(argumentosPrint(o)), TIEMPO_IMPRESION_MS, 'La impresora no respondió a tiempo.'));
        if (!r.ok) return fallo('No se pudo imprimir' + (r.motivo ? `: ${r.motivo}` : '.'), 'IMPRESION');
        return ok(null);
      } catch (e) { return fallo('No se pudo imprimir: ' + mensaje(e), 'IMPRESION'); }
    },

    async exportarPdf(html, nombreSugerido, opciones) {
      if (!deps.estaDesbloqueado()) return fallo(MENSAJE_BLOQUEADO, 'BLOQUEADO');
      const malo = motivoHtmlInvalido(html);
      if (malo) return fallo(malo, 'IMPRESION_ENTRADA');
      const n = normalizarOpciones(opciones);
      if (!n.ok) return fallo(n.error, 'IMPRESION_ENTRADA');
      try {
        const sel = await deps.mostrarGuardar({
          titulo: 'Guardar como PDF',
          rutaSugerida: deps.unir(deps.carpetaDocumentos(), nombreFicheroSeguro(nombreSugerido, 'pdf')),
          filtros: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (sel.cancelado || !sel.ruta) return ok(null);
        const ruta = /\.pdf$/i.test(sel.ruta) ? sel.ruta : sel.ruta + '.pdf';
        const pdf = await conDocumento(html, v => conTiempo(v.aPdf(argumentosPdf({ anchoMm: n.opciones.anchoMm, altoMm: n.opciones.altoMm })), TIEMPO_IMPRESION_MS, 'La generación del PDF tardó demasiado.'));
        if (!pdf || pdf.length < 100) return fallo('El PDF generado está vacío.', 'PDF');
        await deps.fs.escribir(ruta, pdf);
        return ok({ ruta });
      } catch (e) { return fallo('No se pudo guardar el PDF: ' + mensaje(e), 'PDF'); }
    },

    async elegirCarpeta(titulo) {
      try {
        const t = typeof titulo === 'string' && titulo.trim() ? titulo.slice(0, 120) : 'Elegir carpeta';
        const sel = await deps.mostrarCarpeta(t);
        return ok(sel.cancelado || !sel.ruta ? null : sel.ruta);
      } catch (e) { return fallo('No se pudo abrir el selector de carpetas: ' + mensaje(e), 'CARPETA'); }
    },

    async codigoSvg(texto, simbologia) { return generarCodigoSvg(texto, simbologia); },
  };
}

// ───────────────────── Adaptadores reales de Electron ─────────────────────

type ModuloElectron = typeof import('electron');

/**
 * Conecta `DepsExterno` con Electron. `electron` se pasa desde main.ts (no se importa aquí: así este fichero se
 * puede cargar en pruebas sin Electron). `ventanaPrincipal` sirve de padre de los diálogos.
 */
/** Servidores a los que puede acabar llegando una petición con redirecciones (GitHub y su almacén de ficheros). */
export function esHostGithub(url: unknown): boolean {
  let u: URL; try { u = new URL(String(url)); } catch { return false; }
  const h = u.hostname.toLowerCase();
  return u.protocol === 'https:' && (h === 'github.com' || h === 'api.github.com' || h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com'));
}

/**
 * `fetch` para CIMA y actualizaciones: sesión propia, sin los filtros de la ventana, con el proxy del sistema.
 * El actualizador pide `redirect: 'manual'` (comprobar cada salto), pero el `fetch` de Electron no devuelve las
 * redirecciones en manual y falla: se siguen y se comprueba que la respuesta FINAL venga de GitHub; si no, se descarta.
 */
export function fetchExterno(electron: ModuloElectron): FetchLike {
  const ses = electron.session.fromPartition('spd-red-externa');
  return (async (url: string, init: { redirect?: string } & Record<string, unknown>) => {
    const manual = init?.redirect === 'manual';
    const r = await ses.fetch(url, (manual ? { ...init, redirect: 'follow' } : init) as RequestInit);
    if (manual && !esHostGithub(r.url || url)) {
      try { await r.body?.cancel(); } catch { /* ya cerrada */ }
      throw new Error('La respuesta no viene de GitHub: se descarta.');
    }
    return r;
  }) as unknown as FetchLike;
}

export function depsElectron(
  electron: ModuloElectron,
  node: { os: typeof import('node:os'); fs: typeof import('node:fs/promises'); path: typeof import('node:path') },
  ventanaPrincipal: () => BrowserWindow | null,
  /** Carpeta de documentos temporales de impresión (dentro de userData) y estado del bloqueo. */
  impresion: { carpeta: string; estaDesbloqueado: () => boolean },
): DepsExterno {
  const { BrowserWindow: BW, dialog, app, session, clipboard } = electron;
  const sesionImpresion = () => {
    const s = session.fromPartition('spd-impresion');
    s.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [CSP_IMPRESION] } }));
    // Sólo ficheros de la carpeta de impresión (y data:): cualquier otra petición, red y otros ficheros locales incluidos, se cancela.
    s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !esPeticionImpresionPermitida(d.url, impresion.carpeta) }));
    return s;
  };
  return {
    estaDesbloqueado: () => impresion.estaDesbloqueado(),
    crearVentanaImpresion() {
      const win = new BW({
        show: false, width: 900, height: 1200,
        webPreferences: {
          sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true,
          session: sesionImpresion(), devTools: false,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      return {
        cargarArchivo: (ruta) => win.loadFile(ruta),
        imprimir: (opciones) => new Promise(res => {
          win.webContents.print(opciones as Electron.WebContentsPrintOptions, (exito, motivo) => res({ ok: exito, motivo: exito ? undefined : motivo }));
        }),
        aPdf: (opciones) => win.webContents.printToPDF(opciones as Electron.PrintToPDFOptions),
        destruir: () => { if (!win.isDestroyed()) win.destroy(); },
      };
    },
    async impresoras() {
      // getPrintersAsync cuelga de un webContents: la ventana principal, o una oculta si no existe.
      const v = ventanaPrincipal();
      if (v && !v.isDestroyed()) return v.webContents.getPrintersAsync();
      const aux = new BW({ show: false, webPreferences: { sandbox: true, javascript: false } });
      try { return await aux.webContents.getPrintersAsync(); } finally { aux.destroy(); }
    },
    async mostrarGuardar(o) {
      const v = ventanaPrincipal();
      const opts = { title: o.titulo, defaultPath: o.rutaSugerida, filters: o.filtros };
      const r = v && !v.isDestroyed() ? await dialog.showSaveDialog(v, opts) : await dialog.showSaveDialog(opts);
      return { cancelado: r.canceled, ruta: r.filePath };
    },
    async mostrarCarpeta(titulo) {
      const v = ventanaPrincipal();
      const opts: Electron.OpenDialogOptions = { title: titulo, properties: ['openDirectory', 'createDirectory'] };
      const r = v && !v.isDestroyed() ? await dialog.showOpenDialog(v, opts) : await dialog.showOpenDialog(opts);
      return { cancelado: r.canceled, ruta: r.filePaths[0] };
    },
    carpetaDocumentos: () => app.getPath('documents'),
    copiar: (t) => clipboard.writeText(t),
    // Sesión APARTE para la red del programa: la sesión por defecto cancela toda petición que no sea la interfaz
    // (seguridad-ventana), y con ella CIMA y las actualizaciones fallaban siempre. Respeta el proxy del sistema.
    fetch: fetchExterno(electron),
    fs: {
      crearCarpetaTemporal: async () => {
        await node.fs.mkdir(impresion.carpeta, { recursive: true, mode: 0o700 });
        const c = await node.fs.mkdtemp(node.path.join(impresion.carpeta, 'spd-impresion-'));
        await node.fs.chmod(c, 0o700).catch(() => {});
        return c;
      },
      escribir: (ruta, datos) => node.fs.writeFile(ruta, datos),
      borrarCarpeta: (ruta) => node.fs.rm(ruta, { recursive: true, force: true }),
    },
    unir: (...p) => node.path.join(...p),
  };
}

/**
 * Borra los restos de impresiones anteriores (si el programa se cerró a mitad). Se llama al arrancar. Limpia la carpeta de
 * impresión de los datos del usuario y, por si quedó algo de versiones anteriores, la carpeta temporal del sistema.
 */
export async function purgarTemporalesImpresion(node: { os: typeof import('node:os'); fs: typeof import('node:fs/promises'); path: typeof import('node:path') }, carpetaImpresion?: string): Promise<number> {
  let n = 0;
  const limpiar = async (base: string) => {
    try {
      for (const e of await node.fs.readdir(base)) {
        if (e.startsWith('spd-impresion-')) { await node.fs.rm(node.path.join(base, e), { recursive: true, force: true }).catch(() => {}); n++; }
      }
    } catch { /* sin permisos o sin carpeta: no es grave */ }
  };
  if (carpetaImpresion) await limpiar(carpetaImpresion);
  await limpiar(node.os.tmpdir());
  return n;
}
