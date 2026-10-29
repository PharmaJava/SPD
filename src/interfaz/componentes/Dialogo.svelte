<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icono from './Icono.svelte';
  // Diálogo modal nativo: Esc cierra, el foco queda dentro.
  let { abierto = false, titulo, onclose, ancho = 560, children, pie }: {
    abierto?: boolean; titulo: string; onclose?: () => void; ancho?: number; children?: Snippet; pie?: Snippet;
  } = $props();
  let el: HTMLDialogElement | undefined = $state();
  $effect(() => {
    if (!el) return;
    if (abierto && !el.open) el.showModal();
    if (!abierto && el.open) el.close();
  });
</script>
<dialog bind:this={el} class="dialogo" style="width:min({ancho}px, 94vw)" aria-labelledby="dlg-t" onclose={() => onclose?.()} oncancel={() => onclose?.()}>
  {#if abierto}
    <div class="dialogo-cab"><h2 id="dlg-t">{titulo}</h2>
      <button class="btn enlace" onclick={() => onclose?.()} aria-label="Cerrar"><Icono n="x" /></button></div>
    <div class="dialogo-cuerpo">{@render children?.()}</div>
    {#if pie}<div class="dialogo-pie">{@render pie()}</div>{/if}
  {/if}
</dialog>
