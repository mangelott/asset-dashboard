const axios = require('axios');

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_CHAIN_ID = 1; // Ethereum mainnet

async function getBalances(address, apiKey) {
  try {
    const balances = [];
    let totalUsdt = 0;

    // ETH balance via Etherscan
    const ethRes = await axios.get(ETHERSCAN_BASE, {
      params: {
        chainid: ETHERSCAN_CHAIN_ID,
        module: 'account',
        action: 'balance',
        address,
        tag: 'latest',
        apikey: apiKey
      },
      timeout: 10000
    });

    if (ethRes.data.status !== '1') {
      throw new Error(ethRes.data.result || ethRes.data.message || 'Etherscan error');
    }

    const ethBalance = parseFloat(ethRes.data.result) / 1e18;

    if (ethBalance > 0) {
      // Buscar preço ETH
      const priceRes = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { timeout: 5000 });
      const ethPrice = priceRes.data?.ethereum?.usd || 0;
      const valueUsdt = ethBalance * ethPrice;
      totalUsdt += valueUsdt;

      balances.push({
        asset: 'ETH',
        free: ethBalance.toString(),
        locked: '0',
        valueUsdt,
        currentPrice: ethPrice,
        avgEntryPrice: 0,
        pnl: 0,
        pnlPct: 0,
        type: 'Spot'
      });
    }

    // ERC-20 tokens via Etherscan
    const tokensRes = await axios.get(ETHERSCAN_BASE, {
      params: {
        chainid: ETHERSCAN_CHAIN_ID,
        module: 'account',
        action: 'tokentx',
        address,
        startblock: 0,
        endblock: 99999999,
        sort: 'desc',
        apikey: apiKey
      },
      timeout: 10000
    });

    if (tokensRes.data.result && Array.isArray(tokensRes.data.result)) {
      const tokenMap = {};
      tokensRes.data.result.forEach(tx => {
        if (!tokenMap[tx.contractAddress]) {
          tokenMap[tx.contractAddress] = {
            symbol: tx.tokenSymbol,
            decimals: parseInt(tx.tokenDecimal),
            contractAddress: tx.contractAddress
          };
        }
      });

      for (const token of Object.values(tokenMap).slice(0, 10)) {
        try {
          const balRes = await axios.get(ETHERSCAN_BASE, {
            params: {
              chainid: ETHERSCAN_CHAIN_ID,
              module: 'account',
              action: 'tokenbalance',
              contractaddress: token.contractAddress,
              address,
              tag: 'latest',
              apikey: apiKey
            },
            timeout: 5000
          });

          const tokenBalance = parseFloat(balRes.data.result) / Math.pow(10, token.decimals);
          if (tokenBalance <= 0) continue;

          let valueUsdt = 0;
          let currentPrice = 0;

          try {
            const cgRes = await axios.get(
              `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${token.contractAddress}&vs_currencies=usd`,
              { timeout: 5000 }
            );
            currentPrice = cgRes.data?.[token.contractAddress.toLowerCase()]?.usd || 0;
            valueUsdt = tokenBalance * currentPrice;
          } catch (e) { }

          totalUsdt += valueUsdt;
          balances.push({
            asset: token.symbol,
            free: tokenBalance.toString(),
            locked: '0',
            valueUsdt,
            currentPrice,
            avgEntryPrice: 0,
            pnl: 0,
            pnlPct: 0,
            type: 'Spot'
          });
        } catch (e) { }
      }
    }

    return { balances, totalUsdt };
  } catch (e) {
    console.error('Erro Wallet ETH:', e.message);
    throw e;
  }
}

async function getPositions() {
  return [];
}

const ETH_STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'FRAX', 'LUSD', 'GUSD']);

async function getSpotPositions(address, apiKey) {
  const { balances } = await getBalances(address, apiKey);
  return balances
    .filter(b => !ETH_STABLECOINS.has(b.asset) && b.valueUsdt >= 1)
    .map(b => ({
      asset: b.asset,
      quantity: parseFloat(b.free) + parseFloat(b.locked),
      currentPrice: b.currentPrice,
      valueUsdt: b.valueUsdt,
      avgEntryPrice: 0,
      openValue: 0,
      openDate: null,
      pnl: 0,
      pnlPct: 0
    }));
}

// A wallet has no "buy/sell" concept — this returns raw on-chain transfers
// (in/out) instead, with no P&L (cost basis isn't well-defined for a transfer).
async function getTradeHistory(address, apiKey) {
  const addrLower = address.toLowerCase();
  const transfers = [];

  const ethTxRes = await axios.get(ETHERSCAN_BASE, {
    params: {
      chainid: ETHERSCAN_CHAIN_ID,
      module: 'account',
      action: 'txlist',
      address,
      startblock: 0,
      endblock: 99999999,
      sort: 'desc',
      apikey: apiKey
    },
    timeout: 10000
  });

  // Etherscan returns result as an array even when there are zero transactions
  // (status "0" / "No transactions found") — a non-array result means a real
  // error (bad key, invalid address, rate limit), which must be surfaced.
  if (!Array.isArray(ethTxRes.data.result)) {
    throw new Error(ethTxRes.data.result || ethTxRes.data.message || 'Etherscan error');
  }

  ethTxRes.data.result.slice(0, 100).forEach(tx => {
    const qty = parseFloat(tx.value) / 1e18;
    if (qty <= 0) return;
    transfers.push({
      asset: 'ETH',
      side: tx.to?.toLowerCase() === addrLower ? 'in' : 'out',
      qty,
      price: null,
      pnl: null,
      pnlPct: null,
      date: new Date(parseInt(tx.timeStamp) * 1000).toISOString()
    });
  });

  try {
    const tokenTxRes = await axios.get(ETHERSCAN_BASE, {
      params: {
        chainid: ETHERSCAN_CHAIN_ID,
        module: 'account',
        action: 'tokentx',
        address,
        startblock: 0,
        endblock: 99999999,
        sort: 'desc',
        apikey: apiKey
      },
      timeout: 10000
    });

    if (Array.isArray(tokenTxRes.data.result)) {
      tokenTxRes.data.result.slice(0, 100).forEach(tx => {
        const decimals = parseInt(tx.tokenDecimal || '18');
        const qty = parseFloat(tx.value) / Math.pow(10, decimals);
        if (qty <= 0) return;
        transfers.push({
          asset: tx.tokenSymbol,
          side: tx.to?.toLowerCase() === addrLower ? 'in' : 'out',
          qty,
          price: null,
          pnl: null,
          pnlPct: null,
          date: new Date(parseInt(tx.timeStamp) * 1000).toISOString()
        });
      });
    }
  } catch (e) { /* token tx history unavailable */ }

  return transfers.sort((a, b) => new Date(b.date) - new Date(a.date));
}

module.exports = { getBalances, getPositions, getSpotPositions, getTradeHistory };