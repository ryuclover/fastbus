# Auditoria dos buscadores — 4 de novembro de 2026

O objetivo é reduzir requisições desnecessárias, esperar o servidor e distinguir uma falha de uma busca sem ofertas. VPN e rotação de IP não garantem acesso: a própria Cloudflare informa que a reputação de VPNs compartilhados pode provocar desafios adicionais. [Cloudflare: diagnóstico de desafios](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/).

## Mudanças implementadas

| Método | Comportamento do FastBus |
| --- | --- |
| Pausa mínima com variação | Agora espera de 4 a 8 segundos após cada requisição controlada, antes da próxima. |
| Espera adaptativa | Respostas lentas aumentam a espera, até 15 segundos. Uma falha rápida nunca reduz a espera anterior. |
| Concorrência limitada | A fila serializa as chamadas de dados de cada consulta. O worker e as pausas persistentes por fonte continuam compartilhados entre contas, diagnóstico, busca e monitoramento. |
| Limite total | Até oito requisições controladas por consulta e prazo total de 90 segundos; a execução em nuvem também tem prazo e cota próprios. |
| Recuo progressivo | Falhas adiam a fonte em 15 minutos, dobrando até um dia. Mudar o IP não apaga essa pausa. |
| `Retry-After` | Aceita segundos e data HTTP, usando o relógio do servidor quando disponível. Nunca reduz o intervalo mínimo. |
| Desafio em HTTP 200 | Detecta o cabeçalho `cf-mitigated: challenge` e padrões fortes de páginas de desafio. Não confunde um widget CAPTCHA normal com bloqueio. |
| Detecção com custo limitado | Inspeciona apenas os primeiros 32 KiB de respostas textuais; mantém o corpo original para o parser. |
| Interrupção após bloqueio | 401, 403, 408, 429, erros 5xx e desafios encerram as requisições daquela consulta. Não há uma cascata de tentativas por outro IP ou endpoint. |
| Redirecionamentos controlados | Até três saltos; cada requisição usa a fila e conta no limite. Não segue outro domínio nem downgrade HTTPS. Não repete um POST em um 307/308. |
| Cabeçalhos restritos | Cookies e autorização são removidos quando um redirecionamento permitido muda a origem. |
| Cache de metadados | Resoluções positivas de cidades têm capacidade limitada e validade de seis horas. Falhas temporárias não ficam gravadas como resolução definitiva no ClickBus. |
| Preços e vagas atuais | Não foi introduzido cache de tarifas/cotas; metadados e disponibilidade têm necessidades diferentes. |
| Guanabara em lotes | Confere até seis mapas únicos, em série, e alterna os candidatos entre rodadas do mesmo processo. Não enfileira quinze verificações. |
| Cobertura parcial honesta | Mapas não verificados não viram gratuidade. A rodada sinaliza orçamento parcial e cotas inconclusivas. |
| Mobifácil | Corrigida a chave dos slugs conhecidos, evitando descoberta redundante. Cada timeout de rede começa após a fila; removido o prazo global de 8,5 segundos que podia vencer durante a espera. |
| Espera por condições | O ClickBus aguarda controles da extensão, configuração do proxy e resposta específica de viagens, com limites, em vez de três sleeps fixos. A resposta de viagens pode levar até 60 segundos, limitada pelo prazo total. |
| Menos recursos no navegador | Imagens, fontes e mídia são dispensadas. Scripts necessários ao site continuam disponíveis. |
| Identidade por sessão | O navegador mantém contexto e localização durante a consulta; perfis são separados por país. Não há troca de fingerprint a cada chamada. |
| Saída gratuita por janela | O Browsec alterna EUA, Países Baixos, Reino Unido e Singapura em janelas de seis horas, quando `CLICKBUS_FREE_VPN_ROTATION=1`. A escolha ocorre ao abrir um contexto. |
| Confirmação de localização | O contexto só prossegue depois de confirmar o modo proxy e o país esperado. Se a configuração falhar, não inicia a busca nem tenta outra localização automaticamente. |
| Escopo do VPN | A extensão funciona apenas no Chromium de consultas do ClickBus. Não muda o VPN do computador de trabalho, do WhatsApp ou do Olympus. |
| Outros provedores | Continuam no transporte HTTP existente. O pool de até dez proxies HTTP/HTTPS aceita endereços fornecidos pelo operador e mantém uma saída por consulta; não foram adicionadas listas públicas desconhecidas. |
| Dados privados | A extensão não recebe credenciais do banco ou do remetente do WhatsApp. A verificação de saída não armazena o IP público. |

As pausas adaptativas seguem a ideia documentada pelo [AutoThrottle do Scrapy](https://docs.scrapy.org/en/latest/topics/autothrottle.html): reduzir a velocidade quando a latência aumenta e não acelerar em respostas de erro. O tratamento de `Retry-After` segue a [semântica HTTP](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after). A detecção pelo cabeçalho é documentada pela [Cloudflare](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/). O Playwright também orienta esperar respostas/condições específicas e desencoraja usar `networkidle` como prova de prontidão: [referência de Page](https://playwright.dev/docs/api/class-page).

## VPNs gratuitos pesquisados

| Alternativa | Avaliação para este projeto |
| --- | --- |
| Browsec | A documentação lista quatro localizações gratuitas e velocidade limitada. Aproveita a extensão já instalada no runtime, sem criar conta ou instalar um VPN no Windows. É uma saída compartilhada, não um IP residencial/dedicado nem garantia de desbloqueio. [Planos oficiais](https://browsec.com/en/plans). |
| Proton VPN Free | A troca de servidor é aleatória e possui cooldown — 45 segundos na primeira troca e dez minutos nas seguintes. Não oferece controle fino de uma lista de saídas para este worker. [Documentação oficial](https://protonvpn.com/support/change-server-free-plan). |
| Windscribe Free | Tem limite de dados e depende de uma conta. Exigiria uma integração e gestão de acesso diferentes, sem demonstrar vantagem sobre a extensão existente. Não foi criada conta. [Plano oficial](https://windscribe.com/features/use-for-free). |

## Métodos avaliados para uma próxima etapa

1. **API/parceria e autorização da fonte:** oferece um contrato de integração mais estável que depender do HTML e da aceitação de um VPN gratuito. Não há garantia de disponibilidade dessas parcerias para este projeto.
2. **Cache condicional para metadados:** `ETag`/`Last-Modified` podem poupar transferência se o endpoint os oferecer. Não aplicar automaticamente a cotas e preços voláteis.
3. **Métricas por fonte e saída:** acompanhar latência, código fixo de falha, cobertura e consumo para decidir entre conexão direta e uma saída configurada. Uma amostra isolada não prova melhoria estatística.
4. **Regras e robots de cada fonte:** auditar a permissão de cada caminho antes de expandir cobertura. Um endpoint estar visível no navegador não demonstra que exista uma API pública de terceiros.
5. **Fixtures de mudanças de layout:** ampliar amostras reais sanitizadas para detectar alterações de esquema antes que gerem falsos resultados vazios.
6. **Persistência do cursor dos candidatos:** o lote do mesmo processo alterna os mapas; em workers efêmeros, o cursor em memória não sobrevive a uma nova execução. Persisti-lo exige armazenamento e migração adicionais.

Não foram introduzidos resolvers automáticos de CAPTCHA, perfis de fingerprint falsos, proxies públicos coletados da internet, cookies de terceiros, tentativas sem limite ou repetição de um pedido negado em uma sequência de IPs. Essas estratégias aumentariam a complexidade e o volume sem demonstrar confiabilidade para as fontes atuais.

## Verificação

`tests/polite-scraping.test.ts` exercita espera adaptativa, cache, seleção estável de localização, `Retry-After`, desafio em HTTP 200, interrupção, redirecionamentos, verificação serial de assentos e slugs conhecidos. A suíte completa também protege confirmação de contato, envios, isolamento de contas e quotas.

`scripts/verify-free-egress.ts` faz uma verificação isolada usando o snapshot existente: recebe apenas a configuração pública do navegador, valida a localização e encerra o sandbox. Não consulta passagens, não recebe tokens de Turso/WhatsApp e não cria snapshots. Exige uma sessão válida do CLI/SDK; uma falha nessa autenticação local não comprova falha de rede na produção.

### Resultado observado em produção e no teste isolado

O primeiro diagnóstico real, antes da correção final dos controles, terminou com `CLICKBUS_EXTENSION_CONFIGURATION_BROWSER_TIMEOUT`, ainda na configuração da extensão. A pausa persistente da fonte foi mantida; não houve nova consulta ao ClickBus para testar a correção.

A inspeção isolada identificou controles com quebras de linha e uma sobreposição de tutorial. O código passou a usar nomes acessíveis dos botões e o fechamento próprio das dicas. Um teste de navegador cobre Shadow DOM, texto com espaços, consentimento oculto e a sobreposição.

Depois da correção, duas verificações isoladas retornaram `VPN_VERIFIED:GB`, confirmando o proxy e a localização Reino Unido. A captura está em `docs/screenshots/fastbus-vpn-connected.png`. Isso confirma a configuração da extensão, **não** a disponibilidade da API de viagens ou o êxito de consultas futuras. Os ambientes temporários foram encerrados.

O CLI precisou reutilizar o snapshot preparado mais recente, pois a configuração local antiga apontava para outro snapshot. Não foi necessário baixar variáveis de desenvolvimento nem entregar credenciais da aplicação ao navegador de teste. Para gerar apenas o verificador, sem autenticação de cloud, use `npx tsx scripts/verify-free-egress.ts --bundle-only`; remova esse artefato antes de publicar, pois `.fastbus-cloud/*` entra nos pacotes de runtime.
