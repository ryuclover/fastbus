# Segurança do FastBus

## Proteções implementadas

- Senhas com scrypt (N=32768, r=8, p=1) e sal aleatório de 128 bits; comparação em tempo constante.
- Sessões opacas de 256 bits. Somente o hash do token é salvo, com expiração e revogação no logout/troca de senha. Máximo de cinco sessões por usuário.
- Cookie HttpOnly, SameSite=Strict, Secure e prefixo __Host- em produção. Origem HTTPS obrigatória para escritas em produção.
- Verificação de origem em todas as mutações, sem CORS permissivo. Esquemas estritos, corpo limitado a 16 KiB e consultas SQL parametrizadas.
- Autorização por proprietário nas operações de monitoramentos, alertas e WhatsApp; identificação de usuário vem da sessão validada.
- AES-256-GCM, IV aleatório e identidade do registro no AAD, para dados pessoais, telefones, critérios, mensagens, QR Codes e backups da sessão WhatsApp. Índice de e-mail via HMAC.
- Limites persistentes para autenticação, reautenticação e uso de API. Não confiar em X-Forwarded-For evita um bypass trivial por IP inventado.
- CSP básica, proteção contra framing, nosniff, política de referência, permissões de câmera/microfone desativadas e HSTS em produção. Não há analytics externo.
- QR Codes só são retornados a administradores com senha inicial já alterada, com validade curta e respostas no-store. Alertas só contêm links HTTPS dos domínios conhecidos.
- Arquivos secretos e dados locais são ignorados pelo Git. Exclusão de conta em cascata e limpeza dos perfis órfãos pelo worker. A sessão central é independente dos usuários destinatários.

## Limites e responsabilidades de implantação

Criptografia da aplicação não substitui a proteção do servidor. O processo precisa da chave para trabalhar; um invasor com acesso ao processo, à chave e ao banco pode ler os dados. A pasta de dados e arquivos temporários de Chromium precisam estar em volume privado criptografado. Os perfis ativos do navegador contêm credenciais utilizáveis, sem criptografia adicional da aplicação enquanto estão em uso. No Windows, configure ACLs; os modos POSIX de criação não substituem essa configuração.

Não há MFA, verificação de e-mail ou auditoria externa nesta versão. A recuperação de senha usa código de oito dígitos no WhatsApp previamente confirmado; sem esse vínculo, exige manutenção pelo operador. Feche o cadastro depois de cadastrar as contas autorizadas. O limite global de login é intencional para uso pessoal/pequeno grupo; um serviço público requer controle de abuso na borda e mecanismo de identidade adequado à escala. O limite de corpo não substitui limites de conexão/tempo do proxy HTTP.

A CSP ainda permite scripts inline necessários à renderização padrão do Next.js; não se trata de uma CSP estrita com nonce. React escapa os textos exibidos, e nenhum conteúdo de fonte é inserido como HTML. Mantenha essa restrição ao fazer mudanças.

A exclusão de uma conta comum não desconecta o remetente central e não apaga cópias em backups externos. A desconexão administrativa exige o worker em execução para revogar o dispositivo. Revogue o dispositivo em Aparelhos conectados se necessário e mantenha uma política de retenção para backups. Mudança da chave exige migração explícita: substituí-la sem recriptografar torna os dados existentes ilegíveis.

## Auditoria de dependências — 18/10/2026

A auditoria inicial tinha 34 ocorrências (incluindo 2 críticas). Pacotes sem uso foram removidos e correções compatíveis aplicadas; Next.js foi atualizado para 16.4.2. A auditoria final dessa etapa ficou em **9 ocorrências altas e nenhuma crítica**, concentradas na árvore Puppeteer/whatsapp-web.js:

- `extract-zip`: travessia de caminhos/symlinks ao extrair arquivos ZIP.
- `basic-ftp`: consumo excessivo de CPU ao processar listagens FTP.
- Ocorrências propagadas pelos pacotes dependentes (`get-uri`, `pac-proxy-agent`, `proxy-agent`, `@puppeteer/browsers`, `puppeteer-core`, `puppeteer`, `whatsapp-web.js`).

O FastBus usa um Chrome local já instalado e não recebe arquivos ZIP/FTP de usuários para instalar navegadores. Os backups RemoteAuth são gerados pelo próprio navegador, criptografados e autenticados antes de serem reextraídos. Isso reduz a exposição desses caminhos, mas **não elimina as vulnerabilidades da árvore**. Não configure proxies PAC/FTP não confiáveis nem execute downloads de navegador recebidos de usuários.

O `npm audit fix --force` sugeriu downgrade para Puppeteer 19, incompatível com as versões atuais usadas pela integração; esse downgrade não foi aplicado. A integração WhatsApp Web permanece uma dependência com risco residual e requer acompanhamento antes de exposição pública. Reexecute `npm audit` periodicamente; versões e contagens podem mudar.

Fontes da auditoria: [extract-zip — symlink traversal](https://github.com/advisories/GHSA-jmr9-qjv8-65gv), [extract-zip — arbitrary writes](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), [basic-ftp — CPU denial of service](https://github.com/advisories/GHSA-c475-qrg2-pj4r).

## Administração e destinatários

Papéis `user`/`admin` ficam no banco, fora do perfil enviado pelo cliente. Cadastro público não aceita papel administrativo. Somente um comando local de manutenção pode criar/promover administradores; a promoção revoga sessões existentes. A senha inicial gerada é aleatória, armazenada com hash e exige troca antes de liberar a API de QR Code. Conectar/desconectar exige sessão administrativa autenticada, verificação de origem e limite de tentativas; não há confirmação repetida de senha nessa configuração.

Os destinatários são individuais, em formato internacional, com declaração de titularidade e autorização explícita. Somente o dono da conta pode ver/alterar seu número. O worker revalida o opt-in depois da consulta assíncrona ao WhatsApp e antes do envio; a limitação por número usa HMAC e não expõe telefone nos metadados. A ativação exige um código aleatório de quatro dígitos enviado ao próprio WhatsApp. O código expira em dez minutos, aceita no máximo cinco tentativas e não pode ser reutilizado. Pedidos são limitados por conta e número; alterar o destinatário exige nova confirmação. Isso verifica acesso ao número naquele momento, sem comprovar identidade civil. Contatos antigos sem confirmação ficam desativados até verificar.

Não há endpoint de caixa de entrada, leitura de conversas ou mensagens livres; o transporte produz modelos fixos de oportunidade e de diagnóstico solicitado pelo administrador. O teste de mensagem usa o contato confirmado da própria conta e compartilha os limites de envio dos alertas. A biblioteca de WhatsApp Web sincroniza seus próprios dados no perfil do navegador, portanto a restrição da interface não elimina a necessidade de proteger as credenciais e o volume de execução.

## Execução na Vercel

O modo `daily` usa Turso para transações, Blob privado para backups criptografados e Sandbox com prazo máximo de 200 segundos. O snapshot de execução é preparado sem segredos ou perfis pessoais; credenciais entram somente na execução. O código encerra o Sandbox em `finally`, e a plataforma também aplica o prazo máximo. Nenhum Daemon é provisionado.

O cron exige `CRON_SECRET` e admite uma execução por dia UTC. Pareamento exige sessão administrativa autenticada e admite até três inícios por dia UTC. Concessões no banco impedem execução concorrente do worker. Os limites da plataforma continuam aplicáveis e podem pausar o serviço.

O pacote enviado à Vercel exclui `.env*`, `data/`, perfis de navegador e temporários. O backup criptografado é publicado no Blob antes de atualizar a referência no banco; versões substituídas são removidas depois. A exclusão de uma versão antiga pode falhar após a atualização: nesse caso, o objeto permanece privado e criptografado e requer limpeza posterior. Não registrar URLs com tokens, QR ou conteúdo de sessões.

O desafio armazena hash com HMAC vinculado à conta, ao número e ao identificador da solicitação; o código de envio fica criptografado somente enquanto está na fila e é removido antes da transmissão. Falhas não provocam repetição cega da mesma mensagem. Pedidos pendentes podem expirar se o remetente estiver desconectado; a interface permite solicitar outro código. Nunca confirmar um contato lendo o segredo no banco.

## Correções de 30/10/2026

Zod da API atualizado para 4.6.7, Next.js para 16.4.3 e Puppeteer para 25.16.0. Persistem avisos transitivos em bibliotecas de terceiros, incluindo Zod 3 em SDKs, extract-zip e basic-ftp; a atualização direta não elimina essas dependências. Não foram aplicados overrides de versões incompatíveis nem downgrade forçado de Puppeteer. A exploração desses avisos não foi testada. O corpo JSON continua limitado a 16 KiB e os navegadores executam em Sandbox temporário.

Recuperação: código de uso único, com HMAC e prazo de dez minutos, até cinco tentativas por desafio, limite por conta e global. A confirmação substitui o hash da senha e revoga sessões. O operador pode executar `npm run admin -- email@exemplo.com --reset-password` em ambiente administrativo confiável; esse comando gera senha temporária, exige troca e preserva o papel da conta. Não foi executado para contas reais nesta alteração.
