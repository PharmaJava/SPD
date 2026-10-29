/**
 * HTML imprimible de una preparación: etiqueta (motor de etiquetas del dominio) y hoja A4
 * del paciente (mapa día × toma). Sin acceso a la base: recibe todo ya cargado.
 *
 * Reglas (CLAUDE.md, regla 1):
 *  - Nada se imprime "a medias": un dato que falta (lote, caducidad…) se marca y bloquea la
 *    versión definitiva.
 *  - Sólo una preparación VALIDADA (o ya entregada) es imprimible. Las demás llevan marca de
 *    agua y `imprimible: false`.
 *  - Todo valor que entra en el HTML se escapa.
 */
import type { VistaImprimible } from '../api.ts';
import type { Cargado } from './carga.ts';
import type { R } from './util.ts';
import { formatoFecha } from './util.ts';
import {
  escaparHtml as esc, formatearUnidades, PLANTILLA_DOC07_RESUMIBLE, renderizarEtiqueta,
} from '../../dominio/etiquetas.ts';
import type { Plantilla, TomaEntrada } from '../../dominio/etiquetas.ts';

export interface Quien { prep?: R | null; val?: R | null }

const PENDIENTE = '——';

const imprimibleEstado = (estado: string) => estado === 'validado' || estado === 'entregado';

function marcaAgua(estado: string): string | null {
  if (estado === 'anulado') return 'ANULADA';
  return imprimibleEstado(estado) ? null : 'SIN VALIDAR';
}

/** Inserta la marca de agua (texto grande en diagonal) en el documento. */
function conMarcaAgua(html: string, texto: string): string {
  const css = '<style>.marca-agua{position:fixed;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
    'font:bold 22mm Arial,Helvetica,sans-serif;color:rgba(200,0,0,.28);transform:rotate(-30deg);pointer-events:none;z-index:99;text-align:center}</style>';
  return html.replace('</head>', `${css}</head>`).replace('</body>', `<div class="marca-agua">${esc(texto)}</div></body>`);
}

function iniciales(u: R | null | undefined): string {
  return u && typeof u.iniciales === 'string' && u.iniciales.trim() !== '' ? u.iniciales.trim() : PENDIENTE;
}

// ───────────────────────── etiqueta ─────────────────────────

/** Plantilla por defecto: la del doc 07 (100×150 mm). Sin teléfono de farmacia, no se pide ese dato. */
export function plantillaEtiquetaPorDefecto(tieneTelefono: boolean): Plantilla {
  const base = PLANTILLA_DOC07_RESUMIBLE;
  return {
    ...base,
    formato_es: true,
    exigirDescripcion: false,
    bloques: base.bloques.map((b, i) => (i === 0 && !tieneTelefono ? { ...b, contenido: '{{farmacia.nombre}}' } : b)),
  };
}

/** Tomas de la etiqueta: una entrada por fecha y momento, con todos los medicamentos y lotes. */
export function tomasParaEtiqueta(c: Cargado): TomaEntrada[] {
  const orden = new Map(c.aux.momentos.map((m) => [m.id, m]));
  const nombreMomento = (id: number) => orden.get(id)?.nombre ?? `momento ${id}`;
  const grupos = new Map<string, TomaEntrada>();
  const lineas = [...c.evaluacion.lineasReparto].sort((a, b) =>
    a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (orden.get(a.momentoId)?.orden ?? 0) - (orden.get(b.momentoId)?.orden ?? 0) || a.momentoId - b.momentoId || a.tratamientoId - b.tratamientoId);
  for (const l of lineas) {
    const k = `${l.fecha}|${l.momentoId}`;
    let g = grupos.get(k);
    if (!g) { g = { fecha: l.fecha, momentoNombre: nombreMomento(l.momentoId), medicamentos: [] }; grupos.set(k, g); }
    const desc = c.aux.envases.get(l.envaseId)?.descripcion;
    g.medicamentos.push({ nombre: l.nombre, unidades: l.unidades, lote: l.lote, caducidad: l.caducidad, ...(desc ? { descripcion: desc } : {}) });
  }
  return [...grupos.values()];
}

export function etiquetaHtml(prep: R, c: Cargado, quien: Quien, alertas: string[]): VistaImprimible {
  const f = c.aux.farmacia;
  const pac = c.aux.paciente;
  const telefono = f && typeof f.telefono === 'string' && f.telefono.trim() !== '' ? f.telefono : undefined;
  const plantilla = plantillaEtiquetaPorDefecto(telefono !== undefined);
  const datos = {
    farmacia: { nombre: f?.nombre ?? '', direccion: f?.direccion ?? '', telefono: telefono ?? '' },
    paciente: { nombre_completo: c.evaluacion.paciente.nombreCompleto, id_corto: String(pac.id_publico ?? '').slice(0, 8) },
    preparacion: { id_publico: String(prep.id_publico), caducidad: String(prep.caducidad_spd) },
    periodo: { inicio: String(prep.fecha_inicio), fin: String(prep.fecha_fin) },
    prep: { iniciales: iniciales(quien.prep) },
    val: { iniciales: iniciales(quien.val) },
    tomas: tomasParaEtiqueta(c),
    aparte: c.evaluacion.aparte.map((a) => c.aux.aparteTextos.get(a.tratamientoId) ?? a.nombre),
    unidadesEsperadas: c.evaluacion.unidadesEsperadas,
  };
  const r = renderizarEtiqueta(plantilla, datos);
  const problemas = [...r.problemas];
  const estado = String(prep.estado);
  let imprimible = r.imprimible;
  for (const a of alertas) { problemas.push(a); imprimible = false; }
  if (!imprimibleEstado(estado)) {
    imprimible = false;
    problemas.unshift(estado === 'anulado' ? 'La preparación está anulada: no se imprime.' : 'La preparación no está validada: sólo es un borrador (SIN VALIDAR).');
  }
  if (r.html === '') imprimible = false;
  const marca = marcaAgua(estado);
  return { html: marca && r.html !== '' ? conMarcaAgua(r.html, marca) : r.html, imprimible, problemas, faltan: r.faltan };
}

// ───────────────────────── hoja A4 ─────────────────────────

const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const CSS_HOJA =
  '@page{size:210mm 297mm;margin:10mm}html,body{margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#000}' +
  'h1{font-size:14pt;margin:0 0 2mm}h2{font-size:10.5pt;margin:4mm 0 1.5mm}p{margin:0 0 1.5mm}' +
  'table{border-collapse:collapse;width:100%;margin-bottom:2mm}th,td{border:0.3mm solid #000;padding:1mm 1.5mm;vertical-align:top;text-align:left}' +
  'th{background:#eee}td.vacia{background:#f3f3f3;color:#777}td.celda b{font-size:10pt}.fila-dia{white-space:nowrap;font-weight:bold}' +
  '.aviso{border:0.5mm solid #b45309;padding:1.5mm;margin:2mm 0;font-weight:bold}.cabecera{display:flex;justify-content:space-between;align-items:flex-start}' +
  '.codigo{width:24mm;height:24mm}.pie{margin-top:4mm;font-size:8pt}.sin-caja{color:#b00;font-weight:bold}';

export function hojaHtml(prep: R, c: Cargado, quien: Quien, alertas: string[]): VistaImprimible {
  const f = c.aux.farmacia;
  const estado = String(prep.estado);
  const letras = new Map(c.evaluacion.leyenda.map((l) => [l.tratamientoId, l]));
  const faltan: string[] = [];
  const problemas: string[] = [];

  // Cajas usadas (todas, con su lote y caducidad): sin lote o caducidad no se imprime la definitiva.
  const cajas = new Map<number, { tratamientoId: number; unidades: number }>();
  for (const l of c.evaluacion.lineasReparto) {
    const x = cajas.get(l.envaseId) ?? { tratamientoId: l.tratamientoId, unidades: 0 };
    x.unidades += l.unidades;
    cajas.set(l.envaseId, x);
  }
  for (const id of cajas.keys()) {
    const e = c.aux.envases.get(id);
    if (!e || e.lote.trim() === '') faltan.push(`caja ${id}.lote`);
    if (!e || e.caducidad.trim() === '') faltan.push(`caja ${id}.caducidad`);
  }
  if (c.evaluacion.lineasReparto.length === 0) faltan.push('tomas');

  const mapasHtml = c.evaluacion.mapas.map((mapa) => {
    const celdas = new Map(c.evaluacion.alveolos.filter((a) => a.mapa === mapa.indice).map((a) => [`${a.fila}|${a.columna}`, a]));
    const cab = mapa.columnas.map((m) => `<th>${esc(m.nombre)}${m.hora ? `<br><small>${esc(m.hora)}</small>` : ''}</th>`).join('');
    const filas = mapa.filas.map((fila, r) => {
      const etiqueta = fila.fecha === null ? '—' : `${esc(DIAS[(fila.diaSemana ?? 1) - 1] ?? '')} ${esc(formatoFecha(fila.fecha).slice(0, 5))}`;
      const tds = mapa.columnas.map((_m, col) => {
        const a = celdas.get(`${r}|${col}`);
        if (!a || a.fecha === null) return '<td class="vacia">—</td>';
        if (a.contenido.length === 0) return '<td class="celda">—</td>';
        const partes = a.contenido.map((x) => {
          const l = letras.get(x.tratamientoId);
          const base = `<b>${esc(l?.letra ?? '?')}</b> ×${esc(formatearUnidades(x.unidades))}`;
          return x.envaseId === undefined ? `<span class="sin-caja">${base} (sin caja)</span>` : base;
        });
        return `<td class="celda">${partes.join('<br>')}</td>`;
      }).join('');
      return `<tr><td class="fila-dia">${etiqueta}</td>${tds}</tr>`;
    }).join('');
    return `<h2>Blíster ${mapa.indice + 1} de ${c.evaluacion.mapas.length} · del ${esc(formatoFecha(mapa.desde))} al ${esc(formatoFecha(mapa.hasta))}</h2>` +
      `<table><thead><tr><th>Día</th>${cab}</tr></thead><tbody>${filas}</tbody></table>`;
  }).join('');

  const leyendaFilas = c.evaluacion.leyenda
    .filter((l) => c.evaluacion.lineasReparto.some((x) => x.tratamientoId === l.tratamientoId))
    .map((l) => {
      const usadas = [...cajas.entries()].filter(([, v]) => v.tratamientoId === l.tratamientoId).map(([id]) => c.aux.envases.get(id)).filter((e) => e !== undefined);
      const lotes = usadas.map((e) => `Lote ${esc(e.lote === '' ? '⟦lote⟧' : e.lote)} · cad. ${esc(e.caducidad === '' ? '⟦caducidad⟧' : formatoFecha(e.caducidad))} · CN ${esc(e.cn)}`).join('<br>');
      return `<tr><td><b>${esc(l.letra)}</b></td><td>${esc(l.nombre)}<br><small>${esc(l.abreviatura)}</small></td>` +
        `<td>${l.descripcion ? esc(l.descripcion) : 'sin descripción física'}</td><td>${lotes}</td></tr>`;
    }).join('');

  const aparte = c.evaluacion.aparte.map((a) => `<li>${esc(c.aux.aparteTextos.get(a.tratamientoId) ?? a.nombre)}</li>`).join('');
  const fuera = Number(prep.fuera_de_estandar) === 1
    ? `<p class="aviso">Validez de ${esc(String(prep.validez_dias))} días: supera los 14 de los documentos de referencia (desviación registrada).</p>` : '';
  const prepPor = quien.prep ? `${esc(String(quien.prep.nombre))} (${esc(iniciales(quien.prep))})${prep.preparado_en ? ` el ${esc(formatoFecha(String(prep.preparado_en)))}` : ''}` : PENDIENTE;
  const valPor = quien.val ? `${esc(String(quien.val.nombre))} (${esc(iniciales(quien.val))})${prep.validado_en ? ` el ${esc(formatoFecha(String(prep.validado_en)))}` : ''}` : PENDIENTE;
  const farmaciaLinea = [f?.nombre, f?.direccion, f?.telefono].filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => esc(String(x))).join(' · ');
  if (!f || typeof f.nombre !== 'string' || f.nombre.trim() === '') faltan.push('farmacia.nombre');

  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Plan de administración</title><style>${CSS_HOJA}</style></head><body><main>` +
    `<div class="cabecera"><div><h1>Plan de administración del SPD</h1><p>${farmaciaLinea}</p>` +
    `<p><b>Paciente:</b> ${esc(c.evaluacion.paciente.nombreCompleto)}</p>` +
    `<p><b>Periodo:</b> del ${esc(formatoFecha(String(prep.fecha_inicio)))} al ${esc(formatoFecha(String(prep.fecha_fin)))} · <b>Caduca el SPD:</b> ${esc(formatoFecha(String(prep.caducidad_spd)))}</p>` +
    `<p><b>Preparado por:</b> ${prepPor} · <b>Validado por:</b> ${valPor}</p></div>` +
    `<div class="codigo" data-codigo="${esc(String(prep.id_publico))}" data-simbologia="qrcode"></div></div>` +
    fuera + mapasHtml +
    `<h2>Medicamentos</h2><table><thead><tr><th>Letra</th><th>Medicamento</th><th>Descripción física</th><th>Lotes y caducidades</th></tr></thead><tbody>${leyendaFilas}</tbody></table>` +
    (aparte ? `<h2>Administrar aparte (no va en el blíster)</h2><ul>${aparte}</ul>` : '') +
    `<p class="pie">Identificador del SPD: ${esc(String(prep.id_publico).slice(0, 8))}. Consérvelo en lugar seco, protegido de la luz y la humedad, y no lo use pasada la fecha de caducidad del SPD.</p>` +
    `</main></body></html>`;

  for (const f2 of faltan) problemas.push(`falta el dato «${f2}»`);
  let imprimible = faltan.length === 0;
  for (const a of alertas) { problemas.push(a); imprimible = false; }
  if (!imprimibleEstado(estado)) {
    imprimible = false;
    problemas.unshift(estado === 'anulado' ? 'La preparación está anulada: no se imprime.' : 'La preparación no está validada: sólo es un borrador (SIN VALIDAR).');
  }
  const marca = marcaAgua(estado);
  return { html: marca ? conMarcaAgua(html, marca) : html, imprimible, problemas, faltan };
}
