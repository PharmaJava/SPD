/** Utilidades comunes de la interfaz de base (U1). Sin DOM salvo aplicarAspecto/copiar. */
import { get, writable } from 'svelte/store';
import { tiposGuardadosValidos } from '../../dominio/avisos.ts';

/** Texto para la persona cuando el servicio sólo manda el código (o un mensaje que es un código en bruto). */
const TEXTO_POR_CODIGO: Record<string, string> = {
  POSIBLE_DUPLICADO: 'Esta caja parece ya registrada (mismo lote, caducidad y unidades). No se ha guardado.',
  ALERGIA_SIN_CONFIRMAR: 'Hay una posible alergia sin confirmar. Un farmacéutico o el titular debe revisarla con el paciente o el prescriptor antes de validar.',
  DESCRIPCION_FISICA_SIN_CONFIRMAR: 'Falta confirmar cómo es el comprimido (su descripción física). Un farmacéutico o el titular debe hacerlo en Medicamentos.',
  PERIODO_SOLAPADO: 'Este paciente ya tiene un blíster que cubre alguno de esos días. Elige otras fechas o revisa el blíster anterior.',
  FECHA_PREPARACION_FUTURA: 'La fecha de preparación es futura: un blíster se prepara hoy o antes. Revisa la fecha y la hora de este ordenador.',
  PAUTA_CON_HUECOS: 'Hay días sin pauta entre dos pautas del mismo medicamento. Corrige las fechas de las pautas en la ficha del paciente.',
  DOCUMENTO_YA_FIRMADO: 'Este documento ya está firmado y vigente. Si la firma nueva sustituye a la anterior, hay que indicarlo y explicar el motivo.',
};

/**
 * Mensaje para la persona: nunca códigos ni texto técnico.
 * Acepta un Error (`message`) o el Resultado fallido del contrato (`error`); si el texto viene vacío o es un código en bruto,
 * usa el de la tabla por código.
 */
export function mensajeError(e: unknown): string {
  const err = e as { message?: string; error?: string; codigo?: string } | undefined;
  if (err?.codigo === 'SIN_CONEXION') return 'No se puede hablar con el programa. Cierra y vuelve a abrir SPD; si sigue igual, avisa a quien lo mantiene.';
  const m = (err?.message ?? err?.error)?.trim();
  if (m && !/^[A-Z][A-Z0-9_]{3,}$/.test(m)) return m;
  return (err?.codigo ? TEXTO_POR_CODIGO[err.codigo] : undefined) ?? 'Ha ocurrido algo inesperado. Inténtalo de nuevo.';
}

export interface Tostada { id: number; texto: string; tipo: 'ok' | 'info' | 'atencion' | 'bloqueo'; veces: number }
export const tostadas = writable<Tostada[]>([]);
let contador = 0;
const temporizadores = new Map<number, ReturnType<typeof setTimeout>>();
/** Tostadas con el ratón (o el foco) encima: no se cierran solas mientras tanto. */
const detenidas = new Set<number>();

/** Cuánto tarda en cerrarse sola cada clase: los errores y avisos de atención 10 s (si no se tocan); los demás, 4 s. */
export function duracionTostada(tipo: Tostada['tipo']): number { return tipo === 'bloqueo' || tipo === 'atencion' ? 10_000 : 4000; }

function programar(id: number, tipo: Tostada['tipo']): void {
  clearTimeout(temporizadores.get(id));
  temporizadores.delete(id);
  if (detenidas.has(id)) return;
  temporizadores.set(id, setTimeout(() => cerrarTostada(id), duracionTostada(tipo)));
}
export function cerrarTostada(id: number): void {
  clearTimeout(temporizadores.get(id)); temporizadores.delete(id); detenidas.delete(id);
  tostadas.update(l => l.filter(t => t.id !== id));
}
/** «Cerrar todas». */
export function cerrarTodasTostadas(): void {
  for (const t of temporizadores.values()) clearTimeout(t);
  temporizadores.clear(); detenidas.clear();
  tostadas.set([]);
}
/** El ratón (o el foco) está encima: no se cierra sola hasta que se aparte. */
export function pausarTostada(id: number): void {
  detenidas.add(id); clearTimeout(temporizadores.get(id)); temporizadores.delete(id);
}
export function reanudarTostada(id: number): void {
  detenidas.delete(id);
  const tipo = get(tostadas).find(t => t.id === id)?.tipo;
  if (tipo) programar(id, tipo);
}
/**
 * Aviso breve. Se cierra con un clic. Los de error y atención se cierran solos a los 10 s si no se les pone el ratón encima
 * (un error que se va a los 3 s se pierde); el resto, a los 4 s. Un mensaje idéntico que ya está en pantalla no se apila:
 * suma «×N» y reinicia su cuenta atrás.
 */
export function avisar(texto: string, tipo: Tostada['tipo'] = 'ok', _ms = 3000): void {
  let existente: number | undefined;
  tostadas.update(l => {
    const igual = l.find(t => t.texto === texto && t.tipo === tipo);
    if (igual) { existente = igual.id; return l.map(t => (t.id === igual.id ? { ...t, veces: t.veces + 1 } : t)); }
    const id = ++contador;
    existente = id;
    return [...l, { id, texto, tipo, veces: 1 }].slice(-4);
  });
  if (existente !== undefined) programar(existente, tipo);
}

// ───────────── Avisos de «Hoy» que se quitan: sólo tipos de avisos generales, sin datos de pacientes ─────────────
const CLAVE_AVISOS_QUITADOS = 'spd.avisos.quitados';
export function leerTiposAvisosQuitados(): string[] {
  try { return tiposGuardadosValidos(JSON.parse(localStorage.getItem(CLAVE_AVISOS_QUITADOS) ?? '[]')); } catch { return []; }
}
export function guardarTiposAvisosQuitados(tipos: readonly string[]): void {
  try {
    if (tipos.length === 0) localStorage.removeItem(CLAVE_AVISOS_QUITADOS);
    else localStorage.setItem(CLAVE_AVISOS_QUITADOS, JSON.stringify(tiposGuardadosValidos([...tipos])));
  } catch { /* sin almacenamiento: no pasa nada */ }
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
  // Primero el portapapeles del sistema (el programa no da permiso de portapapeles a la página).
  try { const r = await window.spd.copiarAlPortapapeles(t); if (r.ok) return true; } catch { /* sigue con el respaldo */ }
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
