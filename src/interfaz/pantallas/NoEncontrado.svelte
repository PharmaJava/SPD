<script lang="ts">
  import { ir } from '../router.ts';
  import Aviso from '../componentes/Aviso.svelte';
  let { titulo = 'Paciente no encontrado', mensaje = 'La dirección no corresponde a ningún paciente. Puede que se haya escrito mal o que ya no exista.', volverA = 'pacientes', volverTexto = 'Volver a pacientes' }:
    { titulo?: string; mensaje?: string; volverA?: string; volverTexto?: string } = $props();
</script>
<div class="cabecera-pagina"><h1>{titulo}</h1></div>
<Aviso tipo="atencion" titulo="No se encuentra">{mensaje}</Aviso>
<div class="fila margen-s"><button class="btn principal" type="button" onclick={() => ir(volverA)}>{volverTexto}</button></div>
