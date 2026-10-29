<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icono from './Icono.svelte';
  // Color + icono + texto, nunca sólo color. `tipo` bloqueo|atencion|info|ok.
  let { tipo = 'info', titulo, children }: { tipo?: 'bloqueo' | 'atencion' | 'info' | 'ok'; titulo?: string; children?: Snippet } = $props();
  const ICONO = { bloqueo: 'bloqueo', atencion: 'alerta', info: 'info', ok: 'ok' } as const;
  const ROTULO = { bloqueo: 'Bloqueado', atencion: 'Atención', info: 'Información', ok: 'Correcto' } as const;
</script>
<div class="aviso {tipo}" role={tipo === 'bloqueo' ? 'alert' : 'status'}>
  <span class="icono"><Icono n={ICONO[tipo]} tam={20} /></span>
  <div class="cuerpo"><strong>{titulo ?? ROTULO[tipo]}{#if children}: {/if}</strong>{#if children}{@render children()}{/if}</div>
</div>
