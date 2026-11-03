<script lang="ts">
  import { untrack } from 'svelte';
  import { spd } from '../../api.ts';
  import type { PacienteDto, CentroDto, NuevoPaciente } from '../../../servicios/api.ts';
  import Campo from '../../componentes/Campo.svelte';
  import Aviso from '../../componentes/Aviso.svelte';
  import { avisar } from '../../componentes/util.ts';
  import { TIPOS_CENTRO, ETIQUETA_TIPO_CENTRO, buscarCentroIgual, sugerirCentros } from '../../../dominio/origen-paciente.ts';
  import type { TipoCentro } from '../../../dominio/origen-paciente.ts';

  // Formulario por secciones: alta y edición de un paciente.
  let { inicial, centros, onguardado, oncancelar }: {
    inicial?: PacienteDto; centros: CentroDto[]; onguardado: (p: PacienteDto) => void; oncancelar?: () => void;
  } = $props();

  const ini = untrack(() => inicial);
  const s = (v?: string | null) => v ?? '';
  let p = $state({
    nombre: s(ini?.nombre), apellido1: s(ini?.apellido1), apellido2: s(ini?.apellido2), fechaNacimiento: s(ini?.fechaNacimiento),
    sexo: s(ini?.sexo), dniNie: s(ini?.dniNie),
    cipAutonomico: s(ini?.cipAutonomico), cipSns: s(ini?.cipSns), nass: s(ini?.nass), tsiCcaa: s(ini?.tsiCcaa), aseguradora: s(ini?.aseguradora),
    telefono: s(ini?.telefono), telefono2: s(ini?.telefono2), email: s(ini?.email), direccion: s(ini?.direccion), codigoPostal: s(ini?.codigoPostal), municipio: s(ini?.municipio),
    habitacion: s(ini?.habitacion),
    necesitaBraille: ini?.necesitaBraille ?? false, letraGrande: ini?.letraGrande ?? false, notas: s(ini?.notas),
  });
  // Origen: individual (sin centro) o procedente de un centro. El nombre se autocompleta con los centros ya creados.
  const centroIni = untrack(() => ini?.centroId != null ? centros.find(c => c.id === ini.centroId) : undefined);
  let origen = $state<'individual' | 'centro'>(ini?.centroId != null ? 'centro' : 'individual');
  let centroNombre = $state(centroIni?.nombre ?? ''); let centroTipo = $state<TipoCentro>(centroIni?.tipo ?? 'residencia_mayores');
  const elegibles = $derived(centros.filter(c => c.activo || c.id === ini?.centroId));
  const igual = $derived(origen === 'centro' ? buscarCentroIgual(elegibles, centroNombre) : undefined);
  const sugeridos = $derived(sugerirCentros(elegibles, centroNombre));
  let err = $state<Record<string, string>>({}); let ocupado = $state(false); let general = $state<string | null>(null);

  async function guardar() {
    err = {}; general = null;
    if (!p.nombre.trim()) err.nombre = 'Escribe el nombre.';
    if (!p.apellido1.trim()) err.apellido1 = 'Escribe el primer apellido.';
    if (p.fechaNacimiento && p.fechaNacimiento > new Date().toISOString().slice(0, 10)) err.fechaNacimiento = 'La fecha de nacimiento no puede ser futura.';
    if (p.email && !/^\S+@\S+\.\S+$/.test(p.email)) err.email = 'Ese correo no parece correcto.';
    if (p.codigoPostal && !/^\d{5}$/.test(p.codigoPostal)) err.codigoPostal = 'El código postal tiene 5 cifras.';
    if (origen === 'centro' && !centroNombre.trim()) err.centroNombre = 'Escribe el nombre del centro.';
    if (Object.keys(err).length) { document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return; }
    const n = (v: string) => (v.trim() ? v.trim() : null);
    ocupado = true;
    let centroId: number | null = null;
    if (origen === 'centro') {
      if (igual) centroId = igual.id;                       // el centro ya existe: se reutiliza, no se duplica
      else {
        const rc = await spd.obtenerOCrearCentro({ nombre: centroNombre.trim(), tipo: centroTipo });
        if (!rc.ok) { ocupado = false; general = rc.error; return; }
        centroId = rc.datos.centro.id;
      }
    }
    const dto: NuevoPaciente = {
      ...(inicial ? { id: inicial.id } : {}),
      nombre: p.nombre.trim(), apellido1: p.apellido1.trim(), apellido2: n(p.apellido2), fechaNacimiento: n(p.fechaNacimiento),
      sexo: (p.sexo || null) as NuevoPaciente['sexo'], dniNie: n(p.dniNie), cipAutonomico: n(p.cipAutonomico), cipSns: n(p.cipSns), nass: n(p.nass),
      tsiCcaa: n(p.tsiCcaa), aseguradora: n(p.aseguradora), direccion: n(p.direccion), codigoPostal: n(p.codigoPostal), municipio: n(p.municipio),
      telefono: n(p.telefono), telefono2: n(p.telefono2), email: n(p.email), centroId, habitacion: centroId === null ? null : n(p.habitacion),
      necesitaBraille: p.necesitaBraille, letraGrande: p.letraGrande, notas: n(p.notas),
      proximaRevision: ini?.proximaRevision ?? null,
    };
    const r = await spd.guardarPaciente(dto);
    ocupado = false;
    if (r.ok) { avisar(inicial ? 'Datos guardados.' : 'Paciente creado.'); onguardado(r.datos); } else general = r.error;
  }
</script>

<div class="apilado">
  <section class="seccion"><h2>Datos personales</h2>
    <div class="cols-3">
      <Campo etiqueta="Nombre" bind:valor={p.nombre} error={err.nombre} requerido autofocus />
      <Campo etiqueta="Primer apellido" bind:valor={p.apellido1} error={err.apellido1} requerido />
      <Campo etiqueta="Segundo apellido" bind:valor={p.apellido2} />
      <Campo etiqueta="Fecha de nacimiento" tipo="fecha" bind:valor={p.fechaNacimiento} error={err.fechaNacimiento} max={new Date().toISOString().slice(0, 10)} />
      <Campo etiqueta="Sexo" tipo="seleccion" bind:valor={p.sexo} opciones={[{ valor: '', texto: 'Sin indicar' }, { valor: 'M', texto: 'Mujer' }, { valor: 'H', texto: 'Hombre' }, { valor: 'X', texto: 'Otro' }]} />
      <Campo etiqueta="DNI / NIE" bind:valor={p.dniNie} />
    </div>
  </section>
  <section class="seccion"><h2>Tarjeta sanitaria</h2>
    <div class="cols-3">
      <Campo etiqueta="CIP autonómico" bind:valor={p.cipAutonomico} />
      <Campo etiqueta="CIP del SNS" bind:valor={p.cipSns} />
      <Campo etiqueta="Nº de afiliación (NASS)" bind:valor={p.nass} />
      <Campo etiqueta="Aportación (TSI)" bind:valor={p.tsiCcaa} />
      <Campo etiqueta="Aseguradora o mutua" bind:valor={p.aseguradora} />
    </div>
  </section>
  <section class="seccion"><h2>Contacto</h2>
    <div class="cols-3">
      <Campo etiqueta="Teléfono" bind:valor={p.telefono} inputmode="tel" />
      <Campo etiqueta="Otro teléfono" bind:valor={p.telefono2} inputmode="tel" />
      <Campo etiqueta="Correo electrónico" tipo="email" bind:valor={p.email} error={err.email} />
      <div class="col-2"><Campo etiqueta="Dirección" bind:valor={p.direccion} /></div>
      <Campo etiqueta="Código postal" bind:valor={p.codigoPostal} error={err.codigoPostal} inputmode="numeric" maxlength={5} />
      <Campo etiqueta="Municipio" bind:valor={p.municipio} />
    </div>
  </section>
  <section class="seccion"><h2>Origen del paciente</h2>
    <div class="cols-3">
      <Campo etiqueta="Procede de" tipo="seleccion" bind:valor={origen} opciones={[{ valor: 'individual', texto: 'Individual (vive en su domicilio)' }, { valor: 'centro', texto: 'Un centro (residencia, hospital…)' }]} />
      {#if origen === 'centro'}
        <Campo etiqueta="Tipo de centro" tipo="seleccion" bind:valor={centroTipo} disabled={!!igual}
          opciones={TIPOS_CENTRO.map(t => ({ valor: t, texto: ETIQUETA_TIPO_CENTRO[t] }))}
          ayuda={igual ? 'Es el tipo con el que ya está registrado ese centro.' : undefined} />
        <div class="campo">
          <label for="fp-centro">Nombre del centro<span class="req" aria-hidden="true"> *</span></label>
          <input id="fp-centro" type="text" list="fp-centros" bind:value={centroNombre} maxlength="150" autocomplete="off" class:error={!!err.centroNombre} aria-invalid={!!err.centroNombre} />
          <datalist id="fp-centros">{#each sugeridos as c (c.id)}<option value={c.nombre}>{ETIQUETA_TIPO_CENTRO[c.tipo]}</option>{/each}</datalist>
          {#if err.centroNombre}<div class="error-texto" role="alert">{err.centroNombre}</div>
          {:else if igual}<div class="ayuda">Se usará el centro ya registrado «{igual.nombre}» ({ETIQUETA_TIPO_CENTRO[igual.tipo]}).</div>
          {:else if centroNombre.trim()}<div class="ayuda">Centro nuevo: se creará al guardar.</div>{/if}
        </div>
        <Campo etiqueta="Habitación o planta" bind:valor={p.habitacion} />
      {/if}
    </div>
  </section>
  <section class="seccion"><h2>Accesibilidad</h2>
    <label class="marca"><input type="checkbox" bind:checked={p.letraGrande} />Necesita la hoja y las etiquetas en letra grande</label>
    <label class="marca"><input type="checkbox" bind:checked={p.necesitaBraille} />Necesita información en braille</label>
    <Campo etiqueta="Notas" tipo="area" bind:valor={p.notas} />
  </section>
  {#if general}<Aviso tipo="bloqueo" titulo="No se ha guardado">{general}</Aviso>{/if}
  <div class="fila fin">
    {#if oncancelar}<button class="btn" onclick={oncancelar}>Cancelar</button>{/if}
    <button class="btn principal" onclick={guardar} disabled={ocupado}>{inicial ? 'Guardar cambios' : 'Crear paciente'}</button>
  </div>
</div>
