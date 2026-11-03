<script lang="ts">
  import { tostadas, cerrarTostada } from './util.ts';
  import Icono from './Icono.svelte';
</script>
<div class="tostadas" aria-live="polite" aria-relevant="additions">
  {#each $tostadas as t (t.id)}
    <div class="tostada {t.tipo}" role={t.tipo === 'bloqueo' || t.tipo === 'atencion' ? 'alert' : 'status'}>
      <Icono n={t.tipo === 'ok' ? 'ok' : t.tipo === 'bloqueo' ? 'bloqueo' : t.tipo === 'atencion' ? 'alerta' : 'info'} />
      <span class="texto">{t.texto}</span>
      <button class="btn enlace" type="button" onclick={() => cerrarTostada(t.id)} aria-label="Cerrar este aviso"><Icono n="x" tam={16} /></button>
    </div>
  {/each}
</div>
