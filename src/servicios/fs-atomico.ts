/** Escritura atómica de ficheros: temporal → fsync → rename. */
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';

export function escribirAtomico(ruta: string, bytes: Uint8Array): void {
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
