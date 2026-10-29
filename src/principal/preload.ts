/**
 * Preload: expone `window.spd` (el contrato de api.ts) por contextBridge. Un método por cada clave de
 * `METODOS` (metodos.ts) → `ipcRenderer.invoke('spd:<metodo>')`. La interfaz no tiene Node ni `ipcRenderer`.
 *
 * Contrato: ningún método rechaza la promesa; si el IPC falla, se devuelve un `Resultado` de fallo.
 * También avisa al principal de que hay actividad (ratón/teclado/toque, máximo 1 por segundo) para el
 * bloqueo por inactividad.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { METODOS } from '../servicios/metodos.ts';
import { CANAL_ACTIVIDAD, canalDe } from './ipc-nucleo.ts';

const spd: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const metodo of METODOS) {
  spd[metodo] = (...args: unknown[]) =>
    ipcRenderer.invoke(canalDe(metodo), ...args).catch(() => ({
      ok: false, error: 'No se pudo contactar con el programa.', codigo: 'SIN_CONEXION',
    }));
}
contextBridge.exposeInMainWorld('spd', Object.freeze(spd));

let ultimaActividad = 0;
const avisar = () => {
  const ahora = Date.now();
  if (ahora - ultimaActividad < 1000) return;
  ultimaActividad = ahora;
  ipcRenderer.send(CANAL_ACTIVIDAD);
};
for (const tipo of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']) {
  window.addEventListener(tipo, avisar, { passive: true, capture: true });
}
