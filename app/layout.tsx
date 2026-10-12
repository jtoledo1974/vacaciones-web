import type { Metadata } from "next";
import "./vacaciones.css";
export const metadata: Metadata = {
    title: "Vacaciones · Ocho equipos",
    description: "Calendarios, solicitudes y adjudicaciones de vacaciones por equipo y ejercicio.",
    icons: {
        icon: "/favicon.svg",
        shortcut: "/favicon.svg",
    },
};
export default function RootLayout({ children, }: Readonly<{
    children: React.ReactNode;
}>) {
    return (<html lang="es">
      <body className="antialiased">{children}</body>
    </html>);
}
