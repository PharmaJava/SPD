/**
 * CONTRATO ENTRE LA INTERFAZ Y EL PROGRAMA.
 *
 * Lo que la interfaz (renderer) puede pedir. En Electron cada método viaja por IPC
 * (preload → proceso principal → servicios); en desarrollo/pruebas viaja por HTTP
 * (scripts/dev-servidor.mjs). Los datos son JSON puro: nada de Date, Map ni undefined
 * dentro de arrays; las fechas son cadenas ISO (AAAA-MM-DD o AAAA-MM-DDTHH:MM:SSZ).
 *
 * Reglas del contrato:
 *  - TODO método devuelve `Resultado<T>`; nunca lanza hacia la interfaz.
 *  - La interfaz NO calcula reglas clínicas ni de caducidad: las decide el dominio
 *    (src/dominio) y llegan ya resueltas (bloqueos, avisos, mapas…).
 *  - Ningún método devuelve datos de un paciente sin sesión iniciada; los que leen la
 *    ficha de un paciente dejan rastro en la auditoría.
 */
import type { ResultadoPreparacion } from '../dominio/preparacion.ts';
import type { Aviso } from '../dominio/entrada-envase.ts';
import type { PropuestaDescripcion } from '../dominio/descripcion-fisica.ts';
import type { Clasificacion } from '../dominio/aptitud-spd.ts';
import type { TrazabilidadAlerta } from '../dominio/alertas-calidad.ts';

export type Resultado<T> = { ok: true; datos: T } | { ok: false; error: string; codigo?: string };

export type RolUsuario = 'titular' | 'farmaceutico' | 'tecnico' | 'administrativo';
export type EstadoPaciente = 'activo' | 'pausado' | 'baja' | 'fallecido';
export type EstadoPreparacion = 'borrador' | 'preparado' | 'validado' | 'entregado' | 'anulado';

// ───────────────────────────── Sistema ─────────────────────────────

export interface UsuarioPublico { id: number; nombre: string; iniciales: string; rol: RolUsuario }

export interface EstadoSistema {
  /** ¿Existe ya una base de datos creada (primer uso hecho)? */
  inicializado: boolean;
  /** ¿Se ha introducido la contraseña de la farmacia en esta ejecución? */
  desbloqueado: boolean;
  sesion: UsuarioPublico | null;
  version: string;
  /** Carpeta donde viven los datos cifrados (informativo). */
  rutaDatos: string;
  /** Segundos de espera antes de poder volver a probar la contraseña (0 = ya se puede). */
  esperaIntento: number;
}

export interface DatosFarmacia {
  nombre: string; titular: string; nif?: string | null; direccion?: string | null; codigoPostal?: string | null;
  municipio?: string | null; provincia?: string | null; comunidadAutonoma?: string | null; telefono?: string | null;
  email?: string | null; numeroAutorizacion?: string | null; spdDeclaracionFecha?: string | null; spdDeclaracionRef?: string | null;
  rgpdResponsable?: string | null; rgpdContacto?: string | null; rgpdDpd?: string | null;
}

export interface MomentoTomaDto { id: number; nombre: string; hora?: string | null; orden: number; activo: boolean }

export interface Ajustes {
  /** Validez estándar del SPD en días (por defecto 14). */
  diasValidezSpd: number;
  /** ¿Se permite preparar hasta 30 días (desviación asumida, con justificación)? */
  validezExtendidaPermitida: boolean;
  conservacionAniosTrasBaja: number;
  /** Minutos de inactividad antes de bloquear la pantalla. */
  bloqueoMinutos: number;
  /** Disposición del blíster por defecto. */
  inicioDia: 'convencional' | 'cronologico';
  rotar180: boolean;
  sentidoTomas: 'izquierda_derecha' | 'derecha_izquierda';
  posicionInicial: 'izquierda' | 'derecha';
  /** Lector de códigos: 'teclado' | 'serie', separador sustituto del GS (o ''), puerto y velocidad. */
  lector: { modo: 'teclado' | 'serie'; separadorGs: string; puerto?: string; baudios?: number };
  /** Impresora de etiquetas y de documentos (nombre de Windows) y plantilla activa. */
  impresoraEtiquetas?: string | null;
  impresoraDocumentos?: string | null;
  carpetaCopias?: string | null;
}

export interface PrimerUso {
  farmacia: DatosFarmacia;
  titular: { nombre: string; iniciales: string; pin: string };
  contrasena: string;
  momentos: { nombre: string; hora?: string }[];
}
export interface ResultadoPrimerUso {
  /** Clave de recuperación en texto (grupos de 4). Se muestra UNA vez. */
  claveRecuperacion: string;
  /** URI otpauth:// para guardarla en una app de autenticación. */
  uriAutenticador: string;
}

export interface EntradaAuditoriaDto {
  id: number; momento: string; usuario: string | null; accion: string; entidad: string; entidadId: string | null;
  motivo: string | null; resumen: string;
}
export interface EstadoCopias { ultima: string | null; atrasada: boolean; carpeta: string | null; total: number }

export interface ApiSistema {
  estado(): Promise<Resultado<EstadoSistema>>;
  primerUso(datos: PrimerUso): Promise<Resultado<ResultadoPrimerUso>>;
  desbloquear(contrasena: string): Promise<Resultado<EstadoSistema>>;
  /** Restablece la contraseña con la clave de recuperación (texto). */
  recuperar(claveRecuperacion: string, nuevaContrasena: string): Promise<Resultado<EstadoSistema>>;
  bloquear(): Promise<Resultado<EstadoSistema>>;
  cambiarContrasena(actual: string, nueva: string): Promise<Resultado<null>>;

  listarUsuarios(): Promise<Resultado<UsuarioPublico[]>>;
  iniciarSesion(usuarioId: number, pin: string): Promise<Resultado<UsuarioPublico>>;
  cerrarSesion(): Promise<Resultado<null>>;
  crearUsuario(u: { nombre: string; iniciales: string; rol: RolUsuario; numColegiado?: string; pin: string }): Promise<Resultado<UsuarioPublico>>;

  obtenerFarmacia(): Promise<Resultado<DatosFarmacia>>;
  guardarFarmacia(d: DatosFarmacia): Promise<Resultado<DatosFarmacia>>;
  obtenerAjustes(): Promise<Resultado<Ajustes>>;
  guardarAjustes(a: Partial<Ajustes>): Promise<Resultado<Ajustes>>;
  listarMomentos(): Promise<Resultado<MomentoTomaDto[]>>;
  guardarMomentos(m: { id?: number; nombre: string; hora?: string; orden: number; activo?: boolean }[]): Promise<Resultado<MomentoTomaDto[]>>;

  listarAuditoria(filtro: { entidad?: string; entidadId?: string; limite?: number }): Promise<Resultado<EntradaAuditoriaDto[]>>;
  verificarAuditoria(): Promise<Resultado<{ ok: boolean; entradas: number; primerError?: string }>>;

  estadoCopias(): Promise<Resultado<EstadoCopias>>;
  /** Copia cifrada en la carpeta de copias (o la indicada). */
  crearCopia(carpeta?: string): Promise<Resultado<{ ruta: string }>>;
}

// ───────────────────────────── Clínica ─────────────────────────────

export interface PacienteDto {
  id: number; idPublico: string; nombre: string; apellido1: string; apellido2?: string | null;
  fechaNacimiento?: string | null; sexo?: 'M' | 'H' | 'X' | null; dniNie?: string | null;
  cipAutonomico?: string | null; cipSns?: string | null; nass?: string | null; tsiCcaa?: string | null; aseguradora?: string | null;
  direccion?: string | null; codigoPostal?: string | null; municipio?: string | null; telefono?: string | null; telefono2?: string | null; email?: string | null;
  centroId?: number | null; habitacion?: string | null; necesitaBraille: boolean; letraGrande: boolean;
  estado: EstadoPaciente; motivoEstado?: string | null; altaEn: string; bajaEn?: string | null;
  proximaRevision?: string | null; notas?: string | null;
}
export type NuevoPaciente = Omit<PacienteDto, 'id' | 'idPublico' | 'altaEn' | 'bajaEn' | 'estado' | 'motivoEstado'> & { id?: number };

/** Fila de la lista de pacientes: lo que hace falta para decidir sin abrir la ficha. */
export interface PacienteResumen {
  id: number; nombreCompleto: string; estado: EstadoPaciente; centro?: string | null; habitacion?: string | null;
  alergias: string[]; consentimientoSpd: boolean;
  /** Días que cubren las cajas en uso (el mínimo de sus tratamientos emblistables); null si no tiene tratamientos. */
  coberturaDias: number | null;
  proximaPreparacion?: string | null;
  proximaRevision?: string | null;
}

export interface ContactoDto { id: number; pacienteId: number; tipo: string; nombre: string; dniNie?: string | null; parentesco?: string | null; telefono?: string | null; email?: string | null; numColegiado?: string | null; centroSalud?: string | null; autorizadoRecoger: boolean; notas?: string | null }
export interface SaludDatoDto { id: number; pacienteId: number; tipo: string; descripcion: string; valor?: string | null; fecha?: string | null; fuente?: string | null; vigente: boolean }
export interface CentroDto { id: number; nombre: string; direccion?: string | null; telefono?: string | null; contacto?: string | null }

export interface MedicamentoDto {
  cn: string; nombre: string; nregistro?: string | null; principiosActivos?: string | null; laboratorio?: string | null;
  formaFarmaceutica?: string | null; unidadesEnvase?: number | null; receta?: boolean | null; estupefaciente: boolean; psicotropo: boolean;
  descripcionFisica?: string | null; color?: string | null; forma?: string | null; marcasGrabado?: string | null; ranurado?: boolean | null;
  descripcionEstado: 'sin_datos' | 'propuesta' | 'confirmada';
  spdAptitud?: 'apto' | 'precaucion' | 'no_apto' | null; spdMotivo?: string | null;
  urlFichaTecnica?: string | null; urlProspecto?: string | null; creadoManual: boolean;
}
export interface RespuestaCima {
  /** false si no hubo conexión o CIMA no respondió: se dice, no se inventa. */
  disponible: boolean;
  medicamento?: MedicamentoDto;
  descripcion?: PropuestaDescripcion;
  aptitud?: Clasificacion | null;
  aviso?: string;
}

export interface DosisPautaDto { momentoId: number; unidades: number }
export interface PautaDto {
  id?: number; version?: number; vigenteDesde: string; vigenteHasta?: string | null;
  patron: 'diario' | 'dias_semana' | 'cada_n_dias' | 'ciclo' | 'si_precisa';
  diasSemana?: number[]; cadaNDias?: number; cicloOn?: number; cicloOff?: number; fechaAncla?: string;
  instrucciones?: string | null;
  origen: 'receta' | 'informe_medico' | 'comunicacion_medico' | 'paciente' | 'revision_farmaceutica' | 'correccion';
  origenDetalle?: string | null;
  dosis: DosisPautaDto[];
}
export interface TratamientoDto {
  id: number; pacienteId: number; principioActivo: string; dosisTexto?: string | null; cnPreferente?: string | null;
  indicacion?: string | null; emblistable: boolean; motivoNoEmblistable?: string | null; notaFarmaceutico?: string | null;
  creadoEn: string; finalizadoEn?: string | null; motivoFin?: string | null;
  pautas: PautaDto[];
  /** Resumen legible de la pauta vigente hoy: «1 desayuno + 1 cena, a diario». */
  pautaVigenteTexto: string;
  coberturaDias: number | null;
  medicamento?: MedicamentoDto | null;
}

export interface EnvaseDto {
  id: number; pacienteId: number; tratamientoId?: number | null; cn: string; medicamentoNombre: string;
  lote: string; caducidad: string; numeroSerie?: string | null; origenLectura: 'datamatrix' | 'manual';
  unidadesInicio: number; unidadesRestantes: number; estado: 'en_uso' | 'agotado' | 'devuelto' | 'retirado' | 'desechado';
  recibidoEn: string;
}
export interface EntradaEnvaseParams {
  pacienteId: number; tratamientoId?: number | null;
  cn: string; lote?: string; caducidad?: string; numeroSerie?: string;
  /** Lectura cruda del DataMatrix (opcional: el lote y la caducidad son obligatorios, el código no). */
  lecturaDatamatrix?: string;
  unidades: number;
}
export interface ResultadoEntradaEnvase {
  ok: boolean; bloqueos: Aviso[]; atencion: Aviso[]; info: Aviso[];
  /** Lo que se guardaría (o se guardó). */
  normalizado?: { cn: string; lote: string; caducidad: string; numeroSerie?: string; origenLectura: 'datamatrix' | 'manual'; unidades: number };
  medicamentoNombre?: string;
  /** Si ya se guardó (registrarEnvase) el id del envase. */
  envaseId?: number;
}

export interface EvaluarPreparacionParams {
  pacienteId: number; desde: string; dias: number; fechaPreparacion: string;
  diasValidez?: number; justificacion?: string;
}
/** Evaluación completa: todo lo que la interfaz necesita pintar (mapa, bloqueos, avisos, líneas). */
export interface EvaluacionPreparacion extends ResultadoPreparacion {
  paciente: { id: number; nombreCompleto: string };
  /** Nombre y color de cada tratamiento para pintar el mapa. */
  leyenda: { tratamientoId: number; nombre: string; abreviatura: string; color: string; letra: string; descripcion?: string }[];
  /** Celdas ya resueltas: qué hay en cada alvéolo (pintar sin recalcular nada). */
  alveolos: { mapa: number; fila: number; columna: number; fecha: string | null; momentoId: number; contenido: { tratamientoId: number; unidades: number; envaseId?: number; lote?: string }[] }[];
}

export interface PreparacionDto {
  id: number; idPublico: string; pacienteId: number; pacienteNombre: string; fechaInicio: string; fechaFin: string; caducidadSpd: string;
  validezDias: number; fueraDeEstandar: boolean; justificacionValidez?: string | null;
  estado: EstadoPreparacion; preparadoPor?: string | null; preparadoEn?: string | null; validadoPor?: string | null; validadoEn?: string | null;
  temperatura?: number | null; humedad?: number | null; observaciones?: string | null;
}
export interface VistaImprimible { html: string; imprimible: boolean; problemas: string[]; faltan: string[] }

export interface PlantillaDocumentoDto { codigo: string; version: number; titulo: string; obligatorioParaValidar: boolean }
export interface VistaDocumento {
  texto: string; faltan: string[]; imprimibleDefinitivo: boolean; esBorrador: boolean; hash: string; avisos: string[];
}
export interface EstadoConsentimientosDto { completo: boolean; faltan: string[]; desactualizados: string[]; revocados: string[]; firmados: { codigo: string; version: number; firmadoEn: string; firmante: string }[] }

export interface TareaHoy { tipo: string; gravedad: 'bloqueo' | 'atencion' | 'info'; texto: string; pacienteId?: number; accion?: string }
export interface PanelHoy {
  fecha: string;
  tareas: TareaHoy[];
  cifras: { pacientesActivos: number; preparacionesPendientes: number; cajasQueCaducan: number; pacientesSinCobertura: number; fichasIncompletas: number };
  copias: EstadoCopias;
}

export interface ApiClinica {
  panelHoy(): Promise<Resultado<PanelHoy>>;

  listarPacientes(filtro?: { texto?: string; estado?: EstadoPaciente | 'todos'; centroId?: number }): Promise<Resultado<PacienteResumen[]>>;
  obtenerPaciente(id: number): Promise<Resultado<PacienteDto>>;
  guardarPaciente(p: NuevoPaciente): Promise<Resultado<PacienteDto>>;
  darDeBajaPaciente(id: number, motivo: string, estado: Exclude<EstadoPaciente, 'activo'>): Promise<Resultado<PacienteDto>>;
  listarCentros(): Promise<Resultado<CentroDto[]>>;
  guardarCentro(c: Omit<CentroDto, 'id'> & { id?: number }): Promise<Resultado<CentroDto>>;
  listarContactos(pacienteId: number): Promise<Resultado<ContactoDto[]>>;
  guardarContacto(c: Omit<ContactoDto, 'id'> & { id?: number }): Promise<Resultado<ContactoDto>>;
  listarSalud(pacienteId: number): Promise<Resultado<SaludDatoDto[]>>;
  guardarSalud(s: Omit<SaludDatoDto, 'id'> & { id?: number }): Promise<Resultado<SaludDatoDto>>;

  buscarMedicamentos(texto: string): Promise<Resultado<MedicamentoDto[]>>;
  obtenerMedicamento(cn: string): Promise<Resultado<MedicamentoDto | null>>;
  /** Alta o edición manual. La descripción física confirmada la firma el usuario con rol farmacéutico/titular. */
  guardarMedicamento(m: Partial<MedicamentoDto> & { cn: string; nombre: string }, confirmarDescripcion?: boolean): Promise<Resultado<MedicamentoDto>>;
  /** Propone descripción y aptitud a partir de texto de ficha técnica pegado. */
  analizarFichaTecnica(textoSeccion3: string, nombre?: string, formaFarmaceutica?: string): Promise<Resultado<{ descripcion: PropuestaDescripcion; aptitud: Clasificacion | null }>>;
  fichasIncompletas(): Promise<Resultado<MedicamentoDto[]>>;

  listarTratamientos(pacienteId: number, incluirFinalizados?: boolean): Promise<Resultado<TratamientoDto[]>>;
  guardarTratamiento(t: { id?: number; pacienteId: number; principioActivo: string; dosisTexto?: string; cnPreferente?: string; indicacion?: string; emblistable: boolean; motivoNoEmblistable?: string; notaFarmaceutico?: string }): Promise<Resultado<TratamientoDto>>;
  /** Añade una versión nueva de la pauta (la anterior queda en el historial). */
  guardarPauta(tratamientoId: number, pauta: PautaDto): Promise<Resultado<TratamientoDto>>;
  finalizarTratamiento(id: number, motivo: string): Promise<Resultado<TratamientoDto>>;

  listarEnvases(pacienteId: number, incluirCerrados?: boolean): Promise<Resultado<EnvaseDto[]>>;
  /** Comprueba una entrada SIN guardar (para enseñar bloqueos y avisos mientras se teclea). */
  comprobarEntradaEnvase(e: EntradaEnvaseParams): Promise<Resultado<ResultadoEntradaEnvase>>;
  registrarEnvase(e: EntradaEnvaseParams): Promise<Resultado<ResultadoEntradaEnvase>>;
  cerrarEnvase(id: number, estado: 'devuelto' | 'retirado' | 'desechado', motivo: string): Promise<Resultado<EnvaseDto>>;
  importarAlertaCalidad(a: { referencia: string; cn?: string; lote?: string; fecha?: string; descripcion?: string; url?: string }): Promise<Resultado<TrazabilidadAlerta>>;

  evaluarPreparacion(p: EvaluarPreparacionParams): Promise<Resultado<EvaluacionPreparacion>>;
  /** Guarda un borrador (reserva lo evaluado). No descuenta unidades hasta validar. */
  crearPreparacion(p: EvaluarPreparacionParams & { temperatura?: number; humedad?: number; observaciones?: string }): Promise<Resultado<PreparacionDto>>;
  marcarPreparada(id: number): Promise<Resultado<PreparacionDto>>;
  /** Sólo farmacéutico/titular. Vuelve a evaluar, descuenta unidades y deja el estado «validado». */
  validarPreparacion(id: number): Promise<Resultado<PreparacionDto>>;
  registrarEntrega(id: number, e: { entregadoA: string; contactoId?: number; observaciones?: string }): Promise<Resultado<PreparacionDto>>;
  anularPreparacion(id: number, motivo: string): Promise<Resultado<PreparacionDto>>;
  listarPreparaciones(filtro?: { pacienteId?: number; estado?: EstadoPreparacion | 'todas' }): Promise<Resultado<PreparacionDto[]>>;
  obtenerPreparacion(id: number): Promise<Resultado<{ preparacion: PreparacionDto; evaluacion: EvaluacionPreparacion }>>;
  vistaEtiqueta(preparacionId: number): Promise<Resultado<VistaImprimible>>;
  /** Hoja A4 de plan de administración. */
  vistaHojaPaciente(preparacionId: number): Promise<Resultado<VistaImprimible>>;

  listarPlantillasDocumento(): Promise<Resultado<PlantillaDocumentoDto[]>>;
  vistaDocumento(codigo: string, pacienteId: number, firmante?: { nombre: string; dniNie?: string; calidad: 'paciente' | 'representante_legal' | 'guardador_de_hecho'; contactoId?: number }): Promise<Resultado<VistaDocumento>>;
  registrarDocumentoFirmado(codigo: string, pacienteId: number, firmante: { nombre: string; dniNie?: string; calidad: 'paciente' | 'representante_legal' | 'guardador_de_hecho'; contactoId?: number }): Promise<Resultado<{ id: number }>>;
  revocarDocumento(id: number, motivo: string): Promise<Resultado<null>>;
  estadoConsentimientos(pacienteId: number): Promise<Resultado<EstadoConsentimientosDto>>;
}

// ───────────────────── Externo (sólo proceso principal) ─────────────────────

export interface ImpresoraDto { nombre: string; predeterminada: boolean }

export interface ApiExterna {
  /** Consulta CIMA (AEMPS). Sólo viaja el CN. Si no hay red devuelve disponible:false. */
  consultarCima(cn: string): Promise<Resultado<RespuestaCima>>;
  listarImpresoras(): Promise<Resultado<ImpresoraDto[]>>;
  /** Imprime el HTML tal cual (etiqueta o documento). `silenciosa` = sin diálogo. */
  imprimirHtml(html: string, opciones: { impresora?: string; anchoMm?: number; altoMm?: number; silenciosa?: boolean }): Promise<Resultado<null>>;
  /** Guarda el HTML como PDF en la ruta elegida por el usuario (diálogo). */
  exportarPdf(html: string, nombreSugerido: string, opciones?: { anchoMm?: number; altoMm?: number }): Promise<Resultado<{ ruta: string } | null>>;
  elegirCarpeta(titulo: string): Promise<Resultado<string | null>>;
  /** Genera un QR/DataMatrix como SVG (sin red). */
  codigoSvg(texto: string, simbologia: 'qrcode' | 'datamatrix'): Promise<Resultado<string>>;
}

export type ApiSpd = ApiSistema & ApiClinica & ApiExterna;
/** Nombre de cada método del contrato (para registrar IPC/HTTP sin repetirlos a mano). */
export type NombreMetodo = keyof ApiSpd;

declare global {
  interface Window { spd: ApiSpd }
}
