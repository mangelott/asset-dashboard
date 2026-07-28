const axios = require('axios');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

// The strategy DSL: free text is compiled into this bounded schema so backtests
// are deterministic and comparable across tuning iterations — the AI never
// writes arbitrary logic, only fills in these parameters.
const STRATEGY_SPEC_SCHEMA = {
  type: 'object',
  properties: {
    assets: {
      type: 'array', items: { type: 'string' }, maxItems: 3,
      description: 'Bybit linear USDT perpetual symbols, e.g. ["BTCUSDT", "XRPUSDT"]'
    },
    timeframe: { type: 'string', enum: ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] },
    htf_timeframe: {
      type: 'string', enum: ['1h', '2h', '4h', '6h', '12h', '1d', '1w'],
      description: 'Optional higher timeframe used by entry_rules with use_htf=true, for daily-bias / HTF support-resistance style filters. Must be strictly higher than `timeframe`. Omit if no entry_rule uses use_htf.'
    },
    leverage: { type: 'number', minimum: 1, maximum: 10 },
    side: { type: 'string', enum: ['long', 'short', 'both'] },
    position_sizing: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['fixed_usd', 'pct_capital'] },
        value: { type: 'number' }
      },
      required: ['type', 'value']
    },
    entry_logic: { type: 'string', enum: ['all', 'any'], description: 'Whether all entry_rules must hold, or any single one' },
    entry_rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          indicator: { type: 'string', enum: ['rsi', 'ma_cross', 'breakout', 'price_vs_ma'] },
          period: { type: 'number' },
          fast_period: { type: 'number' },
          slow_period: { type: 'number' },
          comparator: { type: 'string', enum: ['above', 'below'] },
          direction: { type: 'string', enum: ['above', 'below', 'bullish', 'bearish'] },
          value: { type: 'number' },
          use_htf: {
            type: 'boolean',
            description: 'If true, evaluate this rule against htf_timeframe candles instead of the primary timeframe (daily bias / HTF support-resistance). Requires htf_timeframe to be set on the spec.'
          }
        },
        required: ['indicator']
      }
    },
    exit_rules: {
      type: 'object',
      properties: {
        stop_loss_pct: { type: 'number' },
        take_profit_pct: { type: 'number' },
        trailing_stop_pct: { type: 'number' },
        max_hold_candles: { type: 'number' },
        opposite_signal_exit: { type: 'boolean' }
      }
    }
  },
  required: ['assets', 'timeframe', 'leverage', 'side', 'position_sizing', 'entry_logic', 'entry_rules', 'exit_rules']
};

const SYSTEM_PROMPT = `És um assistente de estratégias de paper trading (dinheiro simulado, futuros lineares USDT na Bybit). Falas sempre em português.

O teu papel é traduzir descrições em texto livre do utilizador para uma especificação estruturada e limitada (não escreves lógica arbitrária — só preenches parâmetros de um esquema fixo). Isto é o que torna possível fazer backtesting determinístico.

Indicadores suportados nesta versão: RSI, cruzamento de médias móveis (ma_cross), rutura de máximo/mínimo (breakout), preço vs. média móvel (price_vs_ma).

Timeframe superior (multi-timeframe): qualquer entry_rule pode ter "use_htf: true" para ser avaliada num timeframe superior (htf_timeframe) em vez do timeframe principal — isto serve para aproximar conceitos como "bias diário" (ex: price_vs_ma com use_htf no diário) ou "suporte/resistência de timeframe superior" (ex: breakout com use_htf no 4h/diário). htf_timeframe tem de ser estritamente maior do que o timeframe da estratégia.

Regras importantes:
- Até 3 ativos (símbolos lineares Bybit, ex: BTCUSDT). Se o utilizador pedir sugestões, sugere tu mesmo e explica porquê.
- Se o utilizador não especificar o timeframe, escolhe um razoável para a estratégia descrita e explica a escolha — mas deixa claro que é ajustável.
- Alavancagem máxima permitida: 10x.
- SEMPRE que estiveres a propor uma estratégia nova ou uma alteração a uma existente, usa a ferramenta propose_strategy_spec — nunca apliques nada sem o utilizador ver e confirmar primeiro. Explica a proposta em português simples na tua resposta de texto, e deixa a estrutura exata para a ferramenta.
- Se a mensagem do utilizador for só uma pergunta ou comentário (não uma mudança de estratégia), responde só em texto, sem chamar a ferramenta.
- Se o utilizador descrever critérios que NÃO têm correspondência nos indicadores suportados (ex: zonas de liquidez, equal highs/lows, sweeps, notícias económicas/calendário macro, order blocks, análise discricionária de price action) — NUNCA os ignores silenciosamente. Diz explicitamente, na tua resposta de texto, quais critérios não consegues incluir na especificação estruturada e porquê (ainda não suportado nesta versão), antes de propores a parte que consegues aproximar.
- Sê direto e conciso.`;

async function chat(messages) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY não configurada no servidor');
  }

  const res = await axios.post(API_URL, {
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages,
    tools: [{
      name: 'propose_strategy_spec',
      description: 'Propõe uma especificação de estratégia (nova ou atualizada) para o utilizador rever e confirmar.',
      input_schema: STRATEGY_SPEC_SCHEMA
    }]
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    timeout: 60000
  });

  const content = res.data.content || [];
  const textBlock = content.find(b => b.type === 'text');
  const toolBlock = content.find(b => b.type === 'tool_use' && b.name === 'propose_strategy_spec');

  return {
    reply: textBlock?.text || '',
    proposedSpec: toolBlock?.input || null
  };
}

module.exports = { chat, STRATEGY_SPEC_SCHEMA };
