/**
 * Pausa del bloqueo por inactividad mientras haya algo que no se puede perder (p. ej. la clave de recuperación
 * nueva, que sólo se muestra una vez). Mientras haya alguna pausa activa:
 *  - el temporizador de la interfaz (App.svelte) no cuenta inactividad;
 *  - cada 20 s se emite una señal de actividad en la ventana: el preload la reenvía al proceso principal,
 *    que es quien bloquea de verdad, y así su reloj tampoco llega a cero.
 */
import { writable, get } from 'svelte/store';

/** Número de pausas activas (0 = el bloqueo funciona con normalidad). */
export const pausasBloqueo = writable(0);
let latido: ReturnType<typeof setInterval> | undefined;

function senal(): void {
  try { window.dispatchEvent(new Event('pointermove')); } catch { /* sin ventana (pruebas) */ }
}

/** Pausa el bloqueo. Devuelve la función que libera esa pausa (llamarla una sola vez). */
export function pausarBloqueo(): () => void {
  pausasBloqueo.update(n => n + 1);
  senal();
  if (latido === undefined) latido = setInterval(senal, 20_000);
  let liberada = false;
  return () => {
    if (liberada) return;
    liberada = true;
    pausasBloqueo.update(n => Math.max(0, n - 1));
    if (get(pausasBloqueo) === 0 && latido !== undefined) { clearInterval(latido); latido = undefined; }
  };
}
