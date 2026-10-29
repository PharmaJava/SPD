<script lang="ts">
  /** Leyenda de medicamentos del mapa: color + letra + nombre (+ aspecto y avance si se pide). */
  import type { EvaluacionPreparacion } from '../../../servicios/api.ts';
  import '../../estilos/u2.css';
  import { colorMed } from './util.ts';

  type Item = EvaluacionPreparacion['leyenda'][number];
  let { leyenda, activo = null, progreso, seleccionable = false, mostrarDescripcion = false, onElegir }: {
    leyenda: Item[]; activo?: number | null; progreso?: Record<number, { hechos: number; total: number }>;
    seleccionable?: boolean; mostrarDescripcion?: boolean; onElegir?: (tratamientoId: number) => void;
  } = $props();
</script>

<div class="leyenda" role={seleccionable ? 'listbox' : 'list'} aria-label="Medicamentos del blíster">
  {#each leyenda as m, i (m.tratamientoId)}
    {@const pr = progreso?.[m.tratamientoId]}
    {@const completo = !!pr && pr.total > 0 && pr.hechos >= pr.total}
    {#snippet cuerpo()}
      <span class="insignia-med" style="--c:{colorMed(m.color, i)}" aria-hidden="true">{m.letra}</span>
      <span class="texto">
        <span class="nombre">{m.nombre}</span>
        {#if mostrarDescripcion}<span class="desc" style="display:block">{m.descripcion || 'Sin descripción física confirmada'}</span>{/if}
      </span>
      {#if pr}<span class="progreso">{completo ? '✓ ' : ''}{pr.hechos}/{pr.total}</span>{/if}
      {#if seleccionable && i < 9}<span class="tecla" aria-hidden="true">{i + 1}</span>{/if}
    {/snippet}
    {#if seleccionable}
      <button type="button" class="leyenda-item" class:activo={activo === m.tratamientoId} class:completo role="option" aria-selected={activo === m.tratamientoId}
        onclick={() => onElegir?.(m.tratamientoId)} data-prueba="leyenda-{m.tratamientoId}">{@render cuerpo()}</button>
    {:else}
      <div class="leyenda-item" role="listitem">{@render cuerpo()}</div>
    {/if}
  {/each}
</div>
