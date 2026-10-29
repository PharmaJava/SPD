<script lang="ts">
  import Icono from './Icono.svelte';
  export interface FilaMomento { id?: number; nombre: string; hora: string; activo: boolean }
  // Editor de momentos de toma: añadir, ordenar y quitar (en Ajustes se desactivan, no se borran).
  let { momentos = $bindable(), modo = 'inicial' }: { momentos: FilaMomento[]; modo?: 'inicial' | 'ajustes' } = $props();
  function subir(i: number) { if (i > 0) { const m = [...momentos]; [m[i - 1], m[i]] = [m[i]!, m[i - 1]!]; momentos = m; } }
  function bajar(i: number) { if (i < momentos.length - 1) { const m = [...momentos]; [m[i + 1], m[i]] = [m[i]!, m[i + 1]!]; momentos = m; } }
  function quitar(i: number) {
    const f = momentos[i]!;
    if (modo === 'ajustes' && f.id != null) { momentos[i] = { ...f, activo: !f.activo }; }
    else momentos = momentos.filter((_, j) => j !== i);
  }
  function anadir() { momentos = [...momentos, { nombre: '', hora: '', activo: true }]; queueMicrotask(() => { const l = document.querySelectorAll<HTMLInputElement>('.lista-momentos input[type=text]'); l[l.length - 1]?.focus(); }); }
</script>
<div class="lista-momentos">
  {#each momentos as m, i (m.id ?? 'n' + i)}
    <div class="fila-mom" class:inactivo={!m.activo}>
      <input type="text" bind:value={m.nombre} aria-label="Nombre del momento {i + 1}" placeholder="Nombre (p. ej. Desayuno)" disabled={!m.activo} />
      <input type="time" bind:value={m.hora} aria-label="Hora orientativa de {m.nombre || 'momento ' + (i + 1)}" disabled={!m.activo} />
      <div class="fila" style="gap:.2rem;flex-wrap:nowrap">
        <button class="btn enlace" onclick={() => subir(i)} disabled={i === 0} aria-label="Subir {m.nombre}"><Icono n="arriba" /></button>
        <button class="btn enlace" onclick={() => bajar(i)} disabled={i === momentos.length - 1} aria-label="Bajar {m.nombre}"><Icono n="abajo" /></button>
        <button class="btn enlace" onclick={() => quitar(i)} aria-label={modo === 'ajustes' && m.id != null ? (m.activo ? 'Desactivar ' : 'Reactivar ') + m.nombre : 'Quitar ' + m.nombre}>
          {#if modo === 'ajustes' && m.id != null}{m.activo ? 'Desactivar' : 'Reactivar'}{:else}<Icono n="papelera" />{/if}</button>
      </div>
    </div>
  {/each}
  <button class="btn" onclick={anadir}><Icono n="mas" />Añadir momento</button>
</div>
