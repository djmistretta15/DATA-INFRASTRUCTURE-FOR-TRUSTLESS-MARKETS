// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SlashableOracleManager
 * @notice Manages oracle staking, slashing, and reputation system
 * @dev Oracles must stake collateral which can be slashed for bad behavior
 */
contract SlashableOracleManager is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    // Oracle registration and staking
    struct OracleInfo {
        address oracleAddress;
        uint256 stakedAmount;
        uint256 reputationScore;
        uint256 totalReports;
        uint256 validReports;
        uint256 invalidReports;
        uint256 slashedAmount;
        uint256 rewardsEarned;
        uint256 registrationTime;
        uint256 lastActivityTime;
        bool active;
        bool suspended;
        string metadata; // IPFS hash or JSON
    }

    // Slashing event record
    struct SlashingEvent {
        address oracle;
        bytes32 feedId;
        uint256 amount;
        uint256 timestamp;
        uint256 blockNumber;
        SlashReason reason;
        uint256 deviation;
        bytes32 proofHash;
        address slasher;
    }

    // Dispute structure
    struct Dispute {
        uint256 slashingEventId;
        address oracle;
        address challenger;
        uint256 stake;
        string evidence;
        DisputeStatus status;
        uint256 createdAt;
        uint256 resolvedAt;
        address resolver;
    }

    enum SlashReason {
        PRICE_DEVIATION,
        INVALID_TIMESTAMP,
        MISSING_ZK_PROOF,
        DOUBLE_REPORTING,
        MALICIOUS_ACTIVITY,
        INACTIVITY
    }

    enum DisputeStatus {
        PENDING,
        APPROVED,
        REJECTED,
        CANCELLED
    }

    // Storage
    mapping(address => OracleInfo) public oracles;
    mapping(uint256 => SlashingEvent) public slashingEvents;
    mapping(uint256 => Dispute) public disputes;
    mapping(address => uint256[]) public oracleSlashings;
    mapping(bytes32 => mapping(address => bool)) public reportSubmitted; // feedId => oracle => submitted

    address[] public oracleList;
    uint256 public slashingEventCount;
    uint256 public disputeCount;

    // Configuration
    uint256 public minimumStake = 10 ether;
    uint256 public maximumStake = 1000 ether;
    uint256 public slashPercentage = 1000; // 10% in basis points
    uint256 public disputeStake = 1 ether;
    uint256 public disputePeriod = 7 days;
    uint256 public inactivityPeriod = 30 days;
    uint256 public reputationDecayRate = 100; // 1% per slash
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant MAX_REPUTATION = 10000;

    IERC20 public stakeToken;
    address public treasury;

    // Rewards
    uint256 public rewardPool;
    uint256 public rewardPerReport = 0.1 ether;

    // Events
    event OracleRegistered(address indexed oracle, uint256 stakedAmount, string metadata);
    event OracleDeregistered(address indexed oracle, uint256 returnedStake);
    event StakeIncreased(address indexed oracle, uint256 amount, uint256 newTotal);
    event StakeDecreased(address indexed oracle, uint256 amount, uint256 newTotal);

    event OracleSlashed(
        uint256 indexed eventId,
        address indexed oracle,
        bytes32 indexed feedId,
        uint256 amount,
        SlashReason reason,
        uint256 deviation
    );

    event ReputationUpdated(
        address indexed oracle,
        uint256 oldScore,
        uint256 newScore
    );

    event DisputeCreated(
        uint256 indexed disputeId,
        uint256 indexed slashingEventId,
        address indexed oracle,
        address challenger
    );

    event DisputeResolved(
        uint256 indexed disputeId,
        DisputeStatus status,
        address resolver
    );

    event RewardClaimed(address indexed oracle, uint256 amount);
    event OracleSuspended(address indexed oracle, string reason);
    event OracleReactivated(address indexed oracle);

    constructor(address _stakeToken, address _treasury) {
        require(_stakeToken != address(0), "Invalid token");
        require(_treasury != address(0), "Invalid treasury");

        stakeToken = IERC20(_stakeToken);
        treasury = _treasury;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
        _grantRole(SLASHER_ROLE, msg.sender);
    }

    /**
     * @notice Register as an oracle by staking tokens
     * @param amount Amount to stake
     * @param metadata IPFS hash or metadata JSON
     */
    function registerOracle(uint256 amount, string calldata metadata)
        external
        nonReentrant
    {
        require(amount >= minimumStake, "Insufficient stake");
        require(amount <= maximumStake, "Exceeds maximum stake");
        require(!oracles[msg.sender].active, "Already registered");

        // Transfer stake
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        // Create oracle record
        oracles[msg.sender] = OracleInfo({
            oracleAddress: msg.sender,
            stakedAmount: amount,
            reputationScore: MAX_REPUTATION, // Start with max reputation
            totalReports: 0,
            validReports: 0,
            invalidReports: 0,
            slashedAmount: 0,
            rewardsEarned: 0,
            registrationTime: block.timestamp,
            lastActivityTime: block.timestamp,
            active: true,
            suspended: false,
            metadata: metadata
        });

        oracleList.push(msg.sender);

        emit OracleRegistered(msg.sender, amount, metadata);
    }

    /**
     * @notice Deregister oracle and return remaining stake
     */
    function deregisterOracle() external nonReentrant {
        OracleInfo storage oracle = oracles[msg.sender];
        require(oracle.active, "Not registered");
        require(!oracle.suspended, "Oracle suspended");

        uint256 returnAmount = oracle.stakedAmount;
        require(returnAmount > 0, "No stake to return");

        // Mark as inactive
        oracle.active = false;
        oracle.stakedAmount = 0;

        // Return stake
        stakeToken.safeTransfer(msg.sender, returnAmount);

        emit OracleDeregistered(msg.sender, returnAmount);
    }

    /**
     * @notice Increase stake
     * @param amount Additional amount to stake
     */
    function increaseStake(uint256 amount) external nonReentrant {
        OracleInfo storage oracle = oracles[msg.sender];
        require(oracle.active, "Not registered");
        require(oracle.stakedAmount + amount <= maximumStake, "Exceeds maximum");

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        oracle.stakedAmount += amount;

        emit StakeIncreased(msg.sender, amount, oracle.stakedAmount);
    }

    /**
     * @notice Decrease stake
     * @param amount Amount to withdraw
     */
    function decreaseStake(uint256 amount) external nonReentrant {
        OracleInfo storage oracle = oracles[msg.sender];
        require(oracle.active, "Not registered");
        require(!oracle.suspended, "Oracle suspended");
        require(oracle.stakedAmount - amount >= minimumStake, "Below minimum");

        oracle.stakedAmount -= amount;
        stakeToken.safeTransfer(msg.sender, amount);

        emit StakeDecreased(msg.sender, amount, oracle.stakedAmount);
    }

    /**
     * @notice Slash an oracle for bad behavior
     * @param oracle Oracle address to slash
     * @param feedId Feed identifier
     * @param reason Reason for slashing
     * @param deviation Deviation amount (if applicable)
     * @param proofHash Hash of evidence
     */
    function slashOracle(
        address oracle,
        bytes32 feedId,
        SlashReason reason,
        uint256 deviation,
        bytes32 proofHash
    ) external onlyRole(SLASHER_ROLE) returns (uint256) {
        OracleInfo storage oracleInfo = oracles[oracle];
        require(oracleInfo.active, "Oracle not active");
        require(oracleInfo.stakedAmount > 0, "No stake to slash");

        // Calculate slash amount
        uint256 slashAmount = (oracleInfo.stakedAmount * slashPercentage) / BASIS_POINTS;

        // Apply minimum slash
        if (slashAmount < 0.1 ether) {
            slashAmount = 0.1 ether;
        }

        // Don't slash more than available
        if (slashAmount > oracleInfo.stakedAmount) {
            slashAmount = oracleInfo.stakedAmount;
        }

        // Update oracle state
        oracleInfo.stakedAmount -= slashAmount;
        oracleInfo.slashedAmount += slashAmount;
        oracleInfo.invalidReports++;

        // Update reputation
        _updateReputation(oracle, false);

        // Check if should suspend
        if (oracleInfo.stakedAmount < minimumStake) {
            oracleInfo.suspended = true;
            emit OracleSuspended(oracle, "Insufficient stake after slashing");
        }

        // Record slashing event
        uint256 eventId = slashingEventCount++;
        slashingEvents[eventId] = SlashingEvent({
            oracle: oracle,
            feedId: feedId,
            amount: slashAmount,
            timestamp: block.timestamp,
            blockNumber: block.number,
            reason: reason,
            deviation: deviation,
            proofHash: proofHash,
            slasher: msg.sender
        });

        oracleSlashings[oracle].push(eventId);

        // Transfer slashed amount to treasury
        stakeToken.safeTransfer(treasury, slashAmount);

        emit OracleSlashed(eventId, oracle, feedId, slashAmount, reason, deviation);

        return eventId;
    }

    /**
     * @notice Create a dispute for a slashing event
     * @param slashingEventId Event to dispute
     * @param evidence IPFS hash or evidence string
     */
    function createDispute(uint256 slashingEventId, string calldata evidence)
        external
        payable
        nonReentrant
    {
        SlashingEvent storage slashEvent = slashingEvents[slashingEventId];
        require(slashEvent.oracle == msg.sender, "Not your slashing");
        require(
            block.timestamp <= slashEvent.timestamp + disputePeriod,
            "Dispute period expired"
        );
        require(msg.value >= disputeStake, "Insufficient dispute stake");

        uint256 disputeId = disputeCount++;
        disputes[disputeId] = Dispute({
            slashingEventId: slashingEventId,
            oracle: msg.sender,
            challenger: msg.sender,
            stake: msg.value,
            evidence: evidence,
            status: DisputeStatus.PENDING,
            createdAt: block.timestamp,
            resolvedAt: 0,
            resolver: address(0)
        });

        emit DisputeCreated(disputeId, slashingEventId, msg.sender, msg.sender);
    }

    /**
     * @notice Resolve a dispute (governance function)
     * @param disputeId Dispute identifier
     * @param approved Whether to approve the dispute
     */
    function resolveDispute(uint256 disputeId, bool approved)
        external
        onlyRole(GOVERNANCE_ROLE)
    {
        Dispute storage dispute = disputes[disputeId];
        require(dispute.status == DisputeStatus.PENDING, "Not pending");

        SlashingEvent storage slashEvent = slashingEvents[dispute.slashingEventId];
        OracleInfo storage oracle = oracles[slashEvent.oracle];

        if (approved) {
            // Return slashed amount
            uint256 returnAmount = slashEvent.amount;
            oracle.stakedAmount += returnAmount;
            oracle.slashedAmount -= returnAmount;
            oracle.invalidReports--;

            // Update reputation back up
            _updateReputation(slashEvent.oracle, true);

            // Return dispute stake
            payable(dispute.challenger).transfer(dispute.stake);

            dispute.status = DisputeStatus.APPROVED;
        } else {
            // Keep slash, send dispute stake to treasury
            payable(treasury).transfer(dispute.stake);
            dispute.status = DisputeStatus.REJECTED;
        }

        dispute.resolvedAt = block.timestamp;
        dispute.resolver = msg.sender;

        emit DisputeResolved(disputeId, dispute.status, msg.sender);
    }

    /**
     * @notice Record a valid report submission
     * @param oracle Oracle address
     * @param feedId Feed identifier
     */
    function recordValidReport(address oracle, bytes32 feedId)
        external
        onlyRole(SLASHER_ROLE)
    {
        OracleInfo storage oracleInfo = oracles[oracle];
        require(oracleInfo.active, "Oracle not active");
        require(!reportSubmitted[feedId][oracle], "Already submitted");

        reportSubmitted[feedId][oracle] = true;
        oracleInfo.totalReports++;
        oracleInfo.validReports++;
        oracleInfo.lastActivityTime = block.timestamp;

        // Update reputation
        _updateReputation(oracle, true);

        // Add reward
        oracleInfo.rewardsEarned += rewardPerReport;
        rewardPool += rewardPerReport;
    }

    /**
     * @notice Update oracle reputation score
     */
    function _updateReputation(address oracle, bool positive) internal {
        OracleInfo storage oracleInfo = oracles[oracle];
        uint256 oldScore = oracleInfo.reputationScore;
        uint256 newScore;

        if (positive) {
            // Increase reputation (capped at MAX_REPUTATION)
            uint256 increase = (MAX_REPUTATION * 50) / BASIS_POINTS; // 0.5% increase
            newScore = oldScore + increase;
            if (newScore > MAX_REPUTATION) {
                newScore = MAX_REPUTATION;
            }
        } else {
            // Decrease reputation
            uint256 decrease = (oldScore * reputationDecayRate) / BASIS_POINTS;
            newScore = oldScore > decrease ? oldScore - decrease : 0;
        }

        oracleInfo.reputationScore = newScore;

        emit ReputationUpdated(oracle, oldScore, newScore);
    }

    /**
     * @notice Claim accumulated rewards
     */
    function claimRewards() external nonReentrant {
        OracleInfo storage oracle = oracles[msg.sender];
        require(oracle.active, "Not registered");

        uint256 rewards = oracle.rewardsEarned;
        require(rewards > 0, "No rewards");
        require(rewardPool >= rewards, "Insufficient reward pool");

        oracle.rewardsEarned = 0;
        rewardPool -= rewards;

        stakeToken.safeTransfer(msg.sender, rewards);

        emit RewardClaimed(msg.sender, rewards);
    }

    /**
     * @notice Suspend an oracle manually
     * @param oracle Oracle address
     * @param reason Suspension reason
     */
    function suspendOracle(address oracle, string calldata reason)
        external
        onlyRole(ADMIN_ROLE)
    {
        OracleInfo storage oracleInfo = oracles[oracle];
        require(oracleInfo.active, "Not active");
        require(!oracleInfo.suspended, "Already suspended");

        oracleInfo.suspended = true;

        emit OracleSuspended(oracle, reason);
    }

    /**
     * @notice Reactivate a suspended oracle
     * @param oracle Oracle address
     */
    function reactivateOracle(address oracle) external onlyRole(ADMIN_ROLE) {
        OracleInfo storage oracleInfo = oracles[oracle];
        require(oracleInfo.active, "Not active");
        require(oracleInfo.suspended, "Not suspended");
        require(oracleInfo.stakedAmount >= minimumStake, "Insufficient stake");

        oracleInfo.suspended = false;

        emit OracleReactivated(oracle);
    }

    /**
     * @notice Check and slash inactive oracles
     */
    function slashInactiveOracles(address[] calldata oracleAddresses)
        external
        onlyRole(ADMIN_ROLE)
    {
        for (uint256 i = 0; i < oracleAddresses.length; i++) {
            OracleInfo storage oracle = oracles[oracleAddresses[i]];

            if (
                oracle.active &&
                !oracle.suspended &&
                block.timestamp - oracle.lastActivityTime > inactivityPeriod
            ) {
                slashOracle(
                    oracleAddresses[i],
                    bytes32(0),
                    SlashReason.INACTIVITY,
                    0,
                    keccak256("INACTIVITY")
                );
            }
        }
    }

    /**
     * @notice Get oracle information
     */
    function getOracleInfo(address oracle) external view returns (OracleInfo memory) {
        return oracles[oracle];
    }

    /**
     * @notice Get all slashing events for an oracle
     */
    function getOracleSlashings(address oracle)
        external
        view
        returns (uint256[] memory)
    {
        return oracleSlashings[oracle];
    }

    /**
     * @notice Get slashing event details
     */
    function getSlashingEvent(uint256 eventId)
        external
        view
        returns (SlashingEvent memory)
    {
        return slashingEvents[eventId];
    }

    /**
     * @notice Get active oracle count
     */
    function getActiveOracleCount() external view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 0; i < oracleList.length; i++) {
            if (oracles[oracleList[i]].active && !oracles[oracleList[i]].suspended) {
                count++;
            }
        }
        return count;
    }

    /**
     * @notice Get oracle performance metrics
     */
    function getOraclePerformance(address oracle)
        external
        view
        returns (
            uint256 successRate,
            uint256 avgReputation,
            uint256 totalSlashed,
            bool isActive
        )
    {
        OracleInfo storage oracleInfo = oracles[oracle];

        successRate = oracleInfo.totalReports > 0
            ? (oracleInfo.validReports * BASIS_POINTS) / oracleInfo.totalReports
            : 0;

        return (
            successRate,
            oracleInfo.reputationScore,
            oracleInfo.slashedAmount,
            oracleInfo.active && !oracleInfo.suspended
        );
    }

    /**
     * @notice Update configuration
     */
    function updateConfig(
        uint256 _minimumStake,
        uint256 _slashPercentage,
        uint256 _disputeStake,
        uint256 _rewardPerReport
    ) external onlyRole(ADMIN_ROLE) {
        minimumStake = _minimumStake;
        slashPercentage = _slashPercentage;
        disputeStake = _disputeStake;
        rewardPerReport = _rewardPerReport;
    }

    /**
     * @notice Fund reward pool
     */
    function fundRewardPool(uint256 amount) external {
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardPool += amount;
    }

    /**
     * @notice Emergency withdraw (admin only)
     */
    function emergencyWithdraw(address token, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        IERC20(token).safeTransfer(treasury, amount);
    }
}
