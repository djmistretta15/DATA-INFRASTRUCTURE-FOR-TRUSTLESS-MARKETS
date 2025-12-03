#!/usr/bin/env python3
"""
Performance Threshold Checker for K6 Load Test Results
Validates that performance metrics meet SLO requirements
"""

import json
import sys
from dataclasses import dataclass
from typing import Dict, List, Optional
import argparse


@dataclass
class Threshold:
    metric: str
    operator: str  # 'lt', 'lte', 'gt', 'gte', 'eq'
    value: float
    percentile: Optional[str] = None
    severity: str = 'error'  # 'error' or 'warning'
    description: str = ''


# Define performance thresholds (SLOs)
THRESHOLDS: List[Threshold] = [
    # HTTP request latency
    Threshold(
        metric='http_req_duration',
        operator='lt',
        value=500,
        percentile='p(95)',
        severity='error',
        description='95th percentile HTTP request duration < 500ms'
    ),
    Threshold(
        metric='http_req_duration',
        operator='lt',
        value=1000,
        percentile='p(99)',
        severity='error',
        description='99th percentile HTTP request duration < 1000ms'
    ),
    Threshold(
        metric='http_req_duration',
        operator='lt',
        value=200,
        percentile='med',
        severity='warning',
        description='Median HTTP request duration < 200ms'
    ),

    # Error rates
    Threshold(
        metric='http_req_failed',
        operator='lt',
        value=0.01,
        percentile='rate',
        severity='error',
        description='HTTP request failure rate < 1%'
    ),

    # Oracle-specific metrics
    Threshold(
        metric='oracle_price_latency',
        operator='lt',
        value=200,
        percentile='p(95)',
        severity='error',
        description='Oracle price query latency p95 < 200ms'
    ),
    Threshold(
        metric='oracle_errors',
        operator='lt',
        value=0.005,
        percentile='rate',
        severity='error',
        description='Oracle error rate < 0.5%'
    ),

    # GraphQL metrics
    Threshold(
        metric='graphql_query_latency',
        operator='lt',
        value=1000,
        percentile='p(95)',
        severity='error',
        description='GraphQL query latency p95 < 1000ms'
    ),

    # Database metrics
    Threshold(
        metric='database_query_time',
        operator='lt',
        value=300,
        percentile='p(95)',
        severity='warning',
        description='Database query time p95 < 300ms'
    ),

    # Cache performance
    Threshold(
        metric='cache_hit_rate',
        operator='gt',
        value=0.6,
        percentile='rate',
        severity='warning',
        description='Cache hit rate > 60%'
    ),

    # Throughput
    Threshold(
        metric='iterations',
        operator='gt',
        value=1000,
        percentile='count',
        severity='warning',
        description='Total iterations > 1000'
    ),
]


def load_results(file_path: str) -> Dict:
    """Load K6 JSON results file."""
    try:
        with open(file_path, 'r') as f:
            data = json.load(f)
        return data
    except FileNotFoundError:
        print(f"Error: Results file not found: {file_path}")
        sys.exit(2)
    except json.JSONDecodeError as e:
        print(f"Error: Invalid JSON in results file: {e}")
        sys.exit(2)


def get_metric_value(data: Dict, metric: str, percentile: Optional[str]) -> Optional[float]:
    """Extract metric value from K6 results."""
    if 'metrics' not in data:
        # Try to parse line-by-line JSON format
        return parse_streaming_results(data, metric, percentile)

    metrics = data.get('metrics', {})

    if metric not in metrics:
        return None

    metric_data = metrics[metric]

    if percentile == 'rate':
        # For rate metrics (like failure rate)
        return metric_data.get('values', {}).get('rate', metric_data.get('rate'))
    elif percentile == 'count':
        return metric_data.get('values', {}).get('count', metric_data.get('count'))
    elif percentile:
        # For percentile-based metrics
        values = metric_data.get('values', metric_data)
        return values.get(percentile)
    else:
        return metric_data.get('values', {}).get('avg', metric_data.get('avg'))


def parse_streaming_results(data: Dict, metric: str, percentile: Optional[str]) -> Optional[float]:
    """Parse streaming K6 JSON output format."""
    # K6 can output line-by-line JSON, need to aggregate
    # This handles the case where each line is a separate metric point

    if isinstance(data, list):
        # Find relevant metric entries
        metric_values = []
        for entry in data:
            if entry.get('metric') == metric:
                value = entry.get('data', {}).get('value')
                if value is not None:
                    metric_values.append(value)

        if not metric_values:
            return None

        if percentile == 'rate':
            # Calculate rate as sum of 1s divided by total
            return sum(1 for v in metric_values if v > 0) / len(metric_values)
        elif percentile == 'count':
            return len(metric_values)
        elif percentile == 'p(95)':
            metric_values.sort()
            idx = int(len(metric_values) * 0.95)
            return metric_values[idx]
        elif percentile == 'p(99)':
            metric_values.sort()
            idx = int(len(metric_values) * 0.99)
            return metric_values[idx]
        elif percentile == 'med':
            metric_values.sort()
            idx = len(metric_values) // 2
            return metric_values[idx]
        else:
            return sum(metric_values) / len(metric_values)

    return None


def check_threshold(value: float, threshold: Threshold) -> bool:
    """Check if value meets threshold requirement."""
    if threshold.operator == 'lt':
        return value < threshold.value
    elif threshold.operator == 'lte':
        return value <= threshold.value
    elif threshold.operator == 'gt':
        return value > threshold.value
    elif threshold.operator == 'gte':
        return value >= threshold.value
    elif threshold.operator == 'eq':
        return abs(value - threshold.value) < 0.0001
    else:
        raise ValueError(f"Unknown operator: {threshold.operator}")


def format_value(value: float, threshold: Threshold) -> str:
    """Format value for display based on metric type."""
    if 'duration' in threshold.metric or 'latency' in threshold.metric or 'time' in threshold.metric:
        return f"{value:.2f}ms"
    elif 'rate' in threshold.percentile or 'rate' in threshold.metric:
        return f"{value * 100:.3f}%"
    elif threshold.percentile == 'count':
        return f"{int(value)}"
    else:
        return f"{value:.4f}"


def validate_results(data: Dict) -> Dict[str, List[str]]:
    """Validate all thresholds against results."""
    results = {
        'passed': [],
        'warnings': [],
        'errors': [],
        'missing': []
    }

    for threshold in THRESHOLDS:
        value = get_metric_value(data, threshold.metric, threshold.percentile)

        if value is None:
            results['missing'].append(
                f"Metric not found: {threshold.metric} ({threshold.percentile or 'avg'})"
            )
            continue

        passed = check_threshold(value, threshold)
        formatted_value = format_value(value, threshold)
        formatted_threshold = format_value(threshold.value, threshold)

        result_str = (
            f"{threshold.description}\n"
            f"  Actual: {formatted_value}, Expected: {threshold.operator} {formatted_threshold}"
        )

        if passed:
            results['passed'].append(result_str)
        elif threshold.severity == 'warning':
            results['warnings'].append(result_str)
        else:
            results['errors'].append(result_str)

    return results


def print_report(results: Dict[str, List[str]]) -> None:
    """Print formatted validation report."""
    print("=" * 60)
    print("       PERFORMANCE THRESHOLD VALIDATION REPORT")
    print("=" * 60)

    print(f"\n✅ PASSED ({len(results['passed'])})")
    print("-" * 60)
    for item in results['passed']:
        print(f"  {item}")

    if results['warnings']:
        print(f"\n⚠️  WARNINGS ({len(results['warnings'])})")
        print("-" * 60)
        for item in results['warnings']:
            print(f"  {item}")

    if results['errors']:
        print(f"\n❌ ERRORS ({len(results['errors'])})")
        print("-" * 60)
        for item in results['errors']:
            print(f"  {item}")

    if results['missing']:
        print(f"\n❓ MISSING METRICS ({len(results['missing'])})")
        print("-" * 60)
        for item in results['missing']:
            print(f"  {item}")

    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Passed:   {len(results['passed'])}")
    print(f"  Warnings: {len(results['warnings'])}")
    print(f"  Errors:   {len(results['errors'])}")
    print(f"  Missing:  {len(results['missing'])}")

    if results['errors']:
        print("\n❌ OVERALL: FAILED - Critical thresholds not met")
    elif results['warnings']:
        print("\n⚠️  OVERALL: PASSED WITH WARNINGS")
    else:
        print("\n✅ OVERALL: PASSED - All thresholds met")


def generate_json_report(results: Dict[str, List[str]]) -> Dict:
    """Generate JSON report for CI/CD integration."""
    return {
        'status': 'failed' if results['errors'] else 'passed',
        'summary': {
            'passed': len(results['passed']),
            'warnings': len(results['warnings']),
            'errors': len(results['errors']),
            'missing': len(results['missing'])
        },
        'details': results,
        'thresholds': [
            {
                'metric': t.metric,
                'percentile': t.percentile,
                'operator': t.operator,
                'value': t.value,
                'severity': t.severity,
                'description': t.description
            }
            for t in THRESHOLDS
        ]
    }


def main():
    parser = argparse.ArgumentParser(
        description='Validate K6 load test results against performance thresholds'
    )
    parser.add_argument(
        'results_file',
        help='Path to K6 JSON results file'
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='Output results in JSON format'
    )
    parser.add_argument(
        '--strict',
        action='store_true',
        help='Treat warnings as errors'
    )
    parser.add_argument(
        '--output',
        help='Write report to file'
    )

    args = parser.parse_args()

    # Load results
    data = load_results(args.results_file)

    # Validate against thresholds
    results = validate_results(data)

    # Output report
    if args.json:
        report = generate_json_report(results)
        output = json.dumps(report, indent=2)
        if args.output:
            with open(args.output, 'w') as f:
                f.write(output)
        else:
            print(output)
    else:
        print_report(results)

    # Determine exit code
    if results['errors']:
        sys.exit(1)
    elif args.strict and results['warnings']:
        sys.exit(1)
    elif results['missing'] and len(results['missing']) > len(THRESHOLDS) // 2:
        # Too many missing metrics indicates a problem
        print("\nError: Too many metrics missing from results")
        sys.exit(2)
    else:
        sys.exit(0)


if __name__ == '__main__':
    main()
