# Busca manual e alertas

A página `/buscar` usa a estética do painel e permite escolher origem, destino, até sete dias, fontes, benefício e preço máximo. A consulta exige uma conta. Os resultados podem ser filtrados por data, empresa e turno e ordenados por preço ou saída. O link de compra passa pela mesma validação de domínio usada nos alertas.

O botão **Criar alerta desta busca** transfere os critérios para o formulário existente no painel. A pessoa revisa os valores e confirma a criação. Nenhum monitoramento ou envio de WhatsApp é criado automaticamente pela consulta manual. A confirmação do destinatário continua necessária para receber mensagens.

## Execução

`POST /api/search` aceita `{config}` para uma busca nova ou `{id}` para continuar as combinações pendentes de uma busca própria nas últimas 24 horas. `GET /api/search` retorna as oito buscas mais recentes da conta, sem iniciar consultas. As rotas exigem autenticação; a escrita também valida a origem e o esquema dos dados. Os critérios e resultados são criptografados e expiram após sete dias; excluir a conta também os remove.

As rodadas usam a mesma trava de worker e as mesmas pausas duráveis por fonte dos monitoramentos e diagnósticos. Cada rodada executa até três combinações de data e fonte dentro do prazo do worker. Datas adicionais da mesma fonte ficam pendentes enquanto a pausa estiver ativa. A interface diferencia consulta concluída, inconclusiva, falha e pendência. **Sem resultados** não prova ausência de passagens.

Há um limite de três rodadas por conta a cada 15 minutos. No modo gratuito diário da Vercel, há também um limite de três rodadas por dia, compartilhadas entre todas as contas. A busca manual usa o runtime de consultas na Vercel; o remetente do WhatsApp continua no Olympus Cloud. Os limites não garantem cobertura completa de períodos extensos em uma única rodada.

## Verificação

`tests/manual-search.test.ts` cobre isolamento de contas, autenticação, origem, critérios fixos, criptografia, pausas, continuação, perda de lease, filtros de preço/benefício e links, limites e expiração. `scripts/verify-search-ui.mjs` testa filtros de resultados, desktop/mobile, transferência de critérios sem criação automática e preservação da configuração após login usando APIs simuladas, sem mensagens ou consultas reais.
