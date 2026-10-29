/**
 * Cifrado del fichero de datos y claves (doc 10).
 *
 * Esquema:
 *   contraseña ──scrypt(N=2^15,r=8,p=1,sal)──▶ clave derivada (32 B)
 *   clave de datos (32 B aleatorios) ──AES-256-GCM(clave derivada)──▶ «envoltura»
 *   base de datos (bytes de SQLite) ──AES-256-GCM(clave de datos, iv nuevo en cada guardado)──▶ carga
 *
 * Cambiar la contraseña sólo rehace la envoltura. La clave de recuperación ES la clave de
 * datos (src/dominio/clave-recuperacion.ts), por eso se puede abrir sin contraseña.
 *
 * Formato binario de `spd.datos`:
 *   0  magic «SPDDATOS» (8 B)
 *   8  versión (1 B) = 1
 *   9  longitud de la cabecera JSON (u32 big-endian)
 *   13 cabecera JSON (UTF-8): { kdf:{alg,n,r,p,sal}, envoltura:{iv,tag,cifrado}, ivCarga }  (base64)
 *   …  etiqueta GCM de la carga (16 B)
 *   …  carga cifrada (resto del fichero)
 * La cabecera ENTERA (magic, versión, longitud y JSON) va como datos adicionales autenticados (AAD)
 * de la carga y de la envoltura: cambiar un solo byte de cualquier parte hace fallar el GCM.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ErrorSpd } from './contexto.ts';

const MAGIC = Buffer.from('SPDDATOS', 'latin1');
export const VERSION_FORMATO = 1;

export const KDF_POR_DEFECTO = { n: 1 << 15, r: 8, p: 1 } as const;
export interface ParametrosKdf { n: number; r: number; p: number }

/** Techo de los parámetros que se aceptan al LEER un fichero (evita que un fichero hostil agote la memoria). */
const KDF_MAX_N = 1 << 20;
const MAXMEM = 256 * 1024 * 1024;

export const COD_CONTRASENA = 'CONTRASENA_INCORRECTA';
export const COD_FICHERO = 'FICHERO_CORRUPTO';

interface Cabecera {
  kdf: { alg: 'scrypt'; n: number; r: number; p: number; sal: string };
  envoltura: { iv: string; tag: string; cifrado: string };
  ivCarga: string;
}

export interface AbiertoFichero { bytesDb: Uint8Array; claveDatos: Uint8Array }

// ───────────────────────────── utilidades ─────────────────────────────

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const deB64 = (s: string) => Buffer.from(s, 'base64');

function derivar(contrasena: string, sal: Uint8Array, kdf: ParametrosKdf): Buffer {
  return scryptSync(Buffer.from(contrasena.normalize('NFKC'), 'utf8'), sal, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: MAXMEM });
}

function cifrarGcm(clave: Uint8Array, iv: Uint8Array, claro: Uint8Array, aad: Uint8Array): { tag: Buffer; cifrado: Buffer } {
  const c = createCipheriv('aes-256-gcm', clave, iv);
  c.setAAD(aad);
  const cifrado = Buffer.concat([c.update(claro), c.final()]);
  return { tag: c.getAuthTag(), cifrado };
}

/** Devuelve null si la etiqueta no cuadra (clave errónea o datos manipulados). */
function descifrarGcm(clave: Uint8Array, iv: Uint8Array, tag: Uint8Array, cifrado: Uint8Array, aad: Uint8Array): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', clave, iv);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(cifrado), d.final()]);
  } catch { return null; }
}

function corrupto(detalle: string): ErrorSpd {
  return new ErrorSpd(`El fichero de datos está dañado o ha sido modificado (${detalle}).`, COD_FICHERO);
}

interface Parseado { cabecera: Cabecera; aad: Buffer; tagCarga: Buffer; cifradoCarga: Buffer }

function parsear(fichero: Uint8Array): Parseado {
  const f = Buffer.from(fichero.buffer, fichero.byteOffset, fichero.byteLength);
  if (f.length < 13 + 16 || !f.subarray(0, 8).equals(MAGIC)) throw corrupto('no es un fichero de datos de SPD');
  if (f[8] !== VERSION_FORMATO) throw new ErrorSpd(`Versión de fichero no soportada (${f[8]}).`, 'VERSION_FICHERO');
  const lon = f.readUInt32BE(9);
  if (lon < 2 || lon > 4096 || 13 + lon + 16 > f.length) throw corrupto('cabecera incoherente');
  const aad = f.subarray(0, 13 + lon);
  let cabecera: Cabecera;
  try { cabecera = JSON.parse(f.subarray(13, 13 + lon).toString('utf8')) as Cabecera; }
  catch { throw corrupto('cabecera ilegible'); }
  const k = cabecera?.kdf, e = cabecera?.envoltura;
  const entero = (x: unknown) => typeof x === 'number' && Number.isInteger(x);
  if (!k || !e || k.alg !== 'scrypt' || !entero(k.n) || !entero(k.r) || !entero(k.p)
    || typeof k.sal !== 'string' || typeof e.iv !== 'string' || typeof e.tag !== 'string' || typeof e.cifrado !== 'string'
    || typeof cabecera.ivCarga !== 'string') throw corrupto('cabecera incompleta');
  if (k.n < 2 || k.n > KDF_MAX_N || (k.n & (k.n - 1)) !== 0 || k.r < 1 || k.r > 32 || k.p < 1 || k.p > 16) throw corrupto('parámetros de derivación fuera de rango');
  if (deB64(cabecera.ivCarga).length !== 12 || deB64(e.iv).length !== 12 || deB64(e.tag).length !== 16 || deB64(e.cifrado).length !== 32 || deB64(k.sal).length < 16) throw corrupto('cabecera con tamaños no válidos');
  return { cabecera, aad, tagCarga: f.subarray(13 + lon, 13 + lon + 16), cifradoCarga: f.subarray(13 + lon + 16) };
}

function construir(cabecera: Cabecera, claveDatos: Uint8Array, bytesDb: Uint8Array): Uint8Array {
  const ivCarga = randomBytes(12);                       // iv NUEVO en cada guardado
  const cab = { ...cabecera, ivCarga: b64(ivCarga) };
  const json = Buffer.from(JSON.stringify(cab), 'utf8');
  const prefijo = Buffer.alloc(13);
  MAGIC.copy(prefijo, 0); prefijo[8] = VERSION_FORMATO; prefijo.writeUInt32BE(json.length, 9);
  const aad = Buffer.concat([prefijo, json]);
  const { tag, cifrado } = cifrarGcm(claveDatos, ivCarga, bytesDb, aad);
  return Buffer.concat([aad, tag, cifrado]);
}

function envolver(claveDatos: Uint8Array, contrasena: string, kdf: ParametrosKdf): Cabecera {
  const sal = randomBytes(16);
  const iv = randomBytes(12);
  const derivada = derivar(contrasena, sal, kdf);
  // La envoltura se autentica con la sal y los parámetros como AAD: manipularlos hace fallar el tag.
  const aad = Buffer.from(`SPD-envoltura|${kdf.n}|${kdf.r}|${kdf.p}|${b64(sal)}`, 'utf8');
  const { tag, cifrado } = cifrarGcm(derivada, iv, claveDatos, aad);
  derivada.fill(0);
  return { kdf: { alg: 'scrypt', ...kdf, sal: b64(sal) }, envoltura: { iv: b64(iv), tag: b64(tag), cifrado: b64(cifrado) }, ivCarga: '' };
}

function desenvolver(c: Cabecera, contrasena: string): Buffer | null {
  const kdf = { n: c.kdf.n, r: c.kdf.r, p: c.kdf.p };
  const derivada = derivar(contrasena, deB64(c.kdf.sal), kdf);
  const aad = Buffer.from(`SPD-envoltura|${kdf.n}|${kdf.r}|${kdf.p}|${c.kdf.sal}`, 'utf8');
  const clave = descifrarGcm(derivada, deB64(c.envoltura.iv), deB64(c.envoltura.tag), deB64(c.envoltura.cifrado), aad);
  derivada.fill(0);
  return clave;
}

function abrirCarga(p: Parseado, claveDatos: Uint8Array): Uint8Array {
  if (claveDatos.length !== 32) throw new ErrorSpd('La clave de datos debe tener 32 bytes.', 'CLAVE_INVALIDA');
  const claro = descifrarGcm(claveDatos, deB64(p.cabecera.ivCarga), p.tagCarga, p.cifradoCarga, p.aad);
  if (!claro) throw corrupto('la autenticación del contenido ha fallado');
  return new Uint8Array(claro);
}

// ───────────────────────────── API del fichero ─────────────────────────────

/** Crea un fichero nuevo con una clave de datos aleatoria. Devuelve también la clave (para la recuperación). */
export function crearAlmacenNuevo(contrasena: string, bytesDb: Uint8Array, kdf: ParametrosKdf = KDF_POR_DEFECTO): { fichero: Uint8Array; claveDatos: Uint8Array } {
  if (typeof contrasena !== 'string' || contrasena.length === 0) throw new ErrorSpd('La contraseña no puede estar vacía.', 'CONTRASENA_VACIA');
  const claveDatos = new Uint8Array(randomBytes(32));
  const cabecera = envolver(claveDatos, contrasena, kdf);
  return { fichero: construir(cabecera, claveDatos, bytesDb), claveDatos };
}

/** Abre con la contraseña. Contraseña errónea → ErrorSpd CONTRASENA_INCORRECTA; fichero dañado → FICHERO_CORRUPTO. */
export function abrirConContrasena(fichero: Uint8Array, contrasena: string): AbiertoFichero {
  const p = parsear(fichero);
  const clave = desenvolver(p.cabecera, String(contrasena ?? ''));
  if (!clave) throw new ErrorSpd('Contraseña incorrecta (o el fichero de datos está dañado).', COD_CONTRASENA);
  const claveDatos = new Uint8Array(clave);
  clave.fill(0);
  try { return { bytesDb: abrirCarga(p, claveDatos), claveDatos }; }
  catch (e) { claveDatos.fill(0); throw e; }
}

/** Abre con la clave de datos (la de recuperación). Clave equivocada o fichero manipulado → FICHERO_CORRUPTO. */
export function abrirConClaveDeDatos(fichero: Uint8Array, claveDatos: Uint8Array): AbiertoFichero {
  const p = parsear(fichero);
  const copia = new Uint8Array(claveDatos);
  try { return { bytesDb: abrirCarga(p, copia), claveDatos: copia }; }
  catch (e) { copia.fill(0); throw e; }
}

/** Cambia la contraseña: nueva envoltura (sal nueva) y carga recifrada con iv nuevo. Comprueba antes que la clave abre el fichero. */
export function reenvolver(fichero: Uint8Array, claveDatos: Uint8Array, nuevaContrasena: string, kdf: ParametrosKdf = KDF_POR_DEFECTO): Uint8Array {
  if (typeof nuevaContrasena !== 'string' || nuevaContrasena.length === 0) throw new ErrorSpd('La contraseña no puede estar vacía.', 'CONTRASENA_VACIA');
  const { bytesDb } = abrirConClaveDeDatos(fichero, claveDatos);
  return construir(envolver(claveDatos, nuevaContrasena, kdf), claveDatos, bytesDb);
}

/** Guarda una base nueva con la misma envoltura y un iv nuevo. Se comprueba antes que la clave corresponde al fichero. */
export function guardarCarga(fichero: Uint8Array, claveDatos: Uint8Array, bytesDb: Uint8Array): Uint8Array {
  const p = parsear(fichero);
  abrirCarga(p, claveDatos);
  return construir(p.cabecera, claveDatos, bytesDb);
}

/** ¿Tiene pinta de fichero SPD? (sólo la cabecera mágica; no autentica nada). */
export function pareceFicheroSpd(fichero: Uint8Array): boolean {
  return fichero.length >= 13 + 16 && Buffer.from(fichero.buffer, fichero.byteOffset, 8).equals(MAGIC) && fichero[8] === VERSION_FORMATO;
}

// ───────────────────────────── PIN de usuario ─────────────────────────────

const PIN_N = 1 << 14;

/** `scrypt$N$r$p$sal$hash` (base64). Sal propia por usuario. */
export function hashPin(pin: string): string {
  const sal = randomBytes(16);
  const h = scryptSync(Buffer.from(pin.normalize('NFKC'), 'utf8'), sal, 32, { N: PIN_N, r: 8, p: 1, maxmem: MAXMEM });
  return `scrypt$${PIN_N}$8$1$${b64(sal)}$${b64(h)}`;
}

/** Comparación en tiempo constante. Un hash mal formado nunca verifica. */
export function verificarPin(pin: string, almacenado: string): boolean {
  try {
    const partes = String(almacenado).split('$');
    if (partes.length !== 6 || partes[0] !== 'scrypt') return false;
    const n = Number(partes[1]), r = Number(partes[2]), p = Number(partes[3]);
    if (!Number.isInteger(n) || n < 2 || n > KDF_MAX_N || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
    const esperado = deB64(partes[5]);
    if (esperado.length !== 32) return false;
    const h = scryptSync(Buffer.from(String(pin).normalize('NFKC'), 'utf8'), deB64(partes[4]), 32, { N: n, r, p, maxmem: MAXMEM });
    return timingSafeEqual(h, esperado);
  } catch { return false; }
}

// ───────────────────────────── Espera tras fallos ─────────────────────────────

/** Segundos de espera tras `fallos` fallos seguidos de contraseña: 1, 2, 4, 8… hasta 60. */
export function esperaContrasena(fallos: number): number {
  if (fallos <= 0) return 0;
  return Math.min(60, 2 ** Math.min(fallos - 1, 10));
}

export const PIN_MAX_FALLOS = 5;
export const PIN_BLOQUEO_S = 30;

/**
 * Cuenta fallos seguidos y dice cuántos segundos hay que esperar. En memoria; reloj inyectable (ms).
 * `politica(fallos)` devuelve los segundos de espera que provoca el fallo número `fallos`.
 */
export class LimitadorFallos {
  private fallos = 0;
  private hasta = 0;
  private politica: (fallos: number) => number;
  private reloj: () => number;
  private reiniciarAlBloquear: boolean;
  constructor(politica: (fallos: number) => number, reloj: () => number, reiniciarAlBloquear = false) {
    this.politica = politica; this.reloj = reloj; this.reiniciarAlBloquear = reiniciarAlBloquear;
  }
  /** Segundos que faltan (redondeados hacia arriba); 0 si ya se puede intentar. */
  espera(): number { return Math.max(0, Math.ceil((this.hasta - this.reloj()) / 1000)); }
  registrarFallo(): number {
    this.fallos++;
    const s = this.politica(this.fallos);
    this.hasta = s > 0 ? this.reloj() + s * 1000 : 0;
    if (s > 0 && this.reiniciarAlBloquear) this.fallos = 0;
    return s;
  }
  reiniciar(): void { this.fallos = 0; this.hasta = 0; }
  get seguidos(): number { return this.fallos; }
}

export const limitadorContrasena = (reloj: () => number) => new LimitadorFallos(esperaContrasena, reloj);
/** 5 fallos seguidos → 30 s de bloqueo; pasado el bloqueo el contador vuelve a cero. */
export const limitadorPin = (reloj: () => number) => new LimitadorFallos(f => (f >= PIN_MAX_FALLOS ? PIN_BLOQUEO_S : 0), reloj, true);
