"""
AI-Powered Anomaly Detection for Oracle Feeds
Uses machine learning to detect outliers and predict anomalies in price feeds
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.covariance import EllipticEnvelope
import json
import time
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass, asdict
from collections import deque
import warnings
warnings.filterwarnings('ignore')


@dataclass
class AnomalyAlert:
    """Alert structure for detected anomalies"""
    timestamp: int
    feed_name: str
    value: float
    expected_range: Tuple[float, float]
    anomaly_score: float
    severity: str  # 'low', 'medium', 'high', 'critical'
    recommendation: str
    features: Dict[str, float]


class MLAnomalyDetector:
    """
    Machine learning-based anomaly detector for oracle feeds
    Supports multiple detection algorithms and real-time monitoring
    """

    def __init__(self, config: Dict = None):
        self.config = config or {
            'anomaly_threshold': 0.85,
            'model_type': 'IsolationForest',
            'training_interval': 24 * 3600,  # 24 hours
            'features': ['price', 'volume', 'volatility', 'liquidity'],
            'window_size': 100
        }

        # Initialize models
        self.models: Dict[str, any] = {}
        self.scalers: Dict[str, StandardScaler] = {}

        # Historical data buffers
        self.price_history: Dict[str, deque] = {}
        self.feature_history: Dict[str, deque] = {}

        # Training tracking
        self.last_training: Dict[str, int] = {}
        self.model_metrics: Dict[str, Dict] = {}

        # Anomaly tracking
        self.alerts: List[AnomalyAlert] = []
        self.anomaly_count: Dict[str, int] = {}

        print("✓ ML Anomaly Detector initialized")

    def initialize_feed(self, feed_name: str):
        """Initialize tracking for a new feed"""
        if feed_name not in self.models:
            # Create model based on config
            if self.config['model_type'] == 'IsolationForest':
                self.models[feed_name] = IsolationForest(
                    contamination=0.1,
                    random_state=42,
                    n_estimators=100
                )
            elif self.config['model_type'] == 'EllipticEnvelope':
                self.models[feed_name] = EllipticEnvelope(
                    contamination=0.1,
                    random_state=42
                )

            self.scalers[feed_name] = StandardScaler()
            self.price_history[feed_name] = deque(maxlen=self.config['window_size'])
            self.feature_history[feed_name] = deque(maxlen=self.config['window_size'])
            self.last_training[feed_name] = 0
            self.anomaly_count[feed_name] = 0

            print(f"✓ Initialized feed: {feed_name}")

    def extract_features(
        self,
        feed_name: str,
        price: float,
        volume: float = None,
        timestamp: int = None
    ) -> Dict[str, float]:
        """
        Extract features from price data for anomaly detection

        Features:
        - Price change rate
        - Volatility (rolling std)
        - Price momentum
        - Volume spike (if available)
        - Time-based patterns
        """
        if timestamp is None:
            timestamp = int(time.time())

        history = self.price_history.get(feed_name, deque())

        features = {
            'price': price,
            'volume': volume or 0,
            'timestamp': timestamp
        }

        if len(history) > 0:
            # Price change rate
            prev_price = history[-1]
            features['price_change'] = (price - prev_price) / prev_price if prev_price > 0 else 0

            # Volatility (last N periods)
            if len(history) >= 10:
                recent_prices = list(history)[-10:]
                features['volatility'] = np.std(recent_prices) / np.mean(recent_prices)
            else:
                features['volatility'] = 0

            # Momentum (rate of change of change)
            if len(history) >= 2:
                prev_change = (history[-1] - history[-2]) / history[-2] if history[-2] > 0 else 0
                features['momentum'] = features['price_change'] - prev_change
            else:
                features['momentum'] = 0

            # Z-score (distance from mean)
            if len(history) >= 20:
                mean = np.mean(history)
                std = np.std(history)
                features['z_score'] = (price - mean) / std if std > 0 else 0
            else:
                features['z_score'] = 0

        else:
            # First data point
            features['price_change'] = 0
            features['volatility'] = 0
            features['momentum'] = 0
            features['z_score'] = 0

        # Hour of day (cyclical encoding)
        hour = (timestamp % 86400) / 3600
        features['hour_sin'] = np.sin(2 * np.pi * hour / 24)
        features['hour_cos'] = np.cos(2 * np.pi * hour / 24)

        return features

    def train_model(self, feed_name: str):
        """
        Train or retrain the anomaly detection model
        """
        if feed_name not in self.feature_history:
            return

        feature_data = list(self.feature_history[feed_name])

        if len(feature_data) < 50:  # Need minimum data points
            print(f"⚠ Not enough data to train {feed_name} ({len(feature_data)}/50)")
            return

        # Convert to numpy array
        X = np.array([
            [
                f['price'],
                f['price_change'],
                f['volatility'],
                f['momentum'],
                f['z_score'],
                f['hour_sin'],
                f['hour_cos']
            ]
            for f in feature_data
        ])

        # Scale features
        X_scaled = self.scalers[feed_name].fit_transform(X)

        # Train model
        self.models[feed_name].fit(X_scaled)

        # Calculate metrics
        predictions = self.models[feed_name].predict(X_scaled)
        anomalies = np.sum(predictions == -1)

        self.model_metrics[feed_name] = {
            'training_samples': len(X),
            'detected_anomalies': int(anomalies),
            'anomaly_rate': float(anomalies / len(X)),
            'last_trained': int(time.time())
        }

        self.last_training[feed_name] = int(time.time())

        print(f"✓ Trained model for {feed_name}")
        print(f"  Samples: {len(X)}, Anomalies: {anomalies} ({anomalies/len(X)*100:.2f}%)")

    def detect_anomaly(
        self,
        feed_name: str,
        price: float,
        volume: float = None,
        timestamp: int = None
    ) -> Tuple[bool, AnomalyAlert]:
        """
        Detect if a price point is anomalous

        Returns:
            Tuple of (is_anomaly, alert)
        """
        if timestamp is None:
            timestamp = int(time.time())

        # Initialize feed if needed
        if feed_name not in self.models:
            self.initialize_feed(feed_name)

        # Extract features
        features = self.extract_features(feed_name, price, volume, timestamp)

        # Update history
        self.price_history[feed_name].append(price)
        self.feature_history[feed_name].append(features)

        # Check if we need to train/retrain
        if (timestamp - self.last_training.get(feed_name, 0) > self.config['training_interval']
            or len(self.feature_history[feed_name]) == self.config['window_size']):
            self.train_model(feed_name)

        # If model not trained yet, use simple threshold
        if feed_name not in self.model_metrics:
            history = list(self.price_history[feed_name])
            if len(history) >= 20:
                mean = np.mean(history[:-1])  # Exclude current price
                std = np.std(history[:-1])
                z_score = abs((price - mean) / std) if std > 0 else 0

                is_anomaly = z_score > 3  # 3-sigma rule

                alert = AnomalyAlert(
                    timestamp=timestamp,
                    feed_name=feed_name,
                    value=price,
                    expected_range=(mean - 3*std, mean + 3*std),
                    anomaly_score=min(z_score / 3, 1.0),
                    severity=self._get_severity(z_score / 3),
                    recommendation="Model not trained yet. Using statistical threshold.",
                    features=features
                )

                if is_anomaly:
                    self.alerts.append(alert)
                    self.anomaly_count[feed_name] = self.anomaly_count.get(feed_name, 0) + 1

                return is_anomaly, alert
            else:
                # Not enough data
                return False, None

        # Use ML model
        X = np.array([[
            features['price'],
            features['price_change'],
            features['volatility'],
            features['momentum'],
            features['z_score'],
            features['hour_sin'],
            features['hour_cos']
        ]])

        X_scaled = self.scalers[feed_name].transform(X)
        prediction = self.models[feed_name].predict(X_scaled)[0]
        anomaly_score = self.models[feed_name].score_samples(X_scaled)[0]

        # Convert anomaly score to 0-1 range (more negative = more anomalous)
        normalized_score = 1 / (1 + np.exp(anomaly_score))

        is_anomaly = (prediction == -1 and normalized_score > self.config['anomaly_threshold'])

        # Calculate expected range from historical data
        history = list(self.price_history[feed_name])[:-1]
        if len(history) > 0:
            mean = np.mean(history)
            std = np.std(history)
            expected_range = (mean - 2*std, mean + 2*std)
        else:
            expected_range = (price * 0.9, price * 1.1)

        # Determine recommendation
        recommendation = self._generate_recommendation(
            feed_name,
            price,
            features,
            is_anomaly,
            normalized_score
        )

        alert = AnomalyAlert(
            timestamp=timestamp,
            feed_name=feed_name,
            value=price,
            expected_range=expected_range,
            anomaly_score=normalized_score,
            severity=self._get_severity(normalized_score),
            recommendation=recommendation,
            features=features
        )

        if is_anomaly:
            self.alerts.append(alert)
            self.anomaly_count[feed_name] = self.anomaly_count.get(feed_name, 0) + 1
            print(f"⚠ ANOMALY DETECTED: {feed_name}")
            print(f"   Price: ${price:.2f}")
            print(f"   Score: {normalized_score:.3f}")
            print(f"   Severity: {alert.severity}")

        return is_anomaly, alert

    def _get_severity(self, score: float) -> str:
        """Determine severity level based on anomaly score"""
        if score >= 0.95:
            return 'critical'
        elif score >= 0.90:
            return 'high'
        elif score >= 0.85:
            return 'medium'
        else:
            return 'low'

    def _generate_recommendation(
        self,
        feed_name: str,
        price: float,
        features: Dict,
        is_anomaly: bool,
        score: float
    ) -> str:
        """Generate actionable recommendation"""
        if not is_anomaly:
            return "Price within normal range. No action needed."

        recommendations = []

        # High volatility
        if abs(features.get('volatility', 0)) > 0.1:
            recommendations.append("High volatility detected. Increase confirmation requirements.")

        # Large price change
        if abs(features.get('price_change', 0)) > 0.05:
            recommendations.append("Significant price deviation. Verify with additional sources.")

        # High momentum
        if abs(features.get('momentum', 0)) > 0.02:
            recommendations.append("Rapid price movement. Consider temporary oracle override.")

        # Critical severity
        if score >= 0.95:
            recommendations.append("CRITICAL: Suggest governance intervention and feed suspension.")

        if not recommendations:
            recommendations.append("Anomaly detected. Manual review recommended.")

        return " ".join(recommendations)

    def get_feed_statistics(self, feed_name: str) -> Dict:
        """Get statistics for a feed"""
        if feed_name not in self.price_history:
            return {}

        history = list(self.price_history[feed_name])

        if len(history) == 0:
            return {}

        return {
            'feed_name': feed_name,
            'data_points': len(history),
            'current_price': history[-1] if history else None,
            'mean_price': float(np.mean(history)),
            'std_price': float(np.std(history)),
            'min_price': float(np.min(history)),
            'max_price': float(np.max(history)),
            'anomaly_count': self.anomaly_count.get(feed_name, 0),
            'anomaly_rate': self.anomaly_count.get(feed_name, 0) / len(history) if history else 0,
            'model_trained': feed_name in self.model_metrics,
            'model_metrics': self.model_metrics.get(feed_name, {})
        }

    def get_recent_alerts(self, limit: int = 10, feed_name: str = None) -> List[Dict]:
        """Get recent anomaly alerts"""
        alerts = self.alerts

        if feed_name:
            alerts = [a for a in alerts if a.feed_name == feed_name]

        return [asdict(a) for a in sorted(alerts, key=lambda x: x.timestamp, reverse=True)[:limit]]

    def export_model(self, feed_name: str, filepath: str):
        """Export trained model to file"""
        import pickle

        if feed_name not in self.models:
            raise ValueError(f"No model found for {feed_name}")

        model_data = {
            'model': self.models[feed_name],
            'scaler': self.scalers[feed_name],
            'metrics': self.model_metrics.get(feed_name, {}),
            'config': self.config
        }

        with open(filepath, 'wb') as f:
            pickle.dump(model_data, f)

        print(f"✓ Exported model for {feed_name} to {filepath}")


# Example usage and CLI
if __name__ == "__main__":
    print("🤖 ML Anomaly Detector Demo\n")

    # Initialize detector
    detector = MLAnomalyDetector()

    # Simulate price feed data
    print("Simulating ETH/USD price feed...\n")

    np.random.seed(42)
    base_price = 2000
    timestamps = []
    prices = []

    # Generate normal data with some anomalies
    for i in range(150):
        timestamp = int(time.time()) - (150 - i) * 60  # 1 minute intervals

        # Normal price movement
        if i < 100 or (i >= 110 and i < 140):
            price = base_price + np.random.normal(0, 20) + np.sin(i / 10) * 50
        # Inject anomalies
        elif i >= 100 and i < 110:
            price = base_price + 300 + np.random.normal(0, 50)  # Spike
        else:
            price = base_price - 200 + np.random.normal(0, 50)  # Crash

        volume = np.random.uniform(1000000, 5000000)

        # Detect anomaly
        is_anomaly, alert = detector.detect_anomaly(
            feed_name='ETH/USD',
            price=price,
            volume=volume,
            timestamp=timestamp
        )

        timestamps.append(timestamp)
        prices.append(price)

        if is_anomaly and alert:
            print(f"⚠ [{i}] ANOMALY: ${price:.2f} (score: {alert.anomaly_score:.3f})")
            print(f"    {alert.recommendation}\n")

    # Get statistics
    print("\n📊 Feed Statistics:")
    stats = detector.get_feed_statistics('ETH/USD')
    print(json.dumps(stats, indent=2))

    # Get recent alerts
    print("\n🚨 Recent Alerts:")
    alerts = detector.get_recent_alerts(limit=5, feed_name='ETH/USD')
    for alert in alerts:
        print(f"  {alert['severity'].upper()}: ${alert['value']:.2f} (score: {alert['anomaly_score']:.3f})")

    print("\n✓ Demo completed!")
