<script lang="ts">
  import type { Snippet } from 'svelte';
  // Campo de formulario con etiqueta, ayuda y error en el propio campo.
  let {
    etiqueta, valor = $bindable(''), tipo = 'texto', opciones, ayuda, error, placeholder, requerido = false, autofocus = false,
    onenter, maxlength, inputmode, autocomplete = 'off', filas = 3, min, max, step, disabled = false, id, pequeno = false, children,
  }: {
    etiqueta: string; valor?: string | number | null; tipo?: 'texto' | 'contrasena' | 'fecha' | 'numero' | 'area' | 'seleccion' | 'hora' | 'email';
    opciones?: { valor: string | number; texto: string }[]; ayuda?: string; error?: string | null; placeholder?: string; requerido?: boolean;
    autofocus?: boolean; onenter?: () => void; maxlength?: number; inputmode?: 'numeric' | 'text' | 'tel' | 'email' | 'decimal'; autocomplete?: string;
    filas?: number; min?: number | string; max?: number | string; step?: number | string; disabled?: boolean; id?: string; pequeno?: boolean; children?: Snippet;
  } = $props();
  const uid = `c${Math.random().toString(36).slice(2, 8)}`;
  const idc = $derived(id ?? uid);
  function enter(e: KeyboardEvent) { if (e.key === 'Enter' && onenter && tipo !== 'area') { e.preventDefault(); onenter(); } }
  function enfocar(el: HTMLElement) { if (autofocus) queueMicrotask(() => el.focus()); }
</script>
<div class="campo" class:pequeno-campo={pequeno}>
  <label for={idc}>{etiqueta}{#if requerido}<span class="req" aria-hidden="true"> *</span>{/if}</label>
  {#if tipo === 'area'}
    <textarea id={idc} bind:value={valor} rows={filas} {placeholder} {maxlength} {disabled} class:error={!!error} aria-invalid={!!error} use:enfocar></textarea>
  {:else if tipo === 'seleccion'}
    <select id={idc} bind:value={valor} {disabled} class:error={!!error} aria-invalid={!!error} use:enfocar>
      {#each opciones ?? [] as o (o.valor)}<option value={o.valor}>{o.texto}</option>{/each}
    </select>
  {:else if tipo === 'contrasena'}
    <input id={idc} type="password" bind:value={valor} {placeholder} {maxlength} {autocomplete} {disabled} class:error={!!error} aria-invalid={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'fecha'}
    <input id={idc} type="date" bind:value={valor} {min} {max} {disabled} class:error={!!error} aria-invalid={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'hora'}
    <input id={idc} type="time" bind:value={valor} {disabled} class:error={!!error} aria-invalid={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'numero'}
    <input id={idc} type="number" bind:value={valor} {min} {max} {step} {disabled} inputmode={inputmode ?? 'decimal'} class:error={!!error} aria-invalid={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'email'}
    <input id={idc} type="email" bind:value={valor} {placeholder} {maxlength} {disabled} autocomplete="off" class:error={!!error} aria-invalid={!!error} onkeydown={enter} use:enfocar />
  {:else}
    <input id={idc} type="text" bind:value={valor} {placeholder} {maxlength} {inputmode} {autocomplete} {disabled} class:error={!!error} aria-invalid={!!error} aria-describedby={error ? `${idc}-e` : undefined} onkeydown={enter} use:enfocar />
  {/if}
  {#if children}{@render children()}{/if}
  {#if error}<div class="error-texto" id="{idc}-e" role="alert">{error}</div>{:else if ayuda}<div class="ayuda">{ayuda}</div>{/if}
</div>
