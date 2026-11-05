import { Bus } from "lucide-react"

export function Header() {
  return (
    <header className="border-b border-border/70 bg-card/60 backdrop-blur-md sticky top-0 z-50 transition-all">
      <div className="container mx-auto px-4 max-w-6xl">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Branding */}
          <a href="/" className="flex items-center gap-3 group">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary via-primary/90 to-teal-400 flex items-center justify-center shadow-md shadow-primary/25 transition-transform group-hover:scale-105">
              <Bus className="w-5 h-5 text-primary-foreground" />
            </div>
            <div className="flex flex-col">
              <span className="font-extrabold text-xl tracking-tight leading-none bg-gradient-to-r from-foreground via-foreground to-foreground/80 bg-clip-text">
                Fast<span className="text-primary">Bus</span>
              </span>
              <span className="text-[11px] text-muted-foreground font-medium mt-0.5">
                Comparador Multi-Provedores & ID Jovem
              </span>
            </div>
          </a>

          {/* Status & Navigation */}
          <div className="flex items-center gap-4">
            {/* Live Providers Badge */}
            <div className="hidden sm:inline-flex items-center gap-2 px-3 py-1 rounded-full bg-secondary/80 border border-border/80 text-xs font-medium text-muted-foreground">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
              </span>
              <span>6 Provedores Integrados</span>
            </div>

            <nav className="hidden md:flex items-center gap-6 text-sm">
              <a
                href="#buscar"
                className="text-muted-foreground hover:text-primary transition-colors font-medium"
              >
                Buscar
              </a>
              <a
                href="#como-funciona"
                className="text-muted-foreground hover:text-primary transition-colors font-medium"
              >
                Como Funciona
              </a>
              <a
                href="#provedores"
                className="text-muted-foreground hover:text-primary transition-colors font-medium"
              >
                Operadoras
              </a>
            </nav>
          </div>
        </div>
      </div>
    </header>
  )
}
