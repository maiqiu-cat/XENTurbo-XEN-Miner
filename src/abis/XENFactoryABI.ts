// XENFactoryUpgradeable (V2) ABI - the deployed miner factory contract.
// Only the members used by this app are included.
export const XENFactoryABI = [
  {
    inputs: [],
    name: 'FEE',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'vmuCount',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'term', type: 'uint256' },
      { internalType: 'uint256', name: 'count', type: 'uint256' }
    ],
    name: 'bulkClaimRank',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256', name: 'term', type: 'uint256' },
      { internalType: 'uint256', name: 'count', type: 'uint256' }
    ],
    name: 'bulkClaimRank_',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'uint256', name: 'count', type: 'uint256' }],
    name: 'createVMUs',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'uint256', name: 'count', type: 'uint256' }],
    name: 'createVMUs_',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      { internalType: 'uint256', name: 'term', type: 'uint256' }
    ],
    name: 'reuseVMUs',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      { internalType: 'uint256', name: 'term', type: 'uint256' }
    ],
    name: 'reuseVMUs_',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'uint256[]', name: 'ids', type: 'uint256[]' }],
    name: 'bulkClaimMintReward',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'uint256[]', name: 'ids', type: 'uint256[]' }],
    name: 'bulkClaimMintReward_',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      { internalType: 'uint256', name: 'term', type: 'uint256' }
    ],
    name: 'bulkClaimMintRewardAndClaimRank',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [
      { internalType: 'uint256[]', name: 'ids', type: 'uint256[]' },
      { internalType: 'uint256', name: 'term', type: 'uint256' }
    ],
    name: 'bulkClaimMintRewardAndClaimRank_',
    outputs: [],
    stateMutability: 'payable',
    type: 'function'
  },
  {
    inputs: [{ internalType: 'uint256[]', name: 'ids', type: 'uint256[]' }],
    name: 'destroyVMUs',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const
