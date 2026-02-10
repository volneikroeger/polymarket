# Polymarket CLOB Quant Bot — 3 Estratégias Executáveis

Este documento define e implementa **3 estratégias** (Arbitrage, Stale Orders Capture, Market Making) para um bot no **Polymarket CLOB** usando apenas capacidades típicas:

- Ler **orderbook** (best bid/ask + depth)
- Ler **trades recentes**
- Enviar/cancelar **ordens LIMIT**
- Checar saldo (best-effort) e PnL (fora do escopo aqui)

**Sem market order.** Para agressividade usamos LIMIT no best bid/ask (ou cruzando o book).

Código: `src/quantBot.ts`
Config exemplo: `quant-config.example.yml`

---

## Parte 1 — Filtro de Mercados (obrigatório)

Antes de rodar qualquer estratégia, aplicamos um filtro de elegibilidade baseado em book + atividade. Isso evita mercados ilíquidos/pickoff.

### Critérios

1) **Profundidade mínima no topo**
- Medida: somar `size` (shares) dos primeiros `N` níveis em bids e asks.
- Regra: `sum_bid_depth(N) >= D_min` e `sum_ask_depth(N) >= D_min`.
- Implementação: `sumDepth(levels, N)` em `quantBot.ts`.

2) **Spread dentro de faixa útil**
- `spread = best_ask - best_bid`
- Regras:
  - `spread <= maxSpreadAbs` (evita pagar demais)
  - `spread >= minSpreadAbs` (MM precisa “edge”; se spread ~0, não compensa)

3) **Atividade mínima recente (trade count)**
- Medida: buscar `getTrades(tokenId, limit)` e contar trades com `timestamp >= now - lookbackSec`.
- Regra: `recentTrades >= minTradesCount`.
- Motivo: se não tem prints recentes, o book pode ser fake/abandonado.

4) **Evitar mercados perto da resolução (opcional)**
- Para implementar sem inventar endpoint de “closeTime”: incluímos `closeTimeMs` apenas se você fornecer em config.
- Regra: `closeTimeMs - now >= minTimeToCloseMs`.

### Como calibrar
- `minTopDepthShares`: aumentar para reduzir slippage (ex.: 25→100)
- `maxSpreadAbs`: baixar para reduzir custo (ex.: 0.03→0.015)
- `minTradesCount`: aumentar para focar em mercados mais vivos

---

## Parte 2 — Métricas (obrigatório)

As métricas são calculadas por token (outcome) e usadas nas estratégias.

1) **mid**
- `mid = (best_bid + best_ask) / 2`

2) **spread**
- `spread = best_ask - best_bid`

3) **microprice**
- Microprice top-of-book:
  - `microprice = (best_bid * size_ask + best_ask * size_bid) / (size_bid + size_ask)`
- Intuição: puxa o “mid” para o lado com maior agressividade/pressão.

4) **slippage_estimada(X)**
- Caminhar o book para comprar/vender `X` USDC e estimar `avgPrice` e `worstPrice`.
- Implementação: `calcSlippageNotional(book, X, side)`.

5) **book_imbalance (N níveis)**
- `imbalance = (sum_bid_depth - sum_ask_depth) / (sum_bid_depth + sum_ask_depth)`

6) **volatility_mid**
- Desvio padrão do `mid` numa janela de `W` amostras.
- Implementação: `std(midHistory)`.

7) **cancel_rate (proxy de mercado rápido)**
- Contagem de mudanças no top-of-book (best bid/ask) por minuto.
- Observação: isso é proxy (não é taxa real de cancel da conta).

---

## Parte 3 — Estratégia 1: Arbitragem lógica (relativamente “segura”)

### 3.1 Lógica (binário YES/NO)

Para um mercado binário com payoff 1:

- Se `ask_yes + ask_no < 1 - margem` → comprar YES e NO (trava lucro teórico)
- Se `bid_yes + bid_no > 1 + margem` → vender YES e NO (só se houver inventário)

**Exemplo:**
- ask_yes = 0.48
- ask_no  = 0.49
- soma = 0.97
- margem = 0.01 → 1 - margem = 0.99
- 0.97 < 0.99 ⇒ oportunidade: compra os dois.

Lucro teórico ≈ `1 - (ask_yes + ask_no) = 0.03` por 1 share de pacote (antes de fees e execução).

### 3.2 Multi-outcome mutuamente exclusivo
- Se `Σ ask_outcomes < 1 - margem` → comprar 1 share de cada outcome.

### 3.3 Execução (two-leg / multi-leg control)
- Enviar **LIMIT agressiva** no best ask (BUY) / best bid (SELL).
- Se uma perna falhar ao postar, cancelar as outras (rollback).
- (Melhoria futura) monitorar fills por `getOrder` e hedgear se parcial.

### 3.4 Risco
- Tamanho máximo por perna: `maxLegNotionalUsdc`.
- Respeitar caps diários e exposição total.

### 3.5 Saída
- Arb travada pode ser mantida até resolução.
- Alternativa: quando o mercado normalizar, vender o pacote (se houver bids).

Implementação: `tryArbitrage()` em `src/quantBot.ts`.

---

## Parte 4 — Estratégia 2: Stale Orders Capture (captura de ordens "stale" pós-jump)

### Objetivo (preciso)
Capturar ordens resting “erradas” **imediatamente após um movimento brusco**, quando parte do book ainda está “no preço antigo”.

### Sinais (implementados)
O bot só arma stale-capture quando TODAS as condições abaixo são verdade:

1) **Jump do mid**
- Definição: `jump = |mid_now - mid_old|`
- `mid_old` = primeiro sample dentro da janela `W`.
- Regra: `jump >= J`.

2) **Burst de trades**
- Conta trades nos últimos `W` segundos.
- Regra: `trades_in_W >= K`.

3) **Nível grande no lado errado perto do preço antigo**
- Se `mid_now > mid_old` (subiu): existe ask com `price <= mid_old + dist` e `size >= S_min`.
- Se `mid_now < mid_old` (caiu): existe bid com `price >= mid_old - dist` e `size >= S_min`.

Parâmetros: `jumpAbs (J)`, `windowSec (W)`, `burstTradesMin (K)`, `wrongSideMinLevelShares (S_min)`, `wrongSideMaxDistanceAbs (dist)`.

### Regras de entrada (precisas)
Após o trigger (jump+burst+wrongSide), definimos `fair` como uma EMA do **mid_novo** (como você pediu):
- `fair = alpha * mid_now + (1-alpha) * fair_prev`

**Entrada BUY (pós-jump pra cima):**
- se `fair - bestAsk >= edgeAbs` → enviar LIMIT BUY no `bestAsk`.

**Entrada SELL (pós-jump pra baixo):**
- se `bestBid - fair >= edgeAbs` e houver inventário → LIMIT SELL no `bestBid`.

### Regras
- **BUY stale ask:** se `fair - bestAsk >= edgeAbs`
- **SELL stale bid:** se `bestBid - fair >= edgeAbs` e houver inventário.

### Saída (precisa) + risco de ficar preso
Versão atual minimiza ficar preso com 3 mecanismos:

1) **TTL de ordem**
- Cancelar ordens stale se idade > `orderTtlMs`.

2) **Time-stop**
- A configuração inclui `timeStopMs` (próximo passo: módulo de gerenciamento de posição para executar saída progressiva se não reprecificar).

3) **Stop por preço**
- Config inclui `stopLossAbs` / `takeProfitAbs` (próximo passo: aplicar em posições reais com reconciliação de fills).

Observação: sem leitura confiável de posição/fills no CLOB, o TP/SL é parametrizado e documentado, mas o fechamento automático por posição é um hardening a completar.

### Saída / risco de ficar preso
- Em versão mínima, o bot não implementa um “close loop” completo.
- O controle de “não ficar preso” vem do filtro de liquidez + TTL + caps.
- (Melhoria recomendada) adicionar um módulo de gerenciamento de posição:
  - take-profit quando `mid >= entry + takeProfitAbs`
  - stop-loss quando `mid <= entry - stopLossAbs`

Implementação: `tryStaleCapture()`.

---

## Parte 5 — Estratégia 3: Market Making controlado (spread capture)

### Objetivo
Ganhar o spread em mercados “lentos” sem tomar muito adverse selection.

### Regras (implementadas, precisas)
Rodar MM somente quando:
- `spread >= spreadMinAbs`
- `volatility_mid <= volMax`

Cotação (LIMIT, sem cruzar):
- `bid_price_raw = mid - spreadTargetAbs/2 - skew`
- `ask_price_raw = mid + spreadTargetAbs/2 - skew`
- Não cruzar:
  - `bid_price = min(bid_price_raw, bestBid)`
  - `ask_price = max(ask_price_raw, bestAsk)`

Requote:
- Cancel/replace se `|mid - lastMmRefMid| >= deltaRequoteAbs` OU `idade > quoteTtlMs`.

### Regras
- Postar **1 bid** e (conservador) **1 ask somente se houver inventário**.
  - Isso evita short (mais seguro).
- Cancel/replace:
  - se ordem tem idade > `quoteTtlMs`
  - respeitar `replaceCooldownMs` para não bater rate-limit

### Inventory management (obrigatório)
- Medimos inventário (aprox) em notional: `invNotional ≈ shares * fair`.
- Se `invNotional > invMaxNotionalUsdc` ⇒ **não postar bid** (não aumenta long).
- Skew: `skew = invSkewK * invNotional` (se long, puxa bid/ask para baixo).

Conservador por padrão:
- Só posta **ask** se já tiver inventário (evita short).

Implementação: `tryMarketMake()`.

---

## Parte 6 — Gestão de risco global (obrigatório)

Implementado hoje (no `quantBot.ts`):

- **max_open_orders**: se `openOrders > maxOpenOrders` ⇒ HALT
- **max_daily_notional**: se `dailyNotionalUsdc >= maxDailyNotionalUsdc` ⇒ para de abrir novas ordens
- **circuit breaker por falhas consecutivas**: `consecutiveFailures >= maxConsecutiveFailures` ⇒ HALT
- **falhas de feed / latência alta**: se snapshot de token levar `> maxDataLatencyMs` ⇒ HALT
- **cooldown após halt**: espera `cooldownAfterHaltMs` e tenta retomar

Limitações conhecidas:
- `max_daily_loss` exige PnL; como não dependemos de endpoint extra aqui, usamos cap por notional como aproximação de segurança.

---

## Parte 7 — Config + loop principal (preciso)

### YAML default conservador
Veja `quant-config.example.yml` para:
- `spreadMinAbs`, `spreadTargetAbs`, `volMax`, `invMaxNotionalUsdc`
- `arb.edgeAbs`, `arb.maxLegNotionalUsdc`
- `stale.jumpAbs`, `stale.windowSec`, `stale.timeStopMs`, `stale.stopLossAbs`
- limites globais: `maxDailyNotionalUsdc`, `maxOpenNotionalUsdc*`, `maxOpenOrders`

### Pseudocódigo do loop

```text
load cfg
init client
state := { openOrders, marketState, counters }

loop every pollMs:
  resetDailyIfNeeded()

  if halted:
    if cooldown not elapsed: continue
    else resume

  if consecutiveFailures >= maxConsecutiveFailures: halt
  if openOrders > maxOpenOrders: halt
  if dailyNotionalUsdc >= maxDailyNotionalUsdc: continue (no new risk)

  snapshots := {}
  for token in all configured outcomes:
    book := getOrderBook(token)
    trades := getTrades(token)
    metrics := { mid, spread, microprice, imbalance, volatility_mid, cancel_rate }
    if latency too high or book inconsistent: halt
    snapshots[token] := metrics+data

  cancel orders older than max(TTLs)

  for market in cfg.markets:
    if !eligible(market, representativeTokenSnapshot): continue

    if arbitrage enabled:
      if sum(asks_outcomes) < 1-edge: place BUY legs (LIMIT aggressive) with rollback on failure
      if sum(bids_outcomes) > 1+edge: SELL legs only if inventory

    for token in market.outcomes:
      if stale enabled:
        if jump+burst+wrongSide: attack stale liquidity with LIMIT on bestAsk/bestBid

      if mm enabled:
        if spread>=min && vol<=max:
          compute bid/ask around mid w/ skew, clamp not crossing
          cancel/replace if mid moved or TTL
          place quotes respecting inventory and maxOpenOrders

  if loop ok: consecutiveFailures = 0
```

---

## Como rodar

1) Copie o config exemplo:

```bash
cd /root/.openclaw/workspace/polymarket-copytrader
cp quant-config.example.yml quant-config.yml
```

2) Preencha `markets[].outcomes[].tokenId` com token IDs reais.

3) Rodar em paper:

```bash
QUANT_CONFIG_PATH=quant-config.yml npm run quant-bot
```

---

## Roadmap de hardening (recomendado)

- Inventário real via `getBalanceAllowance` + endpoint de posições (CLOB) se disponível
- Tracking de fills por `getOrder` / `getTrades` da conta
- Gerenciamento de posição para stale-capture e MM (TP/SL baseados em mid)
- Controle de slippage via `calcSlippageNotional` antes de cruzar o book
- Medir fees e incluir no edge
