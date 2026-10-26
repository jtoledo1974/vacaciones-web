import type { Metadata, Viewport } from 'next';
import './vacaciones.css';
export const metadata: Metadata = {
  title: 'Vacaciones · Ocho equipos',
  description: 'Calendarios, solicitudes y adjudicaciones de vacaciones por equipo y ejercicio.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Vacaciones LECS', statusBarStyle: 'default' },
  icons: {
    icon: '/favicon.svg',
    shortcut: '/favicon.svg',
    apple: '/vacaciones-icon-192.png',
  },
};
export const viewport: Viewport = { themeColor: '#142a2c' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
