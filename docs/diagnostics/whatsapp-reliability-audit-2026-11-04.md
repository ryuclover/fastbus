# Auditoria de confiabilidade do WhatsApp — 04/11/2026

## Resultado

A conexão e a entrega reais ainda não foram comprovadas. O último pareamento exibiu `ready`, mas não substituiu o backup incompleto anterior. O diagnóstico seguinte terminou com `WHATSAPP_NOT_READY`. A existência de um objeto de backup não comprova que seja novo, completo ou aceito pelo WhatsApp.

Não existe garantia técnica de 100% de disponibilidade ou entrega com um cliente não oficial do WhatsApp Web. A solução precisa detectar falhas, preservar trabalho pendente e mostrar evidências de restauração e entrega. Um teste unitário ou uma tela verde não substitui a validação com os aparelhos reais.

## Evidência coletada em produção

Consultas somente de leitura, sem acessar conteúdo de conversas ou códigos de confirmação. A inspeção do backup foi feita em memória, sem gravar o perfil descriptografado nem exibir suas credenciais.

| Item | Resultado |
| --- | --- |
| Remetente | `desired=1`, `status=error`, `last_error=INITIALIZATION_FAILED` |
| Backup atual | 13.583.982 bytes, 24 entradas |
| IndexedDB | 21 arquivos |
| Local Storage | 0 arquivos |
| Local State | 0 arquivos |
| Network | 0 arquivos |
| Comparação com auditoria anterior | Mesmos totais do arquivo incompleto anterior; sem evidência de substituição por backup completo |
| Processo de pareamento | Código de saída 1, duração 127.992 ms |
| Processo de diagnóstico seguinte | Código de saída 0, duração 158.381 ms; resultado funcional `WHATSAPP_NOT_READY` |
| Concessões de exclusividade ao final | Nenhuma ativa |
| Erro visível nos logs da função | Mensagem genérica de falha de pareamento |
| Logs internos do comando após encerrar Sandbox | API respondeu 410; não foi possível recuperar a exceção original |

As durações mostram que essas duas execuções não chegaram ao timeout de 200 segundos configurado para o Sandbox. Isso não identifica a causa da exceção. Não há evidência suficiente para atribuí-la a logout, conflito, erro de navegador ou encerramento intencional.

## Problemas identificados no código

1. `serviceStatus()` usa principalmente a existência de `backup` e alguns códigos de erro para calcular `sessionStored`. Um erro genérico pode mascarar a invalidez já conhecida do arquivo. Assim, o painel voltou a dizer “Backup salvo” mesmo continuando com o arquivo antigo.
2. `runDiagnostic()` só muda o job para `running` depois de `ready()`. O navegador pode estar tentando restaurar por minutos enquanto a interface diz “Na fila”. O teste realmente executou: a indicação de fila estava errada.
3. O resultado de conexão verifica `ready`, não uma mensagem entregue. O resultado `MESSAGE_SENT` também representa aceite do envio pela biblioteca, e não confirmação de recebimento no aparelho.
4. `runCloudJob()` descarta a saída do comando e resume falhas como `INITIALIZATION_FAILED`. O processo principal também oculta a exceção. É necessário persistir fases e categorias sanitizadas antes de destruir o Sandbox.
5. O sistema cria um Sandbox novo com `persistent:false` por execução. Fecha o navegador e precisa reconstruir o perfil pelo backup em cada envio. Isso aumenta as etapas que podem falhar e não representa uma conexão continuamente aberta.
6. Há um cron diário. Isso limita a frequência de monitoramento e recuperação automática. Não equivale a monitorar continuamente nem a entregar alertas imediatamente.

## Documentação e projetos comparados

### whatsapp-web.js

A [documentação de autenticação](https://wwebjs.dev/guide/creating-your-bot/authentication.html) exige armazenamento persistente para LocalAuth. RemoteAuth precisa de aproximadamente um minuto após o primeiro pareamento para salvar a sessão; o evento `ready` não confirma esse salvamento. O [código de RemoteAuth](https://docs.wwebjs.dev/authStrategies_RemoteAuth.js.html) confirma a dependência de IndexedDB e Local Storage.

A [issue 5781](https://github.com/wwebjs/whatsapp-web.js/issues/5781) relata sessões remotas que não restauram após reinício. A [PR 201957](https://github.com/wwebjs/whatsapp-web.js/pull/201957) propõe preservar a sessão em desconexões transitórias; permanece uma proposta aberta na consulta realizada. Seu autor informa que não validou reinícios com uma sessão real. Não deve ser tratada como correção garantida nem como prova da causa desta instalação.

### WAHA

O [repositório WAHA](https://github.com/devlikeapro/waha) e sua [documentação de armazenamento](https://waha.devlike.pro/docs/how-to/storages/) usam serviço em contêiner com armazenamento de sessão persistente, por volume ou banco compatível. A persistência evita depender de um novo QR a cada inicialização. O desenho é uma referência útil para o FastBus; instalar WAHA, sozinho, não garante disponibilidade ou recebimento.

### Baileys

O [repositório Baileys](https://github.com/WhiskeySockets/Baileys) usa WebSockets em vez de Chromium. Reduz a dependência do navegador, mas ainda requer persistência das credenciais e tratamento de reconexões. Trocar a biblioteca não elimina as dependências do WhatsApp nem comprova que este defeito esteja corrigido. Não recomendo uma migração apressada para tentar dispensar a validação.

### Vercel

As [Functions com Fluid Compute](https://vercel.com/docs/functions/configuring-functions/duration) têm duração limitada; `after()` continua sujeito ao prazo da rota. O Next instalado documenta isso em `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`.

O [SDK de Sandbox](https://vercel.com/docs/sandbox/sdk-reference) distingue comandos bloqueantes e destacados e permite recuperar saída e código de execução. A [documentação de duração e persistência](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence) distingue preservar arquivos de manter um processo rodando. A configuração do FastBus opta explicitamente por não persistir o Sandbox.

A Vercel possui [Daemons](https://vercel.com/daemons) para processos contínuos. A página consultada informa que a versão inicial não inclui filesystem persistente. Portanto, mesmo um daemon exige desenho explícito do armazenamento e verificação de disponibilidade/custo antes da adoção. Não é correto afirmar que a Vercel inteira seja incapaz de executar workers contínuos.

O [cron Hobby](https://vercel.com/docs/cron-jobs/usage-and-pricing) tem restrições de frequência e precisão. O cron diário atual é coerente com uma operação limitada, mas inadequado para prometer acompanhamento contínuo.

## Arquitetura recomendada para continuar usando QR

Manter painel, autenticação e APIs na Vercel. Executar um único worker do remetente em um serviço contínuo com volume persistente, reinício supervisionado e encerramento gracioso. Manter a fila e o histórico fora do processo. Preservar backup criptografado para recuperação, sem transformar cada envio em um ciclo obrigatório de restaurar e fechar Chromium.

Antes de contratar infraestrutura, verificar custo, memória para Chromium, persistência real do disco, política de suspensão e reinício. Nenhum novo recurso pago foi contratado nesta investigação.

O envio deve distinguir: aguardando execução, restaurando, conectado, envio aceito, entrega confirmada, falha e resultado desconhecido. Uma falha após envio ambíguo exige reconciliação antes de repetir, para evitar duplicatas. A confirmação do destinatário permanece pelo fluxo normal de opt-in; não deve ser marcada manualmente para esconder o problema do remetente.

Uma alternativa de produto é a integração oficial da Meta, que dispensa a sessão de navegador. Essa alternativa requer avaliar cadastro, elegibilidade do número, templates e custos. Não foi configurada nem validada nesta investigação.

## Critério de aceitação antes de declarar resolvido

1. Parear uma vez e registrar um backup novo com data, versão e estrutura validada.
2. Reiniciar o processo e comprovar abertura sem QR. Repetir o reinício para excluir sucesso acidental.
3. Solicitar a mensagem de confirmação para o destinatário pelo fluxo normal e concluir com o código recebido pelo titular.
4. Enviar a mensagem fixa de teste pelo mesmo caminho dos alertas e confirmar recebimento no aparelho. Registrar separadamente aceite e entrega.
5. Repetir um envio após reinício, sem novo pareamento.
6. Simular perda de rede, queda do worker e retomada da fila; verificar preservação da sessão e ausência de duplicação automática de envio ambíguo.
7. Validar monitoramento, criação do alerta e entrega no fluxo completo. Testar uma fonte de passagens separadamente não prova entrega por WhatsApp.

## Limites desta investigação

Foi realizada pesquisa, revisão de código e inspeção de produção. Não houve novo pareamento, envio de mensagem, alteração de cotas ou publicação nesta auditoria. A exceção original do comando de pareamento não pôde ser recuperada depois do encerramento do Sandbox. As mudanças propostas acima ainda precisam ser implementadas e validadas; este relatório não declara o serviço pronto.
