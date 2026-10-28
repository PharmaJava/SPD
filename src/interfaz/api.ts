/**
 * Acceso de la interfaz al programa. En Electron `window.spd` lo pone el preload (IPC);
 * en desarrollo y pruebas se rellena con un puente HTTP hacia scripts/dev-servidor.mjs.
 */
import type { ApiSpd, Resultado } from '../servicios/api.ts';

if (typeof window !== 'undefined' && !window.spd) {
  window.spd = new Proxy({}, {
    get: (_o, metodo) => (...args: unknown[]) =>
      fetch(`/api/${String(metodo)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) })
        .then(r => r.json())
        .catch((e: unknown): Resultado<never> => ({ ok: false, error: `No se pudo contactar con el programa: ${e instanceof Error ? e.message : e}`, codigo: 'SIN_CONEXION' })),
  }) as ApiSpd;
}

export const spd: ApiSpd = typeof window !== 'undefined' ? window.spd : (undefined as never);

/** Desenvuelve un Resultado: devuelve los datos o lanza Error con el mensaje en español (para `try/catch` en las pantallas). */
export async function datos<T>(p: Promise<Resultado<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) { const e = new Error(r.error) as Error & { codigo?: string }; e.codigo = r.codigo; throw e; }
  return r.datos;
}
