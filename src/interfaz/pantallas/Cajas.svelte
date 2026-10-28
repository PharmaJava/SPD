<script lang="ts">
  // PROVISIONAL: lo sustituye el agente de la interfaz de preparación (U2).
  let { pacienteId }: { pacienteId?: number } = $props();
</script>
<div class="vacio">Cajas: pendiente {pacienteId ?? ''}</div>
