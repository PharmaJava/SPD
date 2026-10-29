<script lang="ts">
  import { untrack } from 'svelte';
  import { spd } from '../api.ts';
  import type { EstadoSistema } from '../../servicios/api.ts';
  import Campo from '../componentes/Campo.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import Icono from '../componentes/Icono.svelte';
  import { fortaleza } from '../componentes/util.ts';

  let { estado, ondesbloqueado }: { estado: EstadoSistema; ondesbloqueado: (e: EstadoSistema) => void } = $props();

  let contrasena = $state(''); let error = $state<string | null>(null); let ocupado = $state(false);
  let espera = $state(untrack(() => estado.esperaIntento));
  let modo = $state<'normal' | 'recuperar'>('normal');
  let clave = $state(''); let nueva = $state(''); let nueva2 = $state(''); let errClave = $state<string | null>(null); let errNueva = $state<string | null>(null);

  // Cuenta atrás de la espera entre intentos.
  $effect(() => {
    if (espera <= 0) return;
    const t = setInterval(() => { espera = Math.max(0, espera - 1); if (espera === 0) clearInterval(t); }, 1000);
    return () => clearInterval(t);
  });

  async function entrar() {
    if (espera > 0 || ocupado) return;
    if (!contrasena) { error = 'Escribe la contraseña de la farmacia.'; return; }
    ocupado = true; error = null;
    const r = await spd.desbloquear(contrasena);
    ocupado = false;
    if (r.ok) { contrasena = ''; ondesbloqueado(r.datos); return; }
    error = r.error; contrasena = '';
    const e = await spd.estado(); if (e.ok) espera = e.datos.esperaIntento;
  }
  async function recuperar() {
    errClave = errNueva = null;
    if (!clave.trim()) { errClave = 'Escribe la clave de recuperación que guardaste.'; return; }
    if (nueva.length < 10) { errNueva = 'La contraseña nueva debe tener al menos 10 caracteres.'; return; }
    if (nueva !== nueva2) { errNueva = 'Las dos contraseñas no coinciden.'; return; }
    ocupado = true;
    const r = await spd.recuperar(clave.trim(), nueva);
    ocupado = false;
    if (r.ok) { clave = nueva = nueva2 = ''; ondesbloqueado(r.datos); } else errClave = r.error;
  }
  const f = $derived(fortaleza(nueva));
</script>

<div class="pantalla-central">
  <div class="caja">
    <div class="logotipo"><span class="insignia">SPD</span> Gestión de dosificación</div>
    {#if modo === 'normal'}
      <div class="tarjeta apilado">
        <div><h1>Programa bloqueado</h1><p class="suave sin-margen">Escribe la contraseña de la farmacia para abrir los datos.</p></div>
        <Campo etiqueta="Contraseña de la farmacia" tipo="contrasena" bind:valor={contrasena} {error} autofocus onenter={entrar} autocomplete="current-password" disabled={espera > 0} />
        {#if espera > 0}<Aviso tipo="atencion" titulo="Espera un momento">Por seguridad, podrás volver a probar dentro de {espera} {espera === 1 ? 'segundo' : 'segundos'}.</Aviso>{/if}
        <div class="fila">
          <button class="btn enlace" onclick={() => { modo = 'recuperar'; error = null; }}>He perdido la contraseña</button>
          <span class="espacio"></span>
          <button class="btn principal grande" onclick={entrar} disabled={ocupado || espera > 0}><Icono n="bloquear" />{ocupado ? 'Abriendo…' : 'Abrir'}</button>
        </div>
      </div>
    {:else}
      <div class="tarjeta apilado">
        <div><h1>Recuperar el acceso</h1><p class="suave sin-margen">Con la clave de recuperación que imprimiste al empezar puedes poner una contraseña nueva. Tus datos no se pierden.</p></div>
        <Campo etiqueta="Clave de recuperación" tipo="area" filas={3} bind:valor={clave} error={errClave} placeholder="XXXX-XXXX-XXXX-…" autofocus />
        <Campo etiqueta="Contraseña nueva" tipo="contrasena" bind:valor={nueva} autocomplete="new-password" ayuda="Mínimo 10 caracteres.">
          {#if nueva}<div class="medidor" aria-hidden="true">{#each [1,2,3,4] as i}<span class={f.nivel >= i ? 'on-' + f.nivel : ''}></span>{/each}</div><div class="pequeno suave">Fortaleza: {f.texto}</div>{/if}
        </Campo>
        <Campo etiqueta="Repite la contraseña nueva" tipo="contrasena" bind:valor={nueva2} error={errNueva} autocomplete="new-password" onenter={recuperar} />
        <div class="fila">
          <button class="btn" onclick={() => (modo = 'normal')}>Volver</button><span class="espacio"></span>
          <button class="btn principal grande" onclick={recuperar} disabled={ocupado}>Cambiar contraseña y entrar</button>
        </div>
      </div>
    {/if}
  </div>
</div>
