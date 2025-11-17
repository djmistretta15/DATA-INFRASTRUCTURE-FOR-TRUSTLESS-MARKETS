# Terraform Outputs - Expose critical infrastructure information
# Production-grade outputs for downstream tooling and operational access

# VPC Outputs
output "vpc_id" {
  description = "VPC ID for the oracle infrastructure"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "Private subnet IDs for internal services"
  value       = aws_subnet.private[*].id
}

output "public_subnet_ids" {
  description = "Public subnet IDs for load balancers"
  value       = aws_subnet.public[*].id
}

output "nat_gateway_ips" {
  description = "NAT Gateway public IPs for egress traffic"
  value       = aws_eip.nat[*].public_ip
}

# EKS Cluster Outputs
output "eks_cluster_name" {
  description = "EKS cluster name"
  value       = module.eks.cluster_name
}

output "eks_cluster_endpoint" {
  description = "EKS cluster API endpoint"
  value       = module.eks.cluster_endpoint
  sensitive   = true
}

output "eks_cluster_certificate_authority" {
  description = "EKS cluster CA certificate for kubectl"
  value       = module.eks.cluster_certificate_authority_data
  sensitive   = true
}

output "eks_cluster_oidc_issuer_url" {
  description = "OIDC issuer URL for IRSA"
  value       = module.eks.oidc_issuer_url
}

output "eks_cluster_security_group_id" {
  description = "Security group ID for EKS cluster"
  value       = module.eks.cluster_security_group_id
}

output "eks_node_security_group_id" {
  description = "Security group ID for EKS worker nodes"
  value       = module.eks.node_security_group_id
}

# Database Outputs
output "timescaledb_endpoint" {
  description = "TimescaleDB RDS endpoint"
  value       = module.rds.endpoint
  sensitive   = true
}

output "timescaledb_port" {
  description = "TimescaleDB connection port"
  value       = var.db_port
}

output "timescaledb_database_name" {
  description = "TimescaleDB database name"
  value       = var.db_name
}

output "timescaledb_username" {
  description = "TimescaleDB master username"
  value       = var.db_username
  sensitive   = true
}

output "timescaledb_password" {
  description = "TimescaleDB master password (from Secrets Manager recommended)"
  value       = module.rds.password
  sensitive   = true
}

# Redis Outputs
output "redis_primary_endpoint" {
  description = "Redis primary endpoint for writes"
  value       = module.redis.primary_endpoint_address
}

output "redis_configuration_endpoint" {
  description = "Redis configuration endpoint for cluster mode"
  value       = module.redis.configuration_endpoint_address
}

output "redis_port" {
  description = "Redis connection port"
  value       = 6379
}

# S3 Outputs
output "ml_models_bucket_name" {
  description = "S3 bucket name for ML model artifacts"
  value       = aws_s3_bucket.ml_models.id
}

output "ml_models_bucket_arn" {
  description = "S3 bucket ARN for ML models"
  value       = aws_s3_bucket.ml_models.arn
}

output "data_lake_bucket_name" {
  description = "S3 bucket name for historical data lake"
  value       = aws_s3_bucket.data_lake.id
}

output "data_lake_bucket_arn" {
  description = "S3 bucket ARN for data lake"
  value       = aws_s3_bucket.data_lake.arn
}

# KMS Outputs
output "kms_key_id" {
  description = "KMS key ID for encryption"
  value       = aws_kms_key.main.key_id
}

output "kms_key_arn" {
  description = "KMS key ARN for encryption policies"
  value       = aws_kms_key.main.arn
}

# IAM Outputs
output "eks_node_role_arn" {
  description = "IAM role ARN for EKS worker nodes"
  value       = module.eks.node_role_arn
}

output "service_account_role_arn" {
  description = "IAM role ARN for Kubernetes service accounts (IRSA)"
  value       = aws_iam_role.service_account.arn
}

# Kubeconfig Generation Helper
output "kubeconfig_command" {
  description = "Command to update kubeconfig for cluster access"
  value       = "aws eks update-kubeconfig --region ${var.aws_region} --name ${module.eks.cluster_name}"
}

# Security Group Outputs
output "database_security_group_id" {
  description = "Security group ID for database access"
  value       = aws_security_group.database.id
}

output "redis_security_group_id" {
  description = "Security group ID for Redis access"
  value       = aws_security_group.redis.id
}

# Application Configuration Export
output "application_config" {
  description = "Configuration values for application deployment"
  value = {
    cluster_name         = module.eks.cluster_name
    region              = var.aws_region
    database_endpoint   = module.rds.endpoint
    redis_endpoint      = module.redis.primary_endpoint_address
    ml_models_bucket    = aws_s3_bucket.ml_models.id
    data_lake_bucket    = aws_s3_bucket.data_lake.id
    kms_key_id          = aws_kms_key.main.key_id
    vpc_id              = aws_vpc.main.id
    private_subnets     = aws_subnet.private[*].id
    oidc_provider_arn   = module.eks.oidc_provider_arn
  }
  sensitive = true
}

# Monitoring and Observability
output "cloudwatch_log_group" {
  description = "CloudWatch log group for EKS cluster logs"
  value       = "/aws/eks/${var.project_name}-eks/cluster"
}

# Network Information
output "vpc_cidr_block" {
  description = "CIDR block of the VPC"
  value       = aws_vpc.main.cidr_block
}

output "availability_zones" {
  description = "Availability zones used by the infrastructure"
  value       = data.aws_availability_zones.available.names
}

# Cost Estimation Tags
output "resource_tags" {
  description = "Tags applied to all resources for cost tracking"
  value       = local.common_tags
}

# DNS and Load Balancer Information
output "internal_dns_zone" {
  description = "Internal Route53 zone ID for service discovery"
  value       = aws_route53_zone.internal.zone_id
}

# Secrets Manager References
output "secrets_arns" {
  description = "ARNs of secrets stored in Secrets Manager"
  value = {
    database_credentials = aws_secretsmanager_secret.db_credentials.arn
    redis_auth_token     = aws_secretsmanager_secret.redis_auth.arn
    api_keys            = aws_secretsmanager_secret.api_keys.arn
  }
}

# Terraform State Information
output "terraform_workspace" {
  description = "Current Terraform workspace"
  value       = terraform.workspace
}

output "deployment_timestamp" {
  description = "Timestamp of last Terraform apply"
  value       = timestamp()
}
