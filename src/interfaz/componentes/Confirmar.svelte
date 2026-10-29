<script lang="ts">
  import Dialogo from './Dialogo.svelte';
  import Campo from './Campo.svelte';
  // Pregunta antes de una acción importante; opcionalmente pide un motivo escrito.
  let { abierto = false, titulo, mensaje, confirmarTexto = 'Confirmar', peligro = false, pideMotivo = false, etiquetaMotivo = 'Motivo', onconfirmar, oncancelar }: {
    abierto?: boolean; titulo: string; mensaje?: string; confirmarTexto?: string; peligro?: boolean; pideMotivo?: boolean; etiquetaMotivo?: string;
    onconfirmar: (motivo: string) => void | Promise<void>; oncancelar: () => void;
  } = $props();
  let motivo = $state(''); let error = $state<string | null>(null); let ocupado = $state(false);
  $effect(() => { if (abierto) { motivo = ''; error = null; ocupado = false; } });
  async function ok() {
    if (pideMotivo && motivo.trim().length < 3) { error = 'Escribe el motivo (unas palabras bastan).'; return; }
    ocupado = true; try { await onconfirmar(motivo.trim()); } finally { ocupado = false; }
  }
</script>
<Dialogo {abierto} {titulo} onclose={oncancelar} ancho={480}>
  {#if mensaje}<p>{mensaje}</p>{/if}
  {#if pideMotivo}<Campo etiqueta={etiquetaMotivo} bind:valor={motivo} {error} autofocus onenter={ok} />{/if}
  {#snippet pie()}
    <button class="btn" onclick={oncancelar}>Cancelar</button>
    <button class="btn {peligro ? 'peligro' : 'principal'}" onclick={ok} disabled={ocupado}>{confirmarTexto}</button>
  {/snippet}
</Dialogo>
