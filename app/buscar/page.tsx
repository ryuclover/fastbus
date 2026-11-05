"use client";
import { BenefitTerms } from "../../components/benefit-terms";
import { TerminalFields } from "../../components/terminal-fields";
import { priceInReais } from "../../lib/money";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { cidadesSugeridas, valorCidade } from "@/lib/cidades-sugeridas";
import {
  monitorSchema,
  providerIds,
  today,
  type MonitorConfig,
} from "@/lib/monitoring/schema";
import { supportsMonitoring } from "@/lib/monitoring/capabilities";
import { api } from "@/lib/api-client";
import type { User } from "@/types/account";
import type { ManualSearch } from "@/types/manual-search";
import "../fastbus.css";
import "./search.css";

const initial = (): MonitorConfig => ({
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  startDate: today(),
  endDate: today(),
  maxPrice: 10000,
  intervalMinutes: 1440,
  benefit: "any",
  providers: ["Guanabara"],
});
const money = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dateLabel = (s: string) =>
  new Date(`${s}T12:00:00Z`).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
const cityLabel = (s: string) => s.replace("::", " / ");
const timeLabel = (n: number) =>
  new Date(n).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
const jobLabels: Record<string, string> = {
  QUEUED: "Busca na fila",
  RUNNING: "Consultando as fontes",
  SEARCH_PARTIAL: "Rodada concluída · há consultas pendentes",
  SEARCH_COMPLETE: "Consultas concluídas",
  CLOUD_BUSY: "Outra execução está em andamento. Tente continuar depois.",
  CLOUD_DAILY_LIMIT:
    "O limite gratuito de rodadas de hoje foi atingido. Continue amanhã.",
  CLOUD_FAILED: "Não foi possível iniciar a consulta. Tente continuar depois.",
  JOB_INTERRUPTED:
    "A rodada foi interrompida. Os resultados obtidos foram mantidos.",
  JOB_EXPIRED: "A rodada expirou. Você pode tentar continuar.",
  QUERY_FAILED: "A consulta foi interrompida. Tente continuar depois.",
};

export default function ManualSearchPage() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(initial);
  const [searches, setSearches] = useState<ManualSearch[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [date, setDate] = useState("");
  const [company, setCompany] = useState("");
  const [turn, setTurn] = useState("");
  const [sort, setSort] = useState("price");
  const [now, setNow] = useState(0);
  const owner = useRef<string | null>(null);
  const inFlight = useRef(false);
  const job = searches.find((s) => s.id === selected) || searches[0];
  const running = searches.some(
    (s) => s.state === "queued" || s.state === "running",
  );

  const refresh = useCallback(async () => {
    const requestedOwner = owner.current;
    if (!requestedOwner || inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await api<{ searches: ManualSearch[] }>("/api/search");
      if (owner.current !== requestedOwner) return;
      setSearches(response.searches);
    } finally {
      inFlight.current = false;
    }
  }, []);
  useEffect(() => {
    let alive = true;
    try {
      const draft = sessionStorage.getItem("fastbus-search-draft");
      if (draft) {
        const parsed = monitorSchema.safeParse(JSON.parse(draft));
        if (parsed.success) setForm(parsed.data);
        sessionStorage.removeItem("fastbus-search-draft");
      }
    } catch {
      /* A blocked storage preference must not prevent searching. */
    }
    void api<{ user: User | null }>("/api/account/me")
      .then((value) => {
        if (!alive) return;
        owner.current = value.user?.id || null;
        setUser(value.user);
        if (!value.user) setSearches([]);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      owner.current = null;
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh().catch((e) => {
        if (owner.current !== user.id) return;
        if (e.status === 401) {
          owner.current = null;
          setUser(null);
          setSearches([]);
          setSelected("");
        }
        setError(e.message);
      });
    };
    poll();
    const intervalMs = running ? 3000 : 30000;
    const timer = setInterval(poll, intervalMs);

    const onVisibility = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        poll();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [user, running, refresh]);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const pending = job?.targets.filter((t) => t.state === "pending") || [];
  const canContinue = pending.some((t) => !t.nextAt || t.nextAt <= now);
  const checked = job?.targets.filter((t) => t.state !== "pending").length || 0;
  const failed = job?.targets.filter((t) => t.state === "failed").length || 0;
  const inconclusive = job?.targets.some(
    (t) =>
      t.state === "complete" &&
      t.code !== "PROVIDER_OK" &&
      t.code !== "PROVIDER_EMPTY",
  );
  const trips = job?.trips || [];
  const companies = [...new Set(trips.map((t) => t.company))].sort();
  const dates = [...new Set(job?.targets.map((t) => t.date) || [])].sort();
  const filtered = trips
    .filter(
      (t) =>
        (!date || t.date === date) &&
        (!company || t.company === company) &&
        (!turn ||
          (/^\d{2}:\d{2}$/.test(t.departure) &&
            Math.floor(Number(t.departure.slice(0, 2)) / 6) === Number(turn))),
    )
    .sort((a, b) =>
      sort === "price"
        ? priceInReais(a) - priceInReais(b)
        : `${a.date} ${a.departure}`.localeCompare(`${b.date} ${b.departure}`),
    );
  async function submit(input: { config: MonitorConfig } | { id: string }) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/api/search", "POST", input);
      setSelected(result.id);
      setDate("");
      setCompany("");
      setTurn("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível buscar.");
    } finally {
      setBusy(false);
    }
  }
  function start(event: FormEvent) {
    event.preventDefault();
    if (!user) {
      try {
        sessionStorage.setItem("fastbus-search-draft", JSON.stringify(form));
      } catch {
        /* Login remains available without storage. */
      }
      window.location.assign("/?buscar=1");
      return;
    }
    const parsed = monitorSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    void submit({ config: parsed.data });
  }
  function saveAlert(config: MonitorConfig) {
    try {
      sessionStorage.setItem("fastbus-monitor-draft", JSON.stringify(config));
      window.location.assign("/?criar-alerta=1");
    } catch {
      setError(
        "Não foi possível transferir os critérios. Abra o painel de alertas para criar seu monitoramento.",
      );
    }
  }
  function changeBenefit(benefit: MonitorConfig["benefit"]) {
    setForm((f) => ({
      ...f,
      benefit,
      providers: f.providers.filter((p) => supportsMonitoring(p, benefit)),
    }));
  }
  return (
    <div className="fb-app">
      <header className="fb-header">
        <div className="fb-wrap fb-header-inner">
          <a className="fb-brand" href="/" aria-label="FastBus início">
            <span className="fb-brand-icon">
              <Bus size={23} />
            </span>
            <span>
              fast<span className="fb-accent">bus</span>
              <small>SUA PRÓXIMA VIAGEM, NO RADAR.</small>
            </span>
          </a>
          <a className="fb-text-button" href="/">
            <Bell size={16} /> Painel de alertas <ArrowUpRight size={15} />
          </a>
        </div>
      </header>
      <main className="fb-wrap fs-main">
        <div className="fs-heading">
          <div>
            <span className="fb-eyebrow">
              <span className="fb-dot" /> BUSQUE AGORA. ACOMPANHE DEPOIS.
            </span>
            <h1>
              Seu próximo destino,
              <br />
              <span>do seu jeito.</span>
            </h1>
            <p className="fb-muted">
              Compare viagens, ajuste os filtros e transforme sua busca em um
              alerta.
            </p>
          </div>
          <div className="fs-heading-note">
            <Search size={24} />
            <p>
              Uma viagem em mente?
              <br />
              <strong>Vamos encontrar o caminho.</strong>
            </p>
          </div>
        </div>
        <form className="fb-panel fs-form" onSubmit={start}>
          <div className="fs-section-title">
            <h2>Para onde vamos?</h2>
            <span className="fb-muted">01 / Sua viagem</span>
          </div>
          <div className="fs-fields">
            {(["origin", "destination"] as const).map((key, index) => (
              <label key={key}>
                {index ? "Destino" : "Origem"}
                <select
                  aria-label={index ? "Destino" : "Origem"}
                  value={form[key]}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      [key]: e.target.value,
                      [key === "origin"
                        ? "originTerminal"
                        : "destinationTerminal"]: undefined,
                    }))
                  }
                >
                  {cidadesSugeridas.map((c) => (
                    <option key={valorCidade(c)} value={valorCidade(c)}>
                      {cityLabel(valorCidade(c))}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {form.benefit !== "any" && <BenefitTerms />}
            <TerminalFields form={form} onChange={setForm} />
            <label>
              Data inicial
              <input
                type="date"
                required
                min={today()}
                value={form.startDate}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    startDate: e.target.value,
                    endDate:
                      f.endDate < e.target.value ? e.target.value : f.endDate,
                  }))
                }
              />
            </label>
            <label>
              Data final
              <input
                type="date"
                required
                min={form.startDate}
                max={
                  form.startDate
                    ? new Date(Date.parse(form.startDate) + 6 * 86400000)
                        .toISOString()
                        .slice(0, 10)
                    : undefined
                }
                value={form.endDate}
                onChange={(e) =>
                  setForm((f) => ({ ...f, endDate: e.target.value }))
                }
              />
            </label>
            <label>
              Benefício
              <select
                aria-label="Benefício"
                value={form.benefit}
                onChange={(e) =>
                  changeBenefit(e.target.value as MonitorConfig["benefit"])
                }
              >
                <option value="any">Todas as passagens</option>
                <option value="id100">ID Jovem · gratuidade</option>
                <option value="id50">ID Jovem · 50% de desconto</option>
              </select>
            </label>
            <label>
              Preço máximo (R$) · total informado ou cotação se o total estiver
              pendente
              <input
                type="number"
                min="0"
                max="10000"
                step="0.01"
                placeholder="Sem limite"
                value={form.maxPrice === 10000 ? "" : form.maxPrice}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    maxPrice:
                      e.target.value === "" ? 10000 : Number(e.target.value),
                  }))
                }
              />
            </label>
          </div>
          <fieldset className="fs-providers">
            <legend>Onde buscar</legend>
            {providerIds.map((p) => {
              const allowed = supportsMonitoring(p, form.benefit);
              return (
                <label key={p} className={!allowed ? "unavailable" : ""}>
                  <input
                    type="checkbox"
                    disabled={!allowed}
                    checked={form.providers.includes(p)}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        providers: e.target.checked
                          ? [...f.providers, p]
                          : f.providers.filter((v) => v !== p),
                      }))
                    }
                  />
                  {p}
                  <small>{!allowed ? "Indisponível" : ""}</small>
                </label>
              );
            })}
          </fieldset>
          <div className="fs-form-bottom">
            <p className="fb-muted">
              Até 7 dias por busca. Cada rodada consulta até 3 combinações de
              data e fonte, respeitando as pausas entre consultas.
              {process.env.NEXT_PUBLIC_FASTBUS_CLOUD_MODE === "daily" &&
                " O plano gratuito permite até 3 rodadas por dia, compartilhadas entre as contas."}
            </p>
            <button
              className="fb-primary"
              disabled={loading || busy || running}
              type="submit"
            >
              <Search size={17} />
              {loading
                ? "Carregando…"
                : !user
                  ? "Entrar para buscar"
                  : busy || running
                    ? "Buscando…"
                    : "Buscar passagens"}
            </button>
          </div>
        </form>
        {error && (
          <p className="fb-message error" role="alert">
            {error}
          </p>
        )}
        <section className="fs-results" aria-label="Resultados da busca">
          <div className="fs-section-title">
            <h2>{job ? "Sua busca" : "Um destino. Várias possibilidades."}</h2>
            {searches.length > 1 && (
              <label className="fs-history">
                Buscas recentes
                <select
                  value={job?.id}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setDate("");
                    setCompany("");
                    setTurn("");
                  }}
                >
                  {searches.map((s) => (
                    <option value={s.id} key={s.id}>
                      {cityLabel(s.config.destination)} ·{" "}
                      {dateLabel(s.config.startDate)} · {timeLabel(s.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {!job ? (
            <div className="fb-panel fs-empty">
              <div className="fb-mini-icon">
                <Bus size={26} />
              </div>
              <h3>O caminho começa aqui.</h3>
              <p className="fb-muted">
                Escolha as cidades, as datas e as fontes acima para consultar
                passagens.
              </p>
              <a className="fb-text-button" href="/">
                Prefere receber um aviso? Configure seus alertas{" "}
                <ArrowRight size={15} />
              </a>
            </div>
          ) : (
            <>
              <div className="fb-panel fs-search-status">
                <div>
                  <span className="fb-eyebrow">
                    {cityLabel(job.config.origin)} →{" "}
                    {cityLabel(job.config.destination)}
                  </span>
                  <h3 role="status">
                    {jobLabels[job.code] ||
                      "Rodada interrompida. Você pode tentar continuar."}
                  </h3>
                  <p className="fb-muted">
                    {checked} de {job.targets.length} combinações consultadas ·{" "}
                    {trips.length} passagens encontradas
                    {failed > 0 ? ` · ${failed} falha(s) de consulta` : ""}.
                    Atualizado às {timeLabel(job.updatedAt)}.
                  </p>
                </div>
                <button
                  className="fb-secondary"
                  onClick={() => saveAlert(job.config)}
                >
                  <Bell size={16} /> Criar alerta desta busca
                </button>
                {(company || turn) && (
                  <p className="fb-muted" style={{ fontSize: "0.85rem", margin: "4px 0" }}>
                    Filtros de empresa e turno são visuais da tabela e não limitam o alerta persistido.
                  </p>
                )}
                <details className="fs-coverage">
                  <summary>Ver situação das fontes e datas</summary>
                  <ul>
                    {job.targets.map((t) => (
                      <li key={`${t.provider}-${t.date}`}>
                        <strong>{t.provider}</strong> · {dateLabel(t.date)}
                        <span>
                          {t.outcome === "manual"
                            ? "Consulta manual"
                            : t.outcome === "blocked"
                              ? "Fonte bloqueada"
                              : t.outcome === "partial"
                                ? "Cobertura parcial"
                                : t.state === "failed"
                                  ? "Falha na consulta"
                                  : t.state === "complete"
                                    ? t.code === "PROVIDER_OK"
                                      ? "Consultado"
                                      : t.code === "PROVIDER_EMPTY"
                                        ? "Sem ofertas retornadas"
                                        : "Consulta inconclusiva"
                                    : t.nextAt && t.nextAt > now
                                      ? `Em pausa até ${timeLabel(t.nextAt)}`
                                      : "Pendente"}
                          {(t.code === "LOCATION_AMBIGUOUS" ||
                            t.code === "LOCATION_NOT_FOUND") &&
                            (t.provider === "ClickBus" ||
                              t.provider === "Mobifacil") && (
                              <a
                                href={
                                  t.provider === "ClickBus"
                                    ? "https://www.clickbus.com.br/"
                                    : "https://www.mobifacil.com.br/"
                                }
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {" "}
                                · Conferir localidade no site
                              </a>
                            )}
                          {t.coverage?.unsupportedConnections
                            ? ` · ${t.coverage.unsupportedConnections} conexão(ões) sem verificação integral`
                            : ""}
                          {t.coverage &&
                            ` · ${t.coverage.checked}/${t.coverage.candidates} examinadas`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
                {pending.length > 0 &&
                  job.state !== "queued" &&
                  job.state !== "running" && (
                    <div className="fs-continuation">
                      <p className="fb-muted">
                        {canContinue
                          ? "Há fontes disponíveis para a próxima rodada."
                          : "Aguarde as pausas das fontes para continuar esta busca."}{" "}
                        Cada rodada usa a cota de consultas.
                      </p>
                      <button
                        className="fb-secondary"
                        disabled={!canContinue || running || busy}
                        onClick={() => void submit({ id: job.id })}
                      >
                        Continuar busca <ArrowRight size={16} />
                      </button>
                    </div>
                  )}
              </div>
              {trips.length > 0 && (
                <>
                  <div className="fs-date-tabs">
                    <button aria-pressed={!date} onClick={() => setDate("")}>
                      Todas as datas
                    </button>
                    {dates.map((d) => (
                      <button
                        key={d}
                        aria-pressed={date === d}
                        onClick={() => setDate(d)}
                      >
                        {dateLabel(d)}
                        <small>
                          {trips.filter((t) => t.date === d).length} opções
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="fs-filters">
                    <SlidersHorizontal size={18} />
                    <label>
                      Ordenar por
                      <select
                        aria-label="Ordenar por"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="price">Menor preço</option>
                        <option value="departure">Data e horário</option>
                      </select>
                    </label>
                    <label>
                      Empresa
                      <select
                        aria-label="Empresa"
                        value={company}
                        onChange={(e) => setCompany(e.target.value)}
                      >
                        <option value="">Todas</option>
                        {companies.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Saída
                      <select
                        aria-label="Saída"
                        value={turn}
                        onChange={(e) => setTurn(e.target.value)}
                      >
                        <option value="">Qualquer horário</option>
                        <option value="0">Madrugada · 00h–06h</option>
                        <option value="1">Manhã · 06h–12h</option>
                        <option value="2">Tarde · 12h–18h</option>
                        <option value="3">Noite · 18h–24h</option>
                      </select>
                    </label>
                    <span className="fb-muted">{filtered.length} opções</span>
                  </div>
                </>
              )}
              <div className="fs-trip-list">
                {filtered.map((t) => (
                  <article className="fb-panel fs-trip" key={t.id}>
                    <div className="fs-company">
                      <strong>{t.company}</strong>
                      <span className="fb-muted">
                        {t.cabin || "Classe não informada"} · via {t.provider}
                      </span>
                      <span className="fs-date">{dateLabel(t.date)}</span>
                      {t.evidence && (
                        <small className="fb-muted">
                          Embarque:{" "}
                          {t.evidence.origin.terminal ?? "terminal a confirmar"}{" "}
                          · Desembarque:{" "}
                          {t.evidence.destination.terminal ??
                            "terminal a confirmar"}
                        </small>
                      )}
                      {t.evidence && (
                        <small className="fb-muted">
                          Consultada em{" "}
                          {new Date(t.evidence.observedAt).toLocaleString(
                            "pt-BR",
                          )}{" "}
                          ·{" "}
                          {t.evidence.expiresAt <= Date.now()
                            ? "Oferta vencida"
                            : "Confirmar disponibilidade na fonte"}
                        </small>
                      )}
                    </div>
                    <div className="fs-journey">
                      <strong>{t.departure || "—"}</strong>
                      <div>
                        <span>{t.duration || "Duração não informada"}</span>
                        <div className="fs-route-line" />
                      </div>
                      <strong>{t.arrival || "—"}</strong>
                    </div>
                    <div className="fs-price">
                      <strong>{money(priceInReais(t))}</strong>
                      {t.evidence && (
                        <small>
                          {t.evidence.totalMinor == null
                            ? "Cotação · total a confirmar"
                            : "Total informado"}
                          {t.evidence.feesMinor != null &&
                            ` · taxas informadas ${money(t.evidence.feesMinor / 100)}`}
                        </small>
                      )}
                      {t.seats > 0 && t.benefit !== "nenhuma" && (
                        <small>
                          ID Jovem ·{" "}
                          {t.benefit === "id_jovem_100"
                            ? "gratuidade"
                            : "desconto"}{" "}
                          · {t.seats} vaga(s)
                        </small>
                      )}
                      <a
                        className="fb-secondary"
                        href={t.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t.evidence?.linkScope === "trip"
                          ? "Ver viagem na fonte"
                          : "Consultar no site"}{" "}
                        <ArrowUpRight size={15} />
                      </a>
                    </div>
                  </article>
                ))}
              </div>
              {!filtered.length && (
                <div className="fb-panel fs-empty">
                  <Search size={26} />
                  <h3>
                    {trips.length
                      ? "Nenhuma opção com estes filtros."
                      : job.state === "queued" || job.state === "running"
                        ? "Sua busca está em andamento."
                        : failed || inconclusive || pending.length
                          ? "Ainda não há resultados confirmados."
                          : "Nenhuma passagem retornada para estes critérios."}
                  </h3>
                  <p className="fb-muted">
                    {trips.length
                      ? "Altere a data, a empresa ou o horário para ver mais opções."
                      : "Confira a situação de cada fonte acima. Uma consulta sem resultado não garante que não existam passagens."}
                  </p>
                </div>
              )}
              <p className="fs-footnote fb-muted">
                Preços e vagas são os retornados na consulta e podem mudar.
                Confirme as condições e a disponibilidade no site da empresa
                antes de comprar.
              </p>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
