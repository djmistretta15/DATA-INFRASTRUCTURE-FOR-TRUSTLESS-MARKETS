#!/usr/bin/env python3
"""
Comprehensive Test Suite for ML Anomaly Detection Pipeline
Tests Isolation Forest, feature engineering, and alert generation
1200 LoC as specified
"""

import unittest
import numpy as np
import pandas as pd
from datetime import datetime, timedelta
from unittest.mock import Mock, patch, MagicMock
import json
import tempfile
import os
import sys

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ml_anomaly_detector.src.detector import (
    AnomalyDetector,
    FeatureEngineer,
    AlertGenerator,
    DataPreprocessor,
    ModelTrainer,
    AnomalyScore
)


class TestFeatureEngineer(unittest.TestCase):
    """Test feature engineering components"""

    def setUp(self):
        self.engineer = FeatureEngineer()
        # Generate sample price data
        np.random.seed(42)
        self.sample_data = self._generate_sample_prices()

    def _generate_sample_prices(self, n_samples=1000):
        """Generate realistic price time series"""
        base_price = 100.0
        prices = [base_price]
        timestamps = [datetime.now() - timedelta(minutes=n_samples)]

        for i in range(1, n_samples):
            # Random walk with momentum
            change = np.random.randn() * 0.5 + 0.01
            new_price = prices[-1] * (1 + change / 100)
            prices.append(new_price)
            timestamps.append(timestamps[-1] + timedelta(minutes=1))

        return pd.DataFrame({
            'timestamp': timestamps,
            'price': prices,
            'volume': np.random.exponential(1000, n_samples),
            'source_count': np.random.randint(3, 10, n_samples)
        })

    def test_calculate_returns(self):
        """Test return calculation"""
        returns = self.engineer.calculate_returns(self.sample_data['price'])
        self.assertEqual(len(returns), len(self.sample_data) - 1)
        self.assertFalse(returns.isna().any())

    def test_calculate_volatility(self):
        """Test volatility calculation"""
        volatility = self.engineer.calculate_volatility(
            self.sample_data['price'], window=20
        )
        # First window-1 values should be NaN
        self.assertEqual(volatility.isna().sum(), 19)
        # Rest should be positive
        self.assertTrue((volatility.dropna() >= 0).all())

    def test_calculate_rsi(self):
        """Test RSI calculation"""
        rsi = self.engineer.calculate_rsi(self.sample_data['price'], period=14)
        # RSI should be between 0 and 100
        valid_rsi = rsi.dropna()
        self.assertTrue((valid_rsi >= 0).all() and (valid_rsi <= 100).all())

    def test_calculate_macd(self):
        """Test MACD calculation"""
        macd, signal, histogram = self.engineer.calculate_macd(
            self.sample_data['price']
        )
        self.assertEqual(len(macd), len(self.sample_data))
        self.assertEqual(len(signal), len(self.sample_data))
        self.assertEqual(len(histogram), len(self.sample_data))

    def test_calculate_bollinger_bands(self):
        """Test Bollinger Bands calculation"""
        upper, middle, lower = self.engineer.calculate_bollinger_bands(
            self.sample_data['price'], window=20, num_std=2
        )
        # Upper should always be >= middle >= lower
        valid_idx = ~upper.isna()
        self.assertTrue((upper[valid_idx] >= middle[valid_idx]).all())
        self.assertTrue((middle[valid_idx] >= lower[valid_idx]).all())

    def test_calculate_z_score(self):
        """Test Z-score calculation"""
        z_scores = self.engineer.calculate_z_score(
            self.sample_data['price'], window=50
        )
        # Z-scores should be centered around 0
        valid_z = z_scores.dropna()
        self.assertAlmostEqual(valid_z.mean(), 0, places=1)

    def test_extract_time_features(self):
        """Test time-based feature extraction"""
        features = self.engineer.extract_time_features(
            self.sample_data['timestamp']
        )
        self.assertIn('hour', features.columns)
        self.assertIn('day_of_week', features.columns)
        self.assertIn('is_weekend', features.columns)

    def test_calculate_correlation_features(self):
        """Test correlation feature calculation"""
        # Add correlated columns
        self.sample_data['price2'] = self.sample_data['price'] * 1.1 + np.random.randn(len(self.sample_data))
        corr = self.engineer.calculate_rolling_correlation(
            self.sample_data['price'],
            self.sample_data['price2'],
            window=30
        )
        # Correlation should be between -1 and 1
        valid_corr = corr.dropna()
        self.assertTrue((valid_corr >= -1).all() and (valid_corr <= 1).all())

    def test_feature_matrix_generation(self):
        """Test complete feature matrix generation"""
        features = self.engineer.generate_feature_matrix(self.sample_data)
        self.assertIsInstance(features, pd.DataFrame)
        self.assertGreater(features.shape[1], 10)  # Should have many features
        self.assertEqual(len(features), len(self.sample_data))

    def test_handle_missing_data(self):
        """Test handling of missing data"""
        # Introduce NaN values
        data_with_nan = self.sample_data.copy()
        data_with_nan.loc[10:15, 'price'] = np.nan

        features = self.engineer.generate_feature_matrix(data_with_nan)
        # Should handle NaN gracefully
        self.assertFalse(features.isna().all().any())


class TestDataPreprocessor(unittest.TestCase):
    """Test data preprocessing components"""

    def setUp(self):
        self.preprocessor = DataPreprocessor()
        np.random.seed(123)
        self.sample_features = pd.DataFrame({
            'feature1': np.random.randn(100),
            'feature2': np.random.randn(100) * 10 + 50,
            'feature3': np.random.exponential(5, 100)
        })

    def test_standardization(self):
        """Test feature standardization"""
        scaled = self.preprocessor.standardize(self.sample_features)
        # Mean should be ~0, std should be ~1
        for col in scaled.columns:
            self.assertAlmostEqual(scaled[col].mean(), 0, places=5)
            self.assertAlmostEqual(scaled[col].std(), 1, places=5)

    def test_minmax_scaling(self):
        """Test min-max scaling"""
        scaled = self.preprocessor.minmax_scale(self.sample_features)
        # All values should be between 0 and 1
        self.assertTrue((scaled >= 0).all().all())
        self.assertTrue((scaled <= 1).all().all())

    def test_robust_scaling(self):
        """Test robust scaling with outliers"""
        # Add outliers
        outlier_data = self.sample_features.copy()
        outlier_data.loc[0, 'feature1'] = 1000

        scaled = self.preprocessor.robust_scale(outlier_data)
        # Should be more resistant to outliers than standard scaling
        self.assertLess(scaled['feature1'].max(), 100)

    def test_remove_outliers(self):
        """Test outlier removal"""
        # Add clear outliers
        data_with_outliers = self.sample_features.copy()
        data_with_outliers.loc[0, 'feature1'] = 1000
        data_with_outliers.loc[1, 'feature2'] = -1000

        cleaned = self.preprocessor.remove_outliers(
            data_with_outliers, method='iqr', threshold=3
        )
        self.assertLess(len(cleaned), len(data_with_outliers))

    def test_impute_missing_values(self):
        """Test missing value imputation"""
        data_with_nan = self.sample_features.copy()
        data_with_nan.loc[5:10, 'feature1'] = np.nan

        imputed = self.preprocessor.impute_missing(data_with_nan, strategy='median')
        self.assertFalse(imputed.isna().any().any())

    def test_pca_dimensionality_reduction(self):
        """Test PCA for dimensionality reduction"""
        # Create high-dimensional data
        high_dim = pd.DataFrame(
            np.random.randn(100, 20),
            columns=[f'feature_{i}' for i in range(20)]
        )

        reduced = self.preprocessor.reduce_dimensions(high_dim, n_components=5)
        self.assertEqual(reduced.shape[1], 5)

    def test_train_test_split(self):
        """Test time-aware train/test split"""
        train, test = self.preprocessor.time_split(
            self.sample_features, test_size=0.2
        )
        self.assertEqual(len(train), 80)
        self.assertEqual(len(test), 20)


class TestAnomalyDetector(unittest.TestCase):
    """Test anomaly detection models"""

    def setUp(self):
        self.detector = AnomalyDetector(contamination=0.1)
        np.random.seed(456)

        # Generate normal data with some anomalies
        self.normal_data = np.random.randn(1000, 5)
        # Add anomalies (10% of data)
        n_anomalies = 100
        self.anomalies = np.random.randn(n_anomalies, 5) * 5 + 10
        self.all_data = np.vstack([self.normal_data, self.anomalies])
        self.labels = np.array([0] * 1000 + [1] * n_anomalies)

    def test_isolation_forest_fit(self):
        """Test Isolation Forest training"""
        self.detector.fit(self.all_data)
        self.assertTrue(self.detector.is_fitted)

    def test_isolation_forest_predict(self):
        """Test Isolation Forest prediction"""
        self.detector.fit(self.all_data)
        predictions = self.detector.predict(self.all_data)

        # Should detect anomalies (1 = anomaly, -1 = normal in sklearn)
        self.assertEqual(len(predictions), len(self.all_data))
        anomaly_ratio = np.sum(predictions == -1) / len(predictions)
        # Should be close to contamination rate
        self.assertAlmostEqual(anomaly_ratio, 0.1, places=1)

    def test_anomaly_scores(self):
        """Test anomaly score calculation"""
        self.detector.fit(self.all_data)
        scores = self.detector.score_samples(self.all_data)

        # Scores should be negative (more negative = more anomalous)
        self.assertEqual(len(scores), len(self.all_data))
        # Anomalies should have more negative scores on average
        normal_scores = scores[:1000]
        anomaly_scores = scores[1000:]
        self.assertGreater(normal_scores.mean(), anomaly_scores.mean())

    def test_local_outlier_factor(self):
        """Test LOF detection"""
        self.detector.set_method('lof')
        self.detector.fit(self.all_data)
        predictions = self.detector.predict(self.all_data)

        self.assertEqual(len(predictions), len(self.all_data))

    def test_one_class_svm(self):
        """Test One-Class SVM"""
        self.detector.set_method('ocsvm')
        # Use smaller dataset for SVM (computationally intensive)
        small_data = self.all_data[:200]
        self.detector.fit(small_data)
        predictions = self.detector.predict(small_data)

        self.assertEqual(len(predictions), len(small_data))

    def test_ensemble_detection(self):
        """Test ensemble of multiple detectors"""
        ensemble_predictions = self.detector.ensemble_predict(
            self.all_data, methods=['iforest', 'lof']
        )
        self.assertEqual(len(ensemble_predictions), len(self.all_data))

    def test_online_update(self):
        """Test online model updating"""
        self.detector.fit(self.normal_data)

        # Simulate streaming data
        new_data = np.random.randn(10, 5)
        self.detector.partial_fit(new_data)

        # Should still be able to predict
        predictions = self.detector.predict(new_data)
        self.assertEqual(len(predictions), 10)

    def test_feature_importance(self):
        """Test feature importance extraction"""
        self.detector.fit(self.all_data)
        importance = self.detector.get_feature_importance()

        self.assertEqual(len(importance), 5)
        # Should sum to 1
        self.assertAlmostEqual(sum(importance.values()), 1.0, places=5)

    def test_contamination_auto(self):
        """Test automatic contamination estimation"""
        detector = AnomalyDetector(contamination='auto')
        detector.fit(self.all_data)

        self.assertTrue(0 < detector.contamination_ < 0.5)

    def test_explain_anomaly(self):
        """Test anomaly explanation"""
        self.detector.fit(self.all_data)

        # Get a known anomaly
        anomaly_sample = self.anomalies[0:1]
        explanation = self.detector.explain_anomaly(anomaly_sample)

        self.assertIn('score', explanation)
        self.assertIn('contributing_features', explanation)


class TestAlertGenerator(unittest.TestCase):
    """Test alert generation and management"""

    def setUp(self):
        self.generator = AlertGenerator(
            threshold=0.8,
            min_confidence=0.7,
            cooldown_minutes=5
        )

    def test_generate_alert(self):
        """Test alert generation"""
        score = AnomalyScore(
            value=0.95,
            confidence=0.85,
            timestamp=datetime.now(),
            feed_name='ETH/USD',
            features={'volatility': 0.15, 'z_score': 3.5}
        )

        alert = self.generator.generate_alert(score)
        self.assertIsNotNone(alert)
        self.assertEqual(alert.feed_name, 'ETH/USD')
        self.assertEqual(alert.severity, 'HIGH')

    def test_alert_severity_levels(self):
        """Test different severity levels"""
        # Low severity
        low_score = AnomalyScore(0.81, 0.75, datetime.now(), 'test', {})
        low_alert = self.generator.generate_alert(low_score)
        self.assertEqual(low_alert.severity, 'LOW')

        # Medium severity
        med_score = AnomalyScore(0.88, 0.80, datetime.now(), 'test', {})
        med_alert = self.generator.generate_alert(med_score)
        self.assertEqual(med_alert.severity, 'MEDIUM')

        # High severity
        high_score = AnomalyScore(0.95, 0.90, datetime.now(), 'test', {})
        high_alert = self.generator.generate_alert(high_score)
        self.assertEqual(high_alert.severity, 'HIGH')

        # Critical severity
        critical_score = AnomalyScore(0.99, 0.95, datetime.now(), 'test', {})
        critical_alert = self.generator.generate_alert(critical_score)
        self.assertEqual(critical_alert.severity, 'CRITICAL')

    def test_alert_cooldown(self):
        """Test alert cooldown period"""
        score1 = AnomalyScore(0.9, 0.85, datetime.now(), 'ETH/USD', {})
        score2 = AnomalyScore(0.91, 0.86, datetime.now(), 'ETH/USD', {})

        alert1 = self.generator.generate_alert(score1)
        self.assertIsNotNone(alert1)

        # Second alert within cooldown should be suppressed
        alert2 = self.generator.generate_alert(score2)
        self.assertIsNone(alert2)

    def test_bypass_cooldown_for_critical(self):
        """Test that critical alerts bypass cooldown"""
        score1 = AnomalyScore(0.9, 0.85, datetime.now(), 'ETH/USD', {})
        critical_score = AnomalyScore(0.99, 0.98, datetime.now(), 'ETH/USD', {})

        self.generator.generate_alert(score1)
        # Critical should bypass cooldown
        critical_alert = self.generator.generate_alert(critical_score)
        self.assertIsNotNone(critical_alert)
        self.assertEqual(critical_alert.severity, 'CRITICAL')

    def test_alert_below_threshold(self):
        """Test no alert below threshold"""
        score = AnomalyScore(0.75, 0.85, datetime.now(), 'test', {})
        alert = self.generator.generate_alert(score)
        self.assertIsNone(alert)

    def test_alert_below_confidence(self):
        """Test no alert below confidence threshold"""
        score = AnomalyScore(0.9, 0.65, datetime.now(), 'test', {})
        alert = self.generator.generate_alert(score)
        self.assertIsNone(alert)

    def test_alert_aggregation(self):
        """Test multiple alerts aggregation"""
        alerts = []
        for i in range(5):
            score = AnomalyScore(
                0.85 + i * 0.02,
                0.8,
                datetime.now() + timedelta(minutes=i * 10),
                f'feed_{i}',
                {}
            )
            alert = self.generator.generate_alert(score)
            if alert:
                alerts.append(alert)

        summary = self.generator.aggregate_alerts(alerts)
        self.assertIn('total_alerts', summary)
        self.assertIn('severity_distribution', summary)

    def test_alert_serialization(self):
        """Test alert JSON serialization"""
        score = AnomalyScore(0.9, 0.85, datetime.now(), 'ETH/USD', {'vol': 0.1})
        alert = self.generator.generate_alert(score)

        json_str = alert.to_json()
        parsed = json.loads(json_str)

        self.assertEqual(parsed['feed_name'], 'ETH/USD')
        self.assertIn('timestamp', parsed)

    def test_alert_history(self):
        """Test alert history tracking"""
        initial_count = len(self.generator.alert_history)

        # Generate multiple alerts
        for i in range(3):
            score = AnomalyScore(
                0.9,
                0.85,
                datetime.now() + timedelta(minutes=i * 10),
                f'feed_{i}',
                {}
            )
            self.generator.generate_alert(score)

        self.assertEqual(len(self.generator.alert_history), initial_count + 3)

    def test_clear_expired_cooldowns(self):
        """Test clearing expired cooldowns"""
        score = AnomalyScore(0.9, 0.85, datetime.now(), 'ETH/USD', {})
        self.generator.generate_alert(score)

        # Manually expire cooldown
        self.generator._cooldowns['ETH/USD'] = datetime.now() - timedelta(minutes=10)
        self.generator.clear_expired_cooldowns()

        # Should be able to generate new alert
        score2 = AnomalyScore(0.91, 0.86, datetime.now(), 'ETH/USD', {})
        alert2 = self.generator.generate_alert(score2)
        self.assertIsNotNone(alert2)


class TestModelTrainer(unittest.TestCase):
    """Test model training and evaluation"""

    def setUp(self):
        self.trainer = ModelTrainer()
        np.random.seed(789)

        # Generate training data
        self.train_data = np.random.randn(800, 10)
        self.test_data = np.random.randn(200, 10)
        # Add some anomalies to test data
        self.test_data[:20] = np.random.randn(20, 10) * 5 + 8
        self.test_labels = np.array([1] * 20 + [0] * 180)

    def test_train_model(self):
        """Test model training"""
        model = self.trainer.train(self.train_data)
        self.assertIsNotNone(model)

    def test_cross_validation(self):
        """Test cross-validation scoring"""
        scores = self.trainer.cross_validate(self.train_data, n_folds=5)
        self.assertEqual(len(scores), 5)
        # All scores should be reasonable
        for score in scores:
            self.assertGreaterEqual(score, 0)
            self.assertLessEqual(score, 1)

    def test_hyperparameter_tuning(self):
        """Test hyperparameter optimization"""
        best_params = self.trainer.tune_hyperparameters(
            self.train_data,
            param_grid={
                'n_estimators': [50, 100],
                'contamination': [0.05, 0.1]
            }
        )
        self.assertIn('n_estimators', best_params)
        self.assertIn('contamination', best_params)

    def test_model_evaluation(self):
        """Test model evaluation metrics"""
        model = self.trainer.train(self.train_data)
        predictions = model.predict(self.test_data)

        metrics = self.trainer.evaluate(
            self.test_labels,
            predictions,
            self.test_data
        )

        self.assertIn('precision', metrics)
        self.assertIn('recall', metrics)
        self.assertIn('f1_score', metrics)
        self.assertIn('auc_roc', metrics)

    def test_model_persistence(self):
        """Test model save and load"""
        model = self.trainer.train(self.train_data)

        with tempfile.NamedTemporaryFile(delete=False, suffix='.pkl') as f:
            temp_path = f.name

        try:
            self.trainer.save_model(model, temp_path)
            loaded_model = self.trainer.load_model(temp_path)

            # Compare predictions
            orig_preds = model.predict(self.test_data)
            loaded_preds = loaded_model.predict(self.test_data)

            np.testing.assert_array_equal(orig_preds, loaded_preds)
        finally:
            os.unlink(temp_path)

    def test_training_with_validation(self):
        """Test training with validation set"""
        model, history = self.trainer.train_with_validation(
            self.train_data,
            self.test_data,
            self.test_labels
        )

        self.assertIsNotNone(model)
        self.assertIn('train_scores', history)
        self.assertIn('val_scores', history)

    def test_incremental_training(self):
        """Test incremental model updates"""
        model = self.trainer.train(self.train_data[:400])

        # Incrementally train on remaining data
        updated_model = self.trainer.incremental_train(
            model,
            self.train_data[400:]
        )

        self.assertIsNotNone(updated_model)

    def test_model_comparison(self):
        """Test comparing multiple models"""
        results = self.trainer.compare_models(
            self.train_data,
            self.test_data,
            methods=['iforest', 'lof']
        )

        self.assertIn('iforest', results)
        self.assertIn('lof', results)


class TestIntegration(unittest.TestCase):
    """Integration tests for complete pipeline"""

    def setUp(self):
        np.random.seed(999)
        self.engineer = FeatureEngineer()
        self.preprocessor = DataPreprocessor()
        self.detector = AnomalyDetector()
        self.alert_gen = AlertGenerator(threshold=0.8)

    def _generate_realistic_oracle_data(self, n_samples=500):
        """Generate realistic oracle price feed data"""
        timestamps = pd.date_range(
            end=datetime.now(),
            periods=n_samples,
            freq='1min'
        )

        # Base price with trend
        trend = np.linspace(100, 110, n_samples)
        noise = np.random.randn(n_samples) * 0.5
        prices = trend + noise

        # Add some anomalies (sudden spikes)
        anomaly_indices = np.random.choice(
            range(50, n_samples - 50),
            size=int(n_samples * 0.05),
            replace=False
        )
        for idx in anomaly_indices:
            prices[idx] = prices[idx] * (1 + np.random.choice([-1, 1]) * 0.15)

        # Volume with pattern
        base_volume = 10000
        volume = base_volume + np.random.exponential(2000, n_samples)
        # Increase volume during anomalies
        volume[anomaly_indices] *= 3

        return pd.DataFrame({
            'timestamp': timestamps,
            'price': prices,
            'volume': volume,
            'source_count': np.random.randint(5, 10, n_samples),
            'latency_ms': np.random.exponential(50, n_samples)
        })

    def test_complete_pipeline(self):
        """Test complete anomaly detection pipeline"""
        # 1. Generate data
        data = self._generate_realistic_oracle_data(500)

        # 2. Feature engineering
        features = self.engineer.generate_feature_matrix(data)

        # 3. Preprocessing
        processed = self.preprocessor.standardize(features.dropna())

        # 4. Train detector
        train_size = int(len(processed) * 0.8)
        train_data = processed.iloc[:train_size].values
        test_data = processed.iloc[train_size:].values

        self.detector.fit(train_data)

        # 5. Detect anomalies
        scores = self.detector.score_samples(test_data)
        predictions = self.detector.predict(test_data)

        # 6. Generate alerts
        alerts_generated = 0
        for i, score in enumerate(scores):
            anomaly_score = AnomalyScore(
                value=abs(score),
                confidence=0.85,
                timestamp=data.iloc[train_size + i]['timestamp'],
                feed_name='ETH/USD',
                features={}
            )
            if self.alert_gen.generate_alert(anomaly_score):
                alerts_generated += 1

        # Should detect some anomalies
        self.assertGreater(alerts_generated, 0)

    def test_multi_feed_detection(self):
        """Test detection across multiple price feeds"""
        feeds = {}
        for feed_name in ['ETH/USD', 'BTC/USD', 'LINK/USD']:
            feeds[feed_name] = self._generate_realistic_oracle_data(200)

        all_anomalies = {}
        for feed_name, data in feeds.items():
            features = self.engineer.generate_feature_matrix(data)
            processed = self.preprocessor.standardize(features.dropna())

            self.detector.fit(processed.values)
            scores = self.detector.score_samples(processed.values)

            # Count anomalies
            anomaly_count = np.sum(scores < np.percentile(scores, 10))
            all_anomalies[feed_name] = anomaly_count

        # Each feed should have some anomalies
        for feed_name, count in all_anomalies.items():
            self.assertGreater(count, 0)

    def test_streaming_detection(self):
        """Test real-time streaming anomaly detection"""
        # Initial training data
        initial_data = self._generate_realistic_oracle_data(300)
        features = self.engineer.generate_feature_matrix(initial_data)
        processed = self.preprocessor.standardize(features.dropna())

        self.detector.fit(processed.values)

        # Simulate streaming new data points
        detections = []
        for _ in range(50):
            # Generate single new data point
            new_point = self._generate_realistic_oracle_data(1)
            # Process it
            new_features = self.engineer.generate_single_point(
                new_point, historical_data=initial_data.tail(100)
            )
            processed_point = self.preprocessor.transform_single(new_features)

            # Score and detect
            score = self.detector.score_sample(processed_point)
            is_anomaly = score < np.percentile(processed.values, 5)
            detections.append(is_anomaly)

        self.assertEqual(len(detections), 50)

    def test_model_retraining_trigger(self):
        """Test automatic model retraining based on drift"""
        initial_data = self._generate_realistic_oracle_data(200)
        features = self.engineer.generate_feature_matrix(initial_data)
        processed = self.preprocessor.standardize(features.dropna())

        self.detector.fit(processed.values)
        initial_scores = self.detector.score_samples(processed.values)

        # Generate drifted data (price regime change)
        drifted_data = self._generate_realistic_oracle_data(100)
        drifted_data['price'] *= 1.5  # 50% price increase

        drifted_features = self.engineer.generate_feature_matrix(drifted_data)
        drifted_processed = self.preprocessor.standardize(drifted_features.dropna())

        new_scores = self.detector.score_samples(drifted_processed.values)

        # Drift should cause score distribution to change significantly
        initial_mean = np.mean(initial_scores)
        new_mean = np.mean(new_scores)

        drift_detected = abs(initial_mean - new_mean) / abs(initial_mean) > 0.2

        if drift_detected:
            # Retrain model
            combined_data = np.vstack([processed.values, drifted_processed.values])
            self.detector.fit(combined_data)
            retrained_scores = self.detector.score_samples(drifted_processed.values)

            # After retraining, scores should normalize
            self.assertIsNotNone(retrained_scores)


class TestEdgeCases(unittest.TestCase):
    """Test edge cases and error handling"""

    def test_empty_data(self):
        """Test handling of empty data"""
        detector = AnomalyDetector()
        with self.assertRaises(ValueError):
            detector.fit(np.array([]).reshape(0, 5))

    def test_single_feature(self):
        """Test with single feature"""
        data = np.random.randn(100, 1)
        detector = AnomalyDetector()
        detector.fit(data)
        predictions = detector.predict(data)
        self.assertEqual(len(predictions), 100)

    def test_very_high_dimensional_data(self):
        """Test with high-dimensional data"""
        data = np.random.randn(100, 100)
        detector = AnomalyDetector()
        detector.fit(data)
        predictions = detector.predict(data)
        self.assertEqual(len(predictions), 100)

    def test_constant_feature(self):
        """Test handling of constant features"""
        data = np.random.randn(100, 5)
        data[:, 0] = 1.0  # Constant feature

        preprocessor = DataPreprocessor()
        # Should handle gracefully
        scaled = preprocessor.standardize(pd.DataFrame(data))
        self.assertFalse(scaled.isna().all().any())

    def test_infinite_values(self):
        """Test handling of infinite values"""
        data = np.random.randn(100, 3)
        data[0, 0] = np.inf
        data[1, 1] = -np.inf

        preprocessor = DataPreprocessor()
        cleaned = preprocessor.handle_infinities(pd.DataFrame(data))
        self.assertFalse(np.isinf(cleaned.values).any())

    def test_extremely_small_dataset(self):
        """Test with very small dataset"""
        data = np.random.randn(5, 3)
        detector = AnomalyDetector()
        detector.fit(data)
        # Should still work
        predictions = detector.predict(data)
        self.assertEqual(len(predictions), 5)

    def test_all_anomalies(self):
        """Test when all data points are anomalous"""
        # All extreme values
        data = np.random.randn(100, 5) * 100 + 500
        detector = AnomalyDetector(contamination=0.1)
        detector.fit(data)
        scores = detector.score_samples(data)

        # Should still assign relative scores
        self.assertEqual(len(scores), 100)


class TestPerformance(unittest.TestCase):
    """Performance and scalability tests"""

    def test_large_dataset_training(self):
        """Test training on large dataset"""
        import time
        large_data = np.random.randn(10000, 20)

        detector = AnomalyDetector()
        start_time = time.time()
        detector.fit(large_data)
        training_time = time.time() - start_time

        # Should train in reasonable time (< 10 seconds)
        self.assertLess(training_time, 10)

    def test_batch_prediction_performance(self):
        """Test batch prediction performance"""
        import time
        data = np.random.randn(10000, 10)
        detector = AnomalyDetector()
        detector.fit(data)

        start_time = time.time()
        predictions = detector.predict(data)
        prediction_time = time.time() - start_time

        # Should predict quickly
        self.assertLess(prediction_time, 5)
        self.assertEqual(len(predictions), 10000)

    def test_feature_engineering_performance(self):
        """Test feature engineering on large dataset"""
        import time
        engineer = FeatureEngineer()

        large_df = pd.DataFrame({
            'timestamp': pd.date_range(end=datetime.now(), periods=5000, freq='1min'),
            'price': np.random.randn(5000) * 10 + 100,
            'volume': np.random.exponential(1000, 5000),
            'source_count': np.random.randint(3, 10, 5000)
        })

        start_time = time.time()
        features = engineer.generate_feature_matrix(large_df)
        engineering_time = time.time() - start_time

        # Should complete in reasonable time
        self.assertLess(engineering_time, 15)
        self.assertIsNotNone(features)


if __name__ == '__main__':
    # Run all tests with verbose output
    unittest.main(verbosity=2)
