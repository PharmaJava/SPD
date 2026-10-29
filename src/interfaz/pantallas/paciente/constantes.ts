/** Rótulos en español de los vocabularios cerrados del contrato. */
import type { PautaDto, MomentoTomaDto } from '../../../servicios/api.ts';
import { unidades } from '../../lib/formato.ts';
import { DIAS_SEMANA_LARGO } from '../../componentes/util.ts';

export const SALUD_TIPOS: Record<string, string> = {
  alergia: 'Alergia', intolerancia: 'Intolerancia', diagnostico: 'Diagnóstico', disfagia: 'Dificultad para tragar (disfagia)',
  insuficiencia_renal: 'Insuficiencia renal', insuficiencia_hepatica: 'Insuficiencia hepática', embarazo_lactancia: 'Embarazo o lactancia', peso: 'Peso', otro: 'Otro',
};
export const CONTACTO_TIPOS: Record<string, string> = {
  cuidador: 'Cuidador/a', representante_legal: 'Representante legal', familiar: 'Familiar', medico_cabecera: 'Médico de cabecera',
  especialista: 'Médico especialista', enfermeria: 'Enfermería', centro: 'Centro', otro: 'Otro',
};
export const ORIGENES: Record<PautaDto['origen'], string> = {
  receta: 'Receta', informe_medico: 'Informe médico', comunicacion_medico: 'Comunicación del médico', paciente: 'Dicho por el paciente',
  revision_farmaceutica: 'Revisión farmacéutica', correccion: 'Corrección de un error',
};
export const PATRONES: Record<PautaDto['patron'], string> = {
  diario: 'Todos los días', dias_semana: 'Solo algunos días de la semana', cada_n_dias: 'Cada cierto número de días', ciclo: 'Ciclo (días de toma y de descanso)', si_precisa: 'Solo si precisa (no va al blíster)',
};

/** «1 en el desayuno + ½ en la cena, lunes y jueves» — sólo presentación, la pauta la decide el farmacéutico. */
export function textoPauta(p: PautaDto, momentos: MomentoTomaDto[]): string {
  const nom = (id: number) => (momentos.find(m => m.id === id)?.nombre ?? 'momento ' + id).toLowerCase();
  const dosis = [...p.dosis].sort((a, b) => (momentos.find(m => m.id === a.momentoId)?.orden ?? 0) - (momentos.find(m => m.id === b.momentoId)?.orden ?? 0))
    .map(d => `${unidades(d.unidades)} en ${nom(d.momentoId)}`).join(' + ');
  let cuando = '';
  switch (p.patron) {
    case 'diario': cuando = 'a diario'; break;
    case 'dias_semana': cuando = (p.diasSemana ?? []).slice().sort((a, b) => a - b).map(d => DIAS_SEMANA_LARGO[d - 1]).join(', '); break;
    case 'cada_n_dias': cuando = `cada ${p.cadaNDias} días`; break;
    case 'ciclo': cuando = `${p.cicloOn} días de toma y ${p.cicloOff} de descanso`; break;
    case 'si_precisa': return 'Solo si precisa (no se prepara en el blíster)';
  }
  return `${dosis || 'sin dosis'}, ${cuando}`;
}
