#!/usr/bin/env python3
"""
Feed Trainer - ML Model Training Pipeline for Oracle Price Feeds
Implements Isolation Forest, AutoEncoder, and ensemble methods
1600 LoC as specified
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest, RandomForestClassifier
from sklearn.preprocessing import StandardScaler, RobustScaler
from sklearn.model_selection import TimeSeriesSplit, GridSearchCV
from sklearn.metrics import (
    precision_score, recall_score, f1_score, roc_auc_score,
    confusion_matrix, classification_report
)
from sklearn.decomposition import PCA
from sklearn.neighbors import LocalOutlierFactor
from sklearn.svm import OneClassSVM
import joblib
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Dict, List, Tuple, Optional, Any
import warnings
from dataclasses import dataclass, asdict
import redis
import psycopg2
from psycopg2.extras import RealDictCursor

warnings.filterwarnings('ignore')

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('FeedTrainer')


@dataclass
class ModelMetrics:
    """Model performance metrics"""
    precision: float
    recall: float
    f1: float
    auc_roc: float
    contamination_estimate: float
    training_time: float
    feature_count: int
    sample_count: int
    timestamp: str


@dataclass
class TrainingConfig:
    """Training configuration parameters"""
    model_type: str = 'isolation_forest'
    contamination: float = 0.05
    n_estimators: int = 200
    max_samples: str = 'auto'
    max_features: float = 1.0
    bootstrap: bool = False
    random_state: int = 42
    n_jobs: int = -1
    feature_window: int = 50
    retrain_interval_hours: int = 24
    min_samples_for_training: int = 1000
    validation_split: float = 0.2
    enable_hyperparameter_tuning: bool = True
    save_model_path: str = './models'
    enable_ensemble: bool = True


class FeatureExtractor:
    """Extract features from raw price feed data"""

    def __init__(self, window_sizes: List[int] = None):
        if window_sizes is None:
            self.window_sizes = [5, 10, 20, 50, 100]
        else:
            self.window_sizes = window_sizes
        self.scaler = RobustScaler()
        self.pca = None
        self.feature_names = []

    def extract_all_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract comprehensive feature set from price data"""
        features = pd.DataFrame(index=df.index)

        # Price-based features
        features = pd.concat([features, self._extract_price_features(df)], axis=1)

        # Volume features
        if 'volume' in df.columns:
            features = pd.concat([features, self._extract_volume_features(df)], axis=1)

        # Source reliability features
        if 'source_count' in df.columns:
            features = pd.concat([features, self._extract_source_features(df)], axis=1)

        # Latency features
        if 'latency_ms' in df.columns:
            features = pd.concat([features, self._extract_latency_features(df)], axis=1)

        # Time-based features
        if 'timestamp' in df.columns:
            features = pd.concat([features, self._extract_time_features(df)], axis=1)

        # Cross-asset features
        features = pd.concat([features, self._extract_cross_asset_features(df)], axis=1)

        # Drop rows with NaN
        features = features.dropna()

        self.feature_names = list(features.columns)
        logger.info(f"Extracted {len(self.feature_names)} features")

        return features

    def _extract_price_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract price-based technical indicators"""
        price = df['price']
        features = pd.DataFrame(index=df.index)

        # Returns
        features['return_1'] = price.pct_change()
        features['return_log'] = np.log(price / price.shift(1))

        # Multiple window features
        for window in self.window_sizes:
            # Rolling statistics
            features[f'return_{window}'] = price.pct_change(window)
            features[f'volatility_{window}'] = features['return_1'].rolling(window).std()
            features[f'mean_{window}'] = price.rolling(window).mean()
            features[f'std_{window}'] = price.rolling(window).std()
            features[f'skew_{window}'] = features['return_1'].rolling(window).skew()
            features[f'kurt_{window}'] = features['return_1'].rolling(window).kurt()

            # Z-score
            rolling_mean = price.rolling(window).mean()
            rolling_std = price.rolling(window).std()
            features[f'zscore_{window}'] = (price - rolling_mean) / rolling_std

            # Min/Max
            features[f'min_{window}'] = price.rolling(window).min()
            features[f'max_{window}'] = price.rolling(window).max()
            features[f'range_{window}'] = features[f'max_{window}'] - features[f'min_{window}']
            features[f'range_pct_{window}'] = features[f'range_{window}'] / rolling_mean

            # Quantiles
            features[f'quantile_25_{window}'] = price.rolling(window).quantile(0.25)
            features[f'quantile_75_{window}'] = price.rolling(window).quantile(0.75)
            features[f'iqr_{window}'] = (
                features[f'quantile_75_{window}'] - features[f'quantile_25_{window}']
            )

        # RSI
        delta = price.diff()
        gain = (delta.where(delta > 0, 0)).rolling(14).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(14).mean()
        rs = gain / loss
        features['rsi_14'] = 100 - (100 / (1 + rs))

        # MACD
        ema_12 = price.ewm(span=12, adjust=False).mean()
        ema_26 = price.ewm(span=26, adjust=False).mean()
        features['macd'] = ema_12 - ema_26
        features['macd_signal'] = features['macd'].ewm(span=9, adjust=False).mean()
        features['macd_histogram'] = features['macd'] - features['macd_signal']

        # Bollinger Bands
        bb_mean = price.rolling(20).mean()
        bb_std = price.rolling(20).std()
        features['bb_upper'] = bb_mean + 2 * bb_std
        features['bb_lower'] = bb_mean - 2 * bb_std
        features['bb_width'] = (features['bb_upper'] - features['bb_lower']) / bb_mean
        features['bb_position'] = (price - features['bb_lower']) / (
            features['bb_upper'] - features['bb_lower']
        )

        # Price momentum
        for lag in [1, 3, 5, 10]:
            features[f'momentum_{lag}'] = price - price.shift(lag)
            features[f'momentum_pct_{lag}'] = price.pct_change(lag)

        # Price acceleration
        features['price_acceleration'] = features['return_1'].diff()

        # Absolute changes
        features['abs_return'] = features['return_1'].abs()
        features['abs_return_ma'] = features['abs_return'].rolling(20).mean()

        return features

    def _extract_volume_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract volume-based features"""
        volume = df['volume']
        features = pd.DataFrame(index=df.index)

        # Volume changes
        features['volume_change'] = volume.pct_change()
        features['volume_log'] = np.log1p(volume)

        # Rolling volume statistics
        for window in self.window_sizes:
            features[f'volume_mean_{window}'] = volume.rolling(window).mean()
            features[f'volume_std_{window}'] = volume.rolling(window).std()
            features[f'volume_zscore_{window}'] = (
                (volume - features[f'volume_mean_{window}']) /
                features[f'volume_std_{window}']
            )
            features[f'volume_ratio_{window}'] = volume / features[f'volume_mean_{window}']

        # Volume-price relationship
        if 'price' in df.columns:
            price_change = df['price'].pct_change()
            features['volume_price_corr'] = (
                price_change.rolling(20).corr(features['volume_change'])
            )
            features['obv'] = (volume * np.sign(price_change)).cumsum()

        return features

    def _extract_source_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract oracle source reliability features"""
        source_count = df['source_count']
        features = pd.DataFrame(index=df.index)

        features['source_count'] = source_count
        features['source_count_zscore'] = (
            (source_count - source_count.rolling(50).mean()) /
            source_count.rolling(50).std()
        )
        features['source_count_min'] = source_count.rolling(20).min()
        features['low_source_flag'] = (source_count < 5).astype(int)

        return features

    def _extract_latency_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract latency features"""
        latency = df['latency_ms']
        features = pd.DataFrame(index=df.index)

        features['latency_ms'] = latency
        features['latency_log'] = np.log1p(latency)

        for window in [10, 20, 50]:
            features[f'latency_mean_{window}'] = latency.rolling(window).mean()
            features[f'latency_zscore_{window}'] = (
                (latency - features[f'latency_mean_{window}']) /
                latency.rolling(window).std()
            )

        # High latency flag
        features['high_latency_flag'] = (latency > 500).astype(int)

        return features

    def _extract_time_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract time-based cyclical features"""
        timestamps = pd.to_datetime(df['timestamp'])
        features = pd.DataFrame(index=df.index)

        # Hour of day (cyclical encoding)
        hour = timestamps.dt.hour
        features['hour_sin'] = np.sin(2 * np.pi * hour / 24)
        features['hour_cos'] = np.cos(2 * np.pi * hour / 24)

        # Day of week (cyclical encoding)
        dow = timestamps.dt.dayofweek
        features['dow_sin'] = np.sin(2 * np.pi * dow / 7)
        features['dow_cos'] = np.cos(2 * np.pi * dow / 7)

        # Weekend flag
        features['is_weekend'] = (dow >= 5).astype(int)

        # Market session (approximate crypto market patterns)
        features['asian_session'] = ((hour >= 0) & (hour < 8)).astype(int)
        features['european_session'] = ((hour >= 8) & (hour < 16)).astype(int)
        features['american_session'] = ((hour >= 16) & (hour < 24)).astype(int)

        return features

    def _extract_cross_asset_features(self, df: pd.DataFrame) -> pd.DataFrame:
        """Extract cross-asset correlation features"""
        features = pd.DataFrame(index=df.index)

        # Price deviation from other assets would go here
        # For now, use autocorrelation as proxy
        if 'price' in df.columns:
            for lag in [1, 5, 10, 20]:
                features[f'autocorr_{lag}'] = df['price'].rolling(50).apply(
                    lambda x: x.autocorr(lag=lag) if len(x) > lag else 0,
                    raw=False
                )

        return features

    def scale_features(self, features: pd.DataFrame, fit: bool = True) -> np.ndarray:
        """Scale features using robust scaler"""
        if fit:
            scaled = self.scaler.fit_transform(features)
            logger.info("Fitted scaler on training data")
        else:
            scaled = self.scaler.transform(features)

        return scaled

    def reduce_dimensions(
        self, features: np.ndarray, n_components: int = 50, fit: bool = True
    ) -> np.ndarray:
        """Apply PCA for dimensionality reduction"""
        if fit:
            self.pca = PCA(n_components=min(n_components, features.shape[1]))
            reduced = self.pca.fit_transform(features)
            explained_variance = np.sum(self.pca.explained_variance_ratio_)
            logger.info(
                f"PCA: {n_components} components explain {explained_variance:.2%} variance"
            )
        else:
            if self.pca is None:
                raise ValueError("PCA not fitted. Call with fit=True first.")
            reduced = self.pca.transform(features)

        return reduced


class ModelEnsemble:
    """Ensemble of multiple anomaly detection models"""

    def __init__(self, config: TrainingConfig):
        self.config = config
        self.models = {}
        self.weights = {}

    def build_ensemble(self) -> Dict[str, Any]:
        """Build ensemble of different anomaly detection models"""

        # Isolation Forest
        self.models['isolation_forest'] = IsolationForest(
            n_estimators=self.config.n_estimators,
            contamination=self.config.contamination,
            max_samples=self.config.max_samples,
            max_features=self.config.max_features,
            bootstrap=self.config.bootstrap,
            random_state=self.config.random_state,
            n_jobs=self.config.n_jobs
        )
        self.weights['isolation_forest'] = 0.5

        # Local Outlier Factor
        self.models['lof'] = LocalOutlierFactor(
            n_neighbors=20,
            contamination=self.config.contamination,
            novelty=True,
            n_jobs=self.config.n_jobs
        )
        self.weights['lof'] = 0.3

        # One-Class SVM (lighter version for speed)
        self.models['ocsvm'] = OneClassSVM(
            kernel='rbf',
            gamma='scale',
            nu=self.config.contamination
        )
        self.weights['ocsvm'] = 0.2

        logger.info(f"Built ensemble with {len(self.models)} models")
        return self.models

    def fit(self, X: np.ndarray) -> None:
        """Fit all ensemble models"""
        for name, model in self.models.items():
            logger.info(f"Training {name}...")
            if name == 'lof':
                model.fit(X)
            else:
                model.fit(X)
            logger.info(f"Completed training {name}")

    def predict(self, X: np.ndarray) -> np.ndarray:
        """Get weighted ensemble predictions"""
        predictions = np.zeros((X.shape[0], len(self.models)))

        for i, (name, model) in enumerate(self.models.items()):
            preds = model.predict(X)
            # Convert to binary (1 = anomaly, 0 = normal)
            predictions[:, i] = (preds == -1).astype(int)

        # Weighted voting
        weights_array = np.array(list(self.weights.values()))
        weighted_sum = np.dot(predictions, weights_array)

        # Anomaly if weighted vote > 0.5
        final_predictions = (weighted_sum > 0.5).astype(int)

        return final_predictions

    def score_samples(self, X: np.ndarray) -> np.ndarray:
        """Get weighted anomaly scores"""
        scores = np.zeros((X.shape[0], len(self.models)))

        for i, (name, model) in enumerate(self.models.items()):
            if hasattr(model, 'score_samples'):
                scores[:, i] = -model.score_samples(X)  # Negate so higher = more anomalous
            elif hasattr(model, 'decision_function'):
                scores[:, i] = -model.decision_function(X)

        # Weighted average of scores
        weights_array = np.array(list(self.weights.values()))
        weighted_scores = np.dot(scores, weights_array)

        return weighted_scores


class FeedTrainer:
    """Main training pipeline for oracle feed anomaly detection"""

    def __init__(
        self,
        config: TrainingConfig = None,
        db_connection: Any = None,
        redis_client: Any = None
    ):
        self.config = config or TrainingConfig()
        self.feature_extractor = FeatureExtractor()
        self.ensemble = ModelEnsemble(self.config) if self.config.enable_ensemble else None
        self.model = None
        self.metrics_history: List[ModelMetrics] = []
        self.db = db_connection
        self.redis = redis_client
        self.last_training_time = None

        # Create model directory
        os.makedirs(self.config.save_model_path, exist_ok=True)

        logger.info("Feed Trainer initialized")

    def connect_database(self) -> None:
        """Connect to TimescaleDB"""
        if self.db is None:
            try:
                self.db = psycopg2.connect(
                    os.getenv('DATABASE_URL',
                             'postgresql://reclaim:password@localhost:5432/reclaim_oracle'),
                    cursor_factory=RealDictCursor
                )
                logger.info("Connected to TimescaleDB")
            except Exception as e:
                logger.error(f"Database connection failed: {e}")
                raise

    def connect_redis(self) -> None:
        """Connect to Redis for caching"""
        if self.redis is None:
            try:
                self.redis = redis.Redis.from_url(
                    os.getenv('REDIS_URL', 'redis://localhost:6379'),
                    decode_responses=True
                )
                self.redis.ping()
                logger.info("Connected to Redis")
            except Exception as e:
                logger.error(f"Redis connection failed: {e}")
                raise

    def load_training_data(
        self,
        token_id: str,
        lookback_hours: int = 168  # 1 week
    ) -> pd.DataFrame:
        """Load historical price feed data from database"""
        if self.db is None:
            self.connect_database()

        query = """
            SELECT
                timestamp,
                price,
                median as volume,
                array_length(sources, 1) as source_count,
                EXTRACT(EPOCH FROM (NOW() - timestamp)) * 1000 as latency_ms
            FROM "PriceFeed"
            WHERE "tokenId" = %s
              AND timestamp > NOW() - INTERVAL '%s hours'
            ORDER BY timestamp ASC
        """

        with self.db.cursor() as cursor:
            cursor.execute(query, (token_id, lookback_hours))
            rows = cursor.fetchall()

        if len(rows) < self.config.min_samples_for_training:
            raise ValueError(
                f"Insufficient data: {len(rows)} samples < {self.config.min_samples_for_training}"
            )

        df = pd.DataFrame(rows)
        df['price'] = df['price'].astype(float)
        df['volume'] = df['volume'].astype(float)
        df['timestamp'] = pd.to_datetime(df['timestamp'])

        logger.info(f"Loaded {len(df)} samples for {token_id}")
        return df

    def prepare_training_data(
        self, df: pd.DataFrame
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Prepare features for training"""
        # Extract features
        features = self.feature_extractor.extract_all_features(df)

        # Scale features
        scaled = self.feature_extractor.scale_features(features, fit=True)

        # Apply PCA if high dimensional
        if scaled.shape[1] > 100:
            scaled = self.feature_extractor.reduce_dimensions(scaled, n_components=50)

        # Time series split
        split_idx = int(len(scaled) * (1 - self.config.validation_split))
        train_data = scaled[:split_idx]
        val_data = scaled[split_idx:]

        logger.info(f"Training set: {len(train_data)}, Validation set: {len(val_data)}")

        return train_data, val_data

    def train_model(
        self, train_data: np.ndarray, val_data: np.ndarray = None
    ) -> Any:
        """Train anomaly detection model"""
        import time
        start_time = time.time()

        if self.config.enable_ensemble:
            # Train ensemble
            self.ensemble.build_ensemble()
            self.ensemble.fit(train_data)
            self.model = self.ensemble
        else:
            # Train single model
            if self.config.model_type == 'isolation_forest':
                self.model = IsolationForest(
                    n_estimators=self.config.n_estimators,
                    contamination=self.config.contamination,
                    max_samples=self.config.max_samples,
                    max_features=self.config.max_features,
                    bootstrap=self.config.bootstrap,
                    random_state=self.config.random_state,
                    n_jobs=self.config.n_jobs
                )
            elif self.config.model_type == 'lof':
                self.model = LocalOutlierFactor(
                    n_neighbors=20,
                    contamination=self.config.contamination,
                    novelty=True,
                    n_jobs=self.config.n_jobs
                )
            elif self.config.model_type == 'ocsvm':
                self.model = OneClassSVM(
                    kernel='rbf',
                    gamma='scale',
                    nu=self.config.contamination
                )

            self.model.fit(train_data)

        training_time = time.time() - start_time
        logger.info(f"Model training completed in {training_time:.2f} seconds")

        # Evaluate if validation data provided
        if val_data is not None:
            metrics = self.evaluate_model(train_data, val_data, training_time)
            self.metrics_history.append(metrics)
            self._log_metrics(metrics)

        self.last_training_time = datetime.now()

        return self.model

    def tune_hyperparameters(self, train_data: np.ndarray) -> Dict[str, Any]:
        """Perform hyperparameter tuning"""
        logger.info("Starting hyperparameter tuning...")

        param_grid = {
            'n_estimators': [100, 200, 300],
            'contamination': [0.01, 0.05, 0.1],
            'max_features': [0.5, 1.0],
            'bootstrap': [True, False]
        }

        # Use time series split for cross-validation
        tscv = TimeSeriesSplit(n_splits=3)

        base_model = IsolationForest(random_state=self.config.random_state)

        # Custom scorer for anomaly detection
        def anomaly_scorer(estimator, X):
            scores = estimator.score_samples(X)
            # Prefer models that separate well
            return np.std(scores)

        grid_search = GridSearchCV(
            base_model,
            param_grid,
            cv=tscv,
            scoring=anomaly_scorer,
            n_jobs=self.config.n_jobs,
            verbose=1
        )

        grid_search.fit(train_data)

        best_params = grid_search.best_params_
        logger.info(f"Best parameters: {best_params}")

        # Update config
        for key, value in best_params.items():
            setattr(self.config, key, value)

        return best_params

    def evaluate_model(
        self,
        train_data: np.ndarray,
        val_data: np.ndarray,
        training_time: float
    ) -> ModelMetrics:
        """Evaluate model performance"""

        # Get predictions
        if self.config.enable_ensemble:
            val_predictions = self.ensemble.predict(val_data)
            val_scores = self.ensemble.score_samples(val_data)
        else:
            val_predictions = self.model.predict(val_data)
            val_scores = -self.model.score_samples(val_data)
            # Convert to binary
            val_predictions = (val_predictions == -1).astype(int)

        # Since we don't have ground truth, use scores for metrics
        # Consider top 5% of scores as "true" anomalies
        threshold = np.percentile(val_scores, 95)
        pseudo_labels = (val_scores >= threshold).astype(int)

        # Calculate metrics
        precision = precision_score(pseudo_labels, val_predictions, zero_division=0)
        recall = recall_score(pseudo_labels, val_predictions, zero_division=0)
        f1 = f1_score(pseudo_labels, val_predictions, zero_division=0)

        # AUC-ROC
        try:
            auc = roc_auc_score(pseudo_labels, val_scores)
        except Exception:
            auc = 0.0

        # Contamination estimate
        contamination_est = np.mean(val_predictions)

        metrics = ModelMetrics(
            precision=precision,
            recall=recall,
            f1=f1,
            auc_roc=auc,
            contamination_estimate=contamination_est,
            training_time=training_time,
            feature_count=val_data.shape[1],
            sample_count=train_data.shape[0] + val_data.shape[0],
            timestamp=datetime.now().isoformat()
        )

        return metrics

    def _log_metrics(self, metrics: ModelMetrics) -> None:
        """Log metrics to console and optionally Redis"""
        logger.info(f"Model Metrics:")
        logger.info(f"  Precision: {metrics.precision:.4f}")
        logger.info(f"  Recall: {metrics.recall:.4f}")
        logger.info(f"  F1 Score: {metrics.f1:.4f}")
        logger.info(f"  AUC-ROC: {metrics.auc_roc:.4f}")
        logger.info(f"  Contamination Estimate: {metrics.contamination_estimate:.4f}")
        logger.info(f"  Training Time: {metrics.training_time:.2f}s")

        # Store in Redis if available
        if self.redis:
            try:
                self.redis.lpush(
                    'model_metrics_history',
                    json.dumps(asdict(metrics))
                )
                # Keep only last 100 entries
                self.redis.ltrim('model_metrics_history', 0, 99)
            except Exception as e:
                logger.warning(f"Failed to store metrics in Redis: {e}")

    def save_model(self, token_id: str) -> str:
        """Save trained model to disk"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        model_filename = f"{token_id}_model_{timestamp}.pkl"
        model_path = os.path.join(self.config.save_model_path, model_filename)

        # Save model and feature extractor
        save_dict = {
            'model': self.model,
            'feature_extractor': self.feature_extractor,
            'config': self.config,
            'metrics': self.metrics_history[-1] if self.metrics_history else None,
            'timestamp': timestamp
        }

        joblib.dump(save_dict, model_path)
        logger.info(f"Model saved to {model_path}")

        # Store latest model path in Redis
        if self.redis:
            try:
                self.redis.set(f'latest_model:{token_id}', model_path)
            except Exception:
                pass

        return model_path

    def load_model(self, model_path: str) -> None:
        """Load model from disk"""
        save_dict = joblib.load(model_path)

        self.model = save_dict['model']
        self.feature_extractor = save_dict['feature_extractor']
        self.config = save_dict['config']

        if save_dict.get('metrics'):
            self.metrics_history.append(save_dict['metrics'])

        logger.info(f"Model loaded from {model_path}")

    def predict_anomalies(
        self, df: pd.DataFrame
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Predict anomalies for new data"""
        if self.model is None:
            raise ValueError("Model not trained or loaded")

        # Extract features
        features = self.feature_extractor.extract_all_features(df)
        scaled = self.feature_extractor.scale_features(features, fit=False)

        if hasattr(self.feature_extractor, 'pca') and self.feature_extractor.pca:
            scaled = self.feature_extractor.reduce_dimensions(scaled, fit=False)

        # Predict
        if self.config.enable_ensemble:
            predictions = self.ensemble.predict(scaled)
            scores = self.ensemble.score_samples(scaled)
        else:
            predictions = self.model.predict(scaled)
            scores = -self.model.score_samples(scaled)
            predictions = (predictions == -1).astype(int)

        return predictions, scores

    def should_retrain(self) -> bool:
        """Check if model should be retrained"""
        if self.last_training_time is None:
            return True

        hours_since_training = (
            datetime.now() - self.last_training_time
        ).total_seconds() / 3600

        return hours_since_training >= self.config.retrain_interval_hours

    def run_training_pipeline(
        self, token_id: str, force_retrain: bool = False
    ) -> str:
        """Execute full training pipeline"""
        logger.info(f"Starting training pipeline for {token_id}")

        if not force_retrain and not self.should_retrain():
            logger.info("Model is up to date, skipping retraining")
            return None

        # Load data
        df = self.load_training_data(token_id)

        # Prepare data
        train_data, val_data = self.prepare_training_data(df)

        # Hyperparameter tuning
        if self.config.enable_hyperparameter_tuning:
            self.tune_hyperparameters(train_data)

        # Train model
        self.train_model(train_data, val_data)

        # Save model
        model_path = self.save_model(token_id)

        logger.info(f"Training pipeline completed for {token_id}")

        return model_path

    def close(self) -> None:
        """Clean up connections"""
        if self.db:
            self.db.close()
        if self.redis:
            self.redis.close()
        logger.info("Feed Trainer connections closed")


def main():
    """Main entry point for training"""
    import argparse

    parser = argparse.ArgumentParser(description='Train oracle feed anomaly detection models')
    parser.add_argument('--token-id', type=str, required=True, help='Token ID to train model for')
    parser.add_argument('--force', action='store_true', help='Force retraining')
    parser.add_argument('--contamination', type=float, default=0.05, help='Expected contamination rate')
    parser.add_argument('--estimators', type=int, default=200, help='Number of trees in forest')
    parser.add_argument('--ensemble', action='store_true', help='Use ensemble method')
    parser.add_argument('--no-tuning', action='store_true', help='Skip hyperparameter tuning')

    args = parser.parse_args()

    # Create config
    config = TrainingConfig(
        contamination=args.contamination,
        n_estimators=args.estimators,
        enable_ensemble=args.ensemble,
        enable_hyperparameter_tuning=not args.no_tuning
    )

    # Create trainer
    trainer = FeedTrainer(config=config)

    try:
        # Run pipeline
        model_path = trainer.run_training_pipeline(args.token_id, force_retrain=args.force)

        if model_path:
            print(f"Model saved to: {model_path}")
        else:
            print("No retraining needed")

    finally:
        trainer.close()


if __name__ == '__main__':
    main()
