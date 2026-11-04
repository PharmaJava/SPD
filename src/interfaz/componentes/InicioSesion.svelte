<script lang="ts">
  import { spd } from '../api.ts';
  import type { UsuarioPublico, EstadoSistema } from '../../servicios/api.ts';
  import Campo from './Campo.svelte';
  import Cargando from './Cargando.svelte';
  import { nombreRol, mensajeError } from './util.ts';

  let { alentrar }: { alentrar: (u: UsuarioPublico) => void } = $props();
  let usuarios = $state<UsuarioPublico[] | null>(null); let elegido = $state<UsuarioPublico | null>(null);
  let pin = $state(''); let error = $state<string | null>(null); let ocupado = $state(false); let fallo = $state<string | null>(null);

  /** Si el titular ha desactivado el PIN, basta elegir usuario. Ante la duda (no se pudo leer el ajuste) se pide el PIN. */
  let pedirPin = $state(true);
  $effect(() => { spd.obtenerAjustes().then(r => { if (r.ok) pedirPin = r.datos.pedirPin; }); });
  $effect(() => { spd.listarUsuarios().then(r => { if (r.ok) { usuarios = r.datos; if (r.datos.length === 1) elegido = r.datos[0]!; } else fallo = r.error; }); });
  async function entrar() {
    if (!elegido) return;
    if (pedirPin && !pin) { error = 'Escribe tu PIN.'; return; }
    ocupado = true; error = null;
    const r = await spd.iniciarSesion(elegido.id, pedirPin ? pin : undefined);
    ocupado = false; pin = '';
    if (r.ok) alentrar(r.datos); else error = r.error;
  }
</script>
<div class="pantalla-central"><div class="caja">
  <div class="logotipo"><span class="insignia">SPD</span> ¿Quién eres?</div>
  <div class="tarjeta apilado">
    {#if fallo}<div class="error-texto">{fallo}</div>
    {:else if !usuarios}<Cargando />
    {:else if !elegido}
      <p class="suave sin-margen">Elige tu usuario para continuar.</p>
      <div class="apilado">
        {#each usuarios as u (u.id)}
          <button class="btn grande" style="width:100%; justify-content:flex-start" onclick={() => { elegido = u; error = null; if (!pedirPin) void entrar(); }}>
            <span class="avatar">{u.iniciales}</span><span>{u.nombre}<br><span class="suave pequeno">{nombreRol(u.rol)}</span></span>
          </button>
        {/each}
      </div>
    {:else}
      <div class="fila"><span class="avatar">{elegido.iniciales}</span><div><strong>{elegido.nombre}</strong><br><span class="suave pequeno">{nombreRol(elegido.rol)}</span></div></div>
      {#if pedirPin}
        <Campo etiqueta="PIN" tipo="contrasena" bind:valor={pin} {error} autofocus onenter={entrar} inputmode="numeric" autocomplete="off" maxlength={12} />
      {:else}
        <p class="suave sin-margen">El PIN está desactivado en este programa: entras como <strong>{elegido.nombre}</strong> con un clic.</p>
        {#if error}<div class="error-texto" role="alert">{error}</div>{/if}
      {/if}
      <div class="fila">
        {#if usuarios && usuarios.length > 1}<button class="btn" onclick={() => { elegido = null; pin = ''; error = null; }}>Cambiar de usuario</button>{/if}
        <span class="espacio"></span>
        <button class="btn principal grande" onclick={entrar} disabled={ocupado}>{pedirPin ? 'Entrar' : `Entrar como ${elegido.nombre}`}</button>
      </div>
    {/if}
  </div>
</div></div>
