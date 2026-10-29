/**
 * Origen del paciente: individual (vive en su domicilio) o procedente de un centro.
 * Dominio puro: sin disco, red ni interfaz.
 *
 * ⚠️ El origen NO se guarda aparte: sale de si el paciente tiene centro. Una columna
 * `origen` más podría contradecir a `centro_id` y habría dos verdades.
 */
import { normalizar } from './aptitud-spd.ts';

export const TIPOS_CENTRO = [
  'residencia_mayores', 'salud_mental', 'infantil_menores', 'discapacidad',
  'hospital', 'sociosanitario', 'penitenciario', 'otro',
] as const;
export type TipoCentro = (typeof TIPOS_CENTRO)[number];
export type OrigenPaciente = 'individual' | 'centro';

export const ETIQUETA_TIPO_CENTRO: Record<TipoCentro, string> = {
  residencia_mayores: 'Residencia de mayores',
  salud_mental: 'Centro psiquiátrico / salud mental',
  infantil_menores: 'Centro infantil / menores',
  discapacidad: 'Centro de discapacidad',
  hospital: 'Hospital',
  sociosanitario: 'Centro sociosanitario',
  penitenciario: 'Centro penitenciario',
  otro: 'Otro centro',
};

export function esTipoCentro(v: unknown): v is TipoCentro {
  return typeof v === 'string' && (TIPOS_CENTRO as readonly string[]).includes(v);
}

export function origenDe(centroId: number | null | undefined): OrigenPaciente {
  return centroId === null || centroId === undefined ? 'individual' : 'centro';
}

/**
 * Clave para comparar nombres de centro: sin tildes, mayúsculas ni signos, con espacios
 * colapsados. «Residencia  San José.» y «residencia san jose» son el mismo centro.
 * Si queda vacía, no es un nombre válido.
 */
export function normalizarNombreCentro(nombre: unknown): string {
  return normalizar(nombre).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Primer centro cuyo nombre normalizado coincide (excluyendo `excluirId`). */
export function buscarCentroIgual<T extends { id: number; nombre: string }>(centros: readonly T[], nombre: string, excluirId?: number): T | undefined {
  const clave = normalizarNombreCentro(nombre);
  if (clave === '') return undefined;
  return centros.find((c) => c.id !== excluirId && normalizarNombreCentro(c.nombre) === clave);
}

/** Sugerencias para el autocompletado: contienen lo escrito (sin tildes ni mayúsculas); los que empiezan por ello, primero. */
export function sugerirCentros<T extends { nombre: string }>(centros: readonly T[], escrito: string, max = 8): T[] {
  const q = normalizarNombreCentro(escrito);
  if (q === '') return centros.slice(0, max);
  const con = centros.map((c) => ({ c, n: normalizarNombreCentro(c.nombre) })).filter((x) => x.n.includes(q));
  con.sort((a, b) => Number(!a.n.startsWith(q)) - Number(!b.n.startsWith(q)) || a.c.nombre.localeCompare(b.c.nombre, 'es'));
  return con.slice(0, max).map((x) => x.c);
}

export interface PacienteOrigen { centroId: number | null; centroNombre?: string | null; centroTipo?: TipoCentro | null }
export interface ResumenOrigen {
  total: number;
  individuales: number;
  /** Un elemento por cada tipo de centro (aunque sea 0), en el orden de TIPOS_CENTRO. */
  porTipo: { tipo: TipoCentro; etiqueta: string; pacientes: number; centros: number }[];
  porCentro: { centroId: number; nombre: string; tipo: TipoCentro; pacientes: number }[];
}

/** Cuenta pacientes por origen. `centrosActivos` aporta los centros con 0 pacientes. */
export function resumirOrigen(
  pacientes: readonly PacienteOrigen[],
  centros: readonly { id: number; nombre: string; tipo: TipoCentro }[] = [],
): ResumenOrigen {
  const cuenta = new Map<number, number>();
  const info = new Map<number, { nombre: string; tipo: TipoCentro }>(centros.map((c) => [c.id, { nombre: c.nombre, tipo: c.tipo }]));
  let individuales = 0;
  for (const p of pacientes) {
    if (p.centroId === null || p.centroId === undefined) { individuales++; continue; }
    cuenta.set(p.centroId, (cuenta.get(p.centroId) ?? 0) + 1);
    if (!info.has(p.centroId)) info.set(p.centroId, { nombre: p.centroNombre ?? 'Centro', tipo: p.centroTipo ?? 'otro' });
  }
  const porCentro = [...info.entries()]
    .map(([centroId, i]) => ({ centroId, nombre: i.nombre, tipo: i.tipo, pacientes: cuenta.get(centroId) ?? 0 }))
    .sort((a, b) => b.pacientes - a.pacientes || a.nombre.localeCompare(b.nombre, 'es'));
  const porTipo = TIPOS_CENTRO.map((tipo) => {
    const cs = porCentro.filter((c) => c.tipo === tipo);
    return { tipo, etiqueta: ETIQUETA_TIPO_CENTRO[tipo], pacientes: cs.reduce((s, c) => s + c.pacientes, 0), centros: cs.length };
  });
  return { total: pacientes.length, individuales, porTipo, porCentro };
}
