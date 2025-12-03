// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title FeedAggregator
 * @notice Multi-source oracle aggregator with median-of-5 feed logic
 * @dev Implements robust price aggregation with std deviation bounds and slashing
 */
contract FeedAggregator is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant UPDATER_ROLE = keccak256("UPDATER_ROLE");

    // Price feed structure
    struct PriceFeed {
        uint256 price;
        uint256 timestamp;
        uint256 confidence;
        address source;
        bytes32 zkProof;
        bool verified;
    }

    // Aggregated price data
    struct AggregatedPrice {
        uint256 price;
        uint256 median;
        uint256 stdDev;
        uint256 timestamp;
        uint256 blockNumber;
        uint8 sourceCount;
        uint256 confidence;
        bytes32[] zkProofs;
    }

    // Token feed configuration
    struct FeedConfig {
        bool enabled;
        uint256 minSources;
        uint256 maxDeviation; // in basis points (10000 = 100%)
        uint256 stdDevCap; // multiplier in basis points
        uint256 heartbeat; // max time between updates
        uint256 decimals;
        mapping(address => bool) authorizedSources;
        address[] sourceList;
    }

    // Source performance tracking
    struct SourceMetrics {
        uint256 totalUpdates;
        uint256 validUpdates;
        uint256 invalidUpdates;
        uint256 lastUpdateTime;
        uint256 averageDeviation;
        uint256 slashCount;
        bool active;
    }

    // Storage
    mapping(bytes32 => FeedConfig) public feedConfigs; // tokenId => config
    mapping(bytes32 => AggregatedPrice) public latestPrices; // tokenId => price
    mapping(bytes32 => mapping(uint256 => PriceFeed[])) public historicalFeeds; // tokenId => round => feeds
    mapping(bytes32 => uint256) public currentRound; // tokenId => round number
    mapping(address => SourceMetrics) public sourceMetrics; // source => metrics
    mapping(bytes32 => mapping(address => PriceFeed)) public latestSourceFeeds; // tokenId => source => feed

    // Global configuration
    uint256 public constant MAX_SOURCES = 10;
    uint256 public constant MIN_SOURCES = 3;
    uint256 public constant BASIS_POINTS = 10000;
    uint256 public globalMinConfidence = 8000; // 80%
    uint256 public slashingThreshold = 1000; // 10% deviation
    uint256 public slashingAmount = 1 ether;

    // Events
    event PriceUpdated(
        bytes32 indexed tokenId,
        uint256 price,
        uint256 median,
        uint256 timestamp,
        uint8 sourceCount
    );

    event SourceFeedSubmitted(
        bytes32 indexed tokenId,
        address indexed source,
        uint256 price,
        uint256 timestamp,
        bytes32 zkProof
    );

    event SourceSlashed(
        address indexed source,
        bytes32 indexed tokenId,
        uint256 reportedPrice,
        uint256 actualPrice,
        uint256 deviation,
        uint256 slashAmount
    );

    event FeedConfigured(
        bytes32 indexed tokenId,
        uint256 minSources,
        uint256 maxDeviation,
        uint256 heartbeat
    );

    event SourceAuthorized(bytes32 indexed tokenId, address indexed source);
    event SourceRevoked(bytes32 indexed tokenId, address indexed source);
    event ZKProofVerified(bytes32 indexed tokenId, bytes32 zkProof);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);
    }

    /**
     * @notice Configure a price feed for a token
     * @param tokenId Unique identifier for the token
     * @param minSources Minimum number of sources required
     * @param maxDeviation Maximum allowed deviation in basis points
     * @param stdDevCap Standard deviation cap multiplier
     * @param heartbeat Maximum time between updates
     * @param decimals Price decimals
     */
    function configureFeed(
        bytes32 tokenId,
        uint256 minSources,
        uint256 maxDeviation,
        uint256 stdDevCap,
        uint256 heartbeat,
        uint256 decimals
    ) external onlyRole(ADMIN_ROLE) {
        require(minSources >= MIN_SOURCES && minSources <= MAX_SOURCES, "Invalid source count");
        require(maxDeviation > 0 && maxDeviation <= BASIS_POINTS, "Invalid deviation");

        FeedConfig storage config = feedConfigs[tokenId];
        config.enabled = true;
        config.minSources = minSources;
        config.maxDeviation = maxDeviation;
        config.stdDevCap = stdDevCap;
        config.heartbeat = heartbeat;
        config.decimals = decimals;

        emit FeedConfigured(tokenId, minSources, maxDeviation, heartbeat);
    }

    /**
     * @notice Authorize a source for a specific feed
     * @param tokenId Token identifier
     * @param source Source address to authorize
     */
    function authorizeSource(bytes32 tokenId, address source)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(source != address(0), "Invalid source");
        require(!feedConfigs[tokenId].authorizedSources[source], "Already authorized");

        feedConfigs[tokenId].authorizedSources[source] = true;
        feedConfigs[tokenId].sourceList.push(source);

        sourceMetrics[source].active = true;

        emit SourceAuthorized(tokenId, source);
    }

    /**
     * @notice Revoke authorization for a source
     * @param tokenId Token identifier
     * @param source Source address to revoke
     */
    function revokeSource(bytes32 tokenId, address source)
        external
        onlyRole(ADMIN_ROLE)
    {
        require(feedConfigs[tokenId].authorizedSources[source], "Not authorized");

        feedConfigs[tokenId].authorizedSources[source] = false;
        sourceMetrics[source].active = false;

        emit SourceRevoked(tokenId, source);
    }

    /**
     * @notice Submit a price feed from an authorized source
     * @param tokenId Token identifier
     * @param price Price value
     * @param timestamp Price timestamp
     * @param confidence Confidence level (0-10000)
     * @param zkProof Zero-knowledge proof hash
     */
    function submitFeed(
        bytes32 tokenId,
        uint256 price,
        uint256 timestamp,
        uint256 confidence,
        bytes32 zkProof
    ) external nonReentrant whenNotPaused {
        require(feedConfigs[tokenId].enabled, "Feed not configured");
        require(feedConfigs[tokenId].authorizedSources[msg.sender], "Not authorized");
        require(price > 0, "Invalid price");
        require(timestamp <= block.timestamp, "Future timestamp");
        require(timestamp > block.timestamp - feedConfigs[tokenId].heartbeat, "Stale price");
        require(confidence >= globalMinConfidence, "Low confidence");

        PriceFeed memory feed = PriceFeed({
            price: price,
            timestamp: timestamp,
            confidence: confidence,
            source: msg.sender,
            zkProof: zkProof,
            verified: false
        });

        // Store feed
        uint256 round = currentRound[tokenId];
        historicalFeeds[tokenId][round].push(feed);
        latestSourceFeeds[tokenId][msg.sender] = feed;

        // Update source metrics
        sourceMetrics[msg.sender].totalUpdates++;
        sourceMetrics[msg.sender].lastUpdateTime = timestamp;

        emit SourceFeedSubmitted(tokenId, msg.sender, price, timestamp, zkProof);

        // Try to aggregate if we have enough sources
        if (historicalFeeds[tokenId][round].length >= feedConfigs[tokenId].minSources) {
            _aggregatePrice(tokenId);
        }
    }

    /**
     * @notice Internal function to aggregate prices using median-of-5 logic
     * @param tokenId Token identifier
     */
    function _aggregatePrice(bytes32 tokenId) internal {
        uint256 round = currentRound[tokenId];
        PriceFeed[] storage feeds = historicalFeeds[tokenId][round];

        require(feeds.length >= feedConfigs[tokenId].minSources, "Insufficient feeds");

        // Extract prices
        uint256[] memory prices = new uint256[](feeds.length);
        uint256[] memory confidences = new uint256[](feeds.length);
        bytes32[] memory zkProofs = new bytes32[](feeds.length);

        for (uint256 i = 0; i < feeds.length; i++) {
            prices[i] = feeds[i].price;
            confidences[i] = feeds[i].confidence;
            zkProofs[i] = feeds[i].zkProof;
        }

        // Calculate median
        uint256 median = _calculateMedian(prices);

        // Calculate standard deviation
        uint256 stdDev = _calculateStdDev(prices, median);

        // Filter outliers
        (uint256[] memory filteredPrices, uint8 validCount) = _filterOutliers(
            tokenId,
            prices,
            feeds,
            median,
            stdDev
        );

        // Calculate weighted average
        uint256 aggregatedPrice = _weightedAverage(filteredPrices, confidences, validCount);

        // Calculate aggregate confidence
        uint256 avgConfidence = _averageConfidence(confidences, validCount);

        // Store aggregated price
        AggregatedPrice storage aggPrice = latestPrices[tokenId];
        aggPrice.price = aggregatedPrice;
        aggPrice.median = median;
        aggPrice.stdDev = stdDev;
        aggPrice.timestamp = block.timestamp;
        aggPrice.blockNumber = block.number;
        aggPrice.sourceCount = validCount;
        aggPrice.confidence = avgConfidence;
        delete aggPrice.zkProofs;
        for (uint256 i = 0; i < validCount; i++) {
            aggPrice.zkProofs.push(zkProofs[i]);
        }

        // Increment round
        currentRound[tokenId]++;

        emit PriceUpdated(tokenId, aggregatedPrice, median, block.timestamp, validCount);
    }

    /**
     * @notice Calculate median of array
     */
    function _calculateMedian(uint256[] memory values) internal pure returns (uint256) {
        uint256[] memory sorted = _sort(values);
        uint256 len = sorted.length;

        if (len % 2 == 0) {
            return (sorted[len / 2 - 1] + sorted[len / 2]) / 2;
        } else {
            return sorted[len / 2];
        }
    }

    /**
     * @notice Calculate standard deviation
     */
    function _calculateStdDev(uint256[] memory values, uint256 mean)
        internal
        pure
        returns (uint256)
    {
        if (values.length == 0) return 0;

        uint256 sumSquaredDiff = 0;
        for (uint256 i = 0; i < values.length; i++) {
            int256 diff = int256(values[i]) - int256(mean);
            sumSquaredDiff += uint256(diff * diff);
        }

        uint256 variance = sumSquaredDiff / values.length;
        return _sqrt(variance);
    }

    /**
     * @notice Filter outliers based on standard deviation cap
     */
    function _filterOutliers(
        bytes32 tokenId,
        uint256[] memory prices,
        PriceFeed[] storage feeds,
        uint256 median,
        uint256 stdDev
    ) internal returns (uint256[] memory, uint8) {
        uint256[] memory filtered = new uint256[](prices.length);
        uint8 count = 0;
        uint256 stdDevCap = feedConfigs[tokenId].stdDevCap;

        for (uint256 i = 0; i < prices.length; i++) {
            uint256 deviation = prices[i] > median
                ? prices[i] - median
                : median - prices[i];

            // Check if within stdDevCap
            if (deviation <= (stdDev * stdDevCap / BASIS_POINTS)) {
                filtered[count] = prices[i];
                count++;
                sourceMetrics[feeds[i].source].validUpdates++;
            } else {
                // Outlier detected - slash source
                sourceMetrics[feeds[i].source].invalidUpdates++;
                _slashSource(tokenId, feeds[i].source, prices[i], median, deviation);
            }
        }

        return (filtered, count);
    }

    /**
     * @notice Slash a source for providing outlier data
     */
    function _slashSource(
        bytes32 tokenId,
        address source,
        uint256 reportedPrice,
        uint256 actualPrice,
        uint256 deviation
    ) internal {
        uint256 deviationBps = (deviation * BASIS_POINTS) / actualPrice;

        if (deviationBps > slashingThreshold) {
            sourceMetrics[source].slashCount++;

            emit SourceSlashed(
                source,
                tokenId,
                reportedPrice,
                actualPrice,
                deviationBps,
                slashingAmount
            );
        }
    }

    /**
     * @notice Calculate weighted average
     */
    function _weightedAverage(
        uint256[] memory values,
        uint256[] memory weights,
        uint8 count
    ) internal pure returns (uint256) {
        uint256 weightedSum = 0;
        uint256 totalWeight = 0;

        for (uint256 i = 0; i < count; i++) {
            weightedSum += values[i] * weights[i];
            totalWeight += weights[i];
        }

        return weightedSum / totalWeight;
    }

    /**
     * @notice Calculate average confidence
     */
    function _averageConfidence(uint256[] memory confidences, uint8 count)
        internal
        pure
        returns (uint256)
    {
        uint256 sum = 0;
        for (uint256 i = 0; i < count; i++) {
            sum += confidences[i];
        }
        return sum / count;
    }

    /**
     * @notice Sort array using insertion sort
     */
    function _sort(uint256[] memory arr) internal pure returns (uint256[] memory) {
        uint256[] memory sorted = new uint256[](arr.length);
        for (uint256 i = 0; i < arr.length; i++) {
            sorted[i] = arr[i];
        }

        for (uint256 i = 1; i < sorted.length; i++) {
            uint256 key = sorted[i];
            int256 j = int256(i) - 1;

            while (j >= 0 && sorted[uint256(j)] > key) {
                sorted[uint256(j + 1)] = sorted[uint256(j)];
                j--;
            }
            sorted[uint256(j + 1)] = key;
        }

        return sorted;
    }

    /**
     * @notice Square root function using Babylonian method
     */
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;

        uint256 z = (x + 1) / 2;
        uint256 y = x;

        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }

        return y;
    }

    /**
     * @notice Get latest price for a token
     */
    function getLatestPrice(bytes32 tokenId)
        external
        view
        returns (
            uint256 price,
            uint256 timestamp,
            uint256 confidence
        )
    {
        AggregatedPrice storage aggPrice = latestPrices[tokenId];
        require(aggPrice.timestamp > 0, "No price available");
        require(
            block.timestamp - aggPrice.timestamp < feedConfigs[tokenId].heartbeat,
            "Price stale"
        );

        return (aggPrice.price, aggPrice.timestamp, aggPrice.confidence);
    }

    /**
     * @notice Get full aggregated price data
     */
    function getAggregatedPrice(bytes32 tokenId)
        external
        view
        returns (AggregatedPrice memory)
    {
        return latestPrices[tokenId];
    }

    /**
     * @notice Get historical feed data
     */
    function getHistoricalFeeds(bytes32 tokenId, uint256 round)
        external
        view
        returns (PriceFeed[] memory)
    {
        return historicalFeeds[tokenId][round];
    }

    /**
     * @notice Get source metrics
     */
    function getSourceMetrics(address source)
        external
        view
        returns (SourceMetrics memory)
    {
        return sourceMetrics[source];
    }

    /**
     * @notice Check if feed is healthy
     */
    function isFeedHealthy(bytes32 tokenId) external view returns (bool) {
        AggregatedPrice storage aggPrice = latestPrices[tokenId];

        return (
            aggPrice.timestamp > 0 &&
            block.timestamp - aggPrice.timestamp < feedConfigs[tokenId].heartbeat &&
            aggPrice.sourceCount >= feedConfigs[tokenId].minSources &&
            aggPrice.confidence >= globalMinConfidence
        );
    }

    /**
     * @notice Update global configuration
     */
    function updateGlobalConfig(
        uint256 minConfidence,
        uint256 threshold,
        uint256 amount
    ) external onlyRole(ADMIN_ROLE) {
        globalMinConfidence = minConfidence;
        slashingThreshold = threshold;
        slashingAmount = amount;
    }

    /**
     * @notice Pause contract
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause contract
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Emergency price update (use with extreme caution)
     */
    function emergencyPriceUpdate(
        bytes32 tokenId,
        uint256 price,
        string calldata reason
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(price > 0, "Invalid price");

        latestPrices[tokenId].price = price;
        latestPrices[tokenId].timestamp = block.timestamp;
        latestPrices[tokenId].blockNumber = block.number;

        emit PriceUpdated(tokenId, price, price, block.timestamp, 1);
    }
}
