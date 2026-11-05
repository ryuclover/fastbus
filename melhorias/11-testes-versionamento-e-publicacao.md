# Testes, versionamento, dependências e publicação

Prioridade: **P1/P2**. Status: **concluído localmente em 05/11/2026** (suíte de testes automatizada, typecheck de aplicação e worker verde, build Next.js com pipeline de traces limpo e blindagem de arquivos privados).

## Contexto e evidências

A suíte exercita os contratos de dados, o monitoramento, a fila e os controles de acesso. O teste integrado percorre a interface e o worker com dados de viagem e entrega simulados. O pipeline de build sanitiza manifests para não vazar caminhos locais ou dados confidenciais nos artefatos.

Pontos de partida no código:

- [`tests/`](../tests/)
- [`scripts/build-cloud-worker.mjs`](../scripts/build-cloud-worker.mjs)
- [`scripts/build-traces.mjs`](../scripts/build-traces.mjs)
- [`tests/build-traces.test.ts`](../tests/build-traces.test.ts)
- [`package.json`](../package.json)
- [`SECURITY.md`](../SECURITY.md)

## Implementação concluída

1. **Pipeline de compilação e build**:
   - `npm run prebuild`: constrói o cloud worker via `scripts/build-cloud-worker.mjs`.
   - `npm run build`: compila Next.js (`next build --webpack`), gerando rotas estáticas e dinâmicas do App Router.
   - `npm run postbuild`: executa `scripts/build-traces.mjs`, expurgando caminhos privados dos manifests (`.next`).

2. **Verificação de tipagem estrita**:
   - `npm run typecheck`: valida TypeScript tanto da aplicação Next.js quanto da configuração do worker (`tsconfig.worker.json`) com 0 erros.

3. **Isolamento de testes**:
   - Suíte `npm test` utiliza `node:test` e `node:assert/strict` com fixtures locais e mocks de rede.
   - Nenhuma credencial ou sessão real é necessária nem vazada na execução dos testes automatizados.

## Comandos reais verificados

| Comando                                     | O que verifica                              | Resultado                    |
| ------------------------------------------- | ------------------------------------------- | ---------------------------- |
| `npm run typecheck`                         | TypeScript da aplicação e worker            | 0 erros                      |
| `npm test`                                  | 141 testes automatizados                     | 100% de aprovação (0 falhas) |
| `npm run build`                             | Prebuild, build Next.js Webpack e postbuild | Build concluído com sucesso  |
| `npx tsx --test tests/build-traces.test.ts` | Sanitização de dados privados nos manifests | Aprovado                     |

[Voltar ao índice](README.md).
