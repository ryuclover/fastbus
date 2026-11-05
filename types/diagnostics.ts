export type DiagnosticKind = "whatsapp" | "message" | "provider";
export type DiagnosticJob = {
  id: string;
  kind: DiagnosticKind;
  state: "queued" | "running" | "passed" | "failed" | "inconclusive";
  code: string;
  offers: number | null;
  created_at: number;
  completed_at: number | null;
  target?: string;
};
export const diagnosticMessages: Record<string, string> = {
  DAYTONA_NETWORK_BLOCKED: "A execução no Olympus está pausada porque a rede não consegue acessar o banco do FastBus.",
  QUEUED: "Aguardando o processo de verificação.",
  RUNNING: "Verificação em andamento.",
  RESTORING_SESSION:
    "O ambiente está executando o teste e tentando abrir a sessão do WhatsApp.",
  WHATSAPP_READY: "A sessão do WhatsApp abriu com sucesso.",
  MESSAGE_SENT:
    "O WhatsApp confirmou o envio. Confira o recebimento no celular.",
  CONTACT_NOT_VERIFIED:
    "Confirme e ative seu número no painel antes de testar o envio.",
  PAIRING_REQUIRED: "Conecte o WhatsApp e aguarde o primeiro backup da sessão.",
  WHATSAPP_NOT_READY: "O WhatsApp não ficou pronto dentro do prazo.",
  SEND_DEFERRED:
    "Envio impedido por pausa, contato desativado ou remetente desconectado. Aguarde antes de testar novamente.",
  PROVIDER_COOLDOWN: "A fonte está em pausa. Aguarde o horário indicado.",
  PROVIDER_OK:
    "A fonte respondeu com viagens. Isso não garante ofertas nos critérios do monitoramento.",
  PROVIDER_EMPTY:
    "Consulta concluída, sem viagens confirmadas nesta combinação.",
  PROVIDER_PARTIAL:
    "Consulta parcial: não foi possível conferir todas as candidatas.",
  ID_JOVEM_UNCONFIRMED: "A consulta não confirmou cotas ID Jovem online.",
  MONITOR_CHANGED:
    "A rota foi alterada, pausada ou excluída. Inicie uma nova verificação.",
  ADMIN_REQUIRED: "O acesso administrativo foi revogado.",
  JOB_EXPIRED:
    "A verificação não terminou no prazo. O resultado é inconclusivo; confira o celular antes de repetir um envio.",
  CLOUD_BUSY: "Há outra execução ativa. Aguarde antes de tentar novamente.",
  CLOUD_DAILY_LIMIT: "O limite diário de verificações em nuvem foi atingido.",
  CLOUD_FAILED: "Não foi possível iniciar ou concluir a execução em nuvem.",
  CLICKBUS_TRIPS_RESPONSE_TIMEOUT:
    "O ClickBus não retornou a resposta de viagens no prazo.",
  BROWSER_TIMEOUT: "O navegador excedeu o prazo da consulta.",
  PROVIDER_BLOCKED:
    "A fonte recusou a consulta. A pausa da fonte foi preservada.",
  QUERY_FAILED:
    "A fonte não concluiu a consulta. Consulte o código do diagnóstico.",
};
export type DiagnosticsStatus = {
  checkedAt: number;
  database: boolean;
  cloud: boolean;
  cloudConfigured: boolean;
  sender: {
    status: string;
    sessionStored: boolean;
    workerOnline: boolean;
    desired: boolean;
    persistent?: boolean;
  };
  contact: { verified: boolean; enabled: boolean };
  queue: { status: string; count: number }[];
  providers: {
    id: string;
    nextAt: number;
    lastCode: string | null;
    lastAt: number | null;
    commercial: boolean;
    youth: boolean;
  }[];
  monitors: { id: string; label: string; providers: string[]; date: string }[];
  jobs: DiagnosticJob[];
};
