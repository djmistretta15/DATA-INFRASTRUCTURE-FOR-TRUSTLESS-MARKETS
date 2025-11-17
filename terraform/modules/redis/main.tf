variable "cluster_id" { type = string }
variable "node_type" { type = string }
variable "num_cache_nodes" { type = number }
variable "parameter_group_name" { type = string }
variable "engine_version" { type = string }
variable "subnet_group_name" { type = string }
variable "security_group_ids" { type = list(string) }
variable "at_rest_encryption_enabled" { type = bool }
variable "transit_encryption_enabled" { type = bool }
variable "auth_token" { type = string }
variable "automatic_failover_enabled" { type = bool }
variable "multi_az_enabled" { type = bool }
variable "snapshot_retention_limit" { type = number }
variable "snapshot_window" { type = string }
variable "maintenance_window" { type = string }
variable "tags" { type = map(string) }

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = var.cluster_id
  description          = "Redis cluster for ${var.cluster_id}"

  node_type            = var.node_type
  num_cache_clusters   = var.num_cache_nodes
  parameter_group_name = var.parameter_group_name
  engine_version       = var.engine_version
  port                 = 6379

  subnet_group_name  = var.subnet_group_name
  security_group_ids = var.security_group_ids

  at_rest_encryption_enabled = var.at_rest_encryption_enabled
  transit_encryption_enabled = var.transit_encryption_enabled
  auth_token                 = var.auth_token

  automatic_failover_enabled = var.automatic_failover_enabled
  multi_az_enabled           = var.multi_az_enabled

  snapshot_retention_limit = var.snapshot_retention_limit
  snapshot_window          = var.snapshot_window
  maintenance_window       = var.maintenance_window

  apply_immediately = false

  tags = var.tags
}

output "primary_endpoint_address" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "configuration_endpoint_address" {
  value = aws_elasticache_replication_group.main.configuration_endpoint_address
}
