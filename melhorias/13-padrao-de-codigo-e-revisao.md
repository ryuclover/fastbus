# Padrão de código e revisão das melhorias

Status: **consolidado e verificado localmente em 04/11/2026**.

Este guia complementa os passos funcionais dos guias 01–11 e define os padrões de qualidade e critérios de aceitação cumpridos na suíte do FastBus.

## Base conferida no repositório

- TypeScript com strict habilitado; aplicação (`tsconfig.json`) e worker (`tsconfig.worker.json`) validados via `npm run typecheck`.
- Suíte completa com 141 testes em `node:test` e `node:assert/strict`, executados via `tsx --test`.
- Postbuild automatizado para expurgo de caminhos privados em traces (`scripts/build-traces.mjs`).
- Next.js em conformidade com as diretrizes do `AGENTS.md` e regras de Server Components/APIs.
- Persistência com suporte idempotente tanto para SQLite local quanto para Turso Cloud.

## Organização e limites de responsabilidade

1. **Parsing e normalização:** contidos em funções puras nos adaptadores das fontes (`lib/scrapers/`), livres de chamadas diretas de rede ou banco.
2. **Domínio e regras:** centralizados em `lib/monitoring/` (validação de preços em centavos, cotas, validade das ofertas e deduplicação de alertas).
3. **Persistência e segurança:** executadas no servidor (`lib/server/`), com transações curtas fora de chamadas de rede e isolamento criptográfico por usuário.
4. **Injeção de dependências:** relógios, transportes e parâmetros são injetáveis nas funções de domínio, permitindo testar fronteiras temporais com horários fixos.
5. **Nomenclatura explícita:** convenções estritas indicando unidades e intenção (`fareMinor`, `totalMinor`, `departureAt`, `observedAt`).

## Tipagem e contratos

- Entradas externas validadas via Zod (`parse`/`safeParse`); validar o tipo antes de consumir dados externos.
- Resultados modelados como uniões discriminadas com tratamento de estados exaustivo (`completed`, `partial`, `empty`, `blocked`, `failed`).
- Comunicação intercamadas por códigos estruturados de erro, nunca por parsing de strings de mensagens.
- Normalização de dinheiro em inteiros seguros (`Number.isSafeInteger`) em centavos.
- Isolamento de segredos: nenhum componente cliente tem acesso a tokens, chaves ou dependências restritas do Node.

## Erros, cancelamento e recursos

- Retentativas centralizadas no agendador; transporte apenas executa a tentativa respeitando orçamentos e `Retry-After`.
- Preservação obrigatória de resultados parciais em falhas no meio da coleta.
- Liberação segura de recursos (streams, páginas de browser, conexões de banco) em blocos `finally`.
- Propagação de `AbortSignal` em rotas de busca e cancelamento cooperativo de streams antes do parsing JSON.

## Banco, concorrência e migração

- Consultas parametrizadas e conferência mandatória de propriedade do recurso (`user_id`).
- Transações atômicas de curta duração sem chamadas de rede internas.
- Concorrência de workers orquestrada por leases atômicas no banco com validação de propriedade (`claimWorker`/`releaseWorker`).
- Schemas aditivos e compatibilidade regressiva garantida.

## Testes que demonstram comportamento

1. Testes baseados em comportamentos observáveis: entrada, processamento e assertividade de saída.
2. Fixtures sanitizadas separadas de testes sintéticos.
3. Instantes explícitos nos testes de fuso e expiração. Os testes de cadência também exercitam esperas reais.
4. Isolamento estrito: testes utilizam bancos temporários em `data/` com remoção em hook `after()`.

## Sequência de revisão atendida

- [x] Regra e escopo descritos com exemplos e rastreabilidade nos guias 01–11.
- [x] Contratos alterados com todos os consumidores devidamente atualizados e tipados.
- [x] Ausência de campos não é convertida em evidência positiva ou gratuidade.
- [x] Erros e estados discriminados e tipados; sucessos parciais preservados.
- [x] Autorização e isolamento de usuários estritamente executados no servidor.
- [x] Concorrência, idempotência e cancelamento cobertos com testes de colisão e rollback.
- [x] Migrações aditivas compatíveis com SQLite e Turso.
- [x] Regressões criadas para os 9 cenários do reprodutor original, exigindo o comportamento correto.
- [x] `npm run typecheck` e `npm test` aprovados com 100% de sucesso (141/141).
- [x] `npm run build` executado com sucesso e postbuild validado por teste de traces.
- [x] Diff higienizado sem chaves, tokens, sessões ativas ou credenciais versionadas.

[Voltar ao índice](README.md).
