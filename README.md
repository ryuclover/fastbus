# FastBus

O FastBus busca passagens de ônibus por rota, data e preço. Você pode comparar as ofertas na hora ou salvar os critérios para receber um aviso no WhatsApp quando o monitoramento encontrar uma opção compatível.

[Abrir a busca](https://fastbus-five.vercel.app/buscar) · [Painel de alertas](https://fastbus-five.vercel.app/) · [Guias de implementação e testes](melhorias/README.md)

## Da busca ao alerta

1. Em **Buscar**, escolha origem, destino, período, teto de preço e benefício. Cada fonte tem seu próprio resultado. Se uma delas bloquear a consulta, as ofertas já obtidas continuam disponíveis.
2. Revise o preço e os terminais. O teto considera o total quando a fonte o informa. Quando só há uma cotação, confirme as taxas e o valor final na emissão.
3. Salve os critérios como monitoramento. No painel, confirme o seu número com o código recebido pelo WhatsApp. O remetente é central e o pareamento é administrado separadamente.
4. Confira a cobertura e a última consulta no painel. Na configuração Vercel do repositório, o cron roda **uma vez ao dia, às 12h UTC**. Uma rodada consulta uma combinação de fonte e data. Uma janela de 14 dias pode ter cobertura parcial.

### Busca manual

![Busca manual do FastBus com critérios de viagem, cobertura por fonte e resultados de demonstração](docs/screenshots/fastbus-search.png)

### Painel de monitoramento

![Painel do FastBus com rota salva e configuração do contato de demonstração](docs/screenshots/fastbus-dashboard.png)

As capturas usam dados fictícios. Veja também a [busca no celular](docs/screenshots/fastbus-search-mobile.png) e o [diagnóstico administrativo](docs/screenshots/fastbus-admin.png).

## Como executar

No computador ou servidor, rode a aplicação e o worker com SQLite. Na nuvem, a aplicação pode usar Turso na Vercel e acordar o Daytona para o WhatsApp. A API e a fila mantêm o controle dos destinatários e das tentativas. [Arquitetura Vercel](docs/vercel-architecture.md) · [WhatsApp no Daytona](docs/daytona-whatsapp.md)

## Rodar localmente

Requisitos: Node.js 22.17+ e Chrome/Chromium instalado. A aplicação web e o worker precisam acessar **o mesmo diretório de dados e a mesma chave**.

```sh
npm ci
npm run setup
npm run dev
```

Em outro terminal, na mesma pasta:

```sh
npm run worker
```

Abra `http://localhost:3000`, crie sua conta, salve um monitoramento e preencha **Número esperando o contato do FastBus** com o código do país, DDD e número (ex.: +55 11 99999-9999). Confirme que o número é seu e ative o recebimento. O WhatsApp conectado é o número central do serviço; usuários comuns não leem QR Codes.

`npm run setup` gera `.env.local` com uma chave aleatória e procura o navegador instalado. Não sobrescreve configurações existentes. Se necessário, ajuste `WHATSAPP_CHROME_PATH` com o caminho completo do executável. Depois de criar as contas necessárias, altere `FASTBUS_ALLOW_REGISTRATION=false` e reinicie a aplicação.

**Não perca `FASTBUS_DATA_KEY`.** Ela é necessária para ler os dados e backups de sessão. Não compartilhe `.env.local`; guarde sua cópia separada do banco, em local seguro. `APP_ORIGIN` deve coincidir exatamente com o endereço usado no navegador, inclusive porta. `localhost` e `127.0.0.1` são origens diferentes.

## Administração e QR Code

O cadastro comum sempre cria uma conta `user`. Não há promoção para administrador pela API ou pelo navegador. Em um terminal confiável no servidor, promova uma conta existente:

```sh
npm run admin -- seu-email@exemplo.com
```

Para criar um acesso administrativo novo com senha inicial aleatória:

```sh
npm run admin -- admin@fastbus.local --create
```

A senha inicial só é mostrada na execução desse comando, fica armazenada como hash e deve ser trocada no painel **Conta**. Todas as sessões são encerradas na troca; entre novamente para abrir `http://localhost:3000/admin`. A promoção de uma conta existente também revoga as sessões antigas e preserva sua senha atual. Não há senha padrão no código.

Na administração, clique em **Gerar QR Code do FastBus**. No celular do número remetente, abra WhatsApp → Aparelhos conectados → Conectar um aparelho e escaneie o QR. Apenas administradores que já trocaram a senha inicial podem acessar esse código e conectar/desconectar a sessão. O QR expira em um minuto e é renovado pelo WhatsApp Web. Não há disparo manual de texto livre nesta área.

Cada usuário salva somente o próprio número de recebimento em formato internacional. O número é criptografado; o worker consulta se ele existe no WhatsApp e confere novamente o contato/consentimento antes de enviar. A ativação exige o código de quatro dígitos recebido no WhatsApp. Alterar o número exige nova confirmação. Números não registrados resultam em falha de envio, sem tentar encaminhar a grupos ou outros destinos.

A migração para esse modelo desativa as antigas sessões individuais e não as reutiliza como remetente do serviço. O administrador precisa parear o número central. A permissão administrativa é conferida no banco em cada requisição e o QR nunca é retornado pela API do usuário comum.

## Como o monitoramento funciona

- Até 10 monitoramentos por conta, até 7 datas consecutivas por monitoramento, com antecedência máxima de um ano.
- Uma combinação de fonte e data por vez, em rodízio. O intervalo configurado, de 30 minutos a 24 horas, é **entre combinações**, não entre varreduras completas. Sete fontes e sete datas exigem 49 consultas para completar uma rodada.
- Um único worker por banco, protegido por lease renovável. Trabalho e progresso sobrevivem a reinícios. O worker precisa continuar ligado; fechar o navegador não interrompe as buscas.
- Pausa global variável de 5 a 7 minutos entre consultas à mesma fonte. Cada consulta tem limite de 8 requisições HTTP, espaçadas por uma pausa sorteada de 4 a 8 segundos, aumentada até 15 segundos quando a fonte responde lentamente, e prazo total de 90 segundos. O intervalo do monitoramento recebe até 10% de tempo adicional (limitado a 5 minutos), sem antecipar o mínimo escolhido. O timeout de rede começa após a espera na fila. Não há repetição imediata de requisições.
- Respostas 401/403/429/503 interrompem a fonte; `Retry-After` é respeitado. Falhas aumentam a pausa de 15 minutos até 24 horas. Reduzir frequência não garante acesso nem substitui a autorização da fonte.
- É salvo no máximo um novo alerta por combinação consultada: a melhor oferta elegível. A mesma oferta só gera outro aviso após uma queda de pelo menos 3%.
- Sem confirmação, preço numérico ou link HTTPS de uma fonte permitida, não há alerta. ID Jovem exige indicação explícita do benefício e vagas disponíveis; link de encaminhamento não é confirmação.
- Alertas ficam em uma fila persistente quando o WhatsApp está desconectado. Falhas anteriores à transmissão têm até seis tentativas. Se o resultado da transmissão ficar incerto, o painel orienta a conferir o WhatsApp e a fila suspende a repetição automática. Avisos com mais de 24 horas ou data passada expiram. Há limite persistente de um envio por minuto por conta e por número destinatário, e intervalo global de pelo menos 5 segundos entre envios.
- Pausar uma rota pausa consultas e envios. Editar critérios cancela avisos pendentes antigos. Excluir a rota apaga seu histórico. Ao acabar o período, ela é desativada.

## Proxies das consultas

O worker aceita um conjunto opcional de proxies HTTP/HTTPS com túnel CONNECT. Configure somente no servidor, em `.env.local`, e reinicie o worker:

```dotenv
FASTBUS_PROVIDER_PROXY_URLS='["http://usuario:senha@proxy.exemplo:8080","https://outro-proxy.exemplo:443"]'
```

O exemplo é ilustrativo: não fornece servidores reais. Caracteres especiais nas credenciais devem ser codificados como componentes de URL. São aceitos até dez endereços. Sem a variável, a conexão continua direta. Configuração inválida impede a inicialização e não imprime as credenciais.

O rodízio ocorre entre consultas; todas as requisições de uma consulta usam o mesmo proxy. Os limites e pausas da fonte continuam globais para todos os IPs. Falha do proxy não tenta conexão direta nem troca de IP durante a consulta. Login, dados da aplicação e WhatsApp não passam por esse mecanismo; não configure VPN global no sistema para obter esse isolamento.

Uma extensão de VPN do Chrome não fornece automaticamente um proxy utilizável pelo Node.js. Instalar a extensão no navegador pessoal não altera as consultas do worker. Para usar uma VPN com gateway HTTP, mantenha o gateway ativo em ambiente separado (por exemplo, outra máquina ou VM) e restrinja o acesso ao worker por firewall. Se usar o mesmo computador, é necessário verificar o roteamento/split tunneling: ativar a VPN do sistema pode alterar também o tráfego do WhatsApp e da aplicação, independentemente deste código. Proxies externos devem ser serviços de confiança: recebem metadados de destino e volume; os certificados HTTPS continuam sendo verificados.

As pausas variáveis reduzem a regularidade das consultas, mas não garantem acesso. O ClickBus possui um transporte próprio por navegador, descrito abaixo. Não há resolução automática de CAPTCHA ou garantia de desbloqueio. O teste inicial de localizações fica em `docs/diagnostics/vpn-clickbus.json`; a validação posterior de cotas está no relatório específico de ID Jovem.

## ClickBus com Browsec

O transporte validado lê o fluxo público normal do site, sem reproduzir os cabeçalhos fixos do cliente HTTP antigo. Configure no servidor:

```dotenv
CLICKBUS_TRANSPORT=browser
CLICKBUS_BROWSER_PATH="C:/caminho/para/chromium/chrome.exe"
CLICKBUS_BROWSEC_EXTENSION_PATH="C:/caminho/para/browsec-oficial-extraido"
CLICKBUS_BROWSER_HEADLESS=false
```

A validação foi feita em Windows com Chromium visível que permite extensões locais e a versão oficial do Browsec, sem conta pessoal. Chrome instalado comum pode não aceitar extensões locais por flags; use um Chromium compatível. Os arquivos da extensão não são distribuídos pelo repositório. O perfil fica em `FASTBUS_RUNTIME_DIR/clickbus-<país>`, separado do remetente WhatsApp, e não deve ser usado para login pessoal. A inicialização conecta aos EUA por padrão; com `CLICKBUS_FREE_VPN_ROTATION=1`, alterna as quatro localizações gratuitas em janelas de seis horas. Confirma o país sem armazenar IP e recusa chamadas se o proxy da extensão estiver desativado. Não há troca de IP como reação a bloqueio nem fallback direto. O modo headless requer validação própria.

O navegador compartilha o orçamento de oito chamadas de mercado, espaçamento adaptativo de 4 a 8 segundos (até 15 segundos em fontes lentas) e prazo total de 90 segundos. Recursos normais da página não entram nesse contador; as páginas auxiliares de cotas bloqueiam scripts e subrecursos. O worker continua precisando de um ambiente persistente e de acesso ao Chromium. `FASTBUS_PROVIDER_PROXY_URLS` controla o transporte HTTP dos outros provedores; não configura a extensão.

Para uma observação isolada, após a pausa global:

```sh
npm run map:clickbus -- 2026-11-18
```

Escolha uma data futura. O comando reserva a fonte no mesmo banco do worker, não envia WhatsApp, não seleciona poltronas e não exporta cookies ou cabeçalhos assinados. Uma falha não sobrescreve o mapeamento validado com um arquivo vazio. O antigo `cli.ts` usa esse mesmo fluxo limitado.

## Contas e dados

Nome, e-mail, número destinatário, critérios de viagem, alertas, QR Code e backups de WhatsApp são criptografados com AES-256-GCM. Senhas usam scrypt com sal aleatório; tokens de sessão são aleatórios e somente seu SHA-256 é persistido. O índice de e-mail usa HMAC. IDs, horários, contadores e estados operacionais são metadados em texto; o arquivo SQLite inteiro não é criptografado.

O cookie de sessão é HttpOnly/SameSite=Strict e usa Secure/prefixo `__Host-` em produção. A sessão expira em 7 dias. Todas as operações autenticadas restringem o acesso ao usuário proprietário. Escritas validam a origem, o tipo, tamanho e esquema do corpo; o login tem limites persistentes globais e por conta, sem confiar em IP informado em cabeçalhos pelo cliente.

O painel permite trocar senha, encerrando todas as sessões, ou excluir a conta com confirmação da senha. A exclusão remove o usuário, seu contato e seus monitoramentos/histórico por cascata. A sessão central do FastBus é independente e continua atendendo outras contas. O último administrador deve desconectar o remetente antes de excluir sua própria conta. Backups externos do servidor têm seu próprio prazo de retenção. Não há recuperação de senha por e-mail nem autenticação de dois fatores nesta versão.

Não coletamos CPF, documentos, NIS, passaporte ou dados bancários. A conta de e-mail não é validada por envio de mensagem nesta versão.

## WhatsApp e operação

O worker local usa [whatsapp-web.js](https://wwebjs.dev/) com [RemoteAuth](https://wwebjs.dev/guide/creating-your-bot/authentication.html) e armazenamento criptografado dos arquivos de sessão no SQLite. O primeiro backup ocorre aproximadamente um minuto depois da autenticação. O navegador precisa manter arquivos **descriptografados enquanto está ativo**: use um volume privado criptografado (ou tmpfs no Linux), com ACL/permissões limitadas ao usuário do serviço. `FASTBUS_RUNTIME_DIR` controla essa pasta. A limpeza de perfis órfãos acontece quando o worker volta a executar.

Essa biblioteca não é a API oficial do WhatsApp. Mudanças no WhatsApp Web podem exigir manutenção e novo pareamento. O recebimento real depende de pareamento pelo QR Code e conectividade; o envio não foi validado com uma conta real no desenvolvimento desta refatoração. Quando o processo cai durante a transmissão, a reserva expirada fica com resultado incerto na próxima execução. Confira o recebimento no aparelho.

O worker mantém um único navegador do WhatsApp Web do serviço. Não há acesso a conversas, caixa de entrada nem endpoint para mensagens livres. Alertas e mensagens fixas de diagnóstico são limitados ao contato autorizado e confirmado da conta; códigos de confirmação e recuperação seguem seus próprios fluxos. Esta versão destina-se a uso pessoal ou pequeno grupo em um servidor, não a um serviço público de grande escala.

## Fontes existentes

Os adaptadores de ClickBus, Guanabara, Buser, Gontijo, Embarca, Águia Branca e Mobifácil foram preservados. Eles dependem das respostas externas e não são garantia de cobertura ou disponibilidade. Gontijo não confirma vagas automaticamente. Águia Branca não confirma cotas de ID Jovem; esse modo não gera alertas nesta fonte. Buser não consulta ID Jovem e seu fallback por navegador foi desativado no worker; dados ausentes resultam em pausa, sem tentar contornar bloqueios. Nem todas as fontes retornam dados verificáveis em toda rota.

A validação de ID Jovem no ClickBus tem [relatório específico](docs/diagnostics/clickbus-id-jovem.md), comparação da tela em três datas e uma coleta real com cinco ofertas confirmadas. O leitor exige quantidade, tarifa e confirmação do fluxo online, consultando candidatas em pequenos lotes sequenciais. Solicitação manual de benefício não é vaga confirmada. O limite de preço para essas cotas se refere à tarifa; taxas e valor final precisam de confirmação na emissão. A amostra validada foi Rio–São Paulo, não todas as rotas do país.

As rotas públicas antigas `/api/buscar` e `/api/provedor/[id]` retornam HTTP 410. Scripts antigos de inspeção e capturas de FastTravel são referências históricas e não fazem parte do fluxo FastBus. Não use o antigo daemon como segundo worker.

## Produção em servidor persistente

```sh
npm ci
npm run build
npm start
# Em outro processo supervisionado:
npm run worker
```

Use um servidor persistente com disco local, HTTPS e gerenciamento de processos. Não hospede o worker em funções serverless de curta duração. SQLite e o navegador exigem armazenamento persistente e a mesma chave entre os dois processos; não compartilhe o SQLite por NFS nem execute workers em réplicas independentes.

Configure `APP_ORIGIN=https://seu-dominio`, feche o cadastro, execute como usuário sem privilégios e restrinja o acesso ao volume de dados. Use o sandbox padrão do Chrome; não é necessário `--no-sandbox`. Não exponha a porta de depuração do navegador. Faça backups consistentes do SQLite e guarde a chave separadamente. O banco usa WAL; copiar apenas o `.sqlite` em execução pode perder alterações.

Veja [SECURITY.md](SECURITY.md) para os limites conhecidos, incluindo a auditoria de dependências.

## Verificação

```sh
npm run typecheck
npm test
npm run build
npm run format:check
# Com o build pronto e Chrome instalado:
npm run test:e2e
# Com o site local ativo na URL de FASTBUS_TEST_URL:
node scripts/verify-ui.mjs
node scripts/verify-search-ui.mjs
```

Os testes de domínio/API usam um banco temporário e cobrem isolamento, cookies, senhas, criptografia, bloqueios, agendamento e fila de envio com transporte simulado. A verificação visual usa APIs simuladas e não acessa WhatsApp nem fontes reais. Capturas FastBus ficam em `docs/screenshots/fastbus-*.png`.

## Verificações pela administração

Em `/admin`, a seção **Está tudo funcionando?** mostra o banco, o backup do WhatsApp, seu destinatário, a fila da sua conta e o último resultado dos buscadores. O estado salvo não é uma prova de conexão ao vivo: use os botões para executar verificações reais.

- **Verificar conexão** abre a sessão já salva e verifica se o WhatsApp fica pronto, sem enviar mensagem.
- **Enviar mensagem de teste** envia um texto fixo identificado como teste somente ao número confirmado e ativo da conta administrativa. O resultado confirma a aceitação pelo WhatsApp; confira o recebimento no celular. Não há texto ou destinatário livre.
- **Testar buscador** consulta uma fonte e uma data de um monitoramento ativo da sua conta. Usa o mesmo transporte, orçamento e pausa global do monitoramento. Não reserva passagens, não gera alertas nem avança o cursor da rota.

`GET /api/admin/diagnostics` consulta o estado; `POST` na mesma rota inicia uma verificação com `kind` igual a `whatsapp`, `message` ou `provider`. O teste de fonte exige também `monitorId` e `provider`. As duas operações exigem sessão administrativa com senha inicial já alterada; POST valida a origem e não aceita telefone, URL ou mensagem arbitrária.

Os trabalhos ficam persistidos, com histórico de 30 dias e prazo de cinco minutos. Falhas de envio ambíguas não são repetidas automaticamente. A API limita três solicitações por conta a cada 15 minutos e uma pendente por conta. No modo Vercel, há até três execuções de diagnóstico por dia para o serviço, separadas da rotina diária e sujeitas às cotas da plataforma. No modo local, mantenha o worker ligado. As verificações só ocorrem ao clicar nos botões; abrir o painel não envia mensagens nem consulta fornecedores.

## Diagnóstico da conexão

Se o QR não aparecer, a administração mostra a falha e o horário da próxima tentativa. Use **Tentar conexão novamente** para iniciar uma tentativa sem esperar a pausa anterior. A abertura tem prazo máximo e recupera recarregamentos do WhatsApp Web.

No Windows, o perfil ativo usa o caminho curto `data/runtime/sender/RemoteAuth-fastbus` (ou a raiz definida em `FASTBUS_RUNTIME_DIR`), evitando falhas de IndexedDB por caminhos profundos. O backup criptografado continua no SQLite. Não coloque a pasta de execução em caminhos longos ou unidades sem acesso de escrita para o navegador.

Para verificar somente metadados de estado, sem imprimir QR Code nem credenciais:

```sh
node scripts/diagnose-whatsapp.mjs
```

## Execução diária na Vercel

A configuração em nuvem usa Vercel e Turso, com Sandbox para buscas e opção de Daytona para o WhatsApp. Uma execução diária verifica uma combinação de rota/data/fonte; monitoramentos se alternam entre execuções. O WhatsApp abre para parear ou enviar e salva a sessão criptografada. Veja [arquitetura e configuração](docs/vercel-architecture.md).

### Confirmação de WhatsApp e datas móveis

Ao informar o destinatário, solicite o código de quatro dígitos e digite no site o valor recebido no WhatsApp. Os avisos só ativam após confirmar. Código válido por dez minutos, até cinco tentativas e até três solicitações por hora por conta e número. Na Vercel, envios de confirmação usam execuções limitadas separadas (até dez inícios diários globais), sujeitos às cotas gratuitas. O remetente precisa estar pareado no painel administrativo.

Em Período de busca, escolha **Sempre os próximos 14 dias** para uma janela que avança diariamente e não encerra sozinha. Pausar ou excluir interrompe o monitoramento. A opção não muda a frequência do plano: no Hobby atual, há uma execução diária para uma combinação de fonte e data.

### Operação e recuperação de acesso

O painel informa último sucesso, diagnóstico da última tentativa e cobertura real de fonte/data nas últimas 24 horas. A janela móvel usa datas de calendário ancoradas, evitando o salto provocado pelo avanço simultâneo do relógio e do cursor. Isso não amplia a frequência do plano gratuito nem varre todas as datas em cada execução.

A fila remove avisos vencidos e ignora destinatários não confirmados antes de procurar envios elegíveis. Processa mais de um item dentro do prazo de execução e retoma após a confirmação do telefone. Pedidos de envio aguardam brevemente um worker ocupado; ao esgotar o prazo, a confirmação apresenta falha e permite solicitar outro código.

Na tela de login, **Esqueci minha senha** envia um código ao WhatsApp já confirmado. Sem número confirmado, o operador pode gerar uma senha temporária com `npm run admin -- email@exemplo.com --reset-password` usando a configuração do banco correto. Nunca disponibilize esse comando como endpoint público.

A imagem Linux inclui D-Bus, Xvfb e bibliotecas gráficas. A extensão é resolvida relativamente ao diretório de execução (`browsec`), pois o caminho absoluto varia por imagem. O modo padrão mantém a extensão configurada; `CLICKBUS_NETWORK_MODE=direct` é opcional para conexão normal. Nenhum modo alterna identidades automaticamente após bloqueio.

### Correção da restauração do remetente

A configuração do remetente usa a sessão administrativa já autenticada, sem pedir a senha novamente. As restrições de administrador, origem e frequência continuam ativas.

O backup final fecha o Chromium sem logout para gravar Local Storage e IndexedDB antes de arquivar o perfil completo do navegador isolado. Caches e locks são excluídos. Arquivos de autenticação obrigatórios são validados antes de substituir o backup anterior. Backups antigos incompletos exigem um novo pareamento; não podem ser reconstruídos a partir dos dados ausentes.

Uma nova sessão respeita o período inicial de estabilização. Ao encerrar, uma execução que voltou ao QR fica com diagnóstico de restauração pendente, em vez de aparecer como sessão salva apenas porque havia um arquivo antigo.


A política atual, as melhorias de espera e a pesquisa de alternativas estão em [Cuidados do scraper](docs/scraper-care.md).
