const axios = require('axios');

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';
const ETHERSCAN_BASE = 'https://api.etherscan.io/api';

async function getBalances(address, apiKey) {
  try {
    const balances = [];
    let totalUsdt = 0;

    // ETH balance via Etherscan
    const ethRes = await axios.get(ETHERSCAN_BASE, {
      params: {
        module: 'account',
        action: 'balance',
        address,
        tag: 'latest',
        apikey: apiKey
      },
      timeout: 10000
    });

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

module.exports = { getBalances, getPositions };