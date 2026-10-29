/**
 * Documentos y consentimientos (docs/09): plantillas con versión, vista previa con las
 * variables rellenas, registro del texto EXACTO firmado (con su hash) y revocación.
 *
 * Las plantillas viajan embebidas en el programa (plantillas-documentos.ts, generado desde
 * plantillas/consentimientos/*.md) y se siembran en `plantilla_documento` al primer uso.
 * Son BORRADORES para revisar con un abogado: la vista lo dice (`esBorrador`).
 */
import { randomUUID } from 'node:crypto';
import type { Contexto } from '../contexto.ts';
import { ErrorSpd } from '../contexto.ts';
import type { Db } from '../db.ts';
import type { EstadoConsentimientosDto, PlantillaDocumentoDto, VistaDocumento } from '../api.ts';
import { PLANTILLAS_DOCUMENTOS } from '../plantillas-documentos.ts';
import { renderizarDocumento, REQUERIDOS_PARA_VALIDAR_SPD } from '../../dominio/documentos.ts';
import type { ValorDocumento } from '../../dominio/documentos.ts';
import { ahoraISO, bd, exigirSesion, formatoFecha, hoyISO, invalido, noEncontrado, nombreCompleto, textoONull } from './util.ts';
import type { R } from './util.ts';
import { consentimientosDe } from './carga.ts';

type Calidad = 'paciente' | 'representante_legal' | 'guardador_de_hecho';
export interface Firmante { nombre: string; dniNie?: string; calidad: Calidad; contactoId?: number }

const CALIDAD_TEXTO: Record<Calidad, string> = {
  paciente: 'paciente', representante_legal: 'representante legal', guardador_de_hecho: 'guardador de hecho',
};

/** Siembra las plantillas embebidas que aún no estén en la base (versión 1, vigente). Idempotente. */
export function sembrarPlantillas(ctx: Contexto): void {
  const db = bd(ctx);
  const faltan = PLANTILLAS_DOCUMENTOS.filter((p) => !db.get('SELECT 1 AS x FROM plantilla_documento WHERE codigo = ?', [p.codigo]));
  if (faltan.length === 0) return;
  db.transaccion(() => {
    for (const p of faltan) {
      const id = db.run('INSERT INTO plantilla_documento(codigo, version, titulo, cuerpo, vigente) VALUES (?,?,?,?,1)', [p.codigo, 1, p.titulo, p.cuerpo]).ultimoId;
      ctx.auditar({ accion: 'crear', entidad: 'plantilla_documento', entidadId: id, despues: { codigo: p.codigo, version: 1, origen: 'plantilla embebida (borrador)' } });
    }
  });
  ctx.persistir();
}

function plantillaVigente(db: Db, codigo: string): R {
  const p = db.get<R>('SELECT * FROM plantilla_documento WHERE codigo = ? AND vigente = 1 ORDER BY version DESC LIMIT 1', [codigo]);
  if (!p) throw noEncontrado(`No existe la plantilla de documento «${codigo}».`);
  return p;
}

function validarFirmante(f: unknown): Firmante {
  const x = f as Partial<Firmante> | null;
  if (!x || typeof x !== 'object') throw invalido('Falta el firmante.');
  if (typeof x.nombre !== 'string' || x.nombre.trim() === '') throw invalido('Falta el nombre del firmante.');
  if (!x.calidad || !(x.calidad in CALIDAD_TEXTO)) throw invalido('La calidad del firmante no es válida (paciente, representante legal o guardador de hecho).');
  if (x.contactoId !== undefined && (!Number.isInteger(x.contactoId) || x.contactoId <= 0)) throw invalido('El contacto indicado no es válido.');
  return { nombre: x.nombre.trim(), calidad: x.calidad, ...(x.dniNie ? { dniNie: String(x.dniNie).trim() } : {}), ...(x.contactoId ? { contactoId: x.contactoId } : {}) };
}

function listaEnvases(db: Db, pacienteId: number, estado: string): string {
  const filas = db.all<R>(
    `SELECT e.cn, e.lote, e.caducidad, e.unidades_restantes, m.nombre FROM envase e JOIN medicamento m ON m.cn = e.cn
      WHERE e.paciente_id = ? AND e.estado = ? ORDER BY e.id`, [pacienteId, estado]);
  if (filas.length === 0) return 'Ninguno';
  return filas.map((e) => `- ${e.nombre} · CN ${e.cn} · lote ${e.lote} · cad. ${formatoFecha(e.caducidad)} · ${e.unidades_restantes} unidades`).join('\n');
}

interface Preparado { plantilla: R; paciente: R; firmante: Firmante; datos: Record<string, ValorDocumento> }

/** Reúne las variables del documento. Lo que no se sabe queda SIN valor (el dominio lo marca y bloquea el definitivo). */
function prepararDatos(ctx: Contexto, db: Db, codigo: string, pacienteId: number, firmanteEntrada?: unknown): Preparado {
  const plantilla = plantillaVigente(db, codigo);
  const paciente = db.get<R>('SELECT * FROM paciente WHERE id = ?', [pacienteId]);
  if (!paciente) throw noEncontrado('El paciente no existe.');
  const far = db.get<R>('SELECT * FROM farmacia WHERE id = 1') ?? {};
  const porDefecto: Firmante = { nombre: nombreCompleto(paciente), calidad: 'paciente' };
  const firmante = firmanteEntrada === undefined ? porDefecto : validarFirmante(firmanteEntrada);

  // contactoId: en la autorización a terceros es la persona AUTORIZADA; en el resto, el contacto del firmante.
  let contacto: R | undefined;
  if (firmante.contactoId !== undefined) {
    contacto = db.get<R>('SELECT * FROM contacto WHERE id = ? AND paciente_id = ?', [firmante.contactoId, pacienteId]);
    if (!contacto) throw invalido('El contacto indicado no pertenece a este paciente.');
  }
  const esAutorizacion = codigo === 'autorizacion_terceros';
  const dniFirmante = firmante.dniNie
    ?? (firmante.calidad === 'paciente' ? textoONull(paciente.dni_nie) : (!esAutorizacion ? textoONull(contacto?.dni_nie) : null))
    ?? undefined;

  const direccionPaciente = textoONull(paciente.direccion)
    ? [paciente.direccion, [paciente.codigo_postal, paciente.municipio].filter(Boolean).join(' ')].filter((x) => typeof x === 'string' && x.trim() !== '').join(', ')
    : undefined;
  const hoy = formatoFecha(hoyISO(ctx));
  const datos: Record<string, ValorDocumento> = {
    'farmacia.nombre': far.nombre, 'farmacia.titular': far.titular, 'farmacia.nif': far.nif, 'farmacia.direccion': far.direccion,
    'farmacia.municipio': far.municipio, 'farmacia.telefono': far.telefono, 'farmacia.email': far.email,
    // El contacto de protección de datos, si no se indicó otro, es el correo de la farmacia. El DPD no se inventa.
    'farmacia.rgpd_contacto': textoONull(far.rgpd_contacto) ?? far.email, 'farmacia.rgpd_dpd': far.rgpd_dpd,
    'paciente.nombre_completo': nombreCompleto(paciente), 'paciente.dni_nie': paciente.dni_nie,
    'paciente.fecha_nacimiento': paciente.fecha_nacimiento ? formatoFecha(paciente.fecha_nacimiento) : undefined,
    'paciente.direccion': direccionPaciente,
    'firmante.nombre': firmante.nombre, 'firmante.dni_nie': dniFirmante, 'firmante.calidad': CALIDAD_TEXTO[firmante.calidad],
    'fecha.hoy': hoy, 'fecha.efecto': hoy,
    'documento.version': String(plantilla.version),
    // Determinista (misma vista → mismo texto → mismo hash). Sin datos personales: id corto del paciente.
    'documento.id': `${String(paciente.id_publico).slice(0, 8).toUpperCase()}-${codigo}-v${plantilla.version}`,
    'tabla_envases_devueltos': listaEnvases(db, pacienteId, 'en_uso'),
    'tabla_envases_sigre': listaEnvases(db, pacienteId, 'desechado'),
  };
  if (esAutorizacion && contacto) {
    datos['autorizado.nombre'] = contacto.nombre; datos['autorizado.dni_nie'] = contacto.dni_nie;
    datos['autorizado.parentesco'] = contacto.parentesco; datos['autorizado.telefono'] = contacto.telefono;
  }
  return { plantilla, paciente, firmante, datos };
}

// ───────────────────────── API ─────────────────────────

export function listarPlantillas(ctx: Contexto): PlantillaDocumentoDto[] {
  exigirSesion(ctx);
  sembrarPlantillas(ctx);
  const db = bd(ctx);
  const codigos = db.all<R>('SELECT DISTINCT codigo FROM plantilla_documento WHERE vigente = 1 ORDER BY codigo');
  return codigos.map((c) => {
    const p = plantillaVigente(db, String(c.codigo));
    return { codigo: String(p.codigo), version: Number(p.version), titulo: String(p.titulo), obligatorioParaValidar: REQUERIDOS_PARA_VALIDAR_SPD.includes(String(p.codigo)) };
  });
}

export function vistaDocumento(ctx: Contexto, codigo: string, pacienteId: number, firmante?: unknown): VistaDocumento {
  exigirSesion(ctx);
  sembrarPlantillas(ctx);
  const db = bd(ctx);
  const { plantilla, datos } = prepararDatos(ctx, db, codigo, pacienteId, firmante);
  const r = renderizarDocumento(String(plantilla.cuerpo), datos);
  return {
    texto: r.texto, faltan: r.faltan, imprimibleDefinitivo: r.imprimibleDefinitivo, esBorrador: r.esBorrador, hash: r.hash,
    avisos: [...r.avisos, ...r.sinCompletar.map((s) => `Falta completar en la plantilla: ${s}`)],
  };
}

export function registrarFirmado(ctx: Contexto, codigo: string, pacienteId: number, firmanteEntrada: unknown): { id: number } {
  const u = exigirSesion(ctx);
  sembrarPlantillas(ctx);
  const db = bd(ctx);
  const firmante = validarFirmante(firmanteEntrada);
  const { plantilla, datos } = prepararDatos(ctx, db, codigo, pacienteId, firmante);
  const r = renderizarDocumento(String(plantilla.cuerpo), datos);
  // Un dato que falta saldría impreso como «⟦ruta⟧»: eso no es un documento que se pueda firmar.
  if (r.faltan.length > 0) {
    throw new ErrorSpd(`No se puede registrar el documento: faltan datos (${r.faltan.join(', ')}). Complétalos y vuelve a imprimirlo.`, 'DOCUMENTO_INCOMPLETO');
  }
  const idPublico = randomUUID();
  const id = db.transaccion(() => {
    const nuevo = db.run(
      `INSERT INTO documento_firmado(id_publico, paciente_id, plantilla_id, firmante, firmante_calidad, contacto_id, firmado_en, texto_impreso, hash_texto, registrado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [idPublico, pacienteId, plantilla.id, firmante.nombre, firmante.calidad, firmante.contactoId ?? null, ahoraISO(ctx), r.texto, r.hash, u.id]).ultimoId;
    // Las plantillas actuales son borradores o traen «[A COMPLETAR]»: se deja constancia en la auditoría.
    const notas = [r.esBorrador ? 'plantilla en estado BORRADOR' : '', r.sinCompletar.length > 0 ? `con fragmentos sin completar (${r.sinCompletar.length})` : ''].filter(Boolean).join('; ');
    ctx.auditar({
      accion: 'crear', entidad: 'documento_firmado', entidadId: nuevo,
      despues: { pacienteId, codigo, version: Number(plantilla.version), hash: r.hash, firmante: firmante.nombre, calidad: firmante.calidad, borrador: r.esBorrador, sinCompletar: r.sinCompletar.length },
      motivo: notas === '' ? null : `Registrado ${notas}`,
    });
    return nuevo;
  });
  ctx.persistir();
  return { id };
}

export function revocar(ctx: Contexto, id: number, motivo: string): null {
  exigirSesion(ctx);
  const db = bd(ctx);
  const m = typeof motivo === 'string' ? motivo.trim() : '';
  if (m.length < 3) throw invalido('Indica el motivo de la revocación.');
  const d = db.get<R>('SELECT * FROM documento_firmado WHERE id = ?', [id]);
  if (!d) throw noEncontrado('El documento no existe.');
  if (d.revocado_en) throw invalido('El documento ya estaba revocado.');
  db.transaccion(() => {
    db.run('UPDATE documento_firmado SET revocado_en = ?, motivo_revocacion = ? WHERE id = ? AND revocado_en IS NULL', [ahoraISO(ctx), m, id]);
    ctx.auditar({ accion: 'revocar', entidad: 'documento_firmado', entidadId: id, antes: { revocado: false }, despues: { revocado: true, pacienteId: Number(d.paciente_id) }, motivo: m });
  });
  ctx.persistir();
  return null;
}

export function estadoConsentimientosDto(ctx: Contexto, pacienteId: number): EstadoConsentimientosDto {
  exigirSesion(ctx);
  const db = bd(ctx);
  if (!db.get('SELECT 1 AS x FROM paciente WHERE id = ?', [pacienteId])) throw noEncontrado('El paciente no existe.');
  const { estado, firmados } = consentimientosDe(db, pacienteId);
  return {
    completo: estado.completo, faltan: estado.faltan, desactualizados: estado.desactualizados, revocados: estado.revocados,
    firmados: firmados.map((f) => ({ id: f.id, codigo: f.codigo, version: f.version, firmadoEn: f.firmadoEn, firmante: f.firmante, revocado: !!f.revocadoEn })),
  };
}
