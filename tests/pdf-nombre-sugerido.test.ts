import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nombrePdfSugerido } from '../src/interfaz/pantallas/preparacion/util.ts';
import { argumentosPdf } from '../src/principal/impresion.ts';

const f = new Date(2026, 10, 4);

test('nombre sugerido del PDF: apellidos y fecha, sin nombre de pila ni DNI', () => {
  assert.equal(nombrePdfSugerido('etiqueta', 'Ana García López', f), 'etiqueta-garcia-lopez-2026-11-04.pdf');
  assert.equal(nombrePdfSugerido('hoja-paciente', 'Pérez Ruiz, José', f), 'hoja-paciente-perez-ruiz-2026-11-04.pdf');
  assert.equal(nombrePdfSugerido('etiqueta', 'Cher', f), 'etiqueta-cher-2026-11-04.pdf');
  assert.equal(nombrePdfSugerido('hoja-de-trabajo', undefined, f), 'hoja-de-trabajo-2026-11-04.pdf');
});

test('el PDF respeta el tamaño pedido (etiqueta) y cae a A4 sin tamaño', () => {
  const e = argumentosPdf({ anchoMm: 60, altoMm: 40 });
  assert.equal(e.preferCSSPageSize, true);
  assert.ok(Math.abs((e.pageSize as { width: number }).width - 60 / 25.4) < 1e-9);
  assert.equal(argumentosPdf(undefined).pageSize, 'A4');
});
