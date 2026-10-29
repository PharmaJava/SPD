/**
 * Política de seguridad de las ventanas (sin Electron: se prueba sola).
 *
 *  - CSP estricta: todo 'self'; sin contenido remoto; imágenes también `data:` (QR en SVG) y `blob:`.
 *    `style-src` admite 'unsafe-inline' porque las vistas previas de etiquetas y hojas (HTML generado por el
 *    dominio) llevan su CSS dentro; NO se admite script inline ni eval.
 *  - Navegación: la ventana sólo puede estar en la página de la interfaz. Nada de ir a otra URL ni abrir ventanas.
 *  - Enlaces: sólo https://…aemps.es / aemps.gob.es (fichas técnicas y prospectos de CIMA) se abren en el navegador del
 *    sistema; cualquier otro se descarta.
 */
import { pathToFileURL } from 'node:url';
import { urlAemps } from '../servicios/cima.ts';

export const CSP_INTERFAZ = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Para la ventana oculta de impresión: sin scripts, sin red; sólo estilos propios e imágenes incrustadas. */
export const CSP_IMPRESION = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** URL file:// de la página de la interfaz. */
export function urlInterfaz(rutaIndex: string): string { return pathToFileURL(rutaIndex).href; }

/** ¿Es `url` la propia página de la interfaz? (se ignora #hash y ?consulta: la navegación interna usa hash). */
export function esUrlInterfaz(url: string, rutaIndex: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'file:') return false;
  return u.origin + u.pathname === new URL(urlInterfaz(rutaIndex)).origin + new URL(urlInterfaz(rutaIndex)).pathname;
}

/** Los recursos que carga la página (JS, CSS, imágenes) deben vivir dentro de la carpeta de la interfaz. */
export function esRecursoDeInterfaz(url: string, carpetaInterfaz: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'file:') return false;
  const base = pathToFileURL(carpetaInterfaz.endsWith('/') || carpetaInterfaz.endsWith('\\') ? carpetaInterfaz : carpetaInterfaz + '/').href;
  return u.href.startsWith(base) && !u.pathname.includes('/../');
}

export type DecisionApertura = { accion: 'denegar' } | { accion: 'abrirEnNavegador'; url: string };

/** Qué hacer cuando la página intenta abrir una ventana nueva (window.open, target=_blank). */
export function decidirApertura(url: string): DecisionApertura {
  const u = urlAemps(url);
  return u ? { accion: 'abrirEnNavegador', url: u } : { accion: 'denegar' };
}
