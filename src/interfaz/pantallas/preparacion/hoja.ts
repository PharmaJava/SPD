/** Hoja de trabajo para llenar el blíster en la mesa (con casillas). HTML autónomo, sin scripts. */
import type { EvaluacionPreparacion } from '../../../servicios/api.ts';
import { fecha, unidades } from '../../lib/formato.ts';
import { escaparHtml as e } from './util.ts';

const DIAS = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

export function hojaTrabajoHtml(ev: EvaluacionPreparacion, opciones: { desde: string; dias: number; farmacia?: string }): string {
  const nombreMed = (id: number) => ev.leyenda.find(l => l.tratamientoId === id);
  let cuerpo = '';
  for (const mapa of ev.mapas) {
    cuerpo += `<h2>Blíster ${mapa.indice + 1} · del ${e(fecha(mapa.desde))} al ${e(fecha(mapa.hasta))}</h2><table class="mapa"><thead><tr><th></th>`;
    for (const c of mapa.columnas) cuerpo += `<th>${e(c.nombre)}${c.hora ? `<br><small>${e(c.hora)}</small>` : ''}</th>`;
    cuerpo += '</tr></thead><tbody>';
    mapa.filas.forEach((f, fi) => {
      cuerpo += `<tr><th>${f.diaSemana ? DIAS[f.diaSemana] : ''}<br><small>${e(f.fecha ? fecha(f.fecha) : '')}</small></th>`;
      mapa.columnas.forEach((_c, ci) => {
        const usada = mapa.celdas.find(c => c.fila === fi && c.columna === ci)?.usada !== false;
        const al = ev.alveolos.find(a => a.mapa === mapa.indice && a.fila === fi && a.columna === ci);
        if (!usada) { cuerpo += '<td class="sin"></td>'; return; }
        const items = (al?.contenido ?? []).map(x => {
          const m = nombreMed(x.tratamientoId);
          return `<div><span class="caja"></span> <b>${e(m?.letra ?? '?')}</b> ${e(unidades(x.unidades))}</div>`;
        }).join('');
        cuerpo += `<td>${items || '—'}</td>`;
      });
      cuerpo += '</tr>';
    });
    cuerpo += '</tbody></table>';
  }
  const leyenda = ev.leyenda.map(l => `<li><b>${e(l.letra)}</b> ${e(l.nombre)}${l.descripcion ? ` — ${e(l.descripcion)}` : ''}</li>`).join('');
  const lotes = new Map<string, string>();
  for (const l of ev.lineasReparto) lotes.set(`${l.nombre}|${l.lote}|${l.caducidad}`, `<li>${e(l.nombre)}: lote <b>${e(l.lote)}</b>, caduca ${e(fecha(l.caducidad))}</li>`);
  const aparte = ev.aparte.length ? `<p><b>Se da aparte (no va en el blíster):</b> ${ev.aparte.map(a => e(a.nombre)).join(', ')}</p>` : '';
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Hoja de trabajo</title><style>
@page{size:A4 landscape;margin:10mm}body{font-family:"Segoe UI",Arial,sans-serif;font-size:11pt;color:#000;margin:0}
h1{font-size:16pt;margin:0 0 2mm}h2{font-size:12pt;margin:5mm 0 2mm}small{font-weight:400;color:#444}
table.mapa{border-collapse:collapse;width:100%}table.mapa th,table.mapa td{border:1px solid #000;padding:1.5mm 2mm;vertical-align:top;text-align:left}
td.sin{background:#ddd}.caja{display:inline-block;width:4mm;height:4mm;border:1px solid #000;vertical-align:-1mm}
ul{margin:1mm 0;padding-left:5mm}</style></head><body><div>
<h1>Hoja de trabajo · ${e(ev.paciente.nombreCompleto)}</h1>
<div>Del ${e(fecha(opciones.desde))}${ev.finPeriodo ? ` al ${e(fecha(ev.finPeriodo))}` : ''} · ${opciones.dias} días${opciones.farmacia ? ' · ' + e(opciones.farmacia) : ''}</div>
<h2>Medicamentos</h2><ul>${leyenda}</ul>${aparte}${cuerpo}
<h2>Cajas de las que se saca</h2><ul>${[...lotes.values()].join('')}</ul>
<p>Temperatura: ______ °C &nbsp; Humedad: ______ % &nbsp; Preparado por: ____________ &nbsp; Fecha: ____________</p>
</div></body></html>`;
}
