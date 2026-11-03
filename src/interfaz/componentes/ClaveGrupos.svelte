<script lang="ts">
  // Clave de recuperación en grupos numerados y legibles. Un solo componente para que el primer uso y Ajustes la pinten igual.
  let { grupos, etiqueta = 'Clave de recuperación' }: { grupos: string[]; etiqueta?: string } = $props();
</script>
<div class="clave" role="group" aria-label="{etiqueta}: {grupos.length} grupos">
  {#each grupos as g, i}
    <span class="grupo"><span class="n"><span class="solo-lectores">Grupo </span>{i + 1}</span><span class="cod">{g}</span></span>
  {/each}
</div>
