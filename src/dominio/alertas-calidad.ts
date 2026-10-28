/**
 * Alertas de calidad (AEMPS) sobre cajas YA custodiadas y trazabilidad inversa
 * (docs/04-flujos.md §4.7).
 *
 * La entrada de un envase ya comprueba las alertas (entrada-envase.ts); esto
 * cubre el caso contrario: la alerta llega DESPUÉS de que la caja esté en uso.
 *
 * Reglas:
 *  - Coincidencia: cn+lote, sólo lote (cualquier medicamento) o sólo cn (todos
 *    los lotes). Lote sin distinguir mayúsculas y con trim. Una alerta sin cn
 *    ni lote NO identifica nada: se ignora y se AVISA (nunca se adivina).
 *  - Un CN de la alerta que no se entiende no casa con nada, y se avisa.
 *  - Sólo clasificación LOGÍSTICA: retirar la caja, rehacer un blíster aún no
 *    entregado, avisar al paciente de uno ya entregado. Nada clínico.
 *  - Ante datos incoherentes (entrega registrada con la preparación sin marcar
 *    entregada) se asume ENTREGADA —lado seguro— y se avisa.
 *
 * FUNCIONES PURAS: sin disco, red ni reloj. Índices Map: lineal en el tamaño.
 */
import { normalizarCN } from './gs1.ts';
import type { Envase } from './tipos.ts';

export interface AlertaCalidad {
  referencia: string;
  cn?: string;
  lote?: string;
  fecha?: string;
  descripcion?: string;
}

export interface LineaPreparacionRef { preparacionId: number; envaseId: number; [k: string]: unknown }
export interface PreparacionRef {
  id: number;
  pacienteId: number;
  estado: string; // borrador | preparado | validado | entregado | anulado
  fechaInicio: string;
  fechaFin: string;
}
export interface EntregaRef { preparacionId: number; entregadoEn: string }

export interface EnvaseAfectado { envase: Envase; alertas: AlertaCalidad[] }
export interface ResultadoAfectados { afectados: EnvaseAfectado[]; avisos: string[] }

export type Actuacion = 'retirar_envase' | 'rehacer_blister_no_entregado' | 'avisar_paciente_entregado';

export interface PreparacionAfectada {
  preparacionId: number;
  pacienteId: number;
  estado: string;
  entregado: boolean;
  entregadoEn: string | null;
  envaseIds: number[];
  /** null si la preparación está anulada y nunca se entregó: no hay nada que hacer. */
  actuacion: Actuacion | null;
}

export interface TrazabilidadAlerta {
  alerta: AlertaCalidad;
  /** Todos los envases custodiados que casan (cualquier estado). */
  envases: Envase[];
  /** Los que siguen `en_uso`: hay que apartarlos (actuación 'retirar_envase'). */
  envasesARetirar: number[];
  preparaciones: PreparacionAfectada[];
  /** Pacientes con un blíster ya entregado que usó un envase afectado. */
  pacientesAAvisar: number[];
  avisos: string[];
}

export interface ContextoTrazabilidad {
  envases: Envase[];
  lineasPreparacion: LineaPreparacionRef[];
  preparaciones: PreparacionRef[];
  entregas: EntregaRef[];
}

export const claveLote = (l: string | undefined | null): string =>
  typeof l === 'string' ? l.trim().toUpperCase() : '';

function cnDeAlerta(a: AlertaCalidad): { cn: string | null; malformado: boolean } {
  if (typeof a.cn !== 'string' || a.cn.trim() === '') return { cn: null, malformado: false };
  const n = normalizarCN(a.cn);
  return n ? { cn: n, malformado: false } : { cn: null, malformado: true };
}

interface IndiceEnvases {
  porLote: Map<string, Envase[]>;
  porCn: Map<string, Envase[]>;
}

const cnDeEnvase = (e: Envase): string => normalizarCN(e.cn) ?? e.cn;

function indexarEnvases(envases: Envase[]): IndiceEnvases {
  const porLote = new Map<string, Envase[]>();
  const porCn = new Map<string, Envase[]>();
  for (const e of envases) {
    const kl = claveLote(e.lote);
    if (kl) (porLote.get(kl) ?? porLote.set(kl, []).get(kl)!).push(e);
    const kc = cnDeEnvase(e);
    (porCn.get(kc) ?? porCn.set(kc, []).get(kc)!).push(e);
  }
  return { porLote, porCn };
}

/** Envases que casan con UNA alerta; `aviso` si la alerta no se puede usar. */
function casar(a: AlertaCalidad, idx: IndiceEnvases): { envases: Envase[]; aviso?: string } {
  const { cn, malformado } = cnDeAlerta(a);
  const lote = claveLote(a.lote);
  if (malformado) return { envases: [], aviso: `La alerta ${a.referencia} trae un CN que no se entiende (${a.cn}): no se puede cruzar. Revisarla a mano.` };
  if (!cn && !lote) return { envases: [], aviso: `La alerta ${a.referencia} no trae CN ni lote: no identifica ninguna caja. Revisarla a mano.` };
  if (lote) {
    const delLote = idx.porLote.get(lote) ?? [];
    return { envases: cn ? delLote.filter((e) => cnDeEnvase(e) === cn) : delLote };
  }
  return { envases: idx.porCn.get(cn!) ?? [] };
}

/** Envases (de cualquier estado) afectados por alguna alerta, sin duplicados. */
export function envasesAfectados(envases: Envase[], alertas: AlertaCalidad[]): ResultadoAfectados {
  const avisos: string[] = [];
  const vistos = new Map<number, EnvaseAfectado>();
  if (!alertas || alertas.length === 0) return { afectados: [], avisos };
  const idx = indexarEnvases(envases);
  for (const a of alertas) {
    const r = casar(a, idx);
    if (r.aviso) avisos.push(r.aviso);
    for (const e of r.envases) {
      const ya = vistos.get(e.id);
      if (ya) { if (!ya.alertas.includes(a)) ya.alertas.push(a); }
      else vistos.set(e.id, { envase: e, alertas: [a] });
    }
  }
  return { afectados: [...vistos.values()], avisos };
}

export function trazabilidadInversa(alertas: AlertaCalidad[], ctx: ContextoTrazabilidad): TrazabilidadAlerta[] {
  const idx = indexarEnvases(ctx.envases);
  const lineasPorEnvase = new Map<number, LineaPreparacionRef[]>();
  for (const l of ctx.lineasPreparacion) {
    (lineasPorEnvase.get(l.envaseId) ?? lineasPorEnvase.set(l.envaseId, []).get(l.envaseId)!).push(l);
  }
  const prepPorId = new Map<number, PreparacionRef>();
  for (const p of ctx.preparaciones) prepPorId.set(p.id, p);
  const entregaPorPrep = new Map<number, string>(); // la más reciente
  for (const e of ctx.entregas) {
    const prev = entregaPorPrep.get(e.preparacionId);
    if (prev === undefined || e.entregadoEn > prev) entregaPorPrep.set(e.preparacionId, e.entregadoEn);
  }

  return alertas.map((alerta) => {
    const avisos: string[] = [];
    const r = casar(alerta, idx);
    if (r.aviso) avisos.push(r.aviso);
    const envases = r.envases;
    const envasesARetirar = envases.filter((e) => e.estado === 'en_uso').map((e) => e.id);

    const porPrep = new Map<number, Set<number>>();
    for (const e of envases) {
      for (const l of lineasPorEnvase.get(e.id) ?? []) {
        (porPrep.get(l.preparacionId) ?? porPrep.set(l.preparacionId, new Set()).get(l.preparacionId)!).add(e.id);
      }
    }

    const preparaciones: PreparacionAfectada[] = [];
    for (const [prepId, ids] of porPrep) {
      const p = prepPorId.get(prepId);
      if (!p) {
        avisos.push(`Hay líneas de la preparación ${prepId} que usan un envase afectado, pero la preparación no consta: revisar.`);
        continue;
      }
      const fechaEntrega = entregaPorPrep.get(prepId);
      const hayEntrega = fechaEntrega !== undefined;
      const entregado = hayEntrega || p.estado === 'entregado';
      if (hayEntrega && p.estado !== 'entregado') {
        avisos.push(`La preparación ${prepId} tiene una entrega registrada pero su estado es «${p.estado}»: se trata como ENTREGADA. Revisar.`);
      }
      if (!hayEntrega && p.estado === 'entregado') {
        avisos.push(`La preparación ${prepId} figura «entregado» sin registro de entrega: se trata como entregada. Revisar.`);
      }
      let actuacion: Actuacion | null;
      if (entregado) actuacion = 'avisar_paciente_entregado';
      else if (p.estado === 'anulado') actuacion = null;
      else actuacion = 'rehacer_blister_no_entregado';
      preparaciones.push({
        preparacionId: prepId,
        pacienteId: p.pacienteId,
        estado: p.estado,
        entregado,
        entregadoEn: fechaEntrega ?? null,
        envaseIds: [...ids].sort((a, b) => a - b),
        actuacion,
      });
    }
    preparaciones.sort((a, b) => a.preparacionId - b.preparacionId);
    const pacientesAAvisar = [...new Set(preparaciones.filter((x) => x.actuacion === 'avisar_paciente_entregado').map((x) => x.pacienteId))].sort((a, b) => a - b);
    return { alerta, envases, envasesARetirar, preparaciones, pacientesAAvisar, avisos };
  });
}
