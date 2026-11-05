# Parsers e capacidades reais dos provedores

Prioridade: **P1**. Status: **concluído localmente em 05/11/2026**.

## Implementação e decisões entregues

| Fonte        | Parser                                                        | Capacidades registradas (`types/providers.ts`)                                      | Comportamento em erro / vazio                                                                                 |
| ------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Mobifácil    | Parser puro (`lib/scrapers/mobifacil/parser.ts`)              | Comercial: sim. ID Jovem: não comprovado.                                           | Distingue `lsServicos` ausente, JSON truncado, serviços parciais e vazio legítimo.                            |
| ClickBus     | Streaming RSC + Next data (`benefits.ts`, `mapper.ts`)        | Comercial: sim. ID Jovem: sim (100% e 50% verificáveis por viagem).                 | Erros HTTP 403 encerram busca como erro técnico. Vazio confirmado é distinguido de falha de payload.          |
| Guanabara    | Serviços e mapas de assentos com schema estrito (`client.ts`) | Comercial: sim. ID Jovem: sim (100% convencional e 50% comprovado com tarifa base). | Rejeita gratuidade por omissão de taxas. Falhas em assentos individuais não invalidam serviços válidos.       |
| Embarca      | Schema unificado API/SSR (`client.ts`)                        | Comercial: sim. ID Jovem com categoria, vagas e preço explícitos na mesma opção.                    | Bloqueios e payloads inesperados geram erro explícito em vez de resultado vazio.                              |
| Águia Branca | HTML / dataLayer parser (`client.ts`)                         | Comercial: sim. ID Jovem: orientativo.                                              | Preços de cartões, horários e classes são preservados; seleção de filtro não infere assentos gratuitos.       |
| Gontijo      | Adaptador orientativo (`client.ts`)                           | Apenas orientação manual para portal oficial JVVN (`outcome: "manual"`).            | Não afirma operação de linha entre cidades por mera lista de UFs; não entra na fila automática de inventário. |
| Buser        | Parser de cartões comerciais (`client.ts`)                    | Comercial: sim. ID Jovem: não suportado.                                            | Não aceito em monitoramento de cotas governamentais.                                                          |

## Verificação de aceite

- `tests/mobifacil-parser.test.ts` (3/3 aprovados):
  - `lsServicos` ausente gera estado `invalid`.
  - JSON quebrado ou truncado gera estado `invalid`.
  - Serviços com itens rejeitados geram estado `partial` com contadores exatos.
  - Array vazio confirmado gera `valid` vazio sem erro técnico.
- `tests/providers.test.ts` (9/9 aprovados):
  - Gontijo retorna orientação manual com link parametrizado, sem alegar inventário consultado.
  - Matriz `PROVIDER_CAPABILITIES` discrimina com exatidão as capacidades reais de cada adaptador.
  - Águia Branca preserva cartões comerciais e não inventa vagas gratuitas a partir de filtro.
  - Embarca reporta payloads inválidos como falha e respeita bloqueios.
- `npm run typecheck`: aprovado com zero erros.

## Itens concluídos

- [x] Mobifácil diferencia HTML não reconhecido, JSON inválido, todos os itens inválidos, resultado parcial e vazio válido.
- [x] Parser separado do transporte com validação runtime e fixtures sintéticas em tests/mobifacil-parser.test.ts.
- [x] Itens válidos preservados e cobertura parcial retornada pelo adaptador.
- [x] Matriz completa de capacidades compartilhada com UI/fila (`types/providers.ts` e `lib/services/provedores.ts`) e revisão das afirmações sobre malha Gontijo.
- [x] Contratos e schemas de payload bruto implementados com isolamento de falhas por provedor.

## Testes executados

- [x] Marcador lsServicos ausente, JSON truncado e array vazio válido precisam de estados diferentes.
- [x] Fonte apenas orientativa não deve ser contabilizada como inventário consultado.
- [x] Uma mudança de HTML deve gerar diagnóstico específico sem afirmar falta de vagas.

## Critério de conclusão

A aplicação informa o que efetivamente sabe de cada fonte. Falhas de interpretação são observáveis e não escondidas em resultados vazios.

## Migração e recuperação

Cada parser mantém uma função pura de extração desacoplada de rede e de persistência. A matriz de capacidades unifica a visão entre API, fila e interface.

[Voltar ao índice](README.md).
