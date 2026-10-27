/** Public, directly addressable sections of the vacations dashboard. */
export type DashboardSection = 'eleccion' | 'ayuda' | 'estadisticas' | 'administracion';

export const sectionPaths: Record<DashboardSection, string> = {
  eleccion: '/',
  ayuda: '/ayuda',
  estadisticas: '/estadisticas',
  administracion: '/administracion',
};

export function sectionFromPath(pathname: string): DashboardSection {
  if (pathname === '/ayuda' || pathname === '/ayuda/') return 'ayuda';
  if (pathname === '/estadisticas' || pathname === '/estadisticas/') return 'estadisticas';
  if (pathname === '/administracion' || pathname === '/administracion/') return 'administracion';
  return 'eleccion';
}
