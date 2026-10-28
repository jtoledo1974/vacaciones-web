import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sectionFromPath, sectionPaths } from '../app/section-routes.ts';

test('las secciones tienen URL directa y la pantalla principal conserva /', () => {
  assert.deepEqual(sectionPaths, {
    eleccion: '/',
    antiguedad: '/antiguedad',
    ayuda: '/ayuda',
    estadisticas: '/estadisticas',
    administracion: '/administracion',
  });
  for (const [section, path] of Object.entries(sectionPaths)) {
    assert.equal(sectionFromPath(path), section);
    assert.equal(sectionFromPath(path.endsWith('/') ? path : path + '/'), section);
  }
  assert.equal(sectionFromPath('/'), 'eleccion');
  assert.equal(sectionFromPath('/notificaciones'), 'eleccion');
});
