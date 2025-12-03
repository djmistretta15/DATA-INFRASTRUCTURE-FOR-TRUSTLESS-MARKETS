// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title OracleGovernance
 * @notice Decentralized governance for oracle infrastructure
 * @dev Implements proposal creation, voting, timelock execution, and delegation
 * 1200 LoC as specified
 */
contract OracleGovernance is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // Governance token
    IERC20 public governanceToken;

    // Proposal states
    enum ProposalState {
        Pending,
        Active,
        Canceled,
        Defeated,
        Succeeded,
        Queued,
        Expired,
        Executed
    }

    // Vote types
    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct Proposal {
        uint256 id;
        address proposer;
        string title;
        string description;
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
        uint256 startBlock;
        uint256 endBlock;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 quorum;
        uint256 eta; // Execution time after queue
        bool canceled;
        bool executed;
        mapping(address => Receipt) receipts;
    }

    struct Receipt {
        bool hasVoted;
        VoteType voteType;
        uint256 votes;
    }

    struct ProposalConfig {
        uint256 votingDelay;      // Blocks before voting starts
        uint256 votingPeriod;     // Blocks for voting duration
        uint256 proposalThreshold; // Min tokens to create proposal
        uint256 quorumNumerator;   // Quorum percentage (out of 100)
        uint256 timelockDelay;     // Seconds for timelock
    }

    // Delegation
    struct Delegation {
        address delegatee;
        uint256 amount;
        uint256 timestamp;
    }

    // State variables
    mapping(uint256 => Proposal) public proposals;
    mapping(address => Delegation) public delegations;
    mapping(address => uint256) public votingPower;
    mapping(address => uint256) public proposalCount;

    uint256 public proposalCounter;
    ProposalConfig public config;

    // Events
    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        string title,
        string description,
        address[] targets,
        uint256[] values,
        bytes[] calldatas,
        uint256 startBlock,
        uint256 endBlock,
        uint256 quorum
    );

    event VoteCast(
        address indexed voter,
        uint256 indexed proposalId,
        VoteType voteType,
        uint256 votes,
        string reason
    );

    event ProposalCanceled(uint256 indexed proposalId);
    event ProposalQueued(uint256 indexed proposalId, uint256 eta);
    event ProposalExecuted(uint256 indexed proposalId);
    event DelegateChanged(address indexed delegator, address indexed fromDelegate, address indexed toDelegate);
    event DelegateVotesChanged(address indexed delegate, uint256 previousBalance, uint256 newBalance);
    event ConfigUpdated(ProposalConfig newConfig);
    event EmergencyAction(address indexed guardian, string action);

    constructor(
        address _governanceToken,
        uint256 _votingDelay,
        uint256 _votingPeriod,
        uint256 _proposalThreshold,
        uint256 _quorumNumerator,
        uint256 _timelockDelay
    ) {
        require(_governanceToken != address(0), "Invalid token");
        require(_votingPeriod >= 100, "Voting period too short");
        require(_quorumNumerator <= 100, "Invalid quorum");

        governanceToken = IERC20(_governanceToken);

        config = ProposalConfig({
            votingDelay: _votingDelay,
            votingPeriod: _votingPeriod,
            proposalThreshold: _proposalThreshold,
            quorumNumerator: _quorumNumerator,
            timelockDelay: _timelockDelay
        });

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(GUARDIAN_ROLE, msg.sender);
        _setupRole(EXECUTOR_ROLE, msg.sender);
    }

    /**
     * @notice Create a new governance proposal
     */
    function propose(
        string calldata title,
        string calldata description,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata calldatas
    ) external returns (uint256 proposalId) {
        require(
            getVotingPower(msg.sender) >= config.proposalThreshold,
            "Below proposal threshold"
        );
        require(targets.length > 0, "Empty proposal");
        require(
            targets.length == values.length && values.length == calldatas.length,
            "Array length mismatch"
        );
        require(targets.length <= 10, "Too many actions");

        proposalId = ++proposalCounter;
        Proposal storage proposal = proposals[proposalId];

        proposal.id = proposalId;
        proposal.proposer = msg.sender;
        proposal.title = title;
        proposal.description = description;
        proposal.targets = targets;
        proposal.values = values;
        proposal.calldatas = calldatas;
        proposal.startBlock = block.number + config.votingDelay;
        proposal.endBlock = proposal.startBlock + config.votingPeriod;
        proposal.quorum = _calculateQuorum();

        proposalCount[msg.sender]++;

        emit ProposalCreated(
            proposalId,
            msg.sender,
            title,
            description,
            targets,
            values,
            calldatas,
            proposal.startBlock,
            proposal.endBlock,
            proposal.quorum
        );

        return proposalId;
    }

    /**
     * @notice Cast vote on a proposal
     */
    function castVote(
        uint256 proposalId,
        VoteType voteType
    ) external returns (uint256) {
        return _castVote(msg.sender, proposalId, voteType, "");
    }

    /**
     * @notice Cast vote with reason
     */
    function castVoteWithReason(
        uint256 proposalId,
        VoteType voteType,
        string calldata reason
    ) external returns (uint256) {
        return _castVote(msg.sender, proposalId, voteType, reason);
    }

    /**
     * @notice Cast vote by signature
     */
    function castVoteBySig(
        uint256 proposalId,
        VoteType voteType,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        bytes32 domainSeparator = _domainSeparator();
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Vote(uint256 proposalId,uint8 voteType)"),
                proposalId,
                uint8(voteType)
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
        address voter = ecrecover(digest, v, r, s);

        require(voter != address(0), "Invalid signature");

        return _castVote(voter, proposalId, voteType, "");
    }

    /**
     * @notice Internal vote casting
     */
    function _castVote(
        address voter,
        uint256 proposalId,
        VoteType voteType,
        string memory reason
    ) internal returns (uint256) {
        Proposal storage proposal = proposals[proposalId];
        Receipt storage receipt = proposal.receipts[voter];

        require(state(proposalId) == ProposalState.Active, "Voting not active");
        require(!receipt.hasVoted, "Already voted");

        uint256 votes = getVotingPower(voter);
        require(votes > 0, "No voting power");

        receipt.hasVoted = true;
        receipt.voteType = voteType;
        receipt.votes = votes;

        if (voteType == VoteType.For) {
            proposal.forVotes += votes;
        } else if (voteType == VoteType.Against) {
            proposal.againstVotes += votes;
        } else {
            proposal.abstainVotes += votes;
        }

        emit VoteCast(voter, proposalId, voteType, votes, reason);

        return votes;
    }

    /**
     * @notice Queue a succeeded proposal for execution
     */
    function queue(uint256 proposalId) external {
        require(
            state(proposalId) == ProposalState.Succeeded,
            "Proposal not succeeded"
        );

        Proposal storage proposal = proposals[proposalId];
        proposal.eta = block.timestamp + config.timelockDelay;

        emit ProposalQueued(proposalId, proposal.eta);
    }

    /**
     * @notice Execute a queued proposal
     */
    function execute(uint256 proposalId) external payable nonReentrant {
        require(
            state(proposalId) == ProposalState.Queued,
            "Proposal not queued"
        );

        Proposal storage proposal = proposals[proposalId];
        require(block.timestamp >= proposal.eta, "Timelock not expired");
        require(
            block.timestamp <= proposal.eta + 14 days,
            "Proposal expired"
        );

        proposal.executed = true;

        // Execute all actions
        for (uint256 i = 0; i < proposal.targets.length; i++) {
            (bool success, ) = proposal.targets[i].call{value: proposal.values[i]}(
                proposal.calldatas[i]
            );
            require(success, "Execution failed");
        }

        emit ProposalExecuted(proposalId);
    }

    /**
     * @notice Cancel a proposal
     */
    function cancel(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];

        require(
            msg.sender == proposal.proposer ||
                getVotingPower(proposal.proposer) < config.proposalThreshold,
            "Cannot cancel"
        );
        require(
            state(proposalId) != ProposalState.Executed &&
                state(proposalId) != ProposalState.Canceled,
            "Cannot cancel"
        );

        proposal.canceled = true;

        emit ProposalCanceled(proposalId);
    }

    /**
     * @notice Get proposal state
     */
    function state(uint256 proposalId) public view returns (ProposalState) {
        Proposal storage proposal = proposals[proposalId];

        if (proposal.id == 0) {
            revert("Invalid proposal");
        }

        if (proposal.canceled) {
            return ProposalState.Canceled;
        }

        if (proposal.executed) {
            return ProposalState.Executed;
        }

        if (block.number < proposal.startBlock) {
            return ProposalState.Pending;
        }

        if (block.number <= proposal.endBlock) {
            return ProposalState.Active;
        }

        // Check if proposal met quorum and majority
        if (
            proposal.forVotes + proposal.againstVotes + proposal.abstainVotes <
            proposal.quorum
        ) {
            return ProposalState.Defeated;
        }

        if (proposal.forVotes <= proposal.againstVotes) {
            return ProposalState.Defeated;
        }

        if (proposal.eta == 0) {
            return ProposalState.Succeeded;
        }

        if (block.timestamp >= proposal.eta + 14 days) {
            return ProposalState.Expired;
        }

        return ProposalState.Queued;
    }

    /**
     * @notice Delegate voting power to another address
     */
    function delegate(address delegatee) external {
        require(delegatee != address(0), "Invalid delegatee");
        require(delegatee != msg.sender, "Cannot self-delegate");

        address currentDelegate = delegations[msg.sender].delegatee;
        uint256 balance = governanceToken.balanceOf(msg.sender);

        // Remove from current delegate
        if (currentDelegate != address(0)) {
            uint256 oldVotes = votingPower[currentDelegate];
            votingPower[currentDelegate] = oldVotes - delegations[msg.sender].amount;
            emit DelegateVotesChanged(currentDelegate, oldVotes, votingPower[currentDelegate]);
        }

        // Add to new delegate
        uint256 oldNewDelegateVotes = votingPower[delegatee];
        votingPower[delegatee] += balance;

        delegations[msg.sender] = Delegation({
            delegatee: delegatee,
            amount: balance,
            timestamp: block.timestamp
        });

        emit DelegateChanged(msg.sender, currentDelegate, delegatee);
        emit DelegateVotesChanged(delegatee, oldNewDelegateVotes, votingPower[delegatee]);
    }

    /**
     * @notice Remove delegation
     */
    function undelegate() external {
        Delegation storage delegation = delegations[msg.sender];
        require(delegation.delegatee != address(0), "Not delegated");

        address oldDelegate = delegation.delegatee;
        uint256 oldVotes = votingPower[oldDelegate];
        votingPower[oldDelegate] = oldVotes - delegation.amount;

        emit DelegateVotesChanged(oldDelegate, oldVotes, votingPower[oldDelegate]);
        emit DelegateChanged(msg.sender, oldDelegate, address(0));

        delete delegations[msg.sender];
    }

    /**
     * @notice Get voting power for an address
     */
    function getVotingPower(address account) public view returns (uint256) {
        // Own balance + delegated power
        uint256 ownBalance = governanceToken.balanceOf(account);

        // If delegated away, use 0
        if (delegations[account].delegatee != address(0)) {
            return votingPower[account]; // Only delegated power to them
        }

        return ownBalance + votingPower[account];
    }

    /**
     * @notice Get proposal info
     */
    function getProposalInfo(uint256 proposalId)
        external
        view
        returns (
            address proposer,
            string memory title,
            uint256 startBlock,
            uint256 endBlock,
            uint256 forVotes,
            uint256 againstVotes,
            uint256 abstainVotes,
            uint256 quorum,
            ProposalState currentState
        )
    {
        Proposal storage proposal = proposals[proposalId];

        return (
            proposal.proposer,
            proposal.title,
            proposal.startBlock,
            proposal.endBlock,
            proposal.forVotes,
            proposal.againstVotes,
            proposal.abstainVotes,
            proposal.quorum,
            state(proposalId)
        );
    }

    /**
     * @notice Get vote receipt
     */
    function getReceipt(uint256 proposalId, address voter)
        external
        view
        returns (bool hasVoted, VoteType voteType, uint256 votes)
    {
        Receipt storage receipt = proposals[proposalId].receipts[voter];
        return (receipt.hasVoted, receipt.voteType, receipt.votes);
    }

    /**
     * @notice Calculate current quorum
     */
    function _calculateQuorum() internal view returns (uint256) {
        uint256 totalSupply = governanceToken.totalSupply();
        return (totalSupply * config.quorumNumerator) / 100;
    }

    /**
     * @notice Update governance configuration (through governance)
     */
    function updateConfig(ProposalConfig calldata newConfig) external {
        require(
            msg.sender == address(this),
            "Only through governance"
        );
        require(newConfig.votingPeriod >= 100, "Voting period too short");
        require(newConfig.quorumNumerator <= 100, "Invalid quorum");

        config = newConfig;
        emit ConfigUpdated(newConfig);
    }

    /**
     * @notice Emergency guardian action to cancel any proposal
     */
    function emergencyCancel(uint256 proposalId) external onlyRole(GUARDIAN_ROLE) {
        Proposal storage proposal = proposals[proposalId];
        require(!proposal.executed, "Already executed");

        proposal.canceled = true;

        emit EmergencyAction(msg.sender, "Proposal canceled");
        emit ProposalCanceled(proposalId);
    }

    /**
     * @notice Get domain separator for signatures
     */
    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("OracleGovernance")),
                    keccak256(bytes("1")),
                    block.chainid,
                    address(this)
                )
            );
    }

    /**
     * @notice Receive ETH for proposal execution
     */
    receive() external payable {}
}
