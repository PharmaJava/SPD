/** Router mínimo por hash: #/hoy, #/pacientes/12, #/preparar/12… */
import { writable } from 'svelte/store';

export interface Ruta { nombre: string; id?: number; resto: string[]; hash: string }

export function analizar(hash: string): Ruta {
  const limpio = hash.replace(/^#\/?/, '').split('?')[0]!;
  const partes = limpio.split('/').filter(Boolean);
  const nombre = partes[0] ?? 'hoy';
  const n = partes[1] !== undefined && /^\d+$/.test(partes[1]) ? Number(partes[1]) : undefined;
  return { nombre, id: n, resto: partes.slice(n === undefined ? 1 : 2), hash: '#/' + (partes.join('/') || 'hoy') };
}

export const ruta = writable<Ruta>(analizar(typeof location !== 'undefined' ? location.hash : ''));
if (typeof window !== 'undefined') window.addEventListener('hashchange', () => ruta.set(analizar(location.hash)));

export function ir(destino: string): void {
  const h = destino.startsWith('#') ? destino : '#/' + destino.replace(/^\//, '');
  if (location.hash === h) ruta.set(analizar(h)); else location.hash = h;
}
