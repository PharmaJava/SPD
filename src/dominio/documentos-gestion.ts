/**
 * Documentos «gestionados sin firma individual»: la farmacia da por gestionado un consentimiento que no firma el paciente
 * uno a uno (p. ej. lo recoge la residencia). FUNCIONES PURAS y sin dependencias de Node: las usan el servicio y la interfaz.
 * No es una firma y nunca se presenta como tal.
 */

/** Cómo consta un documento: firma real del paciente (o su representante) o «gestionado sin firma individual» por la farmacia. */
export type OrigenDocumento = 'firma' | 'gestionado_sin_firma';

/**
 * Documentos que la farmacia puede dar por «gestionados sin firma individual» (p. ej. los recoge la residencia):
 * son los de consentimiento/información. Los que se firman cada vez (recibí, baja) o por persona (autorización
 * a terceros) NO: allí la firma ES el acto.
 */
export const GESTIONABLES_SIN_FIRMA: readonly string[] = ['consentimiento_spd', 'info_rgpd', 'comunicacion_medico'];

/**
 * Texto que queda guardado cuando la farmacia da un documento por «gestionado sin firma individual».
 * NO imita una firma ni el documento: dice con claridad lo que es. Es lo único que se guarda como `texto_impreso`
 * (y de lo que sale el hash) de ese registro, y es lo que se muestra; nunca se imprime como firmado.
 */
export function textoGestionadoSinFirma(d: { titulo: string; version: number; motivo: string; usuario: string; fecha: string; centro?: string | null }): string {
  const una = (x: string) => x.replace(/\s+/g, ' ').trim();
  return [
    'GESTIONADO SIN FIRMA INDIVIDUAL',
    `Documento: ${una(d.titulo)} (versión ${d.version}).`,
    d.centro ? `Centro: ${una(d.centro)}.` : '',
    `Motivo: ${una(d.motivo)}.`,
    `Registrado por ${una(d.usuario)} el ${d.fecha}.`,
    'No consta firma del paciente ni de su representante en este registro: la farmacia asume la gestión del documento fuera del programa.',
  ].filter(Boolean).join('\n');
}
