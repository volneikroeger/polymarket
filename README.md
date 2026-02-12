# Polymarket Copy Trading Bot

Bot simples para copiar trades de traders específicos no Polymarket.

## 🎯 Traders Monitorados

O bot está configurado para copiar 4 traders:

1. **0xa3e9a711841e655def080044768452b60f4263d0** - 91.5% WR, 20.13% ROI
2. **0x095dcfb123a4bc035ee6b0d624bab0cc964352cf** - 77% WR, 2.35% ROI, $2M volume
3. **0x6d3c5bd13984b2de47c3a88ddc455309aab3d294** - 76% WR, 0.17% ROI
4. **0x0c0e270cf879583d6a0142fc817e05b768d0434e** - 92% WR, 0.01% ROI, $19M volume

## ⚙️ Configuração

### Tamanho de Trade
- **Mínimo por trade**: $1 USDC
- **Máximo por trade**: $1 USDC
- **Máximo de posições ativas**: 10

### Arquivos Importantes
- `.env` - Variáveis de ambiente e credenciais
- `high-confidence-config.yml` - Configuração dos traders e parâmetros de risco

## 🚀 Como Usar

### Iniciar o Bot
```bash
npm run copy-traders
```

### Build
```bash
npm run build
```

### Desenvolvimento
```bash
npm run dev
```

## 📊 Como Funciona

1. **Monitoramento**: O bot verifica a cada 30 segundos as atividades dos traders via API do Polymarket
2. **Detecção**: Quando um trader faz uma compra (BUY), o bot detecta
3. **Cópia**: O bot replica o trade com $1 USDC
4. **Proteção**: Trades de venda (SELL) só são copiados se temos uma posição aberta no mercado

## 🔒 Segurança

- ✅ Só copia BUY orders
- ✅ Só copia SELL orders se temos posição aberta
- ✅ Máximo de $1 por trade
- ✅ Limite de 10 posições ativas
- ✅ Stop-loss de 50 USDC/dia

## 📝 Estrutura do Projeto

```
src/
├── index.ts                          # Ponto de entrada principal
├── traderCopyBot.ts                  # Bot de cópia de traders
└── lib/
    ├── copyTradingConfig.ts          # Loader de configuração
    ├── database.ts                   # Integração Supabase
    ├── logger.ts                     # Sistema de logs
    ├── polymarket/
    │   ├── api.ts                    # Cliente API Polymarket
    │   └── executor.ts               # Executor de ordens
    └── signals/
        ├── traderPositionMirror.ts   # Monitor de posições dos traders
        └── types.ts                  # Tipos TypeScript
```

## 🗄️ Banco de Dados

O bot usa Supabase para rastrear:
- **executed_signals**: Trades executados (evita duplicatas)
- **open_positions**: Posições abertas (tracking de P&L)
- **daily_limits**: Limites diários (proteção de risco)

## ⚠️ Importante

- O bot só copia BUY orders instantaneamente
- SELL orders só são copiados se temos a posição correspondente
- Traders podem ter posições antigas que não copiaremos
- Isso é normal e protege contra vender o que não temos
