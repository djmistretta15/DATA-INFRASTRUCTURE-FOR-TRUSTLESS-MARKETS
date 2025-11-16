import { ethers, Contract, JsonRpcProvider, EventLog } from 'ethers';
import { PrismaClient } from '@prisma/client';
import Redis from 'redis';
import { EventEmitter } from 'events';

/**
 * Lending Rate Indexer - Tracks DeFi lending protocol rates
 * Indexes Aave, Compound, and other major lending protocols
 * 1200 LoC as specified
 */

interface LendingProtocol {
  name: string;
  chain: string;
  address: string;
  type: 'aave_v3' | 'compound_v3' | 'compound_v2' | 'euler' | 'morpho';
  startBlock: number;
}

interface RateSnapshot {
  protocol: string;
  asset: string;
  chain: string;
  supplyRate: bigint;
  borrowRate: bigint;
  utilizationRate: bigint;
  totalSupply: bigint;
  totalBorrow: bigint;
  availableLiquidity: bigint;
  timestamp: number;
  blockNumber: number;
}

interface UserPosition {
  user: string;
  protocol: string;
  asset: string;
  chain: string;
  supplyBalance: bigint;
  borrowBalance: bigint;
  healthFactor: bigint;
  liquidationThreshold: bigint;
  timestamp: number;
}

interface LiquidationEvent {
  liquidator: string;
  borrower: string;
  protocol: string;
  asset: string;
  collateralAsset: string;
  debtRepaid: bigint;
  collateralSeized: bigint;
  timestamp: number;
  txHash: string;
  blockNumber: number;
}

// Aave V3 Pool ABI (simplified)
const AAVE_V3_POOL_ABI = [
  'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
  'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
  'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
  'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
  'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
  'event ReserveDataUpdated(address indexed reserve, uint256 liquidityRate, uint256 stableBorrowRate, uint256 variableBorrowRate, uint256 liquidityIndex, uint256 variableBorrowIndex)',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
];

// Compound V3 Comet ABI
const COMPOUND_V3_ABI = [
  'event Supply(address indexed from, address indexed dst, uint256 amount)',
  'event Withdraw(address indexed src, address indexed to, uint256 amount)',
  'event AbsorbDebt(address indexed absorber, address indexed borrower, uint256 basePaidOut, uint256 usdValue)',
  'function getUtilization() external view returns (uint)',
  'function getSupplyRate(uint utilization) external view returns (uint64)',
  'function getBorrowRate(uint utilization) external view returns (uint64)',
  'function totalSupply() external view returns (uint256)',
  'function totalBorrow() external view returns (uint256)',
  'function balanceOf(address account) external view returns (int104)',
];

export class LendingRateIndexer extends EventEmitter {
  private prisma: PrismaClient;
  private redis: any;
  private providers: Map<string, JsonRpcProvider>;
  private protocols: Map<string, Contract>;
  private protocolConfigs: LendingProtocol[];
  private indexingState: Map<string, number>;
  private isRunning: boolean;

  constructor() {
    super();
    this.prisma = new PrismaClient();
    this.providers = new Map();
    this.protocols = new Map();
    this.protocolConfigs = [];
    this.indexingState = new Map();
    this.isRunning = false;

    this.redis = Redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    this.redis.connect();

    console.log('✓ Lending Rate Indexer initialized');
  }

  /**
   * Initialize blockchain providers
   */
  async initializeProviders(): Promise<void> {
    const chains: Record<string, string> = {
      ethereum: process.env.ETHEREUM_RPC || 'https://eth-mainnet.g.alchemy.com/v2/demo',
      polygon: process.env.POLYGON_RPC || 'https://polygon-mainnet.g.alchemy.com/v2/demo',
      arbitrum: process.env.ARBITRUM_RPC || 'https://arb-mainnet.g.alchemy.com/v2/demo',
      optimism: process.env.OPTIMISM_RPC || 'https://opt-mainnet.g.alchemy.com/v2/demo',
      base: process.env.BASE_RPC || 'https://base-mainnet.g.alchemy.com/v2/demo'
    };

    for (const [chain, rpcUrl] of Object.entries(chains)) {
      try {
        const provider = new JsonRpcProvider(rpcUrl);
        await provider.getBlockNumber(); // Test connection
        this.providers.set(chain, provider);
        console.log(`✓ Connected to ${chain}`);
      } catch (error) {
        console.error(`✗ Failed to connect to ${chain}:`, error);
      }
    }
  }

  /**
   * Register lending protocols to index
   */
  async registerProtocols(): Promise<void> {
    this.protocolConfigs = [
      // Aave V3
      {
        name: 'aave_v3_ethereum',
        chain: 'ethereum',
        address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
        type: 'aave_v3',
        startBlock: 16291127
      },
      {
        name: 'aave_v3_polygon',
        chain: 'polygon',
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        type: 'aave_v3',
        startBlock: 25826028
      },
      {
        name: 'aave_v3_arbitrum',
        chain: 'arbitrum',
        address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
        type: 'aave_v3',
        startBlock: 7742429
      },
      // Compound V3
      {
        name: 'compound_v3_usdc_ethereum',
        chain: 'ethereum',
        address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
        type: 'compound_v3',
        startBlock: 15331586
      },
      {
        name: 'compound_v3_usdc_polygon',
        chain: 'polygon',
        address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
        type: 'compound_v3',
        startBlock: 42040260
      }
    ];

    for (const config of this.protocolConfigs) {
      await this.initializeProtocolContract(config);
      this.indexingState.set(config.name, config.startBlock);
    }

    console.log(`✓ Registered ${this.protocolConfigs.length} lending protocols`);
  }

  /**
   * Initialize protocol contract instance
   */
  private async initializeProtocolContract(config: LendingProtocol): Promise<void> {
    const provider = this.providers.get(config.chain);
    if (!provider) {
      console.error(`No provider for chain ${config.chain}`);
      return;
    }

    let abi: string[];
    switch (config.type) {
      case 'aave_v3':
        abi = AAVE_V3_POOL_ABI;
        break;
      case 'compound_v3':
        abi = COMPOUND_V3_ABI;
        break;
      default:
        abi = AAVE_V3_POOL_ABI; // Default
    }

    const contract = new Contract(config.address, abi, provider);
    this.protocols.set(config.name, contract);
  }

  /**
   * Start indexing all protocols
   */
  async startIndexing(): Promise<void> {
    this.isRunning = true;
    console.log('🚀 Starting lending rate indexing...');

    // Start parallel indexing for each protocol
    const indexingPromises = this.protocolConfigs.map((config) =>
      this.indexProtocol(config).catch((error) => {
        console.error(`Error indexing ${config.name}:`, error);
      })
    );

    // Also start rate snapshot collection
    this.startRateSnapshots();

    await Promise.all(indexingPromises);
  }

  /**
   * Index a single protocol
   */
  private async indexProtocol(config: LendingProtocol): Promise<void> {
    const provider = this.providers.get(config.chain);
    const contract = this.protocols.get(config.name);

    if (!provider || !contract) {
      console.error(`Missing provider or contract for ${config.name}`);
      return;
    }

    const currentBlock = await provider.getBlockNumber();
    let fromBlock = this.indexingState.get(config.name) || config.startBlock;

    console.log(`Indexing ${config.name} from block ${fromBlock} to ${currentBlock}`);

    const batchSize = 1000;

    while (fromBlock < currentBlock && this.isRunning) {
      const toBlock = Math.min(fromBlock + batchSize, currentBlock);

      try {
        switch (config.type) {
          case 'aave_v3':
            await this.indexAaveV3Events(config, contract, fromBlock, toBlock);
            break;
          case 'compound_v3':
            await this.indexCompoundV3Events(config, contract, fromBlock, toBlock);
            break;
        }

        this.indexingState.set(config.name, toBlock);
        await this.saveIndexingState(config.name, toBlock);

        fromBlock = toBlock + 1;

        // Rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        console.error(`Error indexing ${config.name} blocks ${fromBlock}-${toBlock}:`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    console.log(`✓ Completed indexing ${config.name} up to block ${currentBlock}`);

    // Continue real-time indexing
    await this.startRealtimeIndexing(config, contract, provider);
  }

  /**
   * Index Aave V3 events
   */
  private async indexAaveV3Events(
    config: LendingProtocol,
    contract: Contract,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    // Supply events
    const supplyFilter = contract.filters.Supply();
    const supplyEvents = await contract.queryFilter(supplyFilter, fromBlock, toBlock);

    for (const event of supplyEvents) {
      if (event instanceof EventLog) {
        await this.processAaveSupply(config, event);
      }
    }

    // Borrow events
    const borrowFilter = contract.filters.Borrow();
    const borrowEvents = await contract.queryFilter(borrowFilter, fromBlock, toBlock);

    for (const event of borrowEvents) {
      if (event instanceof EventLog) {
        await this.processAaveBorrow(config, event);
      }
    }

    // Liquidation events
    const liquidationFilter = contract.filters.LiquidationCall();
    const liquidationEvents = await contract.queryFilter(liquidationFilter, fromBlock, toBlock);

    for (const event of liquidationEvents) {
      if (event instanceof EventLog) {
        await this.processAaveLiquidation(config, event);
      }
    }

    // Rate update events
    const rateUpdateFilter = contract.filters.ReserveDataUpdated();
    const rateEvents = await contract.queryFilter(rateUpdateFilter, fromBlock, toBlock);

    for (const event of rateEvents) {
      if (event instanceof EventLog) {
        await this.processAaveRateUpdate(config, event);
      }
    }

    console.log(
      `  ${config.name}: ${supplyEvents.length} supplies, ${borrowEvents.length} borrows, ${liquidationEvents.length} liquidations`
    );
  }

  /**
   * Index Compound V3 events
   */
  private async indexCompoundV3Events(
    config: LendingProtocol,
    contract: Contract,
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    // Supply events
    const supplyFilter = contract.filters.Supply();
    const supplyEvents = await contract.queryFilter(supplyFilter, fromBlock, toBlock);

    for (const event of supplyEvents) {
      if (event instanceof EventLog) {
        await this.processCompoundSupply(config, event);
      }
    }

    // Withdraw events
    const withdrawFilter = contract.filters.Withdraw();
    const withdrawEvents = await contract.queryFilter(withdrawFilter, fromBlock, toBlock);

    for (const event of withdrawEvents) {
      if (event instanceof EventLog) {
        await this.processCompoundWithdraw(config, event);
      }
    }

    // Absorption (liquidation) events
    const absorbFilter = contract.filters.AbsorbDebt();
    const absorbEvents = await contract.queryFilter(absorbFilter, fromBlock, toBlock);

    for (const event of absorbEvents) {
      if (event instanceof EventLog) {
        await this.processCompoundAbsorption(config, event);
      }
    }

    console.log(
      `  ${config.name}: ${supplyEvents.length} supplies, ${withdrawEvents.length} withdraws, ${absorbEvents.length} absorptions`
    );
  }

  /**
   * Process Aave supply event
   */
  private async processAaveSupply(config: LendingProtocol, event: EventLog): Promise<void> {
    const { reserve, onBehalfOf, amount } = event.args!;

    await this.prisma.lendingEvent.create({
      data: {
        protocol: config.name,
        chain: config.chain,
        eventType: 'SUPPLY',
        asset: reserve,
        user: onBehalfOf,
        amount: amount.toString(),
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        timestamp: new Date()
      }
    });

    // Update user position
    await this.updateUserPosition(config, onBehalfOf, reserve);

    // Publish event
    await this.redis.publish(
      'lending:supply',
      JSON.stringify({
        protocol: config.name,
        asset: reserve,
        user: onBehalfOf,
        amount: amount.toString(),
        timestamp: Date.now()
      })
    );
  }

  /**
   * Process Aave borrow event
   */
  private async processAaveBorrow(config: LendingProtocol, event: EventLog): Promise<void> {
    const { reserve, onBehalfOf, amount, borrowRate } = event.args!;

    await this.prisma.lendingEvent.create({
      data: {
        protocol: config.name,
        chain: config.chain,
        eventType: 'BORROW',
        asset: reserve,
        user: onBehalfOf,
        amount: amount.toString(),
        interestRate: borrowRate.toString(),
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        timestamp: new Date()
      }
    });

    // Check health factor
    await this.checkHealthFactor(config, onBehalfOf);

    // Publish event
    await this.redis.publish(
      'lending:borrow',
      JSON.stringify({
        protocol: config.name,
        asset: reserve,
        user: onBehalfOf,
        amount: amount.toString(),
        borrowRate: borrowRate.toString(),
        timestamp: Date.now()
      })
    );
  }

  /**
   * Process Aave liquidation event
   */
  private async processAaveLiquidation(config: LendingProtocol, event: EventLog): Promise<void> {
    const {
      collateralAsset,
      debtAsset,
      user: borrower,
      debtToCover,
      liquidatedCollateralAmount,
      liquidator
    } = event.args!;

    const liquidationEvent: LiquidationEvent = {
      liquidator,
      borrower,
      protocol: config.name,
      asset: debtAsset,
      collateralAsset,
      debtRepaid: debtToCover,
      collateralSeized: liquidatedCollateralAmount,
      timestamp: Date.now(),
      txHash: event.transactionHash,
      blockNumber: event.blockNumber
    };

    await this.prisma.liquidation.create({
      data: {
        protocol: config.name,
        chain: config.chain,
        liquidator,
        borrower,
        debtAsset,
        collateralAsset,
        debtRepaid: debtToCover.toString(),
        collateralSeized: liquidatedCollateralAmount.toString(),
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        timestamp: new Date()
      }
    });

    // Emit critical event
    this.emit('liquidation', liquidationEvent);

    // Publish to Redis
    await this.redis.publish('lending:liquidation', JSON.stringify(liquidationEvent));

    console.log(`⚠️ Liquidation: ${borrower} by ${liquidator}`);
  }

  /**
   * Process Aave rate update event
   */
  private async processAaveRateUpdate(config: LendingProtocol, event: EventLog): Promise<void> {
    const { reserve, liquidityRate, variableBorrowRate } = event.args!;

    const rateData = {
      protocol: config.name,
      asset: reserve,
      supplyRate: liquidityRate.toString(),
      borrowRate: variableBorrowRate.toString(),
      timestamp: Date.now(),
      blockNumber: event.blockNumber
    };

    // Cache in Redis
    await this.redis.set(`rate:${config.name}:${reserve}`, JSON.stringify(rateData), { EX: 3600 });

    // Publish rate update
    await this.redis.publish('lending:rate_update', JSON.stringify(rateData));
  }

  /**
   * Process Compound supply
   */
  private async processCompoundSupply(config: LendingProtocol, event: EventLog): Promise<void> {
    const { from, dst, amount } = event.args!;

    await this.prisma.lendingEvent.create({
      data: {
        protocol: config.name,
        chain: config.chain,
        eventType: 'SUPPLY',
        asset: config.address, // Base asset of the Comet
        user: dst,
        amount: amount.toString(),
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        timestamp: new Date()
      }
    });
  }

  /**
   * Process Compound withdraw
   */
  private async processCompoundWithdraw(config: LendingProtocol, event: EventLog): Promise<void> {
    const { src, to, amount } = event.args!;

    await this.prisma.lendingEvent.create({
      data: {
        protocol: config.name,
        chain: config.chain,
        eventType: 'WITHDRAW',
        asset: config.address,
        user: src,
        amount: amount.toString(),
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        timestamp: new Date()
      }
    });
  }

  /**
   * Process Compound absorption (liquidation)
   */
  private async processCompoundAbsorption(config: LendingProtocol, event: EventLog): Promise<void> {
    const { absorber, borrower, basePaidOut, usdValue } = event.args!;

    await this.prisma.liquidation.create({
      data: {
        protocol: config.name,
        chain: config.chain,
        liquidator: absorber,
        borrower,
        debtAsset: config.address,
        collateralAsset: config.address,
        debtRepaid: basePaidOut.toString(),
        collateralSeized: usdValue.toString(),
        blockNumber: event.blockNumber,
        txHash: event.transactionHash,
        timestamp: new Date()
      }
    });

    console.log(`⚠️ Compound Absorption: ${borrower}`);
  }

  /**
   * Update user position
   */
  private async updateUserPosition(
    config: LendingProtocol,
    user: string,
    asset: string
  ): Promise<void> {
    const contract = this.protocols.get(config.name);
    if (!contract || config.type !== 'aave_v3') return;

    try {
      const accountData = await contract.getUserAccountData(user);
      const [
        totalCollateralBase,
        totalDebtBase,
        ,
        currentLiquidationThreshold,
        ,
        healthFactor
      ] = accountData;

      await this.prisma.userLendingPosition.upsert({
        where: {
          user_protocol_asset: {
            user,
            protocol: config.name,
            asset
          }
        },
        update: {
          collateral: totalCollateralBase.toString(),
          debt: totalDebtBase.toString(),
          healthFactor: healthFactor.toString(),
          liquidationThreshold: currentLiquidationThreshold.toString(),
          lastUpdated: new Date()
        },
        create: {
          user,
          protocol: config.name,
          asset,
          chain: config.chain,
          collateral: totalCollateralBase.toString(),
          debt: totalDebtBase.toString(),
          healthFactor: healthFactor.toString(),
          liquidationThreshold: currentLiquidationThreshold.toString(),
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      console.error(`Error updating position for ${user}:`, error);
    }
  }

  /**
   * Check user health factor
   */
  private async checkHealthFactor(config: LendingProtocol, user: string): Promise<void> {
    const contract = this.protocols.get(config.name);
    if (!contract || config.type !== 'aave_v3') return;

    try {
      const [, , , , , healthFactor] = await contract.getUserAccountData(user);

      // Health factor is in 18 decimals
      const healthFactorValue = Number(healthFactor) / 1e18;

      // Alert if health factor is low
      if (healthFactorValue < 1.1) {
        console.log(`⚠️ LOW HEALTH FACTOR: ${user} has ${healthFactorValue.toFixed(4)}`);

        await this.redis.publish(
          'lending:low_health',
          JSON.stringify({
            protocol: config.name,
            user,
            healthFactor: healthFactorValue,
            timestamp: Date.now()
          })
        );

        this.emit('lowHealthFactor', {
          protocol: config.name,
          user,
          healthFactor: healthFactorValue
        });
      }
    } catch (error) {
      console.error(`Error checking health factor for ${user}:`, error);
    }
  }

  /**
   * Start rate snapshot collection
   */
  private startRateSnapshots(): void {
    // Collect rate snapshots every 5 minutes
    setInterval(
      () => {
        this.collectAllRateSnapshots().catch(console.error);
      },
      5 * 60 * 1000
    );

    // Initial collection
    this.collectAllRateSnapshots().catch(console.error);
  }

  /**
   * Collect rate snapshots for all protocols
   */
  private async collectAllRateSnapshots(): Promise<void> {
    for (const config of this.protocolConfigs) {
      try {
        await this.collectRateSnapshot(config);
      } catch (error) {
        console.error(`Error collecting rate snapshot for ${config.name}:`, error);
      }
    }
  }

  /**
   * Collect rate snapshot for a single protocol
   */
  private async collectRateSnapshot(config: LendingProtocol): Promise<void> {
    const contract = this.protocols.get(config.name);
    const provider = this.providers.get(config.chain);
    if (!contract || !provider) return;

    const blockNumber = await provider.getBlockNumber();

    if (config.type === 'compound_v3') {
      const utilization = await contract.getUtilization();
      const supplyRate = await contract.getSupplyRate(utilization);
      const borrowRate = await contract.getBorrowRate(utilization);
      const totalSupply = await contract.totalSupply();
      const totalBorrow = await contract.totalBorrow();

      const snapshot: RateSnapshot = {
        protocol: config.name,
        asset: config.address,
        chain: config.chain,
        supplyRate,
        borrowRate,
        utilizationRate: utilization,
        totalSupply,
        totalBorrow,
        availableLiquidity: totalSupply - totalBorrow,
        timestamp: Date.now(),
        blockNumber
      };

      await this.saveRateSnapshot(snapshot);
    }
  }

  /**
   * Save rate snapshot to database
   */
  private async saveRateSnapshot(snapshot: RateSnapshot): Promise<void> {
    await this.prisma.rateSnapshot.create({
      data: {
        protocol: snapshot.protocol,
        asset: snapshot.asset,
        chain: snapshot.chain,
        supplyRate: snapshot.supplyRate.toString(),
        borrowRate: snapshot.borrowRate.toString(),
        utilizationRate: snapshot.utilizationRate.toString(),
        totalSupply: snapshot.totalSupply.toString(),
        totalBorrow: snapshot.totalBorrow.toString(),
        availableLiquidity: snapshot.availableLiquidity.toString(),
        blockNumber: snapshot.blockNumber,
        timestamp: new Date(snapshot.timestamp)
      }
    });

    // Cache latest rates
    await this.redis.set(`latest_rate:${snapshot.protocol}`, JSON.stringify(snapshot), {
      EX: 600
    });

    // Publish update
    await this.redis.publish('lending:rate_snapshot', JSON.stringify(snapshot));
  }

  /**
   * Start real-time indexing with event listeners
   */
  private async startRealtimeIndexing(
    config: LendingProtocol,
    contract: Contract,
    provider: JsonRpcProvider
  ): Promise<void> {
    console.log(`Starting real-time indexing for ${config.name}`);

    // Listen for new blocks
    provider.on('block', async (blockNumber: number) => {
      if (!this.isRunning) return;

      const lastProcessed = this.indexingState.get(config.name) || 0;
      if (blockNumber > lastProcessed) {
        try {
          switch (config.type) {
            case 'aave_v3':
              await this.indexAaveV3Events(config, contract, lastProcessed + 1, blockNumber);
              break;
            case 'compound_v3':
              await this.indexCompoundV3Events(config, contract, lastProcessed + 1, blockNumber);
              break;
          }
          this.indexingState.set(config.name, blockNumber);
        } catch (error) {
          console.error(`Real-time indexing error for ${config.name}:`, error);
        }
      }
    });
  }

  /**
   * Save indexing state
   */
  private async saveIndexingState(protocolName: string, blockNumber: number): Promise<void> {
    await this.redis.set(`indexing_state:${protocolName}`, blockNumber.toString());
  }

  /**
   * Get historical rates for an asset
   */
  async getHistoricalRates(
    protocol: string,
    asset: string,
    hoursBack: number = 24
  ): Promise<RateSnapshot[]> {
    const cutoffTime = new Date(Date.now() - hoursBack * 3600 * 1000);

    const snapshots = await this.prisma.rateSnapshot.findMany({
      where: {
        protocol,
        asset,
        timestamp: { gte: cutoffTime }
      },
      orderBy: { timestamp: 'asc' }
    });

    return snapshots.map((s) => ({
      protocol: s.protocol,
      asset: s.asset,
      chain: s.chain,
      supplyRate: BigInt(s.supplyRate),
      borrowRate: BigInt(s.borrowRate),
      utilizationRate: BigInt(s.utilizationRate),
      totalSupply: BigInt(s.totalSupply),
      totalBorrow: BigInt(s.totalBorrow),
      availableLiquidity: BigInt(s.availableLiquidity),
      timestamp: s.timestamp.getTime(),
      blockNumber: s.blockNumber
    }));
  }

  /**
   * Get at-risk positions
   */
  async getAtRiskPositions(healthFactorThreshold: number = 1.2): Promise<UserPosition[]> {
    const positions = await this.prisma.userLendingPosition.findMany({
      where: {
        healthFactor: {
          lte: (healthFactorThreshold * 1e18).toString()
        }
      },
      orderBy: { healthFactor: 'asc' }
    });

    return positions.map((p) => ({
      user: p.user,
      protocol: p.protocol,
      asset: p.asset,
      chain: p.chain,
      supplyBalance: BigInt(p.collateral),
      borrowBalance: BigInt(p.debt),
      healthFactor: BigInt(p.healthFactor),
      liquidationThreshold: BigInt(p.liquidationThreshold),
      timestamp: p.lastUpdated.getTime()
    }));
  }

  /**
   * Get protocol statistics
   */
  async getProtocolStats(protocol: string): Promise<any> {
    const [totalSupplies, totalBorrows, liquidations] = await Promise.all([
      this.prisma.lendingEvent.aggregate({
        where: {
          protocol,
          eventType: 'SUPPLY'
        },
        _sum: { amount: true },
        _count: true
      }),
      this.prisma.lendingEvent.aggregate({
        where: {
          protocol,
          eventType: 'BORROW'
        },
        _sum: { amount: true },
        _count: true
      }),
      this.prisma.liquidation.count({
        where: { protocol }
      })
    ]);

    return {
      protocol,
      totalSupplyEvents: totalSupplies._count,
      totalBorrowEvents: totalBorrows._count,
      totalLiquidations: liquidations,
      lastUpdated: Date.now()
    };
  }

  /**
   * Stop indexing
   */
  async stopIndexing(): Promise<void> {
    this.isRunning = false;
    console.log('Stopping lending rate indexer...');

    // Remove event listeners
    for (const [_, provider] of this.providers) {
      provider.removeAllListeners();
    }

    await this.redis.quit();
    await this.prisma.$disconnect();

    console.log('✓ Lending Rate Indexer stopped');
  }
}

// Main execution
if (require.main === module) {
  const indexer = new LendingRateIndexer();

  async function main() {
    await indexer.initializeProviders();
    await indexer.registerProtocols();
    await indexer.startIndexing();
  }

  main().catch(console.error);

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await indexer.stopIndexing();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await indexer.stopIndexing();
    process.exit(0);
  });
}

export default LendingRateIndexer;
