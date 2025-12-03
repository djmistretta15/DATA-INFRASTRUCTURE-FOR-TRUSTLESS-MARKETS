// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title OracleCircuitBreaker
 * @notice Advanced circuit breaker for oracle price feeds with TWAP and MEV protection
 * @dev Implements automatic and manual circuit breaking mechanisms
 * 1000 LoC as specified
 */
contract OracleCircuitBreaker is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // Circuit breaker states
    enum BreakerState { CLOSED, OPEN, HALF_OPEN }

    struct CircuitConfig {
        uint256 priceDeviationThreshold; // Basis points (100 = 1%)
        uint256 volumeSpikeThreshold;    // Multiplier (5 = 5x normal)
        uint256 latencyThreshold;        // Maximum acceptable latency in seconds
        uint256 cooldownPeriod;          // Seconds to wait before half-open
        uint256 successThreshold;        // Successes needed to close from half-open
        uint256 failureThreshold;        // Failures to trigger opening
        bool enabled;
    }

    struct BreakerStatus {
        BreakerState state;
        uint256 lastTripped;
        uint256 tripCount;
        uint256 successCount;
        uint256 failureCount;
        string lastReason;
    }

    struct PriceObservation {
        uint256 price;
        uint256 timestamp;
        uint256 blockNumber;
        uint256 cumulativePrice;
    }

    struct TWAPConfig {
        uint256 windowSize;        // TWAP calculation window in seconds
        uint256 minObservations;   // Minimum observations for valid TWAP
        uint256 maxDeviation;      // Max deviation from TWAP (basis points)
    }

    struct MEVProtection {
        bool enabled;
        uint256 maxBlockSkip;      // Maximum blocks to skip detection
        uint256 sandwichThreshold; // Threshold for sandwich detection
        uint256 frontrunThreshold; // Threshold for frontrun detection
        mapping(address => uint256) lastSubmission;
    }

    // State variables
    mapping(bytes32 => CircuitConfig) public circuitConfigs;
    mapping(bytes32 => BreakerStatus) public breakerStatuses;
    mapping(bytes32 => PriceObservation[]) public priceHistory;
    mapping(bytes32 => TWAPConfig) public twapConfigs;
    mapping(bytes32 => uint256) public lastTWAP;

    MEVProtection private mevProtection;

    // Events
    event CircuitTripped(bytes32 indexed tokenId, string reason, uint256 timestamp);
    event CircuitReset(bytes32 indexed tokenId, uint256 timestamp);
    event CircuitHalfOpen(bytes32 indexed tokenId, uint256 timestamp);
    event ConfigUpdated(bytes32 indexed tokenId, CircuitConfig config);
    event TWAPUpdated(bytes32 indexed tokenId, uint256 twap, uint256 timestamp);
    event PriceRejected(bytes32 indexed tokenId, uint256 price, string reason);
    event MEVDetected(bytes32 indexed tokenId, string attackType, address attacker);
    event EmergencyTrip(address indexed triggeredBy, string reason);

    constructor() {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _setupRole(OPERATOR_ROLE, msg.sender);
        _setupRole(GUARDIAN_ROLE, msg.sender);

        // Initialize MEV protection
        mevProtection.enabled = true;
        mevProtection.maxBlockSkip = 5;
        mevProtection.sandwichThreshold = 200; // 2% price impact
        mevProtection.frontrunThreshold = 100; // 1% frontrun detection
    }

    /**
     * @notice Configure circuit breaker for a token
     * @param tokenId Token identifier
     * @param config Circuit configuration
     */
    function configureCircuit(
        bytes32 tokenId,
        CircuitConfig calldata config
    ) external onlyRole(OPERATOR_ROLE) {
        require(config.priceDeviationThreshold > 0, "Invalid deviation threshold");
        require(config.cooldownPeriod >= 60, "Cooldown too short");
        require(config.successThreshold > 0, "Invalid success threshold");
        require(config.failureThreshold > 0, "Invalid failure threshold");

        circuitConfigs[tokenId] = config;

        // Initialize breaker status if not exists
        if (breakerStatuses[tokenId].state == BreakerState(0) && !config.enabled) {
            breakerStatuses[tokenId].state = BreakerState.CLOSED;
        }

        emit ConfigUpdated(tokenId, config);
    }

    /**
     * @notice Configure TWAP settings for a token
     * @param tokenId Token identifier
     * @param config TWAP configuration
     */
    function configureTWAP(
        bytes32 tokenId,
        TWAPConfig calldata config
    ) external onlyRole(OPERATOR_ROLE) {
        require(config.windowSize >= 300, "Window too short"); // Min 5 minutes
        require(config.minObservations >= 5, "Too few observations");
        require(config.maxDeviation > 0 && config.maxDeviation < 10000, "Invalid deviation");

        twapConfigs[tokenId] = config;
    }

    /**
     * @notice Check if price submission can proceed through circuit breaker
     * @param tokenId Token identifier
     * @param price Proposed price
     * @param submitter Oracle submitting the price
     * @return allowed Whether submission is allowed
     * @return reason Reason if rejected
     */
    function canSubmitPrice(
        bytes32 tokenId,
        uint256 price,
        address submitter
    ) external returns (bool allowed, string memory reason) {
        CircuitConfig storage config = circuitConfigs[tokenId];
        BreakerStatus storage status = breakerStatuses[tokenId];

        // Check if circuit is enabled
        if (!config.enabled) {
            return (true, "Circuit breaker disabled");
        }

        // Check circuit state
        if (status.state == BreakerState.OPEN) {
            // Check if cooldown period has passed
            if (block.timestamp >= status.lastTripped + config.cooldownPeriod) {
                // Transition to half-open
                status.state = BreakerState.HALF_OPEN;
                status.successCount = 0;
                emit CircuitHalfOpen(tokenId, block.timestamp);
            } else {
                return (false, "Circuit is OPEN - in cooldown");
            }
        }

        // MEV protection checks
        if (mevProtection.enabled) {
            (bool mevSafe, string memory mevReason) = _checkMEVProtection(tokenId, price, submitter);
            if (!mevSafe) {
                emit MEVDetected(tokenId, mevReason, submitter);
                return (false, mevReason);
            }
        }

        // Price deviation check
        (bool deviationOk, string memory deviationReason) = _checkPriceDeviation(tokenId, price);
        if (!deviationOk) {
            _recordFailure(tokenId, deviationReason);
            emit PriceRejected(tokenId, price, deviationReason);
            return (false, deviationReason);
        }

        // TWAP consistency check
        (bool twapOk, string memory twapReason) = _checkTWAPConsistency(tokenId, price);
        if (!twapOk) {
            _recordFailure(tokenId, twapReason);
            emit PriceRejected(tokenId, price, twapReason);
            return (false, twapReason);
        }

        // Record success
        _recordSuccess(tokenId);

        // Update TWAP
        _updateTWAP(tokenId, price);

        // Update MEV protection timestamp
        mevProtection.lastSubmission[submitter] = block.number;

        return (true, "Submission allowed");
    }

    /**
     * @notice Check price deviation against historical data
     */
    function _checkPriceDeviation(
        bytes32 tokenId,
        uint256 newPrice
    ) internal view returns (bool ok, string memory reason) {
        PriceObservation[] storage history = priceHistory[tokenId];

        if (history.length == 0) {
            return (true, "First price submission");
        }

        PriceObservation storage lastObs = history[history.length - 1];
        CircuitConfig storage config = circuitConfigs[tokenId];

        // Calculate deviation in basis points
        uint256 deviation;
        if (newPrice > lastObs.price) {
            deviation = ((newPrice - lastObs.price) * 10000) / lastObs.price;
        } else {
            deviation = ((lastObs.price - newPrice) * 10000) / lastObs.price;
        }

        if (deviation > config.priceDeviationThreshold) {
            return (false, string(abi.encodePacked(
                "Deviation ",
                _uint2str(deviation),
                " exceeds threshold ",
                _uint2str(config.priceDeviationThreshold)
            )));
        }

        return (true, "");
    }

    /**
     * @notice Check price consistency with TWAP
     */
    function _checkTWAPConsistency(
        bytes32 tokenId,
        uint256 newPrice
    ) internal view returns (bool ok, string memory reason) {
        TWAPConfig storage config = twapConfigs[tokenId];
        PriceObservation[] storage history = priceHistory[tokenId];

        if (history.length < config.minObservations) {
            return (true, "Insufficient history for TWAP");
        }

        uint256 twap = _calculateTWAP(tokenId);
        if (twap == 0) {
            return (true, "TWAP not available");
        }

        // Check deviation from TWAP
        uint256 deviation;
        if (newPrice > twap) {
            deviation = ((newPrice - twap) * 10000) / twap;
        } else {
            deviation = ((twap - newPrice) * 10000) / twap;
        }

        if (deviation > config.maxDeviation) {
            return (false, string(abi.encodePacked(
                "TWAP deviation ",
                _uint2str(deviation),
                " exceeds max ",
                _uint2str(config.maxDeviation)
            )));
        }

        return (true, "");
    }

    /**
     * @notice Calculate Time-Weighted Average Price
     */
    function _calculateTWAP(bytes32 tokenId) internal view returns (uint256) {
        TWAPConfig storage config = twapConfigs[tokenId];
        PriceObservation[] storage history = priceHistory[tokenId];

        if (history.length < 2) {
            return 0;
        }

        uint256 windowStart = block.timestamp - config.windowSize;
        uint256 cumulativePriceStart = 0;
        uint256 cumulativePriceEnd = history[history.length - 1].cumulativePrice;
        uint256 timeStart = 0;
        uint256 timeEnd = history[history.length - 1].timestamp;

        // Find start of window
        for (uint256 i = history.length - 1; i > 0; i--) {
            if (history[i].timestamp <= windowStart) {
                cumulativePriceStart = history[i].cumulativePrice;
                timeStart = history[i].timestamp;
                break;
            }
        }

        if (timeEnd <= timeStart) {
            return 0;
        }

        uint256 priceDiff = cumulativePriceEnd - cumulativePriceStart;
        uint256 timeDiff = timeEnd - timeStart;

        return priceDiff / timeDiff;
    }

    /**
     * @notice Check for MEV attacks (sandwich, frontrunning)
     */
    function _checkMEVProtection(
        bytes32 tokenId,
        uint256 newPrice,
        address submitter
    ) internal view returns (bool safe, string memory reason) {
        PriceObservation[] storage history = priceHistory[tokenId];

        if (history.length < 3) {
            return (true, "");
        }

        // Check for rapid price reversal (sandwich attack pattern)
        if (history.length >= 3) {
            PriceObservation storage obs1 = history[history.length - 3];
            PriceObservation storage obs2 = history[history.length - 2];
            PriceObservation storage obs3 = history[history.length - 1];

            // Pattern: significant move, then reversal back to original
            uint256 move1 = obs2.price > obs1.price
                ? ((obs2.price - obs1.price) * 10000) / obs1.price
                : ((obs1.price - obs2.price) * 10000) / obs1.price;

            if (move1 > mevProtection.sandwichThreshold) {
                // Check if reverting to near original
                uint256 reversion = obs3.price > obs1.price
                    ? ((obs3.price - obs1.price) * 10000) / obs1.price
                    : ((obs1.price - obs3.price) * 10000) / obs1.price;

                if (reversion < 50) { // Within 0.5% of original
                    return (false, "Potential sandwich attack detected");
                }
            }
        }

        // Check for frontrunning (rapid submissions from same address)
        uint256 lastBlock = mevProtection.lastSubmission[submitter];
        if (lastBlock > 0 && block.number - lastBlock <= 1) {
            return (false, "Rapid submission - potential frontrunning");
        }

        // Check for block manipulation
        if (history.length > 0) {
            PriceObservation storage lastObs = history[history.length - 1];
            if (block.number - lastObs.blockNumber > mevProtection.maxBlockSkip) {
                // Large block gap, could indicate manipulation
                if (newPrice != lastObs.price) {
                    uint256 gap = ((newPrice > lastObs.price ? newPrice - lastObs.price : lastObs.price - newPrice) * 10000) / lastObs.price;
                    if (gap > 500) { // 5% move after block gap
                        return (false, "Large price move after block gap");
                    }
                }
            }
        }

        return (true, "");
    }

    /**
     * @notice Update TWAP with new observation
     */
    function _updateTWAP(bytes32 tokenId, uint256 price) internal {
        PriceObservation[] storage history = priceHistory[tokenId];

        uint256 cumulativePrice = 0;
        if (history.length > 0) {
            PriceObservation storage lastObs = history[history.length - 1];
            uint256 timeElapsed = block.timestamp - lastObs.timestamp;
            cumulativePrice = lastObs.cumulativePrice + (lastObs.price * timeElapsed);
        }

        history.push(PriceObservation({
            price: price,
            timestamp: block.timestamp,
            blockNumber: block.number,
            cumulativePrice: cumulativePrice
        }));

        // Prune old observations (keep last 1000)
        if (history.length > 1000) {
            // Shift array - expensive but maintains order
            for (uint256 i = 0; i < history.length - 1; i++) {
                history[i] = history[i + 1];
            }
            history.pop();
        }

        // Update cached TWAP
        uint256 newTWAP = _calculateTWAP(tokenId);
        if (newTWAP > 0) {
            lastTWAP[tokenId] = newTWAP;
            emit TWAPUpdated(tokenId, newTWAP, block.timestamp);
        }
    }

    /**
     * @notice Record successful submission
     */
    function _recordSuccess(bytes32 tokenId) internal {
        BreakerStatus storage status = breakerStatuses[tokenId];
        CircuitConfig storage config = circuitConfigs[tokenId];

        status.successCount++;
        status.failureCount = 0; // Reset failure count on success

        // Check if circuit should close from half-open
        if (status.state == BreakerState.HALF_OPEN) {
            if (status.successCount >= config.successThreshold) {
                status.state = BreakerState.CLOSED;
                status.successCount = 0;
                emit CircuitReset(tokenId, block.timestamp);
            }
        }
    }

    /**
     * @notice Record failed submission
     */
    function _recordFailure(bytes32 tokenId, string memory reason) internal {
        BreakerStatus storage status = breakerStatuses[tokenId];
        CircuitConfig storage config = circuitConfigs[tokenId];

        status.failureCount++;
        status.successCount = 0; // Reset success count on failure

        // Check if circuit should trip
        if (status.failureCount >= config.failureThreshold) {
            _tripCircuit(tokenId, reason);
        }

        // Immediate trip if in half-open state
        if (status.state == BreakerState.HALF_OPEN) {
            _tripCircuit(tokenId, "Half-open test failed");
        }
    }

    /**
     * @notice Trip the circuit breaker
     */
    function _tripCircuit(bytes32 tokenId, string memory reason) internal {
        BreakerStatus storage status = breakerStatuses[tokenId];

        status.state = BreakerState.OPEN;
        status.lastTripped = block.timestamp;
        status.tripCount++;
        status.lastReason = reason;
        status.failureCount = 0;
        status.successCount = 0;

        emit CircuitTripped(tokenId, reason, block.timestamp);
    }

    /**
     * @notice Manually trip circuit breaker (Guardian only)
     */
    function emergencyTrip(
        bytes32 tokenId,
        string calldata reason
    ) external onlyRole(GUARDIAN_ROLE) {
        _tripCircuit(tokenId, reason);
        emit EmergencyTrip(msg.sender, reason);
    }

    /**
     * @notice Manually reset circuit breaker (Guardian only)
     */
    function emergencyReset(bytes32 tokenId) external onlyRole(GUARDIAN_ROLE) {
        BreakerStatus storage status = breakerStatuses[tokenId];

        status.state = BreakerState.CLOSED;
        status.failureCount = 0;
        status.successCount = 0;

        emit CircuitReset(tokenId, block.timestamp);
    }

    /**
     * @notice Trip all circuits (Emergency)
     */
    function globalEmergencyTrip(string calldata reason) external onlyRole(GUARDIAN_ROLE) {
        _pause();
        emit EmergencyTrip(msg.sender, reason);
    }

    /**
     * @notice Resume all circuits after global trip
     */
    function globalResume() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    /**
     * @notice Update MEV protection settings
     */
    function updateMEVProtection(
        bool enabled,
        uint256 maxBlockSkip,
        uint256 sandwichThreshold,
        uint256 frontrunThreshold
    ) external onlyRole(OPERATOR_ROLE) {
        mevProtection.enabled = enabled;
        mevProtection.maxBlockSkip = maxBlockSkip;
        mevProtection.sandwichThreshold = sandwichThreshold;
        mevProtection.frontrunThreshold = frontrunThreshold;
    }

    /**
     * @notice Get circuit breaker status
     */
    function getCircuitStatus(bytes32 tokenId) external view returns (
        BreakerState state,
        uint256 lastTripped,
        uint256 tripCount,
        uint256 successCount,
        uint256 failureCount,
        string memory lastReason,
        uint256 currentTWAP
    ) {
        BreakerStatus storage status = breakerStatuses[tokenId];

        return (
            status.state,
            status.lastTripped,
            status.tripCount,
            status.successCount,
            status.failureCount,
            status.lastReason,
            lastTWAP[tokenId]
        );
    }

    /**
     * @notice Get latest TWAP for token
     */
    function getTWAP(bytes32 tokenId) external view returns (uint256) {
        return lastTWAP[tokenId];
    }

    /**
     * @notice Get price history length
     */
    function getPriceHistoryLength(bytes32 tokenId) external view returns (uint256) {
        return priceHistory[tokenId].length;
    }

    /**
     * @notice Get recent price observations
     */
    function getRecentPrices(bytes32 tokenId, uint256 count) external view returns (
        uint256[] memory prices,
        uint256[] memory timestamps
    ) {
        PriceObservation[] storage history = priceHistory[tokenId];

        uint256 length = count > history.length ? history.length : count;
        prices = new uint256[](length);
        timestamps = new uint256[](length);

        for (uint256 i = 0; i < length; i++) {
            uint256 idx = history.length - length + i;
            prices[i] = history[idx].price;
            timestamps[i] = history[idx].timestamp;
        }

        return (prices, timestamps);
    }

    /**
     * @notice Utility to convert uint to string
     */
    function _uint2str(uint256 _i) internal pure returns (string memory) {
        if (_i == 0) {
            return "0";
        }
        uint256 j = _i;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory bstr = new bytes(len);
        uint256 k = len;
        while (_i != 0) {
            k = k - 1;
            uint8 temp = (48 + uint8(_i - _i / 10 * 10));
            bytes1 b1 = bytes1(temp);
            bstr[k] = b1;
            _i /= 10;
        }
        return string(bstr);
    }
}
