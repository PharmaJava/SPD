/**
 * Catálogo local de medicamentos. La descripción física y la aptitud para SPD
 * las PROPONE el programa y las CONFIRMA un farmacéutico (o el titular).
 */
import type { Contexto } from '../contexto.ts';
import { ErrorSpd, proteger } from '../contexto.ts';
import type { Resultado, MedicamentoDto } from '../api.ts';
import type { Db } from '../db.ts';
import { normalizarCN } from '../../dominio/gs1.ts';
import { analizarDescripcion } from '../../dominio/descripcion-fisica.ts';
import type { PropuestaDescripcion } from '../../dominio/descripcion-fisica.ts';
import { clasificarMedicamento, normalizar } from '../../dominio/aptitud-spd.ts';
import type { Clasificacion } from '../../dominio/aptitud-spd.ts';
import { ahoraISO, bd, bool, boolDb, exigirSesion, invalido, puedeConfirmar, texto, textoObligatorio, urlHttp } from './comun.ts';
import type { R } from './comun.ts';

// ───────────────────── Principios activos (JSON en la base, texto en el DTO) ─────────────────────

interface Principio { nombre: string; cantidad?: string | number; unidad?: string }

function leerPrincipios(raw: unknown): Principio[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j) && j.every((x) => x && typeof x.nombre === 'string')) return j as Principio[];
  } catch { /* texto libre */ }
  return null;
}

/** «metformina 850 mg + sitagliptina 50 mg» a partir de lo guardado. */
export function principiosATexto(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const l = leerPrincipios(raw);
  if (!l) return raw;
  return l.map((p) => [p.nombre, p.cantidad, p.unidad].filter((x) => x !== undefined && x !== null && x !== '').join(' ')).join(' + ');
}

/** Nombres (sin dosis) de los principios activos guardados. */
export function nombresPrincipios(raw: unknown): string[] {
  const l = leerPrincipios(raw);
  if (l) return l.map((p) => p.nombre);
  if (typeof raw === 'string' && raw.trim() !== '') return raw.split(/\s*(?:\+|\/| y )\s*/).filter(Boolean);
  return [];
}

function textoAPrincipios(t: string | null): string | null {
  if (t === null) return null;
  if (leerPrincipios(t)) return t;
  return JSON.stringify([{ nombre: t }]);
}

// ───────────────────── Vocabulario cerrado de color y forma ─────────────────────

const normLista = (s: string): string => normalizar(s).replace(/\s*(?:,|;| y )\s*/g, ', ');

/** Devuelve el color canónico (minúscula, vocabulario de descripcion-fisica) o lanza. */
export function colorCanonico(entrada: string): string {
  const t = entrada.trim().toLowerCase();
  const a = analizarDescripcion(t);
  const canon = a.colores.join(', ');
  if (canon !== '' && (normLista(canon) === normLista(t) || (a.colores.length === 1 && !/\s/.test(t)))) return canon;
  throw invalido(`Color no reconocido: «${entrada.trim()}». Usa los colores de la lista (blanco, amarillo, rojo, azul, verde, rosa, marrón…).`);
}

/** Devuelve la forma canónica (vocabulario de descripcion-fisica) o lanza. */
export function formaCanonica(entrada: string): string {
  const t = entrada.trim().toLowerCase();
  const a = analizarDescripcion(t);
  const canon = a.forma ?? '';
  if (canon !== '' && (normLista(canon) === normLista(t) || (!/[\s,]/.test(t) && !canon.includes(',')))) return canon;
  throw invalido(`Forma no reconocida: «${entrada.trim()}». Usa las formas de la lista (redondo, oblongo, ovalado, biconvexo…).`);
}

// ───────────────────────────── Filas ↔ DTO ─────────────────────────────

export function medicamentoDto(r: R): MedicamentoDto {
  return {
    cn: r.cn, nombre: r.nombre, nregistro: r.nregistro ?? null, principiosActivos: principiosATexto(r.principios_activos),
    laboratorio: r.laboratorio ?? null, formaFarmaceutica: r.forma_farmaceutica ?? null, unidadesEnvase: r.unidades_envase ?? null,
    receta: r.receta === null || r.receta === undefined ? null : bool(r.receta),
    estupefaciente: bool(r.estupefaciente), psicotropo: bool(r.psicotropo),
    descripcionFisica: r.descripcion_fisica ?? null, color: r.color ?? null, forma: r.forma ?? null, marcasGrabado: r.marcas_grabado ?? null,
    ranurado: r.ranurado === null || r.ranurado === undefined ? null : bool(r.ranurado),
    descripcionEstado: r.descripcion_estado,
    spdAptitud: r.spd_aptitud ?? null, spdMotivo: r.spd_motivo ?? null,
    urlFichaTecnica: r.url_ficha_tecnica ?? null, urlProspecto: r.url_prospecto ?? null, creadoManual: bool(r.creado_manual),
  };
}

export function leerMedicamento(db: Db, cn: string): MedicamentoDto | null {
  const r = db.get<R>('SELECT * FROM medicamento WHERE cn = ?', [cn]);
  return r ? medicamentoDto(r) : null;
}

function cnObligatorio(v: unknown): string {
  const cn = typeof v === 'string' ? normalizarCN(v) : null;
  if (!cn) throw invalido('El código nacional no es válido: debe tener 6 dígitos (con o sin dígito de control) o ser un EAN-13 español.');
  return cn;
}

// ───────────────────────────── Servicios ─────────────────────────────

export function buscarMedicamentos(ctx: Contexto, textoBusqueda: string): Promise<Resultado<MedicamentoDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    const db = bd(ctx);
    const q = normalizar(typeof textoBusqueda === 'string' ? textoBusqueda : '');
    const cnBuscado = typeof textoBusqueda === 'string' ? normalizarCN(textoBusqueda) : null;
    const tokens = q.split(' ').filter(Boolean);
    const filas = db.all<R>('SELECT * FROM medicamento ORDER BY nombre COLLATE NOCASE, cn');
    const out: MedicamentoDto[] = [];
    for (const r of filas) {
      let casa = tokens.length === 0;
      if (!casa) {
        if (cnBuscado && r.cn === cnBuscado) casa = true;
        else {
          const pajar = normalizar([r.nombre, principiosATexto(r.principios_activos), r.laboratorio, r.cn].filter(Boolean).join(' '));
          casa = tokens.every((t) => pajar.includes(t));
        }
      }
      if (casa) out.push(medicamentoDto(r));
      if (out.length >= 100) break;
    }
    return out;
  });
}

export function obtenerMedicamento(ctx: Contexto, cn: string): Promise<Resultado<MedicamentoDto | null>> {
  return proteger(() => {
    exigirSesion(ctx);
    return leerMedicamento(bd(ctx), cnObligatorio(cn));
  });
}

export function analizarFichaTecnica(ctx: Contexto, textoSeccion3: string, nombre?: string, formaFarmaceutica?: string):
  Promise<Resultado<{ descripcion: PropuestaDescripcion; aptitud: Clasificacion | null }>> {
  return proteger(() => {
    exigirSesion(ctx);
    if (typeof textoSeccion3 !== 'string') throw invalido('El texto de la ficha técnica debe ser texto.');
    if (textoSeccion3.length > 20000) throw invalido('El texto de la ficha técnica es demasiado largo.');
    const descripcion = analizarDescripcion(textoSeccion3);
    const aptitud = clasificarMedicamento({
      ...(nombre ? { nombre } : {}),
      ...(formaFarmaceutica ? { formaFarmaceutica } : {}),
    });
    return { descripcion, aptitud };
  });
}

export function fichasIncompletas(ctx: Contexto): Promise<Resultado<MedicamentoDto[]>> {
  return proteger(() => {
    exigirSesion(ctx);
    return bd(ctx).all<R>(
      `SELECT m.* FROM medicamento m WHERE m.descripcion_estado <> 'confirmada' AND (
         EXISTS (SELECT 1 FROM envase e JOIN paciente p ON p.id = e.paciente_id
                  WHERE e.cn = m.cn AND e.estado = 'en_uso' AND p.estado IN ('activo','pausado'))
         OR EXISTS (SELECT 1 FROM tratamiento t JOIN paciente p ON p.id = t.paciente_id
                  WHERE t.cn_preferente = m.cn AND t.finalizado_en IS NULL AND p.estado IN ('activo','pausado')))
       ORDER BY m.nombre COLLATE NOCASE, m.cn`).map(medicamentoDto);
  });
}

type EntradaMedicamento = Partial<MedicamentoDto> & { cn: string; nombre: string };

export function guardarMedicamento(ctx: Contexto, m: EntradaMedicamento, confirmarDescripcion = false): Promise<Resultado<MedicamentoDto>> {
  return proteger(() => {
    const u = exigirSesion(ctx);
    const db = bd(ctx);
    const dto = db.transaccion(() => {
      if (!m || typeof m !== 'object') throw invalido('Faltan los datos del medicamento.');
      // Confirmar la descripción es una firma: sólo farmacéutico o titular, antes de tocar nada.
      if (confirmarDescripcion && !puedeConfirmar(u)) {
        throw new ErrorSpd('Sólo un farmacéutico o el titular puede confirmar la descripción física.', 'SIN_PERMISO');
      }
      const cn = cnObligatorio(m.cn);
      const nombre = textoObligatorio(m.nombre, 'el nombre del medicamento', 250);
      const previo = db.get<R>('SELECT * FROM medicamento WHERE cn = ?', [cn]);
      const antes = previo ? medicamentoDto(previo) : null;
      const tiene = (k: keyof MedicamentoDto) => m[k] !== undefined;
      const elegir = <T>(k: keyof MedicamentoDto, actual: T, convertir: (v: any) => T): T => (tiene(k) ? convertir(m[k]) : actual);

      // Datos generales
      const unidadesEnvase = elegir<number | null>('unidadesEnvase', previo?.unidades_envase ?? null, (v) => {
        if (v === null) return null;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.abs(v * 4 - Math.round(v * 4)) > 1e-9) throw invalido('Las unidades del envase deben ser mayores que cero y múltiplo de 0,25.');
        return v;
      });
      const receta = elegir<number | null>('receta', previo?.receta ?? null, (v) => (v === null ? null : boolDb(v)));
      const nregistro = elegir<string | null>('nregistro', previo?.nregistro ?? null, (v) => texto(v, 'nº de registro', 40));
      const principios = elegir<string | null>('principiosActivos', previo?.principios_activos ?? null, (v) => textoAPrincipios(texto(v, 'principios activos', 500)));
      const laboratorio = elegir<string | null>('laboratorio', previo?.laboratorio ?? null, (v) => texto(v, 'laboratorio', 150));
      const forma = elegir<string | null>('formaFarmaceutica', previo?.forma_farmaceutica ?? null, (v) => texto(v, 'forma farmacéutica', 200));
      const estupefaciente = elegir<number>('estupefaciente', previo?.estupefaciente ?? 0, boolDb);
      const psicotropo = elegir<number>('psicotropo', previo?.psicotropo ?? 0, boolDb);
      const urlFt = elegir<string | null>('urlFichaTecnica', previo?.url_ficha_tecnica ?? null, (v) => urlHttp(v, 'dirección de la ficha técnica'));
      const urlPr = elegir<string | null>('urlProspecto', previo?.url_prospecto ?? null, (v) => urlHttp(v, 'dirección del prospecto'));
      const creadoManual = elegir<number>('creadoManual', previo?.creado_manual ?? 1, boolDb);

      // Descripción física (vocabulario cerrado; el texto libre sólo propone)
      const descripcionPrevia: string | null = previo?.descripcion_fisica ?? null;
      const descripcion = elegir<string | null>('descripcionFisica', descripcionPrevia, (v) => texto(v, 'descripción física', 1000));
      const textoCambiado = tiene('descripcionFisica') && descripcion !== descripcionPrevia;
      const propuesta = textoCambiado && descripcion ? analizarDescripcion(descripcion) : null;
      const color = tiene('color') ? (m.color === null || m.color === '' ? null : colorCanonico(textoObligatorio(m.color, 'el color', 60)))
        : (propuesta && propuesta.colores.length > 0 ? propuesta.colores.join(', ') : previo?.color ?? null);
      const formaFisica = tiene('forma') ? (m.forma === null || m.forma === '' ? null : formaCanonica(textoObligatorio(m.forma, 'la forma', 60)))
        : (propuesta && propuesta.forma ? propuesta.forma : previo?.forma ?? null);
      const marcas = tiene('marcasGrabado') ? texto(m.marcasGrabado, 'marcas de grabado', 120)
        : (propuesta && propuesta.marcas.length > 0 ? propuesta.marcas.join(', ') : previo?.marcas_grabado ?? null);
      const ranurado = elegir<number | null>('ranurado', previo?.ranurado ?? null, (v) => (v === null ? null : boolDb(v)));

      const hayDescripcion = !!(descripcion || color || formaFisica || marcas);
      const cambioDescripcion = !previo || descripcion !== descripcionPrevia || color !== (previo.color ?? null) || formaFisica !== (previo.forma ?? null)
        || marcas !== (previo.marcas_grabado ?? null) || ranurado !== (previo.ranurado ?? null);

      let estadoDesc: 'sin_datos' | 'propuesta' | 'confirmada';
      let confirmadaPor: number | null = null;
      let confirmadaEn: string | null = null;
      if (confirmarDescripcion) {
        if (!color && !formaFisica) throw invalido('No hay descripción que confirmar: indica al menos el color o la forma.');
        estadoDesc = 'confirmada'; confirmadaPor = u.id; confirmadaEn = ahoraISO(ctx);
      } else if (!hayDescripcion) {
        estadoDesc = 'sin_datos';
      } else if (previo?.descripcion_estado === 'confirmada' && !cambioDescripcion) {
        estadoDesc = 'confirmada'; confirmadaPor = previo.descripcion_confirmada_por ?? null; confirmadaEn = previo.descripcion_confirmada_en ?? null;
      } else {
        estadoDesc = 'propuesta';   // un cambio sobre una descripción confirmada obliga a confirmarla otra vez
      }

      // Aptitud para SPD: propuesta del motor; sólo un farmacéutico/titular la fija.
      const clasif = clasificarMedicamento({
        nombre, ...(forma ? { formaFarmaceutica: forma } : {}),
        ...(principiosATexto(principios) ? { principioActivo: nombresPrincipios(principios).join(' + ') } : {}),
      });
      const decididaPor: number | null = previo?.spd_decidido_por ?? null;
      let aptitud: string | null; let motivoApt: string | null; let decididoPor: number | null;
      if (decididaPor !== null) { aptitud = previo!.spd_aptitud ?? null; motivoApt = previo!.spd_motivo ?? null; decididoPor = decididaPor; }
      else { aptitud = clasif?.estado ?? null; motivoApt = clasif?.motivo ?? null; decididoPor = null; }
      const entrante = m.spdAptitud;
      if (entrante !== undefined && entrante !== null && entrante !== aptitud && entrante !== (previo?.spd_aptitud ?? null)) {
        if (!['apto', 'precaucion', 'no_apto'].includes(entrante)) throw invalido('Aptitud para SPD no válida.');
        if (!puedeConfirmar(u)) throw new ErrorSpd('Sólo un farmacéutico o el titular puede fijar la aptitud para SPD.', 'SIN_PERMISO');
        const motivo = texto(m.spdMotivo, 'motivo de la aptitud', 500);
        if (!motivo) throw invalido('Indica el motivo de la decisión sobre la aptitud para SPD.');
        aptitud = entrante; motivoApt = motivo; decididoPor = u.id;
      }

      const params = [nombre, nregistro, principios, laboratorio, forma, unidadesEnvase, receta, estupefaciente, psicotropo, urlFt, urlPr,
        descripcion, color, formaFisica, marcas, ranurado, confirmadaPor, confirmadaEn, aptitud, motivoApt, decididoPor, creadoManual, estadoDesc];
      if (previo) {
        db.run(`UPDATE medicamento SET nombre=?, nregistro=?, principios_activos=?, laboratorio=?, forma_farmaceutica=?, unidades_envase=?, receta=?,
          estupefaciente=?, psicotropo=?, url_ficha_tecnica=?, url_prospecto=?, descripcion_fisica=?, color=?, forma=?, marcas_grabado=?, ranurado=?,
          descripcion_confirmada_por=?, descripcion_confirmada_en=?, spd_aptitud=?, spd_motivo=?, spd_decidido_por=?, creado_manual=?, descripcion_estado=?
          WHERE cn=?`, [...params, cn]);
      } else {
        db.run(`INSERT INTO medicamento(nombre,nregistro,principios_activos,laboratorio,forma_farmaceutica,unidades_envase,receta,estupefaciente,psicotropo,
          url_ficha_tecnica,url_prospecto,descripcion_fisica,color,forma,marcas_grabado,ranurado,descripcion_confirmada_por,descripcion_confirmada_en,
          spd_aptitud,spd_motivo,spd_decidido_por,creado_manual,descripcion_estado,cn) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...params, cn]);
      }
      const despues = leerMedicamento(db, cn)!;
      ctx.auditar({ accion: previo ? 'modificar' : 'crear', entidad: 'medicamento', entidadId: cn, antes: antes, despues });
      if (confirmarDescripcion) {
        ctx.auditar({ accion: 'confirmar_descripcion', entidad: 'medicamento', entidadId: cn, despues: { color, forma: formaFisica, descripcionFisica: descripcion } });
      }
      if (decididoPor !== null && decididoPor !== decididaPor) {
        ctx.auditar({ accion: 'fijar_aptitud', entidad: 'medicamento', entidadId: cn, antes: { spdAptitud: antes?.spdAptitud ?? null }, despues: { spdAptitud: aptitud }, motivo: motivoApt });
      }
      return despues;
    });
    ctx.persistir();
    return dto;
  });
}
