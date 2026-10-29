/**
 * Servicios clínicos base: pacientes, medicamentos, tratamientos y pautas, envases
 * y panel «Hoy». Las preparaciones y los documentos viven en otro módulo.
 *
 * Reglas comunes (docs/10-seguridad.md, CLAUDE.md):
 *  - Sin sesión → fallo «Inicia sesión» (código SIN_SESION). Nada lanza hacia fuera.
 *  - Cada escritura: ctx.db().transaccion(...) con ctx.auditar(...) dentro y ctx.persistir() al final.
 *  - Todo el SQL lleva parámetros; el texto del usuario nunca se concatena.
 *  - El historial no se borra: se versiona o se marca.
 */
import type { Contexto } from './contexto.ts';
import type { ApiClinica } from './api.ts';
import * as pacientes from './clinica/pacientes.ts';
import * as medicamentos from './clinica/medicamentos.ts';
import * as tratamientos from './clinica/tratamientos.ts';
import * as envases from './clinica/envases.ts';
import { panelHoy } from './clinica/panel.ts';

export type ClinicaBase = Pick<ApiClinica,
  'panelHoy' | 'listarPacientes' | 'obtenerPaciente' | 'guardarPaciente' | 'darDeBajaPaciente' | 'listarCentros' | 'guardarCentro' | 'obtenerOCrearCentro' | 'resumenOrigen' |
  'listarContactos' | 'guardarContacto' | 'listarSalud' | 'guardarSalud' | 'buscarMedicamentos' | 'obtenerMedicamento' |
  'guardarMedicamento' | 'analizarFichaTecnica' | 'fichasIncompletas' | 'listarTratamientos' | 'guardarTratamiento' | 'guardarPauta' |
  'finalizarTratamiento' | 'listarEnvases' | 'comprobarEntradaEnvase' | 'registrarEnvase' | 'cerrarEnvase' | 'importarAlertaCalidad'>;

export function crearClinicaBase(ctx: Contexto): ClinicaBase {
  return {
    panelHoy: () => panelHoy(ctx),
    listarPacientes: (f) => pacientes.listarPacientes(ctx, f),
    obtenerPaciente: (id) => pacientes.obtenerPaciente(ctx, id),
    guardarPaciente: (p) => pacientes.guardarPaciente(ctx, p),
    darDeBajaPaciente: (id, motivo, estado) => pacientes.darDeBajaPaciente(ctx, id, motivo, estado),
    listarCentros: () => pacientes.listarCentros(ctx),
    guardarCentro: (c) => pacientes.guardarCentro(ctx, c),
    obtenerOCrearCentro: (c) => pacientes.obtenerOCrearCentro(ctx, c),
    resumenOrigen: () => pacientes.resumenOrigen(ctx),
    listarContactos: (id) => pacientes.listarContactos(ctx, id),
    guardarContacto: (c) => pacientes.guardarContacto(ctx, c),
    listarSalud: (id) => pacientes.listarSalud(ctx, id),
    guardarSalud: (s) => pacientes.guardarSalud(ctx, s),
    buscarMedicamentos: (t) => medicamentos.buscarMedicamentos(ctx, t),
    obtenerMedicamento: (cn) => medicamentos.obtenerMedicamento(ctx, cn),
    guardarMedicamento: (m, confirmar) => medicamentos.guardarMedicamento(ctx, m, confirmar),
    analizarFichaTecnica: (t, n, f) => medicamentos.analizarFichaTecnica(ctx, t, n, f),
    fichasIncompletas: () => medicamentos.fichasIncompletas(ctx),
    listarTratamientos: (id, fin) => tratamientos.listarTratamientos(ctx, id, fin),
    guardarTratamiento: (t) => tratamientos.guardarTratamiento(ctx, t),
    guardarPauta: (id, p) => tratamientos.guardarPauta(ctx, id, p),
    finalizarTratamiento: (id, m) => tratamientos.finalizarTratamiento(ctx, id, m),
    listarEnvases: (id, c) => envases.listarEnvases(ctx, id, c),
    comprobarEntradaEnvase: (e) => envases.comprobarEntradaEnvase(ctx, e),
    registrarEnvase: (e) => envases.registrarEnvase(ctx, e),
    cerrarEnvase: (id, e, m) => envases.cerrarEnvase(ctx, id, e, m),
    importarAlertaCalidad: (a) => envases.importarAlertaCalidad(ctx, a),
  };
}
