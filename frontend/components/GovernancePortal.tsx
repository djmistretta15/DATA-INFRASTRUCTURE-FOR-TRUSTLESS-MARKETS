/**
 * Oracle Governance Portal - DAO Management Interface
 * Production-grade governance UI with proposal management, voting, and delegation
 * 1000+ LoC as specified
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useSubscription, gql } from '@apollo/client';
import { formatDistance, format } from 'date-fns';
import { ethers } from 'ethers';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell
} from 'recharts';

// GraphQL Queries
const GET_PROPOSALS = gql`
  query GetProposals($status: ProposalStatus, $first: Int, $skip: Int) {
    proposals(status: $status, first: $first, skip: $skip, orderBy: "createdAt", orderDirection: "desc") {
      id
      proposer
      description
      targets
      values
      calldatas
      startBlock
      endBlock
      forVotes
      againstVotes
      abstainVotes
      state
      eta
      createdAt
      executedAt
    }
    governanceStats {
      totalProposals
      activeProposals
      passedProposals
      defeatedProposals
      totalVoters
      quorumVotes
      proposalThreshold
    }
  }
`;

const GET_VOTER_INFO = gql`
  query GetVoterInfo($address: String!) {
    voter(address: $address) {
      votingPower
      delegatedTo
      delegatedFrom {
        address
        votes
      }
      proposalsVoted {
        proposalId
        support
        votes
        reason
      }
      proposalsCreated {
        id
        description
        state
      }
    }
  }
`;

const GET_PROPOSAL_DETAILS = gql`
  query GetProposalDetails($id: ID!) {
    proposal(id: $id) {
      id
      proposer
      description
      targets
      values
      calldatas
      signatures
      startBlock
      endBlock
      forVotes
      againstVotes
      abstainVotes
      state
      eta
      createdAt
      executedAt
      votes {
        voter
        support
        votes
        reason
        timestamp
      }
      actions {
        target
        value
        signature
        calldata
        description
      }
    }
  }
`;

const CAST_VOTE = gql`
  mutation CastVote($proposalId: ID!, $support: Int!, $reason: String) {
    castVote(proposalId: $proposalId, support: $support, reason: $reason) {
      success
      transactionHash
      votes
    }
  }
`;

const DELEGATE_VOTES = gql`
  mutation DelegateVotes($delegatee: String!) {
    delegateVotes(delegatee: $delegatee) {
      success
      transactionHash
    }
  }
`;

const CREATE_PROPOSAL = gql`
  mutation CreateProposal($input: ProposalInput!) {
    createProposal(input: $input) {
      success
      proposalId
      transactionHash
    }
  }
`;

const QUEUE_PROPOSAL = gql`
  mutation QueueProposal($proposalId: ID!) {
    queueProposal(proposalId: $proposalId) {
      success
      transactionHash
    }
  }
`;

const EXECUTE_PROPOSAL = gql`
  mutation ExecuteProposal($proposalId: ID!) {
    executeProposal(proposalId: $proposalId) {
      success
      transactionHash
    }
  }
`;

const SUBSCRIBE_VOTES = gql`
  subscription OnVoteCast($proposalId: ID!) {
    voteCast(proposalId: $proposalId) {
      voter
      support
      votes
      reason
      timestamp
    }
  }
`;

// Types
interface Proposal {
  id: string;
  proposer: string;
  description: string;
  targets: string[];
  values: string[];
  calldatas: string[];
  startBlock: number;
  endBlock: number;
  forVotes: string;
  againstVotes: string;
  abstainVotes: string;
  state: ProposalState;
  eta: number;
  createdAt: string;
  executedAt: string | null;
}

interface Vote {
  voter: string;
  support: number;
  votes: string;
  reason: string;
  timestamp: string;
}

interface VoterInfo {
  votingPower: string;
  delegatedTo: string | null;
  delegatedFrom: { address: string; votes: string }[];
  proposalsVoted: { proposalId: string; support: number; votes: string }[];
  proposalsCreated: { id: string; description: string; state: string }[];
}

enum ProposalState {
  Pending = 'Pending',
  Active = 'Active',
  Canceled = 'Canceled',
  Defeated = 'Defeated',
  Succeeded = 'Succeeded',
  Queued = 'Queued',
  Expired = 'Expired',
  Executed = 'Executed'
}

// Component
const GovernancePortal: React.FC = () => {
  // State
  const [connectedAddress, setConnectedAddress] = useState<string | null>(null);
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'proposals' | 'vote' | 'delegate' | 'create'>('overview');
  const [filterStatus, setFilterStatus] = useState<ProposalState | 'all'>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [voteReason, setVoteReason] = useState('');
  const [delegateeAddress, setDelegateeAddress] = useState('');

  // Create proposal form state
  const [proposalForm, setProposalForm] = useState({
    description: '',
    targets: [''],
    values: ['0'],
    calldatas: ['0x'],
    signatures: ['']
  });

  // Queries
  const { data: proposalsData, loading: proposalsLoading, refetch: refetchProposals } = useQuery(GET_PROPOSALS, {
    variables: { status: filterStatus === 'all' ? null : filterStatus, first: 50, skip: 0 },
    pollInterval: 30000
  });

  const { data: voterData, loading: voterLoading } = useQuery(GET_VOTER_INFO, {
    variables: { address: connectedAddress },
    skip: !connectedAddress
  });

  const { data: proposalDetails } = useQuery(GET_PROPOSAL_DETAILS, {
    variables: { id: selectedProposal?.id },
    skip: !selectedProposal
  });

  // Mutations
  const [castVote, { loading: votingLoading }] = useMutation(CAST_VOTE);
  const [delegateVotes, { loading: delegatingLoading }] = useMutation(DELEGATE_VOTES);
  const [createProposal, { loading: creatingLoading }] = useMutation(CREATE_PROPOSAL);
  const [queueProposal, { loading: queuingLoading }] = useMutation(QUEUE_PROPOSAL);
  const [executeProposal, { loading: executingLoading }] = useMutation(EXECUTE_PROPOSAL);

  // Subscriptions
  useSubscription(SUBSCRIBE_VOTES, {
    variables: { proposalId: selectedProposal?.id },
    skip: !selectedProposal,
    onSubscriptionData: ({ subscriptionData }) => {
      console.log('New vote:', subscriptionData.data?.voteCast);
      refetchProposals();
    }
  });

  // Connect wallet
  const connectWallet = useCallback(async () => {
    if (typeof window.ethereum !== 'undefined') {
      try {
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        setConnectedAddress(accounts[0]);
      } catch (error) {
        console.error('Failed to connect wallet:', error);
      }
    } else {
      alert('Please install MetaMask');
    }
  }, []);

  // Vote handlers
  const handleVote = useCallback(async (support: number) => {
    if (!selectedProposal) return;

    try {
      const result = await castVote({
        variables: {
          proposalId: selectedProposal.id,
          support,
          reason: voteReason
        }
      });

      if (result.data.castVote.success) {
        alert(`Vote cast successfully! TX: ${result.data.castVote.transactionHash}`);
        setVoteReason('');
        refetchProposals();
      }
    } catch (error) {
      console.error('Voting failed:', error);
      alert('Failed to cast vote');
    }
  }, [selectedProposal, voteReason, castVote, refetchProposals]);

  // Delegation handler
  const handleDelegate = useCallback(async () => {
    if (!ethers.utils.isAddress(delegateeAddress)) {
      alert('Invalid address');
      return;
    }

    try {
      const result = await delegateVotes({
        variables: { delegatee: delegateeAddress }
      });

      if (result.data.delegateVotes.success) {
        alert(`Delegation successful! TX: ${result.data.delegateVotes.transactionHash}`);
        setDelegateeAddress('');
      }
    } catch (error) {
      console.error('Delegation failed:', error);
      alert('Failed to delegate votes');
    }
  }, [delegateeAddress, delegateVotes]);

  // Create proposal handler
  const handleCreateProposal = useCallback(async () => {
    try {
      const result = await createProposal({
        variables: { input: proposalForm }
      });

      if (result.data.createProposal.success) {
        alert(`Proposal created! ID: ${result.data.createProposal.proposalId}`);
        setShowCreateModal(false);
        setProposalForm({
          description: '',
          targets: [''],
          values: ['0'],
          calldatas: ['0x'],
          signatures: ['']
        });
        refetchProposals();
      }
    } catch (error) {
      console.error('Proposal creation failed:', error);
      alert('Failed to create proposal');
    }
  }, [proposalForm, createProposal, refetchProposals]);

  // Queue proposal handler
  const handleQueueProposal = useCallback(async (proposalId: string) => {
    try {
      const result = await queueProposal({ variables: { proposalId } });
      if (result.data.queueProposal.success) {
        alert('Proposal queued for execution');
        refetchProposals();
      }
    } catch (error) {
      console.error('Queue failed:', error);
    }
  }, [queueProposal, refetchProposals]);

  // Execute proposal handler
  const handleExecuteProposal = useCallback(async (proposalId: string) => {
    try {
      const result = await executeProposal({ variables: { proposalId } });
      if (result.data.executeProposal.success) {
        alert('Proposal executed successfully!');
        refetchProposals();
      }
    } catch (error) {
      console.error('Execution failed:', error);
    }
  }, [executeProposal, refetchProposals]);

  // Computed values
  const stats = useMemo(() => proposalsData?.governanceStats || {
    totalProposals: 0,
    activeProposals: 0,
    passedProposals: 0,
    defeatedProposals: 0,
    totalVoters: 0,
    quorumVotes: '0',
    proposalThreshold: '0'
  }, [proposalsData]);

  const votingPowerFormatted = useMemo(() => {
    if (!voterData?.voter?.votingPower) return '0';
    return ethers.utils.formatEther(voterData.voter.votingPower);
  }, [voterData]);

  const proposalVoteDistribution = useMemo(() => {
    if (!selectedProposal) return [];

    const forVotes = parseFloat(ethers.utils.formatEther(selectedProposal.forVotes));
    const againstVotes = parseFloat(ethers.utils.formatEther(selectedProposal.againstVotes));
    const abstainVotes = parseFloat(ethers.utils.formatEther(selectedProposal.abstainVotes));
    const total = forVotes + againstVotes + abstainVotes;

    return [
      { name: 'For', value: forVotes, percentage: total > 0 ? (forVotes / total * 100).toFixed(2) : 0 },
      { name: 'Against', value: againstVotes, percentage: total > 0 ? (againstVotes / total * 100).toFixed(2) : 0 },
      { name: 'Abstain', value: abstainVotes, percentage: total > 0 ? (abstainVotes / total * 100).toFixed(2) : 0 }
    ];
  }, [selectedProposal]);

  const VOTE_COLORS = ['#22c55e', '#ef4444', '#6b7280'];

  const getStateColor = (state: ProposalState): string => {
    switch (state) {
      case ProposalState.Active: return '#3b82f6';
      case ProposalState.Succeeded:
      case ProposalState.Executed: return '#22c55e';
      case ProposalState.Defeated:
      case ProposalState.Canceled:
      case ProposalState.Expired: return '#ef4444';
      case ProposalState.Queued: return '#f59e0b';
      default: return '#6b7280';
    }
  };

  const formatAddress = (address: string): string => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  // Render functions
  const renderOverview = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-gray-400 text-sm">Total Proposals</h3>
          <p className="text-2xl font-bold text-white">{stats.totalProposals}</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-gray-400 text-sm">Active Proposals</h3>
          <p className="text-2xl font-bold text-blue-400">{stats.activeProposals}</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-gray-400 text-sm">Passed Proposals</h3>
          <p className="text-2xl font-bold text-green-400">{stats.passedProposals}</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-gray-400 text-sm">Total Voters</h3>
          <p className="text-2xl font-bold text-purple-400">{stats.totalVoters}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-gray-800 rounded-lg p-4">
          <h3 className="text-lg font-semibold text-white mb-4">Proposal Outcomes</h3>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie
                data={[
                  { name: 'Passed', value: stats.passedProposals },
                  { name: 'Defeated', value: stats.defeatedProposals },
                  { name: 'Active', value: stats.activeProposals }
                ]}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                dataKey="value"
                label
              >
                {['#22c55e', '#ef4444', '#3b82f6'].map((color, index) => (
                  <Cell key={`cell-${index}`} fill={color} />
                ))}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {connectedAddress && voterData && (
          <div className="bg-gray-800 rounded-lg p-4">
            <h3 className="text-lg font-semibold text-white mb-4">Your Voting Power</h3>
            <div className="space-y-4">
              <div>
                <p className="text-gray-400 text-sm">Current Power</p>
                <p className="text-3xl font-bold text-indigo-400">
                  {parseFloat(votingPowerFormatted).toLocaleString()} votes
                </p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Delegated To</p>
                <p className="text-white">
                  {voterData.voter.delegatedTo
                    ? formatAddress(voterData.voter.delegatedTo)
                    : 'Self'}
                </p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Delegations Received</p>
                <p className="text-white">{voterData.voter.delegatedFrom.length}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Proposals Voted On</p>
                <p className="text-white">{voterData.voter.proposalsVoted.length}</p>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-lg font-semibold text-white mb-4">Governance Parameters</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <p className="text-gray-400 text-sm">Quorum Threshold</p>
            <p className="text-white font-mono">
              {ethers.utils.formatEther(stats.quorumVotes)} votes
            </p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Proposal Threshold</p>
            <p className="text-white font-mono">
              {ethers.utils.formatEther(stats.proposalThreshold)} votes
            </p>
          </div>
          <div>
            <p className="text-gray-400 text-sm">Voting Period</p>
            <p className="text-white font-mono">7 days</p>
          </div>
        </div>
      </div>
    </div>
  );

  const renderProposalsList = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex space-x-2">
          {['all', ...Object.values(ProposalState)].map((status) => (
            <button
              key={status}
              onClick={() => setFilterStatus(status as any)}
              className={`px-3 py-1 rounded text-sm ${
                filterStatus === status
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {status === 'all' ? 'All' : status}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
        >
          Create Proposal
        </button>
      </div>

      {proposalsLoading ? (
        <div className="text-center py-8 text-gray-400">Loading proposals...</div>
      ) : (
        <div className="space-y-3">
          {proposalsData?.proposals.map((proposal: Proposal) => (
            <div
              key={proposal.id}
              className="bg-gray-800 rounded-lg p-4 hover:bg-gray-750 cursor-pointer transition-colors"
              onClick={() => setSelectedProposal(proposal)}
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <div className="flex items-center space-x-2">
                    <span className="text-gray-400 text-sm">#{proposal.id}</span>
                    <span
                      className="px-2 py-0.5 rounded text-xs font-semibold"
                      style={{ backgroundColor: getStateColor(proposal.state), color: 'white' }}
                    >
                      {proposal.state}
                    </span>
                  </div>
                  <h4 className="text-white font-medium mt-1">
                    {proposal.description.slice(0, 100)}
                    {proposal.description.length > 100 && '...'}
                  </h4>
                  <p className="text-gray-400 text-sm mt-1">
                    Proposed by {formatAddress(proposal.proposer)} •{' '}
                    {formatDistance(new Date(proposal.createdAt), new Date(), { addSuffix: true })}
                  </p>
                </div>
                <div className="text-right">
                  <div className="text-green-400 text-sm">
                    For: {parseFloat(ethers.utils.formatEther(proposal.forVotes)).toLocaleString()}
                  </div>
                  <div className="text-red-400 text-sm">
                    Against: {parseFloat(ethers.utils.formatEther(proposal.againstVotes)).toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderVotingInterface = () => {
    if (!selectedProposal) {
      return (
        <div className="text-center py-8 text-gray-400">
          Select a proposal from the list to vote
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="bg-gray-800 rounded-lg p-6">
          <div className="flex justify-between items-start mb-4">
            <div>
              <span className="text-gray-400">Proposal #{selectedProposal.id}</span>
              <h2 className="text-xl font-bold text-white mt-1">
                {selectedProposal.description}
              </h2>
            </div>
            <span
              className="px-3 py-1 rounded text-sm font-semibold"
              style={{ backgroundColor: getStateColor(selectedProposal.state), color: 'white' }}
            >
              {selectedProposal.state}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h3 className="text-white font-semibold mb-3">Vote Distribution</h3>
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={proposalVoteDistribution}
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    dataKey="value"
                    label={({ name, percentage }) => `${name}: ${percentage}%`}
                  >
                    {proposalVoteDistribution.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={VOTE_COLORS[index]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => `${parseFloat(value as string).toLocaleString()} votes`} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-gray-400 text-sm">Proposed By</p>
                <p className="text-white font-mono">{selectedProposal.proposer}</p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Voting Period</p>
                <p className="text-white">
                  Block {selectedProposal.startBlock} - {selectedProposal.endBlock}
                </p>
              </div>
              <div>
                <p className="text-gray-400 text-sm">Created</p>
                <p className="text-white">
                  {format(new Date(selectedProposal.createdAt), 'PPpp')}
                </p>
              </div>
            </div>
          </div>
        </div>

        {selectedProposal.state === ProposalState.Active && connectedAddress && (
          <div className="bg-gray-800 rounded-lg p-6">
            <h3 className="text-white font-semibold mb-4">Cast Your Vote</h3>
            <div className="space-y-4">
              <div>
                <label className="text-gray-400 text-sm block mb-2">
                  Reason (optional)
                </label>
                <textarea
                  value={voteReason}
                  onChange={(e) => setVoteReason(e.target.value)}
                  className="w-full bg-gray-700 text-white rounded p-3 border border-gray-600"
                  rows={3}
                  placeholder="Explain your vote..."
                />
              </div>
              <div className="flex space-x-4">
                <button
                  onClick={() => handleVote(1)}
                  disabled={votingLoading}
                  className="flex-1 bg-green-600 text-white py-3 rounded font-semibold hover:bg-green-700 disabled:opacity-50"
                >
                  Vote For
                </button>
                <button
                  onClick={() => handleVote(0)}
                  disabled={votingLoading}
                  className="flex-1 bg-red-600 text-white py-3 rounded font-semibold hover:bg-red-700 disabled:opacity-50"
                >
                  Vote Against
                </button>
                <button
                  onClick={() => handleVote(2)}
                  disabled={votingLoading}
                  className="flex-1 bg-gray-600 text-white py-3 rounded font-semibold hover:bg-gray-500 disabled:opacity-50"
                >
                  Abstain
                </button>
              </div>
            </div>
          </div>
        )}

        {selectedProposal.state === ProposalState.Succeeded && (
          <div className="bg-gray-800 rounded-lg p-6">
            <h3 className="text-white font-semibold mb-4">Queue for Execution</h3>
            <button
              onClick={() => handleQueueProposal(selectedProposal.id)}
              disabled={queuingLoading}
              className="bg-yellow-600 text-white px-6 py-3 rounded font-semibold hover:bg-yellow-700 disabled:opacity-50"
            >
              Queue Proposal
            </button>
          </div>
        )}

        {selectedProposal.state === ProposalState.Queued && selectedProposal.eta && (
          <div className="bg-gray-800 rounded-lg p-6">
            <h3 className="text-white font-semibold mb-4">Execute Proposal</h3>
            <p className="text-gray-400 mb-4">
              Executable after: {format(new Date(selectedProposal.eta * 1000), 'PPpp')}
            </p>
            <button
              onClick={() => handleExecuteProposal(selectedProposal.id)}
              disabled={executingLoading || Date.now() < selectedProposal.eta * 1000}
              className="bg-indigo-600 text-white px-6 py-3 rounded font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              Execute Proposal
            </button>
          </div>
        )}

        {proposalDetails?.proposal?.votes && (
          <div className="bg-gray-800 rounded-lg p-6">
            <h3 className="text-white font-semibold mb-4">Recent Votes</h3>
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {proposalDetails.proposal.votes.slice(0, 20).map((vote: Vote, index: number) => (
                <div key={index} className="flex justify-between items-center border-b border-gray-700 pb-2">
                  <div>
                    <p className="text-white font-mono text-sm">{formatAddress(vote.voter)}</p>
                    {vote.reason && <p className="text-gray-400 text-xs">{vote.reason}</p>}
                  </div>
                  <div className="text-right">
                    <span
                      className={`px-2 py-1 rounded text-xs ${
                        vote.support === 1 ? 'bg-green-600' : vote.support === 0 ? 'bg-red-600' : 'bg-gray-600'
                      }`}
                    >
                      {vote.support === 1 ? 'For' : vote.support === 0 ? 'Against' : 'Abstain'}
                    </span>
                    <p className="text-gray-400 text-xs mt-1">
                      {parseFloat(ethers.utils.formatEther(vote.votes)).toLocaleString()} votes
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderDelegation = () => (
    <div className="space-y-6">
      <div className="bg-gray-800 rounded-lg p-6">
        <h3 className="text-white font-semibold mb-4">Delegate Your Votes</h3>
        <p className="text-gray-400 mb-4">
          Delegate your voting power to another address. They will vote on your behalf.
          You can reclaim your votes by delegating to yourself.
        </p>
        <div className="space-y-4">
          <div>
            <label className="text-gray-400 text-sm block mb-2">Delegatee Address</label>
            <input
              type="text"
              value={delegateeAddress}
              onChange={(e) => setDelegateeAddress(e.target.value)}
              placeholder="0x..."
              className="w-full bg-gray-700 text-white rounded p-3 border border-gray-600 font-mono"
            />
          </div>
          <div className="flex space-x-4">
            <button
              onClick={handleDelegate}
              disabled={delegatingLoading || !delegateeAddress}
              className="bg-indigo-600 text-white px-6 py-3 rounded font-semibold hover:bg-indigo-700 disabled:opacity-50"
            >
              Delegate Votes
            </button>
            <button
              onClick={() => {
                if (connectedAddress) setDelegateeAddress(connectedAddress);
              }}
              className="bg-gray-600 text-white px-6 py-3 rounded font-semibold hover:bg-gray-500"
            >
              Delegate to Self
            </button>
          </div>
        </div>
      </div>

      {voterData?.voter?.delegatedFrom && voterData.voter.delegatedFrom.length > 0 && (
        <div className="bg-gray-800 rounded-lg p-6">
          <h3 className="text-white font-semibold mb-4">Delegations Received</h3>
          <div className="space-y-2">
            {voterData.voter.delegatedFrom.map((delegation: any, index: number) => (
              <div key={index} className="flex justify-between items-center border-b border-gray-700 pb-2">
                <span className="text-white font-mono">{formatAddress(delegation.address)}</span>
                <span className="text-indigo-400">
                  {parseFloat(ethers.utils.formatEther(delegation.votes)).toLocaleString()} votes
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderCreateProposal = () => (
    <div className="bg-gray-800 rounded-lg p-6">
      <h3 className="text-white font-semibold mb-4">Create New Proposal</h3>
      <p className="text-gray-400 mb-6">
        Minimum voting power required: {ethers.utils.formatEther(stats.proposalThreshold)} votes
      </p>

      <div className="space-y-6">
        <div>
          <label className="text-gray-400 text-sm block mb-2">Description</label>
          <textarea
            value={proposalForm.description}
            onChange={(e) => setProposalForm({ ...proposalForm, description: e.target.value })}
            className="w-full bg-gray-700 text-white rounded p-3 border border-gray-600"
            rows={4}
            placeholder="Describe your proposal..."
          />
        </div>

        <div>
          <label className="text-gray-400 text-sm block mb-2">Actions</label>
          {proposalForm.targets.map((target, index) => (
            <div key={index} className="space-y-2 mb-4 p-4 bg-gray-700 rounded">
              <input
                type="text"
                value={target}
                onChange={(e) => {
                  const newTargets = [...proposalForm.targets];
                  newTargets[index] = e.target.value;
                  setProposalForm({ ...proposalForm, targets: newTargets });
                }}
                placeholder="Target address (0x...)"
                className="w-full bg-gray-600 text-white rounded p-2 font-mono"
              />
              <input
                type="text"
                value={proposalForm.signatures[index]}
                onChange={(e) => {
                  const newSignatures = [...proposalForm.signatures];
                  newSignatures[index] = e.target.value;
                  setProposalForm({ ...proposalForm, signatures: newSignatures });
                }}
                placeholder="Function signature (e.g., transfer(address,uint256))"
                className="w-full bg-gray-600 text-white rounded p-2 font-mono"
              />
              <input
                type="text"
                value={proposalForm.values[index]}
                onChange={(e) => {
                  const newValues = [...proposalForm.values];
                  newValues[index] = e.target.value;
                  setProposalForm({ ...proposalForm, values: newValues });
                }}
                placeholder="Value in wei"
                className="w-full bg-gray-600 text-white rounded p-2 font-mono"
              />
              <input
                type="text"
                value={proposalForm.calldatas[index]}
                onChange={(e) => {
                  const newCalldatas = [...proposalForm.calldatas];
                  newCalldatas[index] = e.target.value;
                  setProposalForm({ ...proposalForm, calldatas: newCalldatas });
                }}
                placeholder="Calldata (0x...)"
                className="w-full bg-gray-600 text-white rounded p-2 font-mono"
              />
            </div>
          ))}
          <button
            onClick={() =>
              setProposalForm({
                ...proposalForm,
                targets: [...proposalForm.targets, ''],
                values: [...proposalForm.values, '0'],
                calldatas: [...proposalForm.calldatas, '0x'],
                signatures: [...proposalForm.signatures, '']
              })
            }
            className="text-indigo-400 text-sm hover:text-indigo-300"
          >
            + Add Action
          </button>
        </div>

        <button
          onClick={handleCreateProposal}
          disabled={creatingLoading || !proposalForm.description}
          className="w-full bg-green-600 text-white py-3 rounded font-semibold hover:bg-green-700 disabled:opacity-50"
        >
          Submit Proposal
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Oracle Governance Portal</h1>
          {connectedAddress ? (
            <div className="flex items-center space-x-4">
              <div className="text-right">
                <p className="text-gray-400 text-sm">Connected</p>
                <p className="font-mono">{formatAddress(connectedAddress)}</p>
              </div>
              <div className="bg-indigo-600 px-3 py-1 rounded">
                {votingPowerFormatted} votes
              </div>
            </div>
          ) : (
            <button
              onClick={connectWallet}
              className="bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700"
            >
              Connect Wallet
            </button>
          )}
        </div>

        {/* Navigation */}
        <div className="flex space-x-1 mb-8 bg-gray-800 rounded-lg p-1">
          {[
            { key: 'overview', label: 'Overview' },
            { key: 'proposals', label: 'Proposals' },
            { key: 'vote', label: 'Vote' },
            { key: 'delegate', label: 'Delegate' },
            { key: 'create', label: 'Create' }
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              className={`flex-1 py-2 rounded text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div>
          {activeTab === 'overview' && renderOverview()}
          {activeTab === 'proposals' && renderProposalsList()}
          {activeTab === 'vote' && renderVotingInterface()}
          {activeTab === 'delegate' && renderDelegation()}
          {activeTab === 'create' && renderCreateProposal()}
        </div>
      </div>
    </div>
  );
};

export default GovernancePortal;
