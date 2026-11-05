"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Bus,
  ShieldCheck,
  MessageCircle,
  ArrowLeft,
  Radio,
} from "lucide-react";
import "../fastbus.css";
import { api } from "@/lib/api-client";
import type { User } from "@/types/account";
import { AdminDiagnostics } from "@/components/admin-diagnostics";
type Session = { user: User | null };
type Sender = {
  cloud?: boolean;
  persistent?: boolean;
  status: string;
  desired: boolean;
  qr: string | null;
  workerOnline: boolean;
  error?: string | null;
  retryAt?: number | null;
  updatedAt?: number | null;
};
const labels: Record<string, string> = {
  disconnected: "Desconectado",
  connecting: "Abrindo WhatsApp Web",
  queued: "Conexão na fila",
  qr: "Aguardando leitura do QR Code",
  authenticated: "Autenticando",
  ready: "Conectado",
  error: "Conexão interrompida",
  offline: "Processo de envio desligado",
  disconnecting: "Desconectando",
  sleeping: "Sessão salva para o próximo envio",
};
export default function Admin() {
  const [access, setAccess] = useState<
    "loading" | "login" | "denied" | "password" | "allowed"
  >("loading");
  const [sender, setSender] = useState<Sender>({
    status: "disconnected",
    desired: false,
    qr: null,
    workerOnline: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSender(
        await api<Sender>(
          "/api/admin/whatsapp",
          "GET",
          undefined,
          "Falha ao consultar a conexão.",
        ),
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 401 && status !== 403) throw error;
      setSender({
        status: "disconnected",
        desired: false,
        qr: null,
        workerOnline: false,
      });
      setAccess(status === 401 ? "login" : "denied");
    }
  }, []);
  useEffect(() => {
    void fetch("/api/account/me", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => response.json())
      .then((session: Session) =>
        setAccess(
          !session.user
            ? "login"
            : session.user.role !== "admin"
              ? "denied"
              : session.user.mustChangePassword
                ? "password"
                : "allowed",
        ),
      )
      .catch(() => {
        setError("Não foi possível verificar seu acesso.");
        setAccess("login");
      });
  }, []);
  useEffect(() => {
    if (access !== "allowed") return;
    const poll = () => {
      void refresh().catch((error) => setError(error.message));
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, [access, refresh]);
  async function toggle(event: { preventDefault(): void }, retry = false) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/admin/whatsapp",
        "POST",
        {
          connect: retry ? true : !sender.desired,
          ...(retry ? { retry: true } : {}),
        },
        "Não foi possível alterar a conexão.",
      );
      await refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Falha na conexão.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fb-app">
      <header className="fb-header">
        <div className="fb-wrap fb-header-inner">
          <a className="fb-brand" href="/">
            <span className="fb-brand-icon">
              <Bus size={23} />
            </span>
            <span>
              fast<span className="fb-accent">bus</span>
              <small>ADMINISTRAÇÃO</small>
            </span>
          </a>
          <a className="fb-text-button" href="/">
            <ArrowLeft size={16} />
            Voltar ao painel
          </a>
        </div>
      </header>
      <main className="fb-wrap fb-dashboard fb-admin">
        <span className="fb-eyebrow">
          <ShieldCheck size={15} />
          ACESSO ADMINISTRATIVO
        </span>
        <h1>O WhatsApp do FastBus.</h1>
        <p className="fb-muted">
          Uma conexão do serviço para enviar os alertas aos números escolhidos
          pelos usuários.
        </p>
        {error && (
          <p className="fb-message error" role="alert">
            {error}
          </p>
        )}
        {access === "loading" && <p role="status">Verificando acesso…</p>}
        {access !== "loading" && access !== "allowed" && (
          <section className="fb-panel fb-account">
            <h2>
              {access === "login"
                ? "Entre com a conta administrativa."
                : access === "password"
                  ? "Troque sua senha inicial."
                  : "Acesso restrito."}
            </h2>
            <p className="fb-muted">
              {access === "password"
                ? "Abra Conta no painel e defina sua senha pessoal antes de conectar o WhatsApp."
                : "Somente uma conta de administrador pode visualizar o QR Code e controlar a conexão. Se estiver usando uma conta comum, saia dela pelo painel e entre como administrador."}
            </p>
            <a className="fb-primary" href="/">
              {access === "password"
                ? "Ir para minha conta"
                : "Ir para o login"}
            </a>
          </section>
        )}
        {access === "allowed" && (
          <>
            <div className="fb-admin-grid">
              <section className="fb-panel fb-account">
                <div className="fb-mini-icon">
                  <MessageCircle size={25} />
                </div>
                <h2>Conexão do número remetente</h2>
                <p className="fb-muted">
                  No celular do FastBus, abra WhatsApp → Aparelhos conectados →
                  Conectar um aparelho.
                </p>
                <p
                  className={`fb-badge ${sender.status === "ready" && sender.workerOnline ? "active" : ""}`}
                >
                  <span className="fb-dot" />
                  {!sender.cloud && !sender.workerOnline && sender.desired
                    ? "Aguardando processo de envio"
                    : labels[sender.status] || sender.status}
                </p>
                {sender.qr && sender.workerOnline && (
                  <div className="fb-qr fb-admin-qr">
                    <img
                      src={sender.qr}
                      width={280}
                      height={280}
                      alt="QR Code administrativo do WhatsApp FastBus"
                    />
                    <p>
                      Escaneie com o aparelho do número que enviará os alertas.
                      O código expira e se renova automaticamente.
                    </p>
                  </div>
                )}
                {sender.cloud && (
                  <p className="fb-message">
                    A conexão abre por até três minutos para parear ou enviar.
                    Leia o QR Code assim que aparecer e aguarde a confirmação de
                    sessão salva. São permitidas até três tentativas de conexão
                    por dia.
                  </p>
                )}
                {!sender.cloud && !sender.workerOnline && (
                  <p className="fb-message warning">
                    O worker está desligado. A conexão será iniciada quando o
                    processo voltar a executar.
                  </p>
                )}
                {sender.error && (
                  <p className="fb-message error" role="alert">
                    {sender.error}
                  </p>
                )}
                {sender.retryAt && sender.retryAt > Date.now() && (
                  <p className="fb-fine">
                    Próxima tentativa automática:{" "}
                    {new Date(sender.retryAt).toLocaleTimeString("pt-BR", {
                      timeZone: "America/Sao_Paulo",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    . Você também pode tentar novamente agora.
                  </p>
                )}
                {sender.workerOnline &&
                  sender.status === "queued" &&
                  sender.updatedAt &&
                  Date.now() - sender.updatedAt > 30000 && (
                    <p className="fb-message warning">
                      A conexão ainda não foi processada. Tente novamente.
                    </p>
                  )}
                <form onSubmit={toggle}>
                  <button
                    className={sender.desired ? "fb-secondary" : "fb-primary"}
                    disabled={busy}
                  >
                    {busy
                      ? "Aguarde…"
                      : sender.desired
                        ? "Desconectar número do FastBus"
                        : "Gerar QR Code do FastBus"}
                  </button>
                  {sender.desired &&
                    ["error", "offline", "queued", "sleeping"].includes(
                      sender.status,
                    ) && (
                      <button
                        type="button"
                        className="fb-primary"
                        disabled={busy}
                        onClick={(event) => void toggle(event, true)}
                      >
                        {sender.status === "sleeping"
                          ? "Abrir conexão do remetente"
                          : "Tentar conexão novamente"}
                      </button>
                    )}
                </form>
              </section>
              <section className="fb-panel fb-account">
                <Radio size={24} className="fb-accent" />
                <h2>Alertas e verificações do serviço</h2>
                <p className="fb-muted">
                  Esta área não oferece caixa de entrada, lista de conversas ou
                  envio de mensagens livres. Além dos alertas, você pode
                  solicitar uma mensagem fixa de teste ao seu número confirmado
                  na área de diagnóstico.
                </p>
                <p className="fb-muted">
                  Os usuários não acessam este QR Code e não precisam conectar o
                  próprio WhatsApp. Cada conta pode alterar, pausar ou remover
                  seu contato no painel.
                </p>
                <div className="fb-privacy">
                  <ShieldCheck size={22} />
                  <p>
                    A sessão é do serviço, independente da conta do usuário
                    destinatário. Os números de destino ficam criptografados.
                  </p>
                </div>
                <p className="fb-fine">
                  O WhatsApp Web pode exigir novo pareamento. O navegador mantém
                  credenciais temporárias enquanto está ativo; proteja o
                  computador do serviço.
                </p>
              </section>
            </div>
            <AdminDiagnostics />
          </>
        )}
      </main>
    </div>
  );
}
