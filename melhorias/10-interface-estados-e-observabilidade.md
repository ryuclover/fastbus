# Interface, estados e observabilidade

Prioridade: **P2**. Status: **concluído localmente em 05/11/2026** (estados canônicos tipados, reconciliação resiliente com backoff de ociosidade, desacoplamento de filtros visuais e cobertura de telemetria).

## Contexto e evidências

Busca com fontes falhas não pode ser sumarizada como concluída sem ressalvas; respostas vazias validadas distinguem-se de erros ou bloqueios. A atualização da interface deve ser eficiente, diminuindo a frequência quando em repouso e pausando em segundo plano.

Pontos de partida no código:

- [`app/buscar/page.tsx`](../app/buscar/page.tsx)
- [`lib/monitoring/manual-search.ts`](../lib/monitoring/manual-search.ts)
- [`components/admin-diagnostics.tsx`](../components/admin-diagnostics.tsx)
- [`app/api/admin/diagnostics/route.ts`](../app/api/admin/diagnostics/route.ts)
- [`tests/api-client.test.ts`](../tests/api-client.test.ts)

## Implementação concluída

1. **Tabela de estados canônicos de busca**:
   - `ManualSearchTarget` e `ManualSearch` possuem estados derivados dos fatos: `queued`, `running`, `complete`, `failed`.
   - Códigos honestos por target: `PROVIDER_OK` (encontrado), `PROVIDER_EMPTY` (sem viagens), `LOCATION_AMBIGUOUS`, `LOCATION_NOT_FOUND`, `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `PROVIDER_ERROR`.
   - Outliers como Gontijo são rotulados explicitamente como `outcome: "manual"` e bloqueios de egress como `outcome: "blocked"`, sem confundir com vazio ou sucesso cego.

2. **Polimento de atualização (polling e visibilidade)**:
   - Polling adaptativo em `app/buscar/page.tsx`: 3000ms quando jobs estão em execução (`running`), reduzindo para 30000ms quando ociosos.
   - Pausa quando a aba está em segundo plano (`document.hidden`), com reconciliação imediata no evento `visibilitychange`.
   - Proteção de concorrência com `inFlight.current` ref, evitando requisições HTTP paralelas sobrepostas.

3. **Desacoplamento entre filtros visuais e critérios persistidos**:
   - Critérios de busca persistidos (`job.config`) são mantidos estritos conforme o `monitorSchema`.
   - Filtros visuais de tabela (ordenação, empresa, turno) são mantidos isolados no estado do cliente React, com esclarecimento explícito ao criar alerta a partir de busca.

4. **Observabilidade e diagnósticos**:
   - Diagnósticos detalhados por fonte e terminal sem expor dados pessoais ou telefones nos logs.
   - Rotas de diagnóstico administrativo (`/api/admin/diagnostics`) tipadas e autenticadas.

## Testes validados

- [x] `tests/api-client.test.ts`: Preservação de cookies, no-store em mutações e retenção de erros com HTTP status e server messages.
- [x] Verificação de tipagem completa com `npm run typecheck` (Next.js e Worker).

## Critério de conclusão

O usuário distingue o que foi consultado do que ainda está pendente ou bloqueado, e a interface desacopla critérios persistidos de filtros de visualização com consumo de rede otimizado.

[Voltar ao índice](README.md).
