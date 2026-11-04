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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { abrirDb } from './db.ts';
import type { Db } from './db.ts';
import { ErrorSpd } from './contexto.ts';
import {
  abrirConClaveDeDatos, abrirConContrasena, abrirConProtector, BYTES_CABECERA, COD_CONTRASENA, COD_FICHERO, COD_PROTECTOR, COD_SIN_CONTRASENA,
  crearAlmacenNuevo, crearAlmacenNuevoSistema, guardarCarga, KDF_POR_DEFECTO, kdfPorMigrar, pareceFicheroSpd, reenvolver, reenvolverConProtector,
  rotarClaveDeDatos, tipoDeEnvoltura,
} from './seguridad.ts';
import type { AbiertoFichero, ParametrosKdf, ProtectorClave, TipoEnvoltura } from './seguridad.ts';
import { claveDesdeTexto } from '../dominio/clave-recuperacion.ts';
import { escribirAtomico } from './fs-atomico.ts';
import { debeActualizar, escribirEstado, evaluarRetroceso, leerEstado, NOMBRE_ESTADO } from './estado-local.ts';
import type { EstadoRollback, Sello } from './estado-local.ts';

export const NOMBRE_FICHERO = 'spd.datos';
export const NOMBRE_COPIA = 'spd.datos.bak';
export { NOMBRE_ESTADO };
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
  /**
   * Sello de la auditoría de una base (contador monótono + hash del último eslabón). Si se da, el almacén mantiene el
   * fichero de estado `spd.estado` y puede detectar una marcha atrás (ver estado-local.ts).
   */
  sello?: (db: Db) => Sello;
  /**
   * Almacén de claves del sistema operativo (Electron safeStorage, sólo en el proceso principal). Sin él, el modo «sin contraseña de
   * arranque» ni se puede activar ni se pueden abrir unos datos que lo usen (error PROTECTOR_NO_DISPONIBLE, nunca un fallo raro).
   */
  protector?: ProtectorClave;
}

/** Una copia ya descifrada, comprobada y migrada, lista para sustituir al estado actual (o para descartarse). */
export interface Restauracion {
  /** Base de la copia (ya migrada al esquema vigente), sólo para leer (p. ej. la auditoría). */
  readonly db: Db;
  /** La copia tiene OTRA clave de datos (es anterior a un cambio de contraseña, o de otra instalación): se recifra con la actual. */
  readonly claveDistinta: boolean;
  /** Sustituye el estado actual por la copia: el estado actual pasa a `spd.datos.bak`. */
  aplicar(): Promise<void>;
  descartar(): void;
}

export type Credencial = { contrasena: string } | { claveDatos: Uint8Array } | { sistema: true };

export interface Almacen {
  readonly rutaFichero: string;
  readonly rutaCopia: string;
  /** ¿Hay datos creados (fichero principal o copia)? */
  existe(): boolean;
  estaDesbloqueado(): boolean;
  /** Base abierta; lanza Error('bloqueado') si no lo está. */
  db(): Db;
  /**
   * Crea un almacén nuevo. `poblar` rellena la base ANTES del primer guardado (si lanza, no se escribe nada).
   * `contrasena = null` = SIN contraseña de arranque: la clave de datos se envuelve con el sistema operativo (hace falta el protector).
   */
  crear(contrasena: string | null, poblar?: (db: Db) => void): Promise<{ claveDatos: Uint8Array }>;
  desbloquear(contrasena: string, opc?: { usarCopia?: boolean }): Promise<{ aviso?: string }>;
  /** Abre unos datos «sin contraseña de arranque» con el almacén de claves del sistema. Si el sistema no puede: CLAVE_SISTEMA_ILEGIBLE (→ clave de recuperación). */
  desbloquearConSistema(opc?: { usarCopia?: boolean }): Promise<{ aviso?: string }>;
  /**
   * Abre con la clave de datos y rehace la envoltura (recuperación). Con contraseña nueva: pasa a (o sigue en) modo contraseña.
   * Con `null`: sólo vale si los datos ya eran «sin contraseña» y se vuelven a ligar al usuario de Windows de ahora.
   */
  recuperar(claveDatos: Uint8Array, nuevaContrasena: string | null, opc?: { usarCopia?: boolean }): Promise<{ aviso?: string }>;
  /** Cómo se protege la clave de datos (null si aún no hay datos). Lee sólo la cabecera del fichero, sin descifrar nada. */
  modoAcceso(): TipoEnvoltura | null;
  /** ¿Hay almacén de claves del sistema que funcione? (nunca lanza) */
  accesoSistemaDisponible(): boolean;
  motivoSistemaNoDisponible(): string;
  /**
   * Contraseña → sin contraseña de arranque. Pide la contraseña actual. NO rota la clave de datos (la clave de recuperación sigue
   * valiendo). Reescribe el fichero y su `.bak`. Si el sistema no puede proteger la clave, no cambia nada.
   */
  quitarContrasena(contrasenaActual: string): Promise<void>;
  /**
   * Sin contraseña → contraseña. ROTA la clave de datos: mientras estuvo sin contraseña, cualquier proceso del usuario de Windows
   * pudo leerla, así que la anterior no debe seguir valiendo. Devuelve la clave nueva (= clave de recuperación nueva, a mostrar).
   */
  ponerContrasena(nueva: string): Promise<{ claveDatos: Uint8Array }>;
  /**
   * Fase 1 de restaurar una copia: descifra y verifica la cabecera con la contraseña de ESA copia (o, si no es la
   * contraseña, con su clave de recuperación) y la abre (migrándola si es de un esquema anterior; si es posterior →
   * VERSION_BASE). Si la copia tiene otra clave de datos (anterior a un cambio de contraseña) se recifra con la actual al
   * aplicarla: la clave de recuperación vigente sigue valiendo. No cambia nada.
   */
  prepararRestauracion(bytesCopia: Uint8Array, contrasenaCopia: string): Promise<Restauracion>;
  /** ¿Es esta la contraseña actual? (no cambia nada). Sin contraseña de arranque lanza SIN_CONTRASENA (no es una contraseña errónea). */
  verificarContrasena(contrasena: string): boolean;
  /**
   * Cambia la contraseña ROTANDO la clave de datos: clave nueva, base recifrada, envoltura nueva. Devuelve la clave nueva
   * (= clave de recuperación nueva, a mostrar y confirmar). La anterior deja de abrir el fichero actual y su `.bak`.
   */
  cambiarContrasena(actual: string, nueva: string): Promise<{ claveDatos: Uint8Array }>;
  /** Compara el sello de auditoría de la base abierta con el fichero de estado (marcha atrás). No escribe nada. */
  comprobarEstado(): EstadoRollback;
  /** Anota el sello actual en el fichero de estado. Sin `permitirRetroceso` nunca baja el contador ya anotado. */
  fijarEstado(opc?: { permitirRetroceso?: boolean }): void;
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

/** Sólo el principio del fichero (la cabecera), sin leerlo entero. null si no existe. */
function leerPrincipio(ruta: string): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = openSync(ruta, 'r');
    const b = Buffer.alloc(BYTES_CABECERA);
    const n = readSync(fd, b, 0, b.length, 0);
    return new Uint8Array(b.subarray(0, n));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* nada */ } } }
}

function leer(ruta: string): Uint8Array | null {
  try { return new Uint8Array(readFileSync(ruta)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

export function crearAlmacen(op: OpcionesAlmacen): Almacen {
  const rutaFichero = join(op.rutaDatos, NOMBRE_FICHERO);
  const rutaCopia = join(op.rutaDatos, NOMBRE_COPIA);
  const rutaEstado = join(op.rutaDatos, NOMBRE_ESTADO);
  const kdfObjetivo: ParametrosKdf = op.kdf ?? KDF_POR_DEFECTO;
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
    const abierto = 'contrasena' in cred ? abrirConContrasena(fichero, cred.contrasena)
      : 'sistema' in cred ? abrirConProtector(fichero, op.protector) : abrirConClaveDeDatos(fichero, cred.claveDatos);
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

  const selloActual = (): Sello | null => (op.sello && db ? op.sello(db) : null);

  /** Anota el sello tras un guardado correcto. Nunca baja el contador (eso sólo lo hace `fijarEstado` con permiso). Best effort. */
  const actualizarEstado = (permitirRetroceso = false): void => {
    const nuevo = selloActual();
    if (!nuevo || !claveDatos) return;
    try {
      const l = leerEstado(rutaEstado, claveDatos);
      if (l.tipo === 'valido' && !permitirRetroceso && !debeActualizar(l.sello, nuevo)) return;
      escribirEstado(rutaEstado, claveDatos, nuevo);
    } catch (e) { op.alError?.(e instanceof Error ? e : new Error(String(e))); }
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
    try { await encolarEscritura(nuevo, previo); errorGuardado = null; actualizarEstado(); }
    catch (e) {
      sucio = true;
      errorGuardado = e instanceof Error ? e.message : String(e);
      throw new ErrorSpd(`No se pudo guardar el fichero de datos: ${errorGuardado}`, 'ERROR_GUARDADO');
    }
  };

  /**
   * Rota la clave de datos y escribe el fichero (y su .bak) con una envoltura de contraseña nueva. Lo usan «cambiar contraseña» y
   * «poner contraseña». La base en memoria ya tiene que estar en el fichero (`flush(true)` antes). El contador del fichero de
   * estado ya visto no se pierde al rotar.
   */
  const rotarYEscribir = async (nueva: string): Promise<{ claveDatos: Uint8Array }> => {
    if (!db || !claveDatos || !ficheroActual) throw new Error('bloqueado');
    const previo = ficheroActual;
    const claveVieja = claveDatos;
    const antes = leerEstado(rutaEstado, claveVieja);   // con la clave que aún vale
    const rot = rotarClaveDeDatos(ficheroActual, claveVieja, nueva, kdfObjetivo);
    try { await encolarEscritura(rot.fichero, rot.fichero); }   // la .bak TAMBIÉN: si no, seguiría abriendo con lo de antes
    catch (e) {
      try { escribirAtomico(rutaCopia, previo); } catch { /* la .bak anterior no se pudo reponer: sigue abriendo con lo de antes */ }
      rot.claveDatos.fill(0);
      throw e;
    }
    claveDatos = rot.claveDatos; ficheroActual = rot.fichero;
    const sello = selloActual();
    if (sello) {
      try {
        const base = antes.tipo === 'valido' && antes.sello.contador > sello.contador ? antes.sello : sello;
        escribirEstado(rutaEstado, claveDatos, base);
      } catch (e) { op.alError?.(e instanceof Error ? e : new Error(String(e))); }
    }
    claveVieja.fill(0);
    return { claveDatos: new Uint8Array(claveDatos) };
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
        const { fichero, claveDatos: clave } = contrasena === null
          ? crearAlmacenNuevoSistema(op.protector, nueva.exportar())
          : crearAlmacenNuevo(contrasena, nueva.exportar(), op.kdf);
        await encolarEscritura(fichero, null);
        instalar(nueva, clave, fichero);
        return { claveDatos: new Uint8Array(clave) };
      } catch (e) { nueva.cerrar(); throw e; }
    },

    async desbloquear(contrasena, opc = {}) {
      if (db) return {};
      const r = await abrirConFallback({ contrasena }, !!opc.usarCopia);
      instalar(r.db, r.abierto.claveDatos, r.fichero);
      // Fichero con scrypt más flojo que el de hoy (p. ej. N=2^15): se rehace la envoltura con la contraseña que acaba de abrirlo.
      // La clave de datos no cambia; si algo falla, el fichero sigue abriéndose como antes.
      try {
        if (kdfPorMigrar(r.fichero, kdfObjetivo)) {
          const migrado = reenvolver(r.fichero, r.abierto.claveDatos, contrasena, kdfObjetivo);
          await encolarEscritura(migrado, migrado);   // la .bak también: abre con la misma clave y no debe quedarse con el scrypt viejo
          ficheroActual = migrado;
        }
      } catch (e) { op.alError?.(e instanceof Error ? e : new Error(String(e))); }
      return r.aviso ? { aviso: r.aviso } : {};
    },

    async desbloquearConSistema(opc = {}) {
      if (db) return {};
      const r = await abrirConFallback({ sistema: true }, !!opc.usarCopia);
      instalar(r.db, r.abierto.claveDatos, r.fichero);
      return r.aviso ? { aviso: r.aviso } : {};
    },

    modoAcceso() {
      for (const ruta of [rutaFichero, rutaCopia]) {
        try { const b = leerPrincipio(ruta); if (b) return tipoDeEnvoltura(b); } catch { /* se prueba con la copia */ }
      }
      // Datos que existen pero cuya cabecera no se entiende: se trata como contraseña (la de siempre); al abrir se dirá que está dañado.
      return almacen.existe() ? 'contrasena' : null;
    },

    accesoSistemaDisponible() {
      try { return !!op.protector && op.protector.disponible(); } catch { return false; }
    },
    motivoSistemaNoDisponible() {
      if (!op.protector) return 'este programa no tiene acceso al almacén de claves de Windows (sólo lo hay en la aplicación instalada)';
      try { return op.protector.disponible() ? '' : op.protector.motivoNoDisponible(); } catch { return 'el almacén de claves del sistema no responde'; }
    },

    async quitarContrasena(contrasenaActual) {
      if (!db || !claveDatos || !ficheroActual) throw new Error('bloqueado');
      if (almacen.modoAcceso() === 'sistema') throw new ErrorSpd('Estos datos ya están abiertos sin contraseña de arranque.', 'YA_SIN_CONTRASENA');
      if (!almacen.verificarContrasena(contrasenaActual)) throw new ErrorSpd('La contraseña actual no es correcta.', COD_CONTRASENA);
      await flush(true);
      const previo = ficheroActual;
      // Si el sistema no puede proteger la clave, esto lanza ANTES de escribir nada.
      const nuevo = reenvolverConProtector(ficheroActual, claveDatos, op.protector);
      try { await encolarEscritura(nuevo, nuevo); }   // la .bak también: si no, seguiría pidiendo la contraseña antigua
      catch (e) {
        try { escribirAtomico(rutaCopia, previo); } catch { /* la .bak anterior no se pudo reponer: sigue abriendo con lo de antes */ }
        throw e;
      }
      ficheroActual = nuevo;
      // La clave de datos no cambia: el fichero de estado (rollback) sigue valiendo tal cual.
    },

    async ponerContrasena(nueva) {
      if (!db || !claveDatos || !ficheroActual) throw new Error('bloqueado');
      if (almacen.modoAcceso() === 'contrasena') throw new ErrorSpd('Estos datos ya tienen contraseña de arranque. Para cambiarla usa «Cambiar contraseña».', 'YA_CON_CONTRASENA');
      await flush(true);
      return rotarYEscribir(nueva);
    },

    async recuperar(clave, nuevaContrasena, opc = {}) {
      if (db) throw new ErrorSpd('El programa ya está desbloqueado.', 'YA_DESBLOQUEADO');
      const r = await abrirConFallback({ claveDatos: clave }, !!opc.usarCopia);
      try {
        let nuevo: Uint8Array;
        if (nuevaContrasena === null) {
          // Sólo tiene sentido si los datos ya eran «sin contraseña»: se vuelven a ligar al usuario de Windows de ahora.
          if (tipoDeEnvoltura(r.fichero) !== 'sistema') throw new ErrorSpd('Estos datos tienen contraseña: para recuperarlos hay que poner una contraseña nueva.', COD_SIN_CONTRASENA);
          nuevo = reenvolverConProtector(r.fichero, r.abierto.claveDatos, op.protector);
        } else nuevo = reenvolver(r.fichero, r.abierto.claveDatos, nuevaContrasena, op.kdf);
        await encolarEscritura(nuevo, r.fichero);
        instalar(r.db, r.abierto.claveDatos, nuevo);
      } catch (e) { r.db.cerrar(); r.abierto.claveDatos.fill(0); throw e; }
      return r.aviso ? { aviso: r.aviso } : {};
    },

    async prepararRestauracion(bytesCopia, contrasenaCopia) {
      if (!db || !claveDatos || !ficheroActual) throw new Error('bloqueado');
      if (!pareceFicheroSpd(bytesCopia)) throw new ErrorSpd('Ese fichero no es una copia de SPD (cabecera no válida).', 'COPIA_INVALIDA');
      // Contraseña de la copia; si no es esa, se prueba como clave de recuperación (la de entonces).
      let abierto: AbiertoFichero;
      try {
        // Una copia hecha SIN contraseña de arranque está ligada al usuario de Windows que la hizo: aquí sólo abre si es el mismo
        // usuario y equipo; si no, hace falta su clave de recuperación (se prueba en el bloque de abajo).
        abierto = tipoDeEnvoltura(bytesCopia) === 'sistema' ? abrirConProtector(bytesCopia, op.protector) : abrirConContrasena(bytesCopia, contrasenaCopia);
      } catch (e) {
        if (e instanceof ErrorSpd && e.codigo === COD_PROTECTOR && !contrasenaCopia) throw new ErrorSpd(`Esta copia se hizo sin contraseña de arranque y ${almacen.motivoSistemaNoDisponible() || 'no se puede abrir con el almacén de claves de Windows'}. Hace falta su clave de recuperación.`, 'COPIA_SISTEMA_AJENA');
        if (!(e instanceof ErrorSpd) || (e.codigo !== COD_CONTRASENA && e.codigo !== 'CLAVE_SISTEMA_ILEGIBLE' && e.codigo !== COD_PROTECTOR)) throw e;
        let clave: Uint8Array | null = null;
        try { clave = claveDesdeTexto(contrasenaCopia); } catch { /* no tiene forma de clave de recuperación */ }
        if (!clave) throw e;
        try { abierto = abrirConClaveDeDatos(bytesCopia, clave); }
        catch (e2) { if (e2 instanceof ErrorSpd && e2.codigo === COD_FICHERO) throw e; throw e2; }   // clave que no abre: «contraseña incorrecta»
      }
      let nueva: Db;
      const claveDistinta = !Buffer.from(abierto.claveDatos).equals(Buffer.from(claveDatos));
      try { nueva = await abrirBase(abierto.bytesDb); }
      finally { abierto.claveDatos.fill(0); }
      let cerrada = false;
      return {
        db: nueva, claveDistinta,
        descartar() { if (!cerrada) { cerrada = true; nueva.cerrar(); } },
        async aplicar() {
          if (cerrada) throw new Error('restauración ya usada');
          if (!db || !claveDatos || !ficheroActual) throw new Error('bloqueado');
          await flush(true);
          const previo = ficheroActual;
          // Misma envoltura (contraseña actual) y MISMA clave de datos actual: sólo cambia el contenido. Una copia con otra
          // clave de datos queda recifrada con la vigente (así la clave de recuperación actual sigue valiendo).
          const nuevo = guardarCarga(ficheroActual, claveDatos, nueva.exportar());
          await encolarEscritura(nuevo, previo);   // el estado actual → .bak; si falla, no se toca nada en memoria
          const vieja = db;
          db = nueva; ficheroActual = nuevo; sucio = false; errorGuardado = null; cerrada = true;
          try { vieja.cerrar(); } catch { /* nada */ }
        },
      };
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
      return rotarYEscribir(nueva);
    },

    comprobarEstado() {
      const sello = selloActual();
      if (!db || !claveDatos || !sello) return { tipo: 'ausente' };
      const l = leerEstado(rutaEstado, claveDatos);
      if (l.tipo === 'ausente') return { tipo: 'ausente' };
      if (l.tipo === 'invalido') return { tipo: 'manipulado', motivo: l.motivo };
      return evaluarRetroceso(l.sello, sello) === 'ok' ? { tipo: 'ok' } : { tipo: 'retroceso', guardado: l.sello, actual: sello };
    },

    fijarEstado(opc = {}) { actualizarEstado(!!opc.permitirRetroceso); },

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
