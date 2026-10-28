/** Public, directly addressable sections of the vacations dashboard. */
export type DashboardSection = 'eleccion' | 'antiguedad' | 'ayuda' | 'estadisticas' | 'administracion';

export const sectionPaths: Record<DashboardSection, string> = {
  eleccion: '/',
  antiguedad: '/antiguedad',
  ayuda: '/ayuda',
  estadisticas: '/estadisticas',
  administracion: '/administracion',
};

export function sectionFromPath(pathname: string): DashboardSection {
  if (pathname === '/antiguedad' || pathname === '/antiguedad/') return 'antiguedad';
  if (pathname === '/ayuda' || pathname === '/ayuda/') return 'ayuda';
  if (pathname === '/estadisticas' || pathname === '/estadisticas/') return 'estadisticas';
  if (pathname === '/administracion' || pathname === '/administracion/') return 'administracion';
  return 'eleccion';
}
