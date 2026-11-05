# Preços, ID Jovem, vagas e validade

Prioridade: **P1**. Status: **concluído localmente em 05/11/2026**.

## Implementação e decisões entregues

| Componente                      | Comportamento entregue                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parser monetário puro           | `parseProviderMoney` (`lib/money.ts`) valida a gramática por fonte, aceitando inteiros, formatos brasileiros (`123,45`, `1.234,56`, `0,00`) e notação decimal de APIs (`123.45`, `55.5`), convertendo estritamente para centavos inteiros (`Number.isSafeInteger`). Rejeita ambiguidades (`1.234`), precisão excessiva (`10.125`), valores negativos ou strings inválidas sem usar `parseFloat` permissivo. |
| Formatação e apresentação       | `formatMoneyBrl` (`lib/money.ts`) formata centavos de volta para a convenção brasileira (`1013` -> `"R$ 10,13"`).                                                                                                                                                                                                                                                                                           |
| Decomposição e tetos            | Em `validateProviderResult`, `totalMinor` deve equivaler exatamente a `fareMinor + feesMinor` quando ambos são informados. O teto de preço definido pelo usuário é comparado com o desembolso total conhecido em centavos.                                                                                                                                                                                  |
| Regras ID Jovem | O contrato exige viagem interestadual convencional e evidência de cota. A antecedência de três horas orienta a reserva. Vagas remanescentes podem continuar disponíveis. [Orientação da ANTT](https://www.gov.br/antt/pt-br/assuntos/passageiros/viajantes/beneficios-tarifarios). |
| Janela temporal e validade | A evidência usa o primeiro limite entre partida, prazo explícito da fonte e 24 horas da observação. A fila revalida essa evidência antes do envio. |

## Verificação de aceite

- Testes de validação de preços e benefícios em `tests/price-validity.test.ts` (6/6 aprovados):
  - Fronteiras monetárias e rejeição de formatos ambíguos ou com precisão excessiva.
  - Teto sobre o total em centavos e tarifa zero com taxa de embarque.
  - Rejeição de rotas dentro da mesma UF e classes não convencionais para ID Jovem.
  - Vaga confirmada perto da partida e expiração no prazo explícito da fonte.
  - Normalização de partidas no fuso da origem e caducidade de viagens já partidas.
- Regressões da Guanabara em `tests/providers.test.ts` (tarifa positiva sem taxa não gera gratuidade por 0<=0).
- Parser Mobifácil em `tests/mobifacil-parser.test.ts` e ClickBus em `tests/clickbus.test.ts` integrados a `parseProviderMoney`.
- `npm run typecheck`: aprovado sem erros.

## Itens concluídos

- [x] Corrigida a inferência Guanabara em que subtotal e taxa ausentes viravam 0<=0. Tarifa explicitamente positiva não é anulada por campos ausentes.
- [x] Regressão com tarifa/total de 100 e cota 100% disponível não produz oferta gratuita.
- [x] Mobifácil interpreta formatos de preço explícitos, preserva zero e rejeita precisão excessiva e valores inválidos via `parseProviderMoney`.
- [x] Dinheiro em centavos em todo o domínio, decomposição de taxas, fuso e expiração por partida.
- [x] Implementada associação conservadora de meio desconto à tarifa original, categoria de passageiro, classe convencional e cota da mesma rota.
- [x] Validação interestadual e orientação de antecedência na interface.

## Testes executados

- [x] Guanabara com fare=100 e total=100, sem subtotal/taxas, não pode gerar gratuidade por 0<=0.
- [x] Strings 123,45, 1.234,56 e 0 devem seguir contrato explícito; formatos não suportados devem ser rejeitados.
- [x] Partida 00h01 não pode gerar aviso às 23h30 do mesmo dia.
- [x] Testar fusos, virada de dia, cota sem preço, taxa com tarifa gratuita e rota na mesma UF.

## Critério de conclusão

Nenhum campo ausente vira prova de gratuidade. Preço exibido, benefício e vaga referem-se à mesma opção; nenhuma viagem com prazo da oferta encerrado ou já partida gera alerta.

## Migração e recuperação

Campos aditivos de centavos (`fareMinor`, `feesMinor`, `totalMinor`, `departureAt`, `expiresAt`) coexistem com payloads legados. Ofertas legadas sem evidência ou com divergência de valores são descartadas pela validação antes do envio.

[Voltar ao índice](README.md).
