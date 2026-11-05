# FastBus gratuito na Vercel

Implementação de 19/10/2026. Sem Daemons e sem servidor de disco persistente contratado.

## Componentes

- Next.js na Vercel Hobby: painel, autenticação, APIs e QR administrativo.
- Turso Starter provisionado pelo Marketplace Vercel: dados transacionais remotos, usuários, contatos criptografados, rotas, alertas, limites e concessões exclusivas.
- Vercel Blob privado: backups RemoteAuth criptografados com AES-256-GCM. Somente a referência da versão publicada fica no banco; o upload conclui antes de atualizar essa referência.
- Sandbox Hobby: navegador em execuções limitadas a 200 segundos. Snapshot limpo com Node 24, dependências, Chromium e Xvfb, sem credenciais nem perfis pessoais. Credenciais são passadas somente à execução; cada execução é encerrada no finally e também tem prazo máximo na plataforma.
- Cron Hobby: uma chamada diária às 12h UTC, com a precisão oferecida pelo plano. Uma combinação de rota/data/fonte por chamada, alternando monitoramentos. Não varre todos os dias de todas as rotas em cada execução.

## Limites e comportamento

O funcionamento gratuito tem menor frequência que o worker local contínuo. Não há promessa de detectar todas as vagas antes de esgotarem. O histórico pode conter oportunidades que já não estejam disponíveis no momento da abertura.

O pareamento administrativo abre o navegador por cerca de três minutos; é necessário ler o QR assim que aparecer e aguardar o primeiro backup. Até três tentativas por dia (UTC). Após salvar a sessão, o WhatsApp permanece desligado entre execuções e abre somente quando houver alerta pendente. A sessão pode exigir novo QR conforme as regras do WhatsApp.

As cotas Hobby podem pausar o serviço. Não há upgrade automático nem daemon pago. Banco e Blob possuem suas próprias cotas gratuitas; acompanhar os painéis antes de aumentar uso. Não criar múltiplos projetos ou crons para contornar limites.

## Segurança e publicação

Banco remoto assíncrono com transações de escrita, limites atômicos e chaves estrangeiras. SQLite local permanece disponível para desenvolvimento. Cookies HTTPOnly/Secure/Strict, checagem de origem, sessão administrativa autenticada para parear, QR restrito ao administrador e destinatários com consentimento.

`.vercelignore` exclui dados, perfis, arquivos de ambiente, diagnósticos e temporários. O build inclui somente o worker empacotado e o código da extensão. O snapshot não contém os segredos da aplicação. A chave de criptografia fica nas variáveis de produção; perdê-la impede recuperar dados e sessões.

`npm run build` prepara `.fastbus-cloud/worker.cjs`. Para publicar a extensão, esse diretório também deve conter `browsec.tar.gz`, gerado a partir da instalação local em `data/browser-extensions/browsec`. A extensão é código; perfis pessoais não são empacotados. Em um clone limpo, preparar esse artefato antes do deploy.

Variáveis: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`, `FASTBUS_DATA_KEY`, `CRON_SECRET`, `FASTBUS_SANDBOX_SNAPSHOT`, `FASTBUS_CLOUD_MODE=daily`, `NEXT_PUBLIC_FASTBUS_CLOUD_MODE=daily`. Origem HTTPS: `APP_ORIGIN`, ou domínio de produção fornecido pela Vercel em `VERCEL_PROJECT_PRODUCTION_URL`. `scripts/prepare-cloud.ts` prepara um novo snapshot limpo usando a autenticação da Vercel; configurar o identificador retornado antes do deploy.

## Verificações

63 testes automatizados e E2E local de produção com navegador real, incluindo isolamento entre contas, ciclo de monitoramento e envio simulado. Banco Turso real: rollback, concorrência do limitador e chaves estrangeiras. Blob privado real: upload/leitura/exclusão de dados artificiais. Sandbox real: Chromium inicia com sandbox do navegador e worker executa/encerra sem rotas ativas. O worker integrado gerou QR real no Sandbox; o WhatsApp usa navegador normal com Xvfb neste ambiente. Produção: cadastro, persistência, cookies, CSRF, restrição administrativa, CRUD de rotas e layout mobile, com contas temporárias removidas. Pareamento completo e entrega real dependem de leitura do QR pelo titular e de oportunidade elegível.

## Documentação oficial

- https://vercel.com/docs/cron-jobs/usage-and-pricing
- https://vercel.com/docs/sandbox/pricing
- https://vercel.com/docs/sandbox/sdk-reference
- https://vercel.com/docs/vercel-blob/private-storage
- https://vercel.com/marketplace/tursocloud
- https://docs.turso.tech/cloud/limitations
