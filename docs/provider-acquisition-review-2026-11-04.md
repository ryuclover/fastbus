# Aquisição de passagens: revisão focada

4 de novembro de 2026. Análise estática dos adaptadores e transporte, cruzada com documentação oficial. Não foram disparadas buscas nos provedores nem alterado código de produção. Exemplos condicionais abaixo demonstram consequências da lógica; não afirmam o formato atual de respostas reais dos sites.

## Correções prioritárias

1. **Identidade da localidade.** `lib/scrapers/clickbus/client.ts:112` seleciona pela UF e recorre a `places[0]`; `lib/scrapers/mobifacil/client.ts:68` faz seleção semelhante. Uma sugestão não comprova identidade da cidade. Exigir nome normalizado + UF ou ID canônico previamente confirmado; representar terminais e agregadores explicitamente. Ambiguidade deve produzir `LOCATION_AMBIGUOUS`, nunca consultar uma rota substituta silenciosamente. Testar cidades homônimas, múltiplos terminais e resposta sem a UF solicitada.

2. **Falha de parser não é busca vazia.** `extrairServicosHtml` em `lib/scrapers/mobifacil/client.ts` retorna `[]` para marcador ausente, JSON inválido e lista realmente vazia. O chamador informa ausência de horários em todos esses casos. Retornar uma união de estados: parsed/empty/schema_changed/challenge. Só declarar vazio quando a estrutura esperada foi reconhecida e validada. Testar HTML novo, tela de erro HTTP 200 e lista vazia válida.

3. **Valores monetários.** Mobifácil usa `parseFloat(s.preco) || undefined` (linha 244): se receber `"123,45"`, interpretará 123; `"1.234,56"` vira 1.234; `"0"` vira ausente. ClickBus comercial usa `Number(trip.price)` sem checagem de finitude. Definir formato por contrato do provedor e rejeitar formatos ambíguos. Normalizar em centavos inteiros, separar tarifa/taxas/total e preservar zero. Corrigir também a inferência de gratuidade da Guanabara documentada na revisão geral.

4. **Capacidade real por provedor.** `lib/services/provedores.ts` reduz capacidade a `suportaIdJovem`. Gontijo apenas monta links e consulta um conjunto estático de UFs; mesmo assim afirma que a linha é operada. Águia Branca retorna ID_JOVEM_UNCONFIRMED antes de consultar em modo benefício; Mobifácil orienta consulta manual. Modelar independentemente coleta comercial, confirmação de cota, emissão online e link de consulta. Fontes de orientação devem aparecer como tal e não consumir rodadas destinadas a confirmar vagas. Estado coberto não prova rota operada.

5. **Cobertura parcial estruturada.** ClickBus calcula `partial` e `unconfirmed`, mas o resultado público não possui esses campos; quando há alguma oferta, a parcialidade fica em texto. Adicionar total de candidatos, candidatos verificados, inconclusivos, cursor e motivo de interrupção. Não tratar um lote de seis como toda a malha. Persistir o cursor para sobreviver ao encerramento do worker e avançar por candidatos efetivamente processados.

6. **Preservar resultados antes de uma falha posterior.** No laço de cotas ClickBus, uma exceção de `loadQuota` pode abandonar os itens já acumulados e cair no resultado vazio do chamador. Fazer checkpoint das ofertas validadas e devolver resultado parcial com motivo do bloqueio, interrompendo novas chamadas. Testar primeira oferta válida seguida de 429 na segunda consulta.

7. **Identidade e composição da viagem.** `converterTripsClickBus` usa `trip.parts?.[0]` para rota e horários. Para itinerários com várias partes, isso pode omitir o destino final ou descartar a viagem por comparar a primeira chegada com o destino solicitado. Suportar segmentos explicitamente ou marcar conexões como não suportadas. O contrato comum `ResultItem` não tem ID da fonte, terminal, timestamp de coleta ou validade. Adicionar esses dados antes de deduplicar ou comparar ofertas entre fontes.

## Transporte e recuperação

Já existem mecanismos úteis: orçamento de requisições, espera adaptativa, deadline, tratamento de Retry-After, interrupção em bloqueios e controles de redirecionamento. A coleta ClickBus já espera a resposta de trips correspondente à origem, destino e data. Preservar essas propriedades.

- Separar `blocked`, `rate_limited`, `timeout`, `upstream_unavailable` e `schema_changed`. Atualmente 401/403/408/429 e todo 5xx convergem em PROVIDER_BLOCKED. Todos podem interromper a rodada, mas exigem diagnóstico e políticas de retomada diferentes.
- Persistir o estado de pausa por fonte e permitir uma tentativa controlada após o prazo. Uma fonte pausada não deve impedir outra elegível. Retry-After é um mínimo a respeitar, não uma sugestão para trocar de IP e continuar.
- Orçar etapas: resolução de origem/destino, lista de viagens e confirmação de cotas. Reservar parte do orçamento para confirmação; evitar iniciar uma etapa sem tempo útil para terminá-la.
- Limitar tamanho do corpo de resposta além do timeout. `json()`/`text()` leem respostas inteiras nos adaptadores; limitar bytes e validar tipo de conteúdo reduz memória consumida por páginas inesperadas.
- Investigar Service Workers ao validar cobertura da interceptação. Playwright documenta que eles podem tornar requisições invisíveis a route(). Não desabilitar indiscriminadamente: a extensão VPN também usa worker; verificar o comportamento específico do contexto.

## Reduzir chamadas sem esconder informação vencida

Cache persistente de IDs de localidades e resolução de terminais, separado do cache de preços. A implementação atual tem cache em memória, perdido em novos workers. Definir TTL e invalidação para cada classe de dado.

Agrupar solicitações simultâneas idênticas por fonte/rota/data/benefício e compartilhar a coleta pública normalizada, mantendo configurações e contatos privados isolados. Aplicar janela curta de reaproveitamento às ofertas com `observedAt` visível; histórico vencido não deve fundamentar alerta de vaga atual.

Mapear quando duas fontes vendem a mesma viagem. Deduplicar somente com evidência suficiente de operadora, serviço, terminais e partida; preservar preços e links por vendedor. Não assumir que horários iguais significam a mesma viagem.

## Contratos e testes de aquisição

Separar transporte -> validação do payload -> normalização -> validação de negócio -> persistência. Usar schemas de runtime para dados externos; TypeScript e casts não validam uma resposta recebida. Aceitar campos adicionais, mas exigir os campos críticos do contrato. Itens inválidos podem ser isolados, desde que a busca indique parcialidade e contagem de rejeições.

Criar fixtures sanitizadas por provedor e versão de parser, sem cookies, tokens ou dados pessoais. Testar: mudança de esquema, preço local, ausência de campos, zero, cidades homônimas, conexão, meia-noite/fuso, resposta vazia legítima, página de desafio, falha após sucesso parcial e retomada após reinício. Reexecutar fixtures sem rede a cada mudança; sondagens reais devem ser poucas, explícitas e respeitar pausas.

Métricas úteis: ofertas válidas por chamada, proporção de candidatos confirmados, falhas de localização, mudanças de contrato, custo/latência por etapa e idade dos dados. Uma resposta HTTP 200 sozinha não mede sucesso da aquisição.

## Ordem de implementação

1. Localidades, parser/vazio, dinheiro e capacidades reais.
2. Contrato normalizado com identidade, proveniência e parcialidade; preservar sucessos parciais.
3. Cursores persistentes, orçamento por etapa e isolamento de falhas das fontes.
4. Fixtures, métricas, cache persistente e coalescência de consultas.

Critério de aceite: uma consulta deve demonstrar qual rota foi consultada, quais candidatos foram examinados, por que cada oferta é válida e o que ficou pendente, inclusive após bloqueio ou reinício.

## Referências primárias

- [Playwright: rede](https://playwright.dev/docs/network): espera/interceptação de respostas e particularidades de Service Workers.
- [Playwright: Page](https://playwright.dev/docs/api/class-page): networkidle é desaconselhado; usar condições específicas.
- [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html): semântica HTTP e Retry-After.
- [Zod: basic usage](https://zod.dev/basics): parse/safeParse validam entradas em runtime.

Não foi comprovada nesta pesquisa a disponibilidade de uma API oficial pública de inventário para cada empresa. Endpoints usados pelo site não devem ser apresentados como uma integração oficial com contrato estável. Integração autorizada/documentada, quando disponível, deve ser avaliada antes de ampliar dependência de HTML ou de extensões VPN.
