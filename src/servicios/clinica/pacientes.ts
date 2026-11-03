/**
 * Pacientes, centros, contactos y datos de salud.
 * Toda escritura: transacción + auditoría dentro + persistir al final.
 */
import type { Contexto } from '../contexto.ts';
import { proteger } from '../contexto.ts';
import type { Resultado, PacienteDto, NuevoPaciente, PacienteResumen, EstadoPaciente, CentroDto, ContactoDto, SaludDatoDto, TipoCentro, OrigenPaciente, ResumenOrigen } from '../api.ts';
import { TIPOS_CENTRO, esTipoCentro, normalizarNombreCentro, buscarCentroIgual, resumirOrigen } from '../../dominio/origen-paciente.ts';
import { normalizar } from '../../dominio/aptitud-spd.ts';
import { ahoraISO, bd, bool, boolDb, esFechaIso, exigirSesion, hoyISO, invalido, noEncontrado, sumarDias, sumarMeses, texto, textoObligatorio } from './comun.ts';
import type { R } from './comun.ts';
import { coberturaPorPaciente } from './cobertura.ts';
import type { Db } from '../db.ts';

const ESTADOS: EstadoPaciente[] = ['activo', 'pausado', 'baja', 'fallecido'];

export function pacienteDto(r: R): PacienteDto {
  return {
    id: r.id, idPublico: r.id_publico, nombre: r.nombre, apellido1: r.apellido1, apellido2: r.apellido2 ?? null,
    fechaNacimiento: r.fecha_nacimiento ?? null, sexo: r.sexo ?? null, dniNie: r.dni_nie ?? null,
    cipAutonomico: r.cip_autonomico ?? null, cipSns: r.cip_sns ?? null, nass: r.nass ?? null, tsiCcaa: r.tsi_ccaa ?? null,
    aseguradora: r.aseguradora ?? null, direccion: r.direccion ?? null, codigoPostal: r.codigo_postal ?? null,
    municipio: r.municipio ?? null, telefono: r.telefono ?? null, telefono2: r.telefono2 ?? null, email: r.email ?? null,
    centroId: r.centro_id ?? null, habitacion: r.habitacion ?? null,
    necesitaBraille: bool(r.necesita_braille), letraGrande: bool(r.letra_grande),
    estado: r.estado, motivoEstado: r.motivo_estado ?? null, altaEn: r.alta_en, bajaEn: r.baja_en ?? null,
    proximaRevision: r.proxima_revision ?? null, notas: r.notas ?? null,
  };
}

export function leerPaciente(db: Db, id: number): PacienteDto | null {
  const r = db.get<R>('SELECT * FROM paciente WHERE id = ?', [id]);
  return r ? pacienteDto(r) : null;
}

function exigirPaciente(db: Db, id: unknown): PacienteDto {
  if (typeof id !== 'number' || !Number.isInteger(id)) throw invalido('Paciente no válido.');
  const p = leerPaciente(db, id);
  if (!p) throw noEncontrado('Paciente no encontrado.');
  return p;
}

/**
 * DNI/NIE: se normaliza (mayúsculas, sin espacios, puntos ni guiones) y se comprueba el FORMATO (8 cifras + letra, o X/Y/Z + 7 cifras +
 * letra). La letra de control NO se valida: una fórmula sin contrastar rechazaría documentos buenos (CLAUDE.md).
 */
export function normalizarDni(v: unknown): string | null {
  const t = texto(v, 'DNI/NIE', 30);
  if (t === null) return null;
  const n = t.toUpperCase().replace(/[\s.\-]/g, '');
  if (n === '') return null;
  if (!/^(\d{8}|[XYZ]\d{7})[A-Z]$/.test(n)) throw invalido(`El DNI/NIE «${t}» no tiene un formato válido (8 cifras y una letra, o X/Y/Z, 7 cifras y una letra).`);
  return n;
}

/** Fecha de nacimiento verosímil: de 1900 a hoy. */
const NACIMIENTO_MINIMO = '1900-01-01';

/** Código postal español: 5 cifras. */
function codigoPostalValido(v: unknown): string | null {
  const t = texto(v, 'código postal', 10);
  if (t === null) return null;
  if (!/^\d{5}$/.test(t)) throw invalido(`El código postal «${t}» no es válido (5 cifras).`);
  return t;
}

/** Mismo nombre y apellidos (sin tildes ni mayúsculas) y misma fecha de nacimiento que otro paciente: probablemente es la misma persona. */
function avisosDuplicado(db: Db, d: DatosPaciente, excluirId: number | null): string[] {
  if (!d.fechaNacimiento) return [];
  const clave = (n: unknown, a1: unknown, a2: unknown) => normalizar([n, a1, a2].filter(Boolean).join(' ')).replace(/[^a-z0-9ñ ]/g, '').replace(/\s+/g, ' ').trim();
  const mia = clave(d.nombre, d.apellido1, d.apellido2);
  return db.all<R>('SELECT id, nombre, apellido1, apellido2, estado FROM paciente WHERE fecha_nacimiento = ? AND id <> ?', [d.fechaNacimiento, excluirId ?? 0])
    .filter((o) => clave(o.nombre, o.apellido1, o.apellido2) === mia)
    .map((o) => `Posible paciente duplicado: ya existe ${nombreCompleto(o)} (nº ${o.id}, ${o.estado}) con el mismo nombre y la misma fecha de nacimiento. Comprueba que no es la misma persona antes de seguir.`);
}

const nombreCompleto = (r: R): string => [r.nombre, r.apellido1, r.apellido2].filter(Boolean).join(' ');

// ───────────────────────────── Pacientes ─────────────────────────────

/** Un listado de pacientes es una lectura MASIVA de datos de salud: queda en la auditoría, pero una vez por sesión y minuto (y tipo). */
export const MS_ENTRE_AUDITORIAS_LISTADO = 60_000;
const ultimaAuditoriaListado = new WeakMap<object, { completo: number; busqueda: number }>();

function auditarListado(ctx: Contexto, db: Db, f: { texto?: string; estado?: unknown; centroId?: number; origen?: unknown; centroTipo?: unknown }, resultados: number): void {
  const sesion = ctx.sesion();
  if (!sesion) return;
  const busqueda = typeof f.texto === 'string' && f.texto.trim() !== '';
  const ahora = ctx.ahora().getTime();
  const visto = ultimaAuditoriaListado.get(sesion) ?? { completo: -Infinity, busqueda: -Infinity };
  const clave = busqueda ? 'busqueda' : 'completo';
  if (ahora - visto[clave] < MS_ENTRE_AUDITORIAS_LISTADO) return;
  visto[clave] = ahora; ultimaAuditoriaListado.set(sesion, visto);
  // Nada del texto buscado (puede ser un nombre): sólo que hubo búsqueda, los filtros y cuántos pacientes se vieron.
  db.transaccion(() => ctx.auditar({
    accion: 'consultar', entidad: 'listado_pacientes', entidadId: null,
    despues: { busqueda, resultados, estado: f.estado ?? null, origen: f.origen ?? null, centroId: f.centroId ?? null, centroTipo: f.centroTipo ?? null },
    motivo: 'Consulta de listado de pacientes',
  }));
  ctx.persistir();
}

export function listarPacientes(ctx: Contexto, filtro: { texto?: string; estado?: EstadoPaciente | 'todos'; centroId?: number; origen?: OrigenPaciente; centroTipo?: TipoCentro } = {}): Promise<Resultado<PacienteResumen[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const f = filtro ?? {};
    const hoy = hoyISO(ctx);
    const filas = db.all<R>(
      `SELECT p.*, c.nombre AS centro_nombre, c.tipo AS centro_tipo FROM paciente p LEFT JOIN centro c ON c.id = p.centro_id
        ORDER BY p.apellido1 COLLATE NOCASE, p.apellido2 COLLATE NOCASE, p.nombre COLLATE NOCASE, p.id`);

    // Filtros (en memoria: la búsqueda sin tildes no la sabe hacer SQLite).
    const estado = f.estado;
    if (estado !== undefined && estado !== 'todos' && !ESTADOS.includes(estado)) throw invalido('Estado de paciente no válido.');
    if (f.origen !== undefined && f.origen !== 'individual' && f.origen !== 'centro') throw invalido('Origen de paciente no válido.');
    if (f.centroTipo !== undefined && !esTipoCentro(f.centroTipo)) throw invalido('Tipo de centro no válido.');
    const tokens = normalizar(typeof f.texto === 'string' ? f.texto : '').split(' ').filter(Boolean);
    const tokensDni = tokens.map((t) => t.replace(/[.\-]/g, ''));
    const visibles = filas.filter((r) => {
      if (estado === undefined) { if (r.estado === 'baja' || r.estado === 'fallecido') return false; }
      else if (estado !== 'todos' && r.estado !== estado) return false;
      if (f.centroId !== undefined && r.centro_id !== f.centroId) return false;
      if (f.origen === 'individual' && r.centro_id != null) return false;
      if (f.origen === 'centro' && r.centro_id == null) return false;
      if (f.centroTipo !== undefined && (r.centro_id == null || r.centro_tipo !== f.centroTipo)) return false;
      if (tokens.length === 0) return true;
      const pajar = normalizar([r.nombre, r.apellido1, r.apellido2, nombreCompleto(r), r.dni_nie, r.cip_autonomico, r.cip_sns].filter(Boolean).join(' '));
      const pajarDni = normalizar(String(r.dni_nie ?? '')).replace(/[.\-\s]/g, '');
      return tokens.every((t, i) => pajar.includes(t) || (pajarDni !== '' && pajarDni.includes(tokensDni[i])));
    });

    // Datos agregados en pocas consultas (nada de una consulta por paciente).
    const alergias = new Map<number, string[]>();
    for (const a of db.all<R>("SELECT paciente_id, descripcion FROM salud_dato WHERE tipo = 'alergia' AND vigente = 1 ORDER BY id")) {
      const l = alergias.get(a.paciente_id) ?? []; l.push(a.descripcion); alergias.set(a.paciente_id, l);
    }
    const conConsentimiento = new Set(db.all<R>(
      `SELECT DISTINCT d.paciente_id FROM documento_firmado d JOIN plantilla_documento pl ON pl.id = d.plantilla_id
        WHERE pl.codigo = 'consentimiento_spd' AND d.revocado_en IS NULL`).map((r) => r.paciente_id as number));
    // Con consentimiento, pero ninguno es una firma real: consta «gestionado sin firma individual».
    const conFirmaReal = new Set(db.all<R>(
      `SELECT DISTINCT d.paciente_id FROM documento_firmado d JOIN plantilla_documento pl ON pl.id = d.plantilla_id
        WHERE pl.codigo = 'consentimiento_spd' AND d.revocado_en IS NULL AND d.origen = 'firma'`).map((r) => r.paciente_id as number));
    const finPrep = new Map<number, string>();
    for (const r of db.all<R>("SELECT paciente_id, MAX(fecha_fin) AS fin FROM preparacion WHERE estado <> 'anulado' GROUP BY paciente_id")) {
      finPrep.set(r.paciente_id, r.fin);
    }
    const cobertura = coberturaPorPaciente(db, hoy);
    auditarListado(ctx, db, f, visibles.length);

    return visibles.map((r): PacienteResumen => ({
      id: r.id, nombreCompleto: nombreCompleto(r), estado: r.estado, centro: r.centro_nombre ?? null, habitacion: r.habitacion ?? null,
      origen: r.centro_id == null ? 'individual' : 'centro', centroId: r.centro_id ?? null, centroTipo: r.centro_id == null ? null : (r.centro_tipo ?? 'otro'),
      alergias: alergias.get(r.id) ?? [], consentimientoSpd: conConsentimiento.has(r.id), consentimientoGestionado: conConsentimiento.has(r.id) && !conFirmaReal.has(r.id),
      coberturaDias: cobertura.get(r.id) ?? null,
      proximaPreparacion: finPrep.has(r.id) ? sumarDias(finPrep.get(r.id)!, 1) : null,
      proximaRevision: r.proxima_revision ?? null,
    }));
  });
}

export function obtenerPaciente(ctx: Contexto, id: number): Promise<Resultado<PacienteDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      const p = exigirPaciente(db, id);
      ctx.auditar({ accion: 'ver', entidad: 'paciente', entidadId: p.id });
      return p;
    });
    ctx.persistir();
    return dto;
  });
}

interface DatosPaciente {
  nombre: string; apellido1: string; apellido2: string | null; fechaNacimiento: string | null; sexo: string | null; dniNie: string | null;
  cipAutonomico: string | null; cipSns: string | null; nass: string | null; tsiCcaa: string | null; aseguradora: string | null;
  direccion: string | null; codigoPostal: string | null; municipio: string | null; telefono: string | null; telefono2: string | null;
  email: string | null; centroId: number | null; habitacion: string | null; necesitaBraille: boolean; letraGrande: boolean;
  proximaRevision: string | null; notas: string | null;
}

function validarPaciente(db: Db, p: NuevoPaciente, hoy: string, centroActual: number | null = null): DatosPaciente {
  if (!p || typeof p !== 'object') throw invalido('Faltan los datos del paciente.');
  const nombre = textoObligatorio(p.nombre, 'el nombre', 100);
  const apellido1 = textoObligatorio(p.apellido1, 'el primer apellido', 100);
  const fechaNacimiento = texto(p.fechaNacimiento, 'fecha de nacimiento', 10);
  if (fechaNacimiento !== null) {
    if (!esFechaIso(fechaNacimiento)) throw invalido('La fecha de nacimiento no es válida (AAAA-MM-DD).');
    if (fechaNacimiento > hoy) throw invalido('La fecha de nacimiento no puede ser futura.');
    if (fechaNacimiento < NACIMIENTO_MINIMO) throw invalido('La fecha de nacimiento no es verosímil (anterior a 1900): comprueba el año.');
  }
  const sexo = p.sexo ?? null;
  if (sexo !== null && !['M', 'H', 'X'].includes(sexo)) throw invalido('Sexo no válido (M, H o X).');
  const proximaRevision = texto(p.proximaRevision, 'próxima revisión', 10);
  if (proximaRevision !== null && !esFechaIso(proximaRevision)) throw invalido('La fecha de próxima revisión no es válida (AAAA-MM-DD).');
  const email = texto(p.email, 'correo electrónico', 200);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalido('El correo electrónico no es válido.');
  let centroId: number | null = null;
  if (p.centroId !== undefined && p.centroId !== null) {
    const c = typeof p.centroId === 'number' ? db.get<R>('SELECT activo FROM centro WHERE id = ?', [p.centroId]) : undefined;
    if (!c) throw invalido('El centro indicado no existe.');
    // Un centro dado de baja no admite pacientes nuevos; quien ya estaba en él puede seguir.
    if (!bool(c.activo) && p.centroId !== centroActual) throw invalido('Ese centro está dado de baja: reactívalo o elige otro.');
    centroId = p.centroId;
  }
  return {
    nombre, apellido1, apellido2: texto(p.apellido2, 'segundo apellido', 100), fechaNacimiento, sexo, dniNie: normalizarDni(p.dniNie),
    cipAutonomico: texto(p.cipAutonomico, 'CIP autonómico', 60), cipSns: texto(p.cipSns, 'CIP-SNS', 60), nass: texto(p.nass, 'NASS', 60),
    tsiCcaa: texto(p.tsiCcaa, 'comunidad de la tarjeta', 100), aseguradora: texto(p.aseguradora, 'aseguradora', 100),
    direccion: texto(p.direccion, 'dirección', 200), codigoPostal: codigoPostalValido(p.codigoPostal), municipio: texto(p.municipio, 'municipio', 100),
    telefono: texto(p.telefono, 'teléfono', 40), telefono2: texto(p.telefono2, 'segundo teléfono', 40), email, centroId,
    habitacion: centroId === null ? null : texto(p.habitacion, 'habitación', 40), necesitaBraille: bool(p.necesitaBraille), letraGrande: bool(p.letraGrande),
    proximaRevision, notas: texto(p.notas, 'notas', 4000),
  };
}

export function guardarPaciente(ctx: Contexto, p: NuevoPaciente): Promise<Resultado<PacienteDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const hoy = hoyISO(ctx);
    const dto = db.transaccion(() => {
      const id = p.id;
      const centroActual = id !== undefined && id !== null ? (db.get<R>('SELECT centro_id FROM paciente WHERE id = ?', [id])?.centro_id ?? null) : null;
      const d = validarPaciente(db, p, hoy, centroActual);
      if (id !== undefined && id !== null) {
        const antes = exigirPaciente(db, id);
        if (d.dniNie) {
          const otro = db.get<R>('SELECT id, nombre, apellido1 FROM paciente WHERE dni_nie = ? AND id <> ?', [d.dniNie, id]);
          if (otro) throw invalido(`Ya existe otro paciente con ese DNI/NIE (${otro.nombre} ${otro.apellido1}).`);
        }
        // Reactivar (volver al servicio) sólo se pide de forma explícita; el resto de campos nunca cambia el estado.
        const reactivar = (p as { estado?: unknown }).estado === 'activo' && antes.estado !== 'activo';
        db.run(
          `UPDATE paciente SET nombre=?, apellido1=?, apellido2=?, fecha_nacimiento=?, sexo=?, dni_nie=?, cip_autonomico=?, cip_sns=?, nass=?, tsi_ccaa=?,
             aseguradora=?, direccion=?, codigo_postal=?, municipio=?, telefono=?, telefono2=?, email=?, centro_id=?, habitacion=?,
             necesita_braille=?, letra_grande=?, proxima_revision=?, notas=? WHERE id=?`,
          [d.nombre, d.apellido1, d.apellido2, d.fechaNacimiento, d.sexo, d.dniNie, d.cipAutonomico, d.cipSns, d.nass, d.tsiCcaa, d.aseguradora,
            d.direccion, d.codigoPostal, d.municipio, d.telefono, d.telefono2, d.email, d.centroId, d.habitacion,
            boolDb(d.necesitaBraille), boolDb(d.letraGrande), d.proximaRevision, d.notas, id]);
        if (reactivar) db.run("UPDATE paciente SET estado='activo', motivo_estado=NULL, baja_en=NULL WHERE id=?", [id]);
        const despues = exigirPaciente(db, id);
        ctx.auditar({ accion: 'modificar', entidad: 'paciente', entidadId: id, antes, despues });
        if (reactivar) ctx.auditar({ accion: 'reactivar', entidad: 'paciente', entidadId: id, antes: { estado: antes.estado }, despues: { estado: 'activo' }, motivo: 'Vuelve al servicio' });
        const avisos = avisosDuplicado(db, d, id);
        return avisos.length > 0 ? { ...despues, avisos } : despues;
      }
      if (d.dniNie) {
        const otro = db.get<R>('SELECT nombre, apellido1, estado FROM paciente WHERE dni_nie = ?', [d.dniNie]);
        if (otro) throw invalido(`Ya existe un paciente con ese DNI/NIE (${otro.nombre} ${otro.apellido1}, ${otro.estado}). Abre su ficha en lugar de crear otra.`);
      }
      const revision = d.proximaRevision ?? sumarMeses(hoy, 6);   // docs/04 §4.9: por defecto, semestral
      const nuevo = db.run(
        `INSERT INTO paciente(id_publico,nombre,apellido1,apellido2,fecha_nacimiento,sexo,dni_nie,cip_autonomico,cip_sns,nass,tsi_ccaa,aseguradora,
           direccion,codigo_postal,municipio,telefono,telefono2,email,centro_id,habitacion,necesita_braille,letra_grande,estado,alta_en,proxima_revision,notas)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'activo',?,?,?)`,
        [crypto.randomUUID(), d.nombre, d.apellido1, d.apellido2, d.fechaNacimiento, d.sexo, d.dniNie, d.cipAutonomico, d.cipSns, d.nass, d.tsiCcaa,
          d.aseguradora, d.direccion, d.codigoPostal, d.municipio, d.telefono, d.telefono2, d.email, d.centroId, d.habitacion,
          boolDb(d.necesitaBraille), boolDb(d.letraGrande), hoy, revision, d.notas]).ultimoId;
      const creado = exigirPaciente(db, nuevo);
      const avisos = avisosDuplicado(db, d, nuevo);
      ctx.auditar({ accion: 'crear', entidad: 'paciente', entidadId: nuevo, despues: creado, motivo: avisos.length > 0 ? avisos.join(' ') : null });
      return avisos.length > 0 ? { ...creado, avisos } : creado;
    });
    ctx.persistir();
    return dto;
  });
}

export function darDeBajaPaciente(ctx: Contexto, id: number, motivo: string, estado: Exclude<EstadoPaciente, 'activo'>): Promise<Resultado<PacienteDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const hoy = hoyISO(ctx);
    const dto = db.transaccion(() => {
      const antes = exigirPaciente(db, id);
      const m = textoObligatorio(motivo, 'el motivo', 500);
      if (!['pausado', 'baja', 'fallecido'].includes(estado)) throw invalido('Estado no válido: usa pausado, baja o fallecido.');
      if (antes.estado === estado) throw invalido(`El paciente ya está en estado «${estado}».`);
      db.run('UPDATE paciente SET estado = ?, motivo_estado = ?, baja_en = ? WHERE id = ?', [estado, m, estado === 'pausado' ? null : hoy, id]);
      const despues = exigirPaciente(db, id);
      ctx.auditar({ accion: 'baja', entidad: 'paciente', entidadId: id, antes, despues, motivo: m });
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}

// ───────────────────────────── Centros ─────────────────────────────

const centroDto = (r: R): CentroDto => ({
  id: r.id, nombre: r.nombre, direccion: r.direccion ?? null, telefono: r.telefono ?? null, contacto: r.contacto ?? null,
  tipo: esTipoCentro(r.tipo) ? r.tipo : 'otro', activo: bool(r.activo),
});

export function listarCentros(ctx: Contexto): Promise<Resultado<CentroDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    return bd(ctx).all<R>('SELECT * FROM centro ORDER BY nombre COLLATE NOCASE, id').map(centroDto);
  });
}

function tipoCentroValido(v: unknown): TipoCentro {
  if (!esTipoCentro(v)) throw invalido(`Tipo de centro no válido (${TIPOS_CENTRO.join(', ')}).`);
  return v;
}

function centroIgual(db: Db, nombre: string, excluirId?: number): CentroDto | undefined {
  return buscarCentroIgual(db.all<R>('SELECT id, nombre, tipo, activo FROM centro').map(centroDto), nombre, excluirId);
}

export function guardarCentro(ctx: Contexto, c: Omit<CentroDto, 'id' | 'tipo' | 'activo'> & { id?: number; tipo?: TipoCentro; activo?: boolean }): Promise<Resultado<CentroDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      if (!c || typeof c !== 'object') throw invalido('Faltan los datos del centro.');
      const nombre = textoObligatorio(c.nombre, 'el nombre del centro', 150);
      const norm = normalizarNombreCentro(nombre);
      if (norm === '') throw invalido('El nombre del centro no es válido.');
      const comunes = [texto(c.direccion, 'dirección', 200), texto(c.telefono, 'teléfono', 40), texto(c.contacto, 'contacto', 150)];
      if (c.id !== undefined && c.id !== null) {
        const antes = db.get<R>('SELECT * FROM centro WHERE id = ?', [c.id]);
        if (!antes) throw noEncontrado('Centro no encontrado.');
        // Sólo se exige nombre único si el nombre cambia (puede haber duplicados antiguos).
        if (norm !== antes.nombre_norm) {
          const otro = centroIgual(db, nombre, c.id);
          if (otro) throw invalido(`Ya existe un centro con ese nombre («${otro.nombre}»).`);
        }
        const tipo = c.tipo === undefined ? centroDto(antes).tipo : tipoCentroValido(c.tipo);
        const activo = c.activo === undefined ? bool(antes.activo) : bool(c.activo);
        db.run('UPDATE centro SET nombre=?, direccion=?, telefono=?, contacto=?, tipo=?, activo=?, nombre_norm=? WHERE id=?', [nombre, ...comunes, tipo, boolDb(activo), norm, c.id]);
        const despues = centroDto(db.get<R>('SELECT * FROM centro WHERE id = ?', [c.id])!);
        ctx.auditar({ accion: 'modificar', entidad: 'centro', entidadId: c.id, antes: centroDto(antes), despues });
        return despues;
      }
      const otro = centroIgual(db, nombre);
      if (otro) throw invalido(`Ya existe un centro con ese nombre («${otro.nombre}»).`);
      const tipo = c.tipo === undefined ? 'otro' : tipoCentroValido(c.tipo);
      const id = db.run('INSERT INTO centro(nombre,direccion,telefono,contacto,tipo,activo,nombre_norm) VALUES (?,?,?,?,?,?,?)',
        [nombre, ...comunes, tipo, boolDb(c.activo === undefined ? true : bool(c.activo)), norm]).ultimoId;
      const despues = centroDto(db.get<R>('SELECT * FROM centro WHERE id = ?', [id])!);
      ctx.auditar({ accion: 'crear', entidad: 'centro', entidadId: id, despues });
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}

/** Para el alta de paciente: reutiliza el centro que ya existe con ese nombre o lo crea (auditado). */
export function obtenerOCrearCentro(ctx: Contexto, c: { nombre: string; tipo: TipoCentro }): Promise<Resultado<{ centro: CentroDto; creado: boolean }>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const res = db.transaccion(() => {
      if (!c || typeof c !== 'object') throw invalido('Faltan los datos del centro.');
      const nombre = textoObligatorio(c.nombre, 'el nombre del centro', 150);
      const norm = normalizarNombreCentro(nombre);
      if (norm === '') throw invalido('El nombre del centro no es válido.');
      const tipo = tipoCentroValido(c.tipo);
      const existente = centroIgual(db, nombre);
      // Si existe se reutiliza TAL CUAL: el tipo ya registrado manda (cambiarlo es una edición explícita del centro).
      if (existente) return { centro: existente, creado: false };
      const id = db.run('INSERT INTO centro(nombre,tipo,activo,nombre_norm) VALUES (?,?,1,?)', [nombre, tipo, norm]).ultimoId;
      const centro = centroDto(db.get<R>('SELECT * FROM centro WHERE id = ?', [id])!);
      ctx.auditar({ accion: 'crear', entidad: 'centro', entidadId: id, despues: centro });
      return { centro, creado: true };
    });
    if (res.creado) ctx.persistir();
    return res;
  });
}

/** Resumen de pacientes ACTIVOS por origen: individuales, por tipo de centro y por centro. */
export function resumenOrigen(ctx: Contexto): Promise<Resultado<ResumenOrigen>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const centros = db.all<R>('SELECT * FROM centro WHERE activo = 1').map(centroDto);
    const filas = db.all<R>("SELECT p.centro_id, c.nombre AS centro_nombre, c.tipo AS centro_tipo FROM paciente p LEFT JOIN centro c ON c.id = p.centro_id WHERE p.estado = 'activo'");
    return resumirOrigen(
      filas.map((r) => ({ centroId: r.centro_id ?? null, centroNombre: r.centro_nombre ?? null, centroTipo: esTipoCentro(r.centro_tipo) ? r.centro_tipo : null })),
      centros,
    );
  });
}

// ───────────────────────────── Contactos ─────────────────────────────

const TIPOS_CONTACTO = ['cuidador', 'representante_legal', 'familiar', 'medico_cabecera', 'especialista', 'enfermeria', 'centro', 'otro'];

const contactoDto = (r: R): ContactoDto => ({
  id: r.id, pacienteId: r.paciente_id, tipo: r.tipo, nombre: r.nombre, dniNie: r.dni_nie ?? null, parentesco: r.parentesco ?? null,
  telefono: r.telefono ?? null, email: r.email ?? null, numColegiado: r.num_colegiado ?? null, centroSalud: r.centro_salud ?? null,
  autorizadoRecoger: bool(r.autorizado_recoger), notas: r.notas ?? null,
});

export function listarContactos(ctx: Contexto, pacienteId: number): Promise<Resultado<ContactoDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    exigirPaciente(db, pacienteId);
    return db.all<R>('SELECT * FROM contacto WHERE paciente_id = ? AND baja_en IS NULL ORDER BY id', [pacienteId]).map(contactoDto);
  });
}

export function guardarContacto(ctx: Contexto, c: Omit<ContactoDto, 'id'> & { id?: number }): Promise<Resultado<ContactoDto>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      if (!c || typeof c !== 'object') throw invalido('Faltan los datos del contacto.');
      exigirPaciente(db, c.pacienteId);
      if (!TIPOS_CONTACTO.includes(c.tipo)) throw invalido('Tipo de contacto no válido.');
      const nombre = textoObligatorio(c.nombre, 'el nombre del contacto', 150);
      const email = texto(c.email, 'correo electrónico', 200);
      if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalido('El correo electrónico no es válido.');
      const vals = [c.tipo, nombre, normalizarDni(c.dniNie), texto(c.parentesco, 'parentesco', 100), texto(c.telefono, 'teléfono', 40), email,
        texto(c.numColegiado, 'nº de colegiado', 40), texto(c.centroSalud, 'centro de salud', 150), boolDb(c.autorizadoRecoger), texto(c.notas, 'notas', 2000)];
      if (c.id !== undefined && c.id !== null) {
        const antes = db.get<R>('SELECT * FROM contacto WHERE id = ?', [c.id]);
        if (!antes) throw noEncontrado('Contacto no encontrado.');
        if (antes.paciente_id !== c.pacienteId) throw invalido('Ese contacto pertenece a otro paciente.');
        db.run(`UPDATE contacto SET tipo=?, nombre=?, dni_nie=?, parentesco=?, telefono=?, email=?, num_colegiado=?, centro_salud=?, autorizado_recoger=?, notas=? WHERE id=?`, [...vals, c.id]);
        const despues = contactoDto(db.get<R>('SELECT * FROM contacto WHERE id = ?', [c.id])!);
        ctx.auditar({ accion: 'modificar', entidad: 'contacto', entidadId: c.id, antes: contactoDto(antes), despues });
        return despues;
      }
      const id = db.run(`INSERT INTO contacto(paciente_id,tipo,nombre,dni_nie,parentesco,telefono,email,num_colegiado,centro_salud,autorizado_recoger,notas) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [c.pacienteId, ...vals]).ultimoId;
      const despues = contactoDto(db.get<R>('SELECT * FROM contacto WHERE id = ?', [id])!);
      ctx.auditar({ accion: 'crear', entidad: 'contacto', entidadId: id, despues });
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}

// ───────────────────────────── Datos de salud ─────────────────────────────

const TIPOS_SALUD = ['alergia', 'intolerancia', 'diagnostico', 'disfagia', 'insuficiencia_renal', 'insuficiencia_hepatica', 'embarazo_lactancia', 'peso', 'otro'];

const saludDto = (r: R): SaludDatoDto => ({
  id: r.id, pacienteId: r.paciente_id, tipo: r.tipo, descripcion: r.descripcion, valor: r.valor ?? null, fecha: r.fecha ?? null,
  fuente: r.fuente ?? null, vigente: bool(r.vigente),
});

export function listarSalud(ctx: Contexto, pacienteId: number): Promise<Resultado<SaludDatoDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const datos = db.transaccion(() => {
      exigirPaciente(db, pacienteId);
      // Son datos de salud (art. 9 RGPD): leerlos deja rastro.
      ctx.auditar({ accion: 'ver', entidad: 'salud_dato', entidadId: pacienteId });
      return db.all<R>('SELECT * FROM salud_dato WHERE paciente_id = ? ORDER BY vigente DESC, id', [pacienteId]).map(saludDto);
    });
    ctx.persistir();
    return datos;
  });
}

/** Número al principio de un valor («70», «70 kg», «62,5»), o null si no empieza por un número. */
function numeroInicial(v: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)/.exec(v);
  return m ? Number(m[1].replace(',', '.')) : null;
}

/** Peso (kg) y función renal (mL/min) con valores creíbles; un error al teclear («700» kg) pasaría a las decisiones de dosis. */
function valorSaludPlausible(tipo: string, valor: string | null): string | null {
  if (valor === null) return null;
  if (tipo === 'peso') {
    const n = numeroInicial(valor);
    if (n === null) throw invalido('El peso tiene que ser un número (kg).');
    if (n < 1 || n > 400) throw invalido(`El peso (${valor}) no es verosímil: debe estar entre 1 y 400 kg.`);
  } else if (tipo === 'insuficiencia_renal') {
    const n = numeroInicial(valor);
    if (n !== null && n > 250) throw invalido(`El valor de función renal (${valor}) no es verosímil (0-250 mL/min).`);
  }
  return valor;
}

export function guardarSalud(ctx: Contexto, s: Omit<SaludDatoDto, 'id'> & { id?: number }): Promise<Resultado<SaludDatoDto>> {
  return proteger(() => {
    const u = exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      if (!s || typeof s !== 'object') throw invalido('Faltan los datos de salud.');
      exigirPaciente(db, s.pacienteId);
      if (!TIPOS_SALUD.includes(s.tipo)) throw invalido('Tipo de dato de salud no válido.');
      const descripcion = textoObligatorio(s.descripcion, 'la descripción', 500);
      const fecha = texto(s.fecha, 'fecha', 10);
      if (fecha !== null && !esFechaIso(fecha)) throw invalido('La fecha no es válida (AAAA-MM-DD).');
      if (fecha !== null && fecha > hoyISO(ctx)) throw invalido('La fecha de un dato de salud no puede ser futura: es cuándo se supo o se midió.');
      if (fecha !== null && fecha < NACIMIENTO_MINIMO) throw invalido('La fecha del dato de salud no es verosímil (anterior a 1900).');
      const valor = valorSaludPlausible(s.tipo, texto(s.valor, 'valor', 100));
      const vals = [s.tipo, descripcion, valor, fecha, texto(s.fuente, 'fuente', 200), s.vigente === false ? 0 : 1];
      if (s.id !== undefined && s.id !== null) {
        const antes = db.get<R>('SELECT * FROM salud_dato WHERE id = ?', [s.id]);
        if (!antes) throw noEncontrado('Dato de salud no encontrado.');
        if (antes.paciente_id !== s.pacienteId) throw invalido('Ese dato pertenece a otro paciente.');
        db.run('UPDATE salud_dato SET tipo=?, descripcion=?, valor=?, fecha=?, fuente=?, vigente=? WHERE id=?', [...vals, s.id]);
        const despues = saludDto(db.get<R>('SELECT * FROM salud_dato WHERE id = ?', [s.id])!);
        ctx.auditar({ accion: 'modificar', entidad: 'salud_dato', entidadId: s.id, antes: saludDto(antes), despues });
        return despues;
      }
      const id = db.run('INSERT INTO salud_dato(paciente_id,tipo,descripcion,valor,fecha,fuente,vigente,registrado_por,registrado_en) VALUES (?,?,?,?,?,?,?,?,?)',
        [s.pacienteId, ...vals, u.id, ahoraISO(ctx)]).ultimoId;
      const despues = saludDto(db.get<R>('SELECT * FROM salud_dato WHERE id = ?', [id])!);
      ctx.auditar({ accion: 'crear', entidad: 'salud_dato', entidadId: id, despues });
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}

