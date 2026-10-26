/**
 * Build-time constants injected by Vite from Git and the compilation clock.
 * These values are never fetched from GitHub by the running application.
 */
declare const __VACACIONES_REVISION__: string;
declare const __VACACIONES_COMMIT_TIME__: string;
declare const __VACACIONES_BUILD_TIME__: string;

const formatter = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function formatted(iso: string): string {
  const date = new Date(iso);
  return iso && Number.isFinite(date.getTime()) ? formatter.format(date) : '';
}
export const buildInfo = {
  revision: __VACACIONES_REVISION__ ? __VACACIONES_REVISION__.slice(0, 10) : 'no identificada',
  buildTimestamp: __VACACIONES_BUILD_TIME__,
  buildDate: formatted(__VACACIONES_BUILD_TIME__),
  commitDate: formatted(__VACACIONES_COMMIT_TIME__),
} as const;
