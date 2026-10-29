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
  Ajustes, ApiSistema, DatosFarmacia, EntradaAuditoriaDto, EstadoCopias, EstadoSistema, MomentoTomaDto, PrimerUso,
  Resultado, ResultadoPrimerUso, RolUsuario, UsuarioPublico,
} from './api.ts';
import { crearAlmacen, COD_COPIA_DISPONIBLE } from './almacen.ts';
import type { Temporizador } from './almacen.ts';
import { ErrorSpd, proteger } from './contexto.ts';
import type { Contexto, DatosAuditoria } from './contexto.ts';
import type { Db } from './db.ts';
import { crearCopiaFichero, estadoDeCopias } from './copias.ts';
import { COD_CONTRASENA, hashPin, limitadorContrasena, limitadorPin, verificarPin } from './seguridad.ts';
import type { LimitadorFallos } from './seguridad.ts';
import { claveDesdeTexto, textoRecuperacion, uriAutenticador } from '../dominio/clave-recuperacion.ts';
import { crearEntrada, diferencias, HASH_GENESIS, verificarCadena } from '../dominio/auditoria.ts';
import type { EntradaAuditoria } from '../dominio/auditoria.ts';

export interface OpcionesSistema {
  rutaDatos: string;
  wasmPath?: string;
  ahora?: () => Date;
  version?: string;
  /** Pruebas: espera del guardado diferido y temporizador inyectable. */
  debounceMs?: number;
  temporizador?: Temporizador;
  alError?: (e: Error) => void;
  /** Sólo pruebas: scrypt más barato. */
  kdf?: { n: number; r: number; p: number };
}

export interface Sistema {
  api: ApiSistema;
  ctx: Contexto;
  cerrar(): Promise<void>;
  /** Equivale a `api.bloquear()`; lo llama el proceso principal tras la inactividad. */
  bloquearPorInactividad(): Promise<Resultado<EstadoSistema>>;
  /** Tras `FICHERO_DANADO_COPIA_DISPONIBLE`: abre la copia anterior (el usuario ya ha aceptado perder los últimos cambios). */
  recuperarConCopia(claveRecuperacion: string, nuevaContrasena: string): Promise<Resultado<{ estado: EstadoSistema; aviso: string }>>;
  /** Copia diaria automática: no pide sesión (sólo copia el fichero cifrado). */
  crearCopiaAutomatica(): Promise<Resultado<{ ruta: string }>>;
  /** Vacía lo pendiente a disco (para pruebas y para el cierre). */
  guardarAhora(): Promise<void>;
}

const ROLES: RolUsuario[] = ['titular', 'farmaceutico', 'tecnico', 'administrativo'];
const CAMPOS_OCULTOS = ['hash_clave', 'pin', 'contrasena', 'nuevaContrasena', 'claveRecuperacion', 'clave'];
const RE_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const CONTRASENA_MIN = 8;
const ULTIMO_HASH = 'auditoria_ultimo_hash';

const AJUSTES_POR_DEFECTO: Ajustes = {
  diasValidezSpd: 14, validezExtendidaPermitida: false, conservacionAniosTrasBaja: 2, bloqueoMinutos: 5,
  inicioDia: 'convencional', rotar180: false, sentidoTomas: 'izquierda_derecha', posicionInicial: 'izquierda',
  lector: { modo: 'teclado', separadorGs: '' }, impresoraEtiquetas: null, impresoraDocumentos: null, carpetaCopias: null,
};

const err = (m: string, c: string) => new ErrorSpd(m, c);
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function validarContrasenaNueva(c: unknown): string {
  if (typeof c !== 'string' || c.length < CONTRASENA_MIN) throw err(`La contraseña debe tener al menos ${CONTRASENA_MIN} caracteres.`, 'CONTRASENA_DEBIL');
  return c;
}
function validarPin(p: unknown): string {
  if (typeof p !== 'string' || !/^\d{4,8}$/.test(p)) throw err('El PIN debe tener entre 4 y 8 cifras.', 'PIN_INVALIDO');
  return p;
}

export function crearSistema(opciones: OpcionesSistema): Sistema {
  const ahora = opciones.ahora ?? (() => new Date());
  const version = opciones.version ?? '0.1.0';
  const almacen = crearAlmacen({
    rutaDatos: opciones.rutaDatos, wasmPath: opciones.wasmPath, ahora, debounceMs: opciones.debounceMs,
    temporizador: opciones.temporizador, alError: opciones.alError, kdf: opciones.kdf,
  });

  let sesion: UsuarioPublico | null = null;
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
    auditar: (d) => escribirAuditoria(d, sesion?.id ?? null),
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
    return {
      inicializado, desbloqueado: almacen.estaDesbloqueado(), sesion,
      version, rutaDatos: opciones.rutaDatos, esperaIntento: limContrasena.espera(),
    };
  }

  function auditarYGuardar(d: DatosAuditoria, usuarioId?: number | null) {
    escribirAuditoria(d, usuarioId === undefined ? sesion?.id ?? null : usuarioId);
    almacen.persistir();
  }

  // ───────────────────────────── Ajustes ─────────────────────────────

  const CLAVES_AJUSTE = {
    diasValidezSpd: 'dias_validez_spd', validezExtendidaPermitida: 'validez_extendida_permitida',
    conservacionAniosTrasBaja: 'conservacion_anios_tras_baja', bloqueoMinutos: 'bloqueo_minutos',
    inicioDia: 'inicio_dia', rotar180: 'rotar_180', sentidoTomas: 'sentido_tomas', posicionInicial: 'posicion_inicial',
    lector: 'lector', impresoraEtiquetas: 'impresora_etiquetas', impresoraDocumentos: 'impresora_documentos', carpetaCopias: 'carpeta_copias',
  } as const;

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
      conservacionAniosTrasBaja: entero('conservacion_anios_tras_baja', d.conservacionAniosTrasBaja),
      bloqueoMinutos: entero('bloqueo_minutos', d.bloqueoMinutos),
      inicioDia: enumer('inicio_dia', ['convencional', 'cronologico'], d.inicioDia),
      rotar180: bool('rotar_180', d.rotar180),
      sentidoTomas: enumer('sentido_tomas', ['izquierda_derecha', 'derecha_izquierda'], d.sentidoTomas),
      posicionInicial: enumer('posicion_inicial', ['izquierda', 'derecha'], d.posicionInicial),
      lector,
      impresoraEtiquetas: mapa.get('impresora_etiquetas') ?? null,
      impresoraDocumentos: mapa.get('impresora_documentos') ?? null,
      carpetaCopias: mapa.get('carpeta_copias') ?? null,
    };
  }

  function validarAjustes(a: Partial<Ajustes>): void {
    const rango = (v: unknown, min: number, max: number, nombre: string) => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw err(`${nombre} debe ser un número entero entre ${min} y ${max}.`, 'AJUSTE_INVALIDO');
    };
    if (a.diasValidezSpd !== undefined) rango(a.diasValidezSpd, 1, 30, 'La validez del SPD (días)');
    if (a.conservacionAniosTrasBaja !== undefined) rango(a.conservacionAniosTrasBaja, 1, 50, 'La conservación tras la baja (años)');
    if (a.bloqueoMinutos !== undefined) rango(a.bloqueoMinutos, 1, 120, 'El bloqueo por inactividad (minutos)');
    const bools: (keyof Ajustes)[] = ['validezExtendidaPermitida', 'rotar180'];
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
    for (const k of ['impresoraEtiquetas', 'impresoraDocumentos', 'carpetaCopias'] as const) {
      const v = a[k];
      if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 500)) throw err(`«${k}» no es válido.`, 'AJUSTE_INVALIDO');
    }
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

  async function hacerCopia(carpeta: string | undefined, usuarioId: number | null): Promise<{ ruta: string }> {
    const base = db();
    const destino = carpeta ?? leerAjustes(base).carpetaCopias;
    if (!destino) throw err('No hay carpeta de copias configurada: elige una en Ajustes.', 'SIN_CARPETA_COPIAS');
    escribirAuditoria({ accion: 'exportar', entidad: 'copia', entidadId: null, motivo: 'Copia de seguridad cifrada' }, usuarioId);
    await almacen.flush(true);
    const ruta = crearCopiaFichero(almacen.rutaFichero, destino, ahora());
    return { ruta };
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

  async function desbloqueo(contrasena: string, usarCopia: boolean): Promise<{ estado: EstadoSistema; aviso?: string }> {
    if (almacen.estaDesbloqueado()) return { estado: estadoSync() };
    if (!almacen.existe()) throw err('Todavía no hay datos: haz el primer uso.', 'NO_INICIALIZADO');
    exigirSinEspera();
    let r: { aviso?: string };
    try { r = await almacen.desbloquear(String(contrasena ?? ''), { usarCopia }); }
    catch (e) { if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) fallarContrasena(); throw e; }
    limContrasena.reiniciar();
    reiniciarSesion();
    auditarYGuardar({ accion: 'desbloquear', entidad: 'sistema', motivo: r.aviso ? 'Se restauró la copia anterior del fichero' : null }, null);
    return { estado: estadoSync(), ...(r.aviso ? { aviso: r.aviso } : {}) };
  }

  async function recuperacion(clave: string, nueva: string, usarCopia: boolean): Promise<{ estado: EstadoSistema; aviso?: string }> {
    if (almacen.estaDesbloqueado()) throw err('El programa ya está desbloqueado: usa «cambiar contraseña».', 'YA_DESBLOQUEADO');
    if (!almacen.existe()) throw err('Todavía no hay datos: haz el primer uso.', 'NO_INICIALIZADO');
    validarContrasenaNueva(nueva);
    exigirSinEspera();
    let bytes: Uint8Array;
    try { bytes = claveDesdeTexto(String(clave ?? '')); }
    catch (e) { throw err(e instanceof Error ? e.message : 'La clave de recuperación no es válida.', 'CLAVE_RECUPERACION_INVALIDA'); }
    let r: { aviso?: string };
    try { r = await almacen.recuperar(bytes, nueva, { usarCopia }); }
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
    auditarYGuardar({ accion: 'recuperar', entidad: 'sistema', motivo: 'Contraseña restablecida con la clave de recuperación' }, null);
    return { estado: estadoSync(), ...(r.aviso ? { aviso: r.aviso } : {}) };
  }

  async function bloqueo(motivo: string | null): Promise<EstadoSistema> {
    if (!almacen.estaDesbloqueado()) { reiniciarSesion(); return estadoSync(); }
    try { escribirAuditoria({ accion: 'bloquear', entidad: 'sistema', motivo }, sesion?.id ?? null); almacen.persistir(); } catch { /* si no se puede auditar, se bloquea igual */ }
    reiniciarSesion();
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
      const contrasena = validarContrasenaNueva(datos.contrasena);
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

    recuperar: (clave, nueva) => proteger(async () => (await recuperacion(clave, nueva, false)).estado),

    bloquear: () => proteger(() => bloqueo(null)),

    cambiarContrasena: (actual, nueva) => proteger<null>(async () => {
      db();
      exigirSesion('titular');
      validarContrasenaNueva(nueva);
      exigirSinEspera();
      try { await almacen.cambiarContrasena(String(actual ?? ''), nueva); }
      catch (e) { if (e instanceof ErrorSpd && e.codigo === COD_CONTRASENA) fallarContrasena(); throw e; }
      limContrasena.reiniciar();
      auditarYGuardar({ accion: 'cambiar_contrasena', entidad: 'sistema' });
      await almacen.flush();
      return null;
    }),

    listarUsuarios: () => proteger(() => db().all('SELECT id, nombre, iniciales, rol FROM usuario WHERE activo = 1 ORDER BY id').map(aPublico)),

    iniciarSesion: (usuarioId, pin) => proteger(async () => {
      const base = db();
      const u = base.get<Record<string, string | number>>('SELECT id, nombre, iniciales, rol, hash_clave FROM usuario WHERE id = ? AND activo = 1', [Number(usuarioId)]);
      if (!u) throw err('Usuario no encontrado.', 'USUARIO_NO_ENCONTRADO');
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
        const id = base.run('INSERT INTO usuario(nombre,iniciales,rol,num_colegiado,hash_clave) VALUES (?,?,?,?,?)', [nombre, iniciales, u.rol, numColegiado, hash]).ultimoId;
        ctx.auditar({ accion: 'crear', entidad: 'usuario', entidadId: id, despues: { nombre, iniciales, rol: u.rol, numColegiado } });
        almacen.persistir();
        return { id, nombre, iniciales, rol: u.rol };
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

    crearCopia: (carpeta) => proteger(async () => {
      db();
      const quien = exigirSesion('titular', 'farmaceutico');
      return hacerCopia(carpeta, quien.id);
    }),
  };

  return {
    api, ctx,
    async cerrar() {
      try { await bloqueo('cierre del programa'); } catch { /* ya está bloqueado; el error de guardado lo vio quien llamó antes */ }
    },
    bloquearPorInactividad: () => proteger(() => bloqueo('inactividad')),
    recuperarConCopia: (clave, nueva) => proteger(async () => {
      const r = await recuperacion(clave, nueva, true);
      return { estado: r.estado, aviso: r.aviso ?? '' };
    }),
    crearCopiaAutomatica: () => proteger(async () => hacerCopia(undefined, null)),
    async guardarAhora() { await almacen.flush(); },
  };
}

export { COD_COPIA_DISPONIBLE };
