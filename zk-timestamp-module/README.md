# ZK Timestamp & Data Attestation Module

Cryptographic verification layer for off-chain data feeds using digital signatures and zero-knowledge proofs.

## Features

- **ECDSA Signatures**: Secure signing of data feeds
- **Commitment Scheme**: Poseidon-like hash commitments for ZK compatibility
- **ZK Proof Generation**: Batch proofs for multiple attestations
- **On-chain Verification**: Generate hashes compatible with smart contracts
- **Attestation Registry**: Historical tracking of all attestations

## Installation

```bash
pip install -r requirements.txt
```

## Usage

### Basic Attestation

```python
from zk_timestamp_module.src.attestation import ZKAttestationEngine

# Initialize engine
engine = ZKAttestationEngine()

# Attest a data feed
attestation = engine.attest_feed(
    feed_name="ETH/USD",
    value=2145.67,
    source="chainlink"
)

# Verify attestation
is_valid = engine.verify_attestation(attestation)
print(f"Valid: {is_valid}")
```

### Batch Attestation with ZK Proof

```python
# Batch attest multiple feeds
feeds = [
    {"feed_name": "BTC/USD", "value": 43250.00, "source": "pyth"},
    {"feed_name": "ETH/USD", "value": 2145.67, "source": "chainlink"}
]

attestations, zk_proof = engine.batch_attest(feeds)

# Verify the ZK proof
proof_valid = engine.verify_zk_proof(zk_proof)
```

### On-chain Verification

```python
# Generate hash for smart contract verification
attest_hash = engine.get_attestation_data_hash(attestation)

# This hash can be verified on-chain with:
# function verifyAttestation(bytes32 attestHash, bytes signature) public view returns (bool)
```

## Attestation Data Structure

```python
@dataclass
class AttestationData:
    feed_name: str          # Feed identifier (e.g., "ETH/USD")
    value: float            # Feed value
    timestamp: int          # Unix timestamp
    source: str             # Data source identifier
    signature: str          # ECDSA signature (hex)
    commitment_hash: str    # Cryptographic commitment
    proof_hash: str         # Optional ZK proof hash
```

## API Reference

### `attest_feed(feed_name, value, source, timestamp=None)`

Create a cryptographically signed attestation for a data feed.

**Returns:** AttestationData

### `verify_attestation(attestation)`

Verify the signature and commitment of an attestation.

**Returns:** bool

### `batch_attest(feeds)`

Create multiple attestations and generate a batch ZK proof.

**Returns:** Tuple[List[AttestationData], str]

### `generate_zk_proof(attestations)`

Generate a zero-knowledge proof for attestations.

**Returns:** str (JSON proof)

### `get_attestation_data_hash(attestation)`

Generate attestData() hash for on-chain verification.

**Returns:** str (hex hash)

## Smart Contract Integration

Example Solidity interface:

```solidity
interface IAttestationVerifier {
    function verifyAttestation(
        string memory feedName,
        uint256 value,
        uint256 timestamp,
        string memory source,
        bytes memory signature
    ) external view returns (bool);

    function verifyBatchProof(
        bytes32 proofHash,
        bytes memory zkProof
    ) external view returns (bool);
}
```

## Security Considerations

1. **Key Management**: Private keys should be stored in secure enclaves (HSM, KMS)
2. **Timestamp Tolerance**: Implement tolerance windows for timestamp verification
3. **Signature Rotation**: Regularly rotate signing keys
4. **Proof Validation**: Always verify ZK proofs before accepting attestations

## ZK Circuit (Production)

For production ZK-SNARKs, use circom:

```circom
template AttestationCircuit() {
    signal input feedName;
    signal input value;
    signal input timestamp;
    signal output commitmentHash;

    component hasher = Poseidon(3);
    hasher.inputs[0] <== feedName;
    hasher.inputs[1] <== value;
    hasher.inputs[2] <== timestamp;

    commitmentHash <== hasher.out;
}
```

## Testing

```bash
python zk-timestamp-module/src/attestation.py
```

## License

MIT
