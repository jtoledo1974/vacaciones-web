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
      <head>
        {/* ES3-safe: browsers too old for the app (no modules/fetch/Promise) go to the read-only version. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if(!('noModule' in document.createElement('script'))||!window.fetch||!window.Promise){location.replace('/lite'+location.search)}",
          }}
        />
      </head>
      <body className="antialiased">
        <noscript>
          <p>
            Tu navegador no ejecuta la web completa. <a href="/lite">Abre la versión sencilla de solo lectura</a>.
          </p>
        </noscript>
        {children}
      </body>
    </html>
  );
}
