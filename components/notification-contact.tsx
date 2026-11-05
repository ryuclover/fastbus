"use client";
import { useEffect, useState, type FormEvent } from "react";
import { MessageCircle, ShieldCheck, Bell, BellOff } from "lucide-react";
import { api } from "@/lib/api-client";
export type ContactStatus = {
  cloud?: boolean;
  phone: string;
  enabled: boolean;
  senderReady: boolean;
  workerOnline: boolean;
  verified?: boolean;
  verificationStatus?: string;
  expiresAt?: number | null;
};
export function NotificationContact({
  contact,
  onSaved,
}: {
  contact: ContactStatus;
  onSaved: () => Promise<void>;
}) {
  const [phone, setPhone] = useState(contact.phone);
  const [consent, setConsent] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  useEffect(() => {
    if (!dirty) setPhone(contact.phone);
  }, [contact.phone, dirty]);
  async function update(method: string, input?: unknown) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{
        verificationRequired?: boolean;
        senderReady?: boolean;
      }>("/api/whatsapp", method, input, "Não foi possível salvar o contato.");
      setDirty(false);
      setConsent(false);
      await onSaved();
      setMessage(
        method === "PATCH"
          ? "Número confirmado. Os avisos estão ativados."
          : result.verificationRequired
            ? result.senderReady
              ? "Código solicitado. Aguarde a mensagem no WhatsApp e digite os 4 dígitos abaixo."
              : "Número aguardando confirmação. O administrador precisa conectar o WhatsApp do FastBus para enviar o código."
            : method === "DELETE"
              ? "Número removido. Nenhum novo aviso será enviado."
              : input && (input as { enabled: boolean }).enabled
                ? "Número salvo. Você receberá as oportunidades encontradas."
                : "Avisos por WhatsApp pausados.",
      );
      setCode("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Falha ao salvar.");
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    void update("POST", { phone, enabled: true, consent });
  }
  useEffect(() => {
    if (!contact.phone || contact.verified) return;
    const timer = setInterval(() => {
      void onSaved().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [contact.phone, contact.verified, onSaved]);
  return (
    <section className="fb-panel fb-whatsapp">
      <div className="fb-mini-icon">
        <MessageCircle size={25} />
      </div>
      <span className="fb-eyebrow">OS AVISOS DO FASTBUS</span>
      <h2>
        Receba as oportunidades <br />
        no seu WhatsApp.
      </h2>
      <p className="fb-muted">
        Informe onde quer receber os alertas. As mensagens serão enviadas pelo
        número do FastBus quando uma passagem atender aos seus critérios.
      </p>
      <span className={`fb-badge ${contact.enabled ? "active" : ""}`}>
        <span className="fb-dot" />
        {contact.enabled
          ? "Recebimento ativado · número confirmado"
          : contact.phone && !contact.verified
            ? "Confirmação pendente"
            : "Recebimento desativado"}
      </span>
      <form onSubmit={save}>
        <label>
          Número esperando o contato do FastBus
          <input
            type="tel"
            name="phone"
            autoComplete="tel"
            placeholder="+55 11 99999-9999"
            value={phone}
            maxLength={30}
            required
            onChange={(event) => {
              setPhone(event.target.value);
              setDirty(true);
              setConsent(false);
            }}
          />
        </label>
        <p className="fb-fine">
          Inclua +55, DDD e número. Exemplo: +55 11 99999-9999.
        </p>
        <label className="fb-checkbox fb-contact-consent">
          <input
            type="checkbox"
            checked={consent}
            required
            onChange={(event) => setConsent(event.target.checked)}
          />
          Este número é meu e autorizo o recebimento dos alertas das minhas
          viagens.
        </label>
        <button className="fb-primary" disabled={busy}>
          <Bell size={16} />
          {busy
            ? "Aguarde…"
            : contact.verified && phone.replace(/[ ()-]/g, "") === contact.phone
              ? "Salvar número e ativar avisos"
              : "Enviar código de confirmação"}
        </button>
      </form>
      {contact.phone && !contact.verified && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update("PATCH", { code });
          }}
        >
          <p className="fb-fine">
            {contact.verificationStatus === "sent"
              ? "Mensagem enviada ao WhatsApp. O código vale por 10 minutos."
              : contact.verificationStatus === "failed" ||
                  contact.verificationStatus === "expired" ||
                  contact.verificationStatus === "locked"
                ? "Não foi possível concluir. Solicite um novo código pelo formulário acima."
                : "Aguardando envio pelo WhatsApp do FastBus. Os avisos permanecem desativados até a confirmação."}
          </p>
          <label>
            Código recebido no WhatsApp
            <input
              name="verificationCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4}"
              maxLength={4}
              minLength={4}
              required
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, ""))
              }
            />
          </label>
          <button
            className="fb-primary"
            disabled={busy || contact.verificationStatus !== "sent"}
          >
            Confirmar número e ativar avisos
          </button>
        </form>
      )}
      {contact.phone && (
        <div className="fb-contact-actions">
          {contact.enabled && (
            <button
              className="fb-text-button"
              disabled={busy}
              onClick={() =>
                void update("POST", {
                  phone: contact.phone,
                  enabled: false,
                  consent: true,
                })
              }
            >
              <BellOff size={14} />
              Pausar avisos
            </button>
          )}
          <button
            className="fb-text-button"
            disabled={busy}
            onClick={() => void update("DELETE")}
          >
            Remover número
          </button>
        </div>
      )}
      {error && (
        <p className="fb-message error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="fb-message success" role="status">
          {message}
        </p>
      )}
      <p className="fb-fine">
        {contact.senderReady
          ? "O número do FastBus está conectado para enviar os avisos."
          : "O envio está aguardando a conexão do número do FastBus pelo administrador. Suas oportunidades continuam no painel."}
      </p>
      <p className="fb-fine">
        <ShieldCheck
          size={13}
          style={{ display: "inline", verticalAlign: "middle" }}
        />{" "}
        Seu número fica criptografado. Você pode pausar ou remover o contato a
        qualquer momento.
      </p>
    </section>
  );
}
