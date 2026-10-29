<script lang="ts">
  import { tostadas } from './util.ts';
  import Icono from './Icono.svelte';
</script>
<div class="tostadas" aria-live="polite">
  {#each $tostadas as t (t.id)}
    <div class="tostada {t.tipo}"><Icono n={t.tipo === 'ok' ? 'ok' : t.tipo === 'bloqueo' ? 'bloqueo' : t.tipo === 'atencion' ? 'alerta' : 'info'} />{t.texto}</div>
  {/each}
</div>
