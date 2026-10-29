/**
 * Copia automática: intenta una copia cifrada cada pocas horas y como máximo una por día (UTC) mientras el
 * programa esté abierto. Sin Electron ni temporizadores globales (se inyectan). Un fallo no se repite en bucle:
 * se reintenta en el siguiente turno, y se informa con `alFallar` (sin datos de pacientes).
 */
import type { Temporizadores } from './inactividad.ts';
import { temporizadoresReales } from './inactividad.ts';

export const PRIMERA_COPIA_MS = 2 * 60_000;
export const CADA_MS = 3 * 3600_000;

export interface Planificador { parar(): void; readonly ultimoDia: string | null }

export function planificarCopias(op: {
  ejecutar: () => Promise<{ ok: boolean; error?: string; codigo?: string }>;
  alFallar?: (motivo: string) => void;
  t?: Temporizadores; primeraMs?: number; cadaMs?: number;
}): Planificador {
  const t = op.t ?? temporizadoresReales;
  let ultimoDia: string | null = null;
  let parado = false;
  let id: unknown = null;
  let enCurso = false;

  const turno = async () => {
    if (parado || enCurso) return;
    const hoy = new Date(t.ahora()).toISOString().slice(0, 10);
    if (ultimoDia !== hoy) {
      enCurso = true;
      try {
        const r = await op.ejecutar();
        if (r.ok) ultimoDia = hoy;
        else if (r.codigo !== 'SIN_CARPETA_COPIAS') op.alFallar?.(r.codigo ?? 'COPIA');   // sin carpeta no es un fallo: aún no se ha configurado
      } catch (e) { op.alFallar?.(e instanceof Error ? e.name : 'COPIA'); }
      finally { enCurso = false; }
    }
    if (!parado) id = t.setTimeout(turno, op.cadaMs ?? CADA_MS);
  };
  id = t.setTimeout(turno, op.primeraMs ?? PRIMERA_COPIA_MS);
  return { parar() { parado = true; if (id !== null) t.clearTimeout(id); }, get ultimoDia() { return ultimoDia; } };
}
