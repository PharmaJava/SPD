/** Utilidades comunes de la interfaz de base (U1). Sin DOM salvo aplicarAspecto/copiar. */
import { writable } from 'svelte/store';

/** Mensaje para la persona: nunca códigos ni texto técnico. */
export function mensajeError(e: unknown): string {
  const err = e as { message?: string; codigo?: string } | undefined;
  if (err?.codigo === 'SIN_CONEXION') return 'No se puede hablar con el programa. Cierra y vuelve a abrir SPD; si sigue igual, avisa a quien lo mantiene.';
  const m = err?.message?.trim();
  if (!m) return 'Ha ocurrido algo inesperado. Inténtalo de nuevo.';
  return m;
}

export interface Tostada { id: number; texto: string; tipo: 'ok' | 'info' | 'atencion' | 'bloqueo' }
export const tostadas = writable<Tostada[]>([]);
let contador = 0;
export function avisar(texto: string, tipo: Tostada['tipo'] = 'ok', ms = 4000): void {
  const id = ++contador;
  tostadas.update(l => [...l, { id, texto, tipo }]);
  setTimeout(() => tostadas.update(l => l.filter(t => t.id !== id)), ms);
}

// ───────────── Aspecto (tema y tamaño de letra), guardado en el equipo ─────────────
export type Tema = 'auto' | 'claro' | 'oscuro';
export interface Aspecto { tema: Tema; letra: number }
const CLAVE_ASPECTO = 'spd.aspecto';
export function leerAspecto(): Aspecto {
  try {
    const a = JSON.parse(localStorage.getItem(CLAVE_ASPECTO) ?? '{}') as Partial<Aspecto>;
    return { tema: a.tema === 'claro' || a.tema === 'oscuro' ? a.tema : 'auto', letra: a.letra && a.letra >= 14 && a.letra <= 22 ? a.letra : 16 };
  } catch { return { tema: 'auto', letra: 16 }; }
}
export function aplicarAspecto(a: Aspecto): void {
  const oscuro = a.tema === 'oscuro' || (a.tema === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  document.documentElement.style.setProperty('--base', `${a.letra}px`);
  try { localStorage.setItem(CLAVE_ASPECTO, JSON.stringify(a)); } catch { /* sin almacenamiento: no pasa nada */ }
}

// ───────────── Pequeños ayudantes de datos ─────────────
export function edad(nacimiento?: string | null, hoy = new Date()): number | null {
  const m = nacimiento ? /^(\d{4})-(\d{2})-(\d{2})/.exec(nacimiento) : null;
  if (!m) return null;
  let a = hoy.getFullYear() - +m[1];
  if (hoy.getMonth() + 1 < +m[2] || (hoy.getMonth() + 1 === +m[2] && hoy.getDate() < +m[3])) a--;
  return a;
}
export function inicialesDe(nombre: string): string {
  return nombre.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(p => p[0]!.toUpperCase()).join('');
}
export function nombreRol(r: string): string {
  return ({ titular: 'Titular', farmaceutico: 'Farmacéutico/a', tecnico: 'Técnico/a', administrativo: 'Administrativo/a' } as Record<string, string>)[r] ?? r;
}
/** Fortaleza 0-4 de una contraseña y su etiqueta. */
export function fortaleza(p: string): { nivel: number; texto: string } {
  let n = 0;
  if (p.length >= 10) n++;
  if (p.length >= 14) n++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) n++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) n++;
  if (p.length < 10) n = Math.min(n, 1);
  if (/^(.)\1+$/.test(p) || /^(1234|abcd|password|contrase)/i.test(p)) n = 0;
  return { nivel: n, texto: ['Muy débil', 'Débil', 'Aceptable', 'Buena', 'Muy buena'][n]! };
}
export async function copiarTexto(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { return document.execCommand('copy'); } catch { return false; } finally { ta.remove(); }
  }
}
export const ROLES_PUEDE_VALIDAR = ['titular', 'farmaceutico'];
export const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
export const DIAS_SEMANA_LARGO = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
export const COMUNIDADES = ['Andalucía','Aragón','Asturias','Baleares','Canarias','Cantabria','Castilla-La Mancha','Castilla y León','Cataluña','Ceuta','Comunidad Valenciana','Extremadura','Galicia','La Rioja','Madrid','Melilla','Murcia','Navarra','País Vasco'];
/** Clase de color y texto de la cobertura (días que cubren las cajas). La cifra la calcula el servicio. */
export function coberturaVista(d: number | null | undefined): { clase: string; texto: string } {
  if (d == null) return { clase: 'suave', texto: '—' };
  if (d <= 0) return { clase: 'cobertura-nula', texto: 'Sin cobertura' };
  return { clase: d < 14 ? 'cobertura-baja' : 'cobertura-ok', texto: `${d} ${d === 1 ? 'día' : 'días'}` };
}
export const ESTADOS_PACIENTE: Record<string, string> = { activo: 'Activo', pausado: 'Pausado', baja: 'De baja', fallecido: 'Fallecido' };
