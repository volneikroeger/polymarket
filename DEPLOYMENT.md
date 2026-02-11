# Guia de Deploy na VPS com Systemd

Este guia explica como fazer deploy do Polymarket Copy Trading Bot na sua VPS usando systemd para gerenciamento de processos e Supabase para persistência de dados.

## Pré-requisitos

1. VPS com Ubuntu/Debian
2. Node.js instalado (v18 ou superior)
3. Git instalado
4. Acesso SSH à VPS
5. Conta Supabase com banco de dados criado
6. Credenciais do Polymarket configuradas

## Configuração Inicial do Supabase

### 1. Aplicar Migrations

As migrations já foram aplicadas e o banco de dados está pronto com as seguintes tabelas:

- `executed_signals` - Histórico de sinais executados (deduplicação)
- `open_positions` - Posições abertas ativas
- `daily_limits` - Limites diários de trading
- `high_confidence_positions` - Posições do scanner high-confidence
- `high_confidence_trades` - Histórico de trades high-confidence
- `discovered_traders` - Traders descobertos (19 registros)
- `trader_performance_history` - Histórico de performance dos traders (19 registros)

### 2. Verificar Credenciais

No dashboard do Supabase (https://app.supabase.com):
1. Vá em Settings > API
2. Copie:
   - Project URL (`VITE_SUPABASE_URL`)
   - Anon/Public key (`VITE_SUPABASE_ANON_KEY`)

## Deploy na VPS

### Método 1: Script Automatizado (Recomendado)

```bash
# SSH na VPS
ssh usuario@sua-vps

# Navegue até o diretório do projeto
cd polymarket-copytrader

# Torne o script executável
chmod +x deploy.sh

# Execute o deploy
./deploy.sh
```

O script irá:
1. Fazer git pull do código mais recente
2. Verificar se o .env existe
3. Instalar dependências (npm install)
4. Compilar TypeScript (npm run build)
5. Instalar o service do systemd
6. Reiniciar o serviço
7. Mostrar o status

### Método 2: Deploy Manual

```bash
# 1. SSH na VPS
ssh usuario@sua-vps

# 2. Navegue até o diretório
cd polymarket-copytrader

# 3. Pull código atualizado
git pull origin main

# 4. Configure o .env
nano .env

# Adicione as variáveis necessárias:
VITE_SUPABASE_URL=https://seu-projeto.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon
POLYMARKET_PRIVATE_KEY=sua-chave-privada
# ... outras variáveis

# 5. Ajuste permissões do .env
chmod 600 .env

# 6. Instale dependências
npm install

# 7. Compile o código
npm run build

# 8. Atualize o caminho no service file
nano polymarket-bot.service
# Ajuste WorkingDirectory para o caminho correto do projeto

# 9. Instale o service
sudo cp polymarket-bot.service /etc/systemd/system/
sudo chmod 644 /etc/systemd/system/polymarket-bot.service

# 10. Ative e inicie o serviço
sudo systemctl daemon-reload
sudo systemctl enable polymarket-bot
sudo systemctl start polymarket-bot

# 11. Verifique o status
sudo systemctl status polymarket-bot
```

## Gerenciamento do Serviço

### Comandos Básicos

```bash
# Ver status
sudo systemctl status polymarket-bot

# Iniciar serviço
sudo systemctl start polymarket-bot

# Parar serviço
sudo systemctl stop polymarket-bot

# Reiniciar serviço
sudo systemctl restart polymarket-bot

# Desabilitar início automático
sudo systemctl disable polymarket-bot

# Habilitar início automático
sudo systemctl enable polymarket-bot
```

### Visualizar Logs

```bash
# Logs em tempo real
sudo journalctl -u polymarket-bot -f

# Últimas 100 linhas
sudo journalctl -u polymarket-bot -n 100

# Logs das últimas 24 horas
sudo journalctl -u polymarket-bot --since "24 hours ago"

# Logs com filtro
sudo journalctl -u polymarket-bot | grep "ERROR"

# Exportar logs para arquivo
sudo journalctl -u polymarket-bot > logs.txt
```

## Monitoramento

### Script de Health Check

Execute o health check para verificar se tudo está funcionando:

```bash
chmod +x health-check.sh
./health-check.sh
```

O script verifica:
- Status do serviço
- Uso de memória
- Erros recentes nos logs
- Uptime do serviço

### Configurar Monitoramento Automático

Adicione ao crontab para verificar a cada 5 minutos:

```bash
crontab -e

# Adicione a linha:
*/5 * * * * /home/ubuntu/polymarket-copytrader/health-check.sh > /tmp/bot-health.log 2>&1
```

## Validação Pós-Deploy

### 1. Verificar Conexão com Supabase

Nos logs, procure por mensagens como:
```
Supabase client initialized
Database connection successful
```

### 2. Verificar Dados no Supabase

Acesse o dashboard do Supabase:
1. Vá em Table Editor
2. Verifique as tabelas:
   - `discovered_traders` deve ter 19 registros
   - `trader_performance_history` deve ter 19 registros
   - Outras tabelas começam vazias até o bot começar a operar

### 3. Verificar Execução de Trades

Quando o bot detectar um sinal e executar um trade:
- `executed_signals` terá novo registro
- `open_positions` será atualizado
- `daily_limits` será incrementado

## Troubleshooting

### Serviço não inicia

```bash
# Verificar erros no log
sudo journalctl -u polymarket-bot -n 50

# Verificar permissões do .env
ls -la .env

# Verificar se o build foi bem-sucedido
ls -la dist/index.js

# Testar manualmente
cd /caminho/do/projeto
node dist/index.js
```

### Erro de conexão com Supabase

```bash
# Verificar variáveis de ambiente
grep SUPABASE .env

# Testar conectividade
curl https://seu-projeto.supabase.co/rest/v1/
```

### Uso alto de memória

```bash
# Verificar uso de memória
ps aux | grep "node dist/index.js"

# Reiniciar serviço
sudo systemctl restart polymarket-bot
```

### Bot não está tradando

1. Verifique os logs para erros
2. Verifique se há saldo disponível
3. Verifique se os limites diários não foram atingidos
4. Verifique a tabela `daily_limits` no Supabase
5. Verifique se os traders configurados estão ativos

## Atualizações

Para atualizar o bot:

```bash
# Método rápido com script
./deploy.sh

# Método manual
git pull origin main
npm install
npm run build
sudo systemctl restart polymarket-bot
```

## Backup e Recovery

### Backup

Os dados estão no Supabase, que tem backup automático. Para backup adicional:

```bash
# Backup do código e configuração
tar -czf backup-$(date +%Y%m%d).tar.gz \
  --exclude=node_modules \
  --exclude=dist \
  .
```

### Recovery

```bash
# Restaurar backup
tar -xzf backup-YYYYMMDD.tar.gz

# Reinstalar dependências
npm install

# Rebuild
npm run build

# Reiniciar serviço
sudo systemctl restart polymarket-bot
```

## Estrutura de Dados Persistidos

### executed_signals
Previne duplicação de ordens. Armazena hash único de cada sinal executado.

### open_positions
Tracking de posições abertas para gerenciamento de saídas e stop-loss.

### daily_limits
Controle de limites diários de trading (notional, trades count, P&L).

### high_confidence_positions
Posições do scanner high-confidence com monitoramento de odds.

### discovered_traders
Base de traders descobertos e analisados (19 traders pré-carregados).

## Segurança

1. **Permissões do .env**: Sempre use `chmod 600 .env`
2. **Service User**: O service roda como usuário `ubuntu` (não root)
3. **RLS Habilitado**: Todas as tabelas do Supabase têm RLS ativo
4. **Logs Limitados**: Logs são rotacionados automaticamente pelo journald
5. **Credenciais**: Nunca commite o .env no git

## Performance

### Recursos Esperados
- CPU: ~5-10% em idle, picos durante trades
- Memória: ~150-300 MB
- Disco: ~500 MB incluindo node_modules
- Rede: Baixo uso, apenas requests para Polymarket e Supabase

### Otimizações
- O bot usa conexão persistente WebSocket com Polymarket CLOB
- Queries ao Supabase são otimizadas com indexes
- Deduplicação previne chamadas desnecessárias

## Suporte

Para problemas:
1. Verifique logs: `sudo journalctl -u polymarket-bot -f`
2. Execute health check: `./health-check.sh`
3. Verifique Supabase dashboard para dados
4. Valide configuração do .env
