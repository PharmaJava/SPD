/**
 * Fichero de estado junto a los datos (`spd.estado`): detección de MARCHA ATRÁS (doc 10.3).
 *
 * Guarda, FUERA de la base cifrada, el último sello de auditoría visto: un contador monótono (id de la última entrada) y
 * el hash de esa entrada. Va firmado con HMAC-SHA256 con una clave derivada (HKDF) de la clave de datos, de modo que sólo
 * se puede fabricar o modificar conociendo la clave de datos; y se compara al desbloquear:
 *   - la base tiene un contador MENOR que el del fichero → se ha puesto una copia más antigua (restauración) o se ha
 *     cambiado el fichero de datos por uno viejo;
 *   - el mismo contador con otro hash → la historia se bifurcó (copia antigua + entradas nuevas).
 * Una restauración legítima desde el programa lo actualiza a propósito (y queda auditada).
 *
 * Límites (honestos): quien pueda borrar a la vez `spd.estado` y sustituir el fichero de datos no deja rastro aquí
 * (sin fichero no hay con qué comparar y se vuelve a crear); la protección es frente a restauraciones accidentales o
 * hechas a mano, y frente a modificar el fichero de estado sin tener la clave.
 */
import { existsSync, readFileSync } from 'node:fs';
import { firmarEstado, firmaIgual } from './seguridad.ts';
import { escribirAtomico } from './fs-atomico.ts';

export const NOMBRE_ESTADO = 'spd.estado';

export interface Sello { contador: number; hash: string }

export type LecturaEstado =
  | { tipo: 'ausente' }
  | { tipo: 'invalido'; motivo: string }
  | { tipo: 'valido'; sello: Sello };

export type EstadoRollback =
  | { tipo: 'ausente' }
  | { tipo: 'ok' }
  | { tipo: 'retroceso'; guardado: Sello; actual: Sello }
  | { tipo: 'manipulado'; motivo: string };

const texto = (s: Sello) => `SPD-estado|1|${s.contador}|${s.hash}`;

export function leerEstado(ruta: string, claveDatos: Uint8Array): LecturaEstado {
  if (!existsSync(ruta)) return { tipo: 'ausente' };
  let j: Record<string, unknown>;
  try { j = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, unknown>; }
  catch { return { tipo: 'invalido', motivo: 'el fichero de estado está ilegible' }; }
  if (!j || j.v !== 1 || !Number.isInteger(j.contador) || (j.contador as number) < 0 || typeof j.hash !== 'string' || typeof j.mac !== 'string') {
    return { tipo: 'invalido', motivo: 'el fichero de estado está incompleto' };
  }
  const sello: Sello = { contador: j.contador as number, hash: j.hash };
  if (!firmaIgual(firmarEstado(claveDatos, texto(sello)), j.mac)) return { tipo: 'invalido', motivo: 'la firma del fichero de estado no es válida' };
  return { tipo: 'valido', sello };
}

export function escribirEstado(ruta: string, claveDatos: Uint8Array, sello: Sello): void {
  escribirAtomico(ruta, new TextEncoder().encode(JSON.stringify({ v: 1, contador: sello.contador, hash: sello.hash, mac: firmarEstado(claveDatos, texto(sello)) })));
}

/** Compara el sello guardado con el de la base recién abierta. Pura. */
export function evaluarRetroceso(guardado: Sello, actual: Sello): 'ok' | 'retroceso' {
  if (actual.contador < guardado.contador) return 'retroceso';
  if (actual.contador === guardado.contador && actual.hash !== guardado.hash) return 'retroceso';
  return 'ok';
}

/** ¿Hay que escribir `nuevo` encima de `guardado` sin permiso para retroceder? (nunca baja el contador) */
export function debeActualizar(guardado: Sello, nuevo: Sello): boolean {
  return nuevo.contador > guardado.contador || (nuevo.contador === guardado.contador && nuevo.hash === guardado.hash);
}
