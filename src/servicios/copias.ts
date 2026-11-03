/**
 * Copias de seguridad del fichero cifrado (doc 10.4).
 *
 * La copia es el propio `spd.datos` (ya cifrado) copiado a la carpeta elegida, con la fecha en el
 * nombre: `spd-AAAAMMDD-HHMMSS.datos` (UTC). Rotación: 7 diarias, 4 semanales, 12 mensuales.
 * Sólo se tocan (y borran) ficheros con ESE patrón: lo demás que haya en la carpeta no se toca.
 */
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { EstadoCopias } from './api.ts';
import { ErrorSpd } from './contexto.ts';

export const COPIAS_DIARIAS = 7;
export const COPIAS_SEMANALES = 4;
export const COPIAS_MENSUALES = 12;
/** Más de 2 días sin copia → aviso. */
export const MS_ATRASADA = 2 * 24 * 3600 * 1000;

const RE_NOMBRE = /^spd-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.datos$/;

export const COPIAS_PREACTUALIZACION = 3;
export const COPIAS_PRERESTAURACION = 3;

export type OrigenCopia = 'automatica' | 'manual' | 'antes_actualizar' | 'antes_restaurar';
/** Ficha que acompaña a cada copia (`<copia>.json`): sin datos de pacientes; el contenido de la copia sigue cifrado. */
export interface MetaCopia { origen: OrigenCopia; motivo: string; versionApp: string; esquema: number | null }
export interface CopiaInfo { nombre: string; fecha: Date; meta?: MetaCopia | null }

const ORIGENES: OrigenCopia[] = ['automatica', 'manual', 'antes_actualizar', 'antes_restaurar'];
const rutaMeta = (ruta: string) => ruta + '.json';

function leerMeta(ruta: string): MetaCopia | null {
  try {
    const j = JSON.parse(readFileSync(rutaMeta(ruta), 'utf8')) as Record<string, unknown>;
    if (!ORIGENES.includes(j.origen as OrigenCopia)) return null;
    return {
      origen: j.origen as OrigenCopia, motivo: typeof j.motivo === 'string' ? j.motivo.slice(0, 200) : '',
      versionApp: typeof j.versionApp === 'string' ? j.versionApp.slice(0, 40) : '',
      esquema: typeof j.esquema === 'number' && Number.isInteger(j.esquema) && j.esquema >= 0 ? j.esquema : null,
    };
  } catch { return null; }
}

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
  for (const nombre of nombres) { const fecha = fechaDeNombre(nombre); if (fecha) r.push({ nombre, fecha, meta: leerMeta(join(carpeta, nombre)) }); }
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
  // Las copias de seguridad previas a actualizar o restaurar más recientes NO se borran por rotación.
  const protegerUltimas = (origen: OrigenCopia, n: number) => {
    for (const c of copias.filter(x => x.meta?.origen === origen).slice(-n)) conservar.add(c.nombre);
  };
  protegerUltimas('antes_actualizar', COPIAS_PREACTUALIZACION);
  protegerUltimas('antes_restaurar', COPIAS_PRERESTAURACION);
  const borradas: string[] = [];
  for (const c of copias) {
    if (conservar.has(c.nombre) || c.nombre === proteger) continue;
    try { rmSync(join(carpeta, c.nombre)); rmSync(rutaMeta(join(carpeta, c.nombre)), { force: true }); borradas.push(c.nombre); } catch { /* si no se puede borrar, se queda */ }
  }
  return borradas;
}

/** Copia el fichero cifrado a la carpeta (atómico: temporal + rename) y rota. Devuelve la ruta. */
export function crearCopiaFichero(origen: string, carpeta: string, ahora: Date, meta?: MetaCopia): string {
  if (!carpeta || !carpeta.trim()) throw new ErrorSpd('No hay carpeta de copias configurada.', 'SIN_CARPETA_COPIAS');
  try { mkdirSync(carpeta, { recursive: true }); }
  catch (e) { throw new ErrorSpd(`No se puede usar la carpeta de copias «${carpeta}»: ${e instanceof Error ? e.message : String(e)}`, 'CARPETA_COPIAS'); }
  // Si ya hay una copia de ese segundo (p. ej. la de «antes de restaurar»), se avanza al siguiente.
  let momento = ahora;
  for (let i = 0; i < 120 && listarCopias(carpeta).some(c => c.nombre === nombreCopia(momento)); i++) momento = new Date(momento.getTime() + 1000);
  const nombre = nombreCopia(momento);
  const destino = join(carpeta, nombre);
  const tmp = destino + '.tmp';
  try {
    copyFileSync(origen, tmp);
    if (statSync(tmp).size !== statSync(origen).size) throw new Error('la copia no tiene el mismo tamaño que el original');
    renameSync(tmp, destino);
    if (meta) { try { writeFileSync(rutaMeta(destino), JSON.stringify({ formato: 1, creada: ahora.toISOString(), ...meta })); } catch { /* sin ficha la copia sigue valiendo */ } }
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

/**
 * Ruta de una copia PROPIA a partir de su nombre: el nombre tiene que tener el patrón exacto (nada de rutas), el
 * fichero tiene que estar dentro de la carpeta (path.resolve) y ser un fichero normal (no enlace, ni carpeta).
 */
export function rutaDeCopia(carpeta: string, nombre: unknown): string {
  if (typeof nombre !== 'string' || !fechaDeNombre(nombre)) throw new ErrorSpd('Esa copia no existe.', 'COPIA_NO_ENCONTRADA');
  const base = resolve(carpeta);
  const ruta = resolve(base, nombre);
  if (!ruta.startsWith(base + sep)) throw new ErrorSpd('Esa copia no existe.', 'COPIA_NO_ENCONTRADA');
  try { if (!lstatSync(ruta).isFile()) throw 0; } catch { throw new ErrorSpd('Esa copia no existe o no es un fichero normal.', 'COPIA_NO_ENCONTRADA'); }
  return ruta;
}

/** Lee la copia. Vacía → COPIA_VACIA. */
export function leerFicheroCopia(ruta: string): Uint8Array {
  const b = new Uint8Array(readFileSync(ruta));
  if (b.length === 0) throw new ErrorSpd('La copia está vacía (0 bytes): no se puede restaurar.', 'COPIA_VACIA');
  return b;
}
