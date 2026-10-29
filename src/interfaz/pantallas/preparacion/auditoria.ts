/** Palabras llanas para la auditoría. Lo que no se conoce se enseña tal cual, sin inventar. */
const ACCIONES: Record<string, string> = {
  crear: 'Alta', modificar: 'Cambio', ver: 'Consulta de la ficha', imprimir: 'Impresión', validar: 'Validación', anular: 'Anulación',
  entregar: 'Entrega', revocar: 'Revocación', cerrar: 'Cierre', baja: 'Baja', login: 'Inicio de sesión', logout: 'Cierre de sesión', firmar: 'Firma registrada',
  confirmar_descripcion: 'Confirmación del aspecto', exportar: 'Exportación', crear_copia: 'Copia de seguridad', registrar_firma: 'Firma registrada', registrar: 'Registro',
};
const ENTIDADES: Record<string, string> = {
  paciente: 'Paciente', envase: 'Caja', preparacion: 'Blíster', tratamiento: 'Tratamiento', pauta: 'Pauta', medicamento: 'Medicamento',
  documento: 'Documento', consentimiento: 'Consentimiento', usuario: 'Usuario', ajustes: 'Ajustes', contacto: 'Contacto', sistema: 'Sistema', salud_dato: 'Dato de salud', documento_firmado: 'Documento firmado', entrega: 'Entrega', alerta_calidad: 'Alerta de calidad', farmacia: 'Datos de la farmacia',
};
export const accionHumana = (a: string) => ACCIONES[a] ?? (a ? a.charAt(0).toUpperCase() + a.slice(1).replace(/_/g, ' ') : '—');
export const entidadHumana = (e: string) => ENTIDADES[e] ?? (e ? e.charAt(0).toUpperCase() + e.slice(1).replace(/_/g, ' ') : '—');
export const ENTIDADES_FILTRO = Object.entries(ENTIDADES);
