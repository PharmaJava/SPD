/**
 * Almacén: el fichero cifrado `spd.datos` en la carpeta de datos + la base abierta en memoria.
 *
 * - Escritura ATÓMICA: fichero temporal → fsync → rename. Antes de sustituir, el estado anterior
 *   (que se conserva en memoria, no se relee del disco) se escribe en `spd.datos.bak`.
 * - Guardado con debounce (400 ms por defecto, inyectable) y vaciado al bloquear/cerrar.
 * - Si el principal está dañado y el .bak abre con la misma credencial, NO se usa solo:
 *   se lanza `FICHERO_DANADO_COPIA_DISPONIBLE` y el llamador repite con `usarCopia: true`,
 *   que devuelve un aviso explicando lo que se ha perdido.
 *
 * Sin Electron: la carpeta llega por parámetro.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { abrirDb } from './db.ts';
import type { Db } from './db.ts';
import { ErrorSpd } from './contexto.ts';
import {
  abrirConClaveDeDatos, abrirConContrasena, COD_CONTRASENA, COD_FICHERO, crearAlmacenNuevo, guardarCarga, reenvolver,
} from './seguridad.ts';
import type { AbiertoFichero, ParametrosKdf } from './seguridad.ts';

export const NOMBRE_FICHERO = 'spd.datos';
export const NOMBRE_COPIA = 'spd.datos.bak';
export const COD_COPIA_DISPONIBLE = 'FICHERO_DANADO_COPIA_DISPONIBLE';

export interface Temporizador {
  programar(fn: () => void, ms: number): unknown;
  cancelar(manejador: unknown): void;
}

export interface OpcionesAlmacen {
  rutaDatos: string;
  wasmPath?: string;
  ahora?: () => Date;
  /** Espera antes de guardar tras un cambio (ms). Por defecto 400. */
  debounceMs?: number;
  temporizador?: Temporizador;
  /** Se llama cuando un guardado diferido falla (nadie más lo vería). */
  alError?: (e: Error) => void;
  /** Sólo pruebas: parámetros de scrypt más baratos al CREAR o reenvolver. Al leer manda lo que diga el fichero. */
  kdf?: ParametrosKdf;
}

export type Credencial = { contrasena: string } | { claveDatos: Uint8Array };

export interface Almacen {
  readonly rutaFichero: string;
  readonly rutaCopia: string;
  /** ¿Hay datos creados (fichero principal o copia)? */
  existe(): boolean;
  estaDesbloqueado(): boolean;
  /** Base abierta; lanza Error('bloqueado') si no lo está. */
  db(): Db;
  /** Crea un almacén nuevo. `poblar` rellena la base ANTES del primer guardado (si lanza, no se escribe nada). */
  crear(contrasena: string, poblar?: (db: Db) => void): Promise<{ claveDatos: Uint8Array }>;
  desbloquear(contrasena: string, opc?: { usarCopia?: boolean }): Promise<{ aviso?: string }>;
  /** Abre con la clave de datos y fija una contraseña nueva (recuperación). */
  recuperar(claveDatos: Uint8Array, nuevaContrasena: string, opc?: { usarCopia?: boolean }): Promise<{ aviso?: string }>;
  /** ¿Es esta la contraseña actual? (no cambia nada) */
  verificarContrasena(contrasena: string): boolean;
  cambiarContrasena(actual: string, nueva: string): Promise<void>;
  /** Marca cambios y programa el guardado diferido. */
  persistir(): void;
  /** Guarda ya (si hay cambios o `forzar`). */
  flush(forzar?: boolean): Promise<void>;
  /** Vacía, cierra la base y descarta las claves de memoria. Devuelve el error de guardado si lo hubo (aun así queda bloqueado). */
  bloquear(): Promise<{ errorGuardado?: string }>;
  ultimoErrorGuardado(): string | null;
  /** Número de escrituras en disco hechas (para pruebas y diagnóstico). */
  escrituras(): number;
}

const temporizadorReal: Temporizador = {
  programar(fn, ms) { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  cancelar(h) { clearTimeout(h as ReturnType<typeof setTimeout>); },
};

function leer(ruta: string): Uint8Array | null {
  try { return new Uint8Array(readFileSync(ruta)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

function escribirAtomico(ruta: string, bytes: Uint8Array): void {
  const tmp = ruta + '.tmp';
  const fd = openSync(tmp, 'w');
  try {
    let desde = 0;
    while (desde < bytes.length) desde += writeSync(fd, bytes, desde, bytes.length - desde);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try { renameSync(tmp, ruta); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch { /* nada */ } throw e; }
}

export function crearAlmacen(op: OpcionesAlmacen): Almacen {
  const rutaFichero = join(op.rutaDatos, NOMBRE_FICHERO);
  const rutaCopia = join(op.rutaDatos, NOMBRE_COPIA);
  const ahora = op.ahora ?? (() => new Date());
  const debounceMs = op.debounceMs ?? 400;
  const temporizador = op.temporizador ?? temporizadorReal;

  let db: Db | null = null;
  let claveDatos: Uint8Array | null = null;
  /** Última versión cifrada conocida (la que hay en disco o la que se va a escribir). */
  let ficheroActual: Uint8Array | null = null;
  let sucio = false;
  let manejador: unknown = null;
  let cola: Promise<void> = Promise.resolve();
  let errorGuardado: string | null = null;
  let nEscrituras = 0;

  const abrirBase = async (bytes: Uint8Array): Promise<Db> => {
    try { return await abrirDb(bytes, { wasmPath: op.wasmPath }); }
    catch (e) {
      if (e instanceof Error && /versión más nueva/.test(e.message)) throw new ErrorSpd(e.message, 'VERSION_BASE');
      throw new ErrorSpd(`La base de datos descifrada está dañada (${e instanceof Error ? e.message : String(e)}).`, COD_FICHERO);
    }
  };

  /** Descifra y abre un fichero concreto con la credencial. */
  const intentar = async (fichero: Uint8Array | null, cred: Credencial, nombre: string): Promise<{ db: Db; abierto: AbiertoFichero; fichero: Uint8Array }> => {
    if (!fichero) throw new ErrorSpd(`Falta el fichero ${nombre}.`, COD_FICHERO);
    const abierto = 'contrasena' in cred ? abrirConContrasena(fichero, cred.contrasena) : abrirConClaveDeDatos(fichero, cred.claveDatos);
    try { return { db: await abrirBase(abierto.bytesDb), abierto, fichero }; }
    catch (e) { abierto.claveDatos.fill(0); throw e; }
  };

  const esDanado = (e: unknown) => e instanceof ErrorSpd && e.codigo === COD_FICHERO;

  /** Abre el principal; si está dañado, mira si la copia sirve y ofrece usarla. */
  const abrirConFallback = async (cred: Credencial, usarCopia: boolean): Promise<{ db: Db; abierto: AbiertoFichero; fichero: Uint8Array; aviso?: string }> => {
    if (!existsSync(rutaFichero) && !existsSync(rutaCopia)) throw new ErrorSpd('No hay datos creados todavía.', 'NO_INICIALIZADO');
    for (const sobra of [rutaFichero + '.tmp', rutaCopia + '.tmp']) { try { rmSync(sobra, { force: true }); } catch { /* nada */ } }
    if (usarCopia) {
      const r = await intentar(leer(rutaCopia), cred, NOMBRE_COPIA);
      // Conserva el principal dañado (si existe) para que alguien pueda examinarlo y pone la copia como principal.
      if (existsSync(rutaFichero)) {
        const sello = ahora().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
        try { renameSync(rutaFichero, join(op.rutaDatos, `${NOMBRE_FICHERO}.danado-${sello}`)); } catch { /* nada */ }
      }
      escribirAtomico(rutaFichero, r.fichero);
      return { ...r, aviso: 'Se ha usado la copia anterior del fichero de datos porque el principal estaba dañado. Los cambios hechos después de ese último guardado correcto se han perdido: revísalos. El fichero dañado se ha conservado con extensión .danado-…' };
    }
    try {
      return await intentar(leer(rutaFichero), cred, NOMBRE_FICHERO);
    } catch (e) {
      if (!esDanado(e)) throw e;
      let copiaSirve = false;
      try { const c = await intentar(leer(rutaCopia), cred, NOMBRE_COPIA); c.db.cerrar(); c.abierto.claveDatos.fill(0); copiaSirve = true; }
      catch { /* la copia tampoco abre */ }
      if (copiaSirve) throw new ErrorSpd(`${(e as Error).message} Hay una copia anterior que sí se puede abrir: puedes usarla (se perderán los últimos cambios).`, COD_COPIA_DISPONIBLE);
      throw e;
    }
  };

  const instalar = (d: Db, clave: Uint8Array, fichero: Uint8Array) => {
    db = d; claveDatos = clave; ficheroActual = fichero; sucio = false; errorGuardado = null;
  };

  /** Escribe en disco, en orden. `previo` (estado anterior) va a la .bak antes de sustituir. */
  const encolarEscritura = (nuevo: Uint8Array, previo: Uint8Array | null): Promise<void> => {
    const trabajo = cola.then(() => {
      mkdirSync(op.rutaDatos, { recursive: true });
      if (previo) escribirAtomico(rutaCopia, previo);
      escribirAtomico(rutaFichero, nuevo);
      nEscrituras++;
    });
    cola = trabajo.catch(() => { /* el error le llega a quien espera `trabajo` */ });
    return trabajo;
  };

  const flush = async (forzar = false): Promise<void> => {
    if (manejador !== null) { temporizador.cancelar(manejador); manejador = null; }
    if (!db || !claveDatos || !ficheroActual) { await cola; return; }
    if (!sucio && !forzar) { await cola; return; }
    const previo = ficheroActual;
    const nuevo = guardarCarga(ficheroActual, claveDatos, db.exportar());
    ficheroActual = nuevo;
    sucio = false;
    try { await encolarEscritura(nuevo, previo); errorGuardado = null; }
    catch (e) {
      sucio = true;
      errorGuardado = e instanceof Error ? e.message : String(e);
      throw new ErrorSpd(`No se pudo guardar el fichero de datos: ${errorGuardado}`, 'ERROR_GUARDADO');
    }
  };

  const almacen: Almacen = {
    rutaFichero, rutaCopia,
    existe: () => existsSync(rutaFichero) || existsSync(rutaCopia),
    estaDesbloqueado: () => db !== null,
    db() { if (!db) throw new Error('bloqueado'); return db; },

    async crear(contrasena, poblar) {
      if (db) throw new ErrorSpd('Ya hay una base abierta.', 'YA_INICIALIZADO');
      if (almacen.existe()) throw new ErrorSpd('Ya existen datos en esta carpeta.', 'YA_INICIALIZADO');
      const nueva = await abrirDb(undefined, { wasmPath: op.wasmPath });
      try {
        poblar?.(nueva);
        const { fichero, claveDatos: clave } = crearAlmacenNuevo(contrasena, nueva.exportar(), op.kdf);
        await encolarEscritura(fichero, null);
        instalar(nueva, clave, fichero);
        return { claveDatos: new Uint8Array(clave) };
      } catch (e) { nueva.cerrar(); throw e; }
    },

    async desbloquear(contrasena, opc = {}) {
      if (db) return {};
      const r = await abrirConFallback({ contrasena }, !!opc.usarCopia);
      instalar(r.db, r.abierto.claveDatos, r.fichero);
      return r.aviso ? { aviso: r.aviso } : {};
    },

    async recuperar(clave, nuevaContrasena, opc = {}) {
      if (db) throw new ErrorSpd('El programa ya está desbloqueado.', 'YA_DESBLOQUEADO');
      const r = await abrirConFallback({ claveDatos: clave }, !!opc.usarCopia);
      try {
        const nuevo = reenvolver(r.fichero, r.abierto.claveDatos, nuevaContrasena, op.kdf);
        await encolarEscritura(nuevo, r.fichero);
        instalar(r.db, r.abierto.claveDatos, nuevo);
      } catch (e) { r.db.cerrar(); r.abierto.claveDatos.fill(0); throw e; }
      return r.aviso ? { aviso: r.aviso } : {};
    },

    verificarContrasena(contrasena) {
      if (!ficheroActual) return false;
      try { abrirConContrasena(ficheroActual, contrasena).claveDatos.fill(0); return true; }
      catch (e) { if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) return false; throw e; }
    },

    async cambiarContrasena(actual, nueva) {
      if (!db || !claveDatos || !ficheroActual) throw new Error('bloqueado');
      if (!almacen.verificarContrasena(actual)) throw new ErrorSpd('La contraseña actual no es correcta.', COD_CONTRASENA);
      await flush(true);   // la base en memoria, ya en el fichero
      const previo = ficheroActual;
      const nuevo = reenvolver(ficheroActual, claveDatos, nueva, op.kdf);
      ficheroActual = nuevo;
      try { await encolarEscritura(nuevo, previo); }
      catch (e) { ficheroActual = previo; throw e; }
    },

    persistir() {
      if (!db) return;
      sucio = true;
      if (manejador !== null) return;
      manejador = temporizador.programar(() => {
        manejador = null;
        flush().catch(e => op.alError?.(e instanceof Error ? e : new Error(String(e))));
      }, debounceMs);
    },

    flush,

    async bloquear() {
      let errorLocal: string | undefined;
      try { await flush(); } catch (e) { errorLocal = e instanceof Error ? e.message : String(e); }
      if (manejador !== null) { temporizador.cancelar(manejador); manejador = null; }
      try { db?.cerrar(); } catch { /* nada */ }
      claveDatos?.fill(0);
      db = null; claveDatos = null; ficheroActual = null; sucio = false;
      return errorLocal ? { errorGuardado: errorLocal } : {};
    },

    ultimoErrorGuardado: () => errorGuardado,
    escrituras: () => nEscrituras,
  };
  return almacen;
}
