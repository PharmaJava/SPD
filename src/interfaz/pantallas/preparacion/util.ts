/** Ayudas pequeñas compartidas por las pantallas de cajas, preparación, medicamentos y auditoría (U2). */
import { spd, datos } from '../../api.ts';
import type { UsuarioPublico } from '../../../servicios/api.ts';

export function mensaje(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Rutas de la aplicación. Si el armazón cambia el formato de las rutas, se corrige aquí
 * (único sitio de las pantallas de U2 que lo sabe).
 */
export const rutas = {
  cajas: (pacienteId?: number) => (pacienteId ? `#/cajas/${pacienteId}` : '#/cajas'),
  preparar: (pacienteId?: number) => (pacienteId ? `#/preparar/${pacienteId}` : '#/preparar'),
  medicamentos: () => '#/medicamentos',
  paciente: (id: number, pestana = '') => `#/pacientes/${id}${pestana ? '/' + pestana : ''}`,
};
export function ir(ruta: string): void { location.hash = ruta; }

/** Sesión actual (rol) para decidir qué botones se ofrecen. El servidor sigue siendo quien manda. */
export async function cargarSesion(): Promise<UsuarioPublico | null> {
  try { return (await datos(spd.estado())).sesion; } catch { return null; }
}
export const puedeValidar = (rol?: string | null): boolean => rol === 'titular' || rol === 'farmaceutico';

export const NOMBRE_ROL: Record<string, string> = {
  titular: 'titular', farmaceutico: 'farmacéutico/a', tecnico: 'técnico/a', administrativo: 'administrativo/a',
};

/** Pitido corto (error de lectura). Silencioso si el navegador no deja audio. */
export function pita(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 330; g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.35);
    setTimeout(() => ctx.close().catch(() => {}), 600);
  } catch { /* sin audio */ }
}

// Estado de trabajo con datos de pacientes: sólo en memoria (ver lib/efimero.ts), nunca en localStorage.
export { leerEfimero as leerLocal, guardarEfimero as guardarLocal, borrarEfimero as borrarLocal } from '../../lib/efimero.ts';

/** Lee y borra un valor de paso entre pantallas (sessionStorage). */
export function tomarPaso(clave: string): string | null {
  try { const v = sessionStorage.getItem(clave); if (v !== null) sessionStorage.removeItem(clave); return v; } catch { return null; }
}
export function dejarPaso(clave: string, valor: string): void { try { sessionStorage.setItem(clave, valor); } catch { /* nada */ } }

export function escaparHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Color de un medicamento en el mapa: el del servicio si es válido; si no, la paleta del tema. */
export function colorMed(color: string | undefined, indice: number): string {
  if (color && /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(color.trim())) return color.trim();
  return `var(--med-${(indice % 8) + 1})`;
}

/** Markdown mínimo (títulos, negrita) y datos que faltan (⟦…⟧) para enseñar y imprimir un documento. Escapa antes de nada. */
export function mdBasico(texto: string): string {
  // Los comentarios de la plantilla (<!-- … -->) no son texto del documento. Lo único de HTML que se admite es <small>…</small> (pie «Documento n.º · versión»),
  // y se admite DESPUÉS de escapar: nada más que esa etiqueta exacta llega a pintarse como marcado.
  const limpio = texto.replace(/<!--[\s\S]*?-->/g, '');
  return escaparHtml(limpio).split('\n').map(l => {
    const t = l.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/⟦(.+?)⟧/g, '<mark>[falta: $1]</mark>')
      .replace(/&lt;small&gt;(.*?)&lt;\/small&gt;/g, '<small>$1</small>');
    const h = /^#{1,3}\s+(.*)$/.exec(t);
    return h ? `<h3>${h[1]}</h3>` : t;
  }).join('<br>').replace(/<\/h3><br>/g, '</h3>');
}

/**
 * HTML que se imprime (o se guarda como PDF) de un documento del paciente: EL TEXTO DEL DOCUMENTO Y NADA MÁS.
 * Sin marca de borrador ni banner: el papel que firma el paciente no lleva avisos del programa (CLAUDE.md, regla 6).
 */
export function htmlDocumentoImprimible(texto: string, titulo: string): string {
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escaparHtml(titulo)}</title><style>@page{size:A4;margin:18mm}body{font-family:Georgia,serif;font-size:11.5pt;line-height:1.4;color:#000}mark{background:#fff3b0}h3{font-size:13pt}</style></head><body><div>${mdBasico(texto)}</div></body></html>`;
}

/** Identificador corto y legible de un blíster (el UUID completo no es para personas). */
export const corto = (idPublico: string): string => 'SPD-' + idPublico.replace(/-/g, '').slice(0, 8).toUpperCase();
