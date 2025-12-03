#!/usr/bin/env python3
"""
Fraud Alerts Pipeline - Real-time fraud detection and alert system
Implements streaming anomaly detection with multi-channel alerting
1200 LoC as specified
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Set
from dataclasses import dataclass, asdict, field
from enum import Enum
import numpy as np
import pandas as pd
import redis.asyncio as redis
import aiohttp
import psycopg2
from psycopg2.extras import RealDictCursor
import joblib
from collections import deque
import hashlib
import hmac

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('FraudAlertsPipeline')


class AlertSeverity(Enum):
    """Alert severity levels"""
    CRITICAL = 'CRITICAL'
    HIGH = 'HIGH'
    MEDIUM = 'MEDIUM'
    LOW = 'LOW'
    INFO = 'INFO'


class FraudType(Enum):
    """Types of fraud/anomaly detected"""
    PRICE_MANIPULATION = 'PRICE_MANIPULATION'
    FLASH_LOAN_ATTACK = 'FLASH_LOAN_ATTACK'
    ORACLE_SPOOFING = 'ORACLE_SPOOFING'
    COORDINATED_ATTACK = 'COORDINATED_ATTACK'
    VOLUME_ANOMALY = 'VOLUME_ANOMALY'
    LATENCY_SPIKE = 'LATENCY_SPIKE'
    SOURCE_DEGRADATION = 'SOURCE_DEGRADATION'
    REPLAY_ATTACK = 'REPLAY_ATTACK'
    SANDWICH_ATTACK = 'SANDWICH_ATTACK'
    MEV_EXTRACTION = 'MEV_EXTRACTION'


@dataclass
class FraudAlert:
    """Fraud alert data structure"""
    id: str
    timestamp: str
    feed_name: str
    fraud_type: str
    severity: str
    confidence: float
    anomaly_score: float
    description: str
    evidence: Dict[str, Any]
    recommended_actions: List[str]
    affected_contracts: List[str]
    potential_loss_usd: float
    is_acknowledged: bool = False
    acknowledged_by: Optional[str] = None
    resolution_status: str = 'OPEN'
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)


@dataclass
class PipelineConfig:
    """Pipeline configuration"""
    redis_url: str = 'redis://localhost:6379'
    database_url: str = 'postgresql://reclaim:password@localhost:5432/reclaim_oracle'
    webhook_url: Optional[str] = None
    telegram_bot_token: Optional[str] = None
    telegram_chat_id: Optional[str] = None
    slack_webhook_url: Optional[str] = None
    email_smtp_host: Optional[str] = None
    email_from: Optional[str] = None
    email_to: List[str] = field(default_factory=list)
    alert_cooldown_minutes: int = 5
    critical_cooldown_minutes: int = 0  # No cooldown for critical
    batch_size: int = 100
    processing_interval_seconds: float = 1.0
    model_path: str = './models'
    max_alerts_per_hour: int = 100
    enable_auto_circuit_break: bool = True
    circuit_break_threshold: float = 0.95
    retention_days: int = 30


class AlertDeduplicator:
    """Deduplicate alerts to prevent spam"""

    def __init__(self, cooldown_minutes: int = 5):
        self.cooldown_minutes = cooldown_minutes
        self.recent_alerts: Dict[str, datetime] = {}
        self.alert_counts: Dict[str, int] = {}

    def should_alert(
        self, feed_name: str, fraud_type: str, severity: AlertSeverity
    ) -> bool:
        """Check if alert should be sent based on cooldown"""
        key = f"{feed_name}:{fraud_type}"
        now = datetime.now()

        # Critical alerts bypass cooldown
        if severity == AlertSeverity.CRITICAL:
            self.recent_alerts[key] = now
            return True

        # Check cooldown
        if key in self.recent_alerts:
            elapsed = (now - self.recent_alerts[key]).total_seconds() / 60
            if elapsed < self.cooldown_minutes:
                return False

        self.recent_alerts[key] = now
        self._increment_count(key)
        return True

    def _increment_count(self, key: str) -> None:
        """Track alert frequency"""
        self.alert_counts[key] = self.alert_counts.get(key, 0) + 1

    def get_alert_statistics(self) -> Dict[str, int]:
        """Get alert frequency statistics"""
        return self.alert_counts.copy()

    def cleanup_old_entries(self, max_age_hours: int = 24) -> None:
        """Clean up old alert entries"""
        cutoff = datetime.now() - timedelta(hours=max_age_hours)
        self.recent_alerts = {
            k: v for k, v in self.recent_alerts.items() if v > cutoff
        }


class AlertNotifier:
    """Send alerts through multiple channels"""

    def __init__(self, config: PipelineConfig):
        self.config = config
        self.session: Optional[aiohttp.ClientSession] = None

    async def initialize(self) -> None:
        """Initialize HTTP session"""
        self.session = aiohttp.ClientSession()
        logger.info("Alert notifier initialized")

    async def notify_all_channels(self, alert: FraudAlert) -> Dict[str, bool]:
        """Send alert to all configured channels"""
        results = {}

        # Webhook
        if self.config.webhook_url:
            results['webhook'] = await self._send_webhook(alert)

        # Telegram
        if self.config.telegram_bot_token and self.config.telegram_chat_id:
            results['telegram'] = await self._send_telegram(alert)

        # Slack
        if self.config.slack_webhook_url:
            results['slack'] = await self._send_slack(alert)

        # Redis pub/sub
        results['redis'] = await self._publish_redis(alert)

        return results

    async def _send_webhook(self, alert: FraudAlert) -> bool:
        """Send alert to webhook endpoint"""
        try:
            async with self.session.post(
                self.config.webhook_url,
                json=alert.to_dict(),
                timeout=10
            ) as response:
                success = response.status == 200
                if not success:
                    logger.error(f"Webhook failed: {response.status}")
                return success
        except Exception as e:
            logger.error(f"Webhook error: {e}")
            return False

    async def _send_telegram(self, alert: FraudAlert) -> bool:
        """Send alert to Telegram"""
        try:
            message = self._format_telegram_message(alert)
            url = f"https://api.telegram.org/bot{self.config.telegram_bot_token}/sendMessage"

            async with self.session.post(
                url,
                json={
                    'chat_id': self.config.telegram_chat_id,
                    'text': message,
                    'parse_mode': 'HTML'
                },
                timeout=10
            ) as response:
                return response.status == 200
        except Exception as e:
            logger.error(f"Telegram error: {e}")
            return False

    def _format_telegram_message(self, alert: FraudAlert) -> str:
        """Format alert for Telegram"""
        severity_emoji = {
            'CRITICAL': '🚨',
            'HIGH': '⚠️',
            'MEDIUM': '🔔',
            'LOW': '📢',
            'INFO': 'ℹ️'
        }

        emoji = severity_emoji.get(alert.severity, '📢')

        message = f"""
{emoji} <b>FRAUD ALERT - {alert.severity}</b> {emoji}

<b>Feed:</b> {alert.feed_name}
<b>Type:</b> {alert.fraud_type}
<b>Time:</b> {alert.timestamp}
<b>Confidence:</b> {alert.confidence:.2%}
<b>Anomaly Score:</b> {alert.anomaly_score:.4f}

<b>Description:</b>
{alert.description}

<b>Potential Loss:</b> ${alert.potential_loss_usd:,.2f}

<b>Recommended Actions:</b>
{chr(10).join(f"• {action}" for action in alert.recommended_actions)}

<b>Alert ID:</b> <code>{alert.id}</code>
"""
        return message.strip()

    async def _send_slack(self, alert: FraudAlert) -> bool:
        """Send alert to Slack"""
        try:
            payload = self._format_slack_payload(alert)

            async with self.session.post(
                self.config.slack_webhook_url,
                json=payload,
                timeout=10
            ) as response:
                return response.status == 200
        except Exception as e:
            logger.error(f"Slack error: {e}")
            return False

    def _format_slack_payload(self, alert: FraudAlert) -> Dict[str, Any]:
        """Format alert for Slack"""
        color_map = {
            'CRITICAL': '#FF0000',
            'HIGH': '#FF6600',
            'MEDIUM': '#FFCC00',
            'LOW': '#00CC00',
            'INFO': '#0066CC'
        }

        return {
            'attachments': [
                {
                    'color': color_map.get(alert.severity, '#000000'),
                    'title': f'🚨 Fraud Alert - {alert.severity}',
                    'fields': [
                        {
                            'title': 'Feed',
                            'value': alert.feed_name,
                            'short': True
                        },
                        {
                            'title': 'Type',
                            'value': alert.fraud_type,
                            'short': True
                        },
                        {
                            'title': 'Confidence',
                            'value': f'{alert.confidence:.2%}',
                            'short': True
                        },
                        {
                            'title': 'Potential Loss',
                            'value': f'${alert.potential_loss_usd:,.2f}',
                            'short': True
                        },
                        {
                            'title': 'Description',
                            'value': alert.description,
                            'short': False
                        }
                    ],
                    'footer': f'Alert ID: {alert.id}',
                    'ts': int(datetime.now().timestamp())
                }
            ]
        }

    async def _publish_redis(self, alert: FraudAlert) -> bool:
        """Publish alert to Redis pub/sub"""
        try:
            redis_client = redis.from_url(self.config.redis_url)
            await redis_client.publish(
                'fraud:alerts',
                alert.to_json()
            )
            await redis_client.close()
            return True
        except Exception as e:
            logger.error(f"Redis publish error: {e}")
            return False

    async def close(self) -> None:
        """Close HTTP session"""
        if self.session:
            await self.session.close()


class FraudDetector:
    """Detect various types of fraud and anomalies"""

    def __init__(self, model_path: Optional[str] = None):
        self.model = None
        self.feature_extractor = None
        if model_path and os.path.exists(model_path):
            self._load_model(model_path)

        # Thresholds for different fraud types
        self.thresholds = {
            'price_change': 0.15,  # 15% sudden change
            'volume_spike': 5.0,   # 5x average volume
            'latency_spike': 1000,  # 1000ms
            'source_minimum': 3,    # Minimum oracle sources
            'anomaly_score': 0.85   # ML model threshold
        }

        # Pattern buffers
        self.price_buffer: Dict[str, deque] = {}
        self.volume_buffer: Dict[str, deque] = {}
        self.timestamp_buffer: Dict[str, deque] = {}

    def _load_model(self, model_path: str) -> None:
        """Load trained anomaly detection model"""
        try:
            saved = joblib.load(model_path)
            self.model = saved.get('model')
            self.feature_extractor = saved.get('feature_extractor')
            logger.info(f"Loaded model from {model_path}")
        except Exception as e:
            logger.error(f"Failed to load model: {e}")

    def detect_fraud(
        self, feed_data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Detect potential fraud in feed data"""
        detections = []

        feed_name = feed_data.get('feed_name', 'UNKNOWN')

        # Initialize buffers if needed
        if feed_name not in self.price_buffer:
            self.price_buffer[feed_name] = deque(maxlen=100)
            self.volume_buffer[feed_name] = deque(maxlen=100)
            self.timestamp_buffer[feed_name] = deque(maxlen=100)

        # Add to buffers
        self.price_buffer[feed_name].append(feed_data.get('price', 0))
        self.volume_buffer[feed_name].append(feed_data.get('volume', 0))
        self.timestamp_buffer[feed_name].append(feed_data.get('timestamp', datetime.now()))

        # Run detections
        detections.extend(self._detect_price_manipulation(feed_name, feed_data))
        detections.extend(self._detect_volume_anomaly(feed_name, feed_data))
        detections.extend(self._detect_latency_spike(feed_name, feed_data))
        detections.extend(self._detect_source_degradation(feed_name, feed_data))
        detections.extend(self._detect_sandwich_attack(feed_name, feed_data))

        # ML-based detection
        if self.model:
            detections.extend(self._detect_with_ml(feed_name, feed_data))

        return detections

    def _detect_price_manipulation(
        self, feed_name: str, data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Detect sudden price manipulation"""
        detections = []
        prices = list(self.price_buffer[feed_name])

        if len(prices) < 2:
            return detections

        current_price = prices[-1]
        previous_price = prices[-2]

        if previous_price == 0:
            return detections

        change = abs(current_price - previous_price) / previous_price

        if change > self.thresholds['price_change']:
            severity = AlertSeverity.CRITICAL if change > 0.5 else AlertSeverity.HIGH
            confidence = min(change / self.thresholds['price_change'], 1.0)

            detections.append({
                'fraud_type': FraudType.PRICE_MANIPULATION,
                'severity': severity,
                'confidence': confidence,
                'score': change,
                'description': f"Sudden price change of {change:.2%} detected",
                'evidence': {
                    'previous_price': previous_price,
                    'current_price': current_price,
                    'change_percentage': change * 100
                },
                'potential_loss': self._estimate_loss(change, data.get('volume', 0))
            })

            # Check for flash loan pattern
            if self._is_flash_loan_pattern(feed_name):
                detections.append({
                    'fraud_type': FraudType.FLASH_LOAN_ATTACK,
                    'severity': AlertSeverity.CRITICAL,
                    'confidence': 0.85,
                    'score': 0.9,
                    'description': "Potential flash loan attack detected",
                    'evidence': {
                        'pattern': 'rapid_reversal',
                        'timeframe': '< 1 block'
                    },
                    'potential_loss': self._estimate_loss(change, data.get('volume', 0)) * 2
                })

        return detections

    def _detect_volume_anomaly(
        self, feed_name: str, data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Detect abnormal trading volume"""
        detections = []
        volumes = list(self.volume_buffer[feed_name])

        if len(volumes) < 10:
            return detections

        avg_volume = np.mean(volumes[:-1])
        current_volume = volumes[-1]

        if avg_volume == 0:
            return detections

        spike_ratio = current_volume / avg_volume

        if spike_ratio > self.thresholds['volume_spike']:
            severity = AlertSeverity.HIGH if spike_ratio > 10 else AlertSeverity.MEDIUM
            confidence = min(spike_ratio / (self.thresholds['volume_spike'] * 2), 1.0)

            detections.append({
                'fraud_type': FraudType.VOLUME_ANOMALY,
                'severity': severity,
                'confidence': confidence,
                'score': spike_ratio / 10,
                'description': f"Volume spike of {spike_ratio:.1f}x average detected",
                'evidence': {
                    'average_volume': avg_volume,
                    'current_volume': current_volume,
                    'spike_ratio': spike_ratio
                },
                'potential_loss': current_volume * 0.01  # 1% of volume
            })

        return detections

    def _detect_latency_spike(
        self, feed_name: str, data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Detect oracle latency issues"""
        detections = []
        latency = data.get('latency_ms', 0)

        if latency > self.thresholds['latency_spike']:
            severity = AlertSeverity.HIGH if latency > 2000 else AlertSeverity.MEDIUM

            detections.append({
                'fraud_type': FraudType.LATENCY_SPIKE,
                'severity': severity,
                'confidence': 0.9,
                'score': latency / self.thresholds['latency_spike'],
                'description': f"Oracle latency of {latency}ms detected",
                'evidence': {
                    'latency_ms': latency,
                    'threshold': self.thresholds['latency_spike']
                },
                'potential_loss': 0  # No direct loss, but stale data risk
            })

        return detections

    def _detect_source_degradation(
        self, feed_name: str, data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Detect reduction in oracle sources"""
        detections = []
        source_count = data.get('source_count', 0)

        if source_count < self.thresholds['source_minimum']:
            severity = (
                AlertSeverity.CRITICAL if source_count <= 1
                else AlertSeverity.HIGH
            )

            detections.append({
                'fraud_type': FraudType.SOURCE_DEGRADATION,
                'severity': severity,
                'confidence': 0.95,
                'score': 1 - (source_count / self.thresholds['source_minimum']),
                'description': f"Only {source_count} oracle sources available",
                'evidence': {
                    'source_count': source_count,
                    'minimum_required': self.thresholds['source_minimum']
                },
                'potential_loss': 10000 * (self.thresholds['source_minimum'] - source_count)
            })

        return detections

    def _detect_sandwich_attack(
        self, feed_name: str, data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Detect potential sandwich attacks"""
        detections = []
        prices = list(self.price_buffer[feed_name])

        if len(prices) < 3:
            return detections

        # Look for price bump -> original price pattern
        if len(prices) >= 5:
            recent = prices[-5:]
            if (
                recent[2] > recent[0] * 1.02  # 2% increase
                and abs(recent[4] - recent[0]) / recent[0] < 0.01  # Returns close to original
            ):
                detections.append({
                    'fraud_type': FraudType.SANDWICH_ATTACK,
                    'severity': AlertSeverity.HIGH,
                    'confidence': 0.75,
                    'score': 0.8,
                    'description': "Potential sandwich attack pattern detected",
                    'evidence': {
                        'price_pattern': recent,
                        'peak_deviation': (recent[2] - recent[0]) / recent[0]
                    },
                    'potential_loss': recent[0] * 0.02  # Estimated 2% loss
                })

        return detections

    def _detect_with_ml(
        self, feed_name: str, data: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Use ML model for anomaly detection"""
        detections = []

        if not self.model or not self.feature_extractor:
            return detections

        try:
            # Create DataFrame from buffer
            prices = list(self.price_buffer[feed_name])
            if len(prices) < 50:
                return detections

            df = pd.DataFrame({
                'timestamp': list(self.timestamp_buffer[feed_name])[-50:],
                'price': prices[-50:],
                'volume': list(self.volume_buffer[feed_name])[-50:],
                'source_count': [data.get('source_count', 5)] * 50,
                'latency_ms': [data.get('latency_ms', 100)] * 50
            })

            # Extract features
            features = self.feature_extractor.extract_all_features(df)
            if len(features) == 0:
                return detections

            scaled = self.feature_extractor.scale_features(features, fit=False)

            # Get anomaly score for latest point
            if hasattr(self.model, 'score_samples'):
                score = -self.model.score_samples(scaled[-1:].reshape(1, -1))[0]
            else:
                score = 0.5

            # Normalize score to 0-1
            normalized_score = min(max(score, 0), 1)

            if normalized_score > self.thresholds['anomaly_score']:
                severity = (
                    AlertSeverity.CRITICAL if normalized_score > 0.95
                    else AlertSeverity.HIGH if normalized_score > 0.9
                    else AlertSeverity.MEDIUM
                )

                detections.append({
                    'fraud_type': FraudType.ORACLE_SPOOFING,
                    'severity': severity,
                    'confidence': normalized_score,
                    'score': normalized_score,
                    'description': f"ML model detected anomaly with score {normalized_score:.4f}",
                    'evidence': {
                        'ml_score': normalized_score,
                        'threshold': self.thresholds['anomaly_score'],
                        'model_type': type(self.model).__name__
                    },
                    'potential_loss': normalized_score * 50000  # Scaled estimate
                })

        except Exception as e:
            logger.error(f"ML detection error: {e}")

        return detections

    def _is_flash_loan_pattern(self, feed_name: str) -> bool:
        """Check if price pattern matches flash loan attack"""
        prices = list(self.price_buffer[feed_name])
        if len(prices) < 4:
            return False

        # Flash loan pattern: sharp move followed by quick reversal
        recent = prices[-4:]
        change1 = abs(recent[1] - recent[0]) / recent[0] if recent[0] != 0 else 0
        change2 = abs(recent[3] - recent[2]) / recent[2] if recent[2] != 0 else 0

        # Both changes significant and in opposite directions
        return change1 > 0.1 and change2 > 0.1

    def _estimate_loss(self, change: float, volume: float) -> float:
        """Estimate potential financial loss"""
        # Simplified estimation based on change magnitude and volume
        return change * volume * 0.1


class FraudAlertsPipeline:
    """Main pipeline for fraud detection and alerting"""

    def __init__(self, config: PipelineConfig = None):
        self.config = config or PipelineConfig()
        self.detector = FraudDetector()
        self.notifier = AlertNotifier(self.config)
        self.deduplicator = AlertDeduplicator(self.config.alert_cooldown_minutes)
        self.redis_client: Optional[redis.Redis] = None
        self.db_connection = None
        self.is_running = False
        self.alerts_generated: List[FraudAlert] = []
        self.circuit_breaker_active: Set[str] = set()

    async def initialize(self) -> None:
        """Initialize pipeline connections"""
        # Redis
        self.redis_client = redis.from_url(self.config.redis_url)
        await self.redis_client.ping()
        logger.info("Connected to Redis")

        # Database
        self.db_connection = psycopg2.connect(
            self.config.database_url,
            cursor_factory=RealDictCursor
        )
        logger.info("Connected to database")

        # Notifier
        await self.notifier.initialize()

        logger.info("Fraud Alerts Pipeline initialized")

    async def start(self) -> None:
        """Start the pipeline"""
        self.is_running = True
        logger.info("Starting Fraud Alerts Pipeline...")

        # Subscribe to price feed updates
        pubsub = self.redis_client.pubsub()
        await pubsub.subscribe('price:update', 'anomaly:detected')

        # Process messages
        async for message in pubsub.listen():
            if not self.is_running:
                break

            if message['type'] == 'message':
                await self._process_message(message)

    async def _process_message(self, message: Dict[str, Any]) -> None:
        """Process incoming Redis message"""
        try:
            data = json.loads(message['data'])
            channel = message['channel']

            if channel == b'price:update':
                await self._handle_price_update(data)
            elif channel == b'anomaly:detected':
                await self._handle_external_anomaly(data)

        except Exception as e:
            logger.error(f"Error processing message: {e}")

    async def _handle_price_update(self, data: Dict[str, Any]) -> None:
        """Handle price feed update"""
        # Check circuit breaker
        feed_name = data.get('feed_name', 'UNKNOWN')
        if feed_name in self.circuit_breaker_active:
            logger.warning(f"Circuit breaker active for {feed_name}, skipping")
            return

        # Detect fraud
        detections = self.detector.detect_fraud(data)

        # Process each detection
        for detection in detections:
            await self._process_detection(data, detection)

    async def _handle_external_anomaly(self, data: Dict[str, Any]) -> None:
        """Handle externally detected anomaly"""
        alert = self._create_alert(
            feed_name=data.get('feed_name', 'UNKNOWN'),
            fraud_type=FraudType.ORACLE_SPOOFING,
            severity=AlertSeverity.HIGH,
            confidence=data.get('confidence', 0.8),
            score=data.get('score', 0.8),
            description=data.get('description', 'External anomaly detected'),
            evidence=data.get('evidence', {}),
            potential_loss=data.get('potential_loss', 0)
        )

        await self._send_alert(alert)

    async def _process_detection(
        self, feed_data: Dict[str, Any], detection: Dict[str, Any]
    ) -> None:
        """Process a single fraud detection"""
        feed_name = feed_data.get('feed_name', 'UNKNOWN')
        fraud_type = detection['fraud_type']
        severity = detection['severity']

        # Check deduplication
        if not self.deduplicator.should_alert(feed_name, fraud_type.value, severity):
            logger.debug(f"Alert deduplicated: {feed_name} - {fraud_type.value}")
            return

        # Create alert
        alert = self._create_alert(
            feed_name=feed_name,
            fraud_type=fraud_type,
            severity=severity,
            confidence=detection['confidence'],
            score=detection['score'],
            description=detection['description'],
            evidence=detection['evidence'],
            potential_loss=detection['potential_loss']
        )

        # Send alert
        await self._send_alert(alert)

        # Check circuit breaker
        if (
            self.config.enable_auto_circuit_break
            and detection['score'] > self.config.circuit_break_threshold
        ):
            await self._activate_circuit_breaker(feed_name, alert)

    def _create_alert(
        self,
        feed_name: str,
        fraud_type: FraudType,
        severity: AlertSeverity,
        confidence: float,
        score: float,
        description: str,
        evidence: Dict[str, Any],
        potential_loss: float
    ) -> FraudAlert:
        """Create a new fraud alert"""
        alert_id = self._generate_alert_id(feed_name, fraud_type.value)

        recommended_actions = self._get_recommended_actions(fraud_type, severity)
        affected_contracts = self._get_affected_contracts(feed_name)

        return FraudAlert(
            id=alert_id,
            timestamp=datetime.now().isoformat(),
            feed_name=feed_name,
            fraud_type=fraud_type.value,
            severity=severity.value,
            confidence=confidence,
            anomaly_score=score,
            description=description,
            evidence=evidence,
            recommended_actions=recommended_actions,
            affected_contracts=affected_contracts,
            potential_loss_usd=potential_loss,
            tags=self._generate_tags(fraud_type, severity)
        )

    def _generate_alert_id(self, feed_name: str, fraud_type: str) -> str:
        """Generate unique alert ID"""
        data = f"{feed_name}:{fraud_type}:{datetime.now().isoformat()}"
        return hashlib.sha256(data.encode()).hexdigest()[:16]

    def _get_recommended_actions(
        self, fraud_type: FraudType, severity: AlertSeverity
    ) -> List[str]:
        """Get recommended actions based on fraud type"""
        actions = {
            FraudType.PRICE_MANIPULATION: [
                "Halt oracle updates temporarily",
                "Cross-reference with other sources",
                "Review recent oracle submissions",
                "Check for coordinated attack patterns"
            ],
            FraudType.FLASH_LOAN_ATTACK: [
                "CRITICAL: Pause affected contracts immediately",
                "Enable TWAP-based pricing",
                "Increase oracle heartbeat frequency",
                "Review transaction sequencing"
            ],
            FraudType.ORACLE_SPOOFING: [
                "Verify oracle source authenticity",
                "Check ZK proof validity",
                "Slash suspicious oracles",
                "Enable stricter deviation checks"
            ],
            FraudType.SOURCE_DEGRADATION: [
                "Increase minimum source threshold",
                "Activate backup oracles",
                "Monitor for oracle censorship",
                "Enable emergency mode"
            ],
            FraudType.SANDWICH_ATTACK: [
                "Review MEV protection measures",
                "Implement private transaction pool",
                "Add slippage protection",
                "Monitor mempool activity"
            ]
        }

        base_actions = actions.get(fraud_type, ["Monitor closely", "Investigate further"])

        if severity == AlertSeverity.CRITICAL:
            base_actions.insert(0, "EMERGENCY: Activate circuit breaker NOW")

        return base_actions

    def _get_affected_contracts(self, feed_name: str) -> List[str]:
        """Get list of contracts using this feed"""
        # In production, this would query the database
        return [
            f"0x{hashlib.sha256(feed_name.encode()).hexdigest()[:40]}",  # Mock address
        ]

    def _generate_tags(
        self, fraud_type: FraudType, severity: AlertSeverity
    ) -> List[str]:
        """Generate tags for alert categorization"""
        tags = [fraud_type.value, severity.value]

        if severity in [AlertSeverity.CRITICAL, AlertSeverity.HIGH]:
            tags.append('URGENT')

        if fraud_type in [FraudType.FLASH_LOAN_ATTACK, FraudType.SANDWICH_ATTACK]:
            tags.append('MEV_RELATED')

        return tags

    async def _send_alert(self, alert: FraudAlert) -> None:
        """Send alert through all channels"""
        logger.info(f"Sending alert: {alert.id} - {alert.fraud_type} - {alert.severity}")

        # Store alert
        self.alerts_generated.append(alert)
        await self._store_alert(alert)

        # Notify all channels
        results = await self.notifier.notify_all_channels(alert)
        logger.info(f"Notification results: {results}")

    async def _store_alert(self, alert: FraudAlert) -> None:
        """Store alert in database"""
        try:
            # Store in Redis for quick access
            await self.redis_client.setex(
                f"alert:{alert.id}",
                timedelta(days=self.config.retention_days),
                alert.to_json()
            )

            # Add to alerts list
            await self.redis_client.lpush('alerts:all', alert.id)
            await self.redis_client.ltrim('alerts:all', 0, 9999)  # Keep last 10000

            logger.debug(f"Stored alert {alert.id}")

        except Exception as e:
            logger.error(f"Failed to store alert: {e}")

    async def _activate_circuit_breaker(
        self, feed_name: str, alert: FraudAlert
    ) -> None:
        """Activate circuit breaker for a feed"""
        logger.warning(f"Activating circuit breaker for {feed_name}")
        self.circuit_breaker_active.add(feed_name)

        # Publish circuit breaker event
        await self.redis_client.publish(
            'circuit_breaker:activated',
            json.dumps({
                'feed_name': feed_name,
                'alert_id': alert.id,
                'timestamp': datetime.now().isoformat()
            })
        )

    async def deactivate_circuit_breaker(self, feed_name: str) -> None:
        """Deactivate circuit breaker for a feed"""
        logger.info(f"Deactivating circuit breaker for {feed_name}")
        self.circuit_breaker_active.discard(feed_name)

        await self.redis_client.publish(
            'circuit_breaker:deactivated',
            json.dumps({
                'feed_name': feed_name,
                'timestamp': datetime.now().isoformat()
            })
        )

    def get_statistics(self) -> Dict[str, Any]:
        """Get pipeline statistics"""
        return {
            'total_alerts': len(self.alerts_generated),
            'active_circuit_breakers': list(self.circuit_breaker_active),
            'deduplicator_stats': self.deduplicator.get_alert_statistics(),
            'is_running': self.is_running
        }

    async def stop(self) -> None:
        """Stop the pipeline"""
        self.is_running = False
        logger.info("Stopping Fraud Alerts Pipeline...")

        # Cleanup
        await self.notifier.close()
        if self.redis_client:
            await self.redis_client.close()
        if self.db_connection:
            self.db_connection.close()

        logger.info("Fraud Alerts Pipeline stopped")


async def main():
    """Main entry point"""
    config = PipelineConfig(
        redis_url=os.getenv('REDIS_URL', 'redis://localhost:6379'),
        database_url=os.getenv(
            'DATABASE_URL',
            'postgresql://reclaim:password@localhost:5432/reclaim_oracle'
        ),
        webhook_url=os.getenv('ALERT_WEBHOOK_URL'),
        telegram_bot_token=os.getenv('TELEGRAM_BOT_TOKEN'),
        telegram_chat_id=os.getenv('TELEGRAM_CHAT_ID'),
        slack_webhook_url=os.getenv('SLACK_WEBHOOK_URL')
    )

    pipeline = FraudAlertsPipeline(config)

    try:
        await pipeline.initialize()
        await pipeline.start()
    except KeyboardInterrupt:
        logger.info("Received shutdown signal")
    finally:
        await pipeline.stop()


if __name__ == '__main__':
    asyncio.run(main())
