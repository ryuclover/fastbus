# WhatsApp sob demanda no Olympus Cloud

O painel e os buscadores continuam na Vercel. `FASTBUS_WHATSAPP_RUNTIME=daytona` direciona pareamento e envio para o sandbox existente, identificado por `DAYTONA_SANDBOX_ID`. A chave `DAYTONA_API_KEY` fica nas variáveis privadas da Vercel e na configuração local ignorada pelo Git. O código não cria sandboxes, altera plano, recarrega créditos ou modifica a regra de desligamento por inatividade do usuário.

## Divisão de responsabilidades

- Vercel: Turso, contas, contatos, consentimento, códigos de confirmação, fila, regras de envio, limites e concessões exclusivas.
- Olympus: Chromium, LocalAuth e operações limitadas de WhatsApp (`state`, `number`, `send`, `checkpoint`, `stop`). Não existe operação SQL, shell ou URL arbitrária no canal.
- O Olympus não recebe token Turso, chave de criptografia nem token Blob. Recebe uma chave aleatória por execução e os dados das operações autorizadas pelo backend.
- O canal temporário usa HTTPS do preview Daytona mais autenticação Bearer própria, inclusive se o workspace já tiver previews públicos. A chave não é enviada ao frontend. QR fica em memória no Olympus, é obtido pelo backend e armazenado criptografado no FastBus; não é impresso em logs.
- Toda mensagem passa pelas mesmas funções de consentimento e limite de alertas/confirmacoes no backend. A perda da concessão do worker bloqueia novas operações de envio.

Essa separação permite usar os serviços oficialmente permitidos pelo Daytona (Vercel e WhatsApp) sem uma conexão direta entre Olympus e Turso. Não existe proxy ou túnel para o banco. A API oficial recusou alterar a rede do sandbox por restrição da organização; a configuração original foi preservada.

## Execução e persistência

Dependências fixadas ficam em `/home/daytona/fastbus`. Chromium e Xvfb já estavam instalados. O build gera `.fastbus-cloud/daytona-whatsapp.cjs`, que é enviado pela API em cada execução. Um processo protegido por `flock` e prazo máximo de 185 segundos executa o canal na porta 30377, com autenticação por chave aleatória de 256 bits. A Vercel espera até aproximadamente três minutos, sob seu prazo total de função. O canal aceita até 10 operações de envio e não repete uma operação com o mesmo identificador, mesmo se o primeiro resultado for ambíguo.

O perfil LocalAuth inteiro fica em `/home/daytona/.fastbus/whatsapp/session-fastbus`, dentro de diretórios privados. O navegador fecha graciosamente antes de registrar a sessão como salva. Após um QR novo, aguarda ao menos 60 segundos para a sincronização inicial. `ready` não é prova de persistência ou entrega. A vinculação `daytona:<sandbox>` no banco evita tratar o ZIP antigo como perfil do Olympus. Desconectar no painel revoga a vinculação; o próximo pareamento limpa o perfil anterior antes de abrir o navegador.

Se o FastBus acordou o workspace, solicita a parada em `finally`, inclusive após falha. Se já estava ligado, fecha somente seu processo e preserva a regra existente de parada por inatividade (20 minutos na verificação inicial), para não encerrar deliberadamente um SSH já em uso. A persistência ainda depende do lifecycle e das condições da conta Daytona.

As consultas de passagens continuam no runtime Vercel anterior com `FASTBUS_QUERY_ONLY=1`, sem abrir o perfil do Olympus. Havendo mensagens pendentes após uma consulta, o backend tenta enviá-las no orçamento restante da função. O cron permanece diário. Não há promessa de monitoramento contínuo.

## Verificação

SSH e API do workspace existente validados. Teste real no Olympus preservou cookies, Local Storage e IndexedDB entre dois processos Chromium com dados artificiais. O canal temporário real respondeu com autenticação e encerrou sem WhatsApp ou banco. Testes verificam autenticação de todas as operações, rejeição de entradas fora do protocolo, limite e deduplicação de envio ambíguo, ausência de credenciais do banco no processo e preservação de um workspace já ativo. A validação real do WhatsApp requer leitura do QR e teste de entrega após reinício; não deve ser declarada concluída por esses testes artificiais.

`FASTBUS_DAYTONA_NETWORK_BLOCKED=1` é uma pausa de operação. Só deve ser removida na publicação da nova divisão de responsabilidades validada. A conexão direta ao Turso foi rejeitada com ECONNRESET, enquanto npm respondeu 200 e WhatsApp 302. A nova arquitetura não usa essa conexão.
