/**
 * Qué decir y a dónde mandar ante los bloqueos de la preparación que tienen arreglo en otra pantalla.
 * El texto del bloqueo lo escribe el programa (dominio); aquí sólo se añade, en lenguaje llano, qué hacer.
 */
import { dejarPaso, ir, rutas } from './util.ts';

export interface Solucion { texto: string; ruta?: string; hacer?: () => void }

/** Qué hacer, en una o dos frases, según el código estable del bloqueo. */
export const QUE_HACER: Record<string, string> = {
  PERIODO_SOLAPADO: 'Ese paciente ya tiene un blíster que cubre alguno de esos días. Elige otras fechas, o revisa el blíster anterior (si se hizo por error, se puede anular).',
  FECHA_PREPARACION_FUTURA: 'Un blíster se prepara hoy o antes, nunca en el futuro. Revisa que la fecha y la hora de este ordenador sean correctas.',
  PAUTA_CON_HUECOS: 'Hay días sin pauta entre dos pautas del mismo medicamento, y esos días no se prepararía nada. Corrige las fechas de las pautas en la pestaña Tratamiento, o finaliza el tratamiento si ya no se toma.',
  DESCRIPCION_FISICA_SIN_CONFIRMAR: 'Sin la descripción confirmada no se puede reconocer el comprimido dentro del blíster. Un farmacéutico o el titular tiene que confirmarla en la ficha del medicamento (Medicamentos).',
  ALERGIA_SIN_CONFIRMAR: 'Puedes preparar el blíster, pero para validarlo un farmacéutico o el titular tiene que revisar la posible alergia con el paciente o el prescriptor.',
};

/** El código nacional que cita el texto de un bloqueo («… (CN 654321): …»), si lo hay. */
export function cnDelTexto(texto: string): string | null {
  return /\(CN (\d{6,7})\)/.exec(texto)?.[1] ?? null;
}

/** Enlace de solución común a los pasos «Revisar» y «Validar». */
export function solucionComun(codigo: string, texto: string, pacienteId?: number): Solucion | null {
  switch (codigo) {
    case 'DESCRIPCION_FISICA_SIN_CONFIRMAR': {
      const cn = cnDelTexto(texto);
      return { texto: 'Ir a Medicamentos', hacer: () => { if (cn) dejarPaso('spd.medicamentos.abrirCn', cn); ir(rutas.medicamentos()); } };
    }
    case 'PERIODO_SOLAPADO': return pacienteId ? { texto: 'Ver sus blísteres', ruta: rutas.paciente(pacienteId, 'blisteres') } : null;
    case 'PAUTA_CON_HUECOS': return pacienteId ? { texto: 'Revisar el tratamiento', ruta: rutas.paciente(pacienteId, 'tratamiento') } : null;
    case 'ALERGIA_SIN_CONFIRMAR': return pacienteId ? { texto: 'Ver las alergias del paciente', ruta: rutas.paciente(pacienteId, 'datos') } : null;
    default: return null;
  }
}
