import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FastBus — Sua próxima viagem, no radar',
  description: 'Monitore passagens de ônibus e oportunidades ID Jovem. Salve sua rota e receba avisos no seu WhatsApp.',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body className="font-sans antialiased">{children}</body></html>
}
