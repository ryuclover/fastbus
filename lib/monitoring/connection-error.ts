/** Only fixed, non-sensitive diagnostics can be returned to the admin UI. */
export function connectionError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (/^SESSION_BACKUP_(INCOMPLETE|INVALID)$/.test(message)) return message;
  if (/Execution context was destroyed|Cannot find context/i.test(message))
    return "BROWSER_NAVIGATION";
  if (
    /Could not find Chrome|executablePath|ENOENT|Browser was not found/i.test(
      message,
    )
  )
    return "BROWSER_NOT_FOUND";
  if (/ERR_CERT|certificate/i.test(message)) return "NETWORK_CERTIFICATE";
  if (
    /ERR_NETWORK_ACCESS_DENIED|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_PROXY/i.test(
      message,
    )
  )
    return "NETWORK_UNAVAILABLE";
  if (/Failed to launch|EACCES|EPERM|spawn/i.test(message))
    return "BROWSER_LAUNCH_FAILED";
  if (/timeout|timed out|Waiting failed.*exceeded/i.test(message))
    return "CONNECTION_TIMEOUT";
  if (/Cannot find module|Optional Dependencies/i.test(message))
    return "DEPENDENCY_MISSING";
  return "INITIALIZATION_FAILED";
}
export const connectionMessages: Record<string, string> = {
  DAYTONA_START_TIMEOUT:
    "O Olympus não abriu o processo de WhatsApp dentro do prazo. Aguarde antes de tentar novamente.",
  DAYTONA_BUSY:
    "Outro processo está usando a conexão do Olympus. Aguarde o encerramento antes de tentar novamente.",
  DAYTONA_WORKER_FAILED:
    "O processo de WhatsApp do Olympus não conseguiu iniciar. Consulte o diagnóstico antes de tentar novamente.",
  DAYTONA_NETWORK_BLOCKED:
    "O Olympus Cloud está instalado, mas sua rede não consegue acessar o banco do FastBus. Novas execuções foram pausadas até liberar esse acesso no Daytona.",
  PERSISTENT_PAIRING_REQUIRED:
    "O ambiente persistente precisa de um primeiro pareamento. Leia o QR e aguarde a confirmação de perfil salvo.",
  SESSION_BACKUP_INCOMPLETE:
    "O backup anterior não contém todos os arquivos de autenticação. Faça o pareamento novamente para salvar uma sessão completa.",
  SESSION_BACKUP_INVALID:
    "O arquivo da sessão não passou na validação. Faça o pareamento novamente.",
  RESTORE_REQUIRES_PAIRING:
    "O WhatsApp não aceitou a sessão salva e pediu novo pareamento. A conexão ainda não foi restaurada.",
  SESSION_BACKUP_FAILED:
    "A conexão abriu, mas não foi possível salvar a sessão completa. O envio futuro ainda não está garantido.",
  PAIRING_REQUIRED:
    "A sessão ainda não foi salva. Gere um QR Code, leia no celular e aguarde a confirmação do backup antes de sair.",
  CLOUD_BUSY:
    "Outra execução está em andamento. Aguarde três minutos e tente conectar novamente.",
  CLOUD_DAILY_LIMIT:
    "O limite de três tentativas de conexão de hoje foi atingido. Tente amanhã (contagem em UTC).",
  BROWSER_NAVIGATION:
    "O WhatsApp Web recarregou durante a conexão. Tente gerar o QR Code novamente.",
  BROWSER_NOT_FOUND:
    "Chrome/Chromium não encontrado. Verifique o navegador configurado no servidor.",
  BROWSER_LAUNCH_FAILED:
    "Não foi possível abrir o navegador do WhatsApp no servidor.",
  NETWORK_CERTIFICATE:
    "A conexão com o WhatsApp falhou na verificação do certificado de rede.",
  NETWORK_UNAVAILABLE:
    "O servidor não conseguiu acessar o WhatsApp Web. Verifique a conexão de rede.",
  CONNECTION_TIMEOUT:
    "O WhatsApp Web demorou para carregar. Tente gerar o QR Code novamente.",
  DEPENDENCY_MISSING:
    "Uma dependência da conexão do WhatsApp está ausente no servidor.",
  INITIALIZATION_FAILED:
    "Não foi possível inicializar o WhatsApp Web. Tente novamente.",
  AUTH_FAILED: "A autenticação do WhatsApp falhou. Gere um novo QR Code.",
  DISCONNECTED:
    "A sessão do WhatsApp foi interrompida. É necessário reconectar.",
};
