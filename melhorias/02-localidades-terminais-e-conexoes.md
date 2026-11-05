# Localidades, terminais e conexões

Prioridade: **P1**. Status: **concluído localmente em 04/11/2026**.

## Implementação e decisões

| Etapa        | Comportamento entregue                                                                                                                                                                                                                                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identidade   | O catálogo usa cidade e UF. A comparação normaliza acentos, espaços e hífens. O nome da localidade e o identificador do fornecedor continuam campos distintos.                                                                                                                                                                                                 |
| Resolução    | ClickBus e Mobifácil usam aliases estáticos explícitos ou uma sugestão dinâmica inequívoca da mesma cidade/UF. Sugestões conflitantes, resultados vazios e erros de rede encerram a resolução. O ClickBus em navegador usa o mesmo resolvedor do HTTP. A leitura de URLs antigas preserva a UF do slug com ou sem o sufixo de agregador.                       |
| Persistência | A tabela aditiva `location_mappings` pertence ao schema operacional usado em SQLite e Turso. Cada entrada contém provedor, cidade, escopo, slug, versão e instante de verificação. A validade atual para mapeamentos dinâmicos é de seis horas. O resolvedor só grava após confirmação. Aliases estáticos são distribuídos no código.                          |
| Terminais    | Busca e monitor aceitam terminal de embarque e de desembarque por nome. O padrão de registros antigos é qualquer terminal. O filtro roda no servidor sobre a evidência por parada e exige nome correspondente. A cidade pode ser consultada como agregadora e depois filtrada pelo terminal confirmado. Trocar a cidade limpa o filtro do respectivo terminal. |
| Conferência  | A validação comum compara cidades/UF informadas com a rota solicitada e rejeita divergências de data. Quando o provedor informa data e hora com deslocamento UTC, a conferência considera o dia na origem conhecida. A evidência indica a correlação com a requisição, com as paradas retornadas, ou com ambas.                                                |
| Conexões     | ClickBus e Guanabara tratam itinerários identificados com várias partes como cobertura parcial e expõem sua contagem. A interface informa que a conexão exige verificação integral. A cota de um segmento não gera alerta para a viagem inteira. Esta é a alternativa conservadora prevista no passo 7.                                                        |
| Compra       | O cartão mostra os terminais disponíveis e distingue consulta ao site de um link identificado por viagem ClickBus. O link específico usa o ID da viagem e o modo comercial ou benefício conforme a oferta.                                                                                                                                                     |

### Verificação de aceite

A suíte completa passou com 131 testes, zero falhas e zero ignorados. A verificação de tipos da aplicação e do worker e o build de produção passaram. Os testes de aquisição usaram fornecedores simulados. A entrega está no checkout local.

### Migração e verificação operacional

A inicialização pode ser repetida sobre o schema anterior. Os campos de terminal e de proveniência são opcionais para preservar a leitura de buscas e alertas antigos. Para invalidar um alias dinâmico, remover somente a linha correspondente a provedor, cidade e escopo, ou expirar sua versão. A próxima resolução bem-sucedida o substitui. A estrutura aditiva pode permanecer após reversão de código.

O teste de persistência usa banco SQLite temporário, fecha a conexão e reabre o arquivo antes de consultar o mesmo mapeamento. Também exercita isolamento entre provedores, validade, troca de versão e falha de resolução. A execução em produção com Turso e a disponibilidade atual dos provedores dependem da operação do ambiente publicado.

## Contexto e evidências

Os resolvers podem usar a primeira sugestão sem correspondência suficiente. O ClickBus compara nomes por inclusão e usa parts[0] para vários campos. Isso cria risco de rota errada ou tratamento incompleto de conexões.

Pontos de partida no código: `lib/scrapers/clickbus/client.ts:112`, `lib/scrapers/mobifacil/client.ts:68`. As linhas são referências da revisão de 04/11/2026 e podem mudar.

## Implementação passo a passo

1. Definir identidade canônica de cidade e UF e manter separado o identificador usado por cada fornecedor.

2. Normalizar acentos e espaços apenas para comparação; preservar o nome original e a UF. Nunca escolher apenas pelo primeiro elemento ou por coincidir a UF.

3. Exigir correspondência inequívoca ou mapeamento revisado. Se houver homônimos ou sugestões incompatíveis, retornar LOCATION_AMBIGUOUS ou LOCATION_NOT_FOUND.

4. Representar uma cidade agregadora e seus terminais como entidades distintas. Registrar se o usuário aceita qualquer terminal ou escolheu um ponto específico.

5. Persistir mapeamentos confirmados com fonte, versão e data de validação. Não gravar timeout ou fallback heurístico como resolução confirmada.

6. Conferir origem, destino e data no retorno. Se o provedor omitir esses campos, usar somente contexto de requisição comprovadamente correlacionado e registrar essa proveniência.

7. Detectar itinerários com múltiplos segmentos. Implementar partida inicial, chegada final, ordem dos segmentos e benefício por trecho; até isso existir, indicar conexão não suportada sem anunciar disponibilidade integral.

8. Preservar terminal e identificador da viagem no link de compra quando suportado; não apresentar link genérico como garantia de chegar à mesma oferta.

## Testes necessários

- [x] Cidades homônimas em UFs diferentes e duas sugestões na mesma UF.
- [x] Terminal específico versus agregador -todos.
- [x] Viagem A→B→C não pode ser apresentada como direta A→C com apenas a cota de A→B.
- [x] Resposta sem correspondência deve encerrar a resolução sem consultar uma rota substituta.

## Critério de conclusão

Nenhuma consulta troca silenciosamente a localidade solicitada. Os resultados permitem identificar embarque, desembarque e eventuais conexões.

## Migração e recuperação

Invalidar apenas mapeamentos incorretos e preservar os demais. Disponibilizar consulta manual quando a identidade não puder ser resolvida.

## Evidência a registrar ao concluir

- Commit e arquivos alterados.
- Comandos executados e resultado dos testes, distinguindo simulação de teste externo.
- Mudanças de esquema/configuração e procedimento de reversão.
- Limitações restantes e métricas observadas, sem credenciais ou dados pessoais.

## Detalhamento de implementação e invariantes

Implementar resolução como função pura de critérios e candidatos, retornando `resolved`, `ambiguous` ou `not_found`. Transporte/cache ficam no chamador; falha de rede tem estado diferente de not_found.

Ordem determinística: ID confirmado → alias revisado no contexto cidade/UF → correspondência normalizada exata. Se ainda houver duas correspondências válidas, não escolher pela posição. Nomes parecidos por substring não devem ser fallback automático.

A chave do cache inclui provedor, cidade canônica, UF e escopo do terminal. Guardar versão do mapeamento e invalidar entradas criadas pelo algoritmo anterior quando sua correspondência não puder ser comprovada.

Para conexões, validar continuidade dos terminais/cidades e ordem temporal dos segmentos. Não somar preços de trechos quando a resposta já informa preço integral. Exigir evidência de benefício para toda a opção anunciada.

Entrega mínima: tabela de fixtures com entrada, candidatos e saída esperada; teste que confirma zero chamadas de inventário quando a localidade está ambígua.

Aplicar também o [padrão de código e revisão](13-padrao-de-codigo-e-revisao.md).

[Voltar ao índice](README.md).
