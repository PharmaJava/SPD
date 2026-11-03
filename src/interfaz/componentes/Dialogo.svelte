<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icono from './Icono.svelte';
  // Diálogo modal nativo: Esc cierra, el foco queda dentro. Cada diálogo tiene su propio id de título.
  // `sucio`: hay cambios sin guardar; cerrar (X, Esc o `pedirCerrar()`) pregunta antes de descartarlos.
  // `bloqueante`: no se puede cerrar con Esc ni con la X (la pantalla de dentro decide cuándo se acaba).
  let { abierto = false, titulo, onclose, ancho = 560, bloqueante = false, sucio = false, children, pie }: {
    bloqueante?: boolean; abierto?: boolean; titulo: string; onclose?: () => void; ancho?: number; sucio?: boolean; children?: Snippet; pie?: Snippet;
  } = $props();
  const uid = `dlg${Math.random().toString(36).slice(2, 8)}`;
  let el: HTMLDialogElement | undefined = $state();
  let ell: HTMLDialogElement | undefined = $state();
  let descartando = $state(false);
  $effect(() => {
    if (!el) return;
    if (abierto && !el.open) el.showModal();
    if (!abierto && el.open) el.close();
  });
  $effect(() => { if (!abierto) descartando = false; });
  $effect(() => {
    if (!ell) return;
    if (descartando && !ell.open) ell.showModal();
    if (!descartando && ell.open) ell.close();
  });
  /** Cierra pidiendo confirmación si hay cambios sin guardar. */
  export function pedirCerrar() { if (sucio) descartando = true; else onclose?.(); }
  function alCancelar(e: Event) { e.preventDefault(); if (!bloqueante) pedirCerrar(); }
</script>
<dialog bind:this={el} class="dialogo" style="width:min({ancho}px, 94vw)" aria-labelledby="{uid}-t" onclose={() => { if (abierto) onclose?.(); }} oncancel={alCancelar}>
  {#if abierto}
    <div class="dialogo-cab"><h2 id="{uid}-t">{titulo}</h2>
      {#if !bloqueante}<button class="btn enlace" type="button" onclick={pedirCerrar} aria-label="Cerrar"><Icono n="x" /></button>{/if}</div>
    <div class="dialogo-cuerpo">{@render children?.()}</div>
    {#if pie}<div class="dialogo-pie">{@render pie()}</div>{/if}
  {/if}
</dialog>
<dialog bind:this={ell} class="dialogo" style="width:min(440px, 94vw)" aria-labelledby="{uid}-d" oncancel={(e) => { e.preventDefault(); descartando = false; }} onclose={() => (descartando = false)}>
  {#if descartando}
    <div class="dialogo-cab"><h2 id="{uid}-d">¿Descartar los cambios?</h2></div>
    <div class="dialogo-cuerpo"><p>Has escrito datos que todavía no se han guardado. Si cierras ahora, se pierden.</p></div>
    <div class="dialogo-pie">
      <button class="btn" type="button" onclick={() => (descartando = false)}>Seguir editando</button>
      <button class="btn peligro" type="button" onclick={() => { descartando = false; onclose?.(); }}>Descartar</button>
    </div>
  {/if}
</dialog>
