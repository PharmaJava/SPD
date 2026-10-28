/**
 * Lo que los servicios necesitan del entorno. Lo construye el almacén (almacen.ts) y
 * lo reciben los servicios clínicos: así pueden probarse con una base en memoria y
 * un contexto de pruebas, sin Electron ni ficheros.
 */
import type { Db } from './db.ts';
import type { Resultado, UsuarioPublico } from './api.ts';

export interface DatosAuditoria {
  accion: string;            // 'crear' | 'modificar' | 'ver' | 'imprimir' | 'validar' …
  entidad: string;           // 'paciente' | 'envase' | 'preparacion' …
  entidadId?: string | number | null;
  antes?: unknown;
  despues?: unknown;
  motivo?: string | null;
}

export interface Contexto {
  /** Base abierta. Lanza `Error('bloqueado')` si el programa está bloqueado. */
  db(): Db;
  /** Hoy según el reloj del programa (inyectable en pruebas). */
  ahora(): Date;
  /** Usuario con sesión iniciada, o null. */
  sesion(): UsuarioPublico | null;
  /** Escribe en la auditoría encadenada. Debe llamarse DENTRO de la misma transacción que el cambio. */
  auditar(d: DatosAuditoria): void;
  /** Pide guardar la base cifrada en disco (puede agrupar varias llamadas). */
  persistir(): void;
}

// ── Ayudas comunes de resultado ──
export const ok = <T>(datos: T): Resultado<T> => ({ ok: true, datos });
export const fallo = (error: string, codigo?: string): Resultado<never> => ({ ok: false, error, ...(codigo ? { codigo } : {}) });

/** Ejecuta `fn`; si lanza, devuelve un fallo en español en vez de propagar la excepción. */
export async function proteger<T>(fn: () => T | Promise<T>): Promise<Resultado<T>> {
  try { return ok(await fn()); }
  catch (e) {
    if (e instanceof ErrorSpd) return fallo(e.message, e.codigo);
    return fallo(e instanceof Error ? e.message : String(e), 'ERROR_INTERNO');
  }
}

/** Error esperado (validación, permisos): su mensaje se enseña tal cual al usuario. */
export class ErrorSpd extends Error {
  codigo: string;
  constructor(mensaje: string, codigo = 'ERROR') { super(mensaje); this.codigo = codigo; }
}
