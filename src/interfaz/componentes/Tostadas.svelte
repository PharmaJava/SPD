<script lang="ts">
  import { tostadas, cerrarTostada, cerrarTodasTostadas, pausarTostada, reanudarTostada } from './util.ts';
  import Icono from './Icono.svelte';
</script>
<div class="tostadas" aria-live="polite" aria-relevant="additions">
  {#if $tostadas.length > 1}
    <button class="btn mini cerrar-todas" type="button" onclick={cerrarTodasTostadas} data-prueba="cerrar-todas-tostadas">Cerrar todas</button>
  {/if}
  {#each $tostadas as t (t.id)}
    <!-- Un clic en cualquier parte del aviso lo cierra. Con el ratón (o el foco) encima no se cierra solo. -->
    <div class="tostada {t.tipo}" role={t.tipo === 'bloqueo' || t.tipo === 'atencion' ? 'alert' : 'status'} data-prueba="tostada"
      title="Clic para cerrar" tabindex="-1"
      onclick={() => cerrarTostada(t.id)} onkeydown={(e) => { if (e.key === 'Escape') cerrarTostada(t.id); }}
      onmouseenter={() => pausarTostada(t.id)} onmouseleave={() => reanudarTostada(t.id)}
      onfocusin={() => pausarTostada(t.id)} onfocusout={() => reanudarTostada(t.id)}>
      <Icono n={t.tipo === 'ok' ? 'ok' : t.tipo === 'bloqueo' ? 'bloqueo' : t.tipo === 'atencion' ? 'alerta' : 'info'} />
      <span class="texto">{t.texto}{#if t.veces > 1} <span class="veces" aria-label="{t.veces} veces">×{t.veces}</span>{/if}</span>
      <button class="btn enlace" type="button" onclick={(e) => { e.stopPropagation(); cerrarTostada(t.id); }} aria-label="Cerrar este aviso"><Icono n="x" tam={16} /></button>
    </div>
  {/each}
</div>
