/**
 * Alertas de calidad (AEMPS) sobre cajas YA custodiadas y trazabilidad inversa
 * (docs/04-flujos.md §4.7).
 *
 * La entrada de un envase ya comprueba las alertas (entrada-envase.ts); esto
 * cubre el caso contrario: la alerta llega DESPUÉS de que la caja esté en uso.
 *
 * Reglas:
 *  - Coincidencia: cn+lote, sólo lote (cualquier medicamento) o sólo cn (todos
 *    los lotes). Lote y CN normalizados (claveLote/claveCn): sin separadores, espacios, ceros iniciales ni mayúsculas. Una alerta sin cn
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
  /**
   * Cajas «aparte» (no emblistables: insulina, jarabes…) afectadas. No pasan por
   * preparacion_linea; su paciente consta en la propia caja y se AVISA siempre
   * (puede habérsele entregado ya aparte).
   */
  envasesAparte: { envaseId: number; pacienteId: number; estado: string }[];
  /** true si la alerta es por CN y no hay ninguna caja con ese CN en el sistema (informativo, no es un visto bueno). */
  sinCajasEnSistema: boolean;
  avisos: string[];
}

export interface ContextoTrazabilidad {
  envases: Envase[];
  lineasPreparacion: LineaPreparacionRef[];
  preparaciones: PreparacionRef[];
  entregas: EntregaRef[];
}

/**
 * Clave de cruce de un LOTE: mayúsculas, sin espacios ni separadores y sin ceros
 * iniciales de cada grupo de dígitos («L-01» = «l 1»). NO equipara «L1» con «L10»
 * ni confunde la O con el 0: un cruce demasiado laxo da alertas falsas.
 */
export const claveLote = (l: string | undefined | null): string =>
  typeof l === 'string'
    ? l.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/\d+/g, (d) => d.replace(/^0+(?=\d)/, ''))
    : '';

/**
 * Clave de cruce de un CN: sólo dígitos (EAN/GTIN → CN, 7 dígitos con control → 6) y sin
 * ceros iniciales, para que «012345» y «12345» casen. El dígito de control no se valida.
 */
export function claveCn(entrada: string | undefined | null): string {
  if (typeof entrada !== 'string') return '';
  const n = normalizarCN(entrada);
  const d = n ?? entrada.replace(/c\.?\s*n\.?/i, '').replace(/\D/g, '');
  return d.replace(/^0+/, '');
}

function cnDeAlerta(a: AlertaCalidad): { cn: string | null; malformado: boolean } {
  if (typeof a.cn !== 'string' || a.cn.trim() === '') return { cn: null, malformado: false };
  const k = claveCn(a.cn);
  return k.length >= 3 && k.length <= 6 ? { cn: k, malformado: false } : { cn: null, malformado: true };
}

interface IndiceEnvases {
  porLote: Map<string, Envase[]>;
  porCn: Map<string, Envase[]>;
}

const cnDeEnvase = (e: Envase): string => claveCn(e.cn) || e.cn;

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
    const { cn: cnAlerta } = cnDeAlerta(alerta);
    const sinCajasEnSistema = cnAlerta !== null && !claveLote(alerta.lote) && envases.length === 0;
    if (sinCajasEnSistema) avisos.push(`Informativo: la alerta ${alerta.referencia} es por CN (${alerta.cn}) y no hay ninguna caja con ese CN en el sistema. Revisa las existencias físicas por si hubiera cajas sin registrar.`);
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
    const envasesAparte: TrazabilidadAlerta['envasesAparte'] = [];
    for (const e of envases) {
      if (!e.aparte) continue;
      if (typeof e.pacienteId !== 'number') {
        avisos.push(`La caja ${e.id} (lote ${e.lote}) es de medicación «aparte» y no consta de qué paciente es: revisar a mano.`);
        continue;
      }
      envasesAparte.push({ envaseId: e.id, pacienteId: e.pacienteId, estado: e.estado });
    }
    const pacientesAAvisar = [...new Set([
      ...preparaciones.filter((x) => x.actuacion === 'avisar_paciente_entregado').map((x) => x.pacienteId),
      ...envasesAparte.map((x) => x.pacienteId),
    ])].sort((a, b) => a - b);
    return { alerta, envases, envasesARetirar, preparaciones, pacientesAAvisar, envasesAparte, sinCajasEnSistema, avisos };
  });
}
