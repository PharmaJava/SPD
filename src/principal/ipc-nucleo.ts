/**
 * Núcleo del IPC (sin Electron, se prueba solo): construye un manejador por cada método del contrato.
 *
 * Reglas:
 *  - Un canal por método de `metodos.ts` (`spd:<metodo>`): lista blanca; no hay canal «genérico».
 *  - Sólo responde a la ventana propia (se comprueba el remitente antes de tocar nada).
 *  - NUNCA propaga excepciones: devuelve siempre un `Resultado`. Un error inesperado se registra (sin datos) y la
 *    interfaz recibe un mensaje genérico; los errores esperados (`ErrorSpd`) llevan su mensaje en español.
 *  - Si un servicio devuelve algo que no es un `Resultado`, se convierte en fallo: la interfaz no debe recibir basura.
 */
import type { ApiSpd, NombreMetodo, Resultado } from '../servicios/api.ts';
import { ErrorSpd, fallo } from '../servicios/contexto.ts';
import { METODOS } from '../servicios/metodos.ts';

export const PREFIJO_CANAL = 'spd:';
export const CANAL_ACTIVIDAD = 'spd-actividad';
export const MAX_ARGUMENTOS = 8;

export const canalDe = (metodo: string): string => PREFIJO_CANAL + metodo;

/** Lo que se sabe del remitente de una llamada IPC. */
export interface Remitente { idWebContents: number; esMarcoPrincipal: boolean; urlMarco: string }
export interface ReglasRemitente { idWebContentsPropio: number | null; urlPropia(url: string): boolean }

export function remitenteValido(r: Remitente | null | undefined, reglas: ReglasRemitente): boolean {
  if (!r || reglas.idWebContentsPropio === null) return false;
  return r.idWebContents === reglas.idWebContentsPropio && r.esMarcoPrincipal === true && reglas.urlPropia(r.urlMarco);
}

export const esResultado = (v: unknown): v is Resultado<unknown> =>
  typeof v === 'object' && v !== null && (((v as any).ok === true && 'datos' in v) || ((v as any).ok === false && typeof (v as any).error === 'string'));

export type Manejador = (remitente: Remitente | null | undefined, ...args: unknown[]) => Promise<Resultado<unknown>>;

export interface OpcionesManejadores {
  api: ApiSpd;
  reglas: () => ReglasRemitente;
  /** Registro local de errores (sin datos de pacientes): sólo método y nombre del error. */
  registrar?: (mensaje: string) => void;
}

export function crearManejadores(op: OpcionesManejadores): Map<string, Manejador> {
  const mapa = new Map<string, Manejador>();
  for (const metodo of METODOS as readonly NombreMetodo[]) {
    mapa.set(canalDe(metodo), async (remitente, ...args) => {
      if (!remitenteValido(remitente, op.reglas())) return fallo('Llamada no autorizada.', 'NO_AUTORIZADO');
      if (args.length > MAX_ARGUMENTOS) return fallo('Demasiados argumentos.', 'ARGUMENTOS');
      try {
        const f = (op.api as unknown as Record<string, unknown>)[metodo];
        if (typeof f !== 'function') return fallo('Función no disponible en esta versión.', 'NO_IMPLEMENTADO');
        const r = await (f as (...a: unknown[]) => unknown).apply(op.api, args);
        if (!esResultado(r)) { op.registrar?.(`${metodo}: respuesta que no es un Resultado`); return fallo('Respuesta interna no válida.', 'ERROR_INTERNO'); }
        return r;
      } catch (e) {
        if (e instanceof ErrorSpd) return fallo(e.message, e.codigo);
        op.registrar?.(`${metodo}: ${e instanceof Error ? e.name : typeof e}`);
        return fallo('Error interno del programa.', 'ERROR_INTERNO');
      }
    });
  }
  return mapa;
}
