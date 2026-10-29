<script lang="ts">
  /** Diálogo nativo (<dialog>): foco atrapado y Esc para cerrar sin librerías. */
  import type { Snippet } from 'svelte';
  import '../../estilos/u2.css';
  let { titulo, abierto = $bindable(false), children, pie, ancho = false, onCerrar }: {
    titulo: string; abierto?: boolean; children: Snippet; pie?: Snippet; ancho?: boolean; onCerrar?: () => void;
  } = $props();
  let dlg: HTMLDialogElement | undefined = $state();
  $effect(() => {
    if (!dlg) return;
    if (abierto && !dlg.open) dlg.showModal();
    if (!abierto && dlg.open) dlg.close();
  });
  function alCerrar() { if (abierto) { abierto = false; } onCerrar?.(); }
  function clicFondo(e: MouseEvent) { if (e.target === dlg) abierto = false; }
</script>

<dialog bind:this={dlg} class="u2-modal" class:ancho onclose={alCerrar} onclick={clicFondo} aria-label={titulo}>
  {#if abierto}
    <header><h2>{titulo}</h2><button class="btn enlace" type="button" onclick={() => (abierto = false)} aria-label="Cerrar">✕</button></header>
    <div class="cuerpo-modal">{@render children()}</div>
    {#if pie}<footer>{@render pie()}</footer>{/if}
  {/if}
</dialog>
