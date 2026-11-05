import { Bus, ExternalLink, ShieldCheck, Sparkles } from "lucide-react"

const provedoresIntegrados = [
  {
    nome: "ClickBus",
    tipo: "Agregador Nacional",
    desc: "Cobre mais de 200 viações (Catarinense, Cometa, 1001, Águia Branca e outras)",
    url: "https://www.clickbus.com.br",
    status: "Verificação dinâmica",
  },
  {
    nome: "Buser",
    tipo: "Fretamento Colaborativo",
    desc: "Melhores tarifas low-cost para trechos populares e capitais",
    url: "https://www.buser.com.br",
    status: "Verificação dinâmica",
  },
  {
    nome: "Guanabara",
    tipo: "Viação Interestadual",
    desc: "Linhas interestaduais com suporte oficial a ID Jovem",
    url: "https://viajeguanabara.com.br",
    status: "Verificação dinâmica",
  },
  {
    nome: "Gontijo",
    tipo: "Viação Interestadual",
    desc: "Frota que conecta MG, SP, RJ e todo o Nordeste brasileiro com formulário JVVN",
    url: "https://www.gontijo.com.br/gratuidade",
    status: "Verificação dinâmica",
  },
  {
    nome: "Embarca.ai",
    tipo: "Plataforma de Linhas Regulares",
    desc: "Parcerias de transporte no Sul e Sudeste (Garcia, Brasil Sul, Santo Anjo) com canal de benefícios",
    url: "https://www.embarca.ai",
    status: "Verificação dinâmica",
  },
]

export function Footer() {
  return (
    <footer id="provedores" className="border-t border-border/80 bg-card/60 backdrop-blur-sm py-12 mt-16">
      <div className="container mx-auto px-4 max-w-6xl">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8 mb-10">
          {/* Coluna 1: Sobre */}
          <div className="md:col-span-4 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-teal-400 flex items-center justify-center shadow-md shadow-primary/20">
                <Bus className="w-5 h-5 text-primary-foreground" />
              </div>
              <span className="font-extrabold text-xl tracking-tight">FastBus</span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              O agregador inteligente que compara preços, horários e vagas de <strong className="text-foreground font-semibold">ID Jovem (100% e 50%)</strong> em múltiplos provedores ao mesmo tempo ao longo de todo o período da sua viagem.
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Conforme Decreto Federal nº 8.537/2015 (ID Jovem)</span>
            </div>
          </div>

          {/* Coluna 2: Provedores Integrados */}
          <div className="md:col-span-8">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-4 h-4 text-primary" />
              <h4 className="font-semibold text-foreground text-sm tracking-wide uppercase">
                Provedores e Fontes Consultadas
              </h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {provedoresIntegrados.map((prov) => (
                <a
                  key={prov.nome}
                  href={prov.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group p-3 rounded-xl border border-border/60 bg-secondary/40 hover:bg-secondary/80 hover:border-primary/40 transition-all flex flex-col justify-between"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold text-sm text-foreground group-hover:text-primary transition-colors flex items-center gap-1.5">
                      {prov.nome}
                      <ExternalLink className="w-3 h-3 opacity-60 group-hover:opacity-100 transition-opacity" />
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-300 font-medium border border-sky-500/20">
                      {prov.status}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {prov.desc}
                  </p>
                </a>
              ))}
            </div>
          </div>
        </div>

        {/* Rodapé inferior com aviso legal */}
        <div className="border-t border-border/50 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <p>
            FastBus é uma ferramenta independente de consulta pública. As reservas e compras são concluídas diretamente nos canais oficiais das viações.
          </p>
          <p className="shrink-0">
            © {new Date().getFullYear()} FastBus. Todos os direitos reservados.
          </p>
        </div>
      </div>
    </footer>
  )
}
