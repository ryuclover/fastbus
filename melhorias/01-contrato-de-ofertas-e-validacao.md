# Contrato de ofertas e validação dos provedores

Prioridade: **P1**. Status: **concluído localmente em 04/11/2026**.

## Contrato entregue

As consultas passam pelo registro em `lib/services/provedores.ts`. O serviço valida a saída e acrescenta a cada oferta a evidência v1 definida em `lib/scrapers/types.ts`. Busca manual, monitoramento e comparador de intervalo consomem esse registro. Os endpoints antigos desativados continuam retornando HTTP 410.

| Fonte        | Entrada e validação                                                                                                | Evidência comercial disponível                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ClickBus     | Lista de viagens e segmentos validada antes da conversão. HTTP e navegador usam o mesmo conversor.                 | ID da viagem e terminais quando informados, trecho único e cotas por categoria verificadas na página da viagem. Conexões com várias partes entram como inconclusivas. |
| Guanabara    | Lista de serviços e mapa de assentos validados separadamente.                                                      | ID da rota, localização informada, partida com deslocamento explícito quando presente, tarifa, taxa de embarque e total discriminados quando conhecidos.              |
| Embarca      | API e conteúdo SSR passam pelo mesmo schema de viagens e cotas.                                                    | ID quando disponível, preço publicado, preço da categoria e vagas retornadas. O comparador e o monitor usam o identificador canônico Embarca.                         |
| Mobifácil    | O parser valida a estrutura lsServicos e cada serviço.                                                             | Preço comercial em BRL e cobertura parcial quando algum serviço é rejeitado.                                                                                          |
| Buser        | As capturas de preço e horários dos cartões HTTP e do navegador são verificadas antes de gerar ofertas comerciais. | Cotação do vendedor. Classe desconhecida continua ausente.                                                                                                            |
| Águia Branca | Cartões HTML ou entradas do dataLayer passam pela validação de preço e horário disponível.                         | Preço, classe e horários presentes na página e SKU quando fornecido pelo fallback.                                                                                    |
| Gontijo      | O adaptador produz orientação manual e o registro valida o envelope.                                               | O destino da consulta é o portal do provedor.                                                                                                                         |

O identificador da oferta é uma impressão digital da cotação normalizada. O ID nativo da viagem fica em um campo separado. O consumidor pode identificar a observação pela impressão digital e pelo instante da coleta. Terminais, segmentos, parcelas de preço e evidência de cota têm valor nulo quando a fonte não os informa.

O prazo superior de uso segue a política existente de 24 horas e termina antes se houver partida conhecida. Horários locais são resolvidos com a zona da origem para o catálogo atual. Um horário desconhecido ou ambíguo continua sem instante de partida. O prazo indica o limite de uso pelo FastBus. O vendedor pode mudar preço ou estoque antes dele.

A busca manual salva a evidência, o resultado da consulta e os contadores no JSON criptografado. O alerta inclui a evidência e a fila verifica sua validade. A página apresenta o instante da consulta e indicação de vencimento. Registros históricos usam seus campos originais e não recebem uma origem ou uma idade inventada. A reversão de código é compatível com os campos aditivos, sem migração SQL.

## Verificação de aceite

A suíte completa passou com 126 testes, zero falhas e zero ignorados. A verificação de tipos da aplicação e do worker e o build de produção passaram. O build registrou os avisos de dependências dinâmicas de WhatsApp e Daytona. A entrega está no checkout local.

Os testes de contrato cobrem preço zero, campos extras, valores inválidos, datas incompatíveis, parcialidade e a leitura da evidência persistida. O teste de aquisição exercita as cidades do catálogo, o conversor ClickBus e o comparador de intervalo com uma resposta Embarca parcialmente inválida. A suíte usa respostas simuladas e fixtures do projeto. A disponibilidade atual das empresas continua sendo uma questão operacional dos guias seguintes.

## Contexto e evidências

Os adaptadores compartilham ResultItem, mas faltam identidade da viagem, terminais, instante de coleta e validade. Casts TypeScript e arrays de any não validam o conteúdo recebido. O resultado também mistura disponibilidade com sucesso da consulta.

Pontos de partida no código: `lib/scrapers/types.ts`, `lib/monitoring/query-provider.ts`, `lib/services/provedores.ts`. As linhas são referências da revisão de 04/11/2026 e podem mudar.

## Implementação passo a passo

1. Inventariar os campos recebidos por fonte e separar campos obrigatórios, opcionais e derivados. Usar exemplos sanitizados já disponíveis; marcar hipóteses que ainda exigem confirmação.

2. Definir um contrato normalizado versionado: provider, providerTripId, origin/destination com IDs e terminais, segmentos, departureAt com fuso, observedAt, expiresAt, currency, fareMinor, feesMinor, totalMinor e benefitEvidence. Os nomes são proposta de desenho, não campos existentes.

3. Representar valores desconhecidos explicitamente. Não converter ausência de preço, assento ou classe em zero, disponibilidade ou Convencional.

4. Definir estados independentes para execução e resultado: sucesso vazio, sucesso com ofertas, parcial, bloqueado, falha e consulta manual. Incluir candidatos totais/conferidos/rejeitados e motivo da interrupção.

5. Criar schemas de runtime por provedor na fronteira de entrada. Tolerar campos adicionais, exigir campos críticos e isolar itens inválidos sem esconder a parcialidade. Limitar quantidade de itens e tamanho de texto.

6. Separar funções de transporte, parsing, normalização e regras de negócio. O normalizador deve ser puro, recebendo payload e contexto explícitos, sem chamar rede.

7. Introduzir versão do contrato nos dados persistidos. Ler registros antigos por adaptação explícita; registros sem evidência suficiente não devem ser promovidos a oportunidades confirmadas.

8. Atualizar engine, busca manual, persistência e interface juntos, preservando a compatibilidade durante a migração.

## Testes necessários

- [x] JSON válido com campo crítico ausente deve produzir erro de contrato ou item rejeitado, não oferta inventada.
- [x] Uma oferta válida e outra inválida devem preservar a primeira e sinalizar parcialidade.
- [x] Campos extras não devem quebrar a integração; NaN, Infinity, preço negativo e data inválida devem ser rejeitados.

## Critério de conclusão

Cada oferta publicada tem identidade, origem da evidência e idade verificáveis. Contadores e estados sobrevivem à persistência e não dependem de interpretar mensagens de texto.

## Migração e recuperação

Adicionar campos de forma compatível antes de exigir sua presença; manter leitor da versão anterior durante a transição. Desabilitar somente o adaptador incompatível se a validação revelar mudanças externas.

## Evidência a registrar ao concluir

- Commit e arquivos alterados.
- Comandos executados e resultado dos testes, distinguindo simulação de teste externo.
- Mudanças de esquema/configuração e procedimento de reversão.
- Limitações restantes e métricas observadas, sem credenciais ou dados pessoais.

## Detalhamento de implementação e invariantes

- Receber payload externo como `unknown`; fazer narrowing por schema antes de acessar propriedades. Usar `z.infer` quando o schema for a fonte do tipo para evitar duas definições divergentes.
- Criar uma união discriminada para o resultado; separar `executionStatus` de `coverageStatus`. Uma consulta pode terminar com ofertas válidas e cobertura parcial.
- Definir `null` como desconhecido nos DTOs persistidos; reservar propriedade opcional para compatibilidade versionada. Nunca usar `value || default` para campos onde zero é válido.
- Validar invariantes além do schema: contagens inteiras não negativas, candidatos confirmados menores ou iguais aos examinados e examinados menores ou iguais ao total conhecido. Total desconhecido permanece null.
- Manter DTOs públicos pequenos e serializáveis. Payload bruto sanitizado, se necessário para diagnóstico, tem retenção própria e não é devolvido ao cliente.
- Migrar um adaptador primeiro, cobrindo seu chamador, persistência e renderização; depois aplicar aos demais. Não criar uma segunda implementação permanente do mesmo domínio.

Entrega mínima: schema de entrada por fonte, contrato normalizado, conversão do primeiro adaptador e teste que percorre coleta simulada → persistência → leitura sem perder parcialidade.

Aplicar também o [padrão de código e revisão](13-padrao-de-codigo-e-revisao.md).

[Voltar ao índice](README.md).
