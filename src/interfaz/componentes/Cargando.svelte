<script lang="ts">
  let { texto = 'Cargando…' }: { texto?: string } = $props();
</script>
<div class="cargando" role="status" aria-live="polite"><span class="rueda" aria-hidden="true"></span>{texto}</div>
