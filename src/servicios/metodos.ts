/**
 * Lista de los métodos del contrato (api.ts) con el grupo al que pertenecen.
 *
 * Sirve para registrar los canales IPC (principal), exponerlos en el preload y
 * montar las rutas HTTP del servidor de desarrollo sin repetir los nombres a mano.
 *
 * ⚠️ Se mantiene a mano, pero no puede desincronizarse sin que se note:
 *  - en compilación, `Record<NombreMetodo, …>` exige TODAS las claves y prohíbe las sobrantes
 *    (`npm run typecheck`);
 *  - en pruebas, tests/principal-metodos.test.ts compara esta lista con el texto de api.ts.
 */
import type { NombreMetodo } from './api.ts';

export type GrupoMetodo = 'sistema' | 'clinica' | 'externa';

export const GRUPO_DE_METODO: Record<NombreMetodo, GrupoMetodo> = {
  // ApiSistema
  estado: 'sistema', primerUso: 'sistema', desbloquear: 'sistema', recuperar: 'sistema', bloquear: 'sistema',
  cambiarContrasena: 'sistema', listarUsuarios: 'sistema', iniciarSesion: 'sistema', cerrarSesion: 'sistema',
  crearUsuario: 'sistema', obtenerFarmacia: 'sistema', guardarFarmacia: 'sistema', obtenerAjustes: 'sistema',
  guardarAjustes: 'sistema', listarMomentos: 'sistema', guardarMomentos: 'sistema', listarAuditoria: 'sistema',
  verificarAuditoria: 'sistema', estadoCopias: 'sistema', crearCopia: 'sistema', desbloquearConCopia: 'sistema',
  // ApiClinica
  panelHoy: 'clinica', listarPacientes: 'clinica', obtenerPaciente: 'clinica', guardarPaciente: 'clinica',
  darDeBajaPaciente: 'clinica', listarCentros: 'clinica', guardarCentro: 'clinica', obtenerOCrearCentro: 'clinica', resumenOrigen: 'clinica', listarContactos: 'clinica',
  guardarContacto: 'clinica', listarSalud: 'clinica', guardarSalud: 'clinica', buscarMedicamentos: 'clinica',
  obtenerMedicamento: 'clinica', guardarMedicamento: 'clinica', analizarFichaTecnica: 'clinica',
  fichasIncompletas: 'clinica', listarTratamientos: 'clinica', guardarTratamiento: 'clinica', guardarPauta: 'clinica',
  finalizarTratamiento: 'clinica', listarEnvases: 'clinica', comprobarEntradaEnvase: 'clinica',
  registrarEnvase: 'clinica', cerrarEnvase: 'clinica', importarAlertaCalidad: 'clinica', evaluarPreparacion: 'clinica',
  crearPreparacion: 'clinica', marcarPreparada: 'clinica', validarPreparacion: 'clinica', registrarEntrega: 'clinica',
  anularPreparacion: 'clinica', listarPreparaciones: 'clinica', obtenerPreparacion: 'clinica', vistaEtiqueta: 'clinica',
  vistaHojaPaciente: 'clinica', listarPlantillasDocumento: 'clinica', vistaDocumento: 'clinica',
  registrarDocumentoFirmado: 'clinica', revocarDocumento: 'clinica', estadoConsentimientos: 'clinica',
  // ApiExterna (sólo proceso principal)
  consultarCima: 'externa', listarImpresoras: 'externa', imprimirHtml: 'externa', exportarPdf: 'externa',
  elegirCarpeta: 'externa', codigoSvg: 'externa',
};

/** Nombres de todos los métodos del contrato. */
export const METODOS: readonly NombreMetodo[] = Object.keys(GRUPO_DE_METODO) as NombreMetodo[];

const CONJUNTO = new Set<string>(METODOS);

/** ¿Es `nombre` un método del contrato? (lista blanca; `Object.hasOwn` evita «constructor», «__proto__»). */
export function esMetodo(nombre: unknown): nombre is NombreMetodo {
  return typeof nombre === 'string' && CONJUNTO.has(nombre);
}
