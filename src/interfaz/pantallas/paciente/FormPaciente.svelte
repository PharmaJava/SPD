<script lang="ts">
  import { untrack } from 'svelte';
  import { spd } from '../../api.ts';
  import type { PacienteDto, CentroDto, NuevoPaciente } from '../../../servicios/api.ts';
  import Campo from '../../componentes/Campo.svelte';
  import Aviso from '../../componentes/Aviso.svelte';
  import { avisar } from '../../componentes/util.ts';

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
    centroId: ini?.centroId != null ? String(ini.centroId) : '', habitacion: s(ini?.habitacion),
    necesitaBraille: ini?.necesitaBraille ?? false, letraGrande: ini?.letraGrande ?? false, notas: s(ini?.notas),
  });
  let err = $state<Record<string, string>>({}); let ocupado = $state(false); let general = $state<string | null>(null);

  async function guardar() {
    err = {}; general = null;
    if (!p.nombre.trim()) err.nombre = 'Escribe el nombre.';
    if (!p.apellido1.trim()) err.apellido1 = 'Escribe el primer apellido.';
    if (p.fechaNacimiento && p.fechaNacimiento > new Date().toISOString().slice(0, 10)) err.fechaNacimiento = 'La fecha de nacimiento no puede ser futura.';
    if (p.email && !/^\S+@\S+\.\S+$/.test(p.email)) err.email = 'Ese correo no parece correcto.';
    if (p.codigoPostal && !/^\d{5}$/.test(p.codigoPostal)) err.codigoPostal = 'El código postal tiene 5 cifras.';
    if (Object.keys(err).length) { document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); return; }
    const n = (v: string) => (v.trim() ? v.trim() : null);
    const dto: NuevoPaciente = {
      ...(inicial ? { id: inicial.id } : {}),
      nombre: p.nombre.trim(), apellido1: p.apellido1.trim(), apellido2: n(p.apellido2), fechaNacimiento: n(p.fechaNacimiento),
      sexo: (p.sexo || null) as NuevoPaciente['sexo'], dniNie: n(p.dniNie), cipAutonomico: n(p.cipAutonomico), cipSns: n(p.cipSns), nass: n(p.nass),
      tsiCcaa: n(p.tsiCcaa), aseguradora: n(p.aseguradora), direccion: n(p.direccion), codigoPostal: n(p.codigoPostal), municipio: n(p.municipio),
      telefono: n(p.telefono), telefono2: n(p.telefono2), email: n(p.email), centroId: p.centroId ? Number(p.centroId) : null, habitacion: n(p.habitacion),
      necesitaBraille: p.necesitaBraille, letraGrande: p.letraGrande, notas: n(p.notas),
      proximaRevision: ini?.proximaRevision ?? null,
    };
    ocupado = true;
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
  <section class="seccion"><h2>Centro o residencia</h2>
    <div class="cols-3">
      <Campo etiqueta="Centro" tipo="seleccion" bind:valor={p.centroId} opciones={[{ valor: '', texto: 'Vive en su domicilio' }, ...centros.map(c => ({ valor: String(c.id), texto: c.nombre }))]} />
      <Campo etiqueta="Habitación o planta" bind:valor={p.habitacion} />
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
