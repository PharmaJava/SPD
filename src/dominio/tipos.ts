/**
 * Tipos compartidos del dominio (fechas ISO AAAA-MM-DD; cantidades en unidades
 * de medicamento, admiten fracciones 0.5 / 0.25). Sin lógica.
 */

/** Momentos de toma definidos por el farmacéutico. */
export interface MomentoToma { id: number; nombre: string; orden: number; hora?: string }

export type PatronPauta = 'diario' | 'dias_semana' | 'cada_n_dias' | 'ciclo' | 'si_precisa';

/** Una versión de pauta (ver tabla pauta_version + pauta_dosis). */
export interface Pauta {
  vigenteDesde: string;
  vigenteHasta?: string | null;        // null/undefined = indefinida
  patron: PatronPauta;
  diasSemana?: number[];               // 1 = lunes … 7 = domingo (patron dias_semana)
  cadaNDias?: number;                  // patron cada_n_dias
  cicloOn?: number;                    // patron ciclo: días con toma
  cicloOff?: number;                   // patron ciclo: días de descanso
  fechaAncla?: string;                 // desde dónde se cuentan cada_n_dias y ciclos
  dosis: { momentoId: number; unidades: number }[];
}

/** Una caja custodiada. */
export interface Envase {
  id: number;
  tratamientoId: number;
  cn: string;                          // 6 dígitos
  lote: string;
  caducidad: string;                   // AAAA-MM-DD
  numeroSerie?: string;
  unidadesRestantes: number;
  estado: 'en_uso' | 'agotado' | 'devuelto' | 'retirado' | 'desechado';
}

/** Unidades de un día y momento. */
export interface TomaDia { fecha: string; momentoId: number; unidades: number }
