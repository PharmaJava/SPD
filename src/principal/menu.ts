/**
 * Plantilla del menú de la aplicación (en español, mínimo). Pura: recibe las acciones; main.ts las conecta.
 * Sin herramientas de desarrollo en la versión instalada (datos de salud: no se deja abrir la consola).
 */
import type { MenuItemConstructorOptions } from 'electron';

export interface AccionesMenu { bloquear(): void; copiaSeguridad(): void; acercaDe(): void; salir(): void }

export function plantillaMenu(a: AccionesMenu, opciones: { desarrollo: boolean }): MenuItemConstructorOptions[] {
  const ver: MenuItemConstructorOptions[] = [
    { label: 'Acercar', role: 'zoomIn', accelerator: 'CommandOrControl+Plus' },
    { label: 'Alejar', role: 'zoomOut' },
    { label: 'Tamaño normal', role: 'resetZoom' },
    { type: 'separator' },
    { label: 'Pantalla completa', role: 'togglefullscreen' },
  ];
  if (opciones.desarrollo) ver.push({ type: 'separator' }, { label: 'Herramientas de desarrollo', role: 'toggleDevTools' });
  return [
    {
      label: 'Archivo',
      submenu: [
        { label: 'Bloquear', accelerator: 'CommandOrControl+L', click: () => a.bloquear() },
        { label: 'Copia de seguridad…', click: () => a.copiaSeguridad() },
        { type: 'separator' },
        { label: 'Salir', accelerator: 'Alt+F4', click: () => a.salir() },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { label: 'Deshacer', role: 'undo' }, { label: 'Rehacer', role: 'redo' }, { type: 'separator' },
        { label: 'Cortar', role: 'cut' }, { label: 'Copiar', role: 'copy' }, { label: 'Pegar', role: 'paste' }, { label: 'Seleccionar todo', role: 'selectAll' },
      ],
    },
    { label: 'Ver', submenu: ver },
    { label: 'Ayuda', submenu: [{ label: 'Acerca de SPD', click: () => a.acercaDe() }] },
  ];
}

/** Texto del cuadro «Acerca de»: siempre dice que NO es un producto sanitario. */
export function textoAcercaDe(version: string): { titulo: string; mensaje: string; detalle: string } {
  return {
    titulo: 'Acerca de SPD',
    mensaje: `SPD ${version}`,
    detalle: [
      'Gestión de Sistemas Personalizados de Dosificación para oficinas de farmacia.',
      '',
      'Este programa NO es un producto sanitario: es una herramienta de registro, organización e impresión. No decide dosis ni tratamientos y no sustituye el criterio del farmacéutico ni la ficha técnica. La farmacia es responsable de verificar cada preparación y de los datos de sus pacientes.',
      '',
      'Se distribuye sin garantía y bajo la licencia de uso incluida con el programa (pulsa «Ver licencia»).',
    ].join('\n'),
  };
}
