/**
 * Copias de seguridad del fichero cifrado (doc 10.4).
 *
 * La copia es el propio `spd.datos` (ya cifrado) copiado a la carpeta elegida, con la fecha en el
 * nombre: `spd-AAAAMMDD-HHMMSS.datos` (UTC). Rotación: 7 diarias, 4 semanales, 12 mensuales.
 * Sólo se tocan (y borran) ficheros con ESE patrón: lo demás que haya en la carpeta no se toca.
 */
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EstadoCopias } from './api.ts';
import { ErrorSpd } from './contexto.ts';

export const COPIAS_DIARIAS = 7;
export const COPIAS_SEMANALES = 4;
export const COPIAS_MENSUALES = 12;
/** Más de 2 días sin copia → aviso. */
export const MS_ATRASADA = 2 * 24 * 3600 * 1000;

const RE_NOMBRE = /^spd-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.datos$/;

export interface CopiaInfo { nombre: string; fecha: Date }

const dos = (n: number) => String(n).padStart(2, '0');

export function nombreCopia(fecha: Date): string {
  return `spd-${fecha.getUTCFullYear()}${dos(fecha.getUTCMonth() + 1)}${dos(fecha.getUTCDate())}-${dos(fecha.getUTCHours())}${dos(fecha.getUTCMinutes())}${dos(fecha.getUTCSeconds())}.datos`;
}

/** Fecha que dice el nombre, o null si no es una copia nuestra (o la fecha no existe). */
export function fechaDeNombre(nombre: string): Date | null {
  const m = RE_NOMBRE.exec(nombre);
  if (!m) return null;
  const [a, mes, d, h, mi, s] = m.slice(1).map(Number);
  const f = new Date(Date.UTC(a, mes - 1, d, h, mi, s));
  return f.getUTCFullYear() === a && f.getUTCMonth() === mes - 1 && f.getUTCDate() === d && f.getUTCHours() === h ? f : null;
}

export function listarCopias(carpeta: string): CopiaInfo[] {
  let nombres: string[];
  try { nombres = readdirSync(carpeta); } catch { return []; }
  const r: CopiaInfo[] = [];
  for (const nombre of nombres) { const fecha = fechaDeNombre(nombre); if (fecha) r.push({ nombre, fecha }); }
  return r.sort((a, b) => a.fecha.getTime() - b.fecha.getTime() || a.nombre.localeCompare(b.nombre));
}

/** Lunes de la semana (UTC) como clave AAAA-MM-DD. */
function claveSemana(f: Date): string {
  const d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;       // lunes = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
const claveDia = (f: Date) => f.toISOString().slice(0, 10);
const claveMes = (f: Date) => f.toISOString().slice(0, 7);

/**
 * Qué copias se conservan: la más reciente de cada uno de los últimos 7 días con copia, de las
 * últimas 4 semanas con copia y de los últimos 12 meses con copia. Las demás sobran.
 */
export function seleccionarConservar(copias: CopiaInfo[]): Set<string> {
  const orden = [...copias].sort((a, b) => b.fecha.getTime() - a.fecha.getTime() || b.nombre.localeCompare(a.nombre));   // más nueva primero
  const conservar = new Set<string>();
  const regla = (clave: (f: Date) => string, cuantas: number) => {
    const vistas = new Set<string>();
    for (const c of orden) {
      const k = clave(c.fecha);
      if (vistas.has(k)) continue;           // ya tenemos la más reciente de ese periodo
      if (vistas.size >= cuantas) break;
      vistas.add(k);
      conservar.add(c.nombre);
    }
  };
  regla(claveDia, COPIAS_DIARIAS);
  regla(claveSemana, COPIAS_SEMANALES);
  regla(claveMes, COPIAS_MENSUALES);
  return conservar;
}

/** Aplica la rotación. Devuelve los nombres borrados. Nunca borra `proteger`. */
export function rotarCopias(carpeta: string, proteger?: string): string[] {
  const copias = listarCopias(carpeta);
  const conservar = seleccionarConservar(copias);
  const borradas: string[] = [];
  for (const c of copias) {
    if (conservar.has(c.nombre) || c.nombre === proteger) continue;
    try { rmSync(join(carpeta, c.nombre)); borradas.push(c.nombre); } catch { /* si no se puede borrar, se queda */ }
  }
  return borradas;
}

/** Copia el fichero cifrado a la carpeta (atómico: temporal + rename) y rota. Devuelve la ruta. */
export function crearCopiaFichero(origen: string, carpeta: string, ahora: Date): string {
  if (!carpeta || !carpeta.trim()) throw new ErrorSpd('No hay carpeta de copias configurada.', 'SIN_CARPETA_COPIAS');
  try { mkdirSync(carpeta, { recursive: true }); }
  catch (e) { throw new ErrorSpd(`No se puede usar la carpeta de copias «${carpeta}»: ${e instanceof Error ? e.message : String(e)}`, 'CARPETA_COPIAS'); }
  const nombre = nombreCopia(ahora);
  const destino = join(carpeta, nombre);
  const tmp = destino + '.tmp';
  try {
    copyFileSync(origen, tmp);
    if (statSync(tmp).size !== statSync(origen).size) throw new Error('la copia no tiene el mismo tamaño que el original');
    renameSync(tmp, destino);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nada */ }
    throw new ErrorSpd(`No se pudo crear la copia: ${e instanceof Error ? e.message : String(e)}`, 'COPIA_FALLIDA');
  }
  rotarCopias(carpeta, nombre);
  return destino;
}

export function estadoDeCopias(carpeta: string | null, ahora: Date): EstadoCopias {
  if (!carpeta) return { ultima: null, atrasada: true, carpeta: null, total: 0 };
  const copias = listarCopias(carpeta);
  const ult = copias.length ? copias[copias.length - 1].fecha : null;
  return {
    ultima: ult ? ult.toISOString() : null,
    atrasada: !ult || ahora.getTime() - ult.getTime() > MS_ATRASADA,
    carpeta,
    total: copias.length,
  };
}
