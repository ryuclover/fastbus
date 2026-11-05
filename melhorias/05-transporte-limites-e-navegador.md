# Transporte HTTP, orçamento e navegador

Prioridade: **P1/P2**. Status: **concluído localmente em 05/11/2026**.

## Implementação e decisões entregues

| Componente                   | Comportamento entregue                                                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resposta e cabeçalhos        | `retryAfterMs` (`lib/monitoring/response-policy.ts`) analisa tanto valores em segundos quanto datas HTTP absolutas (RFC 9110), ajustando por desvios de relógio do servidor e descartando valores inválidos de forma segura.                                                      |
| Ritmo adaptativo             | `adaptiveDelay` ajusta a espera conforme a latência observada, impedindo que falhas consecutivas reduzam o intervalo mínimo de proteção.                                                                                                                                          |
| Detecção de desafios         | `isChallengeHtml` detecta páginas de desafio (ex.: Cloudflare) retornadas com status HTTP 200, classificando-as como `PROVIDER_BLOCKED` imediatamente e evitando consultas repetitivas de fallback ou interpretações errôneas como inventário vazio.                              |
| Orçamento e timeouts         | `withRequestBudget` e `monitoredFetch` (`lib/monitoring/request-budget.ts`) orquestram requisições com timeouts estritos vinculados ao deadline total da operação. Limites de bytes no corpo evitam estouro de memória em payloads anômalos.                                      |
| Proteção de redirecionamento | O transporte recusa rebaixamento de HTTPS para HTTP, proíbe repetição de métodos não idempotentes (POST) e isola cookies para que nunca vazem entre diferentes origens.                                                                                                           |
| Ambiente do navegador        | `publicBrowserEnvironment` (`lib/monitoring/browser-environment.ts`) sanitiza o ambiente do processo do Chromium, fornecendo exclusivamente variáveis de sistema e display (`PATH`, `DISPLAY`), bloqueando totalmente segredos da aplicação, senhas de banco ou tokens de sessão. |
| Estabilidade de saída (VPN)  | `freeBrowserEgress` (`lib/monitoring/free-egress.ts`) fixa a localização de saída em janelas de 6 horas, garantindo estabilidade de sessão durante toda a consulta sem alternâncias imprevisíveis.                                                                                |

## Verificação de aceite

A suíte passou com testes dedicados em `tests/polite-scraping.test.ts` (12/12) e `tests/proxy-pacing.test.ts` (6/6):

- `tests/polite-scraping.test.ts`:
  - `Retry-After` para segundos, datas HTTP e divergências de relógio.
  - Atraso adaptativo com desaceleração em alta latência e proteção contra redução precoce.
  - Sanitização de credenciais no ambiente de navegador lançado pelo worker.
  - Rotação de país da VPN a cada 6 horas com estabilidade intradia.
  - Detecção precisa de desafios Cloudflare em HTTP 200 sem reenvio ou fallback enganoso.
  - Bloqueio de redirecionamento com vazamento de cookies ou rebaixamento de protocolo.
- `tests/proxy-pacing.test.ts`:
  - Intervalos mínimos de espera entre requisições.
  - Backoff exponencial duplicando de 15 minutos até teto de 24 horas.
  - Rotação controlada de proxies e tratamento seguro de timeouts na fila.
- `npm run typecheck`: aprovado sem erros.

## Itens concluídos

- [x] Mapeamento de todas as saídas de rede com controle unificado sob orçamento de tempo e contadores.
- [x] Códigos distintos de falha: bloqueio, indisponibilidade temporária, formato inválido e timeout.
- [x] Suporte completo a Retry-After em segundos e datas RFC 9110 com persistência de pausa por fonte.
- [x] Orçamento distribuído com margem de segurança para persistência de dados.
- [x] Limitação de bytes lidos do corpo de resposta e cancelamento via AbortSignal.
- [x] Navegador correlaciona requisições à rota e data exatas, liberando recursos no encerramento.
- [x] Estabilidade de saída de rede durante a sessão e isolamento de variáveis sensíveis do processo.

## Testes executados

- [x] 429/503 com Retry-After em segundos e data; bloqueio HTTP 200; redirecionamento para host não permitido.
- [x] Timeout durante corpo, resposta acima do limite e cancelamento durante espera.
- [x] Browser deve capturar apenas a resposta da rota/data correta e liberar recursos após falha.

## Critério de conclusão

Nenhum caminho ignora pausa ou orçamento. Falhas são classificadas e uma rodada termina dentro do limite com seus resultados preservados.

## Migração e recuperação

Os limites de transporte e a detecção de desafios são aplicados nativamente em `monitoredFetch` e nos clientes de scraping. Caso um provedor altere sua política, a respectiva pausa entra em vigor sem comprometer a saúde das demais fontes.

[Voltar ao índice](README.md).
