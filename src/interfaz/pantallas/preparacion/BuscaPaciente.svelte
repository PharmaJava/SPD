<script lang="ts">
  /** Elegir un paciente buscando por nombre. Flechas + Intro; el foco puede nacer aquí. */
  import { onMount } from 'svelte';
  import { spd, datos } from '../../api.ts';
  import type { PacienteResumen } from '../../../servicios/api.ts';
  import '../../estilos/u2.css';
  import { mensaje } from './util.ts';

  let { paciente = $bindable<{ id: number; nombre: string } | null>(null), idInicial, enfocar = false, etiqueta = 'Paciente', onElegir }: {
    paciente?: { id: number; nombre: string } | null; idInicial?: number; enfocar?: boolean; etiqueta?: string;
    onElegir?: (p: { id: number; nombre: string }) => void;
  } = $props();

  let texto = $state('');
  let resultados = $state<PacienteResumen[]>([]);
  let abierta = $state(false);
  let indice = $state(0);
  let cargando = $state(false);
  let error = $state('');
  let entrada: HTMLInputElement | undefined = $state();
  let temporizador: ReturnType<typeof setTimeout> | undefined;
  let peticion = 0;

  onMount(async () => {
    if (idInicial && !paciente) {
      try { const p = await datos(spd.obtenerPaciente(idInicial)); paciente = { id: p.id, nombre: nombreDe(p.nombre, p.apellido1, p.apellido2) }; } catch { /* se podrá elegir a mano */ }
    }
    if (enfocar && !paciente) entrada?.focus();
  });
  const nombreDe = (n: string, a1: string, a2?: string | null) => [n, a1, a2].filter(Boolean).join(' ');

  function buscar() {
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      const mi = ++peticion; cargando = true; error = '';
      try {
        const r = await datos(spd.listarPacientes({ texto: texto.trim(), estado: 'activo' }));
        if (mi !== peticion) return;
        resultados = r.slice(0, 8); indice = 0; abierta = true;
      } catch (e) { error = mensaje(e); } finally { if (mi === peticion) cargando = false; }
    }, 180);
  }
  function elegir(p: PacienteResumen) {
    paciente = { id: p.id, nombre: p.nombreCompleto }; abierta = false; texto = ''; resultados = [];
    onElegir?.(paciente);
  }
  function tecla(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!abierta) buscar(); indice = Math.min(indice + 1, resultados.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); indice = Math.max(indice - 1, 0); }
    else if (e.key === 'Enter') { if (abierta && resultados[indice]) { e.preventDefault(); elegir(resultados[indice]); } }
    else if (e.key === 'Escape') { abierta = false; }
  }
  function cambiar() { paciente = null; setTimeout(() => entrada?.focus(), 0); }
</script>

<div class="campo">
  <label for="busca-paciente">{etiqueta}</label>
  {#if paciente}
    <div class="elegido" data-prueba="paciente-elegido">
      <span class="nombre">{paciente.nombre}</span>
      <button class="btn enlace" type="button" onclick={cambiar}>Cambiar</button>
    </div>
  {:else}
    <div class="busca">
      <input id="busca-paciente" bind:this={entrada} bind:value={texto} oninput={buscar} onkeydown={tecla} onfocus={() => { if (!resultados.length) buscar(); else abierta = true; }}
        onblur={() => setTimeout(() => (abierta = false), 150)}
        placeholder="Escribe el nombre o los apellidos…" autocomplete="off" role="combobox" aria-expanded={abierta} aria-controls="busca-paciente-lista" aria-autocomplete="list" />
      {#if abierta}
        <ul id="busca-paciente-lista" role="listbox">
          {#if cargando && !resultados.length}<li class="suave">Buscando…</li>
          {:else if !resultados.length}<li class="suave">Ningún paciente activo con ese nombre.</li>{/if}
          {#each resultados as p, i (p.id)}
            <li role="option" aria-selected={i === indice} onmousedown={(e) => { e.preventDefault(); elegir(p); }}>
              <span class="negrita">{p.nombreCompleto}</span>
              {#if p.centro}<span class="suave pequeno">{p.centro}{p.habitacion ? ' · ' + p.habitacion : ''}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if error}<span class="error-texto">{error}</span>{/if}
  {/if}
</div>
