<script lang="ts">
  import { spd } from '../api.ts';
  import type { DatosFarmacia, ResultadoPrimerUso } from '../../servicios/api.ts';
  import Campo from '../componentes/Campo.svelte';
  import Aviso from '../componentes/Aviso.svelte';
  import Icono from '../componentes/Icono.svelte';
  import EditorMomentos, { type FilaMomento } from '../componentes/EditorMomentos.svelte';
  import { COMUNIDADES, copiarTexto, fortaleza, inicialesDe, avisar } from '../componentes/util.ts';

  let { onterminado }: { onterminado: (contrasena: string, pin: string) => void | Promise<void> } = $props();

  const PASOS = ['Bienvenida', 'Farmacia', 'Titular', 'Contraseña', 'Momentos', 'Clave', 'Listo'];
  let paso = $state(0);
  let ocupado = $state(false); let errorGeneral = $state<string | null>(null);

  // 0 Bienvenida
  let acepta = $state(false);
  // 1 Farmacia
  let f = $state({ nombre: '', titular: '', nif: '', direccion: '', codigoPostal: '', municipio: '', provincia: '', comunidadAutonoma: '', telefono: '', email: '', numeroAutorizacion: '' });
  // 2 Titular
  let u = $state({ nombre: '', iniciales: '', pin: '', pin2: '' });
  // 3 Contraseña
  let c = $state({ a: '', b: '' });
  // 4 Momentos
  let momentos = $state<FilaMomento[]>([
    { nombre: 'Desayuno', hora: '08:00', activo: true }, { nombre: 'Comida', hora: '14:00', activo: true },
    { nombre: 'Cena', hora: '21:00', activo: true }, { nombre: 'Acostarse', hora: '23:00', activo: true },
  ]);
  // 5 Clave
  let resultado = $state<ResultadoPrimerUso | null>(null); let qr = $state(''); let guardada = $state(false);
  let pedidos = $state<number[]>([]); let tecleados = $state<string[]>(['', '', '']); let errClave = $state<string | null>(null); let confirmada = $state(false);

  let err = $state<Record<string, string>>({});
  const fz = $derived(fortaleza(c.a));
  const grupos = $derived((resultado?.claveRecuperacion ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean).flatMap(g => g.length > 4 ? (g.match(/.{1,4}/g) ?? []) : [g]));

  function siguiente() {
    err = {}; errorGeneral = null;
    if (paso === 0) { if (!acepta) { err.acepta = 'Para continuar tienes que aceptar las condiciones.'; return; } }
    if (paso === 1) {
      if (!f.nombre.trim()) err.nombre = 'Escribe el nombre de la farmacia.';
      if (!f.titular.trim()) err.titular = 'Escribe el nombre del titular.';
      if (f.email && !/^\S+@\S+\.\S+$/.test(f.email)) err.email = 'Ese correo no parece correcto.';
      if (f.codigoPostal && !/^\d{5}$/.test(f.codigoPostal)) err.codigoPostal = 'El código postal tiene 5 cifras.';
      if (Object.keys(err).length) return;
      if (!u.nombre) { u.nombre = f.titular.trim(); if (!u.iniciales) u.iniciales = inicialesDe(u.nombre); }
    }
    if (paso === 2) {
      if (!u.nombre.trim()) err.unombre = 'Escribe tu nombre.';
      if (!u.iniciales.trim()) err.iniciales = 'Escribe tus iniciales.';
      if (!/^\d{4,8}$/.test(u.pin)) err.pin = 'El PIN son entre 4 y 8 cifras.';
      else if (u.pin !== u.pin2) err.pin2 = 'Los dos PIN no coinciden.';
      if (Object.keys(err).length) return;
    }
    if (paso === 3) {
      if (c.a.length < 10) { err.c = 'La contraseña debe tener al menos 10 caracteres.'; return; }
      if (fz.nivel < 2) { err.c = 'Es demasiado fácil de adivinar. Añade más caracteres o mezcla letras y números.'; return; }
      if (c.a !== c.b) { err.c2 = 'Las dos contraseñas no coinciden.'; return; }
    }
    if (paso === 4) { crear(); return; }
    if (paso === 5) { comprobarClave(); return; }
    paso++;
  }
  function atras() { err = {}; errorGeneral = null; if (paso > 0 && paso < 5) paso--; }

  async function crear() {
    const lista = momentos.filter(m => m.nombre.trim());
    if (!lista.length) { errorGeneral = 'Define al menos un momento de toma.'; return; }
    ocupado = true;
    const farmacia: DatosFarmacia = { nombre: f.nombre.trim(), titular: f.titular.trim() };
    for (const k of ['nif', 'direccion', 'codigoPostal', 'municipio', 'provincia', 'comunidadAutonoma', 'telefono', 'email', 'numeroAutorizacion'] as const) { if (f[k].trim()) farmacia[k] = f[k].trim(); }
    farmacia.rgpdResponsable = farmacia.nombre;
    const r = await spd.primerUso({ farmacia, titular: { nombre: u.nombre.trim(), iniciales: u.iniciales.trim().toUpperCase(), pin: u.pin }, contrasena: c.a,
      momentos: lista.map(m => ({ nombre: m.nombre.trim(), hora: m.hora || undefined })) });
    ocupado = false;
    if (!r.ok) { errorGeneral = r.error; return; }
    resultado = r.datos;
    const q = await spd.codigoSvg(r.datos.uriAutenticador, 'qrcode'); if (q.ok) qr = q.datos;
    const n = Math.max(grupos.length - 1, 3); // el último grupo puede ser corto (control)
    const pool = Array.from({ length: n }, (_, i) => i);
    pedidos = pool.sort(() => Math.random() - 0.5).slice(0, 3).sort((a, b) => a - b);
    tecleados = ['', '', '']; paso = 5;
  }
  function norm(s: string) { return s.toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function comprobarClave() {
    errClave = null;
    if (!guardada) { errClave = 'Marca que has guardado la clave en un sitio seguro.'; return; }
    const mal = pedidos.some((g, i) => norm(tecleados[i] ?? '') !== norm(grupos[g] ?? ''));
    if (mal) { errClave = 'Alguno de los grupos no coincide con la clave. Míralos con calma en tu copia guardada, no en esta pantalla.'; return; }
    confirmada = true; paso = 6;
  }
  async function copiar() { if (resultado && await copiarTexto(resultado.claveRecuperacion)) avisar('Clave copiada. Pégala en un sitio seguro y bórrala del portapapeles.', 'info'); }
  function imprimir() { window.print(); }
  async function terminar() { ocupado = true; await onterminado(c.a, u.pin); }
  const porcentaje = $derived(Math.round((paso / (PASOS.length - 1)) * 100));
</script>

<div class="pantalla-central">
  <div class="caja ancha">
    <div class="logotipo no-imprimir"><span class="insignia">SPD</span> Bienvenida a SPD</div>
    <div class="progreso no-imprimir" role="progressbar" aria-valuenow={paso + 1} aria-valuemin={1} aria-valuemax={PASOS.length} aria-label="Paso {paso + 1} de {PASOS.length}: {PASOS[paso]}">
      <div class="barra-p"><span style="width:{porcentaje}%"></span></div>
      <div class="pasos">{#each PASOS as p, i}<span class:hecho={i <= paso}>{i + 1}. {p}</span>{/each}</div>
    </div>

    <div class="tarjeta apilado">
      {#if paso === 0}
        <h1>Vamos a preparar tu programa</h1>
        <p>SPD te ayuda a organizar el <strong>sistema personalizado de dosificación</strong> de tu farmacia: pacientes, tratamientos, cajas, blísteres y documentos, con todo registrado.</p>
        <Aviso tipo="info" titulo="Es gratuito">Puedes usarlo en todos los ordenadores que necesites y copiarlo sin modificarlo.</Aviso>
        <Aviso tipo="atencion" titulo="Importante">SPD <strong>no es un producto sanitario</strong>: no decide dosis ni tratamientos. Cada preparación la comprueba y la valida un farmacéutico. La farmacia es la <strong>responsable de los datos</strong> de sus pacientes.</Aviso>
        <details>
          <summary>Leer el resumen de la licencia</summary>
          <div class="licencia">
            <p><strong>Uso gratuito.</strong> Puedes instalarlo y usarlo sin límite de equipos y redistribuirlo sin cambios y sin cobrar.</p>
            <p><strong>No se puede</strong> vender, incluir en un producto de pago, modificar ni quitar el aviso del autor.</p>
            <p><strong>Sin garantía ni soporte.</strong> Se ofrece «tal cual». Mantén tus propias copias de seguridad.</p>
            <p><strong>Responsabilidad.</strong> Verificar cada preparación, la exactitud de los datos y el cumplimiento de la normativa sanitaria y de protección de datos es responsabilidad del usuario.</p>
            <p class="suave pequeno">Este es un resumen; el texto completo está en Ajustes → Acerca de.</p>
          </div>
        </details>
        <label class="marca"><input type="checkbox" bind:checked={acepta} />He leído y acepto las condiciones de uso.</label>
        {#if err.acepta}<div class="error-texto" role="alert">{err.acepta}</div>{/if}
      {:else if paso === 1}
        <h1>Datos de la farmacia</h1><p class="suave sin-margen">Aparecerán en las etiquetas y documentos. Podrás cambiarlos en Ajustes.</p>
        <div class="cols-2">
          <Campo etiqueta="Nombre de la farmacia" bind:valor={f.nombre} error={err.nombre} requerido autofocus onenter={siguiente} />
          <Campo etiqueta="Titular (nombre y apellidos)" bind:valor={f.titular} error={err.titular} requerido onenter={siguiente} />
          <Campo etiqueta="NIF" bind:valor={f.nif} onenter={siguiente} />
          <Campo etiqueta="Número de autorización" bind:valor={f.numeroAutorizacion} onenter={siguiente} />
          <div class="col-2"><Campo etiqueta="Dirección" bind:valor={f.direccion} onenter={siguiente} /></div>
          <Campo etiqueta="Código postal" bind:valor={f.codigoPostal} error={err.codigoPostal} inputmode="numeric" maxlength={5} onenter={siguiente} />
          <Campo etiqueta="Municipio" bind:valor={f.municipio} onenter={siguiente} />
          <Campo etiqueta="Provincia" bind:valor={f.provincia} onenter={siguiente} />
          <Campo etiqueta="Comunidad autónoma" tipo="seleccion" bind:valor={f.comunidadAutonoma} opciones={[{ valor: '', texto: '— Elegir —' }, ...COMUNIDADES.map(x => ({ valor: x, texto: x }))]} />
          <Campo etiqueta="Teléfono" bind:valor={f.telefono} inputmode="tel" onenter={siguiente} />
          <Campo etiqueta="Correo electrónico" tipo="email" bind:valor={f.email} error={err.email} onenter={siguiente} />
        </div>
      {:else if paso === 2}
        <h1>Tu usuario</h1><p class="suave sin-margen">Serás el titular del programa. Cada persona de la farmacia tendrá después su propio usuario; sus iniciales salen en las etiquetas.</p>
        <div class="cols-2">
          <Campo etiqueta="Tu nombre" bind:valor={u.nombre} error={err.unombre} requerido autofocus onenter={siguiente} />
          <Campo etiqueta="Iniciales" bind:valor={u.iniciales} error={err.iniciales} requerido maxlength={4} onenter={siguiente} />
          <Campo etiqueta="PIN (4 a 8 cifras)" tipo="contrasena" bind:valor={u.pin} error={err.pin} requerido inputmode="numeric" maxlength={8} autocomplete="off" ayuda="Lo usarás cada vez que empieces a trabajar." onenter={siguiente} />
          <Campo etiqueta="Repite el PIN" tipo="contrasena" bind:valor={u.pin2} error={err.pin2} requerido inputmode="numeric" maxlength={8} autocomplete="off" onenter={siguiente} />
        </div>
      {:else if paso === 3}
        <h1>Contraseña de la farmacia</h1>
        <p class="suave sin-margen">Protege todos los datos de los pacientes: sin ella nadie puede abrirlos. Elige una frase larga que recuerdes (mínimo 10 caracteres).</p>
        <Campo etiqueta="Contraseña" tipo="contrasena" bind:valor={c.a} error={err.c} requerido autofocus autocomplete="new-password" onenter={siguiente}>
          {#if c.a}<div class="medidor" aria-hidden="true">{#each [1,2,3,4] as i}<span class={fz.nivel >= i ? 'on-' + fz.nivel : ''}></span>{/each}</div><div class="pequeno suave" aria-live="polite">Fortaleza: {fz.texto}</div>{/if}
        </Campo>
        <Campo etiqueta="Repite la contraseña" tipo="contrasena" bind:valor={c.b} error={err.c2} requerido autocomplete="new-password" onenter={siguiente} />
        <Aviso tipo="atencion" titulo="No se puede adivinar">Si la olvidas, solo podrás recuperar los datos con la clave de recuperación del paso siguiente.</Aviso>
      {:else if paso === 4}
        <h1>Momentos de toma</h1>
        <p class="suave sin-margen">Los define el farmacéutico: son las filas del blíster. Te proponemos una plantilla que puedes cambiar, ordenar o ampliar.</p>
        <EditorMomentos bind:momentos modo="inicial" />
        {#if errorGeneral}<Aviso tipo="bloqueo" titulo="No se ha podido crear">{errorGeneral}</Aviso>{/if}
      {:else if paso === 5 && resultado}
        <div class="zona-impresion">
          <h1>Clave de recuperación</h1>
          <Aviso tipo="atencion" titulo="Se muestra una sola vez">Esta clave es la <strong>única forma de recuperar los datos</strong> si olvidas la contraseña. Imprímela y guárdala fuera de este ordenador (caja fuerte, sobre cerrado). No la guardes en el mismo equipo.</Aviso>
          <div class="clave" aria-label="Clave de recuperación">{#each grupos as g, i}<span><small class="suave" style="font-size:.6rem;display:block">{i + 1}</small>{g}</span>{/each}</div>
          <div class="fila" style="margin-top:1rem; align-items:flex-start">
            {#if qr}<div class="qr" aria-label="Código QR de la clave">{@html qr}</div>{/if}
            <p class="suave pequeno" style="flex:1">El código QR contiene la misma clave por si prefieres guardarla en una aplicación de autenticación de confianza. <strong>Farmacia:</strong> {f.nombre} · {new Date().toLocaleDateString('es-ES')}</p>
          </div>
        </div>
        <div class="fila no-imprimir">
          <button class="btn" onclick={imprimir}><Icono n="imprimir" />Imprimir</button>
          <button class="btn" onclick={copiar}><Icono n="copiar" />Copiar</button>
        </div>
        <div class="no-imprimir apilado">
          <label class="marca"><input type="checkbox" bind:checked={guardada} />Ya he guardado la clave en un lugar seguro, fuera de este ordenador.</label>
          <p class="sin-margen"><strong>Comprobación:</strong> mira tu copia guardada y escribe estos grupos.</p>
          <div class="cols-3">
            {#each pedidos as g, i}<Campo etiqueta="Grupo número {g + 1}" bind:valor={tecleados[i]!} maxlength={5} autocomplete="off" onenter={siguiente} />{/each}
          </div>
          {#if errClave}<div class="error-texto" role="alert">{errClave}</div>{/if}
        </div>
      {:else if paso === 6}
        <div class="todo-al-dia">
          <div class="gran"><Icono n="check" tam={38} /></div>
          <h1>Todo listo</h1>
          <p class="suave">Tu farmacia está configurada. Lo siguiente: dar de alta a tu primer paciente.</p>
        </div>
      {/if}
    </div>

    <div class="pie-asistente no-imprimir">
      {#if paso > 0 && paso < 5}<button class="btn" onclick={atras} disabled={ocupado}><Icono n="atras" />Atrás</button>{:else}<span></span>{/if}
      {#if paso === 6}
        <button class="btn principal grande" onclick={terminar} disabled={ocupado}>{ocupado ? 'Entrando…' : 'Empezar a usar SPD'}<Icono n="flecha" /></button>
      {:else}
        <button class="btn principal grande" onclick={siguiente} disabled={ocupado}>
          {paso === 4 ? (ocupado ? 'Creando…' : 'Crear mi farmacia') : paso === 5 ? 'Comprobar y continuar' : 'Continuar'}<Icono n="flecha" />
        </button>
      {/if}
    </div>
  </div>
</div>
