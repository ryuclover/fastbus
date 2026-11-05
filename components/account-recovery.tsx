"use client";
import { useState, type FormEvent } from "react";
import { api } from "@/lib/api-client";
export function AccountRecovery() {
  const [open, setOpen] = useState(false),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (!sent) {
        const result = await api<{ message: string }>(
          "/api/account/recovery",
          "POST",
          { email: input.get("recoveryEmail") },
        );
        setMessage(result.message);
        setSent(true);
      } else {
        await api("/api/account/recovery", "PATCH", {
          email: input.get("recoveryEmail"),
          code: input.get("recoveryCode"),
          password: input.get("recoveryPassword"),
        });
        setMessage("Senha alterada. Entre com sua nova senha.");
        setSent(false);
        setOpen(false);
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Falha ao recuperar acesso.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fb-recovery">
      <button
        type="button"
        className="fb-text-button"
        onClick={() => setOpen(!open)}
      >
        Esqueci minha senha
      </button>
      {open && (
        <form onSubmit={submit}>
          <p className="fb-fine">
            A recuperação usa somente o WhatsApp já confirmado na sua conta. Sem
            número confirmado, procure o administrador.
          </p>
          <label>
            E-mail da conta
            <input
              name="recoveryEmail"
              type="email"
              autoComplete="username"
              required
              maxLength={254}
            />
          </label>
          {sent && (
            <>
              <label>
                Código de recuperação
                <input
                  name="recoveryCode"
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  minLength={8}
                  maxLength={8}
                  autoComplete="one-time-code"
                  required
                />
              </label>
              <label>
                Nova senha de acesso
                <input
                  name="recoveryPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </label>
            </>
          )}
          <button className="fb-primary" disabled={busy}>
            {busy
              ? "Aguarde…"
              : sent
                ? "Definir nova senha"
                : "Enviar código de recuperação"}
          </button>
          {sent && (
            <button
              type="button"
              className="fb-text-button"
              disabled={busy}
              onClick={() => {
                setSent(false);
                setError("");
                setMessage("");
              }}
            >
              Solicitar outro código
            </button>
          )}
        </form>
      )}
      {message && (
        <p className="fb-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="fb-message error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
