/**
 * Registro de los manejadores IPC en Electron. La lógica vive en ipc-nucleo.ts (probada sin Electron);
 * aquí sólo se conecta con `ipcMain` y se extrae el remitente de cada evento.
 */
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow, IpcMainEvent } from 'electron';
import type { ApiSpd } from '../servicios/api.ts';
import { CANAL_ACTIVIDAD, canalDe, crearManejadores } from './ipc-nucleo.ts';
import type { Remitente } from './ipc-nucleo.ts';
import { METODOS } from '../servicios/metodos.ts';

function remitenteDe(ev: IpcMainInvokeEvent | IpcMainEvent): Remitente | null {
  const marco = ev.senderFrame;
  if (!marco) return null;
  return { idWebContents: ev.sender.id, esMarcoPrincipal: marco === ev.sender.mainFrame, urlMarco: marco.url };
}

export interface OpcionesRegistro {
  ipcMain: IpcMain;
  api: ApiSpd;
  ventana: () => BrowserWindow | null;
  urlPropia: (url: string) => boolean;
  /** Se llama con cada señal de actividad de la ventana propia (bloqueo por inactividad). */
  alActividad: () => void;
  registrar?: (mensaje: string) => void;
}

/** Registra todos los canales; devuelve una función que los quita. */
export function registrarIpc(op: OpcionesRegistro): () => void {
  const reglas = () => {
    const v = op.ventana();
    return { idWebContentsPropio: v && !v.isDestroyed() ? v.webContents.id : null, urlPropia: op.urlPropia };
  };
  const manejadores = crearManejadores({ api: op.api, reglas, registrar: op.registrar });
  for (const [canal, fn] of manejadores) {
    op.ipcMain.handle(canal, (ev, ...args) => fn(remitenteDe(ev), ...args));
  }
  const alActividad = (ev: IpcMainEvent) => {
    const r = remitenteDe(ev);
    const rg = reglas();
    if (r && rg.idWebContentsPropio === r.idWebContents && r.esMarcoPrincipal && rg.urlPropia(r.urlMarco)) op.alActividad();
  };
  op.ipcMain.on(CANAL_ACTIVIDAD, alActividad);
  return () => {
    for (const m of METODOS) op.ipcMain.removeHandler(canalDe(m));
    op.ipcMain.removeListener(CANAL_ACTIVIDAD, alActividad);
  };
}
