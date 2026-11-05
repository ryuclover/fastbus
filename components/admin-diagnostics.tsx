"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import {
  diagnosticMessages,
  type DiagnosticKind,
  type DiagnosticsStatus,
} from "@/types/diagnostics";

const kindLabels = {
  whatsapp: "Conexão WhatsApp",
  message: "Mensagem de teste",
  provider: "Consulta ao buscador",
};
const stateLabels = {
  queued: "Na fila",
  running: "Verificando",
  passed: "Concluído",
  failed: "Falhou",
  inconclusive: "Atenção",
};
const time = (value: number | null) =>
  value
    ? new Date(value).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Sem registro";

export function AdminDiagnostics() {
  const [data, setData] = useState<DiagnosticsStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [monitorId, setMonitorId] = useState("");
  const [provider, setProvider] = useState("");
  const refresh = useCallback(async () => {
    try {
      const status = await api<DiagnosticsStatus>(
        "/api/admin/diagnostics",
        "GET",
      );
      setData(status);
      return status;
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Falha ao consultar diagnósticos.",
      );
      setData(null);
    }
  }, []);
  const pending =
    data?.jobs.some(
      (job) => job.state === "queued" || job.state === "running",
    ) || false;
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), pending ? 5000 : 30000);
    return () => clearInterval(timer);
  }, [refresh, pending]);
  const selected =
    data?.monitors.find((m) => m.id === monitorId) || data?.monitors[0];
  const selectedProvider = selected?.providers.includes(provider)
    ? provider
    : selected?.providers[0] || "";
  const gate = data?.providers.find((p) => p.id === selectedProvider);
  async function run(kind: DiagnosticKind) {
    setBusy(true);
    setError("");
    try {
      await api("/api/admin/diagnostics", "POST", {
        kind,
        ...(kind === "provider"
          ? { monitorId: selected?.id, provider: selectedProvider }
          : {}),
      });
      await refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Falha ao iniciar a verificação.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="fb-panel fb-account fb-diagnostics"
      aria-labelledby="diagnostics-title"
    >
      <div className="fb-diagnostics-heading">
        <div>
          <span className="fb-eyebrow">VERIFICAÇÃO DO SERVIÇO</span>
          <h2 id="diagnostics-title">Está tudo funcionando?</h2>
        </div>
        <button
          type="button"
          className="fb-secondary"
          disabled={busy}
          onClick={() => {
            setError("");
            void refresh();
          }}
        >
          Atualizar diagnóstico
        </button>
      </div>
      <p className="fb-muted">
        Consulte o estado atual e execute um teste por vez. O histórico
        distingue falha técnica, pausa da fonte e resultado sem ofertas.
      </p>
      {error && (
        <p className="fb-message error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Carregando diagnóstico…</p>}
      {data && (
        <>
          <p className="fb-fine">
            Atualizado em {time(data.checkedAt)}. Resultados anteriores não
            garantem disponibilidade agora.
          </p>
          <div className="fb-diagnostics-summary">
            <p>
              <strong>Banco de dados</strong>
              <span>Consulta concluída</span>
            </p>
            <p>
              <strong>Sessão WhatsApp</strong>
              <span>
                {data.sender.sessionStored
                  ? data.sender.persistent
                    ? "Perfil persistente salvo"
                    : "Arquivo de sessão presente"
                  : "Sessão ainda não salva"}{" "}
                ·{" "}
                {data.sender.status === "sleeping"
                  ? "em espera entre execuções"
                  : data.sender.status === "ready"
                    ? "conectado"
                    : data.sender.status}
              </span>
            </p>
            <p>
              <strong>Seu destinatário</strong>
              <span>
                {data.contact.enabled && data.contact.verified
                  ? "Confirmado e ativo"
                  : "Precisa confirmar ou ativar no painel"}
              </span>
            </p>
            <p>
              <strong>Processamento</strong>
              <span>
                {data.cloud
                  ? data.cloudConfigured
                    ? "Nuvem configurada · rotina diária"
                    : "Configuração da nuvem incompleta"
                  : data.sender.workerOnline
                    ? "Worker ativo"
                    : "Worker desligado"}
              </span>
            </p>
          </div>
          <p className="fb-fine">
            Fila da sua conta:{" "}
            {data.queue.length
              ? data.queue
                  .map(
                    (item) =>
                      `${({ pending: "pendentes", sent: "enviados", failed: "com falha", expired: "expirados", cancelled: "cancelados" } as Record<string, string>)[item.status] || item.status}: ${item.count}`,
                  )
                  .join(" · ")
              : "sem alertas"}
            .
          </p>
          <div className="fb-diagnostics-actions">
            <div>
              <h3>1. Conexão do WhatsApp</h3>
              <p>
                Abre a sessão salva e verifica se o WhatsApp fica pronto, sem
                enviar mensagem.
              </p>
              <button
                type="button"
                className="fb-secondary"
                disabled={
                  busy ||
                  pending ||
                  !data.sender.sessionStored ||
                  !data.sender.desired
                }
                onClick={() => void run("whatsapp")}
              >
                Verificar conexão
              </button>
            </div>
            <div>
              <h3>2. Entrega de mensagem</h3>
              <p>
                Envia uma mensagem identificada como teste somente ao número
                confirmado da sua conta. Confira o recebimento no celular.
              </p>
              <button
                type="button"
                className="fb-secondary"
                disabled={
                  busy ||
                  pending ||
                  !data.contact.enabled ||
                  !data.contact.verified ||
                  !data.sender.sessionStored ||
                  !data.sender.desired
                }
                onClick={() => void run("message")}
              >
                Enviar mensagem de teste
              </button>
            </div>
            <div>
              <h3>3. Busca de passagens</h3>
              <p>
                Consulta uma data da rota salva com os mesmos limites do
                monitoramento. Não cria alertas nem reserva passagens.
              </p>
              {selected ? (
                <>
                  <label>
                    Rota para verificar
                    <select
                      value={selected.id}
                      onChange={(e) => {
                        setMonitorId(e.target.value);
                        setProvider("");
                      }}
                    >
                      {data.monitors.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Buscador
                    <select
                      value={selectedProvider}
                      onChange={(e) => setProvider(e.target.value)}
                    >
                      {selected.providers.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="fb-fine">
                    Data prevista: {selected.date}.{" "}
                    {gate && gate.nextAt > Date.now()
                      ? `Fonte em pausa até ${time(gate.nextAt)}.`
                      : "A fonte pode ser consultada."}
                  </p>
                  <button
                    type="button"
                    className="fb-secondary"
                    disabled={
                      busy ||
                      pending ||
                      !selectedProvider ||
                      (!!gate && gate.nextAt > Date.now())
                    }
                    onClick={() => void run("provider")}
                  >
                    Testar buscador
                  </button>
                </>
              ) : (
                <p>
                  Crie um monitoramento ativo no painel para testar uma rota.
                </p>
              )}
            </div>
          </div>
          <p className="fb-message">
            {data.cloud
              ? "Até três verificações em nuvem por dia para o serviço, sujeitas às cotas da instalação. "
              : "O worker precisa estar ligado para executar os testes. "}
            Até três solicitações por conta a cada 15 minutos. Um envio
            confirmado pelo WhatsApp ainda precisa ser conferido no celular.
          </p>
          <h3>Buscadores e última consulta do monitoramento</h3>
          <div className="fb-diagnostics-table">
            <table>
              <thead>
                <tr>
                  <th>Fonte</th>
                  <th>Automação</th>
                  <th>Último resultado</th>
                  <th>Próxima consulta permitida</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{p.id}</th>
                    <td>
                      {!p.commercial
                        ? "Indisponível"
                        : p.youth
                          ? "Comercial e ID Jovem"
                          : "Comercial"}
                    </td>
                    <td>
                      {p.lastCode || "Sem consulta registrada"}
                      <small>{time(p.lastAt)}</small>
                    </td>
                    <td>
                      {p.nextAt > Date.now()
                        ? time(p.nextAt)
                        : "Sem pausa registrada"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Histórico de verificações</h3>
          <div aria-live="polite">
            {!data.jobs.length ? (
              <p className="fb-muted">Nenhuma verificação solicitada.</p>
            ) : (
              <ol className="fb-diagnostics-history">
                {data.jobs.map((job) => (
                  <li key={job.id}>
                    <div>
                      <strong>{kindLabels[job.kind]}</strong>
                      <span
                        className={`fb-badge ${job.state === "passed" ? "active" : ""}`}
                      >
                        {job.code === "RESTORING_SESSION"
                          ? "Restaurando sessão"
                          : stateLabels[job.state]}
                      </span>
                    </div>
                    {job.target && <p>{job.target}</p>}
                    <p>
                      {diagnosticMessages[job.code] ||
                        "A verificação não foi concluída. Use o código abaixo para investigar."}
                    </p>
                    <small>
                      {time(job.completed_at || job.created_at)} · {job.code}
                      {job.offers !== null
                        ? ` · ${job.offers} viagens retornadas`
                        : ""}{" "}
                      · Ref. {job.id.slice(0, 8)}
                    </small>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </section>
  );
}
