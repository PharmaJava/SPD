<script lang="ts">
  import type { Snippet } from 'svelte';
  // Campo de formulario con etiqueta, ayuda y error en el propio campo. Todas las ramas comparten los mismos atributos de accesibilidad:
  // aria-invalid, aria-required y aria-describedby (apunta al error o, si no hay, a la ayuda).
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
  const descrito = $derived(error ? `${idc}-e` : ayuda ? `${idc}-a` : undefined);
  const comun = $derived({
    id: idc, disabled, 'aria-invalid': error ? ('true' as const) : undefined, 'aria-required': requerido ? ('true' as const) : undefined, 'aria-describedby': descrito,
  });
  function enter(e: KeyboardEvent) { if (e.key === 'Enter' && onenter && tipo !== 'area') { e.preventDefault(); onenter(); } }
  function enfocar(el: HTMLElement) { if (autofocus) queueMicrotask(() => el.focus()); }
</script>
<div class="campo" class:pequeno-campo={pequeno}>
  <label for={idc}>{etiqueta}{#if requerido}<span class="req" aria-hidden="true"> *</span>{/if}</label>
  {#if tipo === 'area'}
    <textarea {...comun} bind:value={valor} rows={filas} {placeholder} {maxlength} class:error={!!error} use:enfocar></textarea>
  {:else if tipo === 'seleccion'}
    <select {...comun} bind:value={valor} class:error={!!error} use:enfocar>
      {#each opciones ?? [] as o (o.valor)}<option value={o.valor}>{o.texto}</option>{/each}
    </select>
  {:else if tipo === 'contrasena'}
    <input {...comun} type="password" bind:value={valor} {placeholder} {maxlength} {inputmode} {autocomplete} class:error={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'fecha'}
    <input {...comun} type="date" bind:value={valor} {min} {max} class:error={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'hora'}
    <input {...comun} type="time" bind:value={valor} class:error={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'numero'}
    <input {...comun} type="number" bind:value={valor} {min} {max} {step} inputmode={inputmode ?? 'decimal'} class:error={!!error} onkeydown={enter} use:enfocar />
  {:else if tipo === 'email'}
    <input {...comun} type="email" bind:value={valor} {placeholder} {maxlength} inputmode={inputmode ?? 'email'} autocomplete="off" class:error={!!error} onkeydown={enter} use:enfocar />
  {:else}
    <input {...comun} type="text" bind:value={valor} {placeholder} {maxlength} {inputmode} {autocomplete} class:error={!!error} onkeydown={enter} use:enfocar />
  {/if}
  {#if children}{@render children()}{/if}
  {#if error}<div class="error-texto" id="{idc}-e" role="alert">{error}</div>{:else if ayuda}<div class="ayuda" id="{idc}-a">{ayuda}</div>{/if}
</div>
