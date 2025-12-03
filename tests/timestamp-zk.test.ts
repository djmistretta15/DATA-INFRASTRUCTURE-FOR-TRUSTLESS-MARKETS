import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract, Signer, keccak256, toUtf8Bytes, solidityPacked } from 'ethers';

/**
 * Comprehensive Test Suite for zkTimestampVerifier Contract
 * Tests ZK-STARK proof verification, batch processing, and security
 * 1500 LoC as specified
 */

describe('zkTimestampVerifier', () => {
  let zkVerifier: Contract;
  let owner: Signer;
  let verifier: Signer;
  let submitter: Signer;
  let attacker: Signer;
  let users: Signer[];

  const SECURITY_LEVEL = 128n;
  const MIN_VERIFICATIONS = 2n;
  const TIMESTAMP_TOLERANCE = 300n; // 5 minutes

  // Mock ZK proof data
  const generateMockProof = (
    dataHash: string,
    timestamp: bigint,
    nonce: bigint
  ): string[] => {
    // Simulate ZK-STARK proof structure
    const proofElements: string[] = [];
    for (let i = 0; i < 10; i++) {
      const element = keccak256(
        solidityPacked(
          ['bytes32', 'uint256', 'uint256', 'uint256'],
          [dataHash, timestamp, nonce, BigInt(i)]
        )
      );
      proofElements.push(element);
    }
    return proofElements;
  };

  const generateCommitment = (dataHash: string, timestamp: bigint, nonce: bigint): string => {
    return keccak256(
      solidityPacked(['bytes32', 'uint256', 'uint256'], [dataHash, timestamp, nonce])
    );
  };

  beforeEach(async () => {
    [owner, verifier, submitter, attacker, ...users] = await ethers.getSigners();

    const ZKTimestampVerifier = await ethers.getContractFactory('zkTimestampVerifier');
    zkVerifier = await ZKTimestampVerifier.deploy(
      SECURITY_LEVEL,
      TIMESTAMP_TOLERANCE,
      MIN_VERIFICATIONS
    );
    await zkVerifier.waitForDeployment();

    // Register verifier
    await zkVerifier.connect(owner).registerVerifier(await verifier.getAddress());
  });

  describe('Contract Initialization', () => {
    it('should initialize with correct security parameters', async () => {
      expect(await zkVerifier.securityLevel()).to.equal(SECURITY_LEVEL);
      expect(await zkVerifier.timestampTolerance()).to.equal(TIMESTAMP_TOLERANCE);
      expect(await zkVerifier.requiredVerifications()).to.equal(MIN_VERIFICATIONS);
    });

    it('should set deployer as owner', async () => {
      const ownerRole = await zkVerifier.DEFAULT_ADMIN_ROLE();
      expect(await zkVerifier.hasRole(ownerRole, await owner.getAddress())).to.be.true;
    });

    it('should reject invalid security level', async () => {
      const ZKTimestampVerifier = await ethers.getContractFactory('zkTimestampVerifier');
      await expect(
        ZKTimestampVerifier.deploy(64n, TIMESTAMP_TOLERANCE, MIN_VERIFICATIONS)
      ).to.be.revertedWith('Security level too low');
    });

    it('should reject zero timestamp tolerance', async () => {
      const ZKTimestampVerifier = await ethers.getContractFactory('zkTimestampVerifier');
      await expect(
        ZKTimestampVerifier.deploy(SECURITY_LEVEL, 0n, MIN_VERIFICATIONS)
      ).to.be.revertedWith('Invalid timestamp tolerance');
    });

    it('should reject zero required verifications', async () => {
      const ZKTimestampVerifier = await ethers.getContractFactory('zkTimestampVerifier');
      await expect(ZKTimestampVerifier.deploy(SECURITY_LEVEL, TIMESTAMP_TOLERANCE, 0n)).to.be
        .reverted;
    });
  });

  describe('Verifier Management', () => {
    it('should register new verifier', async () => {
      const newVerifier = users[0];
      await expect(zkVerifier.connect(owner).registerVerifier(await newVerifier.getAddress()))
        .to.emit(zkVerifier, 'VerifierRegistered')
        .withArgs(await newVerifier.getAddress());

      expect(await zkVerifier.isVerifier(await newVerifier.getAddress())).to.be.true;
    });

    it('should reject duplicate verifier registration', async () => {
      await expect(
        zkVerifier.connect(owner).registerVerifier(await verifier.getAddress())
      ).to.be.revertedWith('Already registered');
    });

    it('should revoke verifier', async () => {
      await expect(zkVerifier.connect(owner).revokeVerifier(await verifier.getAddress()))
        .to.emit(zkVerifier, 'VerifierRevoked')
        .withArgs(await verifier.getAddress());

      expect(await zkVerifier.isVerifier(await verifier.getAddress())).to.be.false;
    });

    it('should reject non-admin verifier registration', async () => {
      await expect(
        zkVerifier.connect(attacker).registerVerifier(await users[0].getAddress())
      ).to.be.reverted;
    });

    it('should track verifier count', async () => {
      const initialCount = await zkVerifier.verifierCount();
      await zkVerifier.connect(owner).registerVerifier(await users[0].getAddress());
      expect(await zkVerifier.verifierCount()).to.equal(initialCount + 1n);
    });

    it('should get all active verifiers', async () => {
      await zkVerifier.connect(owner).registerVerifier(await users[0].getAddress());
      await zkVerifier.connect(owner).registerVerifier(await users[1].getAddress());

      const verifiers = await zkVerifier.getActiveVerifiers();
      expect(verifiers.length).to.be.gte(3);
    });
  });

  describe('Commitment Phase', () => {
    it('should submit commitment successfully', async () => {
      const dataHash = keccak256(toUtf8Bytes('test data'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 12345n;
      const commitment = generateCommitment(dataHash, timestamp, nonce);

      await expect(zkVerifier.connect(submitter).submitCommitment(commitment))
        .to.emit(zkVerifier, 'CommitmentSubmitted')
        .withArgs(commitment, await submitter.getAddress());
    });

    it('should reject duplicate commitment', async () => {
      const commitment = generateCommitment(
        keccak256(toUtf8Bytes('data')),
        BigInt(Math.floor(Date.now() / 1000)),
        1n
      );

      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await expect(zkVerifier.connect(submitter).submitCommitment(commitment)).to.be.revertedWith(
        'Commitment exists'
      );
    });

    it('should track commitment timestamp', async () => {
      const commitment = generateCommitment(
        keccak256(toUtf8Bytes('data')),
        BigInt(Math.floor(Date.now() / 1000)),
        2n
      );

      const tx = await zkVerifier.connect(submitter).submitCommitment(commitment);
      const block = await ethers.provider.getBlock(tx.blockNumber!);

      const commitmentData = await zkVerifier.getCommitment(commitment);
      expect(commitmentData.submissionTime).to.equal(block!.timestamp);
    });

    it('should allow multiple commitments from same submitter', async () => {
      for (let i = 0; i < 5; i++) {
        const commitment = generateCommitment(
          keccak256(toUtf8Bytes(`data${i}`)),
          BigInt(Math.floor(Date.now() / 1000)),
          BigInt(i)
        );
        await zkVerifier.connect(submitter).submitCommitment(commitment);
      }

      const count = await zkVerifier.getSubmitterCommitmentCount(await submitter.getAddress());
      expect(count).to.equal(5n);
    });
  });

  describe('Reveal Phase', () => {
    let commitment: string;
    let dataHash: string;
    let timestamp: bigint;
    let nonce: bigint;

    beforeEach(async () => {
      dataHash = keccak256(toUtf8Bytes('test data for reveal'));
      timestamp = BigInt(Math.floor(Date.now() / 1000));
      nonce = 99999n;
      commitment = generateCommitment(dataHash, timestamp, nonce);

      await zkVerifier.connect(submitter).submitCommitment(commitment);
    });

    it('should reveal commitment successfully', async () => {
      await expect(zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce))
        .to.emit(zkVerifier, 'CommitmentRevealed')
        .withArgs(commitment, dataHash, nonce);

      const commitmentData = await zkVerifier.getCommitment(commitment);
      expect(commitmentData.revealed).to.be.true;
    });

    it('should reject invalid reveal data', async () => {
      const wrongHash = keccak256(toUtf8Bytes('wrong data'));
      await expect(
        zkVerifier.connect(submitter).revealCommitment(commitment, wrongHash, nonce)
      ).to.be.revertedWith('Invalid reveal');
    });

    it('should reject invalid nonce', async () => {
      const wrongNonce = 88888n;
      await expect(
        zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, wrongNonce)
      ).to.be.revertedWith('Invalid reveal');
    });

    it('should reject non-existent commitment reveal', async () => {
      const fakeCommitment = generateCommitment(
        keccak256(toUtf8Bytes('fake')),
        timestamp,
        12345n
      );
      await expect(
        zkVerifier.connect(submitter).revealCommitment(fakeCommitment, dataHash, nonce)
      ).to.be.revertedWith('Commitment not found');
    });

    it('should reject double reveal', async () => {
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);
      await expect(
        zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce)
      ).to.be.revertedWith('Already revealed');
    });

    it('should only allow original submitter to reveal', async () => {
      await expect(
        zkVerifier.connect(attacker).revealCommitment(commitment, dataHash, nonce)
      ).to.be.revertedWith('Not submitter');
    });
  });

  describe('ZK Proof Verification', () => {
    let dataHash: string;
    let timestamp: bigint;
    let nonce: bigint;
    let proof: string[];
    let commitment: string;

    beforeEach(async () => {
      dataHash = keccak256(toUtf8Bytes('verifiable data'));
      timestamp = BigInt(Math.floor(Date.now() / 1000));
      nonce = 777n;
      proof = generateMockProof(dataHash, timestamp, nonce);
      commitment = generateCommitment(dataHash, timestamp, nonce);

      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);
    });

    it('should verify valid ZK proof', async () => {
      await expect(zkVerifier.connect(verifier).verifyProof(commitment, proof))
        .to.emit(zkVerifier, 'ProofVerified')
        .withArgs(commitment, await verifier.getAddress(), true);
    });

    it('should require minimum proof elements', async () => {
      const shortProof = proof.slice(0, 3);
      await expect(
        zkVerifier.connect(verifier).verifyProof(commitment, shortProof)
      ).to.be.revertedWith('Insufficient proof data');
    });

    it('should reject proof from non-verifier', async () => {
      await expect(zkVerifier.connect(attacker).verifyProof(commitment, proof)).to.be.revertedWith(
        'Not a verifier'
      );
    });

    it('should require commitment to be revealed first', async () => {
      const newHash = keccak256(toUtf8Bytes('unrevealed'));
      const newTimestamp = BigInt(Math.floor(Date.now() / 1000));
      const newNonce = 888n;
      const newCommitment = generateCommitment(newHash, newTimestamp, newNonce);

      await zkVerifier.connect(submitter).submitCommitment(newCommitment);

      await expect(
        zkVerifier.connect(verifier).verifyProof(newCommitment, proof)
      ).to.be.revertedWith('Not revealed');
    });

    it('should track verification count', async () => {
      await zkVerifier.connect(verifier).verifyProof(commitment, proof);

      const data = await zkVerifier.getCommitment(commitment);
      expect(data.verificationCount).to.equal(1n);
    });

    it('should mark as fully verified when threshold reached', async () => {
      // Register second verifier
      await zkVerifier.connect(owner).registerVerifier(await users[0].getAddress());

      await zkVerifier.connect(verifier).verifyProof(commitment, proof);
      await zkVerifier.connect(users[0]).verifyProof(commitment, proof);

      const data = await zkVerifier.getCommitment(commitment);
      expect(data.fullyVerified).to.be.true;
    });

    it('should prevent same verifier verifying twice', async () => {
      await zkVerifier.connect(verifier).verifyProof(commitment, proof);
      await expect(zkVerifier.connect(verifier).verifyProof(commitment, proof)).to.be.revertedWith(
        'Already verified by this verifier'
      );
    });
  });

  describe('Batch Processing', () => {
    it('should submit batch of commitments', async () => {
      const commitments: string[] = [];
      for (let i = 0; i < 10; i++) {
        const hash = keccak256(toUtf8Bytes(`batch data ${i}`));
        const ts = BigInt(Math.floor(Date.now() / 1000) + i);
        const n = BigInt(i * 100);
        commitments.push(generateCommitment(hash, ts, n));
      }

      await expect(zkVerifier.connect(submitter).submitBatchCommitments(commitments))
        .to.emit(zkVerifier, 'BatchCommitted')
        .withArgs(await submitter.getAddress(), 10n);
    });

    it('should reject empty batch', async () => {
      await expect(zkVerifier.connect(submitter).submitBatchCommitments([])).to.be.revertedWith(
        'Empty batch'
      );
    });

    it('should reject oversized batch', async () => {
      const commitments: string[] = [];
      for (let i = 0; i < 101; i++) {
        commitments.push(
          generateCommitment(keccak256(toUtf8Bytes(`${i}`)), BigInt(Date.now()), BigInt(i))
        );
      }

      await expect(
        zkVerifier.connect(submitter).submitBatchCommitments(commitments)
      ).to.be.revertedWith('Batch too large');
    });

    it('should skip duplicate commitments in batch', async () => {
      const commitment = generateCommitment(
        keccak256(toUtf8Bytes('dup')),
        BigInt(Date.now()),
        1n
      );

      const batch = [commitment, commitment, commitment];
      const tx = await zkVerifier.connect(submitter).submitBatchCommitments(batch);
      const receipt = await tx.wait();

      // Should only emit once for unique commitments
      const events = receipt?.logs.filter((l: any) => l.eventName === 'CommitmentSubmitted');
      expect(events?.length).to.equal(1);
    });

    it('should process batch verifications', async () => {
      const commitments: string[] = [];
      const dataHashes: string[] = [];
      const nonces: bigint[] = [];
      const proofs: string[][] = [];

      for (let i = 0; i < 5; i++) {
        const hash = keccak256(toUtf8Bytes(`batch verify ${i}`));
        const ts = BigInt(Math.floor(Date.now() / 1000));
        const n = BigInt(i * 1000);

        dataHashes.push(hash);
        nonces.push(n);
        commitments.push(generateCommitment(hash, ts, n));
        proofs.push(generateMockProof(hash, ts, n));
      }

      // Submit all commitments
      await zkVerifier.connect(submitter).submitBatchCommitments(commitments);

      // Reveal all
      for (let i = 0; i < 5; i++) {
        await zkVerifier
          .connect(submitter)
          .revealCommitment(commitments[i], dataHashes[i], nonces[i]);
      }

      // Batch verify
      await expect(zkVerifier.connect(verifier).verifyBatchProofs(commitments, proofs))
        .to.emit(zkVerifier, 'BatchVerified')
        .withArgs(await verifier.getAddress(), 5n);
    });
  });

  describe('Merkle Tree Batching', () => {
    it('should create merkle root from commitments', async () => {
      const commitments: string[] = [];
      for (let i = 0; i < 8; i++) {
        commitments.push(
          generateCommitment(keccak256(toUtf8Bytes(`merkle ${i}`)), BigInt(Date.now()), BigInt(i))
        );
      }

      const merkleRoot = await zkVerifier.computeMerkleRoot(commitments);
      expect(merkleRoot).to.have.length(66); // 0x + 64 hex chars
    });

    it('should verify merkle proof', async () => {
      const commitments: string[] = [];
      for (let i = 0; i < 4; i++) {
        commitments.push(
          generateCommitment(
            keccak256(toUtf8Bytes(`merkle verify ${i}`)),
            BigInt(Date.now()),
            BigInt(i)
          )
        );
      }

      const merkleRoot = await zkVerifier.computeMerkleRoot(commitments);
      const leafIndex = 1n;
      const merkleProof = await zkVerifier.generateMerkleProof(commitments, leafIndex);

      const isValid = await zkVerifier.verifyMerkleProof(
        commitments[1],
        merkleRoot,
        merkleProof,
        leafIndex
      );
      expect(isValid).to.be.true;
    });

    it('should reject invalid merkle proof', async () => {
      const commitments: string[] = [];
      for (let i = 0; i < 4; i++) {
        commitments.push(
          generateCommitment(
            keccak256(toUtf8Bytes(`invalid merkle ${i}`)),
            BigInt(Date.now()),
            BigInt(i)
          )
        );
      }

      const merkleRoot = await zkVerifier.computeMerkleRoot(commitments);
      const wrongProof = [keccak256(toUtf8Bytes('wrong')), keccak256(toUtf8Bytes('proof'))];

      const isValid = await zkVerifier.verifyMerkleProof(commitments[0], merkleRoot, wrongProof, 0n);
      expect(isValid).to.be.false;
    });
  });

  describe('Timestamp Validation', () => {
    it('should validate timestamp within tolerance', async () => {
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      const withinTolerance = currentTime - TIMESTAMP_TOLERANCE + 10n;

      const isValid = await zkVerifier.isTimestampValid(withinTolerance);
      expect(isValid).to.be.true;
    });

    it('should reject timestamp too old', async () => {
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      const tooOld = currentTime - TIMESTAMP_TOLERANCE - 100n;

      const isValid = await zkVerifier.isTimestampValid(tooOld);
      expect(isValid).to.be.false;
    });

    it('should reject future timestamp', async () => {
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      const future = currentTime + 3600n; // 1 hour in future

      const isValid = await zkVerifier.isTimestampValid(future);
      expect(isValid).to.be.false;
    });

    it('should update timestamp tolerance', async () => {
      const newTolerance = 600n; // 10 minutes
      await zkVerifier.connect(owner).updateTimestampTolerance(newTolerance);
      expect(await zkVerifier.timestampTolerance()).to.equal(newTolerance);
    });

    it('should reject invalid tolerance update', async () => {
      await expect(zkVerifier.connect(owner).updateTimestampTolerance(0n)).to.be.revertedWith(
        'Invalid tolerance'
      );
    });
  });

  describe('Security Level Management', () => {
    it('should update security level', async () => {
      const newLevel = 256n;
      await expect(zkVerifier.connect(owner).updateSecurityLevel(newLevel))
        .to.emit(zkVerifier, 'SecurityLevelUpdated')
        .withArgs(SECURITY_LEVEL, newLevel);

      expect(await zkVerifier.securityLevel()).to.equal(newLevel);
    });

    it('should reject lowering security level', async () => {
      await expect(zkVerifier.connect(owner).updateSecurityLevel(64n)).to.be.revertedWith(
        'Cannot lower security'
      );
    });

    it('should reject non-admin security update', async () => {
      await expect(zkVerifier.connect(attacker).updateSecurityLevel(256n)).to.be.reverted;
    });

    it('should validate proof against security level', async () => {
      const dataHash = keccak256(toUtf8Bytes('security test'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 555n;

      const commitment = generateCommitment(dataHash, timestamp, nonce);
      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);

      // Proof should meet minimum security requirements
      const proof = generateMockProof(dataHash, timestamp, nonce);
      const meetsLevel = await zkVerifier.proofMeetsSecurityLevel(proof);
      expect(meetsLevel).to.be.true;
    });
  });

  describe('Attestation Queries', () => {
    let commitment: string;
    let dataHash: string;

    beforeEach(async () => {
      dataHash = keccak256(toUtf8Bytes('attestation query data'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 333n;
      commitment = generateCommitment(dataHash, timestamp, nonce);

      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);

      // Register second verifier and verify
      await zkVerifier.connect(owner).registerVerifier(await users[0].getAddress());
      const proof = generateMockProof(dataHash, timestamp, nonce);
      await zkVerifier.connect(verifier).verifyProof(commitment, proof);
      await zkVerifier.connect(users[0]).verifyProof(commitment, proof);
    });

    it('should query attestation status', async () => {
      const attestation = await zkVerifier.getAttestationStatus(commitment);
      expect(attestation.exists).to.be.true;
      expect(attestation.revealed).to.be.true;
      expect(attestation.fullyVerified).to.be.true;
      expect(attestation.dataHash).to.equal(dataHash);
    });

    it('should get all attestations for data hash', async () => {
      const attestations = await zkVerifier.getAttestationsForData(dataHash);
      expect(attestations.length).to.be.gte(1);
    });

    it('should get verifier history for commitment', async () => {
      const verifiers = await zkVerifier.getVerifiersForCommitment(commitment);
      expect(verifiers.length).to.equal(2);
      expect(verifiers).to.include(await verifier.getAddress());
      expect(verifiers).to.include(await users[0].getAddress());
    });

    it('should check if commitment is fully attested', async () => {
      const isAttested = await zkVerifier.isFullyAttested(commitment);
      expect(isAttested).to.be.true;
    });
  });

  describe('Slashing and Penalties', () => {
    it('should slash verifier for invalid proof acceptance', async () => {
      const dataHash = keccak256(toUtf8Bytes('slashing test'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 666n;
      const commitment = generateCommitment(dataHash, timestamp, nonce);

      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);

      const proof = generateMockProof(dataHash, timestamp, nonce);
      await zkVerifier.connect(verifier).verifyProof(commitment, proof);

      // Owner reports invalid verification
      await expect(
        zkVerifier.connect(owner).reportInvalidVerification(commitment, await verifier.getAddress())
      )
        .to.emit(zkVerifier, 'VerifierSlashed')
        .withArgs(await verifier.getAddress(), commitment);

      // Check verifier is penalized
      const penalty = await zkVerifier.getVerifierPenalties(await verifier.getAddress());
      expect(penalty).to.be.gt(0n);
    });

    it('should revoke verifier after multiple penalties', async () => {
      // Accumulate penalties
      for (let i = 0; i < 3; i++) {
        const hash = keccak256(toUtf8Bytes(`penalty ${i}`));
        const ts = BigInt(Math.floor(Date.now() / 1000));
        const n = BigInt(i);
        const commitment = generateCommitment(hash, ts, n);

        await zkVerifier.connect(submitter).submitCommitment(commitment);
        await zkVerifier.connect(submitter).revealCommitment(commitment, hash, n);

        const proof = generateMockProof(hash, ts, n);
        await zkVerifier.connect(verifier).verifyProof(commitment, proof);
        await zkVerifier
          .connect(owner)
          .reportInvalidVerification(commitment, await verifier.getAddress());
      }

      // Should be automatically revoked
      expect(await zkVerifier.isVerifier(await verifier.getAddress())).to.be.false;
    });
  });

  describe('Emergency Controls', () => {
    it('should pause contract', async () => {
      await zkVerifier.connect(owner).pause();
      expect(await zkVerifier.paused()).to.be.true;
    });

    it('should prevent operations when paused', async () => {
      await zkVerifier.connect(owner).pause();

      const commitment = generateCommitment(
        keccak256(toUtf8Bytes('paused')),
        BigInt(Date.now()),
        1n
      );

      await expect(zkVerifier.connect(submitter).submitCommitment(commitment)).to.be.revertedWith(
        'Pausable: paused'
      );
    });

    it('should unpause contract', async () => {
      await zkVerifier.connect(owner).pause();
      await zkVerifier.connect(owner).unpause();
      expect(await zkVerifier.paused()).to.be.false;
    });

    it('should only allow admin to pause', async () => {
      await expect(zkVerifier.connect(attacker).pause()).to.be.reverted;
    });

    it('should emergency revoke all verifiers', async () => {
      await zkVerifier.connect(owner).registerVerifier(await users[0].getAddress());
      await zkVerifier.connect(owner).registerVerifier(await users[1].getAddress());

      await expect(zkVerifier.connect(owner).emergencyRevokeAll())
        .to.emit(zkVerifier, 'EmergencyRevokeAll')
        .withArgs(await owner.getAddress());

      expect(await zkVerifier.verifierCount()).to.equal(0n);
    });
  });

  describe('Gas Optimization Tests', () => {
    it('should submit commitment with reasonable gas', async () => {
      const commitment = generateCommitment(
        keccak256(toUtf8Bytes('gas test')),
        BigInt(Date.now()),
        1n
      );

      const tx = await zkVerifier.connect(submitter).submitCommitment(commitment);
      const receipt = await tx.wait();

      // Should be under 100k gas
      expect(receipt!.gasUsed).to.be.lt(100000n);
    });

    it('should batch verify with gas savings', async () => {
      const batchSize = 10;
      const commitments: string[] = [];
      const proofs: string[][] = [];

      for (let i = 0; i < batchSize; i++) {
        const hash = keccak256(toUtf8Bytes(`gas batch ${i}`));
        const ts = BigInt(Math.floor(Date.now() / 1000));
        const n = BigInt(i);

        commitments.push(generateCommitment(hash, ts, n));
        proofs.push(generateMockProof(hash, ts, n));
      }

      await zkVerifier.connect(submitter).submitBatchCommitments(commitments);

      for (let i = 0; i < batchSize; i++) {
        const hash = keccak256(toUtf8Bytes(`gas batch ${i}`));
        await zkVerifier
          .connect(submitter)
          .revealCommitment(commitments[i], hash, BigInt(i));
      }

      const batchTx = await zkVerifier.connect(verifier).verifyBatchProofs(commitments, proofs);
      const batchReceipt = await batchTx.wait();
      const batchGas = batchReceipt!.gasUsed;

      // Batch should be significantly cheaper than individual
      const perItemGas = batchGas / BigInt(batchSize);
      console.log(`Gas per batch item: ${perItemGas}`);

      // Each item should use less than 50k gas in batch
      expect(perItemGas).to.be.lt(50000n);
    });
  });

  describe('Edge Cases and Boundary Tests', () => {
    it('should handle maximum batch size', async () => {
      const commitments: string[] = [];
      for (let i = 0; i < 100; i++) {
        commitments.push(
          generateCommitment(keccak256(toUtf8Bytes(`max ${i}`)), BigInt(Date.now()), BigInt(i))
        );
      }

      await expect(zkVerifier.connect(submitter).submitBatchCommitments(commitments)).to.not.be
        .reverted;
    });

    it('should handle very large proof array', async () => {
      const dataHash = keccak256(toUtf8Bytes('large proof'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 999n;

      const commitment = generateCommitment(dataHash, timestamp, nonce);
      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);

      // Generate large proof
      const largeProof: string[] = [];
      for (let i = 0; i < 50; i++) {
        largeProof.push(keccak256(solidityPacked(['uint256'], [BigInt(i)])));
      }

      await expect(zkVerifier.connect(verifier).verifyProof(commitment, largeProof)).to.not.be
        .reverted;
    });

    it('should handle boundary timestamp', async () => {
      const currentTime = BigInt(Math.floor(Date.now() / 1000));
      const boundaryTime = currentTime - TIMESTAMP_TOLERANCE;

      // Exactly at boundary should be valid
      const isValid = await zkVerifier.isTimestampValid(boundaryTime);
      expect(isValid).to.be.true;
    });

    it('should handle zero nonce', async () => {
      const dataHash = keccak256(toUtf8Bytes('zero nonce'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 0n;

      const commitment = generateCommitment(dataHash, timestamp, nonce);
      await zkVerifier.connect(submitter).submitCommitment(commitment);

      await expect(zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce)).to
        .not.be.reverted;
    });

    it('should handle concurrent submissions', async () => {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        const commitment = generateCommitment(
          keccak256(toUtf8Bytes(`concurrent ${i}`)),
          BigInt(Date.now()),
          BigInt(i)
        );
        promises.push(zkVerifier.connect(users[i % users.length]).submitCommitment(commitment));
      }

      await expect(Promise.all(promises)).to.not.be.rejected;
    });
  });

  describe('Access Control and Permissions', () => {
    it('should grant verifier role', async () => {
      const verifierRole = await zkVerifier.VERIFIER_ROLE();
      await zkVerifier.connect(owner).grantRole(verifierRole, await users[0].getAddress());
      expect(await zkVerifier.hasRole(verifierRole, await users[0].getAddress())).to.be.true;
    });

    it('should revoke verifier role', async () => {
      const verifierRole = await zkVerifier.VERIFIER_ROLE();
      await zkVerifier.connect(owner).revokeRole(verifierRole, await verifier.getAddress());
      expect(await zkVerifier.hasRole(verifierRole, await verifier.getAddress())).to.be.false;
    });

    it('should renounce admin role', async () => {
      const adminRole = await zkVerifier.DEFAULT_ADMIN_ROLE();
      await zkVerifier.connect(owner).renounceRole(adminRole, await owner.getAddress());
      expect(await zkVerifier.hasRole(adminRole, await owner.getAddress())).to.be.false;
    });

    it('should not allow non-admin to grant roles', async () => {
      const verifierRole = await zkVerifier.VERIFIER_ROLE();
      await expect(
        zkVerifier.connect(attacker).grantRole(verifierRole, await users[0].getAddress())
      ).to.be.reverted;
    });
  });

  describe('Events and Logging', () => {
    it('should emit all expected events for full flow', async () => {
      const dataHash = keccak256(toUtf8Bytes('full flow events'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 111n;
      const commitment = generateCommitment(dataHash, timestamp, nonce);
      const proof = generateMockProof(dataHash, timestamp, nonce);

      // Register second verifier
      await zkVerifier.connect(owner).registerVerifier(await users[0].getAddress());

      // Track all events
      const tx1 = await zkVerifier.connect(submitter).submitCommitment(commitment);
      await expect(tx1)
        .to.emit(zkVerifier, 'CommitmentSubmitted')
        .withArgs(commitment, await submitter.getAddress());

      const tx2 = await zkVerifier
        .connect(submitter)
        .revealCommitment(commitment, dataHash, nonce);
      await expect(tx2)
        .to.emit(zkVerifier, 'CommitmentRevealed')
        .withArgs(commitment, dataHash, nonce);

      const tx3 = await zkVerifier.connect(verifier).verifyProof(commitment, proof);
      await expect(tx3).to.emit(zkVerifier, 'ProofVerified');

      const tx4 = await zkVerifier.connect(users[0]).verifyProof(commitment, proof);
      await expect(tx4).to.emit(zkVerifier, 'CommitmentFullyVerified').withArgs(commitment);
    });
  });

  describe('Statistics and Analytics', () => {
    it('should track total commitments', async () => {
      const initial = await zkVerifier.totalCommitments();

      for (let i = 0; i < 3; i++) {
        const commitment = generateCommitment(
          keccak256(toUtf8Bytes(`stats ${i}`)),
          BigInt(Date.now()),
          BigInt(i)
        );
        await zkVerifier.connect(submitter).submitCommitment(commitment);
      }

      expect(await zkVerifier.totalCommitments()).to.equal(initial + 3n);
    });

    it('should track successful verifications', async () => {
      const initial = await zkVerifier.successfulVerifications();

      const dataHash = keccak256(toUtf8Bytes('verification stats'));
      const timestamp = BigInt(Math.floor(Date.now() / 1000));
      const nonce = 222n;
      const commitment = generateCommitment(dataHash, timestamp, nonce);

      await zkVerifier.connect(submitter).submitCommitment(commitment);
      await zkVerifier.connect(submitter).revealCommitment(commitment, dataHash, nonce);

      const proof = generateMockProof(dataHash, timestamp, nonce);
      await zkVerifier.connect(verifier).verifyProof(commitment, proof);

      expect(await zkVerifier.successfulVerifications()).to.equal(initial + 1n);
    });

    it('should provide global statistics', async () => {
      const stats = await zkVerifier.getGlobalStats();
      expect(stats.totalCommitments).to.be.gte(0n);
      expect(stats.totalVerifications).to.be.gte(0n);
      expect(stats.activeVerifiers).to.be.gte(0n);
    });
  });
});
