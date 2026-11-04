<script lang="ts">
  import { untrack } from 'svelte';
  import { spd } from '../api.ts';
  import type { EstadoSistema } from '../../servicios/api.ts';
  import Campo from '../componentes/Campo.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import Icono from '../componentes/Icono.svelte';
  import Cargando from '../componentes/Cargando.svelte';
  import { fortaleza } from '../componentes/util.ts';

  // Sin contraseña de arranque (`estado.modoAcceso === 'sistema'`) esta pantalla casi no se ve: App abre los datos con Windows.
  // Sólo aparece si Windows no puede abrirlos (otro usuario de Windows u otro equipo): entonces la salida es la clave de recuperación.
  let { estado, ondesbloqueado, abriendoSistema = false, errorSistema = null, reintentar }: {
    estado: EstadoSistema; ondesbloqueado: (e: EstadoSistema) => void; abriendoSistema?: boolean; errorSistema?: string | null; reintentar?: () => void;
  } = $props();
  const sinContrasena = $derived(estado.modoAcceso === 'sistema');

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
    // Sin contraseña de arranque la nueva es opcional: vacía = los datos se vuelven a ligar a tu usuario de Windows.
    const conNueva = !sinContrasena || nueva !== '' || nueva2 !== '';
    if (conNueva && nueva.length < 10) { errNueva = 'La contraseña nueva debe tener al menos 10 caracteres.'; return; }
    if (conNueva && nueva !== nueva2) { errNueva = 'Las dos contraseñas no coinciden.'; return; }
    ocupado = true;
    const r = await spd.recuperar(clave.trim(), conNueva ? nueva : undefined);
    ocupado = false;
    if (r.ok) { clave = nueva = nueva2 = ''; ondesbloqueado(r.datos); } else errClave = r.error;
  }
  const f = $derived(fortaleza(nueva));
</script>

<div class="pantalla-central">
  <div class="caja">
    <div class="logotipo"><span class="insignia">SPD</span> Gestión de dosificación</div>
    {#if sinContrasena && modo === 'normal'}
      <div class="tarjeta apilado">
        {#if abriendoSistema || !errorSistema}
          <Cargando texto="Abriendo los datos…" />
        {:else}
          <div><h1>No se pueden abrir los datos</h1></div>
          <Aviso tipo="bloqueo" titulo="Windows no ha abierto los datos">{errorSistema}</Aviso>
          <p class="suave sin-margen">Estos datos se abren sin contraseña, con tu usuario de Windows. Si es el usuario de siempre, prueba de nuevo. Si has cambiado de equipo o de usuario de Windows, usa la clave de recuperación.</p>
          <div class="fila">
            <button class="btn" onclick={() => reintentar?.()}>Reintentar</button>
            <span class="espacio"></span>
            <button class="btn principal" onclick={() => { modo = 'recuperar'; error = null; }}>Usar la clave de recuperación</button>
          </div>
        {/if}
      </div>
    {:else if modo === 'normal'}
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
        <Campo etiqueta={sinContrasena ? 'Contraseña nueva (opcional)' : 'Contraseña nueva'} tipo="contrasena" bind:valor={nueva} autocomplete="new-password" ayuda={sinContrasena ? 'Si la dejas vacía, los datos se vuelven a ligar a tu usuario de Windows, sin contraseña de arranque. Si la escribes (mínimo 10 caracteres), se abrirán con ella.' : 'Mínimo 10 caracteres.'}>
          {#if nueva}<div class="medidor" aria-hidden="true">{#each [1,2,3,4] as i}<span class={f.nivel >= i ? 'on-' + f.nivel : ''}></span>{/each}</div><div class="pequeno suave">Fortaleza: {f.texto}</div>{/if}
        </Campo>
        <Campo etiqueta="Repite la contraseña nueva" tipo="contrasena" bind:valor={nueva2} error={errNueva} autocomplete="new-password" onenter={recuperar} />
        <div class="fila">
          <button class="btn" onclick={() => (modo = 'normal')}>Volver</button><span class="espacio"></span>
          <button class="btn principal grande" onclick={recuperar} disabled={ocupado}>{sinContrasena && !nueva ? 'Recuperar el acceso y entrar' : 'Cambiar contraseña y entrar'}</button>
        </div>
      </div>
    {/if}
  </div>
</div>
