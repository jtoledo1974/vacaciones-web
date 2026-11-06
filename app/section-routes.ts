/** Public, directly addressable sections of the vacations dashboard. */
export type DashboardSection =
  | 'eleccion'
  | 'antiguedad'
  | 'antiguedad-admin'
  | 'ayuda'
  | 'estadisticas'
  | 'administracion'
  | 'resumen-anual';

export const sectionPaths: Record<DashboardSection, string> = {
  eleccion: '/',
  antiguedad: '/antiguedad',
  'antiguedad-admin': '/administracion/antiguedad',
  ayuda: '/ayuda',
  estadisticas: '/estadisticas',
  administracion: '/administracion',
  'resumen-anual': '/administracion/resumen',
};

export function sectionFromPath(pathname: string): DashboardSection {
  if (pathname === '/administracion/antiguedad' || pathname === '/administracion/antiguedad/')
    return 'antiguedad-admin';
  if (pathname === '/administracion/resumen' || pathname === '/administracion/resumen/') return 'resumen-anual';
  if (pathname === '/antiguedad' || pathname === '/antiguedad/') return 'antiguedad';
  if (pathname === '/ayuda' || pathname === '/ayuda/') return 'ayuda';
  if (pathname === '/estadisticas' || pathname === '/estadisticas/') return 'estadisticas';
  if (pathname === '/administracion' || pathname === '/administracion/') return 'administracion';
  return 'eleccion';
}
