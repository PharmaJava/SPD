/**
 * Cifrado del fichero de datos y claves (doc 10).
 *
 * Esquema:
 *   contraseña ──scrypt(N=2^17,r=8,p=1,sal)──▶ clave derivada (32 B)   (los ficheros antiguos con N=2^15 se siguen leyendo
 *                                                                      y se migran al cambiar la contraseña o al desbloquear)
 *   clave de datos (32 B aleatorios) ──AES-256-GCM(clave derivada)──▶ «envoltura»
 *   base de datos (bytes de SQLite) ──AES-256-GCM(clave de datos, iv nuevo en cada guardado)──▶ carga
 *
 * Cambiar la contraseña ROTA la clave de datos (clave nueva, base recifrada, envoltura nueva y clave de recuperación nueva):
 * así quien conociera la contraseña o la clave de recuperación anteriores no abre el fichero nuevo. Recuperar con la clave
 * de recuperación o migrar los parámetros de scrypt sólo rehacen la envoltura (la clave de datos es la misma).
 * La clave de recuperación ES la clave de datos (src/dominio/clave-recuperacion.ts), por eso se puede abrir sin contraseña.
 *
 * Segunda forma de guardar la clave de datos («sin contraseña de arranque», opcional): en vez de scrypt(contraseña) la clave de
 * datos se envuelve con el almacén del sistema operativo (en Windows, DPAPI vía Electron safeStorage: ligada al USUARIO de
 * Windows). La base sigue cifrada en disco con AES-256-GCM y la misma clave de datos, y la clave de recuperación sigue valiendo
 * (ES la clave de datos). Se accede al almacén del sistema a través de la interfaz `ProtectorClave`, que se inyecta: este módulo
 * no depende de Electron y se prueba con un doble. Riesgo asumido: quien use la sesión de Windows de ese usuario (o un
 * proceso suyo) puede abrir los datos; no protege frente a eso, sí frente a quien se lleve el disco o el fichero.
 *
 * Formato binario de `spd.datos`:
 *   0  magic «SPDDATOS» (8 B)
 *   8  versión (1 B): 1 = envuelto con contraseña; 2 = envuelto con el sistema operativo
 *   9  longitud de la cabecera JSON (u32 big-endian)
 *   13 cabecera JSON (UTF-8), según el tipo de envoltura (`tipo`, explícito; si falta es «contrasena»):
 *        contrasena: { tipo, kdf:{alg,n,r,p,sal}, envoltura:{iv,tag,cifrado}, ivCarga }  (base64)
 *        sistema:    { tipo, sistema:{alg:'safeStorage',cifrado}, ivCarga }
 *   …  etiqueta GCM de la carga (16 B)
 *   …  carga cifrada (resto del fichero)
 * La cabecera ENTERA (magic, versión, longitud y JSON) va como datos adicionales autenticados (AAD)
 * de la carga y de la envoltura: cambiar un solo byte de cualquier parte hace fallar el GCM.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ErrorSpd } from './contexto.ts';

const MAGIC = Buffer.from('SPDDATOS', 'latin1');
/** Versión del fichero envuelto con contraseña (la de siempre). */
export const VERSION_FORMATO = 1;
/** Versión del fichero envuelto con el sistema operativo: una versión anterior del programa dice «versión no soportada» en vez de «dañado». */
export const VERSION_FORMATO_SISTEMA = 2;
export type TipoEnvoltura = 'contrasena' | 'sistema';

/**
 * Almacén de claves del sistema operativo (Electron `safeStorage`: DPAPI en Windows). Sólo existe en el proceso principal; los
 * servicios reciben una implementación inyectada (o un doble en las pruebas).
 */
export interface ProtectorClave {
  /** ¿Puede este equipo proteger claves ahora (y no con un respaldo en claro)? */
  disponible(): boolean;
  /** Por qué no está disponible, en lenguaje llano (para enseñarlo tal cual). */
  motivoNoDisponible(): string;
  /** Cifra bytes con el sistema; lanza si no puede. */
  cifrar(claro: Uint8Array): Uint8Array;
  /** Descifra lo cifrado antes; lanza si no puede (otro usuario de Windows, otro equipo, almacén reinstalado…). */
  descifrar(cifrado: Uint8Array): Uint8Array;
}

/** Parámetros para guardar y cambiar la contraseña. Los ficheros antiguos (N=2^15) se leen y se migran a estos. */
export const KDF_POR_DEFECTO = { n: 1 << 17, r: 8, p: 1 } as const;
export interface ParametrosKdf { n: number; r: number; p: number }

/** Techo de los parámetros que se aceptan al LEER un fichero (evita que un fichero hostil agote la memoria o el tiempo). */
export const KDF_MAX_N = 1 << 18;
export const KDF_MAX_P = 4;
const KDF_MAX_R = 32;
/** Memoria máxima que se deja usar a scrypt (N=2^18, r=8 necesita ~256 MiB). */
const MAXMEM = 512 * 1024 * 1024;
/** Memoria que necesita scrypt (aprox., la de OpenSSL: 128·r·(N+p+2)). */
const memoriaScrypt = (k: ParametrosKdf) => 128 * k.r * (k.n + k.p + 2);
const enteroPos = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1;
/** ¿Se aceptan estos parámetros al leer? N potencia de 2 en [2, 2^18], r ≤ 32, p ≤ 4 y memoria dentro del tope. */
export function kdfAceptable(k: ParametrosKdf): boolean {
  return enteroPos(k.n) && enteroPos(k.r) && enteroPos(k.p) && k.n >= 2 && k.n <= KDF_MAX_N && (k.n & (k.n - 1)) === 0
    && k.r <= KDF_MAX_R && k.p <= KDF_MAX_P && memoriaScrypt(k) <= MAXMEM;
}

export const COD_CONTRASENA = 'CONTRASENA_INCORRECTA';
export const COD_FICHERO = 'FICHERO_CORRUPTO';
/** No hay (o no funciona) el almacén del sistema operativo: no se activa el modo sin contraseña, o no se puede abrir con él. */
export const COD_PROTECTOR = 'PROTECTOR_NO_DISPONIBLE';
/** Los datos están ligados a otro usuario de Windows u otro equipo: sólo se abren con la clave de recuperación. */
export const COD_CLAVE_SISTEMA = 'CLAVE_SISTEMA_ILEGIBLE';
/** Se pidió abrir con contraseña unos datos que no la tienen, o al revés. */
export const COD_SIN_CONTRASENA = 'SIN_CONTRASENA';
export const COD_CON_CONTRASENA = 'CON_CONTRASENA';

interface CabeceraContrasena {
  tipo?: 'contrasena';
  kdf: { alg: 'scrypt'; n: number; r: number; p: number; sal: string };
  envoltura: { iv: string; tag: string; cifrado: string };
  ivCarga: string;
}
interface CabeceraSistema {
  tipo: 'sistema';
  sistema: { alg: 'safeStorage'; cifrado: string };
  ivCarga: string;
}
type Cabecera = CabeceraContrasena | CabeceraSistema;
const esSistema = (c: Cabecera): c is CabeceraSistema => c.tipo === 'sistema';
/** Máximo (en bytes) de la clave envuelta por el sistema: un blob de DPAPI ronda los 200 B. */
const SISTEMA_MAX_B = 2048;
/** Bytes del principio del fichero que bastan para leer la cabecera (13 + cabecera máx. 4096 + etiqueta 16). */
export const BYTES_CABECERA = 13 + 4096 + 16;

export interface AbiertoFichero { bytesDb: Uint8Array; claveDatos: Uint8Array }

// ───────────────────────────── utilidades ─────────────────────────────

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const deB64 = (s: string) => Buffer.from(s, 'base64');

function derivar(contrasena: string, sal: Uint8Array, kdf: ParametrosKdf): Buffer {
  // Nunca un error interno de OpenSSL hacia fuera: parámetros fuera de rango o de memoria → ErrorSpd claro.
  if (!kdfAceptable(kdf)) throw new ErrorSpd(`Los parámetros de derivación de la clave (N=${kdf.n}, r=${kdf.r}, p=${kdf.p}) están fuera de lo aceptado: el fichero está dañado o ha sido modificado.`, COD_FICHERO);
  try { return scryptSync(Buffer.from(contrasena.normalize('NFKC'), 'utf8'), sal, 32, { N: kdf.n, r: kdf.r, p: kdf.p, maxmem: MAXMEM }); }
  catch { throw new ErrorSpd('No se pudo derivar la clave con los parámetros del fichero (memoria insuficiente o parámetros no válidos).', COD_FICHERO); }
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
  const ver = f[8];
  if (ver !== VERSION_FORMATO && ver !== VERSION_FORMATO_SISTEMA) throw new ErrorSpd(`Versión de fichero no soportada (${ver}).`, 'VERSION_FICHERO');
  const lon = f.readUInt32BE(9);
  if (lon < 2 || lon > 4096 || 13 + lon + 16 > f.length) throw corrupto('cabecera incoherente');
  const aad = f.subarray(0, 13 + lon);
  let cabecera: Cabecera;
  try { cabecera = JSON.parse(f.subarray(13, 13 + lon).toString('utf8')) as Cabecera; }
  catch { throw corrupto('cabecera ilegible'); }
  if (!cabecera || typeof cabecera !== 'object') throw corrupto('cabecera incompleta');
  const tipo = cabecera.tipo ?? 'contrasena';
  if (tipo !== 'contrasena' && tipo !== 'sistema') throw corrupto('tipo de envoltura desconocido');
  // La versión del fichero y el tipo de envoltura tienen que decir lo mismo (ambos van autenticados en el AAD).
  if ((ver === VERSION_FORMATO_SISTEMA) !== (tipo === 'sistema')) throw corrupto('tipo de envoltura incoherente con la versión');
  if (typeof cabecera.ivCarga !== 'string' || deB64(cabecera.ivCarga).length !== 12) throw corrupto('cabecera con tamaños no válidos');
  if (esSistema(cabecera)) {
    const s = cabecera.sistema;
    if (!s || s.alg !== 'safeStorage' || typeof s.cifrado !== 'string') throw corrupto('cabecera incompleta');
    const n = deB64(s.cifrado).length;
    if (n < 16 || n > SISTEMA_MAX_B) throw corrupto('cabecera con tamaños no válidos');
    return { cabecera, aad, tagCarga: f.subarray(13 + lon, 13 + lon + 16), cifradoCarga: f.subarray(13 + lon + 16) };
  }
  const k = cabecera.kdf, e = cabecera.envoltura;
  const entero = (x: unknown) => typeof x === 'number' && Number.isInteger(x);
  if (!k || !e || k.alg !== 'scrypt' || !entero(k.n) || !entero(k.r) || !entero(k.p)
    || typeof k.sal !== 'string' || typeof e.iv !== 'string' || typeof e.tag !== 'string' || typeof e.cifrado !== 'string') throw corrupto('cabecera incompleta');
  if (!kdfAceptable({ n: k.n, r: k.r, p: k.p })) throw corrupto('parámetros de derivación fuera de rango');
  if (deB64(e.iv).length !== 12 || deB64(e.tag).length !== 16 || deB64(e.cifrado).length !== 32 || deB64(k.sal).length < 16) throw corrupto('cabecera con tamaños no válidos');
  return { cabecera, aad, tagCarga: f.subarray(13 + lon, 13 + lon + 16), cifradoCarga: f.subarray(13 + lon + 16) };
}

function construir(cabecera: Cabecera, claveDatos: Uint8Array, bytesDb: Uint8Array): Uint8Array {
  const ivCarga = randomBytes(12);                       // iv NUEVO en cada guardado
  const cab = { ...cabecera, ivCarga: b64(ivCarga) };
  const json = Buffer.from(JSON.stringify(cab), 'utf8');
  const prefijo = Buffer.alloc(13);
  MAGIC.copy(prefijo, 0); prefijo[8] = esSistema(cabecera) ? VERSION_FORMATO_SISTEMA : VERSION_FORMATO; prefijo.writeUInt32BE(json.length, 9);
  const aad = Buffer.concat([prefijo, json]);
  const { tag, cifrado } = cifrarGcm(claveDatos, ivCarga, bytesDb, aad);
  return Buffer.concat([aad, tag, cifrado]);
}

function envolver(claveDatos: Uint8Array, contrasena: string, kdf: ParametrosKdf): CabeceraContrasena {
  const sal = randomBytes(16);
  const iv = randomBytes(12);
  const derivada = derivar(contrasena, sal, kdf);
  // La envoltura se autentica con la sal y los parámetros como AAD: manipularlos hace fallar el tag.
  const aad = Buffer.from(`SPD-envoltura|${kdf.n}|${kdf.r}|${kdf.p}|${b64(sal)}`, 'utf8');
  const { tag, cifrado } = cifrarGcm(derivada, iv, claveDatos, aad);
  derivada.fill(0);
  return { tipo: 'contrasena', kdf: { alg: 'scrypt', ...kdf, sal: b64(sal) }, envoltura: { iv: b64(iv), tag: b64(tag), cifrado: b64(cifrado) }, ivCarga: '' };
}

function desenvolver(c: CabeceraContrasena, contrasena: string): Buffer | null {
  const kdf = { n: c.kdf.n, r: c.kdf.r, p: c.kdf.p };
  const derivada = derivar(contrasena, deB64(c.kdf.sal), kdf);
  const aad = Buffer.from(`SPD-envoltura|${kdf.n}|${kdf.r}|${kdf.p}|${c.kdf.sal}`, 'utf8');
  const clave = descifrarGcm(derivada, deB64(c.envoltura.iv), deB64(c.envoltura.tag), deB64(c.envoltura.cifrado), aad);
  derivada.fill(0);
  return clave;
}

/** Mensaje cuando el sistema operativo no puede abrir lo que él mismo guardó. */
const TEXTO_CLAVE_SISTEMA = 'Estos datos están ligados al usuario de Windows (y al equipo) con que se crearon, y este usuario no puede abrirlos. Si los has copiado a otro equipo o los usa otro usuario de Windows, introduce la clave de recuperación.';

function sinProtector(p: ProtectorClave | undefined | null): ProtectorClave {
  if (!p) throw new ErrorSpd('Este programa no tiene acceso al almacén de claves de Windows, así que no puede abrir ni crear datos sin contraseña.', COD_PROTECTOR);
  return p;
}

/**
 * Envuelve la clave de datos con el sistema operativo. Comprueba ANTES de dar nada por bueno que lo cifrado se puede volver a
 * descifrar y da la misma clave: un protector que cifra pero no descifra dejaría los datos sin forma de abrirse.
 */
function envolverConProtector(claveDatos: Uint8Array, protector: ProtectorClave | undefined | null): CabeceraSistema {
  const p = sinProtector(protector);
  let disponible = false;
  try { disponible = p.disponible(); } catch { /* se trata como no disponible */ }
  if (!disponible) {
    let motivo = '';
    try { motivo = p.motivoNoDisponible(); } catch { /* sin motivo */ }
    throw new ErrorSpd(`No se puede proteger la clave con Windows: ${motivo || 'el almacén de claves del sistema no está disponible'}.`, COD_PROTECTOR);
  }
  let cifrado: Uint8Array;
  try { cifrado = p.cifrar(claveDatos); }
  catch { throw new ErrorSpd('Windows no ha podido proteger la clave de los datos. No se ha cambiado nada.', COD_PROTECTOR); }
  let vuelta: Uint8Array | null = null;
  try { vuelta = p.descifrar(cifrado); } catch { /* se comprueba abajo */ }
  const bien = !!vuelta && vuelta.length === claveDatos.length && timingSafeEqual(Buffer.from(vuelta), Buffer.from(claveDatos));
  vuelta?.fill(0);
  if (!bien || cifrado.length < 16 || cifrado.length > SISTEMA_MAX_B) throw new ErrorSpd('Windows protege la clave pero no consigue recuperarla (comprobación fallida). No se ha cambiado nada.', COD_PROTECTOR);
  return { tipo: 'sistema', sistema: { alg: 'safeStorage', cifrado: b64(cifrado) }, ivCarga: '' };
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

/** Crea un fichero nuevo SIN contraseña de arranque: la clave de datos (aleatoria) queda envuelta con el sistema operativo. */
export function crearAlmacenNuevoSistema(protector: ProtectorClave | undefined | null, bytesDb: Uint8Array): { fichero: Uint8Array; claveDatos: Uint8Array } {
  const claveDatos = new Uint8Array(randomBytes(32));
  try { return { fichero: construir(envolverConProtector(claveDatos, protector), claveDatos, bytesDb), claveDatos }; }
  catch (e) { claveDatos.fill(0); throw e; }
}

/** Abre con la contraseña. Contraseña errónea → ErrorSpd CONTRASENA_INCORRECTA; fichero dañado → FICHERO_CORRUPTO. Datos sin contraseña → SIN_CONTRASENA. */
export function abrirConContrasena(fichero: Uint8Array, contrasena: string): AbiertoFichero {
  const p = parsear(fichero);
  if (esSistema(p.cabecera)) throw new ErrorSpd('Estos datos no tienen contraseña de arranque: se abren con el usuario de Windows.', COD_SIN_CONTRASENA);
  const clave = desenvolver(p.cabecera, String(contrasena ?? ''));
  if (!clave) throw new ErrorSpd('Contraseña incorrecta (o el fichero de datos está dañado).', COD_CONTRASENA);
  const claveDatos = new Uint8Array(clave);
  clave.fill(0);
  try { return { bytesDb: abrirCarga(p, claveDatos), claveDatos }; }
  catch (e) { claveDatos.fill(0); throw e; }
}

/**
 * Abre un fichero «sistema» con el almacén de claves del sistema operativo. Si el sistema no puede descifrar (otro usuario de
 * Windows, otro equipo) → ErrorSpd CLAVE_SISTEMA_ILEGIBLE (y la salida es la clave de recuperación); fichero dañado → FICHERO_CORRUPTO.
 */
export function abrirConProtector(fichero: Uint8Array, protector: ProtectorClave | undefined | null): AbiertoFichero {
  const p = parsear(fichero);
  if (!esSistema(p.cabecera)) throw new ErrorSpd('Estos datos están protegidos con contraseña.', COD_CON_CONTRASENA);
  const prot = sinProtector(protector);
  let clave: Uint8Array | null = null;
  try { clave = prot.descifrar(deB64(p.cabecera.sistema.cifrado)); } catch { /* abajo */ }
  if (!clave || clave.length !== 32) { clave?.fill(0); throw new ErrorSpd(TEXTO_CLAVE_SISTEMA, COD_CLAVE_SISTEMA); }
  const claveDatos = new Uint8Array(clave);
  clave.fill(0);
  try { return { bytesDb: abrirCarga(p, claveDatos), claveDatos }; }
  catch (e) { claveDatos.fill(0); throw e; }
}

/** ¿Con qué se envuelve la clave de este fichero? (sin autenticar nada; basta con el principio del fichero: ver `BYTES_CABECERA`). */
export function tipoDeEnvoltura(fichero: Uint8Array): TipoEnvoltura {
  return esSistema(parsear(fichero).cabecera) ? 'sistema' : 'contrasena';
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

/**
 * Pasa un fichero a «sin contraseña de arranque» SIN rotar la clave de datos (la clave de recuperación sigue valiendo): abre con la
 * clave y rehace la envoltura con el sistema operativo. Si el sistema no puede proteger la clave, lanza antes de construir nada.
 */
export function reenvolverConProtector(fichero: Uint8Array, claveDatos: Uint8Array, protector: ProtectorClave | undefined | null): Uint8Array {
  const { bytesDb } = abrirConClaveDeDatos(fichero, claveDatos);
  return construir(envolverConProtector(claveDatos, protector), claveDatos, bytesDb);
}

/** Parámetros de scrypt con los que está envuelto el fichero (sin autenticar nada: sólo para decidir si hay que migrar). */
export function parametrosKdfDelFichero(fichero: Uint8Array): ParametrosKdf {
  const { cabecera } = parsear(fichero);
  if (esSistema(cabecera)) throw new ErrorSpd('Estos datos no usan contraseña.', COD_SIN_CONTRASENA);
  return { n: cabecera.kdf.n, r: cabecera.kdf.r, p: cabecera.kdf.p };
}

/** ¿Están los parámetros del fichero por debajo de los que se usarían hoy? (hay que migrar al desbloquear o al cambiar la contraseña) */
export function kdfPorMigrar(fichero: Uint8Array, objetivo: ParametrosKdf = KDF_POR_DEFECTO): boolean {
  if (tipoDeEnvoltura(fichero) === 'sistema') return false;
  const k = parametrosKdfDelFichero(fichero);
  return k.n < objetivo.n || k.r < objetivo.r || k.p < objetivo.p;
}

/**
 * Cambio de contraseña con ROTACIÓN de la clave de datos: abre con la clave actual, genera una clave de datos nueva, recifra la
 * base con ella y rehace la envoltura con la contraseña nueva. Devuelve el fichero nuevo y la clave nueva (la de recuperación).
 */
export function rotarClaveDeDatos(fichero: Uint8Array, claveActual: Uint8Array, nuevaContrasena: string, kdf: ParametrosKdf = KDF_POR_DEFECTO): { fichero: Uint8Array; claveDatos: Uint8Array } {
  if (typeof nuevaContrasena !== 'string' || nuevaContrasena.length === 0) throw new ErrorSpd('La contraseña no puede estar vacía.', 'CONTRASENA_VACIA');
  const { bytesDb } = abrirConClaveDeDatos(fichero, claveActual);
  const claveDatos = new Uint8Array(randomBytes(32));
  return { fichero: construir(envolver(claveDatos, nuevaContrasena, kdf), claveDatos, bytesDb), claveDatos };
}

/** Guarda una base nueva con la misma envoltura y un iv nuevo. Se comprueba antes que la clave corresponde al fichero. */
export function guardarCarga(fichero: Uint8Array, claveDatos: Uint8Array, bytesDb: Uint8Array): Uint8Array {
  const p = parsear(fichero);
  abrirCarga(p, claveDatos);
  return construir(p.cabecera, claveDatos, bytesDb);
}

/** ¿Tiene pinta de fichero SPD? (sólo la cabecera mágica; no autentica nada). */
export function pareceFicheroSpd(fichero: Uint8Array): boolean {
  return fichero.length >= 13 + 16 && Buffer.from(fichero.buffer, fichero.byteOffset, 8).equals(MAGIC) && (fichero[8] === VERSION_FORMATO || fichero[8] === VERSION_FORMATO_SISTEMA);
}

// ───────────────────────────── Política de contraseña ─────────────────────────────

/** Longitud mínima de la contraseña de la farmacia (la misma que exige el asistente de la interfaz). */
export const CONTRASENA_MIN = 10;
/** Fortaleza mínima aceptada (0-4, ver `fortalezaContrasena`): «Aceptable» o mejor. */
export const CONTRASENA_FORTALEZA_MIN = 2;

/** Fortaleza 0-4 de una contraseña: MISMO criterio que el medidor de la interfaz (`fortaleza` en componentes/util.ts). */
export function fortalezaContrasena(p: string): { nivel: number; texto: string } {
  let n = 0;
  if (p.length >= 10) n++;
  if (p.length >= 14) n++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) n++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) n++;
  if (p.length < 10) n = Math.min(n, 1);
  if (/^(.)\1+$/.test(p) || /^(1234|abcd|password|contrase)/i.test(p)) n = 0;
  return { nivel: n, texto: ['Muy débil', 'Débil', 'Aceptable', 'Buena', 'Muy buena'][n]! };
}

/** Política ÚNICA de la contraseña de la farmacia (primer uso, cambio y recuperación). Lanza CONTRASENA_DEBIL; devuelve la contraseña. */
export function exigirContrasenaValida(c: unknown): string {
  if (typeof c !== 'string' || c.length < CONTRASENA_MIN) throw new ErrorSpd(`La contraseña debe tener al menos ${CONTRASENA_MIN} caracteres.`, 'CONTRASENA_DEBIL');
  if (fortalezaContrasena(c).nivel < CONTRASENA_FORTALEZA_MIN) throw new ErrorSpd('La contraseña es demasiado fácil de adivinar: usa mayúsculas y minúsculas, números y símbolos, o alárgala (14 o más caracteres).', 'CONTRASENA_DEBIL');
  return c;
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
    if (!kdfAceptable({ n, r, p })) return false;
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


// ───────────────────────────── Fichero de estado (detección de marcha atrás) ─────────────────────────────

/** Clave para firmar el fichero de estado, derivada de la clave de datos (HKDF-SHA256). Cambia al rotar la clave de datos. */
export function claveDeEstado(claveDatos: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', claveDatos, Buffer.alloc(0), Buffer.from('SPD-estado-v1', 'utf8'), 32));
}

/** HMAC-SHA256 (hex) de un texto con la clave de estado. */
export function firmarEstado(claveDatos: Uint8Array, texto: string): string {
  const k = claveDeEstado(claveDatos);
  try { return createHmac('sha256', k).update(texto, 'utf8').digest('hex'); } finally { k.fill(0); }
}

/** Comparación en tiempo constante de dos firmas hexadecimales. */
export function firmaIgual(a: string, b: string): boolean {
  const x = Buffer.from(String(a), 'utf8'), y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
