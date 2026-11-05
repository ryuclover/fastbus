"use client";
import { BenefitTerms } from "../components/benefit-terms";
import { TerminalFields } from "../components/terminal-fields";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Bus,
  Bell,
  ArrowRight,
  ShieldCheck,
  LogOut,
  Plus,
  Pause,
  Play,
  Trash2,
  Clock3,
  RefreshCw,
  ArrowUpRight,
  Settings,
  Radio,
  Pencil,
} from "lucide-react";
import { cidadesSugeridas, valorCidade } from "@/lib/cidades-sugeridas";
import {
  providerIds,
  monitorSchema,
  today,
  type MonitorConfig,
} from "@/lib/monitoring/schema";
import type { AlertPayload } from "@/lib/monitoring/engine";
import {
  NotificationContact,
  type ContactStatus,
} from "@/components/notification-contact";
import "./fastbus.css";
import { api } from "@/lib/api-client";
import type { User } from "@/types/account";
import { supportsMonitoring } from "@/lib/monitoring/capabilities";
import { AccountRecovery } from "@/components/account-recovery";

type Monitor = MonitorConfig & {
  id: string;
  active: boolean;
  status: string;
  nextAt: number;
  checkedAt: number | null;
  lastSuccessAt?: number | null;
  lastError?: string | null;
  coverageChecked?: number;
  coverageTotal?: number;
};
type Alert = AlertPayload & { id: string; status: string; createdAt: number };
const money = (value: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    value,
  );
const dateTime = (value: number) =>
  new Date(value).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
const cityLabel = (value: string) => value.replace("::", " / ");
const dailyCloud = process.env.NEXT_PUBLIC_FASTBUS_CLOUD_MODE === "daily";
const emptyForm = (): MonitorConfig => ({
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  startDate: today(),
  endDate: today(),
  maxPrice: 150,
  intervalMinutes: dailyCloud ? 1440 : 60,
  benefit: "any",
  providers: ["Guanabara"],
});
const alertLabels: Record<string, string> = {
  pending: "Na fila de envio",
  sent: "Enviado no WhatsApp",
  in_flight: "Envio em andamento",
  uncertain: "Envio sem confirmação. Confira o WhatsApp.",
  failed: "Falha no envio",
  expired: "Oportunidade expirada",
  cancelled: "Cancelado",
};

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [wa, setWa] = useState<ContactStatus>({
    phone: "",
    enabled: false,
    senderReady: false,
    workerOnline: false,
  });
  const [tab, setTab] = useState<"monitors" | "alerts" | "account">("monitors");
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<MonitorConfig>(emptyForm);
  const owner = useRef<string | null>(null);
  owner.current = user?.id || null;
  const clearAccount = useCallback(() => {
    owner.current = null;
    setUser(null);
    setMonitors([]);
    setAlerts([]);
    setWa({
      phone: "",
      enabled: false,
      senderReady: false,
      workerOnline: false,
    });
    setTab("monitors");
    setShowForm(false);
    setEditing(null);
    setForm(emptyForm());
  }, []);
  const loadDashboard = useCallback(async () => {
    const requestedOwner = owner.current;
    if (!requestedOwner) return;
    const [m, a, w] = await Promise.all([
      api<{ monitors: Monitor[] }>("/api/monitors"),
      api<{ alerts: Alert[] }>("/api/alerts"),
      api<ContactStatus>("/api/whatsapp"),
    ]);
    // Ignore an old account's polling response after logout or account switching.
    if (owner.current !== requestedOwner) return;
    setMonitors(m.monitors);
    setAlerts(a.alerts);
    setWa(w);
  }, []);
  useEffect(() => {
    void api<{ user: User | null }>("/api/account/me")
      .then((value) => {
        setUser(value.user);
        if (value.user?.mustChangePassword) {
          setTab("account");
          setNotice(
            "Troque sua senha inicial para liberar o acesso administrativo.",
          );
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user) return;
    if (
      !user.mustChangePassword &&
      new URLSearchParams(window.location.search).has("buscar")
    ) {
      window.location.assign("/buscar");
      return;
    }
    if (
      !user.mustChangePassword &&
      new URLSearchParams(window.location.search).has("criar-alerta")
    ) {
      try {
        const raw = sessionStorage.getItem("fastbus-monitor-draft");
        const parsed = raw && monitorSchema.safeParse(JSON.parse(raw));
        if (parsed && parsed.success) {
          setForm(parsed.data);
          setEditing(null);
          setShowForm(true);
          setTab("monitors");
          setNotice(
            "Revise os critérios da sua busca e salve para criar o alerta.",
          );
          sessionStorage.removeItem("fastbus-monitor-draft");
          window.history.replaceState(null, "", "/");
        } else if (raw) {
          sessionStorage.removeItem("fastbus-monitor-draft");
          setError(
            "Os critérios da busca expiraram. Atualize as datas para criar um alerta.",
          );
        }
      } catch {
        setError("Não foi possível recuperar os critérios da busca.");
      }
    }
  }, [user]);
  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      void loadDashboard().catch((e) => {
        if (owner.current !== user.id) return;
        if (e.status === 401) clearAccount();
        setError(e.message);
      });
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [user, loadDashboard, clearAccount]);
  async function perform(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha na operação.");
    } finally {
      setBusy(false);
    }
  }
  function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void perform(async () => {
      await api(`/api/account/${authMode}`, "POST", {
        email: data.get("email"),
        password: data.get("password"),
        ...(authMode === "register" ? { name: data.get("name") } : {}),
      });
      const result = await api<{ user: User }>("/api/account/me");
      setUser(result.user);
      if (result.user.mustChangePassword) {
        setTab("account");
        setNotice(
          "Troque sua senha inicial para liberar o acesso administrativo.",
        );
      }
    });
  }
  function saveMonitor(event: FormEvent) {
    event.preventDefault();
    void perform(async () => {
      await api(
        editing ? `/api/monitors/${editing}` : "/api/monitors",
        editing ? "PUT" : "POST",
        form,
      );
      setShowForm(false);
      setEditing(null);
      setForm(emptyForm());
      await loadDashboard();
      setNotice(
        dailyCloud
          ? "Monitoramento salvo. A execução diária verifica uma combinação de rota, data e fonte por vez, alternando entre as rotas salvas."
          : "Monitoramento salvo. As consultas continuam com o worker em execução, mesmo com esta página fechada.",
      );
    });
  }
  const logout = () =>
    perform(async () => {
      await api("/api/account/logout", "POST");
      clearAccount();
    });
  const brand = (
    <a className="fb-brand" href="/" aria-label="FastBus início">
      <span className="fb-brand-icon">
        <Bus size={23} />
      </span>
      <span>
        fast<span className="fb-accent">bus</span>
        <small>SUA PRÓXIMA VIAGEM, NO RADAR.</small>
      </span>
    </a>
  );

  return (
    <div className="fb-app">
      <header className="fb-header">
        <div className="fb-wrap fb-header-inner">
          {brand}
          <div className="fb-header-right">
            <a className="fb-text-button" href="/buscar">
              Buscar passagens
            </a>
            {user?.role === "admin" && (
              <a className="fb-text-button" href="/admin">
                Administração
              </a>
            )}
            <span className="fb-security">
              <ShieldCheck size={15} /> Conta protegida
            </span>
            {user && (
              <button
                className="fb-icon-button"
                aria-label="Sair da conta"
                onClick={() => void logout()}
                disabled={busy}
              >
                <LogOut size={19} />
              </button>
            )}
          </div>
        </div>
      </header>
      {loading ? (
        <main className="fb-wrap fb-loading" role="status">
          Carregando sua conta…
        </main>
      ) : !user ? (
        <main className="fb-wrap fb-auth-layout">
          <section className="fb-pitch">
            <span className="fb-eyebrow">
              <span className="fb-dot" /> SUA VIAGEM COMEÇA COM UM AVISO
            </span>
            <h1>
              Você escolhe
              <br />o destino.
              <br />
              <span>
                A gente fica
                <br />
                de olho.
              </span>
            </h1>
            <p>
              Conte para onde quer ir e quanto quer pagar. O FastBus acompanha
              as passagens com calma e avisa no seu WhatsApp quando encontrar
              uma oportunidade.
            </p>
            <div className="fb-steps">
              <span>
                <span>01</span> Salve sua rota
              </span>
              <ArrowRight size={16} />
              <span>
                <span>02</span> Informe seu WhatsApp
              </span>
              <ArrowRight size={16} />
              <span>
                <span>03</span> Receba o aviso
              </span>
            </div>
            <a
              className="fb-primary"
              style={{ marginBottom: 26 }}
              href="/buscar"
            >
              Buscar passagens agora <ArrowRight size={16} />
            </a>
            <div className="fb-benefit">
              <Bell size={19} />
              <div>
                <strong>Menos buscas. Mais possibilidades.</strong>
                <p>Alertas de preço e ID Jovem, com os seus critérios.</p>
              </div>
            </div>
          </section>
          <section className="fb-panel fb-auth">
            <div className="fb-mini-icon">
              <ShieldCheck size={23} />
            </div>
            <h2>
              {authMode === "login"
                ? "Seu próximo destino está aqui."
                : "Comece a acompanhar sua viagem."}
            </h2>
            <p className="fb-muted">
              {authMode === "login"
                ? "Entre para cuidar dos seus monitoramentos."
                : "Salvamos somente o necessário para sua conta e seus alertas."}
            </p>
            <div className="fb-auth-tabs">
              <button
                className={authMode === "login" ? "selected" : ""}
                onClick={() => {
                  setAuthMode("login");
                  setError("");
                }}
              >
                Entrar
              </button>
              <button
                className={authMode === "register" ? "selected" : ""}
                onClick={() => {
                  setAuthMode("register");
                  setError("");
                }}
              >
                Criar conta
              </button>
            </div>
            {notice && (
              <p className="fb-message success" role="status">
                {notice}
              </p>
            )}
            <form onSubmit={authenticate}>
              {authMode === "register" && (
                <label>
                  Como podemos te chamar?
                  <input
                    name="name"
                    autoComplete="name"
                    minLength={2}
                    maxLength={80}
                    required
                    placeholder="Seu nome"
                  />
                </label>
              )}
              <label>
                E-mail
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  placeholder="voce@exemplo.com"
                />
              </label>
              <label>
                Senha
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    authMode === "register"
                      ? "new-password"
                      : "current-password"
                  }
                  minLength={12}
                  maxLength={128}
                  required
                  placeholder="Pelo menos 12 caracteres"
                />
              </label>
              {error && (
                <p className="fb-message error" role="alert">
                  {error}
                </p>
              )}
              <button className="fb-primary" disabled={busy}>
                {busy
                  ? "Aguarde…"
                  : authMode === "login"
                    ? "Entrar no FastBus"
                    : "Criar minha conta"}
                <ArrowRight size={18} />
              </button>
            </form>
            <p className="fb-fine">
              <ShieldCheck size={14} /> Você não precisa informar CPF,
              documentos ou dados bancários.
            </p>
            <AccountRecovery />
          </section>
        </main>
      ) : (
        <main className="fb-wrap fb-dashboard">
          <section className="fb-welcome">
            <div>
              <span className="fb-eyebrow">SEU PAINEL DE VIAGENS</span>
              <h1>
                Olá, {user.name.split(" ")[0]}. <span>Para onde vamos?</span>
              </h1>
              <p className="fb-muted">
                Sua próxima oportunidade pode aparecer enquanto você faz outras
                coisas.
              </p>
            </div>
            <button
              className="fb-primary"
              onClick={() => {
                setTab("monitors");
                setEditing(null);
                setForm(emptyForm());
                setShowForm(true);
              }}
            >
              <Plus size={18} /> Novo monitoramento
            </button>
          </section>
          {error && (
            <p className="fb-message error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="fb-message success" role="status">
              {notice}
            </p>
          )}
          <section className="fb-stats">
            <div>
              <span className="fb-mini-icon">
                <Radio size={20} />
              </span>
              <span>
                <strong>{monitors.filter((m) => m.active).length}</strong>
                <small>Rotas no radar</small>
              </span>
            </div>
            <div>
              <span className="fb-mini-icon">
                <Bell size={20} />
              </span>
              <span>
                <strong>{alerts.length}</strong>
                <small>Oportunidades recentes</small>
              </span>
            </div>
            <div>
              <span
                className={`fb-mini-icon ${wa.workerOnline ? "" : "muted"}`}
              >
                <Clock3 size={20} />
              </span>
              <span>
                <strong className="fb-stat-word">
                  {wa.workerOnline
                    ? "Em execução"
                    : dailyCloud
                      ? "Diário"
                      : "Offline"}
                </strong>
                <small>Processo de monitoramento</small>
              </span>
            </div>
          </section>
          {dailyCloud && (
            <div className="fb-message" role="status">
              Plano gratuito: uma execução diária, com uma combinação de rota,
              data e fonte por vez. As rotas se alternam entre execuções. Avisos
              são enviados após a consulta, se o WhatsApp estiver pareado. O
              serviço pausa ao atingir as cotas gratuitas.
            </div>
          )}
          {!dailyCloud && !wa.workerOnline && (
            <div className="fb-message warning" role="status">
              O processo de monitoramento está desligado. Suas rotas estão
              salvas; novas consultas e envios começam quando o worker for
              iniciado.
            </div>
          )}
          <div className="fb-content">
            <section className="fb-main-column">
              <nav className="fb-tabs" aria-label="Seções do painel">
                <button
                  className={tab === "monitors" ? "selected" : ""}
                  onClick={() => setTab("monitors")}
                >
                  <Radio size={16} /> Monitoramentos
                </button>
                <button
                  className={tab === "alerts" ? "selected" : ""}
                  onClick={() => setTab("alerts")}
                >
                  <Bell size={16} /> Alertas
                </button>
                <button
                  className={tab === "account" ? "selected" : ""}
                  onClick={() => setTab("account")}
                >
                  <Settings size={16} /> Conta
                </button>
              </nav>
              {tab === "monitors" && (
                <>
                  {showForm && (
                    <section className="fb-panel fb-create">
                      <div className="fb-section-head">
                        <h2>
                          {editing
                            ? "Editar monitoramento"
                            : "Coloque uma rota no radar"}
                        </h2>
                        <button
                          className="fb-text-button"
                          onClick={() => {
                            setShowForm(false);
                            setEditing(null);
                          }}
                        >
                          Cancelar
                        </button>
                      </div>
                      <p className="fb-muted">
                        Uma fonte e uma data por consulta. As combinações são
                        consultadas em rodízio.
                      </p>
                      <form onSubmit={saveMonitor}>
                        <div className="fb-form-grid">
                          <label>
                            Origem
                            <select
                              value={form.origin}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  origin: e.target.value,
                                  originTerminal: undefined,
                                })
                              }
                            >
                              {cidadesSugeridas.map((city) => (
                                <option
                                  key={valorCidade(city)}
                                  value={valorCidade(city)}
                                >
                                  {city.nome} / {city.uf}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Destino
                            <select
                              value={form.destination}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  destination: e.target.value,
                                  destinationTerminal: undefined,
                                })
                              }
                            >
                              {cidadesSugeridas.map((city) => (
                                <option
                                  key={valorCidade(city)}
                                  value={valorCidade(city)}
                                >
                                  {city.nome} / {city.uf}
                                </option>
                              ))}
                            </select>
                          </label>
                          {form.benefit !== "any" && <BenefitTerms />}
                          <TerminalFields form={form} onChange={setForm} />
                          <label className="fb-full">
                            Período de busca
                            <select
                              value={form.rollingWindow ? "rolling" : "fixed"}
                              onChange={(event) =>
                                setForm({
                                  ...form,
                                  rollingWindow:
                                    event.target.value === "rolling"
                                      ? 14
                                      : undefined,
                                  startDate: today(),
                                  endDate:
                                    event.target.value === "rolling"
                                      ? new Date(
                                          Date.parse(today()) + 13 * 86400000,
                                        )
                                          .toISOString()
                                          .slice(0, 10)
                                      : today(),
                                })
                              }
                            >
                              <option value="fixed">
                                Datas específicas (até 7 dias)
                              </option>
                              <option value="rolling">
                                Sempre os próximos 14 dias
                              </option>
                            </select>
                          </label>
                          {form.rollingWindow ? (
                            <p className="fb-fine fb-full">
                              A janela avança automaticamente todos os dias.
                              Continua procurando até você pausar ou excluir. A
                              frequência de consulta permanece a do plano.
                            </p>
                          ) : (
                            <>
                              <label>
                                De
                                <input
                                  type="date"
                                  required
                                  min={today()}
                                  value={form.startDate}
                                  onChange={(e) =>
                                    setForm({
                                      ...form,
                                      startDate: e.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label>
                                Até
                                <input
                                  type="date"
                                  required
                                  min={form.startDate}
                                  value={form.endDate}
                                  onChange={(e) =>
                                    setForm({
                                      ...form,
                                      endDate: e.target.value,
                                    })
                                  }
                                />
                              </label>
                            </>
                          )}
                          <label>
                            Preço máximo (R$) · total informado ou cotação se o
                            total estiver pendente
                            <input
                              type="number"
                              min="0"
                              max="10000"
                              step="0.01"
                              required
                              value={form.maxPrice}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  maxPrice: Number(e.target.value),
                                })
                              }
                            />
                            {form.providers.includes("ClickBus") &&
                              form.benefit !== "any" && (
                                <small>
                                  No ClickBus, o limite considera a tarifa do
                                  benefício. Taxas e valor final são confirmados
                                  na emissão.
                                </small>
                              )}
                          </label>
                          <label>
                            Intervalo entre consultas
                            <select
                              value={form.intervalMinutes}
                              onChange={(e) =>
                                setForm({
                                  ...form,
                                  intervalMinutes: Number(e.target.value),
                                })
                              }
                            >
                              {!dailyCloud && (
                                <>
                                  <option value={30}>30 minutos</option>
                                  <option value={60}>1 hora</option>
                                  <option value={180}>3 horas</option>
                                  <option value={360}>6 horas</option>
                                  <option value={720}>12 horas</option>
                                </>
                              )}
                              <option value={1440}>24 horas</option>
                            </select>
                          </label>
                          <label className="fb-full">
                            Benefício
                            <select
                              value={form.benefit}
                              onChange={(e) => {
                                const benefit = e.target
                                  .value as MonitorConfig["benefit"];
                                setForm({
                                  ...form,
                                  benefit,
                                  providers: form.providers.filter((p) =>
                                    supportsMonitoring(p, benefit),
                                  ),
                                });
                              }}
                            >
                              <option value="any">
                                Qualquer passagem no meu preço
                              </option>
                              <option value="id50">
                                ID Jovem: 50% ou 100%
                              </option>
                              <option value="id100">
                                Somente ID Jovem 100%
                              </option>
                            </select>
                          </label>
                        </div>
                        <fieldset>
                          <legend>Fontes para acompanhar</legend>
                          <div className="fb-providers">
                            {providerIds.map((provider) => (
                              <label key={provider} className="fb-checkbox">
                                <input
                                  type="checkbox"
                                  disabled={
                                    !supportsMonitoring(provider, form.benefit)
                                  }
                                  checked={form.providers.includes(provider)}
                                  onChange={(e) =>
                                    setForm({
                                      ...form,
                                      providers: e.target.checked
                                        ? [...form.providers, provider]
                                        : form.providers.filter(
                                            (p) => p !== provider,
                                          ),
                                    })
                                  }
                                />
                                {provider === "AguiaBranca"
                                  ? "Águia Branca"
                                  : provider}
                                {provider === "Gontijo" && (
                                  <span title="Disponibilidade automática ainda não confirmada">
                                    *
                                  </span>
                                )}
                              </label>
                            ))}
                          </div>
                          <p className="fb-fine">
                            Datas fixas de até 7 dias ou janela móvel de 14
                            dias. Fontes desabilitadas não confirmam este
                            benefício automaticamente. Fontes podem ficar
                            indisponíveis; nenhuma frequência garante acesso.
                          </p>
                        </fieldset>
                        <button
                          className="fb-primary"
                          disabled={busy || form.providers.length === 0}
                        >
                          <Radio size={17} />
                          {busy ? "Salvando…" : "Salvar monitoramento"}
                        </button>
                      </form>
                    </section>
                  )}
                  <div className="fb-section-head">
                    <h2>
                      Suas rotas{" "}
                      <span className="fb-count">{monitors.length}</span>
                    </h2>
                    <button
                      className="fb-text-button"
                      disabled={busy}
                      onClick={() => void perform(loadDashboard)}
                    >
                      <RefreshCw size={14} /> Atualizar
                    </button>
                  </div>
                  {monitors.length === 0 ? (
                    <section className="fb-panel fb-empty">
                      <div className="fb-mini-icon">
                        <Bus size={30} />
                      </div>
                      <h3>Uma viagem começa com uma ideia.</h3>
                      <p>
                        Salve uma rota e deixe as próximas consultas com o
                        FastBus.
                      </p>
                      <button
                        className="fb-secondary"
                        onClick={() => setShowForm(true)}
                      >
                        <Plus size={16} /> Criar primeiro monitoramento
                      </button>
                    </section>
                  ) : (
                    monitors.map((monitor) => (
                      <article className="fb-panel fb-route" key={monitor.id}>
                        <div className="fb-section-head">
                          <span
                            className={`fb-badge ${monitor.active ? "active" : ""}`}
                          >
                            <span className="fb-dot" />
                            {monitor.active ? "No radar" : "Pausado"}
                          </span>
                          <div className="fb-actions">
                            <button
                              className="fb-icon-button"
                              aria-label="Editar rota"
                              onClick={() => {
                                const {
                                  origin,
                                  destination,
                                  startDate,
                                  endDate,
                                  rollingWindow,
                                  maxPrice,
                                  intervalMinutes,
                                  benefit,
                                  providers,
                                } = monitor;
                                setForm({
                                  originTerminal: monitor.originTerminal,
                                  destinationTerminal:
                                    monitor.destinationTerminal,
                                  origin,
                                  destination,
                                  startDate,
                                  endDate,
                                  rollingWindow,
                                  maxPrice,
                                  intervalMinutes,
                                  benefit,
                                  providers: providers.filter((p) =>
                                    supportsMonitoring(p, benefit),
                                  ),
                                });
                                setEditing(monitor.id);
                                setShowForm(true);
                              }}
                            >
                              <Pencil size={16} />
                            </button>
                            <button
                              className="fb-icon-button"
                              disabled={busy}
                              aria-label={
                                monitor.active ? "Pausar rota" : "Retomar rota"
                              }
                              onClick={() =>
                                void perform(async () => {
                                  await api(
                                    `/api/monitors/${monitor.id}`,
                                    "PATCH",
                                    { active: !monitor.active },
                                  );
                                  await loadDashboard();
                                })
                              }
                            >
                              {monitor.active ? (
                                <Pause size={16} />
                              ) : (
                                <Play size={16} />
                              )}
                            </button>
                            <button
                              className="fb-icon-button danger"
                              disabled={busy}
                              aria-label="Excluir rota"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    "Excluir este monitoramento e seu histórico de alertas?",
                                  )
                                )
                                  void perform(async () => {
                                    await api(
                                      `/api/monitors/${monitor.id}`,
                                      "DELETE",
                                    );
                                    await loadDashboard();
                                  });
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                        <div className="fb-route-cities">
                          <strong>{cityLabel(monitor.origin)}</strong>
                          <ArrowRight size={21} />
                          <strong>{cityLabel(monitor.destination)}</strong>
                        </div>
                        <div className="fb-route-info">
                          <span>
                            {monitor.rollingWindow ? (
                              "Sempre os próximos 14 dias · sem data final"
                            ) : (
                              <>
                                {monitor.startDate
                                  .split("-")
                                  .reverse()
                                  .join("/")}{" "}
                                —{" "}
                                {monitor.endDate.split("-").reverse().join("/")}
                              </>
                            )}
                          </span>
                          <span>
                            Até <b>{money(monitor.maxPrice)}</b>
                          </span>
                          {monitor.benefit !== "any" && (
                            <span className="fb-accent">
                              ID Jovem{" "}
                              {monitor.benefit === "id100"
                                ? "100%"
                                : "50% / 100%"}
                            </span>
                          )}
                        </div>
                        <div className="fb-source-list">
                          {monitor.providers.map((p) => (
                            <span key={p}>{p}</span>
                          ))}
                        </div>
                        <p className="fb-route-status">
                          <Clock3 size={14} />
                          {monitor.status}
                        </p>
                        <p className="fb-fine">
                          {monitor.checkedAt
                            ? `Última tentativa: ${dateTime(monitor.checkedAt)}. `
                            : ""}
                          {monitor.active
                            ? `Próxima tentativa a partir de ${dateTime(monitor.nextAt)} · intervalo de ${monitor.intervalMinutes} min entre combinações.`
                            : "Consultas e envios desta rota estão pausados."}
                        </p>
                        <p className="fb-fine">
                          {monitor.lastSuccessAt
                            ? `Última consulta concluída: ${dateTime(monitor.lastSuccessAt)}.`
                            : "Ainda não há uma consulta concluída confirmada."}
                          {monitor.lastError
                            ? ` Diagnóstico: ${monitor.lastError}.`
                            : ""}
                        </p>
                        <p className="fb-fine">
                          Cobertura nas últimas 24 horas:{" "}
                          {monitor.coverageChecked || 0} de{" "}
                          {monitor.coverageTotal || 0} combinações de fonte e
                          data da janela atual.
                        </p>
                      </article>
                    ))
                  )}
                </>
              )}
              {tab === "alerts" && (
                <>
                  <div className="fb-section-head">
                    <h2>Oportunidades encontradas</h2>
                  </div>
                  <p className="fb-muted">
                    Últimos 50 alertas. A disponibilidade pode mudar após a
                    consulta.
                  </p>
                  {alerts.length === 0 ? (
                    <section className="fb-panel fb-empty">
                      <Bell size={30} />
                      <h3>Nenhum aviso por enquanto.</h3>
                      <p>
                        Quando uma passagem atender aos seus critérios, ela
                        aparece aqui.
                      </p>
                    </section>
                  ) : (
                    alerts.map((alert) => (
                      <article key={alert.id} className="fb-panel fb-alert">
                        <div className="fb-section-head">
                          <span className="fb-badge">
                            {alertLabels[alert.status] || alert.status}
                          </span>
                          <strong className="fb-price">
                            {alert.provider === "ClickBus" &&
                            alert.benefit.startsWith("id_jovem_")
                              ? "Tarifa "
                              : ""}
                            {money(alert.price)}
                          </strong>
                        </div>
                        <h3>
                          {cityLabel(alert.origin)} <ArrowRight size={16} />{" "}
                          {cityLabel(alert.destination)}
                        </h3>
                        <p>
                          {alert.date.split("-").reverse().join("/")} às{" "}
                          {alert.departure} · {alert.company}
                        </p>
                        {alert.provider === "ClickBus" &&
                          alert.benefit.startsWith("id_jovem_") && (
                            <p className="fb-fine">
                              Taxas e valor final a confirmar no ClickBus.
                            </p>
                          )}
                        <p className="fb-fine">
                          {alert.provider} · Consultado em{" "}
                          {dateTime(alert.observedAt)}
                          {alert.benefit !== "nenhuma"
                            ? ` · ${alert.benefit === "id_jovem_100" ? "ID Jovem 100%" : "ID Jovem 50%"}`
                            : ""}
                        </p>
                        <div className="fb-actions">
                          <a
                            className="fb-text-button"
                            href={alert.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Conferir na fonte <ArrowUpRight size={15} />
                          </a>
                          {alert.status === "failed" && (
                            <button
                              className="fb-text-button"
                              disabled={busy}
                              onClick={() =>
                                void perform(async () => {
                                  await api("/api/alerts", "POST", {
                                    id: alert.id,
                                  });
                                  await loadDashboard();
                                })
                              }
                            >
                              Tentar envio novamente
                            </button>
                          )}
                        </div>
                      </article>
                    ))
                  )}
                </>
              )}
              {tab === "account" && (
                <section className="fb-panel fb-account">
                  <h2>Sua conta, seus dados.</h2>
                  <p className="fb-muted">
                    {user.name} · {user.email}
                  </p>
                  <div className="fb-privacy">
                    <ShieldCheck size={22} />
                    <p>
                      Guardamos seu nome, e-mail, critérios de viagem e
                      histórico de alertas. Não solicitamos documentos ou dados
                      de pagamento. O número de contato permite enviar avisos ao
                      número escolhido por você.
                    </p>
                  </div>
                  <h3>Alterar senha</h3>
                  <p className="fb-fine">
                    A alteração encerra todas as sessões. Você precisará entrar
                    novamente.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      void perform(async () => {
                        await api("/api/account/password", "POST", {
                          password: data.get("password"),
                          newPassword: data.get("newPassword"),
                        });
                        clearAccount();
                        setNotice("Senha alterada. Entre novamente.");
                      });
                    }}
                  >
                    <label>
                      Senha atual
                      <input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        maxLength={128}
                        required
                      />
                    </label>
                    <label>
                      Nova senha
                      <input
                        name="newPassword"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={128}
                        required
                      />
                    </label>
                    <button className="fb-secondary" disabled={busy}>
                      Atualizar senha
                    </button>
                  </form>
                  <hr />
                  <h3>Excluir minha conta</h3>
                  <p className="fb-muted">
                    Remove seus dados, número de contato, monitoramentos e
                    alertas. A conexão central do FastBus continua atendendo as
                    outras contas.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      void perform(async () => {
                        await api("/api/account/delete", "POST", {
                          password: data.get("password"),
                        });
                        clearAccount();
                        setNotice("Conta excluída.");
                      });
                    }}
                  >
                    <label>
                      Confirme sua senha
                      <input
                        name="password"
                        type="password"
                        autoComplete="current-password"
                        maxLength={128}
                        required
                      />
                    </label>
                    <label className="fb-checkbox">
                      <input type="checkbox" required />
                      Entendo que a exclusão é permanente.
                    </label>
                    <button
                      className="fb-secondary fb-danger-button"
                      disabled={busy}
                    >
                      Excluir conta e dados
                    </button>
                  </form>
                </section>
              )}
            </section>
            <aside className="fb-sidebar">
              <NotificationContact
                key={user.id}
                contact={wa}
                onSaved={loadDashboard}
              />
              <section className="fb-how">
                <ShieldCheck size={18} />
                <h3>No seu tempo. Com cuidado.</h3>
                <p>
                  Consultas espaçadas e pausas quando uma fonte falha. Sem
                  mensagens quando não há uma nova oportunidade.
                </p>
                <a
                  href="https://github.com/ryuclover/Fast-Travel"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Sobre o projeto <ArrowUpRight size={13} />
                </a>
              </section>
            </aside>
          </div>
        </main>
      )}
      <footer className="fb-wrap fb-footer">
        <span>
          fastbus{" "}
          <span className="fb-muted">/ De olho na sua próxima viagem.</span>
        </span>
        <span>Feito para acompanhar, sem pressa.</span>
      </footer>
    </div>
  );
}
