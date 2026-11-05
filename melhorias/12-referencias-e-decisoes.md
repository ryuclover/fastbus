# Referências e decisões de implementação

Status: **consolidado e concluído localmente em 04/11/2026**.

## Fontes primárias consultadas nas revisões

- [Playwright: rede](https://playwright.dev/docs/network). Base para aguardar respostas específicas e investigar a interceptação quando há Service Workers. Aplicação: guias 05 e 11.
- [Playwright: Page](https://playwright.dev/docs/api/class-page). A documentação desaconselha networkidle como condição de prontidão; usar condições pertinentes ao fluxo. Aplicação: guia 05.
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html). Semântica de HTTP e Retry-After em segundos e datas HTTP. Aplicação: guia 05.
- [Zod: basic usage](https://zod.dev/basics). Validação em runtime com schemas discriminados e safeParse. Aplicação: guias 01, 03 e 04.
- [Vercel: gerenciamento de cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs). Fonte para agendamento de jobs de monitoramento. Aplicação: guia 07.
- [ID Jovem no Gov.br](https://www.gov.br/pt-br/servicos/obter-a-carteira-de-identidade-jovem). Regras oficiais de elegibilidade, exigência interestadual e transporte. Aplicação: guia 03.
- [Decreto 8.537 no acervo da ANTT](https://anttlegis.antt.gov.br/action/ActionDatalegis.php?acao=abrirTextoAto&cod_menu=7155&cod_modulo=161&link=S&numeroAto=00008537&orgao=NI&seqAto=000&tipo=DEC&valorAno=2015). Reserva de vagas convencionais, cotas de 100% e 50% e precedência. Aplicação: guia 03.
- [Aviso Zod (GHSA-mrhx-c7xc-m3w5)](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) e [aviso extract-zip (GHSA-7pqw-9j4j-h8q3)](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3). Avaliação de integridade de dependências transitivas. Aplicação: guia 11.

## Registro das decisões consolidadas

| Decisão                    | Contexto                                             | Opção adotada                                                                                                                                         | Consequência                                                                                                                    | Critério de revisão                                                                       |
| -------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1. **Cobertura prometida** | Monitoramento contínuo em ambiente serverless.       | Janela deslizante de até 14 dias; avanço determinístico de cursor. Provedores com suporte real comprovado.                                            | Fontes meramente orientativas (ex.: Gontijo) não contam como inventário consultado.                                             | Se provedor orientativo passar a expor consulta pública direta de vagas.                  |
| 2. **Orçamento**           | Prevenção de bloqueios por IP e custos operacionais. | `withRequestBudget` gerencia timeouts pelo deadline restante. Leitura de body com teto de bytes; ritmo adaptativo e respeito estrito a `Retry-After`. | Requisições interrompem imediatamente em caso de desafio (HTTP 200 Cloudflare) ou 403, sem loops de retentativa.                | Se novas políticas de quota forem contratadas junto aos agregadores.                      |
| 3. **Frescor**             | Validade de cotas de assentos e dados de rotas.      | TTL de 6h para mapeamentos de localidade; 24h para ofertas salvas, expirando no instante exato da partida (`departureAt`).                            | Viagens já partidas nunca geram alertas nem notificações, mesmo no mesmo dia da consulta.                                       | Se provedor fornecer webhook de atualização em tempo real.                                |
| 4. **Preço**               | Representação monetária e comparação com tetos.      | Centavos inteiros seguros (`fareMinor`, `feesMinor`, `totalMinor`). Total deve corresponder à soma de tarifa e taxas quando ambas existem.            | O teto informado pelo usuário é comparado com o desembolso total conhecido em centavos. Ausência de campos não vira gratuidade. | Caso novo provedor opere com taxas variáveis pós-carrinho documentadas.                   |
| 5. **Identidade**          | Identificação de viagens, cidades e terminais.       | Cidade e UF normalizadas canonicamente. Terminais suportados explicitamente por nome/ID. Conexões parciais marcadas como incompletas.                 | Eliminação de homônimos errados e garantia de que conexões não anunciem vagas de ponta a ponta sem confirmação.                 | Implementação de algoritmo de junção de itinerários multitrecho.                          |
| 6. **Entrega**             | Envio de mensagens de alerta via WhatsApp.           | Deduplicação por impressão digital por monitor (viagem, benefício, usuário). Estado `in_flight` gravado antes do transporte.                                     | Falha incerta não repete cegamente; número alterado revoga consentimento e exige nova validação por token descartável.          | Se a API oficial de mensagens fornecer recibo de entrega com id de reconciliação reversa. |
| 7. **Despertar**           | Execução autônoma de tarefas de coleta.              | Cron fail-closed com secret. Concorrência controlada por leases atômicas com verificação de dono (`claimWorker`).                                     | Nenhum worker sobrescreve trabalho de outro. Provedores pausados não bloqueiam provedores saudáveis.                            | Adoção de infraestrutura dedicada de mensageria assíncrona.                               |
| 8. **Compatibilidade**     | Ciclo de vida de software, deploy e segurança.       | Schemas aditivos, sanitização de manifests de build (`build-traces.mjs`), suíte com 141 testes sintéticos e tipagem dupla (`tsconfig.worker.json`).   | Deploy seguro no Next.js/Vercel sem vazamento de dados privados ou dependência de rede em testes.                               | Atualização de major do Next.js ou migração de motor de banco.                            |

## Padrão de código complementar

Consultar o [guia 13](13-padrao-de-codigo-e-revisao.md) para tipagem, organização, concorrência, erros e checklist de revisão.

## Práticas comuns a todos os guias

- Preservar desconhecido como desconhecido; não substituir ausência por um valor que confirme oportunidade.
- Registrar evidência de negócio, não apenas sucesso de processo.
- Respeitar bloqueios e pausas independentemente do IP; nenhum guia propõe contornar desafios interativos.
- Preferir mudança pequena, compatível e mensurável antes de trocar a arquitetura.
- Não aumentar chamadas para compensar parser incorreto ou seleção errada de rota.
- Manter banco, contatos, sessão e credenciais fora de fixtures e logs públicos.
- Separar teste unitário, integração simulada e teste externo controlado nos resultados apresentados.
- Seguir as orientações de `AGENTS.md` e a documentação do Next instalada.

[Voltar ao índice](README.md).
