# Busca parcial, cache e retomada

Prioridade: **P1/P2**. Status: **concluído localmente em 05/11/2026**.

## Implementação e decisões entregues

| Componente                      | Comportamento entregue                                                                                                                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache LRU delimitado            | `LookupCache` (`lib/monitoring/lookup-cache.ts`) implementa limite de capacidade e descarte Least-Recently-Used (LRU). Cada item possui expiração por TTL, impedindo que dados obsoletos sirvam como confirmação atual de vaga ou que erros transitórios sejam cacheados permanentemente. |
| Jobs de busca duráveis          | As buscas manuais são geridas via tabela `search_jobs` (`lib/monitoring/manual-search.ts`). O ciclo de vida define os estados `queued`, `running`, `complete` e `partial`.                                                                                                    |
| Preservação de ofertas parciais | A execução salva checkpoints dos resultados validados por fonte. Se uma fonte falhar, esgotar tempo ou for bloqueada após o retorno de ofertas válidas por outro provedor, o job transiciona para `partial`, preservando integralmente as ofertas adquiridas e contadores de cobertura.   |
| Isolamento criptográfico        | O payload de busca e os resultados obtidos são cifrados no campo `search_jobs.payload`, com o ID da busca como contexto autenticado e consultas limitadas ao proprietário, impedindo vazamento de histórico, contatos ou consultas entre diferentes contas.                                                                                          |
| Cache de localidades            | O resolvedor de terminais e cidades (`lib/scrapers/location.ts` e `lib/server/location-mappings.ts`) armazena mapeamentos confirmados com TTL de 6 horas e versionamento, reduzindo requisições redundantes de autocompletar e resolução de slugs.                                        |

## Verificação de aceite

- `tests/manual-search.test.ts` (6/6 aprovados):
  - Ciclo de vida completo do job de busca: enfileiramento, execução controlada, checkpoint e finalização.
  - Preservação de resultados parciais criptografados quando um provedor falha e outro tem sucesso.
  - Classificação como `failed` apenas quando todos os provedores falham, e como `partial` em falhas parciais.
  - Isolamento estrito entre usuários e proteção contra acesso indevido ou chamadas sobrepostas.
  - Limite de 3 rodadas por conta a cada 15 minutos e descarte após 7 dias.
- `tests/polite-scraping.test.ts`:
  - Cache delimitado com expiração por TTL e política de expulsão LRU.
- `tests/location-store.test.ts`:
  - Persistência e invalidação de cache de mapeamentos de localidade com isolamento por provedor.
- `npm run typecheck`: aprovado sem erros.

## Itens concluídos

- [x] Chave de consulta estável vinculada a provedor, origem, destino, data e benefício.
- [x] Persistência de estado e candidatos por meio de jobs duráveis na tabela `search_jobs`.
- [x] Checkpoint de resultados válidos no banco antes de prosseguir com etapas adicionais.
- [x] Transições de estado atômicas garantindo que falhas parciais não apaguem ofertas já conferidas.
- [x] Cache de localidades com TTL, versionamento e proteção contra cacheamento de erros temporários.
- [x] Isolamento criptográfico completo entre consultas de diferentes contas.

## Testes executados

- [x] Primeira cota válida seguida de interrupção ou 429 preserva a primeira oferta adquirida.
- [x] Encerrar e reabrir o processamento mantém histórico íntegro e atualiza o estado do job.
- [x] Contas diferentes mantêm seus resultados, contatos e preferências estritamente isolados.

## Critério de conclusão

A cobertura de cada consulta é observável e auditável. Falhas parciais preservam as ofertas válidas sem promover resultados incompletos a sucesso integral.

## Migração e recuperação

A tabela `search_jobs` e as estruturas de cache em banco integram-se de forma aditiva ao schema de dados. Em caso de necessidade de reversão, consultas em andamento expiram com segurança sem corrupção de estado.

[Voltar ao índice](README.md).
