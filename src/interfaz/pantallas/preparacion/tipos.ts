export interface EntradaPreparar {
  paciente: { id: number; nombre: string } | null;
  modoInicio: 'lunes' | 'hoy' | 'otra';
  desde: string; dias: 7 | 14 | 28; validez: number; justificacion: string;
}
/** Bloqueos que no impiden PREPARAR: sólo impiden validar (lo hará otra persona o más tarde). */
export const SOLO_PARA_VALIDAR = ['ROL_NO_PUEDE_VALIDAR', 'CONSENTIMIENTO_NO_VIGENTE'];
