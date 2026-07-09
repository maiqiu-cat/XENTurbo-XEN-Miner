// Official XENCrypto ABI - only the read members used by this app.
export const XENCryptoABI = [
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'userMints',
    outputs: [
      { internalType: 'address', name: 'user', type: 'address' },
      { internalType: 'uint256', name: 'term', type: 'uint256' },
      { internalType: 'uint256', name: 'maturityTs', type: 'uint256' },
      { internalType: 'uint256', name: 'rank', type: 'uint256' },
      { internalType: 'uint256', name: 'amplifier', type: 'uint256' },
      { internalType: 'uint256', name: 'eaaRate', type: 'uint256' }
    ],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [],
    name: 'globalRank',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const
