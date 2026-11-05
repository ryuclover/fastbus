# Revisão técnica e de negócio do FastBus

Data: 4 de novembro de 2026. Escopo: checkout local, configuração de execução, consulta do painel publicado e documentação oficial aplicável. Esta revisão gerou documentação e um reprodutor local; não implantou correções de comportamento.

## Parecer

O FastBus já tem uma base útil de busca manual e controles importantes de segurança. A operação de alertas automáticos ainda precisa de garantias de exatidão, cobertura e entrega. A prioridade técnica deve ser fazer uma oportunidade correta chegar ao destinatário dentro do prazo, com estados recuperáveis e uma versão reproduzível do sistema.

Os 109 testes existentes passaram. Um reprodutor adicional confirmou **nove cenários de negócio** que esses testes não impedem. Os resultados reproduzidos usam exclusivamente um banco temporário e transportes simulados, sem consulta aos provedores ou mensagem real. Uma condição reproduzida não significa que já tenha ocorrido um incidente com um usuário real.

Evidências locais:

- `docs/diagnostics/business-rules-repro.mjs`: executável com `node --import tsx docs/diagnostics/business-rules-repro.mjs`.
- `docs/diagnostics/dependency-audit-2026-11-04.json`: saída de `npm audit --omit=dev --json`.
- Configuração: `vercel.json`, `lib/server/cloud-jobs.ts`, `scripts/cloud-worker.ts`.

## Situação operacional observada

Na consulta ao painel em **04/11, 18h29, horário de Brasília**, o banco respondeu, a nuvem estava configurada, mas o painel informou:

- Sessão WhatsApp ainda não salva, estado `error`.
- Destinatário da conta ainda precisa confirmar ou ativar o recebimento.
- ClickBus pausado até **05/11, 14h39**, com falha anterior na configuração da extensão.

Isso é o estado reportado pela aplicação, não uma nova tentativa de conexão ou entrega. Nenhum diagnóstico de envio ou de provedor foi acionado nesta revisão. Para declarar o caminho de entrega operacional, ainda é necessário observar o ciclo completo: pareamento, persistência, encerramento, restauração e mensagem recebida pelo contato confirmado.

## Achados prioritários

P1 significa corrigir antes de confiar no funcionamento autônomo. P2 significa corrigir na próxima etapa de consolidação. Não identifiquei nesta revisão um incidente comprovado de vazamento ou invasão que justifique classificar um P0.

### P1 — Uma tarifa positiva pode receber o rótulo de gratuidade

**Evidência:** `lib/scrapers/guanabara/client.ts:235` utiliza `(t.sub_total ?? 0) <= (t.boarding_fee ?? 0)` para inferir tarifa gratuita. Quando os dois campos faltam, a comparação vira `0 <= 0`, mesmo que `fare` seja positivo.

O reprodutor forneceu `fare: 100`, `total: 100`, classe convencional e cotas de assentos. O adaptador emitiu `id_jovem_100`. A existência de uma cota não demonstra que o preço daquela oferta corresponda à mesma cota.

**Melhoria:** representar ausência como desconhecido; confirmar benefício e preço para a mesma viagem/categoria/assento. Separar tarifa, taxas e total. A gratuidade da tarifa pode coexistir com cobranças permitidas, portanto também é incorreto exigir simplesmente `total === 0` como solução universal.

**Aceite:** tarifa positiva e campos faltantes nunca produzem gratuidade por inferência; taxas conhecidas ficam separadas; benefício sem evidência suficiente aparece como não confirmado.

### P1 — A cobertura permitida excede a capacidade disponível

**Evidência:** `lib/server/cloud-jobs.ts:95` permite no máximo uma execução diária de monitoramento para todo o projeto. `scripts/cloud-worker.ts:142` chama `runOneQuery` uma vez, e o engine retorna depois de uma combinação. Cada conta pode cadastrar dez monitoramentos, com vários dias e fontes.

Um único monitoramento de **sete dias e quatro fontes demanda 28 combinações**. No orçamento atual, seriam necessários 28 dias sem concorrência ou falhas para completar essa quantidade de trabalho. O período de viagem termina em sete dias. Com mais contas e monitores, a cobertura cai ainda mais. A interface já avisa que alterna combinações, mas aceitar o cadastro não torna esse acompanhamento suficiente.

**Melhoria:** definir cobertura prometida e fazer controle de admissão. Exibir quantas combinações serão verificadas antes do fim do período e limitar critérios incompatíveis com o orçamento. Planejar lotes pequenos por prazo da viagem, saúde da fonte e justiça entre contas, mantendo os limites de acesso.

O limite de uma combinação por execução é uma escolha da implementação. O Hobby da Vercel limita a frequência do cron a uma vez por dia e admite disparo dentro da hora especificada; isso não equivale a impor uma única combinação por tarefa. Qualquer aumento precisa ser medido contra CPU, memória, tráfego e créditos reais. [Documentação da Vercel](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

**Aceite:** um monitoramento só é apresentado como atendido quando sua cobertura mínima cabe no orçamento e no prazo. Não ampliar cotas sem medição.

### P1 — Uma fonte pausada pode impedir a alternativa saudável

**Evidência:** `lib/monitoring/engine.ts:207` escolhe o alvo pelo cursor. Ao encontrar a fonte em pausa, adia o monitor inteiro, sem buscar outra combinação elegível da mesma rota.

O reprodutor configurou ClickBus e Guanabara, pausou apenas o ClickBus e observou **zero consultas**, embora a Guanabara estivesse disponível para tentativa.

**Melhoria:** planejar tarefas por combinação, separando o prazo do monitoramento do prazo de cada fonte. Uma falha do ClickBus deve preservar sua pausa e permitir trabalho elegível em outra fonte.

**Aceite:** com uma fonte bloqueada e outra saudável, a saudável pode ser escolhida sem qualquer chamada à bloqueada.

### P1 — A detecção de uma oferta pode impedir seu primeiro aviso bem-sucedido

**Evidência:** `lib/monitoring/engine.ts:149` suprime a mesma oferta pelo histórico de preço. A observação é gravada junto da criação do alerta, antes de sua entrega, em `engine.ts:165`.

Reprodução: uma oferta gratuita gerou alerta; o alerta expirou sem envio; a mesma oferta foi detectada novamente e não gerou novo alerta. Para preço zero, a regra de queda de 3% nunca reabilita a oferta. O problema também pode afetar quem confirma o contato depois da primeira detecção.

**Melhoria:** separar “oferta observada” de “usuário notificado”. Deduplicar notificações bem-sucedidas por uma janela definida, preservando uma tarefa recuperável para alertas ainda não entregues. Revalidar a oferta antes de reenviar uma informação antiga.

**Aceite:** alerta expirado ou falho não é tratado como notificação concluída; reativação de contato tem política explícita de retomada e validade.

### P1 — A validade da viagem considera o dia, mas ignora o horário

**Evidência:** `lib/monitoring/engine.ts:331` expira pela idade da observação ou por `payload.date < today()`. Não compara a partida com o instante de envio. O payload guarda data e texto do horário, sem um instante com fuso.

Reprodução: às 23h30, uma oferta com saída às 00h01 daquele mesmo dia chegou ao transporte simulado. A listagem manual também não possui uma regra comum que elimine partidas já ocorridas.

**Melhoria:** normalizar `departureAt` com o fuso da origem, definir validade por fonte/benefício e verificar o prazo tanto na coleta quanto no envio. Horário ausente deve ser explicitamente desconhecido. A validade não deve ser estendida só porque o item permaneceu na fila.

**Aceite:** nenhuma oportunidade já partida é enviada; fusos e viagens que atravessam a meia-noite são testados; informação antiga recebe estado visível de expiração.

### P1 — Uma confirmação de envio perdida pode causar duplicação

**Evidência:** `deliverOne`, em `lib/monitoring/engine.ts:350`, agenda nova tentativa após qualquer exceção. `lib/server/daytona-transport.ts:126` gera um UUID novo para cada `/send`; a deduplicação do canal está em memória em `lib/monitoring/daytona-protocol.ts:34`.

Reprodução: o transporte simulado aceitou a mensagem e perdeu a confirmação; o engine repetiu a tentativa e terminou como `sent`, com duas aceitações. A proteção do canal evita repetição do mesmo identificador no mesmo processo, mas não resolve outro identificador ou um reinício.

**Melhoria:** propagar uma chave estável ligada ao alerta, registrar intenção/tentativa/identificador da mensagem de forma durável e distinguir erro antes do envio de resultado incerto depois dele. Uma tentativa incerta precisa de reconciliação ou decisão explícita, não repetição automática indistinta.

**Aceite:** testes de queda antes/depois da aceitação, timeout e reinício não geram reenvio cego. Persistir uma chave melhora a proteção, mas não autoriza prometer “exatamente uma vez” sem suporte equivalente do destino.

### P1 — Os horários de nova tentativa não despertam o processamento

**Evidência:** a fila agenda novas tentativas em minutos, mas `vercel.json` contém apenas o cron diário. `runCloudJob` inicia a entrega a partir de uma execução de monitoramento ou de ações específicas da interface. `runDaytonaJob` processa uma rodada de entrega e depois encerra; gravar `next_at` não agenda um novo despertar.

Assim, uma tentativa marcada para daqui a dois minutos pode esperar a próxima execução diária e expirar. A pausa atual do ClickBus ilustra outra consequência: se a pausa termina depois do cron da manhã, a consulta automática pode só ocorrer no dia seguinte ao término da pausa.

**Melhoria:** criar um dispatcher durável que encontre trabalho vencido e desperte o worker dentro de uma política de orçamento. Separar o calendário de coleta do de entrega/recuperação. Caso permaneça estritamente diário, declarar esse prazo e não apresentar o agendamento interno em minutos como garantia de execução.

**Aceite:** demonstrar entrega e recuperação depois de reinício, tarefa ocupada e falha temporária, sem depender de uma aba aberta.

### P1 — Falta um checkpoint versionado da implementação atual

**Evidência:** neste checkout, `git ls-files -- lib/monitoring lib/server app/buscar app/admin tests` não retornou arquivos. O estado contém 30 entradas modificadas, dez excluídas e 67 entradas não rastreadas; o último commit local é `8f36f9c`. As contagens de entradas não equivalem necessariamente a arquivos, pois diretórios podem ser agrupados.

Não é possível associar a implementação local atual inteira a esse commit. A revisão não comparou todas as branches remotas, portanto não afirma que inexista alguma cópia em outro lugar. O risco concreto aqui é não conseguir reconstruir o estado atual a partir do Git deste checkout.

**Melhoria:** revisar o conjunto de mudanças, preservar o trabalho existente, conferir exclusões de segredos/perfis e criar uma base versionada. Ligar teste, build e publicação a um commit identificável. Não adicionar toda a árvore indiscriminadamente.

**Aceite:** um checkout limpo do commit indicado reproduz a aplicação e o worker com instruções documentadas; a implantação informa esse commit.

## P2 — Consolidação das regras e operação

### ID Jovem precisa de um contrato explícito

O esquema aceita Rio de Janeiro → Niterói com `id100`, caso confirmado pelo reprodutor. A regra do programa considera transporte interestadual na categoria convencional; a elegibilidade pessoal e a documentação são verificadas no processo de obtenção/utilização do benefício. [Descrição oficial do programa](https://www.gov.br/pt-br/servicos/obter-a-carteira-de-identidade-jovem).

Validar a compatibilidade da rota, orientar sobre documento válido e modelar a antecedência de reserva conforme a linha e o fornecedor. A referência normativa trata a antecedência em relação ao ponto inicial da linha, não simplesmente ao embarque intermediário. Não implementar um corte universal de três horas sem considerar o restante da regra e as condições de venda. [Decreto 8.537 no acervo da ANTT](https://anttlegis.antt.gov.br/action/ActionDatalegis.php?acao=abrirTextoAto&cod_menu=7155&cod_modulo=161&link=S&numeroAto=00008537&orgao=NI&seqAto=000&tipo=DEC&valorAno=2015).

A aplicação pode informar os requisitos sem coletar NIS, documento ou comprovação de renda. Conta criada, número confirmado, elegibilidade do passageiro e cota disponível são fatos diferentes.

### Estados de busca e saúde estão misturados

- Uma busca com todas as fontes falhas termina em `SEARCH_COMPLETE`, embora as linhas individuais mostrem falha. Reproduzido em `manual-search.ts:269`.
- Uma resposta válida sem viagens e com `disponivel: false` recebe `PROVIDER_PARTIAL`, não um estado de resultado vazio confirmado. Reproduzido em `manual-search.ts:215`.
- `senderReady` em nuvem deriva da presença da sessão e de um estado diferente de erro, não de uma conexão ou entrega verificada naquele instante (`app/api/whatsapp/route.ts:38`).

Separar: execução concluída, cobertura completa, fonte vazia, resposta parcial, bloqueio e falha. Para WhatsApp, mostrar credencial salva, processo dormindo/ativo, última restauração e última mensagem confirmada. Uma sessão salva não comprova recebimento no celular.

### A rotação de VPN repete o país em tarefas diárias

`free-egress.ts` usa janelas de seis horas e quatro países: o ciclo completo dura 24 horas. O cron diário tende a executar na mesma janela todos os dias. O reprodutor obteve `GB, GB, GB` em três dias consecutivos no mesmo horário. Isso demonstra repetição da seleção de país; não comprova qual IP o serviço de VPN atribuirá em cada ocasião.

Se a diversidade entre execuções diárias for necessária, persistir um cursor de saída por execução permitida, mantendo a localização estável durante a consulta e as pausas globais da fonte. Medir sucesso e latência antes de aumentar o uso de VPN.

### Os lotes de candidatos não sobrevivem ao worker efêmero

Os cursores de candidatos do ClickBus e da Guanabara ficam em mapas em memória. Lotes repetidos dentro do mesmo processo alternam candidatos, mas um novo sandbox pode começar novamente pelo primeiro lote. Persistir esse progresso por rota/data/fonte e invalidá-lo quando a lista de viagens mudar, evitando deixar candidatos posteriores sempre sem verificação.

### A interface ociosa consome recursos continuamente

`app/buscar/page.tsx:137` atualiza a lista a cada cinco segundos, mesmo sem tarefa ativa: **720 requisições por hora por aba**. O endpoint lê e descriptografa até oito históricos e executa rotinas de expiração a cada listagem. O custo de acompanhar a tela pode superar o custo das raras buscas.

Atualizar rapidamente só enquanto uma tarefa estiver rodando; reduzir a frequência em repouso e pausar em aba oculta. Separar lista resumida de detalhes e executar manutenção de retenção fora de cada GET. Manter isolamento e cache privado.

### Critérios do alerta e filtros visuais precisam estar claros

Empresa, turno e ordenação são filtros locais dos resultados. “Criar alerta desta busca” transfere `job.config`, que não contém empresa ou turno. Definir quais filtros fazem parte do monitoramento e quais são apenas de visualização, incluindo essa distinção na interface. Editar critérios também precisa reconsiderar `next_at`, para uma rota atualizada não manter um horário antigo inadequado.

### Filas, justiça e orçamento precisam de política comum

Uma conta pode consumir as três rodadas manuais diárias compartilhadas. Pares, diagnósticos, coleta, confirmação e entrega têm limites próprios; alguns usos competem pela mesma trava de execução. Documentar prioridade para confirmação, recuperação e alertas prestes a expirar, seguida de coleta e diagnóstico. Definir regras de admissão para uso pessoal/pequeno grupo e medir consumo por tarefa, sem abandonar os limites da fonte.

### Dependências e runtime precisam de atualização controlada

`npm audit --omit=dev` reportou **20 pacotes afetados: 15 altos, cinco moderados e nenhum crítico**. São seis avisos distintos na saída examinada, propagados pela árvore; não são 20 explorações independentes demonstradas. Há ocorrências na árvore de Puppeteer/WhatsApp e SDKs Vercel, incluindo uma versão transitiva antiga do Zod; o Zod direto do projeto já é 4.6.7.

Avaliar alcance real e opções compatíveis, atualizar com testes e regenerar o snapshot quando suas dependências mudarem. Algumas sugestões automáticas incluem downgrade de versão; não aplicar `audit fix --force` indiscriminadamente. Referências: [Zod e coleções grandes](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [extract-zip e escrita por symlinks](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).

Fixar o major de Node suportado, registrar a versão/hash das dependências do snapshot e comparar isso ao worker compilado. O build usa pacotes externos no worker; atualizar o lockfile da aplicação não atualiza automaticamente os módulos já congelados no snapshot.

### Recuperação e observabilidade

Documentar restauração de banco, chave de criptografia e perfil persistente; verificar retenção e ciclo de vida do Olympus e testar a recuperação. A documentação já reconhece que trocar a chave sem migração perde acesso aos dados. Introduzir identificação de versão da chave quando a rotação for implementada.

Registrar identificadores correlacionáveis de tarefa, coleta, oferta e tentativa de envio, sem tokens ou telefones nos logs. Medir cobertura antes da viagem, percentual de resultados válidos, idade da oferta, tempo até envio e tentativas incertas. “Processo terminou sem exceção” não deve ser a única medida de sucesso.

## Regras mínimas de negócio para estabilizar

| Área         | Regra que precisa ser assegurada                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| Oferta       | Fonte, viagem, data, fuso, benefício e preço devem se referir à mesma opção; campo ausente permanece desconhecido.  |
| Preço        | Tarifa, taxas e total separados; limite do usuário aplicado à base claramente indicada.                             |
| Vagas        | Elegibilidade ou cota nominal não substituem vaga efetivamente disponível.                                          |
| Tempo        | Partida e validade verificadas na coleta e na entrega; regra de reserva do benefício explícita.                     |
| Cobertura    | Critérios aceitos devem caber na capacidade e no prazo, ou informar acompanhamento parcial.                         |
| Fontes       | Uma fonte pausada não bloqueia outra saudável; qualquer IP obedece ao mesmo bloqueio da fonte.                      |
| Alerta       | Observação não equivale a notificação; deduplicação tem janela e estado de entrega.                                 |
| Destinatário | Consentimento e número confirmado revalidados antes do envio; troca de número invalida a confirmação anterior.      |
| Envio        | Resultado incerto é distinto de falha anterior ao envio e de mensagem aceita; recebimento exige evidência adequada. |
| Execução     | Trabalho persistido tem um mecanismo de retomada compatível com `next_at`.                                          |
| Operação     | Estado da aplicação, cobertura e entrega são verificáveis a partir de uma versão conhecida do código.               |

## Ordem recomendada de execução

1. **Exatidão e recuperação:** corrigir classificação de gratuidade, validade por horário, histórico de notificações e tratamento de envio incerto. Converter os cenários do reprodutor em testes que exijam o comportamento correto. Criar o checkpoint Git da base revisada, com exclusão de segredos.
2. **Capacidade e fila:** definir a cobertura mínima para o orçamento gratuito, persistir tarefas por combinação, aproveitar fontes saudáveis e implementar despertar/retomada coerentes com o prazo de entrega. O stack atual pode ser mantido; não é necessário adicionar serviços antes de medir.
3. **Operação demonstrável:** concluir o ciclo real de remetente e destinatário, estabelecer métricas e recuperação, reduzir polling e padronizar estados do painel. Tratar dependências por alcance e compatibilidade e ligar CI/publicação a commits reproduzíveis.

O marco de aceitação deve ser uma rota de interesse real sendo consultada com cobertura conhecida, uma oportunidade corretamente classificada e uma única notificação útil recebida após o ambiente dormir e restaurar. O projeto então terá evidência do fluxo completo, além da evidência de componentes isolados.
