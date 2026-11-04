/**
 * ApiSistema: estado, primer uso, desbloqueo, usuarios, farmacia, ajustes, momentos, auditoría y copias.
 *
 * `crearSistema` construye el almacén cifrado, el Contexto real (que usan los servicios clínicos) y la
 * implementación del contrato. NINGÚN método lanza hacia fuera: todo pasa por `proteger`.
 *
 * Reglas de acceso (doc 10.2): titular → todo; farmacéutico → ajustes, momentos, auditoría, copias;
 * técnico y administrativo → sólo ver. Cambiar la validez extendida, crear usuarios, cambiar la
 * contraseña y editar los datos de la farmacia es sólo del titular.
 */
import type {
  Ajustes, ApiSistema, CopiaDto, ResultadoRestauracion, DatosFarmacia, EntradaAuditoriaDto, EstadoCopias, EstadoSistema, MomentoTomaDto, PrimerUso,
  Resultado, ResultadoPrimerUso, RolUsuario, UsuarioPublico,
} from './api.ts';
import { crearAlmacen, COD_COPIA_DISPONIBLE } from './almacen.ts';
import type { Temporizador } from './almacen.ts';
import { ErrorSpd, proteger } from './contexto.ts';
import type { Contexto, DatosAuditoria } from './contexto.ts';
import type { Db } from './db.ts';
import { crearCopiaFichero, estadoDeCopias, leerFicheroCopia, listarCopias as listarCopiasCarpeta, rutaDeCopia } from './copias.ts';
import type { MetaCopia } from './copias.ts';
import { VERSION_ESQUEMA } from './db.ts';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { COD_CONTRASENA, COD_PROTECTOR, exigirContrasenaValida, hashPin, limitadorContrasena, limitadorPin, verificarPin } from './seguridad.ts';
import type { LimitadorFallos, ProtectorClave } from './seguridad.ts';
import { claveDesdeTexto, textoRecuperacion, uriAutenticador } from '../dominio/clave-recuperacion.ts';
import { crearEntrada, diferencias, HASH_GENESIS, verificarCadena } from '../dominio/auditoria.ts';
import { CONFIG_IMPRESION_POR_DEFECTO, normalizarConfigImpresion, validarConfigImpresion } from '../dominio/etiquetas-hoja.ts';
import type { EntradaAuditoria } from '../dominio/auditoria.ts';

export interface OpcionesSistema {
  rutaDatos: string;
  wasmPath?: string;
  ahora?: () => Date;
  version?: string;
  /** Carpeta de copias de seguridad cuando no hay ninguna configurada (sólo para las de «antes de actualizar/restaurar»). */
  carpetaCopiasPorDefecto?: string;
  /** Pruebas: espera del guardado diferido y temporizador inyectable. */
  debounceMs?: number;
  temporizador?: Temporizador;
  alError?: (e: Error) => void;
  /** Sólo pruebas: scrypt más barato. */
  kdf?: { n: number; r: number; p: number };
  /** Almacén de claves del sistema operativo (Electron safeStorage; sólo en el proceso principal). Sin él no hay modo «sin contraseña». */
  protector?: ProtectorClave;
}

export interface Sistema {
  api: ApiSistema;
  ctx: Contexto;
  cerrar(): Promise<void>;
  /** ¿Está desbloqueada la base? (síncrono; lo usa la impresión del proceso principal) */
  estaDesbloqueado(): boolean;
  /** Equivale a `api.bloquear()`; lo llama el proceso principal tras la inactividad. */
  bloquearPorInactividad(): Promise<Resultado<EstadoSistema>>;
  /** Tras `FICHERO_DANADO_COPIA_DISPONIBLE`: abre la copia anterior (el usuario ya ha aceptado perder los últimos cambios). */
  recuperarConCopia(claveRecuperacion: string, nuevaContrasena: string): Promise<Resultado<{ estado: EstadoSistema; aviso: string }>>;
  /** Copia diaria automática: no pide sesión (sólo copia el fichero cifrado). */
  crearCopiaAutomatica(): Promise<Resultado<{ ruta: string }>>;
  /** Copia obligatoria antes de instalar una versión nueva. Funciona bloqueado (copia el fichero cifrado). `ruta` null = aún no hay datos. */
  crearCopiaPreActualizacion(version: string): Promise<Resultado<{ ruta: string | null }>>;
  /** Vacía lo pendiente a disco (para pruebas y para el cierre). */
  guardarAhora(): Promise<void>;
}

const ROLES: RolUsuario[] = ['titular', 'farmaceutico', 'tecnico', 'administrativo'];
const CAMPOS_OCULTOS = ['hash_clave', 'pin', 'contrasena', 'nuevaContrasena', 'claveRecuperacion', 'clave'];
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const ULTIMO_HASH = 'auditoria_ultimo_hash';

const AJUSTES_POR_DEFECTO: Ajustes = {
  diasValidezSpd: 14, validezExtendidaPermitida: false, exigirConsentimientos: true, conservacionAniosTrasBaja: 2, bloqueoMinutos: 5,
  inicioDia: 'convencional', rotar180: false, sentidoTomas: 'izquierda_derecha', posicionInicial: 'izquierda',
  lector: { modo: 'teclado', separadorGs: '' }, impresoraEtiquetas: null, impresoraDocumentos: null, impresionEtiquetas: CONFIG_IMPRESION_POR_DEFECTO, carpetaCopias: null,
  pedirPin: true, pedirUsuarioAlArrancar: true, usuarioPredeterminadoId: null,
};

const err = (m: string, c: string) => new ErrorSpd(m, c);
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Política única de seguridad.ts (la misma que el medidor de la interfaz): primer uso, cambio y recuperación. */
const validarContrasenaNueva = exigirContrasenaValida;
function validarPin(p: unknown): string {
  if (typeof p !== 'string' || !/^\d{4,8}$/.test(p)) throw err('El PIN debe tener entre 4 y 8 cifras.', 'PIN_INVALIDO');
  return p;
}

export function crearSistema(opciones: OpcionesSistema): Sistema {
  const ahora = opciones.ahora ?? (() => new Date());
  const version = opciones.version ?? '1.0.5';
  const almacen = crearAlmacen({
    rutaDatos: opciones.rutaDatos, wasmPath: opciones.wasmPath, ahora, debounceMs: opciones.debounceMs,
    temporizador: opciones.temporizador, alError: opciones.alError, kdf: opciones.kdf, protector: opciones.protector,
    // Sello de la auditoría para el fichero de estado (detección de marcha atrás): id y hash de la última entrada.
    sello: (base) => {
      const f = base.get<{ id: number; hash: string }>('SELECT id, hash FROM auditoria ORDER BY id DESC LIMIT 1');
      return { contador: f ? Number(f.id) : 0, hash: f ? String(f.hash) : '' };
    },
  });

  let sesion: UsuarioPublico | null = null;
  let avisoSeguridad: string | null = null;
  const relojMs = () => ahora().getTime();
  const limContrasena = limitadorContrasena(relojMs);
  const limPines = new Map<number, LimitadorFallos>();
  const limPin = (id: number) => { let l = limPines.get(id); if (!l) { l = limitadorPin(relojMs); limPines.set(id, l); } return l; };

  const db = (): Db => {
    if (!almacen.estaDesbloqueado()) throw err('El programa está bloqueado: introduce la contraseña de la farmacia.', 'BLOQUEADO');
    return almacen.db();
  };

  // ───────────────────────────── Contexto real ─────────────────────────────

  function escribirAuditoria(d: DatosAuditoria, usuarioId: number | null): void {
    const base = almacen.db();   // lanza Error('bloqueado') si lo está
    const ult = base.get<{ hash: string }>('SELECT hash FROM auditoria ORDER BY id DESC LIMIT 1');
    const e = crearEntrada({
      momento: ahora().toISOString(), usuarioId, accion: d.accion, entidad: d.entidad,
      entidadId: d.entidadId == null ? null : String(d.entidadId), antes: d.antes ?? null, despues: d.despues ?? null,
      motivo: d.motivo ?? null, camposOcultos: CAMPOS_OCULTOS,
    }, ult?.hash ?? HASH_GENESIS);
    base.run('INSERT INTO auditoria(momento,usuario_id,accion,entidad,entidad_id,antes,despues,motivo,hash_previo,hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [e.momento, e.usuarioId, e.accion, e.entidad, e.entidadId, JSON.stringify(e.antes), JSON.stringify(e.despues), e.motivo, e.hashPrevio, e.hash]);
    // Segundo testigo del último eslabón: borrar la última entrada no rompe la cadena, pero sí descuadra esto.
    base.run('INSERT INTO ajuste(clave,valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', [ULTIMO_HASH, e.hash]);
  }

  const ctx: Contexto = {
    db: () => almacen.db(),
    ahora: () => ahora(),
    sesion: () => sesion,
    auditar: (d) => escribirAuditoria(d, d.usuarioId !== undefined ? d.usuarioId : sesion?.id ?? null),
    identificarValidador(validadorId) {
      const s = exigirSesion();
      if (leerAjustes(db()).pedirPin) return { usuario: s, sesion: s, sinPin: false };
      // Sin PIN nadie queda identificado por entrar: validar exige ELEGIR al farmacéutico/titular y confirmarlo (el rol lo comprueba quien llama).
      if (validadorId === undefined || validadorId === null) throw err('Sin PIN hay que decir quién valida: elige al farmacéutico o titular y confirma que eres tú.', 'VALIDADOR_REQUERIDO');
      const f = db().get<Record<string, unknown>>('SELECT id, nombre, iniciales, rol FROM usuario WHERE id = ? AND activo = 1', [Number(validadorId)]);
      if (!f) throw err('El usuario que valida no existe o está dado de baja.', 'USUARIO_NO_ENCONTRADO');
      return { usuario: aPublico(f), sesion: s, sinPin: true };
    },
    persistir: () => almacen.persistir(),
  };

  // ───────────────────────────── Ayudas ─────────────────────────────

  const aPublico = (f: Record<string, unknown>): UsuarioPublico =>
    ({ id: Number(f.id), nombre: String(f.nombre), iniciales: String(f.iniciales), rol: f.rol as RolUsuario });

  function exigirSesion(...roles: RolUsuario[]): UsuarioPublico {
    if (!sesion) throw err('Inicia sesión con tu PIN para hacer esto.', 'SIN_SESION');
    if (roles.length && !roles.includes(sesion.rol)) throw err('Tu rol no permite hacer esto.', 'SIN_PERMISO');
    return sesion;
  }

  function estadoSync(): EstadoSistema {
    let inicializado = false;
    try { inicializado = almacen.existe(); } catch { /* sin acceso a la carpeta: se dice como no inicializado */ }
    let modoAcceso: 'contrasena' | 'sistema' | null = null;
    try { modoAcceso = inicializado ? almacen.modoAcceso() : null; } catch { /* se queda sin saber */ }
    const sistemaOk = almacen.accesoSistemaDisponible();
    return {
      inicializado, desbloqueado: almacen.estaDesbloqueado(), sesion,
      ...(almacen.estaDesbloqueado() && avisoSeguridad ? { avisoSeguridad } : {}),
      version, rutaDatos: opciones.rutaDatos,
      // Sin contraseña de arranque no hay intentos de contraseña que limitar.
      esperaIntento: modoAcceso === 'sistema' ? 0 : limContrasena.espera(),
      modoAcceso, accesoSistemaDisponible: sistemaOk,
      ...(sistemaOk ? {} : { motivoSistemaNoDisponible: almacen.motivoSistemaNoDisponible() }),
    };
  }

  function auditarYGuardar(d: DatosAuditoria, usuarioId?: number | null) {
    escribirAuditoria(d, usuarioId === undefined ? sesion?.id ?? null : usuarioId);
    almacen.persistir();
  }

  // ───────────────────────────── Ajustes ─────────────────────────────

  const CLAVES_AJUSTE = {
    diasValidezSpd: 'dias_validez_spd', validezExtendidaPermitida: 'validez_extendida_permitida', exigirConsentimientos: 'exigir_consentimientos',
    conservacionAniosTrasBaja: 'conservacion_anios_tras_baja', bloqueoMinutos: 'bloqueo_minutos',
    inicioDia: 'inicio_dia', rotar180: 'rotar_180', sentidoTomas: 'sentido_tomas', posicionInicial: 'posicion_inicial',
    lector: 'lector', impresoraEtiquetas: 'impresora_etiquetas', impresoraDocumentos: 'impresora_documentos', impresionEtiquetas: 'impresion_etiquetas', carpetaCopias: 'carpeta_copias',
    pedirPin: 'pedir_pin', pedirUsuarioAlArrancar: 'pedir_usuario_arranque', usuarioPredeterminadoId: 'usuario_predeterminado_id',
  } as const;

  function leerImpresion(crudo: string | undefined) {
    try { return normalizarConfigImpresion(crudo ? JSON.parse(crudo) : null); } catch { return normalizarConfigImpresion(null); }
  }

  function leerAjustes(base: Db): Ajustes {
    const mapa = new Map(base.all<{ clave: string; valor: string }>('SELECT clave, valor FROM ajuste').map(f => [f.clave, f.valor]));
    const entero = (k: string, def: number) => { const n = Number(mapa.get(k)); return mapa.has(k) && Number.isFinite(n) ? n : def; };
    const bool = (k: string, def: boolean) => (mapa.has(k) ? mapa.get(k) === '1' : def);
    const enumer = <T extends string>(k: string, validos: readonly T[], def: T): T => (validos as readonly string[]).includes(mapa.get(k) ?? '') ? mapa.get(k) as T : def;
    let lector = { ...AJUSTES_POR_DEFECTO.lector };
    try { const l = JSON.parse(mapa.get('lector') ?? 'null'); if (l && typeof l === 'object') lector = { ...lector, ...l }; } catch { /* valor por defecto */ }
    const d = AJUSTES_POR_DEFECTO;
    return {
      diasValidezSpd: entero('dias_validez_spd', d.diasValidezSpd),
      validezExtendidaPermitida: bool('validez_extendida_permitida', d.validezExtendidaPermitida),
      exigirConsentimientos: bool('exigir_consentimientos', d.exigirConsentimientos),
      conservacionAniosTrasBaja: entero('conservacion_anios_tras_baja', d.conservacionAniosTrasBaja),
      bloqueoMinutos: entero('bloqueo_minutos', d.bloqueoMinutos),
      inicioDia: enumer('inicio_dia', ['convencional', 'cronologico'], d.inicioDia),
      rotar180: bool('rotar_180', d.rotar180),
      sentidoTomas: enumer('sentido_tomas', ['izquierda_derecha', 'derecha_izquierda'], d.sentidoTomas),
      posicionInicial: enumer('posicion_inicial', ['izquierda', 'derecha'], d.posicionInicial),
      lector,
      impresoraEtiquetas: mapa.get('impresora_etiquetas') ?? null,
      impresoraDocumentos: mapa.get('impresora_documentos') ?? null,
      impresionEtiquetas: leerImpresion(mapa.get('impresion_etiquetas')),
      carpetaCopias: mapa.get('carpeta_copias') ?? null,
      pedirPin: bool('pedir_pin', d.pedirPin),
      pedirUsuarioAlArrancar: bool('pedir_usuario_arranque', d.pedirUsuarioAlArrancar),
      usuarioPredeterminadoId: mapa.has('usuario_predeterminado_id') && Number.isInteger(Number(mapa.get('usuario_predeterminado_id'))) ? Number(mapa.get('usuario_predeterminado_id')) : null,
    };
  }

  function validarAjustes(a: Partial<Ajustes>): void {
    const rango = (v: unknown, min: number, max: number, nombre: string) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw err(`${nombre} debe ser un número entero entre ${min} y ${max}.`, 'AJUSTE_INVALIDO');
    };
    if (a.diasValidezSpd !== undefined) rango(a.diasValidezSpd, 1, 30, 'La validez del SPD (días)');
    if (a.conservacionAniosTrasBaja !== undefined) rango(a.conservacionAniosTrasBaja, 1, 50, 'La conservación tras la baja (años)');
    // 0 = no bloquear solo (lo ofrece la interfaz con ese aviso); hasta 240 min.
    if (a.bloqueoMinutos !== undefined) rango(a.bloqueoMinutos, 0, 240, 'El bloqueo por inactividad (minutos)');
    const bools: (keyof Ajustes)[] = ['validezExtendidaPermitida', 'exigirConsentimientos', 'rotar180', 'pedirPin', 'pedirUsuarioAlArrancar'];
    if (a.usuarioPredeterminadoId !== undefined && a.usuarioPredeterminadoId !== null) rango(a.usuarioPredeterminadoId, 1, 2_000_000_000, 'El usuario predeterminado');
    for (const k of bools) if (a[k] !== undefined && typeof a[k] !== 'boolean') throw err(`«${k}» debe ser verdadero o falso.`, 'AJUSTE_INVALIDO');
    const enums: [keyof Ajustes, string[]][] = [
      ['inicioDia', ['convencional', 'cronologico']], ['sentidoTomas', ['izquierda_derecha', 'derecha_izquierda']], ['posicionInicial', ['izquierda', 'derecha']],
    ];
    for (const [k, v] of enums) if (a[k] !== undefined && !v.includes(a[k] as string)) throw err(`Valor no válido en «${k}».`, 'AJUSTE_INVALIDO');
    if (a.lector !== undefined) {
      const l = a.lector as Ajustes['lector'] | null;
      if (!l || (l.modo !== 'teclado' && l.modo !== 'serie')) throw err('El modo del lector debe ser «teclado» o «serie».', 'AJUSTE_INVALIDO');
      if (typeof l.separadorGs !== 'string' || l.separadorGs.length > 4) throw err('El separador del lector no es válido.', 'AJUSTE_INVALIDO');
      if (l.puerto !== undefined && (typeof l.puerto !== 'string' || l.puerto.length > 100)) throw err('El puerto del lector no es válido.', 'AJUSTE_INVALIDO');
      if (l.baudios !== undefined) rango(l.baudios, 300, 921600, 'La velocidad del lector');
    }
    if (a.impresionEtiquetas !== undefined) {
      const motivos = validarConfigImpresion(a.impresionEtiquetas);
      if (motivos.length) throw err(`La impresión de etiquetas no es válida: ${motivos.join(' ')}`, 'AJUSTE_INVALIDO');
    }
    for (const k of ['impresoraEtiquetas', 'impresoraDocumentos', 'carpetaCopias'] as const) {
      const v = a[k];
      if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 500)) throw err(`«${k}» no es válido.`, 'AJUSTE_INVALIDO');
    }
  }

  /** La carpeta de copias tiene que ser una ruta ABSOLUTA, existir, ser una carpeta y admitir escritura: si no, las copias fallarían en silencio. */
  function exigirCarpetaCopiasUtil(ruta: string): void {
    const falla = (motivo: string) => err(`La carpeta de copias «${ruta}» no sirve: ${motivo}`, 'AJUSTE_INVALIDO');
    if (!isAbsolute(ruta)) throw falla('tiene que ser una ruta completa (por ejemplo D:\\Copias SPD), no relativa.');
    let ok = false;
    try { ok = statSync(ruta).isDirectory(); } catch { throw falla('no existe. Créala antes o elige otra.'); }
    if (!ok) throw falla('no es una carpeta.');
    try { rmSync(mkdtempSync(join(ruta, '.spd-prueba-')), { recursive: true, force: true }); }
    catch { throw falla('no se puede escribir en ella (permisos o disco de sólo lectura).'); }
  }

  function guardarClave(base: Db, clave: string, valor: unknown): void {
    if (valor === null || valor === undefined || valor === '') { base.run('DELETE FROM ajuste WHERE clave = ?', [clave]); return; }
    const v = typeof valor === 'boolean' ? (valor ? '1' : '0') : typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
    base.run('INSERT INTO ajuste(clave,valor) VALUES (?,?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor', [clave, v]);
  }

  // ───────────────────────────── Farmacia ─────────────────────────────

  const COLUMNAS_FARMACIA: [keyof DatosFarmacia, string][] = [
    ['nombre', 'nombre'], ['titular', 'titular'], ['nif', 'nif'], ['direccion', 'direccion'], ['codigoPostal', 'codigo_postal'],
    ['municipio', 'municipio'], ['provincia', 'provincia'], ['comunidadAutonoma', 'comunidad_autonoma'], ['telefono', 'telefono'],
    ['email', 'email'], ['numeroAutorizacion', 'numero_autorizacion'], ['spdDeclaracionFecha', 'spd_declaracion_fecha'],
    ['spdDeclaracionRef', 'spd_declaracion_ref'], ['rgpdResponsable', 'rgpd_responsable'], ['rgpdContacto', 'rgpd_contacto'], ['rgpdDpd', 'rgpd_dpd'],
  ];

  function leerFarmacia(base: Db): DatosFarmacia | null {
    const f = base.get<Record<string, string | null>>('SELECT * FROM farmacia WHERE id = 1');
    if (!f) return null;
    const d: Record<string, unknown> = {};
    for (const [k, col] of COLUMNAS_FARMACIA) d[k] = f[col] ?? null;
    d.nombre = f.nombre ?? ''; d.titular = f.titular ?? '';
    return d as unknown as DatosFarmacia;
  }

  function normalizarFarmacia(d: DatosFarmacia): DatosFarmacia {
    const nombre = texto(d?.nombre), titular = texto(d?.titular);
    if (!nombre) throw err('Falta el nombre de la farmacia.', 'FARMACIA_INVALIDA');
    if (!titular) throw err('Falta el nombre del titular.', 'FARMACIA_INVALIDA');
    const r: Record<string, unknown> = { nombre, titular };
    for (const [k] of COLUMNAS_FARMACIA) if (k !== 'nombre' && k !== 'titular') {
      const v = (d as unknown as Record<string, unknown>)[k];
      if (v !== undefined && v !== null && typeof v !== 'string') throw err(`El campo «${k}» no es válido.`, 'FARMACIA_INVALIDA');
      r[k] = texto(v);
    }
    if (r.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email as string)) throw err('El correo de la farmacia no parece válido.', 'FARMACIA_INVALIDA');
    return r as unknown as DatosFarmacia;
  }

  function escribirFarmacia(base: Db, d: DatosFarmacia): void {
    const cols = COLUMNAS_FARMACIA.map(([, c]) => c);
    const valores = COLUMNAS_FARMACIA.map(([k]) => (d as unknown as Record<string, string | null>)[k] ?? null);
    if (base.get('SELECT id FROM farmacia WHERE id = 1')) {
      base.run(`UPDATE farmacia SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = 1`, valores);
    } else {
      base.run(`INSERT INTO farmacia(id, ${cols.join(', ')}) VALUES (1, ${cols.map(() => '?').join(', ')})`, valores);
    }
  }

  // ───────────────────────────── Momentos ─────────────────────────────

  const aMomento = (f: Record<string, unknown>): MomentoTomaDto =>
    ({ id: Number(f.id), nombre: String(f.nombre), hora: (f.hora as string | null) ?? null, orden: Number(f.orden), activo: Number(f.activo) === 1 });

  function leerMomentos(base: Db): MomentoTomaDto[] {
    return base.all('SELECT id, nombre, hora, orden, activo FROM momento_toma ORDER BY orden, id').map(aMomento);
  }

  function validarMomentos(m: { nombre: string; hora?: string | null; orden: number; activo?: boolean }[]): void {
    if (!Array.isArray(m)) throw err('Faltan los momentos de toma.', 'MOMENTOS_INVALIDOS');
    const activos = new Set<string>();
    for (const x of m) {
      if (!texto(x?.nombre)) throw err('Cada momento de toma necesita un nombre.', 'MOMENTOS_INVALIDOS');
      if (x.hora != null && x.hora !== '' && !RE_HORA.test(x.hora)) throw err(`La hora «${x.hora}» no es válida (usa HH:MM).`, 'MOMENTOS_INVALIDOS');
      if (!Number.isInteger(x.orden)) throw err('El orden de cada momento debe ser un número entero.', 'MOMENTOS_INVALIDOS');
      if (x.activo !== false) {
        const k = x.nombre.trim().toLowerCase();
        if (activos.has(k)) throw err(`El momento «${x.nombre.trim()}» está repetido.`, 'MOMENTOS_INVALIDOS');
        activos.add(k);
      }
    }
    if (activos.size === 0) throw err('Hace falta al menos un momento de toma activo.', 'MOMENTOS_INVALIDOS');
  }

  // ───────────────────────────── Auditoría ─────────────────────────────

  const corto = (v: unknown): string => {
    if (v === undefined) return '—';
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > 40 ? s.slice(0, 37) + '…' : s;
  };

  function resumir(f: Record<string, unknown>): string {
    const parse = (s: unknown) => { try { return s == null ? null : JSON.parse(String(s)); } catch { return null; } };
    const difs = diferencias(parse(f.antes), parse(f.despues), CAMPOS_OCULTOS);
    let r = `${f.accion} ${f.entidad}${f.entidad_id != null ? ` #${f.entidad_id}` : ''}`;
    if (difs.length) r += ': ' + difs.slice(0, 6).map(d => `${d.campo}: ${corto(d.antes)} → ${corto(d.despues)}`).join('; ') + (difs.length > 6 ? ` … (+${difs.length - 6})` : '');
    if (f.motivo) r += ` (motivo: ${f.motivo})`;
    return r;
  }

  // ───────────────────────────── Copias ─────────────────────────────

  const metaCopia = (origen: MetaCopia['origen'], motivo: string, esquema: number | null): MetaCopia => ({ origen, motivo, versionApp: version, esquema });

  /** Carpetas de copias propias: la de los ajustes y, si no hay, la del programa. */
  function carpetaDeCopias(): string | null {
    return (almacen.estaDesbloqueado() ? leerAjustes(almacen.db()).carpetaCopias : null) ?? opciones.carpetaCopiasPorDefecto ?? null;
  }
  const carpetasDeCopias = (): string[] => {
    const c = [almacen.estaDesbloqueado() ? leerAjustes(almacen.db()).carpetaCopias : null, opciones.carpetaCopiasPorDefecto ?? null].filter((x): x is string => !!x);
    return [...new Set(c)];
  };

  /** La carpeta SIEMPRE sale de los ajustes (nunca de lo que mande la interfaz). `seguridad`: puede usar la del programa. */
  async function hacerCopia(usuarioId: number | null, meta: Omit<MetaCopia, 'versionApp' | 'esquema'>, seguridad = false, protegerTambien: string[] = []): Promise<{ ruta: string }> {
    const base = db();
    const destino = seguridad ? carpetaDeCopias() : leerAjustes(base).carpetaCopias;
    if (!destino) throw err('No hay carpeta de copias configurada: elige una en Ajustes.', 'SIN_CARPETA_COPIAS');
    escribirAuditoria({ accion: 'exportar', entidad: 'copia', entidadId: null, motivo: meta.motivo }, usuarioId);
    await almacen.flush(true);
    const ruta = crearCopiaFichero(almacen.rutaFichero, destino, ahora(), metaCopia(meta.origen, meta.motivo, base.version()), protegerTambien);
    return { ruta };
  }

  function describirCopia(c: { nombre: string; fecha: Date; meta?: MetaCopia | null }, carpeta: string): CopiaDto {
    let tamano = 0;
    try { tamano = statSync(join(carpeta, c.nombre)).size; } catch { /* se verá como vacía */ }
    let aviso: string | null = null;
    if (tamano === 0) aviso = 'La copia está vacía: no se puede restaurar.';
    else if (c.meta?.esquema != null && c.meta.esquema > VERSION_ESQUEMA) aviso = `Es de una versión más nueva del programa (esquema ${c.meta.esquema}; este programa llega al ${VERSION_ESQUEMA}). Actualiza SPD para restaurarla.`;
    return {
      nombre: c.nombre, fecha: c.fecha.toISOString(), tamano, origen: c.meta?.origen ?? 'desconocido', motivo: c.meta?.motivo || null,
      versionApp: c.meta?.versionApp || null, esquema: c.meta?.esquema ?? null, restaurable: aviso === null, avisoRestauracion: aviso,
    };
  }

  /** Copia de seguridad obligatoria antes de cambiar cómo se abren los datos. Sin carpeta de copias no se cambia nada. */
  async function copiaPrevia(usuarioId: number, motivo: string): Promise<string> {
    try {
      const r = await hacerCopia(usuarioId, { origen: 'antes_cambio_acceso', motivo }, true);
      return r.ruta.split(/[\\/]/).pop()!;
    } catch (e) {
      if (e instanceof ErrorSpd && e.codigo === 'SIN_CARPETA_COPIAS') throw err('Antes de cambiar cómo se abren los datos se hace una copia de seguridad, y no hay carpeta de copias configurada. Elígela en Ajustes → Copias de seguridad.', 'SIN_CARPETA_COPIAS');
      throw e;
    }
  }

  async function restaurar(nombre: string, contrasena: string, contrasenaCopia: string | undefined): Promise<ResultadoRestauracion> {
    db();
    const quien = exigirSesion('titular');
    exigirSinEspera();
    // Con contraseña de arranque se confirma con ella; sin ella no hay contraseña que pedir (basta ser titular y escribir RESTAURAR en la interfaz).
    if (almacen.modoAcceso() !== 'sistema') {
      if (!almacen.verificarContrasena(String(contrasena ?? ''))) fallarContrasena();
      limContrasena.reiniciar();
    }
    // La copia sale de NUESTRAS carpetas por su nombre (patrón exacto): nunca una ruta recibida de la interfaz.
    let ruta: string | null = null, carpeta = '';
    for (const c of carpetasDeCopias()) { try { ruta = rutaDeCopia(c, nombre); carpeta = c; break; } catch { /* siguiente carpeta */ } }
    if (!ruta) throw err('Esa copia no existe en la carpeta de copias.', 'COPIA_NO_ENCONTRADA');
    const info = describirCopia({ nombre, fecha: new Date(0), meta: listarCopiasCarpeta(carpeta).find(x => x.nombre === nombre)?.meta }, carpeta);
    if (!info.restaurable) throw err(info.avisoRestauracion!, info.tamano === 0 ? 'COPIA_VACIA' : 'COPIA_MAS_NUEVA');
    const bytes = leerFicheroCopia(ruta);
    // Fase 1: descifrar, verificar y abrir (migrando si es anterior). Si algo falla, no se ha tocado nada.
    let r;
    try { r = await almacen.prepararRestauracion(bytes, String(contrasenaCopia ?? (almacen.modoAcceso() === 'sistema' ? '' : contrasena))); }
    catch (e) {
      if (e instanceof ErrorSpd && (e.codigo === 'CLAVE_SISTEMA_ILEGIBLE' || e.codigo === 'COPIA_SISTEMA_AJENA')) throw err('Esa copia se hizo sin contraseña de arranque y está ligada al usuario de Windows (y al equipo) que la creó: aquí no se puede abrir con el sistema. Escribe su clave de recuperación (la de entonces).', 'COPIA_SISTEMA_AJENA');
      if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) throw err(contrasenaCopia ? 'Ni la contraseña ni la clave de recuperación indicadas abren esa copia.' : 'La copia está protegida con otra contraseña (¿es de antes de cambiarla?). Indica la contraseña que tenía entonces (o su clave de recuperación).', 'CONTRASENA_COPIA');
      if (e instanceof ErrorSpd && e.codigo === 'VERSION_BASE') throw err(e.message, 'COPIA_MAS_NUEVA');
      throw e;
    }
    try {
      const actual = almacen.db().get<{ n: number; m: number | null }>('SELECT count(*) AS n, max(id) AS m FROM auditoria');
      const restaurada = r.db.get<{ n: number; m: number | null }>('SELECT count(*) AS n, max(id) AS m FROM auditoria');
      const perdidas = Math.max(0, Number(actual?.n ?? 0) - Number(restaurada?.n ?? 0));
      // Fase 2: copia de seguridad del estado actual (para poder deshacer) y sustitución.
      const previa = await hacerCopia(quien.id, { origen: 'antes_restaurar', motivo: `Antes de restaurar la copia ${nombre}` }, true, [nombre]);
      await r.aplicar();
      reiniciarSesion(); limPines.clear();
      auditarYGuardar({ accion: 'restaurar', entidad: 'copia', entidadId: null, motivo: `Restaurada la copia ${nombre}; estado anterior guardado en ${previa.ruta.split(/[\\/]/).pop()}; ${perdidas} entradas de auditoría posteriores a la copia quedan sólo en la copia previa${r.claveDistinta ? '; la copia tenía otra clave de datos (anterior a un cambio de contraseña) y se ha recifrado con la actual' : ''}` }, null);
      await almacen.flush(true);
      almacen.fijarEstado({ permitirRetroceso: true });   // restauración legítima: la auditoría vuelve atrás A PROPÓSITO y queda registrada
      return {
        copiaPrevia: previa.ruta.split(/[\\/]/).pop()!, entradasAuditoriaPerdidas: perdidas,
        aviso: `Copia restaurada. Se ha perdido lo hecho después de ella${perdidas ? ` (${perdidas} entradas de auditoría)` : ''}. Para deshacerlo, restaura «${previa.ruta.split(/[\\/]/).pop()}». Vuelve a iniciar sesión con tu PIN.`,
      };
    } finally { r.descartar(); }
  }

  // ───────────────────────────── Desbloqueo ─────────────────────────────

  function reiniciarSesion() { sesion = null; }

  function textoEspera(s: number) { return `Espera ${s} s antes de volver a probar.`; }

  function exigirSinEspera() {
    const e = limContrasena.espera();
    if (e > 0) throw err(`Demasiados intentos. ${textoEspera(e)}`, 'ESPERA_ACTIVA');
  }

  function fallarContrasena(): never {
    const s = limContrasena.registrarFallo();
    throw err(`Contraseña incorrecta. ${textoEspera(s)}`, COD_CONTRASENA);
  }

  /**
   * Al abrir: compara la auditoría con el fichero de estado. Si la base es MÁS ANTIGUA que la última vez que se abrió, puede
   * ser una copia vieja puesta en su sitio: se avisa, se audita (queda constancia) y el estado actual pasa a ser la referencia.
   * Va ANTES de escribir la entrada de «desbloquear» (que subiría el contador).
   */
  function comprobarMarchaAtras(): void {
    avisoSeguridad = null;
    let r;
    try { r = almacen.comprobarEstado(); } catch { return; }
    if (r.tipo === 'retroceso') {
      const g = r.guardado, a = r.actual;
      avisoSeguridad = a.contador < g.contador
        ? `Los datos son MÁS ANTIGUOS que la última vez que se abrió el programa (la auditoría llega a la entrada ${a.contador} y antes llegaba a la ${g.contador}). Puede que se haya puesto una copia antigua en su sitio. Si no la has restaurado tú desde Ajustes, avisa al titular y revisa la auditoría.`
        : `La historia de la auditoría no coincide con la de la última vez que se abrió el programa (entrada ${a.contador}). Puede que se haya puesto una copia antigua en su sitio. Si no la has restaurado tú desde Ajustes, avisa al titular.`;
    } else if (r.tipo === 'manipulado') {
      avisoSeguridad = `El fichero de estado que acompaña a los datos no es válido (${r.motivo}). Alguien lo ha modificado o los datos no son los de siempre. Revisa la auditoría.`;
    }
    if (avisoSeguridad) {
      try { escribirAuditoria({ accion: 'alerta_seguridad', entidad: 'sistema', motivo: avisoSeguridad }, null); almacen.persistir(); } catch { /* el aviso se enseña igual */ }
      almacen.fijarEstado({ permitirRetroceso: true });   // se avisa una vez; queda en la auditoría
    } else almacen.fijarEstado();
  }

  /**
   * Si el titular ha desactivado «pedir elegir usuario al arrancar», entra el usuario predeterminado (sin PIN: los ajustes lo
   * obligan). Sólo al ABRIR los datos; después de bloquear o por inactividad se vuelve a elegir usuario.
   */
  function inicioAutomatico(): void {
    const a = leerAjustes(almacen.db());
    if (a.pedirUsuarioAlArrancar || a.pedirPin || a.usuarioPredeterminadoId === null) return;
    const f = almacen.db().get<Record<string, unknown>>('SELECT id, nombre, iniciales, rol FROM usuario WHERE id = ? AND activo = 1', [a.usuarioPredeterminadoId]);
    if (!f) return;   // el usuario ya no está: se pide elegir
    sesion = aPublico(f);
    auditarYGuardar({ accion: 'login', entidad: 'usuario', entidadId: sesion.id, motivo: 'Inicio automático: el titular ha desactivado pedir usuario al arrancar' }, sesion.id);
  }

  /** Abre unos datos «sin contraseña de arranque» con el almacén de claves de Windows. No cuenta intentos: no hay contraseña que adivinar. */
  async function desbloqueoSistema(usarCopia: boolean): Promise<{ estado: EstadoSistema; aviso?: string }> {
    if (almacen.estaDesbloqueado()) return { estado: estadoSync() };
    if (!almacen.existe()) throw err('Todavía no hay datos: haz el primer uso.', 'NO_INICIALIZADO');
    if (almacen.modoAcceso() !== 'sistema') throw err('Estos datos tienen contraseña de arranque: escríbela para abrirlos.', 'CON_CONTRASENA');
    const r = await almacen.desbloquearConSistema({ usarCopia });
    reiniciarSesion();
    comprobarMarchaAtras();
    auditarYGuardar({ accion: 'desbloquear', entidad: 'sistema', motivo: r.aviso ? 'Se restauró la copia anterior del fichero' : 'Apertura sin contraseña de arranque (usuario de Windows)' }, null);
    inicioAutomatico();
    return { estado: estadoSync(), ...(r.aviso ? { aviso: r.aviso } : {}) };
  }

  async function desbloqueo(contrasena: string, usarCopia: boolean): Promise<{ estado: EstadoSistema; aviso?: string }> {
    if (almacen.estaDesbloqueado()) return { estado: estadoSync() };
    if (!almacen.existe()) throw err('Todavía no hay datos: haz el primer uso.', 'NO_INICIALIZADO');
    if (almacen.modoAcceso() === 'sistema') return desbloqueoSistema(usarCopia);
    exigirSinEspera();
    let r: { aviso?: string };
    try { r = await almacen.desbloquear(String(contrasena ?? ''), { usarCopia }); }
    catch (e) { if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) fallarContrasena(); throw e; }
    limContrasena.reiniciar();
    reiniciarSesion();
    comprobarMarchaAtras();
    auditarYGuardar({ accion: 'desbloquear', entidad: 'sistema', motivo: r.aviso ? 'Se restauró la copia anterior del fichero' : null }, null);
    inicioAutomatico();
    return { estado: estadoSync(), ...(r.aviso ? { aviso: r.aviso } : {}) };
  }

  async function recuperacion(clave: string, nueva: string | undefined, usarCopia: boolean): Promise<{ estado: EstadoSistema; aviso?: string }> {
    if (almacen.estaDesbloqueado()) throw err('El programa ya está desbloqueado: usa «cambiar contraseña».', 'YA_DESBLOQUEADO');
    if (!almacen.existe()) throw err('Todavía no hay datos: haz el primer uso.', 'NO_INICIALIZADO');
    // Con contraseña de arranque hace falta una nueva; sin ella es opcional (si no se da, los datos se ligan al usuario de Windows de ahora).
    const modo = almacen.modoAcceso();
    const conNueva = typeof nueva === 'string' && nueva !== '';
    if (modo !== 'sistema' || conNueva) validarContrasenaNueva(nueva);
    exigirSinEspera();
    let bytes: Uint8Array;
    try { bytes = claveDesdeTexto(String(clave ?? '')); }
    catch (e) { throw err(e instanceof Error ? e.message : 'La clave de recuperación no es válida.', 'CLAVE_RECUPERACION_INVALIDA'); }
    let r: { aviso?: string };
    try { r = await almacen.recuperar(bytes, conNueva ? nueva! : null, { usarCopia }); }
    catch (e) {
      // Con la clave de datos no hay «contraseña incorrecta»: si no abre, la clave no es la de esta base.
      if (e instanceof ErrorSpd && e.codigo === 'FICHERO_CORRUPTO') {
        limContrasena.registrarFallo();
        throw err('La clave de recuperación no corresponde a estos datos (o el fichero está dañado).', 'CLAVE_RECUPERACION_INCORRECTA');
      }
      throw e;
    }
    bytes.fill(0);
    limContrasena.reiniciar();
    reiniciarSesion();
    comprobarMarchaAtras();
    auditarYGuardar({ accion: 'recuperar', entidad: 'sistema', motivo: conNueva ? 'Contraseña restablecida con la clave de recuperación' : 'Acceso restablecido con la clave de recuperación: datos ligados de nuevo al usuario de Windows actual (sin contraseña de arranque)' }, null);
    inicioAutomatico();
    return { estado: estadoSync(), ...(r.aviso ? { aviso: r.aviso } : {}) };
  }

  /**
   * Bloquear. Con contraseña de arranque cierra los datos (hay que volver a escribirla). SIN ella no hay nada que volver a pedir
   * (Windows reabriría los datos al instante), así que bloquear = cerrar la sesión del usuario y volver a «¿Quién eres?»; los
   * datos quedan abiertos en la memoria del programa. `total` (cierre del programa) lo cierra todo siempre.
   */
  async function bloqueo(motivo: string | null, total = false): Promise<EstadoSistema> {
    if (!almacen.estaDesbloqueado()) { reiniciarSesion(); return estadoSync(); }
    if (!total && almacen.modoAcceso() === 'sistema') {
      try { escribirAuditoria({ accion: 'bloquear', entidad: 'sistema', motivo: `${motivo ?? 'manual'} (sin contraseña de arranque: se cierra la sesión del usuario)` }, sesion?.id ?? null); almacen.persistir(); } catch { /* se cierra la sesión igual */ }
      reiniciarSesion();
      try { await almacen.flush(); } catch (e) { throw err(`Se ha cerrado la sesión, pero no se pudieron guardar los últimos cambios: ${e instanceof Error ? e.message : String(e)}`, 'ERROR_GUARDADO'); }
      return estadoSync();
    }
    try { escribirAuditoria({ accion: 'bloquear', entidad: 'sistema', motivo }, sesion?.id ?? null); almacen.persistir(); } catch { /* si no se puede auditar, se bloquea igual */ }
    reiniciarSesion(); avisoSeguridad = null;
    const r = await almacen.bloquear();
    if (r.errorGuardado) throw err(`El programa se ha bloqueado, pero no se pudieron guardar los últimos cambios: ${r.errorGuardado}`, 'ERROR_GUARDADO');
    return estadoSync();
  }

  // ───────────────────────────── La API ─────────────────────────────

  const api: ApiSistema = {
    estado: () => proteger(() => estadoSync()),

    primerUso: (datos: PrimerUso) => proteger<ResultadoPrimerUso>(async () => {
      if (almacen.existe()) throw err('Ya hay datos creados en esta carpeta.', 'YA_INICIALIZADO');
      const farmacia = normalizarFarmacia(datos?.farmacia);
      const nombreTitular = texto(datos?.titular?.nombre), iniciales = texto(datos?.titular?.iniciales)?.toUpperCase();
      if (!nombreTitular || !iniciales) throw err('Faltan el nombre y las iniciales del titular.', 'TITULAR_INVALIDO');
      if (iniciales.length > 4) throw err('Las iniciales pueden tener como máximo 4 letras.', 'TITULAR_INVALIDO');
      const pin = validarPin(datos.titular.pin);
      const sinContrasena = datos?.sinContrasena === true;
      if (sinContrasena) {
        if (datos.contrasena) throw err('Has indicado una contraseña y también empezar sin contraseña: elige una de las dos.', 'PRIMER_USO_INVALIDO');
        if (datos.reconoceRiesgoSinContrasena !== true) throw err('Para empezar sin contraseña de arranque tienes que confirmar que has leído el aviso.', 'RIESGO_NO_RECONOCIDO');
        if (!almacen.accesoSistemaDisponible()) throw err(`No se puede empezar sin contraseña en este equipo: ${almacen.motivoSistemaNoDisponible()}. Usa una contraseña.`, COD_PROTECTOR);
      }
      const contrasena = sinContrasena ? null : validarContrasenaNueva(datos.contrasena);
      validarMomentos((datos.momentos ?? []).map((m, i) => ({ nombre: m?.nombre, hora: m?.hora, orden: i + 1 })));
      const hash = hashPin(pin);
      let usuarioId = 0;

      const { claveDatos } = await almacen.crear(contrasena, (base) => {
        base.transaccion(() => {
          escribirFarmacia(base, farmacia);
          usuarioId = base.run('INSERT INTO usuario(nombre,iniciales,rol,hash_clave) VALUES (?,?,?,?)', [nombreTitular, iniciales, 'titular', hash]).ultimoId;
          datos.momentos.forEach((m, i) => base.run('INSERT INTO momento_toma(nombre,hora,orden) VALUES (?,?,?)', [m.nombre.trim(), m.hora || null, i + 1]));
        });
      });
      sesion = { id: usuarioId, nombre: nombreTitular, iniciales, rol: 'titular' };
      limContrasena.reiniciar();
      const base = almacen.db();
      base.transaccion(() => {
        escribirAuditoria({ accion: 'crear', entidad: 'farmacia', entidadId: 1, despues: farmacia }, usuarioId);
        escribirAuditoria({ accion: 'crear', entidad: 'usuario', entidadId: usuarioId, despues: { nombre: nombreTitular, iniciales, rol: 'titular' } }, usuarioId);
        escribirAuditoria({ accion: 'crear', entidad: 'momentos_toma', despues: datos.momentos.map(m => m.nombre.trim()) }, usuarioId);
        if (sinContrasena) escribirAuditoria({ accion: 'crear', entidad: 'acceso', despues: { modo: 'sistema' }, motivo: 'Primer uso SIN contraseña de arranque: clave de datos ligada al usuario de Windows; riesgo reconocido por el titular' }, usuarioId);
        escribirAuditoria({ accion: 'login', entidad: 'usuario', entidadId: usuarioId }, usuarioId);
      });
      await almacen.flush(true);
      const r = { claveRecuperacion: textoRecuperacion(claveDatos), uriAutenticador: uriAutenticador(claveDatos, farmacia.nombre) };
      claveDatos.fill(0);
      return r;
    }),

    desbloquear: (contrasena) => proteger(async () => (await desbloqueo(contrasena, false)).estado),

    desbloquearConCopia: (contrasena) => proteger(async () => {
      const r = await desbloqueo(contrasena, true);
      return { ...r.estado, aviso: r.aviso ?? '' };
    }),

    desbloquearConSistema: () => proteger(async () => (await desbloqueoSistema(false)).estado),

    recuperar: (clave, nueva) => proteger(async () => (await recuperacion(clave, nueva, false)).estado),

    bloquear: () => proteger(() => bloqueo(null)),

    cambiarContrasena: (actual, nueva) => proteger<ResultadoPrimerUso>(async () => {
      db();
      exigirSesion('titular');
      if (almacen.modoAcceso() === 'sistema') throw err('No hay contraseña de arranque que cambiar. Puedes ponerla en Ajustes → Seguridad.', 'SIN_CONTRASENA');
      validarContrasenaNueva(nueva);
      exigirSinEspera();
      let claveDatos: Uint8Array;
      try { ({ claveDatos } = await almacen.cambiarContrasena(String(actual ?? ''), nueva)); }
      catch (e) { if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) fallarContrasena(); throw e; }
      limContrasena.reiniciar();
      try {
        // La clave de datos ha ROTADO: la clave de recuperación de antes ya no abre el fichero. Se devuelve la nueva (hay que guardarla).
        auditarYGuardar({ accion: 'cambiar_contrasena', entidad: 'sistema', motivo: 'Contraseña cambiada y clave de datos rotada (clave de recuperación nueva). Las copias anteriores siguen abriéndose con la contraseña de entonces.' });
        await almacen.flush();
        return { claveRecuperacion: textoRecuperacion(claveDatos), uriAutenticador: uriAutenticador(claveDatos, leerFarmacia(db())?.nombre || 'SPD') };
      } finally { claveDatos.fill(0); }
    }),

    quitarContrasenaArranque: (actual, motivoTxt, confirmo) => proteger(async () => {
      db();
      const quien = exigirSesion('titular');
      if (almacen.modoAcceso() === 'sistema') throw err('Los datos ya se abren sin contraseña de arranque.', 'YA_SIN_CONTRASENA');
      if (confirmo !== true) throw err('Marca la casilla para confirmar que has leído el aviso.', 'RIESGO_NO_RECONOCIDO');
      const m = texto(motivoTxt);
      if (!m || m.length < 5) throw err('Quitar la contraseña de arranque exige un motivo escrito (mín. 5 letras): queda en el historial.', 'MOTIVO_OBLIGATORIO');
      if (!almacen.accesoSistemaDisponible()) throw err(`No se puede quitar la contraseña en este equipo: ${almacen.motivoSistemaNoDisponible()}.`, COD_PROTECTOR);
      exigirSinEspera();
      if (!almacen.verificarContrasena(String(actual ?? ''))) fallarContrasena();
      limContrasena.reiniciar();
      const copia = await copiaPrevia(quien.id, 'Antes de quitar la contraseña de arranque');
      try { await almacen.quitarContrasena(String(actual ?? '')); }
      catch (e) { if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) fallarContrasena(); throw e; }
      limPines.clear();
      auditarYGuardar({ accion: 'modificar', entidad: 'acceso', antes: { modo: 'contrasena' }, despues: { modo: 'sistema' },
        motivo: `${m}. Ahora los datos se abren con el usuario de Windows, sin contraseña (la clave de recuperación sigue valiendo). Copia previa: ${copia}` });
      await almacen.flush();
      return estadoSync();
    }),

    ponerContrasenaArranque: (nueva, motivoTxt) => proteger<ResultadoPrimerUso>(async () => {
      db();
      const quien = exigirSesion('titular');
      if (almacen.modoAcceso() !== 'sistema') throw err('Los datos ya tienen contraseña de arranque. Para cambiarla usa «Cambiar contraseña».', 'YA_CON_CONTRASENA');
      const m = texto(motivoTxt);
      if (!m || m.length < 5) throw err('Poner la contraseña de arranque exige un motivo escrito (mín. 5 letras): queda en el historial.', 'MOTIVO_OBLIGATORIO');
      validarContrasenaNueva(nueva);
      const copia = await copiaPrevia(quien.id, 'Antes de poner contraseña de arranque');
      const { claveDatos } = await almacen.ponerContrasena(nueva);
      limContrasena.reiniciar();
      try {
        auditarYGuardar({ accion: 'modificar', entidad: 'acceso', antes: { modo: 'sistema' }, despues: { modo: 'contrasena' },
          motivo: `${m}. Clave de datos rotada (clave de recuperación nueva: la anterior ya no abre el fichero actual). Copia previa: ${copia}` });
        await almacen.flush();
        return { claveRecuperacion: textoRecuperacion(claveDatos), uriAutenticador: uriAutenticador(claveDatos, leerFarmacia(db())?.nombre || 'SPD') };
      } finally { claveDatos.fill(0); }
    }),

    listarUsuarios: () => proteger(() => db().all('SELECT id, nombre, iniciales, rol FROM usuario WHERE activo = 1 ORDER BY id').map(aPublico)),

    iniciarSesion: (usuarioId, pin) => proteger(async () => {
      const base = db();
      const u = base.get<Record<string, string | number>>('SELECT id, nombre, iniciales, rol, hash_clave FROM usuario WHERE id = ? AND activo = 1', [Number(usuarioId)]);
      if (!u) throw err('Usuario no encontrado.', 'USUARIO_NO_ENCONTRADO');
      if (!leerAjustes(base).pedirPin) {
        // El titular ha desactivado el PIN: basta elegir usuario. Queda constancia en la auditoría de que entró sin PIN.
        sesion = aPublico(u);
        auditarYGuardar({ accion: 'login', entidad: 'usuario', entidadId: sesion.id, motivo: 'Entrada sin PIN (desactivado por el titular)' }, sesion.id);
        return sesion;
      }
      const lim = limPin(u.id as number);
      const e = lim.espera();
      if (e > 0) throw err(`Demasiados intentos con este usuario. Espera ${e} s.`, 'USUARIO_BLOQUEADO');
      if (!verificarPin(String(pin ?? ''), String(u.hash_clave))) {
        const s = lim.registrarFallo();
        auditarYGuardar({ accion: 'login_fallido', entidad: 'usuario', entidadId: u.id as number }, u.id as number);
        throw s > 0
          ? err(`PIN incorrecto. Usuario bloqueado ${s} s por demasiados intentos.`, 'USUARIO_BLOQUEADO')
          : err('PIN incorrecto.', 'PIN_INCORRECTO');
      }
      lim.reiniciar();
      sesion = aPublico(u);
      auditarYGuardar({ accion: 'login', entidad: 'usuario', entidadId: sesion.id }, sesion.id);
      return sesion;
    }),

    cerrarSesion: () => proteger<null>(() => {
      if (sesion && almacen.estaDesbloqueado()) auditarYGuardar({ accion: 'logout', entidad: 'usuario', entidadId: sesion.id });
      sesion = null;
      return null;
    }),

    crearUsuario: (u) => proteger(() => {
      const base = db();
      exigirSesion('titular');
      const nombre = texto(u?.nombre), iniciales = texto(u?.iniciales)?.toUpperCase();
      if (!nombre || !iniciales) throw err('Faltan el nombre y las iniciales.', 'USUARIO_INVALIDO');
      if (iniciales.length > 4) throw err('Las iniciales pueden tener como máximo 4 letras.', 'USUARIO_INVALIDO');
      if (!ROLES.includes(u.rol)) throw err('Rol no válido.', 'USUARIO_INVALIDO');
      const numColegiado = texto(u.numColegiado);
      const hash = hashPin(validarPin(u.pin));
      return base.transaccion(() => {
        // Iniciales repetidas: no bloquea, pero en los registros impresos no se sabría quién es quién.
        const iguales = base.all<{ nombre: string }>('SELECT nombre FROM usuario WHERE activo = 1 AND upper(iniciales) = ? ORDER BY id', [iniciales]).map((x) => x.nombre);
        const avisos = iguales.length > 0 ? [`Las iniciales «${iniciales}» ya las usa ${iguales.join(', ')}: en las etiquetas y registros impresos no se distinguirá quién hizo cada cosa. Valora usar otras.`] : [];
        const id = base.run('INSERT INTO usuario(nombre,iniciales,rol,num_colegiado,hash_clave) VALUES (?,?,?,?,?)', [nombre, iniciales, u.rol, numColegiado, hash]).ultimoId;
        ctx.auditar({ accion: 'crear', entidad: 'usuario', entidadId: id, despues: { nombre, iniciales, rol: u.rol, numColegiado }, motivo: avisos.length > 0 ? 'Iniciales repetidas con otro usuario' : null });
        almacen.persistir();
        return { id, nombre, iniciales, rol: u.rol, ...(avisos.length > 0 ? { avisos } : {}) };
      });
    }),

    obtenerFarmacia: () => proteger(() => {
      const f = leerFarmacia(db());
      if (!f) throw err('Todavía no se han guardado los datos de la farmacia.', 'SIN_FARMACIA');
      return f;
    }),

    guardarFarmacia: (d) => proteger(() => {
      const base = db();
      exigirSesion('titular');
      const nueva = normalizarFarmacia(d);
      return base.transaccion(() => {
        const antes = leerFarmacia(base);
        escribirFarmacia(base, nueva);
        ctx.auditar({ accion: antes ? 'modificar' : 'crear', entidad: 'farmacia', entidadId: 1, antes, despues: nueva });
        almacen.persistir();
        return leerFarmacia(base)!;
      });
    }),

    obtenerAjustes: () => proteger(() => leerAjustes(db())),

    guardarAjustes: (a) => proteger(() => {
      const base = db();
      const quien = exigirSesion('titular', 'farmaceutico');
      if (!a || typeof a !== 'object') throw err('Ajustes no válidos.', 'AJUSTE_INVALIDO');
      validarAjustes(a);
      const motivo = texto(a.motivo);
      const antes = leerAjustes(base);
      const despues: Ajustes = { ...antes };
      for (const k of Object.keys(CLAVES_AJUSTE) as (keyof Ajustes)[]) if (k in a && a[k] !== undefined) (despues as unknown as Record<string, unknown>)[k] = a[k];
      for (const k of ['impresoraEtiquetas', 'impresoraDocumentos', 'carpetaCopias'] as const) if (despues[k] === '') despues[k] = null;
      if (despues.validezExtendidaPermitida !== antes.validezExtendidaPermitida) {
        if (quien.rol !== 'titular') throw err('Sólo el titular puede cambiar la validez extendida del SPD.', 'SIN_PERMISO');
        if (despues.validezExtendidaPermitida && (!motivo || motivo.length < 5)) throw err('Activar la validez extendida (hasta 30 días) exige un motivo escrito.', 'MOTIVO_OBLIGATORIO');
      }
      if (despues.exigirConsentimientos !== antes.exigirConsentimientos) {
        if (quien.rol !== 'titular') throw err('Sólo el titular puede cambiar si se exigen los consentimientos para validar.', 'SIN_PERMISO');
        if (!motivo || motivo.length < 5) throw err('Cambiar si se exigen los consentimientos exige un motivo escrito: queda en el historial.', 'MOTIVO_OBLIGATORIO');
      }
      if (despues.pedirPin !== antes.pedirPin || despues.pedirUsuarioAlArrancar !== antes.pedirUsuarioAlArrancar || despues.usuarioPredeterminadoId !== antes.usuarioPredeterminadoId) {
        if (quien.rol !== 'titular') throw err('Sólo el titular puede cambiar si se pide el PIN o elegir usuario al arrancar.', 'SIN_PERMISO');
        if (!motivo || motivo.length < 5) throw err('Cambiar cómo se identifica quien trabaja exige un motivo escrito: queda en el historial.', 'MOTIVO_OBLIGATORIO');
      }
      if (despues.pedirPin && !despues.pedirUsuarioAlArrancar) throw err('Con PIN activado hay que elegir usuario al arrancar: si no, el usuario predeterminado entraría sin PIN.', 'AJUSTE_INCOHERENTE');
      if (!despues.pedirUsuarioAlArrancar) {
        const pred = despues.usuarioPredeterminadoId;
        if (pred === null || !base.get('SELECT id FROM usuario WHERE id = ? AND activo = 1', [pred])) throw err('Para no pedir usuario al arrancar elige el usuario con el que se abre el programa (activo).', 'AJUSTE_INVALIDO');
      }
      if (despues.carpetaCopias && despues.carpetaCopias !== antes.carpetaCopias) exigirCarpetaCopiasUtil(despues.carpetaCopias);
      if (despues.diasValidezSpd > 14 && !despues.validezExtendidaPermitida) throw err('Una validez de más de 14 días exige activar antes la validez extendida (lo hace el titular, con motivo).', 'VALIDEZ_NO_PERMITIDA');
      return base.transaccion(() => {
        const cambios: Record<string, [unknown, unknown]> = {};
        for (const k of Object.keys(CLAVES_AJUSTE) as (keyof Ajustes)[]) {
          if (JSON.stringify(antes[k]) === JSON.stringify(despues[k])) continue;
          cambios[k] = [antes[k], despues[k]];
          guardarClave(base, CLAVES_AJUSTE[k], despues[k]);
        }
        if (Object.keys(cambios).length) {
          base.run('UPDATE farmacia SET dias_validez_spd = ?, validez_extendida_permitida = ? WHERE id = 1', [despues.diasValidezSpd, despues.validezExtendidaPermitida ? 1 : 0]);
          ctx.auditar({
            accion: 'modificar', entidad: 'ajustes',
            antes: Object.fromEntries(Object.entries(cambios).map(([k, v]) => [k, v[0] ?? null])),
            despues: Object.fromEntries(Object.entries(cambios).map(([k, v]) => [k, v[1] ?? null])),
            motivo,
          });
          almacen.persistir();
        }
        return leerAjustes(base);
      });
    }),

    listarMomentos: () => proteger(() => leerMomentos(db())),

    guardarMomentos: (m) => proteger(() => {
      const base = db();
      exigirSesion('titular', 'farmaceutico');
      validarMomentos(m);
      return base.transaccion(() => {
        const antes = leerMomentos(base);
        const conocidos = new Set(antes.map(x => x.id));
        const enLista = new Set<number>();
        for (const x of m) {
          const hora = x.hora ? x.hora : null, nombre = x.nombre.trim(), activo = x.activo === false ? 0 : 1;
          if (x.id !== undefined && x.id !== null) {
            if (!conocidos.has(x.id)) throw err(`El momento ${x.id} no existe.`, 'MOMENTOS_INVALIDOS');
            enLista.add(x.id);
            base.run('UPDATE momento_toma SET nombre = ?, hora = ?, orden = ?, activo = ? WHERE id = ?', [nombre, hora, x.orden, activo, x.id]);
          } else {
            base.run('INSERT INTO momento_toma(nombre,hora,orden,activo) VALUES (?,?,?,?)', [nombre, hora, x.orden, activo]);
          }
        }
        for (const viejo of antes) {
          if (enLista.has(viejo.id)) continue;
          // Si alguna pauta o preparación lo usa, la clave foránea impide borrarlo: entonces se desactiva.
          try { base.transaccion(() => base.run('DELETE FROM momento_toma WHERE id = ?', [viejo.id])); }
          catch { base.run('UPDATE momento_toma SET activo = 0 WHERE id = ?', [viejo.id]); }
        }
        const despues = leerMomentos(base);
        if (!despues.some(x => x.activo)) throw err('Hace falta al menos un momento de toma activo.', 'MOMENTOS_INVALIDOS');
        ctx.auditar({ accion: 'modificar', entidad: 'momentos_toma', antes, despues });
        almacen.persistir();
        return despues;
      });
    }),

    listarAuditoria: (filtro) => proteger<EntradaAuditoriaDto[]>(() => {
      const base = db();
      exigirSesion('titular', 'farmaceutico');
      const cond: string[] = [], params: (string | number)[] = [];
      if (filtro?.entidad) { cond.push('a.entidad = ?'); params.push(filtro.entidad); }
      if (filtro?.entidadId) { cond.push('a.entidad_id = ?'); params.push(String(filtro.entidadId)); }
      const limite = Math.min(Math.max(Math.trunc(Number(filtro?.limite ?? 200)) || 200, 1), 1000);
      const filas = base.all<Record<string, unknown>>(
        `SELECT a.*, u.nombre AS usuario_nombre FROM auditoria a LEFT JOIN usuario u ON u.id = a.usuario_id
         ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${limite}`, params);
      return filas.map(f => ({
        id: Number(f.id), momento: String(f.momento), usuario: (f.usuario_nombre as string | null) ?? null, accion: String(f.accion),
        entidad: String(f.entidad), entidadId: (f.entidad_id as string | null) ?? null, motivo: (f.motivo as string | null) ?? null, resumen: resumir(f),
      }));
    }),

    verificarAuditoria: () => proteger(() => {
      const base = db();
      exigirSesion('titular', 'farmaceutico');
      const filas = base.all<Record<string, unknown>>('SELECT * FROM auditoria ORDER BY id');
      const parse = (s: unknown) => (s == null ? null : JSON.parse(String(s)));
      let entradas: EntradaAuditoria[];
      try {
        entradas = filas.map(f => ({
          momento: String(f.momento), usuarioId: f.usuario_id == null ? null : Number(f.usuario_id), accion: String(f.accion), entidad: String(f.entidad),
          entidadId: f.entidad_id == null ? null : String(f.entidad_id), antes: parse(f.antes), despues: parse(f.despues),
          motivo: f.motivo == null ? null : String(f.motivo), hashPrevio: String(f.hash_previo), hash: String(f.hash),
        }));
      } catch { return { ok: false, entradas: filas.length, primerError: 'Una entrada tiene contenido ilegible.' }; }
      const r = verificarCadena(entradas);
      if (!r.ok) {
        const e = r.primerError!;
        return { ok: false, entradas: entradas.length, primerError: `Entrada nº ${e.indice + 1} (id ${filas[e.indice]?.id}): ${e.motivo}.` };
      }
      const guardado = base.get<{ valor: string }>('SELECT valor FROM ajuste WHERE clave = ?', [ULTIMO_HASH])?.valor;
      const ultimo = entradas.length ? entradas[entradas.length - 1].hash : null;
      if (ultimo === null && guardado) return { ok: false, entradas: 0, primerError: 'La auditoría está vacía pero consta que tuvo entradas: se han borrado.' };
      if (ultimo !== null && !guardado) return { ok: false, entradas: entradas.length, primerError: 'Falta el sello del último registro de auditoría.' };
      if (ultimo !== null && guardado !== ultimo) return { ok: false, entradas: entradas.length, primerError: 'La última entrada de la auditoría no coincide con el sello guardado: se han borrado entradas finales.' };
      return { ok: true, entradas: entradas.length };
    }),

    estadoCopias: () => proteger<EstadoCopias>(() => estadoDeCopias(leerAjustes(db()).carpetaCopias ?? null, ahora())),

    listarCopias: () => proteger<CopiaDto[]>(() => {
      db();
      exigirSesion('titular', 'farmaceutico');
      const todas: CopiaDto[] = [];
      for (const c of carpetasDeCopias()) for (const x of listarCopiasCarpeta(c, ahora())) todas.push(describirCopia(x, c));
      return todas.sort((a, b) => b.fecha.localeCompare(a.fecha));
    }),

    restaurarCopia: (nombre, contrasena, contrasenaCopia) => proteger(() => restaurar(nombre, contrasena, contrasenaCopia)),

    crearCopia: (carpeta) => proteger(async () => {
      db();
      const quien = exigirSesion('titular', 'farmaceutico');
      void carpeta;   // la carpeta sale SOLO de los ajustes
      return hacerCopia(quien.id, { origen: 'manual', motivo: 'Copia de seguridad manual' });
    }),
  };

  return {
    api, ctx,
    estaDesbloqueado: () => almacen.estaDesbloqueado(),
    async cerrar() {
      try { await bloqueo('cierre del programa', true); } catch { /* ya está bloqueado; el error de guardado lo vio quien llamó antes */ }
    },
    bloquearPorInactividad: () => proteger(() => bloqueo('inactividad')),
    recuperarConCopia: (clave, nueva) => proteger(async () => {
      const r = await recuperacion(clave, nueva, true);
      return { estado: r.estado, aviso: r.aviso ?? '' };
    }),
    crearCopiaAutomatica: () => proteger(async () => hacerCopia(null, { origen: 'automatica', motivo: 'Copia automática diaria' })),
    crearCopiaPreActualizacion: (v) => proteger(async () => {
      const ver = String(v ?? '');
      if (!/^\d+\.\d+\.\d+[0-9A-Za-z.-]*$/.test(ver)) throw err('Versión no válida.', 'VERSION_INVALIDA');
      const motivo = `Antes de actualizar a v${ver}`;
      if (!almacen.existe()) return { ruta: null };
      if (almacen.estaDesbloqueado()) return hacerCopia(sesion?.id ?? null, { origen: 'antes_actualizar', motivo }, true);
      const destino = opciones.carpetaCopiasPorDefecto;
      if (!destino) throw err('No hay carpeta donde guardar la copia previa.', 'SIN_CARPETA_COPIAS');
      return { ruta: crearCopiaFichero(almacen.rutaFichero, destino, ahora(), metaCopia('antes_actualizar', motivo, null)) };
    }),
    async guardarAhora() { await almacen.flush(); },
  };
}

export { COD_COPIA_DISPONIBLE };
