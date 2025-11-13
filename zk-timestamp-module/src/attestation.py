"""
ZK Timestamp and Data Attestation Module
Provides cryptographic verification of off-chain data feeds
"""

import hashlib
import json
import time
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.backends import default_backend
from eth_abi import encode


@dataclass
class AttestationData:
    """Data structure for attestations"""
    feed_name: str
    value: float
    timestamp: int
    source: str
    signature: str
    commitment_hash: str
    proof_hash: Optional[str] = None


class ZKAttestationEngine:
    """
    ZK-based attestation engine for verifying off-chain data feeds
    Uses ECDSA signatures and Poseidon-like commitment schemes
    """

    def __init__(self):
        self.private_key = ec.generate_private_key(ec.SECP256K1(), default_backend())
        self.public_key = self.private_key.public_key()
        self.attestations: Dict[str, List[AttestationData]] = {}
        self.commitment_registry: Dict[str, str] = {}

    def generate_commitment(self, feed_name: str, value: float, timestamp: int) -> str:
        """
        Generate a cryptographic commitment using Poseidon-like hash
        In production, use actual Poseidon hash for ZK-SNARK compatibility
        """
        data = f"{feed_name}:{value}:{timestamp}"
        commitment = hashlib.sha256(data.encode()).hexdigest()
        return f"0x{commitment}"

    def sign_data(self, data: bytes) -> str:
        """
        Sign data using ECDSA
        """
        signature = self.private_key.sign(
            data,
            ec.ECDSA(hashes.SHA256())
        )
        return signature.hex()

    def verify_signature(self, data: bytes, signature: str, public_key=None) -> bool:
        """
        Verify ECDSA signature
        """
        try:
            key = public_key or self.public_key
            key.verify(
                bytes.fromhex(signature),
                data,
                ec.ECDSA(hashes.SHA256())
            )
            return True
        except Exception as e:
            print(f"Signature verification failed: {e}")
            return False

    def attest_feed(
        self,
        feed_name: str,
        value: float,
        source: str,
        timestamp: Optional[int] = None
    ) -> AttestationData:
        """
        Create an attestation for a data feed

        Args:
            feed_name: Name of the feed (e.g., "ETH/USD")
            value: Feed value
            source: Data source identifier
            timestamp: Unix timestamp (defaults to current time)

        Returns:
            AttestationData with signature and commitment
        """
        if timestamp is None:
            timestamp = int(time.time())

        # Generate commitment
        commitment_hash = self.generate_commitment(feed_name, value, timestamp)

        # Create data to sign
        sign_data = json.dumps({
            "feed_name": feed_name,
            "value": value,
            "timestamp": timestamp,
            "source": source,
            "commitment": commitment_hash
        }, sort_keys=True).encode()

        # Sign the data
        signature = self.sign_data(sign_data)

        # Create attestation
        attestation = AttestationData(
            feed_name=feed_name,
            value=value,
            timestamp=timestamp,
            source=source,
            signature=signature,
            commitment_hash=commitment_hash
        )

        # Store attestation
        if feed_name not in self.attestations:
            self.attestations[feed_name] = []
        self.attestations[feed_name].append(attestation)

        # Register commitment
        self.commitment_registry[commitment_hash] = json.dumps(asdict(attestation))

        return attestation

    def verify_attestation(self, attestation: AttestationData) -> bool:
        """
        Verify an attestation's signature and commitment
        """
        # Verify commitment
        expected_commitment = self.generate_commitment(
            attestation.feed_name,
            attestation.value,
            attestation.timestamp
        )
        if expected_commitment != attestation.commitment_hash:
            print("Commitment verification failed")
            return False

        # Verify signature
        sign_data = json.dumps({
            "feed_name": attestation.feed_name,
            "value": attestation.value,
            "timestamp": attestation.timestamp,
            "source": attestation.source,
            "commitment": attestation.commitment_hash
        }, sort_keys=True).encode()

        if not self.verify_signature(sign_data, attestation.signature):
            print("Signature verification failed")
            return False

        return True

    def generate_zk_proof(self, attestations: List[AttestationData]) -> str:
        """
        Generate a ZK proof for multiple attestations
        This is a simplified version - in production use ZK-SNARKs (e.g., circom + snarkjs)
        """
        proof_data = {
            "attestations": [
                {
                    "feed": a.feed_name,
                    "commitment": a.commitment_hash,
                    "timestamp": a.timestamp
                }
                for a in attestations
            ],
            "count": len(attestations),
            "timestamp": int(time.time())
        }

        proof_bytes = json.dumps(proof_data, sort_keys=True).encode()
        proof_hash = hashlib.sha256(proof_bytes).hexdigest()

        # Sign the proof
        signature = self.sign_data(proof_bytes)

        return json.dumps({
            "proof_hash": f"0x{proof_hash}",
            "signature": signature,
            "public_inputs": proof_data
        })

    def verify_zk_proof(self, proof_json: str) -> bool:
        """
        Verify a ZK proof
        """
        try:
            proof = json.loads(proof_json)
            proof_bytes = json.dumps(proof["public_inputs"], sort_keys=True).encode()

            expected_hash = hashlib.sha256(proof_bytes).hexdigest()
            if f"0x{expected_hash}" != proof["proof_hash"]:
                return False

            return self.verify_signature(proof_bytes, proof["signature"])
        except Exception as e:
            print(f"ZK proof verification failed: {e}")
            return False

    def get_attestation_data_hash(self, attestation: AttestationData) -> str:
        """
        Generate attestData() hash for on-chain verification
        """
        # Encode as would be done in Solidity
        encoded = encode(
            ['string', 'uint256', 'uint256', 'string'],
            [
                attestation.feed_name,
                int(attestation.value * 1e18),  # Convert to wei-like precision
                attestation.timestamp,
                attestation.source
            ]
        )
        return f"0x{hashlib.sha256(encoded).hexdigest()}"

    def batch_attest(
        self,
        feeds: List[Dict[str, any]]
    ) -> Tuple[List[AttestationData], str]:
        """
        Create attestations for multiple feeds and generate a batch ZK proof

        Args:
            feeds: List of feed dictionaries with keys: feed_name, value, source

        Returns:
            Tuple of (attestations list, zk_proof)
        """
        attestations = []
        timestamp = int(time.time())

        for feed in feeds:
            attestation = self.attest_feed(
                feed_name=feed['feed_name'],
                value=feed['value'],
                source=feed['source'],
                timestamp=timestamp
            )
            attestations.append(attestation)

        # Generate batch ZK proof
        zk_proof = self.generate_zk_proof(attestations)

        return attestations, zk_proof

    def get_attestation_history(
        self,
        feed_name: str,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None
    ) -> List[AttestationData]:
        """
        Get attestation history for a feed within a time range
        """
        attestations = self.attestations.get(feed_name, [])

        if start_time is not None:
            attestations = [a for a in attestations if a.timestamp >= start_time]

        if end_time is not None:
            attestations = [a for a in attestations if a.timestamp <= end_time]

        return attestations

    def export_public_key(self) -> str:
        """
        Export public key in PEM format
        """
        pem = self.public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return pem.decode()


# Example usage and CLI
if __name__ == "__main__":
    print("🔐 ZK Attestation Engine Demo\n")

    # Initialize engine
    engine = ZKAttestationEngine()

    # Example 1: Single attestation
    print("Example 1: Single Feed Attestation")
    attestation = engine.attest_feed(
        feed_name="ETH/USD",
        value=2145.67,
        source="chainlink"
    )
    print(f"✓ Attested: {attestation.feed_name} = {attestation.value}")
    print(f"  Commitment: {attestation.commitment_hash[:20]}...")
    print(f"  Signature: {attestation.signature[:20]}...")

    # Verify attestation
    is_valid = engine.verify_attestation(attestation)
    print(f"  Verification: {'✓ VALID' if is_valid else '✗ INVALID'}\n")

    # Example 2: Batch attestation with ZK proof
    print("Example 2: Batch Attestation with ZK Proof")
    feeds = [
        {"feed_name": "BTC/USD", "value": 43250.00, "source": "pyth"},
        {"feed_name": "ETH/USD", "value": 2145.67, "source": "chainlink"},
        {"feed_name": "SOL/USD", "value": 98.50, "source": "redstone"}
    ]

    attestations, zk_proof = engine.batch_attest(feeds)
    print(f"✓ Batch attested {len(attestations)} feeds")

    # Verify ZK proof
    proof_valid = engine.verify_zk_proof(zk_proof)
    print(f"  ZK Proof: {'✓ VALID' if proof_valid else '✗ INVALID'}\n")

    # Example 3: Get attestData() hash for on-chain verification
    print("Example 3: On-chain Verification Hash")
    attest_hash = engine.get_attestation_data_hash(attestations[0])
    print(f"  attestData() hash: {attest_hash[:20]}...\n")

    # Export public key
    print("Example 4: Public Key Export")
    pub_key = engine.export_public_key()
    print(f"  Public Key (PEM):\n{pub_key[:100]}...\n")

    print("✓ All examples completed successfully!")
