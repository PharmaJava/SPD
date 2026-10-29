/**
 * Ayudas propias de los servicios de preparación y documentos (no dependen de
 * los demás servicios clínicos): sesión, fechas en hora de Madrid, ajustes y
 * conversiones de filas.
 */
import type { Contexto } from '../contexto.ts';
import { ErrorSpd } from '../contexto.ts';
import type { Db } from '../db.ts';
import type { UsuarioPublico } from '../api.ts';

/** Fila de la base: se leen columnas por nombre. */
export type R = Record<string, any>;

export function exigirSesion(ctx: Contexto): UsuarioPublico {
  const u = ctx.sesion();
  if (!u) throw new ErrorSpd('Inicia sesión.', 'SIN_SESION');
  return u;
}

export function bd(ctx: Contexto): Db {
  try { return ctx.db(); }
  catch (e) {
    if (e instanceof Error && /bloqueado/i.test(e.message)) throw new ErrorSpd('El programa está bloqueado: introduce la contraseña.', 'BLOQUEADO');
    throw e;
  }
}

export const invalido = (m: string) => new ErrorSpd(m, 'VALIDACION');
export const noEncontrado = (m: string) => new ErrorSpd(m, 'NO_ENCONTRADO');

const FMT_MADRID = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });

/** AAAA-MM-DD en hora de Madrid de un instante (Date o cadena ISO). */
export function fechaLocal(d: Date | string): string {
  return FMT_MADRID.format(typeof d === 'string' ? new Date(d) : d);
}
export const hoyISO = (ctx: Contexto): string => fechaLocal(ctx.ahora());
/** Instante actual ISO sin milisegundos. */
export const ahoraISO = (ctx: Contexto): string => ctx.ahora().toISOString().replace(/\.\d+Z$/, 'Z');

export function esFechaIso(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 86_400_000);
}

/** AAAA-MM-DD → DD/MM/AAAA. */
export function formatoFecha(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? '');
}

export const aCuartos = (u: number): number => Math.round(u * 4);

const AFIRMATIVO = new Set(['1', 'true', 'si', 'sí', 'yes']);
const comoBool = (v: string | undefined): boolean | undefined =>
  v === undefined ? undefined : AFIRMATIVO.has(v.trim().toLowerCase());

export interface AjustesPrep {
  diasValidezSpd: number;
  validezExtendidaPermitida: boolean;
  disposicion: {
    inicioDia?: 'convencional' | 'cronologico';
    rotar180?: boolean;
    sentidoTomas?: 'izquierda_derecha' | 'derecha_izquierda';
    posicionInicial?: 'izquierda' | 'derecha';
  };
}

/**
 * Ajustes que afectan a la preparación. Fuente: tabla `ajuste` (clave-valor); si una clave
 * no está, la columna de `farmacia` (dias_validez_spd, validez_extendida_permitida); si
 * tampoco, el valor por defecto (14 días, sin validez extendida, disposición del dominio).
 */
export function leerAjustesPrep(db: Db): AjustesPrep {
  const filas = db.all<{ clave: string; valor: string }>('SELECT clave, valor FROM ajuste');
  const a = new Map(filas.map((f) => [f.clave, f.valor]));
  const far = db.get<R>('SELECT dias_validez_spd, validez_extendida_permitida FROM farmacia WHERE id = 1');
  const dias = Number(a.get('dias_validez_spd') ?? far?.dias_validez_spd ?? 14);
  const ext = comoBool(a.get('validez_extendida_permitida')) ?? (far ? Number(far.validez_extendida_permitida) === 1 : false);
  const disp: AjustesPrep['disposicion'] = {};
  const inicio = a.get('inicioDia');
  if (inicio === 'convencional' || inicio === 'cronologico') disp.inicioDia = inicio;
  const rot = comoBool(a.get('rotar180'));
  if (rot !== undefined) disp.rotar180 = rot;
  const sentido = a.get('sentidoTomas');
  if (sentido === 'izquierda_derecha' || sentido === 'derecha_izquierda') disp.sentidoTomas = sentido;
  const pos = a.get('posicionInicial');
  if (pos === 'izquierda' || pos === 'derecha') disp.posicionInicial = pos;
  return { diasValidezSpd: Number.isInteger(dias) && dias >= 1 ? dias : 14, validezExtendidaPermitida: ext, disposicion: disp };
}

export function nombreCompleto(p: R): string {
  return [p.nombre, p.apellido1, p.apellido2].filter((x) => typeof x === 'string' && x.trim() !== '').join(' ');
}

export const textoONull = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Marcadores «?,?,?». */
export const marcadores = (n: number): string => Array.from({ length: n }, () => '?').join(',');
