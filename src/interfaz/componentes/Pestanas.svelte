<script lang="ts">
  // Pestañas accesibles: flechas izquierda/derecha cambian de pestaña.
  let { pestanas, activa = $bindable() }: { pestanas: { id: string; etiqueta: string; contador?: number | null }[]; activa: string } = $props();
  function tecla(e: KeyboardEvent) {
    const i = pestanas.findIndex(p => p.id === activa);
    if (e.key === 'ArrowRight') { activa = pestanas[(i + 1) % pestanas.length]!.id; focoActiva(); }
    else if (e.key === 'ArrowLeft') { activa = pestanas[(i - 1 + pestanas.length) % pestanas.length]!.id; focoActiva(); }
  }
  function focoActiva() { queueMicrotask(() => document.querySelector<HTMLElement>('.pestanas [aria-selected="true"]')?.focus()); }
</script>
<div class="pestanas" role="tablist" tabindex="-1" onkeydown={tecla}>
  {#each pestanas as p (p.id)}
    <button role="tab" id="pest-{p.id}" aria-selected={activa === p.id} aria-controls="panel-{p.id}" tabindex={activa === p.id ? 0 : -1}
      class:activa={activa === p.id} onclick={() => (activa = p.id)}>{p.etiqueta}{#if p.contador}<span class="contador">{p.contador}</span>{/if}</button>
  {/each}
</div>
