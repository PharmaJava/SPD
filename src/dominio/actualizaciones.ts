/**
 * Actualizaciones del programa: lógica PURA (sin red, disco ni interfaz).
 *
 * El programa consulta las «releases» públicas de UN solo repositorio (REPO_ACTUALIZACIONES) por HTTPS.
 * Aquí se decide, a partir del JSON que devuelve GitHub:
 *   · qué versión es más nueva (semver),
 *   · qué fichero es el instalador y cuál es la lista de sumas SHA-256,
 *   · qué direcciones se aceptan para descargar (sólo github.com/PharmaJava/SPD/releases/download/…),
 *   · qué se enseña en «Volver a una versión anterior».
 * Nunca se descarga ni se instala nada sin que la persona lo acepte: eso lo orquesta src/principal.
 */

export const REPO_ACTUALIZACIONES = 'PharmaJava/SPD';
export const URL_API_ULTIMA = `https://api.github.com/repos/${REPO_ACTUALIZACIONES}/releases/latest`;
export const URL_API_LISTA = `https://api.github.com/repos/${REPO_ACTUALIZACIONES}/releases?per_page=20`;
export const MAX_NOTAS = 4000;
export const NOMBRES_SUMAS = ['SHA256SUMS.txt', 'SHA256SUMS'] as const;

// ───────────────────────────── Versiones (semver) ─────────────────────────────

export interface VersionSemver { mayor: number; menor: number; parche: number; pre: string[] }

const RE_VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parsearVersion(v: unknown): VersionSemver | null {
  if (typeof v !== 'string' || v.length > 64) return null;
  const m = RE_VERSION.exec(v.trim());
  if (!m) return null;
  return { mayor: Number(m[1]), menor: Number(m[2]), parche: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** «v1.2.3» → «1.2.3» (sin metadatos de compilación). null si no es una versión. */
export function normalizarVersion(v: unknown): string | null {
  const p = parsearVersion(v);
  return p ? `${p.mayor}.${p.menor}.${p.parche}${p.pre.length ? '-' + p.pre.join('.') : ''}` : null;
}

function compararPre(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;              // sin sufijo > con sufijo (1.0.0 > 1.0.0-rc.1)
  if (!b.length) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (nx) return -1;              // los numéricos van antes que los alfanuméricos
    else if (ny) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** -1 si a < b, 0 si iguales, 1 si a > b. null si alguna no es una versión válida. */
export function compararVersiones(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parsearVersion(a), y = parsearVersion(b);
  if (!x || !y) return null;
  for (const k of ['mayor', 'menor', 'parche'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  return compararPre(x.pre, y.pre) as -1 | 0 | 1;
}

// ───────────────────────────── Direcciones permitidas ─────────────────────────────

const repoMin = REPO_ACTUALIZACIONES.toLowerCase();

function urlHttps(v: unknown): URL | null {
  if (typeof v !== 'string' || v.length > 600) return null;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  return u;
}

/** Descarga de un fichero de la release: SÓLO https://github.com/PharmaJava/SPD/releases/download/<etiqueta>/<fichero>. */
export function esUrlDescargaPermitida(url: unknown): boolean {
  const u = urlHttps(url);
  if (!u || u.hostname.toLowerCase() !== 'github.com') return false;
  const partes = u.pathname.split('/');       // ['', 'PharmaJava', 'SPD', 'releases', 'download', etiqueta, fichero]
  if (partes.length !== 7) return false;
  if (`${partes[1]}/${partes[2]}`.toLowerCase() !== repoMin || partes[3] !== 'releases' || partes[4] !== 'download') return false;
  return !!partes[5] && !!partes[6] && !partes.some(p => p === '..' || p === '.');
}

/** Saltos de redirección que se aceptan al descargar (GitHub reenvía a su almacén de ficheros). Siempre https. */
export function esUrlRedireccionPermitida(url: unknown): boolean {
  const u = urlHttps(url);
  if (!u) return false;
  const h = u.hostname.toLowerCase();
  return h === 'github.com' || h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com');
}

/** Página pública de la release (se construye con la etiqueta; no se fía del enlace que traiga el JSON). */
export function urlPaginaRelease(etiqueta: string): string {
  return `https://github.com/${REPO_ACTUALIZACIONES}/releases/tag/${encodeURIComponent(etiqueta)}`;
}

// ───────────────────────────── Releases ─────────────────────────────

export interface AssetRelease { nombre: string; url: string; tamano: number }
export interface ReleasePublicada {
  etiqueta: string; version: string; nombre: string; notas: string; publicadaEn: string | null;
  prerelease: boolean; urlPagina: string; assets: AssetRelease[];
}

const RE_NOMBRE_ASSET = /^[A-Za-z0-9._()+-]{1,200}$/;
const RE_ETIQUETA = /^[A-Za-z0-9._+-]{1,64}$/;

function textoSeguro(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // Fuera caracteres de control (salvo salto de línea y tabulador): se enseña como texto plano en un diálogo.
  const limpio = v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return limpio.length > max ? limpio.slice(0, max - 1).trimEnd() + '…' : limpio;
}

/** JSON de una release de GitHub → datos validados, o null (borrador, etiqueta rara, sin versión…). */
export function interpretarRelease(json: unknown): ReleasePublicada | null {
  if (typeof json !== 'object' || json === null) return null;
  const r = json as Record<string, unknown>;
  if (r.draft === true) return null;
  const etiqueta = typeof r.tag_name === 'string' ? r.tag_name : '';
  if (!RE_ETIQUETA.test(etiqueta)) return null;
  const version = normalizarVersion(etiqueta);
  if (!version) return null;
  const assets: AssetRelease[] = [];
  if (Array.isArray(r.assets)) {
    for (const a of r.assets) {
      if (typeof a !== 'object' || a === null) continue;
      const x = a as Record<string, unknown>;
      const nombre = typeof x.name === 'string' ? x.name : '';
      const url = typeof x.browser_download_url === 'string' ? x.browser_download_url : '';
      if (!RE_NOMBRE_ASSET.test(nombre) || !esUrlDescargaPermitida(url)) continue;
      // La dirección tiene que ser la de ESTA etiqueta y ESTE fichero (no un fichero de otra release).
      const partes = new URL(url).pathname.split('/');
      if (decodeURIComponent(partes[5]) !== etiqueta || decodeURIComponent(partes[6]) !== nombre) continue;
      assets.push({ nombre, url, tamano: typeof x.size === 'number' && Number.isFinite(x.size) && x.size >= 0 ? x.size : 0 });
    }
  }
  const fecha = typeof r.published_at === 'string' && !Number.isNaN(Date.parse(r.published_at)) ? new Date(r.published_at).toISOString() : null;
  return {
    etiqueta, version, nombre: textoSeguro(r.name, 120) || `SPD ${version}`, notas: textoSeguro(r.body, MAX_NOTAS),
    publicadaEn: fecha, prerelease: r.prerelease === true, urlPagina: urlPaginaRelease(etiqueta), assets,
  };
}

/** El instalador NSIS de ESA versión: `SPD-<versión>-win-x64.exe` (no el portable). */
export function elegirInstalador(rel: ReleasePublicada): AssetRelease | null {
  const esperado = `SPD-${rel.version}-win-x64.exe`.toLowerCase();
  return rel.assets.find(a => a.nombre.toLowerCase() === esperado) ?? null;
}

/** El fichero de sumas SHA-256 de la release. */
export function elegirSumas(rel: ReleasePublicada): AssetRelease | null {
  for (const n of NOMBRES_SUMAS) { const a = rel.assets.find(x => x.nombre.toLowerCase() === n.toLowerCase()); if (a) return a; }
  return null;
}

// ───────────────────────────── Sumas SHA-256 ─────────────────────────────

/**
 * `SHA256SUMS.txt` → mapa nombre → hash (minúsculas). Acepta «hash  nombre» y «hash *nombre», BOM y CRLF.
 * Si un mismo nombre aparece con dos hashes distintos, se descarta (ambiguo: mejor no instalar que adivinar).
 */
export function parsearSumas(texto: string): Map<string, string> {
  const r = new Map<string, string>();
  const ambiguos = new Set<string>();
  for (const linea of String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(\S.*?)\s*$/.exec(linea.trim());
    if (!m) continue;
    const nombre = m[2], hash = m[1].toLowerCase();
    const previo = r.get(nombre);
    if (previo !== undefined && previo !== hash) ambiguos.add(nombre);
    r.set(nombre, hash);
  }
  for (const n of ambiguos) r.delete(n);
  return r;
}

export function sumaDe(sumas: Map<string, string>, nombre: string): string | null {
  const directo = sumas.get(nombre);
  if (directo) return directo;
  for (const [k, v] of sumas) if (k.toLowerCase() === nombre.toLowerCase()) return v;
  return null;
}

export function coincideSuma(esperada: string | null, calculada: string): boolean {
  return !!esperada && /^[0-9a-f]{64}$/i.test(esperada) && esperada.toLowerCase() === calculada.toLowerCase();
}

// ───────────────────────────── Decisión ─────────────────────────────

export type EstadoBusqueda = 'al_dia' | 'disponible' | 'ignorada' | 'sin_instalador';

export interface DecisionActualizacion {
  estado: EstadoBusqueda;
  version: string | null;
  release: ReleasePublicada | null;
  instalador: AssetRelease | null;
  sumas: AssetRelease | null;
}

/**
 * ¿Hay una versión nueva que ofrecer?
 *  - Las pre-versiones nunca se ofrecen.
 *  - «No volver a avisar de esta versión» sólo calla el aviso AUTOMÁTICO del arranque (`manual` = la persona pulsó
 *    «Buscar actualizaciones»: entonces se le enseña igualmente).
 *  - Si la release existe pero aún no tiene instalador o sumas (se está subiendo), no se ofrece: sin sumas no se instala.
 */
export function decidirActualizacion(op: { actual: string; release: ReleasePublicada | null; versionIgnorada?: string | null; manual: boolean }): DecisionActualizacion {
  const nada: DecisionActualizacion = { estado: 'al_dia', version: null, release: null, instalador: null, sumas: null };
  const rel = op.release;
  if (!rel || rel.prerelease) return nada;
  const c = compararVersiones(rel.version, op.actual);
  if (c === null || c <= 0) return nada;
  const instalador = elegirInstalador(rel), sumas = elegirSumas(rel);
  const base = { version: rel.version, release: rel, instalador, sumas };
  if (!instalador || !sumas) return { estado: 'sin_instalador', ...base };
  if (!op.manual && op.versionIgnorada && compararVersiones(op.versionIgnorada, rel.version) === 0) return { estado: 'ignorada', ...base };
  return { estado: 'disponible', ...base };
}

// ───────────────────────────── Preferencias ─────────────────────────────

export interface PreferenciasActualizacion { comprobarAlArrancar: boolean; versionIgnorada: string | null; ultimaComprobacion: string | null }
export const PREFERENCIAS_POR_DEFECTO: PreferenciasActualizacion = { comprobarAlArrancar: true, versionIgnorada: null, ultimaComprobacion: null };

/** Lo que haya en el fichero de preferencias → preferencias válidas (lo que no cuadre, al valor por defecto). */
export function normalizarPreferencias(raw: unknown): PreferenciasActualizacion {
  const r = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  return {
    comprobarAlArrancar: typeof r.comprobarAlArrancar === 'boolean' ? r.comprobarAlArrancar : true,
    versionIgnorada: normalizarVersion(r.versionIgnorada),
    ultimaComprobacion: typeof r.ultimaComprobacion === 'string' && !Number.isNaN(Date.parse(r.ultimaComprobacion)) ? new Date(r.ultimaComprobacion).toISOString() : null,
  };
}

// ───────────────────────────── Volver a una versión anterior ─────────────────────────────

export interface VersionPublicada {
  version: string; etiqueta: string; fecha: string | null; urlPagina: string;
  esActual: boolean; esAnterior: boolean;
  instalador: { nombre: string; url: string; tamano: number; sha256: string | null } | null;
}

/**
 * Lista de versiones publicadas (más nueva primero), sin borradores ni pre-versiones, con el enlace al instalador y su
 * suma SHA-256 si se pudo leer. `sumasPorEtiqueta` es opcional: sin ella, `sha256` queda en null (se dice «no disponible»).
 */
export function listarVersionesPublicadas(releases: ReleasePublicada[], actual: string, sumasPorEtiqueta: Map<string, Map<string, string>> = new Map()): VersionPublicada[] {
  const vistas = new Set<string>();
  const salida: VersionPublicada[] = [];
  for (const rel of releases) {
    if (rel.prerelease || vistas.has(rel.version)) continue;
    vistas.add(rel.version);
    const inst = elegirInstalador(rel);
    const cmp = compararVersiones(rel.version, actual);
    salida.push({
      version: rel.version, etiqueta: rel.etiqueta, fecha: rel.publicadaEn, urlPagina: rel.urlPagina,
      esActual: cmp === 0, esAnterior: cmp === -1,
      instalador: inst ? { nombre: inst.nombre, url: inst.url, tamano: inst.tamano, sha256: sumaDe(sumasPorEtiqueta.get(rel.etiqueta) ?? new Map(), inst.nombre) } : null,
    });
  }
  return salida.sort((a, b) => compararVersiones(b.version, a.version) ?? 0);
}
