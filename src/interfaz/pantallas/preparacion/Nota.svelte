<script lang="ts">
  /** Aviso con color + icono + texto (nunca sólo color). */
  import type { Snippet } from 'svelte';
  import '../../estilos/u2.css';
  let { gravedad = 'info', children, accion, id }: {
    gravedad?: 'bloqueo' | 'atencion' | 'info' | 'ok'; children: Snippet; accion?: Snippet; id?: string;
  } = $props();
  const ICONOS = { bloqueo: '✖', atencion: '▲', info: 'ℹ', ok: '✓' } as const;
  const NOMBRES = { bloqueo: 'No se puede continuar', atencion: 'Atención', info: 'Información', ok: 'Correcto' } as const;
</script>

<div class="aviso {gravedad}" role={gravedad === 'bloqueo' ? 'alert' : 'status'} {id} data-gravedad={gravedad}>
  <span class="icono" aria-hidden="true">{ICONOS[gravedad]}</span>
  <div class="cuerpo" style="flex:1"><span class="solo-lectores">{NOMBRES[gravedad]}: </span>{@render children()}</div>
  {#if accion}<div>{@render accion()}</div>{/if}
</div>
