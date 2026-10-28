/** Public, directly addressable sections of the vacations dashboard. */
export type DashboardSection =
  | 'eleccion'
  | 'antiguedad'
  | 'antiguedad-admin'
  | 'ayuda'
  | 'estadisticas'
  | 'administracion';

export const sectionPaths: Record<DashboardSection, string> = {
  eleccion: '/',
  antiguedad: '/antiguedad',
  'antiguedad-admin': '/administracion/antiguedad',
  ayuda: '/ayuda',
  estadisticas: '/estadisticas',
  administracion: '/administracion',
};

export function sectionFromPath(pathname: string): DashboardSection {
  if (pathname === '/administracion/antiguedad' || pathname === '/administracion/antiguedad/')
    return 'antiguedad-admin';
  if (pathname === '/antiguedad' || pathname === '/antiguedad/') return 'antiguedad';
  if (pathname === '/ayuda' || pathname === '/ayuda/') return 'ayuda';
  if (pathname === '/estadisticas' || pathname === '/estadisticas/') return 'estadisticas';
  if (pathname === '/administracion' || pathname === '/administracion/') return 'administracion';
  return 'eleccion';
}
