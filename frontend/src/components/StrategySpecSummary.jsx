const INDICATOR_LABELS = {
  rsi: r => `RSI(${r.period}) ${r.comparator === 'below' ? 'abaixo' : 'acima'} de ${r.value}`,
  ma_cross: r => `Cruzamento de médias ${r.fast_period}/${r.slow_period} (${r.direction === 'bullish' ? 'alta' : 'baixa'})`,
  price_vs_ma: r => `Preço ${r.comparator === 'above' ? 'acima' : 'abaixo'} da média de ${r.period}`,
  breakout: r => `Rutura de ${r.period} períodos (${r.direction === 'above' ? 'máximo' : 'mínimo'})`
}

const SIDE_LABELS = { long: 'Só compra (long)', short: 'Só venda (short)', both: 'Ambas as direções' }

export default function StrategySpecSummary({ assets, timeframe, spec }) {
  if (!spec) return null
  const rules = spec.entry_rules || []
  const exit = spec.exit_rules || {}
  const sizing = spec.position_sizing || {}

  return (
    <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', lineHeight: 1.8, color: '#cbd5e1' }}>
      {assets?.length > 0 && <li>Ativos: <strong>{assets.join(', ')}</strong></li>}
      {timeframe && <li>Timeframe: <strong>{timeframe}</strong></li>}
      {spec.htf_timeframe && <li>Timeframe superior: <strong>{spec.htf_timeframe}</strong></li>}
      {spec.leverage && <li>Alavancagem: <strong>{spec.leverage}x</strong></li>}
      {spec.side && <li>Direção: <strong>{SIDE_LABELS[spec.side] || spec.side}</strong></li>}
      {sizing.value && <li>Dimensionamento: <strong>{sizing.type === 'pct_capital' ? `${sizing.value}% do capital` : `$${sizing.value} fixos`}</strong></li>}
      {rules.length > 0 && (
        <li>
          Entrada ({spec.entry_logic === 'any' ? 'qualquer uma' : 'todas'}):
          <ul style={{ margin: '4px 0' }}>
            {rules.map((r, i) => (
              <li key={i}>
                {INDICATOR_LABELS[r.indicator]?.(r) || r.indicator}
                {r.use_htf && <strong> (timeframe superior)</strong>}
              </li>
            ))}
          </ul>
        </li>
      )}
      {(exit.stop_loss_pct || exit.take_profit_pct || exit.trailing_stop_pct || exit.max_hold_candles) && (
        <li>
          Saída:
          <ul style={{ margin: '4px 0' }}>
            {exit.stop_loss_pct && <li>stop-loss {exit.stop_loss_pct}%</li>}
            {exit.take_profit_pct && <li>take-profit {exit.take_profit_pct}%</li>}
            {exit.trailing_stop_pct && <li>trailing stop {exit.trailing_stop_pct}%</li>}
            {exit.max_hold_candles && <li>máximo {exit.max_hold_candles} velas</li>}
            {exit.opposite_signal_exit && <li>sai em sinal contrário</li>}
          </ul>
        </li>
      )}
    </ul>
  )
}
