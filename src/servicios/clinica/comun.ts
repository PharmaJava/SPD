/**
 * Ayudas comunes de los servicios clínicos base: sesión, fechas, texto y
 * validaciones pequeñas. Sin acceso a disco ni red (sólo el Contexto).
 */
import type { Contexto } from '../contexto.ts';
import { ErrorSpd } from '../contexto.ts';
import type { Db } from '../db.ts';
import type { UsuarioPublico } from '../api.ts';
import { puedeValidar } from '../../dominio/caducidad-spd.ts';

/** Fila de la base: los servicios leen columnas por nombre. */
export type R = Record<string, any>;

export const MS_DIA = 86_400_000;

export function exigirSesion(ctx: Contexto): UsuarioPublico {
  const u = ctx.sesion();
  if (!u) throw new ErrorSpd('Inicia sesión', 'SIN_SESION');
  return u;
}

/** Base abierta; si el programa está bloqueado lo dice en español. */
export function bd(ctx: Contexto): Db {
  try { return ctx.db(); }
  catch (e) {
    if (e instanceof Error && /bloqueado/i.test(e.message)) throw new ErrorSpd('El programa está bloqueado: introduce la contraseña.', 'BLOQUEADO');
    throw e;
  }
}

/** ¿Puede este usuario confirmar descripciones físicas / fijar aptitudes? (farmacéutico o titular) */
export function puedeConfirmar(u: UsuarioPublico): boolean { return puedeValidar(u.rol); }

export function invalido(mensaje: string): ErrorSpd { return new ErrorSpd(mensaje, 'VALIDACION'); }
export function noEncontrado(mensaje: string): ErrorSpd { return new ErrorSpd(mensaje, 'NO_ENCONTRADO'); }

/** Día de hoy (AAAA-MM-DD) según el reloj del programa, en hora de Madrid. */
export function hoyISO(ctx: Contexto): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.ahora());
}

/** Momento actual ISO sin milisegundos: 2026-11-02T09:00:00Z. */
export function ahoraISO(ctx: Contexto): string {
  return ctx.ahora().toISOString().replace(/\.\d+Z$/, 'Z');
}

export function esFechaIso(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / MS_DIA);
}

export function sumarMeses(fecha: string, meses: number): string {
  const d = new Date(fecha + 'T00:00:00Z');
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d.toISOString().slice(0, 10);
}

/** AAAA-MM-DD → DD/MM/AAAA (para los textos que lee una persona). */
export function formatoFecha(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? '');
}

/** Texto recortado o null si está vacío. Lanza si no es texto. */
export function texto(v: unknown, campo: string, max = 500): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalido(`«${campo}» debe ser texto.`);
  const t = v.trim();
  if (t === '') return null;
  if (t.length > max) throw invalido(`«${campo}» es demasiado largo (máximo ${max} caracteres).`);
  return t;
}

export function textoObligatorio(v: unknown, campo: string, max = 500): string {
  const t = texto(v, campo, max);
  if (t === null) throw invalido(`Falta ${campo}.`);
  return t;
}

export function entero(v: unknown, campo: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw invalido(`«${campo}» no es válido.`);
  return v;
}

export const bool = (v: unknown): boolean => v === true || v === 1;
export const boolDb = (v: unknown): 0 | 1 => (bool(v) ? 1 : 0);

export function urlHttp(v: unknown, campo: string): string | null {
  const t = texto(v, campo, 500);
  if (t === null) return null;
  if (!/^https?:\/\/\S+$/i.test(t)) throw invalido(`«${campo}» debe ser una dirección http(s).`);
  return t;
}

/** Marcadores «?,?,?» para una lista de valores (siempre con parámetros). */
export function marcadores(n: number): string { return Array.from({ length: n }, () => '?').join(','); }

/** Ejecuta `fn` con trozos de `ids` (límite de variables de SQLite). */
export function porTrozos<T>(ids: number[], fn: (trozo: number[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 400) out.push(...fn(ids.slice(i, i + 400)));
  return out;
}
