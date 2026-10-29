<script lang="ts">
  /**
   * Mapa del blíster: filas = días, columnas = momentos de toma, tal como llegan de `mapas`
   * (el dominio ya decidió orden, rotación y huecos). Color + LETRA por medicamento.
   */
  import type { MapaBlister } from '../../../dominio/disposicion-blister.ts';
  import type { EvaluacionPreparacion } from '../../../servicios/api.ts';
  import { unidades } from '../../lib/formato.ts';
  import '../../estilos/u2.css';
  import { colorMed } from './util.ts';

  type Leyenda = EvaluacionPreparacion['leyenda'];
  let { mapa, alveolos, leyenda, hechos, resaltar = null, siguiente = null, onCelda }: {
    mapa: MapaBlister; alveolos: EvaluacionPreparacion['alveolos']; leyenda: Leyenda;
    /** Claves «mapa:fila:columna:tratamiento» ya llenadas. */
    hechos?: Set<string>;
    resaltar?: number | null; siguiente?: { fila: number; columna: number } | null;
    onCelda?: (fila: number, columna: number) => void;
  } = $props();

  const DIAS = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const indiceMed = $derived(new Map(leyenda.map((m, i) => [m.tratamientoId, i])));
  const porCelda = $derived.by(() => {
    const m = new Map<string, EvaluacionPreparacion['alveolos'][number]>();
    for (const a of alveolos) if (a.mapa === mapa.indice) m.set(`${a.fila}:${a.columna}`, a);
    return m;
  });
  const usadas = $derived(new Map(mapa.celdas.map(c => [`${c.fila}:${c.columna}`, c.usada])));

  function dia(f: { fecha: string | null; diaSemana: number | null }) {
    if (!f.fecha) return { a: f.diaSemana ? DIAS[f.diaSemana] : '—', b: '' };
    const [, m, d] = f.fecha.split('-');
    return { a: f.diaSemana ? DIAS[f.diaSemana] : '', b: `${+d} ${MESES[+m - 1]}` };
  }
  const nombreMed = (id: number) => leyenda.find(l => l.tratamientoId === id)?.nombre ?? 'medicamento';
  function etiquetaCelda(fila: number, col: number, contenido: { tratamientoId: number; unidades: number }[]) {
    const d = dia(mapa.filas[fila]);
    const toma = mapa.columnas[col]?.nombre ?? '';
    const que = contenido.length ? contenido.map(c => `${unidades(c.unidades)} de ${nombreMed(c.tratamientoId)}`).join(', ') : 'vacío';
    return `${d.a} ${d.b}, ${toma}: ${que}`;
  }
</script>

<div class="mapa-envoltorio">
  <div class="mapa" style="grid-template-columns: 4.6rem repeat({mapa.columnas.length}, minmax(0, 1fr))" role="grid" aria-label="Mapa del blíster">
    <div></div>
    {#each mapa.columnas as c (c.id)}
      <div class="cab" role="columnheader">{c.nombre}{#if c.hora}<small>{c.hora}</small>{/if}</div>
    {/each}
    {#each mapa.filas as f, fi (fi)}
      {@const d = dia(f)}
      <div class="dia" role="rowheader">{d.a}<small>{d.b}</small></div>
      {#each mapa.columnas as _c, ci (ci)}
        {@const clave = `${fi}:${ci}`}
        {@const usada = usadas.get(clave) !== false}
        {@const al = porCelda.get(clave)}
        {@const contenido = al?.contenido ?? []}
        {@const esSig = siguiente?.fila === fi && siguiente?.columna === ci}
        {@const apagado = resaltar !== null && !contenido.some(x => x.tratamientoId === resaltar)}
        {@const completa = contenido.length > 0 && !!hechos && contenido.every(x => hechos.has(`${mapa.indice}:${fi}:${ci}:${x.tratamientoId}`))}
        {#snippet interior()}
          {#if !usada}<span class="solo-lectores">sin uso</span>
          {:else if !contenido.length}<span aria-hidden="true">—</span>
          {:else}
            {#each contenido as x (x.tratamientoId)}
              {@const i = indiceMed.get(x.tratamientoId) ?? 0}
              <span class="chip-med" class:hecho={hechos?.has(`${mapa.indice}:${fi}:${ci}:${x.tratamientoId}`)} style="--c:{colorMed(leyenda[i]?.color, i)}">
                <span class="letra" aria-hidden="true">{leyenda[i]?.letra ?? '?'}</span><span class="ud">{unidades(x.unidades)}</span>
              </span>
            {/each}
          {/if}
        {/snippet}
        {#if onCelda && usada && contenido.length}
          <button type="button" class="alveolo" class:siguiente={esSig} class:apagado class:completa role="gridcell" aria-label={etiquetaCelda(fi, ci, contenido)}
            data-fila={fi} data-col={ci} onclick={() => onCelda(fi, ci)}>{@render interior()}</button>
        {:else}
          <div class="alveolo" class:sin-uso={!usada} class:sin-toma={usada && !contenido.length} class:apagado class:siguiente={esSig} role="gridcell"
            aria-label={usada ? etiquetaCelda(fi, ci, contenido) : 'sin uso'} data-fila={fi} data-col={ci}>{@render interior()}</div>
        {/if}
      {/each}
    {/each}
  </div>
</div>
