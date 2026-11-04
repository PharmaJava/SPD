/**
 * Protector de claves del sistema operativo (proceso principal): adapta Electron `safeStorage` (DPAPI en Windows, ligada al
 * USUARIO de Windows) a la interfaz `ProtectorClave` que usan los servicios. Sin Electron: recibe el objeto, así se prueba con un doble.
 *
 * Lo que protege y lo que no: la clave de datos queda atada al usuario de Windows y al equipo, de modo que el fichero de datos
 * (o una copia) no se abre en otro equipo ni con otro usuario. NO protege frente a quien use esa sesión de Windows o ejecute un
 * proceso con ese usuario: ese puede pedirle a Windows que la descifre. Por eso el modo es opcional y se avisa.
 */
import type { ProtectorClave } from '../servicios/seguridad.ts';

/** Lo que necesitamos de `electron.safeStorage`. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(texto: string): Uint8Array;
  decryptString(cifrado: Uint8Array): string;
  /** Sólo Linux: 'basic_text' / 'unknown' = sin almacén real (la clave quedaría casi en claro). */
  getSelectedStorageBackend?(): string;
}

export function protectorDeSafeStorage(ss: SafeStorageLike | null | undefined, plataforma: string = process.platform): ProtectorClave {
  const motivo = (): string => {
    if (!ss) return 'este programa no tiene acceso al almacén de claves de Windows';
    let ok = false;
    try { ok = ss.isEncryptionAvailable(); } catch { /* no disponible */ }
    if (!ok) return 'Windows no ofrece ahora su almacén de claves para este usuario';
    if (plataforma === 'linux') {
      let b = '';
      try { b = ss.getSelectedStorageBackend?.() ?? ''; } catch { /* sin saber */ }
      if (b === 'basic_text' || b === 'unknown' || b === '') return 'este sistema no tiene un almacén de claves seguro (la clave quedaría casi en claro)';
    }
    return '';
  };
  return {
    disponible: () => motivo() === '',
    motivoNoDisponible: () => motivo(),
    cifrar(claro) {
      if (!ss || motivo() !== '') throw new Error('protector no disponible');
      // safeStorage trabaja con texto: se pasa en base64.
      return new Uint8Array(ss.encryptString(Buffer.from(claro).toString('base64')));
    },
    descifrar(cifrado) {
      if (!ss) throw new Error('protector no disponible');
      return new Uint8Array(Buffer.from(ss.decryptString(cifrado), 'base64'));
    },
  };
}
