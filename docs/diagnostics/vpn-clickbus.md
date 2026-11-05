# Teste de VPN para ClickBus — 18/10/2026

Teste real com Browsec 4.0.0 baixado da Chrome Web Store oficial, em perfil temporário isolado do Chromium. A localização de saída foi confirmada por `api.country.is`; endereços IP não foram registrados. Nenhum acesso à conta FastBus, sessão WhatsApp, compra ou dado de usuário foi realizado.

| Local gratuito exibido na extensão | País confirmado | Página ClickBus | API pública de lugares |
| --- | --- | --- | --- |
| Alemanha | DE | Erro HTTP/2 | Não consultada |
| Holanda | NL | Erro HTTP/2 | Não consultada |
| Reino Unido | GB | Erro HTTP/2 | Não consultada |
| Estados Unidos | US | HTTP 200, sem desafio visível | HTTP 200, lista com 10 lugares |
| Letônia | LV | Erro HTTP/2 | Não consultada |
| Lituânia | LT | Erro HTTP/2 | Não consultada |
| Singapura | SG | Erro HTTP/2 | Não consultada |

O teste de comparação com o mesmo Chromium, sem extensão, retornou HTTP 200 na página inicial tanto com HTTP/2 habilitado quanto desabilitado. As falhas via VPN são erros de protocolo observados; não foi possível determinar se resultam de incompatibilidade do túnel, rede ou rejeição do provedor. Não devem ser descritas como confirmação de bloqueio antibot.

O site de planos do Browsec publicava quatro localizações gratuitas, enquanto a versão testada da extensão exibiu sete. Esta tabela descreve as opções realmente apresentadas ao perfil de teste. O resultado é pontual: IPs de saída, disponibilidade e decisões do site podem mudar.

## Adequação ao projeto

**Browsec, Estados Unidos** é uma opção validada para abertura manual do site e consulta de lugares pelo navegador neste teste. Não foi validada uma busca completa de viagens, preços ou cotas ID Jovem. A extensão não oferece, nas fontes consultadas, uma interface de proxy HTTP documentada para ligar diretamente ao worker Node.js. Não foram extraídas credenciais internas da extensão nem ativada uma VPN global no computador.

O FastBus agora aceita `FASTBUS_PROVIDER_PROXY_URLS`, uma lista de proxies HTTP/HTTPS com rodízio entre consultas, IP fixo durante cada consulta, autenticação opcional e sem fallback direto quando um proxy falha. Sem endpoints configurados, o worker continua direto. O transporte foi validado com um túnel CONNECT real local, incluindo autenticação e respeito a HTTP 429. Não há proxy externo operacional configurado.

Para experimentar uma VPN gratuita integrada ao worker, o **Windscribe com Proxy Gateway HTTP** é um candidato arquiteturalmente compatível. A documentação oficial descreve o gateway HTTP e o plano gratuito; exige uma conta e o aplicativo conectado. Não foi testado com ClickBus, portanto não recebe selo de compatibilidade. Prefira um gateway em máquina/VM separada e firewall que permita apenas o worker; no mesmo computador é necessário verificar split tunneling para evitar que a VPN do sistema também altere WhatsApp e aplicação. Uma instância de gateway representa uma saída, não um conjunto automático de países.

**Proton VPN Free** possui extensão, mas a troca gratuita de servidor é aleatória e tem espera obrigatória; não é uma boa correspondência para escolher localizações por consulta. Não foi testado no ClickBus por exigir autenticação.

## Fontes

- [Browsec na Chrome Web Store](https://chromewebstore.google.com/detail/browsec-vpn-free-vpn-for/omghfjlpggmjjaagoclmmobgdodcjboh)
- [Planos e países do Browsec](https://browsec.com/en/plans)
- [Plano gratuito Windscribe](https://windscribe.com/features/use-for-free)
- [Proxy Gateway Windscribe](https://windscribe.com/knowledge-base/articles/what-is-the-proxy-gateway-feature-and-how-to-use-it)
- [Extensão Proton VPN](https://protonvpn.com/support/browser-extensions)
- [Limites de troca no Proton Free](https://protonvpn.com/support/change-server-free-plan)

Resultados brutos, sem IPs nem credenciais: [vpn-clickbus.json](vpn-clickbus.json).
